import { View, Text, StyleSheet, TouchableOpacity, ScrollView, RefreshControl, Linking, Platform } from 'react-native';
import { useQuery } from 'convex/react';
import { api } from '../../../../convex/_generated/api';
import { useCarrierOwner } from '../_layout';
import { colors, typography, borderRadius, shadows, spacing } from '../../../lib/theme';
import { Ionicons } from '@expo/vector-icons';
import { useState, useCallback } from 'react';

// ============================================
// DRIVER TRACKING SCREEN
// Shows all drivers with their current status
// Map requires development build (not available in Expo Go)
// ============================================

export default function TrackingScreen() {
  const { carrierOrgId } = useCarrierOwner();
  const [refreshing, setRefreshing] = useState(false);
  const [selectedDriver, setSelectedDriver] = useState<string | null>(null);

  const driverLocations = useQuery(
    api.carrierMobile.getDriverLocations,
    carrierOrgId ? { carrierOrgId } : 'skip'
  );

  const onRefresh = useCallback(() => {
    setRefreshing(true);
    // Query will auto-refresh, just show the indicator briefly
    setTimeout(() => setRefreshing(false), 1000);
  }, []);

  const handleCall = (phone: string) => {
    Linking.openURL(`tel:${phone}`);
  };

  const handleDirections = (latitude: number, longitude: number) => {
    const url = Platform.select({
      ios: `maps:0,0?q=${latitude},${longitude}`,
      android: `geo:0,0?q=${latitude},${longitude}`,
    });
    if (url) Linking.openURL(url);
  };

  const formatTime = (timestamp: number) => {
    const date = new Date(timestamp);
    const now = new Date();
    const diffMs = now.getTime() - date.getTime();
    const diffMins = Math.floor(diffMs / 60000);
    
    if (diffMins < 1) return 'Just now';
    if (diffMins < 60) return `${diffMins}m ago`;
    if (diffMins < 1440) return `${Math.floor(diffMins / 60)}h ago`;
    return date.toLocaleDateString();
  };

  const activeDrivers = driverLocations?.filter(d => d.currentLoad) || [];
  const availableDrivers = driverLocations?.filter(d => !d.currentLoad) || [];

  return (
    <View style={styles.container}>
      {/* Header Stats */}
      <View style={styles.statsRow}>
        <View style={styles.statCard}>
          <View style={[styles.statIcon, { backgroundColor: colors.primary + '20' }]}>
            <Ionicons name="people" size={20} color={colors.primary} />
          </View>
          <Text style={styles.statValue}>{driverLocations?.length || 0}</Text>
          <Text style={styles.statLabel}>Total Drivers</Text>
        </View>
        <View style={styles.statCard}>
          <View style={[styles.statIcon, { backgroundColor: colors.warning + '20' }]}>
            <Ionicons name="car" size={20} color={colors.warning} />
          </View>
          <Text style={styles.statValue}>{activeDrivers.length}</Text>
          <Text style={styles.statLabel}>On Load</Text>
        </View>
        <View style={styles.statCard}>
          <View style={[styles.statIcon, { backgroundColor: colors.success + '20' }]}>
            <Ionicons name="checkmark-circle" size={20} color={colors.success} />
          </View>
          <Text style={styles.statValue}>{availableDrivers.length}</Text>
          <Text style={styles.statLabel}>Available</Text>
        </View>
      </View>

      <ScrollView
        style={styles.scrollView}
        contentContainerStyle={styles.scrollContent}
        refreshControl={
          <RefreshControl
            refreshing={refreshing}
            onRefresh={onRefresh}
            tintColor={colors.primary}
          />
        }
      >
        {/* Active Drivers Section */}
        {activeDrivers.length > 0 && (
          <View style={styles.section}>
            <Text style={styles.sectionTitle}>
              <Ionicons name="car" size={16} color={colors.warning} /> On Load
            </Text>
            {activeDrivers.map((driverLoc) => (
              <TouchableOpacity
                key={driverLoc.driver._id}
                style={[
                  styles.driverCard,
                  selectedDriver === driverLoc.driver._id && styles.selectedCard,
                ]}
                onPress={() =>
                  setSelectedDriver(
                    selectedDriver === driverLoc.driver._id ? null : driverLoc.driver._id
                  )
                }
                activeOpacity={0.7}
              >
                <View style={styles.driverRow}>
                  <View style={[styles.statusDot, styles.activeDot]} />
                  <View style={styles.driverInfo}>
                    <Text style={styles.driverName}>
                      {driverLoc.driver.firstName} {driverLoc.driver.lastName}
                    </Text>
                    <Text style={styles.driverPhone}>{driverLoc.driver.phone}</Text>
                  </View>
                  <View style={styles.loadBadge}>
                    <Text style={styles.loadBadgeText} maxFontSizeMultiplier={1.2}>
                      {driverLoc.currentLoad?.internalId}
                    </Text>
                  </View>
                </View>

                {driverLoc.currentLoad && (
                  <View style={styles.loadDetails}>
                    <Text style={styles.customerName}>
                      {driverLoc.currentLoad.customerName}
                    </Text>
                  </View>
                )}

                <View style={styles.locationRow}>
                  <Ionicons name="location" size={14} color={colors.foregroundMuted} />
                  <Text style={styles.locationText}>
                    {formatTime(driverLoc.location.recordedAt)}
                  </Text>
                  {driverLoc.location.speed !== undefined && driverLoc.location.speed > 0 && (
                    <Text style={styles.speedText}>
                      • {Math.round(driverLoc.location.speed * 2.237)} mph
                    </Text>
                  )}
                </View>

                {selectedDriver === driverLoc.driver._id && (
                  <View style={styles.actionRow}>
                    <TouchableOpacity
                      style={styles.actionButton}
                      onPress={() => handleCall(driverLoc.driver.phone)}
                    >
                      <Ionicons name="call" size={18} color={colors.primary} />
                      <Text style={styles.actionText}>Call</Text>
                    </TouchableOpacity>
                    <TouchableOpacity
                      style={styles.actionButton}
                      onPress={() =>
                        handleDirections(
                          driverLoc.location.latitude,
                          driverLoc.location.longitude
                        )
                      }
                    >
                      <Ionicons name="navigate" size={18} color={colors.primary} />
                      <Text style={styles.actionText}>Directions</Text>
                    </TouchableOpacity>
                  </View>
                )}
              </TouchableOpacity>
            ))}
          </View>
        )}

        {/* Available Drivers Section */}
        {availableDrivers.length > 0 && (
          <View style={styles.section}>
            <Text style={styles.sectionTitle}>
              <Ionicons name="checkmark-circle" size={16} color={colors.success} /> Available
            </Text>
            {availableDrivers.map((driverLoc) => (
              <TouchableOpacity
                key={driverLoc.driver._id}
                style={[
                  styles.driverCard,
                  selectedDriver === driverLoc.driver._id && styles.selectedCard,
                ]}
                onPress={() =>
                  setSelectedDriver(
                    selectedDriver === driverLoc.driver._id ? null : driverLoc.driver._id
                  )
                }
                activeOpacity={0.7}
              >
                <View style={styles.driverRow}>
                  <View style={[styles.statusDot, styles.availableDot]} />
                  <View style={styles.driverInfo}>
                    <Text style={styles.driverName}>
                      {driverLoc.driver.firstName} {driverLoc.driver.lastName}
                    </Text>
                    <Text style={styles.driverPhone}>{driverLoc.driver.phone}</Text>
                  </View>
                  <View style={[styles.loadBadge, styles.availableBadge]}>
                    <Text style={[styles.loadBadgeText, styles.availableBadgeText]}>
                      Available
                    </Text>
                  </View>
                </View>

                <View style={styles.locationRow}>
                  <Ionicons name="location" size={14} color={colors.foregroundMuted} />
                  <Text style={styles.locationText}>
                    {formatTime(driverLoc.location.recordedAt)}
                  </Text>
                </View>

                {selectedDriver === driverLoc.driver._id && (
                  <View style={styles.actionRow}>
                    <TouchableOpacity
                      style={styles.actionButton}
                      onPress={() => handleCall(driverLoc.driver.phone)}
                    >
                      <Ionicons name="call" size={18} color={colors.primary} />
                      <Text style={styles.actionText}>Call</Text>
                    </TouchableOpacity>
                    <TouchableOpacity
                      style={styles.actionButton}
                      onPress={() =>
                        handleDirections(
                          driverLoc.location.latitude,
                          driverLoc.location.longitude
                        )
                      }
                    >
                      <Ionicons name="navigate" size={18} color={colors.primary} />
                      <Text style={styles.actionText}>Directions</Text>
                    </TouchableOpacity>
                  </View>
                )}
              </TouchableOpacity>
            ))}
          </View>
        )}

        {/* Empty State */}
        {(!driverLocations || driverLocations.length === 0) && (
          <View style={styles.emptyState}>
            <Ionicons name="location-outline" size={48} color={colors.foregroundMuted} />
            <Text style={styles.emptyTitle}>No Active Drivers</Text>
            <Text style={styles.emptySubtext}>
              Driver locations will appear here when they check in to a load
            </Text>
          </View>
        )}
      </ScrollView>
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: colors.background,
  },
  statsRow: {
    flexDirection: 'row',
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.md,
    gap: spacing.sm,
  },
  statCard: {
    flex: 1,
    backgroundColor: colors.card,
    borderRadius: borderRadius.lg,
    padding: spacing.md,
    alignItems: 'center',
    ...shadows.sm,
  },
  statIcon: {
    width: 40,
    height: 40,
    borderRadius: 20,
    justifyContent: 'center',
    alignItems: 'center',
    marginBottom: spacing.xs,
  },
  statValue: {
    fontSize: typography.xl,
    fontWeight: '700',
    color: colors.foreground,
  },
  statLabel: {
    fontSize: typography.xs,
    color: colors.foregroundMuted,
  },
  scrollView: {
    flex: 1,
  },
  scrollContent: {
    paddingHorizontal: spacing.md,
    paddingBottom: 100,
  },
  section: {
    marginBottom: spacing.lg,
  },
  sectionTitle: {
    fontSize: typography.sm,
    fontWeight: '600',
    color: colors.foregroundMuted,
    marginBottom: spacing.sm,
    textTransform: 'uppercase',
    letterSpacing: 0.5,
  },
  driverCard: {
    backgroundColor: colors.card,
    borderRadius: borderRadius.lg,
    padding: spacing.md,
    marginBottom: spacing.sm,
    borderWidth: 1,
    borderColor: colors.border,
  },
  selectedCard: {
    borderColor: colors.primary,
    borderWidth: 2,
  },
  driverRow: {
    flexDirection: 'row',
    alignItems: 'center',
  },
  statusDot: {
    width: 10,
    height: 10,
    borderRadius: 5,
    marginRight: spacing.sm,
  },
  activeDot: {
    backgroundColor: colors.warning,
  },
  availableDot: {
    backgroundColor: colors.success,
  },
  driverInfo: {
    flex: 1,
  },
  driverName: {
    fontSize: typography.base,
    fontWeight: '600',
    color: colors.foreground,
  },
  driverPhone: {
    fontSize: typography.sm,
    color: colors.foregroundMuted,
  },
  loadBadge: {
    backgroundColor: colors.warning + '20',
    paddingHorizontal: spacing.sm,
    paddingVertical: spacing.xs,
    borderRadius: borderRadius.sm,
  },
  loadBadgeText: {
    fontSize: typography.xs,
    fontWeight: '600',
    color: colors.warning,
  },
  availableBadge: {
    backgroundColor: colors.success + '20',
  },
  availableBadgeText: {
    color: colors.success,
  },
  loadDetails: {
    marginTop: spacing.sm,
    paddingTop: spacing.sm,
    borderTopWidth: 1,
    borderTopColor: colors.border,
  },
  customerName: {
    fontSize: typography.sm,
    color: colors.foregroundMuted,
  },
  locationRow: {
    flexDirection: 'row',
    alignItems: 'center',
    marginTop: spacing.sm,
    gap: spacing.xs,
  },
  locationText: {
    fontSize: typography.xs,
    color: colors.foregroundMuted,
  },
  speedText: {
    fontSize: typography.xs,
    color: colors.foregroundMuted,
  },
  actionRow: {
    flexDirection: 'row',
    gap: spacing.sm,
    marginTop: spacing.md,
    paddingTop: spacing.md,
    borderTopWidth: 1,
    borderTopColor: colors.border,
  },
  actionButton: {
    flex: 1,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: spacing.xs,
    paddingVertical: spacing.sm,
    backgroundColor: colors.muted,
    borderRadius: borderRadius.md,
  },
  actionText: {
    fontSize: typography.sm,
    color: colors.primary,
    fontWeight: '500',
  },
  emptyState: {
    alignItems: 'center',
    paddingVertical: spacing.xl * 2,
  },
  emptyTitle: {
    fontSize: typography.lg,
    fontWeight: '600',
    color: colors.foreground,
    marginTop: spacing.md,
  },
  emptySubtext: {
    fontSize: typography.sm,
    color: colors.foregroundMuted,
    textAlign: 'center',
    marginTop: spacing.xs,
    paddingHorizontal: spacing.lg,
  },
});
