import * as Location from 'expo-location';
import * as TaskManager from 'expo-task-manager';
import Constants from 'expo-constants';
import { AppState, Platform } from 'react-native';
import { storage } from './storage';
import { convex } from './convex';
import { ConvexHttpClient } from 'convex/browser';
import { api } from '../../convex/_generated/api';
import { Id } from '../../convex/_generated/dataModel';
import {
  insertLocation,
  getUnsyncedLocations,
  getUnsyncedCount,
  markAsSynced,
  markSyncAttemptFailed,
  purgeStaleUnsynced,
  getLastLocationForLoad,
  getLastLocationForSession,
  type LocationInput,
} from './location-storage';
import { log } from './log';
import {
  trackBGTaskFired,
  trackBGTaskResult,
  trackBGTaskError,
  trackBGTaskReregistered,
  trackForegroundResume,
  trackWatchLocationReceived,
  trackWatchLocationFiltered,
  trackWatchLocationSaved,
  trackWatchLocationError,
} from './analytics';
import { requestIgnoreBatteryOptimizationOnce } from './battery-optimization';

// Module-scoped namespaced logger. Debug/info calls are stripped in
// production by Metro; warn/error pass through so Sentry / native
// logs still see degraded-path signals. See lib/log.ts.
const lg = log('LocationTracking');

// ============================================
// LOCATION TRACKING
// Background location tracking for route recording
// Tracks driver from first stop check-in to last stop checkout
// GPS points are stored durably in SQLite and only marked synced
// after confirmed upload to Convex. No data loss on auth failures,
// app kills, or network issues.
// NOTE: Background location requires a development build (not Expo Go)
// ============================================

const LOCATION_TASK_NAME = 'OTOQA_LOCATION_TRACKING';
const TRACKING_STATE_KEY = 'location_tracking_state';

// ============================================
// TRACKING CONFIGURATION
// Tuned for trucking: battery-friendly + smooth route reconstruction.
// At 60 mph a truck covers ~27 m/s → a 250 m distance gate fires every ~9 s.
// The 30-second hard floor prevents that from flooding the DB.
// Result: ~2 pts/min on highway, ~1.5 pts/min in city, 1 pt/5 min stationary.
// ============================================
const TRACKING_INTERVAL_MS = 2 * 60 * 1000; // "enough time" gate — 2 min
const SYNC_INTERVAL_MS = 2 * 60 * 1000; // Sync to server every 2 minutes
const BG_DISTANCE_INTERVAL = 200; // iOS/Android: OS delivers updates every 200 m
const MAX_ACCURACY_METERS = 50; // Reject readings with > 50 m accuracy
const MIN_DISTANCE_BETWEEN_POINTS = 250; // Skip if < 250 m from last point
const MIN_TIME_BETWEEN_SAVES_MS = 30 * 1000; // Hard floor — never save more often than 30 s
const SYNC_BATCH_SIZE = 50; // Max points per sync batch

// ============================================
// BACKGROUND-SAFE CONVEX CLIENT
// The ConvexReactClient requires the React tree for auth.
// In iOS background tasks, React is not mounted so we use
// ConvexHttpClient with a stored JWT token instead.
// For background syncs, we also have a direct HTTP endpoint
// that uses a static API key (no Clerk JWT needed).
// ============================================
const CONVEX_URL = process.env.EXPO_PUBLIC_CONVEX_URL!;
const MOBILE_LOCATION_API_KEY = process.env.EXPO_PUBLIC_MOBILE_LOCATION_API_KEY;

// Derive the HTTP endpoint URL from the Convex deployment URL
// e.g. https://greedy-vole-262.convex.cloud -> https://greedy-vole-262.convex.site
const CONVEX_SITE_URL = CONVEX_URL.replace('.convex.cloud', '.convex.site');

/**
 * Wire shape of a single ping sent to the server. loadId and sessionId
 * are both optional; mutation enforces at-least-one + trackingType match.
 */
type SyncPing = {
  driverId: string;
  loadId?: string;
  sessionId?: string;
  latitude: number;
  longitude: number;
  accuracy?: number;
  speed?: number;
  heading?: number;
  trackingType: 'LOAD_ROUTE' | 'SESSION_ROUTE';
  recordedAt: number;
};

/**
 * Server's structured outcome for a batch insert. See
 * convex/driverLocations.ts::IngestOutcome for full semantics.
 *
 * Pre-PR-1 servers only return `inserted`; the other fields are normalized
 * to 0 in normalizeIngestResponse below so the client can use a single
 * code path either way.
 */
type IngestResponse = {
  inserted: number;
  duplicates: number;
  permanentlyRejected: number;
  transientlyRejected: number;
};

function normalizeIngestResponse(raw: unknown): IngestResponse {
  const r = (raw ?? {}) as Partial<IngestResponse>;
  return {
    inserted: typeof r.inserted === 'number' ? r.inserted : 0,
    duplicates: typeof r.duplicates === 'number' ? r.duplicates : 0,
    permanentlyRejected:
      typeof r.permanentlyRejected === 'number' ? r.permanentlyRejected : 0,
    transientlyRejected:
      typeof r.transientlyRejected === 'number' ? r.transientlyRejected : 0,
  };
}

// Escape-hatch thresholds for the sync-rejection infinite loop.
//   • MAX_SYNC_ATTEMPTS: at the 2-min sync interval this is ~40 min of
//     retries before we give up on a row. Long enough to ride out
//     transient outages; short enough that genuine bad data doesn't
//     block the queue forever.
//   • MAX_PING_AGE_MS: 48h. The user confirmed this is the realistic
//     max offline window for a driver — 12h is rare already, 48h
//     covers edge cases (weekend offline, dead phone in the cab).
//     Anything older is almost certainly never going to land — purge
//     it so the queue stays bounded.
const MAX_SYNC_ATTEMPTS = 20;
const MAX_PING_AGE_MS = 48 * 60 * 60 * 1000;

/**
 * Apply the server's structured outcome to a batch of attempted-to-sync
 * rows, then run the escape-hatch purge.
 *
 * Returns true if any rows were marked synced (i.e. the batch made
 * progress). The caller uses this to decide whether to continue
 * recursive batching — false means the same rows would be re-selected
 * next iteration, so stop.
 *
 * Outcome handling:
 *   • If server accounts for the whole batch with NO transient
 *     rejections: mark all rows synced. inserted = stored, duplicates
 *     = already there, permanentlyRejected = won't retry — all "done".
 *   • If server flags any row as transientlyRejected (today: never;
 *     reserved for future): we can't tell which row is which, so bump
 *     the attempt counter on all rows in the batch and let the next
 *     cycle retry the same set.
 *   • If server didn't account for every row (old server, accounting
 *     drift): fall back to legacy behavior — mark synced if inserted>0,
 *     else bump attempts.
 */
async function applyIngestOutcome(
  batchIds: string[],
  result: IngestResponse,
  source: 'FG' | 'BG',
): Promise<boolean> {
  if (batchIds.length === 0) return false;

  const completed = result.inserted + result.duplicates + result.permanentlyRejected;
  const totalProcessed = completed + result.transientlyRejected;
  const fullyAccounted = totalProcessed === batchIds.length;

  let advanced = false;

  if (fullyAccounted && result.transientlyRejected === 0) {
    await markAsSynced(batchIds);
    advanced = true;
    lg.debug(
      `${source} sync: ${batchIds.length} done (` +
        `inserted=${result.inserted}, dup=${result.duplicates}, ` +
        `permRejected=${result.permanentlyRejected})`,
    );
    if (result.permanentlyRejected > 0) {
      // Bad data being uploaded — surface so we can investigate upstream.
      // Not a sync failure (we've stopped retrying), but worth knowing.
      trackBGTaskError({
        step: 'permanently_rejected',
        error: `${source}_${result.permanentlyRejected}_of_${batchIds.length}`,
      });
    }
  } else if (fullyAccounted && result.transientlyRejected > 0) {
    // Server says retry. We don't know which rows specifically, so bump
    // attempts on all and try the same set again next cycle.
    await markSyncAttemptFailed(batchIds);
    lg.warn(
      `${source} sync: ${result.transientlyRejected}/${batchIds.length} transiently rejected, bumping attempts`,
    );
  } else {
    // Old server (returned only `inserted`) or accounting drift. Fall
    // back to legacy "any progress = success" rule, plus attempt bump
    // when nothing landed so the escape hatch can eventually kick in.
    if (result.inserted > 0) {
      await markAsSynced(batchIds);
      advanced = true;
      lg.debug(
        `${source} sync (legacy path): ${result.inserted} inserted, marking ${batchIds.length} rows synced`,
      );
    } else {
      await markSyncAttemptFailed(batchIds);
      lg.warn(
        `${source} sync: server returned inserted=0 for ${batchIds.length} rows, bumping attempts (escape hatch active)`,
      );
      trackBGTaskError({
        step: 'sync_rejected',
        error: `${source}_inserted_0_of_${batchIds.length}`,
      });
    }
  }

  // Escape hatch: anything that's been retried >MAX_SYNC_ATTEMPTS times,
  // or has been queued >MAX_PING_AGE_MS, gets hard-deleted with telemetry.
  // Cheap query, runs at most once per sync cycle.
  try {
    const purge = await purgeStaleUnsynced(MAX_SYNC_ATTEMPTS, MAX_PING_AGE_MS);
    if (purge.deleted > 0) {
      lg.warn(
        `Purged ${purge.deleted} stale unsynced rows ` +
          `(maxAttempts=${MAX_SYNC_ATTEMPTS}, maxAge=${MAX_PING_AGE_MS}ms). ` +
          `Sample: ${JSON.stringify(purge.sample)}`,
      );
      trackBGTaskError({
        step: 'purged_stale_unsynced',
        error: `${source}_${purge.deleted}_rows`,
      });
    }
  } catch (purgeErr) {
    // Purge failure is non-fatal — DB might be busy. Try again next cycle.
    const msg = purgeErr instanceof Error ? purgeErr.message : String(purgeErr);
    lg.warn(`Stale-purge failed (will retry): ${msg}`);
  }

  return advanced;
}

