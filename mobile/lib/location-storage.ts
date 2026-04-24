import * as mmkvQueue from './location-queue';
import * as sqliteQueue from './location-db';
import {
  getQueueBackend,
  getFlagBool,
  FLAG_QUEUE_ENCRYPTION_ENABLED,
} from './feature-flags';
import { registerQueueBackend } from './analytics';
import { log } from './log';

// ============================================================================
// LOCATION STORAGE DISPATCHER
// ============================================================================
//
// Single import point for GPS-ping persistence. Backend is resolved ONCE
// during root init via `resolveBackend()`; after that every function on
// this module is an async pass-through to the chosen implementation.
//
// SCAFFOLDING — this whole file is deleted in Phase 5 cleanup once the
// global flip to MMKV lands and `expo-sqlite` is removed. At that point
// callers switch to importing `./location-queue` directly. See
// mobile/docs/location-queue-mmkv.md § "Why delete the dispatcher".
//
// Callers must NOT import from ./location-queue or ./location-db directly
// — doing so would bypass the kill-switch and pin them to one backend
// regardless of the feature flag. Enforced by a CI grep (see
// scripts/ci-check-imports.sh).
//
// SHAPE: this module normalizes both backends onto a **string-id, async**
// API. MMKV is natively sync with string ids. SQLite is async with number
// ids — we wrap it with trivial string↔number conversion at the boundary.
// Callers only see the target (MMKV) shape, which simplifies Phase 5
// deletion: no caller-side changes needed when the dispatcher goes away.
// ============================================================================

const lg = log('LocationStorage');

export type Backend = 'mmkv' | 'sqlite';

interface ResolvedBackend {
  backend: Backend;
}

let resolved: ResolvedBackend | null = null;
let inflightResolve: Promise<Backend> | null = null;

/**
 * Resolve the backend at boot. Idempotent — multiple callers receive the
 * same decision. The decision is locked for the session; a mid-session
 * backend swap would strand unsynced pings in the old backend (the exact
 * data-loss we're eliminating), so we deliberately forbid it.
 *
 * Concurrent callers are handled: if a resolve is in-flight, new callers
 * await the same promise rather than starting a parallel resolution. This
 * prevents a race where a (app) layout mounts and fires resumeTracking
 * before root layout's resolveBackend() completes — both would otherwise
 * race to set `resolved` and double-register the PostHog super-property.
 */
export async function resolveBackend(): Promise<Backend> {
  if (resolved) return resolved.backend;
  if (inflightResolve) return inflightResolve;

  inflightResolve = (async () => {
    const backend = await getQueueBackend();

    // Encryption-at-rest resolution is only meaningful on the MMKV path —
    // the legacy SQLite backend is scheduled for deletion in Phase 5 and
    // won't receive encryption work. If the flag is absent (cold cache,
    // first launch) we default to false; a device that's going to be
    // encryption-enabled will pick it up on the next launch when the
    // refresh has landed.
    if (backend === 'mmkv') {
      const encryptionEnabled = await getFlagBool(
        FLAG_QUEUE_ENCRYPTION_ENABLED,
        false,
      );
      try {
        const mode = await mmkvQueue.resolveQueueEncryption(encryptionEnabled);
        lg.debug(`Queue encryption resolved: ${mode}`);
      } catch (err) {
        // Non-fatal: resolveQueueEncryption already falls back to plaintext
        // internally. Log and continue so we don't block tracking startup
        // on a Keychain/Keystore hiccup.
        lg.warn(`Queue encryption resolve failed (plaintext fallback): ${err}`);
      }
    }

    resolved = { backend };
    registerQueueBackend(backend);
    lg.debug(`Queue backend resolved: ${backend}`);
    return backend;
  })().finally(() => {
    inflightResolve = null;
  });

  return inflightResolve;
}

export function getResolvedBackend(): Backend {
  if (!resolved) {
    throw new Error(
      'location-storage: resolveBackend() must be awaited during app init before any queue operation',
    );
  }
  return resolved.backend;
}

