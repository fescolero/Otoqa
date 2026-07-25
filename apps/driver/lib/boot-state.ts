import { createMMKV } from 'react-native-mmkv';
import { log } from './log';

// ============================================================================
// BOOT-STATE MMKV — dedicated instance for the Phase 3 BOOT_COMPLETED receiver
// ============================================================================
//
// WHY A SEPARATE INSTANCE FROM THE PING QUEUE
//
// The ping queue is optionally encrypted (AES-256 key in SecureStore). But
// Android's BroadcastReceiver for `ACTION_BOOT_COMPLETED` runs BEFORE the
// user unlocks the device for the first time after boot — the phase where
// Keystore-backed secrets are not yet available. If the native side can't
// read its encryption key, it can't decrypt the store to learn whether
// tracking was active when the device rebooted. That's the signal Phase 3
// needs to decide whether to restart the foreground service.
//
// So this instance stays unencrypted on purpose, and the shape is
// deliberately narrow: NO location data, NO PII, just a boolean plus the
// minimum ids needed to reconstruct tracking state. Think of it as a tiny
// hint flag, not a general-purpose store.
//
// NATIVE READ CONTRACT (Phase 3)
//
// The Phase 3 BroadcastReceiver reads this MMKV file directly via Tencent's
// native MMKV API (not through JS — JS isn't running at `BOOT_COMPLETED`).
// The shape and instance id below are therefore a cross-boundary contract:
// changing either requires a matching native change + an `expo.runtimeVersion`
// bump so older native binaries don't receive a JS bundle that writes an
// incompatible shape.
//
// PII CHECK
//
// `driverId` is a Convex id (opaque random string). `sessionId` is the same.
// Neither is PII on its own — they're join keys. Do NOT extend this shape
// with phone numbers, names, coordinates, or any other personal info without
// first revisiting the "unencrypted-on-purpose" premise above.
// ============================================================================

const lg = log('BootState');

const BOOT_STATE_MMKV_ID = 'otoqa-boot-state';
const KEY_STATE = 'tracking_state';

// Dedicated MMKV instance. No encryption — see comment above.
const mmkv = createMMKV({ id: BOOT_STATE_MMKV_ID });

export interface BootState {
  isActive: boolean;
  sessionId: string | null;
  driverId: string | null;
  lastWriteAt: number;
}

/**
 * Write the current tracking state to the boot-state store. Called from
 * start/stopLocationTracking so the native BOOT_COMPLETED receiver has a
 * fresh hint to reason from after a reboot.
 *
 * Never throws — a boot-state write failure must not prevent tracking from
 * starting. Worst case the receiver sees a slightly stale state and skips
 * the auto-restart; the user opens the app and tracking resumes normally.
 */
export function setBootState(
  partial: Omit<BootState, 'lastWriteAt'>,
): void {
  try {
    const state: BootState = {
      ...partial,
      lastWriteAt: Date.now(),
    };
    mmkv.set(KEY_STATE, JSON.stringify(state));
  } catch (err) {
    lg.warn(`setBootState failed (non-fatal): ${err}`);
  }
}

/**
 * Clear the boot-state store. Called from stopLocationTracking on a clean
 * shutdown — distinct from writing `isActive: false` because the native
 * receiver treats "no key present" as "app never tracked, do nothing."
 */
export function clearBootState(): void {
  try {
    mmkv.remove(KEY_STATE);
  } catch (err) {
    lg.warn(`clearBootState failed (non-fatal): ${err}`);
  }
}

/**
 * Read the boot-state store. Primarily for diagnostics + tests — the
 * native receiver has its own read path (direct MMKV native API). Returns
 * null if no state has ever been written.
 */
export function getBootState(): BootState | null {
  try {
    const raw = mmkv.getString(KEY_STATE);
    if (!raw) return null;
    return JSON.parse(raw) as BootState;
  } catch (err) {
    lg.warn(`getBootState read failed: ${err}`);
    return null;
  }
}
