import { useState, useEffect, useCallback } from 'react';
import {
  View,
  Text,
  ScrollView,
  TouchableOpacity,
  StyleSheet,
  Alert,
  Linking,
  Modal,
  TextInput,
  ActivityIndicator,
  Dimensions,
  KeyboardAvoidingView,
  Platform,
} from 'react-native';
import { useLocalSearchParams, useRouter, Stack, useFocusEffect } from 'expo-router';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { Ionicons, Feather, MaterialCommunityIcons } from '@expo/vector-icons';
import { useLoadDetail } from '../../../lib/hooks/useLoadDetail';
import { useCheckIn } from '../../../lib/hooks/useCheckIn';
import { useDriver } from '../_layout';
import { useNetworkStatus } from '../../../lib/hooks/useNetworkStatus';
import { Id } from '../../../../convex/_generated/dataModel';
import * as ImagePicker from 'expo-image-picker';
import { usePostHog } from 'posthog-react-native';
import AsyncStorage from '@react-native-async-storage/async-storage';

// Key for retrieving captured photo URI
const CAPTURED_PHOTO_KEY = 'captured_photo_uri';

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
  xs: 4,
  sm: 8,
  md: 12,
  lg: 16,
  xl: 20,
  '2xl': 24,
};

const borderRadius = {
  md: 8,
  lg: 12,
  xl: 16,
  '2xl': 20,
  '3xl': 24,
  full: 9999,
};

