/** Re-time appointment windows (§5.4) — per-stop ±15 min steppers on the
 * window end, knock-on warnings surfaced from the server, audit-logged. */
import * as React from 'react';
import { ActivityIndicator, Alert, FlatList, Pressable, Text, View } from 'react-native';
import { useLocalSearchParams, useRouter } from 'expo-router';
import { useMutation, useQuery } from 'convex/react';
import { Ionicons } from '@expo/vector-icons';
import { api } from '@otoqa/convex-client';
import { borderRadius, colors, typography } from '@otoqa/mobile-core';

const STEP_MS = 15 * 60 * 1000;
const fmt = (iso: string | undefined) =>
  iso ? new Date(iso).toLocaleString(undefined, { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' }) : '—';

export default function AdjustScreen() {
  const router = useRouter();
  const { assignmentId } = useLocalSearchParams<{ assignmentId: string }>();
  const rows = useQuery(api.dispatchMobile.listActiveAssignments, {});
  const adjust = useMutation(api.dispatchMobile.adjustStopWindow);
  const [deltas, setDeltas] = React.useState<Record<string, number>>({});

  const assignment = rows?.find((r) => r._id === assignmentId);

  const save = async (stopId: string, baseEnd: string) => {
    const delta = deltas[stopId] ?? 0;
    if (delta === 0) return;
    const newEnd = new Date(Date.parse(baseEnd) + delta).toISOString();
    const res = await adjust({ stopId: stopId as never, windowEndTime: newEnd });
    setDeltas((d) => ({ ...d, [stopId]: 0 }));
    if (res.warnings.length > 0) Alert.alert('Heads up', res.warnings.join('\n'));
  };

  return (
    <View style={{ flex: 1, backgroundColor: colors.background, paddingTop: 64 }}>
      <View style={{ flexDirection: 'row', alignItems: 'center', paddingHorizontal: 16, gap: 8 }}>
        <Pressable onPress={() => router.back()} hitSlop={12}>
          <Ionicons name="chevron-back" size={24} color={colors.foreground} />
        </Pressable>
        <Text style={{ fontSize: typography.xl, fontWeight: typography.bold, color: colors.foreground }}>
          Adjust times{assignment?.load ? ` · #${assignment.load.internalId}` : ''}
        </Text>
      </View>
      {rows === undefined ? (
        <ActivityIndicator color={colors.primary} style={{ marginTop: 48 }} />
      ) : !assignment ? (
        <Text style={{ color: colors.foregroundMuted, textAlign: 'center', marginTop: 48 }}>
          This load is no longer active.
        </Text>
      ) : (
        <FlatList
          data={assignment.stops.filter((s) => s.windowEndTime)}
          keyExtractor={(s) => s._id}
          contentContainerStyle={{ padding: 20, gap: 10 }}
          ListEmptyComponent={
            <Text style={{ color: colors.foregroundMuted, textAlign: 'center', marginTop: 32 }}>
              No stops with appointment windows on this load.
            </Text>
          }
          renderItem={({ item }) => {
            const delta = deltas[item._id] ?? 0;
            const newEnd = item.windowEndTime
              ? new Date(Date.parse(item.windowEndTime) + delta).toISOString()
              : undefined;
            return (
              <View style={{ backgroundColor: colors.card, borderWidth: 1, borderColor: delta !== 0 ? colors.primary : colors.border, borderRadius: borderRadius.lg, padding: 14 }}>
                <Text style={{ color: colors.foreground, fontWeight: typography.semibold }}>
                  {item.stopType === 'PICKUP' ? 'Pickup' : 'Stop'} {item.sequenceNumber} · {item.address}
                </Text>
                <Text style={{ color: colors.foregroundMuted, fontSize: typography.sm, marginTop: 4 }}>
                  Window ends {fmt(newEnd)}
                  {delta !== 0 ? `  (${delta > 0 ? '+' : ''}${delta / 60000} min)` : ''}
                </Text>
                <View style={{ flexDirection: 'row', alignItems: 'center', gap: 10, marginTop: 10 }}>
                  {[-STEP_MS, STEP_MS].map((step) => (
                    <Pressable
                      key={step}
                      onPress={() => setDeltas((d) => ({ ...d, [item._id]: (d[item._id] ?? 0) + step }))}
                      style={{ borderWidth: 1, borderColor: colors.border, borderRadius: borderRadius.md, paddingHorizontal: 14, paddingVertical: 8 }}
                    >
                      <Text style={{ color: colors.foreground, fontWeight: typography.bold }}>
                        {step < 0 ? '−15 min' : '+15 min'}
                      </Text>
                    </Pressable>
                  ))}
                  <Pressable
                    disabled={delta === 0}
                    onPress={() => void save(item._id, item.windowEndTime!)}
                    style={{ marginLeft: 'auto', backgroundColor: delta === 0 ? colors.border : colors.primary, borderRadius: borderRadius.md, paddingHorizontal: 16, paddingVertical: 8 }}
                  >
                    <Text style={{ color: colors.primaryForeground, fontWeight: typography.semibold }}>
                      {delta === 0 ? 'No change' : `Move to ${newEnd ? fmt(newEnd).split(', ').pop() : ''}`}
                    </Text>
                  </Pressable>
                </View>
              </View>
            );
          }}
        />
      )}
    </View>
  );
}
