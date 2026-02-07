import {
  View,
  Text,
  StyleSheet,
  ScrollView,
  RefreshControl,
  TouchableOpacity,
} from 'react-native';
import { useQuery } from 'convex/react';
import { api } from '../../../../convex/_generated/api';
import { useCarrierOwner } from '../_layout';
import { colors, typography, borderRadius, shadows, spacing } from '../../../lib/theme';
import { Ionicons } from '@expo/vector-icons';
import { useState, useCallback } from 'react';

// ============================================
// SETTLEMENTS / EARNINGS SCREEN
// Revenue tracking and payment status
// ============================================

type PeriodType = 7 | 30 | 90;

export default function SettlementsScreen() {
  const { carrierOrgId } = useCarrierOwner();
  const [refreshing, setRefreshing] = useState(false);
  const [period, setPeriod] = useState<PeriodType>(30);

  const earningsSummary = useQuery(
    api.carrierMobile.getEarningsSummary,
    carrierOrgId ? { carrierOrgId, periodDays: period } : 'skip'
  );

  const recentPayments = useQuery(
    api.carrierMobile.getRecentPayments,
    carrierOrgId ? { carrierOrgId, limit: 20 } : 'skip'
  );

  const onRefresh = useCallback(async () => {
    setRefreshing(true);
    setTimeout(() => setRefreshing(false), 1000);
  }, []);

  const getPaymentStatusStyle = (status: string) => {
    switch (status) {
      case 'PAID':
        return { backgroundColor: colors.success + '20', color: colors.success };
      case 'PENDING':
        return { backgroundColor: colors.warning + '20', color: colors.warning };
      case 'INVOICED':
        return { backgroundColor: colors.primary + '20', color: colors.primary };
      case 'DISPUTED':
        return { backgroundColor: colors.destructive + '20', color: colors.destructive };
      default:
        return { backgroundColor: colors.muted, color: colors.foregroundMuted };
    }
  };

  const renderPaymentItem = ({ item }: { item: any }) => {
    const statusStyle = getPaymentStatusStyle(item.paymentStatus || 'PENDING');

    return (
      <View style={styles.paymentItem}>
        <View style={styles.paymentHeader}>
          <View style={styles.paymentInfo}>
            <Text style={styles.paymentLoadId}>{item.loadInternalId || 'Load'}</Text>
            <Text style={styles.paymentCustomer}>{item.customerName}</Text>
          </View>
          <Text style={styles.paymentAmount}>
            ${(item.paymentAmount || item.carrierTotalAmount)?.toLocaleString()}
          </Text>
        </View>
        <View style={styles.paymentFooter}>
          <View style={[styles.paymentStatus, { backgroundColor: statusStyle.backgroundColor }]}>
            <Text style={[styles.paymentStatusText, { color: statusStyle.color }]}>
              {item.paymentStatus || 'Pending'}
            </Text>
          </View>
          <Text style={styles.paymentDate}>
            {item.paymentDate
              ? new Date(item.paymentDate).toLocaleDateString()
              : item.completedAt
                ? `Completed ${new Date(item.completedAt).toLocaleDateString()}`
                : ''}
          </Text>
        </View>
      </View>
    );
  };

  return (
    <ScrollView
      style={styles.container}
      contentContainerStyle={styles.content}
      refreshControl={
        <RefreshControl refreshing={refreshing} onRefresh={onRefresh} tintColor={colors.primary} />
      }
    >
      {/* Period Selector */}
      <View style={styles.periodSelector}>
        {([7, 30, 90] as PeriodType[]).map((p) => (
          <TouchableOpacity
            key={p}
            style={[styles.periodButton, period === p && styles.activePeriodButton]}
            onPress={() => setPeriod(p)}
          >
            <Text style={[styles.periodText, period === p && styles.activePeriodText]}>
              {p === 7 ? '7 Days' : p === 30 ? '30 Days' : '90 Days'}
            </Text>
          </TouchableOpacity>
        ))}
      </View>

      {/* Summary Cards */}
      <View style={styles.summarySection}>
        <View style={styles.mainSummaryCard}>
          <Text style={styles.summaryLabel}>Total Revenue</Text>
          <Text style={styles.summaryMainValue}>
            ${earningsSummary?.totalEarnings?.toLocaleString() || '0'}
          </Text>
          <Text style={styles.summarySubtext}>
            {earningsSummary?.totalLoads || 0} loads completed
          </Text>
        </View>

        <View style={styles.summaryRow}>
          <View style={[styles.summaryCard, styles.successCard]}>
            <Ionicons name="checkmark-circle" size={24} color={colors.success} />
            <Text style={styles.summaryCardLabel}>Paid</Text>
            <Text style={[styles.summaryCardValue, { color: colors.success }]}>
              ${earningsSummary?.paidAmount?.toLocaleString() || '0'}
            </Text>
          </View>

          <View style={[styles.summaryCard, styles.warningCard]}>
            <Ionicons name="time" size={24} color={colors.warning} />
            <Text style={styles.summaryCardLabel}>Pending</Text>
            <Text style={[styles.summaryCardValue, { color: colors.warning }]}>
              ${earningsSummary?.pendingAmount?.toLocaleString() || '0'}
            </Text>
          </View>
        </View>

        {(earningsSummary?.disputedAmount ?? 0) > 0 && (
          <View style={[styles.alertCard]}>
            <Ionicons name="alert-circle" size={20} color={colors.destructive} />
            <View style={styles.alertContent}>
              <Text style={styles.alertTitle}>Disputed</Text>
              <Text style={styles.alertAmount}>
                ${(earningsSummary?.disputedAmount ?? 0).toLocaleString()}
              </Text>
            </View>
          </View>
        )}
      </View>

      {/* Average Per Load */}
      <View style={styles.statCard}>
        <View style={styles.statRow}>
          <View style={styles.statItem}>
            <Text style={styles.statLabel}>Avg. Per Load</Text>
            <Text style={styles.statValue}>
              ${earningsSummary?.averagePerLoad?.toFixed(0) || '0'}
            </Text>
          </View>
          <View style={styles.statDivider} />
          <View style={styles.statItem}>
            <Text style={styles.statLabel}>Loads</Text>
            <Text style={styles.statValue}>{earningsSummary?.totalLoads || 0}</Text>
          </View>
        </View>
      </View>

      {/* Recent Payments */}
      <View style={styles.recentSection}>
        <Text style={styles.sectionTitle}>Recent Payments</Text>

        {recentPayments && recentPayments.length > 0 ? (
          recentPayments.map((payment: any) => (
            <View key={payment._id}>{renderPaymentItem({ item: payment })}</View>
          ))
        ) : (
          <View style={styles.emptyState}>
            <Ionicons name="receipt-outline" size={48} color={colors.foregroundMuted} />
            <Text style={styles.emptyText}>No payment history yet</Text>
            <Text style={styles.emptySubtext}>
              Complete loads to start tracking earnings
            </Text>
          </View>
        )}
      </View>

      {/* Bottom Padding */}
      <View style={{ height: 120 }} />
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: colors.background,
  },
  content: {
    padding: spacing.lg,
  },
  periodSelector: {
    flexDirection: 'row',
    backgroundColor: colors.card,
    borderRadius: borderRadius.lg,
    padding: spacing.xs,
    marginBottom: spacing.lg,
  },
  periodButton: {
    flex: 1,
    paddingVertical: spacing.sm,
    alignItems: 'center',
    borderRadius: borderRadius.md,
  },
  activePeriodButton: {
    backgroundColor: colors.primary,
  },
  periodText: {
    fontSize: typography.sm,
    color: colors.foregroundMuted,
    fontWeight: '500',
  },
  activePeriodText: {
    color: colors.foreground,
    fontWeight: '600',
  },
  summarySection: {
    marginBottom: spacing.lg,
  },
  mainSummaryCard: {
    backgroundColor: colors.card,
    borderRadius: borderRadius.lg,
    padding: spacing.xl,
    alignItems: 'center',
    marginBottom: spacing.md,
    ...shadows.sm,
  },
  summaryLabel: {
    fontSize: typography.sm,
    color: colors.foregroundMuted,
  },
  summaryMainValue: {
    fontSize: 40,
    fontWeight: '700',
    color: colors.success,
    marginVertical: spacing.sm,
  },
  summarySubtext: {
    fontSize: typography.sm,
    color: colors.foregroundMuted,
  },
  summaryRow: {
    flexDirection: 'row',
    gap: spacing.md,
  },
  summaryCard: {
    flex: 1,
    backgroundColor: colors.card,
    borderRadius: borderRadius.lg,
    padding: spacing.lg,
    ...shadows.sm,
  },
  successCard: {
    borderLeftWidth: 3,
    borderLeftColor: colors.success,
  },
  warningCard: {
    borderLeftWidth: 3,
    borderLeftColor: colors.warning,
  },
  summaryCardLabel: {
    fontSize: typography.xs,
    color: colors.foregroundMuted,
    marginTop: spacing.sm,
  },
  summaryCardValue: {
    fontSize: typography.xl,
    fontWeight: '700',
    color: colors.foreground,
  },
  alertCard: {
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: colors.destructive + '15',
    borderRadius: borderRadius.lg,
    padding: spacing.md,
    marginTop: spacing.md,
    borderWidth: 1,
    borderColor: colors.destructive + '30',
  },
  alertContent: {
    marginLeft: spacing.md,
  },
  alertTitle: {
    fontSize: typography.sm,
    color: colors.destructive,
    fontWeight: '600',
  },
  alertAmount: {
    fontSize: typography.base,
    color: colors.destructive,
    fontWeight: '700',
  },
  statCard: {
    backgroundColor: colors.card,
    borderRadius: borderRadius.lg,
    padding: spacing.lg,
    marginBottom: spacing.lg,
    ...shadows.sm,
  },
  statRow: {
    flexDirection: 'row',
    alignItems: 'center',
  },
  statItem: {
    flex: 1,
    alignItems: 'center',
  },
  statDivider: {
    width: 1,
    height: 40,
    backgroundColor: colors.border,
  },
  statLabel: {
    fontSize: typography.xs,
    color: colors.foregroundMuted,
  },
  statValue: {
    fontSize: typography.xl,
    fontWeight: '700',
    color: colors.foreground,
    marginTop: 4,
  },
  recentSection: {
    marginBottom: spacing.lg,
  },
  sectionTitle: {
    fontSize: typography.lg,
    fontWeight: '600',
    color: colors.foreground,
    marginBottom: spacing.md,
  },
  paymentItem: {
    backgroundColor: colors.card,
    borderRadius: borderRadius.lg,
    padding: spacing.lg,
    marginBottom: spacing.sm,
    ...shadows.sm,
  },
  paymentHeader: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'flex-start',
    marginBottom: spacing.sm,
  },
  paymentInfo: {
    flex: 1,
  },
  paymentLoadId: {
    fontSize: typography.base,
    fontWeight: '600',
    color: colors.foreground,
  },
  paymentCustomer: {
    fontSize: typography.sm,
    color: colors.foregroundMuted,
    marginTop: 2,
  },
  paymentAmount: {
    fontSize: typography.lg,
    fontWeight: '700',
    color: colors.foreground,
  },
  paymentFooter: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
  },
  paymentStatus: {
    paddingHorizontal: 8,
    paddingVertical: 4,
    borderRadius: borderRadius.sm,
  },
  paymentStatusText: {
    fontSize: 10,
    fontWeight: '600',
  },
  paymentDate: {
    fontSize: typography.xs,
    color: colors.foregroundMuted,
  },
  emptyState: {
    alignItems: 'center',
    paddingVertical: spacing['2xl'],
  },
  emptyText: {
    fontSize: typography.lg,
    fontWeight: '600',
    color: colors.foreground,
    marginTop: spacing.md,
  },
  emptySubtext: {
    fontSize: typography.sm,
    color: colors.foregroundMuted,
    marginTop: spacing.xs,
  },
});
