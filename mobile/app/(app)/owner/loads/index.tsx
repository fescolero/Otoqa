import {
  View,
  Text,
  StyleSheet,
  FlatList,
  RefreshControl,
  TouchableOpacity,
  ScrollView,
} from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useQuery } from 'convex/react';
import { api } from '../../../../../convex/_generated/api';
import { useCarrierOwner } from '../../_layout';
import { colors, typography, borderRadius, shadows, spacing } from '../../../../lib/theme';
import { Ionicons, MaterialCommunityIcons, Feather } from '@expo/vector-icons';
import { useState, useCallback } from 'react';
import { useRouter } from 'expo-router';

// ============================================
// MANAGE LOADS SCREEN
// View and manage all carrier loads
// ============================================

type TabType = 'unassigned' | 'assigned' | 'completed' | 'canceled';

// Avatar color palette
const AVATAR_COLORS = [
  '#FF6B6B', '#4ECDC4', '#45B7D1', '#96CEB4', '#FFEAA7',
  '#DDA0DD', '#98D8C8', '#F7DC6F', '#BB8FCE', '#85C1E9',
];

function getAvatarColor(str: string): string {
  let hash = 0;
  for (let i = 0; i < str.length; i++) {
    hash = str.charCodeAt(i) + ((hash << 5) - hash);
  }
  return AVATAR_COLORS[Math.abs(hash) % AVATAR_COLORS.length];
}

function formatDate(dateStr?: string): string {
  if (!dateStr) return '';
  try {
    const date = new Date(dateStr);
    return date.toLocaleDateString('en-US', { 
      month: 'short', 
      day: 'numeric',
      hour: 'numeric',
      minute: '2-digit',
      hour12: true,
    });
  } catch {
    return dateStr;
  }
}

function getRelativeTime(dateStr?: string): string {
  if (!dateStr) return '';
  try {
    const date = new Date(dateStr);
    const now = new Date();
    const diffMs = now.getTime() - date.getTime();
    const diffDays = Math.floor(diffMs / (1000 * 60 * 60 * 24));
    
    if (diffDays === 0) return 'Today';
    if (diffDays === 1) return '1d ago';
    if (diffDays < 7) return `${diffDays}d ago`;
    if (diffDays < 30) return `${Math.floor(diffDays / 7)}w ago`;
    return `${Math.floor(diffDays / 30)}mo ago`;
  } catch {
    return '';
  }
}

