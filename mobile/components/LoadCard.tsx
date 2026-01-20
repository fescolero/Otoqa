import React from 'react';
import { View, Text, StyleSheet, TouchableOpacity } from 'react-native';
import { colors, typography, spacing, borderRadius, shadows } from '../lib/theme';

// ============================================
// LOAD CARDS
// Dark Theme - Reusable Load Display Components
// ============================================

interface LoadData {
  _id: string;
  internalId: string;
  status?: string;
  trackingStatus?: string;
  stopCount?: number;
  effectiveMiles?: number;
  truckId?: string;
  firstPickup?: {
    address?: string;
    city?: string;
    state?: string;
    postalCode?: string;
    windowBeginDate?: string;
    windowBeginTime?: string;
  };
  lastDelivery?: {
    address?: string;
    city?: string;
    state?: string;
    postalCode?: string;
    windowBeginDate?: string;
    windowEndTime?: string;
  };
}

interface CurrentLoadCardProps {
  load: LoadData;
  onPress: () => void;
}

export function CurrentLoadCard({ load, onPress }: CurrentLoadCardProps) {
  const formatTime = (timeStr?: string) => {
    if (!timeStr) return 'TBD';
    try {
      const date = new Date(timeStr);
      if (isNaN(date.getTime())) return 'TBD';
      return date.toLocaleTimeString('en-US', { 
        hour: 'numeric', 
        minute: '2-digit',
        hour12: true 
      });
    } catch {
      return 'TBD';
    }
  };

  return (
    <TouchableOpacity
      style={styles.currentLoadCard}
      onPress={onPress}
      activeOpacity={0.9}
    >
      <View style={styles.currentLoadContent}>
        <View style={styles.currentLoadLeft}>
          <Text style={styles.currentLoadIcon}>🚛</Text>
          <View>
            <Text style={styles.currentLoadLabel}>Current Load</Text>
            <Text style={styles.currentLoadId}>#{load.internalId}</Text>
          </View>
        </View>
        <View style={styles.currentLoadRight}>
          <Text style={styles.currentLoadExpectedLabel}>Expected</Text>
          <Text style={styles.currentLoadTime}>
            {formatTime(load.lastDelivery?.windowEndTime)}
          </Text>
        </View>
      </View>
    </TouchableOpacity>
  );
}

interface ScheduledLoadCardProps {
  load: LoadData;
  tripNumber: number;
  onPress: () => void;
}

