/** New load (§5.6) — thin client over dispatchMobile.createLoad, which
 * runs the web's exact validation/creation model and self-assigns the
 * load (AWARDED) so it lands on the Board ready for a driver.
 *
 * Dictation (Phase 3): the mic in the header records one clip →
 * convex/voice.transcribeLoadDraft (Nova-3 with customer keyterms +
 * numerals, Haiku extraction) → the form PRE-FILLS for review. Nothing
 * commits from speech — the dispatcher edits and submits as usual.
 * Windows default to today 8–10am / 1–3pm unless dictated. */
import * as React from 'react';
import { Alert, Pressable, ScrollView, Text, TextInput, View } from 'react-native';
import { useRouter } from 'expo-router';
import { useAction, useMutation, useQuery } from 'convex/react';
import { Ionicons } from '@expo/vector-icons';
import { api, type Id } from '@otoqa/convex-client';
import { borderRadius, colors, typography } from '../lib/theme';
import { useVoiceClip } from '../lib/hooks/useVoiceClip';

/** Local date at hour; date "YYYY-MM-DD" or null = today. */
const at = (date: string | null, h: number) => {
  const d = date ? new Date(`${date}T00:00:00`) : new Date();
  d.setHours(h, 0, 0, 0);
  return d;
};
const mkStop = (
  seq: number,
  type: 'PICKUP' | 'DELIVERY',
  address: string,
  date: string | null,
  beginH: number,
) => ({
  sequenceNumber: seq,
  stopType: type,
  loadingType: 'APPT' as const,
  address,
  windowBeginDate: at(date, beginH).toISOString().slice(0, 10),
  windowBeginTime: at(date, beginH).toISOString(),
  windowEndDate: at(date, beginH + 2).toISOString().slice(0, 10),
  windowEndTime: at(date, beginH + 2).toISOString(),
  commodityDescription: 'General freight',
  commodityUnits: 'Pallets' as const,
  pieces: 1,
});
const windowLabel = (date: string | null, h: number) => {
  const d = at(date, h);
  const day = date ? d.toLocaleDateString(undefined, { month: 'short', day: 'numeric' }) : 'today';
  const t = (x: Date) => x.toLocaleTimeString(undefined, { hour: 'numeric' });
  return `${day} ${t(d)}–${t(at(date, h + 2))}`;
};

export default function CreateLoadScreen() {
  const router = useRouter();
  const customers = useQuery(api.dispatchMobile.listCustomers, {});
  const create = useMutation(api.dispatchMobile.createLoad);
  const dictate = useAction(api.voice.transcribeLoadDraft);
  const [customerId, setCustomerId] = React.useState<Id<'customers'> | null>(null);
  const [commodity, setCommodity] = React.useState('');
  const [pickup, setPickup] = React.useState('');
  const [dropoff, setDropoff] = React.useState('');
  const [pickupWhen, setPickupWhen] = React.useState<{ date: string | null; hour: number }>({ date: null, hour: 8 });
  const [dropoffWhen, setDropoffWhen] = React.useState<{ date: string | null; hour: number }>({ date: null, hour: 13 });
  const [heard, setHeard] = React.useState('');
  const [extracting, setExtracting] = React.useState(false);
  const [busy, setBusy] = React.useState(false);
  const ready = customerId && pickup.trim() && dropoff.trim();

  const customersRef = React.useRef(customers);
  customersRef.current = customers;

  const voice = useVoiceClip(async (clip, deviceTranscript) => {
    if (!clip) {
      if (deviceTranscript) setHeard(deviceTranscript);
      else Alert.alert('Dictation unavailable', 'Check the microphone permission and try again.');
      return;
    }
    setExtracting(true);
    try {
      const res = await dictate(clip);
      setHeard(res.transcript || deviceTranscript);
      const draft = res.draft;
      if (!draft) {
        Alert.alert('Could not extract load details', 'The transcript is shown below — fill the form in manually.');
        return;
      }
      if (draft.customerName) {
        const q = draft.customerName.toLowerCase();
        const hit = (customersRef.current ?? []).find(
          (c) => c.name.toLowerCase().includes(q) || q.includes(c.name.toLowerCase()),
        );
        if (hit) setCustomerId(hit._id);
      }
      if (draft.commodity) setCommodity(draft.commodity);
      if (draft.pickupAddress) setPickup(draft.pickupAddress);
      if (draft.dropoffAddress) setDropoff(draft.dropoffAddress);
      if (draft.pickupDate !== null || draft.pickupHour !== null) {
        setPickupWhen((w) => ({ date: draft.pickupDate ?? w.date, hour: draft.pickupHour ?? w.hour }));
      }
      if (draft.dropoffDate !== null || draft.dropoffHour !== null) {
        setDropoffWhen((w) => ({ date: draft.dropoffDate ?? w.date, hour: draft.dropoffHour ?? w.hour }));
      }
    } catch (e) {
      Alert.alert('Dictation failed', e instanceof Error ? e.message : 'Try again.');
    } finally {
      setExtracting(false);
    }
  });

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
        stops: [
          mkStop(1, 'PICKUP', pickup.trim(), pickupWhen.date, pickupWhen.hour),
          mkStop(2, 'DELIVERY', dropoff.trim(), dropoffWhen.date, dropoffWhen.hour),
        ],
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
        <Text style={{ flex: 1, fontSize: typography.xl, fontWeight: typography.bold, color: colors.foreground }}>New load</Text>
        {voice.available && (
          <Pressable onPress={() => void voice.toggle()} hitSlop={10} style={{ width: 40, height: 40, borderRadius: 20, alignItems: 'center', justifyContent: 'center', backgroundColor: voice.listening ? colors.destructive : colors.primary }}>
            <Ionicons name={voice.listening ? 'stop' : 'mic'} size={20} color={colors.primaryForeground} />
          </Pressable>
        )}
      </View>
      {(voice.listening || voice.partial || extracting) && (
        <Text style={{ color: colors.foregroundMuted, fontSize: typography.sm, paddingHorizontal: 20, marginTop: 8 }} numberOfLines={2}>
          {extracting ? 'Extracting load details…' : voice.partial || 'Listening — describe the load…'}
        </Text>
      )}
      <ScrollView contentContainerStyle={{ padding: 20, gap: 14 }}>
        {heard !== '' && (
          <View style={{ borderWidth: 1, borderColor: colors.border, borderRadius: borderRadius.md, backgroundColor: colors.card, padding: 12 }}>
            <Text style={{ color: colors.foregroundMuted, fontSize: typography.xs, fontWeight: typography.bold, letterSpacing: 1, marginBottom: 4 }}>HEARD</Text>
            <Text style={{ color: colors.foreground, fontSize: typography.sm, lineHeight: 20 }}>{heard}</Text>
          </View>
        )}
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
        <Text style={s.label}>PICKUP · {windowLabel(pickupWhen.date, pickupWhen.hour)}</Text>
        <TextInput style={field} value={pickup} onChangeText={setPickup} placeholder="Pickup address" placeholderTextColor={colors.foregroundMuted} />
        <Text style={s.label}>DROPOFF · {windowLabel(dropoffWhen.date, dropoffWhen.hour)}</Text>
        <TextInput style={field} value={dropoff} onChangeText={setDropoff} placeholder="Dropoff address" placeholderTextColor={colors.foregroundMuted} />
        <Text style={{ color: colors.foregroundMuted, fontSize: typography.xs }}>
          Windows come from dictation when spoken, otherwise default to today; fine-tune after
          creation with the clock icon on the Board.
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
