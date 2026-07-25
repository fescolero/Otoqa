import * as SQLite from 'expo-sqlite';
import { log } from './log';

const lg = log('LocationDB');

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
// Mutex for concurrent getDb() callers — prevents two concurrent openAndInit() races.
let dbInitPromise: Promise<SQLite.SQLiteDatabase> | null = null;

function isRecoverableDbError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return (
    message.includes('NativeDatabase.execAsync') ||
    message.includes('NullPointerException') ||
    message.includes('Access to closed')
  );
}

async function resetDbHandle(): Promise<void> {
  const stale = db;
  // Null both module-level refs immediately — before any await — so concurrent
  // getDb() callers that run during the close see a clean slate and open a
  // fresh handle rather than getting the (about-to-be-closed) stale one.
  db = null;
  dbInitPromise = null;
  if (stale) {
    // Fire-and-forget: do NOT await closeAsync(). Concurrent callers may hold a
    // direct reference to `stale` with an in-flight runAsync(); awaiting close
    // here would destroy the native handle while their operation is executing,
    // causing NullPointerException. Releasing the module reference now lets the
    // GC reclaim the native handle once all in-flight operations complete.
    stale.closeAsync().catch(() => {});
  }
}

async function withDbRetry<T>(fn: () => Promise<T>): Promise<T> {
  try {
    return await fn();
  } catch (error) {
    if (!isRecoverableDbError(error)) throw error;
    lg.warn('Recoverable DB error, reopening and retrying once');
    await resetDbHandle();
    return await fn();
  }
}

export interface LocationRow {
  id: number;
  driverId: string;
  loadId: string | null; // Session-only pings (pre-check-in) have no attached load
  sessionId: string | null; // Phase 1+ pings always carry sessionId; legacy rows are null
  organizationId: string;
  latitude: number;
  longitude: number;
  accuracy: number | null;
  speed: number | null;
  heading: number | null;
  recordedAt: number;
  createdAt: number;
  synced: number; // 0 = unsynced, 1 = synced
  syncAttempts: number; // v3+: incremented each time a sync cycle fails to mark this row synced
  firstAttemptAt: number | null; // v3+: ms epoch of the first sync attempt for this row
}

// Schema version tracked via SQLite's user_version pragma.
// v1: initial schema (loadId NOT NULL, no sessionId).
// v2: loadId made nullable, sessionId column + index added.
// v3: syncAttempts + firstAttemptAt columns added — escape hatch for the
//     sync-rejection infinite loop. Rows that fail enough times or sit
//     unsynced too long get purged (see purgeStaleUnsynced below).
const CURRENT_SCHEMA_VERSION = 3;

const SCHEMA_V3_SQL = `
  CREATE TABLE IF NOT EXISTS locations (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    driverId TEXT NOT NULL,
    loadId TEXT,
    sessionId TEXT,
    organizationId TEXT NOT NULL,
    latitude REAL NOT NULL,
    longitude REAL NOT NULL,
    accuracy REAL,
    speed REAL,
    heading REAL,
    recordedAt REAL NOT NULL,
    createdAt REAL NOT NULL,
    synced INTEGER NOT NULL DEFAULT 0,
    syncAttempts INTEGER NOT NULL DEFAULT 0,
    firstAttemptAt INTEGER
  );
  CREATE INDEX IF NOT EXISTS idx_locations_load_synced ON locations (loadId, synced);
  CREATE INDEX IF NOT EXISTS idx_locations_session_synced ON locations (sessionId, synced);
  CREATE INDEX IF NOT EXISTS idx_locations_synced ON locations (synced);
  CREATE INDEX IF NOT EXISTS idx_locations_recorded ON locations (recordedAt);
`;

/**
 * v1 → v2 migration: add sessionId column, make loadId nullable.
 *
 * SQLite doesn't support `ALTER TABLE ... ALTER COLUMN` for constraint
 * changes, so we rebuild the table: create v2 → copy v1 rows → drop v1 →
 * rename. All inside a transaction so a mid-migration crash leaves the
 * old table intact.
 *
 * Existing rows keep their loadId; sessionId backfills as NULL. Those rows
 * will sync through the legacy loadId-based ingest path on next resume.
 */
async function migrateV1ToV2(database: SQLite.SQLiteDatabase): Promise<void> {
  lg.debug('Migrating schema v1 → v2');
  await database.execAsync(`
    BEGIN TRANSACTION;

    CREATE TABLE locations_v2 (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      driverId TEXT NOT NULL,
      loadId TEXT,
      sessionId TEXT,
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

    INSERT INTO locations_v2
      (id, driverId, loadId, sessionId, organizationId, latitude, longitude,
       accuracy, speed, heading, recordedAt, createdAt, synced)
    SELECT
      id, driverId, loadId, NULL, organizationId, latitude, longitude,
      accuracy, speed, heading, recordedAt, createdAt, synced
    FROM locations;

    DROP TABLE locations;
    ALTER TABLE locations_v2 RENAME TO locations;

    CREATE INDEX idx_locations_load_synced ON locations (loadId, synced);
    CREATE INDEX idx_locations_session_synced ON locations (sessionId, synced);
    CREATE INDEX idx_locations_synced ON locations (synced);
    CREATE INDEX idx_locations_recorded ON locations (recordedAt);

    PRAGMA user_version = 2;

    COMMIT;
  `);
  lg.debug('Schema migration v1 → v2 complete');
}

