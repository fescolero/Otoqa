/**
 * Tests for the OTA reload budget (apps/driver/lib/auto-update-budget.ts).
 *
 * This guard exists because of a real freeze: a bundle that crashed on launch
 * made expo-updates roll back to the embedded bundle, the app restarted with
 * the update still pending, and the hook reloaded again — a restart loop that
 * reads to the driver as a frozen screen. The previous guard was a variable
 * in the effect's closure, which `reloadAsync()` wiped by destroying the JS
 * context. So the case that matters most here is the second one: a budget
 * that has already been spent must stay spent across restarts.
 */
import { describe, it, expect } from 'vitest';
import {
  decideReload,
  MAX_RELOAD_ATTEMPTS,
  MIN_RETRY_INTERVAL_MS,
  type ReloadBudget,
} from './auto-update-budget';

const UPDATE = 'update_abc';
const NOW = 1_700_000_000_000;

const budget = (over: Partial<ReloadBudget> = {}): ReloadBudget => ({
  updateId: UPDATE,
  attempts: 1,
  lastAttemptAt: NOW - MIN_RETRY_INTERVAL_MS - 1,
  ...over,
});

describe('decideReload', () => {
  it('reloads the first time an update is seen', () => {
    const d = decideReload({ budget: null, pendingUpdateId: UPDATE, now: NOW });
    expect(d).toEqual({ kind: 'reload', attempts: 1, isLastAttempt: false });
  });

  it('stops once the budget is spent — the crash-loop case', () => {
    const d = decideReload({
      budget: budget({ attempts: MAX_RELOAD_ATTEMPTS }),
      pendingUpdateId: UPDATE,
      now: NOW,
    });
    expect(d).toEqual({ kind: 'blocked', attempts: MAX_RELOAD_ATTEMPTS });
  });

  it('stays blocked no matter how much later the app restarts', () => {
    // The old guard reset on every restart. This one must not: a bundle that
    // does not launch is not going to start launching in an hour.
    const d = decideReload({
      budget: budget({ attempts: MAX_RELOAD_ATTEMPTS, lastAttemptAt: NOW - 86_400_000 }),
      pendingUpdateId: UPDATE,
      now: NOW,
    });
    expect(d.kind).toBe('blocked');
  });

  it('backs off inside the budget rather than retrying immediately', () => {
    const d = decideReload({
      budget: budget({ attempts: 1, lastAttemptAt: NOW - 1_000 }),
      pendingUpdateId: UPDATE,
      now: NOW,
    });
    expect(d).toEqual({ kind: 'backoff' });
  });

  it('retries once the backoff has elapsed', () => {
    const d = decideReload({
      budget: budget({ attempts: 1, lastAttemptAt: NOW - MIN_RETRY_INTERVAL_MS - 1 }),
      pendingUpdateId: UPDATE,
      now: NOW,
    });
    expect(d).toEqual({ kind: 'reload', attempts: 2, isLastAttempt: true });
  });

  it('flags the final attempt so exhaustion is reported before the context dies', () => {
    const d = decideReload({ budget: budget({ attempts: 1 }), pendingUpdateId: UPDATE, now: NOW });
    expect(d.kind === 'reload' && d.isLastAttempt).toBe(true);
  });

  it("a different update's budget never blocks a new one", () => {
    // The keying is the point: a bundle that won't launch must not poison
    // the budget of the fix that replaces it.
    const d = decideReload({
      budget: budget({ updateId: 'update_broken', attempts: MAX_RELOAD_ATTEMPTS, lastAttemptAt: NOW }),
      pendingUpdateId: 'update_fixed',
      now: NOW,
    });
    expect(d).toEqual({ kind: 'reload', attempts: 1, isLastAttempt: false });
  });

  it('spends the budget from zero for an update with no record', () => {
    const d = decideReload({ budget: null, pendingUpdateId: 'unknown_pending', now: NOW });
    expect(d.kind === 'reload' && d.attempts).toBe(1);
  });

  it('a full budget cycle terminates', () => {
    // Walk the loop the way the device would, feeding each decision back in.
    let stored: ReloadBudget | null = null;
    const kinds: string[] = [];
    for (let restart = 0; restart < 6; restart++) {
      const now = NOW + restart * (MIN_RETRY_INTERVAL_MS + 1);
      const d = decideReload({ budget: stored, pendingUpdateId: UPDATE, now });
      kinds.push(d.kind);
      if (d.kind === 'reload') {
        stored = { updateId: UPDATE, attempts: d.attempts, lastAttemptAt: now };
      }
    }
    // Two reloads, then blocked forever — never an unbounded restart.
    expect(kinds).toEqual(['reload', 'reload', 'blocked', 'blocked', 'blocked', 'blocked']);
  });
});
