import { convexTest } from 'convex-test';
import { describe, it, expect } from 'vitest';
import schema from './schema';
import type { Id } from './_generated/dataModel';
import type { MutationCtx } from './_generated/server';
import { api } from './_generated/api';

/**
 * fuelReview.setReview — the disposition that clears an entry's
 * exceptions — and the rule that a material edit clears the review.
 */

const ORG = 'org_rv_test';
const USER = 'user_rv_test';
const T0 = 1_700_000_000_000;

async function seed(ctx: MutationCtx): Promise<{ fuel: Id<'fuelEntries'>; def: Id<'defEntries'> }> {
  const now = Date.now();
  const vendorId = await ctx.db.insert('fuelVendors', {
    organizationId: ORG, name: 'Pilot', isActive: true, createdAt: now, updatedAt: now, createdBy: USER,
  });
  const base = {
    organizationId: ORG, entryDate: T0, vendorId, gallons: 100, pricePerGallon: 4.2, totalCost: 420,
    createdAt: now, updatedAt: now, createdBy: USER,
  };
  return {
    fuel: await ctx.db.insert('fuelEntries', base),
    def: await ctx.db.insert('defEntries', base),
  };
}

describe('setReview', () => {
  it('stores who decided what, on either table, and clears on null', async () => {
    const t = convexTest(schema).withIdentity({ subject: USER, org_id: ORG, name: 'Fran' });
    const { fuel, def } = await t.run(seed);

    await t.mutation(api.fuelReview.setReview, { type: 'fuel', entryId: fuel, status: 'OK', note: '  receipt confirms ' });
    await t.mutation(api.fuelReview.setReview, { type: 'def', entryId: def, status: 'DRIVER_FOLLOW_UP' });

    const [f, d] = await t.run(async (ctx) => [await ctx.db.get(fuel), await ctx.db.get(def)]);
    expect(f?.review).toMatchObject({ status: 'OK', reviewedBy: USER, reviewedByName: 'Fran', note: 'receipt confirms' });
    expect(d?.review).toMatchObject({ status: 'DRIVER_FOLLOW_UP', reviewedBy: USER });
    expect(d?.review?.note).toBeUndefined();

    await t.mutation(api.fuelReview.setReview, { type: 'fuel', entryId: fuel, status: null });
    expect((await t.run(async (ctx) => ctx.db.get(fuel)))?.review).toBeUndefined();

    const audit = await t.run(async (ctx) =>
      ctx.db
        .query('auditLog')
        .withIndex('by_org_entity', (q) => q.eq('organizationId', ORG).eq('entityType', 'fuelEntry').eq('entityId', fuel))
        .take(10),
    );
    expect(audit.map((a) => a.description)).toEqual(['Marked Reviewed OK', 'Review cleared']);
  });

  it('refuses entries outside the caller organization', async () => {
    const t = convexTest(schema);
    const { fuel } = await t.run(seed);
    const stranger = t.withIdentity({ subject: 'u2', org_id: 'org_other' });
    await expect(
      stranger.mutation(api.fuelReview.setReview, { type: 'fuel', entryId: fuel, status: 'OK' }),
    ).rejects.toThrow('Entry not found');
  });

  it('is cleared by an edit to a figure it judged, but survives a note', async () => {
    const t = convexTest(schema).withIdentity({ subject: USER, org_id: ORG });
    const { fuel, def } = await t.run(seed);
    await t.mutation(api.fuelReview.setReview, { type: 'fuel', entryId: fuel, status: 'OK' });
    await t.mutation(api.fuelReview.setReview, { type: 'def', entryId: def, status: 'OK' });

    await t.mutation(api.fuelEntries.update, { entryId: fuel, notes: 'called the driver', updatedBy: USER });
    expect((await t.run(async (ctx) => ctx.db.get(fuel)))?.review?.status).toBe('OK');

    await t.mutation(api.fuelEntries.update, { entryId: fuel, pricePerGallon: 4.19, updatedBy: USER });
    expect((await t.run(async (ctx) => ctx.db.get(fuel)))?.review).toBeUndefined();

    await t.mutation(api.defEntries.update, { entryId: def, gallons: 12, updatedBy: USER });
    expect((await t.run(async (ctx) => ctx.db.get(def)))?.review).toBeUndefined();
  });
});
