import OtoqaShiftStatusModule from './OtoqaShiftStatusModule';

/**
 * Lock-screen shift surface — one JS API over two native presentations:
 *
 *   Android: ongoing silent notification with a native chronometer
 *            (ticks in the OS; zero updates needed for the timer).
 *   iOS:     ActivityKit Live Activity (lock screen + Dynamic Island),
 *            timer rendered natively from the shift start Date.
 *
 * Every function is fire-and-forget safe: on binaries without the native
 * module (pre-1.6.0 builds, Expo Go) or when the OS declines (notifications
 * blocked, Live Activities disabled), calls resolve false instead of
 * throwing. Callers should NOT gate business logic on these results —
 * the surface is a mirror of shift state, never the owner of it.
 *
 * Idempotence lives HERE, not at the call sites: startShiftStatus is
 * called from every resume path (foreground mounts, FCM wakes, motion
 * wakes), so a start for an already-active shift must be a no-op that
 * PRESERVES the current granular status line ("Stop 3 of 5 — checked
 * in") instead of resetting it to a generic one. Likewise identical
 * consecutive status lines are deduped so back-to-back events don't
 * burn the iOS Live Activity update budget. This state dies with the JS
 * runtime — which is the same lifetime as the Kotlin module's fields,
 * and the Swift side independently keeps an existing same-start
 * activity alive across process restarts.
 */

let activeStartedAtMs: number | null = null;
let lastStatusLine: string | null = null;

/** Show the surface. startedAtMs anchors the elapsed-time chronometer. */
export async function startShiftStatus(
  startedAtMs: number,
  statusLine: string,
): Promise<boolean> {
  try {
    if (!Number.isFinite(startedAtMs) || startedAtMs <= 0) return false;

    // Same shift already showing in this runtime → nothing to do. Keeps
    // resume paths from clobbering the granular stop status with the
    // generic re-assert line.
    if (activeStartedAtMs === startedAtMs) return true;

    const ok = (await OtoqaShiftStatusModule?.startShiftStatus(startedAtMs, statusLine)) ?? false;
    if (ok) {
      activeStartedAtMs = startedAtMs;
      lastStatusLine = statusLine;
    }
    return ok;
  } catch (error) {
    console.warn('[ShiftStatus] start failed:', error);
    return false;
  }
}

/** Update the one-line trip/stop status. No-op if the surface isn't up. */
export async function updateShiftStatus(statusLine: string): Promise<boolean> {
  try {
    if (statusLine === lastStatusLine) return true; // dedupe identical updates
    const ok = (await OtoqaShiftStatusModule?.updateShiftStatus(statusLine)) ?? false;
    if (ok) lastStatusLine = statusLine;
    return ok;
  } catch (error) {
    console.warn('[ShiftStatus] update failed:', error);
    return false;
  }
}

/** Tear the surface down. Safe to call when nothing is showing. */
export async function endShiftStatus(): Promise<boolean> {
  activeStartedAtMs = null;
  lastStatusLine = null;
  try {
    return (await OtoqaShiftStatusModule?.endShiftStatus()) ?? false;
  } catch (error) {
    console.warn('[ShiftStatus] end failed:', error);
    return false;
  }
}
