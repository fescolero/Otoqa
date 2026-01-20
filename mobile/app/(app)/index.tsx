import React, { useMemo, useState } from 'react';
import {
  View,
  Text,
  ScrollView,
  StyleSheet,
  RefreshControl,
  TouchableOpacity,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { useRouter } from 'expo-router';
import { Ionicons, MaterialCommunityIcons, Feather } from '@expo/vector-icons';
import { useMyLoads } from '../../lib/hooks/useMyLoads';
import { useNetworkStatus } from '../../lib/hooks/useNetworkStatus';
import { useOfflineQueue } from '../../lib/hooks/useOfflineQueue';
import { useDriver } from './_layout';
import { colors, typography, spacing, borderRadius, shadows } from '../../lib/theme';

// ============================================
// HOME SCREEN - Dark Logistics Design
// Professional Driver Dashboard
// ============================================

export default function HomeScreen() {
  const router = useRouter();
  const { driverId } = useDriver();
  const { loads, isLoading, refetch, isRefetching, lastSyncTime } = useMyLoads(driverId);
  const { isConnected } = useNetworkStatus();
  const { pendingCount } = useOfflineQueue();
  const [showCompleted, setShowCompleted] = useState(false);

  // Separate active, upcoming, and completed loads
  const { activeLoad, scheduledLoads, completedLoads } = useMemo(() => {
    if (!loads || loads.length === 0) {
      return { activeLoad: null, scheduledLoads: [], completedLoads: [] };
    }

    const completed = loads.filter((l) => l.status === 'Completed' || l.trackingStatus === 'Completed');
    const active = loads.filter((l) => l.status !== 'Completed' && l.trackingStatus !== 'Completed');
    
    // Only show as "Current Load" if actually in transit/in progress
    const inProgress = active.find(
      (l) => l.trackingStatus === 'In Transit' || 
             l.trackingStatus === 'At Pickup' || 
             l.trackingStatus === 'At Delivery' ||
             l.status === 'In Progress'
    );
    
    // All non-completed loads that aren't the current one go to scheduled
    const scheduled = active
      .filter((l) => l._id !== inProgress?._id)
      .sort((a, b) => {
        const timeA = a.firstPickup?.windowBeginDate || '';
        const timeB = b.firstPickup?.windowBeginDate || '';
        return timeA.localeCompare(timeB);
      });

    return { 
      activeLoad: inProgress, 
      scheduledLoads: scheduled,
      completedLoads: completed 
    };
  }, [loads]);

  // Format date for header
  const formatHeaderDate = () => {
    const now = new Date();
    return now.toLocaleDateString('en-US', { 
      month: 'long', 
      day: 'numeric', 
      year: 'numeric' 
    });
  };

  // Check if load is multi-day
  const isMultiDay = (load: typeof activeLoad) => {
    if (!load?.firstPickup?.windowBeginDate || !load?.lastDelivery?.windowBeginDate) return false;
    const pickupDate = load.firstPickup.windowBeginDate.split('T')[0];
    const deliveryDate = load.lastDelivery.windowBeginDate.split('T')[0];
    return pickupDate !== deliveryDate;
  };

  // Get multi-day continuation date
  const getMultiDayDate = (load: typeof activeLoad) => {
    if (!load?.lastDelivery?.windowBeginDate) return null;
    try {
      const date = new Date(load.lastDelivery.windowBeginDate);
      return date.toLocaleDateString('en-US', { month: 'long', day: 'numeric', year: 'numeric' });
    } catch {
      return null;
    }
  };

  // Format time only
  const formatTime = (timeStr?: string) => {
    if (!timeStr) return null;
    try {
      const date = new Date(timeStr);
      if (isNaN(date.getTime())) return null;
      return date.toLocaleTimeString('en-US', { 
        hour: 'numeric', 
        minute: '2-digit',
        hour12: true 
      });
    } catch {
      return null;
    }
  };

  // Format date and time together
  const formatDateTime = (dateStr?: string, timeStr?: string) => {
    if (!dateStr && !timeStr) return null;
    try {
      // Try to get date from dateStr
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

  // Format expected delivery
  const formatExpectedDelivery = (load: typeof activeLoad) => {
    if (!load?.lastDelivery?.windowBeginDate) return null;
    try {
      const date = new Date(load.lastDelivery.windowBeginDate);
      const time = load.lastDelivery?.windowEndTime 
        ? formatTime(load.lastDelivery.windowEndTime) 
        : formatTime(load.lastDelivery.windowBeginDate);
      const dateStr = date.toLocaleDateString('en-US', { month: 'long', day: 'numeric' });
      return `${dateStr}, ${time || ''}`;
    } catch {
      return null;
    }
  };

  // Get pickup address
  const getPickupAddress = (load: typeof activeLoad) => {
    if (!load?.firstPickup) return 'Address pending';
    const { address, city, state, postalCode } = load.firstPickup;
    if (address && city && state) {
      return `${address}, ${city}, ${state} ${postalCode || ''}`.trim();
    }
    if (city && state) return `${city}, ${state}`;
    return 'Address pending';
  };

  // Get delivery address
  const getDeliveryAddress = (load: typeof activeLoad) => {
    if (!load?.lastDelivery) return 'Address pending';
    const { address, city, state, postalCode } = load.lastDelivery;
    if (address && city && state) {
      return `${address}, ${city}, ${state} ${postalCode || ''}`.trim();
    }
    if (city && state) return `${city}, ${state}`;
    return 'Address pending';
  };

  // Loading skeleton
  const LoadingSkeleton = () => (
    <View style={styles.skeletonContainer}>
      <View style={[styles.skeletonBox, { height: 80, marginBottom: 16 }]} />
      <View style={[styles.skeletonBox, { height: 200, marginBottom: 12 }]} />
      <View style={[styles.skeletonBox, { height: 200 }]} />
    </View>
  );

  return (
    <SafeAreaView style={styles.container} edges={['top']}>
      {/* Offline Banner */}
      {isConnected === false && (
        <View style={styles.offlineBanner}>
          <Ionicons name="wifi-outline" size={16} color={colors.background} />
          <Text style={styles.offlineBannerText}>Offline Mode — Showing cached data</Text>
        </View>
      )}

      <ScrollView
        style={styles.scrollView}
        contentContainerStyle={styles.scrollContent}
        showsVerticalScrollIndicator={false}
        refreshControl={
          <RefreshControl
            refreshing={isRefetching}
            onRefresh={refetch}
            tintColor={colors.primary}
            colors={[colors.primary]}
          />
        }
      >
        {/* Header */}
        <View style={styles.header}>
          <View style={styles.dateContainer}>
            <Ionicons name="calendar" size={36} color={colors.primary} />
            <View style={styles.dateTextContainer}>
              <Text style={styles.todayLabel}>Today</Text>
              <Text style={styles.dateText}>{formatHeaderDate()}</Text>
            </View>
          </View>
          <View style={styles.headerDivider} />
          <View style={styles.weatherContainer}>
            <Ionicons name="sunny" size={28} color={colors.secondary} />
            <View>
              <Text style={styles.weatherLabel}>Weather</Text>
              <Text style={styles.weatherText}>72°F</Text>
            </View>
          </View>
        </View>

        {/* Section Header */}
        <View style={styles.sectionHeader}>
          <Text style={styles.sectionTitle}>Scheduled Loads</Text>
          <View style={styles.sectionActions}>
            <TouchableOpacity style={styles.actionButton}>
              <Feather name="filter" size={16} color={colors.foreground} />
              <Text style={styles.actionText}>Sort</Text>
            </TouchableOpacity>
            <TouchableOpacity 
              style={styles.actionButton}
              onPress={() => setShowCompleted(!showCompleted)}
            >
              <Ionicons name="checkmark-circle" size={18} color={colors.foreground} />
              <Text style={styles.actionText}>Completed</Text>
            </TouchableOpacity>
          </View>
        </View>

        {/* Pending Sync */}
        {pendingCount > 0 && (
          <View style={styles.syncBanner}>
            <Ionicons name="cloud-upload-outline" size={16} color={colors.foregroundMuted} />
            <Text style={styles.syncText}>
              {pendingCount} update{pendingCount > 1 ? 's' : ''} pending sync
            </Text>
          </View>
        )}

        {/* Loading State */}
        {isLoading && <LoadingSkeleton />}

        {/* Current Load Card */}
        {!isLoading && activeLoad && (
          <TouchableOpacity
            style={styles.currentLoadCard}
            onPress={() => router.push(`/trip/${activeLoad._id}`)}
            activeOpacity={0.9}
          >
            <View style={styles.currentLoadContent}>
              <View style={styles.currentLoadLeft}>
                <MaterialCommunityIcons name="truck-delivery" size={32} color={colors.primaryForeground} />
                <View>
                  <Text style={styles.currentLoadLabel}>Current Load</Text>
                  <Text style={styles.currentLoadId}>#{activeLoad.internalId}</Text>
                </View>
              </View>
              <View style={styles.currentLoadRight}>
                <Text style={styles.currentLoadExpectedLabel}>Expected</Text>
                <Text style={styles.currentLoadTime}>
                  {formatTime(activeLoad.lastDelivery?.windowEndTime) || 'TBD'}
                </Text>
              </View>
            </View>
          </TouchableOpacity>
        )}

        {/* Scheduled Load Cards */}
        {!isLoading && scheduledLoads.map((load, index) => {
          const multiDay = isMultiDay(load);
          const multiDayDate = getMultiDayDate(load);
          const expectedDelivery = formatExpectedDelivery(load);
          
          return (
            <TouchableOpacity
              key={load._id}
              style={styles.loadCard}
              onPress={() => router.push(`/trip/${load._id}`)}
              activeOpacity={0.8}
            >
              {/* Card Header */}
              <View style={styles.loadCardHeader}>
                <View style={styles.loadCardHeaderLeft}>
                  <Feather name="package" size={14} color={colors.foregroundMuted} />
                  <Text style={styles.loadCardTitle}>Load #{load.internalId}</Text>
                  {load.parsedHcr && (
                    <View style={styles.truckBadge}>
                      <Text style={styles.truckBadgeText}>{load.parsedHcr}</Text>
                    </View>
                  )}
                  {load.parsedTripNumber && (
                    <View style={styles.tripBadge}>
                      <Text style={styles.tripBadgeText}>Trip {load.parsedTripNumber}</Text>
                    </View>
                  )}
                </View>
                <View style={styles.statusBadge}>
                  <Text style={styles.statusBadgeText}>Scheduled</Text>
                </View>
              </View>

              {/* Multi-Day Indicator */}
              {multiDay && multiDayDate && (
                <View style={styles.multiDayBanner}>
                  <Ionicons name="calendar-outline" size={16} color={colors.chart3} />
                  <View>
                    <Text style={styles.multiDayTitle}>Multi-Day Load</Text>
                    <Text style={styles.multiDayText}>Continues into {multiDayDate}</Text>
                  </View>
                </View>
              )}

              {/* Time and Packages */}
              <View style={styles.loadCardStats}>
                <View style={styles.statLeft}>
                  <Text style={styles.statLabel}>Pickup</Text>
                  <Text style={styles.statValue}>
                    {formatDateTime(load.firstPickup?.windowBeginDate, load.firstPickup?.windowBeginTime) || 'TBD'}
                  </Text>
                </View>
                <View style={styles.statRight}>
                  <Text style={styles.statLabel}>Stops</Text>
                  <Text style={styles.statValueMono}>{load.stopCount || '—'}</Text>
                </View>
              </View>

              {/* Addresses */}
              <View style={styles.addressSection}>
                {/* Pickup */}
                <View style={styles.addressRow}>
                  <Ionicons name="location" size={16} color={colors.chart4} style={{ marginTop: 2 }} />
                  <View style={styles.addressContent}>
                    <Text style={styles.addressLabel}>Pickup</Text>
                    <Text style={styles.addressText}>{getPickupAddress(load)}</Text>
                  </View>
                </View>

                {/* Delivery */}
                <View style={styles.addressRow}>
                  <Ionicons name="flag" size={16} color={colors.destructive} style={{ marginTop: 2 }} />
                  <View style={styles.addressContent}>
                    <Text style={styles.addressLabel}>Last Delivery</Text>
                    <Text style={styles.addressText}>{getDeliveryAddress(load)}</Text>
                    {expectedDelivery && (
                      <Text style={styles.expectedText}>Expected: {expectedDelivery}</Text>
                    )}
                  </View>
                </View>
              </View>
            </TouchableOpacity>
          );
        })}

        {/* No Loads State */}
        {!isLoading && !activeLoad && scheduledLoads.length === 0 && (
          <View style={styles.emptyState}>
            <Ionicons name="clipboard-outline" size={64} color={colors.foregroundMuted} />
            <Text style={styles.emptyTitle}>No Scheduled Loads</Text>
            <Text style={styles.emptyText}>Pull down to refresh</Text>
          </View>
        )}

        {/* Completed Loads */}
        {showCompleted && completedLoads.length > 0 && (
          <>
            <View style={styles.completedHeader}>
              <Text style={styles.completedHeaderText}>
                Completed ({completedLoads.length})
              </Text>
            </View>
            {completedLoads.map((load) => (
              <TouchableOpacity
                key={load._id}
                style={styles.completedCard}
                onPress={() => router.push(`/trip/${load._id}`)}
                activeOpacity={0.7}
              >
                <View style={styles.completedContent}>
                  <Ionicons name="checkmark-circle" size={20} color={colors.success} />
                  <View>
                    <Text style={styles.completedTitle}>Load #{load.internalId}</Text>
                    <Text style={styles.completedSubtitle}>
                      {load.lastDelivery?.city || 'Completed'}
                    </Text>
                  </View>
                </View>
              </TouchableOpacity>
            ))}
          </>
        )}

        {/* Bottom spacing for nav */}
        <View style={{ height: 120 }} />
      </ScrollView>
    </SafeAreaView>
  );
}

// ============================================
// DARK THEME STYLES
// ============================================

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: colors.background,
  },
  scrollView: {
    flex: 1,
  },
  scrollContent: {
    paddingHorizontal: spacing.md,
  },

  // Offline Banner
  offlineBanner: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: colors.warning,
    paddingVertical: 10,
    paddingHorizontal: spacing.md,
    gap: 8,
  },
  offlineBannerText: {
    color: colors.background,
    fontSize: typography.sm,
    fontWeight: typography.semibold,
  },

  // Header
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingTop: spacing.lg,
    paddingBottom: spacing.lg,
  },
  dateContainer: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10,
    flex: 1,
  },
  dateTextContainer: {
    flex: 1,
  },
  todayLabel: {
    fontSize: typography.sm,
    fontWeight: typography.medium,
    color: colors.foregroundMuted,
    letterSpacing: 0.5,
  },
  dateText: {
    fontSize: typography.xl,
    fontWeight: typography.semibold,
    color: colors.foreground,
  },
  headerDivider: {
    width: 1,
    height: 40,
    backgroundColor: colors.border,
    marginHorizontal: spacing.base,
  },
  weatherContainer: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
  },
  weatherLabel: {
    fontSize: typography.xs,
    fontWeight: typography.medium,
    color: colors.foregroundMuted,
  },
  weatherText: {
    fontSize: typography.base,
    fontWeight: typography.semibold,
    color: colors.foreground,
  },

  // Section Header
  sectionHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    marginBottom: spacing.md,
  },
  sectionTitle: {
    fontSize: typography.xl,
    fontWeight: typography.semibold,
    color: colors.foreground,
  },
  sectionActions: {
    flexDirection: 'row',
    gap: 8,
  },
  actionButton: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    backgroundColor: colors.muted,
    paddingHorizontal: 12,
    paddingVertical: 8,
    borderRadius: borderRadius.lg,
  },
  actionText: {
    fontSize: typography.sm,
    fontWeight: typography.medium,
    color: colors.foreground,
  },

  // Sync Banner
  syncBanner: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: colors.muted,
    paddingVertical: 10,
    paddingHorizontal: spacing.md,
    borderRadius: borderRadius.lg,
    marginBottom: spacing.md,
    borderWidth: 1,
    borderColor: colors.border,
    gap: 8,
  },
  syncText: {
    color: colors.foregroundMuted,
    fontSize: typography.sm,
    fontWeight: typography.medium,
  },

  // Current Load Card
  currentLoadCard: {
    backgroundColor: colors.primary,
    borderRadius: borderRadius['2xl'],
    padding: spacing.lg,
    marginBottom: spacing.md,
    ...shadows.lg,
  },
  currentLoadContent: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
  },
  currentLoadLeft: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 12,
  },
  currentLoadLabel: {
    fontSize: typography.sm,
    fontWeight: typography.medium,
    color: 'rgba(26, 29, 33, 0.8)',
  },
  currentLoadId: {
    fontSize: typography['2xl'],
    fontWeight: typography.bold,
    color: colors.primaryForeground,
    fontFamily: 'Courier',
    letterSpacing: -1,
  },
  currentLoadRight: {
    alignItems: 'flex-end',
  },
  currentLoadExpectedLabel: {
    fontSize: typography.sm,
    fontWeight: typography.medium,
    color: 'rgba(26, 29, 33, 0.8)',
  },
  currentLoadTime: {
    fontSize: typography['2xl'],
    fontWeight: typography.semibold,
    color: colors.primaryForeground,
  },

  // Load Card
  loadCard: {
    backgroundColor: colors.card,
    borderRadius: borderRadius.xl,
    padding: spacing.base,
    marginBottom: spacing.base,
    borderWidth: 1,
    borderColor: 'rgba(63, 69, 82, 0.5)',
    ...shadows.md,
  },
  loadCardHeader: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    marginBottom: 8,
  },
  loadCardHeaderLeft: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    flexWrap: 'wrap',
  },
  loadCardTitle: {
    fontSize: typography.sm,
    fontWeight: typography.semibold,
    color: colors.foreground,
  },
  truckBadge: {
    backgroundColor: 'rgba(255, 107, 0, 0.3)',
    paddingHorizontal: 8,
    paddingVertical: 3,
    borderRadius: borderRadius.md,
  },
  truckBadgeText: {
    fontSize: typography.xs,
    fontWeight: typography.semibold,
    color: colors.primary,
  },
  tripBadge: {
    backgroundColor: 'rgba(59, 130, 246, 0.3)',
    paddingHorizontal: 8,
    paddingVertical: 3,
    borderRadius: borderRadius.md,
  },
  tripBadgeText: {
    fontSize: typography.xs,
    fontWeight: typography.semibold,
    color: colors.chart3,
  },
  statusBadge: {
    backgroundColor: 'rgba(234, 179, 8, 0.3)',
    paddingHorizontal: 8,
    paddingVertical: 3,
    borderRadius: borderRadius.full,
  },
  statusBadgeText: {
    fontSize: typography.xs,
    fontWeight: typography.semibold,
    color: colors.secondary,
  },

  // Multi-Day Banner
  multiDayBanner: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    backgroundColor: 'rgba(59, 130, 246, 0.1)',
    borderWidth: 1,
    borderColor: 'rgba(59, 130, 246, 0.3)',
    paddingHorizontal: 10,
    paddingVertical: 8,
    borderRadius: borderRadius.lg,
    marginBottom: 8,
  },
  multiDayTitle: {
    fontSize: typography.xs,
    fontWeight: typography.semibold,
    color: colors.chart3,
  },
  multiDayText: {
    fontSize: typography.xs,
    color: colors.foregroundMuted,
  },

  // Stats
  loadCardStats: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    marginBottom: 8,
  },
  statLabel: {
    fontSize: typography.xs,
    color: colors.foregroundMuted,
    marginBottom: 2,
  },
  statValue: {
    fontSize: typography.base,
    fontWeight: typography.semibold,
    color: colors.foreground,
  },
  statLeft: {
    flex: 1,
  },
  statRight: {
    alignItems: 'flex-end',
  },
  statValueMono: {
    fontSize: typography.base,
    fontWeight: typography.bold,
    color: colors.foreground,
    fontFamily: 'Courier',
  },

  // Address Section
  addressSection: {
    borderTopWidth: 1,
    borderTopColor: 'rgba(63, 69, 82, 0.5)',
    paddingTop: 8,
    gap: 8,
  },
  addressRow: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    gap: 8,
  },
  addressContent: {
    flex: 1,
  },
  addressLabel: {
    fontSize: typography.xs,
    color: colors.foregroundMuted,
    marginBottom: 2,
  },
  addressText: {
    fontSize: typography.sm,
    fontWeight: typography.medium,
    color: colors.foreground,
  },
  expectedText: {
    fontSize: typography.xs,
    fontWeight: typography.medium,
    color: colors.chart3,
    marginTop: 4,
  },

  // Empty State
  emptyState: {
    alignItems: 'center',
    justifyContent: 'center',
    paddingVertical: 60,
  },
  emptyTitle: {
    fontSize: typography.lg,
    fontWeight: typography.semibold,
    color: colors.foreground,
    marginTop: 16,
    marginBottom: 8,
  },
  emptyText: {
    fontSize: typography.base,
    color: colors.foregroundMuted,
  },

  // Completed Section
  completedHeader: {
    marginTop: spacing.lg,
    marginBottom: spacing.base,
  },
  completedHeaderText: {
    fontSize: typography.base,
    fontWeight: typography.semibold,
    color: colors.foregroundMuted,
  },
  completedCard: {
    backgroundColor: colors.card,
    borderRadius: borderRadius.lg,
    padding: spacing.base,
    marginBottom: 8,
    opacity: 0.7,
  },
  completedContent: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 12,
  },
  completedTitle: {
    fontSize: typography.sm,
    fontWeight: typography.semibold,
    color: colors.foreground,
  },
  completedSubtitle: {
    fontSize: typography.xs,
    color: colors.foregroundMuted,
  },

  // Skeleton
  skeletonContainer: {
    paddingTop: spacing.md,
  },
  skeletonBox: {
    backgroundColor: colors.muted,
    borderRadius: borderRadius.xl,
  },
});
