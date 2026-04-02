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

let db: SQLite.SQLiteDatabase | null = null;
// Mutex: prevents concurrent callers from each spawning their own openAndInit()
// when db is null (e.g. multiple GPS callbacks firing simultaneously at startup).
let dbInitPromise: Promise<SQLite.SQLiteDatabase> | null = null;

function isRecoverableDbError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return (
    message.includes('NativeDatabase') ||
    message.includes('NullPointerException') ||
    message.includes('Access to closed')
  );
}

async function resetDbHandle(): Promise<void> {
  dbInitPromise = null;
  if (db) {
    try {
      await db.closeAsync();
    } catch {
      // ignore dead native handles
    }
    db = null;
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

async function openAndInit(): Promise<SQLite.SQLiteDatabase> {
  const newDb = await SQLite.openDatabaseAsync(DB_NAME);
  // Android: the native handle can be transiently null immediately after
  // openDatabaseAsync resolves, causing execAsync to throw NullPointerException.
  // Retry with exponential backoff to give the native layer time to finish init.
  const RETRY_DELAYS_MS = [300, 600, 1200];
  let lastErr: unknown;
  for (let attempt = 0; attempt <= RETRY_DELAYS_MS.length; attempt++) {
    try {
      await newDb.execAsync(SCHEMA_SQL);
      return newDb;
    } catch (err) {
      if (!isRecoverableDbError(err)) throw err;
      lastErr = err;
      if (attempt < RETRY_DELAYS_MS.length) {
        await new Promise<void>((r) => setTimeout(r, RETRY_DELAYS_MS[attempt]));
      }
    }
  }
  throw lastErr as Error;
}

async function getDb(): Promise<SQLite.SQLiteDatabase> {
  if (db) {
    // Verify the native handle is still alive. Android can destroy it after
    // long background periods while the JS reference remains cached.
    try {
      await db.execAsync('SELECT 1');
      return db;
    } catch {
      console.warn('[LocationDB] Stale DB handle detected, reopening...');
      try {
        await db.closeAsync();
      } catch {
        /* already dead */
      }
      db = null;
      dbInitPromise = null;
    }
  }

  // Serialize concurrent callers: only one openAndInit() runs at a time.
  if (!dbInitPromise) {
    dbInitPromise = openAndInit()
      .then((newDb) => {
        db = newDb;
        dbInitPromise = null;
        return newDb;
      })
      .catch((err) => {
        dbInitPromise = null;
        throw err;
      });
  }

  return dbInitPromise;
}

/**
 * Force-close and reopen the database connection.
 * Call on foreground resume to proactively replace handles that Android
 * may have invalidated while the app was backgrounded.
 */
export async function reopenDb(): Promise<void> {
  dbInitPromise = null;
  await resetDbHandle();
  db = await openAndInit();
  console.log('[LocationDB] Database connection refreshed');
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

  try {
    const database = await getDb();
    const result = await database.runAsync(
      `INSERT INTO locations (driverId, loadId, organizationId, latitude, longitude, accuracy, speed, heading, recordedAt, createdAt, synced)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0)`,
      ...args,
    );
    return result.lastInsertRowId;
  } catch (error) {
    if (!isRecoverableDbError(error)) throw error;

    console.warn('[LocationDB] Insert failed with stale handle, reopening and retrying once');
    await resetDbHandle();
    await new Promise<void>((r) => setTimeout(r, 150));
    const database = await getDb();
    const result = await database.runAsync(
      `INSERT INTO locations (driverId, loadId, organizationId, latitude, longitude, accuracy, speed, heading, recordedAt, createdAt, synced)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0)`,
      ...args,
    );
    return result.lastInsertRowId;
  }
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
}

// ============================================
// READ OPERATIONS
// ============================================

export async function getUnsyncedLocations(limit = 100): Promise<LocationRow[]> {
  const database = await getDb();
  return await database.getAllAsync<LocationRow>(
    'SELECT * FROM locations WHERE synced = 0 ORDER BY recordedAt ASC LIMIT ?',
    limit,
  );
}

export async function getUnsyncedForLoad(loadId: string, limit = 500): Promise<LocationRow[]> {
  const database = await getDb();
  return await database.getAllAsync<LocationRow>(
    'SELECT * FROM locations WHERE loadId = ? AND synced = 0 ORDER BY recordedAt ASC LIMIT ?',
    loadId,
    limit,
  );
}

export async function getUnsyncedCount(): Promise<number> {
  const database = await getDb();
  const row = await database.getFirstAsync<{ count: number }>(
    'SELECT COUNT(*) as count FROM locations WHERE synced = 0',
  );
  return row?.count ?? 0;
}

export async function getUnsyncedCountForLoad(loadId: string): Promise<number> {
  const database = await getDb();
  const row = await database.getFirstAsync<{ count: number }>(
    'SELECT COUNT(*) as count FROM locations WHERE loadId = ? AND synced = 0',
    loadId,
  );
  return row?.count ?? 0;
}

export async function getTotalCountForLoad(loadId: string): Promise<number> {
  const database = await getDb();
  const row = await database.getFirstAsync<{ count: number }>(
    'SELECT COUNT(*) as count FROM locations WHERE loadId = ?',
    loadId,
  );
  return row?.count ?? 0;
}

// ============================================
// SYNC OPERATIONS
// ============================================

export async function markAsSynced(ids: number[]): Promise<void> {
  if (ids.length === 0) return;
  const database = await getDb();
  const placeholders = ids.map(() => '?').join(',');
  await database.runAsync(`UPDATE locations SET synced = 1 WHERE id IN (${placeholders})`, ...ids);
}

export async function deleteOldSyncedLocations(olderThanMs: number = 7 * 24 * 60 * 60 * 1000): Promise<number> {
  const database = await getDb();
  const cutoff = Date.now() - olderThanMs;
  const result = await database.runAsync('DELETE FROM locations WHERE synced = 1 AND createdAt < ?', cutoff);
  return result.changes;
}

// ============================================
// LAST POINT (for distance filtering)
// ============================================

export async function getLastLocationForLoad(
  loadId: string,
): Promise<{ latitude: number; longitude: number; recordedAt: number } | null> {
  const database = await getDb();
  const row = await database.getFirstAsync<{
    latitude: number;
    longitude: number;
    recordedAt: number;
  }>('SELECT latitude, longitude, recordedAt FROM locations WHERE loadId = ? ORDER BY recordedAt DESC LIMIT 1', loadId);
  return row ?? null;
}

// ============================================
// CLEANUP
// ============================================

export async function deleteAllForLoad(loadId: string): Promise<number> {
  const database = await getDb();
  const result = await database.runAsync('DELETE FROM locations WHERE loadId = ?', loadId);
  return result.changes;
}

export async function closeDb(): Promise<void> {
  if (db) {
    await db.closeAsync();
    db = null;
  }
}
