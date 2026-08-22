/** Board — the capacity-first view from the v8 design
 * (`lib-dispatch/capacity.jsx`): horizon tiles summarising what lands when,
 * a one-tap route into batch planning, then the work itself.
 *
 * Live assignments bucketed by horizon: pending
 * broker OFFERS first (accept/decline — Phase 3), then what's rolling
 * now, then AWARDED work by urgency of its next window — Next 4 hours /
 * Today / Later / Unscheduled. The backlog is never one flat list.
 * Buckets compute client-side from the stops the read wrapper already
 * returns. */
import { useEffect, useMemo, useState } from 'react';
import { ActivityIndicator, Alert, Pressable, SectionList, Text, View } from 'react-native';
import { useRouter } from 'expo-router';
import { Ionicons } from '@expo/vector-icons';
import { useMutation, useQuery } from 'convex/react';
import { api } from '@otoqa/convex-client';
import { borderRadius, colors, typography } from '../../lib/theme';
import { displayLoadId } from '../../lib/format';
import {
  countByHorizon,
  horizonOf,
  horizonTiles,
  HORIZON_ORDER,
  isActionable,
  type Horizon,
} from '../../lib/board';
import { AllTrucksLoadedCard, RunRow, TruckNeedCard } from '../../lib/board-cards';
import { useDispatchSession } from './_layout';

type Row = NonNullable<ReturnType<typeof useQuery<typeof api.dispatchMobile.listActiveAssignments>>>[number];
type OfferRow = NonNullable<ReturnType<typeof useQuery<typeof api.dispatchMobile.listOffers>>>[number];

type Section = {
  title: string;
  hot: boolean;
  offers?: boolean;
  /** Rows in this section still need a driver — show the assign affordance. */
  assign?: boolean;
  data: (Row | OfferRow)[];
};

/** Awarded to us, nobody driving it yet — the thing this app exists to fix. */
function isUnassigned(r: Row): boolean {
  return r.status === 'AWARDED' && !r.driver;
}

/** Earliest window of a not-yet-checked-in stop — the load's "next action" time. */
function nextWindow(r: Row | OfferRow): number | null {
  const t = r.stops
    .filter((s) => !s.checkedInAt && s.windowBeginTime)
    .map((s) => Date.parse(s.windowBeginTime!))
    .filter(Number.isFinite)
    .sort((a, b) => a - b)[0];
  return t ?? null;
}

/**
 * The board is an assignment tool, so it leads with work that still needs a
 * driver, bucketed by how soon it's due — exactly what the tiles count.
 *
 * Everything else is status rather than a to-do: rolling work has started,
 * and assigned work is handled. Both stay visible, below, so the board is
 * still a complete picture — but they don't compete with the backlog for
 * the top of the screen, and they aren't counted in the tiles.
 */
function bucketsOf(rows: Row[], now: number): Section[] {
  const needsDriver = (k: Horizon) =>
    rows
      .filter(
        (r) =>
          isUnassigned(r) &&
          isActionable(nextWindow(r), now) &&
          horizonOf(nextWindow(r), now) === k,
      )
      .sort((a, b) => (nextWindow(a) ?? 0) - (nextWindow(b) ?? 0));

  const assigned = rows
    .filter((r) => r.status === 'AWARDED' && !isUnassigned(r))
    .sort((a, b) => (nextWindow(a) ?? 0) - (nextWindow(b) ?? 0));

  const tiles = horizonTiles(now);
  return [
    ...HORIZON_ORDER.map((k) => ({
      title: tiles.find((t) => t.k === k)?.label ?? k,
      hot: k === 'now',
      assign: true,
      data: needsDriver(k),
    })),
    { title: 'Unscheduled', hot: false, assign: true, data: needsDriver('unscheduled') },
    { title: 'Rolling now', hot: false, data: rows.filter((r) => r.status === 'IN_PROGRESS') },
    { title: 'Assigned', hot: false, data: assigned },
  ].filter((s) => s.data.length > 0);
}

function fmtTime(t: number | null): string {
  return t ? new Date(t).toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' }) : '';
}

