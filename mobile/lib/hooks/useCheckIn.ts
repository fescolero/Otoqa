import { useMutation, useAction } from 'convex/react';
import { api } from '../../../convex/_generated/api';
import { Id } from '../../../convex/_generated/dataModel';
import { enqueueMutation } from '../offline-queue';
import { uploadPODPhoto } from '../s3-upload';
import {
  ensureTrackingForLoad,
  stopLocationTracking,
  getTrackingState,
  attachLoadToSession,
  detachLoadFromSession,
  reconcileTrackingStateWithActiveSession,
} from '../location-tracking';
import * as Location from 'expo-location';
import { useNetworkStatus } from './useNetworkStatus';
import { usePostHog } from 'posthog-react-native';
import { trackCheckinOfflineQueued, trackCheckinMutationTimeout } from '../analytics';

/**
 * Two tracking modes coexist on mobile during the rollout:
 *
 *   Session mode (Phase 3): the driver started a shift via the QR scan +
 *     Start Shift flow. tracking-state.sessionId is set. Check-in attaches
 *     the loadId to the existing ping stream; check-out detaches it but
 *     keeps the session running. End Shift is the only way to fully stop.
 *
 *   Legacy load mode: no session exists. Check-in starts load-bound
 *     tracking; last-stop checkout fully stops it. Same as today.
 *
 * Helpers below detect the mode by reading the persisted tracking state
 * and route accordingly. Session mode is preferred when both could apply.
 */
async function attachLoadToTrackingForCheckIn(params: {
  driverId: Id<'drivers'>;
  loadId: Id<'loadInformation'>;
  organizationId: string;
}): Promise<{
  success: boolean;
  message: string;
  mode: 'session' | 'legacy_load';
  action?: 'attached' | 'started' | 'continued' | 'handoff';
  previousLoadId?: string;
}> {
  // Reconcile with the server's active-session source of truth BEFORE
  // deciding mode. Drivers whose TrackingState lost / never had
  // sessionId (e.g., from the pre-fix start-shift.tsx typo) get their
  // state patched here, so this check-in and every subsequent ping
  // flows in session mode and lastPingAt populates on the server.
  // See reconcileTrackingStateWithActiveSession in location-tracking.ts.
  const state = await reconcileTrackingStateWithActiveSession('check_in');
  if (state?.isActive && state.sessionId) {
    const result = await attachLoadToSession(params.loadId);
    return {
      success: result.success,
      message: result.message,
      mode: 'session',
      action: 'attached',
    };
  }
  const legacy = await ensureTrackingForLoad(params);
  return {
    success: legacy.success,
    message: legacy.message,
    mode: 'legacy_load',
    action: legacy.action,
    previousLoadId: legacy.previousLoadId,
  };
}

async function releaseLoadFromTrackingOnLastStop(): Promise<{
  success: boolean;
  message: string;
  mode: 'session' | 'legacy_load';
}> {
  const state = await getTrackingState();
  if (state?.isActive && state.sessionId) {
    // Session mode: keep tracking running. Just dissociate the load from
    // the ping stream. Driver ends the shift explicitly later.
    const result = await detachLoadFromSession();
    return { success: result.success, message: result.message, mode: 'session' };
  }
  // Legacy mode: last-stop checkout fully stops tracking.
  const result = await stopLocationTracking();
  return { success: result.success, message: result.message, mode: 'legacy_load' };
}

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
    new Promise<never>((_, reject) => setTimeout(() => reject(new Error('Request timed out')), ms)),
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
  isRedirected?: boolean;
}

