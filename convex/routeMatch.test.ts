import { convexTest } from 'convex-test';
import { describe, it, expect } from 'vitest';
import schema from './schema';
import type { Id } from './_generated/dataModel';
import { matchRouteAssignment } from './lib/routeMatch';

/**
 * The shared route matcher. Pins the tier order and — the part that was
 * broken — that `priority` actually decides between candidates. Every
 * previous copy used `.first()`, i.e. index order, so a lower-priority
 * route could win purely by insertion order.
 */

const ORG = 'org_rm';
const USER = 'user_rm';
const HCR = '917DK';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
async function route(ctx: any, o: {
  hcr?: string; trip?: string; priority: number; isActive?: boolean; name: string;
  activeDays?: number[]; excludeFederalHolidays?: boolean; customExclusions?: string[];
}): Promise<Id<'routeAssignments'>> {
  const now = Date.now();
  return ctx.db.insert('routeAssignments', {
    workosOrgId: ORG,
    hcr: o.hcr ?? HCR,
    ...(o.trip ? { tripNumber: o.trip } : {}),
    priority: o.priority,
    isActive: o.isActive ?? true,
    ...(o.activeDays ? { activeDays: o.activeDays } : {}),
    ...(o.excludeFederalHolidays ? { excludeFederalHolidays: true } : {}),
    ...(o.customExclusions ? { customExclusions: o.customExclusions } : {}),
    name: o.name,
    createdBy: USER, createdAt: now, updatedAt: now,
  });
}

const matchFull = (t: ReturnType<typeof convexTest>, hcr: string, trip?: string, serviceDate?: string) =>
  t.run((ctx) => matchRouteAssignment(ctx, { workosOrgId: ORG, hcr, trip, serviceDate }));

const match = async (t: ReturnType<typeof convexTest>, hcr: string, trip?: string, serviceDate?: string) =>
  (await matchFull(t, hcr, trip, serviceDate)).route;