/** Small facet pill (HCR / Trip). */
function Tag({ label }: { label: string }) {
  return (
    <View style={{ borderWidth: 1, borderColor: colors.border, borderRadius: 999, paddingHorizontal: 8, paddingVertical: 2 }}>
      <Text style={{ color: colors.foregroundMuted, fontSize: typography.xs }}>{label}</Text>
    </View>
  );
}

/** HCR + Trip chips row; renders nothing when the load has neither. */
function FacetTags({ load }: { load?: { hcr?: string | null; tripNumber?: string | null } | null }) {
  if (!load?.hcr && !load?.tripNumber) return null;
  return (
    <View style={{ flexDirection: 'row', gap: 6, marginTop: 6, flexWrap: 'wrap' }}>
      {load?.hcr ? <Tag label={`HCR ${load.hcr}`} /> : null}
      {load?.tripNumber ? <Tag label={`Trip ${load.tripNumber}`} /> : null}
    </View>
  );
}

/** Offer card — Accept / Decline while OFFERED; "awaiting award" after. */
function OfferCard({ offer }: { offer: OfferRow }) {
  const acceptOffer = useMutation(api.dispatchMobile.acceptOffer);
  const declineOffer = useMutation(api.dispatchMobile.declineOffer);
  const [busy, setBusy] = useState(false);
  const t = nextWindow(offer);

  const run = async (fn: () => Promise<unknown>) => {
    setBusy(true);
    try {
      await fn();
    } catch (e) {
      Alert.alert('Something went wrong', e instanceof Error ? e.message : 'Please try again.');
    } finally {
      setBusy(false);
    }
  };

  const confirmDecline = () =>
    Alert.alert(
      'Decline this offer?',
      `Load ${displayLoadId(offer.load?.internalId)} goes back to the broker. This can't be undone.`,
      [
        { text: 'Keep offer', style: 'cancel' },
        {
          text: 'Decline',
          style: 'destructive',
          onPress: () => void run(() => declineOffer({ assignmentId: offer._id })),
        },
      ],
    );

  return (
    <Pressable
      onLongPress={() => Alert.alert('Load payload (debug)', JSON.stringify(offer.load, null, 2))}
      style={{ backgroundColor: colors.card, borderWidth: 1, borderColor: colors.primary, borderRadius: borderRadius.lg, padding: 14, marginBottom: 10 }}
    >
      <View style={{ flexDirection: 'row', justifyContent: 'space-between' }}>
        <Text style={{ color: colors.foreground, fontWeight: typography.semibold, fontSize: typography.base }}>
          {displayLoadId(offer.load?.internalId)}
        </Text>
        {offer.status === 'ACCEPTED' ? (
          <Text style={{ color: colors.foregroundMuted, fontSize: typography.xs, fontWeight: typography.bold }}>
            Accepted · awaiting award
          </Text>
        ) : (
          <Text style={{ color: colors.primary, fontSize: typography.xs, fontWeight: typography.bold }}>
            New offer
          </Text>
        )}
      </View>
      <Text style={{ color: colors.foregroundMuted, fontSize: typography.sm, marginTop: 3 }}>
        {offer.load?.customerName ?? 'Customer'} · {offer.stops.length} stop{offer.stops.length === 1 ? '' : 's'}
        {t ? ` · ${fmtTime(t)}` : ''}
        {offer.load?.effectiveMiles ? ` · ${Math.round(offer.load.effectiveMiles)} mi` : ''}
      </Text>
      <FacetTags load={offer.load} />
      {offer.carrierTotalAmount != null && (
        <Text style={{ color: colors.foreground, fontSize: typography.sm, fontWeight: typography.semibold, marginTop: 2 }}>
          ${offer.carrierTotalAmount.toLocaleString()}
        </Text>
      )}
      {offer.status === 'OFFERED' && (
        <View style={{ flexDirection: 'row', gap: 10, marginTop: 12 }}>
          <Pressable
            disabled={busy}
            onPress={() => void run(() => acceptOffer({ assignmentId: offer._id }))}
            style={{ flex: 1, flexDirection: 'row', justifyContent: 'center', alignItems: 'center', gap: 6, backgroundColor: colors.primary, paddingVertical: 10, borderRadius: borderRadius.md, opacity: busy ? 0.6 : 1 }}
          >
            <Ionicons name="checkmark" size={16} color={colors.primaryForeground} />
            <Text style={{ color: colors.primaryForeground, fontSize: typography.sm, fontWeight: typography.semibold }}>Accept</Text>
          </Pressable>
          <Pressable
            disabled={busy}
            onPress={confirmDecline}
            style={{ flex: 1, flexDirection: 'row', justifyContent: 'center', alignItems: 'center', gap: 6, borderWidth: 1, borderColor: colors.border, paddingVertical: 10, borderRadius: borderRadius.md, opacity: busy ? 0.6 : 1 }}
          >
            <Ionicons name="close" size={16} color={colors.destructive} />
            <Text style={{ color: colors.destructive, fontSize: typography.sm, fontWeight: typography.semibold }}>Decline</Text>
          </Pressable>
        </View>
      )}
    </Pressable>
  );
}

