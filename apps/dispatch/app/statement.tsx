/** Statement detail — itemized settlement via dispatchMobile.getStatementDetails.
 * All money and period copy renders from data (D7). Shows the truncation
 * notice when a statement carries more lines than the detail cap. */
import { ActivityIndicator, FlatList, Pressable, Text, View } from 'react-native';
import { useLocalSearchParams, useRouter } from 'expo-router';
import { useQuery } from 'convex/react';
import { Ionicons } from '@expo/vector-icons';
import { api } from '@otoqa/convex-client';
import { borderRadius, colors, typography } from '@otoqa/mobile-core';

const day = (ms: number) =>
  new Date(ms).toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
const money = (n: number) => `$${n.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

export default function StatementScreen() {
  const router = useRouter();
  const { settlementId, source } = useLocalSearchParams<{ settlementId: string; source: 'legacy' | 'ledger' }>();
  const data = useQuery(
    api.dispatchMobile.getStatementDetails,
    settlementId && source ? { settlementId, source } : 'skip',
  );

  return (
    <View style={{ flex: 1, backgroundColor: colors.background, paddingTop: 64 }}>
      <View style={{ flexDirection: 'row', alignItems: 'center', paddingHorizontal: 16, gap: 8 }}>
        <Pressable onPress={() => router.back()} hitSlop={12}>
          <Ionicons name="chevron-back" size={24} color={colors.foreground} />
        </Pressable>
        <Text style={{ fontSize: typography.xl, fontWeight: typography.bold, color: colors.foreground }}>
          {data ? `${day(data.statement.periodStart)} – ${day(data.statement.periodEnd)}` : 'Statement'}
        </Text>
      </View>
      {data === undefined ? (
        <ActivityIndicator color={colors.primary} style={{ marginTop: 48 }} />
      ) : (
        <FlatList
          data={data.lines}
          keyExtractor={(l) => l.id}
          contentContainerStyle={{ padding: 20, gap: 8 }}
          ListHeaderComponent={
            <View style={{ gap: 10, marginBottom: 12 }}>
              <View style={{ backgroundColor: colors.card, borderWidth: 1, borderColor: colors.border, borderRadius: borderRadius.lg, padding: 14 }}>
                <Text style={{ color: colors.foregroundMuted, fontSize: typography.sm }}>
                  {data.statement.brokerName}
                  {data.statement.statementNumber ? ` · #${data.statement.statementNumber}` : ''} · {data.statement.status}
                  {data.statement.paidAt
                    ? ` ${day(data.statement.paidAt)}${data.statement.paidMethod ? ` · ${data.statement.paidMethod}` : ''}`
                    : data.statement.payDate
                      ? ` · pays ${day(data.statement.payDate)}`
                      : ''}
                </Text>
                {([
                  ['Earnings', data.summary.earnTotal],
                  ['Reimbursements', data.summary.reimbTotal],
                  ['Deductions', -data.summary.deductTotal],
                ] as const).map(([label, amt]) => (
                  <View key={label} style={{ flexDirection: 'row', justifyContent: 'space-between', marginTop: 8 }}>
                    <Text style={{ color: colors.foregroundMuted, fontSize: typography.sm }}>{label}</Text>
                    <Text style={{ color: colors.foreground, fontSize: typography.sm }}>{money(amt)}</Text>
                  </View>
                ))}
                <View style={{ flexDirection: 'row', justifyContent: 'space-between', marginTop: 10, paddingTop: 10, borderTopWidth: 1, borderTopColor: colors.border }}>
                  <Text style={{ color: colors.foreground, fontWeight: typography.bold }}>Net</Text>
                  <Text style={{ color: colors.foreground, fontWeight: typography.bold }}>{money(data.summary.net)}</Text>
                </View>
              </View>
              {data.linesTruncated && (
                <Text style={{ color: colors.warning, fontSize: typography.xs }}>
                  Long statement — showing the first {data.lines.length} lines; totals above are exact.
                </Text>
              )}
            </View>
          }
          renderItem={({ item }) => (
            <View style={{ backgroundColor: colors.card, borderWidth: 1, borderColor: colors.border, borderRadius: borderRadius.md, padding: 12 }}>
              <View style={{ flexDirection: 'row', justifyContent: 'space-between' }}>
                <Text style={{ color: colors.foreground, fontSize: typography.sm, flex: 1 }} numberOfLines={1}>
                  {item.description}
                </Text>
                <Text style={{ color: item.totalAmount < 0 ? colors.destructive : colors.foreground, fontSize: typography.sm, fontWeight: typography.semibold }}>
                  {money(item.totalAmount)}
                </Text>
              </View>
              <Text style={{ color: colors.foregroundMuted, fontSize: typography.xs, marginTop: 3 }}>
                {item.workStart ? `${day(item.workStart)} · ` : ''}
                {item.loadLabel ?? item.category}
              </Text>
            </View>
          )}
        />
      )}
    </View>
  );
}
