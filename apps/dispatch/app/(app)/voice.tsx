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
import { useAction, useConvex, useMutation, useQuery } from 'convex/react';
import { api } from '@otoqa/convex-client';
import { borderRadius, colors, typography } from '@otoqa/mobile-core';
import {
  matchByRef,
  matchDriver,
  nextOccurrence,
  parseCommand,
  type VoiceIntent,
} from '../../lib/voice/parser';
import { displayLoadId } from '../../lib/format';

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
} | null = null;
try {
  SpeechSynth = require('expo-speech');
} catch {
  SpeechSynth = null;
}
/* eslint-enable @typescript-eslint/no-var-requires */

const mimeForUri = (uri: string) =>
  uri.toLowerCase().endsWith('.caf') ? 'audio/x-caf' : 'audio/wav';

type Msg = { id: number; role: 'you' | 'agent'; text: string };
type Pending =
  | { kind: 'assign'; assignmentId: string; driverId: string; label: string }
  | { kind: 'move'; stopId: string; beginISO: string; endISO: string; label: string }
  | { kind: 'accept' | 'decline'; assignmentId: string; label: string };

/** Bump on every voice-feature change — shown in the header so a glance
 * tells which bundle is actually running (expo-updates rolls back bad
 * OTAs silently; this makes delivery verifiable). */