/** Uppercase section label, matching the list's own section headers. */
function SectionLabel({ children }: { children: string }) {
  return (
    <Text
      style={{
        color: colors.foregroundSubtle,
        fontSize: typography.xs,
        fontWeight: typography.bold,
        letterSpacing: 1,
        textTransform: 'uppercase',
        marginBottom: 8,
      }}
    >
      {children}
    </Text>
  );
}

/** One horizon tile: a count, its label, and what it means. */
function HorizonTile({
  label,
  sub,
  count,
  tone,
  selected,
  onPress,
}: {
  label: string;
  sub: string;
  count: number;
  tone: 'warn' | 'plain';
  selected: boolean;
  onPress: () => void;
}) {
  // Only colour a tile that has something in it — a lit tile on an empty
  // bucket is a false alarm every time the board is healthy.
  const lit = count > 0 && tone === 'warn';
  const fg = colors.warning;
  const bg = 'rgba(245,158,11,0.10)';
  const bd = 'rgba(245,158,11,0.32)';
  return (
    <Pressable
      onPress={onPress}
      style={{
        flexBasis: '48%',
        flexGrow: 1,
        padding: 13,
        borderRadius: borderRadius.lg,
        backgroundColor: lit ? bg : colors.card,
        borderWidth: 1,
        borderColor: selected ? colors.primary : lit ? bd : colors.borderSubtle,
      }}
    >
      <Text
        style={{
          fontSize: 26,
          lineHeight: 30,
          fontWeight: typography.bold,
          color: lit ? fg : colors.foreground,
        }}
      >
        {count}
      </Text>
      <Text
        style={{
          fontSize: typography.sm,
          fontWeight: typography.bold,
          color: colors.foreground,
          marginTop: 3,
        }}
      >
        {label}
      </Text>
      <Text style={{ fontSize: typography.xs, color: colors.foregroundSubtle, marginTop: 1 }}>
        {sub}
      </Text>
    </Pressable>
  );
}

/**
 * Route into batch planning.
 *
 * Deliberately does NOT run `suggestPlan` to show the design's clean /
 * exception counts: that query ranks every org driver — location and HOS
 * reads apiece — once per proposed run, and the Board is a reactive
 * subscription on the landing screen. The full summary renders on /plan,
 * where the plan is already loaded and the cost is paid once, on purpose.
 */
function AutoPlanCard({ unassigned, onPress }: { unassigned: number; onPress: () => void }) {
  return (
    <Pressable
      onPress={onPress}
      style={{
        marginTop: 12,
        padding: 15,
        borderRadius: borderRadius.lg,
        backgroundColor: colors.accentTint,
        borderWidth: 1,
        borderColor: colors.primary,
        flexDirection: 'row',
        alignItems: 'center',
        gap: 11,
      }}
    >
      <View
        style={{
          width: 28,
          height: 28,
          borderRadius: 999,
          backgroundColor: colors.primary,
          alignItems: 'center',
          justifyContent: 'center',
        }}
      >
        <Ionicons name="sparkles" size={15} color={colors.primaryForeground} />
      </View>
      <View style={{ flex: 1, minWidth: 0 }}>
        <Text
          style={{ fontSize: typography.md, fontWeight: typography.bold, color: colors.foreground }}
        >
          Plan the backlog
        </Text>
        <Text style={{ fontSize: typography.sm, color: colors.foregroundMuted, marginTop: 2 }}>
          {unassigned} load{unassigned === 1 ? '' : 's'} waiting on a driver
        </Text>
      </View>
      <Ionicons name="chevron-forward" size={18} color={colors.primary} />
    </Pressable>
  );
}