/**
 * v2 → v3 migration: add syncAttempts + firstAttemptAt columns.
 *
 * Pure ALTER TABLE — no rebuild required because we're only ADDING
 * columns with defaults. Both new columns are nullable (firstAttemptAt)
 * or have defaults (syncAttempts), so existing rows are valid as-is.
 *
 * SQLite's ALTER TABLE ADD COLUMN is atomic-per-statement; we still
 * wrap in a transaction so the user_version bump only commits if both
 * adds succeed.
 */
async function migrateV2ToV3(database: SQLite.SQLiteDatabase): Promise<void> {
  lg.debug('Migrating schema v2 → v3');
  await database.execAsync(`
    BEGIN TRANSACTION;

    ALTER TABLE locations ADD COLUMN syncAttempts INTEGER NOT NULL DEFAULT 0;
    ALTER TABLE locations ADD COLUMN firstAttemptAt INTEGER;

    PRAGMA user_version = 3;

    COMMIT;
  `);
  lg.debug('Schema migration v2 → v3 complete');
}

async function openAndInit(): Promise<SQLite.SQLiteDatabase> {
  const newDb = await SQLite.openDatabaseAsync(DB_NAME);
  await newDb.execAsync('PRAGMA journal_mode = WAL;');

  const versionRow = await newDb.getFirstAsync<{ user_version: number }>(
    'PRAGMA user_version'
  );
  const currentVersion = versionRow?.user_version ?? 0;

  if (currentVersion === 0) {
    // Fresh install — create the latest schema directly.
    await newDb.execAsync(SCHEMA_V3_SQL);
    await newDb.execAsync(`PRAGMA user_version = ${CURRENT_SCHEMA_VERSION};`);
    lg.debug(`Initialized fresh schema at v${CURRENT_SCHEMA_VERSION}`);
  } else if (currentVersion < CURRENT_SCHEMA_VERSION) {
    // Sequential migrations — apply each step that's needed. Each migration
    // bumps user_version, so a crash mid-chain leaves the DB at the last
    // successful step and the next launch picks up where we left off.
    if (currentVersion < 2) await migrateV1ToV2(newDb);
    if (currentVersion < 3) await migrateV2ToV3(newDb);
  } else if (currentVersion > CURRENT_SCHEMA_VERSION) {
    // Downgrade (user re-installed older app over newer data). Log and proceed;
    // the schema is forward-compatible enough that inserts will still work.
    lg.warn(
      `DB at version ${currentVersion}, app expects ${CURRENT_SCHEMA_VERSION}. Proceeding.`
    );
  }

  return newDb;
}

