/**
 * Zero-tap SMS OTP (Android only) — thin, guarded wrapper around the local
 * expo-sms-retriever native module (modules/expo-sms-retriever).
 *
 * Guarded because the module only exists in builds compiled after it was
 * added: on iOS, on older Android binaries receiving this JS over the air,
 * or if Play services declines, everything here no-ops and the verify
 * screen falls back to the keyboard's one-tap autofill chip.
 *
 * Zero-tap additionally requires the SMS body to end with the app's
 * 11-char signing hash (see AppSignatureHelper / getSmsAppSignatures) —
 * append the production hash to the Clerk SMS template. Messages without
 * the hash are never delivered to the listener.
 */
import { Platform } from 'react-native';

interface SmsRetrieverNativeModule {
  startListener(): Promise<boolean>;
  stopListener(): Promise<void>;
  getAppSignatures(): Promise<string[]>;
  addListener(
    event: 'onSmsReceived',
    cb: (e: { message?: string; timeout?: boolean }) => void,
  ): { remove(): void };
}

function loadModule(): SmsRetrieverNativeModule | null {
  if (Platform.OS !== 'android') return null;
  try {
    const { requireNativeModule } = require('expo-modules-core');
    return requireNativeModule('ExpoSmsRetriever') as SmsRetrieverNativeModule;
  } catch {
    return null; // running in a binary built before the module existed
  }
}

/**
 * Start listening for the verification SMS; calls onCode with the first
 * 4–8 digit run found in a delivered message. Returns a cleanup function —
 * always safe to call, even where the module is unavailable.
 */
export function startSmsOtpListener(onCode: (code: string) => void): () => void {
  const native = loadModule();
  if (!native) return () => {};

  const sub = native.addListener('onSmsReceived', (event) => {
    if (!event.message) return; // timeout — window closed, fall back to one-tap
    const match = /\b(\d{4,8})\b/.exec(event.message);
    if (match) onCode(match[1]);
  });

  native.startListener().catch(() => {});

  return () => {
    sub.remove();
    native.stopListener().catch(() => {});
  };
}

/** The running build's SMS Retriever hash(es) — for the Clerk SMS template. */
export async function getSmsAppSignatures(): Promise<string[]> {
  const native = loadModule();
  if (!native) return [];
  try {
    return await native.getAppSignatures();
  } catch {
    return [];
  }
}
