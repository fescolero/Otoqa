/**
 * useVoiceClip — one-shot mic capture for server-side STT (Phase 3).
 *
 * Wraps expo-speech-recognition's recording session: live partials for
 * feedback, persisted clip (wav Android / caf iOS, int16 16 kHz)
 * delivered to `onClip` once the session ends. Mirrors the Voice tab's
 * device-validated flow; both native modules are lazy-required so an
 * OTA onto an older APK degrades to `available: false` instead of
 * crashing.
 *
 * onClip receives the base64 clip + mime type, or null when no usable
 * recording was captured (denied permission, no speech, old build) —
 * callers decide their own fallback.
 */
import { useEffect, useRef, useState } from 'react';

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
/* eslint-enable @typescript-eslint/no-var-requires */

const mimeForUri = (uri: string) =>
  uri.toLowerCase().endsWith('.caf') ? 'audio/x-caf' : 'audio/wav';

export function useVoiceClip(
  onClip: (clip: { audioBase64: string; mimeType: string } | null, deviceTranscript: string) => void,
) {
  const [listening, setListening] = useState(false);
  const [partial, setPartial] = useState('');
  const audioUriRef = useRef<string | null>(null);
  const finalTranscriptRef = useRef('');
  const endedRef = useRef(false);
  const processedRef = useRef(true);
  const onClipRef = useRef(onClip);
  onClipRef.current = onClip;

  const process = async () => {
    if (processedRef.current) return;
    processedRef.current = true;
    setPartial('');
    const uri = audioUriRef.current;
    const deviceTranscript = finalTranscriptRef.current.trim();
    if (uri && FileSystem) {
      try {
        const audioBase64 = await FileSystem.readAsStringAsync(uri, { encoding: 'base64' });
        return onClipRef.current({ audioBase64, mimeType: mimeForUri(uri) }, deviceTranscript);
      } catch {
        // Fall through — clip unreadable, report transcript only.
      }
    }
    onClipRef.current(null, deviceTranscript);
  };
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
        if (endedRef.current) void processRef.current();
      }),
      Speech.addListener('end', () => {
        setListening(false);
        endedRef.current = true;
        if (audioUriRef.current) {
          void processRef.current();
        } else {
          setTimeout(() => void processRef.current(), 800);
        }
      }),
      Speech.addListener('error', (e: { error?: string }) => {
        setListening(false);
        setPartial('');
        if (e.error === 'no-speech' || e.error === 'aborted') return;
        endedRef.current = true;
        void processRef.current();
      }),
    ];
    return () => subs.forEach((s) => s.remove());
  }, []);

  const toggle = async () => {
    if (!Speech) return;
    if (listening) {
      Speech.stop();
      return;
    }
    const perm = await Speech.requestPermissionsAsync();
    if (!perm.granted) {
      onClipRef.current(null, '');
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
      recordingOptions: { persist: true, outputEncoding: 'pcmFormatInt16', outputSampleRate: 16000 },
    });
  };

  return { available: !!Speech, listening, partial, toggle };
}
