/** Auto-plan sheet (Phase 3, §5.1 at scale) — proposed bundled runs over
 * the unassigned backlog. Pure proposal: nothing commits until the
 * dispatcher applies. Per run: chained loads with deadhead hops, top
 * driver suggestion (tap the driver row to cycle the top 3 — warned
 * candidates ranked, never hidden), and an include/exclude toggle.
 * Conflicts on apply are skipped-and-reported, never clobbered. */
import { useState } from 'react';
import { ActivityIndicator, Alert, Pressable, ScrollView, Text, View } from 'react-native';
import { useRouter } from 'expo-router';
import { Ionicons } from '@expo/vector-icons';
import { useMutation, useQuery } from 'convex/react';
import { api } from '@otoqa/convex-client';
import { borderRadius, colors, typography } from '@otoqa/mobile-core';

const fmt = (t: number) =>
  new Date(t).toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' });

export default function PlanScreen() {
  const router = useRouter();
  const plan = useQuery(api.dispatchMobile.suggestPlan, {});
  const applyPlan = useMutation(api.dispatchMobile.applyPlan);
  const [choice, setChoice] = useState<Record<number, number>>({});
  const [excluded, setExcluded] = useState<Record<number, boolean>>({});
  const [busy, setBusy] = useState(false);

  const includedPicks = (plan?.runs ?? [])
    .map((run, i) => ({ run, i }))
    .filter(({ run, i }) => !excluded[i] && run.candidates.length > 0);

  const apply = async () => {
    if (!plan || includedPicks.length === 0) return;
    setBusy(true);
    try {
      const res = await applyPlan({
        picks: includedPicks.map(({ run, i }) => ({
          driverId: run.candidates[(choice[i] ?? 0) % run.candidates.length]._id,
          assignmentIds: run.loads.map((l) => l.assignmentId),
        })),
      });
      const failed = res.results.filter((r) => !r.success);
      const ok = res.results.length - failed.length;
      if (failed.length === 0) {
        router.back();
      } else {
        Alert.alert(
          `${ok} assigned, ${failed.length} skipped`,
          failed.map((f) => `• ${f.reason ?? 'Skipped'}`).join('\n'),
          [{ text: 'OK', onPress: () => router.back() }],
        );
      }
    } catch (e) {
      Alert.alert('Something went wrong', e instanceof Error ? e.message : 'Please try again.');
    } finally {
      setBusy(false);
    }
  };

  return (
    <View style={{ flex: 1, backgroundColor: colors.background, paddingTop: 64 }}>
      <View style={{ flexDirection: 'row', alignItems: 'center', paddingHorizontal: 16, gap: 8 }}>
        <Pressable onPress={() => router.back()} hitSlop={12}>
          <Ionicons name="chevron-back" size={24} color={colors.foreground} />
        </Pressable>
        <Text style={{ fontSize: typography.xl, fontWeight: typography.bold, color: colors.foreground }}>
          Auto-plan
        </Text>
      </View>
      {plan === undefined ? (
        <ActivityIndicator color={colors.primary} style={{ marginTop: 48 }} />
      ) : plan.runs.length === 0 && plan.unplannable.length === 0 ? (
        <Text style={{ color: colors.foregroundMuted, fontSize: typography.sm, textAlign: 'center', marginTop: 48, lineHeight: 20 }}>
          Nothing to plan — every awarded load{'\n'}already has a driver.
        </Text>
      ) : (
        <>
          <ScrollView contentContainerStyle={{ padding: 24, paddingBottom: 120 }}>
            {plan.runs.map((run, i) => {
              const off = !!excluded[i];
              const cand = run.candidates.length
                ? run.candidates[(choice[i] ?? 0) % run.candidates.length]
                : null;
              return (
                <View
                  key={run.loads[0].assignmentId}
                  style={{ backgroundColor: colors.card, borderWidth: 1, borderColor: off ? colors.border : colors.primary, borderRadius: borderRadius.lg, padding: 14, marginBottom: 12, opacity: off ? 0.55 : 1 }}
                >
                  <View style={{ flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center' }}>
                    <Text style={{ color: colors.foreground, fontWeight: typography.bold, fontSize: typography.base }}>
                      Run {i + 1} · {run.loads.length} load{run.loads.length === 1 ? '' : 's'}
                    </Text>
                    <Pressable onPress={() => setExcluded((x) => ({ ...x, [i]: !x[i] }))} hitSlop={10}>
                      <Ionicons
                        name={off ? 'square-outline' : 'checkbox'}
                        size={22}
                        color={off ? colors.foregroundMuted : colors.primary}
                      />
                    </Pressable>
                  </View>
                  <Text style={{ color: colors.foregroundMuted, fontSize: typography.xs, marginTop: 2 }}>
                    {fmt(run.start)} – {fmt(run.end)}
                  </Text>
                  {run.loads.map((l, j) => (
                    <View key={l.assignmentId} style={{ marginTop: 8 }}>
                      {j > 0 && (
                        <Text style={{ color: colors.foregroundMuted, fontSize: typography.xs, marginBottom: 4 }}>
                          ↓ {run.deadheadMiles[j - 1]} mi deadhead
                        </Text>
                      )}
                      <Text style={{ color: colors.foreground, fontSize: typography.sm, fontWeight: typography.semibold }}>
                        #{l.load?.internalId ?? '—'}{' '}
                        <Text style={{ color: colors.foregroundMuted, fontWeight: typography.medium }}>
                          {l.load?.customerName ?? ''} · {fmt(l.start)}
                        </Text>
                      </Text>
                    </View>
                  ))}
                  {cand ? (
                    <Pressable
                      onPress={() =>
                        run.candidates.length > 1 && setChoice((c) => ({ ...c, [i]: (c[i] ?? 0) + 1 }))
                      }
                      style={{ flexDirection: 'row', alignItems: 'center', gap: 8, marginTop: 12, paddingTop: 10, borderTopWidth: 1, borderTopColor: colors.border }}
                    >
                      <Ionicons name="person-circle-outline" size={20} color={colors.primary} />
                      <View style={{ flex: 1 }}>
                        <Text style={{ color: colors.foreground, fontSize: typography.sm, fontWeight: typography.semibold }}>
                          {cand.firstName} {cand.lastName}
                          {cand.milesFromPickup != null ? `  ·  ${cand.milesFromPickup} mi out` : ''}
                        </Text>
                        {cand.warns.length > 0 && (
                          <Text style={{ color: colors.warning, fontSize: typography.xs, marginTop: 1 }}>
                            {cand.warns.join(' · ')}
                          </Text>
                        )}
                      </View>
                      {run.candidates.length > 1 && (
                        <Ionicons name="swap-vertical" size={16} color={colors.foregroundMuted} />
                      )}
                    </Pressable>
                  ) : (
                    <Text style={{ color: colors.warning, fontSize: typography.xs, marginTop: 12 }}>
                      No available driver to suggest — assign manually from the Board.
                    </Text>
                  )}
                </View>
              );
            })}
            {plan.unplannable.length > 0 && (
              <>
                <Text style={{ color: colors.foregroundMuted, fontSize: typography.xs, fontWeight: typography.bold, letterSpacing: 1, textTransform: 'uppercase', marginTop: 8, marginBottom: 6 }}>
                  Needs attention · {plan.unplannable.length}
                </Text>
                {plan.unplannable.map((u) => (
                  <View key={u.assignmentId} style={{ backgroundColor: colors.card, borderWidth: 1, borderColor: colors.border, borderRadius: borderRadius.lg, padding: 12, marginBottom: 8 }}>
                    <Text style={{ color: colors.foreground, fontSize: typography.sm, fontWeight: typography.semibold }}>
                      #{u.load?.internalId ?? '—'}
                    </Text>
                    <Text style={{ color: colors.warning, fontSize: typography.xs, marginTop: 2 }}>{u.reason}</Text>
                  </View>
                ))}
              </>
            )}
          </ScrollView>
          {includedPicks.length > 0 && (
            <View style={{ position: 'absolute', left: 24, right: 24, bottom: 34 }}>
              <Pressable
                disabled={busy}
                onPress={() => void apply()}
                style={{ flexDirection: 'row', justifyContent: 'center', alignItems: 'center', gap: 8, backgroundColor: colors.primary, paddingVertical: 14, borderRadius: borderRadius.lg, opacity: busy ? 0.6 : 1 }}
              >
                {busy ? (
                  <ActivityIndicator color={colors.primaryForeground} />
                ) : (
                  <>
                    <Ionicons name="sparkles" size={17} color={colors.primaryForeground} />
                    <Text style={{ color: colors.primaryForeground, fontSize: typography.base, fontWeight: typography.semibold }}>
                      Apply {includedPicks.length} run{includedPicks.length === 1 ? '' : 's'}
                    </Text>
                  </>
                )}
              </Pressable>
            </View>
          )}
        </>
      )}
    </View>
  );
}
