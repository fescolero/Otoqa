/**
 * On-time delivery — the ONE place the rule lives.
 *
 * A delivery stop is on time when the truck arrived no later than the
 * appointment window's end plus a grace period. "Arrived" is the EARLIER
 * of the driver's check-in tap and the geofence auto-arrival: the fence
 * is only stamped when the driver did not tap within the grace check, so
 * when both exist the tap is a paperwork delay after a physical arrival.
 *
 * Only DELIVERY stops are judged (industry on-time %). Stops without an
 * appointment window (detours, windowless drops) or without any arrival
 * record are not evaluable and are excluded from both numerator and
 * denominator rather than counted against the driver.
 *
 * Pure: no clock, no db. Used by the leg-completion stamp, the backfill,
 * and tests.
 */

import { parseStopDateTime } from './timeUtils';

export const ON_TIME_GRACE_MS = 15 * 60 * 1000;

export interface OnTimeStopLike {
  stopType: 'PICKUP' | 'DELIVERY' | 'DETOUR';
  sequenceNumber?: number;
  windowEndDate?: string;
  windowEndTime?: string;
  /** ISO 8601 string from the driver's tap. */
  checkedInAt?: string;
  /** ms epoch from the geofence fallback. */
  autoArrivedAt?: number;
}

/** Earliest evidence the truck was at the stop, or null when none. */
export function stopArrivalMs(stop: OnTimeStopLike): number | null {
  const candidates: number[] = [];
  if (stop.checkedInAt) {
    const t = Date.parse(stop.checkedInAt);
    if (!Number.isNaN(t)) candidates.push(t);
  }
  if (typeof stop.autoArrivedAt === 'number' && Number.isFinite(stop.autoArrivedAt)) {
    candidates.push(stop.autoArrivedAt);
  }
  return candidates.length ? Math.min(...candidates) : null;
}

export interface DeliveryOnTimeResult {
  onTime: boolean;
  /** Milliseconds past the window end + grace; 0 when on time. */
  lateMs: number;
}

/** null = not evaluable (not a delivery, no window end, or no arrival). */
export function evaluateDeliveryOnTime(
  stop: OnTimeStopLike,
  graceMs: number = ON_TIME_GRACE_MS,
): DeliveryOnTimeResult | null {
  if (stop.stopType !== 'DELIVERY') return null;
  const windowEnd = parseStopDateTime(stop.windowEndDate, stop.windowEndTime);
  if (windowEnd === null) return null;
  const arrived = stopArrivalMs(stop);
  if (arrived === null) return null;
  const deadline = windowEnd + graceMs;
  return arrived <= deadline ? { onTime: true, lateMs: 0 } : { onTime: false, lateMs: arrived - deadline };
}

export interface LegOnTimeSummary {
  deliveriesEvaluated: number;
  deliveriesOnTime: number;
  /** Worst lateness among evaluated deliveries, ms past window end +
   *  grace; 0 when every evaluated delivery was on time. */
  deliveriesMaxLateMs: number;
}

/**
 * Roll up the delivery stops a leg covers — those whose sequence number
 * lies within [startSeq, endSeq]. Stops with no sequence number are
 * skipped (they cannot be placed on the leg).
 */
export function summarizeLegOnTime(
  stops: readonly OnTimeStopLike[],
  startSeq: number,
  endSeq: number,
  graceMs: number = ON_TIME_GRACE_MS,
): LegOnTimeSummary {
  const lo = Math.min(startSeq, endSeq);
  const hi = Math.max(startSeq, endSeq);
  let deliveriesEvaluated = 0;
  let deliveriesOnTime = 0;
  let deliveriesMaxLateMs = 0;
  for (const s of stops) {
    if (typeof s.sequenceNumber !== 'number') continue;
    if (s.sequenceNumber < lo || s.sequenceNumber > hi) continue;
    const r = evaluateDeliveryOnTime(s, graceMs);
    if (!r) continue;
    deliveriesEvaluated++;
    if (r.onTime) deliveriesOnTime++;
    else deliveriesMaxLateMs = Math.max(deliveriesMaxLateMs, r.lateMs);
  }
  return { deliveriesEvaluated, deliveriesOnTime, deliveriesMaxLateMs };
}

/** "42m", "2h 05m", "1d 3h" — for a "Late …" badge. */
export function formatLateDuration(ms: number): string {
  const totalMin = Math.max(1, Math.round(ms / 60_000));
  const d = Math.floor(totalMin / 1440);
  const h = Math.floor((totalMin % 1440) / 60);
  const m = totalMin % 60;
  if (d > 0) return h > 0 ? `${d}d ${h}h` : `${d}d`;
  if (h > 0) return `${h}h ${String(m).padStart(2, '0')}m`;
  return `${m}m`;
}

/** Percentage 0–100 (rounded) or null when nothing was evaluable. */
export function onTimePercent(evaluated: number, onTime: number): number | null {
  if (evaluated <= 0) return null;
  return Math.round((onTime / evaluated) * 100);
}