export default function ManageLoadsScreen() {
  const insets = useSafeAreaInsets();
  const { carrierOrgId, carrierExternalOrgId } = useCarrierOwner();
  const router = useRouter();
  const [activeTab, setActiveTab] = useState<TabType>('unassigned');
  const [refreshing, setRefreshing] = useState(false);

  const loadQueryOrgId = carrierExternalOrgId || carrierOrgId;

  // Get active/assigned loads
  const activeLoads = useQuery(
    api.carrierMobile.getActiveLoads,
    loadQueryOrgId ? { carrierOrgId: loadQueryOrgId, carrierConvexId: carrierOrgId || undefined } : 'skip'
  );

  // Get completed loads
  const completedLoads = useQuery(
    api.carrierMobile.getCompletedLoads,
    loadQueryOrgId ? { carrierOrgId: loadQueryOrgId, limit: 50 } : 'skip'
  );

  const onRefresh = useCallback(async () => {
    setRefreshing(true);
    setTimeout(() => setRefreshing(false), 1000);
  }, []);

  // Filter loads based on tab
  const getDataForTab = () => {
    switch (activeTab) {
      case 'unassigned':
        return (activeLoads || []).filter(
          (load) => !load.driver && (load.status === 'ACCEPTED' || load.status === 'AWARDED')
        );
      case 'assigned':
        return (activeLoads || []).filter(
          (load) => load.driver && (load.status === 'ACCEPTED' || load.status === 'AWARDED' || load.status === 'IN_PROGRESS')
        );
      case 'completed':
        return (completedLoads || []).filter((load) => load.status === 'COMPLETED');
      case 'canceled':
        return [...(activeLoads || []), ...(completedLoads || [])].filter(
          (load) => load.status === 'CANCELED' || load.status === 'DECLINED'
        );
    }
  };

  const data = getDataForTab();
  const totalCount = data.length;

  const renderLoadCard = ({ item }: { item: any }) => {
    const firstStop = item.stops?.[0];
    const lastStop = item.stops?.[item.stops?.length - 1];
    const driver = item.driver;
    
    // Get driver avatar info
    const driverFirstLetter = driver?.firstName?.charAt(0)?.toUpperCase() || '?';
    const driverAvatarColor = driver ? getAvatarColor(driver._id || driver.firstName || '') : colors.muted;

    return (
      <TouchableOpacity
        style={styles.loadCard}
        onPress={() => router.push({
          pathname: '/(app)/owner/assign-driver',
          params: { 
            assignmentId: item._id,
            loadInternalId: item.load?.internalId || 'N/A',
          },
        })}
        activeOpacity={0.8}
      >
        {/* Header Row */}
        <View style={styles.loadHeader}>
          <View style={styles.loadIdRow}>
            <MaterialCommunityIcons name="truck-delivery" size={18} color={colors.foreground} />
            <Text style={styles.loadId}>Load #{item.load?.internalId || 'N/A'}</Text>
          </View>
          <View style={[styles.assignmentBadge, { backgroundColor: driver ? colors.success : '#F59E0B' }]}>
            <Text style={styles.assignmentBadgeText} maxFontSizeMultiplier={1.2}>
              {driver ? 'Assigned' : 'Unassigned'}
            </Text>
          </View>
        </View>

        {/* Badge Row */}
        <View style={styles.badgeRow}>
          {item.load?.hcr && (
            <View style={styles.hcrBadge}>
              <Text style={styles.hcrBadgeText} maxFontSizeMultiplier={1.2}>HCR {item.load.hcr}</Text>
            </View>
          )}
          {item.load?.tripNumber && (
            <View style={styles.tripBadge}>
              <Text style={styles.tripBadgeText} maxFontSizeMultiplier={1.2}>Trip {item.load.tripNumber}</Text>
            </View>
          )}
        </View>

        {/* Pickup Info */}
        <View style={styles.stopRow}>
          <View style={styles.stopDot} />
          <View style={styles.stopInfo}>
            <Text style={styles.stopLabel}>Pickup</Text>
            <Text style={styles.stopLocation}>
              {firstStop?.city || 'Unknown'}, {firstStop?.state || ''} • {formatDate(firstStop?.windowBeginDate)}
            </Text>
          </View>
        </View>

        {/* Delivery Info */}
        <View style={styles.stopRow}>
          <View style={[styles.stopDot, styles.deliveryDot]} />
          <View style={styles.stopInfo}>
            <Text style={styles.stopLabel}>Delivery</Text>
            <Text style={styles.stopLocation}>
              {lastStop?.city || 'Unknown'}, {lastStop?.state || ''} • {formatDate(lastStop?.windowBeginDate)}
            </Text>
          </View>
        </View>

        {/* Footer Row */}
        <View style={styles.loadFooter}>
          {driver ? (
            <View style={styles.driverRow}>
              <View style={[styles.driverAvatar, { backgroundColor: driverAvatarColor }]}>
                <Text style={styles.driverAvatarText}>{driverFirstLetter}</Text>
              </View>
              <Text style={styles.driverName}>{driver.firstName} {driver.lastName}</Text>
            </View>
          ) : (
            <View style={styles.driverRow}>
              <View style={[styles.driverAvatar, { backgroundColor: colors.muted }]}>
                <Ionicons name="person-outline" size={14} color={colors.foregroundMuted} />
              </View>
              <Text style={styles.driverNameMuted}>Unassigned</Text>
            </View>
          )}

          {item.status === 'COMPLETED' ? (
            <View style={styles.completedInfo}>
              <Ionicons name="checkmark-circle" size={16} color={colors.success} />
              <Text style={styles.completedText}>Delivered {getRelativeTime(item.completedAt)}</Text>
            </View>
          ) : (
            <TouchableOpacity style={styles.detailsButton}>
              <Text style={styles.detailsButtonText}>Details</Text>
            </TouchableOpacity>
          )}
        </View>
      </TouchableOpacity>
    );
  };

  const renderEmptyState = () => (
    <View style={styles.emptyStateContainer}>
      <View style={styles.emptyStateCard}>
        <View style={styles.emptyStateIconContainer}>
          <Feather name="package" size={32} color={colors.primary} />
        </View>
        <Text style={styles.emptyStateTitle}>No loads available</Text>
        <Text style={styles.emptyStateSubtitle}>
          We couldn't find any loads matching your current filters or location. Try broadening your search or check back in a few minutes.
        </Text>
      </View>

      {/* Load Alerts Card */}
      <View style={styles.alertsCard}>
        <View style={styles.alertsIconContainer}>
          <Ionicons name="notifications" size={20} color={colors.primary} />
        </View>
        <View style={styles.alertsContent}>
          <Text style={styles.alertsTitle}>Load Alerts</Text>
          <Text style={styles.alertsSubtitle}>Notify me when new loads are posted</Text>
        </View>
        <TouchableOpacity style={styles.enableButton}>
          <Text style={styles.enableButtonText}>Enable</Text>
        </TouchableOpacity>
      </View>
    </View>
  );

  return (
    <View style={[styles.container, { paddingTop: insets.top }]}>
      {/* Header */}
      <View style={styles.header}>
        <TouchableOpacity onPress={() => router.back()} style={styles.backButton}>
          <Ionicons name="arrow-back" size={24} color={colors.foreground} />
        </TouchableOpacity>
        <Text style={styles.headerTitle}>Manage Loads</Text>
        <View style={{ width: 40 }} />
      </View>

      {/* Tab Bar */}
      <View style={styles.tabBarContainer}>
        <ScrollView 
          horizontal 
          showsHorizontalScrollIndicator={false}
          contentContainerStyle={styles.tabBar}
        >
          {(['unassigned', 'assigned', 'completed', 'canceled'] as TabType[]).map((tab) => (
            <TouchableOpacity
              key={tab}
              style={[styles.tab, activeTab === tab && styles.activeTab]}
              onPress={() => setActiveTab(tab)}
            >
              <Text style={[styles.tabText, activeTab === tab && styles.activeTabText]}>
                {tab.charAt(0).toUpperCase() + tab.slice(1)}
              </Text>
            </TouchableOpacity>
          ))}
        </ScrollView>
      </View>

      {/* Section Header */}
      <View style={styles.sectionHeader}>
        <Text style={styles.sectionTitle}>ACTIVE & RECENT</Text>
        <Text style={styles.sectionCount}>Showing {totalCount} loads</Text>
      </View>

      {/* Load List */}
      <FlatList
        data={data}
        renderItem={renderLoadCard}
        keyExtractor={(item) => item._id}
        contentContainerStyle={styles.listContent}
        refreshControl={
          <RefreshControl refreshing={refreshing} onRefresh={onRefresh} tintColor={colors.primary} />
        }
        ListEmptyComponent={renderEmptyState}
        showsVerticalScrollIndicator={false}
      />
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: colors.background,
  },
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: spacing.lg,
    paddingVertical: spacing.md,
  },
  backButton: {
    width: 40,
    height: 40,
    borderRadius: 20,
    backgroundColor: colors.card,
    alignItems: 'center',
    justifyContent: 'center',
  },
  headerTitle: {
    fontSize: typography.xl,
    fontWeight: '700',
    color: colors.foreground,
  },

  // Tab Bar
  tabBarContainer: {
    marginBottom: spacing.md,
  },
  tabBar: {
    flexDirection: 'row',
    paddingHorizontal: spacing.lg,
    gap: spacing.sm,
    alignItems: 'center',
  },
  tab: {
    paddingVertical: 8,
    paddingHorizontal: 16,
    borderRadius: 20,
    backgroundColor: colors.card,
    borderWidth: 1,
    borderColor: colors.border,
  },
  activeTab: {
    backgroundColor: colors.primary,
    borderColor: colors.primary,
  },
  tabText: {
    fontSize: typography.sm,
    fontWeight: '600',
    color: colors.foreground,
  },
  activeTabText: {
    color: colors.primaryForeground,
  },

  // Section Header
  sectionHeader: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    paddingHorizontal: spacing.lg,
    marginBottom: spacing.md,
  },
  sectionTitle: {
    fontSize: typography.sm,
    fontWeight: '600',
    color: colors.foregroundMuted,
    letterSpacing: 0.5,
  },
  sectionCount: {
    fontSize: typography.sm,
    color: colors.foregroundMuted,
  },

  // List
  listContent: {
    paddingHorizontal: spacing.lg,
    paddingBottom: 120,
  },

  // Load Card
  loadCard: {
    backgroundColor: colors.card,
    borderRadius: borderRadius.xl,
    padding: spacing.lg,
    marginBottom: spacing.md,
    ...shadows.md,
  },
  loadHeader: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    marginBottom: spacing.md,
  },
  loadIdRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.sm,
  },
  loadId: {
    fontSize: typography.base,
    fontWeight: '700',
    color: colors.foreground,
  },
  badgeRow: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: spacing.xs,
    marginBottom: spacing.md,
  },
  hcrBadge: {
    backgroundColor: colors.muted,
    paddingHorizontal: 10,
    paddingVertical: 4,
    borderRadius: borderRadius.sm,
  },
  hcrBadgeText: {
    fontSize: typography.xs,
    fontWeight: '600',
    color: colors.foreground,
  },
  tripBadge: {
    backgroundColor: '#3B82F6',
    paddingHorizontal: 10,
    paddingVertical: 4,
    borderRadius: borderRadius.sm,
  },
  tripBadgeText: {
    fontSize: typography.xs,
    fontWeight: '600',
    color: '#FFFFFF',
  },
  assignmentBadge: {
    paddingHorizontal: 10,
    paddingVertical: 4,
    borderRadius: borderRadius.sm,
  },
  assignmentBadgeText: {
    fontSize: typography.xs,
    fontWeight: '600',
    color: '#FFFFFF',
  },
  statusBadge: {
    paddingHorizontal: 10,
    paddingVertical: 4,
    borderRadius: borderRadius.sm,
  },
  statusText: {
    fontSize: typography.xs,
    fontWeight: '600',
  },

  // Stop Row
  stopRow: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    marginBottom: spacing.sm,
    paddingLeft: spacing.xs,
  },
  stopDot: {
    width: 8,
    height: 8,
    borderRadius: 4,
    backgroundColor: colors.success,
    marginTop: 6,
    marginRight: spacing.md,
  },
  deliveryDot: {
    backgroundColor: colors.destructive,
  },
  stopInfo: {
    flex: 1,
  },
  stopLabel: {
    fontSize: typography.xs,
    color: colors.foregroundMuted,
    marginBottom: 2,
  },
  stopLocation: {
    fontSize: typography.sm,
    color: colors.foreground,
    fontWeight: '500',
  },

  // Footer
  loadFooter: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    marginTop: spacing.md,
    paddingTop: spacing.md,
    borderTopWidth: 1,
    borderTopColor: colors.border,
  },
  driverRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.sm,
  },
  driverAvatar: {
    width: 28,
    height: 28,
    borderRadius: 14,
    alignItems: 'center',
    justifyContent: 'center',
  },
  driverAvatarText: {
    fontSize: typography.sm,
    fontWeight: '600',
    color: '#FFFFFF',
  },
  driverName: {
    fontSize: typography.sm,
    fontWeight: '500',
    color: colors.foreground,
  },
  driverNameMuted: {
    fontSize: typography.sm,
    color: colors.foregroundMuted,
  },
  detailsButton: {
    backgroundColor: 'transparent',
    borderWidth: 1,
    borderColor: colors.primary,
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.xs,
    borderRadius: borderRadius.md,
  },
  detailsButtonText: {
    fontSize: typography.sm,
    fontWeight: '600',
    color: colors.primary,
  },
  completedInfo: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.xs,
  },
  completedText: {
    fontSize: typography.sm,
    color: colors.success,
    fontWeight: '500',
  },

  // Empty State
  emptyStateContainer: {
    paddingTop: spacing.xl,
  },
  emptyStateCard: {
    backgroundColor: colors.card,
    borderRadius: borderRadius.xl,
    padding: spacing.xl,
    paddingVertical: spacing.xl * 2,
    alignItems: 'center',
    ...shadows.md,
  },
  emptyStateIconContainer: {
    width: 72,
    height: 72,
    borderRadius: 36,
    backgroundColor: colors.muted,
    alignItems: 'center',
    justifyContent: 'center',
    marginBottom: spacing.lg,
  },
  emptyStateTitle: {
    fontSize: typography.xl,
    fontWeight: '700',
    color: colors.foreground,
    marginBottom: spacing.sm,
    textAlign: 'center',
  },
  emptyStateSubtitle: {
    fontSize: typography.sm,
    color: colors.foregroundMuted,
    textAlign: 'center',
    lineHeight: 20,
    paddingHorizontal: spacing.md,
  },

  // Alerts Card
  alertsCard: {
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: colors.card,
    borderRadius: borderRadius.xl,
    padding: spacing.lg,
    marginTop: spacing.md,
    ...shadows.sm,
  },
  alertsIconContainer: {
    width: 40,
    height: 40,
    borderRadius: 20,
    backgroundColor: colors.muted,
    alignItems: 'center',
    justifyContent: 'center',
    marginRight: spacing.md,
  },
  alertsContent: {
    flex: 1,
  },
  alertsTitle: {
    fontSize: typography.base,
    fontWeight: '600',
    color: colors.foreground,
  },
  alertsSubtitle: {
    fontSize: typography.sm,
    color: colors.foregroundMuted,
  },
  enableButton: {
    backgroundColor: colors.primary,
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.sm,
    borderRadius: borderRadius.md,
  },
  enableButtonText: {
    fontSize: typography.sm,
    fontWeight: '600',
    color: colors.foreground,
  },
});
