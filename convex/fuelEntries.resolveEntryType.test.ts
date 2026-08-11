import { convexTest } from 'convex-test';
import { describe, it, expect } from 'vitest';
import schema from './schema';
import type { Id } from './_generated/dataModel';
import { api } from './_generated/api';

/**
 * Tests for fuelEntries.resolveEntryType — the resolver that lets the
 * shared diesel detail / edit routes work without a `?type=` hint in the
 * URL.
 *
 * Regression context: those routes used to default a missing `?type=` to
 * 'fuel', which handed `defEntries` ids to `v.id('fuelEntries')`. Convex
 * rejects that during argument validation (before the handler runs), so
 * the page threw instead of rendering the DEF record.
 */

const ORG = 'org_ret_test';
const OTHER_ORG = 'org_ret_other';
const USER = 'user_ret_test';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
async function seedVendor(ctx: any, org = ORG): Promise<Id<'fuelVendors'>> {
  const now = Date.now();
  return await ctx.db.insert('fuelVendors', {
    organizationId: org,
    name: 'Pilot',
    isActive: true,
    createdAt: now,
    updatedAt: now,
    createdBy: USER,
  });
}

async function insertEntry(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  ctx: any,
  table: 'fuelEntries' | 'defEntries',
  vendorId: Id<'fuelVendors'>,
  org = ORG,
): Promise<string> {
  const now = Date.now();
  return await ctx.db.insert(table, {
    organizationId: org,
    entryDate: now,
    vendorId,
    gallons: 50,
    pricePerGallon: 4,
    totalCost: 200,
    createdAt: now,
    updatedAt: now,
    createdBy: USER,
  });
}

describe('resolveEntryType', () => {
  it('resolves ids to their owning diesel table', async () => {
    const t = convexTest(schema).withIdentity({ subject: USER, org_id: ORG });

    const { fuelId, defId } = await t.run(async (ctx) => {
      const vendorId = await seedVendor(ctx);
      return {
        fuelId: await insertEntry(ctx, 'fuelEntries', vendorId),
        defId: await insertEntry(ctx, 'defEntries', vendorId),
      };
    });

    expect(await t.query(api.fuelEntries.resolveEntryType, { entryId: fuelId })).toBe('fuel');
    // The case that used to crash the detail page: a DEF id with no
    // `?type=` hint must resolve to 'def', not fall through to 'fuel'.
    expect(await t.query(api.fuelEntries.resolveEntryType, { entryId: defId })).toBe('def');
  });

  it('returns null for a malformed id instead of throwing', async () => {
    const t = convexTest(schema).withIdentity({ subject: USER, org_id: ORG });

    // An arbitrary path segment must not blow up argument validation —
    // `normalizeId` rejects it and the caller renders "not found".
    expect(
      await t.query(api.fuelEntries.resolveEntryType, { entryId: 'not-a-convex-id' }),
    ).toBeNull();
  });

  it('does not disclose entries belonging to another organization', async () => {
    const t = convexTest(schema);

    const foreignDefId = await t.run(async (ctx) => {
      const vendorId = await seedVendor(ctx, OTHER_ORG);
      return await insertEntry(ctx, 'defEntries', vendorId, OTHER_ORG);
    });

    const asMember = t.withIdentity({ subject: USER, org_id: ORG });
    expect(
      await asMember.query(api.fuelEntries.resolveEntryType, { entryId: foreignDefId }),
    ).toBeNull();
  });

  it('rejects unauthenticated callers', async () => {
    const t = convexTest(schema);
    await expect(
      t.query(api.fuelEntries.resolveEntryType, { entryId: 'not-a-convex-id' }),
    ).rejects.toThrow('Unauthenticated');
  });
});
