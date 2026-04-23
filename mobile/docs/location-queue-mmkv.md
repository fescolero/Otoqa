# MMKV-backed GPS ping queue — design sketch (v3)

**Status**: design / discussion — not wired into the app.
**Goal**: eliminate the `NativeDatabase.execAsync → NullPointerException` failure class by removing SQLite from the offline GPS queue. Replace with `react-native-mmkv`, which is mmap-backed and has no native DB handle for Android's GC to destroy.
**Non-goals**: changing the Convex schema, the HTTP sync protocol, or the check-in flow. This is a swap of the **local** durability layer only.

### Changes since v1 (red-team round 1)

1. **Timestamp-based keys, no shared counter.** Fixes the FG↔BG `nextSeq` race.
2. **In-memory indices removed.** They didn't cross JS contexts; stale anchors could corrupt the distance filter. O(n) scans are sub-millisecond at our queue bound anyway.
3. **Migration drains `bg_fallback_locations` too**, not only SQLite.
4. **Hard cap on queue size (10 000)** with oldest-eviction; `purgeStaleUnsynced` now also runs at app startup.
5. **Corruption recovery**: every MMKV operation is wrapped; two consecutive failures auto-`clearAll()` and emit telemetry.
6. **Kill-switch is server-controlled** (Convex feature flag) instead of build-time env var — enables per-org rollback without a rebuild.
7. **Explicit telemetry**: new events (`location_queue_op_failed`, `location_queue_migrated`, `location_queue_auto_reset`, `location_queue_evicted`) plus a `queue_backend` super-property.
8. **Expo config plugin + ProGuard keep-rules** called out as load-bearing build-side work.
9. **Pin to `react-native-mmkv@^4`** (we're on RN 0.81 + `newArchEnabled: true` — v3 is now legacy).
10. **Burn-in targets are hard numeric gates**, not "watch for a week."

### Changes since v2 (red-team round 2)

11. **Dispatcher design spelled out** — resolved-once-at-boot (Option A). New section "Dispatcher" below; new file `mobile/lib/location-storage.ts`.
12. **Migration is now atomic-or-restart** — stamps intermediate `meta:schema_v = 'migrating'` before any copy; rolls back with `clearAll()` on next launch if seen.
13. **Kill-switch semantics clarified**: forward rollback only. Mid-flight rescue is the Reset button or a cold-start.
14. **Eviction guards against unexpected key format** — defensive regex check before `delete`.
15. **Force-quit + reopen test protocol made concrete** — 20 pings, force-quit, reopen, verify via `getUnsyncedCount` + Convex presence within 2 min.
16. **ProGuard rules rewritten** — rely on the library's bundled rules first; only add explicit keeps on observed `NoSuchMethodError`.
17. **Auto-reset threshold reasoning committed to a comment** so a future reader doesn't "tune" it up for ostensible safety.

---

## API shape — side-by-side

Every public function currently exported by [`mobile/lib/location-db.ts`](../lib/location-db.ts) ports over.

| Current SQLite API | MMKV equivalent | Notes |
|---|---|---|
| `insertLocation(loc)` | same | Returns `string` (pingId — timestamp + random suffix). Was `number` before. |
| `insertLocationBatch(locs)` | same | |
| `getUnsyncedLocations(limit)` | same | Returns `QueuedPing[]`. |
| `getUnsyncedCount()` | same | Derived from `getAllKeys()` count; O(n) but n < 10k. |
| `getUnsyncedCountForLoad(loadId)` | same | O(n) scan of queue. |
| `getTotalCountForLoad(loadId)` | **deleted** | Identical to `getUnsyncedCountForLoad` once synced pings are removed; collapse the one UI caller to show a single "pending" number. |
| `markAsSynced(ids)` | `removeSynced(ids)` | No `synced=1` flag — delete on sync. Strictly simpler state. |
| `markSyncAttemptFailed(ids)` | same | Updates `syncAttempts` + `firstAttemptAt` in place. |
| `purgeStaleUnsynced(maxAttempts, maxAgeMs)` | same | Semantics preserved. Now also runs at app startup, not only after sync. |
| `deleteOldSyncedLocations(olderThanMs)` | **deleted** | No synced rows to clean up. |
| `getLastLocationForLoad(loadId)` | same | O(n) scan (no in-memory cache — see § Concurrency). |
| `getLastLocationForSession(sessionId)` | same | Same. |
| `deleteAllForLoad(loadId)` | same | |
| `resetLocationDb()` | `resetLocationQueue()` | `mmkv.clearAll()` is effectively instant. |
| `reopenDb()` | **deleted** | Nothing to reopen. MMKV is mmap — there's no handle that can die. |
| `closeDb()` | **deleted** | Same. |

**ID type change** — `number → string` — is the only breaking API shift for callers. Current callers (`location-tracking.ts`) treat IDs opaquely, so the change is a TypeScript-only propagation.

---

## Storage layout

Single MMKV instance, two key families:

```
meta:schema_v       → string   // "1", room to evolve
ping:{recordedAt}-{rand} → JSON blob  // one queued ping per key
```

**Key format**: `ping:1776972223683-a7f2`.

- `recordedAt` is the 13-digit Unix-ms GPS timestamp, already monotonically-compatible and lexicographically sortable through year 2286.
- `-a7f2` is a 4-hex-char random suffix (16 bits, ~65k values). Collision probability at two concurrent inserts sharing the same millisecond is 1 in 65k — negligible for our write rate.

Lexicographic sort of these keys = time-ascending FIFO. No separate `meta:seq` counter. **No cross-context race to lose.**

No `meta:count` either — `getAllKeys().filter(startsWith('ping:')).length` is a few microseconds at our queue bound. Not worth the race hazard for an O(1) read.

---

## Concurrency model

| Actor | When it runs | What it does to MMKV |
|---|---|---|
| Foreground `watchPositionAsync` callback | Whenever the app is visible and a fix arrives | Insert one ping. Sync runs inline. |
| Background `TaskManager` task | Periodically when the app is backgrounded/killed | Inserts a small batch; may sync. |
| Foreground resume flow | Once per `AppState → 'active'` | Runs startup purge + migration guard. |

All three can execute concurrently (FG and BG live in different JS contexts). MMKV's native layer serializes writes via an internal file lock — at our ~3-writes-per-minute rate there's no contention hit. Because we've removed the `nextSeq` read-modify-write and the in-memory index, **there is no operation in this module that is not safe under concurrent contexts.**

---

## Implementation sketch

```ts
// mobile/lib/location-queue.ts
import { MMKV } from 'react-native-mmkv';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { log } from './log';
import { trackLocationQueueOpFailed, trackLocationQueueAutoReset, trackLocationQueueEvicted, trackLocationQueueMigrated } from './analytics';

const lg = log('LocationQueue');

// One instance, shared between foreground + background task contexts.
// MMKV is thread-safe via internal file locking. Unlike expo-sqlite, there
// is no native "database object" that Android's GC can destroy between
// operations — the mmap is kernel-backed.
const mmkv = new MMKV({ id: 'otoqa-location-queue' });

const KEY_SCHEMA = 'meta:schema_v';
const PING_PREFIX = 'ping:';
// Validates `ping:{13-digit-recordedAt}-{4-hex}`. Used as a defensive guard
// before eviction so a malformed key (from a bug or stale writer) can't
// trick the oldest-key-deletion logic into deleting the wrong row.
const PING_KEY_SHAPE = /^ping:\d{13}-[0-9a-f]{4}$/;
const MAX_QUEUE_SIZE = 10_000;          // hard cap; evict oldest beyond this

// Auto-reset threshold. MMKV failures are not retry-recoverable like the
// SQLite handle-stale errors were: the failure modes (disk full,
// filesystem corruption, ENOMEM on mmap) don't self-heal between calls.
// So "retry once" would add latency without recovery. Threshold = 2 means
// the withRecovery wrapper effectively IS the retry — one failure is
// tolerated (could be a transient kernel hiccup), two in a row means the
// storage layer is wedged and clearAll is the only forward path. Do NOT
// raise this number "to be safe": higher values just delay recovery on
// devices that are already unusable.
const FAILURE_THRESHOLD = 2;

// ---------- types ----------

export interface QueuedPing {
  id: string;                     // timestamp + random hex suffix; matches key after `ping:`
  driverId: string;
  loadId: string | null;
  sessionId: string | null;
  organizationId: string;
  latitude: number;
  longitude: number;
  accuracy: number | null;
  speed: number | null;
  heading: number | null;
  recordedAt: number;
  createdAt: number;
  syncAttempts: number;           // escape-hatch: purge after 20 fails
  firstAttemptAt: number | null;  // or 48h elapsed since first try
}

export interface LocationInput {
  driverId: string;
  loadId?: string | null;
  sessionId?: string | null;
  organizationId: string;
  latitude: number;
  longitude: number;
  accuracy: number | null;
  speed: number | null;
  heading: number | null;
  recordedAt: number;
}

// ---------- corruption recovery wrapper ----------
// Every public function routes through this. Two consecutive op failures
// triggers a full clearAll + telemetry — the MMKV equivalent of "the DB
// file is wedged, nuke it to recover." Queue state is ephemeral (outbox
// for HTTP sync), so loss is acceptable in exchange for recovery.

let consecutiveFailures = 0;

function withRecovery<T>(op: string, fn: () => T): T {
  try {
    const result = fn();
    if (consecutiveFailures > 0) consecutiveFailures = 0;
    return result;
  } catch (err) {
    consecutiveFailures++;
    trackLocationQueueOpFailed({ op, error: err instanceof Error ? err.message : String(err), consecutiveFailures });
    if (consecutiveFailures >= FAILURE_THRESHOLD) {
      lg.warn(`MMKV op '${op}' failed ${consecutiveFailures}× — auto-resetting queue`);
      try {
        mmkv.clearAll();
        trackLocationQueueAutoReset({ trigger: 'consecutive_failures', op });
      } catch {
        // If clearAll itself throws, the storage layer is unreachable.
        // Nothing we can do; next app launch will try again.
      }
      consecutiveFailures = 0;
    }
    throw err;
  }
}

// ---------- internal helpers ----------

function assertHasAnchor(loc: LocationInput): void {
  if (!loc.loadId && !loc.sessionId) {
    throw new Error('insertLocation: loadId or sessionId required');
  }
}

function newPingId(recordedAt: number): string {
  const rand = Math.floor(Math.random() * 0x10000).toString(16).padStart(4, '0');
  return `${recordedAt}-${rand}`;
}

function keyFor(id: string): string {
  return `${PING_PREFIX}${id}`;
}

function allPingKeys(): string[] {
  return mmkv.getAllKeys().filter((k) => k.startsWith(PING_PREFIX));
}

function readPing(key: string): QueuedPing | null {
  const raw = mmkv.getString(key);
  if (!raw) return null;
  try {
    return JSON.parse(raw) as QueuedPing;
  } catch (err) {
    lg.warn(`Corrupt ping at ${key}, removing: ${err}`);
    mmkv.delete(key);
    return null;
  }
}

function writePing(ping: QueuedPing): void {
  mmkv.set(keyFor(ping.id), JSON.stringify(ping));
}

function* iterateAll(): Generator<QueuedPing> {
  for (const key of allPingKeys()) {
    const ping = readPing(key);
    if (ping) yield ping;
  }
}

// ---------- write API ----------

export function insertLocation(loc: LocationInput): string {
  return withRecovery('insertLocation', () => {
    assertHasAnchor(loc);

    // Enforce hard cap — evict oldest if at limit. Keys are time-ordered,
    // so sorted()[0] is the oldest. Defensive: verify the key matches our
    // expected shape before deleting, otherwise a malformed key (bug, test
    // fixture, or stale writer) could trick us into deleting the wrong row.
    const keys = allPingKeys();
    if (keys.length >= MAX_QUEUE_SIZE) {
      const oldest = keys.sort()[0];
      if (PING_KEY_SHAPE.test(oldest)) {
        mmkv.delete(oldest);
        trackLocationQueueEvicted({ reason: 'queue_full', queueSize: keys.length });
      } else {
        lg.warn(`Skipping eviction of unexpected key shape: ${oldest}`);
      }
    }

    const id = newPingId(loc.recordedAt);
    const now = Date.now();
    const ping: QueuedPing = {
      id,
      driverId: loc.driverId,
      loadId: loc.loadId ?? null,
      sessionId: loc.sessionId ?? null,
      organizationId: loc.organizationId,
      latitude: loc.latitude,
      longitude: loc.longitude,
      accuracy: loc.accuracy,
      speed: loc.speed,
      heading: loc.heading,
      recordedAt: loc.recordedAt,
      createdAt: now,
      syncAttempts: 0,
      firstAttemptAt: null,
    };
    writePing(ping);
    return id;
  });
}

export function insertLocationBatch(locs: LocationInput[]): number {
  // No transaction needed — each write is individually durable via mmap.
  // A partial failure leaves a consistent, partially-filled queue.
  let n = 0;
  for (const loc of locs) {
    try {
      insertLocation(loc);
      n++;
    } catch (err) {
      lg.warn(`insertLocationBatch: skipping invalid ping: ${err}`);
    }
  }
  return n;
}

// ---------- read API ----------

export function getUnsyncedLocations(limit = 100): QueuedPing[] {
  return withRecovery('getUnsyncedLocations', () => {
    const keys = allPingKeys().sort().slice(0, limit);
    const out: QueuedPing[] = [];
    for (const key of keys) {
      const ping = readPing(key);
      if (ping) out.push(ping);
    }
    return out;
  });
}

export function getUnsyncedCount(): number {
  return withRecovery('getUnsyncedCount', () => allPingKeys().length);
}

export function getUnsyncedForLoad(loadId: string, limit = 500): QueuedPing[] {
  return withRecovery('getUnsyncedForLoad', () => {
    const out: QueuedPing[] = [];
    for (const ping of iterateAll()) {
      if (ping.loadId === loadId) {
        out.push(ping);
        if (out.length >= limit) break;
      }
    }
    out.sort((a, b) => a.recordedAt - b.recordedAt);
    return out;
  });
}

export function getUnsyncedCountForLoad(loadId: string): number {
  return withRecovery('getUnsyncedCountForLoad', () => {
    let n = 0;
    for (const ping of iterateAll()) {
      if (ping.loadId === loadId) n++;
    }
    return n;
  });
}

// getTotalCountForLoad is intentionally not exported. The sole caller was a
// debug banner that displayed `total pts · unsynced pending`; in this model
// those two numbers are always equal, so the banner collapses to just
// `X pending`. If a caller ever needs "total sent for this load" over time,
// Convex is the source of truth — the local queue only knows about pings
// that haven't shipped yet.

export function getLastLocationForLoad(
  loadId: string,
): { latitude: number; longitude: number; recordedAt: number } | null {
  return withRecovery('getLastLocationForLoad', () => {
    // O(n) scan. At n < 10k with ~300-byte JSON blobs, this is sub-millisecond.
    // No in-memory cache — it would be stale in the other JS context (BG task
    // can't see FG's cache, and vice versa).
    let best: { latitude: number; longitude: number; recordedAt: number } | null = null;
    for (const ping of iterateAll()) {
      if (ping.loadId !== loadId) continue;
      if (!best || best.recordedAt < ping.recordedAt) {
        best = { latitude: ping.latitude, longitude: ping.longitude, recordedAt: ping.recordedAt };
      }
    }
    return best;
  });
}

export function getLastLocationForSession(
  sessionId: string,
): { latitude: number; longitude: number; recordedAt: number } | null {
  return withRecovery('getLastLocationForSession', () => {
    let best: { latitude: number; longitude: number; recordedAt: number } | null = null;
    for (const ping of iterateAll()) {
      if (ping.sessionId !== sessionId) continue;
      if (!best || best.recordedAt < ping.recordedAt) {
        best = { latitude: ping.latitude, longitude: ping.longitude, recordedAt: ping.recordedAt };
      }
    }
    return best;
  });
}

// ---------- sync-lifecycle API ----------

export function removeSynced(ids: string[]): void {
  withRecovery('removeSynced', () => {
    // Called by syncUnsyncedToConvex on successful server ack. Unlike the
    // SQLite `UPDATE ... SET synced=1`, we simply delete — there are no
    // queries that need to distinguish past-synced from never-existed.
    for (const id of ids) {
      const key = keyFor(id);
      if (mmkv.contains(key)) mmkv.delete(key);
    }
  });
}

export function markSyncAttemptFailed(ids: string[]): void {
  withRecovery('markSyncAttemptFailed', () => {
    const now = Date.now();
    for (const id of ids) {
      const key = keyFor(id);
      const ping = readPing(key);
      if (!ping) continue;
      ping.syncAttempts += 1;
      if (ping.firstAttemptAt === null) ping.firstAttemptAt = now;
      writePing(ping);
    }
  });
}

export interface PurgeResult {
  deleted: number;
  sample: Array<{
    id: string;
    driverId: string;
    sessionId: string | null;
    loadId: string | null;
    syncAttempts: number;
    ageMs: number;
  }>;
}

export function purgeStaleUnsynced(
  maxAttempts = 20,
  maxAgeMs = 48 * 60 * 60 * 1000,
): PurgeResult {
  return withRecovery('purgeStaleUnsynced', () => {
    const now = Date.now();
    const ageCutoff = now - maxAgeMs;
    const sample: PurgeResult['sample'] = [];
    let deleted = 0;

    for (const ping of iterateAll()) {
      const tooManyAttempts = ping.syncAttempts >= maxAttempts;
      const tooOld = ping.createdAt < ageCutoff;
      if (!tooManyAttempts && !tooOld) continue;

      if (sample.length < 5) {
        sample.push({
          id: ping.id,
          driverId: ping.driverId,
          sessionId: ping.sessionId,
          loadId: ping.loadId,
          syncAttempts: ping.syncAttempts,
          ageMs: now - ping.createdAt,
        });
      }
      mmkv.delete(keyFor(ping.id));
      deleted++;
    }
    return { deleted, sample };
  });
}

// ---------- cleanup API ----------

export function deleteAllForLoad(loadId: string): number {
  return withRecovery('deleteAllForLoad', () => {
    let deleted = 0;
    for (const ping of iterateAll()) {
      if (ping.loadId === loadId) {
        mmkv.delete(keyFor(ping.id));
        deleted++;
      }
    }
    return deleted;
  });
}

export function resetLocationQueue(): void {
  withRecovery('resetLocationQueue', () => {
    lg.warn('Resetting location queue — all unsynced pings will be discarded');
    mmkv.clearAll();
  });
}

// ---------- one-shot migration ----------

const BG_FALLBACK_LEGACY_KEY = 'otoqa-driver:bg_fallback_locations';
const SQLITE_LEGACY_DB = 'otoqa_locations.db';

/**
 * On first launch of the MMKV bundle, drain two legacy outboxes into MMKV:
 *
 *   1. SQLite `locations` table — the primary store in every version before
 *      this one. Read unsynced rows, copy, delete the file.
 *   2. `bg_fallback_locations` AsyncStorage key — the secondary buffer that
 *      was written when SQLite was unavailable (the failure mode we're
 *      eliminating). Parse the JSON array, copy, delete the key.
 *
 * ATOMICITY: the copy is not atomic (each insertLocation is its own write),
 * so a crash mid-migration would leave a partially-migrated MMKV plus a
 * still-present legacy source. On the next launch we'd re-copy everything
 * and create duplicate entries. To prevent that, we stamp an intermediate
 * `meta:schema_v = 'migrating'` BEFORE any copy begins. If we see that
 * sentinel on startup it means a previous attempt crashed — blow away the
 * partial MMKV with clearAll() and start over. Server-side dedup at
 * driverLocations.ingestBatch would catch any duplicates that slipped
 * through anyway, but we prefer not to double our batch sizes.
 *
 * If a legacy source is unreadable (common for devices hit by the Android
 * GC bug), we skip the copy — those pings were stranded anyway — and still
 * advance schema_v so we don't retry on every app launch.
 */
export async function migrateFromLegacyStoresOnce(): Promise<void> {
  const currentSchema = mmkv.getString(KEY_SCHEMA);
  if (currentSchema === '1') return;

  if (currentSchema === 'migrating') {
    // Previous migration attempt crashed partway. Roll back the partial
    // import so we don't double-insert on this attempt.
    lg.warn('Detected interrupted migration — rolling back partial MMKV state');
    mmkv.clearAll();
    trackLocationQueueAutoReset({ trigger: 'interrupted_migration' });
  }

  mmkv.set(KEY_SCHEMA, 'migrating');

  let sqliteRows = 0;
  let fallbackRows = 0;
  let sqliteReadable = true;
  let fallbackReadable = true;

  // 1. SQLite drain
  try {
    const SQLite = await import('expo-sqlite');
    const legacy = await SQLite.openDatabaseAsync(SQLITE_LEGACY_DB);
    const rows = await legacy.getAllAsync<LocationInput & {
      syncAttempts?: number;
      firstAttemptAt?: number | null;
    }>('SELECT * FROM locations WHERE synced = 0');
    for (const r of rows) {
      try {
        insertLocation(r);
        sqliteRows++;
      } catch (err) {
        lg.warn(`Migration: skipping corrupt SQLite row: ${err}`);
      }
    }
    await legacy.closeAsync().catch(() => {});
  } catch (err) {
    sqliteReadable = false;
    lg.warn(`Migration: legacy SQLite unreadable, skipping copy: ${err}`);
  }

  try {
    const SQLite = await import('expo-sqlite');
    await SQLite.deleteDatabaseAsync(SQLITE_LEGACY_DB);
  } catch {
    /* file already gone */
  }

  // 2. AsyncStorage fallback drain
  try {
    const json = await AsyncStorage.getItem(BG_FALLBACK_LEGACY_KEY);
    if (json) {
      const parsed = JSON.parse(json) as LocationInput[];
      for (const loc of parsed) {
        try {
          insertLocation(loc);
          fallbackRows++;
        } catch (err) {
          lg.warn(`Migration: skipping corrupt fallback row: ${err}`);
        }
      }
      await AsyncStorage.removeItem(BG_FALLBACK_LEGACY_KEY);
    }
  } catch (err) {
    fallbackReadable = false;
    lg.warn(`Migration: fallback buffer unreadable: ${err}`);
  }

  trackLocationQueueMigrated({
    sqliteRows,
    fallbackRows,
    sqliteReadable,
    fallbackReadable,
  });

  // Commit: only stamp the final schema version after both copy phases
  // complete. Any crash above leaves schema_v = 'migrating', which next
  // launch interprets as "roll back and retry."
  mmkv.set(KEY_SCHEMA, '1');
}
```

---

## Callsite migration

Four files touched. **All imports go through the dispatcher `./location-storage`, never `./location-queue` or `./location-db` directly** (enforced by the CI grep rule in the Dispatcher section).

```ts
// 1. mobile/lib/location-tracking.ts — imports + delete fallback scaffolding
import {
  insertLocation, getUnsyncedLocations, getUnsyncedCount,
  removeSynced as markAsSynced,          // rename: no synced flag, just delete
  markSyncAttemptFailed, purgeStaleUnsynced, getLastLocationForLoad,
  getLastLocationForSession, resetLocationQueue as resetLocationDb,
} from './location-storage';

// DELETE: BG_FALLBACK_LOCATIONS_KEY, saveFallbackLocations,
//         recoverFallbackLocations, and all their call sites.
// DELETE: deleteOldSyncedLocations calls (nothing to clean up).
// DELETE: reopenDb calls (no handle to reopen).
```

```ts
// 2. mobile/lib/hooks/useCheckIn.ts — swap ./location-db → ./location-storage;
//    no logic change.
```

```tsx
// 3. mobile/app/(app)/trip/[id].tsx — debug banner simplification
import { getUnsyncedCountForLoad } from '../../../lib/location-storage';
const pending = getUnsyncedCountForLoad(id);  // sync under MMKV, async under SQLite
setTrackingDebug({ isActive, pendingPoints: pending, loadId });
// banner: `GPS ON · {pendingPoints} pending`
```

```ts
// 4. mobile/app/_layout.tsx (or equivalent root init) — add three startup calls
import {
  resolveBackend,
  migrateFromLegacyStoresOnce,
  purgeStaleUnsynced,
} from '@/lib/location-storage';

// Blocking: decide backend before any tracking code runs.
const backend = await resolveBackend();

// Drain legacy stores into MMKV (no-op on SQLite backend or if already done).
if (backend === 'mmkv') {
  await migrateFromLegacyStoresOnce();
}

// Belt-and-suspenders: purge stale pings at startup in case the device has
// been offline long enough that sync-driven purge never ran.
purgeStaleUnsynced();
```

---

## Telemetry (new events)

All events route through [`mobile/lib/analytics.ts`](../lib/analytics.ts). New exports:

```ts
export function trackLocationQueueOpFailed(ctx: { op: string; error: string; consecutiveFailures: number }) {
  capture('location_queue_op_failed', ctx);
}

export function trackLocationQueueAutoReset(ctx: { trigger: 'consecutive_failures' | 'manual'; op?: string }) {
  capture('location_queue_auto_reset', ctx);
}

export function trackLocationQueueEvicted(ctx: { reason: 'queue_full'; queueSize: number }) {
  capture('location_queue_evicted', ctx);
}

export function trackLocationQueueMigrated(ctx: {
  sqliteRows: number;
  fallbackRows: number;
  sqliteReadable: boolean;
  fallbackReadable: boolean;
}) {
  capture('location_queue_migrated', ctx);
}
```

And a **super-property** registered once at app init, so every existing event (`watch_location_saved`, `bg_task_result`, etc.) carries the backend flag:

```ts
// mobile/lib/analytics.ts — inside setPostHogClient
client.register({ queue_backend: getQueueBackend() });
```

This makes backend-specific comparisons trivial in PostHog — filter `bg_task_result` by `queue_backend` to see MMKV-vs-SQLite failure rates side-by-side during the canary.

---

## Dispatcher — one backend per app session

The queue module (`location-queue.ts`) and the current SQLite module (`location-db.ts`) expose the same public surface but with different async-ness (MMKV is synchronous; SQLite is not). We need a single import point that picks one and sticks with it for the whole app session.

**Decision**: resolve the backend **once at app boot**, cache in a module constant, dispatch synchronously forever after. Every function on the public surface stays synchronous — the async path only exists during a single `await` in root init.

Three reasons:

1. **Sync dispatch** — turning `insertLocation` into `async` just because one startup lookup is async would force every caller (including hot paths like the watchPositionAsync callback) to `await`, adding context-switches for nothing.
2. **No mid-session swap risk** — stashing the decision at boot means no part of the app can observe an inconsistent "I'm-on-SQLite-now-MMKV" state. Prevents an entire class of race bugs.
3. **Testable** — the resolution step is one function that can be mocked; everything downstream imports the dispatcher and doesn't know the backend exists.

```ts
// mobile/lib/location-storage.ts (new, ~60 LOC)
//
// Single import point for the GPS outbox. Backend is resolved ONCE during
// root-init via resolveBackend(); after that point every export on this
// module is a synchronous pass-through to the chosen implementation.
//
// Callers must NOT import from ./location-queue or ./location-db directly
// — doing so would bypass the kill-switch and pin them to one backend
// regardless of the feature flag.

import { getQueueBackend } from './feature-flags';
import * as mmkvQueue from './location-queue';
import * as sqliteQueue from './location-db';

type Backend = 'mmkv' | 'sqlite';
type Impl = typeof mmkvQueue;

let resolved: { backend: Backend; impl: Impl } | null = null;

/**
 * Must be awaited exactly once, in the root layout, before any tracking
 * code runs. Subsequent calls are no-ops. The cached flag lookup is ~1ms;
 * a cold fetch from Convex is 100–300ms. We block on it intentionally —
 * the wrong backend for even one ping write is worse than a 200ms start
 * delay.
 */
export async function resolveBackend(): Promise<Backend> {
  if (resolved) return resolved.backend;
  const backend = await getQueueBackend();
  // Note: location-db.ts and location-queue.ts export slightly different
  // property names (string ids vs number ids). The dispatcher normalizes
  // by pinning the type to the MMKV variant — the SQLite module will get
  // deleted in Phase 5 anyway, so we don't maintain a generic interface.
  const impl = backend === 'mmkv' ? mmkvQueue : (sqliteQueue as unknown as Impl);
  resolved = { backend, impl };
  return backend;
}

function current(): Impl {
  if (!resolved) {
    throw new Error(
      'location-storage: resolveBackend() must be awaited during app init before any queue operation',
    );
  }
  return resolved.impl;
}

// Public surface — sync pass-throughs. Shape matches location-queue.ts.
export const insertLocation: Impl['insertLocation'] = (loc) => current().insertLocation(loc);
export const insertLocationBatch: Impl['insertLocationBatch'] = (locs) => current().insertLocationBatch(locs);
export const getUnsyncedLocations: Impl['getUnsyncedLocations'] = (limit) => current().getUnsyncedLocations(limit);
export const getUnsyncedCount: Impl['getUnsyncedCount'] = () => current().getUnsyncedCount();
export const getUnsyncedForLoad: Impl['getUnsyncedForLoad'] = (loadId, limit) => current().getUnsyncedForLoad(loadId, limit);
export const getUnsyncedCountForLoad: Impl['getUnsyncedCountForLoad'] = (loadId) => current().getUnsyncedCountForLoad(loadId);
export const getLastLocationForLoad: Impl['getLastLocationForLoad'] = (id) => current().getLastLocationForLoad(id);
export const getLastLocationForSession: Impl['getLastLocationForSession'] = (id) => current().getLastLocationForSession(id);
export const removeSynced: Impl['removeSynced'] = (ids) => current().removeSynced(ids);
export const markSyncAttemptFailed: Impl['markSyncAttemptFailed'] = (ids) => current().markSyncAttemptFailed(ids);
export const purgeStaleUnsynced: Impl['purgeStaleUnsynced'] = (a, b) => current().purgeStaleUnsynced(a, b);
export const deleteAllForLoad: Impl['deleteAllForLoad'] = (id) => current().deleteAllForLoad(id);
export const resetLocationQueue: Impl['resetLocationQueue'] = () => current().resetLocationQueue();
export { migrateFromLegacyStoresOnce } from './location-queue';

export function getResolvedBackend(): Backend {
  if (!resolved) throw new Error('resolveBackend() not called yet');
  return resolved.backend;
}
```

**Root-init integration** (app/_layout.tsx or equivalent):

```ts
import { resolveBackend, migrateFromLegacyStoresOnce, purgeStaleUnsynced } from '@/lib/location-storage';

// Before any tracking code runs:
const backend = await resolveBackend();
if (backend === 'mmkv') {
  await migrateFromLegacyStoresOnce();
}
// Safe in either backend — both implementations expose purge.
purgeStaleUnsynced();
```

**Callsite rule** — enforced by CI grep:

```
grep -rE "from ['\"](\\.\\.?/)*lib/location-(db|queue)['\"]" mobile/app mobile/lib/hooks \
  && echo "ERROR: import from location-storage, not the backend modules directly" \
  && exit 1
```

The only files allowed to import from `./location-db` or `./location-queue` are `./location-storage.ts` itself and the two modules' own test files.

---

## Feature flag: server-controlled kill switch

Backend selection must be flippable **without a rebuild or OTA**. A bad MMKV regression on a Monday afternoon should be fixable from Convex in 30 seconds, not next release cycle.

```ts
// mobile/lib/feature-flags.ts (new, ~30 LOC)
import { convex } from './convex';
import { storage } from './storage';
import { api } from '../../convex/_generated/api';

const CACHE_KEY = 'feature_flags_cache';
const CACHE_MAX_AGE_MS = 24 * 60 * 60 * 1000;

let inMemory: Record<string, string> | null = null;

export async function getQueueBackend(): Promise<'mmkv' | 'sqlite'> {
  // 1. Try cached value — fine offline, survives cold start.
  if (!inMemory) {
    const raw = await storage.getString(CACHE_KEY);
    if (raw) {
      try { inMemory = JSON.parse(raw); } catch { inMemory = {}; }
    } else {
      inMemory = {};
    }
  }
  const cached = inMemory.gps_queue_backend;

  // 2. Kick off a background refresh. Cached value returns immediately;
  //    the new value is picked up on next app launch.
  refreshAsync().catch(() => {});

  return (cached === 'mmkv' || cached === 'sqlite') ? cached : 'sqlite';
}

async function refreshAsync(): Promise<void> {
  try {
    const flags = await convex.query(api.featureFlags.getForOrg);
    if (flags) {
      inMemory = flags;
      await storage.set(CACHE_KEY, JSON.stringify({ ...flags, _cachedAt: Date.now() }));
    }
  } catch {
    // Offline or auth failure — keep using cached value.
  }
}
```

A new Convex table `featureFlags` (org-scoped) holds `{ key, value }` rows; a single `getForOrg` query returns the whole map. Flipping a flag is a `mutation` from an admin UI or the Convex dashboard.

**Rollback semantics — this is forward rollback, not mid-flight rescue.** The cached value is read at app start and is stable for that session. If a driver is mid-trip when we flip the flag server-side, they keep the current backend until their next **cold start** (force-quit + reopen, or OS-initiated kill + relaunch). We deliberately don't swap backends mid-session: a live backend change would strand any unsynced pings in the old backend, which is exactly the data-loss we're trying to eliminate.

Consequences for incident response:

- **Stopping a regression from spreading**: flipping the flag is near-instant — any device that hasn't yet cold-started with the new flag value will boot on the good backend.
- **Rescuing a driver already stuck on a bad backend**: the flag flip alone doesn't help them. They need either (a) the in-app "Reset tracking storage" button to clear the wedge and cold-start, or (b) the OS to kill the app so the next launch re-reads the flag.

If you need a true mid-flight rollback (rare — has to be a severe regression), the path is to push an OTA that forces a bundle reload. That's heavier but exists as a last resort.

---

## Native-build prerequisites

Items that must land in the same EAS build as the module itself:

1. **Dependency**: `bun add react-native-mmkv@^4` in `mobile/`.
2. **Expo config plugin** — add to `app.json`:
   ```json
   {
     "expo": {
       "plugins": ["react-native-mmkv"]
     }
   }
   ```
3. **Android ProGuard/R8 keep-rules** — **rely on the library's bundled `consumer-rules.pro` first.** `react-native-mmkv` and the underlying Tencent MMKV library both ship consumer rules that Gradle automatically applies to release builds. In principle nothing extra is needed.

   **Verification step** (not optional): run a release (`--variant release`) build against the canary after adding the dependency, install on a device, and exercise the queue (check-in → capture pings → sync). If you see a runtime `NoSuchMethodError` / `ClassNotFoundException` referencing `com.tencent.mmkv.*` or `com.mrousavy.*`, the bundled rules aren't sufficient — **only then** add narrow keeps targeting the specific missing symbol to `mobile/android/app/proguard-rules.pro`. Do not add blanket `-keep class com.mrousavy.** { *; }` preemptively — a catch-all like that defeats R8's shrinking on unrelated classes and masks real symbol issues behind it.
4. **iOS**: no additional steps. `pod install` runs automatically in EAS.

None of these can be OTA'd — they require a native rebuild. Schedule the first MMKV-capable build early enough that burn-in can happen before flag-flipping.

---

## Performance

| Operation | SQLite today | MMKV (v2) | Why |
|---|---|---|---|
| `insertLocation` | 1 open + 1 INSERT | 1 cap-check + 1 put | mmap write ≪ DB open |
| `getUnsyncedLocations(50)` | 1 open + 1 SELECT | `getAllKeys` + 50 reads + 50 parses | Keys index in memory; no file I/O for the list |
| `removeSynced(50)` | 1 open + 1 UPDATE ... IN (...) | 50 deletes | Sub-millisecond; delete is O(1) |
| `getLastLocationForSession` | 1 open + 1 SELECT with index | O(n) scan of <10k keys | ~1 ms worst case — eliminates in-memory-cache staleness |
| Full queue scan (purge) | 1 open + 1 SELECT + bulk DELETE | `getAllKeys` + iterate | Comparable |

At ~3 writes/min and 1 sync batch/2 min, queue size steady-state is <10 items. Scans are microseconds in the common case; the 10k-item cap is an **upper bound** for catastrophic offline, never the steady state.

---

## Stability profile

| Failure | SQLite today | MMKV (v2) |
|---|---|---|
| Native handle GC'd between ops (Android) | **Yes — this is the bug.** | No — no native object to GC. |
| Schema drift after in-place upgrade | **Yes — we just shipped a guard for this.** | No — no schema. |
| Transaction crash mid-migration | Possible | No migrations to run. |
| FG ↔ BG counter race | N/A | Eliminated — timestamp-based keys. |
| Stale in-memory index corrupts distance filter | N/A | Eliminated — no cache. |
| Unbounded offline queue growth | Possible | Capped at 10k; oldest evicted with telemetry. |
| Disk full | Write returns error | Write returns error — same. |
| File corruption | Recovery via reinstall | Auto-recovery: 2 failed ops → `clearAll` + telemetry. |
| Concurrent access from FG + BG task | WAL + SQLite locking | MMKV's internal file lock. |
| Rollback after bad release | Rebuild + OTA | Flip feature flag in Convex — no deploy. |

Every remaining row is either "common-cause catastrophic (disk full)" or has automatic recovery.

---

## Rollout plan

### Phase 0 — prep (1 PR, ~2 days)

- Create `mobile/lib/location-queue.ts` (this module) behind no-op — it's imported by nothing yet.
- Create `mobile/lib/feature-flags.ts` with `getQueueBackend()` wired to Convex.
- Add `featureFlags` table + `getForOrg` / admin mutation to Convex.
- Add `queue_backend` super-property registration in analytics.ts.
- Add the four new PostHog events.
- Ship in one EAS build (native rebuild required for `react-native-mmkv`).

### Phase 1 — dispatcher wiring (1 PR)

- Add a tiny dispatcher module `location-storage.ts` that re-exports from `location-queue.ts` or `location-db.ts` based on `getQueueBackend()` result at app startup.
- Change `location-tracking.ts`, `useCheckIn.ts`, `trip/[id].tsx` to import from the dispatcher.
- `featureFlags.gps_queue_backend` defaults to `sqlite` globally. Zero behavior change shipped.

### Phase 2 — internal canary

Flip the feature flag to `mmkv` for the internal-testers org only. Watch for 72 hours. **Hard gates before expanding**:

| Metric | Target | How to read |
|---|---|---|
| `location_queue_op_failed` events per active driver-day | < 0.1 | Small handful of transient storage errors is fine; anything more is a regression |
| `location_queue_auto_reset` events | 0 | Any auto-reset in canary is a defect to triage |
| `bg_task_result.syncSuccess` rate | ≥ 99% | Currently ~70% on affected devices |
| `watch_location_error` rate (ratio of `…_error` to `…_received`) | < 1% | Currently ~50% on the Samsung devices we've been debugging |
| `tracking_storage_reset` (manual) event rate | drops to 0 across canary group | The whole point — drivers stop needing to tap Reset |
| **Force-quit + reopen protocol** | passes on ≥ 3 iterations × 2 platforms | See protocol below |

**Force-quit + reopen protocol** (run before flipping to Phase 3, on at least one Android and one iOS test device):

1. Install the canary build with `gps_queue_backend=mmkv` for the test org.
2. Start a shift + check in at a stop so tracking is active.
3. Drive around (or simulate motion) long enough to accumulate **≥ 20 pings**. Verify via the debug banner or `getUnsyncedCount()`.
4. Record the count — call it `N_before`.
5. Force-quit the app: swipe it off the app switcher (iOS) / swipe from recents (Android). Not just backgrounded.
6. Immediately reopen the app.
7. Within 2 minutes of reopen, check:
   - `getUnsyncedCount()` returns `N_before` (pre-reopen count survived the force-quit) OR less (sync has started flushing).
   - Convex `driverLocations` table contains all 20 pings for that load.
   - No `location_queue_op_failed` or `location_queue_auto_reset` events in PostHog for the device.

Repeat 3× on each platform. **Any failure is a blocker** — the whole point of MMKV is surviving this exact OS-kill scenario without data loss.

### Phase 3 — 10% staged expansion

Flip for ~10% of production orgs (random bucket). 48-hour watch with the same gates, plus an iOS-specific sub-gate since the canary is Android-heavy:

| Metric | Target |
|---|---|
| Same gates as Phase 2, split by platform | Both ≤ targets |
| No new support tickets mentioning GPS or tracking | Manual review |

### Phase 4 — global flip

If Phases 2 and 3 hit every gate, flip `gps_queue_backend` default to `mmkv` for all orgs. Leave the dispatcher in place for one release as a rollback path.

### Phase 5 — delete everything the rollout made necessary

One release after the global flip (~2 weeks):

- Remove `mobile/lib/location-db.ts` (~350 LOC).
- **Remove `mobile/lib/location-storage.ts`** (the dispatcher). Callers switch to importing `./location-queue` directly.
- **Remove `mobile/lib/feature-flags.ts`** and the `featureFlags.gps_queue_backend` Convex record. No more runtime backend selection — there's only one backend.
- Remove the CI grep guard against direct backend imports (it was guarding against a problem that no longer exists).
- Remove `expo-sqlite` from dependencies if no other caller uses it.
- Remove the schema-drift guard from the codebase.
- Remove the "Reset tracking storage" Troubleshooting button — its purpose was SQLite corruption recovery, which the MMKV auto-reset covers.

All the scaffolding from the past two weeks' incident work goes away.

### Why delete the dispatcher — not "collapse it to a re-export"

It would be tempting to leave `location-storage.ts` as a one-line re-export (`export * from './location-queue'`) "just in case we need to swap backends again someday." Evaluated against our stated criteria — **performance, stability, or security** — the re-export loses on every axis:

- **Performance**: zero impact either way.
- **Stability**: indirection layers are where signature drift hides. Add a function to `location-queue`, forget to re-export from the pass-through, and you get either unreachable code or a silently-wrong import shape. This is the *same* failure mode that caused Fix #8 (the Android NPE fix) to regress twice during unrelated rewrites. The pass-through adds a new place for that to happen.
- **Security**: neutral.

The dispatcher earns its keep *during* the rollout (sync boot resolution + CI guard against direct imports) but earns nothing after. If we ever do migrate again, re-introducing ~60 LOC of dispatcher is a 30-minute job — cheaper than paying the cognitive tax of an unused abstraction for every new engineer reading the codebase in the meantime.

YAGNI applies. Delete it.

---

## Summary of what changes on disk

### During rollout (Phases 0–4)

- **+1 file**: `mobile/lib/location-queue.ts` (~400 LOC). Permanent.
- **+1 file**: `mobile/lib/location-storage.ts` dispatcher (~60 LOC). Scaffold — deleted in Phase 5.
- **+1 file**: `mobile/lib/feature-flags.ts` (~30 LOC). Scaffold — deleted in Phase 5.
- **+1 Convex table + 2 Convex functions**: `featureFlags`, `getForOrg`, `setFlag`. Scaffold — deleted in Phase 5.
- **+1 CI check**: grep guard against direct imports of the backend modules. Scaffold — removed in Phase 5.
- **+1 dependency**: `react-native-mmkv@^4`. Permanent.

### After Phase 5 cleanup

- **−1 file**: `mobile/lib/location-db.ts` (~350 LOC).
- **−1 file**: `mobile/lib/location-storage.ts` (dispatcher — see § "Why delete the dispatcher").
- **−1 file**: `mobile/lib/feature-flags.ts`.
- **−1 Convex table + 2 functions**: `featureFlags` et al.
- **−1 CI grep guard**.
- **−4 fallback routines** in `location-tracking.ts` (`saveFallbackLocations`, `recoverFallbackLocations`, three call sites, `BG_FALLBACK_LOCATIONS_KEY`).
- **−1 dependency**: `expo-sqlite` removed if no other caller exists.
- **−1 UI element**: "Reset tracking storage" button (its purpose is covered by MMKV auto-reset).

**Final state**: one new file (`location-queue.ts`, ~400 LOC), one swapped dependency, ~500 LOC of scaffolding and legacy paths deleted. Complexity budget: strongly negative — no migrations, no schemas, no handle lifecycle, no fallback buffer, no "is SQLite available" branches, no runtime backend selection, no feature flag, no CI guard.
