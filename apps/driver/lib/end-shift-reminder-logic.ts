/**
 * end-shift-reminder-logic.ts — the reminder's decision table, kept free of
 * React Native, Convex and storage so it can be unit-tested in node.
 *
 * One rule does the real work: the reminder fires on a transition INTO the
 * start yard that came FROM outside it. That single condition is what makes
 * the feature safe to arm on every shift —
 *
 *   - a driver who starts the shift parked in the yard opens `inside`, so
 *     the shift-start crossing can't fire;
 *   - a driver who leaves and comes back does fire, which is the whole
 *     point — they're back where they started and may well be done;
 *   - GPS jitter can't flap it, because the hysteresis band between the
 *     entry and exit rings is its own zone that changes nothing.
 *
 * See docs/end-shift-reminder-spec.md.
 */

import { findEnclosingFence, type FenceZone, type YardFence } from './yard-fence-math';

/**
 * How long after the shift starts a fix can still establish the anchor.
 * Mirrors START_YARD_WINDOW_MS in convex/yardGeofence.ts — the two must
 * agree, or the device and the dispatcher timeline anchor different yards.
 *
 * Wide enough for a cold GPS lock, far too narrow for a drive between two
 * yards, which is the whole point: it is what separates "the yard they
 * started in" from "a yard they happened to visit".
 */
export const ARM_WINDOW_MS = 5 * 60_000;

/**
 * The last *settled* side of the fence. `between` is never stored — a fix in
 * the hysteresis band leaves the previous answer standing. `unknown` is the
 * state before the first fix settles it, and it can never fire: we don't
 * know whether the driver just arrived or was here all along.
 */
export type ReminderZone = 'inside' | 'outside' | 'unknown';

export type ReminderFacts = {
  zone: ReminderZone;
  /** Reset every time the driver leaves, so each visit nudges at most once. */
  remindedThisVisit: boolean;
};

export type ReminderTransition = ReminderFacts & {
  /** The driver just came back into the start yard and should be nudged. */
  fire: boolean;
  /** Whether anything moved — callers persist only when this is true. */
  changed: boolean;
};

/**
 * Fold one observed fence zone into the reminder's state.
 *
 * Deliberately total and side-effect free: every branch returns a complete
 * next state, so the caller never has to reason about which fields it must
 * carry forward.
 */
export function nextReminderState(
  prev: ReminderFacts,
  observed: FenceZone,
): ReminderTransition {
  const unchanged = { ...prev, fire: false, changed: false };

  // In the hysteresis band, or still on the side we already recorded.
  if (observed === 'between' || observed === prev.zone) return unchanged;

  if (observed === 'outside') {
    // Leaving re-arms the nudge for the next visit.
    return { zone: 'outside', remindedThisVisit: false, fire: false, changed: true };
  }

  // observed === 'inside'
  const fire = prev.zone === 'outside' && !prev.remindedThisVisit;
  return {
    zone: 'inside',
    remindedThisVisit: prev.remindedThisVisit || fire,
    fire,
    changed: true,
  };
}


/**
 * What to do with a fix that arrives before this shift has an anchor.
 *
 *   retry     — the fence cache hasn't landed yet. It is refreshed
 *               fire-and-forget at Start Shift, so the first fix can easily
 *               beat it home; an empty cache is "not yet", NOT "this org has
 *               no yards". Say nothing and look again on the next fix.
 *   tombstone — the window closed with no anchor established. Recorded so
 *               the reminder stops re-reading the cache on every ping for
 *               the rest of the shift.
 *   arm       — settled. `fence` is null when the shift genuinely opened
 *               outside every fence, which is a real answer, not a failure.
 */
export type ArmDecision =
  | { kind: 'retry' }
  | { kind: 'tombstone'; reason: 'window_closed' }
  | { kind: 'arm'; fence: YardFence | null; reason: 'opened_inside_fence' | 'outside_all_fences' };

export function decideArm(input: {
  sinceShiftStartMs: number;
  fences: YardFence[];
  latitude: number;
  longitude: number;
}): ArmDecision {
  if (input.sinceShiftStartMs > ARM_WINDOW_MS) {
    return { kind: 'tombstone', reason: 'window_closed' };
  }
  if (input.fences.length === 0) return { kind: 'retry' };

  const fence = findEnclosingFence(input.fences, input.latitude, input.longitude);
  return {
    kind: 'arm',
    fence,
    reason: fence ? 'opened_inside_fence' : 'outside_all_fences',
  };
}
