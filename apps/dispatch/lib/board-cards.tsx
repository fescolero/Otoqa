/**
 * Capacity-first Board cards (design `lib-dispatch/capacity.jsx`).
 *
 * Split out of the Board screen because these are the two heaviest pieces of
 * that layout — an open truck with its best-fit work, and a bundled run.
 * They take plain values rather than Convex documents so the shapes stay
 * obvious at the call site.
 */
import { useState } from 'react';
import { Pressable, Text, View } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { borderRadius, colors, typography } from './theme';
import { AvatarWithStatus, hasHosSignal, HosBar, type HosLike } from './ui';

const time = (ms: number) =>
  new Date(ms).toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' });

export interface RunLike {
  key: string;
  /** Present on truck suggestions — what `applyPlan` commits. */
  assignmentIds?: string[];
  loadCount: number;
  from: string | null;
  to: string | null;
  via: string[];
  startT: number;
  loadedMiles: number;
  customerName: string | null;
  deadheadMi?: number | null;
}

/**
 * A run's shape, honestly: endpoints get the line, intermediate stops drop
 * to a secondary "via" row. Putting the whole chain on one phone-width row
 * ellipsizes every name into uselessness.
 */
export function RunRoute({ run, size }: { run: RunLike; size?: number }) {
  const fontSize = size ?? typography.base;
  const roundTrip = !!run.from && run.from === run.to;
  return (
    <View style={{ minWidth: 0 }}>
      {roundTrip ? (
        <Text numberOfLines={1} style={{ fontSize, fontWeight: typography.bold, color: colors.foreground }}>
          {run.from} round trip
        </Text>
      ) : (
        <View style={{ flexDirection: 'row', alignItems: 'center', gap: 6, minWidth: 0 }}>
          <Text
            numberOfLines={1}
            style={{ fontSize, fontWeight: typography.bold, color: colors.foreground, flexShrink: 0 }}
          >
            {run.from ?? '—'}
          </Text>
          <Ionicons name="arrow-forward" size={12} color={colors.foregroundSubtle} />
          <Text
            numberOfLines={1}
            style={{
              fontSize,
              fontWeight: typography.bold,
              color: colors.foregroundMuted,
              flexShrink: 1,
            }}
          >
            {run.to ?? '—'}
          </Text>
        </View>
      )}
      {run.via.length > 0 && (
        <Text
          numberOfLines={1}
          style={{ fontSize: typography.xs, color: colors.foregroundSubtle, marginTop: 2 }}
        >
          via {run.via.join(', ')}
        </Text>
      )}
    </View>
  );
}

function Chip({ children, tone = 'plain' }: { children: string; tone?: 'plain' | 'good' | 'warn' | 'bad' | 'accent' }) {
  const map = {
    plain: { bg: colors.muted, fg: colors.foregroundMuted },
    good: { bg: 'rgba(16,185,129,0.12)', fg: colors.success },
    warn: { bg: 'rgba(245,158,11,0.14)', fg: colors.warning },
    bad: { bg: 'rgba(239,68,68,0.14)', fg: colors.error },
    accent: { bg: colors.accentTint, fg: colors.primary },
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
      <Text style={{ color: t.fg, fontSize: typography.xs, fontWeight: typography.semibold }}>
        {children}
      </Text>
    </View>
  );
}

/** Facts about one piece of work: how far out, how long, what's chained. */
function WorkChips({ run }: { run: RunLike }) {
  const dh = run.deadheadMi;
  return (
    <View style={{ flexDirection: 'row', gap: 5, flexWrap: 'wrap', alignItems: 'center' }}>
      {run.loadCount > 1 && <Chip tone="accent">{`${run.loadCount}-load run`}</Chip>}
      {dh != null && (
        <Chip tone={dh < 15 ? 'good' : dh > 45 ? 'warn' : 'plain'}>
          {dh < 3 ? 'At pickup' : `${dh} mi out`}
        </Chip>
      )}
      {run.loadedMiles > 0 && <Chip>{`${Math.round(run.loadedMiles)} mi`}</Chip>}
    </View>
  );
}

