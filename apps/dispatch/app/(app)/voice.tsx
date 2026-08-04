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
import { ActivityIndicator, Animated, Linking, Pressable, ScrollView, Text, View } from 'react-native';
import { useRouter } from 'expo-router';
import { Ionicons } from '@expo/vector-icons';
import { useAction, useConvex, useMutation, useQuery } from 'convex/react';
import { api } from '@otoqa/convex-client';
import { borderRadius, colors, typography } from '@otoqa/mobile-core';
import {
  localDateStr,
  matchByRef,
  matchDriver,
  nextOccurrence,
  parseCommand,
  type VoiceIntent,
} from '../../lib/voice/parser';
import { displayLoadId } from '../../lib/format';
import { trackAction } from '../../lib/analytics';

// Lazy requires: absent native modules (old APK + OTA JS) must not crash.
/* eslint-disable @typescript-eslint/no-var-requires */
let Speech: {
  requestPermissionsAsync(): Promise<{ granted: boolean }>;
  start(opts: Record<string, unknown>): void;
  stop(): void;
  addListener(event: string, cb: (e: any) => void): { remove(): void };
} | null = null;
try {
  Speech = require('expo-speech-recognition').ExpoSpeechRecognitionModule;
} catch {
  Speech = null;
}
let FileSystem: { readAsStringAsync(uri: string, opts: { encoding: 'base64' }): Promise<string> } | null =
  null;
try {
  FileSystem = require('expo-file-system/legacy');
} catch {
  FileSystem = null;
}
// TTS — native module; absent until the build that bundles it (OTA-safe).
let SpeechSynth: {
  speak(text: string, opts?: { language?: string; onDone?: () => void; onError?: () => void }): void;
  stop(): void;
  isSpeakingAsync?: () => Promise<boolean>;
} | null = null;
try {
  SpeechSynth = require('expo-speech');
} catch {
  SpeechSynth = null;
}
/* eslint-enable @typescript-eslint/no-var-requires */

const mimeForUri = (uri: string) =>
  uri.toLowerCase().endsWith('.caf') ? 'audio/x-caf' : 'audio/wav';

/** Row-per-load rendering, shared by chat bubbles and the confirm card. */
type LoadRow = {
  load: string;
  /** Right-aligned detail: a date, a time, or empty. */
  when: string | null;
  tags: string[];
  /** Muted second line (customer · status). */
  note: string | null;
  /** Warning line (e.g. reassignment). */
  warn: string | null;
  /** Tier 2: tap-through target — opens /load/[id] when present. */
  loadId?: string | null;
};
type Msg = { id: number; role: 'you' | 'agent'; text: string; rows?: LoadRow[] };
type PendingRow = { load: string; date: string; tags: string[]; current: string | null; loadId: string };
type Pending =
  | { kind: 'assign'; assignmentId: string; driverId: string; label: string }
  | { kind: 'assignLoads'; loadIds: string[]; driverId: string; label: string; rows: PendingRow[] }
  | { kind: 'move'; stopId: string; beginISO: string; endISO: string; label: string }
  | { kind: 'accept' | 'decline'; assignmentId: string; label: string };

const fmtDay = (iso: string) => {
  const d = new Date(`${iso}T00:00:00`);
  return Number.isNaN(d.getTime())
    ? iso
    : d.toLocaleDateString(undefined, { weekday: 'short', month: 'short', day: 'numeric' });
};

/** One visual row per load — used by agent bubbles AND the confirm card.
 *  Rows with a loadId tap through to the load detail screen. */
