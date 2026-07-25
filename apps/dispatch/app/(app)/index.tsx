/** Board — live assignments bucketed by horizon (v8 design): what's
 * rolling now, then AWARDED work by urgency of its next window —
 * Next 4 hours / Today / Later / Unscheduled. The backlog is never one
 * flat list. Buckets compute client-side from the stops the read
 * wrapper already returns. */
import { ActivityIndicator, Pressable, SectionList, Text, View } from 'react-native';
import { useRouter } from 'expo-router';
import { Ionicons } from '@expo/vector-icons';
import { useQuery } from 'convex/react';
import { api } from '@otoqa/convex-client';
import { borderRadius, colors, typography } from '@otoqa/mobile-core';
import { useDispatchSession } from './_layout';

type Row = NonNullable<ReturnType<typeof useQuery<typeof api.dispatchMobile.listActiveAssignments>>>[number];

/** Earliest window of a not-yet-checked-in stop — the load's "next action" time. */
function nextWindow(r: Row): number | null {
  const t = r.stops
    .filter((s) => !s.checkedInAt && s.windowBeginTime)
    .map((s) => Date.parse(s.windowBeginTime!))
    .filter(Number.isFinite)
    .sort((a, b) => a - b)[0];
  return t ?? null;
}

function bucketsOf(rows: Row[]) {
  const now = Date.now();
  const in4h = now + 4 * 3600_000;
  const endOfDay = new Date().setHours(23, 59, 59, 999);
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

export default function BoardScreen() {
  const session = useDispatchSession();
  const router = useRouter();
  const rows = useQuery(api.dispatchMobile.listActiveAssignments, {});
  const sections = rows ? bucketsOf(rows) : [];

  return (
    <View style={{ flex: 1, backgroundColor: colors.background, paddingTop: 70 }}>
      <View style={{ paddingHorizontal: 24 }}>
        <View style={{ flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' }}>
          <Text style={{ fontSize: typography['2xl'], fontWeight: typography.bold, color: colors.foreground }}>
            Board
          </Text>
          <Pressable onPress={() => router.push('/create')} hitSlop={10}>
            <Ionicons name="add-circle" size={26} color={colors.primary} />
          </Pressable>
        </View>
        <Text style={{ fontSize: typography.sm, color: colors.foregroundMuted, marginTop: 4 }}>
          {session?.orgName ?? ''}
          {rows ? ` · ${rows.length} active` : ''}
        </Text>
      </View>
      {rows === undefined ? (
        <ActivityIndicator color={colors.primary} style={{ marginTop: 48 }} />
      ) : rows.length === 0 ? (
        <Text style={{ color: colors.foregroundMuted, fontSize: typography.sm, textAlign: 'center', marginTop: 48, lineHeight: 20 }}>
          No loads on the board yet.{'\n'}Tap + to create one, or wait for awarded loads.
        </Text>
      ) : (
        <SectionList
          sections={sections}
          keyExtractor={(r) => r._id}
          contentContainerStyle={{ padding: 24, paddingTop: 12 }}
          stickySectionHeadersEnabled={false}
          renderSectionHeader={({ section }) => (
            <Text style={{ color: section.hot ? colors.warning : colors.foregroundMuted, fontSize: typography.xs, fontWeight: typography.bold, letterSpacing: 1, textTransform: 'uppercase', marginTop: 14, marginBottom: 6 }}>
              {section.title} · {section.data.length}
            </Text>
          )}
          renderItem={({ item }) => {
            const t = nextWindow(item);
            return (
              <Pressable
                onPress={() => router.push({ pathname: '/assign', params: { assignmentId: item._id } })}
                style={{ backgroundColor: colors.card, borderWidth: 1, borderColor: colors.border, borderRadius: borderRadius.lg, padding: 14, marginBottom: 10 }}
              >
                <View style={{ flexDirection: 'row', justifyContent: 'space-between' }}>
                  <Text style={{ color: colors.foreground, fontWeight: typography.semibold, fontSize: typography.base }}>
                    #{item.load?.internalId ?? '—'}
                  </Text>
                  <View style={{ flexDirection: 'row', alignItems: 'center', gap: 12 }}>
                    <Pressable onPress={() => router.push({ pathname: '/adjust', params: { assignmentId: item._id } })} hitSlop={8}>
                      <Ionicons name="time-outline" size={18} color={colors.foregroundMuted} />
                    </Pressable>
                    <Text style={{ color: item.status === 'IN_PROGRESS' ? colors.primary : colors.warning, fontSize: typography.xs, fontWeight: typography.bold }}>
                      {item.status === 'IN_PROGRESS' ? 'In transit' : 'Awarded'}
                    </Text>
                  </View>
                </View>
                <Text style={{ color: colors.foregroundMuted, fontSize: typography.sm, marginTop: 3 }}>
                  {item.load?.customerName ?? 'Customer'} · {item.stops.length} stop{item.stops.length === 1 ? '' : 's'}
                  {t ? ` · ${new Date(t).toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' })}` : ''}
                </Text>
                <Text style={{ color: colors.foregroundMuted, fontSize: typography.sm, marginTop: 2 }}>
                  {item.driver ? `${item.driver.firstName} ${item.driver.lastName}` : 'No driver assigned'}
                </Text>
              </Pressable>
            );
          }}
        />
      )}
    </View>
  );
}
