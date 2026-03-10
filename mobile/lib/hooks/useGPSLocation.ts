import { useEffect, useRef, useState, useCallback } from 'react';
import * as Location from 'expo-location';
import {
  trackGPSPrewarmComplete,
  trackGPSPrewarmFailed,
  trackGPSFreshFixObtained,
  trackGPSFreshFixTimeout,
  trackGPSHighAccuracyUpgrade,
  trackGPSPermissionDenied,
} from '../analytics';

// ============================================
// GPS LOCATION HOOK
// Pre-warms GPS on mount, progressive Balanced-to-High accuracy,
// continuous background watch. Always returns a fresh fix.
// ============================================

interface GPSState {
  latitude: number;
  longitude: number;
  accuracy: number | null;
  timestamp: number;
  source: 'balanced' | 'high';
}

const GPS_MAX_TIMEOUT_MS = 20_000;
const HIGH_ACCURACY_MAX_AGE_MS = 30_000;
const BALANCED_MAX_AGE_MS = 10_000;

function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  return Promise.race([
    promise,
    new Promise<never>((_, reject) =>
      setTimeout(() => reject(new Error('GPS timeout')), ms)
    ),
  ]);
}

export function useGPSLocation() {
  const [location, setLocation] = useState<GPSState | null>(null);
  const [isWarming, setIsWarming] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const watchRef = useRef<Location.LocationSubscription | null>(null);
  const locationRef = useRef<GPSState | null>(null);

  // Keep ref in sync so getFreshLocation always has latest
  useEffect(() => {
    locationRef.current = location;
  }, [location]);

  useEffect(() => {
    let cancelled = false;
    const prewarmStart = Date.now();

    async function prewarm() {
      const { status } = await Location.requestForegroundPermissionsAsync();
      if (status !== 'granted') {
        if (!cancelled) {
          setError('Location permission not granted');
          setIsWarming(false);
          trackGPSPermissionDenied();
        }
        return;
      }

      // Get an initial Balanced fix (fast: 1-3s, ~10-30m accuracy)
      try {
        const loc = await Location.getCurrentPositionAsync({
          accuracy: Location.Accuracy.Balanced,
        });
        if (!cancelled) {
          const state: GPSState = {
            latitude: loc.coords.latitude,
            longitude: loc.coords.longitude,
            accuracy: loc.coords.accuracy,
            timestamp: loc.timestamp,
            source: 'balanced',
          };
          setLocation(state);
          locationRef.current = state;
          setIsWarming(false);
          trackGPSPrewarmComplete({
            source: 'balanced',
            accuracy_m: loc.coords.accuracy,
            elapsed_ms: Date.now() - prewarmStart,
          });
        }
      } catch (err) {
        if (!cancelled) {
          setIsWarming(false);
          trackGPSPrewarmFailed(err instanceof Error ? err.message : 'unknown');
        }
      }

      // Start background watch at High accuracy to continuously improve
      try {
        let firstHighFix = true;
        watchRef.current = await Location.watchPositionAsync(
          { accuracy: Location.Accuracy.High, distanceInterval: 5 },
          (loc) => {
            if (!cancelled) {
              const state: GPSState = {
                latitude: loc.coords.latitude,
                longitude: loc.coords.longitude,
                accuracy: loc.coords.accuracy,
                timestamp: loc.timestamp,
                source: 'high',
              };
              setLocation(state);
              locationRef.current = state;
              if (firstHighFix) {
                firstHighFix = false;
                trackGPSPrewarmComplete({
                  source: 'high',
                  accuracy_m: loc.coords.accuracy,
                  elapsed_ms: Date.now() - prewarmStart,
                });
              }
            }
          }
        );
      } catch {
        // High-accuracy watch failed (e.g. permissions revoked mid-flow)
      }
    }

    prewarm();

    return () => {
      cancelled = true;
      watchRef.current?.remove();
    };
  }, []);

  const getFreshLocation = useCallback(async (): Promise<{
    latitude: number;
    longitude: number;
  }> => {
    const current = locationRef.current;
    const requestStart = Date.now();

    // Recent high-accuracy fix is good enough
    if (
      current &&
      current.source === 'high' &&
      Date.now() - current.timestamp < HIGH_ACCURACY_MAX_AGE_MS
    ) {
      trackGPSFreshFixObtained({
        source: 'prewarmed_high',
        accuracy_m: current.accuracy,
        age_ms: Date.now() - current.timestamp,
      });
      return { latitude: current.latitude, longitude: current.longitude };
    }

    // Recent balanced fix is acceptable (still within 500m check-in radius)
    if (current && Date.now() - current.timestamp < BALANCED_MAX_AGE_MS) {
      trackGPSFreshFixObtained({
        source: 'prewarmed_balanced',
        accuracy_m: current.accuracy,
        age_ms: Date.now() - current.timestamp,
      });
      return { latitude: current.latitude, longitude: current.longitude };
    }

    // Need a fresh fix -- try Balanced first (fast)
    let balancedFix: Location.LocationObject;
    try {
      balancedFix = await withTimeout(
        Location.getCurrentPositionAsync({ accuracy: Location.Accuracy.Balanced }),
        GPS_MAX_TIMEOUT_MS
      );
    } catch (err) {
      trackGPSFreshFixTimeout(Date.now() - requestStart);
      throw err;
    }

    const freshState: GPSState = {
      latitude: balancedFix.coords.latitude,
      longitude: balancedFix.coords.longitude,
      accuracy: balancedFix.coords.accuracy,
      timestamp: balancedFix.timestamp,
      source: 'balanced',
    };
    setLocation(freshState);
    locationRef.current = freshState;

    trackGPSFreshFixObtained({
      source: 'fresh_balanced',
      accuracy_m: balancedFix.coords.accuracy,
      age_ms: 0,
    });

    // Non-blocking upgrade to High accuracy
    const upgradeStart = Date.now();
    Location.getCurrentPositionAsync({ accuracy: Location.Accuracy.High })
      .then((highFix) => {
        const highState: GPSState = {
          latitude: highFix.coords.latitude,
          longitude: highFix.coords.longitude,
          accuracy: highFix.coords.accuracy,
          timestamp: highFix.timestamp,
          source: 'high',
        };
        setLocation(highState);
        locationRef.current = highState;
        trackGPSHighAccuracyUpgrade({
          accuracy_m: highFix.coords.accuracy,
          elapsed_since_balanced_ms: Date.now() - upgradeStart,
        });
      })
      .catch(() => {});

    return {
      latitude: balancedFix.coords.latitude,
      longitude: balancedFix.coords.longitude,
    };
  }, []);

  return {
    location,
    isWarming,
    error,
    getFreshLocation,
  };
}