/**
 * Sync locations directly via the Convex HTTP endpoint using a static API key.
 * Works in background tasks without Clerk auth.
 */
async function syncViaHttpEndpoint(
  locations: SyncPing[],
  organizationId: string,
): Promise<IngestResponse> {
  if (!MOBILE_LOCATION_API_KEY) {
    throw new Error('MOBILE_LOCATION_API_KEY not configured');
  }

  const response = await fetch(`${CONVEX_SITE_URL}/v1/mobile/locations`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-Mobile-Api-Key': MOBILE_LOCATION_API_KEY,
    },
    body: JSON.stringify({ locations, organizationId }),
  });

  if (!response.ok) {
    const text = await response.text().catch(() => 'no body');
    throw new Error(`HTTP ${response.status}: ${text}`);
  }

  return normalizeIngestResponse(await response.json());
}

/**
 * Run a Convex mutation with auth, trying the React client first
 * (works in foreground) then falling back to an HTTP client with
 * the stored JWT (works in background tasks).
 */
async function authedMutation<T>(mutationRef: any, args: any): Promise<T> {
  // Try the React client first with a timeout.
  // The React client queues mutations over WebSocket and may hang indefinitely
  // if the WS is disconnected (background) or auth is in limbo.
  try {
    const REACT_CLIENT_TIMEOUT = 5_000;
    const result = await Promise.race([
      convex.mutation(mutationRef, args),
      new Promise<never>((_, reject) =>
        setTimeout(() => reject(new Error('React client timeout')), REACT_CLIENT_TIMEOUT),
      ),
    ]);
    return result;
  } catch (reactErr) {
    const msg = reactErr instanceof Error ? reactErr.message : String(reactErr);
    const isRecoverable =
      msg.includes('Not authenticated') ||
      msg.includes('Unauthenticated') ||
      msg.includes('auth') ||
      msg.includes('timeout');
    if (!isRecoverable) throw reactErr;

    lg.debug(`React client failed (${msg}), trying HTTP client...`);
  }

  // Fallback: HTTP client with a fresh token from the Clerk singleton.
  // Unlike the stored token (which expires in ~60s), the Clerk singleton
  // can mint fresh JWTs as long as the session is alive in SecureStore.
  const { getFreshToken } = require('./auth-token-store');
  const token = await getFreshToken();
  if (!token) {
    throw new Error('No auth token available (Clerk session may have expired)');
  }

  const httpClient = new ConvexHttpClient(CONVEX_URL);
  httpClient.setAuth(token);
  try {
    return await httpClient.mutation(mutationRef, args);
  } catch (httpErr) {
    const msg = httpErr instanceof Error ? httpErr.message : String(httpErr);
    lg.error(`HTTP client also failed: ${msg}`);
    throw httpErr;
  }
}

// Detect Expo Go: background tasks only work in development/production builds.
// In EAS builds, appOwnership is null and executionEnvironment may be undefined,
// so we ONLY check for the positive Expo Go indicators, never negate device checks
// (Constants.isDevice can be undefined in production, which would false-positive).
const isExpoGo = Constants.appOwnership === 'expo' || Constants.executionEnvironment === 'storeClient';

// Safe device check - expo-device may not be available in Expo Go
let isPhysicalDevice = true;
try {
  // Dynamic import to avoid crash in Expo Go
  const Device = require('expo-device');
  isPhysicalDevice = Device.isDevice;
} catch {
  // Assume physical device if we can't check
  isPhysicalDevice = true;
}

// ============================================
// UTILITY FUNCTIONS
// ============================================

/**
 * Calculate distance between two points in meters (Haversine formula)
 */
function calculateDistance(lat1: number, lon1: number, lat2: number, lon2: number): number {
  const R = 6371000; // Earth's radius in meters
  const dLat = ((lat2 - lat1) * Math.PI) / 180;
  const dLon = ((lon2 - lon1) * Math.PI) / 180;
  const a =
    Math.sin(dLat / 2) * Math.sin(dLat / 2) +
    Math.cos((lat1 * Math.PI) / 180) * Math.cos((lat2 * Math.PI) / 180) * Math.sin(dLon / 2) * Math.sin(dLon / 2);
  const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
  return R * c;
}

// ============================================
// TYPES
// ============================================

/**
 * State persisted in AsyncStorage that the background task reads to know
 * what's currently being tracked.
 *
 * Modes:
 *   - Legacy load-only:  { loadId, no sessionId, trackingType: 'LOAD_ROUTE' }
 *     Used by the existing useCheckIn → ensureTrackingForLoad path until
 *     mobile fully migrates to session mode.
 *   - Session, no load:  { sessionId, no loadId, trackingType: 'SESSION_ROUTE' }
 *     Driver is on shift but hasn't checked in anywhere.
 *   - Session + load:    { sessionId + loadId, trackingType: 'LOAD_ROUTE' }
 *     Driver is on shift and currently between first check-in and last checkout.
 */
interface TrackingState {
  isActive: boolean;
  driverId: string;
  loadId?: string;
  sessionId?: string;
  organizationId: string;
  trackingType: 'LOAD_ROUTE' | 'SESSION_ROUTE';
  startedAt: number;
}

// BufferedLocation type removed — GPS points are now stored in SQLite
// via location-db.ts instead of AsyncStorage JSON arrays.

// ============================================
// BACKGROUND TASK DEFINITION
// Must be at module scope for background execution
// Points are written to SQLite immediately (durable).
// Sync to Convex is best-effort — failures are safe because
// SQLite retains unsynced rows for later retry.
//
// RESILIENCE: Every step is individually try/caught so a failure
// in one part (e.g. SQLite init) doesn't prevent the rest from
// running. AsyncStorage is used as a fallback buffer if SQLite
// is unavailable in the headless background context.
// ============================================

const HEARTBEAT_INTERVAL_MS = 5 * 60 * 1000; // 5 minutes
const TRACKING_SESSION_MAX_AGE_MS = 18 * 60 * 60 * 1000; // 18 hours
const LAST_HEARTBEAT_KEY = 'location_last_heartbeat';
const BG_TASK_ALIVE_KEY = 'bg_task_last_alive';

// Note: the legacy `bg_fallback_locations` AsyncStorage buffer and its
// save/recover helpers have been deleted. They existed to catch writes
// when SQLite was unavailable (the Android-16 NPE failure mode). On the
// MMKV backend that failure class doesn't exist; on the legacy SQLite
// backend the new withRecovery layer in location-queue.ts handles it.
// See mobile/docs/location-queue-mmkv.md § "Can we kill the bg_fallback_locations buffer?"

/**
 * Check when the background task last fired (for diagnostics).
 */
export async function getBackgroundTaskLastAlive(): Promise<number> {
  try {
    const ts = await storage.getString(BG_TASK_ALIVE_KEY);
    return ts ? parseInt(ts, 10) : 0;
  } catch {
    return 0;
  }
}

