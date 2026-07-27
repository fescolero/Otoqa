/** Voice agent (Phase 3) — press the mic, speak a command, confirm the
 * action card. Deterministic on-device parsing (lib/voice/parser); every
 * mutating command goes through an explicit Confirm card — the agent
 * never acts on speech alone. Command families:
 *   "assign load 1001 to Marcus"      → assignDriverToLoad
 *   "move load 1001 to 3 pm"          → adjustStopWindow (next open stop)
 *   "accept / decline offer 1001"     → offer mutations
 *   "what's on the board" / "alerts?" → spoken-style summaries
 *
 * The native module ships in builds that include this release — an OTA
 * update onto an older APK degrades to a "rebuild required" card instead
 * of crashing (lazy require).
 */
import { useEffect, useRef, useState } from 'react';
import { ActivityIndicator, Pressable, ScrollView, Text, View } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { useMutation, useQuery } from 'convex/react';
import { api } from '@otoqa/convex-client';
import { borderRadius, colors, typography } from '@otoqa/mobile-core';
import {
  matchByRef,
  matchDriver,
  nextOccurrence,
  parseCommand,
  type VoiceIntent,
} from '../../lib/voice/parser';

// Lazy require: absent native module (old APK + OTA JS) must not crash.
let Speech: {
  requestPermissionsAsync(): Promise<{ granted: boolean }>;
  start(opts: { lang: string; interimResults: boolean; continuous: boolean }): void;
  stop(): void;
  addListener(event: string, cb: (e: never) => void): { remove(): void };
} | null = null;
try {
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  Speech = require('expo-speech-recognition').ExpoSpeechRecognitionModule;
} catch {
  Speech = null;
}

type Msg = { id: number; role: 'you' | 'agent'; text: string };
type Pending =
  | { kind: 'assign'; assignmentId: string; driverId: string; label: string }
  | { kind: 'move'; stopId: string; beginISO: string; endISO: string; label: string }
  | { kind: 'accept' | 'decline'; assignmentId: string; label: string };

const fmtT = (d: Date) => d.toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' });
const kindLabel = (k: string) => k.toLowerCase().replace(/_/g, ' ');

