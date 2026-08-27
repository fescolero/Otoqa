/**
 * Load detail — read-only view of one load: id + status, facet chips,
 * meta (customer / equipment / miles / commodity), assigned driver
 * (tap → driver detail, call icon), and the stop timeline with window
 * times and check-in/out marks. Reached from Board leg rows and from
 * driver detail.
 */
import { ActivityIndicator, Linking, Pressable, ScrollView, Text, View } from 'react-native';
import { useLocalSearchParams, useRouter } from 'expo-router';
import { Ionicons } from '@expo/vector-icons';
import { useQuery } from 'convex/react';
import { api } from '@otoqa/convex-client';
import { borderRadius, colors, typography } from '../../lib/theme';
import { displayLoadId } from '../../lib/format';
import { loadIdentity } from '../../lib/run-identity';
import type { Id } from '@otoqa/convex-client';

const fmtWindow = (date?: string | null, begin?: string | null, end?: string | null) => {
  const fmtT = (iso?: string | null) => {
    if (!iso) return null;
    const d = new Date(iso);
    return Number.isNaN(d.getTime())
      ? iso
      : d.toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' });
  };
  const day = date
    ? new Date(`${date.slice(0, 10)}T00:00:00`).toLocaleDateString(undefined, {
        weekday: 'short',
        month: 'short',
        day: 'numeric',
      })
    : null;
  const t1 = fmtT(begin);
  const t2 = fmtT(end);
  return [day, t1 && t2 ? `${t1} – ${t2}` : (t1 ?? '')].filter(Boolean).join(' · ');
};

const fmtMark = (iso: string) => {
  const d = new Date(iso);
  return Number.isNaN(d.getTime())
    ? iso
    : d.toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' });
};

function Chip({ label }: { label: string }) {
  return (
    <View style={{ borderWidth: 1, borderColor: colors.border, borderRadius: 999, paddingHorizontal: 8, paddingVertical: 2 }}>
      <Text style={{ color: colors.foregroundMuted, fontSize: typography.xs }}>{label}</Text>
    </View>
  );
}

function MetaRow({ label, value }: { label: string; value: string }) {
  return (
    <View style={{ flexDirection: 'row', justifyContent: 'space-between', paddingVertical: 6 }}>
      <Text style={{ color: colors.foregroundMuted, fontSize: typography.sm }}>{label}</Text>
      <Text style={{ color: colors.foreground, fontSize: typography.sm, fontWeight: typography.medium, flexShrink: 1, textAlign: 'right' }}>
        {value}
      </Text>
    </View>
  );
}

