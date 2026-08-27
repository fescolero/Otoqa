/**
 * Board grouping and summary rules (design `lib-dispatch/capacity.jsx`).
 *
 * Pure and react-native-free so the node vitest project can cover them.
 *
 * The design's premise: a phone must never show "all unassigned". It shows
 * bounded work — how much lands in each horizon, and a plan you approve in
 * one pass. These are the rules behind that.
 */

export type Horizon = 'overdue' | 'now' | 'today' | 'tomorrow' | 'later' | 'unscheduled';

const FOUR_HOURS = 4 * 3600_000;

function endOfDay(ms: number): number {
  const d = new Date(ms);
  d.setHours(23, 59, 59, 999);
  return d.getTime();
}

const clock = (ms: number) =>
  new Date(ms).toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' });
const calendar = (ms: number) =>
  new Date(ms).toLocaleDateString(undefined, { month: 'short', day: 'numeric' });

/**
 * The tiles, with the range each one actually covers.
 *
 * Static labels made the counts look broken: at 7pm "Next 4h" runs to 11pm,
 * so "Today" is the 58 minutes left after it — which reads as nonsense next
 * to a 4-hour bucket holding 34 loads. The buckets are a partition, and the
 * sub-label has to say so, exactly as the design's does ("by 1:40 PM", "to
 * 8:00 PM").
 *
 * Past-due work has no tile because it does not belong on this board at all
 * — see `isActionable`.
 */
export function horizonTiles(now: number): { k: Horizon; label: string; sub: string }[] {
  const windowEnd = now + FOUR_HOURS;
  const todayEnd = endOfDay(now);
  return [
    { k: 'now', label: 'Next 4h', sub: `by ${clock(windowEnd)}` },
    {
      k: 'today',
      label: 'Today',
      // Once the 4h window reaches midnight there is no "rest of today" left.
      sub: windowEnd >= todayEnd ? 'Covered by Next 4h' : `to ${clock(todayEnd)}`,
    },
    { k: 'tomorrow', label: 'Tomorrow', sub: calendar(now + 86_400_000) },
    { k: 'later', label: 'Later', sub: `${calendar(now + 2 * 86_400_000)} onward` },
  ];
}

/** Stable ordering for section headings, independent of the clock. */
export const HORIZON_ORDER: Horizon[] = ['now', 'today', 'tomorrow', 'later'];

/**
 * Whether a load still belongs on the board.
 *
 * A pickup window that has already closed is not work a dispatcher can act
 * on from a phone — assigning a driver won't un-miss it. Product decision
 * (2026-08-21): if we missed it, we missed it. Such loads are excluded from
 * the tiles, the sections and the header count alike, so every number on the
 * screen describes the same population.
 *
 * `horizonOf` still classifies them as 'overdue' — the fact is true and
 * worth naming; this is the one place that decides to act on it, and the
 * loads remain visible in the web TMS.
 *
 * Unscheduled work is actionable: no window means nothing was missed.
 */
export function isActionable(nextWindowMs: number | null, now: number): boolean {
  return horizonOf(nextWindowMs, now) !== 'overdue';
}

/**
 * Which bucket a load's next action falls in.
 *
 * Overdue is separated rather than folded forward: a window that closed an
 * hour ago is the most urgent thing on the board, and counting it under
 * "Next 4h" tells a dispatcher the opposite of the truth.
 */
export function horizonOf(nextWindowMs: number | null, now: number): Horizon {
  if (nextWindowMs == null) return 'unscheduled';
  if (nextWindowMs < now) return 'overdue';
  if (nextWindowMs <= now + FOUR_HOURS) return 'now';
  if (nextWindowMs <= endOfDay(now)) return 'today';
  if (nextWindowMs <= endOfDay(now + 86_400_000)) return 'tomorrow';
  return 'later';
}

/** Tiles count work that still needs a driver — assigned work isn't a backlog. */
export function countByHorizon<T>(
  rows: T[],
  nextWindow: (row: T) => number | null,
  now: number,
): Record<Horizon, number> {
  const counts: Record<Horizon, number> = {
    overdue: 0,
    now: 0,
    today: 0,
    tomorrow: 0,
    later: 0,
    unscheduled: 0,
  };
  for (const r of rows) counts[horizonOf(nextWindow(r), now)]++;
  return counts;
}

// ── Auto-plan summary ──────────────────────────────────────────────────────

export interface PlanLike {
  runs: { loads: unknown[]; start: number; candidates: unknown[] }[];
  unplannable: unknown[];
}

export interface PlanSummary {
  loads: number;
  trucks: number;
  clean: number;
  needsCall: number;
  urgent: number;
}

/**
 * What the "Auto-plan is ready" card claims, computed rather than guessed.
 *
 * `needsCall` deliberately folds two different failures together — a run the
 * ranker found no driver for, and a load it could not chain at all — because
 * both land in the same place for a dispatcher: work the machine could not
 * place, which a human now has to.
 */
export function planSummary(plan: PlanLike, now: number): PlanSummary {
  const runs = plan.runs;
  return {
    loads: runs.reduce((n, r) => n + r.loads.length, 0),
    trucks: runs.length,
    clean: runs.filter((r) => r.candidates.length > 0).length,
    needsCall: runs.filter((r) => r.candidates.length === 0).length + plan.unplannable.length,
    urgent: runs.filter((r) => r.start <= now + FOUR_HOURS).length,
  };
}

/** Nothing to approve — don't show the card at all. */
export function planIsEmpty(plan: PlanLike | undefined | null): boolean {
  return !plan || plan.runs.length === 0;
}
