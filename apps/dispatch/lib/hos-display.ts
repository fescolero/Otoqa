/**
 * Presentation rules for the HOS estimate (D11).
 *
 * Pure and react-native-free so it can be unit-tested in the node project —
 * `ui.tsx` re-exports these for screens.
 */

/** The shape `hosForDriver` returns; only the fields display logic reads. */
export interface HosLike {
  onShift: boolean;
  onDutyHours: number | null;
  windowRemainingHours: number | null;
  cycleUsedHours: number;
  cycleRemainingHours: number;
  offDutyHours: number | null;
}

/**
 * True when the estimate rests on at least one real shift.
 *
 * This exists because the empty case is dangerous rather than merely blank:
 * with no sessions, `estimateHos` returns a *full* 70h cycle and a null
 * offDuty — which `hosChipLabel` reports as "No recent shifts". Rendered
 * without this check, a driver we have no data on draws a full green bar,
 * i.e. a confident claim that they're fully rested. Absence must read as
 * absence.
 */
export function hasHosSignal(hos: HosLike): boolean {
  return hos.onShift || hos.offDutyHours != null || hos.cycleUsedHours > 0;
}

/**
 * What the bar measures, and against what ceiling.
 *
 * On shift, the 14h window is the number that decides whether a driver can
 * take another load today. Off shift there is no window, so it falls back to
 * the 70h cycle — a different kind of fact, which is why the label says so
 * rather than leaving "6h" and "70h" looking equivalent.
 */
export function hosBarValue(hos: HosLike): {
  remaining: number;
  max: number;
  label: string;
} {
  if (hos.onShift) {
    const remaining = hos.windowRemainingHours ?? 0;
    return { remaining, max: 14, label: `${Math.round(remaining)}h left` };
  }
  const remaining = hos.cycleRemainingHours;
  return { remaining, max: 70, label: `${Math.round(remaining)}h cycle` };
}

/** Hours-remaining thresholds, not a percentage — a 70h cycle must not read
 *  "green" when only 2h of it are left. */
export type HosTone = 'danger' | 'warning' | 'ok';

export function hosTone(remaining: number): HosTone {
  if (remaining < 2) return 'danger';
  if (remaining < 4) return 'warning';
  return 'ok';
}
