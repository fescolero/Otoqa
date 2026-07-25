/** Pay — carrier settlements via dispatchMobile.listStatements.
 * Period labels render from statement data (D7: WEEKLY/BIWEEKLY/MONTHLY
 * orgs exist — never hardcode "weekly / pays Wednesday"). Reachable only
 * from the capability-gated More row; the query itself enforces
 * canViewSettlements server-side either way. */
import { ActivityIndicator, FlatList, Pressable, Text, View } from 'react-native';
import { useRouter } from 'expo-router';
import { useQuery } from 'convex/react';
import { Ionicons } from '@expo/vector-icons';
import { api } from '@otoqa/convex-client';
import { borderRadius, colors, typography } from '@otoqa/mobile-core';

const day = (ms: number) =>
  new Date(ms).toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
const money = (n: number) => `$${n.toLocaleString('en-US', { maximumFractionDigits: 2 })}`;

export default function PayScreen() {
  const router = useRouter();
  const rows = useQuery(api.dispatchMobile.listStatements, {});

  return (
    <View style={{ flex: 1, backgroundColor: colors.background, paddingTop: 64 }}>
      <View style={{ flexDirection: 'row', alignItems: 'center', paddingHorizontal: 16, gap: 8 }}>
        <Pressable onPress={() => router.back()} hitSlop={12}>
          <Ionicons name="chevron-back" size={24} color={colors.foreground} />
        </Pressable>
        <Text style={{ fontSize: typography['2xl'], fontWeight: typography.bold, color: colors.foreground }}>
          Pay & settlements
        </Text>
      </View>
      {rows === undefined ? (
        <ActivityIndicator color={colors.primary} style={{ marginTop: 48 }} />
      ) : rows.length === 0 ? (
        <Text style={{ color: colors.foregroundMuted, fontSize: typography.sm, textAlign: 'center', marginTop: 48, lineHeight: 20 }}>
          No settlements yet.{'\n'}Statements appear here as pay periods close.
        </Text>
      ) : (
        <FlatList
          data={rows}
          keyExtractor={(r) => r.id}
          contentContainerStyle={{ padding: 20, gap: 10 }}
          renderItem={({ item }) => (
            <View style={{ backgroundColor: colors.card, borderWidth: 1, borderColor: colors.border, borderRadius: borderRadius.lg, padding: 14 }}>
              <View style={{ flexDirection: 'row', justifyContent: 'space-between' }}>
                <Text style={{ color: colors.foreground, fontWeight: typography.semibold }}>
                  {day(item.periodStart)} – {day(item.periodEnd)}
                </Text>
                <Text style={{ color: colors.foreground, fontWeight: typography.bold }}>
                  {money(item.net)}
                </Text>
              </View>
              <Text style={{ color: colors.foregroundMuted, fontSize: typography.sm, marginTop: 3 }}>
                {item.brokerName}
                {item.statementNumber ? ` · #${item.statementNumber}` : ''} · {item.status}
                {item.paidAt ? ` ${day(item.paidAt)}` : item.payDate ? ` · pays ${day(item.payDate)}` : ''}
              </Text>
            </View>
          )}
        />
      )}
    </View>
  );
}
