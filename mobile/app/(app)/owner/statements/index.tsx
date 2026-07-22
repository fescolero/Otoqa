/**
 * Broker statements — the carrier org's settlement statements, across every
 * broker partnership. Distinct from owner/settlements.tsx (per-load revenue):
 * these are the actual pay-run statements the broker cuts (CST-…), with
 * status, pay dates, and itemized lines in the detail screen. Read-only.
 */
import {
  View,
  Text,
  StyleSheet,
  ScrollView,
  RefreshControl,
  Pressable,
} from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useRouter } from 'expo-router';
import { useQuery } from 'convex/react';
import { useState, useCallback } from 'react';
import { Ionicons } from '@expo/vector-icons';
import { api } from '../../../../../convex/_generated/api';
import { useCarrierOwner } from '../../_layout';
import { colors, typography, borderRadius, shadows, spacing } from '../../../../lib/theme';
import {
  fmtDate,
  fmtMoney,
  fmtRange,
  type MobileStatementStatus,
  type StatementRow,
} from '../../../../lib/pay-format';

const STATUS_STYLE: Record<MobileStatementStatus, { label: string; color: string }> = {
  ACCRUING: { label: 'In progress', color: colors.primary },
  IN_REVIEW: { label: 'In review', color: colors.warning },
  APPROVED: { label: 'Approved', color: colors.success },
  PAID: { label: 'Paid', color: colors.success },
  DISPUTED: { label: 'Disputed', color: colors.destructive },
};

export default function BrokerStatementsScreen() {
  const insets = useSafeAreaInsets();
  const router = useRouter();
  const { carrierOrgId, carrierExternalOrgId } = useCarrierOwner();
  const [refreshing, setRefreshing] = useState(false);

  // requireCarrierAuth accepts either identifier form; prefer the external id.
  const authOrgId = carrierExternalOrgId ?? carrierOrgId;

  const rows = useQuery(
    api.mobileSettlements.getCarrierStatements,
    authOrgId ? { carrierOrgId: authOrgId } : 'skip',
  ) as StatementRow[] | undefined;

  const onRefresh = useCallback(async () => {
    setRefreshing(true);
    setTimeout(() => setRefreshing(false), 1000);
  }, []);

  return (
    <View style={[styles.screen, { paddingTop: insets.top }]}>
      <View style={styles.header}>
        <Pressable onPress={() => router.back()} style={styles.backButton}>
          <Ionicons name="arrow-back" size={24} color={colors.foreground} />
        </Pressable>
        <Text style={styles.headerTitle}>Broker Statements</Text>
        <View style={{ width: 40 }} />
      </View>

      <ScrollView
        style={styles.container}
        contentContainerStyle={styles.content}
        refreshControl={
          <RefreshControl refreshing={refreshing} onRefresh={onRefresh} tintColor={colors.primary} />
        }
      >
        {rows === undefined ? (
          <>
            <View style={[styles.skeletonCard, { height: 92 }]} />
            <View style={[styles.skeletonCard, { height: 92 }]} />
            <View style={[styles.skeletonCard, { height: 92 }]} />
          </>
        ) : rows.length === 0 ? (
          <View style={styles.emptyState}>
            <Ionicons name="document-text-outline" size={48} color={colors.foregroundMuted} />
            <Text style={styles.emptyText}>No statements yet</Text>
            <Text style={styles.emptySubtext}>
              Settlement statements from your broker partners will show here.
            </Text>
          </View>
        ) : (
          rows.map((row) => {
            const status = STATUS_STYLE[row.status];
            const dateLine =
              row.status === 'PAID' && row.paidAt
                ? `Paid ${fmtDate(row.paidAt)}${row.paidMethod ? ` · ${row.paidMethod}` : ''}`
                : row.payDate
                  ? `Pay date ${fmtDate(row.payDate)}`
                  : '';
            return (
              <Pressable
                key={row.id}
                onPress={() =>
                  router.push({
                    pathname: '/owner/statements/[id]',
                    params: { id: row.id, source: row.source },
                  })
                }
                style={({ pressed }) => [styles.rowCard, pressed && { opacity: 0.85 }]}
              >
                <View style={styles.rowHeader}>
                  <View style={{ flex: 1, minWidth: 0 }}>
                    <Text style={styles.rowTitle} numberOfLines={1}>
                      {row.statementNumber ?? fmtRange(row.periodStart, row.periodEnd)}
                    </Text>
                    <Text style={styles.rowBroker} numberOfLines={1}>
                      {row.brokerName ?? 'Broker'}
                    </Text>
                  </View>
                  <Text style={styles.rowNet}>{fmtMoney(row.net)}</Text>
                </View>
                <View style={styles.rowFooter}>
                  <View style={[styles.statusPill, { backgroundColor: status.color + '20' }]}>
                    <Text style={[styles.statusText, { color: status.color }]}>
                      {status.label}
                    </Text>
                  </View>
                  <Text style={styles.rowMeta} numberOfLines={1}>
                    {fmtRange(row.periodStart, row.periodEnd)}
                    {dateLine ? ` · ${dateLine}` : ''}
                  </Text>
                </View>
              </Pressable>
            );
          })
        )}

        <View style={{ height: 120 }} />
      </ScrollView>
    </View>
  );
}

const styles = StyleSheet.create({
  screen: {
    flex: 1,
    backgroundColor: colors.background,
  },
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: spacing.lg,
    paddingVertical: spacing.md,
    borderBottomWidth: 1,
    borderBottomColor: colors.border,
  },
  backButton: {
    padding: spacing.xs,
    width: 40,
  },
  headerTitle: {
    flex: 1,
    textAlign: 'center',
    fontSize: typography.lg,
    fontWeight: '600',
    color: colors.foreground,
  },
  container: {
    flex: 1,
  },
  content: {
    padding: spacing.lg,
  },
  skeletonCard: {
    backgroundColor: colors.card,
    borderRadius: borderRadius.lg,
    marginBottom: spacing.sm,
    opacity: 0.6,
  },
  rowCard: {
    backgroundColor: colors.card,
    borderRadius: borderRadius.lg,
    padding: spacing.lg,
    marginBottom: spacing.sm,
    ...shadows.sm,
  },
  rowHeader: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'flex-start',
    marginBottom: spacing.sm,
    gap: spacing.md,
  },
  rowTitle: {
    fontSize: typography.base,
    fontWeight: '600',
    color: colors.foreground,
  },
  rowBroker: {
    fontSize: typography.sm,
    color: colors.foregroundMuted,
    marginTop: 2,
  },
  rowNet: {
    fontSize: typography.lg,
    fontWeight: '700',
    color: colors.foreground,
  },
  rowFooter: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.sm,
  },
  statusPill: {
    paddingHorizontal: 8,
    paddingVertical: 4,
    borderRadius: borderRadius.sm,
  },
  statusText: {
    fontSize: 10,
    fontWeight: '600',
  },
  rowMeta: {
    flex: 1,
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
    textAlign: 'center',
    paddingHorizontal: spacing.xl,
  },
});
