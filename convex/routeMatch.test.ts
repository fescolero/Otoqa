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
}): Promise<Id<'routeAssignments'>> {
  const now = Date.now();
  return ctx.db.insert('routeAssignments', {
    workosOrgId: ORG,
    hcr: o.hcr ?? HCR,
    ...(o.trip ? { tripNumber: o.trip } : {}),
    priority: o.priority,
    isActive: o.isActive ?? true,
    name: o.name,
    createdBy: USER, createdAt: now, updatedAt: now,
  });
}

const match = (t: ReturnType<typeof convexTest>, hcr: string, trip?: string) =>
  t.run((ctx) => matchRouteAssignment(ctx, { workosOrgId: ORG, hcr, trip }));

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

  it('falls back to any active route on the HCR as a last resort', async () => {
    const t = convexTest(schema);
    await t.run(async (ctx) => {
      await route(ctx, { trip: 'T1', priority: 5, name: 'some-trip' });
    });
    expect((await match(t, HCR, 'T9'))?.name).toBe('some-trip');
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

  it('REGRESSION: priority decides the last-resort tier too', async () => {
    const t = convexTest(schema);
    await t.run(async (ctx) => {
      await route(ctx, { trip: 'TA', priority: 50, name: 'inserted-first' });
      await route(ctx, { trip: 'TB', priority: 2, name: 'highest-priority' });
    });
    expect((await match(t, HCR, 'TZ'))?.name).toBe('highest-priority');
  });

  it('ignores inactive routes at every tier', async () => {
    const t = convexTest(schema);
    await t.run(async (ctx) => {
      await route(ctx, { trip: 'T1', priority: 1, isActive: false, name: 'exact-off' });
      await route(ctx, { priority: 2, isActive: false, name: 'hcr-only-off' });
      await route(ctx, { trip: 'T2', priority: 3, name: 'live' });
    });
    expect((await match(t, HCR, 'T1'))?.name).toBe('live');
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
