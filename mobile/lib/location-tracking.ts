import * as Location from 'expo-location';
import * as TaskManager from 'expo-task-manager';
import Constants from 'expo-constants';
import { Platform } from 'react-native';
import { storage } from './storage';
import { convex } from './convex';
import { api } from '../../convex/_generated/api';
import { Id } from '../../convex/_generated/dataModel';

// ============================================
// LOCATION TRACKING
// Background location tracking for route recording
// Tracks driver from first stop checkout to last stop checkout
// NOTE: Background location requires a development build (not Expo Go)
// ============================================

const LOCATION_TASK_NAME = 'OTOQA_LOCATION_TRACKING';
const TRACKING_STATE_KEY = 'location_tracking_state';
const LOCATION_BUFFER_KEY = 'location_buffer';

// ============================================
// TRACKING CONFIGURATION
// Optimized for accurate route reconstruction
// ============================================
const TRACKING_INTERVAL_MS = 1 * 60 * 1000;  // 1 minute (was 5 minutes)
const SYNC_INTERVAL_MS = 2 * 60 * 1000;      // Sync to server every 2 minutes
const MIN_DISTANCE_METERS = 50;               // Also track on 50m movement (was 100m)
const MAX_ACCURACY_METERS = 50;               // Reject readings with > 50m accuracy
const MIN_DISTANCE_BETWEEN_POINTS = 20;       // Skip if < 20m from last point (avoid duplicates)

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

interface BufferedLocation {
  driverId: string;
  loadId: string;
  latitude: number;
  longitude: number;
  accuracy: number | null;
  speed: number | null;
  heading: number | null;
  trackingType: 'LOAD_ROUTE';
  recordedAt: number;
}

// ============================================
// BACKGROUND TASK DEFINITION
// Must be at module scope for background execution
// ============================================

