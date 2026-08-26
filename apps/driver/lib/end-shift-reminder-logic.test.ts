/**
 * Tests for the end-shift reminder's decision table
 * (apps/driver/lib/end-shift-reminder-logic.ts).
 *
 * The failure this guards against is a reminder that fires when the driver
 * has not gone anywhere — at shift start, or on GPS jitter while parked.
 * Both would train drivers to swipe the notification away, which costs more
 * than the feature is worth.
 */
import { describe, it, expect } from 'vitest';
import {
  nextReminderState,
  decideArm,
  ARM_WINDOW_MS,
  type ReminderFacts,
} from './end-shift-reminder-logic';
import type { YardFence } from './yard-fence-math';

const facts = (over: Partial<ReminderFacts> = {}): ReminderFacts => ({
  zone: 'inside',
  remindedThisVisit: false,
  ...over,
});

describe('nextReminderState', () => {
  it('fires when the driver comes back in from outside', () => {
    const t = nextReminderState(facts({ zone: 'outside' }), 'inside');
    expect(t.fire).toBe(true);
    expect(t.zone).toBe('inside');
    expect(t.remindedThisVisit).toBe(true);
    expect(t.changed).toBe(true);
  });

  it('does not fire at shift start — opening inside is not an arrival', () => {
    // The shift opens `inside`; every later fix in the yard is a no-op.
    const t = nextReminderState(facts({ zone: 'inside' }), 'inside');
    expect(t.fire).toBe(false);
    expect(t.changed).toBe(false);
  });

  it('does not fire from unknown — a first fix only settles the side', () => {
    const t = nextReminderState(facts({ zone: 'unknown' }), 'inside');
    expect(t.fire).toBe(false);
    expect(t.zone).toBe('inside');
    expect(t.changed).toBe(true);
  });

  it('never fires on the hysteresis band, from any prior state', () => {
    for (const zone of ['inside', 'outside', 'unknown'] as const) {
      const t = nextReminderState(facts({ zone }), 'between');
      expect(t.fire).toBe(false);
      expect(t.changed).toBe(false);
      expect(t.zone).toBe(zone); // the band leaves the answer standing
    }
  });

  it('nudges once per visit, not once per fix', () => {
    let state: ReminderFacts = facts({ zone: 'outside' });
    const first = nextReminderState(state, 'inside');
    expect(first.fire).toBe(true);
    state = { zone: first.zone, remindedThisVisit: first.remindedThisVisit };

    // Parked in the yard: more inside fixes, and a jitter excursion into the
    // band and back. None of them re-nudge.
    for (const observed of ['inside', 'between', 'inside'] as const) {
      const t = nextReminderState(state, observed);
      expect(t.fire).toBe(false);
      state = { zone: t.zone, remindedThisVisit: t.remindedThisVisit };
    }
    expect(state).toEqual({ zone: 'inside', remindedThisVisit: true });
  });

  it('re-arms after the driver actually leaves', () => {
    let state: ReminderFacts = facts({ zone: 'inside', remindedThisVisit: true });

    const left = nextReminderState(state, 'outside');
    expect(left.remindedThisVisit).toBe(false); // leaving re-arms
    expect(left.fire).toBe(false);
    state = { zone: left.zone, remindedThisVisit: left.remindedThisVisit };

    const back = nextReminderState(state, 'inside');
    expect(back.fire).toBe(true); // second visit nudges again
  });

  it('leaving from unknown settles without firing', () => {
    const t = nextReminderState(facts({ zone: 'unknown' }), 'outside');
    expect(t.fire).toBe(false);
    expect(t.zone).toBe('outside');
    expect(t.changed).toBe(true);
  });
});

const KM = 1 / 111.32;
const BASE = { lat: 34, lng: -117 };

function fence(over: Partial<YardFence> = {}): YardFence {
  return {
    id: 'yard_main',
    name: 'Main Yard',
    latitude: BASE.lat,
    longitude: BASE.lng,
    entryRadiusMeters: 250,
    exitRadiusMeters: 375,
    ...over,
  };
}

describe('decideArm', () => {
  const inside = { latitude: BASE.lat + 0.1 * KM, longitude: BASE.lng };
  const far = { latitude: BASE.lat + 10 * KM, longitude: BASE.lng };

  it('anchors a shift that opened inside a fence', () => {
    const d = decideArm({ sinceShiftStartMs: 40_000, fences: [fence()], ...inside });
    expect(d).toEqual({ kind: 'arm', fence: fence(), reason: 'opened_inside_fence' });
  });

  it('settles with no anchor when the shift opened outside every fence', () => {
    const d = decideArm({ sinceShiftStartMs: 40_000, fences: [fence()], ...far });
    expect(d).toEqual({ kind: 'arm', fence: null, reason: 'outside_all_fences' });
  });

  it('retries on an empty cache — not yet is not the same as no yards', () => {
    // The fence cache is refreshed fire-and-forget at Start Shift, so the
    // first fix can beat it home. Tombstoning here would silently disarm
    // every shift that gets a GPS lock faster than the network.
    expect(decideArm({ sinceShiftStartMs: 5_000, fences: [], ...inside })).toEqual({
      kind: 'retry',
    });
  });

  it('tombstones once the window closes, even sitting in the yard', () => {
    const d = decideArm({
      sinceShiftStartMs: ARM_WINDOW_MS + 1,
      fences: [fence()],
      ...inside,
    });
    expect(d).toEqual({ kind: 'tombstone', reason: 'window_closed' });
  });

  it('the closed window beats an empty cache — no retrying all day', () => {
    const d = decideArm({ sinceShiftStartMs: ARM_WINDOW_MS + 1, fences: [], ...inside });
    expect(d.kind).toBe('tombstone');
  });

  it('a yard reached after the window cannot become the anchor', () => {
    // Three hours in, parked in a yard: this is the case the window exists
    // to reject — it is a yard they drove to, not the one they started in.
    const d = decideArm({
      sinceShiftStartMs: 3 * 60 * 60_000,
      fences: [fence()],
      ...inside,
    });
    expect(d.kind).toBe('tombstone');
  });

  it('anchors to the nearest fence when two overlap', () => {
    const near = fence({ id: 'near', latitude: BASE.lat + 0.1 * KM, entryRadiusMeters: 2000, exitRadiusMeters: 3000 });
    const far2 = fence({ id: 'far', entryRadiusMeters: 2000, exitRadiusMeters: 3000 });
    const d = decideArm({ sinceShiftStartMs: 10_000, fences: [far2, near], ...inside });
    expect(d.kind === 'arm' && d.fence?.id).toBe('near');
  });
});
