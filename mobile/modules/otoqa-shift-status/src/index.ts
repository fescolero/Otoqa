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
 */

/** Show the surface. startedAtMs anchors the elapsed-time chronometer. */
export async function startShiftStatus(
  startedAtMs: number,
  statusLine: string,
): Promise<boolean> {
  try {
    return (await OtoqaShiftStatusModule?.startShiftStatus(startedAtMs, statusLine)) ?? false;
  } catch (error) {
    console.warn('[ShiftStatus] start failed:', error);
    return false;
  }
}

/** Update the one-line trip/stop status. No-op if the surface isn't up. */
export async function updateShiftStatus(statusLine: string): Promise<boolean> {
  try {
    return (await OtoqaShiftStatusModule?.updateShiftStatus(statusLine)) ?? false;
  } catch (error) {
    console.warn('[ShiftStatus] update failed:', error);
    return false;
  }
}

/** Tear the surface down. Safe to call when nothing is showing. */
export async function endShiftStatus(): Promise<boolean> {
  try {
    return (await OtoqaShiftStatusModule?.endShiftStatus()) ?? false;
  } catch (error) {
    console.warn('[ShiftStatus] end failed:', error);
    return false;
  }
}

/** True when this binary contains the native module (1.6.0+ builds). */
export function isShiftStatusAvailable(): boolean {
  return OtoqaShiftStatusModule != null;
}
