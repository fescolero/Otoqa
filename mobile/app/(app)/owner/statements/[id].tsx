/**
 * Broker statement detail — one settlement statement, itemized. Summary
 * (earnings / deductions / net + payment info) and the line items, grouped
 * by work day. Very large statements return a capped line list; the summary
 * always reflects every line. Read-only.
 */
import { View, Text, StyleSheet, ScrollView, Pressable } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useLocalSearchParams, useRouter } from 'expo-router';
import { useQuery } from 'convex/react';
import { useMemo } from 'react';
import { Ionicons } from '@expo/vector-icons';
import { api } from '../../../../../convex/_generated/api';
import { useCarrierOwner } from '../../_layout';
import { colors, typography, borderRadius, shadows, spacing } from '../../../../lib/theme';
import {
  fmtDate,
  fmtDay,
  fmtMoney,
  fmtRange,
  type MobileStatementStatus,
  type StatementLine,
} from '../../../../lib/pay-format';

const STATUS_STYLE: Record<MobileStatementStatus, { label: string; color: string }> = {
  ACCRUING: { label: 'In progress', color: colors.primary },
  IN_REVIEW: { label: 'In review', color: colors.warning },
  APPROVED: { label: 'Approved', color: colors.success },
  PAID: { label: 'Paid', color: colors.success },
  DISPUTED: { label: 'Disputed', color: colors.destructive },
};

interface CarrierStatementDetails {
  statement: {
    id: string;
    source: 'legacy' | 'ledger';
    statementNumber: string | null;
    status: MobileStatementStatus;
    periodStart: number;
    periodEnd: number;
    payDate: number | null;
    paidAt: number | null;
    paidMethod: string | null;
    paidReference: string | null;
    brokerName?: string;
  };
  lines: StatementLine[];
  linesTruncated: boolean;
  summary: {
    earnTotal: number;
    reimbTotal: number;
    deductTotal: number;
    net: number;
    lineCount: number | null;
    loadCount: number | null;
  };
}

