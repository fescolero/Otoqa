import {
  View,
  Text,
  StyleSheet,
  SectionList,
  RefreshControl,
  Pressable,
  ActivityIndicator,
} from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useQuery } from 'convex/react';
import { api } from '../../../../../convex/_generated/api';
import { useCarrierOwner } from '../../_layout';
import { colors, typography, borderRadius, spacing } from '../../../../lib/theme';
import { Ionicons, MaterialCommunityIcons, Feather } from '@expo/vector-icons';
import { useState, useCallback, useRef, useMemo } from 'react';
import { useRouter } from 'expo-router';
import { useQueryHealth } from '../../../../lib/hooks/useQueryHealth';

type DateFilter = 'today' | 'tomorrow' | 'history';
type StatusFilter = 'needsDriver' | 'active' | 'completed';

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

function formatStopDateTime(dateStr?: string, timeStr?: string): string {
  if (!dateStr && !timeStr) return '';

  const parts: string[] = [];

  if (dateStr) {
    try {
      // windowBeginDate is an ISO date string (e.g. "2026-03-05" or "2026-03-05T00:00:00Z")
      // Parse date parts directly to avoid UTC-to-local timezone shift
      const [yearStr, monthStr, dayStr] = dateStr.split('T')[0].split('-');
      const localDate = new Date(Number(yearStr), Number(monthStr) - 1, Number(dayStr));
      if (!isNaN(localDate.getTime())) {
        parts.push(localDate.toLocaleDateString('en-US', { month: 'short', day: 'numeric' }));
      }
    } catch { /* skip */ }
  }

  if (timeStr) {
    try {
      // windowBeginTime is an ISO string with timezone offset (e.g. "2026-03-05T08:00:00-05:00")
      const time = new Date(timeStr);
      if (!isNaN(time.getTime())) {
        parts.push(time.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit', hour12: true }));
      }
    } catch { /* skip */ }
  }

  return parts.join(', ');
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

function getPickupDateKey(load: any): string {
  const firstStop = load.stops?.[0];
  if (!firstStop?.windowBeginDate) return 'no-date';
  return firstStop.windowBeginDate.split('T')[0];
}

function formatSectionTitle(dateKey: string): string {
  if (dateKey === 'no-date') return 'No Date';
  try {
    const [yearStr, monthStr, dayStr] = dateKey.split('-');
    const date = new Date(Number(yearStr), Number(monthStr) - 1, Number(dayStr));
    if (isNaN(date.getTime())) return 'No Date';

    const now = new Date();
    const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
    const tomorrow = new Date(today);
    tomorrow.setDate(tomorrow.getDate() + 1);
    const endOfWeek = new Date(today);
    endOfWeek.setDate(endOfWeek.getDate() + 6);

    const dateOnly = new Date(date.getFullYear(), date.getMonth(), date.getDate());

    if (dateOnly.getTime() === today.getTime()) {
      return `Today, ${date.toLocaleDateString('en-US', { month: 'short', day: 'numeric' })}`;
    }
    if (dateOnly.getTime() === tomorrow.getTime()) {
      return `Tomorrow, ${date.toLocaleDateString('en-US', { month: 'short', day: 'numeric' })}`;
    }
    if (dateOnly > today && dateOnly <= endOfWeek) {
      return date.toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric' });
    }
    return date.toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
  } catch {
    return 'No Date';
  }
}

function isDateKeyToday(dateKey: string): boolean {
  if (dateKey === 'no-date') return false;
  try {
    const now = new Date();
    const todayStr = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`;
    return dateKey === todayStr;
  } catch {
    return false;
  }
}

function groupByPickupDate(loads: any[]): { title: string; isToday: boolean; data: any[] }[] {
  const groups = new Map<string, any[]>();

  for (const load of loads) {
    const key = getPickupDateKey(load);
    const existing = groups.get(key);
    if (existing) {
      existing.push(load);
    } else {
      groups.set(key, [load]);
    }
  }

  const sortedKeys = Array.from(groups.keys()).sort((a, b) => {
    if (a === 'no-date') return 1;
    if (b === 'no-date') return -1;
    return b.localeCompare(a);
  });

  return sortedKeys.map((key) => ({
    title: formatSectionTitle(key),
    isToday: isDateKeyToday(key),
    data: groups.get(key)!,
  }));
}

const DATE_FILTER_CONFIG: { key: DateFilter; label: string }[] = [
  { key: 'today', label: 'Today' },
  { key: 'tomorrow', label: 'Tomorrow' },
  { key: 'history', label: 'History' },
];

const STATUS_FILTER_CONFIG: { key: StatusFilter; label: string }[] = [
  { key: 'needsDriver', label: 'Needs Driver' },
  { key: 'active', label: 'Active' },
  { key: 'completed', label: 'Completed' },
];

function getDateBounds(filter: DateFilter): { start: Date; end: Date } | null {
  const now = new Date();
  const todayStart = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  const todayEnd = new Date(todayStart);
  todayEnd.setDate(todayEnd.getDate() + 1);

  switch (filter) {
    case 'today':
      return { start: todayStart, end: todayEnd };
    case 'tomorrow': {
      const tomorrowStart = new Date(todayEnd);
      const tomorrowEnd = new Date(tomorrowStart);
      tomorrowEnd.setDate(tomorrowEnd.getDate() + 1);
      return { start: tomorrowStart, end: tomorrowEnd };
    }
    case 'history':
      return { start: new Date(0), end: todayStart };
  }
}

function loadMatchesDateFilter(load: any, filter: DateFilter): boolean {
  const firstStop = load.stops?.[0];
  if (!firstStop?.windowBeginDate) return filter === 'history';

  const dateStr = firstStop.windowBeginDate.split('T')[0];
  const [yearStr, monthStr, dayStr] = dateStr.split('-');
  const loadDate = new Date(Number(yearStr), Number(monthStr) - 1, Number(dayStr));

  const bounds = getDateBounds(filter);
  if (!bounds) return true;

  return loadDate >= bounds.start && loadDate < bounds.end;
}

export default function ManageLoadsScreen() {
  const insets = useSafeAreaInsets();
  const { carrierOrgId, carrierExternalOrgId } = useCarrierOwner();
  const router = useRouter();
  const [dateFilter, setDateFilter] = useState<DateFilter>('today');
  const [statusFilter, setStatusFilter] = useState<StatusFilter>('needsDriver');
  const [refreshing, setRefreshing] = useState(false);

  const loadQueryOrgId = carrierExternalOrgId || carrierOrgId;

  // Get active/assigned loads
  const activeLoadsLive = useQuery(
    api.carrierMobile.getActiveLoads,
    loadQueryOrgId ? { carrierOrgId: loadQueryOrgId, carrierConvexId: carrierOrgId || undefined } : 'skip'
  );

  // Get completed loads
  const completedLoadsLive = useQuery(
    api.carrierMobile.getCompletedLoads,
    loadQueryOrgId ? { carrierOrgId: loadQueryOrgId, limit: 50 } : 'skip'
  );

  // Cache last known data so transient auth failures (token refresh)
  // don't flash "No loads available" when loads actually exist
  const cachedActiveRef = useRef(activeLoadsLive);
  const cachedCompletedRef = useRef(completedLoadsLive);
  if (activeLoadsLive !== undefined && activeLoadsLive.length > 0) {
    cachedActiveRef.current = activeLoadsLive;
  } else if (activeLoadsLive !== undefined) {
    cachedActiveRef.current = activeLoadsLive;
  }
  if (completedLoadsLive !== undefined) {
    cachedCompletedRef.current = completedLoadsLive;
  }

  const activeLoads = activeLoadsLive ?? cachedActiveRef.current;
  const completedLoads = completedLoadsLive ?? cachedCompletedRef.current;
  const isLoading = activeLoads === undefined;

  useQueryHealth('getActiveLoads', activeLoadsLive, (d) => d.length === 0);
  useQueryHealth('getCompletedLoads', completedLoadsLive, (d) => d.length === 0);

  const onRefresh = useCallback(async () => {
    setRefreshing(true);
    setTimeout(() => setRefreshing(false), 1000);
  }, []);

  const allLoads = useMemo(() => {
    const active = activeLoads || [];
    const completed = completedLoads || [];
    const done = completed.filter((load) => load.status === 'COMPLETED');
    const canceledDeclined = active.filter(
      (load) => load.status === 'CANCELED' || load.status === 'DECLINED'
    );
    return [...active, ...done, ...canceledDeclined];
  }, [activeLoads, completedLoads]);

  const filterByStatus = useCallback((loads: any[], status: StatusFilter): any[] => {
    switch (status) {
      case 'needsDriver':
        return loads.filter(
          (load) => !load.driver && (load.status === 'ACCEPTED' || load.status === 'AWARDED')
        );
      case 'active':
        return loads.filter(
          (load) => load.driver && (load.status === 'ACCEPTED' || load.status === 'AWARDED' || load.status === 'IN_PROGRESS')
        );
      case 'completed':
        return loads.filter(
          (load) => load.status === 'COMPLETED' || load.status === 'CANCELED' || load.status === 'DECLINED'
        );
    }
  }, []);

  const dateFilteredLoads = useMemo(
    () => allLoads.filter((load) => loadMatchesDateFilter(load, dateFilter)),
    [allLoads, dateFilter]
  );

  const statusCounts: Record<StatusFilter, number> = useMemo(() => ({
    needsDriver: filterByStatus(dateFilteredLoads, 'needsDriver').length,
    active: filterByStatus(dateFilteredLoads, 'active').length,
    completed: filterByStatus(dateFilteredLoads, 'completed').length,
  }), [dateFilteredLoads, filterByStatus]);

  const flatData = useMemo(
    () => isLoading ? [] : filterByStatus(dateFilteredLoads, statusFilter),
    [isLoading, dateFilteredLoads, statusFilter, filterByStatus]
  );

  const sections = useMemo(() => groupByPickupDate(flatData), [flatData]);
  const totalCount = flatData.length;

  const renderLoadCard = ({ item }: { item: any }) => {
    const firstStop = item.stops?.[0];
    const lastStop = item.stops?.[item.stops?.length - 1];
    const driver = item.driver;
    
    // Get driver avatar info
    const driverFirstLetter = driver?.firstName?.charAt(0)?.toUpperCase() || '?';
    const driverAvatarColor = driver ? getAvatarColor(driver._id || driver.firstName || '') : colors.muted;

    return (
      <Pressable
        style={styles.loadCard}
        onPress={() => router.push({
          pathname: '/(app)/owner/assign-driver',
          params: { 
            assignmentId: item._id,
            loadInternalId: item.load?.internalId || 'N/A',
          },
        })}

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
              {firstStop?.city || 'Unknown'}, {firstStop?.state || ''} • {formatStopDateTime(firstStop?.windowBeginDate, firstStop?.windowBeginTime)}
            </Text>
          </View>
        </View>

        {/* Delivery Info */}
        <View style={styles.stopRow}>
          <View style={[styles.stopDot, styles.deliveryDot]} />
          <View style={styles.stopInfo}>
            <Text style={styles.stopLabel}>Delivery</Text>
            <Text style={styles.stopLocation}>
              {lastStop?.city || 'Unknown'}, {lastStop?.state || ''} • {formatStopDateTime(lastStop?.windowBeginDate, lastStop?.windowBeginTime)}
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
            <Pressable style={styles.detailsButton}>
              <Text style={styles.detailsButtonText}>Details</Text>
            </Pressable>
          )}
        </View>
      </Pressable>
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
        <Pressable style={styles.enableButton}>
          <Text style={styles.enableButtonText}>Enable</Text>
        </Pressable>
      </View>
    </View>
  );

  return (
    <View style={[styles.container, { paddingTop: insets.top }]}>
      {/* Header */}
      <View style={styles.header}>
        <Pressable onPress={() => router.back()} style={styles.backButton}>
          <Ionicons name="arrow-back" size={24} color={colors.foreground} />
        </Pressable>
        <Text style={styles.headerTitle}>Manage Loads</Text>
        <View style={{ width: 40 }} />
      </View>

      {/* Date Filter Bar */}
      <View style={styles.dateFilterContainer}>
        <View style={styles.dateFilterBar}>
          {DATE_FILTER_CONFIG.map(({ key, label }) => (
            <Pressable
              key={key}
              style={[styles.dateTab, dateFilter === key && styles.dateTabActive]}
              onPress={() => setDateFilter(key)}
            >
              <Text style={[styles.dateTabText, dateFilter === key && styles.dateTabTextActive]}>
                {label}
              </Text>
            </Pressable>
          ))}
        </View>
      </View>

      {/* Status Filter Bar */}
      <View style={styles.statusFilterContainer}>
        <View style={styles.statusFilterBar}>
          {STATUS_FILTER_CONFIG.map(({ key, label }) => (
            <Pressable
              key={key}
              style={[styles.statusTab, statusFilter === key && styles.statusTabActive]}
              onPress={() => setStatusFilter(key)}
            >
              <Text style={[styles.statusTabText, statusFilter === key && styles.statusTabTextActive]}>
                {label}
              </Text>
              {statusCounts[key] > 0 && (
                <View style={[styles.statusBadgeCount, statusFilter === key && styles.statusBadgeCountActive]}>
                  <Text style={[styles.statusBadgeCountText, statusFilter === key && styles.statusBadgeCountTextActive]}>
                    {statusCounts[key]}
                  </Text>
                </View>
              )}
            </Pressable>
          ))}
        </View>
      </View>

      {/* Section Header */}
      <View style={styles.sectionHeader}>
        <Text style={styles.sectionTitle}>
          {statusFilter === 'needsDriver' ? 'NEEDS DRIVER' : statusFilter === 'active' ? 'ACTIVE LOADS' : 'COMPLETED'}
        </Text>
        <Text style={styles.sectionCount}>{totalCount} load{totalCount !== 1 ? 's' : ''}</Text>
      </View>

      {/* Load List */}
      <SectionList
        sections={sections}
        renderItem={renderLoadCard}
        renderSectionHeader={({ section }) => {
          const { title, isToday } = section as { title: string; isToday: boolean; data: any[] };
          return (
            <View style={[styles.dateSectionHeader, isToday && styles.dateSectionHeaderToday]}>
              <View style={styles.dateSectionDivider} />
              <View style={[styles.dateSectionLabelWrap, isToday && styles.dateSectionLabelWrapToday]}>
                {isToday && (
                  <Ionicons name="radio-button-on" size={10} color={colors.primary} style={{ marginRight: 6 }} />
                )}
                <Text style={[styles.dateSectionTitle, isToday && styles.dateSectionTitleToday]}>
                  {title}
                </Text>
              </View>
              <View style={styles.dateSectionDivider} />
            </View>
          );
        }}
        keyExtractor={(item) => item._id}
        contentContainerStyle={styles.listContent}
        stickySectionHeadersEnabled
        refreshControl={
          <RefreshControl refreshing={refreshing} onRefresh={onRefresh} tintColor={colors.primary} />
        }
        ListEmptyComponent={isLoading ? () => (
          <View style={styles.loadingContainer}>
            <ActivityIndicator size="large" color={colors.primary} />
            <Text style={styles.loadingText}>Loading loads...</Text>
          </View>
        ) : renderEmptyState}
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
    paddingHorizontal: spacing.md,
    paddingTop: spacing.sm,
    paddingBottom: spacing.md,
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

  // Date Filter Bar
  dateFilterContainer: {
    paddingHorizontal: spacing.md,
    marginBottom: spacing.sm,
  },
  dateFilterBar: {
    flexDirection: 'row',
    backgroundColor: colors.muted,
    borderRadius: 24,
    padding: 3,
  },
  dateTab: {
    flex: 1,
    paddingVertical: 10,
    borderRadius: 22,
    alignItems: 'center',
    justifyContent: 'center',
  },
  dateTabActive: {
    backgroundColor: colors.foreground,
  },
  dateTabText: {
    fontSize: typography.base,
    fontWeight: '600',
    color: colors.foregroundMuted,
  },
  dateTabTextActive: {
    color: colors.background,
  },

  // Status Filter Bar
  statusFilterContainer: {
    paddingHorizontal: spacing.md,
    marginBottom: spacing.sm,
  },
  statusFilterBar: {
    flexDirection: 'row',
    gap: spacing.sm,
  },
  statusTab: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    paddingVertical: 8,
    paddingHorizontal: 14,
    borderRadius: 20,
    backgroundColor: colors.card,
    borderWidth: 1,
    borderColor: colors.border,
  },
  statusTabActive: {
    backgroundColor: colors.primary,
    borderColor: colors.primary,
  },
  statusTabText: {
    fontSize: typography.sm,
    fontWeight: '600',
    color: colors.foreground,
  },
  statusTabTextActive: {
    color: colors.primaryForeground,
  },
  statusBadgeCount: {
    backgroundColor: colors.muted,
    borderRadius: 10,
    minWidth: 20,
    height: 20,
    alignItems: 'center',
    justifyContent: 'center',
    paddingHorizontal: 6,
  },
  statusBadgeCountActive: {
    backgroundColor: 'rgba(26, 29, 33, 0.3)',
  },
  statusBadgeCountText: {
    fontSize: typography.xs,
    fontWeight: '700',
    color: colors.foreground,
  },
  statusBadgeCountTextActive: {
    color: colors.primaryForeground,
  },

  // Date Section Headers
  dateSectionHeader: {
    backgroundColor: colors.background,
    flexDirection: 'row',
    alignItems: 'center',
    paddingVertical: spacing.sm,
    gap: spacing.sm,
  },
  dateSectionHeaderToday: {},
  dateSectionDivider: {
    flex: 1,
    height: 1,
    backgroundColor: colors.border,
  },
  dateSectionLabelWrap: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: spacing.sm,
    paddingVertical: 2,
    borderRadius: borderRadius.md,
  },
  dateSectionLabelWrapToday: {
    backgroundColor: colors.primary + '18',
    paddingHorizontal: spacing.md,
    paddingVertical: 4,
    borderRadius: 20,
  },
  dateSectionTitle: {
    fontSize: typography.base,
    fontWeight: '700',
    color: colors.foregroundMuted,
  },
  dateSectionTitleToday: {
    color: colors.primary,
  },

  // Section Header
  sectionHeader: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    paddingHorizontal: spacing.md,
    marginBottom: spacing.xs,
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
    paddingHorizontal: spacing.md,
    paddingBottom: 100,
  },

  // Load Card
  loadCard: {
    backgroundColor: colors.card,
    borderRadius: borderRadius.xl,
    padding: spacing.base,
    marginBottom: spacing.sm,
  },
  loadHeader: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    marginBottom: spacing.sm,
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
    marginBottom: spacing.sm,
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
    marginBottom: spacing.xs,
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
    marginTop: spacing.sm,
    paddingTop: spacing.sm,
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
  loadingContainer: {
    paddingTop: 80,
    alignItems: 'center' as const,
    justifyContent: 'center' as const,
  },
  loadingText: {
    color: colors.foregroundMuted,
    marginTop: 16,
    fontSize: typography.base,
  },
});