TaskManager.defineTask(LOCATION_TASK_NAME, async ({ data, error }) => {
  const taskStartTime = Date.now();
  lg.debug(`===== BG TASK INVOKED at ${new Date(taskStartTime).toISOString()} =====`);

  // Record that the task fired (for foreground diagnostics)
  try {
    await storage.set(BG_TASK_ALIVE_KEY, taskStartTime.toString());
  } catch (aliveErr) {
    lg.error('BG task: failed to write alive timestamp:', aliveErr);
  }

  if (error) {
    lg.error('BG task error from OS:', error);
    trackBGTaskError({ step: 'os_error', error: String(error) });
    return;
  }

  // Step 1: Read tracking state from AsyncStorage
  let state: TrackingState | null = null;
  try {
    const stateJson = await storage.getString(TRACKING_STATE_KEY);
    if (!stateJson) {
      lg.debug('BG task: no tracking state in AsyncStorage');
      trackBGTaskError({ step: 'read_state', error: 'no tracking state' });
      return;
    }
    state = JSON.parse(stateJson);
    if (!state?.isActive) {
      lg.debug('BG task: tracking not active');
      return;
    }
    if (!state.loadId && !state.sessionId) {
      lg.warn('BG task: state missing both loadId and sessionId — skipping');
      return;
    }
    const anchor = state.sessionId
      ? `session=${state.sessionId.substring(0, 12)}`
      : `load=${(state.loadId ?? '').substring(0, 12)}`;
    lg.debug(`BG task: tracking active for ${anchor}...`);
  } catch (stateErr) {
    lg.error('BG task: FAILED to read tracking state:', stateErr);
    trackBGTaskError({ step: 'read_state', error: stateErr instanceof Error ? stateErr.message : String(stateErr) });
    return;
  }

  // Step 2: Extract locations from the task data
  const { locations } = (data ?? {}) as { locations?: Location.LocationObject[] };
  if (!locations || locations.length === 0) {
    lg.debug('BG task: no locations in data payload');
    trackBGTaskError({ step: 'extract_locations', error: 'no locations in payload' });
    return;
  }

  const accuracies = locations.map((l) => l.coords.accuracy?.toFixed(0) ?? '?').join(',');
  const ages = locations.map((l) => ((taskStartTime - l.timestamp) / 1000).toFixed(0) + 's').join(',');
  lg.debug(
    `BG task: ${locations.length} location(s) received, accuracy=[${accuracies}], ages=[${ages}]`,
  );

  // Step 3: Try to get last point from SQLite (may fail in headless context).
  // Prefer sessionId-keyed lookup when present — that's the new source of
  // truth and works even before any check-in. Fall back to loadId for the
  // legacy load-only path.
  let lastPoint: { latitude: number; longitude: number; recordedAt: number } | null = null;
  let sqliteAvailable = true;
  try {
    if (state.sessionId) {
      lastPoint = await getLastLocationForSession(state.sessionId);
    } else if (state.loadId) {
      lastPoint = await getLastLocationForLoad(state.loadId);
    }
    lg.debug(`BG task: SQLite available, lastPoint=${lastPoint ? 'yes' : 'none'}`);
  } catch (dbErr) {
    sqliteAvailable = false;
    lg.warn(
      'BG task: SQLite NOT available in background:',
      dbErr instanceof Error ? dbErr.message : dbErr,
    );
    trackBGTaskError({ step: 'sqlite_init', error: dbErr instanceof Error ? dbErr.message : String(dbErr) });
  }

  trackBGTaskFired({
    locationCount: locations.length,
    accuracies,
    ages,
    sqliteAvailable,
    trackingActive: true,
  });

  // Step 4: Filter and save locations
  const now = taskStartTime;
  let lastHeartbeat = 0;
  try {
    const lastHeartbeatStr = await storage.getString(LAST_HEARTBEAT_KEY);
    lastHeartbeat = lastHeartbeatStr ? parseInt(lastHeartbeatStr, 10) : 0;
  } catch {
    // Non-critical
  }
  const needsHeartbeat = now - lastHeartbeat >= HEARTBEAT_INTERVAL_MS;

  let addedCount = 0;
  let rejectedAccuracy = 0;
  let rejectedDistance = 0;
  let rejectedStale = 0;
  let prevLat = lastPoint?.latitude ?? null;
  let prevLng = lastPoint?.longitude ?? null;
  let prevTimestamp = lastPoint?.recordedAt ?? 0;
  let savedHeartbeat = false;

  const locationsToSave: LocationInput[] = [];

  for (const loc of locations) {
    if (loc.coords.accuracy && loc.coords.accuracy > MAX_ACCURACY_METERS) {
      rejectedAccuracy++;
      continue;
    }

    // Reject duplicate timestamps (same GPS fix delivered twice)
    if (prevTimestamp > 0 && Math.abs(loc.timestamp - prevTimestamp) < 1000) {
      rejectedStale++;
      continue;
    }

    // Reject truly stale cached locations: same coordinates AND old
    const locationAge = now - loc.timestamp;
    if (prevLat !== null && prevLng !== null && locationAge > 60_000) {
      const distFromPrev = calculateDistance(prevLat, prevLng, loc.coords.latitude, loc.coords.longitude);
      if (distFromPrev < 1) {
        rejectedStale++;
        continue;
      }
    }

    let distance = Infinity;
    if (prevLat !== null && prevLng !== null) {
      distance = calculateDistance(prevLat, prevLng, loc.coords.latitude, loc.coords.longitude);
    }

    const timeSincePrev = prevTimestamp > 0 ? loc.timestamp - prevTimestamp : Infinity;

    // Hard floor: never save more often than MIN_TIME_BETWEEN_SAVES_MS
    if (timeSincePrev < MIN_TIME_BETWEEN_SAVES_MS) {
      rejectedDistance++;
      continue;
    }

    const enoughDistance = distance >= MIN_DISTANCE_BETWEEN_POINTS;
    const enoughTime = timeSincePrev >= TRACKING_INTERVAL_MS;
    const isHeartbeat = needsHeartbeat && !savedHeartbeat;

    if (!enoughDistance && !enoughTime && !isHeartbeat) {
      rejectedDistance++;
      continue;
    }

    const locationData: LocationInput = {
      driverId: state.driverId,
      // Both anchors written when present. State.loadId may be undefined in
      // session-only mode; that's fine — server validates trackingType matches.
      loadId: state.loadId ?? null,
      sessionId: state.sessionId ?? null,
      organizationId: state.organizationId,
      latitude: loc.coords.latitude,
      longitude: loc.coords.longitude,
      accuracy: loc.coords.accuracy,
      speed: loc.coords.speed,
      heading: loc.coords.heading,
      recordedAt: loc.timestamp,
    };

    locationsToSave.push(locationData);
    prevLat = loc.coords.latitude;
    prevLng = loc.coords.longitude;
    prevTimestamp = loc.timestamp;
    addedCount++;

    if (needsHeartbeat && !savedHeartbeat) {
      savedHeartbeat = true;
      try {
        await storage.set(LAST_HEARTBEAT_KEY, now.toString());
      } catch {
        // Non-critical
      }
    }
  }

  lg.debug(
    `BG task: filtered ${addedCount}/${locations.length} to save (rejected: ${rejectedAccuracy} accuracy, ${rejectedDistance} distance, ${rejectedStale} stale${savedHeartbeat ? ', +heartbeat' : ''})`,
  );

  // Step 5: Persist to the queue.
  //
  // The `usedFallback` signal + its `bg_fallback_locations` AsyncStorage
  // buffer existed for the Android-16 SQLite NPE incident (4/22). On MMKV
  // the failure class doesn't exist, and the dispatcher's auto-reset layer
  // handles the rare storage errors that remain. Flag is kept (always
  // false) for telemetry-shape backwards compatibility during the canary.
  const usedFallback = false;
  if (locationsToSave.length > 0) {
    try {
      for (const loc of locationsToSave) {
        await insertLocation(loc);
      }
      lg.debug(`BG task: persisted ${locationsToSave.length} pings to local queue`);
    } catch (queueErr) {
      lg.error(
        'BG task: queue insert failed (pings lost this cycle):',
        queueErr instanceof Error ? queueErr.message : queueErr,
      );
      trackBGTaskError({
        step: 'queue_insert',
        error: queueErr instanceof Error ? queueErr.message : String(queueErr),
      });
    }
  }

  // Step 6: Sync to Convex via the HTTP endpoint (no Clerk JWT needed).
  // Uses a static API key that works regardless of auth state.
  let syncAttempted = false;
  let syncSuccess = false;
  let syncCount = 0;
  if (sqliteAvailable && MOBILE_LOCATION_API_KEY) {
    try {
      const unsynced = await getUnsyncedLocations(SYNC_BATCH_SIZE);
      if (unsynced.length > 0) {
        syncAttempted = true;
        const payload: SyncPing[] = unsynced.map((loc) => ({
          driverId: loc.driverId,
          loadId: loc.loadId ?? undefined,
          sessionId: loc.sessionId ?? undefined,
          latitude: loc.latitude,
          longitude: loc.longitude,
          accuracy: loc.accuracy ?? undefined,
          speed: loc.speed ?? undefined,
          heading: loc.heading ?? undefined,
          // Server enforces match: loadId↔LOAD_ROUTE, no-loadId↔SESSION_ROUTE.
          trackingType: loc.loadId ? 'LOAD_ROUTE' : 'SESSION_ROUTE',
          recordedAt: loc.recordedAt,
        }));

        const result = await syncViaHttpEndpoint(payload, state.organizationId);
        syncSuccess = true;
        syncCount = result.inserted;

        await applyIngestOutcome(unsynced.map((r) => r.id), result, 'BG');
      }
    } catch (flushError) {
      const errMsg = flushError instanceof Error ? flushError.message : String(flushError);
      lg.warn(`BG HTTP sync failed (points safe in SQLite): ${errMsg}`);
      syncAttempted = true;
      trackBGTaskError({ step: 'sync', error: errMsg });
    }
  } else if (!MOBILE_LOCATION_API_KEY) {
    lg.warn('BG sync skipped: MOBILE_LOCATION_API_KEY not configured');
  }

  const durationMs = Date.now() - taskStartTime;
  trackBGTaskResult({
    saved: addedCount,
    total: locations.length,
    rejectedAccuracy,
    rejectedDistance,
    rejectedStale,
    usedFallback,
    syncAttempted,
    syncSuccess: syncAttempted ? syncSuccess : undefined,
    syncCount: syncAttempted ? syncCount : undefined,
    durationMs,
  });

  lg.debug(`===== BG TASK COMPLETE (${durationMs}ms) =====`);
});

