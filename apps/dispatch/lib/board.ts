/**
 * Board grouping and summary rules (design `lib-dispatch/capacity.jsx`).
 *
 * Pure and react-native-free so the node vitest project can cover them.
 *
 * The design's premise: a phone must never show "all unassigned". It shows
 * bounded work — how much lands in each horizon, and a plan you approve in
 * one pass. These are the rules behind that.
 */

export type Horizon = 'now' | 'today' | 'tomorrow' | 'later' | 'unscheduled';

export const HORIZONS: { k: Horizon; label: string; sub: string }[] = [
  { k: 'now', label: 'Next 4h', sub: 'Starting within 4h' },
  { k: 'today', label: 'Today', sub: 'Rest of the day' },
  { k: 'tomorrow', label: 'Tomorrow', sub: 'Next 24h' },
  { k: 'later', label: 'Later', sub: 'Beyond tomorrow' },
];

const FOUR_HOURS = 4 * 3600_000;

function endOfDay(ms: number): number {
  const d = new Date(ms);
  d.setHours(23, 59, 59, 999);
  return d.getTime();
}

/**
 * Which bucket a load's next action falls in.
 *
 * Anything already overdue counts as `now` rather than sliding into a past
 * bucket and disappearing — a window that closed an hour ago is the most
 * urgent thing on the board, not the least.
 */
export function horizonOf(nextWindowMs: number | null, now: number): Horizon {
  if (nextWindowMs == null) return 'unscheduled';
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