export default function LoadDetailScreen() {
  const router = useRouter();
  const { id } = useLocalSearchParams<{ id: string }>();
  const load = useQuery(api.dispatchMobile.getLoadDetail, id ? { loadId: id as Id<'loadInformation'> } : 'skip');

  if (load === undefined) {
    return (
      <View style={{ flex: 1, backgroundColor: colors.background, alignItems: 'center', justifyContent: 'center' }}>
        <ActivityIndicator color={colors.primary} />
      </View>
    );
  }
  if (load === null) {
    return (
      <View style={{ flex: 1, backgroundColor: colors.background, alignItems: 'center', justifyContent: 'center', padding: 32 }}>
        <Ionicons name="cube-outline" size={40} color={colors.foregroundMuted} />
        <Text style={{ color: colors.foregroundMuted, fontSize: typography.sm, marginTop: 10 }}>Load not found.</Text>
        <Pressable onPress={() => router.back()} style={{ marginTop: 16 }}>
          <Text style={{ color: colors.primary, fontSize: typography.sm, fontWeight: typography.semibold }}>Go back</Text>
        </Pressable>
      </View>
    );
  }

  const rolling = load.legStatus === 'ACTIVE' || load.trackingStatus === 'In Transit';
  const title = loadIdentity(load);
  const loadNumber = displayLoadId(load.internalId);

  return (
    <View style={{ flex: 1, backgroundColor: colors.background, paddingTop: 64 }}>
      <View style={{ flexDirection: 'row', alignItems: 'center', paddingHorizontal: 16, gap: 8 }}>
        <Pressable onPress={() => router.back()} hitSlop={12}>
          <Ionicons name="chevron-back" size={24} color={colors.foreground} />
        </Pressable>
        {/* Titled the way you got here from: a card reading "HCR 945L4 ·
            Trip 27" must not land on a screen headed "120065381". The number
            keeps a home directly beneath, unless it IS the title because the
            load carries no contract facets. */}
        <View style={{ flex: 1, minWidth: 0 }}>
          <Text
            numberOfLines={1}
            style={{ fontSize: typography.xl, fontWeight: typography.bold, color: colors.foreground }}
          >
            {title}
          </Text>
          {title !== loadNumber && (
            <Text style={{ fontSize: typography.sm, color: colors.foregroundSubtle, marginTop: 1 }}>
              {loadNumber}
            </Text>
          )}
        </View>
        <Text style={{ color: rolling ? colors.primary : colors.foregroundMuted, fontSize: typography.xs, fontWeight: typography.bold }}>
          {rolling ? 'In transit' : (load.trackingStatus ?? load.status)}
        </Text>
      </View>

      <ScrollView contentContainerStyle={{ padding: 20, paddingBottom: 48 }}>
        {load.externalSource ? (
          <View style={{ flexDirection: 'row', gap: 6, flexWrap: 'wrap', marginBottom: 14 }}>
            <Chip label={load.externalSource} />
          </View>
        ) : null}

        <View style={{ backgroundColor: colors.card, borderWidth: 1, borderColor: colors.border, borderRadius: borderRadius.lg, paddingHorizontal: 14, paddingVertical: 8, marginBottom: 12 }}>
          {load.customerName ? <MetaRow label="Customer" value={load.customerName} /> : null}
          {load.equipmentType ? <MetaRow label="Equipment" value={load.equipmentType} /> : null}
          {load.effectiveMiles ? <MetaRow label="Miles" value={`${Math.round(load.effectiveMiles)}`} /> : null}
          {load.weight ? <MetaRow label="Weight" value={`${load.weight.toLocaleString()} lb`} /> : null}
          {load.commodityDescription ? <MetaRow label="Commodity" value={load.commodityDescription} /> : null}
        </View>

        {load.driver && (
          <Pressable
            onPress={() => router.push({ pathname: '/driver/[id]', params: { id: load.driver!._id } })}
            style={{ flexDirection: 'row', alignItems: 'center', gap: 10, backgroundColor: colors.card, borderWidth: 1, borderColor: colors.border, borderRadius: borderRadius.lg, padding: 14, marginBottom: 12 }}
          >
            <Ionicons name="person-circle-outline" size={22} color={colors.primary} />
            <Text style={{ flex: 1, color: colors.foreground, fontSize: typography.sm, fontWeight: typography.semibold }}>
              {load.driver.firstName} {load.driver.lastName}
            </Text>
            {load.driver.phone ? (
              <Pressable onPress={() => void Linking.openURL(`tel:${load.driver!.phone}`)} hitSlop={10}>
                <Ionicons name="call-outline" size={20} color={colors.primary} />
              </Pressable>
            ) : null}
            <Ionicons name="chevron-forward" size={16} color={colors.foregroundMuted} />
          </Pressable>
        )}

        <Text style={{ color: colors.foregroundMuted, fontSize: typography.xs, fontWeight: typography.bold, letterSpacing: 1, textTransform: 'uppercase', marginBottom: 8 }}>
          Stops · {load.stops.length}
        </Text>
        {load.stops.map((s, i) => {
          const done = !!s.checkedOutAt;
          const here = !!s.checkedInAt && !s.checkedOutAt;
          return (
            <View key={s._id} style={{ flexDirection: 'row', gap: 12 }}>
              <View style={{ alignItems: 'center', width: 14 }}>
                <View
                  style={{
                    width: 12,
                    height: 12,
                    borderRadius: 6,
                    marginTop: 4,
                    backgroundColor: done ? colors.primary : here ? colors.warning : colors.card,
                    borderWidth: done || here ? 0 : 2,
                    borderColor: colors.border,
                  }}
                />
                {i < load.stops.length - 1 && (
                  <View style={{ flex: 1, width: 2, backgroundColor: colors.border, marginVertical: 2 }} />
                )}
              </View>
              <View style={{ flex: 1, paddingBottom: 18 }}>
                <Text style={{ color: colors.foregroundMuted, fontSize: typography.xs, fontWeight: typography.bold }}>
                  {s.stopType === 'PICKUP' ? 'Pickup' : s.stopType === 'DELIVERY' ? 'Delivery' : 'Detour'} · stop {s.sequenceNumber}
                </Text>
                <Text style={{ color: colors.foreground, fontSize: typography.sm, fontWeight: typography.medium, marginTop: 2 }}>
                  {s.address}
                  {s.city ? `, ${s.city}` : ''}
                  {s.state ? `, ${s.state}` : ''}
                </Text>
                {(s.windowBeginDate || s.windowBeginTime) && (
                  <Text style={{ color: colors.foregroundMuted, fontSize: typography.xs, marginTop: 2 }}>
                    {fmtWindow(s.windowBeginDate, s.windowBeginTime, s.windowEndTime)}
                  </Text>
                )}
                {s.checkedInAt && (
                  <Text style={{ color: done ? colors.primary : colors.warning, fontSize: typography.xs, marginTop: 3 }}>
                    In {fmtMark(s.checkedInAt)}
                    {s.checkedOutAt ? ` · Out ${fmtMark(s.checkedOutAt)}` : ' · on site'}
                  </Text>
                )}
              </View>
            </View>
          );
        })}
      </ScrollView>
    </View>
  );
}
