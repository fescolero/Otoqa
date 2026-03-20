import * as Location from 'expo-location';
import * as TaskManager from 'expo-task-manager';
import Constants from 'expo-constants';
import { Platform } from 'react-native';
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
  getLastLocationForLoad,
  deleteOldSyncedLocations,
  reopenDb,
} from './location-db';
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
 * Sync locations directly via the Convex HTTP endpoint using a static API key.
 * Works in background tasks without Clerk auth.
 */
async function syncViaHttpEndpoint(
  locations: Array<{
    driverId: string;
    loadId: string;
    latitude: number;
    longitude: number;
    accuracy?: number;
    speed?: number;
    heading?: number;
    trackingType: 'LOAD_ROUTE';
    recordedAt: number;
  }>,
  organizationId: string,
): Promise<{ inserted: number }> {
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

  return await response.json();
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

    console.log(`[LocationTracking] React client failed (${msg}), trying HTTP client...`);
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
    console.error(`[LocationTracking] HTTP client also failed: ${msg}`);
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

interface TrackingState {
  isActive: boolean;
  driverId: string;
  loadId: string;
  organizationId: string;
  trackingType: 'LOAD_ROUTE';
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
const BG_FALLBACK_LOCATIONS_KEY = 'bg_fallback_locations';

/**
 * Save locations to AsyncStorage as a fallback when SQLite is unavailable.
 * These get recovered and inserted into SQLite on the next foreground return.
 */
async function saveFallbackLocations(
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
): Promise<void> {
  try {
    const existingJson = await storage.getString(BG_FALLBACK_LOCATIONS_KEY);
    const existing = existingJson ? JSON.parse(existingJson) : [];
    const combined = [...existing, ...locations];
    // Cap at 500 to prevent unbounded growth
    const capped = combined.slice(-500);
    await storage.set(BG_FALLBACK_LOCATIONS_KEY, JSON.stringify(capped));
    console.log(
      `[LocationTracking] BG fallback: saved ${locations.length} locations to AsyncStorage (total: ${capped.length})`,
    );
  } catch (err) {
    console.error('[LocationTracking] BG fallback save failed:', err);
  }
}

/**
 * Recover fallback locations from AsyncStorage into SQLite.
 * Called on foreground return.
 */
export async function recoverFallbackLocations(): Promise<number> {
  try {
    const json = await storage.getString(BG_FALLBACK_LOCATIONS_KEY);
    if (!json) return 0;
    const locations = JSON.parse(json);
    if (!Array.isArray(locations) || locations.length === 0) return 0;

    let inserted = 0;
    for (const loc of locations) {
      try {
        await insertLocation(loc);
        inserted++;
      } catch {
        // Skip duplicates or invalid entries
      }
    }

    await storage.delete(BG_FALLBACK_LOCATIONS_KEY);
    console.log(
      `[LocationTracking] Recovered ${inserted}/${locations.length} fallback locations from AsyncStorage to SQLite`,
    );
    return inserted;
  } catch (err) {
    console.error('[LocationTracking] Fallback recovery failed:', err);
    return 0;
  }
}

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
  console.log(`[LocationTracking] ===== BG TASK INVOKED at ${new Date(taskStartTime).toISOString()} =====`);

  // Record that the task fired (for foreground diagnostics)
  try {
    await storage.set(BG_TASK_ALIVE_KEY, taskStartTime.toString());
  } catch (aliveErr) {
    console.error('[LocationTracking] BG task: failed to write alive timestamp:', aliveErr);
  }

  if (error) {
    console.error('[LocationTracking] BG task error from OS:', error);
    trackBGTaskError({ step: 'os_error', error: String(error) });
    return;
  }

  // Step 1: Read tracking state from AsyncStorage
  let state: TrackingState | null = null;
  try {
    const stateJson = await storage.getString(TRACKING_STATE_KEY);
    if (!stateJson) {
      console.log('[LocationTracking] BG task: no tracking state in AsyncStorage');
      trackBGTaskError({ step: 'read_state', error: 'no tracking state' });
      return;
    }
    state = JSON.parse(stateJson);
    if (!state?.isActive) {
      console.log('[LocationTracking] BG task: tracking not active');
      return;
    }
    console.log(`[LocationTracking] BG task: tracking active for load=${state.loadId.substring(0, 12)}...`);
  } catch (stateErr) {
    console.error('[LocationTracking] BG task: FAILED to read tracking state:', stateErr);
    trackBGTaskError({ step: 'read_state', error: stateErr instanceof Error ? stateErr.message : String(stateErr) });
    return;
  }

  // Step 2: Extract locations from the task data
  const { locations } = (data ?? {}) as { locations?: Location.LocationObject[] };
  if (!locations || locations.length === 0) {
    console.log('[LocationTracking] BG task: no locations in data payload');
    trackBGTaskError({ step: 'extract_locations', error: 'no locations in payload' });
    return;
  }

  const accuracies = locations.map((l) => l.coords.accuracy?.toFixed(0) ?? '?').join(',');
  const ages = locations.map((l) => ((taskStartTime - l.timestamp) / 1000).toFixed(0) + 's').join(',');
  console.log(
    `[LocationTracking] BG task: ${locations.length} location(s) received, accuracy=[${accuracies}], ages=[${ages}]`,
  );

  // Step 3: Try to get last point from SQLite (may fail in headless context)
  let lastPoint: { latitude: number; longitude: number; recordedAt: number } | null = null;
  let sqliteAvailable = true;
  try {
    lastPoint = await getLastLocationForLoad(state.loadId);
    console.log(`[LocationTracking] BG task: SQLite available, lastPoint=${lastPoint ? 'yes' : 'none'}`);
  } catch (dbErr) {
    sqliteAvailable = false;
    console.warn(
      '[LocationTracking] BG task: SQLite NOT available in background:',
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

  const locationsToSave: Array<{
    driverId: string;
    loadId: string;
    organizationId: string;
    latitude: number;
    longitude: number;
    accuracy: number | null;
    speed: number | null;
    heading: number | null;
    recordedAt: number;
  }> = [];

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

    const locationData = {
      driverId: state.driverId,
      loadId: state.loadId,
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

  console.log(
    `[LocationTracking] BG task: filtered ${addedCount}/${locations.length} to save (rejected: ${rejectedAccuracy} accuracy, ${rejectedDistance} distance, ${rejectedStale} stale${savedHeartbeat ? ', +heartbeat' : ''})`,
  );

  // Step 5: Save to SQLite (primary) or AsyncStorage (fallback)
  let usedFallback = false;
  if (locationsToSave.length > 0) {
    if (sqliteAvailable) {
      try {
        for (const loc of locationsToSave) {
          await insertLocation(loc);
        }
        console.log(`[LocationTracking] BG task: saved ${locationsToSave.length} to SQLite`);
      } catch (sqliteErr) {
        console.error(
          '[LocationTracking] BG task: SQLite insert failed, falling back to AsyncStorage:',
          sqliteErr instanceof Error ? sqliteErr.message : sqliteErr,
        );
        trackBGTaskError({
          step: 'sqlite_insert',
          error: sqliteErr instanceof Error ? sqliteErr.message : String(sqliteErr),
        });
        usedFallback = true;
        await saveFallbackLocations(locationsToSave);
      }
    } else {
      usedFallback = true;
      await saveFallbackLocations(locationsToSave);
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
        const payload = unsynced.map((loc) => ({
          driverId: loc.driverId as Id<'drivers'>,
          loadId: loc.loadId as Id<'loadInformation'>,
          latitude: loc.latitude,
          longitude: loc.longitude,
          accuracy: loc.accuracy ?? undefined,
          speed: loc.speed ?? undefined,
          heading: loc.heading ?? undefined,
          trackingType: 'LOAD_ROUTE' as const,
          recordedAt: loc.recordedAt,
        }));

        const result = await syncViaHttpEndpoint(payload, state.organizationId);
        syncSuccess = true;
        syncCount = result.inserted;

        if (result.inserted > 0) {
          // Only mark synced if the server actually accepted points.
          // If inserted === 0, the server rejected everything (org mismatch,
          // driver deleted, etc.) — retaining as unsynced lets us retry later
          // or investigate why points are rejected.
          await markAsSynced(unsynced.map((r) => r.id));
          console.log(`[LocationTracking] BG HTTP sync: ${result.inserted} inserted, ${unsynced.length} marked synced`);
        } else {
          console.warn(
            `[LocationTracking] BG HTTP sync: server returned inserted=0 for ${unsynced.length} points — NOT marking synced (will retry)`,
          );
          trackBGTaskError({ step: 'sync_rejected', error: `server_inserted_0_of_${unsynced.length}` });
        }
      }
    } catch (flushError) {
      const errMsg = flushError instanceof Error ? flushError.message : String(flushError);
      console.warn(`[LocationTracking] BG HTTP sync failed (points safe in SQLite): ${errMsg}`);
      syncAttempted = true;
      trackBGTaskError({ step: 'sync', error: errMsg });
    }
  } else if (!MOBILE_LOCATION_API_KEY) {
    console.warn('[LocationTracking] BG sync skipped: MOBILE_LOCATION_API_KEY not configured');
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

  console.log(`[LocationTracking] ===== BG TASK COMPLETE (${durationMs}ms) =====`);
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
    console.log('[LocationTracking] Starting tracking for load:', params.loadId);
    console.log('[LocationTracking] Is Expo Go:', isExpoGo);
    console.log('[LocationTracking] Platform:', Platform.OS);
    console.log('[LocationTracking] isPhysicalDevice:', isPhysicalDevice);
    console.log('[LocationTracking] Constants.appOwnership:', Constants.appOwnership);
    console.log('[LocationTracking] Constants.executionEnvironment:', Constants.executionEnvironment);
    console.log('[LocationTracking] orgId:', params.organizationId?.substring(0, 12) + '...');

    // Check if running in Expo Go - background tasks don't work there
    if (isExpoGo) {
      console.warn('[LocationTracking] Running in Expo Go - background location not supported');
      console.warn('[LocationTracking] Please use a development build for background tracking');

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
      console.warn('[LocationTracking] Running on simulator - background location may not work');
    }

    // Check if already tracking
    const existingState = await getTrackingState();
    if (existingState?.isActive) {
      console.log('[LocationTracking] Already tracking, stopping previous session');
      await stopLocationTracking();
    }

    // Request foreground permission first
    const { status: fgStatus } = await Location.requestForegroundPermissionsAsync();
    console.log('[LocationTracking] Foreground permission status:', fgStatus);
    if (fgStatus !== 'granted') {
      return { success: false, message: 'Foreground location permission required' };
    }

    // Request background permission
    const { status: bgStatus } = await Location.requestBackgroundPermissionsAsync();
    console.log('[LocationTracking] Background permission status:', bgStatus);
    if (bgStatus !== 'granted') {
      return {
        success: false,
        message: 'Background location permission required. Please enable "Always" location access in Settings.',
      };
    }

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
    console.log('[LocationTracking] Task already registered:', isTaskDefined);

    // Try to start background location updates
    // If it fails (e.g., missing permissions in Expo Go), fall back to foreground polling
    try {
      console.log('[LocationTracking] Starting background location updates...');
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

      console.log('[LocationTracking] Background + foreground tracking started successfully');
      return { success: true, message: 'Location tracking started' };
    } catch (bgError) {
      // Background tracking failed - fall back to foreground polling
      console.warn('[LocationTracking] Background tracking failed, falling back to foreground polling');
      console.warn('[LocationTracking] Error:', bgError instanceof Error ? bgError.message : bgError);

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
    console.error('[LocationTracking] Start failed:', errorMessage);
    return { success: false, message: errorMessage };
  }
}

/**
 * Stop location tracking
 * Called when driver checks out of the last stop
 */
export async function stopLocationTracking(): Promise<{ success: boolean; message: string }> {
  try {
    console.log('[LocationTracking] Stopping tracking...');

    try {
      await reopenDb();
    } catch (err) {
      console.warn('[LocationTracking] stop: DB reopen failed, continuing best-effort:', err);
    }

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
        console.warn(
          unsyncedRemaining >= 0
            ? `[LocationTracking] Final sync incomplete, ${unsyncedRemaining} points retained in SQLite for later upload`
            : '[LocationTracking] Final sync incomplete, unsynced points retained in SQLite for later upload',
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

    // Clean up old synced data (keep 7 days for debugging)
    try {
      const cleaned = await deleteOldSyncedLocations();
      if (cleaned > 0) {
        console.log(`[LocationTracking] Cleaned ${cleaned} old synced records from SQLite`);
      }
    } catch {
      // Non-critical
    }

    console.log('[LocationTracking] Stopped successfully');
    return { success: true, message: 'Location tracking stopped' };
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : 'Failed to stop tracking';
    console.error('[LocationTracking] Stop failed:', errorMessage);
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
    console.warn(
      `[LocationTracking] Active tracking session is stale ` +
        `(load=${state.loadId.slice(0, 12)}..., age=${Math.round(ageMs / 3600000)}h) — allowing new load ${loadId.slice(0, 12)}... to start`,
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

  console.warn(
    `[LocationTracking] Handing off tracking from load=${state.loadId.slice(0, 12)}... ` +
      `to load=${params.loadId.slice(0, 12)}... (age=${Math.round(ageMs / 60000)}m, stale=${isStale})`,
  );

  try {
    await reopenDb();
  } catch (err) {
    console.warn('[LocationTracking] Handoff DB reopen failed, continuing best-effort:', err);
  }

  try {
    await forceFlush();
  } catch (err) {
    console.warn('[LocationTracking] Handoff flush failed, continuing with switch:', err);
  }

  const stopResult = await stopLocationTracking();
  if (!stopResult.success) {
    console.warn('[LocationTracking] Handoff stop failed, forcing local reset before restart:', stopResult.message);
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
        console.log(`[LocationTracking] forceFlush: synced ${result.synced} points on attempt ${attempt + 1}`);
        return result;
      }
      if (result.success) return result;
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.warn(`[LocationTracking] forceFlush attempt ${attempt + 1}/${MAX_RETRIES} failed: ${msg}`);
    }
  }

  const remaining = await getUnsyncedCount();
  console.warn(`[LocationTracking] forceFlush: all retries exhausted, ${remaining} points still in SQLite`);
  return { success: false, synced: 0 };
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
      console.log('[LocationTracking] No active tracking to resume');
      return { resumed: false, message: 'No active tracking session' };
    }

    console.log('[LocationTracking] Resuming tracking for load:', state.loadId);

    // Check permissions first
    const { status } = await Location.getForegroundPermissionsAsync();
    if (status !== 'granted') {
      console.warn('[LocationTracking] Location permission not granted, cannot resume');
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
          console.log('[LocationTracking] Resume: force-cycling BG task to reconnect JS callback');
          try {
            await Location.stopLocationUpdatesAsync(LOCATION_TASK_NAME);
          } catch {
            /* ok if native side already cleaned up */
          }
        }

        console.log('[LocationTracking] Resume: (re-)starting BG location task...');
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
        console.log(`[LocationTracking] BG task registered on resume (wasRegistered=${isRegistered})`);
      } catch (bgError) {
        console.warn('[LocationTracking] Could not start background tracking:', bgError);
      }
    }

    // Always start foreground watch when the app is open.
    // This is the primary data source while the app is in the foreground --
    // the background task is throttled by the OS and fires infrequently.
    startForegroundPolling(state.organizationId);

    // Sync any unsynced locations from SQLite (survived app restart)
    const unsyncedCount = await getUnsyncedCount();
    if (unsyncedCount > 0) {
      console.log(`[LocationTracking] Found ${unsyncedCount} unsynced locations in SQLite, syncing...`);
      await syncUnsyncedToConvex(state.organizationId);
    }

    console.log('[LocationTracking] Tracking resumed successfully');
    return {
      resumed: true,
      message: `Tracking resumed for load ${state.loadId}`,
      state,
    };
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : 'Failed to resume tracking';
    console.error('[LocationTracking] Resume failed:', errorMessage);
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
      console.warn('[LocationTracking] Periodic sync failed (will retry):', err);
    }
  }, SYNC_INTERVAL_MS);

  console.log('[LocationTracking] Sync interval started (every 30s)');
}