export default function VoiceScreen() {
  const rows = useQuery(api.dispatchMobile.listActiveAssignments, {});
  const drivers = useQuery(api.dispatchMobile.listDrivers, {});
  const offers = useQuery(api.dispatchMobile.listOffers, {});
  const alerts = useQuery(api.dispatchAlerts.listAlerts, {});
  const assignDriver = useMutation(api.dispatchMobile.assignDriverToLoad);
  const adjustWindow = useMutation(api.dispatchMobile.adjustStopWindow);
  const acceptOffer = useMutation(api.dispatchMobile.acceptOffer);
  const declineOffer = useMutation(api.dispatchMobile.declineOffer);

  const [messages, setMessages] = useState<Msg[]>([]);
  const [pending, setPending] = useState<Pending | null>(null);
  const [listening, setListening] = useState(false);
  const [partial, setPartial] = useState('');
  const [busy, setBusy] = useState(false);
  const nextId = useRef(1);
  const scrollRef = useRef<ScrollView>(null);

  const say = (role: 'you' | 'agent', text: string) =>
    setMessages((m) => [...m, { id: nextId.current++, role, text }]);

  const handleIntent = (intent: VoiceIntent) => {
    switch (intent.kind) {
      case 'assign': {
        const loadHit = matchByRef(rows ?? [], (r) => r.load?.internalId, intent.loadRef);
        if (!loadHit) return say('agent', `I can't find load ${intent.loadRef} on the board.`);
        if ('ambiguous' in loadHit)
          return say(
            'agent',
            `Several loads match: ${loadHit.ambiguous.map((r) => `#${r.load?.internalId}`).join(', ')}. Say the full number.`,
          );
        const driverHit = matchDriver(drivers ?? [], intent.driverQuery);
        if (!driverHit) return say('agent', `I don't know a driver called “${intent.driverQuery}”.`);
        if ('ambiguous' in driverHit)
          return say(
            'agent',
            `Several drivers match: ${driverHit.ambiguous.map((d) => `${d.firstName} ${d.lastName}`).join(', ')}. Say the full name.`,
          );
        const row = loadHit.match;
        const d = driverHit.match;
        return setPending({
          kind: 'assign',
          assignmentId: row._id,
          driverId: d._id,
          label: `Assign #${row.load?.internalId} to ${d.firstName} ${d.lastName}?`,
        });
      }
      case 'move_window': {
        const loadHit = matchByRef(rows ?? [], (r) => r.load?.internalId, intent.loadRef);
        if (!loadHit) return say('agent', `I can't find load ${intent.loadRef} on the board.`);
        if ('ambiguous' in loadHit)
          return say(
            'agent',
            `Several loads match: ${loadHit.ambiguous.map((r) => `#${r.load?.internalId}`).join(', ')}. Say the full number.`,
          );
        const row = loadHit.match;
        const stop = row.stops.filter((s) => !s.checkedInAt)[0];
        if (!stop) return say('agent', `Every stop on #${row.load?.internalId} is already checked in.`);
        const begin = nextOccurrence(intent.time, new Date());
        const end = new Date(begin.getTime() + 30 * 60 * 1000);
        return setPending({
          kind: 'move',
          stopId: stop._id,
          beginISO: begin.toISOString(),
          endISO: end.toISOString(),
          label: `Move #${row.load?.internalId} stop ${stop.sequenceNumber} to ${fmtT(begin)} – ${fmtT(end)}?`,
        });
      }
      case 'accept_offer':
      case 'decline_offer': {
        const verb = intent.kind === 'accept_offer' ? 'Accept' : 'Decline';
        const open = (offers ?? []).filter((o) => o.status === 'OFFERED');
        if (open.length === 0) return say('agent', 'There are no open offers right now.');
        let target = null;
        if (intent.loadRef) {
          const hit = matchByRef(open, (o) => o.load?.internalId, intent.loadRef);
          if (!hit) return say('agent', `No open offer matches ${intent.loadRef}.`);
          if ('ambiguous' in hit)
            return say(
              'agent',
              `Several offers match: ${hit.ambiguous.map((o) => `#${o.load?.internalId}`).join(', ')}.`,
            );
          target = hit.match;
        } else if (open.length === 1) {
          target = open[0];
        } else {
          return say(
            'agent',
            `There are ${open.length} open offers. Say "${verb.toLowerCase()} offer" plus the load number.`,
          );
        }
        return setPending({
          kind: intent.kind === 'accept_offer' ? 'accept' : 'decline',
          assignmentId: target._id,
          label: `${verb} the offer for #${target.load?.internalId}?`,
        });
      }
      case 'board_summary': {
        const r = rows ?? [];
        const rolling = r.filter((x) => x.status === 'IN_PROGRESS').length;
        const awarded = r.filter((x) => x.status === 'AWARDED');
        const unassigned = awarded.filter((x) => !x.assignedDriverId).length;
        const openOffers = (offers ?? []).filter((o) => o.status === 'OFFERED').length;
        let text = `${rolling} rolling, ${awarded.length} awarded (${unassigned} unassigned)`;
        if (openOffers) text += `, ${openOffers} open offer${openOffers === 1 ? '' : 's'}`;
        text += '.';
        return say('agent', text);
      }
      case 'alerts_summary': {
        const a = alerts ?? [];
        if (a.length === 0) return say('agent', 'No open alerts. All quiet.');
        const high = a.filter((x) => x.severity === 'high').length;
        const top = a
          .slice(0, 3)
          .map((x) => `${kindLabel(x.kind)}${x.loadInternalId ? ` on #${x.loadInternalId}` : ''}`)
          .join('; ');
        return say('agent', `${a.length} open alert${a.length === 1 ? '' : 's'}${high ? ` (${high} high)` : ''}: ${top}.`);
      }
      case 'unknown':
        return say(
          'agent',
          'Try: “assign load 1001 to Marcus”, “move load 1001 to 3 pm”, “accept offer 1001”, “what’s on the board”, or “any alerts”.',
        );
    }
  };

  // Keep the latest handler in a ref so the native listeners subscribe once.
  const onFinal = (transcript: string) => {
    setPartial('');
    if (!transcript.trim()) return;
    say('you', transcript);
    handleIntent(parseCommand(transcript));
  };
  const onFinalRef = useRef(onFinal);
  onFinalRef.current = onFinal;

  useEffect(() => {
    if (!Speech) return;
    const subs = [
      Speech.addListener('result', (e: { results?: { transcript: string }[]; isFinal?: boolean }) => {
        const tr = e.results?.[0]?.transcript ?? '';
        if (e.isFinal) onFinalRef.current(tr);
        else setPartial(tr);
      }),
      Speech.addListener('end', () => setListening(false)),
      Speech.addListener('error', (e: { error?: string; message?: string }) => {
        setListening(false);
        setPartial('');
        if (e.error !== 'no-speech' && e.error !== 'aborted') {
          setMessages((m) => [
            ...m,
            { id: nextId.current++, role: 'agent', text: `Mic trouble: ${e.message ?? e.error ?? 'unknown error'}` },
          ]);
        }
      }),
    ];
    return () => subs.forEach((s) => s.remove());
  }, []);

  const toggleMic = async () => {
    if (!Speech) return;
    if (listening) {
      Speech.stop();
      return;
    }
    const perm = await Speech.requestPermissionsAsync();
    if (!perm.granted) {
      say('agent', 'Microphone permission is required for voice commands — enable it in Settings.');
      return;
    }
    setPartial('');
    setListening(true);
    Speech.start({ lang: 'en-US', interimResults: true, continuous: false });
  };

  const confirm = async () => {
    if (!pending || busy) return;
    setBusy(true);
    try {
      if (pending.kind === 'assign') {
        const res = await assignDriver({
          assignmentId: pending.assignmentId as never,
          driverId: pending.driverId as never,
        });
        say('agent', res.success ? 'Done — assigned.' : `That load was just assigned to ${res.alreadyAssigned.driverName}.`);
      } else if (pending.kind === 'move') {
        const res = await adjustWindow({
          stopId: pending.stopId as never,
          windowBeginTime: pending.beginISO,
          windowEndTime: pending.endISO,
        });
        say('agent', res.warnings.length ? `Moved. Heads up: ${res.warnings.join(' ')}` : 'Done — window moved.');
      } else if (pending.kind === 'accept') {
        await acceptOffer({ assignmentId: pending.assignmentId as never });
        say('agent', 'Offer accepted — waiting on the broker award.');
      } else {
        await declineOffer({ assignmentId: pending.assignmentId as never });
        say('agent', 'Offer declined.');
      }
    } catch (e) {
      say('agent', e instanceof Error ? e.message : 'That didn’t work — try again.');
    } finally {
      setPending(null);
      setBusy(false);
    }
  };

  return (
    <View style={{ flex: 1, backgroundColor: colors.background, paddingTop: 70 }}>
      <View style={{ paddingHorizontal: 24 }}>
        <Text style={{ fontSize: typography['2xl'], fontWeight: typography.bold, color: colors.foreground }}>
          Voice
        </Text>
        <Text style={{ fontSize: typography.sm, color: colors.foregroundMuted, marginTop: 4 }}>
          Speak a command — every action asks before it runs
        </Text>
      </View>

      {!Speech ? (
        <View style={{ margin: 24, backgroundColor: colors.card, borderWidth: 1, borderColor: colors.border, borderRadius: borderRadius.lg, padding: 18, alignItems: 'center', gap: 8 }}>
          <Ionicons name="mic-off-outline" size={32} color={colors.warning} />
          <Text style={{ color: colors.foreground, fontWeight: typography.semibold, fontSize: typography.base }}>
            Voice needs a new app build
          </Text>
          <Text style={{ color: colors.foregroundMuted, fontSize: typography.sm, textAlign: 'center', lineHeight: 20 }}>
            This installed version doesn't include the microphone module yet. Install the latest
            build to use voice commands.
          </Text>
        </View>
      ) : (
        <>
          <ScrollView
            ref={scrollRef}
            style={{ flex: 1 }}
            contentContainerStyle={{ padding: 24, paddingBottom: 12 }}
            onContentSizeChange={() => scrollRef.current?.scrollToEnd({ animated: true })}
          >
            {messages.length === 0 && (
              <Text style={{ color: colors.foregroundMuted, fontSize: typography.sm, textAlign: 'center', marginTop: 24, lineHeight: 22 }}>
                Try:{'\n'}“Assign load 1001 to Marcus”{'\n'}“Move load 1001 to 3 pm”{'\n'}“Accept offer 1001”{'\n'}“What’s on the board?” · “Any alerts?”
              </Text>
            )}
            {messages.map((m) => (
              <View
                key={m.id}
                style={{
                  alignSelf: m.role === 'you' ? 'flex-end' : 'flex-start',
                  backgroundColor: m.role === 'you' ? colors.primary : colors.card,
                  borderWidth: m.role === 'you' ? 0 : 1,
                  borderColor: colors.border,
                  borderRadius: borderRadius.lg,
                  paddingHorizontal: 14,
                  paddingVertical: 10,
                  marginBottom: 8,
                  maxWidth: '85%',
                }}
              >
                <Text style={{ color: m.role === 'you' ? colors.primaryForeground : colors.foreground, fontSize: typography.sm, lineHeight: 20 }}>
                  {m.text}
                </Text>
              </View>
            ))}
            {pending && (
              <View style={{ backgroundColor: colors.card, borderWidth: 1, borderColor: colors.primary, borderRadius: borderRadius.lg, padding: 14, marginTop: 4 }}>
                <Text style={{ color: colors.foreground, fontSize: typography.base, fontWeight: typography.semibold }}>
                  {pending.label}
                </Text>
                <View style={{ flexDirection: 'row', gap: 10, marginTop: 12 }}>
                  <Pressable
                    disabled={busy}
                    onPress={() => void confirm()}
                    style={{ flex: 1, alignItems: 'center', backgroundColor: colors.primary, paddingVertical: 10, borderRadius: borderRadius.md, opacity: busy ? 0.6 : 1 }}
                  >
                    {busy ? (
                      <ActivityIndicator color={colors.primaryForeground} />
                    ) : (
                      <Text style={{ color: colors.primaryForeground, fontSize: typography.sm, fontWeight: typography.semibold }}>Confirm</Text>
                    )}
                  </Pressable>
                  <Pressable
                    disabled={busy}
                    onPress={() => setPending(null)}
                    style={{ flex: 1, alignItems: 'center', borderWidth: 1, borderColor: colors.border, paddingVertical: 10, borderRadius: borderRadius.md }}
                  >
                    <Text style={{ color: colors.foregroundMuted, fontSize: typography.sm, fontWeight: typography.semibold }}>Cancel</Text>
                  </Pressable>
                </View>
              </View>
            )}
          </ScrollView>

          <View style={{ alignItems: 'center', paddingBottom: 26, paddingTop: 6 }}>
            {(listening || partial) && (
              <Text style={{ color: colors.foregroundMuted, fontSize: typography.sm, marginBottom: 10, paddingHorizontal: 32, textAlign: 'center' }} numberOfLines={2}>
                {partial || 'Listening…'}
              </Text>
            )}
            <Pressable
              onPress={() => void toggleMic()}
              style={{
                width: 72,
                height: 72,
                borderRadius: 36,
                alignItems: 'center',
                justifyContent: 'center',
                backgroundColor: listening ? colors.destructive : colors.primary,
              }}
            >
              <Ionicons name={listening ? 'stop' : 'mic'} size={30} color={colors.primaryForeground} />
            </Pressable>
          </View>
        </>
      )}
    </View>
  );
}
