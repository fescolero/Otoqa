import { useMutation, useAction } from 'convex/react';
import { api } from '../../../convex/_generated/api';
import { Id } from '../../../convex/_generated/dataModel';
import { enqueueMutation } from '../offline-queue';
import { uploadPODPhoto } from '../s3-upload';
import { startLocationTracking, stopLocationTracking } from '../location-tracking';
import * as Location from 'expo-location';
import { useNetworkStatus } from './useNetworkStatus';
import { usePostHog } from 'posthog-react-native';

// ============================================
// HOOK: CHECK-IN/OUT AT STOPS
// Handles both online and offline scenarios
// Integrates with location tracking for route recording
// ============================================

interface CheckInOptions {
  stopId: Id<'loadStops'>;
  driverId: Id<'drivers'>;
  loadId?: Id<'loadInformation'>;
  notes?: string;
  photoUri?: string;
  // For location tracking - determines when to start/stop
  stopSequence?: number; // Current stop's sequence number (1-based)
  totalStops?: number; // Total number of stops in the load
  organizationId?: string; // Required for location tracking
}

interface CheckInResult {
  success: boolean;
  message: string;
  queued?: boolean;
}

export function useCheckIn() {
  const checkInMutation = useMutation(api.driverMobile.checkInAtStop);
  const checkOutMutation = useMutation(api.driverMobile.checkOutFromStop);
  const getUploadUrl = useAction(api.s3Upload.getPODUploadUrl);
  const { isConnected } = useNetworkStatus();
  const posthog = usePostHog();
  
  // Be conservative: if network status is unknown (null), treat as offline
  const shouldQueue = isConnected !== true;

  // Get current location
  const getCurrentLocation = async () => {
    const { status } = await Location.requestForegroundPermissionsAsync();
    if (status !== 'granted') {
      throw new Error('Location permission not granted');
    }

    const location = await Location.getCurrentPositionAsync({
      accuracy: Location.Accuracy.High,
    });

    return {
      latitude: location.coords.latitude,
      longitude: location.coords.longitude,
    };
  };

  // Check in at a stop
  const checkIn = async (options: CheckInOptions): Promise<CheckInResult> => {
    try {
      const location = await getCurrentLocation();
      const driverTimestamp = new Date().toISOString();

      if (shouldQueue) {
        // Queue for later (offline or network status unknown)
        await enqueueMutation('checkIn', {
          stopId: options.stopId,
          driverId: options.driverId,
          latitude: location.latitude,
          longitude: location.longitude,
          driverTimestamp,
          notes: options.notes,
        });

        return {
          success: true,
          message: shouldQueue && isConnected === null ? 'Check-in queued (checking network...)' : 'Check-in queued for sync',
          queued: true,
        };
      }

      // Online - call mutation directly
      const result = await checkInMutation({
        stopId: options.stopId,
        driverId: options.driverId,
        latitude: location.latitude,
        longitude: location.longitude,
        driverTimestamp,
        notes: options.notes,
      });

      return result;
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

  // Check out from a stop
  const checkOut = async (options: CheckInOptions): Promise<CheckInResult> => {
    try {
      const location = await getCurrentLocation();
      const driverTimestamp = new Date().toISOString();

      if (shouldQueue) {
        // Queue for later (with photo if provided)
        await enqueueMutation(
          'checkOut',
          {
            stopId: options.stopId,
            driverId: options.driverId,
            latitude: location.latitude,
            longitude: location.longitude,
            driverTimestamp,
            notes: options.notes,
          },
          { photoUri: options.photoUri }
        );

        return {
          success: true,
          message: 'Check-out queued for sync',
          queued: true,
        };
      }

      // Online - upload photo first if provided
      let podPhotoUrl: string | undefined;
      
      if (options.photoUri) {
        try {
          console.log('[CheckOut] Photo URI:', options.photoUri);
          console.log('[CheckOut] Getting presigned URL from Convex...');
          
          // Get presigned URL from Convex
          const { uploadUrl, fileUrl } = await getUploadUrl({
            loadId: options.loadId ? String(options.loadId) : 'unknown',
            stopId: String(options.stopId),
            filename: `pod_${Date.now()}.jpg`,
          });

          console.log('[CheckOut] Got presigned URL, uploading to R2...');
          console.log('[CheckOut] Upload URL (first 100 chars):', uploadUrl.substring(0, 100));

          // Upload to S3/R2
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
            // Continue with check-out even if photo upload fails
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
          // Continue with check-out even if photo upload fails
        }
      }

      // Call check-out mutation with photo URL
      const result = await checkOutMutation({
        stopId: options.stopId,
        driverId: options.driverId,
        latitude: location.latitude,
        longitude: location.longitude,
        driverTimestamp,
        notes: options.notes,
        podPhotoUrl,
      });

      // Handle location tracking based on stop position
      if (result.success && options.stopSequence && options.totalStops && options.loadId && options.organizationId) {
        const isFirstStop = options.stopSequence === 1;
        const isLastStop = options.stopSequence === options.totalStops;

        if (isFirstStop) {
          // START tracking after checking out of first stop (pickup complete, starting route)
          console.log('[CheckOut] First stop - starting location tracking');
          const trackingResult = await startLocationTracking({
            driverId: options.driverId,
            loadId: options.loadId,
            organizationId: options.organizationId,
          });
          
          posthog.capture('location_tracking_started', {
            loadId: options.loadId ?? null,
            stopId: options.stopId,
            success: trackingResult.success,
            message: trackingResult.message,
          });

          if (!trackingResult.success) {
            console.warn('[CheckOut] Location tracking failed to start:', trackingResult.message);
            // Don't fail the checkout - tracking is supplementary
          }
        } else if (isLastStop) {
          // STOP tracking after checking out of last stop (delivery complete)
          console.log('[CheckOut] Last stop - stopping location tracking');
          const trackingResult = await stopLocationTracking();
          
          posthog.capture('location_tracking_stopped', {
            loadId: options.loadId ?? null,
            stopId: options.stopId,
            success: trackingResult.success,
          });
        }
        // Middle stops: tracking continues automatically
      }

      return result;
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
