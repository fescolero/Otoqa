import { useState, useEffect, useCallback, useMemo, useRef } from 'react';
import {
  View,
  Text,
  ScrollView,
  Pressable,
  StyleSheet,
  Alert,
  Linking,
  Modal,
  TextInput,
  ActivityIndicator,
  KeyboardAvoidingView,
  Platform,
  Image,
  Keyboard,
  TouchableWithoutFeedback,
  Switch,
  Animated,
  PanResponder,
} from 'react-native';
import { useLocalSearchParams, useRouter, Stack } from 'expo-router';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { Ionicons } from '@expo/vector-icons';
import * as ImagePicker from 'expo-image-picker';
import { useLoadDetail } from '../../../lib/hooks/useLoadDetail';
import { useCheckIn } from '../../../lib/hooks/useCheckIn';
import { useGPSLocation } from '../../../lib/hooks/useGPSLocation';
import { useUploadDocument } from '../../../lib/hooks/useUploadDocument';
import { enqueueMutation } from '../../../lib/offline-queue';
import { useDriver } from '../_layout';
import { useNetworkStatus } from '../../../lib/hooks/useNetworkStatus';
import { useOfflineQueue } from '../../../lib/hooks/useOfflineQueue';
import { Id } from '../../../../convex/_generated/dataModel';
import { usePostHog } from 'posthog-react-native';
import {
  type PendingActionsMap,
  loadPendingActions,
  addPendingAction,
  reconcilePendingActions,
} from '../../../lib/pending-actions';
import {
  getTrackingState,
  getBufferedLocationCount,
  isTracking,
  startLocationTracking,
} from '../../../lib/location-tracking';
import { getUnsyncedCountForLoad } from '../../../lib/location-storage';
import { useMutation, useQuery } from 'convex/react';
import { api } from '../../../../convex/_generated/api';
import { AppState } from 'react-native';
// Design system — used for the redesigned top chrome (header, summary card,
// quick actions). The stops list + modals below keep the legacy palette
// for now; they'll migrate in a later pass.
import { Icon } from '../../../lib/design-icons';
import { useTheme } from '../../../lib/ThemeContext';
import {
  typeScale,
  radii as designRadii,
} from '../../../lib/design-tokens';
import {
  loadFacetTags,
  tagKindStyles,
} from '../../../lib/facet-tags';

// ============================================
// DESIGN SYSTEM
// ============================================
const colors = {
  background: '#1a1d21',
  foreground: '#f3f4f6',
  foregroundMuted: '#9ca3af',
  primary: '#ff6b00',
  primaryForeground: '#1a1d21',
  secondary: '#eab308',
  muted: '#2d323b',
  card: '#22262b',
  cardForeground: '#f3f4f6',
  border: '#3f4552',
  destructive: '#ef4444',
  success: '#10b981',
};

const spacing = {
  'xs': 4,
  'sm': 8,
  'md': 12,
  'lg': 16,
  'xl': 20,
  '2xl': 24,
};

const borderRadius = {
  'md': 8,
  'lg': 12,
  'xl': 16,
  '2xl': 20,
  '3xl': 24,
  'full': 9999,
};