export function ScheduledLoadCard({ load, tripNumber, onPress }: ScheduledLoadCardProps) {
  const isMultiDay = () => {
    if (!load.firstPickup?.windowBeginDate || !load.lastDelivery?.windowBeginDate) return false;
    const pickupDate = load.firstPickup.windowBeginDate.split('T')[0];
    const deliveryDate = load.lastDelivery.windowBeginDate.split('T')[0];
    return pickupDate !== deliveryDate;
  };

  const getMultiDayDate = () => {
    if (!load.lastDelivery?.windowBeginDate) return null;
    try {
      const date = new Date(load.lastDelivery.windowBeginDate);
      return date.toLocaleDateString('en-US', { month: 'long', day: 'numeric', year: 'numeric' });
    } catch {
      return null;
    }
  };

  const formatTime = (timeStr?: string) => {
    if (!timeStr) return 'TBD';
    try {
      const date = new Date(timeStr);
      if (isNaN(date.getTime())) return 'TBD';
      return date.toLocaleTimeString('en-US', { 
        hour: 'numeric', 
        minute: '2-digit',
        hour12: true 
      });
    } catch {
      return 'TBD';
    }
  };

  const getAddress = (stop: LoadData['firstPickup'] | LoadData['lastDelivery']) => {
    if (!stop) return 'Address pending';
    const { address, city, state, postalCode } = stop;
    if (address && city && state) {
      return `${address}, ${city}, ${state} ${postalCode || ''}`.trim();
    }
    if (city && state) return `${city}, ${state}`;
    return 'Address pending';
  };

  const formatExpectedDelivery = () => {
    if (!load.lastDelivery?.windowBeginDate) return null;
    try {
      const date = new Date(load.lastDelivery.windowBeginDate);
      const time = load.lastDelivery?.windowEndTime 
        ? formatTime(load.lastDelivery.windowEndTime) 
        : formatTime(load.lastDelivery.windowBeginDate);
      const dateStr = date.toLocaleDateString('en-US', { month: 'long', day: 'numeric' });
      return `${dateStr}, ${time}`;
    } catch {
      return null;
    }
  };

  const multiDay = isMultiDay();
  const multiDayDate = getMultiDayDate();
  const expectedDelivery = formatExpectedDelivery();

  return (
    <TouchableOpacity
      style={styles.loadCard}
      onPress={onPress}
      activeOpacity={0.8}
    >
      {/* Card Header */}
      <View style={styles.loadCardHeader}>
        <View style={styles.loadCardHeaderLeft}>
          <Text style={styles.loadCardIcon}>📦</Text>
          <Text style={styles.loadCardTitle}>Load #{load.internalId}</Text>
          <View style={styles.tripBadge}>
            <Text style={styles.tripBadgeText}>Trip {tripNumber}</Text>
          </View>
        </View>
        <View style={styles.statusBadge}>
          <Text style={styles.statusBadgeText}>Scheduled</Text>
        </View>
      </View>

      {/* Multi-Day Indicator */}
      {multiDay && multiDayDate && (
        <View style={styles.multiDayBanner}>
          <Text style={styles.multiDayIcon}>📆</Text>
          <View>
            <Text style={styles.multiDayTitle}>Multi-Day Load</Text>
            <Text style={styles.multiDayText}>Continues into {multiDayDate}</Text>
          </View>
        </View>
      )}

      {/* Time and Stats */}
      <View style={styles.loadCardStats}>
        <View>
          <Text style={styles.statLabel}>Pickup Time</Text>
          <Text style={styles.statValue}>
            {formatTime(load.firstPickup?.windowBeginTime)}
          </Text>
        </View>
        <View style={styles.statRight}>
          <Text style={styles.statLabel}>Packages</Text>
          <Text style={styles.statValueMono}>{load.stopCount || '—'}</Text>
        </View>
      </View>

      {/* Addresses */}
      <View style={styles.addressSection}>
        <View style={styles.addressRow}>
          <Text style={styles.pickupIcon}>📍</Text>
          <View style={styles.addressContent}>
            <Text style={styles.addressLabel}>Pickup</Text>
            <Text style={styles.addressText}>{getAddress(load.firstPickup)}</Text>
          </View>
        </View>

        <View style={styles.addressRow}>
          <Text style={styles.deliveryIcon}>🚩</Text>
          <View style={styles.addressContent}>
            <Text style={styles.addressLabel}>Last Delivery</Text>
            <Text style={styles.addressText}>{getAddress(load.lastDelivery)}</Text>
            {expectedDelivery && (
              <Text style={styles.expectedText}>Expected: {expectedDelivery}</Text>
            )}
          </View>
        </View>
      </View>
    </TouchableOpacity>
  );
}

const styles = StyleSheet.create({
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
  currentLoadIcon: {
    fontSize: 28,
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

  // Scheduled Load Card
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
  },
  loadCardIcon: {
    fontSize: 14,
    color: colors.foregroundMuted,
  },
  loadCardTitle: {
    fontSize: typography.sm,
    fontWeight: typography.semibold,
    color: colors.foreground,
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
  multiDayIcon: {
    fontSize: 14,
    color: colors.chart3,
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
  pickupIcon: {
    fontSize: 14,
    color: colors.chart4,
    marginTop: 2,
  },
  deliveryIcon: {
    fontSize: 14,
    color: colors.destructive,
    marginTop: 2,
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
});
