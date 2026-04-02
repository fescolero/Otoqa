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
} from 'react-native';
import { useLocalSearchParams, useRouter, Stack } from 'expo-router';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { Ionicons, MaterialCommunityIcons } from '@expo/vector-icons';
import * as ImagePicker from 'expo-image-picker';
import { useLoadDetail } from '../../../lib/hooks/useLoadDetail';
import { useCheckIn } from '../../../lib/hooks/useCheckIn';
import { useGPSLocation } from '../../../lib/hooks/useGPSLocation';
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
import { getTotalCountForLoad, getUnsyncedCountForLoad } from '../../../lib/location-db';
import { useMutation } from 'convex/react';
import { api } from '../../../../convex/_generated/api';
import { AppState } from 'react-native';

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
  const { connectionQuality } = useNetworkStatus();
  const { isWarming: isGPSWarming, getFreshLocation } = useGPSLocation();
  const { checkIn, checkOut } = useCheckIn(getFreshLocation);
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
  const [showQuickActions, setShowQuickActions] = useState(false);
  const [showDetourModal, setShowDetourModal] = useState(false);
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
    totalPoints: number;
    unsyncedPoints: number;
    loadId: string | null;
  } | null>(null);

  // Track whether we should retry starting tracking on foreground return
  // (e.g., after the driver grants "Always" permission in Settings)
  const pendingTrackingRetry = useRef(false);

  useEffect(() => {
    if (!id) return;
    let cancelled = false;
    const refresh = async () => {
      try {
        const state = await getTrackingState();
        const total = await getTotalCountForLoad(id);
        const unsynced = await getUnsyncedCountForLoad(id);
        if (!cancelled) {
          setTrackingDebug({
            isActive: state?.isActive ?? false,
            totalPoints: total,
            unsyncedPoints: unsynced,
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

  // Open maps for navigation
  const openMaps = (address: string, city?: string, state?: string) => {
    const query = encodeURIComponent(`${address}, ${city || ''} ${state || ''}`);
    const url = `https://maps.apple.com/?q=${query}`;
    Linking.openURL(url);
  };

  // Handle check-in
  const handleCheckIn = async (stopId: Id<'loadStops'>) => {
    setCheckInModal({ visible: true, stopId, type: 'in' });
  };

  // Handle check-out
  const handleCheckOut = async (stopId: Id<'loadStops'>) => {
    setCheckInModal({ visible: true, stopId, type: 'out' });
  };

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
        Alert.alert('Error', result.message);
      }
    } catch (error: any) {
      const errorMessage = error?.message || 'Unknown error';
      posthog?.capture(`${actionType}_exception`, {
        loadId: id,
        stopId: checkInModal.type === 'out' ? (activeCheckedInStop?._id ?? checkInModal.stopId) : checkInModal.stopId,
        error: errorMessage,
        stack: error?.stack,
      });
      Alert.alert('Error', 'Failed to submit. Please try again.');
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

  // Format date and time together
  const formatDateTime = (dateStr?: string, timeStr?: string) => {
    if (!dateStr && !timeStr) return null;
    try {
      const dateObj = dateStr ? new Date(dateStr) : null;
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
          : dateObj && !isNaN(dateObj.getTime())
            ? dateObj.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit', hour12: true })
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
        <Pressable style={styles.backButton} onPress={() => router.back()}>
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
        <Pressable style={styles.backButton} onPress={() => router.back()}>
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

      <View style={[styles.container, { paddingTop: insets.top }]}>
        {/* Header */}
        <View style={styles.header}>
          <Pressable style={styles.headerBackButton} onPress={() => router.back()}>
            <Ionicons name="arrow-back" size={24} color={colors.foreground} />
          </Pressable>
          <Text style={styles.headerTitle}>Load Details</Text>
          <View style={styles.headerSpacer} />
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
                GPS {trackingDebug.isActive ? 'ON' : 'OFF'} · {trackingDebug.totalPoints} pts ·{' '}
                {trackingDebug.unsyncedPoints} pending
              </Text>
            </View>
          )}

          {/* Load ID Card */}
          <View style={styles.card}>
            <View style={styles.loadIdRow}>
              <View style={styles.loadIdLeft}>
                <MaterialCommunityIcons name="steering" size={20} color={colors.foregroundMuted} />
                <View>
                  <Text style={styles.loadIdLabel}>Load ID</Text>
                  <Text style={styles.loadIdValue}>#{load.internalId}</Text>
                </View>
              </View>
              <View style={[styles.statusBadge, { backgroundColor: `${statusDisplay.color}20` }]}>
                <Text style={[styles.statusBadgeText, { color: statusDisplay.color }]}>{statusDisplay.text}</Text>
              </View>
            </View>
          </View>

          {/* Route Details */}
          <View style={styles.card}>
            <View style={styles.sectionHeader}>
              <Ionicons name="location" size={20} color={colors.primary} />
              <Text style={styles.sectionTitle}>Route Details</Text>
            </View>

            <View style={styles.stopsContainer}>
              {displayStops.map((stop: any, index: number) => {
                const isPickup = stop.stopType === 'PICKUP';
                const isCompleted = stop.status === 'Completed' || !!stop.checkedOutAt;
                const isCheckedIn = !!stop.checkedInAt && !stop.checkedOutAt;
                const isCurrent = index === currentStopIndex;
                const isFuture = index > currentStopIndex && currentStopIndex !== -1;
                const isLast = index === displayStops.length - 1;
                const isPendingSync = !!(stop as any).pendingSync;

                return (
                  <View key={stop._id} style={styles.stopRow}>
                    {/* Timeline indicator */}
                    <View style={styles.timelineContainer}>
                      <View
                        style={[
                          styles.timelineDot,
                          isCompleted && styles.timelineDotCompleted,
                          isCurrent && styles.timelineDotActive,
                          isFuture && styles.timelineDotFuture,
                        ]}
                      >
                        {isCurrent && <View style={styles.timelineDotRing} />}
                      </View>
                      {!isLast && <View style={[styles.timelineLine, isFuture && styles.timelineLineFuture]} />}
                    </View>

                    {/* Stop content */}
                    <View style={[styles.stopContent, isFuture && styles.stopContentFuture]}>
                      <View style={styles.stopHeader}>
                        <Text
                          style={[
                            styles.stopLabel,
                            isCurrent && styles.stopLabelActive,
                            isFuture && styles.stopLabelFuture,
                          ]}
                        >
                          Stop {stop.sequenceNumber} -{' '}
                          {isPickup ? 'Pickup' : index === stops.length - 1 ? 'Final Delivery' : 'Delivery'}
                        </Text>
                      </View>

                      <Text style={[styles.stopName, isFuture && styles.stopNameFuture]}>
                        {stop.locationName || `${stop.city}, ${stop.state}`}
                      </Text>

                      <Text style={[styles.stopAddress, isFuture && styles.stopAddressFuture]}>
                        {stop.address}
                        {stop.city ? `, ${stop.city}` : ''}
                        {stop.state ? `, ${stop.state}` : ''} {stop.postalCode || ''}
                      </Text>

                      {/* Checked In/Out badges for completed stops */}
                      {(stop.checkedInAt || stop.checkedOutAt) && (
                        <View style={styles.checkedBadgesRow}>
                          {stop.checkedInAt && (
                            <View style={styles.checkedBadge}>
                              <Text style={styles.checkedBadgeText} maxFontSizeMultiplier={1.2}>
                                Checked In: {formatCheckedTime(stop.checkedInAt)}
                              </Text>
                            </View>
                          )}
                          {stop.checkedOutAt && (
                            <View style={styles.checkedBadge}>
                              <Text style={styles.checkedBadgeText} maxFontSizeMultiplier={1.2}>
                                Checked Out: {formatCheckedTime(stop.checkedOutAt)}
                              </Text>
                            </View>
                          )}
                          {isPendingSync && (
                            <View style={styles.pendingSyncBadge}>
                              <Ionicons name="sync" size={10} color={colors.secondary} />
                              <Text style={styles.pendingSyncBadgeText} maxFontSizeMultiplier={1.2}>
                                Pending sync
                              </Text>
                            </View>
                          )}
                          {stop.isRedirected && (
                            <View style={styles.redirectedBadge}>
                              <Ionicons name="swap-horizontal" size={10} color={colors.secondary} />
                              <Text style={styles.redirectedBadgeText} maxFontSizeMultiplier={1.2}>
                                Redirected
                              </Text>
                            </View>
                          )}
                        </View>
                      )}

                      {/* Target time for current/future stops */}
                      {!isCompleted && (
                        <View style={[styles.targetTimeBadge, isCurrent && styles.targetTimeBadgeActive]}>
                          <Ionicons
                            name="time"
                            size={14}
                            color={isCurrent ? colors.secondary : colors.foregroundMuted}
                          />
                          <Text style={[styles.targetTimeText, isCurrent && styles.targetTimeTextActive]}>
                            Target: {formatDateTime(stop.windowBeginDate, stop.windowBeginTime) || 'TBD'}
                          </Text>
                        </View>
                      )}

                      {/* GPS warming indicator */}
                      {isCurrent && !isCheckedIn && isGPSWarming && (
                        <View style={styles.gpsWarmingBadge}>
                          <ActivityIndicator size="small" color={colors.secondary} />
                          <Text style={styles.gpsWarmingText}>Acquiring GPS...</Text>
                        </View>
                      )}

                      {/* Check In button for current stop */}
                      {isCurrent && !isCheckedIn && (
                        <Pressable
                          style={({ pressed }) => [styles.checkInButton, pressed && { opacity: 0.8 }]}
                          onPress={() => handleCheckIn(stop._id)}
                        >
                          <Ionicons name="log-in" size={20} color={colors.primaryForeground} />
                          <Text style={styles.checkInButtonText}>Check In</Text>
                        </Pressable>
                      )}

                      {/* Check Out button only for the active checked-in stop */}
                      {isCurrent && isCheckedIn && (
                        <Pressable
                          style={({ pressed }) => [styles.checkOutButton, pressed && { opacity: 0.8 }]}
                          onPress={() => {
                            handleCheckOut(stop._id);
                          }}
                        >
                          <Ionicons name="log-out" size={20} color={colors.foreground} />
                          <Text style={styles.checkOutButtonText}>Check Out</Text>
                        </Pressable>
                      )}
                    </View>
                  </View>
                );
              })}
            </View>
          </View>

          {/* Contact Information */}
          {load.contactPersonName && (
            <View style={styles.card}>
              <Text style={styles.sectionTitleSimple}>Contact Information</Text>
              <View style={styles.contactRow}>
                <View style={styles.contactAvatar}>
                  <Ionicons name="person" size={24} color={colors.foregroundMuted} />
                </View>
                <View style={styles.contactInfo}>
                  <Text style={styles.contactName}>{load.contactPersonName}</Text>
                  <Text style={styles.contactRole}>
                    {load.customerName ? `Site Manager • ${load.customerName}` : 'Site Contact'}
                  </Text>
                </View>
                {load.contactPersonPhone && (
                  <Pressable
                    style={styles.callButton}
                    onPress={() => Linking.openURL(`tel:${load.contactPersonPhone}`)}
                  >
                    <Ionicons name="call" size={24} color={colors.primary} />
                  </Pressable>
                )}
              </View>
            </View>
          )}

          {/* Special Instructions */}
          {load.generalInstructions && (
            <View style={styles.card}>
              <Text style={styles.sectionTitleSimple}>Special Instructions</Text>
              <View style={styles.instructionsRow}>
                <View style={styles.instructionsIcon}>
                  <Ionicons name="document-text" size={20} color={colors.secondary} />
                </View>
                <Text style={styles.instructionsText}>{load.generalInstructions}</Text>
              </View>
            </View>
          )}
        </ScrollView>

        {/* Bottom Action Bar — fixed at bottom, outside ScrollView */}
        <View
          style={[
            styles.bottomBar,
            { paddingBottom: insets.bottom + (Platform.OS === 'ios' ? spacing.sm : spacing.lg) },
          ]}
        >
          <Pressable
            style={({ pressed }) => [styles.menuButton, pressed && { opacity: 0.8 }]}
            onPress={() => setShowQuickActions(true)}
          >
            <Ionicons name="ellipsis-horizontal" size={24} color={colors.foreground} />
          </Pressable>
          <Pressable style={({ pressed }) => [styles.completeButton, pressed && { opacity: 0.8 }]}>
            <Ionicons name="checkmark-circle" size={24} color={colors.foreground} />
            <Text style={styles.completeButtonText}>Complete Load</Text>
          </Pressable>
        </View>

        {/* Quick Actions Modal */}
        <Modal
          visible={showQuickActions}
          animationType="slide"
          transparent
          onRequestClose={() => setShowQuickActions(false)}
        >
          <View style={styles.quickActionsOverlay}>
            <Pressable style={styles.quickActionsBackdrop} onPress={() => setShowQuickActions(false)} />
            <View style={styles.quickActionsSheet}>
              <View style={styles.sheetHandle} />

              {/* Header */}
              <View style={styles.quickActionsHeader}>
                <View>
                  <Text style={styles.quickActionsTitle}>Quick Actions</Text>
                  <Text style={styles.quickActionsSubtitle}>Available tasks for this load</Text>
                </View>
                <Pressable style={styles.quickActionsCloseBtn} onPress={() => setShowQuickActions(false)}>
                  <Ionicons name="close" size={18} color={colors.foregroundMuted} />
                </Pressable>
              </View>

              {/* Action Grid */}
              <View style={styles.quickActionsGrid}>
                <Pressable
                  style={styles.quickActionItem}
                  onPress={() => {
                    setShowQuickActions(false);
                    const targetStop = displayStops[currentStopIndex] || displayStops[0];
                    if (targetStop) {
                      openMaps(targetStop.address, targetStop.city, targetStop.state);
                    }
                  }}
                >
                  <View style={styles.quickActionIconContainer}>
                    <Ionicons name="navigate" size={26} color={colors.primary} />
                  </View>
                  <Text style={styles.quickActionLabel}>Navigate</Text>
                </Pressable>

                <Pressable style={[styles.quickActionItem, styles.quickActionItemDisabled]} disabled={true}>
                  <View style={[styles.quickActionIconContainer, styles.quickActionIconContainerDisabled]}>
                    <Ionicons name="call" size={26} color={colors.foregroundMuted} />
                  </View>
                  <Text style={[styles.quickActionLabel, styles.quickActionLabelDisabled]}>Call Site</Text>
                </Pressable>

                <Pressable style={styles.quickActionItem}>
                  <View style={styles.quickActionIconContainer}>
                    <Ionicons name="document-text" size={26} color={colors.primary} />
                  </View>
                  <Text style={styles.quickActionLabel}>Documents</Text>
                </Pressable>

                <Pressable
                  style={styles.quickActionItem}
                  onPress={() => {
                    setShowQuickActions(false);
                    setShowDetourModal(true);
                  }}
                >
                  <View style={styles.quickActionIconContainer}>
                    <Ionicons name="git-branch" size={26} color={colors.primary} />
                  </View>
                  <Text style={styles.quickActionLabel}>Add Detour</Text>
                </Pressable>
              </View>

              {/* Bottom Actions */}
              <View style={styles.quickActionsBottomSection}>
                <Pressable style={styles.quickActionRowItem}>
                  <View style={styles.quickActionRowLeft}>
                    <View style={[styles.quickActionRowIcon, styles.quickActionRowIconRed]}>
                      <Ionicons name="alert-circle" size={20} color={colors.destructive} />
                    </View>
                    <Text style={[styles.quickActionRowLabel, styles.quickActionRowLabelRed]}>Report an Issue</Text>
                  </View>
                  <Ionicons name="arrow-forward" size={20} color={colors.destructive} />
                </Pressable>

                <Pressable style={styles.quickActionRowItem}>
                  <View style={styles.quickActionRowLeft}>
                    <View style={[styles.quickActionRowIcon, styles.quickActionRowIconOrange]}>
                      <Ionicons name="share-social" size={20} color={colors.primary} />
                    </View>
                    <Text style={[styles.quickActionRowLabel, styles.quickActionRowLabelOrange]}>Share Status</Text>
                  </View>
                  <Ionicons name="arrow-forward" size={20} color={colors.primary} />
                </Pressable>
              </View>
            </View>
          </View>
        </Modal>

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

        {/* Add Detour Modal */}
        <Modal
          visible={showDetourModal}
          animationType="slide"
          transparent
          onRequestClose={() => setShowDetourModal(false)}
        >
          <TouchableWithoutFeedback onPress={Keyboard.dismiss}>
            <View style={styles.detourModalOverlay}>
              <Pressable style={styles.detourModalBackdrop} onPress={() => setShowDetourModal(false)} />
              <KeyboardAvoidingView behavior={Platform.OS === 'ios' ? 'padding' : undefined}>
                <View style={styles.detourModalSheet}>
                  <View style={styles.sheetHandle} />

                  {/* Header */}
                  <View style={styles.detourModalHeader}>
                    <View>
                      <Text style={styles.detourModalTitle}>Add Detour</Text>
                      <Text style={styles.detourModalSubtitle}>Log an unplanned stop on your route</Text>
                    </View>
                    <Pressable style={styles.detourModalCloseBtn} onPress={() => setShowDetourModal(false)}>
                      <Ionicons name="close" size={16} color={colors.foreground} />
                    </Pressable>
                  </View>

                  {/* Reason Picker */}
                  <View style={styles.detourStopsCard}>
                    <Text style={styles.detourStopsLabel}>REASON</Text>
                    <ScrollView
                      horizontal
                      showsHorizontalScrollIndicator={false}
                      style={{ marginHorizontal: -spacing.sm }}
                    >
                      <View style={styles.detourReasonRow}>
                        {(
                          [
                            { key: 'FUEL', icon: 'flame-outline' as const, label: 'Fuel' },
                            { key: 'REST', icon: 'bed-outline' as const, label: 'Rest' },
                            { key: 'FOOD', icon: 'restaurant-outline' as const, label: 'Food' },
                            { key: 'SCALE', icon: 'speedometer-outline' as const, label: 'Scale' },
                            { key: 'REPAIR', icon: 'build-outline' as const, label: 'Repair' },
                            { key: 'REDIRECT', icon: 'swap-horizontal-outline' as const, label: 'Redirect' },
                            { key: 'CUSTOMER', icon: 'people-outline' as const, label: 'Customer' },
                            { key: 'OTHER', icon: 'ellipsis-horizontal-outline' as const, label: 'Other' },
                          ] as const
                        ).map((item) => (
                          <Pressable
                            key={item.key}
                            style={[
                              styles.detourReasonChip,
                              detourReason === item.key && styles.detourReasonChipActive,
                            ]}
                            onPress={() => setDetourReason(item.key)}
                          >
                            <Ionicons
                              name={item.icon}
                              size={18}
                              color={detourReason === item.key ? colors.primaryForeground : colors.foregroundMuted}
                            />
                            <Text
                              style={[
                                styles.detourReasonChipText,
                                detourReason === item.key && styles.detourReasonChipTextActive,
                              ]}
                            >
                              {item.label}
                            </Text>
                          </Pressable>
                        ))}
                      </View>
                    </ScrollView>
                  </View>

                  {/* Number of Stops Selector */}
                  <View style={styles.detourStopsCard}>
                    <Text style={styles.detourStopsLabel}>NUMBER OF STOPS</Text>
                    <View style={styles.detourStopsRow}>
                      <Pressable
                        style={[styles.detourStopsButton, detourStops <= 1 && styles.detourStopsButtonDisabled]}
                        onPress={() => setDetourStops(Math.max(1, detourStops - 1))}
                        disabled={detourStops <= 1}
                      >
                        <Ionicons
                          name="remove"
                          size={24}
                          color={detourStops <= 1 ? colors.foregroundMuted : colors.foreground}
                        />
                      </Pressable>

                      <View style={styles.detourStopsCountContainer}>
                        <Text style={styles.detourStopsCount}>{detourStops.toString().padStart(2, '0')}</Text>
                        <Text style={styles.detourStopsTotalLabel}>STOPS</Text>
                      </View>

                      <Pressable style={styles.detourStopsButton} onPress={() => setDetourStops(detourStops + 1)}>
                        <Ionicons name="add" size={24} color={colors.primaryForeground} />
                      </Pressable>
                    </View>
                  </View>

                  {/* Notes (optional) */}
                  <TextInput
                    style={styles.detourNotesInput}
                    placeholder="Add notes (optional)"
                    placeholderTextColor={colors.foregroundMuted}
                    value={detourNotes}
                    onChangeText={setDetourNotes}
                    multiline
                    numberOfLines={2}
                    maxLength={200}
                  />

                  {/* GPS Info */}
                  <View style={styles.detourGpsCard}>
                    <View style={styles.detourGpsIconContainer}>
                      <Ionicons name="locate" size={22} color={colors.primary} />
                    </View>
                    <View style={styles.detourGpsTextContainer}>
                      <Text style={styles.detourGpsTitle}>GPS Auto-Logged</Text>
                      <Text style={styles.detourGpsDescription}>
                        Your current location and <Text style={styles.detourGpsBold}>check-in/out</Text> times will be
                        recorded automatically.
                      </Text>
                    </View>
                  </View>

                  {/* Confirm Button */}
                  <Pressable
                    style={({ pressed }) => [
                      styles.detourConfirmButton,
                      pressed && { opacity: 0.8 },
                      isAddingDetour && { opacity: 0.6 },
                    ]}
                    disabled={isAddingDetour}
                    onPress={async () => {
                      setIsAddingDetour(true);
                      try {
                        // Get fresh GPS for the detour location
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

                        const result = await addDetourStopsMutation({
                          loadId: id as Id<'loadInformation'>,
                          driverId,
                          numberOfStops: detourStops,
                          reason: detourReason,
                          notes: detourNotes || undefined,
                          latitude: loc.latitude,
                          longitude: loc.longitude,
                          driverTimestamp: new Date().toISOString(),
                        });

                        posthog?.capture('detour_confirmed', {
                          loadId: id,
                          numberOfStops: detourStops,
                          reason: detourReason,
                          success: result.success,
                        });

                        setShowDetourModal(false);

                        if (result.success) {
                          Alert.alert('Detour Added', result.message, [{ text: 'OK' }]);
                        } else {
                          Alert.alert('Error', result.message);
                        }
                      } catch (err) {
                        const msg = err instanceof Error ? err.message : 'Something went wrong';
                        Alert.alert('Error', msg);
                      } finally {
                        setIsAddingDetour(false);
                        setDetourStops(1);
                        setDetourReason('FUEL');
                        setDetourNotes('');
                      }
                    }}
                  >
                    {isAddingDetour ? (
                      <ActivityIndicator color={colors.primaryForeground} size="small" />
                    ) : (
                      <>
                        <Ionicons name="navigate" size={22} color={colors.primaryForeground} />
                        <Text style={styles.detourConfirmButtonText}>Confirm Detour</Text>
                      </>
                    )}
                  </Pressable>

                  {/* Cancel Button */}
                  <Pressable
                    style={styles.detourCancelButton}
                    onPress={() => {
                      setShowDetourModal(false);
                      setDetourStops(1);
                      setDetourReason('FUEL');
                      setDetourNotes('');
                    }}
                  >
                    <Text style={styles.detourCancelButtonText}>Cancel</Text>
                  </Pressable>
                </View>
              </KeyboardAvoidingView>
            </View>
          </TouchableWithoutFeedback>
        </Modal>
      </View>
    </>
  );
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