// ============================================
// TRIP DETAIL SCREEN
// ============================================
export default function TripDetailScreen() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const router = useRouter();
  const insets = useSafeAreaInsets();
  const { driverId, organizationId } = useDriver();
  const { palette } = useTheme();
  const { connectionQuality } = useNetworkStatus();
  const { isWarming: isGPSWarming, getFreshLocation } = useGPSLocation();
  const { checkIn, checkOut } = useCheckIn(getFreshLocation);
  const { uploadDocument } = useUploadDocument(getFreshLocation);
  const { pendingCount } = useOfflineQueue();
  const posthog = usePostHog();

  const { load, stops, isLoading, hasNoData } = useLoadDetail(id as Id<'loadInformation'>, driverId);

  // Check-in modal state
  const [checkInModal, setCheckInModal] = useState<{
    visible: boolean;
    stopId: Id<'loadStops'> | null;
    type: 'in' | 'out';
  }>({ visible: false, stopId: null, type: 'in' });
  const [notes, setNotes] = useState('');
  const [photoUri, setPhotoUri] = useState<string | null>(null);
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [isRedirected, setIsRedirected] = useState(false);
  const [showDetourModal, setShowDetourModal] = useState(false);
  const [showAccidentSheet, setShowAccidentSheet] = useState(false);
  const [showDocumentsSheet, setShowDocumentsSheet] = useState(false);
  const [accidentKind, setAccidentKind] = useState<string>('Collision');
  const [accidentNote, setAccidentNote] = useState('');
  const [detourStops, setDetourStops] = useState(1);
  const [detourReason, setDetourReason] = useState<
    'FUEL' | 'REST' | 'FOOD' | 'SCALE' | 'REPAIR' | 'REDIRECT' | 'CUSTOMER' | 'OTHER'
  >('FUEL');
  const [detourNotes, setDetourNotes] = useState('');
  const [isAddingDetour, setIsAddingDetour] = useState(false);
  const addDetourStopsMutation = useMutation(api.driverMobile.addDetourStops);

  // Optimistic pending actions (persisted across restarts)
  const [pendingActions, setPendingActions] = useState<PendingActionsMap>({});

  // GPS tracking debug info
  const [trackingDebug, setTrackingDebug] = useState<{
    isActive: boolean;
    pendingPoints: number;
    loadId: string | null;
  } | null>(null);

  // Track whether we should retry starting tracking on foreground return
  // (e.g., after the driver grants "Always" permission in Settings)
  const pendingTrackingRetry = useRef(false);

  // Recent doc uploads — drives the "JUST UPLOADED" list inside the
  // Documents sheet so the driver has tactile feedback that the capture
  // landed. Cleared when the sheet is dismissed.
  const [recentUploads, setRecentUploads] = useState<
    Array<{ type: DocKind; status: 'uploading' | 'uploaded' | 'queued' | 'failed' }>
  >([]);

  // Accident sheet: optional photo that becomes an Accident-typed
  // document. Kept separate from the legacy POD `photoUri` state so
  // they don't collide.
  const [accidentPhotoUri, setAccidentPhotoUri] = useState<string | null>(null);
  // Gates the Report button + disables re-submit while the upload is in
  // flight. Reset in both the success path and every failure branch.
  const [isReportingAccident, setIsReportingAccident] = useState(false);

  // Persistent load-documents list. Only fetched while the Documents
  // sheet is open — avoids a second reactive subscription on every trip
  // mount when the driver hasn't opened it yet. The sheet renders a
  // chronological "On this load" section from this data; the ephemeral
  // `recentUploads` state above is just for sub-second tap feedback
  // until the server query catches up.
  const loadDocuments = useQuery(
    api.driverMobile.getLoadDocuments,
    showDocumentsSheet && driverId && id
      ? { loadId: id as Id<'loadInformation'>, driverId }
      : 'skip',
  );

  useEffect(() => {
    if (!id) return;
    let cancelled = false;
    const refresh = async () => {
      try {
        const state = await getTrackingState();
        const pending = await getUnsyncedCountForLoad(id);
        if (!cancelled) {
          setTrackingDebug({
            isActive: state?.isActive ?? false,
            pendingPoints: pending,
            loadId: state?.loadId ?? null,
          });
        }
      } catch {
        /* ignore */
      }
    };
    refresh();
    const interval = setInterval(refresh, 10000);
    return () => {
      cancelled = true;
      clearInterval(interval);
    };
  }, [id]);

  // When the app returns from Settings, retry starting tracking if it
  // previously failed due to missing permissions.
  useEffect(() => {
    if (!id || !driverId || !organizationId) return;
    const sub = AppState.addEventListener('change', async (nextState) => {
      if (nextState === 'active' && pendingTrackingRetry.current) {
        pendingTrackingRetry.current = false;
        const alreadyTracking = await isTracking();
        if (alreadyTracking) return;
        console.log('[TripDetail] Retrying tracking start after Settings return');
        const result = await startLocationTracking({
          driverId: driverId as Id<'drivers'>,
          loadId: id as Id<'loadInformation'>,
          organizationId,
        });
        if (result.success) {
          Alert.alert('GPS Tracking Active', 'Route tracking has started successfully.');
        } else {
          Alert.alert('GPS Tracking Failed', result.message);
        }
      }
    });
    return () => sub.remove();
  }, [id, driverId, organizationId]);

  // Load persisted pending actions on mount
  useEffect(() => {
    if (!id) return;
    loadPendingActions(id).then(setPendingActions);
  }, [id]);

  // Reconcile pending actions when server data arrives
  useEffect(() => {
    if (!id || stops.length === 0) return;
    reconcilePendingActions(id, stops).then(setPendingActions);
  }, [id, stops]);

  // Merge pending actions into stops for display
  const displayStops = useMemo(() => {
    return stops.map((stop: any) => {
      const pending = pendingActions[stop._id];
      if (!pending) return stop;
      return {
        ...stop,
        checkedInAt: pending.type === 'in' ? pending.timestamp : stop.checkedInAt,
        checkedOutAt: pending.type === 'out' ? pending.timestamp : stop.checkedOutAt,
        pendingSync: true,
      };
    });
  }, [stops, pendingActions]);

  // Record a pending action (optimistic + persisted)
  const recordPendingAction = useCallback(
    async (stopId: string, type: 'in' | 'out') => {
      if (!id) return;
      const now = new Date().toISOString();
      const action = { type, timestamp: now, driverTimestamp: now };
      setPendingActions((prev) => ({ ...prev, [stopId]: action }));
      await addPendingAction(id, stopId, action);
    },
    [id],
  );

  // Open the driver's default maps app natively (not a browser tab). On iOS
  // the `http://maps.apple.com/` URL is intercepted by the system and opens
  // Apple Maps directly; on Android the `geo:` intent hands off to whichever
  // maps app the user has configured (Google Maps, Waze, etc.).
  const openMaps = async (address: string, city?: string, state?: string) => {
    const query = [address, city, state].filter(Boolean).join(', ');
    const encoded = encodeURIComponent(query);
    const url = Platform.select({
      ios: `http://maps.apple.com/?q=${encoded}`,
      android: `geo:0,0?q=${encoded}`,
      default: `https://www.google.com/maps/search/?api=1&query=${encoded}`,
    })!;
    try {
      await Linking.openURL(url);
    } catch {
      // Some Android devices have no geo: handler. Fall back to Google Maps
      // web which every browser resolves.
      await Linking.openURL(
        `https://www.google.com/maps/search/?api=1&query=${encoded}`,
      );
    }
  };

  // Run a check-in or check-out directly — no modal. The mutation only
  // needs (stopId, driverId, loadId); notes / photo / isRedirected are all
  // optional and captured via Documents flow when needed, not inline.
  const runCheckAction = async (
    stopId: Id<'loadStops'>,
    type: 'in' | 'out',
  ) => {
    if (!driverId) return;
    if (isSubmitting) return;

    setIsSubmitting(true);
    const actionType = type === 'in' ? 'check_in' : 'check_out';
    const resolvedStopId =
      type === 'out' ? (activeCheckedInStop?._id ?? stopId) : stopId;
    const currentStop = displayStops.find((s: any) => s._id === resolvedStopId);
    const totalStops = displayStops.filter((s: any) => s.stopType !== 'DETOUR').length;

    posthog?.capture(`${actionType}_started`, {
      loadId: id,
      stopId: resolvedStopId,
      inline: true,
    });

    try {
      const result =
        type === 'in'
          ? await checkIn({
              stopId: resolvedStopId,
              driverId,
              loadId: id as Id<'loadInformation'>,
              stopSequence: currentStop?.sequenceNumber,
              totalStops,
              organizationId: organizationId || undefined,
            })
          : await checkOut({
              stopId: resolvedStopId,
              driverId,
              loadId: id as Id<'loadInformation'>,
              stopSequence: currentStop?.sequenceNumber,
              totalStops,
              organizationId: organizationId || undefined,
            });

      posthog?.capture(`${actionType}_result`, {
        loadId: id,
        stopId: resolvedStopId || null,
        success: result.success,
        queued: result.queued ?? false,
      });

      if (result.success) {
        await recordPendingAction(resolvedStopId as string, type);

        if (result.trackingFailed) {
          setTimeout(() => {
            Alert.alert(
              'Location Permission Required',
              'Route tracking could not start. Please enable "Always" location access in Settings so we can record your delivery route.',
              [
                { text: 'Not Now', style: 'cancel' },
                {
                  text: 'Open Settings',
                  onPress: () => {
                    pendingTrackingRetry.current = true;
                    Linking.openSettings();
                  },
                },
              ],
            );
          }, 400);
        } else if (result.queued) {
          // Surface offline-queue feedback only; success is silent.
          Alert.alert('Queued', result.message);
        }
      } else {
        Alert.alert(
          type === 'in' ? "Couldn't check in" : "Couldn't check out",
          result.message || 'Try again, or reach dispatch if this keeps happening.',
        );
      }
    } catch (error: any) {
      const msg = error?.message || 'Unexpected error';
      posthog?.capture(`${actionType}_exception`, {
        loadId: id,
        stopId: resolvedStopId || null,
        error: msg,
      });
      Alert.alert(
        type === 'in' ? "Couldn't check in" : "Couldn't check out",
        `${msg}\n\nIf this keeps happening, reach out to dispatch.`,
      );
    } finally {
      setIsSubmitting(false);
      posthog?.flush();
    }
  };

  const handleCheckIn = (stopId: Id<'loadStops'>) => runCheckAction(stopId, 'in');
  const handleCheckOut = (stopId: Id<'loadStops'>) => runCheckAction(stopId, 'out');

  // Launch native system camera — no custom screen, no touch issues
  const launchCamera = async () => {
    const { status } = await ImagePicker.requestCameraPermissionsAsync();
    if (status !== 'granted') {
      Alert.alert('Permission Required', 'Camera access is needed to capture proof of delivery photos.');
      return;
    }

    posthog?.capture('capture_photo_opened', { loadId: id, stopId: checkInModal.stopId || null });

    const result = await ImagePicker.launchCameraAsync({
      mediaTypes: ['images'],
      quality: 0.8,
      allowsEditing: false,
    });

    if (!result.canceled && result.assets?.[0]?.uri) {
      setPhotoUri(result.assets[0].uri);
      posthog?.capture('capture_photo_taken', { loadId: id, success: true });
    }
  };

  // DocumentsSheet tile handler — one flow per kind:
  //   1. Request camera permission.
  //   2. Capture a single photo (cancel-safe).
  //   3. Fire an optimistic "uploading" row in the sheet list.
  //   4. uploadDocument() handles the presign → PUT → mutation chain
  //      (or queues on poor signal). Update the row with the outcome.
  // Unlike the legacy POD path, the upload does NOT wait for a checkout
  // — the doc is written immediately with its own GPS + capturedAt.
  const handlePickDocKind = async (kind: DocKind) => {
    if (!driverId || !id) return;

    const { status } = await ImagePicker.requestCameraPermissionsAsync();
    if (status !== 'granted') {
      Alert.alert('Permission Required', 'Camera access is needed to capture documents.');
      return;
    }

    const cameraResult = await ImagePicker.launchCameraAsync({
      mediaTypes: ['images'],
      quality: 0.8,
      allowsEditing: false,
    });
    if (cameraResult.canceled || !cameraResult.assets?.[0]?.uri) return;

    const capturedUri = cameraResult.assets[0].uri;
    setRecentUploads((prev) => [{ type: kind, status: 'uploading' }, ...prev]);

    try {
      const result = await uploadDocument({
        loadId: id as Id<'loadInformation'>,
        driverId,
        type: kind,
        photoUri: capturedUri,
      });
      setRecentUploads((prev) => {
        // Find the most recent `uploading` entry for this kind and
        // update it — not a nice-to-have, this avoids ghost rows if the
        // driver hammers the tile before a previous one resolves.
        const idx = prev.findIndex((r) => r.type === kind && r.status === 'uploading');
        if (idx < 0) return prev;
        const next = [...prev];
        next[idx] = {
          type: kind,
          status: result.queued ? 'queued' : result.success ? 'uploaded' : 'failed',
        };
        return next;
      });
    } catch {
      setRecentUploads((prev) => {
        const idx = prev.findIndex((r) => r.type === kind && r.status === 'uploading');
        if (idx < 0) return prev;
        const next = [...prev];
        next[idx] = { type: kind, status: 'failed' };
        return next;
      });
    }
  };

  // AccidentSheet's optional photo affordance. We keep the uri in a
  // separate slot (accidentPhotoUri) so it doesn't fight the legacy POD
  // photoUri used by the check-out flow.
  const captureAccidentPhoto = async () => {
    const { status } = await ImagePicker.requestCameraPermissionsAsync();
    if (status !== 'granted') {
      Alert.alert('Permission Required', 'Camera access is needed to attach a photo.');
      return;
    }
    const cameraResult = await ImagePicker.launchCameraAsync({
      mediaTypes: ['images'],
      quality: 0.8,
      allowsEditing: false,
    });
    if (!cameraResult.canceled && cameraResult.assets?.[0]?.uri) {
      setAccidentPhotoUri(cameraResult.assets[0].uri);
    }
  };

  // Submit check-in/out
  const submitCheckIn = async () => {
    if (!checkInModal.stopId || !driverId) return;

    setIsSubmitting(true);
    const actionType = checkInModal.type === 'in' ? 'check_in' : 'check_out';

    posthog?.capture(`${actionType}_started`, {
      loadId: id,
      stopId: checkInModal.stopId,
      hasPhoto: !!photoUri,
      hasNotes: !!notes,
    });

    try {
      const resolvedStopId =
        checkInModal.type === 'out' ? (activeCheckedInStop?._id ?? checkInModal.stopId) : checkInModal.stopId;
      const currentStop = displayStops.find((s: any) => s._id === resolvedStopId);
      // Exclude DETOUR stops from the count — they don't gate load/tracking completion.
      const totalStops = displayStops.filter((s: any) => s.stopType !== 'DETOUR').length;

      if (checkInModal.type === 'out' && activeCheckedInStop && activeCheckedInStop._id !== checkInModal.stopId) {
        console.warn(
          `[TripDetail] check_out modal stopId=${checkInModal.stopId} is stale, redirecting to active checked-in stopId=${activeCheckedInStop._id}`,
        );
        posthog?.capture('checkout_stop_corrected', {
          loadId: id,
          requestedStopId: checkInModal.stopId,
          resolvedStopId,
        });
      }

      console.log(
        `[TripDetail] ${actionType}: stopId=${resolvedStopId}, seq=${currentStop?.sequenceNumber}, total=${totalStops}, driverId=${driverId ? 'yes' : 'NULL'}, orgId=${organizationId ? organizationId.substring(0, 12) + '...' : 'NULL'}`,
      );
      posthog?.capture('tracking_params_debug', {
        loadId: id,
        stopId: resolvedStopId,
        action: actionType,
        stopSequence: currentStop?.sequenceNumber ?? null,
        totalStops,
        hasDriverId: !!driverId,
        hasOrgId: !!organizationId,
        orgId: organizationId ?? null,
      });

      const result =
        checkInModal.type === 'in'
          ? await checkIn({
              stopId: resolvedStopId,
              driverId,
              loadId: id as Id<'loadInformation'>,
              notes: notes || undefined,
              stopSequence: currentStop?.sequenceNumber,
              totalStops,
              organizationId: organizationId || undefined,
              ...(isRedirected ? { isRedirected: true } : {}),
            })
          : await checkOut({
              stopId: resolvedStopId,
              driverId,
              loadId: id as Id<'loadInformation'>,
              notes: notes || undefined,
              photoUri: photoUri || undefined,
              // Location tracking parameters
              stopSequence: currentStop?.sequenceNumber,
              totalStops,
              organizationId: organizationId || undefined,
            });

      posthog?.capture(`${actionType}_result`, {
        loadId: id,
        stopId: resolvedStopId || null,
        success: result.success,
        queued: result.queued ?? false,
        message: result.message,
      });

      if (result.success) {
        // Optimistic UI update -- immediately reflect in stop state
        await recordPendingAction(resolvedStopId as string, checkInModal.type);

        if (result.trackingFailed) {
          closeModal();
          setTimeout(() => {
            Alert.alert(
              'Location Permission Required',
              'Route tracking could not start. Please enable "Always" location access in Settings so we can record your delivery route.',
              [
                { text: 'Not Now', style: 'cancel' },
                {
                  text: 'Open Settings',
                  onPress: () => {
                    pendingTrackingRetry.current = true;
                    Linking.openSettings();
                  },
                },
              ],
            );
          }, 500);
        } else {
          Alert.alert(result.queued ? 'Queued' : 'Success', result.message);
          closeModal();
        }
      } else {
        Alert.alert(
          checkInModal.type === 'in' ? "Couldn't check in" : "Couldn't check out",
          result.message || 'Try again, or reach dispatch if this keeps happening.',
        );
      }
    } catch (error: any) {
      const errorMessage = error?.message || 'Unexpected error';
      posthog?.capture(`${actionType}_exception`, {
        loadId: id,
        stopId: checkInModal.type === 'out' ? (activeCheckedInStop?._id ?? checkInModal.stopId) : checkInModal.stopId,
        error: errorMessage,
        stack: error?.stack,
      });
      Alert.alert(
        checkInModal.type === 'in' ? "Couldn't check in" : "Couldn't check out",
        `${errorMessage}\n\nIf this keeps happening, reach out to dispatch.`,
      );
    } finally {
      setIsSubmitting(false);
      posthog?.flush();
    }
  };

  // Close modal and reset state
  const closeModal = () => {
    setCheckInModal({ visible: false, stopId: null, type: 'in' });
    setNotes('');
    setPhotoUri(null);
    setIsRedirected(false);
  };

  // Format date and time together.
  //
  // dateStr is a date-only string like "2026-04-20". If we feed that straight
  // into new Date() it parses as UTC midnight — which in negative-offset
  // zones (Pacific is UTC-7/-8) renders as the PRIOR day when passed through
  // toLocaleDateString. Anchor it to local midnight instead so the label
  // reads the day a driver actually thinks of it as.
  //
  // timeStr is a full ISO 8601 timestamp with TZ offset (schema comment
  // confirms this), so new Date() already produces the correct instant.
  const parseDateOnlyLocal = (ds: string): Date | null => {
    const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(ds);
    if (!m) {
      const fallback = new Date(ds);
      return isNaN(fallback.getTime()) ? null : fallback;
    }
    const [, y, mo, d] = m;
    return new Date(Number(y), Number(mo) - 1, Number(d));
  };

  const formatDateTime = (dateStr?: string, timeStr?: string) => {
    if (!dateStr && !timeStr) return null;
    try {
      const dateObj = dateStr ? parseDateOnlyLocal(dateStr) : null;
      const timeObj = timeStr ? new Date(timeStr) : null;

      // Format date part (e.g., "Jan 15")
      const datePart =
        dateObj && !isNaN(dateObj.getTime())
          ? dateObj.toLocaleDateString('en-US', { month: 'short', day: 'numeric' })
          : null;

      // Format time part
      const timePart =
        timeObj && !isNaN(timeObj.getTime())
          ? timeObj.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit', hour12: true })
          : null;

      if (datePart && timePart) {
        return `${datePart}, ${timePart}`;
      }
      return datePart || timePart || null;
    } catch {
      return null;
    }
  };

  // Format checked in/out time
  const formatCheckedTime = (timestamp?: number) => {
    if (!timestamp) return null;
    const date = new Date(timestamp);
    return date.toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit' });
  };

  // Get load status display
  const getStatusDisplay = () => {
    if (!load) return { text: 'Unknown', color: colors.muted };

    const status = load.trackingStatus || load.status;
    switch (status) {
      case 'In Transit':
      case 'At Pickup':
      case 'At Delivery':
        return { text: 'Active', color: colors.primary };
      case 'Completed':
        return { text: 'Completed', color: colors.success };
      default:
        return { text: 'Scheduled', color: colors.secondary };
    }
  };

  // Determine which stop is the current active stop (uses displayStops for optimistic state)
  const getCurrentStopIndex = () => {
    for (let i = 0; i < displayStops.length; i++) {
      const stop = displayStops[i];
      if (stop.status !== 'Completed' && !stop.checkedOutAt) {
        return i;
      }
    }
    return -1;
  };

  if (isLoading) {
    return (
      <View style={[styles.loading, { paddingTop: insets.top }]}>
        <ActivityIndicator size="large" color={colors.primary} />
      </View>
    );
  }

  if (hasNoData) {
    return (
      <View style={[styles.error, { paddingTop: insets.top }]}>
        <Ionicons name="cloud-offline" size={64} color={colors.secondary} />
        <Text style={styles.errorText}>Load data unavailable offline</Text>
        <Text style={[styles.errorText, { fontSize: 14, fontWeight: '400', marginTop: 0 }]}>
          Please try again when you have a stronger signal
        </Text>
        <Pressable
          style={styles.backButton}
          onPress={() =>
            router.canGoBack() ? router.back() : router.replace('/(app)')
          }
        >
          <Text style={styles.backButtonText}>Go Back</Text>
        </Pressable>
      </View>
    );
  }

  if (!load) {
    return (
      <View style={[styles.error, { paddingTop: insets.top }]}>
        <Ionicons name="alert-circle" size={64} color={colors.destructive} />
        <Text style={styles.errorText}>Load not found</Text>
        <Pressable
          style={styles.backButton}
          onPress={() =>
            router.canGoBack() ? router.back() : router.replace('/(app)')
          }
        >
          <Text style={styles.backButtonText}>Go Back</Text>
        </Pressable>
      </View>
    );
  }

  const statusDisplay = getStatusDisplay();
  const currentStopIndex = getCurrentStopIndex();
  const activeCheckedInStop = displayStops.find((stop: any) => !!stop.checkedInAt && !stop.checkedOutAt) ?? null;

  return (
    <>
      <Stack.Screen options={{ headerShown: false }} />

      <View style={[styles.container, { paddingTop: insets.top, backgroundColor: palette.bgCanvas }]}>
        {/* Header — edge-to-edge on canvas per design-principles: no border,
            no surface fill. Back, centered title, kebab for quick actions. */}
        <View style={[styles.header, { backgroundColor: palette.bgCanvas, borderBottomWidth: 0 }]}>
          <Pressable
            onPress={() =>
              router.canGoBack() ? router.back() : router.replace('/(app)')
            }
            accessibilityLabel="Back"
            style={({ pressed }) => [
              { width: 44, height: 44, alignItems: 'center', justifyContent: 'center', borderRadius: designRadii.full },
              pressed && { opacity: 0.7 },
            ]}
          >
            <Icon name="arrow-left" size={24} color={palette.textPrimary} />
          </Pressable>
          <Text
            style={{
              ...typeScale.labelLg,
              color: palette.textPrimary,
              fontWeight: '600',
            }}
          >
            Load details
          </Text>
          {/* Kebab menu — exposes the contact dial + maps fallback as an
              explicit action so the dense action bar below doesn't swallow
              them. When we wire Compliance/Payroll screens the shortcuts
              live here too. Disabled until there's something to show. */}
          <Pressable
            onPress={() => {
              const opts: Array<{ label: string; action: () => void }> = [];
              if (load.contactPersonPhone) {
                opts.push({
                  label: `Call ${load.contactPersonName ?? 'contact'}`,
                  action: () => Linking.openURL(`tel:${load.contactPersonPhone}`),
                });
              }
              const nextStop =
                displayStops.find((s) => !s.checkedOutAt) ?? displayStops[0];
              if (nextStop?.address) {
                opts.push({
                  label: 'Open in Maps',
                  action: () => openMaps(nextStop.address, nextStop.city, nextStop.state),
                });
              }
              if (opts.length === 0) {
                Alert.alert('Nothing to show', 'No contact or address on this load.');
                return;
              }
              Alert.alert('Actions', undefined, [
                ...opts.map((o) => ({ text: o.label, onPress: o.action })),
                { text: 'Cancel', style: 'cancel' },
              ]);
            }}
            accessibilityLabel="More actions"
            style={({ pressed }) => [
              { width: 44, height: 44, alignItems: 'center', justifyContent: 'center', borderRadius: designRadii.full },
              pressed && { opacity: 0.7 },
            ]}
          >
            <Icon name="more-h" size={22} color={palette.textPrimary} />
          </Pressable>
        </View>

        <ScrollView
          style={styles.scrollView}
          contentContainerStyle={[styles.scrollContent, { paddingBottom: spacing.md }]}
          showsVerticalScrollIndicator={false}
        >
          {/* Connection Quality Banner */}
          {connectionQuality === 'offline' && (
            <View style={styles.offlineBanner}>
              <Ionicons name="cloud-offline" size={16} color={colors.foreground} />
              <Text style={styles.offlineText}>
                Offline - Changes will sync when connected
                {pendingCount > 0 ? ` (${pendingCount} pending)` : ''}
              </Text>
            </View>
          )}
          {connectionQuality === 'poor' && (
            <View style={styles.weakSignalBanner}>
              <Ionicons name="cellular" size={16} color={colors.background} />
              <Text style={styles.weakSignalText}>
                Weak signal - Actions will be queued
                {pendingCount > 0 ? ` (${pendingCount} pending)` : ''}
              </Text>
            </View>
          )}

          {/* GPS Tracking Debug Banner */}
          {trackingDebug && (
            <View
              style={{
                flexDirection: 'row',
                alignItems: 'center',
                backgroundColor: trackingDebug.isActive ? '#064e3b' : '#1e293b',
                paddingHorizontal: 12,
                paddingVertical: 6,
                borderRadius: 8,
                marginBottom: 8,
                gap: 8,
              }}
            >
              <Ionicons
                name={trackingDebug.isActive ? 'radio' : 'radio-outline'}
                size={14}
                color={trackingDebug.isActive ? '#34d399' : '#94a3b8'}
              />
              <Text
                style={{ color: '#d1d5db', fontSize: 11, fontFamily: Platform.OS === 'ios' ? 'Menlo' : 'monospace' }}
              >
                GPS {trackingDebug.isActive ? 'ON' : 'OFF'} · {trackingDebug.pendingPoints} pending
              </Text>
            </View>
          )}

          {/* Load Summary — design-aligned. Gives the driver the load's
              identity, classification (tags), current status, and a glance-
              able progress bar. Sits above the Route Details card since
              drivers glance at it more often than they tap a stop. */}
          <LoadSummary
            palette={palette}
            load={load}
            displayStops={displayStops}
            activeCheckedInStop={activeCheckedInStop}
            statusDisplay={statusDisplay}
          />

          {/* Route Timeline — design-aligned. Numbered dots per stop, dashed
              ring for detours, single inline action per current stop (check-
              in → check-out → disappears). Address/target time hidden for
              detours per design-principles. */}
          <View
            style={{
              backgroundColor: palette.bgSurface,
              borderWidth: 1,
              borderColor: palette.borderSubtle,
              borderRadius: designRadii.lg,
              paddingVertical: 4,
              marginBottom: 16,
            }}
          >
            <Text
              style={{
                fontSize: 12,
                fontWeight: '700',
                letterSpacing: 0.72,
                color: palette.textTertiary,
                paddingHorizontal: 12,
                paddingTop: 14,
                paddingBottom: 4,
              }}
            >
              ROUTE
            </Text>
            {displayStops.map((stop: any, index: number) => {
              const isDetour = stop.stopType === 'DETOUR';
              const isPickup = stop.stopType === 'PICKUP';
              const isCompleted =
                stop.status === 'Completed' || !!stop.checkedOutAt;
              const isCheckedIn = !!stop.checkedInAt && !stop.checkedOutAt;
              const isCurrent = index === currentStopIndex;
              const isLast = index === displayStops.length - 1;
              const isPendingSync = !!(stop as any).pendingSync;

              // Stable detour numbering: which # detour is this in order.
              const detourNumber = isDetour
                ? displayStops
                    .slice(0, index + 1)
                    .filter((s: any) => s.stopType === 'DETOUR').length
                : null;

              const kindLabel = isDetour
                ? `↔ Detour ${detourNumber ?? ''}`.trim()
                : isPickup
                  ? '↑ Pickup'
                  : '↓ Dropoff';

              const dotBorderColor = isCompleted
                ? palette.success
                : isCurrent
                  ? palette.accent
                  : palette.textTertiary;
              const dotBgColor = isCompleted
                ? palette.success
                : isCurrent
                  ? palette.accent
                  : palette.bgSurface;

              const compactTime = (ts?: number | string | null) => {
                if (!ts) return '';
                const raw = formatCheckedTime(
                  typeof ts === 'string' ? new Date(ts).getTime() : ts,
                );
                if (!raw) return '';
                // "09:38 AM" → "9:38a"
                const m = /^(\d{1,2}):(\d{2})\s*([AP])M?/i.exec(raw);
                if (!m) return raw;
                const [, h, mm, ap] = m;
                return `${parseInt(h, 10)}:${mm}${ap.toLowerCase()}`;
              };

              const windowText = formatDateTime(
                stop.windowBeginDate,
                stop.windowBeginTime,
              );

              return (
                <View
                  key={stop._id}
                  style={{
                    flexDirection: 'row',
                    gap: 14,
                    paddingHorizontal: 12,
                    paddingVertical: 10,
                  }}
                >
                  {/* Timeline rail: numbered dot + connecting line */}
                  <View
                    style={{
                      alignItems: 'center',
                      flexShrink: 0,
                    }}
                  >
                    <View
                      style={{
                        width: 22,
                        height: 22,
                        borderRadius: 11,
                        borderWidth: 2,
                        borderColor: dotBorderColor,
                        borderStyle: isDetour ? 'dashed' : 'solid',
                        backgroundColor: dotBgColor,
                        alignItems: 'center',
                        justifyContent: 'center',
                      }}
                    >
                      {isCompleted ? (
                        <Icon
                          name="check"
                          size={12}
                          color="#fff"
                          strokeWidth={3}
                        />
                      ) : (
                        <Text
                          style={{
                            fontSize: 11,
                            fontWeight: '700',
                            color: isCurrent ? '#fff' : palette.textTertiary,
                            fontVariant: ['tabular-nums'],
                          }}
                        >
                          {stop.sequenceNumber}
                        </Text>
                      )}
                    </View>
                    {!isLast && (
                      <View
                        style={{
                          flex: 1,
                          width: 2,
                          marginTop: 2,
                          backgroundColor: isCompleted
                            ? palette.success
                            : palette.borderDefault,
                          borderRadius: 1,
                        }}
                      />
                    )}
                  </View>

                  {/* Body */}
                  <View style={{ flex: 1, paddingBottom: isLast ? 0 : 6 }}>
                    <Text
                      style={{
                        fontSize: 11,
                        fontWeight: '700',
                        letterSpacing: 0.66,
                        color: isDetour
                          ? palette.warning
                          : palette.textTertiary,
                        marginBottom: 6,
                      }}
                    >
                      {kindLabel.toUpperCase()}
                      {isCompleted && !isDetour ? ' · DONE' : ''}
                    </Text>

                    <Text
                      style={{
                        fontSize: 15,
                        lineHeight: 20,
                        fontWeight: '600',
                        color: palette.textPrimary,
                      }}
                      numberOfLines={1}
                    >
                      {isDetour
                        ? 'Off-plan stop'
                        : stop.locationName || `${stop.city}, ${stop.state}`}
                    </Text>

                    {!isDetour && (
                      <Text
                        style={{
                          fontSize: 13,
                          color: palette.textSecondary,
                          marginTop: 2,
                        }}
                        numberOfLines={1}
                      >
                        {stop.address}
                        {stop.city ? `, ${stop.city}` : ''}
                        {stop.state ? `, ${stop.state}` : ''}{' '}
                        {stop.postalCode || ''}
                      </Text>
                    )}

                    {/* Compact time line: window · checkedIn → checkedOut */}
                    <View
                      style={{
                        flexDirection: 'row',
                        alignItems: 'center',
                        gap: 6,
                        flexWrap: 'wrap',
                        marginTop: 6,
                      }}
                    >
                      <Icon
                        name="clock"
                        size={13}
                        color={palette.textTertiary}
                      />
                      {!isDetour && windowText && (
                        <Text
                          style={{
                            fontSize: 12,
                            color: palette.textTertiary,
                            fontVariant: ['tabular-nums'],
                          }}
                        >
                          {windowText}
                        </Text>
                      )}
                      {(stop.checkedInAt || stop.checkedOutAt) && (
                        <Text
                          style={{
                            fontSize: 12,
                            color: palette.textTertiary,
                            fontVariant: ['tabular-nums'],
                          }}
                        >
                          {!isDetour && windowText ? '· ' : ''}
                          {compactTime(stop.checkedInAt)}
                          {stop.checkedOutAt
                            ? ` → ${compactTime(stop.checkedOutAt)}`
                            : ''}
                        </Text>
                      )}
                      {!windowText && !stop.checkedInAt && !isDetour && (
                        <Text
                          style={{
                            fontSize: 12,
                            color: palette.textTertiary,
                          }}
                        >
                          Not checked in
                        </Text>
                      )}
                    </View>

                    {/* Inline badges — pending sync + redirected */}
                    {(isPendingSync || stop.isRedirected) && (
                      <View
                        style={{
                          flexDirection: 'row',
                          gap: 6,
                          flexWrap: 'wrap',
                          marginTop: 6,
                        }}
                      >
                        {isPendingSync && (
                          <View
                            style={{
                              flexDirection: 'row',
                              alignItems: 'center',
                              gap: 4,
                              paddingHorizontal: 8,
                              paddingVertical: 2,
                              borderRadius: designRadii.sm,
                              backgroundColor: 'rgba(245,158,11,0.12)',
                            }}
                          >
                            <Text
                              style={{
                                fontSize: 10,
                                fontWeight: '600',
                                color: palette.warning,
                                letterSpacing: 0.3,
                              }}
                            >
                              PENDING SYNC
                            </Text>
                          </View>
                        )}
                        {stop.isRedirected && (
                          <View
                            style={{
                              flexDirection: 'row',
                              alignItems: 'center',
                              gap: 4,
                              paddingHorizontal: 8,
                              paddingVertical: 2,
                              borderRadius: designRadii.sm,
                              backgroundColor: 'rgba(124,58,237,0.14)',
                            }}
                          >
                            <Text
                              style={{
                                fontSize: 10,
                                fontWeight: '600',
                                color: '#A78BFA',
                                letterSpacing: 0.3,
                              }}
                            >
                              REDIRECTED
                            </Text>
                          </View>
                        )}
                      </View>
                    )}

                    {/* GPS warming indicator */}
                    {isCurrent && !isCheckedIn && isGPSWarming && (
                      <View
                        style={{
                          flexDirection: 'row',
                          alignItems: 'center',
                          gap: 6,
                          marginTop: 10,
                        }}
                      >
                        <ActivityIndicator
                          size="small"
                          color={palette.accent}
                        />
                        <Text
                          style={{
                            fontSize: 12,
                            color: palette.textSecondary,
                          }}
                        >
                          Acquiring GPS…
                        </Text>
                      </View>
                    )}

                    {/* Single action per current stop — design rule:
                        never show both Check In and Check Out at once. */}
                    {isCurrent && !isCheckedIn && (
                      <Pressable
                        onPress={() => handleCheckIn(stop._id)}
                        style={({ pressed }) => [
                          {
                            marginTop: 12,
                            height: 40,
                            borderRadius: designRadii.md,
                            backgroundColor: palette.accent,
                            flexDirection: 'row',
                            alignItems: 'center',
                            justifyContent: 'center',
                            gap: 8,
                          },
                          pressed && { opacity: 0.88 },
                        ]}
                      >
                        <Icon name="map-pin" size={16} color="#fff" />
                        <Text
                          style={{
                            color: '#fff',
                            fontSize: 14,
                            fontWeight: '600',
                          }}
                        >
                          {isDetour
                            ? 'Check in at detour'
                            : isPickup
                              ? 'Check in at pickup'
                              : 'Check in at dropoff'}
                        </Text>
                      </Pressable>
                    )}
                    {isCurrent && isCheckedIn && (
                      <Pressable
                        onPress={() => handleCheckOut(stop._id)}
                        style={({ pressed }) => [
                          {
                            marginTop: 12,
                            height: 40,
                            borderRadius: designRadii.md,
                            backgroundColor: palette.success,
                            flexDirection: 'row',
                            alignItems: 'center',
                            justifyContent: 'center',
                            gap: 8,
                          },
                          pressed && { opacity: 0.88 },
                        ]}
                      >
                        <Icon
                          name="check"
                          size={16}
                          color="#fff"
                          strokeWidth={2}
                        />
                        <Text
                          style={{
                            color: '#fff',
                            fontSize: 14,
                            fontWeight: '600',
                          }}
                        >
                          {isDetour ? 'Check out of detour' : 'Check out'}
                        </Text>
                      </Pressable>
                    )}
                  </View>
                </View>
              );
            })}
          </View>

          {/* Quick Actions — design 2×2 grid. Handlers reuse existing flows
              so this is pure UI addition; no new business logic. */}
          <QuickActionsGrid
            palette={palette}
            onNavigate={() => {
              // Navigate the next stop that isn't completed yet. Falls back
              // to the first stop if everything's done (edge case).
              const target =
                displayStops.find((s) => !s.checkedOutAt) ?? displayStops[0];
              if (target?.address) {
                openMaps(target.address, target.city, target.state);
              }
            }}
            onDocuments={() => setShowDocumentsSheet(true)}
            onDetour={() => setShowDetourModal(true)}
            onAccident={() => setShowAccidentSheet(true)}
          />

          {/* Load meta (Commodity / Weight + units / Broker / Trailer temp).
              Reads the fields plumbed through getLoadWithStops — the card
              hides itself entirely if none are set so spot loads without
              full metadata don't show a blank shell. */}
          <LoadMetaCard
            palette={palette}
            commodity={load.commodityDescription}
            weight={load.weight}
            units={load.units}
            broker={load.customerName}
            poNumber={load.poNumber}
            temperature={load.temperature}
            maxTemperature={load.maxTemperature}
          />

          {/* Contact Information */}
          {load.contactPersonName && (
            <View
              style={{
                backgroundColor: palette.bgSurface,
                borderWidth: 1,
                borderColor: palette.borderSubtle,
                borderRadius: designRadii.lg,
                padding: 14,
                marginBottom: 16,
              }}
            >
              <Text
                style={{
                  fontSize: 11,
                  fontWeight: '700',
                  letterSpacing: 0.8,
                  color: palette.textTertiary,
                  marginBottom: 10,
                }}
              >
                CONTACT
              </Text>
              <View style={{ flexDirection: 'row', alignItems: 'center', gap: 12 }}>
                <View
                  style={{
                    width: 40,
                    height: 40,
                    borderRadius: designRadii.md,
                    backgroundColor: palette.bgMuted,
                    alignItems: 'center',
                    justifyContent: 'center',
                  }}
                >
                  <Icon name="user" size={20} color={palette.textSecondary} />
                </View>
                <View style={{ flex: 1, minWidth: 0 }}>
                  <Text
                    style={{
                      fontSize: 14,
                      fontWeight: '600',
                      color: palette.textPrimary,
                    }}
                    numberOfLines={1}
                  >
                    {load.contactPersonName}
                  </Text>
                  <Text
                    style={{
                      fontSize: 12,
                      color: palette.textTertiary,
                      marginTop: 2,
                    }}
                    numberOfLines={1}
                  >
                    {load.customerName ? `Site Manager · ${load.customerName}` : 'Site Contact'}
                  </Text>
                </View>
                {load.contactPersonPhone && (
                  <Pressable
                    onPress={() => Linking.openURL(`tel:${load.contactPersonPhone}`)}
                    accessibilityLabel="Call contact"
                    style={({ pressed }) => [
                      {
                        width: 40,
                        height: 40,
                        borderRadius: designRadii.full,
                        backgroundColor: palette.accentTint,
                        alignItems: 'center',
                        justifyContent: 'center',
                      },
                      pressed && { opacity: 0.7 },
                    ]}
                  >
                    <Icon name="phone" size={20} color={palette.accent} />
                  </Pressable>
                )}
              </View>
            </View>
          )}

          {/* Special Instructions */}
          {load.generalInstructions && (
            <View
              style={{
                backgroundColor: palette.bgSurface,
                borderWidth: 1,
                borderColor: palette.borderSubtle,
                borderRadius: designRadii.lg,
                padding: 14,
                marginBottom: 16,
              }}
            >
              <Text
                style={{
                  fontSize: 11,
                  fontWeight: '700',
                  letterSpacing: 0.8,
                  color: palette.textTertiary,
                  marginBottom: 10,
                }}
              >
                INSTRUCTIONS
              </Text>
              <View style={{ flexDirection: 'row', gap: 12 }}>
                <View
                  style={{
                    width: 28,
                    height: 28,
                    borderRadius: designRadii.md,
                    backgroundColor: palette.bgMuted,
                    alignItems: 'center',
                    justifyContent: 'center',
                    marginTop: 1,
                  }}
                >
                  <Icon name="info" size={16} color={palette.textSecondary} />
                </View>
                <Text
                  style={{
                    flex: 1,
                    fontSize: 13,
                    lineHeight: 18,
                    color: palette.textPrimary,
                  }}
                >
                  {load.generalInstructions}
                </Text>
              </View>
            </View>
          )}
        </ScrollView>

        {/* Check-in/out Modal */}
        <Modal visible={checkInModal.visible} animationType="slide" transparent onRequestClose={closeModal}>
          <KeyboardAvoidingView
            style={styles.modalOverlay}
            behavior="padding"
            keyboardVerticalOffset={Platform.OS === 'ios' ? -150 : -160}
          >
            <Pressable
              style={styles.modalBackdrop}
              onPress={() => {
                Keyboard.dismiss();
                closeModal();
              }}
            />
            <TouchableWithoutFeedback onPress={Keyboard.dismiss}>
              <View style={styles.modalContent}>
                <View style={styles.sheetHandle} />

                {/* Header */}
                <View style={styles.modalHeader}>
                  <View style={styles.modalHeaderText}>
                    <Text style={styles.modalTitle}>
                      {checkInModal.type === 'in' ? 'Confirm Check-In' : 'Confirm Check-Out'}
                    </Text>
                    <Text style={styles.modalSubtitle}>
                      Stop {displayStops[currentStopIndex]?.sequenceNumber}:{' '}
                      {displayStops[currentStopIndex]?.locationName ||
                        `${displayStops[currentStopIndex]?.city}, ${displayStops[currentStopIndex]?.state}`}
                    </Text>
                  </View>
                  <Pressable style={styles.modalCancelButton} onPress={closeModal}>
                    <Text style={styles.modalCancelButtonText}>Cancel</Text>
                  </Pressable>
                </View>

                {/* Redirected Stop Toggle (check-in only) */}
                {checkInModal.type === 'in' && (
                  <View style={styles.redirectToggleRow}>
                    <View style={styles.redirectToggleLeft}>
                      <Ionicons name="swap-horizontal" size={20} color={colors.secondary} />
                      <Text style={styles.redirectToggleLabel}>
                        Redirected {displayStops[currentStopIndex]?.stopType === 'PICKUP' ? 'Pickup' : 'Delivery'}
                      </Text>
                    </View>
                    <Switch
                      value={isRedirected}
                      onValueChange={setIsRedirected}
                      trackColor={{ false: colors.muted, true: `${colors.secondary}80` }}
                      thumbColor={isRedirected ? colors.secondary : colors.foregroundMuted}
                    />
                  </View>
                )}
                {isRedirected && (
                  <View style={styles.redirectBanner}>
                    <Ionicons name="information-circle" size={16} color={colors.secondary} />
                    <Text style={styles.redirectBannerText}>
                      You'll check in at your current GPS location. The scheduled address is kept for records.
                    </Text>
                  </View>
                )}

                {/* Photo Row — shows camera prompt or attached photo */}
                {photoUri ? (
                  <View style={[styles.modalPhotoRow, { borderColor: `${colors.success}40` }]}>
                    <Image source={{ uri: photoUri }} style={styles.modalPhotoThumbnail} />
                    <View style={styles.modalPhotoTextContainer}>
                      <View style={styles.modalPhotoAttachedRow}>
                        <Ionicons name="checkmark-circle" size={18} color={colors.success} />
                        <Text style={[styles.modalPhotoTitle, { color: colors.success }]}>Photo Attached</Text>
                      </View>
                      <Text style={styles.modalPhotoSubtitle}>
                        Ready to upload with {checkInModal.type === 'in' ? 'check-in' : 'check-out'}
                      </Text>
                    </View>
                    <Pressable
                      style={({ pressed }) => [styles.modalPhotoRemoveButton, pressed && { opacity: 0.7 }]}
                      onPress={() => setPhotoUri(null)}
                    >
                      <Ionicons name="close-circle" size={22} color={colors.foregroundMuted} />
                    </Pressable>
                  </View>
                ) : (
                  <Pressable style={styles.modalPhotoRow} onPress={launchCamera}>
                    <View style={styles.modalPhotoIconContainer}>
                      <Ionicons name="camera" size={24} color={colors.primary} />
                    </View>
                    <View style={styles.modalPhotoTextContainer}>
                      <Text style={styles.modalPhotoTitle}>Take a Photo</Text>
                      <Text style={styles.modalPhotoSubtitle}>
                        {checkInModal.type === 'in' ? 'Proof of arrival or cargo status' : 'Proof of delivery'}
                      </Text>
                    </View>
                    <Ionicons name="arrow-forward" size={20} color={colors.foregroundMuted} />
                  </Pressable>
                )}

                {/* Add Note Section */}
                <View style={styles.modalNoteSection}>
                  <View style={styles.modalNoteLabelRow}>
                    <Ionicons name="chatbubble-ellipses" size={18} color={colors.secondary} />
                    <Text style={styles.modalNoteLabel}>Add Note or Voice Message</Text>
                  </View>
                  <View style={styles.modalNoteInputRow}>
                    <TextInput
                      style={styles.modalNoteInput}
                      value={notes}
                      onChangeText={setNotes}
                      placeholder="Gate info or arrival details..."
                      placeholderTextColor={colors.foregroundMuted}
                      multiline
                      numberOfLines={4}
                      textAlignVertical="top"
                      blurOnSubmit
                      returnKeyType="done"
                      onSubmitEditing={() => Keyboard.dismiss()}
                    />
                    <Pressable
                      style={({ pressed }) => [
                        styles.modalNoteActionButton,
                        notes.trim() ? styles.modalNoteSendButton : styles.modalNoteVoiceButton,
                        pressed && { opacity: 0.7 },
                      ]}
                      onPress={() => Keyboard.dismiss()}
                    >
                      <Ionicons
                        name={notes.trim() ? 'send' : 'mic'}
                        size={20}
                        color={notes.trim() ? colors.foreground : colors.secondary}
                      />
                    </Pressable>
                  </View>
                </View>

                {/* Complete Button */}
                <Pressable
                  style={({ pressed }) => [
                    styles.modalCompleteButton,
                    isSubmitting && styles.modalCompleteButtonDisabled,
                    pressed && { opacity: 0.8 },
                  ]}
                  onPress={submitCheckIn}
                  disabled={isSubmitting}
                >
                  {isSubmitting ? (
                    <ActivityIndicator color={colors.primaryForeground} size="small" />
                  ) : (
                    <>
                      <Ionicons name="log-in" size={22} color={colors.primaryForeground} />
                      <Text style={styles.modalCompleteButtonText}>
                        Complete {checkInModal.type === 'in' ? 'Check-In' : 'Check-Out'}
                      </Text>
                    </>
                  )}
                </Pressable>

                {/* GPS Notice */}
                <View style={styles.modalGpsNotice}>
                  <Ionicons name="location" size={16} color={colors.foregroundMuted} />
                  <Text style={styles.modalGpsNoticeText}>Location verified via GPS</Text>
                </View>
              </View>
            </TouchableWithoutFeedback>
          </KeyboardAvoidingView>
        </Modal>

        <DetourSheet
          visible={showDetourModal}
          palette={palette}
          reason={detourReason}
          setReason={setDetourReason}
          notes={detourNotes}
          setNotes={setDetourNotes}
          isSubmitting={isAddingDetour}
          onClose={() => {
            setShowDetourModal(false);
            setDetourReason('FUEL');
            setDetourNotes('');
          }}
          onConfirm={async () => {
            setIsAddingDetour(true);
            try {
              const loc = await getFreshLocation();
              if (!driverId) {
                Alert.alert(
                  'Driver Unavailable',
                  'Could not determine the current driver. Please reopen the trip and try again.',
                );
                setIsAddingDetour(false);
                return;
              }
              if (!loc) {
                Alert.alert('GPS Unavailable', 'Could not get your current location. Please try again.');
                setIsAddingDetour(false);
                return;
              }

              const mutationArgs = {
                loadId: id as Id<'loadInformation'>,
                driverId,
                numberOfStops: 1,
                reason: detourReason,
                notes: detourNotes || undefined,
                latitude: loc.latitude,
                longitude: loc.longitude,
                driverTimestamp: new Date().toISOString(),
              };

              // Offline / poor signal — queue the detour so the driver
              // isn't blocked in a yard with bad coverage. The mutation
              // replays verbatim when signal returns; dispatch sees it a
              // minute late rather than not at all.
              if (connectionQuality !== 'good') {
                await enqueueMutation('addDetourStops', mutationArgs);
                posthog?.capture('detour_queued_offline', {
                  loadId: id,
                  reason: detourReason,
                  connectionQuality,
                });
                setShowDetourModal(false);
                setDetourReason('FUEL');
                setDetourNotes('');
                Alert.alert(
                  connectionQuality === 'offline' ? 'Saved offline' : 'Weak signal',
                  connectionQuality === 'offline'
                    ? 'Detour saved — will sync when you reconnect.'
                    : 'Detour queued — will sync as signal improves.',
                );
                return;
              }

              const result = await addDetourStopsMutation(mutationArgs);

              posthog?.capture('detour_confirmed', {
                loadId: id,
                numberOfStops: 1,
                reason: detourReason,
                success: result.success,
              });

              setShowDetourModal(false);
              setDetourReason('FUEL');
              setDetourNotes('');

              if (!result.success) {
                Alert.alert(
                  "Couldn't add detour",
                  result.message ||
                    'The server rejected the detour. Try again, or reach out to dispatch if this keeps happening.',
                );
              }
            } catch (err) {
              // Any runtime error — fall back to queueing rather than
              // dead-ending the driver. The queue processor will retry
              // with exponential backoff.
              const msg = err instanceof Error ? err.message : 'Something went wrong';
              try {
                const loc = await getFreshLocation();
                if (driverId && loc) {
                  await enqueueMutation('addDetourStops', {
                    loadId: id as Id<'loadInformation'>,
                    driverId,
                    numberOfStops: 1,
                    reason: detourReason,
                    notes: detourNotes || undefined,
                    latitude: loc.latitude,
                    longitude: loc.longitude,
                    driverTimestamp: new Date().toISOString(),
                  });
                  posthog?.capture('detour_queued_after_error', {
                    loadId: id,
                    reason: detourReason,
                    error: msg,
                  });
                  setShowDetourModal(false);
                  setDetourReason('FUEL');
                  setDetourNotes('');
                  Alert.alert('Connection slow', 'Detour queued — will sync shortly.');
                  return;
                }
              } catch {
                /* fall through to the raw error alert below */
              }
              Alert.alert("Couldn't add detour", msg);
            } finally {
              setIsAddingDetour(false);
            }
          }}
        />

        <AccidentSheet
          visible={showAccidentSheet}
          palette={palette}
          kind={accidentKind}
          setKind={setAccidentKind}
          note={accidentNote}
          setNote={setAccidentNote}
          hasPhoto={!!accidentPhotoUri}
          onCapturePhoto={captureAccidentPhoto}
          isReporting={isReportingAccident}
          onClose={() => {
            setShowAccidentSheet(false);
            setAccidentPhotoUri(null);
          }}
          onReport={async () => {
            if (!driverId || !id) return;
            setIsReportingAccident(true);
            posthog?.capture('accident_reported', {
              loadId: id,
              kind: accidentKind,
              hasNote: !!accidentNote,
              hasPhoto: !!accidentPhotoUri,
            });

            // Write an Accident-typed document. The "what happened" chip
            // is sent as `accidentKind` — lands on the R2 object as the
            // `accident-kind` metadata field, searchable from the bucket
            // without hitting Convex. The free-text description stays in
            // `note` (per-row on Convex, not in metadata; S3 per-object
            // metadata is capped at 2KB and better suited to short
            // structured values).
            //
            // Photo is optional — if the driver skipped it we still
            // want the record; we just upload a minimal placeholder
            // photo... actually, the backend requires externalUrl OR
            // storageId, so without a photo the driver gets an inline
            // warning (below). We enforce here rather than silently
            // no-op'ing.
            if (!accidentPhotoUri) {
              Alert.alert(
                'Photo required',
                'Accident reports need a photo. Tap "Attach photo" to capture one before reporting.',
              );
              setIsReportingAccident(false);
              return;
            }

            try {
              const result = await uploadDocument({
                loadId: id as Id<'loadInformation'>,
                driverId,
                type: 'Accident',
                photoUri: accidentPhotoUri,
                note: accidentNote || undefined,
                accidentKind,
              });

              if (!result.success) {
                Alert.alert('Report failed', result.message);
                setIsReportingAccident(false);
                return;
              }

              Alert.alert(
                result.queued ? 'Queued' : 'Reported',
                result.queued
                  ? 'No signal — the report will upload when connected.'
                  : 'Dispatch will see this incident.',
              );
            } catch (uploadErr) {
              const msg = uploadErr instanceof Error ? uploadErr.message : 'Report failed';
              Alert.alert('Report failed', msg);
              setIsReportingAccident(false);
              return;
            }

            setShowAccidentSheet(false);
            setAccidentKind('Collision');
            setAccidentNote('');
            setAccidentPhotoUri(null);
            setIsReportingAccident(false);
          }}
        />

        <DocumentsSheet
          visible={showDocumentsSheet}
          palette={palette}
          recentUploads={recentUploads}
          existingDocs={loadDocuments ?? []}
          onClose={() => {
            setShowDocumentsSheet(false);
            // Clear the toast list on dismiss so re-opening the sheet
            // starts fresh — the server-side loadDocuments query is the
            // source of truth; this list is just ephemeral feedback.
            setRecentUploads([]);
          }}
          onPickKind={handlePickDocKind}
        />
      </View>
    </>
  );
}