TaskManager.defineTask(LOCATION_TASK_NAME, async ({ data, error }) => {
  if (error) {
    console.error('[LocationTracking] Task error:', error);
    return;
  }

  try {
    const stateJson = await storage.getString(TRACKING_STATE_KEY);
    if (!stateJson) {
      console.log('[LocationTracking] No tracking state found');
      return;
    }

    const state: TrackingState = JSON.parse(stateJson);
    if (!state.isActive) {
      console.log('[LocationTracking] Tracking not active');
      return;
    }

    const { locations } = data as { locations: Location.LocationObject[] };
    if (!locations || locations.length === 0) {
      console.log('[LocationTracking] No locations in data');
      return;
    }

    // Get existing buffer
    const bufferJson = await storage.getString(LOCATION_BUFFER_KEY);
    const buffer: BufferedLocation[] = bufferJson ? JSON.parse(bufferJson) : [];

    // Get last buffered location for distance check
    const lastPoint = buffer.length > 0 ? buffer[buffer.length - 1] : null;

    let addedCount = 0;
    let rejectedAccuracy = 0;
    let rejectedDistance = 0;

    // Add new locations to buffer with filtering
    for (const loc of locations) {
      // Filter 1: Reject inaccurate readings (> 50m accuracy)
      if (loc.coords.accuracy && loc.coords.accuracy > MAX_ACCURACY_METERS) {
        rejectedAccuracy++;
        continue;
      }

      // Filter 2: Skip if too close to last point (avoid duplicates)
      if (lastPoint || buffer.length > 0) {
        const prevPoint = buffer.length > 0 ? buffer[buffer.length - 1] : lastPoint;
        if (prevPoint) {
          const distance = calculateDistance(
            prevPoint.latitude,
            prevPoint.longitude,
            loc.coords.latitude,
            loc.coords.longitude
          );
          if (distance < MIN_DISTANCE_BETWEEN_POINTS) {
            rejectedDistance++;
            continue;
          }
        }
      }

      buffer.push({
        driverId: state.driverId,
        loadId: state.loadId,
        latitude: loc.coords.latitude,
        longitude: loc.coords.longitude,
        accuracy: loc.coords.accuracy,
        speed: loc.coords.speed,
        heading: loc.coords.heading,
        trackingType: state.trackingType,
        recordedAt: loc.timestamp,
      });
      addedCount++;
    }

    // Save updated buffer
    await storage.set(LOCATION_BUFFER_KEY, JSON.stringify(buffer));
    console.log(`[LocationTracking] Added ${addedCount}/${locations.length} locations (rejected: ${rejectedAccuracy} accuracy, ${rejectedDistance} distance) (total: ${buffer.length})`);
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

    // Check if running in Expo Go - background tasks don't work there
    if (isExpoGo) {
      console.warn('[LocationTracking] Running in Expo Go - background location not supported');
      console.warn('[LocationTracking] Please use a development build for background tracking');
      
      // Still save state and capture initial location for testing
      const state: TrackingState = {
        isActive: true,
        driverId: params.driverId as string,
        loadId: params.loadId as string,
        organizationId: params.organizationId,
        trackingType: 'LOAD_ROUTE',
        startedAt: Date.now(),
      };
      await storage.set(TRACKING_STATE_KEY, JSON.stringify(state));
      await storage.set(LOCATION_BUFFER_KEY, JSON.stringify([]));
      
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

    // Clear any existing buffer
    await storage.set(LOCATION_BUFFER_KEY, JSON.stringify([]));

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

      console.log('[LocationTracking] Background tracking started successfully');
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

    // Flush remaining buffer before stopping
    const state = await getTrackingState();
    if (state?.isActive) {
      await flushLocationBuffer(state.organizationId);
    }

    // Clear tracking state
    await storage.set(TRACKING_STATE_KEY, JSON.stringify({ isActive: false }));

    // Stop background updates if registered (only in non-Expo Go)
    if (!isExpoGo) {
      const isRegistered = await TaskManager.isTaskRegisteredAsync(LOCATION_TASK_NAME);
      if (isRegistered) {
        await Location.stopLocationUpdatesAsync(LOCATION_TASK_NAME);
      }
    }

    // Clear buffer
    await storage.delete(LOCATION_BUFFER_KEY);

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
 * Get buffered location count (for debugging)
 */
export async function getBufferedLocationCount(): Promise<number> {
  try {
    const bufferJson = await storage.getString(LOCATION_BUFFER_KEY);
    if (!bufferJson) return 0;
    const buffer: BufferedLocation[] = JSON.parse(bufferJson);
    return buffer.length;
  } catch {
    return 0;
  }
}

/**
 * Force flush buffer to Convex (useful for testing or manual sync)
 */
export async function forceFlush(): Promise<{ success: boolean; synced: number }> {
  const state = await getTrackingState();
  if (!state?.organizationId) {
    return { success: false, synced: 0 };
  }
  return await flushLocationBuffer(state.organizationId);
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

    // Flush any buffered locations from before restart
    const bufferedCount = await getBufferedLocationCount();
    if (bufferedCount > 0) {
      console.log(`[LocationTracking] Flushing ${bufferedCount} buffered locations`);
      await flushLocationBuffer(state.organizationId);
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

  // Sync to server every 2 minutes
  syncIntervalId = setInterval(async () => {
    await flushLocationBuffer(organizationId);
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

          // Filter: Reject inaccurate readings (> 50m accuracy)
          if (location.coords.accuracy && location.coords.accuracy > MAX_ACCURACY_METERS) {
            console.log(`[LocationTracking] Watch: rejected (accuracy ${location.coords.accuracy?.toFixed(0)}m)`);
            return;
          }

          // Filter: Skip if too close to last location (< 20m)
          if (lastForegroundLocation) {
            const distance = calculateDistance(
              lastForegroundLocation.latitude,
              lastForegroundLocation.longitude,
              location.coords.latitude,
              location.coords.longitude
            );
            if (distance < MIN_DISTANCE_BETWEEN_POINTS) {
              return; // Silent skip for nearby points
            }
          }

          // Filter: Skip if too recent (< 30 seconds since last save)
          const now = Date.now();
          if (lastForegroundLocation && now - lastForegroundLocation.time < 30000) {
            return;
          }

          // Add to buffer
          const bufferJson = await storage.getString(LOCATION_BUFFER_KEY);
          const buffer: BufferedLocation[] = bufferJson ? JSON.parse(bufferJson) : [];

          buffer.push({
            driverId: state.driverId,
            loadId: state.loadId,
            latitude: location.coords.latitude,
            longitude: location.coords.longitude,
            accuracy: location.coords.accuracy,
            speed: location.coords.speed,
            heading: location.coords.heading,
            trackingType: state.trackingType,
            recordedAt: location.timestamp,
          });

          await storage.set(LOCATION_BUFFER_KEY, JSON.stringify(buffer));
          
          // Update last location
          lastForegroundLocation = {
            latitude: location.coords.latitude,
            longitude: location.coords.longitude,
            time: now,
          };

          console.log(`[LocationTracking] Watch: captured (accuracy ${location.coords.accuracy?.toFixed(0)}m, speed ${((location.coords.speed || 0) * 2.237).toFixed(0)}mph)`);

          // Flush to server when we have a few points
          if (buffer.length >= 3) {
            await flushLocationBuffer(organizationId);
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
 * Capture current location immediately and add to buffer
 */
async function captureCurrentLocation(state: TrackingState) {
  try {
    const location = await Location.getCurrentPositionAsync({
      accuracy: Location.Accuracy.High,
    });

    const bufferJson = await storage.getString(LOCATION_BUFFER_KEY);
    const buffer: BufferedLocation[] = bufferJson ? JSON.parse(bufferJson) : [];

    buffer.push({
      driverId: state.driverId,
      loadId: state.loadId,
      latitude: location.coords.latitude,
      longitude: location.coords.longitude,
      accuracy: location.coords.accuracy,
      speed: location.coords.speed,
      heading: location.coords.heading,
      trackingType: state.trackingType,
      recordedAt: location.timestamp,
    });

    await storage.set(LOCATION_BUFFER_KEY, JSON.stringify(buffer));
    console.log('[LocationTracking] Captured initial location');
  } catch (error) {
    console.error('[LocationTracking] Failed to capture initial location:', error);
  }
}

/**
 * Flush buffered locations to Convex
 */
async function flushLocationBuffer(
  organizationId: string
): Promise<{ success: boolean; synced: number }> {
  try {
    const bufferJson = await storage.getString(LOCATION_BUFFER_KEY);
    if (!bufferJson) {
      return { success: true, synced: 0 };
    }

    const buffer: BufferedLocation[] = JSON.parse(bufferJson);
    if (buffer.length === 0) {
      return { success: true, synced: 0 };
    }

    console.log(`[LocationTracking] Flushing ${buffer.length} locations to Convex...`);

    // Transform buffer to Convex format
    const locations = buffer.map((loc) => ({
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

    // Send to Convex
    const result = await convex.mutation(api.driverLocations.batchInsertLocations, {
      locations,
      organizationId,
    });

    // Clear buffer on success
    await storage.set(LOCATION_BUFFER_KEY, JSON.stringify([]));
    console.log(`[LocationTracking] Synced ${result.inserted} locations`);

    return { success: true, synced: result.inserted };
  } catch (error) {
    console.error('[LocationTracking] Flush failed:', error);
    // Keep buffer for retry
    return { success: false, synced: 0 };
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
