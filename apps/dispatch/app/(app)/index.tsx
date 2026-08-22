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
import { countByHorizon, horizonOf, HORIZONS, type Horizon } from '../../lib/board';
import { useDispatchSession } from './_layout';

type Row = NonNullable<ReturnType<typeof useQuery<typeof api.dispatchMobile.listActiveAssignments>>>[number];
type OfferRow = NonNullable<ReturnType<typeof useQuery<typeof api.dispatchMobile.listOffers>>>[number];

type Section = { title: string; hot: boolean; offers?: boolean; data: (Row | OfferRow)[] };

/** Earliest window of a not-yet-checked-in stop — the load's "next action" time. */
function nextWindow(r: Row | OfferRow): number | null {
  const t = r.stops
    .filter((s) => !s.checkedInAt && s.windowBeginTime)
    .map((s) => Date.parse(s.windowBeginTime!))
    .filter(Number.isFinite)
    .sort((a, b) => a - b)[0];
  return t ?? null;
}

function bucketsOf(rows: Row[], now: number): Section[] {
  const in4h = now + 4 * 3600_000;
  const endOfDay = new Date(now).setHours(23, 59, 59, 999);
  const rolling = rows.filter((r) => r.status === 'IN_PROGRESS');
  const awarded = rows.filter((r) => r.status === 'AWARDED');
  const withT = awarded.map((r) => ({ r, t: nextWindow(r) }));
  const pick = (f: (t: number | null) => boolean) =>
    withT.filter(({ t }) => f(t)).map(({ r }) => r).sort((a, b) => (nextWindow(a) ?? 0) - (nextWindow(b) ?? 0));
  return [
    { title: 'Rolling now', hot: false, data: rolling },
    { title: 'Next 4 hours', hot: true, data: pick((t) => t != null && t <= in4h) },
    { title: 'Today', hot: false, data: pick((t) => t != null && t > in4h && t <= endOfDay) },
    { title: 'Later', hot: false, data: pick((t) => t != null && t > endOfDay) },
    { title: 'Unscheduled', hot: false, data: pick((t) => t == null) },
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

/** One horizon tile: a count, its label, and what it means. */
function HorizonTile({
  label,
  sub,
  count,
  hot,
  selected,
  onPress,
}: {
  label: string;
  sub: string;
  count: number;
  hot: boolean;
  selected: boolean;
  onPress: () => void;
}) {
  const accent = hot && count > 0;
  return (
    <Pressable
      onPress={onPress}
      style={{
        flexBasis: '48%',
        flexGrow: 1,
        padding: 13,
        borderRadius: borderRadius.lg,
        backgroundColor: accent ? 'rgba(245,158,11,0.10)' : colors.card,
        borderWidth: 1,
        borderColor: selected
          ? colors.primary
          : accent
            ? 'rgba(245,158,11,0.32)'
            : colors.borderSubtle,
      }}
    >
      <Text
        style={{
          fontSize: 26,
          lineHeight: 30,
          fontWeight: typography.bold,
          color: accent ? colors.warning : colors.foreground,
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

  const counts = useMemo(() => countByHorizon(rows ?? [], nextWindow, now), [rows, now]);
  const unassigned = useMemo(
    () => (rows ?? []).filter((r) => r.status === 'AWARDED' && !r.driver).length,
    [rows],
  );

  // Picking a tile replaces the bucketed view with that one horizon, rather
  // than filtering inside it — otherwise "Next 4h" would still render a
  // "Rolling now" section above it and read as though the filter missed.
  const sections: Section[] = useMemo(() => {
    if (loading) return [];
    if (horizon) {
      const meta = HORIZONS.find((h) => h.k === horizon);
      const data = rows.filter((r) => horizonOf(nextWindow(r), now) === horizon);
      return data.length > 0
        ? [{ title: meta?.label ?? horizon, hot: horizon === 'now', data }]
        : [];
    }
    return [
      ...(offers.length > 0
        ? [{ title: 'Offers', hot: true, offers: true, data: offers as (Row | OfferRow)[] }]
        : []),
      ...bucketsOf(rows, now),
    ];
  }, [loading, horizon, rows, offers, now]);

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
        <Text style={{ fontSize: typography.sm, color: colors.foregroundMuted, marginTop: 4 }}>
          {session?.orgName ?? ''}
          {rows ? ` · ${rows.length} active` : ''}
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
                {HORIZONS.map((hz) => (
                  <HorizonTile
                    key={hz.k}
                    label={hz.label}
                    sub={hz.sub}
                    count={counts[hz.k]}
                    hot={hz.k === 'now'}
                    selected={horizon === hz.k}
                    onPress={() => setHorizon((cur) => (cur === hz.k ? null : hz.k))}
                  />
                ))}
              </View>
              {unassigned > 0 && (
                <AutoPlanCard unassigned={unassigned} onPress={() => router.push('/plan')} />
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
                  row.source === 'leg'
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
                <Text style={{ color: colors.foregroundMuted, fontSize: typography.sm, marginTop: 2 }}>
                  {row.driver ? `${row.driver.firstName} ${row.driver.lastName}` : 'No driver assigned'}
                </Text>
                <FacetTags load={row.load} />
              </Pressable>
            );
          }}
        />
      )}
    </View>
  );
}