// ============================================================================
// DESIGN-ALIGNED SUB-COMPONENTS
//
// These live below the main TripDetailScreen render and are rendered by it
// via direct invocation (<LoadSummary palette={palette} ... />). They're
// scoped to this file so the main screen's state + handlers stay local.
//
// They use the design-tokens palette (passed in as a prop) so they flip
// cleanly with the app-wide theme preference.
// ============================================================================

type Palette = ReturnType<typeof useTheme>['palette'];

/**
 * Load Summary card — top of screen, above the legacy Route Details block.
 * Shows: internalId · tags · status chip · progress bar. Status progresses
 * against non-detour stops so detours don't dilute the "X of Y complete"
 * reading.
 */
function LoadSummary({
  palette,
  load,
  displayStops,
  activeCheckedInStop,
  statusDisplay,
}: {
  palette: Palette;
  load: any;
  displayStops: any[];
  activeCheckedInStop: any | null;
  statusDisplay: { text: string; color: string };
}) {
  const plannedStops = displayStops.filter((s) => s.stopType !== 'DETOUR');
  const total = plannedStops.length || 1;
  const done = plannedStops.filter((s) => !!s.checkedOutAt).length;
  const onDetour =
    activeCheckedInStop && activeCheckedInStop.stopType === 'DETOUR';
  const hasDetour = displayStops.some(
    (s) => s.stopType === 'DETOUR' && !s.checkedOutAt,
  );
  const progressPct = Math.min((done / total) * 100, 100);

  // Shared facet-tag helper — same source as the driver dashboard so
  // HCR / TRIP / equipment / HAZ / TARP badges stay consistent across
  // surfaces. See mobile/lib/facet-tags.ts.
  const tags = loadFacetTags(load);

  return (
    <View
      style={{
        paddingHorizontal: 4,
        paddingBottom: 12,
        gap: 10,
      }}
    >
      <Text
        style={{
          fontSize: 11,
          fontWeight: '700',
          letterSpacing: 0.88,
          color: palette.textTertiary,
        }}
      >
        LOAD
      </Text>

      <View
        style={{
          flexDirection: 'row',
          alignItems: 'center',
          justifyContent: 'space-between',
          gap: 12,
        }}
      >
        <Text
          style={{
            fontSize: 24,
            lineHeight: 30,
            fontWeight: '700',
            letterSpacing: -0.24,
            color: palette.textPrimary,
            flexShrink: 1,
            fontVariant: ['tabular-nums'],
          }}
          numberOfLines={1}
        >
          #{load.orderNumber ?? load.internalId}
        </Text>
        <View
          style={{
            backgroundColor: `${statusDisplay.color}20`,
            paddingHorizontal: 10,
            paddingVertical: 4,
            borderRadius: designRadii.full,
          }}
        >
          <Text
            style={{
              fontSize: 11,
              fontWeight: '600',
              letterSpacing: 0.3,
              color: statusDisplay.color,
            }}
          >
            {statusDisplay.text}
          </Text>
        </View>
      </View>

      {(tags.length > 0 || hasDetour) && (
        <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 6 }}>
          {tags.map((t) => {
            const s = tagKindStyles(t.kind, t.label, palette);
            return (
              <View
                key={t.label}
                style={{
                  height: 22,
                  paddingHorizontal: 8,
                  borderRadius: designRadii.sm,
                  backgroundColor: s.bg,
                  justifyContent: 'center',
                }}
              >
                <Text
                  style={{
                    fontSize: 11,
                    fontWeight: '700',
                    letterSpacing: 0.55,
                    color: s.fg,
                  }}
                >
                  {t.label}
                </Text>
              </View>
            );
          })}
          {typeof load.stopCount === 'number' && load.effectiveMiles && (
            <View
              style={{
                height: 22,
                paddingHorizontal: 8,
                borderRadius: designRadii.sm,
                backgroundColor: palette.bgMuted,
                justifyContent: 'center',
              }}
            >
              <Text
                style={{
                  fontSize: 11,
                  fontWeight: '700',
                  letterSpacing: 0.55,
                  color: palette.textSecondary,
                }}
              >
                {load.stopCount} stops · {Math.round(load.effectiveMiles)} mi
              </Text>
            </View>
          )}
          {hasDetour && (
            <View
              style={{
                flexDirection: 'row',
                alignItems: 'center',
                gap: 4,
                height: 22,
                paddingHorizontal: 8,
                borderRadius: designRadii.sm,
                backgroundColor: 'rgba(245,158,11,0.14)',
              }}
            >
              <Icon name="warning" size={11} color={palette.warning} strokeWidth={2} />
              <Text
                style={{
                  fontSize: 11,
                  fontWeight: '700',
                  letterSpacing: 0.55,
                  color: palette.warning,
                }}
              >
                DETOUR
              </Text>
            </View>
          )}
        </View>
      )}

      <View style={{ marginTop: 4 }}>
        <View
          style={{
            flexDirection: 'row',
            alignItems: 'center',
            justifyContent: 'space-between',
            marginBottom: 6,
          }}
        >
          <Text
            style={{
              fontSize: 12,
              color: palette.textTertiary,
              letterSpacing: 0.24,
            }}
          >
            {onDetour
              ? 'On detour'
              : `Stop ${Math.min(done + 1, total)} of ${total}`}
          </Text>
          <Text
            style={{
              fontSize: 12,
              color: palette.textTertiary,
              fontVariant: ['tabular-nums'],
            }}
          >
            {done}/{total} complete
          </Text>
        </View>
        <View
          style={{
            height: 6,
            borderRadius: designRadii.full,
            backgroundColor: palette.bgMuted,
            overflow: 'hidden',
          }}
        >
          <View
            style={{
              width: `${progressPct}%`,
              height: '100%',
              backgroundColor: onDetour ? palette.warning : palette.accent,
            }}
          />
        </View>
      </View>
    </View>
  );
}

