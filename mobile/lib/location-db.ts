import * as SQLite from 'expo-sqlite';

// ============================================
// SQLITE-BACKED GPS LOCATION STORE
// Durable storage for GPS points that survives:
// - Auth token expiration
// - App backgrounding / OS killing the JS context
// - Network failures
// - App restarts
//
// Points are only deleted AFTER confirmed synced to Convex.
// ============================================

const DB_NAME = 'otoqa_locations.db';

// ============================================
// CONNECTION STRATEGY — ALWAYS OPEN FRESH
//
// We intentionally do NOT cache the SQLiteDatabase handle across operations.
//
// Root cause of the recurring NullPointerException (NativeDatabase.execAsync):
//   Android's JVM GC destroys the native NativeDatabase object while the JS/JSI
//   reference remains alive. On Android 16 (Samsung SM-S911U, OS version 16) this
//   happens aggressively, triggering NPE bursts every 50–60 minutes during a shift.
//   Retrying with the same cached handle only delays the same failure.
//
// Fix 1 (current): getDb() closes the previous connection and calls openDatabaseAsync
//   fresh on every operation. The connection lives only for the duration of the fn()
//   call, then goes out of scope. No stale handle, no GC problem.
//   All ops run through opQueue so close/open is always sequential — no concurrent
//   handle races, no leaked file descriptors.
//
// If NPE bursts continue after this fix, escalate to:
//   Fix 2: Switch to openDatabaseSync() — synchronous connections bypass the async
//     JNI boundary that is susceptible to Android GC. expo-sqlite 16 supports it via
//     SQLite.openDatabaseSync(DB_NAME). Requires wrapping callers in withExclusiveTransactionSync.
//     See: https://docs.expo.dev/versions/latest/sdk/sqlite/#sqliteopendatabasesyncname
//
//   Fix 3: Upgrade expo-sqlite — 16.0.x has open Android NPE issues tracked in the
//     Expo repo (expo-sqlite Android NullPointerException). A patch release or upgrade
//     to 17.x may include a native fix for NativeDatabase GC on Android 16+.
//     Monitor: https://github.com/expo/expo/issues?q=sqlite+NullPointerException
// ============================================

let db: SQLite.SQLiteDatabase | null = null;

function isRecoverableDbError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return (
    message.includes('NativeDatabase.execAsync') ||
    message.includes('NullPointerException') ||
    message.includes('Access to closed')
  );
}

const SCHEMA_SQL = `
  PRAGMA journal_mode = WAL;
  CREATE TABLE IF NOT EXISTS locations (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    driverId TEXT NOT NULL,
    loadId TEXT NOT NULL,
    organizationId TEXT NOT NULL,
    latitude REAL NOT NULL,
    longitude REAL NOT NULL,
    accuracy REAL,
    speed REAL,
    heading REAL,
    recordedAt REAL NOT NULL,
    createdAt REAL NOT NULL,
    synced INTEGER NOT NULL DEFAULT 0
  );
  CREATE INDEX IF NOT EXISTS idx_locations_load_synced ON locations (loadId, synced);
  CREATE INDEX IF NOT EXISTS idx_locations_synced ON locations (synced);
  CREATE INDEX IF NOT EXISTS idx_locations_recorded ON locations (recordedAt);
`;

async function openAndInit(): Promise<SQLite.SQLiteDatabase> {
  const newDb = await SQLite.openDatabaseAsync(DB_NAME);
  await newDb.execAsync(SCHEMA_SQL);
  return newDb;
}

// Always opens a fresh connection. Closes the previous one first to prevent
// file-descriptor accumulation. Because all callers run through opQueue, this
// close→open is always sequential — no concurrent handle access.
async function getDb(): Promise<SQLite.SQLiteDatabase> {
  if (db) {
    try {
      await db.closeAsync();
    } catch {
      // Already dead — safe to ignore, we're replacing it anyway.
    }
    db = null;
  }
  const newDb = await openAndInit();
  db = newDb;
  return newDb;
}

// Serializes all SQLite operations through a single promise chain.
// Ensures close→open in getDb() is never concurrent with another operation.
let opQueue: Promise<unknown> = Promise.resolve();

