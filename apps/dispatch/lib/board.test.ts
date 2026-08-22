import { describe, expect, it } from 'vitest';
import {
  countByHorizon,
  horizonOf,
  horizonTiles,
  HORIZON_ORDER,
  planIsEmpty,
  planSummary,
  type Horizon,
  type PlanLike,
} from './board';

// A fixed mid-morning instant, so "end of day" is unambiguous.
const NOW = new Date('2026-04-17T09:00:00').getTime();
const h = (hours: number) => NOW + hours * 3600_000;

describe('horizonOf', () => {
  it('buckets by how soon the next action is due', () => {
    expect(horizonOf(h(1), NOW)).toBe('now');
    expect(horizonOf(h(3.9), NOW)).toBe('now');
    expect(horizonOf(h(6), NOW)).toBe('today'); // 3pm same day
    expect(horizonOf(h(26), NOW)).toBe('tomorrow'); // 11am next day
    expect(horizonOf(h(72), NOW)).toBe('later');
    expect(horizonOf(null, NOW)).toBe('unscheduled');
  });

  it('separates overdue from Next 4h', () => {
    // Folding past-due work forward both inflated "Next 4h" and hid the most
    // urgent thing on the board behind a label claiming it was upcoming.
    expect(horizonOf(h(-1), NOW)).toBe('overdue');
    expect(horizonOf(h(-48), NOW)).toBe('overdue');
    expect(horizonOf(h(0.5), NOW)).toBe('now');
  });

  it('puts the last minute of today in today, and the first of tomorrow in tomorrow', () => {
    const endToday = new Date('2026-04-17T23:59:00').getTime();
    const startTomorrow = new Date('2026-04-18T00:01:00').getTime();
    expect(horizonOf(endToday, NOW)).toBe('today');
    expect(horizonOf(startTomorrow, NOW)).toBe('tomorrow');
  });
});

describe('countByHorizon', () => {
  it('tallies every row into exactly one bucket', () => {
    const rows = [h(-3), h(1), h(2), h(7), h(30), h(200), null];
    const counts = countByHorizon(rows, (r) => r, NOW);
    expect(counts).toEqual({
      overdue: 1,
      now: 2,
      today: 1,
      tomorrow: 1,
      later: 1,
      unscheduled: 1,
    });
    expect(Object.values(counts).reduce((a, b) => a + b, 0)).toBe(rows.length);
  });

  it('returns all-zero for an empty board rather than undefined counts', () => {
    expect(countByHorizon([] as number[], (r) => r, NOW)).toEqual({
      overdue: 0,
      now: 0,
      today: 0,
      tomorrow: 0,
      later: 0,
      unscheduled: 0,
    });
  });
});

describe('planSummary', () => {
  const run = (loads: number, candidates: number, start: number) => ({
    loads: Array.from({ length: loads }, (_, i) => i),
    candidates: Array.from({ length: candidates }, (_, i) => i),
    start,
  });

  it('counts what the card claims', () => {
    const plan: PlanLike = {
      runs: [run(3, 2, h(1)), run(2, 3, h(9)), run(1, 0, h(30))],
      unplannable: [{}, {}],
    };
    const s = planSummary(plan, NOW);
    expect(s.loads).toBe(6);
    expect(s.trucks).toBe(3);
    expect(s.clean).toBe(2);
    expect(s.urgent).toBe(1);
    // One run with no candidate + two unplannable loads.
    expect(s.needsCall).toBe(3);
  });

  it('folds both machine failures into needsCall — they land on the same desk', () => {
    const noDriver: PlanLike = { runs: [run(1, 0, h(1))], unplannable: [] };
    const noChain: PlanLike = { runs: [], unplannable: [{}] };
    expect(planSummary(noDriver, NOW).needsCall).toBe(1);
    expect(planSummary(noChain, NOW).needsCall).toBe(1);
  });

  it('counts an overdue run as urgent', () => {
    const plan: PlanLike = { runs: [run(1, 1, h(-2))], unplannable: [] };
    expect(planSummary(plan, NOW).urgent).toBe(1);
  });
});

describe('planIsEmpty', () => {
  it('hides the card when there is nothing to approve', () => {
    expect(planIsEmpty(undefined)).toBe(true);
    expect(planIsEmpty(null)).toBe(true);
    expect(planIsEmpty({ runs: [], unplannable: [] })).toBe(true);
    // Unplannable loads alone are not a plan — there is nothing to apply.
    expect(planIsEmpty({ runs: [], unplannable: [{}, {}] })).toBe(true);
  });

  it('shows the card as soon as one run exists', () => {
    expect(
      planIsEmpty({ runs: [{ loads: [1], candidates: [1], start: NOW }], unplannable: [] }),
    ).toBe(false);
  });
});

describe('horizon tiles', () => {
  it('covers every scheduled bucket, in the order sections render', () => {
    expect(horizonTiles(NOW).map((t) => t.k)).toEqual(HORIZON_ORDER);
  });

  it('leaves unscheduled out of the tiles — it is not a point in time', () => {
    expect(horizonTiles(NOW).some((t) => t.k === 'unscheduled')).toBe(false);
  });

  it('states the range each tile covers, so a small Today reads as a remainder', () => {
    // 9am: Next 4h runs to 1pm, so Today is 1pm→midnight. Static labels made
    // that look broken next to a bigger 4-hour count.
    const tiles = horizonTiles(NOW);
    const now4h = tiles.find((t) => t.k === 'now')!;
    const today = tiles.find((t) => t.k === 'today')!;
    expect(now4h.sub).toContain('1:00');
    expect(today.sub).toContain('11:59');
  });

  it('says so when the 4h window has already swallowed the rest of today', () => {
    const late = new Date('2026-04-17T22:30:00').getTime();
    const today = horizonTiles(late).find((t) => t.k === 'today')!;
    expect(today.sub).toBe('Covered by Next 4h');
    // And nothing can land in that bucket, so the count is honestly zero.
    expect(horizonOf(new Date('2026-04-17T23:30:00').getTime(), late)).toBe('now');
  });

  it('dates the forward tiles rather than labelling them vaguely', () => {
    const tiles = horizonTiles(NOW);
    expect(tiles.find((t) => t.k === 'tomorrow')!.sub).toContain('18');
    expect(tiles.find((t) => t.k === 'later')!.sub).toContain('19');
  });
});