// ============================================
// PUBLIC API
// ============================================

/**
 * Start location tracking for a load
 * Called when driver checks out of the first stop
 * NOTE: Background tracking requires a development build, not Expo Go
 */
export async function startLocationTracking(params: {
  driverId: Id<'drivers'>;
  loadId: Id<'loadInformation'>;
  organizationId: string;
}): Promise<{ success: boolean; message: string }> {
  try {
    lg.debug('Starting tracking for load:', params.loadId);
    lg.debug('Is Expo Go:', isExpoGo);
    lg.debug('Platform:', Platform.OS);
    lg.debug('isPhysicalDevice:', isPhysicalDevice);
    lg.debug('Constants.appOwnership:', Constants.appOwnership);
    lg.debug('Constants.executionEnvironment:', Constants.executionEnvironment);
    lg.debug('orgId:', params.organizationId?.substring(0, 12) + '...');

    // Check if running in Expo Go - background tasks don't work there
    if (isExpoGo) {
      lg.warn('Running in Expo Go - background location not supported');
      lg.warn('Please use a development build for background tracking');

      const state: TrackingState = {
        isActive: true,
        driverId: params.driverId as string,
        loadId: params.loadId as string,
        organizationId: params.organizationId,
        trackingType: 'LOAD_ROUTE',
        startedAt: Date.now(),
      };
      await storage.set(TRACKING_STATE_KEY, JSON.stringify(state));

      // Capture initial location
      await captureCurrentLocation(state);

      // Start foreground-only polling as fallback
      startForegroundPolling(params.organizationId);

      return {
        success: true,
        message: 'Tracking started (foreground only in Expo Go)',
      };
    }

    // Check if this is a physical device (background location may not work on simulators)
    if (!isPhysicalDevice) {
      lg.warn('Running on simulator - background location may not work');
    }

    // Check if already tracking
    const existingState = await getTrackingState();
    if (existingState?.isActive) {
      lg.debug('Already tracking, stopping previous session');
      await stopLocationTracking();
    }

    // Request foreground permission first
    const { status: fgStatus } = await Location.requestForegroundPermissionsAsync();
    lg.debug('Foreground permission status:', fgStatus);
    if (fgStatus !== 'granted') {
      return { success: false, message: 'Foreground location permission required' };
    }

    // Request background permission
    const { status: bgStatus } = await Location.requestBackgroundPermissionsAsync();
    lg.debug('Background permission status:', bgStatus);
    if (bgStatus !== 'granted') {
      return {
        success: false,
        message: 'Background location permission required. Please enable "Always" location access in Settings.',
      };
    }

    // One-shot: ask the user to exempt us from Android's battery optimization.
    // Without this, Doze + App Standby will aggressively kill the foreground
    // service on long shifts (esp. screen-locked driving), silently stopping
    // GPS capture. The prompt is a single system dialog; deferred here so the
    // driver only ever sees it alongside the location-permission flow (not as
    // a surprise mid-use). Non-blocking: we don't fail tracking start if the
    // user declines — the battery killer just becomes more likely.
    requestIgnoreBatteryOptimizationOnce().catch(() => {
      /* best-effort; don't block tracking start on this */
    });

    // Save tracking state
    const state: TrackingState = {
      isActive: true,
      driverId: params.driverId as string,
      loadId: params.loadId as string,
      organizationId: params.organizationId,
      trackingType: 'LOAD_ROUTE',
      startedAt: Date.now(),
    };
    await storage.set(TRACKING_STATE_KEY, JSON.stringify(state));

    // Check if task is already registered
    const isTaskDefined = await TaskManager.isTaskRegisteredAsync(LOCATION_TASK_NAME);
    lg.debug('Task already registered:', isTaskDefined);

    // Try to start background location updates
    // If it fails (e.g., missing permissions in Expo Go), fall back to foreground polling
    try {
      lg.debug('Starting background location updates...');
      await Location.startLocationUpdatesAsync(LOCATION_TASK_NAME, {
        accuracy: Location.Accuracy.High,
        timeInterval: TRACKING_INTERVAL_MS,
        distanceInterval: BG_DISTANCE_INTERVAL,
        showsBackgroundLocationIndicator: true,
        foregroundService: {
          notificationTitle: 'Route Tracking Active',
          notificationBody: 'Recording your delivery route',
          notificationColor: '#22c55e',
        },
        // OtherNavigation avoids competing with the driver's active nav app
        // (Apple Maps, Google Maps, Waze) for the AutomotiveNavigation slot.
        activityType: Location.ActivityType.OtherNavigation,
        pausesUpdatesAutomatically: false,
      });

      // Start sync interval
      startSyncInterval(params.organizationId);

      // Capture initial location immediately
      await captureCurrentLocation(state);

      // Also start foreground watch as a dual safety net.
      // Background task handles updates when the app is suspended,
      // but foreground watch gives us immediate points while the app is open.
      // SQLite distance filtering prevents duplicates.
      startForegroundPolling(params.organizationId);

      lg.debug('Background + foreground tracking started successfully');
      return { success: true, message: 'Location tracking started' };
    } catch (bgError) {
      // Background tracking failed - fall back to foreground polling
      lg.warn('Background tracking failed, falling back to foreground polling');
      lg.warn('Error:', bgError instanceof Error ? bgError.message : bgError);

      // Capture initial location
      await captureCurrentLocation(state);

      // Start foreground-only polling as fallback
      startForegroundPolling(params.organizationId);

      return {
        success: true,
        message: 'Tracking started (foreground only - background not available)',
      };
    }
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : 'Failed to start tracking';
    lg.error('Start failed:', errorMessage);
    return { success: false, message: errorMessage };
  }
}

/**
 * Stop location tracking
 * Called when driver checks out of the last stop
 */
export async function stopLocationTracking(): Promise<{ success: boolean; message: string }> {
  try {
    lg.debug('Stopping tracking...');

    // Stop sync interval and foreground polling
    stopSyncInterval();
    await stopForegroundPolling();

    // Final sync attempt — any failures are safe, SQLite retains unsynced rows
    const state = await getTrackingState();
    if (state?.isActive) {
      try {
        await syncUnsyncedToConvex(state.organizationId);
      } catch {
        let unsyncedRemaining = -1;
        try {
          unsyncedRemaining = await getUnsyncedCount();
        } catch {
          // Ignore stale DB errors during best-effort shutdown
        }
        lg.warn(
          unsyncedRemaining >= 0
            ? `Final sync incomplete, ${unsyncedRemaining} points retained in SQLite for later upload`
            : 'Final sync incomplete, unsynced points retained in SQLite for later upload',
        );
      }
    }

    // Clear tracking state and heartbeat (but NOT the SQLite data — it persists for re-upload)
    await storage.set(TRACKING_STATE_KEY, JSON.stringify({ isActive: false }));
    await storage.delete(LAST_HEARTBEAT_KEY);

    // Stop background updates if registered (only in non-Expo Go)
    if (!isExpoGo) {
      const isRegistered = await TaskManager.isTaskRegisteredAsync(LOCATION_TASK_NAME);
      if (isRegistered) {
        await Location.stopLocationUpdatesAsync(LOCATION_TASK_NAME);
      }
    }

    lg.debug('Stopped successfully');
    return { success: true, message: 'Location tracking stopped' };
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : 'Failed to stop tracking';
    lg.error('Stop failed:', errorMessage);
    return { success: false, message: errorMessage };
  }
}

/**
 * Get current tracking state
 */
export async function getTrackingState(): Promise<TrackingState | null> {
  try {
    const stateJson = await storage.getString(TRACKING_STATE_KEY);
    if (!stateJson) return null;
    return JSON.parse(stateJson);
  } catch {
    return null;
  }
}

/**
 * Check if currently tracking
 */
export async function isTracking(): Promise<boolean> {
  const state = await getTrackingState();
  return state?.isActive ?? false;
}

export async function shouldStartTrackingForLoad(loadId: string): Promise<boolean> {
  const state = await getTrackingState();
  if (!state?.isActive) return true;
  if (state.loadId === loadId) return false;

  const startedAt = typeof state.startedAt === 'number' ? state.startedAt : 0;
  const ageMs = startedAt > 0 ? Date.now() - startedAt : Infinity;
  if (ageMs > TRACKING_SESSION_MAX_AGE_MS) {
    const stalePrev = state.loadId ? state.loadId.slice(0, 12) : '<none>';
    lg.warn(
      `Active tracking session is stale ` +
        `(load=${stalePrev}..., age=${Math.round(ageMs / 3600000)}h) — allowing new load ${loadId.slice(0, 12)}... to start`,
    );
    return true;
  }

  return false;
}

