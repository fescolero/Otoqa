/**
 * My Pay — the driver's own settlement statements.
 *
 * Hero: the current period's ACCRUING statement (live earnings so far).
 * Below: statement history (in review → approved → paid), newest first.
 * Read-only by design — disputes/edits stay with the broker's back office.
 *
 * Data: api.mobileSettlements.getMyStatements (payee-scoped, flag-gated on
 * the org's settlements_read_ledger so numbers always match the web).
 */
import React, { useEffect, useMemo } from 'react';
import { View, Text, StyleSheet, Pressable, ScrollView } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { useRouter } from 'expo-router';
import { useQuery } from 'convex/react';
import { api } from '../../../../convex/_generated/api';
import { trackScreen } from '../../../lib/analytics';
import { useDriver } from '../_layout';
import { Icon } from '../../../lib/design-icons';
import { useTheme } from '../../../lib/ThemeContext';
import { useDensityTokens } from '../../../lib/density';
import { densitySpacing, radii, type Palette } from '../../../lib/design-tokens';
import {
  fmtDate,
  fmtMoney,
  fmtRange,
  STATUS_META,
  type StatementRow,
} from '../../../lib/pay-format';

type Sp = (typeof densitySpacing)['dense'];

export default function MyPayScreen() {
  const router = useRouter();
  const { palette } = useTheme();
  const { sp } = useDensityTokens();
  const styles = useMemo(() => makeStyles(palette, sp), [palette, sp]);
  const { driverId } = useDriver();

  useEffect(() => {
    trackScreen('MyPay');
  }, []);

  const rows = useQuery(
    api.mobileSettlements.getMyStatements,
    driverId ? { driverId } : 'skip',
  ) as StatementRow[] | undefined;

  const accruing = rows?.find((r) => r.status === 'ACCRUING') ?? null;
  const history = rows?.filter((r) => r !== accruing) ?? [];

  const openStatement = (row: StatementRow) =>
    router.push({
      pathname: '/pay/[id]',
      params: { id: row.id, source: row.source },
    });

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
        <Text style={styles.headerTitle}>My Pay</Text>
        <View style={{ width: 44 }} />
      </View>

      <ScrollView
        style={styles.scroll}
        contentContainerStyle={{ paddingBottom: 48 }}
        showsVerticalScrollIndicator={false}
      >
        {rows === undefined ? (
          <>
            <View style={[styles.card, styles.skeleton, { height: 128 }]} />
            <View style={[styles.card, styles.skeleton, { height: 72, marginTop: 12 }]} />
            <View style={[styles.card, styles.skeleton, { height: 72, marginTop: 10 }]} />
          </>
        ) : rows.length === 0 ? (
          <View style={styles.empty}>
            <View style={styles.emptyIcon}>
              <Icon name="dollar" size={26} color={palette.textTertiary} />
            </View>
            <Text style={styles.emptyTitle}>No pay statements yet</Text>
            <Text style={styles.emptyMeta}>
              Statements show up here once your first pay period starts.
            </Text>
          </View>
        ) : (
          <>
            {/* Hero — current period accruing */}
            {accruing && (
              <Pressable
                onPress={() => openStatement(accruing)}
                style={({ pressed }) => [styles.heroCard, pressed && { opacity: 0.92 }]}
              >
                <Text style={[styles.eyebrow, { color: palette.accent }]}>
                  THIS PERIOD SO FAR
                </Text>
                <Text style={styles.heroNet}>{fmtMoney(accruing.net)}</Text>
                <Text style={styles.heroMeta}>
                  {fmtRange(accruing.periodStart, accruing.periodEnd)}
                  {accruing.units ? ` · ${accruing.units}` : ''}
                </Text>
                <View style={styles.heroFootRow}>
                  <Icon name="info" size={13} color={palette.textTertiary} />
                  <Text style={styles.heroFootText}>
                    Updates as you work — final after review
                  </Text>
                  <View style={{ flex: 1 }} />
                  <Icon name="chevron-right" size={16} color={palette.textTertiary} />
                </View>
              </Pressable>
            )}

            {/* Statement history */}
            {history.length > 0 && (
              <>
                <View style={styles.sectionHead}>
                  <Text style={styles.sectionLabel}>STATEMENTS</Text>
                </View>
                <View style={{ gap: 10 }}>
                  {history.map((row) => (
                    <StatementListRow
                      key={row.id}
                      row={row}
                      palette={palette}
                      styles={styles}
                      onPress={() => openStatement(row)}
                    />
                  ))}
                </View>
              </>
            )}
          </>
        )}
      </ScrollView>
    </SafeAreaView>
  );
}