async function getDb(): Promise<SQLite.SQLiteDatabase> {
  // Join any in-flight init first — prevents two concurrent openAndInit() calls.
  if (dbInitPromise) return dbInitPromise;

  if (db) {
    // Verify the native handle is still alive. Android can destroy it after
    // long background periods while the JS reference remains cached.
    try {
      await db.execAsync('SELECT 1');
      // Re-check after the yield: another caller may have started a reinit.
      if (dbInitPromise) return dbInitPromise;
      return db;
    } catch {
      lg.warn('Stale DB handle detected, reopening...');
      // Fall through to claim the mutex below.
    }
  }

  // Claim mutex synchronously (no await before assignment) so concurrent
  // callers that reach here after the probe-yield all join the same promise.
  if (!dbInitPromise) {
    const staleDb = db;
    db = null; // clear immediately so concurrent probes fail fast
    dbInitPromise = (async () => {
      if (staleDb) {
        try {
          await staleDb.closeAsync();
        } catch {
          /* already dead */
        }
      }
      const newDb = await openAndInit();
      db = newDb;
      return newDb;
    })().finally(() => {
      dbInitPromise = null;
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
  await resetDbHandle();
  await getDb(); // uses mutex so concurrent callers share one openAndInit()
  lg.debug('Database connection refreshed');
}

// ============================================
// WRITE OPERATIONS
// ============================================

export interface LocationInput {
  driverId: string;
  // Either loadId or sessionId (or both) must be present. Enforced below.
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

function assertHasAnchor(loc: LocationInput): void {
  if (!loc.loadId && !loc.sessionId) {
    throw new Error('insertLocation: loadId or sessionId required');
  }
}

export async function insertLocation(loc: LocationInput): Promise<number> {
  assertHasAnchor(loc);
  const args = [
    loc.driverId,
    loc.loadId ?? null,
    loc.sessionId ?? null,
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
      `INSERT INTO locations (driverId, loadId, sessionId, organizationId, latitude, longitude, accuracy, speed, heading, recordedAt, createdAt, synced)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0)`,
      ...args,
    );
    return result.lastInsertRowId;
  });
}

export async function insertLocationBatch(locations: LocationInput[]): Promise<number> {
  if (locations.length === 0) return 0;
  for (const loc of locations) assertHasAnchor(loc);

  return withDbRetry(async () => {
    const database = await getDb();
    const now = Date.now();
    let inserted = 0;

    const stmt = await database.prepareAsync(
      `INSERT INTO locations (driverId, loadId, sessionId, organizationId, latitude, longitude, accuracy, speed, heading, recordedAt, createdAt, synced)
       VALUES ($driverId, $loadId, $sessionId, $orgId, $lat, $lng, $acc, $spd, $hdg, $rec, $cre, 0)`,
    );

    try {
      for (const loc of locations) {
        await stmt.executeAsync({
          $driverId: loc.driverId,
          $loadId: loc.loadId ?? null,
          $sessionId: loc.sessionId ?? null,
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

/**
 * Record that a sync cycle failed to mark these rows synced.
 *
 * Increments syncAttempts for each row (so the escape hatch in
 * purgeStaleUnsynced can give up after enough tries) and stamps
 * firstAttemptAt on rows that haven't been tried before (so the age
 * cutoff has a stable reference even if recordedAt is far in the past
 * from offline accumulation).
 *
 * Called from syncUnsyncedToConvex for any row that wasn't covered by
 * the server's inserted/duplicates/permanentlyRejected counts.
 */
export async function markSyncAttemptFailed(ids: number[]): Promise<void> {
  if (ids.length === 0) return;
  await withDbRetry(async () => {
    const database = await getDb();
    const placeholders = ids.map(() => '?').join(',');
    const now = Date.now();
    await database.runAsync(
      `UPDATE locations
         SET syncAttempts = syncAttempts + 1,
             firstAttemptAt = COALESCE(firstAttemptAt, ?)
         WHERE id IN (${placeholders})`,
      now,
      ...ids,
    );
  });
}

export interface PurgeResult {
  deleted: number;
  // Sample of purged rows for telemetry — we intentionally only keep a few
  // so the event payload stays small. Bug-hunting upstream uses these.
  sample: Array<{
    id: number;
    driverId: string;
    sessionId: string | null;
    loadId: string | null;
    syncAttempts: number;
    ageMs: number;
  }>;
}

/**
 * Hard-delete unsynced rows that have exhausted retry budget.
 *
 * Two cutoffs (logical OR — either triggers purge):
 *   • syncAttempts >= maxAttempts (default 20 ≈ 40 min at 2-min sync interval)
 *   • now - createdAt > maxAgeMs   (default 48h — the user-confirmed
 *                                    realistic max offline window; 12h is
 *                                    rare already, 48h covers edge cases)
 *
 * Returns the count + a small sample (max 5 rows) for telemetry. The
 * caller is expected to fire a tracking event so we can spot persistent
 * upstream issues (a specific driver/org systematically losing pings).
 */
export async function purgeStaleUnsynced(
  maxAttempts: number = 20,
  maxAgeMs: number = 48 * 60 * 60 * 1000,
): Promise<PurgeResult> {
  return withDbRetry(async () => {
    const database = await getDb();
    const now = Date.now();
    const ageCutoff = now - maxAgeMs;

    // Read sample BEFORE delete so we can include row details in telemetry.
    const sample = await database.getAllAsync<{
      id: number;
      driverId: string;
      sessionId: string | null;
      loadId: string | null;
      syncAttempts: number;
      createdAt: number;
    }>(
      `SELECT id, driverId, sessionId, loadId, syncAttempts, createdAt
         FROM locations
         WHERE synced = 0
           AND (syncAttempts >= ? OR createdAt < ?)
         ORDER BY createdAt ASC
         LIMIT 5`,
      maxAttempts,
      ageCutoff,
    );

    const result = await database.runAsync(
      `DELETE FROM locations
         WHERE synced = 0
           AND (syncAttempts >= ? OR createdAt < ?)`,
      maxAttempts,
      ageCutoff,
    );

    type SampleRow = {
      id: number;
      driverId: string;
      sessionId: string | null;
      loadId: string | null;
      syncAttempts: number;
      createdAt: number;
    };
    return {
      deleted: result.changes,
      sample: (sample as SampleRow[]).map((r) => ({
        id: r.id,
        driverId: r.driverId,
        sessionId: r.sessionId,
        loadId: r.loadId,
        syncAttempts: r.syncAttempts,
        ageMs: now - r.createdAt,
      })),
    };
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

/**
 * Last-point reader for session-scoped distance filtering. Used by the
 * background task when the driver is on shift but not yet on a load —
 * pings have sessionId but no loadId, so load-scoped lookup finds nothing.
 */
export async function getLastLocationForSession(
  sessionId: string,
): Promise<{ latitude: number; longitude: number; recordedAt: number } | null> {
  return withDbRetry(async () => {
    const database = await getDb();
    const row = await database.getFirstAsync<{
      latitude: number;
      longitude: number;
      recordedAt: number;
    }>(
      'SELECT latitude, longitude, recordedAt FROM locations WHERE sessionId = ? ORDER BY recordedAt DESC LIMIT 1',
      sessionId,
    );
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
    await db.closeAsync();
    db = null;
  }
}