export async function ensureTrackingForLoad(params: {
  driverId: Id<'drivers'>;
  loadId: Id<'loadInformation'>;
  organizationId: string;
}): Promise<{
  success: boolean;
  action: 'started' | 'continued' | 'handoff';
  message: string;
  previousLoadId?: string;
}> {
  const state = await getTrackingState();
  if (!state?.isActive) {
    const result = await startLocationTracking(params);
    return { success: result.success, action: 'started', message: result.message };
  }

  if (state.loadId === params.loadId) {
    return { success: true, action: 'continued', message: 'Tracking already active for this load' };
  }

  const startedAt = typeof state.startedAt === 'number' ? state.startedAt : 0;
  const ageMs = startedAt > 0 ? Date.now() - startedAt : Infinity;
  const isStale = ageMs > TRACKING_SESSION_MAX_AGE_MS;

  const fromLoadDisplay = state.loadId ? state.loadId.slice(0, 12) : '<none>';
  lg.warn(
    `Handing off tracking from load=${fromLoadDisplay}... ` +
      `to load=${params.loadId.slice(0, 12)}... (age=${Math.round(ageMs / 60000)}m, stale=${isStale})`,
  );

  try {
    await forceFlush();
  } catch (err) {
    lg.warn('Handoff flush failed, continuing with switch:', err);
  }

  const stopResult = await stopLocationTracking();
  if (!stopResult.success) {
    lg.warn('Handoff stop failed, forcing local reset before restart:', stopResult.message);
    try {
      stopSyncInterval();
      await stopForegroundPolling();
    } catch {
      // Best-effort only
    }
    try {
      await storage.set(TRACKING_STATE_KEY, JSON.stringify({ isActive: false }));
      await storage.delete(LAST_HEARTBEAT_KEY);
    } catch {
      // Best-effort only
    }
    if (!isExpoGo) {
      try {
        const isRegistered = await TaskManager.isTaskRegisteredAsync(LOCATION_TASK_NAME);
        if (isRegistered) {
          await Location.stopLocationUpdatesAsync(LOCATION_TASK_NAME);
        }
      } catch {
        // Best-effort only
      }
    }
  }

  const startResult = await startLocationTracking(params);
  return {
    success: startResult.success,
    action: 'handoff',
    message: startResult.message,
    previousLoadId: state.loadId,
  };
}

/**
 * Get count of unsynced locations in SQLite
 */
export async function getBufferedLocationCount(): Promise<number> {
  try {
    return await getUnsyncedCount();
  } catch {
    return 0;
  }
}

/**
 * Force sync all unsynced points to Convex.
 * Retries with exponential backoff to handle auth token refresh delays
 * after the app returns from background.
 */
export async function forceFlush(): Promise<{ success: boolean; synced: number }> {
  const state = await getTrackingState();
  if (!state?.organizationId) {
    return { success: false, synced: 0 };
  }

  const MAX_RETRIES = 4;
  const delays = [0, 2000, 5000, 10000];

  for (let attempt = 0; attempt < MAX_RETRIES; attempt++) {
    if (delays[attempt] > 0) {
      await new Promise((r) => setTimeout(r, delays[attempt]));
    }

    const unsyncedCount = await getUnsyncedCount();
    if (unsyncedCount === 0) {
      return { success: true, synced: 0 };
    }

    try {
      const result = await syncUnsyncedToConvex(state.organizationId);
      if (result.success && result.synced > 0) {
        lg.debug(`forceFlush: synced ${result.synced} points on attempt ${attempt + 1}`);
        return result;
      }
      if (result.success) return result;
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      lg.warn(`forceFlush attempt ${attempt + 1}/${MAX_RETRIES} failed: ${msg}`);
    }
  }

  const remaining = await getUnsyncedCount();
  lg.warn(`forceFlush: all retries exhausted, ${remaining} points still in SQLite`);
  return { success: false, synced: 0 };
}

// ============================================
// SESSION-MODE PUBLIC API (Phase 3)
//
// These functions wrap the existing OS-level resources (background task,
// foreground watch, sync interval) but track the driver's *shift* rather
// than a specific load. Pings flow with sessionId; loadId attaches when
// the driver checks into stop 1 and detaches after the last checkout.
//
// Coexists with startLocationTracking — both write the same TrackingState
// in storage. The legacy load-only path keeps working for orgs/drivers
// that haven't moved to session mode yet.
// ============================================

async function applyOSLevelTrackingResources(state: TrackingState): Promise<{
  success: boolean;
  message: string;
}> {
  // Persist state first so the BG task can read it on next OS callback.
  await storage.set(TRACKING_STATE_KEY, JSON.stringify(state));

  if (isExpoGo) {
    lg.warn('Running in Expo Go — background location not supported');
    await captureCurrentLocation(state);
    startForegroundPolling(state.organizationId);
    return { success: true, message: 'Tracking started (foreground only in Expo Go)' };
  }

  if (!isPhysicalDevice) {
    lg.warn('Running on simulator — background location may not work');
  }

  const { status: fgStatus } = await Location.requestForegroundPermissionsAsync();
  if (fgStatus !== 'granted') {
    return { success: false, message: 'Foreground location permission required' };
  }
  const { status: bgStatus } = await Location.requestBackgroundPermissionsAsync();
  if (bgStatus !== 'granted') {
    return {
      success: false,
      message:
        'Background location permission required. Please enable "Always" location access in Settings.',
    };
  }

  // One-shot battery-optimization exemption prompt. See startLocationTracking
  // for rationale; same best-effort, non-blocking call.
  requestIgnoreBatteryOptimizationOnce().catch(() => {});

  try {
    await Location.startLocationUpdatesAsync(LOCATION_TASK_NAME, {
      accuracy: Location.Accuracy.High,
      timeInterval: TRACKING_INTERVAL_MS,
      distanceInterval: BG_DISTANCE_INTERVAL,
      showsBackgroundLocationIndicator: true,
      foregroundService: {
        notificationTitle: 'Shift Active',
        notificationBody: 'Recording your route while on shift',
        notificationColor: '#22c55e',
      },
      activityType: Location.ActivityType.OtherNavigation,
      pausesUpdatesAutomatically: false,
    });
    startSyncInterval(state.organizationId);
    await captureCurrentLocation(state);
    startForegroundPolling(state.organizationId);
    return { success: true, message: 'Location tracking started' };
  } catch (bgError) {
    lg.warn(
      'Background tracking failed, falling back to foreground polling:',
      bgError instanceof Error ? bgError.message : bgError,
    );
    await captureCurrentLocation(state);
    startForegroundPolling(state.organizationId);
    return {
      success: true,
      message: 'Tracking started (foreground only — background not available)',
    };
  }
}

/**
 * Start session-mode tracking. GPS pings flow with sessionId and no loadId
 * until the driver checks into a stop, then loadId attaches via
 * attachLoadToSession().
 *
 * Closes any existing tracking state (load-mode or session-mode) first.
 */
export async function startSessionTracking(params: {
  driverId: Id<'drivers'>;
  sessionId: Id<'driverSessions'>;
  organizationId: string;
}): Promise<{ success: boolean; message: string }> {
  try {
    lg.debug(
      `Starting session tracking: session=${(params.sessionId as string).substring(0, 12)}...`,
    );

    const existing = await getTrackingState();
    if (existing?.isActive) {
      lg.debug('Existing tracking session detected, stopping before session start');
      await stopLocationTracking();
    }

    const state: TrackingState = {
      isActive: true,
      driverId: params.driverId as string,
      sessionId: params.sessionId as string,
      organizationId: params.organizationId,
      trackingType: 'SESSION_ROUTE',
      startedAt: Date.now(),
    };

    return await applyOSLevelTrackingResources(state);
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : 'Failed to start session tracking';
    lg.error('Session start failed:', errorMessage);
    return { success: false, message: errorMessage };
  }
}

/**
 * Attach a load to the active session. Subsequent pings flow with both
 * sessionId and loadId, and trackingType flips to LOAD_ROUTE.
 *
 * Called from useCheckIn after a successful first-stop check-in. Does NOT
 * restart the OS-level tracking — the BG task and foreground watch keep
 * running with the new state.
 */
export async function attachLoadToSession(loadId: Id<'loadInformation'>): Promise<{
  success: boolean;
  message: string;
}> {
  const state = await getTrackingState();
  if (!state?.isActive) {
    return { success: false, message: 'No active tracking session to attach to' };
  }
  if (state.loadId === (loadId as string)) {
    return { success: true, message: 'Load already attached' };
  }
  const updated: TrackingState = {
    ...state,
    loadId: loadId as string,
    trackingType: 'LOAD_ROUTE',
  };
  await storage.set(TRACKING_STATE_KEY, JSON.stringify(updated));
  lg.debug(
    `Attached load=${(loadId as string).substring(0, 12)}... to session`,
  );
  return { success: true, message: 'Load attached to session' };
}

/**
 * Detach the current load from the active session. Pings continue to flow
 * with sessionId only, trackingType returns to SESSION_ROUTE.
 *
 * Called from useCheckIn after the last-stop checkout. Tracking continues
 * until the driver explicitly ends the shift via stopSessionTracking.
 */