function StatementListRow({
  row,
  palette,
  styles,
  onPress,
}: {
  row: StatementRow;
  palette: Palette;
  styles: ReturnType<typeof makeStyles>;
  onPress: () => void;
}) {
  const meta = STATUS_META[row.status];
  const color = meta.color(palette);
  const dateLine =
    row.status === 'PAID' && row.paidAt
      ? `Paid ${fmtDate(row.paidAt)}${row.paidMethod ? ` · ${row.paidMethod}` : ''}`
      : row.payDate
        ? `Pay date ${fmtDate(row.payDate)}`
        : fmtRange(row.periodStart, row.periodEnd);

  return (
    <Pressable
      onPress={onPress}
      style={({ pressed }) => [styles.rowCard, pressed && { opacity: 0.88 }]}
    >
      <View style={[styles.rowIcon, { backgroundColor: `${color}1F` }]}>
        <Icon name="clipboard" size={18} color={color} />
      </View>
      <View style={{ flex: 1, minWidth: 0 }}>
        <View style={styles.rowTitleLine}>
          <Text style={styles.rowTitle} numberOfLines={1}>
            {row.statementNumber ?? fmtRange(row.periodStart, row.periodEnd)}
          </Text>
          <View style={[styles.pill, { backgroundColor: `${color}1F` }]}>
            <Text style={[styles.pillText, { color }]}>{meta.label}</Text>
          </View>
        </View>
        <Text style={styles.rowMeta} numberOfLines={1}>
          {fmtRange(row.periodStart, row.periodEnd)}
        </Text>
        <Text style={styles.rowMeta} numberOfLines={1}>
          {dateLine}
        </Text>
      </View>
      <View style={{ alignItems: 'flex-end', gap: 2 }}>
        <Text style={styles.rowNet}>{fmtMoney(row.net)}</Text>
        <Icon name="chevron-right" size={15} color={palette.textTertiary} />
      </View>
    </Pressable>
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
    eyebrow: {
      fontSize: 11,
      fontWeight: '700',
      letterSpacing: 0.8,
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
    heroCard: {
      borderRadius: radii.lg,
      backgroundColor: palette.bgSurface,
      borderWidth: 1,
      borderColor: palette.borderSubtle,
      padding: sp.cardPadding,
    },
    heroNet: {
      fontSize: 32,
      fontWeight: '700',
      letterSpacing: -0.4,
      color: palette.textPrimary,
      marginTop: 6,
      fontVariant: ['tabular-nums'],
    },
    heroMeta: {
      fontSize: 12,
      color: palette.textSecondary,
      marginTop: 2,
    },
    heroFootRow: {
      flexDirection: 'row',
      alignItems: 'center',
      gap: 6,
      marginTop: 12,
      paddingTop: 10,
      borderTopWidth: StyleSheet.hairlineWidth,
      borderTopColor: palette.borderSubtle,
    },
    heroFootText: {
      fontSize: 11,
      color: palette.textTertiary,
    },
    sectionHead: {
      paddingTop: 20,
      paddingBottom: 8,
    },
    sectionLabel: {
      fontSize: 11,
      fontWeight: '700',
      letterSpacing: 0.8,
      color: palette.textTertiary,
    },
    rowCard: {
      flexDirection: 'row',
      alignItems: 'center',
      gap: 12,
      paddingVertical: sp.listPy,
      paddingHorizontal: sp.listPx,
      borderRadius: radii.lg,
      backgroundColor: palette.bgSurface,
      borderWidth: 1,
      borderColor: palette.borderSubtle,
    },
    rowIcon: {
      width: 36,
      height: 36,
      borderRadius: radii.md,
      alignItems: 'center',
      justifyContent: 'center',
    },
    rowTitleLine: {
      flexDirection: 'row',
      alignItems: 'center',
      gap: 6,
    },
    rowTitle: {
      fontSize: 14,
      fontWeight: '600',
      color: palette.textPrimary,
      flexShrink: 1,
    },
    rowMeta: {
      fontSize: 11,
      color: palette.textTertiary,
      marginTop: 1,
    },
    rowNet: {
      fontSize: 15,
      fontWeight: '700',
      color: palette.textPrimary,
      fontVariant: ['tabular-nums'],
    },
    pill: {
      paddingHorizontal: 7,
      paddingVertical: 2,
      borderRadius: radii.full,
    },
    pillText: {
      fontSize: 10,
      fontWeight: '700',
      letterSpacing: 0.3,
    },
    empty: {
      alignItems: 'center',
      paddingVertical: 64,
      gap: 6,
    },
    emptyIcon: {
      width: 56,
      height: 56,
      borderRadius: 999,
      backgroundColor: palette.bgMuted,
      alignItems: 'center',
      justifyContent: 'center',
      marginBottom: 8,
    },
    emptyTitle: {
      fontSize: 15,
      fontWeight: '600',
      color: palette.textPrimary,
    },
    emptyMeta: {
      fontSize: 12,
      color: palette.textTertiary,
      textAlign: 'center',
      paddingHorizontal: 32,
    },
  });