/**
 * Quick Actions grid — 2×2 tiles under the Route Details card. Keeps the
 * existing business wiring: Navigate opens Apple Maps against the next
 * unchecked stop; Documents reuses the check-in modal's photo path via a
 * quick-actions trigger; Detour opens the existing detour modal;
 * Report accident is a placeholder until the sheet lands.
 */
/**
 * LoadMetaCard — the design's Load Meta section.
 *
 * Four optional k/v rows (Commodity / Weight+units / Broker / Trailer temp).
 * Renders nothing at all if none of the fields are populated. Temp renders
 * as a range when both `temperature` and `maxTemperature` are set:
 *   "34°F – 38°F required"
 * Weight picks up the new `units` field (PR #57) to avoid the hardcoded
 * "lbs" the legacy surface assumed.
 */
function LoadMetaCard({
  palette,
  commodity,
  weight,
  units,
  broker,
  poNumber,
  temperature,
  maxTemperature,
}: {
  palette: Palette;
  commodity?: string;
  weight?: number;
  units?: 'Pallets' | 'Boxes' | 'Pieces' | 'Lbs' | 'Kg';
  broker?: string;
  poNumber?: string;
  temperature?: number;
  maxTemperature?: number;
}) {
  const rows: Array<[string, string]> = [];
  if (commodity) rows.push(['Commodity', commodity]);

  if (typeof weight === 'number') {
    const unitLabel = units ?? 'Lbs';
    rows.push(['Weight', `${weight.toLocaleString()} ${unitLabel}`]);
  }

  if (broker) {
    rows.push(['Broker', poNumber ? `${broker} · PO ${poNumber}` : broker]);
  }

  if (typeof temperature === 'number') {
    const tempLabel =
      typeof maxTemperature === 'number' && maxTemperature !== temperature
        ? `${temperature}°F – ${maxTemperature}°F required`
        : `${temperature}°F required`;
    rows.push(['Trailer temp', tempLabel]);
  }

  if (rows.length === 0) return null;

  return (
    <View style={{ paddingTop: 20 }}>
      <Text
        style={{
          fontSize: 12,
          fontWeight: '700',
          letterSpacing: 0.72,
          color: palette.textTertiary,
          marginBottom: 8,
          paddingHorizontal: 4,
        }}
      >
        LOAD INFO
      </Text>
      <View
        style={{
          backgroundColor: palette.bgSurface,
          borderWidth: 1,
          borderColor: palette.borderSubtle,
          borderRadius: designRadii.lg,
          overflow: 'hidden',
        }}
      >
        {rows.map(([k, v], i) => (
          <View
            key={k}
            style={{
              flexDirection: 'row',
              justifyContent: 'space-between',
              alignItems: 'center',
              paddingHorizontal: 14,
              paddingVertical: 12,
              borderTopWidth: i === 0 ? 0 : StyleSheet.hairlineWidth,
              borderTopColor: palette.borderSubtle,
            }}
          >
            <Text style={{ fontSize: 13, color: palette.textTertiary }}>{k}</Text>
            <Text
              style={{
                fontSize: 13,
                fontWeight: '500',
                color: palette.textPrimary,
                flexShrink: 1,
                textAlign: 'right',
                marginLeft: 12,
              }}
            >
              {v}
            </Text>
          </View>
        ))}
      </View>
    </View>
  );
}

