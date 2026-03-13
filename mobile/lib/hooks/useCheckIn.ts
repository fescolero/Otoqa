import { useMutation, useAction } from 'convex/react';
import { api } from '../../../convex/_generated/api';
import { Id } from '../../../convex/_generated/dataModel';
import { enqueueMutation } from '../offline-queue';
import { uploadPODPhoto } from '../s3-upload';
import { startLocationTracking, stopLocationTracking, isTracking } from '../location-tracking';
import * as Location from 'expo-location';
import { useNetworkStatus } from './useNetworkStatus';
import { usePostHog } from 'posthog-react-native';
import { trackCheckinOfflineQueued, trackCheckinMutationTimeout } from '../analytics';

// ============================================
// HOOK: CHECK-IN/OUT AT STOPS
// Handles online, weak-signal, and offline scenarios.
// On good connection: tries mutation with 8s timeout, falls back to queue.
// On poor/offline: queues immediately.
// Accepts optional getFreshLocation from useGPSLocation for pre-warmed GPS.
// ============================================

const MUTATION_TIMEOUT_MS = 8_000;

function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  return Promise.race([
    promise,
    new Promise<never>((_, reject) =>
      setTimeout(() => reject(new Error('Request timed out')), ms)
    ),
  ]);
}

interface CheckInOptions {
  stopId: Id<'loadStops'>;
  driverId: Id<'drivers'>;
  loadId?: Id<'loadInformation'>;
  notes?: string;
  photoUri?: string;
  stopSequence?: number;
  totalStops?: number;
  organizationId?: string;
}

interface CheckInResult {
  success: boolean;
  message: string;
  queued?: boolean;
}

type LocationGetter = () => Promise<{ latitude: number; longitude: number }>;

