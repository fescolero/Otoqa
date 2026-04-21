/**
 * useUploadDocument — driver-side hook for the unified loadDocuments
 * backend (PR #58). Orchestrates the full capture → upload → record flow
 * for every non-POD-on-checkout document kind (POD / Receipt / Cargo /
 * Damage / Accident / Other).
 *
 * Flow (online, good connection):
 *   1. Caller provides a photoUri (already captured by ImagePicker).
 *   2. Hook reads current GPS via the passed-in getFreshLocation (shared
 *      with check-in, so the warm-up cost is amortized).
 *   3. Fetches a presigned R2 URL via s3Upload.getLoadDocumentUploadUrl.
 *   4. PUTs the photo with the shared s3-upload helper.
 *   5. Calls driverMobile.uploadLoadDocument with externalUrl + GPS +
 *      capturedAt. The server infers the stop/context from the check-in
 *      window active at capturedAt.
 *
 * Flow (poor signal / offline / mutation timeout):
 *   - Queue a `uploadLoadDocument` entry with the local photoUri. The
 *     offline queue's processor (wired in app/_layout.tsx) replays the
 *     full chain — S3 URL + PUT + mutation — once connectivity returns.
 *
 * GPS missing (permission denied, timed out): the upload still proceeds;
 * the server records `inferredContext: UNKNOWN` and ops can cross-check
 * manually. Better to lose precise location than to block the driver.
 */
import { useAction, useMutation } from 'convex/react';
import { usePostHog } from 'posthog-react-native';
import * as Location from 'expo-location';
import { api } from '../../../convex/_generated/api';
import type { Id } from '../../../convex/_generated/dataModel';
import { uploadPODPhoto } from '../s3-upload';
import { enqueueMutation } from '../offline-queue';
import { useNetworkStatus } from './useNetworkStatus';

export type DriverDocumentType =
  | 'POD'
  | 'Receipt'
  | 'Cargo'
  | 'Damage'
  | 'Accident'
  | 'Other';

type LocationGetter = () => Promise<{ latitude: number; longitude: number }>;

interface UploadOptions {
  loadId: Id<'loadInformation'>;
  driverId: Id<'drivers'>;
  type: DriverDocumentType;
  photoUri: string;
  note?: string;
  // Only meaningful when type === 'Accident'. The "what happened" chip
  // is passed through to R2 as the `accident-kind` metadata field so
  // ops can filter the bucket on incident type. Free-text description
  // still goes in `note` (which lives on the Convex row, not in
  // metadata — S3 per-object metadata is capped at 2KB total).
  accidentKind?: string;
}

interface UploadResult {
  success: boolean;
  queued?: boolean;
  message: string;
  inferredContext?: string;
  inferredStopSequence?: number | null;
}

const MUTATION_TIMEOUT_MS = 10_000;

function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  return Promise.race([
    promise,
    new Promise<never>((_, reject) =>
      setTimeout(() => reject(new Error('Request timed out')), ms),
    ),
  ]);
}

export function useUploadDocument(getFreshLocation?: LocationGetter) {
  const getUploadUrl = useAction(api.s3Upload.getLoadDocumentUploadUrl);
  const uploadMutation = useMutation(api.driverMobile.uploadLoadDocument);
  const { connectionQuality } = useNetworkStatus();
  const posthog = usePostHog();

  // Fallback getter — mirrors useCheckIn's pattern. Swallows permission
  // denial so a denied driver can still upload (just without GPS).
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

  const getLocation = getFreshLocation ?? fallbackGetLocation;

  const safelyReadLocation = async () => {
    try {
      return await getLocation();
    } catch {
      return null; // GPS missing → server lands the row as UNKNOWN.
    }
  };

  const uploadDocument = async (opts: UploadOptions): Promise<UploadResult> => {
    const capturedAt = Date.now();
    const shouldQueue = connectionQuality !== 'good';

    posthog?.capture('doc_upload_started', {
      loadId: opts.loadId,
      docType: opts.type,
      connectionQuality,
      hasNote: !!opts.note,
    });

    // Offline / poor: queue immediately with the raw photoUri. The
    // processor in _layout.tsx replays getUploadUrl → PUT → mutation.
    if (shouldQueue) {
      const location = await safelyReadLocation();
      await enqueueMutation(
        'uploadLoadDocument',
        {
          loadId: opts.loadId,
          driverId: opts.driverId,
          type: opts.type,
          capturedAt,
          capturedLat: location?.latitude,
          capturedLng: location?.longitude,
          note: opts.note,
          accidentKind: opts.accidentKind,
        },
        { photoUri: opts.photoUri },
      );
      posthog?.capture('doc_upload_queued', {
        loadId: opts.loadId,
        docType: opts.type,
      });
      return {
        success: true,
        queued: true,
        message:
          connectionQuality === 'offline'
            ? 'Saved offline — will upload when connected'
            : 'Weak signal — upload queued',
      };
    }

    // Online path — try everything inline, fall back to queue on timeout.
    try {
      const location = await safelyReadLocation();

      const { uploadUrl, fileUrl, metadataHeaders } = await getUploadUrl({
        loadId: String(opts.loadId),
        type: opts.type,
        filename: `${opts.type.toLowerCase()}_${capturedAt}.jpg`,
        // Pass everything we know to the action so it gets baked into
        // the R2 object as x-amz-meta-* — ops can search the bucket
        // without needing Convex for any of this.
        driverId: String(opts.driverId),
        capturedAt,
        capturedLat: location?.latitude,
        capturedLng: location?.longitude,
        accidentKind: opts.accidentKind,
      });

      const putResult = await uploadPODPhoto(uploadUrl, opts.photoUri, 3, metadataHeaders);
      if (!putResult.success) {
        throw new Error(putResult.error ?? 'Upload failed');
      }

      const mutationResult = await withTimeout(
        uploadMutation({
          loadId: opts.loadId,
          driverId: opts.driverId,
          type: opts.type,
          externalUrl: fileUrl,
          capturedAt,
          capturedLat: location?.latitude,
          capturedLng: location?.longitude,
          note: opts.note,
        }),
        MUTATION_TIMEOUT_MS,
      );

      posthog?.capture('doc_upload_success', {
        loadId: opts.loadId,
        docType: opts.type,
        inferredContext: mutationResult.inferredContext,
        hadGps: !!location,
      });

      return {
        success: true,
        message: 'Uploaded',
        inferredContext: mutationResult.inferredContext,
        inferredStopSequence: mutationResult.inferredStopSequence,
      };
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Upload failed';
      posthog?.capture('doc_upload_failed', {
        loadId: opts.loadId,
        docType: opts.type,
        error: message,
      });

      // Best-effort fallback — queue it so the driver isn't blocked.
      try {
        const location = await safelyReadLocation();
        await enqueueMutation(
          'uploadLoadDocument',
          {
            loadId: opts.loadId,
            driverId: opts.driverId,
            type: opts.type,
            capturedAt,
            capturedLat: location?.latitude,
            capturedLng: location?.longitude,
            note: opts.note,
          },
          { photoUri: opts.photoUri },
        );
        return {
          success: true,
          queued: true,
          message: 'Connection slow — upload queued',
        };
      } catch {
        return { success: false, message };
      }
    }
  };

  return {
    uploadDocument,
    isOffline: connectionQuality !== 'good',
  };
}
