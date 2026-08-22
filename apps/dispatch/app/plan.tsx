/** Auto-plan sheet (Phase 3, §5.1 at scale) — proposed bundled runs over
 * the unassigned backlog. Pure proposal: nothing commits until the
 * dispatcher applies. Per run: chained loads with deadhead hops, top
 * driver suggestion (tap the driver row to cycle the top 3 — warned
 * candidates ranked, never hidden), and an include/exclude toggle.
 * Conflicts on apply are skipped-and-reported, never clobbered. */
import { useMemo, useState } from 'react';
import {
  ActivityIndicator,
  Alert,
  FlatList,
  Modal,
  Pressable,
  ScrollView,
  Text,
  View,
} from 'react-native';
import { useRouter } from 'expo-router';
import { Ionicons } from '@expo/vector-icons';
import { useMutation, useQuery } from 'convex/react';
import { api } from '@otoqa/convex-client';
import { borderRadius, colors, typography } from '../lib/theme';
import { displayLoadId } from '../lib/format';
import { trackAction } from '../lib/analytics';
import { planSummary } from '../lib/board';
import { Avatar, SearchField } from '../lib/ui';

/** Small labelled fact, per the design's Meta chip. */
function Meta({ children, tone }: { children: string; tone: 'good' | 'warn' | 'plain' }) {
  const map = {
    good: { bg: 'rgba(16,185,129,0.12)', fg: colors.success },
    warn: { bg: 'rgba(245,158,11,0.14)', fg: colors.warning },
    plain: { bg: colors.muted, fg: colors.foregroundMuted },
  } as const;
  const t = map[tone];
  return (
    <View
      style={{
        backgroundColor: t.bg,
        paddingHorizontal: 8,
        paddingVertical: 3,
        borderRadius: borderRadius.full,
      }}
    >
      <Text style={{ color: t.fg, fontSize: typography.sm, fontWeight: typography.semibold }}>
        {children}
      </Text>
    </View>
  );
}

const fmt = (t: number) =>
  new Date(t).toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' });