function WorkLine({ run }: { run: RunLike }) {
  return (
    <View style={{ minWidth: 0 }}>
      <RunRoute run={run} />
      <Text style={{ fontSize: typography.sm, color: colors.foregroundSubtle, marginTop: 2 }}>
        {time(run.startT)}
        {run.customerName ? ` · ${run.customerName}` : ''}
      </Text>
    </View>
  );
}

export interface OpenTruck {
  _id: string;
  firstName: string;
  lastName: string;
  truckUnitId: string | null;
  hos: HosLike;
  warns: string[];
  suggestions: RunLike[];
}

/**
 * One open truck and its best three pieces of work, assignable in place.
 *
 * Renders nothing when there is no work to offer — an "open truck" card with
 * an empty body is just noise on a board whose whole point is bounded work.
 */
export function TruckNeedCard({
  truck,
  busy,
  onAssign,
}: {
  truck: OpenTruck;
  busy: boolean;
  onAssign: (run: RunLike) => void;
}) {
  const [expanded, setExpanded] = useState(false);
  if (truck.suggestions.length === 0) return null;

  const best = truck.suggestions[0];
  const others = truck.suggestions.slice(1);

  return (
    <View
      style={{
        backgroundColor: colors.card,
        borderWidth: 1,
        borderColor: colors.borderSubtle,
        borderRadius: borderRadius.lg,
        padding: 13,
        marginBottom: 10,
      }}
    >
      <View style={{ flexDirection: 'row', alignItems: 'center', gap: 11 }}>
        <AvatarWithStatus
          id={truck._id}
          first={truck.firstName}
          last={truck.lastName}
          status="idle"
          size={38}
        />
        <View style={{ flex: 1, minWidth: 0 }}>
          <Text
            numberOfLines={1}
            style={{ fontSize: typography.md, fontWeight: typography.bold, color: colors.foreground }}
          >
            {truck.firstName} {truck.lastName}
          </Text>
          <Text style={{ fontSize: typography.sm, color: colors.foregroundSubtle, marginTop: 2 }}>
            {truck.truckUnitId ? `Truck ${truck.truckUnitId} · ` : ''}empty now
          </Text>
        </View>
        {hasHosSignal(truck.hos) && <HosBar hos={truck.hos} width={28} />}
      </View>

      <View
        style={{
          marginTop: 11,
          padding: 11,
          borderRadius: borderRadius.lg,
          backgroundColor: colors.accentTint,
          borderWidth: 1,
          borderColor: colors.primary,
        }}
      >
        <View style={{ flexDirection: 'row', alignItems: 'center', gap: 7, marginBottom: 7 }}>
          <Ionicons name="sparkles" size={13} color={colors.primary} />
          <Text
            style={{
              fontSize: typography.xs,
              fontWeight: typography.bold,
              letterSpacing: 0.7,
              textTransform: 'uppercase',
              color: colors.primary,
            }}
          >
            Best fit
          </Text>
        </View>
        <WorkLine run={best} />
        <View style={{ marginTop: 8 }}>
          <WorkChips run={best} />
        </View>
        {truck.warns.length > 0 && (
          <View style={{ marginTop: 8 }}>
            <Chip tone="bad">{truck.warns[0]}</Chip>
          </View>
        )}
        <Pressable
          disabled={busy}
          onPress={() => onAssign(best)}
          style={{
            marginTop: 10,
            minHeight: 42,
            borderRadius: borderRadius.md,
            backgroundColor: colors.primary,
            flexDirection: 'row',
            alignItems: 'center',
            justifyContent: 'center',
            gap: 7,
            opacity: busy ? 0.6 : 1,
          }}
        >
          <Ionicons name="checkmark" size={16} color={colors.primaryForeground} />
          <Text
            style={{
              color: colors.primaryForeground,
              fontSize: typography.base,
              fontWeight: typography.bold,
            }}
          >
            Give it to {truck.lastName}
          </Text>
        </Pressable>
      </View>

      {others.length > 0 && (
        <Pressable
          onPress={() => setExpanded((e) => !e)}
          style={{
            marginTop: 9,
            minHeight: 34,
            flexDirection: 'row',
            alignItems: 'center',
            justifyContent: 'center',
            gap: 6,
          }}
        >
          <Text
            style={{
              fontSize: typography.sm,
              fontWeight: typography.semibold,
              color: colors.foregroundMuted,
            }}
          >
            {expanded ? 'Hide' : `${others.length} other option${others.length > 1 ? 's' : ''}`}
          </Text>
          <Ionicons
            name={expanded ? 'chevron-up' : 'chevron-down'}
            size={14}
            color={colors.foregroundMuted}
          />
        </Pressable>
      )}

      {expanded &&
        others.map((run) => (
          <View
            key={run.key}
            style={{
              flexDirection: 'row',
              alignItems: 'center',
              gap: 10,
              padding: 11,
              borderRadius: borderRadius.md,
              backgroundColor: colors.muted,
              marginTop: 7,
            }}
          >
            <View style={{ flex: 1, minWidth: 0 }}>
              <WorkLine run={run} />
              <View style={{ marginTop: 6 }}>
                <WorkChips run={run} />
              </View>
            </View>
            <Pressable
              disabled={busy}
              onPress={() => onAssign(run)}
              style={{
                minHeight: 40,
                paddingHorizontal: 12,
                borderRadius: borderRadius.md,
                backgroundColor: colors.card,
                borderWidth: 1,
                borderColor: colors.border,
                justifyContent: 'center',
                opacity: busy ? 0.6 : 1,
              }}
            >
              <Text
                style={{
                  fontSize: typography.sm,
                  fontWeight: typography.bold,
                  color: colors.foreground,
                }}
              >
                Assign
              </Text>
            </Pressable>
          </View>
        ))}
    </View>
  );
}