// ============================================
// TRIP DETAIL SCREEN
// ============================================
export default function TripDetailScreen() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const router = useRouter();
  const insets = useSafeAreaInsets();
  const { driverId, organizationId } = useDriver();
  const { isOffline } = useNetworkStatus();
  const { checkIn, checkOut } = useCheckIn();
  const posthog = usePostHog();

  const { load, stops, isLoading } = useLoadDetail(
    id as Id<'loadInformation'>,
    driverId
  );

  // Check-in modal state
  const [checkInModal, setCheckInModal] = useState<{
    visible: boolean;
    stopId: Id<'loadStops'> | null;
    type: 'in' | 'out';
  }>({ visible: false, stopId: null, type: 'in' });
  const [notes, setNotes] = useState('');
  const [photoUri, setPhotoUri] = useState<string | null>(null);
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [showQuickActions, setShowQuickActions] = useState(false);
  const [showDetourModal, setShowDetourModal] = useState(false);
  const [detourStops, setDetourStops] = useState(1);

  // Check for captured photo when screen comes into focus
  useFocusEffect(
    useCallback(() => {
      const checkForCapturedPhoto = async () => {
        try {
          const capturedUri = await AsyncStorage.getItem(CAPTURED_PHOTO_KEY);
          if (capturedUri) {
            console.log('[TripDetail] Retrieved captured photo:', capturedUri);
            setPhotoUri(capturedUri);
            // Clear the stored URI so it's not reused
            await AsyncStorage.removeItem(CAPTURED_PHOTO_KEY);
            
            // Show the check-in modal if it was closed
            if (!checkInModal.visible && checkInModal.stopId) {
              setCheckInModal(prev => ({ ...prev, visible: true }));
            }
          }
        } catch (error) {
          console.error('[TripDetail] Failed to retrieve captured photo:', error);
        }
      };
      
      checkForCapturedPhoto();
    }, [checkInModal.stopId, checkInModal.visible])
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

  // Navigate to capture photo screen
  const navigateToCapturePhoto = (stopIdParam?: Id<'loadStops'>) => {
    const currentStop = stops[currentStopIndex];
    const locationName = currentStop?.locationName || 
      (currentStop ? `${currentStop.city}, ${currentStop.state}` : undefined);
    
    posthog?.capture('capture_photo_screen_opened', { loadId: id, stopId: stopIdParam || null });
    
    router.push({
      pathname: '/capture-photo',
      params: {
        loadId: id,
        stopId: stopIdParam || checkInModal.stopId || undefined,
        locationName: locationName || `Load #${load?.internalId}`,
        stopSequence: currentStop?.sequenceNumber?.toString() || undefined,
      },
    });
  };

  // Legacy take photo for check-in modal (fallback to ImagePicker)
  const takePhoto = async () => {
    posthog?.capture('take_photo_started', { loadId: id, stopId: checkInModal.stopId });
    
    const permission = await ImagePicker.requestCameraPermissionsAsync();
    if (!permission.granted) {
      posthog?.capture('take_photo_permission_denied');
      Alert.alert('Permission Required', 'Camera access is required for POD photos');
      return;
    }

    const result = await ImagePicker.launchCameraAsync({
      mediaTypes: ['images'],
      quality: 0.8,
      allowsEditing: false,
    });

    if (!result.canceled && result.assets[0]) {
      setPhotoUri(result.assets[0].uri);
      posthog?.capture('take_photo_success', { 
        uri: result.assets[0].uri,
        width: result.assets[0].width,
        height: result.assets[0].height,
      });
    } else {
      posthog?.capture('take_photo_cancelled');
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
      // Get the current stop to determine sequence number
      const currentStop = stops.find(s => s._id === checkInModal.stopId);
      const totalStops = stops.length;
      
      const result = checkInModal.type === 'in'
        ? await checkIn({
            stopId: checkInModal.stopId,
            driverId,
            notes: notes || undefined,
          })
        : await checkOut({
            stopId: checkInModal.stopId,
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
        stopId: checkInModal.stopId || null,
        success: result.success,
        queued: result.queued ?? false,
        message: result.message,
      });
      
      if (result.success) {
        Alert.alert(
          result.queued ? 'Queued' : 'Success',
          result.message
        );
        closeModal();
      } else {
        Alert.alert('Error', result.message);
      }
    } catch (error: any) {
      const errorMessage = error?.message || 'Unknown error';
      posthog?.capture(`${actionType}_exception`, {
        loadId: id,
        stopId: checkInModal.stopId,
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
  };

  // Format time for display
  const formatTime = (timeString?: string) => {
    if (!timeString) return null;
    try {
      // Handle different time formats
      if (timeString.includes('T')) {
        const date = new Date(timeString);
        return date.toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit' });
      }
      // Already formatted time
      return timeString;
    } catch {
      return timeString;
    }
  };

  // Format date and time together
  const formatDateTime = (dateStr?: string, timeStr?: string) => {
    if (!dateStr && !timeStr) return null;
    try {
      const dateObj = dateStr ? new Date(dateStr) : null;
      const timeObj = timeStr ? new Date(timeStr) : null;
      
      // Format date part (e.g., "Jan 15")
      const datePart = dateObj && !isNaN(dateObj.getTime())
        ? dateObj.toLocaleDateString('en-US', { month: 'short', day: 'numeric' })
        : null;
      
      // Format time part
      const timePart = timeObj && !isNaN(timeObj.getTime())
        ? timeObj.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit', hour12: true })
        : (dateObj && !isNaN(dateObj.getTime()) 
            ? dateObj.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit', hour12: true })
            : null);
      
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

  // Determine which stop is the current active stop
  const getCurrentStopIndex = () => {
    for (let i = 0; i < stops.length; i++) {
      const stop = stops[i];
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

  if (!load) {
    return (
      <View style={[styles.error, { paddingTop: insets.top }]}>
        <Ionicons name="alert-circle" size={64} color={colors.destructive} />
        <Text style={styles.errorText}>Load not found</Text>
        <TouchableOpacity style={styles.backButton} onPress={() => router.back()}>
          <Text style={styles.backButtonText}>Go Back</Text>
        </TouchableOpacity>
      </View>
    );
  }

  const statusDisplay = getStatusDisplay();
  const currentStopIndex = getCurrentStopIndex();

  return (
    <>
      <Stack.Screen options={{ headerShown: false }} />
      
      <View style={[styles.container, { paddingTop: insets.top }]}>
        {/* Header */}
        <View style={styles.header}>
          <TouchableOpacity 
            style={styles.headerBackButton} 
            onPress={() => router.back()}
          >
            <Ionicons name="arrow-back" size={24} color={colors.foreground} />
          </TouchableOpacity>
          <Text style={styles.headerTitle}>Load Details</Text>
          <View style={styles.headerSpacer} />
        </View>

        <ScrollView 
          style={styles.scrollView}
          contentContainerStyle={[styles.scrollContent, { paddingBottom: 100 + insets.bottom }]}
          showsVerticalScrollIndicator={false}
        >
          {/* Offline Banner */}
          {isOffline && (
            <View style={styles.offlineBanner}>
              <Ionicons name="cloud-offline" size={16} color={colors.foreground} />
              <Text style={styles.offlineText}>Offline - Changes will sync later</Text>
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
              <View style={styles.statusContainer}>
                <Text style={styles.statusLabel}>Status:</Text>
                <View style={[styles.statusBadge, { backgroundColor: `${statusDisplay.color}20` }]}>
                  <Text style={[styles.statusBadgeText, { color: statusDisplay.color }]}>
                    {statusDisplay.text}
                  </Text>
                </View>
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
              {stops.map((stop, index) => {
                const isPickup = stop.stopType === 'PICKUP';
                const isCompleted = stop.status === 'Completed' || !!stop.checkedOutAt;
                const isCheckedIn = !!stop.checkedInAt && !stop.checkedOutAt;
                const isCurrent = index === currentStopIndex;
                const isFuture = index > currentStopIndex && currentStopIndex !== -1;
                const isLast = index === stops.length - 1;

                return (
                  <View key={stop._id} style={styles.stopRow}>
                    {/* Timeline indicator */}
                    <View style={styles.timelineContainer}>
                      <View style={[
                        styles.timelineDot,
                        isCompleted && styles.timelineDotCompleted,
                        isCurrent && styles.timelineDotActive,
                        isFuture && styles.timelineDotFuture,
                      ]}>
                        {isCurrent && <View style={styles.timelineDotRing} />}
                      </View>
                      {!isLast && (
                        <View style={[
                          styles.timelineLine,
                          isFuture && styles.timelineLineFuture,
                        ]} />
                      )}
                    </View>

                    {/* Stop content */}
                    <View style={[styles.stopContent, isFuture && styles.stopContentFuture]}>
                      <View style={styles.stopHeader}>
                        <Text style={[
                          styles.stopLabel,
                          isCurrent && styles.stopLabelActive,
                          isFuture && styles.stopLabelFuture,
                        ]}>
                          Stop {stop.sequenceNumber} - {isPickup ? 'Pickup' : index === stops.length - 1 ? 'Final Delivery' : 'Delivery'}
                        </Text>
                      </View>

                      <Text style={[styles.stopName, isFuture && styles.stopNameFuture]}>
                        {stop.locationName || `${stop.city}, ${stop.state}`}
                      </Text>
                      
                      <Text style={[styles.stopAddress, isFuture && styles.stopAddressFuture]}>
                        {stop.address}{stop.city ? `, ${stop.city}` : ''}{stop.state ? `, ${stop.state}` : ''} {stop.postalCode || ''}
                      </Text>

                      {/* Checked In/Out badges for completed stops */}
                      {(stop.checkedInAt || stop.checkedOutAt) && (
                        <View style={styles.checkedBadgesRow}>
                          {stop.checkedInAt && (
                            <View style={styles.checkedBadge}>
                              <Text style={styles.checkedBadgeText}>
                                Checked In: {formatCheckedTime(stop.checkedInAt)}
                              </Text>
                            </View>
                          )}
                          {stop.checkedOutAt && (
                            <View style={styles.checkedBadge}>
                              <Text style={styles.checkedBadgeText}>
                                Checked Out: {formatCheckedTime(stop.checkedOutAt)}
                              </Text>
                            </View>
                          )}
                        </View>
                      )}

                      {/* Target time for current/future stops */}
                      {!isCompleted && (
                        <View style={[
                          styles.targetTimeBadge,
                          isCurrent && styles.targetTimeBadgeActive,
                        ]}>
                          <Ionicons 
                            name="time" 
                            size={14} 
                            color={isCurrent ? colors.secondary : colors.foregroundMuted} 
                          />
                          <Text style={[
                            styles.targetTimeText,
                            isCurrent && styles.targetTimeTextActive,
                          ]}>
                            Target: {formatDateTime(stop.windowBeginDate, stop.windowBeginTime) || 'TBD'}
                          </Text>
                        </View>
                      )}

                      {/* Check In button for current stop */}
                      {isCurrent && !isCheckedIn && (
                        <TouchableOpacity
                          style={styles.checkInButton}
                          onPress={() => handleCheckIn(stop._id)}
                          activeOpacity={0.8}
                        >
                          <Ionicons name="log-in" size={20} color={colors.primaryForeground} />
                          <Text style={styles.checkInButtonText}>Check In</Text>
                        </TouchableOpacity>
                      )}

                      {/* Check Out button for checked-in stop */}
                      {isCheckedIn && (
                        <TouchableOpacity
                          style={styles.checkOutButton}
                          onPress={() => handleCheckOut(stop._id)}
                          activeOpacity={0.8}
                        >
                          <Ionicons name="log-out" size={20} color={colors.foreground} />
                          <Text style={styles.checkOutButtonText}>Check Out</Text>
                        </TouchableOpacity>
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
                  <TouchableOpacity
                    style={styles.callButton}
                    onPress={() => Linking.openURL(`tel:${load.contactPersonPhone}`)}
                  >
                    <Ionicons name="call" size={24} color={colors.primary} />
                  </TouchableOpacity>
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

        {/* Bottom Action Bar */}
        <View style={[styles.bottomBar, { paddingBottom: insets.bottom + spacing.lg }]}>
          <TouchableOpacity 
            style={styles.menuButton}
            onPress={() => setShowQuickActions(true)}
          >
            <Ionicons name="ellipsis-horizontal" size={24} color={colors.foreground} />
          </TouchableOpacity>
          <TouchableOpacity style={styles.completeButton} activeOpacity={0.8}>
            <Ionicons name="checkmark-circle" size={24} color={colors.foreground} />
            <Text style={styles.completeButtonText}>Complete Load</Text>
          </TouchableOpacity>
        </View>

        {/* Quick Actions Modal */}
        <Modal
          visible={showQuickActions}
          animationType="slide"
          transparent
          onRequestClose={() => setShowQuickActions(false)}
        >
          <View style={styles.quickActionsOverlay}>
            <TouchableOpacity 
              style={styles.quickActionsBackdrop}
              activeOpacity={1}
              onPress={() => setShowQuickActions(false)}
            />
            <View style={styles.quickActionsSheet}>
              <View style={styles.sheetHandle} />
              
              {/* Header */}
              <View style={styles.quickActionsHeader}>
                <View>
                  <Text style={styles.quickActionsTitle}>Quick Actions</Text>
                  <Text style={styles.quickActionsSubtitle}>Available tasks for this load</Text>
                </View>
                <TouchableOpacity 
                  style={styles.quickActionsCloseBtn}
                  onPress={() => setShowQuickActions(false)}
                >
                  <Ionicons name="close" size={18} color={colors.foregroundMuted} />
                </TouchableOpacity>
              </View>

              {/* Action Grid */}
              <View style={styles.quickActionsGrid}>
                <TouchableOpacity 
                  style={styles.quickActionItem}
                  onPress={() => {
                    setShowQuickActions(false);
                    const targetStop = stops[currentStopIndex] || stops[0];
                    if (targetStop) {
                      openMaps(targetStop.address, targetStop.city, targetStop.state);
                    }
                  }}
                >
                  <View style={styles.quickActionIconContainer}>
                    <Ionicons name="navigate" size={26} color={colors.primary} />
                  </View>
                  <Text style={styles.quickActionLabel}>Navigate</Text>
                </TouchableOpacity>

                <TouchableOpacity 
                  style={[styles.quickActionItem, styles.quickActionItemDisabled]}
                  disabled={true}
                >
                  <View style={[styles.quickActionIconContainer, styles.quickActionIconContainerDisabled]}>
                    <Ionicons name="call" size={26} color={colors.foregroundMuted} />
                  </View>
                  <Text style={[styles.quickActionLabel, styles.quickActionLabelDisabled]}>Call Site</Text>
                </TouchableOpacity>

                <TouchableOpacity style={styles.quickActionItem}>
                  <View style={styles.quickActionIconContainer}>
                    <Ionicons name="document-text" size={26} color={colors.primary} />
                  </View>
                  <Text style={styles.quickActionLabel}>Documents</Text>
                </TouchableOpacity>

                <TouchableOpacity 
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
                </TouchableOpacity>
              </View>

              {/* Bottom Actions */}
              <View style={styles.quickActionsBottomSection}>
                <TouchableOpacity style={styles.quickActionRowItem}>
                  <View style={styles.quickActionRowLeft}>
                    <View style={[styles.quickActionRowIcon, styles.quickActionRowIconRed]}>
                      <Ionicons name="alert-circle" size={20} color={colors.destructive} />
                    </View>
                    <Text style={[styles.quickActionRowLabel, styles.quickActionRowLabelRed]}>
                      Report an Issue
                    </Text>
                  </View>
                  <Ionicons name="arrow-forward" size={20} color={colors.destructive} />
                </TouchableOpacity>

                <TouchableOpacity style={styles.quickActionRowItem}>
                  <View style={styles.quickActionRowLeft}>
                    <View style={[styles.quickActionRowIcon, styles.quickActionRowIconOrange]}>
                      <Ionicons name="share-social" size={20} color={colors.primary} />
                    </View>
                    <Text style={[styles.quickActionRowLabel, styles.quickActionRowLabelOrange]}>
                      Share Status
                    </Text>
                  </View>
                  <Ionicons name="arrow-forward" size={20} color={colors.primary} />
                </TouchableOpacity>
              </View>
            </View>
          </View>
        </Modal>

        {/* Check-in/out Modal */}
        <Modal
          visible={checkInModal.visible}
          animationType="slide"
          transparent
          onRequestClose={closeModal}
        >
          <KeyboardAvoidingView 
            style={styles.modalOverlay}
            behavior="padding"
            keyboardVerticalOffset={Platform.OS === 'ios' ? -150 : -160}
          >
            <TouchableOpacity 
              style={styles.modalBackdrop} 
              activeOpacity={1} 
              onPress={closeModal}
            />
            <View style={styles.modalContent}>
              <View style={styles.sheetHandle} />
              
              {/* Header */}
              <View style={styles.modalHeader}>
                <View style={styles.modalHeaderText}>
                  <Text style={styles.modalTitle}>
                    {checkInModal.type === 'in' ? 'Confirm Check-In' : 'Confirm Check-Out'}
                  </Text>
                  <Text style={styles.modalSubtitle}>
                    Stop {stops[currentStopIndex]?.sequenceNumber}: {stops[currentStopIndex]?.locationName || `${stops[currentStopIndex]?.city}, ${stops[currentStopIndex]?.state}`}
                  </Text>
                </View>
                <TouchableOpacity style={styles.modalCancelButton} onPress={closeModal}>
                  <Text style={styles.modalCancelButtonText}>Cancel</Text>
                </TouchableOpacity>
              </View>

              {/* Take a Photo Row */}
              <TouchableOpacity 
                style={styles.modalPhotoRow}
                onPress={() => {
                  closeModal();
                  navigateToCapturePhoto(checkInModal.stopId || undefined);
                }}
              >
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
              </TouchableOpacity>

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
                  />
                  <TouchableOpacity 
                    style={[
                      styles.modalNoteActionButton,
                      notes.trim() ? styles.modalNoteSendButton : styles.modalNoteVoiceButton
                    ]}
                  >
                    <Ionicons 
                      name={notes.trim() ? "send" : "mic"} 
                      size={20} 
                      color={notes.trim() ? colors.foreground : colors.secondary} 
                    />
                  </TouchableOpacity>
                </View>
              </View>

              {/* Complete Button */}
              <TouchableOpacity
                style={[styles.modalCompleteButton, isSubmitting && styles.modalCompleteButtonDisabled]}
                onPress={submitCheckIn}
                disabled={isSubmitting}
                activeOpacity={0.8}
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
              </TouchableOpacity>

              {/* GPS Notice */}
              <View style={styles.modalGpsNotice}>
                <Ionicons name="location" size={16} color={colors.foregroundMuted} />
                <Text style={styles.modalGpsNoticeText}>Location verified via GPS</Text>
              </View>
            </View>
          </KeyboardAvoidingView>
        </Modal>

        {/* Add Detour Modal */}
        <Modal
          visible={showDetourModal}
          animationType="slide"
          transparent
          onRequestClose={() => setShowDetourModal(false)}
        >
          <View style={styles.detourModalOverlay}>
            <TouchableOpacity 
              style={styles.detourModalBackdrop}
              activeOpacity={1}
              onPress={() => setShowDetourModal(false)}
            />
            <View style={styles.detourModalSheet}>
              <View style={styles.sheetHandle} />
              
              {/* Header */}
              <View style={styles.detourModalHeader}>
                <View>
                  <Text style={styles.detourModalTitle}>Add Detour Stops</Text>
                  <Text style={styles.detourModalSubtitle}>Plan additional stops on your current route</Text>
                </View>
                <TouchableOpacity 
                  style={styles.detourModalCloseBtn}
                  onPress={() => setShowDetourModal(false)}
                >
                  <Ionicons name="close" size={16} color={colors.foreground} />
                </TouchableOpacity>
              </View>

              {/* Number of Stops Selector */}
              <View style={styles.detourStopsCard}>
                <Text style={styles.detourStopsLabel}>NUMBER OF STOPS</Text>
                <View style={styles.detourStopsRow}>
                  <TouchableOpacity 
                    style={[
                      styles.detourStopsButton,
                      detourStops <= 1 && styles.detourStopsButtonDisabled
                    ]}
                    onPress={() => setDetourStops(Math.max(1, detourStops - 1))}
                    disabled={detourStops <= 1}
                  >
                    <Ionicons 
                      name="remove" 
                      size={24} 
                      color={detourStops <= 1 ? colors.foregroundMuted : colors.foreground} 
                    />
                  </TouchableOpacity>
                  
                  <View style={styles.detourStopsCountContainer}>
                    <Text style={styles.detourStopsCount}>
                      {detourStops.toString().padStart(2, '0')}
                    </Text>
                    <Text style={styles.detourStopsTotalLabel}>STOPS TOTAL</Text>
                  </View>
                  
                  <TouchableOpacity 
                    style={styles.detourStopsButton}
                    onPress={() => setDetourStops(detourStops + 1)}
                  >
                    <Ionicons name="add" size={24} color={colors.primaryForeground} />
                  </TouchableOpacity>
                </View>
              </View>

              {/* GPS Logging Info Card */}
              <View style={styles.detourGpsCard}>
                <View style={styles.detourGpsIconContainer}>
                  <Ionicons name="locate" size={22} color={colors.primary} />
                </View>
                <View style={styles.detourGpsTextContainer}>
                  <Text style={styles.detourGpsTitle}>Automatic GPS Logging</Text>
                  <Text style={styles.detourGpsDescription}>
                    Our system will automatically record your{' '}
                    <Text style={styles.detourGpsBold}>check-in</Text> and{' '}
                    <Text style={styles.detourGpsBold}>check-out</Text> times and locations for each detour stop.
                  </Text>
                  <View style={styles.detourGpsBadgesRow}>
                    <View style={styles.detourGpsBadge}>
                      <View style={[styles.detourGpsBadgeDot, styles.detourGpsBadgeDotGreen]} />
                      <Text style={styles.detourGpsBadgeText}>Auto Check-in</Text>
                    </View>
                    <View style={styles.detourGpsBadge}>
                      <View style={[styles.detourGpsBadgeDot, styles.detourGpsBadgeDotBlue]} />
                      <Text style={styles.detourGpsBadgeText}>Auto Check-out</Text>
                    </View>
                  </View>
                </View>
              </View>

              {/* Confirm Button */}
              <TouchableOpacity
                style={styles.detourConfirmButton}
                onPress={() => {
                  posthog?.capture('detour_confirmed', { 
                    loadId: id, 
                    numberOfStops: detourStops 
                  });
                  setShowDetourModal(false);
                  Alert.alert(
                    'Detour Added',
                    `${detourStops} detour stop${detourStops > 1 ? 's' : ''} will be added to your route.`,
                    [{ text: 'OK' }]
                  );
                  setDetourStops(1);
                }}
                activeOpacity={0.8}
              >
                <Ionicons name="navigate" size={22} color={colors.primaryForeground} />
                <Text style={styles.detourConfirmButtonText}>Confirm Detour</Text>
              </TouchableOpacity>

              {/* Cancel Button */}
              <TouchableOpacity
                style={styles.detourCancelButton}
                onPress={() => {
                  setShowDetourModal(false);
                  setDetourStops(1);
                }}
              >
                <Text style={styles.detourCancelButtonText}>Cancel</Text>
              </TouchableOpacity>
            </View>
          </View>
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

  // Offline banner
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
  statusContainer: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.sm,
  },
  statusLabel: {
    fontSize: 14,
    color: colors.foregroundMuted,
    fontWeight: '500',
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

  // Bottom bar
  bottomBar: {
    position: 'absolute',
    bottom: 0,
    left: 0,
    right: 0,
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.md,
    paddingHorizontal: spacing.xl,
    paddingTop: spacing.xl,
    backgroundColor: `${colors.background}F5`,
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
    fontSize: 24,
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