function RowList({ rows }: { rows: LoadRow[] }) {
  const router = useRouter();
  return (
    <>
      {rows.map((r, i) => (
        <Pressable
          key={i}
          disabled={!r.loadId}
          onPress={
            r.loadId
              ? () => router.push({ pathname: '/load/[id]', params: { id: r.loadId! } })
              : undefined
          }
          style={{ marginTop: 10, paddingTop: 10, borderTopWidth: 1, borderTopColor: colors.border }}
        >
          <View style={{ flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' }}>
            <Text style={{ color: colors.foreground, fontSize: typography.sm, fontWeight: typography.bold }}>
              {r.load}
            </Text>
            <View style={{ flexDirection: 'row', alignItems: 'center', gap: 4 }}>
              {r.when ? (
                <Text style={{ color: colors.foregroundMuted, fontSize: typography.xs }}>{r.when}</Text>
              ) : null}
              {r.loadId ? (
                <Ionicons name="chevron-forward" size={13} color={colors.foregroundMuted} />
              ) : null}
            </View>
          </View>
          {r.tags.length > 0 && (
            <View style={{ flexDirection: 'row', gap: 6, marginTop: 5, flexWrap: 'wrap' }}>
              {r.tags.map((t) => (
                <View
                  key={t}
                  style={{ borderWidth: 1, borderColor: colors.border, borderRadius: 999, paddingHorizontal: 8, paddingVertical: 2 }}
                >
                  <Text style={{ color: colors.foregroundMuted, fontSize: typography.xs }}>{t}</Text>
                </View>
              ))}
            </View>
          )}
          {r.note && (
            <Text style={{ color: colors.foregroundMuted, fontSize: typography.xs, marginTop: 4 }}>
              {r.note}
            </Text>
          )}
          {r.warn && (
            <Text style={{ color: colors.warning, fontSize: typography.xs, marginTop: 4 }}>{r.warn}</Text>
          )}
        </Pressable>
      ))}
    </>
  );
}

/** Bump on every voice-feature change — shown in the header so a glance
 * tells which bundle is actually running (expo-updates rolls back bad
 * OTAs silently; this makes delivery verifiable). */
const VOICE_BUILD = 'v23';
let updateTag = 'embedded js';
try {
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const Updates = require('expo-updates');
  if (Updates.updateId && !Updates.isEmbeddedLaunch) {
    updateTag = `ota ${String(Updates.updateId).slice(0, 8)}`;
  }
} catch {
  // expo-updates unavailable (dev client) — leave the embedded tag.
}

const fmtT = (d: Date) => d.toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' });
const kindLabel = (k: string) => k.toLowerCase().replace(/_/g, ' ');
const agoLabel = (ms: number): string => {
  const mins = Math.round((Date.now() - ms) / 60_000);
  if (mins < 1) return 'just now';
  if (mins < 60) return `${mins}m ago`;
  const hours = Math.round(mins / 60);
  return hours < 48 ? `${hours}h ago` : `${Math.round(hours / 24)}d ago`;
};
/** Leading yes/no words for hands-free confirmation of the pending card. */
const yesNo = (t: string): 'yes' | 'no' | null => {
  const w = t.trim().toLowerCase().replace(/^[^a-z']+/, '');
  if (/^(yes|yeah|yep|yup|ok(ay)?|confirm(ed)?|correct|do it|go ahead|sure|affirmative)\b/.test(w))
    return 'yes';
  if (/^(no|nope|cancel|stop|don'?t|do not|never ?mind|nevermind|negative)\b/.test(w)) return 'no';
  return null;
};
const shortDate = (d: Date) => d.toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
const dayLabel = (d: Date, end?: Date | null) => {
  if (end) return `${shortDate(d)} – ${shortDate(end)}`;
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  const diff = Math.round((d.getTime() - today.getTime()) / 86_400_000);
  if (diff === 0) return 'today';
  if (diff === -1) return 'yesterday';
  return `on ${shortDate(d)}`;
};

export default function VoiceScreen() {
  const rows = useQuery(api.dispatchMobile.listActiveAssignments, {});
  const drivers = useQuery(api.dispatchMobile.listDrivers, {});
  const offers = useQuery(api.dispatchMobile.listOffers, {});
  const alerts = useQuery(api.dispatchAlerts.listAlerts, {});
  const assignDriver = useMutation(api.dispatchMobile.assignDriverToLoad);
  const assignLoadsWeb = useMutation(api.dispatchMobile.assignDriverToLoadsWeb);
  const adjustWindow = useMutation(api.dispatchMobile.adjustStopWindow);
  const acceptOffer = useMutation(api.dispatchMobile.acceptOffer);
  const declineOffer = useMutation(api.dispatchMobile.declineOffer);
  const transcribe = useAction(api.voice.transcribeAndParse);
  const convexClient = useConvex();

  const [messages, setMessages] = useState<Msg[]>([]);
  const [pending, setPending] = useState<Pending | null>(null);
  // Mirrors for the once-subscribed native listeners / process closure:
  // the pending ACTION card (voice yes/no) and the latest confirm().
  const pendingActionRef = useRef<Pending | null>(null);
  const confirmRef = useRef<() => Promise<void>>(async () => {});
  const [listening, setListening] = useState(false);
  const [partial, setPartial] = useState('');
  const [busy, setBusy] = useState(false);
  const nextId = useRef(1);
  const scrollRef = useRef<ScrollView>(null);

  // v23 UI: the mic button breathes while the app is listening — the
  // visual cue that the session is still open through pauses (v21
  // endpointing keeps it open until 1.8s of silence).
  const pulse = useRef(new Animated.Value(1)).current;
  useEffect(() => {
    if (!listening) {
      pulse.setValue(1);
      return;
    }
    const loop = Animated.loop(
      Animated.sequence([
        Animated.timing(pulse, { toValue: 1.12, duration: 650, useNativeDriver: true }),
        Animated.timing(pulse, { toValue: 1, duration: 650, useNativeDriver: true }),
      ]),
    );
    loop.start();
    return () => loop.stop();
  }, [listening, pulse]);

  // TTS mute — ref-mirrored so async flows always read the live value.
  const [muted, setMuted] = useState(false);
  const mutedRef = useRef(false);
  // Barge-in-lite (v22): while the agent is speaking, tapping the mic
  // stops TTS and opens the mic. The generation token cancels the
  // interrupted reply's pending watchdog/reopen so it can't fire late
  // and fight the session the user just started.
  const [speaking, setSpeaking] = useState(false);
  const speakingRef = useRef(false);
  const ttsGenRef = useRef(0);
  const setSpeakingState = (v: boolean) => {
    speakingRef.current = v;
    setSpeaking(v);
  };
  const toggleMute = () => {
    setMuted((m) => {
      const next = !m;
      mutedRef.current = next;
      if (next) {
        SpeechSynth?.stop();
        // Muting mid-question: cancel the reply's watchdog/reopen too —
        // a muted user is opting out of the hands-free loop.
        ttsGenRef.current++;
        setSpeakingState(false);
      }
      return next;
    });
  };

  /**
   * Speak an agent reply aloud (unless muted / module absent). thenListen
   * reopens the mic AFTER speech finishes — speaking first would let the
   * TTS bleed into the recording.
   */
  const speakReply = (text: string, thenListen?: boolean) => {
    const gen = ++ttsGenRef.current;
    const after = thenListen
      ? () => {
          autoOpenedRef.current = true;
          autoRetriedRef.current = false;
          void startListeningRef.current();
        }
      : undefined;
    if (!mutedRef.current && SpeechSynth) {
      SpeechSynth.stop();
      const startedAt = Date.now();
      setSpeakingState(true);
      let fired = false;
      const once = (via: 'callback' | 'watchdog') => {
        if (fired || gen !== ttsGenRef.current) return;
        fired = true;
        setSpeakingState(false);
        if (after) {
          trackAction('voice_tts', { via, ms: Date.now() - startedAt, chars: text.length });
          after();
        }
      };
      SpeechSynth.speak(text, {
        language: 'en-US',
        onDone: () => once('callback'),
        onError: () => once('callback'),
      });
      // Engine watchdog: some Android TTS engines never fire callbacks.
      // Instead of blindly opening the mic (which cut the spoken question
      // short), poll isSpeakingAsync — re-arm while the engine is still
      // talking, settle only once it's done or unresponsive. Runs for
      // every reply now (not just thenListen) so the speaking state —
      // which gates the tap-to-interrupt hint — always clears.
      let checks = 0;
      const watchdog = () => {
        if (fired || gen !== ttsGenRef.current) return;
        const probe = SpeechSynth?.isSpeakingAsync?.();
        if (probe && typeof probe.then === 'function') {
          probe
            .then((stillSpeaking) => {
              if (fired || gen !== ttsGenRef.current) return;
              if (stillSpeaking && checks < 8) {
                checks++;
                setTimeout(watchdog, 1200);
              } else once('watchdog');
            })
            .catch(() => once('watchdog'));
        } else once('watchdog');
      };
      setTimeout(watchdog, Math.min(2000 + text.length * 55, 9000));
    } else if (after) {
      setTimeout(() => {
        if (gen === ttsGenRef.current) after();
      }, 600);
    }
  };

  const say = (
    role: 'you' | 'agent',
    text: string,
    opts?: { thenListen?: boolean; rows?: LoadRow[]; speak?: string },
  ) => {
    const id = nextId.current++;
    setMessages((m) => [...m, { id, role, text, ...(opts?.rows ? { rows: opts.rows } : {}) }]);
    // The bubble can show a terse header + rows while the spoken reply
    // stays a natural sentence (opts.speak).
    if (role === 'agent') speakReply(opts?.speak ?? text, opts?.thenListen);
    return id;
  };

  /** Optimistic-transcript swap: refine a shown message in place. */
  const updateMessage = (id: number, text: string) =>
    setMessages((m) => m.map((msg) => (msg.id === id ? { ...msg, text } : msg)));

  /** Tier 2 voice confirmation: show the card, speak the question, and
   *  reopen the mic so "yes" / "cancel" completes it hands-free. The
   *  buttons keep working; ambiguous speech falls through to normal
   *  command parsing with the card still up. */
  const propose = (p: Pending) => {
    setPending(p);
    pendingActionRef.current = p;
    speakReply(`${p.label} Say yes to confirm, or cancel.`, true);
  };
  const clearPending = () => {
    setPending(null);
    pendingActionRef.current = null;
  };

  // Fresh start: wipes the feed (which IS the conversational context sent
  // to the server), any pending confirm card, the clarify bridge, and any
  // speech in progress. The next utterance parses with zero context.
  const clearConversation = () => {
    if (listening) Speech?.stop();
    SpeechSynth?.stop();
    ttsGenRef.current++;
    setSpeakingState(false);
    setMessages([]);
    clearPending();
    setPartial('');
    pendingClarifyRef.current = null;
  };

  const handleIntent = (intent: VoiceIntent) => {
    switch (intent.kind) {
      case 'assign': {
        // Facet form — "trip 5 HCR 96036 to Jorge tomorrow and Saturday":
        // resolve loads by route tags + service dates on the server.
        if (intent.hcr || intent.trip || intent.trips?.length) {
          const driverHit = matchDriver(drivers ?? [], intent.driverQuery);
          if (!driverHit) return say('agent', `I don't know a driver called “${intent.driverQuery}”.`);
          if ('ambiguous' in driverHit)
            return say(
              'agent',
              `Several drivers match: ${driverHit.ambiguous.map((d) => `${d.firstName} ${d.lastName}`).join(', ')}. Say the full name.`,
            );
          const d = driverHit.match;
          const tripList = intent.trips?.length ? intent.trips : intent.trip ? [intent.trip] : [];
          const routeLabel = [
            tripList.length ? `Trip${tripList.length === 1 ? '' : 's'} ${tripList.join(', ')}` : null,
            intent.hcr ? `HCR ${intent.hcr}` : null,
          ]
            .filter(Boolean)
            .join(' ');
          const dates = intent.dates?.length ? intent.dates : [localDateStr(new Date())];
          void (async () => {
            try {
              const found = await convexClient.query(api.dispatchMobile.findLoadsByFacetDates, {
                hcr: intent.hcr ?? undefined,
                trips: tripList.length ? tripList : undefined,
                dates,
              });
              if (found.length === 0)
                return say(
                  'agent',
                  `No loads match ${routeLabel} on ${dates.map(fmtDay).join(', ')}. Check the trip and contract numbers.`,
                );
              propose({
                kind: 'assignLoads',
                loadIds: found.map((f) => f.loadId as string),
                driverId: d._id,
                label: `Assign ${found.length} load${found.length === 1 ? '' : 's'} on ${routeLabel} to ${d.firstName} ${d.lastName}?`,
                rows: found.map((f) => ({
                  load: displayLoadId(f.internalId),
                  date: f.firstStopDate,
                  loadId: f.loadId as string,
                  tags: [
                    f.tripNumber ? `Trip ${f.tripNumber}` : null,
                    f.hcr ? `HCR ${f.hcr}` : null,
                  ].filter((t): t is string => !!t),
                  current: f.currentDriverName,
                })),
              });
            } catch (e) {
              say('agent', e instanceof Error ? e.message : 'Could not look that route up.');
            }
          })();
          return;
        }
        if (!intent.loadRef) return say('agent', 'Which load should I assign? Say the load number, or a trip and HCR.');
        // Web-TMS leg rows are read-only here — their driver is managed in
        // the TMS, and assignLoad only accepts loadCarrierAssignments ids.
        const assignable = (rows ?? []).filter((r) => r.source !== 'leg');
        const loadHit = matchByRef(assignable, (r) => r.load?.internalId, intent.loadRef);
        if (!loadHit) return say('agent', `I can't find load ${intent.loadRef} on the board.`);
        if ('ambiguous' in loadHit)
          return say(
            'agent',
            `Several loads match: ${loadHit.ambiguous.map((r) => `${displayLoadId(r.load?.internalId)}`).join(', ')}. Say the full number.`,
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
        return propose({
          kind: 'assign',
          assignmentId: row._id,
          driverId: d._id,
          label: `Assign ${displayLoadId(row.load?.internalId)} to ${d.firstName} ${d.lastName}?`,
        });
      }
      case 'move_window': {
        const loadHit = matchByRef(rows ?? [], (r) => r.load?.internalId, intent.loadRef);
        if (!loadHit) return say('agent', `I can't find load ${intent.loadRef} on the board.`);
        if ('ambiguous' in loadHit)
          return say(
            'agent',
            `Several loads match: ${loadHit.ambiguous.map((r) => `${displayLoadId(r.load?.internalId)}`).join(', ')}. Say the full number.`,
          );
        const row = loadHit.match;
        const stop = row.stops.filter((s) => !s.checkedInAt)[0];
        if (!stop) return say('agent', `Every stop on ${displayLoadId(row.load?.internalId)} is already checked in.`);
        const begin = nextOccurrence(intent.time, new Date());
        const end = new Date(begin.getTime() + 30 * 60 * 1000);
        return propose({
          kind: 'move',
          stopId: stop._id,
          beginISO: begin.toISOString(),
          endISO: end.toISOString(),
          label: `Move ${displayLoadId(row.load?.internalId)} stop ${stop.sequenceNumber} to ${fmtT(begin)} – ${fmtT(end)}?`,
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
              `Several offers match: ${hit.ambiguous.map((o) => `${displayLoadId(o.load?.internalId)}`).join(', ')}.`,
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
        return propose({
          kind: intent.kind === 'accept_offer' ? 'accept' : 'decline',
          assignmentId: target._id,
          label: `${verb} the offer for ${displayLoadId(target.load?.internalId)}?`,
        });
      }
      case 'driver_history': {
        const hit = matchDriver(drivers ?? [], intent.driverQuery);
        if (!hit) return say('agent', `I don't know a driver called “${intent.driverQuery}”.`);
        if ('ambiguous' in hit)
          return say(
            'agent',
            `Several drivers match: ${hit.ambiguous.map((d) => `${d.firstName} ${d.lastName}`).join(', ')}. Say the full name.`,
          );
        const d = hit.match;
        // Day bounds are computed HERE — dispatch days are local-tz days
        // and only the device knows its zone; the server takes epoch ms.
        // dateEnd (inclusive) extends the window for range questions.
        const day = intent.date ? new Date(`${intent.date}T00:00:00`) : new Date();
        day.setHours(0, 0, 0, 0);
        const dayStartMs = day.getTime();
        const endDay = intent.dateEnd ? new Date(`${intent.dateEnd}T00:00:00`) : null;
        endDay?.setHours(0, 0, 0, 0);
        const dayEndMs = (endDay ? endDay.getTime() : dayStartMs) + 86_400_000;
        void (async () => {
          try {
            const loads = await convexClient.query(api.dispatchMobile.listDriverHistory, {
              driverId: d._id,
              dayStartMs,
              dayEndMs,
            });
            const name = `${d.firstName} ${d.lastName}`;
            const label = dayLabel(day, endDay);
            if (loads.length === 0) return say('agent', `${name} had no loads ${label}.`);
            const statusWord = (s: string) =>
              s === 'COMPLETED' ? 'completed' : s === 'IN_PROGRESS' ? 'in transit' : 'scheduled';
            const rows: LoadRow[] = loads.map((l) => ({
              load: displayLoadId(l.internalId),
              when: l.firstStopTime ?? null,
              loadId: l.loadId,
              tags: [
                l.tripNumber ? `Trip ${l.tripNumber}` : null,
                l.hcr ? `HCR ${l.hcr}` : null,
              ].filter((t): t is string => !!t),
              note: [l.customerName, statusWord(l.status)].filter(Boolean).join(' · '),
              warn: null,
            }));
            const spoken = loads
              .map((l) => `${displayLoadId(l.internalId)} ${l.customerName ?? ''} ${statusWord(l.status)}`)
              .join('; ');
            say('agent', `${name} — ${loads.length} load${loads.length === 1 ? '' : 's'} ${label}:`, {
              rows,
              speak: `${name} — ${loads.length} load${loads.length === 1 ? '' : 's'} ${label}: ${spoken}.`,
            });
          } catch (e) {
            say('agent', e instanceof Error ? e.message : 'Could not look that up.');
          }
        })();
        return;
      }
      case 'call_driver': {
        const hit = matchDriver(drivers ?? [], intent.driverQuery);
        if (!hit) return say('agent', `I don't know a driver called “${intent.driverQuery}”.`);
        if ('ambiguous' in hit)
          return say(
            'agent',
            `Several drivers match: ${hit.ambiguous.map((d) => `${d.firstName} ${d.lastName}`).join(', ')}. Say the full name.`,
          );
        const d = hit.match;
        if (!d.phone) return say('agent', `No phone number on file for ${d.firstName} ${d.lastName}.`);
        say('agent', `Calling ${d.firstName} ${d.lastName}…`);
        trackAction('voice_call_driver');
        void Linking.openURL(`tel:${d.phone}`);
        return;
      }
      case 'driver_location': {
        const hit = matchDriver(drivers ?? [], intent.driverQuery);
        if (!hit) return say('agent', `I don't know a driver called “${intent.driverQuery}”.`);
        if ('ambiguous' in hit)
          return say(
            'agent',
            `Several drivers match: ${hit.ambiguous.map((d) => `${d.firstName} ${d.lastName}`).join(', ')}. Say the full name.`,
          );
        const d = hit.match;
        void (async () => {
          try {
            const detail = await convexClient.query(api.dispatchMobile.getDriverDetail, {
              driverId: d._id,
            });
            if (!detail) return say('agent', `Couldn't load ${d.firstName}'s status.`);
            const name = `${d.firstName} ${d.lastName}`;
            const ping = detail.lastFixAt
              ? `last ping ${agoLabel(detail.lastFixAt)}`
              : 'no recent GPS data';
            const cur = detail.currentLoad;
            const rows: LoadRow[] = cur
              ? [
                  {
                    load: displayLoadId(cur.internalId),
                    when: null,
                    tags: [
                      cur.tripNumber ? `Trip ${cur.tripNumber}` : null,
                      cur.hcr ? `HCR ${cur.hcr}` : null,
                    ].filter((t): t is string => !!t),
                    note: cur.customerName,
                    warn: null,
                    loadId: cur._id as string,
                  },
                ]
              : [];
            say(
              'agent',
              `${name} — ${ping} · ${detail.hosLabel}${cur ? '. Current load:' : '. No active load.'}`,
              {
                rows: rows.length ? rows : undefined,
                speak: `${name}: ${ping}, ${detail.hosLabel}${
                  cur ? `, on load ${displayLoadId(cur.internalId)}` : ', no active load'
                }`,
              },
            );
          } catch (e) {
            say('agent', e instanceof Error ? e.message : 'Could not look that up.');
          }
        })();
        return;
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
          .map((x) => `${kindLabel(x.kind)}${x.loadInternalId ? ` on ${displayLoadId(x.loadInternalId)}` : ''}`)
          .join('; ');
        return say('agent', `${a.length} open alert${a.length === 1 ? '' : 's'}${high ? ` (${high} high)` : ''}: ${top}.`);
      }
      case 'clarify':
        // The pipeline holds the original command; the next utterance
        // answers this question and completes it — so reopen the mic
        // automatically once the question has been spoken/shown.
        return void say('agent', intent.question, { thenListen: true });
      case 'unknown':
      // Version-skew guard: a server-parsed intent kind this build doesn't
      // know must show help, never silently drop the turn.
      default:
        return say(
          'agent',
          'Try: “assign load 1001 to Marcus”, “move load 1001 to 3 pm”, “accept offer 1001”, “what loads did Marcus have yesterday / this week”, “what’s on the board”, “call Marcus”, “where’s Marcus”, or “any alerts”.',
        );
    }
  };

  // ── Capture pipeline ─────────────────────────────────────────────
  // The one mic session feeds two paths: on-device recognition shows
  // live partials (and is the offline fallback), while the persisted
  // clip goes to convex/voice.transcribeAndParse — Deepgram Nova-3 with
  // fleet keyterms + numerals, then Haiku intent. Server transcript
  // wins when available; any failure degrades to the on-device text
  // and the deterministic parser. Refs, not state: the listeners
  // subscribe once and must always see the latest values.
  const [thinking, setThinking] = useState(false);
  // Clarification continuation: when the agent asks for a missing piece,
  // this holds the ORIGINAL command so the next utterance completes it.
  const pendingClarifyRef = useRef<string | null>(null);
  // Auto-opened mic sessions (post-clarify relisten): silence gets ONE
  // silent reopen, then gives up quietly — never an error bubble. Only
  // manual taps earn "I didn't catch that".
  const autoOpenedRef = useRef(false);
  const autoRetriedRef = useRef(false);
  const audioUriRef = useRef<string | null>(null);
  const finalTranscriptRef = useRef('');
  // App-side endpointing (Perplexity-style): the OS recognizer's ~0.5s
  // endpointer is far too eager for dispatch commands, so we run the
  // session in continuous mode and end the turn ourselves — after a
  // comfortable silence hold once the user HAS spoken, or a generous
  // no-speech window when they haven't started yet.
  const segmentsRef = useRef<string[]>([]);
  const partialRef = useRef('');
  const lastActivityRef = useRef(0);
  const sessionStartRef = useRef(0);
  const listeningRef = useRef(false);
  const endpointTimerRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const endedRef = useRef(false);
  const processedRef = useRef(true);
  // Telemetry: why the mic session closed — the field data that tunes
  // the endpointing constants (silence hold vs hard cap vs give-up).
  const endReasonRef = useRef<string | null>(null);

  const process = async () => {
    if (processedRef.current) return;
    processedRef.current = true;
    setPartial('');
    const uri = audioUriRef.current;
    const deviceTranscript = finalTranscriptRef.current.trim();
    // One event per mic session — the dataset that tunes SILENCE_HOLD_MS
    // and NO_SPEECH_WAIT_MS on data instead of feel. No transcript text.
    trackAction('voice_turn', {
      end_reason: endReasonRef.current ?? 'os_end',
      session_ms: Date.now() - sessionStartRef.current,
      spoke: deviceTranscript.length > 0,
      chars: deviceTranscript.length,
      auto_opened: autoOpenedRef.current,
    });

    // Tier 2 voice confirmation: a leading yes/no while a confirm card
    // is up completes it immediately — no server round-trip. Anything
    // else falls through to normal parsing with the card still showing.
    const action = pendingActionRef.current;
    if (action && deviceTranscript) {
      const verdict = yesNo(deviceTranscript);
      if (verdict) {
        trackAction('voice_confirm', { method: 'voice_device', verdict, kind: action.kind });
        say('you', deviceTranscript);
        if (verdict === 'yes') void confirmRef.current();
        else {
          clearPending();
          say('agent', 'Cancelled.');
        }
        return;
      }
    }

    const pending = pendingClarifyRef.current;
    // Silence handling: auto-opened sessions retry once silently, then
    // stop quietly. Manual sessions get the spoken error.
    const onNoSpeech = () => {
      if (autoOpenedRef.current) {
        if (!autoRetriedRef.current) {
          autoRetriedRef.current = true;
          void startListeningRef.current();
        } else {
          autoOpenedRef.current = false;
        }
        return;
      }
      say('agent', "I didn't catch that — try again.");
    };
    const dispatchIntent = (transcript: string, intent: VoiceIntent) => {
      if (intent.kind === 'clarify') {
        // Chain: keep accumulating context until the command completes.
        pendingClarifyRef.current = pending ? `${pending} ${transcript}` : transcript;
      } else {
        pendingClarifyRef.current = null;
      }
      handleIntentRef.current(intent);
    };

    // Conversational context: the last few visible turns ride along so
    // follow-ups resolve. Captured from the pre-utterance feed (the
    // closure's `messages` predates the optimistic bubble below).
    // Rows carry the load details the bubble header omits — flatten them
    // back into the text so the NLU context keeps the numbers.
    const history = messages.slice(-8).map((m) => ({
      role: m.role,
      text: m.rows
        ? `${m.text} ${m.rows
            .map(
              (r) =>
                `${r.load}${r.tags.length ? ` (${r.tags.join(', ')})` : ''}${r.note ? ` ${r.note}` : ''}`,
            )
            .join('; ')}`
        : m.text,
    }));

    // Optimistic transcript: show the on-device text the instant the mic
    // closes; the (keyterm-corrected) server transcript swaps in when it
    // lands — no dead air while Deepgram runs.
    const shownId = deviceTranscript ? say('you', deviceTranscript) : null;

    if (uri && FileSystem) {
      setThinking(true);
      try {
        const audioBase64 = await FileSystem.readAsStringAsync(uri, { encoding: 'base64' });
        const serverStart = Date.now();
        const res = await transcribe({
          audioBase64,
          mimeType: mimeForUri(uri),
          ...(history.length > 0 ? { history } : {}),
          ...(pending ? { contextText: pending } : {}),
        });
        const serverMs = Date.now() - serverStart;
        const transcript = res.transcript || deviceTranscript;
        setThinking(false);
        if (!transcript) return onNoSpeech();
        autoOpenedRef.current = false;
        if (shownId == null) say('you', transcript);
        else if (transcript !== deviceTranscript) updateMessage(shownId, transcript);
        const act = pendingActionRef.current;
        if (act) {
          const verdict = yesNo(transcript);
          if (verdict) trackAction('voice_confirm', { method: 'voice_server', verdict, kind: act.kind });
          if (verdict === 'yes') return void confirmRef.current();
          if (verdict === 'no') {
            clearPending();
            return void say('agent', 'Cancelled.');
          }
        }
        const intent =
          (res.intent as VoiceIntent | null) ??
          parseCommand(pending ? `${pending} ${transcript}` : transcript);
        trackAction('voice_command', {
          nlu: res.intent ? 'haiku' : 'fallback_parser',
          intent_kind: intent.kind,
          transcript_source: res.transcript ? 'server' : 'device',
          server_ms: serverMs,
          history_turns: history.length,
          audio_kb: Math.round((audioBase64.length * 0.75) / 1024),
        });
        return dispatchIntent(transcript, intent);
      } catch {
        setThinking(false);
        // Server pipeline unavailable — fall through to on-device.
      }
    }
    if (!deviceTranscript) return onNoSpeech();
    autoOpenedRef.current = false;
    const deviceIntent = parseCommand(
      pending ? `${pending} ${deviceTranscript}` : deviceTranscript,
    );
    trackAction('voice_command', {
      nlu: 'device_parser',
      intent_kind: deviceIntent.kind,
      transcript_source: 'device',
      history_turns: history.length,
    });
    dispatchIntent(deviceTranscript, deviceIntent);
  };

  // Latest closures for the once-subscribed native listeners.
  const handleIntentRef = useRef(handleIntent);
  handleIntentRef.current = handleIntent;
  const processRef = useRef(process);
  processRef.current = process;

  useEffect(() => {
    if (!Speech) return;
    const subs = [
      Speech.addListener('result', (e: { results?: { transcript: string }[]; isFinal?: boolean }) => {
        const tr = e.results?.[0]?.transcript ?? '';
        lastActivityRef.current = Date.now();
        if (e.isFinal) {
          const t = tr.trim();
          if (t) {
            // Continuous sessions may emit cumulative or per-segment
            // finals depending on the engine — collapse cumulative ones.
            const joined = segmentsRef.current.join(' ').trim();
            if (joined && t.startsWith(joined)) segmentsRef.current = [t];
            else segmentsRef.current.push(t);
          }
          partialRef.current = '';
          setPartial(segmentsRef.current.join(' '));
        } else {
          partialRef.current = tr;
          setPartial(`${segmentsRef.current.join(' ')} ${tr}`.trim());
        }
      }),
      Speech.addListener('audioend', (e: { uri?: string | null }) => {
        audioUriRef.current = e.uri ?? null;
        // audioend can land after end — process as soon as both are true.
        if (endedRef.current) void processRef.current();
      }),
      Speech.addListener('end', () => {
        setListening(false);
        listeningRef.current = false;
        if (endpointTimerRef.current) {
          clearInterval(endpointTimerRef.current);
          endpointTimerRef.current = null;
        }
        finalTranscriptRef.current = `${segmentsRef.current.join(' ')} ${partialRef.current}`.trim();
        endedRef.current = true;
        if (audioUriRef.current) {
          void processRef.current();
        } else {
          // Grace period for a trailing audioend; then on-device fallback.
          setTimeout(() => void processRef.current(), 800);
        }
      }),
      Speech.addListener('error', (e: { error?: string; message?: string }) => {
        endReasonRef.current = e.error === 'no-speech' ? 'no_speech' : `error:${e.error ?? 'unknown'}`;
        setListening(false);
        listeningRef.current = false;
        if (endpointTimerRef.current) {
          clearInterval(endpointTimerRef.current);
          endpointTimerRef.current = null;
        }
        setPartial('');
        if (e.error === 'no-speech' && autoOpenedRef.current && !autoRetriedRef.current) {
          // Auto-opened mic heard nothing (OS closed it) — one quiet reopen.
          autoRetriedRef.current = true;
          void startListeningRef.current();
          return;
        }
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

  const startListening = async () => {
    if (!Speech || listening) return;
    SpeechSynth?.stop(); // never record our own TTS
    const perm = await Speech.requestPermissionsAsync();
    if (!perm.granted) {
      say('agent', 'Microphone permission is required for voice commands — enable it in Settings.');
      return;
    }
    setPartial('');
    audioUriRef.current = null;
    finalTranscriptRef.current = '';
    segmentsRef.current = [];
    partialRef.current = '';
    endedRef.current = false;
    processedRef.current = false;
    endReasonRef.current = null;
    sessionStartRef.current = Date.now();
    lastActivityRef.current = Date.now();
    setListening(true);
    listeningRef.current = true;
    Speech.start({
      lang: 'en-US',
      interimResults: true,
      // Continuous: the OS never unilaterally closes the mic; the
      // endpoint loop below decides when the turn is over.
      continuous: true,
      androidIntentOptions: {
        EXTRA_SPEECH_INPUT_COMPLETE_SILENCE_LENGTH_MILLIS: 2000,
        EXTRA_SPEECH_INPUT_POSSIBLY_COMPLETE_SILENCE_LENGTH_MILLIS: 2000,
      },
      // Persist the session audio for the server pipeline (wav on
      // Android, caf on iOS; int16 keeps the upload small).
      recordingOptions: { persist: true, outputEncoding: 'pcmFormatInt16', outputSampleRate: 16000 },
    });
    // App-side endpointing: silence hold after speech, patience before it.
    const SILENCE_HOLD_MS = 1800;
    const NO_SPEECH_WAIT_MS = autoOpenedRef.current ? 9000 : 15000;
    const HARD_CAP_MS = 45000;
    if (endpointTimerRef.current) clearInterval(endpointTimerRef.current);
    endpointTimerRef.current = setInterval(() => {
      if (!listeningRef.current) return;
      const now = Date.now();
      const spoken = segmentsRef.current.length > 0 || partialRef.current.trim().length > 0;
      const idle = now - lastActivityRef.current;
      const elapsed = now - sessionStartRef.current;
      if (elapsed > HARD_CAP_MS) {
        endReasonRef.current = 'hard_cap';
        Speech?.stop();
      } else if (spoken && idle > SILENCE_HOLD_MS) {
        endReasonRef.current = 'silence_hold';
        Speech?.stop();
      } else if (!spoken && elapsed > NO_SPEECH_WAIT_MS) {
        endReasonRef.current = 'no_speech';
        Speech?.stop();
      }
    }, 300);
  };
  // Latest closure for auto-relisten callbacks (TTS onDone fires from an
  // older render's closure).
  const startListeningRef = useRef(startListening);
  startListeningRef.current = startListening;

  const toggleMic = async () => {
    if (!Speech) return;
    if (listening) {
      endReasonRef.current = 'manual_stop';
      Speech.stop();
      return;
    }
    // Barge-in-lite: tapping while the agent talks cuts the speech AND
    // cancels its pending watchdog/reopen — the user's session owns the
    // mic now (startListening stops TTS itself).
    if (speakingRef.current) {
      trackAction('voice_tts', { via: 'interrupted' });
      ttsGenRef.current++;
      setSpeakingState(false);
    }
    autoOpenedRef.current = false;
    autoRetriedRef.current = false;
    await startListening();
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
      } else if (pending.kind === 'assignLoads') {
        const res = await assignLoadsWeb({
          loadIds: pending.loadIds as never,
          driverId: pending.driverId as never,
        });
        const ok = res.results.filter((r) => r.success);
        const failed = res.results.filter((r) => !r.success);
        say(
          'agent',
          failed.length === 0
            ? `Done — ${ok.length} load${ok.length === 1 ? '' : 's'} assigned.`
            : `${ok.length} assigned, ${failed.length} failed: ${failed
                .map((f) => `${f.internalId ? displayLoadId(f.internalId) : 'a load'} (${f.reason ?? 'unknown'})`)
                .join('; ')}`,
        );
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
      trackAction('voice_action_confirmed', {
        kind: pending.kind,
        ...(pending.kind === 'assignLoads' ? { load_count: pending.loadIds.length } : {}),
      });
    } catch (e) {
      say('agent', e instanceof Error ? e.message : 'That didn’t work — try again.');
    } finally {
      clearPending();
      setBusy(false);
    }
  };
  confirmRef.current = confirm;

  return (
    <View style={{ flex: 1, backgroundColor: colors.background, paddingTop: 70 }}>
      <View style={{ paddingHorizontal: 24 }}>
        <View style={{ flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' }}>
          <Text style={{ fontSize: typography['2xl'], fontWeight: typography.bold, color: colors.foreground }}>
            Voice
          </Text>
          <View style={{ flexDirection: 'row', alignItems: 'center', gap: 18 }}>
            {SpeechSynth && (
              <Pressable onPress={toggleMute} hitSlop={10}>
                <Ionicons
                  name={muted ? 'volume-mute-outline' : 'volume-high-outline'}
                  size={19}
                  color={muted ? colors.foregroundMuted : colors.primary}
                />
              </Pressable>
            )}
            {(messages.length > 0 || pending) && (
              <Pressable onPress={clearConversation} hitSlop={10} style={{ flexDirection: 'row', alignItems: 'center', gap: 5 }}>
                <Ionicons name="refresh-outline" size={16} color={colors.foregroundMuted} />
                <Text style={{ color: colors.foregroundMuted, fontSize: typography.sm }}>New chat</Text>
              </Pressable>
            )}
          </View>
        </View>
        <Text style={{ fontSize: typography.sm, color: colors.foregroundMuted, marginTop: 4 }}>
          Talk naturally — every action asks before it runs · {VOICE_BUILD} · {updateTag}
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
              <View style={{ marginTop: 8, gap: 12 }}>
                <View style={{ backgroundColor: colors.card, borderWidth: 1, borderColor: colors.border, borderRadius: borderRadius.lg, padding: 16 }}>
                  <Text style={{ color: colors.foreground, fontSize: typography.sm, fontWeight: typography.semibold, marginBottom: 6 }}>
                    Try saying
                  </Text>
                  {[
                    '“Trip 5, HCR 96036 — assign to Jorge tomorrow and Saturday”',
                    '“Assign trips 103 and 104 on 96036 to Marcus for Friday”',
                    '“What loads did Marcus have this week?”',
                    '“Where’s Marcus?” · “Call Marcus”',
                    '“Move load 1001 to 3 pm” · “Accept offer 1001”',
                    '“What’s on the board?” · “Any alerts?”',
                  ].map((t) => (
                    <Text key={t} style={{ color: colors.foregroundMuted, fontSize: typography.sm, lineHeight: 24 }}>
                      {t}
                    </Text>
                  ))}
                </View>
                <View style={{ backgroundColor: colors.card, borderWidth: 1, borderColor: colors.border, borderRadius: borderRadius.lg, padding: 16, gap: 10 }}>
                  <Text style={{ color: colors.foreground, fontSize: typography.sm, fontWeight: typography.semibold }}>
                    Hands-free
                  </Text>
                  {(
                    [
                      ['mic-outline', 'It keeps listening through pauses — take your time mid-sentence.'],
                      ['chatbubble-ellipses-outline', 'When it asks a question, just answer — the mic reopens itself. “Yes” confirms, “cancel” stops.'],
                      ['hand-left-outline', 'While it’s talking, tap the mic to jump in.'],
                    ] as const
                  ).map(([icon, text]) => (
                    <View key={icon} style={{ flexDirection: 'row', alignItems: 'center', gap: 10 }}>
                      <Ionicons name={icon} size={16} color={colors.primary} />
                      <Text style={{ color: colors.foregroundMuted, fontSize: typography.sm, flex: 1, lineHeight: 20 }}>
                        {text}
                      </Text>
                    </View>
                  ))}
                </View>
              </View>
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
                {m.rows && <RowList rows={m.rows} />}
              </View>
            ))}
            {pending && (
              <View style={{ backgroundColor: colors.card, borderWidth: 1, borderColor: colors.primary, borderRadius: borderRadius.lg, padding: 14, marginTop: 4 }}>
                <Text style={{ color: colors.foreground, fontSize: typography.base, fontWeight: typography.semibold }}>
                  {pending.label}
                </Text>
                {pending.kind === 'assignLoads' && (
                  <RowList
                    rows={pending.rows.map((r) => ({
                      load: r.load,
                      when: fmtDay(r.date),
                      tags: r.tags,
                      note: null,
                      warn: r.current
                        ? `Currently assigned to ${r.current} — confirming reassigns it.`
                        : null,
                      loadId: r.loadId,
                    }))}
                  />
                )}
                <View style={{ flexDirection: 'row', gap: 10, marginTop: 12 }}>
                  <Pressable
                    disabled={busy}
                    onPress={() => {
                      trackAction('voice_confirm', { method: 'button', verdict: 'yes', kind: pending.kind });
                      void confirm();
                    }}
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
                    onPress={() => {
                      trackAction('voice_confirm', { method: 'button', verdict: 'no', kind: pending.kind });
                      clearPending();
                    }}
                    style={{ flex: 1, alignItems: 'center', borderWidth: 1, borderColor: colors.border, paddingVertical: 10, borderRadius: borderRadius.md }}
                  >
                    <Text style={{ color: colors.foregroundMuted, fontSize: typography.sm, fontWeight: typography.semibold }}>Cancel</Text>
                  </Pressable>
                </View>
                <View style={{ flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 6, marginTop: 10 }}>
                  <Ionicons name="mic-outline" size={13} color={colors.foregroundMuted} />
                  <Text style={{ color: colors.foregroundMuted, fontSize: typography.xs }}>
                    Hands-free: say “yes” or “cancel” — or ask for a change
                  </Text>
                </View>
              </View>
            )}
          </ScrollView>

          <View style={{ alignItems: 'center', paddingBottom: 22, paddingTop: 6 }}>
            {(() => {
              // One visual state machine for the whole voice loop —
              // listening wins (mic is hot), then thinking, then speaking.
              const micState = listening ? 'listening' : thinking ? 'thinking' : speaking ? 'speaking' : 'idle';
              return (
                <>
                  {(micState !== 'idle' || partial) && (
                    <Text
                      style={{ color: colors.foregroundMuted, fontSize: typography.sm, marginBottom: 10, paddingHorizontal: 32, textAlign: 'center' }}
                      numberOfLines={3}
                    >
                      {micState === 'thinking'
                        ? 'Thinking…'
                        : micState === 'speaking'
                          ? 'Speaking — tap the mic to jump in'
                          : partial || 'Listening — take your time'}
                    </Text>
                  )}
                  <Animated.View style={{ transform: [{ scale: pulse }] }}>
                    <Pressable
                      disabled={micState === 'thinking'}
                      onPress={() => void toggleMic()}
                      style={{
                        width: 72,
                        height: 72,
                        borderRadius: 36,
                        alignItems: 'center',
                        justifyContent: 'center',
                        backgroundColor:
                          micState === 'listening'
                            ? colors.destructive
                            : micState === 'idle'
                              ? colors.primary
                              : colors.card,
                        borderWidth: micState === 'thinking' || micState === 'speaking' ? 1 : 0,
                        borderColor: micState === 'speaking' ? colors.primary : colors.border,
                      }}
                    >
                      {micState === 'thinking' ? (
                        <ActivityIndicator color={colors.primary} />
                      ) : (
                        <Ionicons
                          name={micState === 'listening' ? 'stop' : 'mic'}
                          size={30}
                          color={micState === 'speaking' ? colors.primary : colors.primaryForeground}
                        />
                      )}
                    </Pressable>
                  </Animated.View>
                  <Text style={{ color: colors.foregroundMuted, fontSize: typography.xs, marginTop: 8 }}>
                    {micState === 'idle'
                      ? 'Tap to talk'
                      : micState === 'listening'
                        ? 'Tap to stop'
                        : micState === 'speaking'
                          ? 'Tap to jump in'
                          : ' '}
                  </Text>
                </>
              );
            })()}
          </View>
        </>
      )}
    </View>
  );
}
