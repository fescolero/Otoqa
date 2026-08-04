/**
 * Session-derived HOS ESTIMATE (plan D11) — pure math over driver shift
 * sessions, no ctx. This is an approximation, always labeled "est" in
 * the UI: sessions measure ON-DUTY time, not driving time, so the
 * 11-hour driving limit and 30-minute-break rule are out of scope. The
 * eventual source of truth is an ELD integration.
 *
 * Rules approximated (US property-carrying):
 *  - 14-hour on-duty window from shift start (windowRemainingHours)
 *  - 70-hour / 8-day cycle from summed session active time
 *  - 10-hour off-duty reset detection between shifts
 */

export const HOS_WINDOW_HOURS = 14;
export const HOS_CYCLE_HOURS = 70;
export const HOS_RESET_HOURS = 10;
export const HOS_CYCLE_DAYS = 8;

const HOUR_MS = 3_600_000;
const round1 = (n: number) => Math.round(n * 10) / 10;

export interface SessionLite {
  startedAt: number;
  endedAt?: number | null;
  /** Computed by the driver app on session end; falls back to wall time. */
  totalActiveMinutes?: number | null;
  status: 'active' | 'completed';
}

export interface HosEstimate {
  onShift: boolean;
  /** Hours into the current shift (null when off shift). */
  onDutyHours: number | null;
  /** 14h window remaining, clamped at 0 (null when off shift). */
  windowRemainingHours: number | null;
  /** Summed active hours over the trailing 8 days, live shift included. */
  cycleUsedHours: number;
  cycleRemainingHours: number;
  /** Hours since the last shift ended (null on shift / no history). */
  offDutyHours: number | null;
  /** Off-shift only: has the 10h reset elapsed? */
  restReset: boolean | null;
}

export function estimateHos(sessions: SessionLite[], now: number): HosEstimate {
  const cutoff = now - HOS_CYCLE_DAYS * 24 * HOUR_MS;
  const active = sessions.find((s) => s.status === 'active') ?? null;

  let cycleMs = 0;
  for (const s of sessions) {
    if (s.status !== 'completed') continue;
    const end = s.endedAt ?? s.startedAt;
    if (end <= cutoff) continue;
    cycleMs +=
      s.totalActiveMinutes != null
        ? s.totalActiveMinutes * 60_000
        : Math.max(0, end - s.startedAt);
  }
  if (active) cycleMs += Math.max(0, now - active.startedAt);
  const cycleUsedHours = round1(cycleMs / HOUR_MS);
  const cycleRemainingHours = round1(Math.max(0, HOS_CYCLE_HOURS - cycleUsedHours));

  if (active) {
    const onDutyMs = Math.max(0, now - active.startedAt);
    return {
      onShift: true,
      onDutyHours: round1(onDutyMs / HOUR_MS),
      windowRemainingHours: round1(Math.max(0, HOS_WINDOW_HOURS * HOUR_MS - onDutyMs) / HOUR_MS),
      cycleUsedHours,
      cycleRemainingHours,
      offDutyHours: null,
      restReset: null,
    };
  }

  const lastEnd = sessions
    .map((s) => s.endedAt)
    .filter((e): e is number => e != null)
    .sort((a, b) => b - a)[0];
  const offMs = lastEnd != null ? Math.max(0, now - lastEnd) : null;
  return {
    onShift: false,
    onDutyHours: null,
    windowRemainingHours: null,
    cycleUsedHours,
    cycleRemainingHours,
    offDutyHours: offMs != null ? round1(offMs / HOUR_MS) : null,
    restReset: offMs != null ? offMs >= HOS_RESET_HOURS * HOUR_MS : null,
  };
}

/** One-line chip text, always suffixed (est). */
export function hosChipLabel(h: HosEstimate): string {
  if (h.onShift) {
    return `On shift ${h.onDutyHours}h · ~${h.windowRemainingHours}h window left (est)`;
  }
  if (h.offDutyHours == null) return 'No recent shifts';
  return h.restReset
    ? `Off duty ${h.offDutyHours}h · rested (est)`
    : `Off duty ${h.offDutyHours}h · reset at ${HOS_RESET_HOURS}h (est)`;
}