describe('matchRouteAssignment', () => {
  it('prefers an exact HCR+trip rule over an HCR-only rule', async () => {
    const t = convexTest(schema);
    await t.run(async (ctx) => {
      await route(ctx, { priority: 1, name: 'hcr-only' });
      await route(ctx, { trip: 'T1', priority: 9, name: 'exact' });
    });
    expect((await match(t, HCR, 'T1'))?.name).toBe('exact');
  });

  it('falls back to the HCR-only rule when the trip does not match', async () => {
    const t = convexTest(schema);
    await t.run(async (ctx) => {
      await route(ctx, { priority: 1, name: 'hcr-only' });
      await route(ctx, { trip: 'T1', priority: 1, name: 'other-trip' });
    });
    expect((await match(t, HCR, 'T9'))?.name).toBe('hcr-only');
  });

  it('REGRESSION: a trip-specific rule never claims a different trip', async () => {
    // The real incident: HCR 96036 had rules for trips 1,2,5,6,7,8 and none
    // for 821. A removed third tier ("any active route on this HCR") handed
    // 20 loads on trip 821 to the driver whose rule covered trip 1 — chosen
    // by a same-priority tiebreak, with no rule in the UI to explain it.
    const t = convexTest(schema);
    await t.run(async (ctx) => {
      await route(ctx, { trip: '1', priority: 100, name: 'trip-1-jorge' });
      await route(ctx, { trip: '2', priority: 100, name: 'trip-2-jorge' });
    });
    const result = await matchFull(t, HCR, '821');
    expect(result.route).toBeNull();
    expect(result.declinedBecause).toBeUndefined();
  });

  it('an HCR-only rule IS the catch-all, and covers an unlisted trip', async () => {
    const t = convexTest(schema);
    await t.run(async (ctx) => {
      await route(ctx, { trip: '1', priority: 1, name: 'trip-1' });
      await route(ctx, { priority: 100, name: 'catch-all' });
    });
    expect((await match(t, HCR, '821'))?.name).toBe('catch-all');
    expect((await match(t, HCR, '1'))?.name).toBe('trip-1');
  });

  it('REGRESSION: lowest priority wins, not insertion order', async () => {
    const t = convexTest(schema);
    await t.run(async (ctx) => {
      // Inserted first, so `.first()` used to return this one.
      await route(ctx, { trip: 'T1', priority: 50, name: 'inserted-first' });
      await route(ctx, { trip: 'T1', priority: 1, name: 'highest-priority' });
    });
    expect((await match(t, HCR, 'T1'))?.name).toBe('highest-priority');
  });

  it('REGRESSION: priority decides between catch-all rules too', async () => {
    const t = convexTest(schema);
    await t.run(async (ctx) => {
      await route(ctx, { priority: 50, name: 'inserted-first' });
      await route(ctx, { priority: 2, name: 'highest-priority' });
    });
    expect((await match(t, HCR, 'TZ'))?.name).toBe('highest-priority');
  });

  it('ignores inactive routes at both tiers', async () => {
    const t = convexTest(schema);
    await t.run(async (ctx) => {
      await route(ctx, { trip: 'T1', priority: 1, isActive: false, name: 'exact-off' });
      await route(ctx, { priority: 2, isActive: false, name: 'hcr-only-off' });
      await route(ctx, { priority: 3, name: 'hcr-only-live' });
    });
    // The exact rule is paused, so the live catch-all takes it.
    expect((await match(t, HCR, 'T1'))?.name).toBe('hcr-only-live');
  });

  it('returns null when nothing on the HCR is active', async () => {
    const t = convexTest(schema);
    await t.run(async (ctx) => {
      await route(ctx, { priority: 1, isActive: false, name: 'off' });
      await route(ctx, { hcr: 'OTHER', priority: 1, name: 'different-hcr' });
    });
    expect(await match(t, HCR, 'T1')).toBeNull();
  });

  it('is scoped to the calling organization', async () => {
    const t = convexTest(schema);
    await t.run(async (ctx) => {
      const now = Date.now();
      await ctx.db.insert('routeAssignments', {
        workosOrgId: 'org_other', hcr: HCR, priority: 1, isActive: true,
        name: 'other-org', createdBy: USER, createdAt: now, updatedAt: now,
      });
    });
    expect(await match(t, HCR)).toBeNull();
  });
});

/**
 * Feature A — per-route service days. The calendar is evaluated against the
 * LOAD'S service date, not the clock.
 *
 * 2026-09-14 is a Monday; 2026-09-19 is a Saturday. 2026-07-03 is the
 * observed Independence Day holiday (Jul 4 falls on a Saturday in 2026).
 */
const MON = '2026-09-14';
const SAT = '2026-09-19';