function QuickActionsGrid({
  palette,
  onNavigate,
  onDocuments,
  onDetour,
  onAccident,
}: {
  palette: Palette;
  onNavigate: () => void;
  onDocuments: () => void;
  onDetour: () => void;
  onAccident: () => void;
}) {
  return (
    <View style={{ paddingHorizontal: 0, paddingTop: 16 }}>
      <Text
        style={{
          fontSize: 12,
          fontWeight: '700',
          letterSpacing: 0.72,
          color: palette.textTertiary,
          marginBottom: 8,
          paddingHorizontal: 4,
        }}
      >
        QUICK ACTIONS
      </Text>
      <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 8 }}>
        <QuickActionTile
          palette={palette}
          icon="map-pin"
          label="Navigate"
          sub="Open in Maps"
          onPress={onNavigate}
        />
        <QuickActionTile
          palette={palette}
          icon="clipboard"
          label="Documents"
          sub="Photos & notes"
          onPress={onDocuments}
        />
        <QuickActionTile
          palette={palette}
          icon="plus"
          label="Add detour"
          sub="Extra stop"
          onPress={onDetour}
        />
        <QuickActionTile
          palette={palette}
          icon="warning"
          label="Report accident"
          sub="Escalate to ops"
          onPress={onAccident}
          danger
        />
      </View>
    </View>
  );
}

function QuickActionTile({
  palette,
  icon,
  label,
  sub,
  onPress,
  danger,
}: {
  palette: Palette;
  icon: React.ComponentProps<typeof Icon>['name'];
  label: string;
  sub: string;
  onPress: () => void;
  danger?: boolean;
}) {
  return (
    <Pressable
      onPress={onPress}
      style={({ pressed }) => [
        {
          flexBasis: '48%',
          flexGrow: 1,
          padding: 12,
          borderRadius: designRadii.lg,
          backgroundColor: palette.bgSurface,
          borderWidth: 1,
          borderColor: palette.borderSubtle,
          minHeight: 76,
          gap: 8,
        },
        pressed && { opacity: 0.85 },
      ]}
    >
      <View
        style={{
          width: 32,
          height: 32,
          borderRadius: designRadii.md,
          backgroundColor: danger ? 'rgba(245,158,11,0.14)' : palette.accentTint,
          alignItems: 'center',
          justifyContent: 'center',
        }}
      >
        <Icon
          name={icon}
          size={18}
          color={danger ? palette.warning : palette.accent}
        />
      </View>
      <View>
        <Text
          style={{
            fontSize: 14,
            lineHeight: 18,
            fontWeight: '600',
            color: palette.textPrimary,
          }}
        >
          {label}
        </Text>
        <Text
          style={{
            fontSize: 12,
            color: palette.textTertiary,
            marginTop: 2,
          }}
        >
          {sub}
        </Text>
      </View>
    </Pressable>
  );
}

// ============================================================================
// BOTTOM SHEETS — Detour / Accident / Documents
//
// Shared structure: backdrop (tap to dismiss) + rounded sheet with a handle,
// title + subtitle, body, and primary/secondary actions. Uses the design
// palette so they flip with the theme preference.
// ============================================================================

const SHEET_RADIUS = 20;

// Either crossing the distance threshold OR flicking past the velocity
// threshold dismisses — matches iOS's presented-sheet gesture feel.
const SHEET_DISMISS_DISTANCE = 120;
const SHEET_DISMISS_VELOCITY = 0.8;
// Max translation the backdrop fades across — beyond this we're past
// the dismiss threshold anyway. Keeps the math simple.
const SHEET_DRAG_FADE_RANGE = 240;

function SheetFrame({
  palette,
  onClose,
  title,
  subtitle,
  children,
}: {
  palette: Palette;
  onClose: () => void;
  title: string;
  subtitle?: string;
  children: React.ReactNode;
}) {
  // translateY drives the sheet's vertical offset as the user drags.
  const translateY = useRef(new Animated.Value(0)).current;
  const isClosingRef = useRef(false);

  // Backdrop opacity fades from 0.5 → 0 as the sheet drags toward
  // dismiss, matching iOS presented-sheet behavior. Interpolating off
  // the same translateY keeps the two perfectly in sync and native-
  // driver-friendly.
  const backdropOpacity = translateY.interpolate({
    inputRange: [0, SHEET_DRAG_FADE_RANGE],
    outputRange: [0.5, 0],
    extrapolate: 'clamp',
  });

  const closeWithAnimation = useCallback(() => {
    if (isClosingRef.current) return;
    isClosingRef.current = true;
    Animated.timing(translateY, {
      toValue: 600,
      duration: 180,
      useNativeDriver: true,
    }).start(() => {
      onClose();
      // Defer the reset until AFTER RN's Modal has finished its own
      // slide-out animation. Without this delay, setValue(0) teleports
      // the sheet back to rest position mid-Modal-close — visible as
      // a split-second re-open flash before the Modal finishes hiding.
      // 400ms covers both iOS (~300ms slide) and Android (~250ms) with
      // headroom. The next open then starts from a clean y=0.
      setTimeout(() => {
        translateY.setValue(0);
        isClosingRef.current = false;
      }, 400);
    });
  }, [onClose, translateY]);

  const panResponder = useMemo(
    () =>
      PanResponder.create({
        // Capture phase: let children take first shot. Buttons / chips /
        // text inputs claim the touch here.
        onStartShouldSetPanResponderCapture: () => false,
        // Bubble phase: if no child claimed, the Animated.View takes
        // the touch. This is what makes title/subtitle/pill draggable —
        // they're inside plain Views with no own touch handlers, so the
        // touch bubbles up and we claim it. Without this, RN's responder
        // system has no one registered for moves over those areas, so
        // no drag events fire at all.
        onStartShouldSetPanResponder: () => true,
        // When a child (Pressable) already owns the touch, this steals
        // it on clearly-vertical movement so drivers can still start a
        // drag from a chip. The velocity-biased check (|dy| > |dx|*1.5)
        // avoids hijacking a horizontal scroll accidentally.
        onMoveShouldSetPanResponderCapture: (_, g) =>
          g.dy > 6 && Math.abs(g.dy) > Math.abs(g.dx) * 1.5,
        onPanResponderMove: (_, g) => {
          // Clamp to 0 — you can pull down but not push up past rest.
          translateY.setValue(Math.max(0, g.dy));
        },
        onPanResponderRelease: (_, g) => {
          if (g.dy > SHEET_DISMISS_DISTANCE || g.vy > SHEET_DISMISS_VELOCITY) {
            closeWithAnimation();
          } else {
            Animated.spring(translateY, {
              toValue: 0,
              useNativeDriver: true,
              bounciness: 4,
            }).start();
          }
        },
        onPanResponderTerminate: () => {
          Animated.spring(translateY, {
            toValue: 0,
            useNativeDriver: true,
            bounciness: 4,
          }).start();
        },
      }),
    [translateY, closeWithAnimation],
  );

  return (
    <View style={{ flex: 1, justifyContent: 'flex-end' }}>
      {/* Backdrop lives in its own absolute layer so it can fade
          independently of the sheet's transform. Still captures taps
          to close. */}
      <Animated.View
        pointerEvents="auto"
        style={{
          ...StyleSheet.absoluteFillObject,
          backgroundColor: '#000',
          opacity: backdropOpacity,
        }}
      >
        <Pressable style={{ flex: 1 }} onPress={onClose} />
      </Animated.View>

      <KeyboardAvoidingView behavior={Platform.OS === 'ios' ? 'padding' : undefined}>
        {/* The entire sheet body is the drag target — pan handlers
            are attached here so grabbing the pill, the title, OR even
            the whitespace just inside the sheet all register. Children
            (chips, buttons, inputs) still resolve taps first because
            of the onStartShouldSetPanResponder: false policy. */}
        <Animated.View
          {...panResponder.panHandlers}
          style={{
            backgroundColor: palette.bgSurface,
            borderTopLeftRadius: SHEET_RADIUS,
            borderTopRightRadius: SHEET_RADIUS,
            padding: 20,
            paddingBottom: 32,
            gap: 14,
            transform: [{ translateY }],
          }}
        >
          {/* Enlarged tap target around the pill — 44pt tall band per
              iOS HIG minimum so thumbs land reliably. Pill itself bumped
              to 44×5 so it reads as clearly interactive. */}
          <View
            style={{
              alignSelf: 'center',
              paddingVertical: 10,
              paddingHorizontal: 20,
              marginTop: -8,
              marginBottom: 2,
            }}
          >
            <View
              style={{
                width: 44,
                height: 5,
                borderRadius: 3,
                backgroundColor: palette.borderDefault,
              }}
            />
          </View>
          <View>
            <Text
              style={{ fontSize: 18, fontWeight: '700', color: palette.textPrimary, letterSpacing: -0.2 }}
            >
              {title}
            </Text>
            {subtitle ? (
              <Text style={{ fontSize: 13, lineHeight: 18, color: palette.textSecondary, marginTop: 4 }}>
                {subtitle}
              </Text>
            ) : null}
          </View>
          {children}
        </Animated.View>
      </KeyboardAvoidingView>
    </View>
  );
}