// Circuit breaker: trips when all retry attempts fail (native layer unrecoverable).
// Prevents a dead native module from cascading — callers skip to AsyncStorage
// fallback immediately instead of each burning through 3 retry cycles.
// Cleared by reopenDb() on foreground resume.
let dbDead = false;

async function withDbRetry<T>(fn: () => Promise<T>): Promise<T> {
  const queued = opQueue.then(async (): Promise<T> => {
    if (dbDead) {
      throw new Error('[LocationDB] DB unavailable, using fallback');
    }
    try {
      return await fn();
    } catch (error) {
      if (!isRecoverableDbError(error)) throw error;
      // getDb() always opens fresh, so retrying fn() automatically uses a new
      // native connection — no explicit handle reset needed between attempts.
      console.warn('[LocationDB] Recoverable DB error (attempt 1), retrying with fresh connection...');
      try {
        return await fn();
      } catch (retryError) {
        if (!isRecoverableDbError(retryError)) throw retryError;
        console.warn('[LocationDB] Recoverable DB error (attempt 2), waiting 300ms...');
        await new Promise<void>((r) => setTimeout(r, 300));
        try {
          return await fn();
        } catch (finalError) {
          // All 3 attempts exhausted — trip the circuit breaker.
          // Subsequent ops skip immediately to AsyncStorage fallback until
          // reopenDb() confirms the native layer is healthy again.
          dbDead = true;
          throw finalError;
        }
      }
    }
  });
  // Absorb errors in the chain so a failed op doesn't block subsequent ones.
  opQueue = queued.catch(() => {});
  return queued;
}

export interface LocationRow {
  id: number;
  driverId: string;
  loadId: string;
  organizationId: string;
  latitude: number;
  longitude: number;
  accuracy: number | null;
  speed: number | null;
  heading: number | null;
  recordedAt: number;
  createdAt: number;
  synced: number; // 0 = unsynced, 1 = synced
}

/**
 * Verify the database connection is healthy and clear the circuit breaker.
 * Routes through opQueue so it cannot race with an in-flight insert.
 * Call on foreground resume to allow ops to resume after a dead-native-layer event.
 */
export async function reopenDb(): Promise<void> {
  const queued = opQueue.then(async () => {
    dbDead = false;
    try {
      // getDb() closes any stale handle and opens fresh — acts as a health probe.
      await getDb();
      console.log('[LocationDB] Database connection verified OK');
    } catch (err) {
      dbDead = true; // native layer still broken — stay dead until next foreground resume
      console.warn('[LocationDB] DB still unavailable after reopen:', err);
    }
  });
  opQueue = queued.catch(() => {});
  await queued;
}

// ============================================
// WRITE OPERATIONS
// ============================================

export async function insertLocation(loc: {
  driverId: string;
  loadId: string;
  organizationId: string;
  latitude: number;
  longitude: number;
  accuracy: number | null;
  speed: number | null;
  heading: number | null;
  recordedAt: number;
}): Promise<number> {
  const args = [
    loc.driverId,
    loc.loadId,
    loc.organizationId,
    loc.latitude,
    loc.longitude,
    loc.accuracy,
    loc.speed,
    loc.heading,
    loc.recordedAt,
    Date.now(),
  ] as const;

  return withDbRetry(async () => {
    const database = await getDb();
    const result = await database.runAsync(
      `INSERT INTO locations (driverId, loadId, organizationId, latitude, longitude, accuracy, speed, heading, recordedAt, createdAt, synced)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0)`,
      ...args,
    );
    return result.lastInsertRowId;
  });
}

export async function insertLocationBatch(
  locations: Array<{
    driverId: string;
    loadId: string;
    organizationId: string;
    latitude: number;
    longitude: number;
    accuracy: number | null;
    speed: number | null;
    heading: number | null;
    recordedAt: number;
  }>,
): Promise<number> {
  if (locations.length === 0) return 0;

  return withDbRetry(async () => {
    const database = await getDb();
    const now = Date.now();
    let inserted = 0;

    const stmt = await database.prepareAsync(
      `INSERT INTO locations (driverId, loadId, organizationId, latitude, longitude, accuracy, speed, heading, recordedAt, createdAt, synced)
       VALUES ($driverId, $loadId, $orgId, $lat, $lng, $acc, $spd, $hdg, $rec, $cre, 0)`,
    );

    try {
      for (const loc of locations) {
        await stmt.executeAsync({
          $driverId: loc.driverId,
          $loadId: loc.loadId,
          $orgId: loc.organizationId,
          $lat: loc.latitude,
          $lng: loc.longitude,
          $acc: loc.accuracy,
          $spd: loc.speed,
          $hdg: loc.heading,
          $rec: loc.recordedAt,
          $cre: now,
        });
        inserted++;
      }
    } finally {
      await stmt.finalizeAsync();
    }

    return inserted;
  });
}