function stopSyncInterval() {
  if (syncIntervalId) {
    clearInterval(syncIntervalId);
    syncIntervalId = null;
    console.log('[LocationTracking] Sync interval stopped');
  }
}

// Foreground watch subscription for real-time continuous updates
let foregroundWatchSubscription: Location.LocationSubscription | null = null;
let lastForegroundLocation: { latitude: number; longitude: number; time: number } | null = null;
let isSyncing = false;

/**
 * Start foreground location watching with continuous real-time updates
 * Uses watchPositionAsync for better accuracy than interval polling
 */
async function startForegroundPolling(organizationId: string) {
  // Stop any existing subscription
  await stopForegroundPolling();

  console.log('[LocationTracking] Starting foreground watch (continuous real-time updates)');

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
            loadId: state.loadId,
            organizationId: state.organizationId,
            latitude: location.coords.latitude,
            longitude: location.coords.longitude,
            accuracy: location.coords.accuracy,
            speed: location.coords.speed,
            heading: location.coords.heading,
            recordedAt: location.timestamp,
          };

          let usedFallback = false;
          try {
            await insertLocation(locationRecord);
          } catch (insertError) {
            console.warn(
              '[LocationTracking] Watch: SQLite insert failed after retry, buffering fallback location:',
              insertError instanceof Error ? insertError.message : insertError,
            );
            trackWatchLocationError({
              step: 'insert',
              error: insertError instanceof Error ? insertError.message : String(insertError),
            });
            await saveFallbackLocations([locationRecord]);
            usedFallback = true;
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
          console.log(
            `[LocationTracking] Watch: saved (acc=${location.coords.accuracy?.toFixed(0)}m, dist=${distance.toFixed(0)}m, gap=${(timeSinceLast / 1000).toFixed(0)}s, reason=${reason})`,
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
              console.warn(
                '[LocationTracking] Watch: sync failed, will retry:',
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
          console.error('[LocationTracking] Watch callback error:', error);
        }
      },
    );

    console.log('[LocationTracking] Foreground watch started successfully');
  } catch (error) {
    console.error('[LocationTracking] Failed to start foreground watch:', error);
  }
}