describe('matchRouteAssignment — service calendar', () => {
  it('weekday comes from the date string, so Monday is Monday', () => {
    expect(new Date(`${MON}T00:00:00.000Z`).getUTCDay()).toBe(1);
    expect(new Date(`${SAT}T00:00:00.000Z`).getUTCDay()).toBe(6);
  });

  it('a route with no calendar runs every day (legacy rows unaffected)', async () => {
    const t = convexTest(schema);
    await t.run((ctx) => route(ctx, { priority: 1, name: 'always' }));
    expect((await match(t, HCR, undefined, SAT))?.name).toBe('always');
    expect((await match(t, HCR, undefined, undefined))?.name).toBe('always');
  });

  it('matches on an active day and declines on an inactive one', async () => {
    const t = convexTest(schema);
    await t.run((ctx) => route(ctx, { priority: 1, name: 'mwf', activeDays: [1, 3, 5] }));
    expect((await match(t, HCR, undefined, MON))?.name).toBe('mwf');

    const sat = await matchFull(t, HCR, undefined, SAT);
    expect(sat.route).toBeNull();
    expect(sat.declinedBecause).toBe('CALENDAR');
  });

  it('FALL-THROUGH: a day-blocked route lets the next candidate win', async () => {
    const t = convexTest(schema);
    await t.run(async (ctx) => {
      await route(ctx, { priority: 1, name: 'weekday-driver', activeDays: [1, 2, 3, 4, 5] });
      await route(ctx, { priority: 2, name: 'anyday-carrier' });
    });
    // Monday: the higher-priority restricted route wins.
    expect((await match(t, HCR, undefined, MON))?.name).toBe('weekday-driver');
    // Saturday: it is passed over rather than failing the whole match.
    expect((await match(t, HCR, undefined, SAT))?.name).toBe('anyday-carrier');
  });

  it('fall-through works across tiers too', async () => {
    const t = convexTest(schema);
    await t.run(async (ctx) => {
      await route(ctx, { trip: 'T1', priority: 1, name: 'exact-weekday', activeDays: [1, 2, 3, 4, 5] });
      await route(ctx, { priority: 9, name: 'hcr-only-anyday' });
    });
    expect((await match(t, HCR, 'T1', MON))?.name).toBe('exact-weekday');
    expect((await match(t, HCR, 'T1', SAT))?.name).toBe('hcr-only-anyday');
  });

  it('declines a custom-excluded date', async () => {
    const t = convexTest(schema);
    await t.run((ctx) => route(ctx, { priority: 1, name: 'r', customExclusions: [MON] }));
    expect(await match(t, HCR, undefined, MON)).toBeNull();
    expect((await match(t, HCR, undefined, SAT))?.name).toBe('r');
  });

  it('declines a federal holiday when asked to', async () => {
    const t = convexTest(schema);
    await t.run((ctx) => route(ctx, { priority: 1, name: 'r', excludeFederalHolidays: true }));
    expect(await match(t, HCR, undefined, '2026-07-03')).toBeNull();
    expect((await match(t, HCR, undefined, MON))?.name).toBe('r');
  });

  it('a restricted route declines a load with no service date', async () => {
    const t = convexTest(schema);
    await t.run((ctx) => route(ctx, { priority: 1, name: 'mwf', activeDays: [1, 3, 5] }));

    const result = await matchFull(t, HCR, undefined, undefined);
    expect(result.route).toBeNull();
    expect(result.declinedBecause).toBe('NO_SERVICE_DATE');
  });

  it('but an unrestricted route still takes an undated load', async () => {
    const t = convexTest(schema);
    await t.run(async (ctx) => {
      await route(ctx, { priority: 1, name: 'mwf', activeDays: [1, 3, 5] });
      await route(ctx, { priority: 2, name: 'anyday' });
    });
    expect((await match(t, HCR, undefined, undefined))?.name).toBe('anyday');
  });

  it('reports plain NO_MATCH when no rule exists at all', async () => {
    const t = convexTest(schema);
    const result = await matchFull(t, HCR, undefined, MON);
    expect(result.route).toBeNull();
    expect(result.declinedBecause).toBeUndefined();
  });
});

describe('matchRouteAssignment — two rules sharing an HCR + Trip', () => {
  it('routes each day to the rule that covers it', async () => {
    const t = convexTest(schema);
    await t.run(async (ctx) => {
      await route(ctx, { trip: 'T1', priority: 1, name: 'mwf', activeDays: [1, 3, 5] });
      await route(ctx, { trip: 'T1', priority: 1, name: 'tuth', activeDays: [2, 4] });
    });
    expect((await match(t, HCR, 'T1', MON))?.name).toBe('mwf');            // Monday
    expect((await match(t, HCR, 'T1', '2026-09-15'))?.name).toBe('tuth');  // Tuesday
    const sat = await matchFull(t, HCR, 'T1', SAT);
    expect(sat.route).toBeNull();
    expect(sat.declinedBecause).toBe('CALENDAR');
  });
});
