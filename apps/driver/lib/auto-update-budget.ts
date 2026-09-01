/**
 * auto-update-budget.ts — the reload budget's decision rule, kept free of
 * React, expo-updates and storage so it can be unit-tested in node.
 *
 * This is the guard that stops a bundle which crashes on launch from
 * restarting the app forever. It has to be right, and it cannot be exercised
 * through the hook (every path there ends in `reloadAsync()` destroying the
 * JS context), so the rule lives here on its own.
 *
 * See auto-update.ts for why the previous in-closure guard could never work.
 */

/**
 * A healthy update applies on the first reload. The second covers a genuine
 * transient — a download finishing as the process died. A third restart is
 * already a worse experience than running yesterday's bundle for a day.
 */
export const MAX_RELOAD_ATTEMPTS = 2;

/**
 * Even inside the budget, never retry faster than this. A crash-loop restarts
 * in under a second; ten minutes makes the second attempt a considered retry
 * rather than another beat of the same thrash.
 */
export const MIN_RETRY_INTERVAL_MS = 10 * 60_000;

export type ReloadBudget = {
  /** The pending update this budget belongs to. */
  updateId: string;
  attempts: number;
  lastAttemptAt: number;
};

export type ReloadDecision =
  | { kind: 'reload'; attempts: number; isLastAttempt: boolean }
  | { kind: 'blocked'; attempts: number }
  | { kind: 'backoff' };

/**
 * Whether to spend an attempt reloading into `pendingUpdateId`.
 *
 * A budget belonging to a different update is ignored rather than reset: the
 * budget is keyed so that a bundle which will not launch cannot poison the
 * next one that would.
 */
export function decideReload(input: {
  budget: ReloadBudget | null;
  pendingUpdateId: string;
  now: number;
}): ReloadDecision {
  const { budget, pendingUpdateId, now } = input;
  const forThisUpdate = budget && budget.updateId === pendingUpdateId ? budget : null;

  if (forThisUpdate && forThisUpdate.attempts >= MAX_RELOAD_ATTEMPTS) {
    return { kind: 'blocked', attempts: forThisUpdate.attempts };
  }
  if (forThisUpdate && now - forThisUpdate.lastAttemptAt < MIN_RETRY_INTERVAL_MS) {
    return { kind: 'backoff' };
  }

  const attempts = (forThisUpdate?.attempts ?? 0) + 1;
  return { kind: 'reload', attempts, isLastAttempt: attempts >= MAX_RELOAD_ATTEMPTS };
}