export default function BoardScreen() {
  const session = useDispatchSession();
  const router = useRouter();
  const rows = useQuery(api.dispatchMobile.listActiveAssignments, {});
  const offers = useQuery(api.dispatchMobile.listOffers, {});
  const capacity = useQuery(api.dispatchMobile.boardCapacity, {});
  const applyPlan = useMutation(api.dispatchMobile.applyPlan);
  const [assigning, setAssigning] = useState(false);
  const loading = rows === undefined || offers === undefined;
  const [horizon, setHorizon] = useState<Horizon | null>(null);

  // One clock for the screen, ticking every minute. Horizon membership is
  // time-dependent: a load crossing from "Today" into "Next 4h" is exactly
  // what the tiles exist to surface, and it must not wait for a data change.
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), 60_000);
    return () => clearInterval(id);
  }, []);

  // Counted over the same set the horizon sections render, so the tiles are
  // a true summary of the list rather than a second opinion on it.
  // Past-due work is excluded everywhere it would be counted or listed, so
  // the tiles, the sections and the header all describe the same population.
  const scheduled = useMemo(
    () => (rows ?? []).filter((r) => isUnassigned(r) && isActionable(nextWindow(r), now)),
    [rows, now],
  );
  const counts = useMemo(() => countByHorizon(scheduled, nextWindow, now), [scheduled, now]);

  // Picking a tile replaces the bucketed view with that one horizon, rather
  // than filtering inside it — otherwise "Next 4h" would still render a
  // "Rolling now" section above it and read as though the filter missed.
  const sections: Section[] = useMemo(() => {
    if (loading) return [];
    if (horizon) {
      const meta = horizonTiles(now).find((h) => h.k === horizon);
      const data = scheduled.filter((r) => horizonOf(nextWindow(r), now) === horizon);
      return data.length > 0
        ? [{ title: meta?.label ?? horizon, hot: horizon === 'now', assign: true, data }]
        : [];
    }
    return [
      ...(offers.length > 0
        ? [{ title: 'Offers', hot: true, offers: true, data: offers as (Row | OfferRow)[] }]
        : []),
      ...bucketsOf(rows, now),
    ];
  }, [loading, horizon, rows, offers, now, scheduled]);

  // One driver, one run, committed through the same guarded path the plan
  // sheet uses — conflicts are skipped and reported, never clobbered.
  const giveWork = async (driverId: string, assignmentIds: string[]) => {
    if (assignmentIds.length === 0) return;
    setAssigning(true);
    try {
      const res = await applyPlan({
        picks: [{ driverId: driverId as never, assignmentIds: assignmentIds as never }],
      });
      const failed = res.results.filter((r) => !r.success);
      if (failed.length > 0) {
        Alert.alert('Not assigned', failed.map((f) => `• ${f.reason ?? 'Skipped'}`).join('\n'));
      }
    } catch (e) {
      Alert.alert('Something went wrong', e instanceof Error ? e.message : 'Please try again.');
    } finally {
      setAssigning(false);
    }
  };

  return (
    <View style={{ flex: 1, backgroundColor: colors.background, paddingTop: 70 }}>
      <View style={{ paddingHorizontal: 24 }}>
        <View style={{ flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' }}>
          <Text style={{ fontSize: typography['2xl'], fontWeight: typography.bold, color: colors.foreground }}>
            Board
          </Text>
          <View style={{ flexDirection: 'row', alignItems: 'center', gap: 16 }}>
            <Pressable onPress={() => router.push('/plan')} hitSlop={10}>
              <Ionicons name="sparkles" size={22} color={colors.primary} />
            </Pressable>
            <Pressable onPress={() => router.push('/create')} hitSlop={10}>
              <Ionicons name="add-circle" size={26} color={colors.primary} />
            </Pressable>
          </View>
        </View>
        {/* Leads with the number this screen exists to drive to zero. */}
        <Text style={{ fontSize: typography.sm, color: colors.foregroundMuted, marginTop: 4 }}>
          {session?.orgName ?? ''}
          {rows
            ? scheduled.length > 0
              ? ` · ${scheduled.length} need${scheduled.length === 1 ? 's' : ''} a driver`
              : ' · all assigned'
            : ''}
          {offers && offers.length > 0 ? ` · ${offers.length} offer${offers.length === 1 ? '' : 's'}` : ''}
        </Text>
      </View>
      {loading ? (
        <ActivityIndicator color={colors.primary} style={{ marginTop: 48 }} />
      ) : rows.length === 0 && offers.length === 0 ? (
        // Only when the board is genuinely empty. Keyed off the data, not off
        // `sections`, so a horizon filter that matches nothing still renders
        // the tiles — otherwise the filter hides its own escape hatch.
        <Text style={{ color: colors.foregroundMuted, fontSize: typography.sm, textAlign: 'center', marginTop: 48, lineHeight: 20 }}>
          No loads on the board yet.{'\n'}Tap + to create one, or wait for offers and awarded loads.
        </Text>
      ) : (
        <SectionList
          sections={sections}
          keyExtractor={(r) => r._id}
          style={{ flex: 1 }}
          contentContainerStyle={{ padding: 24, paddingTop: 12 }}
          stickySectionHeadersEnabled={false}
          ListHeaderComponent={
            <View>
              <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 8 }}>
                {horizonTiles(now).map((hz) => (
                  <HorizonTile
                    key={hz.k}
                    label={hz.label}
                    sub={hz.sub}
                    count={counts[hz.k]}
                    tone={hz.k === 'now' ? 'warn' : 'plain'}
                    selected={horizon === hz.k}
                    onPress={() => setHorizon((cur) => (cur === hz.k ? null : hz.k))}
                  />
                ))}
              </View>
              {scheduled.length > 0 && (
                <AutoPlanCard unassigned={scheduled.length} onPress={() => router.push('/plan')} />
              )}

              {/* Bounded by fleet size, not backlog size — and it empties out
                  as work is assigned, which is the point of the section. */}
              {!horizon && capacity && (
                <View style={{ marginTop: 18 }}>
                  <SectionLabel>Trucks needing work</SectionLabel>
                  {capacity.openTrucks.some((t) => t.suggestions.length > 0) ? (
                    capacity.openTrucks.map((truck) => (
                      <TruckNeedCard
                        key={truck._id}
                        truck={truck}
                        busy={assigning}
                        onAssign={(run) => void giveWork(truck._id, run.assignmentIds ?? [])}
                      />
                    ))
                  ) : (
                    <AllTrucksLoadedCard backlog={scheduled.length} />
                  )}
                </View>
              )}

              {!horizon && capacity && capacity.runs.length > 0 && (
                <View style={{ marginTop: 18 }}>
                  <SectionLabel>Bundled runs</SectionLabel>
                  {capacity.runs.map((run) => (
                    <RunRow
                      key={run.key}
                      run={run}
                      onPress={() =>
                        run.loads[0]?._id
                          ? router.push({ pathname: '/load/[id]', params: { id: run.loads[0]._id } })
                          : router.push('/plan')
                      }
                    />
                  ))}
                </View>
              )}

              {horizon && (
                <Pressable onPress={() => setHorizon(null)} style={{ marginTop: 12 }}>
                  <Text
                    style={{
                      color: colors.primary,
                      fontSize: typography.sm,
                      fontWeight: typography.semibold,
                    }}
                  >
                    ← Show everything
                  </Text>
                </Pressable>
              )}
            </View>
          }
          ListEmptyComponent={
            <Text
              style={{
                color: colors.foregroundSubtle,
                fontSize: typography.base,
                textAlign: 'center',
                paddingVertical: 40,
              }}
            >
              Nothing in this horizon.
            </Text>
          }
          renderSectionHeader={({ section }) => (
            <Text style={{ color: section.hot ? colors.warning : colors.foregroundMuted, fontSize: typography.xs, fontWeight: typography.bold, letterSpacing: 1, textTransform: 'uppercase', marginTop: 14, marginBottom: 6 }}>
              {section.title} · {section.data.length}
            </Text>
          )}
          renderItem={({ item, section }) => {
            if ((section as Section).offers) {
              return <OfferCard offer={item as OfferRow} />;
            }
            const row = item as Row;
            const t = nextWindow(row);
            return (
              <Pressable
                onPress={
                  row.source === 'open'
                    ? () => router.push({ pathname: '/assign', params: { loadId: row.loadId } })
                    : row.source === 'leg'
                      ? row.load
                        ? () => router.push({ pathname: '/load/[id]', params: { id: row.load!._id } })
                        : undefined
                      : () => router.push({ pathname: '/assign', params: { assignmentId: row._id } })
                }
                onLongPress={() => Alert.alert('Load payload (debug)', JSON.stringify(row.load, null, 2))}
                style={{ backgroundColor: colors.card, borderWidth: 1, borderColor: colors.border, borderRadius: borderRadius.lg, padding: 14, marginBottom: 10 }}
              >
                <View style={{ flexDirection: 'row', justifyContent: 'space-between' }}>
                  <Text style={{ color: colors.foreground, fontWeight: typography.semibold, fontSize: typography.base }}>
                    {displayLoadId(row.load?.internalId)}
                  </Text>
                  <View style={{ flexDirection: 'row', alignItems: 'center', gap: 12 }}>
                    {row.source !== 'leg' && (
                      <Pressable onPress={() => router.push({ pathname: '/adjust', params: { assignmentId: row._id } })} hitSlop={8}>
                        <Ionicons name="time-outline" size={18} color={colors.foregroundMuted} />
                      </Pressable>
                    )}
                    <Text style={{ color: row.status === 'IN_PROGRESS' ? colors.primary : colors.warning, fontSize: typography.xs, fontWeight: typography.bold }}>
                      {row.status === 'IN_PROGRESS' ? 'In transit' : 'Awarded'}
                    </Text>
                  </View>
                </View>
                <Text style={{ color: colors.foregroundMuted, fontSize: typography.sm, marginTop: 3 }}>
                  {row.load?.customerName ?? 'Customer'} · {row.stops.length} stop{row.stops.length === 1 ? '' : 's'}
                  {t ? ` · ${fmtTime(t)}` : ''}
                </Text>
                <Text
                  style={{
                    color: row.driver ? colors.foregroundMuted : colors.warning,
                    fontSize: typography.sm,
                    fontWeight: row.driver ? typography.normal : typography.semibold,
                    marginTop: 2,
                  }}
                >
                  {row.driver ? `${row.driver.firstName} ${row.driver.lastName}` : 'Needs a driver'}
                </Text>
                <FacetTags load={row.load} />
                {/* The whole card already opens the assign sheet, but a load
                    waiting on a driver deserves a visible verb — this is the
                    one action the board exists for. Legs assign through the
                    web TMS, so the button only appears where it can work. */}
                {(section as Section).assign && row.source !== 'leg' && (
                  <Pressable
                    onPress={() =>
                      router.push(
                        row.source === 'open'
                          ? { pathname: '/assign', params: { loadId: row.loadId } }
                          : { pathname: '/assign', params: { assignmentId: row._id } },
                      )
                    }
                    style={{
                      marginTop: 12,
                      minHeight: 38,
                      borderRadius: borderRadius.md,
                      backgroundColor: colors.accentTint,
                      flexDirection: 'row',
                      alignItems: 'center',
                      justifyContent: 'center',
                      gap: 6,
                    }}
                  >
                    <Ionicons name="person-add-outline" size={15} color={colors.primary} />
                    <Text
                      style={{
                        color: colors.primary,
                        fontSize: typography.sm,
                        fontWeight: typography.bold,
                      }}
                    >
                      Assign driver
                    </Text>
                  </Pressable>
                )}
              </Pressable>
            );
          }}
        />
      )}
    </View>
  );
}
