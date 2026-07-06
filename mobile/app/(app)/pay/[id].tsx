/**
 * Statement detail — one pay statement, itemized for the driver.
 *
 * Summary card (earnings / reimbursements / deductions / net + payment
 * info), then line items grouped by work day. Shift lines show the clock
 * window and the loads run during the shift. Read-only.
 */
import React, { useEffect, useMemo } from 'react';
import { View, Text, StyleSheet, Pressable, ScrollView } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { useLocalSearchParams, useRouter } from 'expo-router';
import { useQuery } from 'convex/react';
import { api } from '../../../../convex/_generated/api';
import { trackScreen } from '../../../lib/analytics';
import { Icon } from '../../../lib/design-icons';
import { useTheme } from '../../../lib/ThemeContext';
import { useDensityTokens } from '../../../lib/density';
import { densitySpacing, radii, type Palette } from '../../../lib/design-tokens';
import {
  fmtClock,
  fmtDate,
  fmtDay,
  fmtMoney,
  fmtRange,
  STATUS_META,
  type MobileStatementStatus,
  type StatementLine,
} from '../../../lib/pay-format';

type Sp = (typeof densitySpacing)['dense'];

interface StatementDetails {
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
    units?: string | null;
    planDetail?: string | null;
  };
}

export default function StatementDetailScreen() {
  const router = useRouter();
  const { palette } = useTheme();
  const { sp } = useDensityTokens();
  const styles = useMemo(() => makeStyles(palette, sp), [palette, sp]);
  const params = useLocalSearchParams<{ id: string; source: 'legacy' | 'ledger' }>();

  useEffect(() => {
    trackScreen('MyPayStatement');
  }, []);

  const details = useQuery(
    api.mobileSettlements.getMyStatementDetails,
    params.id && params.source
      ? { settlementId: params.id, source: params.source }
      : 'skip',
  ) as StatementDetails | undefined;

  // Group lines by work day (statement order is already chronological).
  const dayGroups = useMemo(() => {
    if (!details) return [];
    const groups: Array<{ key: string; label: string; lines: StatementLine[] }> = [];
    for (const line of details.lines) {
      const day = line.workStart ? new Date(line.workStart) : null;
      const key = day
        ? `${day.getFullYear()}-${day.getMonth()}-${day.getDate()}`
        : 'other';
      const label = line.workStart ? fmtDay(line.workStart) : 'Other items';
      const last = groups[groups.length - 1];
      if (last && last.key === key) last.lines.push(line);
      else groups.push({ key, label, lines: [line] });
    }
    return groups;
  }, [details]);

  const meta = details ? STATUS_META[details.statement.status] : null;
  const color = meta && details ? meta.color(palette) : palette.textTertiary;

  return (
    <SafeAreaView style={styles.screen} edges={['top']}>
      <View style={styles.header}>
        <Pressable
          accessibilityLabel="Back"
          onPress={() => router.back()}
          style={({ pressed }) => [styles.headerBtn, pressed && { opacity: 0.7 }]}
        >
          <Icon name="arrow-left" size={22} color={palette.textPrimary} />
        </Pressable>
        <Text style={styles.headerTitle} numberOfLines={1}>
          {details?.statement.statementNumber ?? 'Statement'}
        </Text>
        <View style={{ width: 44 }} />
      </View>

      <ScrollView
        style={styles.scroll}
        contentContainerStyle={{ paddingBottom: 48 }}
        showsVerticalScrollIndicator={false}
      >
        {!details ? (
          <>
            <View style={[styles.card, styles.skeleton, { height: 170 }]} />
            <View style={[styles.card, styles.skeleton, { height: 220, marginTop: 12 }]} />
          </>
        ) : (
          <>
            {/* Summary card */}
            <View style={styles.card}>
              <View style={styles.summaryHead}>
                <View style={{ flex: 1, minWidth: 0 }}>
                  <Text style={styles.summaryPeriod}>
                    {fmtRange(details.statement.periodStart, details.statement.periodEnd)}
                  </Text>
                  {!!details.statement.brokerName && (
                    <Text style={styles.summarySub} numberOfLines={1}>
                      {details.statement.brokerName}
                    </Text>
                  )}
                  {!!details.summary.planDetail && (
                    <Text style={styles.summarySub} numberOfLines={1}>
                      {details.summary.planDetail}
                      {details.summary.units ? ` · ${details.summary.units}` : ''}
                    </Text>
                  )}
                </View>
                {meta && (
                  <View style={[styles.pill, { backgroundColor: `${color}1F` }]}>
                    <Text style={[styles.pillText, { color }]}>{meta.label}</Text>
                  </View>
                )}
              </View>

              <View style={styles.summaryRows}>
                <SummaryRow styles={styles} label="Earnings" value={fmtMoney(details.summary.earnTotal)} />
                {details.summary.reimbTotal > 0 && (
                  <SummaryRow
                    styles={styles}
                    label="Reimbursements"
                    value={fmtMoney(details.summary.reimbTotal)}
                  />
                )}
                {details.summary.deductTotal > 0 && (
                  <SummaryRow
                    styles={styles}
                    label="Deductions"
                    value={`-${fmtMoney(details.summary.deductTotal)}`}
                    valueColor={palette.danger}
                  />
                )}
                <View style={styles.netDivider} />
                <View style={styles.summaryRow}>
                  <Text style={styles.netLabel}>Net pay</Text>
                  <Text style={styles.netValue}>{fmtMoney(details.summary.net)}</Text>
                </View>
              </View>

              {/* Payment / pay-date footer */}
              <View style={styles.payFoot}>
                {details.statement.status === 'PAID' && details.statement.paidAt ? (
                  <>
                    <Icon name="check-circle" size={14} color={palette.success} />
                    <Text style={[styles.payFootText, { color: palette.success }]}>
                      Paid {fmtDate(details.statement.paidAt)}
                      {details.statement.paidMethod ? ` via ${details.statement.paidMethod}` : ''}
                      {details.statement.paidReference ? ` · ref ${details.statement.paidReference}` : ''}
                    </Text>
                  </>
                ) : details.statement.payDate ? (
                  <>
                    <Icon name="calendar" size={14} color={palette.textTertiary} />
                    <Text style={styles.payFootText}>
                      Expected pay date {fmtDate(details.statement.payDate)}
                    </Text>
                  </>
                ) : null}
              </View>

              {meta?.provisional && (
                <View style={styles.provisionalNote}>
                  <Icon name="info" size={13} color={palette.textTertiary} />
                  <Text style={styles.provisionalText}>
                    Amounts can change until the statement is approved.
                  </Text>
                </View>
              )}
            </View>

            {/* Line items by day */}
            {dayGroups.map((group) => (
              <View key={group.key}>
                <View style={styles.sectionHead}>
                  <Text style={styles.sectionLabel}>{group.label.toUpperCase()}</Text>
                </View>
                <View style={styles.linesCard}>
                  {group.lines.map((line, i) => (
                    <View key={line.id}>
                      {i > 0 && <View style={styles.lineDivider} />}
                      <LineRow line={line} palette={palette} styles={styles} />
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
      </ScrollView>
    </SafeAreaView>
  );
}

function SummaryRow({
  styles,
  label,
  value,
  valueColor,
}: {
  styles: ReturnType<typeof makeStyles>;
  label: string;
  value: string;
  valueColor?: string;
}) {
  return (
    <View style={styles.summaryRow}>
      <Text style={styles.summaryLabel}>{label}</Text>
      <Text style={[styles.summaryValue, valueColor ? { color: valueColor } : null]}>
        {value}
      </Text>
    </View>
  );
}

function LineRow({
  line,
  palette,
  styles,
}: {
  line: StatementLine;
  palette: Palette;
  styles: ReturnType<typeof makeStyles>;
}) {
  const isShift = !!line.workEnd;
  const subParts: string[] = [];
  if (isShift && line.workStart && line.workEnd) {
    subParts.push(`${fmtClock(line.workStart)} – ${fmtClock(line.workEnd)}`);
  }
  if (line.loadLabel) subParts.push(line.loadLabel);
  if (line.kind === 'MANUAL') subParts.push('Adjustment');

  return (
    <View style={styles.lineRow}>
      <View style={styles.lineMain}>
        <View style={{ flex: 1, minWidth: 0 }}>
          <Text style={styles.lineTitle} numberOfLines={1}>
            {line.description}
          </Text>
          {subParts.length > 0 && (
            <Text style={styles.lineMeta} numberOfLines={1}>
              {subParts.join(' · ')}
            </Text>
          )}
        </View>
        <Text
          style={[
            styles.lineAmount,
            line.totalAmount < 0 && { color: palette.danger },
          ]}
        >
          {fmtMoney(line.totalAmount)}
        </Text>
      </View>
      {line.shiftLoads && line.shiftLoads.length > 0 && (
        <View style={styles.shiftLoads}>
          {line.shiftLoads.map((sl, i) => (
            <View key={`${sl.label}-${i}`} style={styles.shiftLoadRow}>
              <View style={styles.shiftLoadDot} />
              <Text style={styles.shiftLoadText} numberOfLines={1}>
                {sl.label}
                {sl.lane ? ` · ${sl.lane}` : ''}
              </Text>
            </View>
          ))}
        </View>
      )}
    </View>
  );
}

const makeStyles = (palette: Palette, sp: Sp) =>
  StyleSheet.create({
    screen: {
      flex: 1,
      backgroundColor: palette.bgCanvas,
    },
    header: {
      height: 52,
      paddingHorizontal: 8,
      flexDirection: 'row',
      alignItems: 'center',
    },
    headerBtn: {
      width: 44,
      height: 44,
      borderRadius: radii.full,
      alignItems: 'center',
      justifyContent: 'center',
    },
    headerTitle: {
      flex: 1,
      textAlign: 'center',
      fontSize: 16,
      fontWeight: '700',
      letterSpacing: -0.16,
      color: palette.textPrimary,
    },
    scroll: {
      flex: 1,
      paddingHorizontal: sp.screenPx,
    },
    card: {
      borderRadius: radii.lg,
      backgroundColor: palette.bgSurface,
      borderWidth: 1,
      borderColor: palette.borderSubtle,
      padding: sp.cardPadding,
    },
    skeleton: {
      backgroundColor: palette.bgMuted,
      borderColor: 'transparent',
    },
    summaryHead: {
      flexDirection: 'row',
      alignItems: 'flex-start',
      gap: 8,
    },
    summaryPeriod: {
      fontSize: 14,
      fontWeight: '600',
      color: palette.textPrimary,
    },
    summarySub: {
      fontSize: 11,
      color: palette.textTertiary,
      marginTop: 2,
    },
    pill: {
      paddingHorizontal: 8,
      paddingVertical: 3,
      borderRadius: radii.full,
    },
    pillText: {
      fontSize: 10,
      fontWeight: '700',
      letterSpacing: 0.3,
    },
    summaryRows: {
      marginTop: 14,
      gap: 8,
    },
    summaryRow: {
      flexDirection: 'row',
      justifyContent: 'space-between',
      alignItems: 'center',
    },
    summaryLabel: {
      fontSize: 13,
      color: palette.textSecondary,
    },
    summaryValue: {
      fontSize: 13,
      fontWeight: '600',
      color: palette.textPrimary,
      fontVariant: ['tabular-nums'],
    },
    netDivider: {
      height: StyleSheet.hairlineWidth,
      backgroundColor: palette.borderSubtle,
      marginVertical: 2,
    },
    netLabel: {
      fontSize: 14,
      fontWeight: '700',
      color: palette.textPrimary,
    },
    netValue: {
      fontSize: 18,
      fontWeight: '700',
      letterSpacing: -0.2,
      color: palette.textPrimary,
      fontVariant: ['tabular-nums'],
    },
    payFoot: {
      flexDirection: 'row',
      alignItems: 'center',
      gap: 6,
      marginTop: 12,
      paddingTop: 10,
      borderTopWidth: StyleSheet.hairlineWidth,
      borderTopColor: palette.borderSubtle,
    },
    payFootText: {
      fontSize: 11,
      color: palette.textTertiary,
      flexShrink: 1,
    },
    provisionalNote: {
      flexDirection: 'row',
      alignItems: 'center',
      gap: 6,
      marginTop: 8,
    },
    provisionalText: {
      fontSize: 11,
      color: palette.textTertiary,
      flexShrink: 1,
    },
    sectionHead: {
      paddingTop: 18,
      paddingBottom: 8,
    },
    sectionLabel: {
      fontSize: 11,
      fontWeight: '700',
      letterSpacing: 0.8,
      color: palette.textTertiary,
    },
    linesCard: {
      borderRadius: radii.lg,
      backgroundColor: palette.bgSurface,
      borderWidth: 1,
      borderColor: palette.borderSubtle,
      overflow: 'hidden',
    },
    lineDivider: {
      height: StyleSheet.hairlineWidth,
      backgroundColor: palette.borderSubtle,
      marginLeft: 14,
    },
    lineRow: {
      paddingHorizontal: 14,
      paddingVertical: 12,
    },
    lineMain: {
      flexDirection: 'row',
      alignItems: 'center',
      gap: 10,
    },
    lineTitle: {
      fontSize: 13,
      fontWeight: '600',
      color: palette.textPrimary,
    },
    lineMeta: {
      fontSize: 11,
      color: palette.textTertiary,
      marginTop: 2,
    },
    lineAmount: {
      fontSize: 13,
      fontWeight: '700',
      color: palette.textPrimary,
      fontVariant: ['tabular-nums'],
    },
    shiftLoads: {
      marginTop: 8,
      gap: 4,
    },
    shiftLoadRow: {
      flexDirection: 'row',
      alignItems: 'center',
      gap: 8,
    },
    shiftLoadDot: {
      width: 4,
      height: 4,
      borderRadius: 999,
      backgroundColor: palette.borderStrong,
      marginLeft: 4,
    },
    shiftLoadText: {
      fontSize: 11,
      color: palette.textSecondary,
      flexShrink: 1,
    },
    truncNote: {
      fontSize: 11,
      color: palette.textTertiary,
      textAlign: 'center',
      marginTop: 14,
    },
  });