const VOICE_BUILD = 'v7';
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
  const adjustWindow = useMutation(api.dispatchMobile.adjustStopWindow);
  const acceptOffer = useMutation(api.dispatchMobile.acceptOffer);
  const declineOffer = useMutation(api.dispatchMobile.declineOffer);
  const transcribe = useAction(api.voice.transcribeAndParse);
  const convexClient = useConvex();

  const [messages, setMessages] = useState<Msg[]>([]);
  const [pending, setPending] = useState<Pending | null>(null);
  const [listening, setListening] = useState(false);
  const [partial, setPartial] = useState('');
  const [busy, setBusy] = useState(false);
  const nextId = useRef(1);
  const scrollRef = useRef<ScrollView>(null);

  // TTS mute — ref-mirrored so async flows always read the live value.
  const [muted, setMuted] = useState(false);
  const mutedRef = useRef(false);
  const toggleMute = () => {
    setMuted((m) => {
      const next = !m;
      mutedRef.current = next;
      if (next) SpeechSynth?.stop();
      return next;
    });
  };

  /**
   * Speak an agent reply aloud (unless muted / module absent). thenListen
   * reopens the mic AFTER speech finishes — speaking first would let the
   * TTS bleed into the recording.
   */
  const speakReply = (text: string, thenListen?: boolean) => {
    const after = thenListen ? () => void startListeningRef.current() : undefined;
    if (!mutedRef.current && SpeechSynth) {
      SpeechSynth.stop();
      SpeechSynth.speak(text, { language: 'en-US', onDone: after, onError: after });
    } else if (after) {
      setTimeout(after, 600);
    }
  };

  const say = (role: 'you' | 'agent', text: string, opts?: { thenListen?: boolean }) => {
    const id = nextId.current++;
    setMessages((m) => [...m, { id, role, text }]);
    if (role === 'agent') speakReply(text, opts?.thenListen);
    return id;
  };

  /** Optimistic-transcript swap: refine a shown message in place. */
  const updateMessage = (id: number, text: string) =>
    setMessages((m) => m.map((msg) => (msg.id === id ? { ...msg, text } : msg)));

  // Fresh start: wipes the feed (which IS the conversational context sent
  // to the server), any pending confirm card, the clarify bridge, and any
  // speech in progress. The next utterance parses with zero context.
  const clearConversation = () => {
    if (listening) Speech?.stop();
    SpeechSynth?.stop();
    setMessages([]);
    setPending(null);
    setPartial('');
    pendingClarifyRef.current = null;
  };

  const handleIntent = (intent: VoiceIntent) => {
    switch (intent.kind) {
      case 'assign': {
        const loadHit = matchByRef(rows ?? [], (r) => r.load?.internalId, intent.loadRef);
        if (!loadHit) return say('agent', `I can't find load ${intent.loadRef} on the board.`);
        if ('ambiguous' in loadHit)
          return say(
            'agent',
            `Several loads match: ${loadHit.ambiguous.map((r) => `#${displayLoadId(r.load?.internalId)}`).join(', ')}. Say the full number.`,
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
          label: `Assign #${displayLoadId(row.load?.internalId)} to ${d.firstName} ${d.lastName}?`,
        });
      }
      case 'move_window': {
        const loadHit = matchByRef(rows ?? [], (r) => r.load?.internalId, intent.loadRef);
        if (!loadHit) return say('agent', `I can't find load ${intent.loadRef} on the board.`);
        if ('ambiguous' in loadHit)
          return say(
            'agent',
            `Several loads match: ${loadHit.ambiguous.map((r) => `#${displayLoadId(r.load?.internalId)}`).join(', ')}. Say the full number.`,
          );
        const row = loadHit.match;
        const stop = row.stops.filter((s) => !s.checkedInAt)[0];
        if (!stop) return say('agent', `Every stop on #${displayLoadId(row.load?.internalId)} is already checked in.`);
        const begin = nextOccurrence(intent.time, new Date());
        const end = new Date(begin.getTime() + 30 * 60 * 1000);
        return setPending({
          kind: 'move',
          stopId: stop._id,
          beginISO: begin.toISOString(),
          endISO: end.toISOString(),
          label: `Move #${displayLoadId(row.load?.internalId)} stop ${stop.sequenceNumber} to ${fmtT(begin)} – ${fmtT(end)}?`,
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
              `Several offers match: ${hit.ambiguous.map((o) => `#${displayLoadId(o.load?.internalId)}`).join(', ')}.`,
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
          label: `${verb} the offer for #${displayLoadId(target.load?.internalId)}?`,
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
            const items = loads
              .map(
                (l) =>
                  `#${displayLoadId(l.internalId)}${l.customerName ? ` ${l.customerName}` : ''} (${
                    l.status === 'COMPLETED' ? 'completed' : l.status === 'IN_PROGRESS' ? 'in transit' : 'scheduled'
                  })`,
              )
              .join('; ');
            say('agent', `${name} — ${loads.length} load${loads.length === 1 ? '' : 's'} ${label}: ${items}.`);
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
          .map((x) => `${kindLabel(x.kind)}${x.loadInternalId ? ` on #${x.loadInternalId}` : ''}`)
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
          'Try: “assign load 1001 to Marcus”, “move load 1001 to 3 pm”, “accept offer 1001”, “what loads did Marcus have yesterday / this week”, “what’s on the board”, or “any alerts”.',
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
  const audioUriRef = useRef<string | null>(null);
  const finalTranscriptRef = useRef('');
  const endedRef = useRef(false);
  const processedRef = useRef(true);

  const process = async () => {
    if (processedRef.current) return;
    processedRef.current = true;
    setPartial('');
    const uri = audioUriRef.current;
    const deviceTranscript = finalTranscriptRef.current.trim();

    const pending = pendingClarifyRef.current;
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
    const history = messages.slice(-8).map((m) => ({ role: m.role, text: m.text }));

    // Optimistic transcript: show the on-device text the instant the mic
    // closes; the (keyterm-corrected) server transcript swaps in when it
    // lands — no dead air while Deepgram runs.
    const shownId = deviceTranscript ? say('you', deviceTranscript) : null;

    if (uri && FileSystem) {
      setThinking(true);
      try {
        const audioBase64 = await FileSystem.readAsStringAsync(uri, { encoding: 'base64' });
        const res = await transcribe({
          audioBase64,
          mimeType: mimeForUri(uri),
          ...(history.length > 0 ? { history } : {}),
          ...(pending ? { contextText: pending } : {}),
        });
        const transcript = res.transcript || deviceTranscript;
        setThinking(false);
        if (!transcript) return void say('agent', "I didn't catch that — try again.");
        if (shownId == null) say('you', transcript);
        else if (transcript !== deviceTranscript) updateMessage(shownId, transcript);
        return dispatchIntent(
          transcript,
          (res.intent as VoiceIntent | null) ??
            parseCommand(pending ? `${pending} ${transcript}` : transcript),
        );
      } catch {
        setThinking(false);
        // Server pipeline unavailable — fall through to on-device.
      }
    }
    if (!deviceTranscript) return void say('agent', "I didn't catch that — try again.");
    dispatchIntent(
      deviceTranscript,
      parseCommand(pending ? `${pending} ${deviceTranscript}` : deviceTranscript),
    );
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
        if (e.isFinal) finalTranscriptRef.current = tr;
        else setPartial(tr);
      }),
      Speech.addListener('audioend', (e: { uri?: string | null }) => {
        audioUriRef.current = e.uri ?? null;
        // audioend can land after end — process as soon as both are true.
        if (endedRef.current) void processRef.current();
      }),
      Speech.addListener('end', () => {
        setListening(false);
        endedRef.current = true;
        if (audioUriRef.current) {
          void processRef.current();
        } else {
          // Grace period for a trailing audioend; then on-device fallback.
          setTimeout(() => void processRef.current(), 800);
        }
      }),
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
    endedRef.current = false;
    processedRef.current = false;
    setListening(true);
    Speech.start({
      lang: 'en-US',
      interimResults: true,
      continuous: false,
      // Persist the session audio for the server pipeline (wav on
      // Android, caf on iOS; int16 keeps the upload small).
      recordingOptions: { persist: true, outputEncoding: 'pcmFormatInt16', outputSampleRate: 16000 },
    });
  };
  // Latest closure for auto-relisten callbacks (TTS onDone fires from an
  // older render's closure).
  const startListeningRef = useRef(startListening);
  startListeningRef.current = startListening;

  const toggleMic = async () => {
    if (!Speech) return;
    if (listening) {
      Speech.stop();
      return;
    }
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
          Speak a command — every action asks before it runs · {VOICE_BUILD} · {updateTag}
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
                Try:{'\n'}“Assign load 1001 to Marcus”{'\n'}“Move load 1001 to 3 pm”{'\n'}“Accept offer 1001”{'\n'}“What loads did Marcus have this week?”{'\n'}“What’s on the board?” · “Any alerts?”
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
            {(listening || partial || thinking) && (
              <Text style={{ color: colors.foregroundMuted, fontSize: typography.sm, marginBottom: 10, paddingHorizontal: 32, textAlign: 'center' }} numberOfLines={2}>
                {thinking ? 'Thinking…' : partial || 'Listening…'}
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