function SheetButton({
  palette,
  label,
  onPress,
  variant = 'primary',
  disabled,
  loading,
  icon,
}: {
  palette: Palette;
  label: string;
  onPress: () => void;
  variant?: 'primary' | 'secondary' | 'danger';
  disabled?: boolean;
  loading?: boolean;
  icon?: React.ComponentProps<typeof Icon>['name'];
}) {
  const bg =
    variant === 'primary' ? palette.accent : variant === 'danger' ? palette.danger : 'transparent';
  const border =
    variant === 'secondary' ? palette.borderDefault : 'transparent';
  const fg =
    variant === 'secondary' ? palette.textPrimary : '#fff';
  return (
    <Pressable
      onPress={onPress}
      disabled={disabled || loading}
      style={({ pressed }) => [
        {
          flex: 1,
          height: 48,
          borderRadius: designRadii.md,
          backgroundColor: bg,
          borderWidth: variant === 'secondary' ? 1 : 0,
          borderColor: border,
          flexDirection: 'row',
          alignItems: 'center',
          justifyContent: 'center',
          gap: 8,
        },
        pressed && !disabled && { opacity: 0.85 },
        (disabled || loading) && { opacity: 0.55 },
      ]}
    >
      {loading ? (
        <ActivityIndicator color={fg} size="small" />
      ) : (
        <>
          {icon ? <Icon name={icon} size={16} color={fg} /> : null}
          <Text style={{ color: fg, fontSize: 15, fontWeight: '600' }}>{label}</Text>
        </>
      )}
    </Pressable>
  );
}

const DETOUR_REASONS = [
  { key: 'FUEL', icon: 'warning', label: 'Fuel' },
  { key: 'REST', icon: 'clock', label: 'Rest' },
  { key: 'FOOD', icon: 'package', label: 'Food' },
  { key: 'SCALE', icon: 'gauge', label: 'Scale' },
  { key: 'REPAIR', icon: 'settings', label: 'Repair' },
  { key: 'REDIRECT', icon: 'arrow-right', label: 'Redirect' },
  { key: 'CUSTOMER', icon: 'user', label: 'Customer' },
  { key: 'OTHER', icon: 'more-h', label: 'Other' },
] as const;

function DetourSheet({
  visible,
  palette,
  reason,
  setReason,
  notes,
  setNotes,
  isSubmitting,
  onClose,
  onConfirm,
}: {
  visible: boolean;
  palette: Palette;
  reason: string;
  setReason: (r: any) => void;
  notes: string;
  setNotes: (n: string) => void;
  isSubmitting: boolean;
  onClose: () => void;
  onConfirm: () => void;
}) {
  return (
    <Modal visible={visible} animationType="slide" transparent onRequestClose={onClose}>
      <TouchableWithoutFeedback onPress={Keyboard.dismiss}>
        <View style={{ flex: 1 }}>
          <SheetFrame
            palette={palette}
            onClose={onClose}
            title="Start a detour"
            subtitle="We'll track your check-in and check-out times for this off-plan stop. Dispatch is notified."
          >
            <View style={{ gap: 8 }}>
              <Text
                style={{
                  fontSize: 11,
                  fontWeight: '700',
                  letterSpacing: 0.8,
                  color: palette.textTertiary,
                }}
              >
                REASON
              </Text>
              <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 8 }}>
                {DETOUR_REASONS.map((item) => {
                  const active = reason === item.key;
                  return (
                    <Pressable
                      key={item.key}
                      onPress={() => setReason(item.key)}
                      style={({ pressed }) => [
                        {
                          flexDirection: 'row',
                          alignItems: 'center',
                          gap: 6,
                          paddingHorizontal: 12,
                          paddingVertical: 8,
                          borderRadius: designRadii.full,
                          backgroundColor: active ? palette.accentTint : palette.bgMuted,
                          borderWidth: 1,
                          borderColor: active ? palette.accent : 'transparent',
                        },
                        pressed && { opacity: 0.8 },
                      ]}
                    >
                      <Icon
                        name={item.icon}
                        size={14}
                        color={active ? palette.accent : palette.textSecondary}
                      />
                      <Text
                        style={{
                          fontSize: 13,
                          fontWeight: '500',
                          color: active ? palette.accent : palette.textPrimary,
                        }}
                      >
                        {item.label}
                      </Text>
                    </Pressable>
                  );
                })}
              </View>
            </View>

            <TextInput
              value={notes}
              onChangeText={setNotes}
              placeholder="Add a note (optional)"
              placeholderTextColor={palette.textPlaceholder}
              multiline
              maxLength={200}
              style={{
                borderWidth: 1,
                borderColor: palette.borderSubtle,
                backgroundColor: palette.bgMuted,
                borderRadius: designRadii.md,
                paddingHorizontal: 12,
                paddingVertical: 10,
                minHeight: 60,
                fontSize: 14,
                color: palette.textPrimary,
                textAlignVertical: 'top',
              }}
            />

            <View
              style={{
                flexDirection: 'row',
                alignItems: 'flex-start',
                gap: 10,
                padding: 12,
                borderRadius: designRadii.md,
                backgroundColor: palette.accentTint,
              }}
            >
              <Icon name="location" size={16} color={palette.accent} strokeWidth={1.8} />
              <Text style={{ flex: 1, fontSize: 12, lineHeight: 16, color: palette.textSecondary }}>
                Your GPS location and check-in / check-out times are recorded automatically.
              </Text>
            </View>

            <View style={{ flexDirection: 'row', gap: 8 }}>
              <SheetButton palette={palette} label="Cancel" variant="secondary" onPress={onClose} />
              <SheetButton
                palette={palette}
                label={isSubmitting ? 'Starting…' : 'Start detour'}
                variant="primary"
                loading={isSubmitting}
                onPress={onConfirm}
              />
            </View>
          </SheetFrame>
        </View>
      </TouchableWithoutFeedback>
    </Modal>
  );
}

// Values land on the R2 object as `x-amz-meta-accident-kind`. Kept
// short + distinct so ops can filter the bucket by incident category.
const ACCIDENT_KINDS = [
  'Collision',
  'Trailer damage',
  'Cargo damage',
  'Multi-vehicle',
] as const;

function AccidentSheet({
  visible,
  palette,
  kind,
  setKind,
  note,
  setNote,
  hasPhoto,
  onCapturePhoto,
  onClose,
  onReport,
  isReporting,
}: {
  visible: boolean;
  palette: Palette;
  kind: string;
  setKind: (k: string) => void;
  note: string;
  setNote: (n: string) => void;
  // Optional photo attachment — driver captures visual evidence that
  // lands as an Accident-typed document alongside the structured kind
  // chip and the free-text description. The parent owns photoUri so the
  // upload fires from the same place as the mutation.
  hasPhoto: boolean;
  onCapturePhoto: () => void;
  onClose: () => void;
  // Creates the Accident-typed loadDocuments row (+ R2 object with the
  // kind stamped as metadata). Parent clears sheet state after success.
  onReport: () => void;
  isReporting: boolean;
}) {
  return (
    <Modal visible={visible} animationType="slide" transparent onRequestClose={onClose}>
      <TouchableWithoutFeedback onPress={Keyboard.dismiss}>
        <View style={{ flex: 1 }}>
          <SheetFrame
            palette={palette}
            onClose={onClose}
            title="Report an accident"
            subtitle="Logs an incident record with your GPS, time, and photo (if attached)."
          >
            <View
              style={{
                flexDirection: 'row',
                alignItems: 'flex-start',
                gap: 10,
                padding: 14,
                borderRadius: designRadii.md,
                backgroundColor: 'rgba(245, 158, 11, 0.10)',
                borderWidth: 1,
                borderColor: 'rgba(245, 158, 11, 0.28)',
              }}
            >
              <Icon name="warning" size={18} color={palette.warning} />
              <View style={{ flex: 1 }}>
                <Text style={{ fontSize: 14, fontWeight: '600', color: palette.textPrimary }}>
                  Everyone safe first.
                </Text>
                <Text
                  style={{ fontSize: 13, lineHeight: 18, color: palette.textSecondary, marginTop: 2 }}
                >
                  If there are injuries, call 911 before continuing.
                </Text>
              </View>
            </View>

            <View style={{ gap: 8 }}>
              <Text
                style={{
                  fontSize: 11,
                  fontWeight: '700',
                  letterSpacing: 0.8,
                  color: palette.textTertiary,
                }}
              >
                WHAT HAPPENED?
              </Text>
              {/* Balanced 2×2 grid. With 4 fixed chips, intrinsic-width
                  + flex-wrap stranded "Multi-vehicle" on its own row
                  with dead space on the right. flexBasis: '48%' +
                  flexGrow: 1 makes every chip half-width, filling both
                  rows evenly regardless of label length. */}
              <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 8 }}>
                {ACCIDENT_KINDS.map((opt) => {
                  const active = kind === opt;
                  return (
                    <Pressable
                      key={opt}
                      onPress={() => setKind(opt)}
                      style={({ pressed }) => [
                        {
                          flexBasis: '48%',
                          flexGrow: 1,
                          paddingHorizontal: 12,
                          paddingVertical: 10,
                          borderRadius: designRadii.full,
                          backgroundColor: active ? palette.accentTint : palette.bgMuted,
                          borderWidth: 1,
                          borderColor: active ? palette.accent : 'transparent',
                          alignItems: 'center',
                        },
                        pressed && { opacity: 0.8 },
                      ]}
                    >
                      <Text
                        style={{
                          fontSize: 13,
                          fontWeight: '500',
                          color: active ? palette.accent : palette.textPrimary,
                        }}
                      >
                        {opt}
                      </Text>
                    </Pressable>
                  );
                })}
              </View>
            </View>

            <View style={{ gap: 6 }}>
              <Text
                style={{
                  fontSize: 11,
                  fontWeight: '700',
                  letterSpacing: 0.8,
                  color: palette.textTertiary,
                }}
              >
                BRIEF DESCRIPTION
              </Text>
              <TextInput
                value={note}
                onChangeText={setNote}
                placeholder="Short description — ops will call for full report"
                placeholderTextColor={palette.textPlaceholder}
                multiline
                maxLength={300}
                style={{
                  borderWidth: 1,
                  borderColor: palette.borderSubtle,
                  backgroundColor: palette.bgMuted,
                  borderRadius: designRadii.md,
                  paddingHorizontal: 12,
                  paddingVertical: 10,
                  minHeight: 72,
                  fontSize: 14,
                  color: palette.textPrimary,
                  textAlignVertical: 'top',
                }}
              />
            </View>

            {/* Optional photo attachment — builds an Accident-typed
                document in loadDocuments with GPS + timestamp alongside
                the tel: dial, so ops has evidence before the call. */}
            <Pressable
              onPress={onCapturePhoto}
              style={({ pressed }) => [
                {
                  flexDirection: 'row',
                  alignItems: 'center',
                  gap: 10,
                  padding: 12,
                  borderRadius: designRadii.md,
                  borderWidth: 1,
                  borderColor: hasPhoto ? palette.success : palette.borderSubtle,
                  borderStyle: hasPhoto ? 'solid' : 'dashed',
                  backgroundColor: hasPhoto ? 'rgba(16,185,129,0.08)' : palette.bgMuted,
                },
                pressed && { opacity: 0.85 },
              ]}
            >
              <Icon
                name={hasPhoto ? 'check' : 'camera'}
                size={18}
                color={hasPhoto ? palette.success : palette.textSecondary}
                strokeWidth={hasPhoto ? 2.5 : 1.5}
              />
              <Text style={{ fontSize: 13, color: palette.textPrimary, flex: 1 }}>
                {hasPhoto ? 'Photo attached — tap to retake' : 'Attach photo (optional)'}
              </Text>
            </Pressable>

            <View style={{ flexDirection: 'row', gap: 8 }}>
              <SheetButton palette={palette} label="Cancel" variant="secondary" onPress={onClose} />
              <SheetButton
                palette={palette}
                label={isReporting ? 'Reporting…' : 'Report'}
                variant="danger"
                icon="check"
                disabled={isReporting}
                onPress={onReport}
              />
            </View>
          </SheetFrame>
        </View>
      </TouchableWithoutFeedback>
    </Modal>
  );
}

// DocKind mirrors the driver-facing enum from convex schema.ts
// loadDocuments.type. Kept as the full 6-value union so other surfaces
// (AccidentSheet → uploadDocument({type:'Accident'})) still compile.
type DocKind = 'POD' | 'Receipt' | 'Cargo' | 'Damage' | 'Accident' | 'Other';
// DOC_KINDS is only the *tiles* rendered in the Documents sheet —
// Accident is intentionally absent because the Quick Action has its own
// dedicated AccidentSheet flow (kind chips + attach photo + page ops).
// Exposing it here too would give drivers two entry points for the same
// record and risk inconsistent metadata.
const DOC_KINDS: ReadonlyArray<{ key: DocKind; icon: string; sub: string }> = [
  { key: 'POD', icon: 'check', sub: 'Signed delivery slip' },
  { key: 'Receipt', icon: 'clipboard', sub: 'Lumper, fuel, tolls' },
  { key: 'Cargo', icon: 'package', sub: 'Load condition' },
  { key: 'Damage', icon: 'warning', sub: 'Damaged freight' },
  { key: 'Other', icon: 'more-h', sub: 'Anything else' },
] as const;

/**
 * DocumentsSheet — per-tile capture + upload.
 *
 * Each tile corresponds to one of the 6 backend DocKinds. Tapping a tile
 * launches the camera, then on capture fires onUpload(type, photoUri).
 * The parent screen routes that through useUploadDocument, which stamps
 * GPS + capturedAt + type server-side (PR #58).
 *
 * No more "save with next check-out" — each upload is its own record,
 * independently stamped with the driver's GPS and time at capture.
 */
// Shape that comes back from api.driverMobile.getLoadDocuments. Kept
// inline rather than importing from _generated because the generated
// type union would pull in all 6 string literals + UNKNOWN for context,
// which we'd just re-narrow anyway.
type LoadDocumentRow = {
  _id: string;
  type: DocKind;
  externalUrl?: string;
  capturedAt?: number;
  uploadedAt: number;
  inferredStopSequence?: number;
  inferredContext?: string;
};

