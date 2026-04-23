import { createMMKV } from 'react-native-mmkv';
import AsyncStorage from '@react-native-async-storage/async-storage';
import * as SQLite from 'expo-sqlite';
import { log } from './log';
import {
  trackLocationQueueOpFailed,
  trackLocationQueueAutoReset,
  trackLocationQueueEvicted,
  trackLocationQueueMigrated,
} from './analytics';

// ============================================================================
// MMKV-BACKED GPS PING QUEUE
// ============================================================================
//
// Designed to replace SQLite-backed `location-db.ts` as the local outbox for
// GPS pings awaiting upload to Convex. See mobile/docs/location-queue-mmkv.md
// for the full design rationale.
//
// CRITICAL INVARIANT — do not reintroduce a module-level native DB handle.
// The original SQLite design cached a NativeDatabase object at module scope,
// which Android's GC aggressively destroys between operations, producing the
// NullPointerException cascade that wedged Christian's device (4/22–4/23
// incident). MMKV's mmap-backed file has no native object for GC to collect;
// the constant below is safe because it's a thin JSI wrapper, not a cached
// resource. Do NOT wrap this module in a "reopen on error" pattern — if a
// write fails we auto-reset (see withRecovery below), we do not retry.
//
// KEY LAYOUT
//   meta:schema_v   → "1" | "migrating"  (migration atomicity state)
//   ping:{13-digit-recordedAt}-{4-hex-rand} → JSON QueuedPing
//
// Timestamp-based keys sort lexicographically = time-ascending = FIFO. No
// shared counter → no cross-context race between foreground watchPosition
// and background TaskManager.
// ============================================================================

const lg = log('LocationQueue');

// MMKV instance. Thread-safe via internal file lock; safely shared across
// the foreground JS context and the headless TaskManager context.
const mmkv = createMMKV({ id: 'otoqa-location-queue' });

const KEY_SCHEMA = 'meta:schema_v';
const PING_PREFIX = 'ping:';

// Validates `ping:{13-digit-recordedAt}-{4-hex}`. Used as a defensive guard
// before eviction so a malformed key (from a bug or stale writer) can't
// trick the oldest-key-deletion logic into deleting the wrong row.
const PING_KEY_SHAPE = /^ping:\d{13}-[0-9a-f]{4}$/;

// Hard cap — evict oldest beyond this. 10 000 × ~250 B = ~2.5 MB on disk,
// covers ~55 h at 1 ping / 20 s. An offline-for-a-week edge case would
// silently drop the earliest pings rather than grow unbounded.
const MAX_QUEUE_SIZE = 10_000;

// Auto-reset threshold. MMKV failures are NOT retry-recoverable the way the
// SQLite handle-stale errors were: the failure modes (disk full, filesystem
// corruption, ENOMEM on mmap) don't self-heal between calls, so "retry
// once" would add latency without recovery. Threshold = 2 means the
// withRecovery wrapper effectively IS the retry — one failure is tolerated
// (could be a transient kernel hiccup), two in a row means the storage
// layer is wedged and clearAll() is the only forward path. Do NOT raise
// this number "to be safe": higher values just delay recovery on devices
// that are already unusable.
const FAILURE_THRESHOLD = 2;

// ============================================================================
// TYPES
// ============================================================================

export interface QueuedPing {
  id: string; // `${recordedAt}-${4hex}`, matches key suffix after `ping:`
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
  syncAttempts: number; // escape-hatch: purged after 20 fails
  firstAttemptAt: number | null; // or when createdAt is > maxAgeMs old
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

// ============================================================================
// CORRUPTION-RECOVERY WRAPPER
// ============================================================================

let consecutiveFailures = 0;

function withRecovery<T>(op: string, fn: () => T): T {
  try {
    const result = fn();
    if (consecutiveFailures > 0) consecutiveFailures = 0;
    return result;
  } catch (err) {
    consecutiveFailures++;
    const errorMsg = err instanceof Error ? err.message : String(err);
    trackLocationQueueOpFailed({ op, error: errorMsg, consecutiveFailures });
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

// ============================================================================
// INTERNAL HELPERS
// ============================================================================

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
  return mmkv.getAllKeys().filter((k: string) => k.startsWith(PING_PREFIX));
}

function readPing(key: string): QueuedPing | null {
  const raw = mmkv.getString(key);
  if (!raw) return null;
  try {
    return JSON.parse(raw) as QueuedPing;
  } catch (err) {
    // Data-level corruption on this one row — not an MMKV failure. Delete
    // the bad row and move on; don't trigger withRecovery escalation.
    lg.warn(`Corrupt ping at ${key}, removing: ${err}`);
    mmkv.remove(key);
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

// ============================================================================
// WRITE API
// ============================================================================

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
        mmkv.remove(oldest);
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

// ============================================================================
// READ API
// ============================================================================

export function getUnsyncedLocations(limit = 100): QueuedPing[] {
  return withRecovery('getUnsyncedLocations', () => {
    // Every queued ping is unsynced — on successful sync we delete, so there's
    // no synced=1 state. FIFO by key order (which is time order via timestamp
    // prefix).
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

// getTotalCountForLoad is intentionally not exported. The sole caller in the
// SQLite module was a debug banner showing `total pts · unsynced pending`;
// since we delete on sync, those two numbers are always equal. The banner
// collapses to `X pending` after the rewire in trip/[id].tsx.

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
        best = {
          latitude: ping.latitude,
          longitude: ping.longitude,
          recordedAt: ping.recordedAt,
        };
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
        best = {
          latitude: ping.latitude,
          longitude: ping.longitude,
          recordedAt: ping.recordedAt,
        };
      }
    }
    return best;
  });
}

// ============================================================================
// SYNC-LIFECYCLE API
// ============================================================================

export function removeSynced(ids: string[]): void {
  withRecovery('removeSynced', () => {
    // Called by syncUnsyncedToConvex on successful server ack. Unlike the
    // SQLite `UPDATE ... SET synced=1`, we simply delete — there are no
    // queries that need to distinguish past-synced from never-existed.
    for (const id of ids) {
      const key = keyFor(id);
      if (mmkv.contains(key)) mmkv.remove(key);
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
      mmkv.remove(keyFor(ping.id));
      deleted++;
    }
    return { deleted, sample };
  });
}

// ============================================================================
// CLEANUP API
// ============================================================================

export function deleteAllForLoad(loadId: string): number {
  return withRecovery('deleteAllForLoad', () => {
    let deleted = 0;
    for (const ping of iterateAll()) {
      if (ping.loadId === loadId) {
        mmkv.remove(keyFor(ping.id));
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

// ============================================================================
// ONE-SHOT MIGRATION FROM LEGACY STORES
// ============================================================================

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
    const legacy = await SQLite.openDatabaseAsync(SQLITE_LEGACY_DB);
    type LegacyRow = LocationInput & {
      syncAttempts?: number;
      firstAttemptAt?: number | null;
    };
    const rows = await legacy.getAllAsync<LegacyRow>(
      'SELECT * FROM locations WHERE synced = 0',
    );
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
