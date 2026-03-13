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
  getUnsyncedCountForLoad,
  markAsSynced,
  getLastLocationForLoad,
  deleteOldSyncedLocations,
} from './location-db';

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
// Optimized for accurate route reconstruction
// ============================================
const TRACKING_INTERVAL_MS = 1 * 60 * 1000;  // 1 minute (was 5 minutes)
const SYNC_INTERVAL_MS = 2 * 60 * 1000;      // Sync to server every 2 minutes
const MIN_DISTANCE_METERS = 50;               // Also track on 50m movement (was 100m)
const MAX_ACCURACY_METERS = 50;               // Reject readings with > 50m accuracy
const MIN_DISTANCE_BETWEEN_POINTS = 20;       // Skip if < 20m from last point (avoid duplicates)

// ============================================
// BACKGROUND-SAFE CONVEX CLIENT
// The ConvexReactClient requires the React tree for auth.
// In iOS background tasks, React is not mounted so we use
// ConvexHttpClient with a stored JWT token instead.
// ============================================
const CONVEX_URL = process.env.EXPO_PUBLIC_CONVEX_URL!;

/**
 * Run a Convex mutation with auth, trying the React client first
 * (works in foreground) then falling back to an HTTP client with
 * the stored JWT (works in background tasks).
 */
async function authedMutation<T>(
  mutationRef: any,
  args: any
): Promise<T> {
  // Try the React client first -- it has a live WebSocket and fresh auth
  try {
    return await convex.mutation(mutationRef, args);
  } catch (reactErr) {
    const msg = reactErr instanceof Error ? reactErr.message : String(reactErr);
    const isAuthErr = msg.includes('Not authenticated') || msg.includes('Unauthenticated') || msg.includes('auth');
    if (!isAuthErr) throw reactErr;

    console.log('[LocationTracking] React client auth failed, trying HTTP client with stored token...');
  }

  // Fallback: HTTP client with stored token
  const { getStoredAuthToken } = require('./auth-token-store');
  const token = await getStoredAuthToken();
  if (!token) {
    throw new Error('No stored auth token available for background sync');
  }

  const httpClient = new ConvexHttpClient(CONVEX_URL);
  httpClient.setAuth(token);
  try {
    return await httpClient.mutation(mutationRef, args);
  } catch (httpErr) {
    const msg = httpErr instanceof Error ? httpErr.message : String(httpErr);
    console.error(`[LocationTracking] HTTP client mutation also failed: ${msg}`);
    throw httpErr;
  }
}