export async function detachLoadFromSession(): Promise<{
  success: boolean;
  message: string;
}> {
  const state = await getTrackingState();
  if (!state?.isActive) {
    return { success: false, message: 'No active tracking session' };
  }
  if (!state.loadId) {
    return { success: true, message: 'No load currently attached' };
  }
  const updated: TrackingState = {
    isActive: state.isActive,
    driverId: state.driverId,
    sessionId: state.sessionId,
    organizationId: state.organizationId,
    trackingType: 'SESSION_ROUTE',
    startedAt: state.startedAt,
    // loadId omitted on purpose
  };
  await storage.set(TRACKING_STATE_KEY, JSON.stringify(updated));
  lg.debug('Detached load from session');
  return { success: true, message: 'Load detached from session' };
}

/**
 * End session-mode tracking. Alias for stopLocationTracking — both tear
 * down the same OS-level resources and flush any unsynced points.
 */
export async function stopSessionTracking(): Promise<{ success: boolean; message: string }> {
  return stopLocationTracking();
}

/**
 * Resume tracking after app restart
 * Call this on app startup to restore tracking if it was active
 */
export async function resumeTracking(): Promise<{
  resumed: boolean;
  message: string;
  state?: TrackingState;
}> {
  try {
    const state = await getTrackingState();

    if (!state?.isActive) {
      lg.debug('No active tracking to resume');
      return { resumed: false, message: 'No active tracking session' };
    }

    lg.debug('Resuming tracking for load:', state.loadId);

    // Check permissions first
    const { status } = await Location.getForegroundPermissionsAsync();
    if (status !== 'granted') {
      lg.warn('Location permission not granted, cannot resume');
      return { resumed: false, message: 'Location permission not granted', state };
    }

    // Restart sync interval
    startSyncInterval(state.organizationId);

    // Always force-cycle the background task on app resume.
    // We no longer trust isTaskRegisteredAsync() — after OTA updates or
    // phone restarts the native registration persists but the JS callback
    // is stale (zombie). Force-cycling is the only reliable fix.
    if (!isExpoGo && isPhysicalDevice) {
      try {
        const isRegistered = await TaskManager.isTaskRegisteredAsync(LOCATION_TASK_NAME);

        if (isRegistered) {
          lg.debug('Resume: force-cycling BG task to reconnect JS callback');
          try {
            await Location.stopLocationUpdatesAsync(LOCATION_TASK_NAME);
          } catch {
            /* ok if native side already cleaned up */
          }
        }

        lg.debug('Resume: (re-)starting BG location task...');
        await Location.startLocationUpdatesAsync(LOCATION_TASK_NAME, {
          accuracy: Location.Accuracy.High,
          timeInterval: TRACKING_INTERVAL_MS,
          distanceInterval: BG_DISTANCE_INTERVAL,
          showsBackgroundLocationIndicator: true,
          foregroundService: {
            notificationTitle: 'Route Tracking Active',
            notificationBody: 'Recording your delivery route',
            notificationColor: '#22c55e',
          },
          activityType: Location.ActivityType.OtherNavigation,
          pausesUpdatesAutomatically: false,
        });
        lg.debug(`BG task registered on resume (wasRegistered=${isRegistered})`);
      } catch (bgError) {
        lg.warn('Could not start background tracking:', bgError);
      }
    }

    // Always start foreground watch when the app is open.
    // This is the primary data source while the app is in the foreground --
    // the background task is throttled by the OS and fires infrequently.
    startForegroundPolling(state.organizationId);

    // Sync any unsynced locations from SQLite (survived app restart)
    const unsyncedCount = await getUnsyncedCount();
    if (unsyncedCount > 0) {
      lg.debug(`Found ${unsyncedCount} unsynced locations in SQLite, syncing...`);
      await syncUnsyncedToConvex(state.organizationId);
    }

    lg.debug('Tracking resumed successfully');
    return {
      resumed: true,
      message: `Tracking resumed for load ${state.loadId}`,
      state,
    };
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : 'Failed to resume tracking';
    lg.error('Resume failed:', errorMessage);
    return { resumed: false, message: errorMessage };
  }
}

// ============================================
// INTERNAL FUNCTIONS
// ============================================

let syncIntervalId: ReturnType<typeof setInterval> | null = null;

function startSyncInterval(organizationId: string) {
  if (syncIntervalId) {
    clearInterval(syncIntervalId);
  }

  syncIntervalId = setInterval(async () => {
    try {
      await syncUnsyncedToConvex(organizationId);
    } catch (err) {
      lg.warn('Periodic sync failed (will retry):', err);
    }
  }, SYNC_INTERVAL_MS);

  lg.debug('Sync interval started (every 30s)');
}

function stopSyncInterval() {
  if (syncIntervalId) {
    clearInterval(syncIntervalId);
    syncIntervalId = null;
    lg.debug('Sync interval stopped');
  }
}

// Foreground watch subscription for real-time continuous updates
let foregroundWatchSubscription: Location.LocationSubscription | null = null;
let lastForegroundLocation: { latitude: number; longitude: number; time: number } | null = null;
let isSyncing = false;
// Heartbeat gate: verify BG task is still registered every ~5 minutes during
// active foreground tracking. Cheap TaskManager.isTaskRegisteredAsync call,
// but no need to run it on every single GPS fix.
let lastBgTaskHeartbeatCheck = 0;
const BG_TASK_HEARTBEAT_INTERVAL_MS = 5 * 60 * 1000;

/**
 * Throttled heartbeat: if the BG task has been silently unregistered (OEM
 * kill, Doze sweep, Samsung Sleeping Apps, etc.), re-register it now so
 * the driver doesn't silently stop capturing when they next lock the
 * phone. The foreground watch itself keeps running even when the BG task
 * is dead — which is why this check is necessary in the first place; the
 * data from the foreground side looks healthy while the background side
 * has quietly died.
 *
 * No-op on Expo Go (no TaskManager). No-op if called within
 * BG_TASK_HEARTBEAT_INTERVAL_MS of the previous check.
 */
async function maybeReregisterBgTaskHeartbeat(
  now: number,
  organizationId: string,
): Promise<void> {
  if (isExpoGo) return;
  if (now - lastBgTaskHeartbeatCheck < BG_TASK_HEARTBEAT_INTERVAL_MS) return;
  lastBgTaskHeartbeatCheck = now;

  try {
    const isRegistered = await TaskManager.isTaskRegisteredAsync(
      LOCATION_TASK_NAME,
    );
    if (isRegistered) return; // healthy — nothing to do

    // BG task is gone. We'd like to re-register immediately, BUT Android 12+
    // (API 31+) forbids starting a foreground service from the background —
    // Location.startLocationUpdatesAsync throws ForegroundServiceStartNotAllowedException
    // with message "Foreground service cannot be started when the application
    // is in the background." This callback fires from watchPositionAsync, which
    // can briefly outlive the FGS during a background kill, so hitting this
    // path WITH AppState != 'active' is the common case, not an edge case.
    //
    // Two consequences:
    //   • Heartbeat can only self-heal background-kills that happen WHILE the
    //     app is foreground — a narrow window (mostly OS-wake-word churn on
    //     Samsung + similar OEMs while screen is on).
    //   • The "app was backgrounded, FGS got killed, driver is driving with
    //     screen off" case — the common one — cannot be recovered in-process.
    //     It needs FCM high-priority push to wake the app into foreground
    //     first, which our server-push wake-up PR addresses.
    //
    // So: in background, emit a "skipped_backgrounded" signal and return.
    // We DON'T even attempt the register call; avoids log noise + uncaught
    // SecurityException in telemetry.
    const appState = AppState.currentState;
    if (appState !== 'active') {
      trackBGTaskReregistered({
        source: 'heartbeat',
        wasRegistered: false,
        success: false,
        error: `skipped_backgrounded:${appState}`,
      });
      lg.debug(
        `Heartbeat: BG task dead but app is ${appState} — can't restart FGS from background, deferring to foreground_return or FCM wake`,
      );
      return;
    }

    lg.warn('Heartbeat: BG task is NOT registered during active tracking — re-registering');
    let success = false;
    let error: string | undefined;
    try {
      await Location.startLocationUpdatesAsync(LOCATION_TASK_NAME, {
        accuracy: Location.Accuracy.High,
        timeInterval: TRACKING_INTERVAL_MS,
        distanceInterval: BG_DISTANCE_INTERVAL,
        showsBackgroundLocationIndicator: true,
        foregroundService: {
          notificationTitle: 'Route Tracking Active',
          notificationBody: 'Recording your delivery route',
          notificationColor: '#22c55e',
        },
        activityType: Location.ActivityType.OtherNavigation,
        pausesUpdatesAutomatically: false,
      });
      success = true;
    } catch (restartErr) {
      error = restartErr instanceof Error ? restartErr.message : String(restartErr);
      lg.warn(`Heartbeat: BG task re-registration failed: ${error}`);
    }
    trackBGTaskReregistered({
      source: 'heartbeat',
      wasRegistered: false,
      success,
      error,
    });
  } catch (err) {
    // isTaskRegisteredAsync itself failed — unusual but non-fatal.
    lg.warn(
      `Heartbeat: isTaskRegisteredAsync failed: ${err instanceof Error ? err.message : err}`,
    );
  }
}

/**
 * Start foreground location watching with continuous real-time updates
 * Uses watchPositionAsync for better accuracy than interval polling
 */