export default function PlanScreen() {
  const router = useRouter();
  const plan = useQuery(api.dispatchMobile.suggestPlan, {});
  const applyPlan = useMutation(api.dispatchMobile.applyPlan);
  const [choice, setChoice] = useState<Record<number, number>>({});
  const [excluded, setExcluded] = useState<Record<number, boolean>>({});
  const [busy, setBusy] = useState(false);

  // Cycling the top three reaches the drivers the scorer liked. Overriding
  // reaches the one the dispatcher already had in mind — which on a fleet
  // this size is the difference between one tap and a scroll.
  const roster = useQuery(api.dispatchMobile.listAvailableDrivers, {});
  const [pickerFor, setPickerFor] = useState<number | null>(null);
  const [override, setOverride] = useState<
    Record<number, { _id: string; firstName: string; lastName: string }>
  >({});
  const [q, setQ] = useState('');

  const rosterMatches = useMemo(() => {
    const needle = q.trim().toLowerCase();
    const all = roster ?? [];
    if (!needle) return all;
    return all.filter((d) =>
      `${d.firstName ?? ''} ${d.lastName ?? ''} ${d.phone ?? ''}`.toLowerCase().includes(needle),
    );
  }, [roster, q]);

  // The design puts these counts on the Board's plan card. They live here
  // instead: the summary needs the ranked plan, and ranking reads every
  // driver's location and HOS per run — too heavy for a reactive landing
  // screen, free here where the plan is already loaded.
  // Captured once at mount rather than ticked: this sheet is transient, and
  // only `urgent` is time-dependent. Re-reading the clock each render would
  // be impure for no behavioural gain.
  const [openedAt] = useState(() => Date.now());
  const summary = plan ? planSummary(plan, openedAt) : null;

  const includedPicks = (plan?.runs ?? [])
    .map((run, i) => ({ run, i }))
    .filter(({ run, i }) => !excluded[i] && (run.candidates.length > 0 || !!override[i]));

  const apply = async () => {
    if (!plan || includedPicks.length === 0) return;
    setBusy(true);
    try {
      const res = await applyPlan({
        picks: includedPicks.map(({ run, i }) => ({
          driverId: (override[i]?._id ??
            run.candidates[(choice[i] ?? 0) % run.candidates.length]._id) as never,
          assignmentIds: run.loads.map((l) => l.assignmentId),
        })),
      });
      const failed = res.results.filter((r) => !r.success);
      const ok = res.results.length - failed.length;
      trackAction('plan_applied', { applied: ok, skipped: failed.length });
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
        <View style={{ flex: 1 }}>
          <Text style={{ fontSize: typography.xl, fontWeight: typography.bold, color: colors.foreground }}>
            Auto-plan
          </Text>
          {summary && summary.trucks > 0 && (
            <Text style={{ fontSize: typography.sm, color: colors.foregroundSubtle, marginTop: 2 }}>
              {summary.loads} load{summary.loads === 1 ? '' : 's'} across {summary.trucks} truck
              {summary.trucks === 1 ? '' : 's'}
              {summary.needsCall > 0 ? ` · ${summary.needsCall} need your call` : ''}
            </Text>
          )}
        </View>
      </View>
      {summary && summary.trucks > 0 && (
        <View
          style={{ flexDirection: 'row', gap: 6, flexWrap: 'wrap', paddingHorizontal: 24, marginTop: 12 }}
        >
          <Meta tone="good">{`${summary.clean} clean`}</Meta>
          {summary.needsCall > 0 && (
            <Meta tone="warn">{`${summary.needsCall} exception${summary.needsCall === 1 ? '' : 's'}`}</Meta>
          )}
          {summary.urgent > 0 && <Meta tone="plain">{`${summary.urgent} in the next 4h`}</Meta>}
        </View>
      )}
      {plan === undefined ? (
        <ActivityIndicator color={colors.primary} style={{ marginTop: 48 }} />
      ) : plan.runs.length === 0 && plan.unplannable.length === 0 ? (
        <Text style={{ color: colors.foregroundMuted, fontSize: typography.sm, textAlign: 'center', marginTop: 48, lineHeight: 20 }}>
          Nothing to plan — every awarded load{'\n'}already has a driver.
        </Text>
      ) : (
        <>
          <Modal
            visible={pickerFor !== null}
            animationType="slide"
            transparent={false}
            onRequestClose={() => setPickerFor(null)}
          >
            <View style={{ flex: 1, backgroundColor: colors.background, paddingTop: 64 }}>
              <View style={{ flexDirection: 'row', alignItems: 'center', paddingHorizontal: 16, gap: 8 }}>
                <Pressable onPress={() => setPickerFor(null)} hitSlop={12}>
                  <Ionicons name="chevron-back" size={24} color={colors.foreground} />
                </Pressable>
                <Text style={{ fontSize: typography.xl, fontWeight: typography.bold, color: colors.foreground }}>
                  {pickerFor !== null ? `Driver for run ${pickerFor + 1}` : 'Pick a driver'}
                </Text>
              </View>
              <View style={{ paddingHorizontal: 24, paddingTop: 14 }}>
                <SearchField
                  value={q}
                  onChangeText={setQ}
                  placeholder={`Search ${(roster ?? []).length} drivers`}
                />
              </View>
              {roster === undefined ? (
                <ActivityIndicator color={colors.primary} style={{ marginTop: 48 }} />
              ) : (
                <FlatList
                  data={rosterMatches}
                  keyExtractor={(d) => d._id}
                  style={{ flex: 1 }}
                  keyboardShouldPersistTaps="handled"
                  contentContainerStyle={{ padding: 24, gap: 8 }}
                  ListEmptyComponent={
                    <Text
                      style={{
                        color: colors.foregroundSubtle,
                        fontSize: typography.base,
                        textAlign: 'center',
                        paddingVertical: 40,
                      }}
                    >
                      No drivers match.
                    </Text>
                  }
                  renderItem={({ item }) => (
                    <Pressable
                      onPress={() => {
                        if (pickerFor === null) return;
                        setOverride((o) => ({
                          ...o,
                          [pickerFor]: {
                            _id: item._id,
                            firstName: item.firstName,
                            lastName: item.lastName,
                          },
                        }));
                        setPickerFor(null);
                      }}
                      style={{
                        flexDirection: 'row',
                        alignItems: 'center',
                        gap: 11,
                        backgroundColor: colors.card,
                        borderWidth: 1,
                        borderColor: colors.borderSubtle,
                        borderRadius: borderRadius.lg,
                        padding: 12,
                      }}
                    >
                      <Avatar id={item._id} first={item.firstName} last={item.lastName} size={34} />
                      <View style={{ flex: 1, minWidth: 0 }}>
                        <Text
                          numberOfLines={1}
                          style={{ color: colors.foreground, fontSize: typography.base, fontWeight: typography.semibold }}
                        >
                          {item.firstName} {item.lastName}
                        </Text>
                        {item.phone ? (
                          <Text style={{ color: colors.foregroundSubtle, fontSize: typography.sm, marginTop: 2 }}>
                            {item.phone}
                          </Text>
                        ) : null}
                      </View>
                      <Ionicons name="chevron-forward" size={16} color={colors.foregroundSubtle} />
                    </Pressable>
                  )}
                />
              )}
            </View>
          </Modal>

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
                        {l.load ? displayLoadId(l.load.internalId) : '—'}{' '}
                        <Text style={{ color: colors.foregroundMuted, fontWeight: typography.medium }}>
                          {l.load?.tripNumber ? `Trip ${l.load.tripNumber} · ` : ''}
                          {l.load?.customerName ?? ''} · {fmt(l.start)}
                        </Text>
                      </Text>
                    </View>
                  ))}
                  {cand || override[i] ? (
                    <Pressable
                      onPress={() =>
                        !override[i] &&
                        run.candidates.length > 1 &&
                        setChoice((c) => ({ ...c, [i]: (c[i] ?? 0) + 1 }))
                      }
                      style={{ flexDirection: 'row', alignItems: 'center', gap: 8, marginTop: 12, paddingTop: 10, borderTopWidth: 1, borderTopColor: colors.border }}
                    >
                      <Ionicons name="person-circle-outline" size={20} color={colors.primary} />
                      <View style={{ flex: 1 }}>
                        <Text style={{ color: colors.foreground, fontSize: typography.sm, fontWeight: typography.semibold }}>
                          {override[i]
                            ? `${override[i].firstName} ${override[i].lastName}`
                            : `${cand!.firstName} ${cand!.lastName}`}
                          {!override[i] && cand!.milesFromPickup != null
                            ? `  ·  ${cand!.milesFromPickup} mi out`
                            : ''}
                        </Text>
                        {override[i] ? (
                          <Text style={{ color: colors.foregroundSubtle, fontSize: typography.xs, marginTop: 1 }}>
                            Chosen by you
                          </Text>
                        ) : (
                          cand!.warns.length > 0 && (
                            <Text style={{ color: colors.warning, fontSize: typography.xs, marginTop: 1 }}>
                              {cand!.warns.join(' · ')}
                            </Text>
                          )
                        )}
                      </View>
                      {!override[i] && run.candidates.length > 1 && (
                        <Ionicons name="swap-vertical" size={16} color={colors.foregroundMuted} />
                      )}
                      <Pressable
                        onPress={() => {
                          setQ('');
                          setPickerFor(i);
                        }}
                        hitSlop={8}
                        style={{ paddingHorizontal: 6 }}
                      >
                        <Text style={{ color: colors.primary, fontSize: typography.xs, fontWeight: typography.bold }}>
                          {override[i] ? 'CHANGE' : 'PICK'}
                        </Text>
                      </Pressable>
                    </Pressable>
                  ) : (
                    <Pressable
                      onPress={() => {
                        setQ('');
                        setPickerFor(i);
                      }}
                      style={{
                        flexDirection: 'row',
                        alignItems: 'center',
                        justifyContent: 'center',
                        gap: 6,
                        marginTop: 12,
                        minHeight: 38,
                        borderRadius: borderRadius.md,
                        backgroundColor: colors.accentTint,
                      }}
                    >
                      <Ionicons name="person-add-outline" size={15} color={colors.primary} />
                      <Text style={{ color: colors.primary, fontSize: typography.sm, fontWeight: typography.bold }}>
                        Pick a driver
                      </Text>
                    </Pressable>
                  )}
                  {!cand && !override[i] && (
                    <Text style={{ color: colors.warning, fontSize: typography.xs, marginTop: 8 }}>
                      No driver scored well for this run — pick one above to include it.
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
                      {u.load ? displayLoadId(u.load.internalId) : '—'}
                      {u.load?.tripNumber ? ` · Trip ${u.load.tripNumber}` : ''}
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