function DocumentsSheet({
  visible,
  palette,
  recentUploads,
  existingDocs,
  onClose,
  onPickKind,
}: {
  visible: boolean;
  palette: Palette;
  // Sub-second tap feedback for captures made in the current session.
  // Fades into the `existingDocs` list once the server query catches up.
  recentUploads: Array<{ type: DocKind; status: 'uploading' | 'uploaded' | 'queued' | 'failed' }>;
  // Persistent list from getLoadDocuments — every document for this
  // load, ordered chronologically. Source of truth.
  existingDocs: ReadonlyArray<LoadDocumentRow>;
  onClose: () => void;
  onPickKind: (kind: DocKind) => void;
}) {
  // Newest first for visual priority — the driver cares about what
  // they just uploaded, not what ops uploaded last Tuesday.
  const sortedDocs = useMemo(
    () =>
      [...existingDocs].sort((a, b) => {
        const aT = a.capturedAt ?? a.uploadedAt;
        const bT = b.capturedAt ?? b.uploadedAt;
        return bT - aT;
      }),
    [existingDocs],
  );

  return (
    <Modal visible={visible} animationType="slide" transparent onRequestClose={onClose}>
      <TouchableWithoutFeedback onPress={Keyboard.dismiss}>
        <View style={{ flex: 1 }}>
          <SheetFrame
            palette={palette}
            onClose={onClose}
            title="Documents"
            subtitle="Tap a kind to capture — we record your GPS and time automatically."
          >
            <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 8 }}>
              {DOC_KINDS.map(({ key, icon, sub }) => (
                <Pressable
                  key={key}
                  onPress={() => onPickKind(key)}
                  style={({ pressed }) => [
                    {
                      flexBasis: '48%',
                      flexGrow: 1,
                      padding: 14,
                      borderRadius: designRadii.lg,
                      backgroundColor: palette.bgMuted,
                      borderWidth: 1,
                      borderColor: palette.borderSubtle,
                      borderStyle: 'dashed',
                      alignItems: 'center',
                      gap: 6,
                      minHeight: 92,
                      justifyContent: 'center',
                    },
                    pressed && { opacity: 0.85 },
                  ]}
                >
                  <Icon name={icon} size={22} color={palette.textSecondary} />
                  <Text style={{ fontSize: 13, fontWeight: '500', color: palette.textPrimary }}>
                    {key}
                  </Text>
                  <Text style={{ fontSize: 11, color: palette.textTertiary, textAlign: 'center' }}>
                    {sub}
                  </Text>
                </Pressable>
              ))}
            </View>

            {recentUploads.length > 0 && (
              <View style={{ gap: 6 }}>
                <Text
                  style={{
                    fontSize: 11,
                    fontWeight: '700',
                    letterSpacing: 0.8,
                    color: palette.textTertiary,
                  }}
                >
                  JUST UPLOADED
                </Text>
                {recentUploads.map((u, i) => {
                  const color =
                    u.status === 'failed'
                      ? palette.danger
                      : u.status === 'uploading'
                        ? palette.textSecondary
                        : u.status === 'queued'
                          ? palette.warning
                          : palette.success;
                  const label =
                    u.status === 'uploading'
                      ? 'Uploading…'
                      : u.status === 'queued'
                        ? 'Queued (no signal)'
                        : u.status === 'failed'
                          ? 'Failed'
                          : 'Uploaded';
                  return (
                    <View
                      key={i}
                      style={{
                        flexDirection: 'row',
                        alignItems: 'center',
                        gap: 8,
                        padding: 10,
                        borderRadius: designRadii.md,
                        backgroundColor: palette.bgMuted,
                      }}
                    >
                      <Icon
                        name={u.status === 'failed' ? 'warning' : 'check'}
                        size={14}
                        color={color}
                        strokeWidth={2.5}
                      />
                      <Text style={{ fontSize: 13, color: palette.textPrimary, flex: 1 }}>
                        {u.type}
                      </Text>
                      <Text style={{ fontSize: 12, color }}>{label}</Text>
                    </View>
                  );
                })}
              </View>
            )}

            {sortedDocs.length > 0 && (
              <View style={{ gap: 6 }}>
                <Text
                  style={{
                    fontSize: 11,
                    fontWeight: '700',
                    letterSpacing: 0.8,
                    color: palette.textTertiary,
                  }}
                >
                  ON THIS LOAD · {sortedDocs.length}
                </Text>
                {/* Cap at 6 rows to keep the sheet height sane. The full
                    history lives on ops tooling / future driver-wide
                    Documents hub; this is just for "did my last few
                    uploads land?" verification. */}
                {sortedDocs.slice(0, 6).map((doc) => (
                  <LoadDocumentRowView key={doc._id} palette={palette} doc={doc} />
                ))}
                {sortedDocs.length > 6 && (
                  <Text style={{ fontSize: 12, color: palette.textTertiary, paddingHorizontal: 4 }}>
                    +{sortedDocs.length - 6} more
                  </Text>
                )}
              </View>
            )}

            <SheetButton palette={palette} label="Done" variant="secondary" onPress={onClose} />
          </SheetFrame>
        </View>
      </TouchableWithoutFeedback>
    </Modal>
  );
}

// One row of the persistent list. Shows the doc kind, captured time,
// and the inferred context chip ("Stop 2 · At stop" / "In transit to
// stop 3" / etc.) so drivers + ops can see how the row was linked to
// the route without opening the image.
function LoadDocumentRowView({ palette, doc }: { palette: Palette; doc: LoadDocumentRow }) {
  const capturedAt = doc.capturedAt ?? doc.uploadedAt;
  const time = formatDocTime(capturedAt);
  const ctx = formatContextLabel(doc.inferredContext, doc.inferredStopSequence);

  return (
    <View
      style={{
        flexDirection: 'row',
        alignItems: 'center',
        gap: 10,
        padding: 10,
        borderRadius: designRadii.md,
        borderWidth: 1,
        borderColor: palette.borderSubtle,
      }}
    >
      <View
        style={{
          width: 32,
          height: 32,
          borderRadius: designRadii.md,
          backgroundColor: palette.bgMuted,
          alignItems: 'center',
          justifyContent: 'center',
        }}
      >
        <Icon
          name={DOC_TYPE_ICON[doc.type] ?? 'clipboard'}
          size={16}
          color={palette.textSecondary}
        />
      </View>
      <View style={{ flex: 1, minWidth: 0 }}>
        <Text style={{ fontSize: 13, fontWeight: '600', color: palette.textPrimary }}>
          {doc.type}
          {ctx && (
            <Text style={{ fontWeight: '400', color: palette.textTertiary }}>
              {` · ${ctx}`}
            </Text>
          )}
        </Text>
        <Text style={{ fontSize: 11, color: palette.textTertiary, marginTop: 2 }}>{time}</Text>
      </View>
    </View>
  );
}

// Shared with DOC_KINDS above — keeps the icon mapping authoritative
// even when the list grows.
const DOC_TYPE_ICON: Record<DocKind, string> = {
  POD: 'check',
  Receipt: 'clipboard',
  Cargo: 'package',
  Damage: 'warning',
  Accident: 'warning',
  Other: 'more-h',
};

function formatDocTime(ms: number): string {
  const d = new Date(ms);
  const now = new Date();
  const sameDay =
    d.getFullYear() === now.getFullYear() &&
    d.getMonth() === now.getMonth() &&
    d.getDate() === now.getDate();
  const timeStr = d.toLocaleTimeString(undefined, {
    hour: 'numeric',
    minute: '2-digit',
  });
  if (sameDay) return `Today · ${timeStr}`;
  const dateStr = d.toLocaleDateString(undefined, {
    month: 'short',
    day: 'numeric',
  });
  return `${dateStr} · ${timeStr}`;
}