async function startForegroundPolling(organizationId: string) {
  // Stop any existing subscription
  await stopForegroundPolling();

  lg.debug('Starting foreground watch (continuous real-time updates)');

  try {
    foregroundWatchSubscription = await Location.watchPositionAsync(
      {
        accuracy: Location.Accuracy.High,
        // Let the OS pre-filter — only wake us every 50 m / 10 s.
        // Our callback applies stricter gates (250 m / 30 s) so we
        // still get reliable coverage without burning battery on
        // callbacks we'll just discard.
        distanceInterval: 50,
        timeInterval: 10_000,
      },
      async (location) => {
        try {
          const now = Date.now();
          const ageMs = now - location.timestamp;
          trackWatchLocationReceived({
            accuracy_m: location.coords.accuracy ?? null,
            age_ms: ageMs,
            speed_mps: location.coords.speed ?? null,
            heading_deg: location.coords.heading ?? null,
          });

          // Throttled heartbeat — catches silently-killed BG tasks before
          // the driver locks the phone and drops into a capture gap.
          void maybeReregisterBgTaskHeartbeat(now, organizationId);

          const state = await getTrackingState();
          if (!state?.isActive) {
            trackWatchLocationFiltered({
              reason: 'inactive',
              accuracy_m: location.coords.accuracy ?? null,
              age_ms: ageMs,
            });
            await stopForegroundPolling();
            return;
          }

          if (location.coords.accuracy && location.coords.accuracy > MAX_ACCURACY_METERS) {
            trackWatchLocationFiltered({
              reason: 'accuracy',
              accuracy_m: location.coords.accuracy,
              age_ms: ageMs,
            });
            return;
          }

          const timeSinceLast = lastForegroundLocation ? now - lastForegroundLocation.time : Infinity;

          let distance = Infinity;
          if (lastForegroundLocation) {
            distance = calculateDistance(
              lastForegroundLocation.latitude,
              lastForegroundLocation.longitude,
              location.coords.latitude,
              location.coords.longitude,
            );
          }

          // Hard floor: never save more often than MIN_TIME_BETWEEN_SAVES_MS
          // regardless of distance. Prevents flooding at highway speeds.
          if (timeSinceLast < MIN_TIME_BETWEEN_SAVES_MS) {
            trackWatchLocationFiltered({
              reason: 'time_floor',
              accuracy_m: location.coords.accuracy ?? null,
              age_ms: ageMs,
              distance_m: Number.isFinite(distance) ? distance : null,
              gap_ms: Number.isFinite(timeSinceLast) ? timeSinceLast : null,
            });
            return;
          }

          // After the hard floor, save if enough distance OR enough time OR heartbeat.
          const enoughTime = timeSinceLast >= TRACKING_INTERVAL_MS;
          const enoughDistance = distance >= MIN_DISTANCE_BETWEEN_POINTS;
          const needsHeartbeat = timeSinceLast >= HEARTBEAT_INTERVAL_MS;

          if (!enoughTime && !enoughDistance && !needsHeartbeat) {
            trackWatchLocationFiltered({
              reason: 'distance_time_gate',
              accuracy_m: location.coords.accuracy ?? null,
              age_ms: ageMs,
              distance_m: Number.isFinite(distance) ? distance : null,
              gap_ms: Number.isFinite(timeSinceLast) ? timeSinceLast : null,
            });
            return;
          }

          const locationRecord = {
            driverId: state.driverId,
            loadId: state.loadId ?? null,
            sessionId: state.sessionId ?? null,
            organizationId: state.organizationId,
            latitude: location.coords.latitude,
            longitude: location.coords.longitude,
            accuracy: location.coords.accuracy,
            speed: location.coords.speed,
            heading: location.coords.heading,
            recordedAt: location.timestamp,
          };

          // No fallback buffer — on MMKV the failure class is gone, and on
          // the legacy SQLite backend the dispatcher's withRecovery handles
          // retry + auto-reset. If insert still throws here, the ping is
          // dropped and telemetry flags the error.
          const usedFallback = false;
          try {
            await insertLocation(locationRecord);
          } catch (insertError) {
            lg.warn(
              'Watch: insert failed (ping dropped):',
              insertError instanceof Error ? insertError.message : insertError,
            );
            trackWatchLocationError({
              step: 'insert',
              error: insertError instanceof Error ? insertError.message : String(insertError),
            });
          }

          lastForegroundLocation = {
            latitude: location.coords.latitude,
            longitude: location.coords.longitude,
            time: now,
          };

          const reason = enoughDistance ? 'distance' : enoughTime ? 'time' : 'heartbeat';
          trackWatchLocationSaved({
            reason,
            accuracy_m: location.coords.accuracy ?? null,
            distance_m: Number.isFinite(distance) ? distance : null,
            gap_ms: Number.isFinite(timeSinceLast) ? timeSinceLast : null,
            used_fallback: usedFallback,
          });
          lg.debug(
            `Watch: saved (acc=${location.coords.accuracy?.toFixed(0)}m, dist=${distance.toFixed(0)}m, gap=${(timeSinceLast / 1000).toFixed(0)}s, reason=${reason})`,
          );

          // Sync immediately -- we're in the foreground with valid auth.
          if (!isSyncing) {
            isSyncing = true;
            try {
              await syncUnsyncedToConvex(organizationId);
            } catch (syncErr) {
              trackWatchLocationError({
                step: 'sync',
                error: syncErr instanceof Error ? syncErr.message : String(syncErr),
              });
              lg.warn(
                'Watch: sync failed, will retry:',
                syncErr instanceof Error ? syncErr.message : syncErr,
              );
            } finally {
              isSyncing = false;
            }
          }
        } catch (error) {
          trackWatchLocationError({
            step: 'callback',
            error: error instanceof Error ? error.message : String(error),
          });
          lg.error('Watch callback error:', error);
        }
      },
    );

    lg.debug('Foreground watch started successfully');
  } catch (error) {
    lg.error('Failed to start foreground watch:', error);
  }
}

async function stopForegroundPolling() {
  if (foregroundWatchSubscription) {
    foregroundWatchSubscription.remove();
    foregroundWatchSubscription = null;
    lastForegroundLocation = null;
    lg.debug('Foreground watch stopped');
  }
}

/**
 * Capture current location immediately, write to SQLite, and attempt immediate sync.
 * Called at tracking start when the user is in the foreground with valid auth.
 */
async function captureCurrentLocation(state: TrackingState) {
  try {
    const location = await Location.getCurrentPositionAsync({
      accuracy: Location.Accuracy.High,
    });

    const rowId = await insertLocation({
      driverId: state.driverId,
      loadId: state.loadId ?? null,
      sessionId: state.sessionId ?? null,
      organizationId: state.organizationId,
      latitude: location.coords.latitude,
      longitude: location.coords.longitude,
      accuracy: location.coords.accuracy,
      speed: location.coords.speed,
      heading: location.coords.heading,
      recordedAt: location.timestamp,
    });

    lg.debug(
      `Captured initial location to SQLite (rowId=${rowId}, accuracy=${location.coords.accuracy?.toFixed(0)}m, lat=${location.coords.latitude.toFixed(5)}, lng=${location.coords.longitude.toFixed(5)})`,
    );

    // Seed the foreground watch state so it doesn't immediately save a duplicate
    lastForegroundLocation = {
      latitude: location.coords.latitude,
      longitude: location.coords.longitude,
      time: Date.now(),
    };

    // Immediately try to sync this point while we have valid auth
    try {
      await syncUnsyncedToConvex(state.organizationId);
    } catch (syncErr) {
      lg.warn(
        'Immediate sync of initial point failed (will retry later):',
        syncErr instanceof Error ? syncErr.message : syncErr,
      );
    }
  } catch (error) {
    lg.error('Failed to capture initial location:', error);
  }
}

/**
 * Sync unsynced GPS points from SQLite to Convex.
 * Reads unsynced rows, uploads in batches, marks each batch as synced.
 * On auth failure, retries once after a delay. Unsynced rows are never
 * deleted — they persist in SQLite for future retry.
 */