export default function BrokerStatementDetailScreen() {
  const insets = useSafeAreaInsets();
  const router = useRouter();
  const { carrierOrgId, carrierExternalOrgId } = useCarrierOwner();
  const params = useLocalSearchParams<{ id: string; source: 'legacy' | 'ledger' }>();

  const authOrgId = carrierExternalOrgId ?? carrierOrgId;

  const details = useQuery(
    api.mobileSettlements.getCarrierStatementDetails,
    authOrgId && params.id && params.source
      ? { carrierOrgId: authOrgId, settlementId: params.id, source: params.source }
      : 'skip',
  ) as CarrierStatementDetails | undefined;

  const dayGroups = useMemo(() => {
    if (!details) return [];
    const groups: Array<{ key: string; label: string; lines: StatementLine[] }> = [];
    for (const line of details.lines) {
      const day = line.workStart ? new Date(line.workStart) : null;
      const key = day ? `${day.getFullYear()}-${day.getMonth()}-${day.getDate()}` : 'other';
      const label = line.workStart ? fmtDay(line.workStart) : 'Other items';
      const last = groups[groups.length - 1];
      if (last && last.key === key) last.lines.push(line);
      else groups.push({ key, label, lines: [line] });
    }
    return groups;
  }, [details]);

  const status = details ? STATUS_STYLE[details.statement.status] : null;

  return (
    <View style={[styles.screen, { paddingTop: insets.top }]}>
      <View style={styles.header}>
        <Pressable onPress={() => router.back()} style={styles.backButton}>
          <Ionicons name="arrow-back" size={24} color={colors.foreground} />
        </Pressable>
        <Text style={styles.headerTitle} numberOfLines={1}>
          {details?.statement.statementNumber ?? 'Statement'}
        </Text>
        <View style={{ width: 40 }} />
      </View>

      <ScrollView style={styles.container} contentContainerStyle={styles.content}>
        {!details ? (
          <>
            <View style={[styles.skeletonCard, { height: 180 }]} />
            <View style={[styles.skeletonCard, { height: 240 }]} />
          </>
        ) : (
          <>
            {/* Summary */}
            <View style={styles.card}>
              <View style={styles.summaryHead}>
                <View style={{ flex: 1, minWidth: 0 }}>
                  <Text style={styles.summaryPeriod}>
                    {fmtRange(details.statement.periodStart, details.statement.periodEnd)}
                  </Text>
                  {!!details.statement.brokerName && (
                    <Text style={styles.summaryBroker} numberOfLines={1}>
                      {details.statement.brokerName}
                    </Text>
                  )}
                </View>
                {status && (
                  <View style={[styles.statusPill, { backgroundColor: status.color + '20' }]}>
                    <Text style={[styles.statusText, { color: status.color }]}>
                      {status.label}
                    </Text>
                  </View>
                )}
              </View>

              <View style={styles.summaryRows}>
                <View style={styles.summaryRow}>
                  <Text style={styles.summaryLabel}>Earnings</Text>
                  <Text style={styles.summaryValue}>{fmtMoney(details.summary.earnTotal)}</Text>
                </View>
                {details.summary.reimbTotal > 0 && (
                  <View style={styles.summaryRow}>
                    <Text style={styles.summaryLabel}>Reimbursements</Text>
                    <Text style={styles.summaryValue}>{fmtMoney(details.summary.reimbTotal)}</Text>
                  </View>
                )}
                {details.summary.deductTotal > 0 && (
                  <View style={styles.summaryRow}>
                    <Text style={styles.summaryLabel}>Deductions</Text>
                    <Text style={[styles.summaryValue, { color: colors.destructive }]}>
                      -{fmtMoney(details.summary.deductTotal)}
                    </Text>
                  </View>
                )}
                <View style={styles.netDivider} />
                <View style={styles.summaryRow}>
                  <Text style={styles.netLabel}>Net</Text>
                  <Text style={styles.netValue}>{fmtMoney(details.summary.net)}</Text>
                </View>
              </View>

              <View style={styles.payFoot}>
                {details.statement.status === 'PAID' && details.statement.paidAt ? (
                  <Text style={[styles.payFootText, { color: colors.success }]}>
                    Paid {fmtDate(details.statement.paidAt)}
                    {details.statement.paidMethod ? ` via ${details.statement.paidMethod}` : ''}
                    {details.statement.paidReference
                      ? ` · ref ${details.statement.paidReference}`
                      : ''}
                  </Text>
                ) : details.statement.payDate ? (
                  <Text style={styles.payFootText}>
                    Expected pay date {fmtDate(details.statement.payDate)}
                  </Text>
                ) : null}
                {(details.statement.status === 'ACCRUING' ||
                  details.statement.status === 'IN_REVIEW') && (
                  <Text style={styles.payFootText}>
                    Amounts can change until the statement is approved.
                  </Text>
                )}
              </View>
            </View>

            {/* Lines by day */}
            {dayGroups.map((group) => (
              <View key={group.key}>
                <Text style={styles.sectionTitle}>{group.label}</Text>
                <View style={styles.linesCard}>
                  {group.lines.map((line, i) => (
                    <View key={line.id}>
                      {i > 0 && <View style={styles.lineDivider} />}
                      <View style={styles.lineRow}>
                        <View style={{ flex: 1, minWidth: 0 }}>
                          <Text style={styles.lineTitle} numberOfLines={1}>
                            {line.description}
                          </Text>
                          <Text style={styles.lineMeta} numberOfLines={1}>
                            {[
                              line.loadLabel,
                              line.kind === 'MANUAL' ? 'Adjustment' : null,
                              line.quantity !== 1
                                ? `${line.quantity.toLocaleString()} × ${fmtMoney(line.rate)}`
                                : null,
                            ]
                              .filter(Boolean)
                              .join(' · ') || ' '}
                          </Text>
                        </View>
                        <Text
                          style={[
                            styles.lineAmount,
                            line.totalAmount < 0 && { color: colors.destructive },
                          ]}
                        >
                          {fmtMoney(line.totalAmount)}
                        </Text>
                      </View>
                    </View>
                  ))}
                </View>
              </View>
            ))}

            {details.linesTruncated && (
              <Text style={styles.truncNote}>
                Showing the first {details.lines.length} lines — totals include every line.
              </Text>
            )}
          </>
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
    marginBottom: spacing.md,
    opacity: 0.6,
  },
  card: {
    backgroundColor: colors.card,
    borderRadius: borderRadius.lg,
    padding: spacing.lg,
    marginBottom: spacing.md,
    ...shadows.sm,
  },
  summaryHead: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    gap: spacing.md,
  },
  summaryPeriod: {
    fontSize: typography.base,
    fontWeight: '600',
    color: colors.foreground,
  },
  summaryBroker: {
    fontSize: typography.sm,
    color: colors.foregroundMuted,
    marginTop: 2,
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
  summaryRows: {
    marginTop: spacing.md,
    gap: spacing.sm,
  },
  summaryRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
  },
  summaryLabel: {
    fontSize: typography.sm,
    color: colors.foregroundMuted,
  },
  summaryValue: {
    fontSize: typography.sm,
    fontWeight: '600',
    color: colors.foreground,
  },
  netDivider: {
    height: 1,
    backgroundColor: colors.border,
    marginVertical: 2,
  },
  netLabel: {
    fontSize: typography.base,
    fontWeight: '700',
    color: colors.foreground,
  },
  netValue: {
    fontSize: typography.xl,
    fontWeight: '700',
    color: colors.foreground,
  },
  payFoot: {
    marginTop: spacing.md,
    paddingTop: spacing.sm,
    borderTopWidth: 1,
    borderTopColor: colors.border,
    gap: 4,
  },
  payFootText: {
    fontSize: typography.xs,
    color: colors.foregroundMuted,
  },
  sectionTitle: {
    fontSize: typography.sm,
    fontWeight: '600',
    color: colors.foregroundMuted,
    marginTop: spacing.md,
    marginBottom: spacing.sm,
  },
  linesCard: {
    backgroundColor: colors.card,
    borderRadius: borderRadius.lg,
    overflow: 'hidden',
    ...shadows.sm,
  },
  lineDivider: {
    height: 1,
    backgroundColor: colors.border,
    marginLeft: spacing.lg,
  },
  lineRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.md,
    paddingHorizontal: spacing.lg,
    paddingVertical: spacing.md,
  },
  lineTitle: {
    fontSize: typography.sm,
    fontWeight: '600',
    color: colors.foreground,
  },
  lineMeta: {
    fontSize: typography.xs,
    color: colors.foregroundMuted,
    marginTop: 2,
  },
  lineAmount: {
    fontSize: typography.sm,
    fontWeight: '700',
    color: colors.foreground,
  },
  truncNote: {
    fontSize: typography.xs,
    color: colors.foregroundMuted,
    textAlign: 'center',
    marginTop: spacing.md,
  },
});