function ensureResolved(): Backend {
  if (!resolved) {
    throw new Error(
      'location-storage: resolveBackend() not called. Add `await resolveBackend()` to app/_layout root init.',
    );
  }
  return resolved.backend;
}

// ============================================================================
// ADAPTED TYPES — unified shape the dispatcher exposes to callers
// ============================================================================

export type LocationInput = mmkvQueue.LocationInput;

export interface QueuedPing {
  id: string;
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
  syncAttempts: number;
  firstAttemptAt: number | null;
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
// ADAPTERS — normalize SQLite's number-id shape to the string-id MMKV shape
// ============================================================================

function sqliteRowToQueuedPing(row: sqliteQueue.LocationRow): QueuedPing {
  return {
    id: String(row.id),
    driverId: row.driverId,
    loadId: row.loadId,
    sessionId: row.sessionId,
    organizationId: row.organizationId,
    latitude: row.latitude,
    longitude: row.longitude,
    accuracy: row.accuracy,
    speed: row.speed,
    heading: row.heading,
    recordedAt: row.recordedAt,
    createdAt: row.createdAt,
    syncAttempts: row.syncAttempts,
    firstAttemptAt: row.firstAttemptAt,
  };
}

function sqliteSampleToAdapted(
  s: sqliteQueue.PurgeResult['sample'][number],
): PurgeResult['sample'][number] {
  return {
    id: String(s.id),
    driverId: s.driverId,
    sessionId: s.sessionId,
    loadId: s.loadId,
    syncAttempts: s.syncAttempts,
    ageMs: s.ageMs,
  };
}

// ============================================================================
// WRITE API
// ============================================================================

export async function insertLocation(loc: LocationInput): Promise<string> {
  if (ensureResolved() === 'mmkv') {
    return mmkvQueue.insertLocation(loc);
  }
  const sqliteLoc: sqliteQueue.LocationInput = {
    ...loc,
    loadId: loc.loadId ?? null,
    sessionId: loc.sessionId ?? null,
  };
  const id = await sqliteQueue.insertLocation(sqliteLoc);
  return String(id);
}

export async function insertLocationBatch(locs: LocationInput[]): Promise<number> {
  if (ensureResolved() === 'mmkv') {
    return mmkvQueue.insertLocationBatch(locs);
  }
  const sqliteLocs: sqliteQueue.LocationInput[] = locs.map((l) => ({
    ...l,
    loadId: l.loadId ?? null,
    sessionId: l.sessionId ?? null,
  }));
  return sqliteQueue.insertLocationBatch(sqliteLocs);
}

// ============================================================================
// READ API
// ============================================================================

export async function getUnsyncedLocations(limit = 100): Promise<QueuedPing[]> {
  if (ensureResolved() === 'mmkv') {
    return mmkvQueue.getUnsyncedLocations(limit);
  }
  const rows = await sqliteQueue.getUnsyncedLocations(limit);
  return rows.map(sqliteRowToQueuedPing);
}

export async function getUnsyncedCount(): Promise<number> {
  if (ensureResolved() === 'mmkv') {
    return mmkvQueue.getUnsyncedCount();
  }
  return sqliteQueue.getUnsyncedCount();
}

export async function getUnsyncedCountForLoad(loadId: string): Promise<number> {
  if (ensureResolved() === 'mmkv') {
    return mmkvQueue.getUnsyncedCountForLoad(loadId);
  }
  return sqliteQueue.getUnsyncedCountForLoad(loadId);
}

export async function getLastLocationForLoad(
  loadId: string,
): Promise<{ latitude: number; longitude: number; recordedAt: number } | null> {
  if (ensureResolved() === 'mmkv') {
    return mmkvQueue.getLastLocationForLoad(loadId);
  }
  return sqliteQueue.getLastLocationForLoad(loadId);
}

export async function getLastLocationForSession(
  sessionId: string,
): Promise<{ latitude: number; longitude: number; recordedAt: number } | null> {
  if (ensureResolved() === 'mmkv') {
    return mmkvQueue.getLastLocationForSession(sessionId);
  }
  return sqliteQueue.getLastLocationForSession(sessionId);
}

// ============================================================================
// SYNC-LIFECYCLE API
// ============================================================================

/**
 * Mark the given pings as successfully synced. In MMKV this deletes them;
 * in SQLite this sets synced=1. Callers don't care which.
 *
 * Kept under the old name `markAsSynced` so location-tracking.ts needs
 * zero logic changes during the rollout.
 */
export async function markAsSynced(ids: string[]): Promise<void> {
  if (ensureResolved() === 'mmkv') {
    return mmkvQueue.removeSynced(ids);
  }
  const numericIds = ids.map((s) => Number(s)).filter((n) => !Number.isNaN(n));
  return sqliteQueue.markAsSynced(numericIds);
}

export async function markSyncAttemptFailed(ids: string[]): Promise<void> {
  if (ensureResolved() === 'mmkv') {
    return mmkvQueue.markSyncAttemptFailed(ids);
  }
  const numericIds = ids.map((s) => Number(s)).filter((n) => !Number.isNaN(n));
  return sqliteQueue.markSyncAttemptFailed(numericIds);
}

/**
 * Mark the given pings as permanently failed (server clock-skew rejection).
 *
 * MMKV: sets a flag on each row so getUnsyncedLocations excludes it; the
 * row sticks around for forensic inspection until the 48h age purge.
 *
 * SQLite: no-op (with warning). The legacy backend has no permanentlyFailed
 * column and Phase 5 deletes this dispatcher along with it. Skew-rejected
 * rows on SQLite will retry until the 20-attempt escape hatch inside
 * purgeStaleUnsynced kicks in — worse than MMKV but bounded and acceptable
 * for the shrinking SQLite cohort.
 */
export async function markPermanentlyFailed(ids: string[]): Promise<void> {
  if (ensureResolved() === 'mmkv') {
    return mmkvQueue.markPermanentlyFailed(ids);
  }
  lg.warn(
    `markPermanentlyFailed on SQLite backend is a no-op (${ids.length} ids). ` +
      `Pings will retry until the 20-attempt escape hatch. See Phase 5 cleanup.`,
  );
}

export async function purgeStaleUnsynced(
  maxAttempts?: number,
  maxAgeMs?: number,
): Promise<PurgeResult> {
  if (ensureResolved() === 'mmkv') {
    return mmkvQueue.purgeStaleUnsynced(maxAttempts, maxAgeMs);
  }
  const res = await sqliteQueue.purgeStaleUnsynced(maxAttempts, maxAgeMs);
  return {
    deleted: res.deleted,
    sample: res.sample.map(sqliteSampleToAdapted),
  };
}

// ============================================================================
// CLEANUP API
// ============================================================================

export async function deleteAllForLoad(loadId: string): Promise<number> {
  if (ensureResolved() === 'mmkv') {
    return mmkvQueue.deleteAllForLoad(loadId);
  }
  return sqliteQueue.deleteAllForLoad(loadId);
}

/**
 * Nuke the local queue. Used by the App Settings → Reset tracking storage
 * button (added in PR #104, not in this main-based branch yet).
 *
 * - MMKV backend: clearAll, instant.
 * - SQLite backend: no-op with warning, since main-branch location-db.ts
 *   doesn't expose a reset entrypoint. When #104 merges, this branch can
 *   wire up to the `resetLocationDb` export from that PR.
 */
export async function resetLocationQueue(): Promise<void> {
  if (ensureResolved() === 'mmkv') {
    return mmkvQueue.resetLocationQueue();
  }
  lg.warn('resetLocationQueue on SQLite backend is a no-op on main (see PR #104).');
}

// ============================================================================
// STARTUP HOOKS
// ============================================================================

/**
 * Run the one-shot MMKV migration if (a) we're on the MMKV backend and
 * (b) we haven't migrated already this install. On SQLite backend this
 * is a no-op — there's nothing to migrate into.
 */
export async function migrateIfNeeded(): Promise<void> {
  if (ensureResolved() === 'mmkv') {
    await mmkvQueue.migrateFromLegacyStoresOnce();
  }
}