// Check if running in Expo Go (background tasks don't work in Expo Go)
// Multiple checks for reliability across platforms
const isExpoGo = 
  Constants.appOwnership === 'expo' || 
  Constants.executionEnvironment === 'storeClient' ||
  !Constants.isDevice;

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
function calculateDistance(
  lat1: number,
  lon1: number,
  lat2: number,
  lon2: number
): number {
  const R = 6371000; // Earth's radius in meters
  const dLat = ((lat2 - lat1) * Math.PI) / 180;
  const dLon = ((lon2 - lon1) * Math.PI) / 180;
  const a =
    Math.sin(dLat / 2) * Math.sin(dLat / 2) +
    Math.cos((lat1 * Math.PI) / 180) *
      Math.cos((lat2 * Math.PI) / 180) *
      Math.sin(dLon / 2) *
      Math.sin(dLon / 2);
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
// ============================================

const BACKGROUND_FLUSH_THRESHOLD = 3;
const BACKGROUND_FLUSH_INTERVAL_MS = 2 * 60 * 1000;
const LAST_BACKGROUND_FLUSH_KEY = 'location_last_bg_flush';

// Minimum interval for saving a "heartbeat" point even when stationary.
// Ensures we always have proof the background task is running.
const HEARTBEAT_INTERVAL_MS = 5 * 60 * 1000; // 5 minutes
const LAST_HEARTBEAT_KEY = 'location_last_heartbeat';

TaskManager.defineTask(LOCATION_TASK_NAME, async ({ data, error }) => {
  if (error) {
    console.error('[LocationTracking] Task error:', error);
    return;
  }

  try {
    const stateJson = await storage.getString(TRACKING_STATE_KEY);
    if (!stateJson) {
      console.log('[LocationTracking] BG task: no tracking state');
      return;
    }

    const state: TrackingState = JSON.parse(stateJson);
    if (!state.isActive) {
      console.log('[LocationTracking] BG task: tracking not active');
      return;
    }

    const { locations } = data as { locations: Location.LocationObject[] };
    if (!locations || locations.length === 0) {
      console.log('[LocationTracking] BG task: no locations in data');
      return;
    }

    console.log(`[LocationTracking] BG task fired: ${locations.length} location(s), accuracy=${locations.map(l => l.coords.accuracy?.toFixed(0)).join(',')}`);

    const lastPoint = await getLastLocationForLoad(state.loadId);

    // Check if we need a heartbeat (save at least one point even if stationary)
    const now = Date.now();
    const lastHeartbeatStr = await storage.getString(LAST_HEARTBEAT_KEY);
    const lastHeartbeat = lastHeartbeatStr ? parseInt(lastHeartbeatStr, 10) : 0;
    const needsHeartbeat = (now - lastHeartbeat) >= HEARTBEAT_INTERVAL_MS;

    let addedCount = 0;
    let rejectedAccuracy = 0;
    let rejectedDistance = 0;
    let prevLat = lastPoint?.latitude ?? null;
    let prevLng = lastPoint?.longitude ?? null;
    let savedHeartbeat = false;

    for (const loc of locations) {
      if (loc.coords.accuracy && loc.coords.accuracy > MAX_ACCURACY_METERS) {
        rejectedAccuracy++;
        continue;
      }

      let tooClose = false;
      if (prevLat !== null && prevLng !== null) {
        const distance = calculateDistance(
          prevLat, prevLng,
          loc.coords.latitude, loc.coords.longitude
        );
        if (distance < MIN_DISTANCE_BETWEEN_POINTS) {
          tooClose = true;
        }
      }

      // Save if moved enough OR if we need a heartbeat to prove we're alive
      if (tooClose && !(needsHeartbeat && !savedHeartbeat)) {
        rejectedDistance++;
        continue;
      }

      await insertLocation({
        driverId: state.driverId,
        loadId: state.loadId,
        organizationId: state.organizationId,
        latitude: loc.coords.latitude,
        longitude: loc.coords.longitude,
        accuracy: loc.coords.accuracy,
        speed: loc.coords.speed,
        heading: loc.coords.heading,
        recordedAt: loc.timestamp,
      });

      prevLat = loc.coords.latitude;
      prevLng = loc.coords.longitude;
      addedCount++;

      if (needsHeartbeat && !savedHeartbeat) {
        savedHeartbeat = true;
        await storage.set(LAST_HEARTBEAT_KEY, now.toString());
      }
    }

    console.log(`[LocationTracking] BG task: saved ${addedCount}/${locations.length} to SQLite (rejected: ${rejectedAccuracy} accuracy, ${rejectedDistance} distance${savedHeartbeat ? ', +heartbeat' : ''})`);

    // Best-effort sync to Convex
    const flushNow = Date.now();
    const lastFlushStr = await storage.getString(LAST_BACKGROUND_FLUSH_KEY);
    const lastFlushTime = lastFlushStr ? parseInt(lastFlushStr, 10) : 0;
    const timeSinceFlush = flushNow - lastFlushTime;
    const unsyncedCount = await getUnsyncedCount();

    const shouldFlush =
      unsyncedCount >= BACKGROUND_FLUSH_THRESHOLD ||
      (unsyncedCount > 0 && timeSinceFlush >= BACKGROUND_FLUSH_INTERVAL_MS);

    if (shouldFlush) {
      try {
        const result = await syncUnsyncedToConvex(state.organizationId);
        if (result.success) {
          await storage.set(LAST_BACKGROUND_FLUSH_KEY, flushNow.toString());
        }
      } catch (flushError) {
        const errMsg = flushError instanceof Error ? flushError.message : String(flushError);
        console.warn(`[LocationTracking] Background sync failed (SQLite retains data): ${errMsg}`);
      }
    }
  } catch (err) {
    console.error('[LocationTracking] Error processing locations:', err);
  }
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
        message: 'Tracking started (foreground only in Expo Go)' 
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
      return { success: false, message: 'Background location permission required. Please enable "Always" location access in Settings.' };
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
        // HIGH ACCURACY for better route reconstruction
        accuracy: Location.Accuracy.BestForNavigation,
        
        // Track every 1 minute OR 50m movement (whichever comes first)
        timeInterval: TRACKING_INTERVAL_MS,
        distanceInterval: MIN_DISTANCE_METERS,
        
        // Show indicator so user knows tracking is active
        showsBackgroundLocationIndicator: true,
        
        // Android foreground service (required for background)
        foregroundService: {
          notificationTitle: 'Route Tracking Active',
          notificationBody: 'Recording your delivery route',
          notificationColor: '#22c55e',
        },
        
        // iOS specific - optimize for driving
        activityType: Location.ActivityType.AutomotiveNavigation,
        pausesUpdatesAutomatically: false,
        
        // Android specific - batch updates for efficiency
        deferredUpdatesInterval: TRACKING_INTERVAL_MS,
        deferredUpdatesDistance: MIN_DISTANCE_METERS,
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

    // Stop sync interval and foreground polling
    stopSyncInterval();
    await stopForegroundPolling();

    // Final sync attempt — any failures are safe, SQLite retains unsynced rows
    const state = await getTrackingState();
    if (state?.isActive) {
      try {
        await syncUnsyncedToConvex(state.organizationId);
      } catch (err) {
        const unsyncedRemaining = await getUnsyncedCount();
        console.warn(`[LocationTracking] Final sync incomplete, ${unsyncedRemaining} points retained in SQLite for later upload`);
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

    // Try to restart background tracking (for development builds)
    if (!isExpoGo && isPhysicalDevice) {
      try {
        const isRegistered = await TaskManager.isTaskRegisteredAsync(LOCATION_TASK_NAME);
        if (!isRegistered) {
          await Location.startLocationUpdatesAsync(LOCATION_TASK_NAME, {
            accuracy: Location.Accuracy.BestForNavigation,
            timeInterval: TRACKING_INTERVAL_MS,
            distanceInterval: MIN_DISTANCE_METERS,
            showsBackgroundLocationIndicator: true,
            foregroundService: {
              notificationTitle: 'Route Tracking Active',
              notificationBody: 'Recording your delivery route',
              notificationColor: '#22c55e',
            },
            activityType: Location.ActivityType.AutomotiveNavigation,
            pausesUpdatesAutomatically: false,
          });
          console.log('[LocationTracking] Background tracking resumed');
        } else {
          console.log('[LocationTracking] Background task already registered');
        }
      } catch (bgError) {
        console.warn('[LocationTracking] Could not resume background tracking:', bgError);
        // Fall back to foreground polling
        startForegroundPolling(state.organizationId);
      }
    } else {
      // Expo Go - use foreground polling
      startForegroundPolling(state.organizationId);
    }

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
      state 
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

  console.log('[LocationTracking] Sync interval started (every 2 min)');
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
        // Highest accuracy for best GPS readings
        accuracy: Location.Accuracy.BestForNavigation,
        // Update when moved 30 meters (more granular than background)
        distanceInterval: 30,
        // Also update every 30 seconds minimum
        timeInterval: 30000,
      },
      async (location) => {
        try {
          const state = await getTrackingState();
          if (!state?.isActive) {
            await stopForegroundPolling();
            return;
          }

          if (location.coords.accuracy && location.coords.accuracy > MAX_ACCURACY_METERS) {
            console.log(`[LocationTracking] Watch: rejected (accuracy ${location.coords.accuracy?.toFixed(0)}m)`);
            return;
          }

          const now = Date.now();
          const timeSinceLast = lastForegroundLocation ? now - lastForegroundLocation.time : Infinity;

          // Throttle: don't save more than once per 30s
          if (timeSinceLast < 30000) {
            return;
          }

          let tooClose = false;
          if (lastForegroundLocation) {
            const distance = calculateDistance(
              lastForegroundLocation.latitude,
              lastForegroundLocation.longitude,
              location.coords.latitude,
              location.coords.longitude
            );
            if (distance < MIN_DISTANCE_BETWEEN_POINTS) {
              tooClose = true;
            }
          }

          // Save if moved enough, OR every 5 min as heartbeat even if stationary
          const needsHeartbeat = timeSinceLast >= HEARTBEAT_INTERVAL_MS;
          if (tooClose && !needsHeartbeat) {
            return;
          }

          await insertLocation({
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

          lastForegroundLocation = {
            latitude: location.coords.latitude,
            longitude: location.coords.longitude,
            time: now,
          };

          console.log(`[LocationTracking] Watch: saved to SQLite (accuracy ${location.coords.accuracy?.toFixed(0)}m, speed ${((location.coords.speed || 0) * 2.237).toFixed(0)}mph${tooClose ? ', heartbeat' : ''})`);

          // Sync to Convex when we have a few unsynced points
          const unsyncedCount = await getUnsyncedCount();
          if (unsyncedCount >= 3) {
            await syncUnsyncedToConvex(organizationId);
          }
        } catch (error) {
          console.error('[LocationTracking] Watch callback error:', error);
        }
      }
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

    console.log(`[LocationTracking] Captured initial location to SQLite (rowId=${rowId}, accuracy=${location.coords.accuracy?.toFixed(0)}m, lat=${location.coords.latitude.toFixed(5)}, lng=${location.coords.longitude.toFixed(5)})`);

    // Immediately try to sync this point while we have valid auth
    try {
      await syncUnsyncedToConvex(state.organizationId);
    } catch (syncErr) {
      console.warn('[LocationTracking] Immediate sync of initial point failed (will retry later):', syncErr instanceof Error ? syncErr.message : syncErr);
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
const SYNC_BATCH_SIZE = 50;

async function syncUnsyncedToConvex(
  organizationId: string,
  retryAttempt = 0
): Promise<{ success: boolean; synced: number }> {
  const MAX_AUTH_RETRIES = 3;
  const AUTH_RETRY_DELAYS = [3000, 6000, 12000];

  try {
    const unsynced = await getUnsyncedLocations(SYNC_BATCH_SIZE);
    if (unsynced.length === 0) {
      return { success: true, synced: 0 };
    }

    console.log(`[LocationTracking] Syncing ${unsynced.length} unsynced points to Convex (orgId=${organizationId.substring(0, 12)}..., attempt=${retryAttempt})`);

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

    const result = await authedMutation<{ inserted: number }>(
      api.driverLocations.batchInsertLocations,
      { locations, organizationId }
    );

    const syncedIds = unsynced.map((r) => r.id);
    await markAsSynced(syncedIds);

    console.log(`[LocationTracking] Synced ${result.inserted} locations, marked ${syncedIds.length} rows`);

    if (result.inserted < syncedIds.length) {
      console.warn(`[LocationTracking] Server accepted ${result.inserted}/${syncedIds.length} — some points may have been rejected (org mismatch or invalid driver/load)`);
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
    const isAuthError = errorMsg.includes('Not authenticated') || errorMsg.includes('auth') || errorMsg.includes('Unauthenticated');

    if (isAuthError && retryAttempt < MAX_AUTH_RETRIES) {
      const delay = AUTH_RETRY_DELAYS[retryAttempt] ?? 12000;
      console.warn(`[LocationTracking] Sync auth failed (attempt ${retryAttempt + 1}/${MAX_AUTH_RETRIES}), retrying in ${delay / 1000}s... (SQLite data safe)`);
      await new Promise((r) => setTimeout(r, delay));
      return syncUnsyncedToConvex(organizationId, retryAttempt + 1);
    }

    const remaining = await getUnsyncedCount();
    console.error(`[LocationTracking] Sync failed (attempt ${retryAttempt + 1}): ${errorMsg} — ${remaining} points retained in SQLite for later`);
    return { success: false, synced: 0 };
  }
}

// Export for use by the app layout's foreground flush
export { syncUnsyncedToConvex };

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