/** Every truck has work — the section's success state, not an empty list. */
export function AllTrucksLoadedCard({ backlog }: { backlog: number }) {
  return (
    <View
      style={{
        borderRadius: borderRadius.lg,
        borderWidth: 1,
        borderColor: 'rgba(16,185,129,0.30)',
        backgroundColor: 'rgba(16,185,129,0.08)',
        padding: 14,
        flexDirection: 'row',
        gap: 11,
        alignItems: 'center',
      }}
    >
      <View
        style={{
          width: 30,
          height: 30,
          borderRadius: 999,
          backgroundColor: colors.success,
          alignItems: 'center',
          justifyContent: 'center',
        }}
      >
        <Ionicons name="checkmark" size={17} color="#fff" />
      </View>
      <View style={{ flex: 1, minWidth: 0 }}>
        <Text style={{ fontSize: typography.base, fontWeight: typography.bold, color: colors.foreground }}>
          Every truck is loaded
        </Text>
        <Text style={{ fontSize: typography.sm, color: colors.foregroundMuted, marginTop: 2, lineHeight: 17 }}>
          {backlog > 0
            ? `${backlog} load${backlog === 1 ? '' : 's'} stay in the backlog until capacity frees up.`
            : 'Nothing waiting in the backlog either.'}
        </Text>
      </View>
    </View>
  );
}

/** One bundled run in the list — chained loads, assignable as a unit. */
export function RunRow({ run, onPress }: { run: RunLike; onPress: () => void }) {
  return (
    <Pressable
      onPress={onPress}
      style={{
        flexDirection: 'row',
        alignItems: 'center',
        gap: 11,
        padding: 12,
        borderRadius: borderRadius.lg,
        backgroundColor: colors.card,
        borderWidth: 1,
        borderColor: colors.borderSubtle,
        marginBottom: 8,
      }}
    >
      <View
        style={{
          width: 32,
          height: 32,
          borderRadius: borderRadius.md,
          backgroundColor: colors.accentTint,
          alignItems: 'center',
          justifyContent: 'center',
        }}
      >
        <Text style={{ color: colors.primary, fontSize: typography.sm, fontWeight: typography.bold }}>
          {run.loadCount}
        </Text>
      </View>
      <View style={{ flex: 1, minWidth: 0 }}>
        <RunRoute run={run} />
        <Text style={{ fontSize: typography.sm, color: colors.foregroundSubtle, marginTop: 2 }}>
          {time(run.startT)}
          {run.loadedMiles > 0 ? ` · ${Math.round(run.loadedMiles)} mi` : ''}
        </Text>
      </View>
      <Ionicons name="chevron-forward" size={16} color={colors.foregroundSubtle} />
    </Pressable>
  );
}