async function stopForegroundPolling() {
  if (foregroundWatchSubscription) {
    foregroundWatchSubscription.remove();
    foregroundWatchSubscription = null;
    lastForegroundLocation = null;
    console.log('[LocationTracking] Foreground watch stopped');
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
      loadId: state.loadId,
      organizationId: state.organizationId,
      latitude: location.coords.latitude,
      longitude: location.coords.longitude,
      accuracy: location.coords.accuracy,
      speed: location.coords.speed,
      heading: location.coords.heading,
      recordedAt: location.timestamp,
    });

    console.log(
      `[LocationTracking] Captured initial location to SQLite (rowId=${rowId}, accuracy=${location.coords.accuracy?.toFixed(0)}m, lat=${location.coords.latitude.toFixed(5)}, lng=${location.coords.longitude.toFixed(5)})`,
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
      console.warn(
        '[LocationTracking] Immediate sync of initial point failed (will retry later):',
        syncErr instanceof Error ? syncErr.message : syncErr,
      );
    }
  } catch (error) {
    console.error('[LocationTracking] Failed to capture initial location:', error);
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

    console.log(
      `[LocationTracking] Syncing ${unsynced.length} unsynced points to Convex (orgId=${organizationId.substring(0, 12)}..., attempt=${retryAttempt})`,
    );

    const locations = unsynced.map((loc) => ({
      driverId: loc.driverId as Id<'drivers'>,
      loadId: loc.loadId as Id<'loadInformation'>,
      latitude: loc.latitude,
      longitude: loc.longitude,
      accuracy: loc.accuracy ?? undefined,
      speed: loc.speed ?? undefined,
      heading: loc.heading ?? undefined,
      trackingType: 'LOAD_ROUTE' as const,
      recordedAt: loc.recordedAt,
    }));

    const result = await authedMutation<{ inserted: number }>(api.driverLocations.batchInsertLocations, {
      locations,
      organizationId,
    });

    const syncedIds = unsynced.map((r) => r.id);

    if (result.inserted > 0) {
      // Only mark synced if the server actually accepted some/all points.
      // This prevents permanent data loss when the server rejects everything
      // (e.g. org mismatch, deleted driver, missing load).
      await markAsSynced(syncedIds);
      console.log(`[LocationTracking] Synced ${result.inserted} locations, marked ${syncedIds.length} rows`);

      if (result.inserted < syncedIds.length) {
        console.warn(
          `[LocationTracking] Server accepted ${result.inserted}/${syncedIds.length} — some points may have been rejected (org mismatch or invalid driver/load)`,
        );
      }
    } else {
      console.warn(
        `[LocationTracking] Server rejected all ${syncedIds.length} points (inserted=0) — NOT marking synced, will retry`,
      );
      trackBGTaskError({ step: 'sync_rejected', error: `server_inserted_0_of_${syncedIds.length}` });
    }

    const remaining = await getUnsyncedCount();
    if (remaining > 0) {
      console.log(`[LocationTracking] ${remaining} more unsynced points, continuing...`);
      const nextResult = await syncUnsyncedToConvex(organizationId);
      return { success: true, synced: result.inserted + nextResult.synced };
    }

    return { success: true, synced: result.inserted };
  } catch (error) {
    const errorMsg = error instanceof Error ? error.message : String(error);
    const isAuthError =
      errorMsg.includes('Not authenticated') || errorMsg.includes('auth') || errorMsg.includes('Unauthenticated');

    if (isAuthError && retryAttempt < MAX_AUTH_RETRIES) {
      const delay = AUTH_RETRY_DELAYS[retryAttempt] ?? 12000;
      console.warn(
        `[LocationTracking] Sync auth failed (attempt ${retryAttempt + 1}/${MAX_AUTH_RETRIES}), retrying in ${delay / 1000}s... (SQLite data safe)`,
      );
      await new Promise((r) => setTimeout(r, delay));
      return syncUnsyncedToConvex(organizationId, retryAttempt + 1);
    }

    const remaining = await getUnsyncedCount();
    console.error(
      `[LocationTracking] Sync failed (attempt ${retryAttempt + 1}): ${errorMsg} — ${remaining} points retained in SQLite for later`,
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

  console.log('[LocationTracking] Restarting foreground services after app resume');

  // Proactively refresh the SQLite connection. Android can destroy the native
  // database handle after long background periods while the JS-side reference
  // remains cached, causing NullPointerException on the next prepareAsync/runAsync.
  try {
    await reopenDb();
  } catch (err) {
    console.warn('[LocationTracking] DB reopen failed, getDb() will retry on demand:', err);
  }

  // Recover any locations saved to AsyncStorage fallback during background
  let fallbackRecovered = 0;
  try {
    fallbackRecovered = await recoverFallbackLocations();
    if (fallbackRecovered > 0) {
      console.log(`[LocationTracking] Recovered ${fallbackRecovered} fallback locations from background`);
    }
  } catch (err) {
    console.warn('[LocationTracking] Fallback recovery error:', err);
  }

  // Check when the background task last fired (diagnostic)
  let bgTaskLastAliveAgoSec: number | null = null;
  try {
    const lastAlive = await getBackgroundTaskLastAlive();
    if (lastAlive > 0) {
      bgTaskLastAliveAgoSec = Math.round((Date.now() - lastAlive) / 1000);
      console.log(`[LocationTracking] BG task last fired ${bgTaskLastAliveAgoSec}s ago`);
    } else {
      console.log('[LocationTracking] BG task has never fired (or alive key was cleared)');
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

      console.log(
        `[LocationTracking] BG task isRegistered=${wasRegistered}, ` +
          `lastAliveAgo=${bgTaskLastAliveAgoSec}s, health=${healthStatus}`,
      );

      // Always stop first if registered — ensures native layer reconnects to current JS callback
      if (wasRegistered) {
        console.log(`[LocationTracking] Force-cycling BG task (health=${healthStatus})...`);
        try {
          await Location.stopLocationUpdatesAsync(LOCATION_TASK_NAME);
        } catch {
          // May fail if native side already cleaned up -- that's fine
        }
      }

      // (Re-)register the background task
      console.log('[LocationTracking] (Re-)starting BG location task...');
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
      console.log(`[LocationTracking] BG task registered on foreground return (${reason})`);
      trackBGTaskReregistered({
        source: 'foreground_return',
        wasRegistered,
        success: true,
        error: reason === 'force_cycled' ? undefined : reason,
      });
    } catch (bgErr) {
      const errMsg = bgErr instanceof Error ? bgErr.message : String(bgErr);
      console.warn('[LocationTracking] Failed to register background task:', errMsg);
      trackBGTaskReregistered({ source: 'foreground_return', wasRegistered, success: false, error: errMsg });
    }
  } else {
    console.log(
      `[LocationTracking] Skipping BG re-register: isExpoGo=${isExpoGo}, isPhysicalDevice=${isPhysicalDevice}`,
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