export function useCheckIn(getFreshLocation?: LocationGetter) {
  const checkInMutation = useMutation(api.driverMobile.checkInAtStop);
  const checkOutMutation = useMutation(api.driverMobile.checkOutFromStop);
  const getUploadUrl = useAction(api.s3Upload.getPODUploadUrl);
  const { connectionQuality } = useNetworkStatus();
  const posthog = usePostHog();

  const shouldQueue = connectionQuality !== 'good';

  // Fallback location getter when no pre-warmed GPS is provided
  const fallbackGetLocation: LocationGetter = async () => {
    const { status } = await Location.requestForegroundPermissionsAsync();
    if (status !== 'granted') {
      throw new Error('Location permission not granted');
    }
    const location = await Location.getCurrentPositionAsync({
      accuracy: Location.Accuracy.Balanced,
    });
    return {
      latitude: location.coords.latitude,
      longitude: location.coords.longitude,
    };
  };

  const getLocation = getFreshLocation || fallbackGetLocation;

  const checkIn = async (options: CheckInOptions): Promise<CheckInResult> => {
    try {
      const location = await getLocation();
      const driverTimestamp = new Date().toISOString();

      const mutationArgs = {
        stopId: options.stopId,
        driverId: options.driverId,
        latitude: location.latitude,
        longitude: location.longitude,
        driverTimestamp,
        notes: options.notes,
      };

      if (shouldQueue) {
        await enqueueMutation('checkIn', mutationArgs);
        trackCheckinOfflineQueued({
          stopId: String(options.stopId),
          loadId: options.loadId ? String(options.loadId) : undefined,
          connectionQuality,
          action: 'check_in',
        });

        // Start tracking even when offline -- GPS points go to SQLite
        if (options.stopSequence === 1 && options.loadId && options.organizationId) {
          console.log('[CheckIn] First stop (offline) - starting location tracking');
          try {
            await startLocationTracking({
              driverId: options.driverId,
              loadId: options.loadId,
              organizationId: options.organizationId,
            });
          } catch (trackErr) {
            console.warn('[CheckIn] Tracking start failed while offline:', trackErr);
          }
        }

        return {
          success: true,
          message: connectionQuality === 'offline'
            ? 'Check-in saved offline - will sync when connected'
            : 'Weak signal - check-in queued for sync',
          queued: true,
        };
      }

      // Good connection -- try with timeout, fall back to queue
      const mutationStart = Date.now();
      try {
        const result = await withTimeout(
          checkInMutation(mutationArgs),
          MUTATION_TIMEOUT_MS
        );

        // Start location tracking on check-in at the first stop
        console.log(`[CheckIn] Tracking check: success=${result.success}, seq=${options.stopSequence}, total=${options.totalStops}, loadId=${options.loadId ? 'yes' : 'no'}, orgId=${options.organizationId ? 'yes' : 'no'}`);
        if (result.success && options.stopSequence && options.totalStops && options.loadId && options.organizationId) {
          const isFirstStop = options.stopSequence === 1;

          if (isFirstStop) {
            console.log('[CheckIn] First stop check-in - starting location tracking');
            const trackingResult = await startLocationTracking({
              driverId: options.driverId,
              loadId: options.loadId,
              organizationId: options.organizationId,
            });

            posthog.capture('location_tracking_started', {
              loadId: options.loadId ?? null,
              stopId: options.stopId,
              trigger: 'check_in',
              success: trackingResult.success,
              message: trackingResult.message,
            });

            if (!trackingResult.success) {
              console.warn('[CheckIn] Location tracking failed to start:', trackingResult.message);
            }
          }
        }

        return result;
      } catch (onlineError) {
        await enqueueMutation('checkIn', mutationArgs);
        trackCheckinMutationTimeout({
          stopId: String(options.stopId),
          loadId: options.loadId ? String(options.loadId) : undefined,
          action: 'check_in',
          elapsed_ms: Date.now() - mutationStart,
        });
        posthog.capture('checkin_timeout_queued', {
          stopId: options.stopId,
          error: onlineError instanceof Error ? onlineError.message : 'timeout',
        });

        // Still try to start tracking even if the mutation was queued
        if (options.stopSequence === 1 && options.loadId && options.organizationId) {
          console.log('[CheckIn] First stop (queued) - starting location tracking anyway');
          try {
            await startLocationTracking({
              driverId: options.driverId,
              loadId: options.loadId,
              organizationId: options.organizationId,
            });
          } catch (trackErr) {
            console.warn('[CheckIn] Tracking start failed after queue:', trackErr);
          }
        }

        return {
          success: true,
          message: 'Connection slow - check-in queued for sync',
          queued: true,
        };
      }
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : 'Check-in failed';
      posthog.capture('checkin_failed', {
        stopId: options.stopId,
        error: errorMessage,
        errorStack: error instanceof Error ? error.stack ?? null : null,
      });
      return {
        success: false,
        message: errorMessage,
      };
    }
  };

  const checkOut = async (options: CheckInOptions): Promise<CheckInResult> => {
    try {
      const location = await getLocation();
      const driverTimestamp = new Date().toISOString();

      const baseMutationArgs = {
        stopId: options.stopId,
        driverId: options.driverId,
        latitude: location.latitude,
        longitude: location.longitude,
        driverTimestamp,
        notes: options.notes,
      };

      if (shouldQueue) {
        await enqueueMutation(
          'checkOut',
          baseMutationArgs,
          { photoUri: options.photoUri }
        );
        trackCheckinOfflineQueued({
          stopId: String(options.stopId),
          loadId: options.loadId ? String(options.loadId) : undefined,
          connectionQuality,
          action: 'check_out',
        });
        return {
          success: true,
          message: connectionQuality === 'offline'
            ? 'Check-out saved offline - will sync when connected'
            : 'Weak signal - check-out queued for sync',
          queued: true,
        };
      }

      // Good connection -- upload photo first if provided
      let podPhotoUrl: string | undefined;

      if (options.photoUri) {
        try {
          console.log('[CheckOut] Photo URI:', options.photoUri);
          console.log('[CheckOut] Getting presigned URL from Convex...');

          const { uploadUrl, fileUrl } = await getUploadUrl({
            loadId: options.loadId ? String(options.loadId) : 'unknown',
            stopId: String(options.stopId),
            filename: `pod_${Date.now()}.jpg`,
          });

          console.log('[CheckOut] Got presigned URL, uploading to R2...');
          console.log('[CheckOut] Upload URL (first 100 chars):', uploadUrl.substring(0, 100));

          const uploadResult = await uploadPODPhoto(uploadUrl, options.photoUri);

          if (uploadResult.success) {
            podPhotoUrl = fileUrl;
            console.log('[CheckOut] Photo uploaded successfully:', podPhotoUrl);
            posthog.capture('photo_upload_success', {
              loadId: options.loadId ?? null,
              stopId: options.stopId,
              fileUrl,
            });
          } else {
            console.error('[CheckOut] Photo upload failed:', uploadResult.error);
            posthog.capture('photo_upload_failed', {
              loadId: options.loadId ?? null,
              stopId: options.stopId,
              error: uploadResult.error ?? null,
              photoUri: options.photoUri,
            });
          }
        } catch (uploadError: any) {
          const errorMessage = uploadError?.message || String(uploadError);
          console.error('[CheckOut] Photo upload error:', errorMessage);
          posthog.capture('photo_upload_exception', {
            loadId: options.loadId ?? null,
            stopId: options.stopId,
            error: errorMessage,
            errorStack: uploadError?.stack ?? null,
            photoUri: options.photoUri,
          });
        }
      }

      // Try mutation with timeout, fall back to queue
      const checkoutMutationStart = Date.now();
      try {
        const result = await withTimeout(
          checkOutMutation({
            ...baseMutationArgs,
            podPhotoUrl,
          }),
          MUTATION_TIMEOUT_MS
        );

        // Handle location tracking based on stop position
        if (result.success && options.stopSequence && options.totalStops && options.loadId && options.organizationId) {
          const isFirstStop = options.stopSequence === 1;
          const isLastStop = options.stopSequence === options.totalStops;

          if (isFirstStop) {
            // Safety net: check-in should have started tracking, but ensure it's running
            const alreadyTracking = await isTracking();
            if (!alreadyTracking) {
              console.log('[CheckOut] First stop checkout - tracking not running, starting as fallback');
              const trackingResult = await startLocationTracking({
                driverId: options.driverId,
                loadId: options.loadId,
                organizationId: options.organizationId,
              });

              posthog.capture('location_tracking_started', {
                loadId: options.loadId ?? null,
                stopId: options.stopId,
                trigger: 'check_out_fallback',
                success: trackingResult.success,
                message: trackingResult.message,
              });

              if (!trackingResult.success) {
                console.warn('[CheckOut] Location tracking failed to start:', trackingResult.message);
              }
            } else {
              console.log('[CheckOut] First stop checkout - tracking already running from check-in');
            }
          } else if (isLastStop) {
            console.log('[CheckOut] Last stop - stopping location tracking');
            const trackingResult = await stopLocationTracking();

            posthog.capture('location_tracking_stopped', {
              loadId: options.loadId ?? null,
              stopId: options.stopId,
              success: trackingResult.success,
            });
          }
        }

        return result;
      } catch (onlineError) {
        // Mutation timed out or failed -- queue it (photo already uploaded or will be re-uploaded from queue)
        await enqueueMutation(
          'checkOut',
          { ...baseMutationArgs, podPhotoUrl },
          { photoUri: !podPhotoUrl ? options.photoUri : undefined }
        );
        trackCheckinMutationTimeout({
          stopId: String(options.stopId),
          loadId: options.loadId ? String(options.loadId) : undefined,
          action: 'check_out',
          elapsed_ms: Date.now() - checkoutMutationStart,
        });
        posthog.capture('checkout_timeout_queued', {
          stopId: options.stopId,
          loadId: options.loadId ?? null,
          error: onlineError instanceof Error ? onlineError.message : 'timeout',
        });
        return {
          success: true,
          message: 'Connection slow - check-out queued for sync',
          queued: true,
        };
      }
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : 'Check-out failed';
      posthog.capture('checkout_failed', {
        loadId: options.loadId ?? null,
        stopId: options.stopId,
        error: errorMessage,
        errorStack: error instanceof Error ? error.stack ?? null : null,
      });
      return {
        success: false,
        message: errorMessage,
      };
    }
  };

  return {
    checkIn,
    checkOut,
    isOffline: shouldQueue,
  };
}
