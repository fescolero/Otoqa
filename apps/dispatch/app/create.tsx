/** New load (§5.6) — thin client over dispatchMobile.createLoad, which
 * runs the web's exact validation/creation model and self-assigns the
 * load (AWARDED) so it lands on the Board ready for a driver. Windows
 * default to today 8–10am / 1–3pm; dictation arrives with Phase 3. */
import * as React from 'react';
import { Alert, Pressable, ScrollView, Text, TextInput, View } from 'react-native';
import { useRouter } from 'expo-router';
import { useMutation, useQuery } from 'convex/react';
import { Ionicons } from '@expo/vector-icons';
import { api, type Id } from '@otoqa/convex-client';
import { borderRadius, colors, typography } from '@otoqa/mobile-core';

const iso = (h: number) => {
  const d = new Date();
  d.setHours(h, 0, 0, 0);
  return d;
};
const mkStop = (seq: number, type: 'PICKUP' | 'DELIVERY', address: string, beginH: number) => ({
  sequenceNumber: seq,
  stopType: type,
  loadingType: 'APPT' as const,
  address,
  windowBeginDate: iso(beginH).toISOString().slice(0, 10),
  windowBeginTime: iso(beginH).toISOString(),
  windowEndDate: iso(beginH + 2).toISOString().slice(0, 10),
  windowEndTime: iso(beginH + 2).toISOString(),
  commodityDescription: 'General freight',
  commodityUnits: 'Pallets' as const,
  pieces: 1,
});

export default function CreateLoadScreen() {
  const router = useRouter();
  const customers = useQuery(api.dispatchMobile.listCustomers, {});
  const create = useMutation(api.dispatchMobile.createLoad);
  const [customerId, setCustomerId] = React.useState<Id<'customers'> | null>(null);
  const [commodity, setCommodity] = React.useState('');
  const [pickup, setPickup] = React.useState('');
  const [dropoff, setDropoff] = React.useState('');
  const [busy, setBusy] = React.useState(false);
  const ready = customerId && pickup.trim() && dropoff.trim();

  const submit = async () => {
    if (!ready || busy) return;
    setBusy(true);
    try {
      const n = Date.now().toString().slice(-6);
      await create({
        internalId: `M-${n}`,
        orderNumber: `M-${n}`,
        customerId: customerId!,
        fleet: 'Main',
        units: 'Pallets',
        commodityDescription: commodity.trim() || undefined,
        stops: [mkStop(1, 'PICKUP', pickup.trim(), 8), mkStop(2, 'DELIVERY', dropoff.trim(), 13)],
      });
      router.back();
    } catch (e) {
      Alert.alert('Could not create load', e instanceof Error ? e.message : 'Try again.');
    } finally {
      setBusy(false);
    }
  };

  const field = { borderWidth: 1, borderColor: colors.border, borderRadius: borderRadius.md, backgroundColor: colors.card, paddingHorizontal: 14, minHeight: 50, color: colors.foreground, fontSize: typography.base } as const;
  return (
    <View style={{ flex: 1, backgroundColor: colors.background, paddingTop: 64 }}>
      <View style={{ flexDirection: 'row', alignItems: 'center', paddingHorizontal: 16, gap: 8 }}>
        <Pressable onPress={() => router.back()} hitSlop={12}>
          <Ionicons name="chevron-back" size={24} color={colors.foreground} />
        </Pressable>
        <Text style={{ fontSize: typography.xl, fontWeight: typography.bold, color: colors.foreground }}>New load</Text>
      </View>
      <ScrollView contentContainerStyle={{ padding: 20, gap: 14 }}>
        <Text style={s.label}>CUSTOMER</Text>
        <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 8 }}>
          {(customers ?? []).map((c) => (
            <Pressable key={c._id} onPress={() => setCustomerId(c._id)} style={{ borderWidth: 1, borderColor: customerId === c._id ? colors.primary : colors.border, backgroundColor: customerId === c._id ? colors.primary : colors.card, borderRadius: borderRadius.full ?? 20, paddingHorizontal: 14, paddingVertical: 8 }}>
              <Text style={{ color: customerId === c._id ? colors.primaryForeground : colors.foreground, fontSize: typography.sm }}>{c.name}</Text>
            </Pressable>
          ))}
          {customers?.length === 0 && (
            <Text style={{ color: colors.foregroundMuted, fontSize: typography.sm }}>
              No customers yet — add one on the web first.
            </Text>
          )}
        </View>
        <Text style={s.label}>COMMODITY</Text>
        <TextInput style={field} value={commodity} onChangeText={setCommodity} placeholder="What's on the trailer" placeholderTextColor={colors.foregroundMuted} />
        <Text style={s.label}>PICKUP · today 8–10 AM</Text>
        <TextInput style={field} value={pickup} onChangeText={setPickup} placeholder="Pickup address" placeholderTextColor={colors.foregroundMuted} />
        <Text style={s.label}>DROPOFF · today 1–3 PM</Text>
        <TextInput style={field} value={dropoff} onChangeText={setDropoff} placeholder="Dropoff address" placeholderTextColor={colors.foregroundMuted} />
        <Text style={{ color: colors.foregroundMuted, fontSize: typography.xs }}>
          Windows default to today; fine-tune them after creation with the clock icon on the Board.
        </Text>
        <Pressable disabled={!ready || busy} onPress={() => void submit()} style={{ backgroundColor: ready ? colors.primary : colors.border, borderRadius: borderRadius.md, minHeight: 52, alignItems: 'center', justifyContent: 'center', marginTop: 6 }}>
          <Text style={{ color: colors.primaryForeground, fontWeight: typography.bold, fontSize: typography.base }}>
            {busy ? 'Creating…' : 'Create & find a driver'}
          </Text>
        </Pressable>
      </ScrollView>
    </View>
  );
}
const s = { label: { color: colors.foregroundMuted, fontSize: typography.xs, fontWeight: typography.bold, letterSpacing: 1 } } as const;