// ============================================
// READ OPERATIONS
// ============================================

export async function getUnsyncedLocations(limit = 100): Promise<LocationRow[]> {
  return withDbRetry(async () => {
    const database = await getDb();
    return database.getAllAsync<LocationRow>(
      'SELECT * FROM locations WHERE synced = 0 ORDER BY recordedAt ASC LIMIT ?',
      limit,
    );
  });
}

export async function getUnsyncedForLoad(loadId: string, limit = 500): Promise<LocationRow[]> {
  return withDbRetry(async () => {
    const database = await getDb();
    return database.getAllAsync<LocationRow>(
      'SELECT * FROM locations WHERE loadId = ? AND synced = 0 ORDER BY recordedAt ASC LIMIT ?',
      loadId,
      limit,
    );
  });
}

export async function getUnsyncedCount(): Promise<number> {
  return withDbRetry(async () => {
    const database = await getDb();
    const row = await database.getFirstAsync<{ count: number }>(
      'SELECT COUNT(*) as count FROM locations WHERE synced = 0',
    );
    return row?.count ?? 0;
  });
}

export async function getUnsyncedCountForLoad(loadId: string): Promise<number> {
  return withDbRetry(async () => {
    const database = await getDb();
    const row = await database.getFirstAsync<{ count: number }>(
      'SELECT COUNT(*) as count FROM locations WHERE loadId = ? AND synced = 0',
      loadId,
    );
    return row?.count ?? 0;
  });
}

export async function getTotalCountForLoad(loadId: string): Promise<number> {
  return withDbRetry(async () => {
    const database = await getDb();
    const row = await database.getFirstAsync<{ count: number }>(
      'SELECT COUNT(*) as count FROM locations WHERE loadId = ?',
      loadId,
    );
    return row?.count ?? 0;
  });
}

// ============================================
// SYNC OPERATIONS
// ============================================

export async function markAsSynced(ids: number[]): Promise<void> {
  if (ids.length === 0) return;
  await withDbRetry(async () => {
    const database = await getDb();
    const placeholders = ids.map(() => '?').join(',');
    await database.runAsync(`UPDATE locations SET synced = 1 WHERE id IN (${placeholders})`, ...ids);
  });
}

export async function deleteOldSyncedLocations(olderThanMs: number = 7 * 24 * 60 * 60 * 1000): Promise<number> {
  return withDbRetry(async () => {
    const database = await getDb();
    const cutoff = Date.now() - olderThanMs;
    const result = await database.runAsync('DELETE FROM locations WHERE synced = 1 AND createdAt < ?', cutoff);
    return result.changes;
  });
}

// ============================================
// LAST POINT (for distance filtering)
// ============================================

export async function getLastLocationForLoad(
  loadId: string,
): Promise<{ latitude: number; longitude: number; recordedAt: number } | null> {
  return withDbRetry(async () => {
    const database = await getDb();
    const row = await database.getFirstAsync<{
      latitude: number;
      longitude: number;
      recordedAt: number;
    }>('SELECT latitude, longitude, recordedAt FROM locations WHERE loadId = ? ORDER BY recordedAt DESC LIMIT 1', loadId);
    return row ?? null;
  });
}

// ============================================
// CLEANUP
// ============================================

export async function deleteAllForLoad(loadId: string): Promise<number> {
  return withDbRetry(async () => {
    const database = await getDb();
    const result = await database.runAsync('DELETE FROM locations WHERE loadId = ?', loadId);
    return result.changes;
  });
}

export async function closeDb(): Promise<void> {
  if (db) {
    try {
      await db.closeAsync();
    } catch {
      // ignore
    }
    db = null;
  }
}