async function syncUnsyncedToConvex(
  organizationId: string,
  retryAttempt = 0,
): Promise<{ success: boolean; synced: number }> {
  const MAX_AUTH_RETRIES = 2;
  const AUTH_RETRY_DELAYS = [1000, 3000];

  try {
    const unsynced = await getUnsyncedLocations(SYNC_BATCH_SIZE);
    if (unsynced.length === 0) {
      return { success: true, synced: 0 };
    }

    lg.debug(
      `Syncing ${unsynced.length} unsynced points to Convex (orgId=${organizationId.substring(0, 12)}..., attempt=${retryAttempt})`,
    );

    const locations: SyncPing[] = unsynced.map((loc) => ({
      driverId: loc.driverId,
      loadId: loc.loadId ?? undefined,
      sessionId: loc.sessionId ?? undefined,
      latitude: loc.latitude,
      longitude: loc.longitude,
      accuracy: loc.accuracy ?? undefined,
      speed: loc.speed ?? undefined,
      heading: loc.heading ?? undefined,
      // Server enforces match: loadId↔LOAD_ROUTE, no-loadId↔SESSION_ROUTE.
      trackingType: loc.loadId ? 'LOAD_ROUTE' : 'SESSION_ROUTE',
      recordedAt: loc.recordedAt,
    }));

    const rawResult = await authedMutation<unknown>(api.driverLocations.batchInsertLocations, {
      locations,
      organizationId,
    });
    const result = normalizeIngestResponse(rawResult);
    const syncedIds = unsynced.map((r) => r.id);

    const advanced = await applyIngestOutcome(syncedIds, result, 'FG');

    // Continue batching only when this batch made progress. If `advanced`
    // is false the same rows would be reselected next iteration, causing
    // unbounded recursion. The escape-hatch purge inside applyIngestOutcome
    // handles rows that have failed too many times — anything still
    // unsynced after the purge is genuinely worth retrying later.
    if (advanced) {
      const remaining = await getUnsyncedCount();
      if (remaining > 0) {
        lg.debug(`${remaining} more unsynced points, continuing...`);
        const nextResult = await syncUnsyncedToConvex(organizationId);
        return { success: true, synced: result.inserted + nextResult.synced };
      }
    }

    return { success: true, synced: result.inserted };
  } catch (error) {
    const errorMsg = error instanceof Error ? error.message : String(error);
    const isAuthError =
      errorMsg.includes('Not authenticated') || errorMsg.includes('auth') || errorMsg.includes('Unauthenticated');

    if (isAuthError && retryAttempt < MAX_AUTH_RETRIES) {
      const delay = AUTH_RETRY_DELAYS[retryAttempt] ?? 12000;
      lg.warn(
        `Sync auth failed (attempt ${retryAttempt + 1}/${MAX_AUTH_RETRIES}), retrying in ${delay / 1000}s... (SQLite data safe)`,
      );
      await new Promise((r) => setTimeout(r, delay));
      return syncUnsyncedToConvex(organizationId, retryAttempt + 1);
    }

    const remaining = await getUnsyncedCount();
    lg.error(
      `Sync failed (attempt ${retryAttempt + 1}): ${errorMsg} — ${remaining} points retained in SQLite for later`,
    );
    return { success: false, synced: 0 };
  }
}

// Export for use by the app layout's foreground flush
export { syncUnsyncedToConvex };

/**
 * Restart foreground services (watch + sync interval) when the app returns
 * from background. iOS suspends JS timers and watch subscriptions when the
 * app is backgrounded, so they must be re-established on foreground return.
 *
 * Also re-registers the background location task. After OTA updates, the
 * JS bundle changes but the native task registration may be stale, causing
 * the background task callback to never fire. Stopping and re-starting
 * ensures the native layer points to the current JS callback.
 */
export async function restartForegroundServices(): Promise<void> {
  const state = await getTrackingState();
  if (!state?.isActive) return;

  lg.debug('Restarting foreground services after app resume');

  // (Legacy AsyncStorage fallback recovery removed — the buffer no longer
  // exists. The one-shot migrateFromLegacyStoresOnce in root init handles
  // draining pre-upgrade buffers into the queue.)
  const fallbackRecovered = 0;

  // Check when the background task last fired (diagnostic)
  let bgTaskLastAliveAgoSec: number | null = null;
  try {
    const lastAlive = await getBackgroundTaskLastAlive();
    if (lastAlive > 0) {
      bgTaskLastAliveAgoSec = Math.round((Date.now() - lastAlive) / 1000);
      lg.debug(`BG task last fired ${bgTaskLastAliveAgoSec}s ago`);
    } else {
      lg.debug('BG task has never fired (or alive key was cleared)');
    }
  } catch {
    // Non-critical
  }

  // Get unsynced count for diagnostics
  let unsyncedCount = 0;
  try {
    unsyncedCount = await getUnsyncedCount();
  } catch {
    // Non-critical
  }

  trackForegroundResume({
    bgTaskLastAliveAgoSec,
    fallbackRecovered,
    unsyncedCount,
    isExpoGo,
    isPhysicalDevice,
    platform: Platform.OS,
  });

  // Re-register the background task.
  // We ALWAYS force-cycle on foreground return now. The previous approach
  // of skipping re-register when "already_registered" caused silent GPS
  // loss: the native task registration persists across OTA updates and
  // phone restarts, but the JS callback becomes stale. isTaskRegisteredAsync()
  // returns true, yet the JS callback never fires.
  //
  // Force-cycling is safe: there's a brief gap (~1-2s) during stop+start,
  // but that's far better than the task being permanently dead. The
  // foreground watch covers the gap anyway.

  if (!isExpoGo && isPhysicalDevice) {
    let wasRegistered = false;
    try {
      wasRegistered = await TaskManager.isTaskRegisteredAsync(LOCATION_TASK_NAME);

      // Classify the task health for diagnostics
      const isZombie = wasRegistered && bgTaskLastAliveAgoSec !== null && bgTaskLastAliveAgoSec > 5 * 60; // > 5 min = definitely zombie
      const isSuspect = wasRegistered && bgTaskLastAliveAgoSec !== null && bgTaskLastAliveAgoSec > 3 * 60; // > 3 min = likely zombie (should fire every ~30s-2min)
      const neverFired = wasRegistered && (bgTaskLastAliveAgoSec === null || bgTaskLastAliveAgoSec === 0);

      const healthStatus = isZombie ? 'zombie' : isSuspect ? 'suspect' : neverFired ? 'never_fired' : 'alive';

      lg.debug(
        `BG task isRegistered=${wasRegistered}, ` +
          `lastAliveAgo=${bgTaskLastAliveAgoSec}s, health=${healthStatus}`,
      );

      // Always stop first if registered — ensures native layer reconnects to current JS callback
      if (wasRegistered) {
        lg.debug(`Force-cycling BG task (health=${healthStatus})...`);
        try {
          await Location.stopLocationUpdatesAsync(LOCATION_TASK_NAME);
        } catch {
          // May fail if native side already cleaned up -- that's fine
        }
      }

      // (Re-)register the background task
      lg.debug('(Re-)starting BG location task...');
      await Location.startLocationUpdatesAsync(LOCATION_TASK_NAME, {
        accuracy: Location.Accuracy.High,
        timeInterval: TRACKING_INTERVAL_MS,
        distanceInterval: BG_DISTANCE_INTERVAL,
        showsBackgroundLocationIndicator: true,
        foregroundService: {
          notificationTitle: 'Route Tracking Active',
          notificationBody: 'Recording your delivery route',
          notificationColor: '#22c55e',
        },
        activityType: Location.ActivityType.OtherNavigation,
        pausesUpdatesAutomatically: false,
      });

      const reason = !wasRegistered
        ? 'not_registered'
        : isZombie
          ? 'zombie_recycled'
          : isSuspect
            ? 'suspect_recycled'
            : neverFired
              ? 'never_fired_recycled'
              : 'force_cycled';
      lg.debug(`BG task registered on foreground return (${reason})`);
      trackBGTaskReregistered({
        source: 'foreground_return',
        wasRegistered,
        success: true,
        error: reason === 'force_cycled' ? undefined : reason,
      });
    } catch (bgErr) {
      const errMsg = bgErr instanceof Error ? bgErr.message : String(bgErr);
      lg.warn('Failed to register background task:', errMsg);
      trackBGTaskReregistered({ source: 'foreground_return', wasRegistered, success: false, error: errMsg });
    }
  } else {
    lg.debug(
      `Skipping BG re-register: isExpoGo=${isExpoGo}, isPhysicalDevice=${isPhysicalDevice}`,
    );
    trackBGTaskReregistered({
      source: 'foreground_return',
      wasRegistered: false,
      success: false,
      error: `skipped: isExpoGo=${isExpoGo}, isPhysicalDevice=${isPhysicalDevice}`,
    });
  }

  startSyncInterval(state.organizationId);
  startForegroundPolling(state.organizationId);

  // Immediate one-shot flush: if any pings were buffered during the silent
  // window (zombie BG task, screen-off gap, etc.), push them now instead of
  // waiting for the sync interval's next tick. Cheap when queue is empty.
  if (unsyncedCount > 0) {
    lg.debug(`Foreground resume: flushing ${unsyncedCount} buffered pings`);
    syncUnsyncedToConvex(state.organizationId).catch((err) => {
      lg.warn(
        `Foreground-resume flush failed (retry on next interval): ${err instanceof Error ? err.message : err}`,
      );
    });
  }
}

// ============================================
// UTILITY FUNCTIONS
// ============================================

/**
 * Check if location tracking is available on this device
 */
export async function checkLocationServicesEnabled(): Promise<boolean> {
  return await Location.hasServicesEnabledAsync();
}

/**
 * Get current location permissions status
 */
export async function getLocationPermissions(): Promise<{
  foreground: Location.PermissionStatus;
  background: Location.PermissionStatus;
}> {
  const [foreground, background] = await Promise.all([
    Location.getForegroundPermissionsAsync(),
    Location.getBackgroundPermissionsAsync(),
  ]);

  return {
    foreground: foreground.status,
    background: background.status,
  };
}

/**
 * Check if background location task is registered
 */
export async function isBackgroundTaskRegistered(): Promise<boolean> {
  return await TaskManager.isTaskRegisteredAsync(LOCATION_TASK_NAME);
}