function formatContextLabel(
  ctx: string | undefined,
  stopSeq: number | undefined,
): string | null {
  if (!ctx) return null;
  switch (ctx) {
    case 'AT_STOP':
      return stopSeq ? `At stop ${stopSeq}` : 'At stop';
    case 'IN_TRANSIT':
      return stopSeq ? `In transit to stop ${stopSeq}` : 'In transit';
    case 'BEFORE_FIRST':
      return 'Before first stop';
    case 'AFTER_LAST':
      return 'After last stop';
    case 'UNKNOWN':
    default:
      return null;
  }
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: colors.background,
  },
  loading: {
    flex: 1,
    justifyContent: 'center',
    alignItems: 'center',
    backgroundColor: colors.background,
  },
  error: {
    flex: 1,
    justifyContent: 'center',
    alignItems: 'center',
    backgroundColor: colors.background,
    padding: spacing['2xl'],
  },
  errorText: {
    color: colors.destructive,
    fontSize: 18,
    fontWeight: '600',
    marginTop: spacing.lg,
    marginBottom: spacing.xl,
  },
  backButton: {
    backgroundColor: colors.muted,
    paddingHorizontal: spacing.xl,
    paddingVertical: spacing.md,
    borderRadius: borderRadius.lg,
  },
  backButtonText: {
    color: colors.foreground,
    fontWeight: '600',
  },

  // Header
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: spacing.xl,
    paddingVertical: spacing.md,
  },
  headerBackButton: {
    width: 44,
    height: 44,
    borderRadius: borderRadius.full,
    backgroundColor: `${colors.muted}80`,
    alignItems: 'center',
    justifyContent: 'center',
  },
  headerTitle: {
    fontSize: 20,
    fontWeight: '600',
    color: colors.foreground,
  },
  headerSpacer: {
    width: 44,
  },

  // Scroll
  scrollView: {
    flex: 1,
  },
  scrollContent: {
    padding: spacing.xl,
    gap: spacing.lg,
  },

  // Offline / weak signal banners
  offlineBanner: {
    backgroundColor: colors.destructive,
    padding: spacing.md,
    borderRadius: borderRadius.lg,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: spacing.sm,
  },
  offlineText: {
    color: colors.foreground,
    fontSize: 14,
    fontWeight: '500',
  },
  weakSignalBanner: {
    backgroundColor: colors.secondary,
    padding: spacing.md,
    borderRadius: borderRadius.lg,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: spacing.sm,
  },
  weakSignalText: {
    color: colors.background,
    fontSize: 14,
    fontWeight: '600',
  },

  // Card
  card: {
    backgroundColor: colors.card,
    borderRadius: borderRadius['3xl'],
    padding: spacing.xl,
    borderWidth: 1,
    borderColor: `${colors.border}50`,
  },

  // Load ID
  loadIdRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
  },
  loadIdLeft: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.md,
  },
  loadIdLabel: {
    fontSize: 14,
    color: colors.foregroundMuted,
    fontWeight: '500',
  },
  loadIdValue: {
    fontSize: 16,
    color: colors.foreground,
    fontWeight: '600',
  },
  statusBadge: {
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.xs + 2,
    borderRadius: borderRadius.full,
  },
  statusBadgeText: {
    fontSize: 14,
    fontWeight: '600',
  },

  // Section
  sectionHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.sm,
    marginBottom: spacing.lg,
  },
  sectionTitle: {
    fontSize: 18,
    fontWeight: '600',
    color: colors.foreground,
  },
  sectionTitleSimple: {
    fontSize: 18,
    fontWeight: '600',
    color: colors.foreground,
    marginBottom: spacing.lg,
  },

  // Stops
  stopsContainer: {
    gap: 0,
  },
  stopRow: {
    flexDirection: 'row',
    gap: spacing.md,
  },
  timelineContainer: {
    alignItems: 'center',
    width: 20,
  },
  timelineDot: {
    width: 12,
    height: 12,
    borderRadius: 6,
    backgroundColor: colors.primary,
    marginTop: 4,
  },
  timelineDotCompleted: {
    backgroundColor: colors.primary,
  },
  timelineDotActive: {
    backgroundColor: colors.primary,
    width: 12,
    height: 12,
  },
  timelineDotRing: {
    position: 'absolute',
    top: -4,
    left: -4,
    right: -4,
    bottom: -4,
    borderRadius: 10,
    borderWidth: 4,
    borderColor: `${colors.primary}30`,
  },
  timelineDotFuture: {
    backgroundColor: `${colors.muted}80`,
    width: 10,
    height: 10,
  },
  timelineLine: {
    width: 2,
    flex: 1,
    backgroundColor: `${colors.muted}50`,
    marginVertical: spacing.xs,
    minHeight: 64,
  },
  timelineLineFuture: {
    backgroundColor: `${colors.muted}30`,
  },
  stopContent: {
    flex: 1,
    paddingBottom: spacing.lg,
  },
  stopContentFuture: {
    opacity: 0.5,
  },
  stopHeader: {
    marginBottom: spacing.xs,
  },
  stopLabel: {
    fontSize: 14,
    fontWeight: '700',
    color: colors.primary,
    marginBottom: spacing.xs,
  },
  stopLabelActive: {
    color: colors.primary,
  },
  stopLabelFuture: {
    color: colors.foregroundMuted,
  },
  stopName: {
    fontSize: 16,
    fontWeight: '600',
    color: colors.foreground,
    marginBottom: spacing.xs,
  },
  stopNameFuture: {
    color: colors.foreground,
  },
  stopAddress: {
    fontSize: 14,
    color: `${colors.foreground}B0`,
    marginBottom: spacing.sm,
  },
  stopAddressFuture: {
    color: colors.foregroundMuted,
  },

  // Checked badges
  checkedBadgesRow: {
    flexDirection: 'row',
    gap: spacing.sm,
    marginTop: spacing.sm,
    flexWrap: 'wrap',
  },
  checkedBadge: {
    backgroundColor: `${colors.primary}30`,
    paddingHorizontal: spacing.sm,
    paddingVertical: spacing.xs,
    borderRadius: borderRadius.md,
  },
  checkedBadgeText: {
    fontSize: 12,
    color: colors.primary,
    fontWeight: '600',
  },
  pendingSyncBadge: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.xs,
    backgroundColor: `${colors.secondary}30`,
    paddingHorizontal: spacing.sm,
    paddingVertical: spacing.xs,
    borderRadius: borderRadius.md,
  },
  pendingSyncBadgeText: {
    fontSize: 12,
    color: colors.secondary,
    fontWeight: '600',
  },
  redirectedBadge: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.xs,
    backgroundColor: `${colors.secondary}20`,
    paddingHorizontal: spacing.sm,
    paddingVertical: spacing.xs,
    borderRadius: borderRadius.md,
  },
  redirectedBadgeText: {
    fontSize: 12,
    color: colors.secondary,
    fontWeight: '600',
  },

  // GPS warming
  gpsWarmingBadge: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.sm,
    marginTop: spacing.sm,
    paddingHorizontal: spacing.sm + 2,
    paddingVertical: spacing.xs + 2,
    backgroundColor: `${colors.secondary}20`,
    borderRadius: borderRadius.md,
    alignSelf: 'flex-start',
  },
  gpsWarmingText: {
    fontSize: 13,
    color: colors.secondary,
    fontWeight: '500',
  },

  // Target time
  targetTimeBadge: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.xs,
    backgroundColor: `${colors.muted}50`,
    paddingHorizontal: spacing.sm + 2,
    paddingVertical: spacing.xs + 2,
    borderRadius: borderRadius.md,
    alignSelf: 'flex-start',
    marginTop: spacing.sm,
  },
  targetTimeBadgeActive: {
    backgroundColor: `${colors.secondary}30`,
  },
  targetTimeText: {
    fontSize: 14,
    color: colors.foregroundMuted,
  },
  targetTimeTextActive: {
    color: colors.secondary,
    fontWeight: '600',
  },

  // Check In/Out buttons
  checkInButton: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: spacing.sm,
    backgroundColor: colors.primary,
    paddingVertical: spacing.md,
    borderRadius: borderRadius.xl,
    marginTop: spacing.md,
  },
  checkInButtonText: {
    fontSize: 16,
    fontWeight: '600',
    color: colors.primaryForeground,
  },
  checkOutButton: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: spacing.sm,
    backgroundColor: colors.success,
    paddingVertical: spacing.md,
    borderRadius: borderRadius.xl,
    marginTop: spacing.md,
  },
  checkOutButtonText: {
    fontSize: 16,
    fontWeight: '600',
    color: colors.foreground,
  },

  // Contact
  contactRow: {
    flexDirection: 'row',
    alignItems: 'center',
  },
  contactAvatar: {
    width: 48,
    height: 48,
    borderRadius: 24,
    backgroundColor: colors.muted,
    alignItems: 'center',
    justifyContent: 'center',
    borderWidth: 2,
    borderColor: colors.border,
  },
  contactInfo: {
    flex: 1,
    marginLeft: spacing.md,
  },
  contactName: {
    fontSize: 16,
    fontWeight: '600',
    color: colors.foreground,
  },
  contactRole: {
    fontSize: 14,
    color: colors.foregroundMuted,
  },
  callButton: {
    width: 44,
    height: 44,
    borderRadius: 22,
    backgroundColor: `${colors.muted}80`,
    alignItems: 'center',
    justifyContent: 'center',
  },

  // Instructions
  instructionsRow: {
    flexDirection: 'row',
    gap: spacing.md,
  },
  instructionsIcon: {
    width: 40,
    height: 40,
    borderRadius: borderRadius.xl,
    backgroundColor: `${colors.secondary}15`,
    alignItems: 'center',
    justifyContent: 'center',
  },
  instructionsText: {
    flex: 1,
    fontSize: 16,
    color: colors.cardForeground,
    lineHeight: 24,
  },

  // Bottom bar — fixed at bottom, outside ScrollView
  bottomBar: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.md,
    paddingTop: spacing.md,
    paddingHorizontal: spacing.lg,
    backgroundColor: colors.background,
    borderTopWidth: 1,
    borderTopColor: `${colors.border}50`,
  },
  menuButton: {
    width: 56,
    height: 56,
    borderRadius: borderRadius['2xl'],
    backgroundColor: `${colors.muted}80`,
    alignItems: 'center',
    justifyContent: 'center',
  },
  completeButton: {
    flex: 1,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: spacing.sm + 2,
    backgroundColor: colors.muted,
    paddingVertical: spacing.lg,
    borderRadius: borderRadius['2xl'],
  },
  completeButtonText: {
    fontSize: 18,
    fontWeight: '700',
    color: colors.foreground,
  },

  // Quick Actions Modal
  quickActionsOverlay: {
    flex: 1,
    justifyContent: 'flex-end',
  },
  quickActionsBackdrop: {
    ...StyleSheet.absoluteFillObject,
    backgroundColor: `${colors.background}E0`,
  },
  quickActionsSheet: {
    backgroundColor: colors.card,
    borderTopLeftRadius: borderRadius['3xl'],
    borderTopRightRadius: borderRadius['3xl'],
    padding: spacing['2xl'],
    paddingBottom: spacing['2xl'] + 20,
    borderTopWidth: 1,
    borderColor: `${colors.border}50`,
  },
  sheetHandle: {
    width: 40,
    height: 4,
    backgroundColor: colors.muted,
    borderRadius: 2,
    alignSelf: 'center',
    marginBottom: spacing.xl,
  },
  quickActionsHeader: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    justifyContent: 'space-between',
    marginBottom: spacing.xl,
  },
  quickActionsTitle: {
    fontSize: 22,
    fontWeight: '700',
    color: colors.foreground,
    marginBottom: spacing.xs,
  },
  quickActionsSubtitle: {
    fontSize: 14,
    color: colors.foregroundMuted,
  },
  quickActionsCloseBtn: {
    width: 32,
    height: 32,
    borderRadius: 16,
    backgroundColor: colors.muted,
    alignItems: 'center',
    justifyContent: 'center',
  },
  quickActionsGrid: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: spacing.md,
    marginBottom: spacing.xl,
  },
  quickActionItem: {
    width: '48%',
    alignItems: 'center',
    justifyContent: 'center',
    gap: spacing.md,
    backgroundColor: colors.background,
    paddingVertical: spacing.xl,
    borderRadius: borderRadius['2xl'],
    borderWidth: 1,
    borderColor: `${colors.border}30`,
  },
  quickActionIconContainer: {
    width: 52,
    height: 52,
    borderRadius: 26,
    backgroundColor: `${colors.primary}25`,
    alignItems: 'center',
    justifyContent: 'center',
  },
  quickActionLabel: {
    fontSize: 14,
    fontWeight: '600',
    color: colors.foreground,
  },
  quickActionItemDisabled: {
    opacity: 0.5,
  },
  quickActionIconContainerDisabled: {
    backgroundColor: `${colors.muted}50`,
  },
  quickActionLabelDisabled: {
    color: colors.foregroundMuted,
  },
  quickActionsBottomSection: {
    gap: spacing.md,
  },
  quickActionRowItem: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    backgroundColor: colors.background,
    paddingHorizontal: spacing.lg,
    paddingVertical: spacing.md + 2,
    borderRadius: borderRadius.xl,
    borderWidth: 1,
    borderColor: `${colors.border}30`,
  },
  quickActionRowLeft: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.md,
  },
  quickActionRowIcon: {
    width: 36,
    height: 36,
    borderRadius: 18,
    alignItems: 'center',
    justifyContent: 'center',
  },
  quickActionRowIconRed: {
    backgroundColor: `${colors.destructive}20`,
  },
  quickActionRowIconYellow: {
    backgroundColor: `${colors.secondary}20`,
  },
  quickActionRowIconOrange: {
    backgroundColor: `${colors.primary}20`,
  },
  quickActionRowLabel: {
    fontSize: 15,
    fontWeight: '600',
  },
  quickActionRowLabelRed: {
    color: colors.destructive,
  },
  quickActionRowLabelYellow: {
    color: colors.secondary,
  },
  quickActionRowLabelOrange: {
    color: colors.primary,
  },

  // Check-in Modal
  modalOverlay: {
    flex: 1,
    justifyContent: 'flex-end',
  },
  modalBackdrop: {
    ...StyleSheet.absoluteFillObject,
    backgroundColor: `${colors.background}B0`,
  },
  modalContent: {
    backgroundColor: colors.card,
    borderTopLeftRadius: borderRadius['3xl'],
    borderTopRightRadius: borderRadius['3xl'],
    padding: spacing['2xl'],
    paddingBottom: spacing['2xl'] + 10,
  },
  modalHeader: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'flex-start',
    marginBottom: spacing.xl,
  },
  modalHeaderText: {
    flex: 1,
    marginRight: spacing.md,
  },
  modalTitle: {
    fontSize: Platform.OS === 'ios' ? 20 : 24,
    fontWeight: '700',
    color: colors.foreground,
    marginBottom: spacing.xs,
  },
  modalSubtitle: {
    fontSize: 15,
    color: colors.foregroundMuted,
  },
  modalCancelButton: {
    backgroundColor: `${colors.destructive}20`,
    paddingHorizontal: spacing.lg,
    paddingVertical: spacing.sm,
    borderRadius: borderRadius.full,
  },
  modalCancelButtonText: {
    color: colors.destructive,
    fontSize: 15,
    fontWeight: '600',
  },
  redirectToggleRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    backgroundColor: colors.background,
    padding: spacing.lg,
    borderRadius: borderRadius['2xl'],
    marginBottom: spacing.sm,
  },
  redirectToggleLeft: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.sm,
  },
  redirectToggleLabel: {
    color: colors.foreground,
    fontSize: 15,
    fontWeight: '600',
  },
  redirectBanner: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    gap: spacing.sm,
    backgroundColor: `${colors.secondary}15`,
    padding: spacing.md,
    borderRadius: borderRadius.lg,
    marginBottom: spacing.sm,
  },
  redirectBannerText: {
    flex: 1,
    color: colors.secondary,
    fontSize: 13,
    lineHeight: 18,
  },
  modalPhotoRow: {
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: colors.background,
    padding: spacing.lg,
    borderRadius: borderRadius['2xl'],
    marginBottom: spacing.md,
    borderWidth: 1,
    borderColor: `${colors.border}30`,
  },
  modalPhotoIconContainer: {
    width: 48,
    height: 48,
    borderRadius: borderRadius.lg,
    backgroundColor: `${colors.primary}25`,
    alignItems: 'center',
    justifyContent: 'center',
    marginRight: spacing.md,
  },
  modalPhotoTextContainer: {
    flex: 1,
  },
  modalPhotoTitle: {
    fontSize: 16,
    fontWeight: '600',
    color: colors.foreground,
    marginBottom: 2,
  },
  modalPhotoSubtitle: {
    fontSize: 14,
    color: colors.foregroundMuted,
  },
  modalPhotoThumbnail: {
    width: 48,
    height: 48,
    borderRadius: borderRadius.lg,
    marginRight: spacing.md,
    backgroundColor: colors.muted,
  },
  modalPhotoAttachedRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.xs,
    marginBottom: 2,
  },
  modalPhotoRemoveButton: {
    padding: spacing.xs,
  },
  modalNoteSection: {
    backgroundColor: colors.background,
    padding: spacing.lg,
    borderRadius: borderRadius['2xl'],
    marginBottom: spacing.xl,
    borderWidth: 1,
    borderColor: `${colors.border}30`,
  },
  modalNoteLabelRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.sm,
    marginBottom: spacing.md,
  },
  modalNoteLabel: {
    fontSize: 15,
    fontWeight: '600',
    color: colors.foreground,
  },
  modalNoteInputRow: {
    flexDirection: 'row',
    alignItems: 'flex-end',
    gap: spacing.sm,
  },
  modalNoteInput: {
    flex: 1,
    backgroundColor: colors.muted,
    borderRadius: borderRadius.lg,
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.md,
    color: colors.foreground,
    fontSize: 14,
    minHeight: 44,
    maxHeight: 100,
  },
  modalNoteActionButton: {
    width: 44,
    height: 44,
    borderRadius: borderRadius.lg,
    alignItems: 'center',
    justifyContent: 'center',
  },
  modalNoteSendButton: {
    backgroundColor: colors.muted,
  },
  modalNoteVoiceButton: {
    backgroundColor: `${colors.secondary}20`,
  },
  modalCompleteButton: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: spacing.sm,
    backgroundColor: colors.primary,
    paddingVertical: spacing.lg + 2,
    borderRadius: borderRadius['2xl'],
    marginBottom: spacing.lg,
  },
  modalCompleteButtonDisabled: {
    backgroundColor: colors.muted,
  },
  modalCompleteButtonText: {
    fontSize: 18,
    fontWeight: '700',
    color: colors.primaryForeground,
  },
  modalGpsNotice: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: spacing.xs,
  },
  modalGpsNoticeText: {
    fontSize: 14,
    color: colors.foregroundMuted,
  },

  // Detour Modal
  detourModalOverlay: {
    flex: 1,
    justifyContent: 'flex-end',
  },
  detourModalBackdrop: {
    ...StyleSheet.absoluteFillObject,
    backgroundColor: `${colors.background}E0`,
  },
  detourModalSheet: {
    backgroundColor: colors.card,
    borderTopLeftRadius: borderRadius['3xl'],
    borderTopRightRadius: borderRadius['3xl'],
    padding: spacing['2xl'],
    paddingBottom: spacing['2xl'] + 20,
    borderTopWidth: 1,
    borderColor: `${colors.border}50`,
  },
  detourModalHeader: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    justifyContent: 'space-between',
    marginBottom: spacing.xl,
  },
  detourModalTitle: {
    fontSize: 24,
    fontWeight: '700',
    color: colors.foreground,
    marginBottom: spacing.xs,
  },
  detourModalSubtitle: {
    fontSize: 15,
    color: colors.foregroundMuted,
  },
  detourModalCloseBtn: {
    width: 32,
    height: 32,
    borderRadius: 16,
    backgroundColor: colors.muted,
    alignItems: 'center',
    justifyContent: 'center',
  },
  detourStopsCard: {
    backgroundColor: colors.background,
    borderRadius: borderRadius['2xl'],
    padding: spacing.xl,
    alignItems: 'center',
    marginBottom: spacing.lg,
    borderWidth: 1,
    borderColor: `${colors.border}30`,
  },
  detourStopsLabel: {
    fontSize: 13,
    fontWeight: '600',
    color: colors.foregroundMuted,
    letterSpacing: 1,
    marginBottom: spacing.lg,
  },
  detourStopsRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: spacing['2xl'],
  },
  detourStopsButton: {
    width: 48,
    height: 48,
    borderRadius: borderRadius.lg,
    backgroundColor: colors.primary,
    alignItems: 'center',
    justifyContent: 'center',
  },
  detourStopsButtonDisabled: {
    backgroundColor: colors.muted,
  },
  detourStopsCountContainer: {
    alignItems: 'center',
  },
  detourStopsCount: {
    fontSize: 48,
    fontWeight: '700',
    color: colors.primary,
    lineHeight: 56,
  },
  detourStopsTotalLabel: {
    fontSize: 12,
    fontWeight: '600',
    color: colors.foregroundMuted,
    letterSpacing: 0.5,
  },
  detourReasonRow: {
    flexDirection: 'row',
    gap: spacing.sm,
    paddingHorizontal: spacing.sm,
  },
  detourReasonChip: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.sm + 2,
    borderRadius: borderRadius.full,
    backgroundColor: colors.muted,
    borderWidth: 1,
    borderColor: `${colors.border}30`,
  },
  detourReasonChipActive: {
    backgroundColor: colors.primary,
    borderColor: colors.primary,
  },
  detourReasonChipText: {
    fontSize: 14,
    fontWeight: '600',
    color: colors.foregroundMuted,
  },
  detourReasonChipTextActive: {
    color: colors.primaryForeground,
  },
  detourNotesInput: {
    backgroundColor: colors.background,
    borderRadius: borderRadius['2xl'],
    padding: spacing.lg,
    fontSize: 15,
    color: colors.foreground,
    borderWidth: 1,
    borderColor: `${colors.border}30`,
    marginBottom: spacing.lg,
    minHeight: 56,
    textAlignVertical: 'top',
  },
  detourGpsCard: {
    backgroundColor: colors.background,
    borderRadius: borderRadius['2xl'],
    padding: spacing.lg,
    flexDirection: 'row',
    gap: spacing.md,
    marginBottom: spacing.xl,
    borderWidth: 1,
    borderColor: `${colors.border}30`,
  },
  detourGpsIconContainer: {
    width: 44,
    height: 44,
    borderRadius: borderRadius.lg,
    backgroundColor: `${colors.primary}25`,
    alignItems: 'center',
    justifyContent: 'center',
  },
  detourGpsTextContainer: {
    flex: 1,
  },
  detourGpsTitle: {
    fontSize: 16,
    fontWeight: '600',
    color: colors.foreground,
    marginBottom: spacing.xs,
  },
  detourGpsDescription: {
    fontSize: 14,
    color: colors.foregroundMuted,
    lineHeight: 20,
    marginBottom: spacing.md,
  },
  detourGpsBold: {
    fontWeight: '700',
    color: colors.foreground,
  },
  detourGpsBadgesRow: {
    flexDirection: 'row',
    gap: spacing.lg,
  },
  detourGpsBadge: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.sm,
  },
  detourGpsBadgeDot: {
    width: 8,
    height: 8,
    borderRadius: 4,
  },
  detourGpsBadgeDotGreen: {
    backgroundColor: colors.success,
  },
  detourGpsBadgeDotBlue: {
    backgroundColor: '#3b82f6',
  },
  detourGpsBadgeText: {
    fontSize: 13,
    color: colors.foregroundMuted,
  },
  detourConfirmButton: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: spacing.sm,
    backgroundColor: colors.primary,
    paddingVertical: spacing.lg + 2,
    borderRadius: borderRadius['2xl'],
    marginBottom: spacing.md,
  },
  detourConfirmButtonText: {
    fontSize: 18,
    fontWeight: '700',
    color: colors.primaryForeground,
  },
  detourCancelButton: {
    alignItems: 'center',
    justifyContent: 'center',
    paddingVertical: spacing.md,
  },
  detourCancelButtonText: {
    fontSize: 16,
    fontWeight: '600',
    color: colors.foreground,
  },
});