interface CheckInResult {
  success: boolean;
  message: string;
  queued?: boolean;
  trackingFailed?: boolean;
  trackingMessage?: string;
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
        ...(options.isRedirected ? { isRedirected: true } : {}),
      };

      if (shouldQueue) {
        await enqueueMutation('checkIn', mutationArgs);
        trackCheckinOfflineQueued({
          stopId: String(options.stopId),
          loadId: options.loadId ? String(options.loadId) : undefined,
          connectionQuality,
          action: 'check_in',
        });

        // Attach load to tracking even when offline -- GPS points go to SQLite.
        // Session mode: just attaches loadId to the existing ping stream.
        // Legacy mode: starts load-bound tracking from scratch.
        if (options.loadId && options.organizationId) {
          console.log(`[CheckIn] Stop ${options.stopSequence} (offline) - attaching load to tracking`);
          try {
            const trackingResult = await attachLoadToTrackingForCheckIn({
              driverId: options.driverId,
              loadId: options.loadId,
              organizationId: options.organizationId,
            });
            if (trackingResult.action === 'handoff') {
              posthog.capture('location_tracking_handed_off', {
                fromLoadId: trackingResult.previousLoadId ?? null,
                toLoadId: options.loadId,
                stopId: options.stopId,
                trigger: 'check_in_offline',
                mode: trackingResult.mode,
                success: trackingResult.success,
                message: trackingResult.message,
              });
            }
          } catch (trackErr) {
            console.warn('[CheckIn] Tracking attach failed while offline:', trackErr);
          }
        }

        return {
          success: true,
          message:
            connectionQuality === 'offline'
              ? 'Check-in saved offline - will sync when connected'
              : 'Weak signal - check-in queued for sync',
          queued: true,
        };
      }

      // Good connection -- try with timeout, fall back to queue
      const mutationStart = Date.now();
      try {
        const result = await withTimeout(checkInMutation(mutationArgs), MUTATION_TIMEOUT_MS);

        // Start location tracking if not already running.
        let trackingFailed = false;
        let trackingMessage: string | undefined;

        console.log(
          `[CheckIn] Tracking check: success=${result.success}, seq=${options.stopSequence}, total=${options.totalStops}, loadId=${options.loadId ? 'yes' : 'no'}, orgId=${options.organizationId ? 'yes' : 'no'}`,
        );
        if (result.success && options.loadId && options.organizationId) {
          console.log(
            `[CheckIn] Stop ${options.stopSequence} check-in - attaching load to tracking`,
          );
          const trackingResult = await attachLoadToTrackingForCheckIn({
            driverId: options.driverId,
            loadId: options.loadId,
            organizationId: options.organizationId,
          });

          const trigger = options.stopSequence === 1 ? 'check_in' : 'check_in_late_start';
          if (trackingResult.action === 'handoff') {
            posthog.capture('location_tracking_handed_off', {
              fromLoadId: trackingResult.previousLoadId ?? null,
              toLoadId: options.loadId,
              stopId: options.stopId,
              trigger,
              mode: trackingResult.mode,
              success: trackingResult.success,
              message: trackingResult.message,
            });
          } else if (trackingResult.action === 'started' || trackingResult.action === 'attached') {
            posthog.capture('location_tracking_started', {
              loadId: options.loadId ?? null,
              stopId: options.stopId,
              trigger,
              mode: trackingResult.mode,
              action: trackingResult.action,
              success: trackingResult.success,
              message: trackingResult.message,
            });
          }

          if (!trackingResult.success) {
            console.warn('[CheckIn] Tracking attach failed:', trackingResult.message);
            trackingFailed = true;
            trackingMessage = trackingResult.message;
          }
        }

        return { ...result, trackingFailed, trackingMessage };
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

        // Still attach load to tracking even if the mutation was queued
        if (options.loadId && options.organizationId) {
          console.log(`[CheckIn] Stop ${options.stopSequence} (queued) - attaching load to tracking`);
          try {
            const trackingResult = await attachLoadToTrackingForCheckIn({
              driverId: options.driverId,
              loadId: options.loadId,
              organizationId: options.organizationId,
            });
            if (trackingResult.action === 'handoff') {
              posthog.capture('location_tracking_handed_off', {
                fromLoadId: trackingResult.previousLoadId ?? null,
                toLoadId: options.loadId,
                stopId: options.stopId,
                trigger: 'check_in_queued',
                mode: trackingResult.mode,
                success: trackingResult.success,
                message: trackingResult.message,
              });
            }
          } catch (trackErr) {
            console.warn('[CheckIn] Tracking attach failed after queue:', trackErr);
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
        errorStack: error instanceof Error ? (error.stack ?? null) : null,
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
        await enqueueMutation('checkOut', baseMutationArgs, { photoUri: options.photoUri });
        trackCheckinOfflineQueued({
          stopId: String(options.stopId),
          loadId: options.loadId ? String(options.loadId) : undefined,
          connectionQuality,
          action: 'check_out',
        });
        return {
          success: true,
          message:
            connectionQuality === 'offline'
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

          const nowMs = Date.now();
          const { uploadUrl, fileUrl, metadataHeaders } = await getUploadUrl({
            loadId: options.loadId ? String(options.loadId) : 'unknown',
            stopId: String(options.stopId),
            filename: `pod_${nowMs}.jpg`,
            // Stamp the R2 object with the same GPS + driverId we're
            // about to hand to the check-out mutation. This makes the
            // bucket searchable / auditable without Convex.
            driverId: String(options.driverId),
            capturedAt: nowMs,
            capturedLat: location.latitude,
            capturedLng: location.longitude,
          });

          console.log('[CheckOut] Got presigned URL, uploading to R2...');
          console.log('[CheckOut] Upload URL (first 100 chars):', uploadUrl.substring(0, 100));

          const uploadResult = await uploadPODPhoto(uploadUrl, options.photoUri, 3, metadataHeaders);

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
          MUTATION_TIMEOUT_MS,
        );

        // Handle location tracking based on stop position
        let trackingFailed = false;
        let trackingMessage: string | undefined;

        console.log(
          `[CheckOut] Tracking check: success=${result.success}, seq=${options.stopSequence}, total=${options.totalStops}, loadId=${options.loadId ? 'yes' : 'no'}, orgId=${options.organizationId ? 'yes' : 'no'}`,
        );
        if (result.success && options.loadId && options.organizationId) {
          const isLastStop = options.stopSequence === options.totalStops;

          if (isLastStop) {
            // Session mode: detach load (keep tracking running for the rest
            // of the shift). Legacy mode: stop tracking entirely.
            console.log('[CheckOut] Last stop - releasing load from tracking');
            const trackingResult = await releaseLoadFromTrackingOnLastStop();

            posthog.capture('location_tracking_stopped', {
              loadId: options.loadId ?? null,
              stopId: options.stopId,
              mode: trackingResult.mode,
              success: trackingResult.success,
            });
          } else {
            console.log(
              `[CheckOut] Stop ${options.stopSequence} checkout - re-attaching load to tracking`,
            );
            const trackingResult = await attachLoadToTrackingForCheckIn({
              driverId: options.driverId,
              loadId: options.loadId,
              organizationId: options.organizationId,
            });

            if (trackingResult.action === 'handoff') {
              posthog.capture('location_tracking_handed_off', {
                fromLoadId: trackingResult.previousLoadId ?? null,
                toLoadId: options.loadId,
                stopId: options.stopId,
                trigger: 'check_out_late_start',
                mode: trackingResult.mode,
                success: trackingResult.success,
                message: trackingResult.message,
              });
            } else if (
              trackingResult.action === 'started' ||
              trackingResult.action === 'attached'
            ) {
              posthog.capture('location_tracking_started', {
                loadId: options.loadId ?? null,
                stopId: options.stopId,
                trigger: 'check_out_late_start',
                mode: trackingResult.mode,
                action: trackingResult.action,
                success: trackingResult.success,
                message: trackingResult.message,
              });
            }

            if (!trackingResult.success) {
              console.warn('[CheckOut] Tracking attach failed:', trackingResult.message);
              trackingFailed = true;
              trackingMessage = trackingResult.message;
            }
          }
        }

        return { ...result, trackingFailed, trackingMessage };
      } catch (onlineError) {
        // Mutation timed out or failed -- queue it (photo already uploaded or will be re-uploaded from queue)
        await enqueueMutation(
          'checkOut',
          { ...baseMutationArgs, podPhotoUrl },
          { photoUri: !podPhotoUrl ? options.photoUri : undefined },
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
        errorStack: error instanceof Error ? (error.stack ?? null) : null,
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
