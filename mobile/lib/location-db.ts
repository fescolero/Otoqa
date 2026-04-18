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
//
// ANDROID 16 GC NOTE (Fix #8 — merged to main 2026-04-17)
// -------------------------------------------------------
// On Samsung devices running Android 16, the JVM garbage collector
// aggressively destroys the NativeDatabase object between operations.
// expo-sqlite's JSI bridge only stores a numeric handleId; when the JVM
// destroys the backing object, subsequent calls via that handleId throw
// "NativeDatabase.execAsync has been rejected → NullPointerException".
//
// A module-level cache (`let db`) cannot solve this — the handle can be
// probed successfully with `SELECT 1`, then GC fires, then the next op
// fails. Retries against the same cached handle fail the same way.
//
// The fix: open a fresh connection on every operation. The pattern is
// open → run → (let the native layer release). There is no module-level
// cache. Each operation gets a new handleId that cannot be dead yet.
//
// Performance: ~5–10ms per open on Android. At ~3 ops/min this is
// negligible and far cheaper than silently dropping GPS data.
// ============================================

const DB_NAME = 'otoqa_locations.db';

function isRecoverableDbError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return (
    message.includes('NativeDatabase.execAsync') ||
    message.includes('NullPointerException') ||
    message.includes('Access to closed')
  );
}

/**
 * Run a DB operation with a fresh connection, close it after, retry once
 * on recoverable errors.
 *
 * The caller receives the opened `database` as an argument. This ensures
 * each operation has its own live handle for the duration of the op —
 * no shared/cached handle that Android GC can destroy between calls.
 *
 * The close is fire-and-forget (no await) so the next op doesn't wait
 * on the close. If there are concurrent ops, each one has its own
 * independent handle.
 */
async function withDbRetry<T>(fn: (database: SQLite.SQLiteDatabase) => Promise<T>): Promise<T> {
  const runOnce = async (): Promise<T> => {
    const database = await getDb();
    try {
      return await fn(database);
    } finally {
      database.closeAsync().catch(() => {});
    }
  };
  try {
    return await runOnce();
  } catch (error) {
    if (!isRecoverableDbError(error)) throw error;
    console.warn('[LocationDB] Recoverable DB error, retrying with fresh handle');
    return await runOnce();
  }
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

/**
 * Open a fresh database connection and run the idempotent schema setup.
 * Called on EVERY operation — there is no module-level cache. This is the
 * Fix #8 approach to Android 16's aggressive JVM GC destroying the
 * NativeDatabase object between operations.
 *
 * `CREATE TABLE IF NOT EXISTS` and `CREATE INDEX IF NOT EXISTS` make the
 * schema setup idempotent and ~fast after the first invocation.
 */
async function getDb(): Promise<SQLite.SQLiteDatabase> {
  const newDb = await SQLite.openDatabaseAsync(DB_NAME);
  await newDb.execAsync(SCHEMA_SQL);
  return newDb;
}

/**
 * No-op. Preserved for API compatibility with callers from the pre-Fix-#8
 * cache-based design. There is no cached handle to reopen; every operation
 * opens fresh.
 */
export async function reopenDb(): Promise<void> {
  // intentional no-op — fresh connection per op, see module comment
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

  return withDbRetry(async (database) => {
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

  return withDbRetry(async (database) => {
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
  return withDbRetry(async (database) => {
    return database.getAllAsync<LocationRow>(
      'SELECT * FROM locations WHERE synced = 0 ORDER BY recordedAt ASC LIMIT ?',
      limit,
    );
  });
}

export async function getUnsyncedForLoad(loadId: string, limit = 500): Promise<LocationRow[]> {
  return withDbRetry(async (database) => {
    return database.getAllAsync<LocationRow>(
      'SELECT * FROM locations WHERE loadId = ? AND synced = 0 ORDER BY recordedAt ASC LIMIT ?',
      loadId,
      limit,
    );
  });
}

export async function getUnsyncedCount(): Promise<number> {
  return withDbRetry(async (database) => {
    const row = await database.getFirstAsync<{ count: number }>(
      'SELECT COUNT(*) as count FROM locations WHERE synced = 0',
    );
    return row?.count ?? 0;
  });
}

export async function getUnsyncedCountForLoad(loadId: string): Promise<number> {
  return withDbRetry(async (database) => {
    const row = await database.getFirstAsync<{ count: number }>(
      'SELECT COUNT(*) as count FROM locations WHERE loadId = ? AND synced = 0',
      loadId,
    );
    return row?.count ?? 0;
  });
}

export async function getTotalCountForLoad(loadId: string): Promise<number> {
  return withDbRetry(async (database) => {
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
  await withDbRetry(async (database) => {
    const placeholders = ids.map(() => '?').join(',');
    await database.runAsync(`UPDATE locations SET synced = 1 WHERE id IN (${placeholders})`, ...ids);
  });
}

export async function deleteOldSyncedLocations(olderThanMs: number = 7 * 24 * 60 * 60 * 1000): Promise<number> {
  return withDbRetry(async (database) => {
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
  return withDbRetry(async (database) => {
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
  return withDbRetry(async (database) => {
    const result = await database.runAsync('DELETE FROM locations WHERE loadId = ?', loadId);
    return result.changes;
  });
}

export async function closeDb(): Promise<void> {
  // No-op — fresh connection per op means nothing to close at the module level.
  // Preserved for API compatibility.
}
