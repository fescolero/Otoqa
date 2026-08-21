/**
 * Drivers — the fleet list from the v8 design (`lib-dispatch/drivers.jsx`).
 *
 * The dispatcher's question here is "who can take this?", so every row
 * answers it without a tap: who they are, whether they're rolling, what
 * they're running, and how much service time is left. Search and the filter
 * row exist because a 25-truck fleet doesn't fit on a phone screen.
 *
 * Everything rendered is server-derived (dispatchMobile.listDrivers) — the
 * status in particular is a checkable condition, not a client guess.
 */
import { useMemo, useState } from 'react';
import { ActivityIndicator, FlatList, Pressable, Text, View } from 'react-native';
import { useRouter } from 'expo-router';
import { Ionicons } from '@expo/vector-icons';
import { useQuery } from 'convex/react';
import { api } from '@otoqa/convex-client';
import { borderRadius, colors, typography } from '../../lib/theme';
import {
  AvatarWithStatus,
  HosBar,
  SearchField,
  SegRow,
  StatusPill,
  type DriverStatus,
} from '../../lib/ui';

type Row = NonNullable<ReturnType<typeof useQuery<typeof api.dispatchMobile.listDrivers>>>[number];

type Filter = 'all' | 'idle' | 'moving' | 'attention';

/** "Off plan" folds late and offline together — both mean "look at this one". */
const matchesFilter = (status: DriverStatus, f: Filter) =>
  f === 'all' ||
  (f === 'attention' ? status === 'late' || status === 'offline' : status === f);

function DriverRow({ row, onPress }: { row: Row; onPress: () => void }) {
  const status = row.status as DriverStatus;
  const route = row.route;
  return (
    <Pressable
      onPress={onPress}
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
      <AvatarWithStatus
        id={row._id}
        first={row.firstName}
        last={row.lastName}
        status={status}
        size={40}
      />
      <View style={{ flex: 1, minWidth: 0, gap: 4 }}>
        <View style={{ flexDirection: 'row', alignItems: 'center', gap: 7 }}>
          <Text
            numberOfLines={1}
            style={{
              flexShrink: 1,
              fontSize: typography.md,
              fontWeight: typography.semibold,
              color: colors.foreground,
            }}
          >
            {row.firstName} {row.lastName}
          </Text>
          {row.truckUnitId ? (
            <Text
              style={{
                fontSize: typography.xs,
                fontWeight: typography.bold,
                color: colors.foregroundSubtle,
              }}
            >
              {row.truckUnitId}
            </Text>
          ) : null}
        </View>

        {/* The route only exists while work is running; idle drivers get the
            honest fallback rather than a fabricated location. */}
        <Text numberOfLines={1} style={{ fontSize: typography.sm, color: colors.foregroundSubtle }}>
          {route?.from || route?.to
            ? `${route.from ?? '—'} → ${route.to ?? '—'}`
            : status === 'idle'
              ? 'No load assigned'
              : status === 'offline'
                ? 'No recent GPS fix'
                : 'Load details unavailable'}
        </Text>

        <View style={{ flexDirection: 'row', alignItems: 'center', gap: 6, flexWrap: 'wrap' }}>
          <HosBar
            onShift={row.hos.onShift}
            windowRemainingHours={row.hos.windowRemainingHours}
            cycleRemainingHours={row.hos.cycleRemainingHours}
          />
          <Text style={{ fontSize: typography.xs, color: colors.foregroundSubtle }}>
            · {row.loadsToday} today
          </Text>
        </View>
      </View>
      <StatusPill status={status} />
    </Pressable>
  );
}

export default function DriversScreen() {
  const rows = useQuery(api.dispatchMobile.listDrivers, {});
  const router = useRouter();
  const [filter, setFilter] = useState<Filter>('all');
  const [q, setQ] = useState('');

  const counts = useMemo(() => {
    const base = { all: 0, idle: 0, moving: 0, attention: 0 };
    if (!rows) return base;
    base.all = rows.length;
    for (const r of rows) {
      const s = r.status as DriverStatus;
      if (s === 'idle') base.idle++;
      else if (s === 'moving') base.moving++;
      else base.attention++;
    }
    return base;
  }, [rows]);

  const list = useMemo(() => {
    if (!rows) return [];
    const needle = q.trim().toLowerCase();
    return rows.filter((r) => {
      if (!matchesFilter(r.status as DriverStatus, filter)) return false;
      if (!needle) return true;
      const hay = `${r.firstName ?? ''} ${r.lastName ?? ''} ${r.truckUnitId ?? ''} ${r.phone ?? ''}`;
      return hay.toLowerCase().includes(needle);
    });
  }, [rows, filter, q]);

  return (
    <View style={{ flex: 1, backgroundColor: colors.background, paddingTop: 70 }}>
      <View style={{ paddingHorizontal: 24 }}>
        <View style={{ flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' }}>
          <Text
            style={{
              fontSize: typography['2xl'],
              fontWeight: typography.bold,
              color: colors.foreground,
            }}
          >
            Drivers
          </Text>
          <Pressable onPress={() => router.push('/map')} hitSlop={10}>
            <Ionicons name="map-outline" size={22} color={colors.primary} />
          </Pressable>
        </View>
        {rows && (
          <Text style={{ fontSize: typography.sm, color: colors.foregroundSubtle, marginTop: 4 }}>
            {counts.idle} available · {counts.moving} rolling · {counts.attention} need attention
          </Text>
        )}
      </View>

      {rows === undefined ? (
        <ActivityIndicator color={colors.primary} style={{ marginTop: 48 }} />
      ) : rows.length === 0 ? (
        <Text
          style={{
            color: colors.foregroundMuted,
            fontSize: typography.sm,
            textAlign: 'center',
            marginTop: 48,
            lineHeight: 20,
          }}
        >
          No drivers yet.{'\n'}Drivers added to your organization appear here.
        </Text>
      ) : (
        <>
          <View style={{ paddingHorizontal: 24, paddingTop: 14, paddingBottom: 10 }}>
            <SearchField
              value={q}
              onChangeText={setQ}
              placeholder={`Search ${rows.length} driver${rows.length === 1 ? '' : 's'}`}
            />
          </View>
          <SegRow
            value={filter}
            onChange={setFilter}
            counts={counts}
            items={[
              { k: 'all', label: 'All' },
              { k: 'idle', label: 'Available' },
              { k: 'moving', label: 'Rolling' },
              { k: 'attention', label: 'Off plan' },
            ]}
          />
          <FlatList
            data={list}
            keyExtractor={(r) => r._id}
            contentContainerStyle={{ padding: 24, paddingTop: 14, gap: 10 }}
            keyboardShouldPersistTaps="handled"
            renderItem={({ item }) => (
              <DriverRow
                row={item}
                onPress={() =>
                  router.push({ pathname: '/driver/[id]', params: { id: item._id } })
                }
              />
            )}
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
          />
        </>
      )}
    </View>
  );
}
