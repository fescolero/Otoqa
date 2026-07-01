import { convexTest } from 'convex-test';
import { describe, it, expect } from 'vitest';
import schema from './schema';
import type { Id } from './_generated/dataModel';
import { api } from './_generated/api';

/**
 * Tests for loads.countLoadsByStatusFiltered. The fix replaced unbounded
 * `.collect()` + per-load `Promise.all(get)` fan-outs with `.take(cap)`-bounded
 * reads so the query can never exceed Convex's 4096-read limit. These assert
 * each branch still produces EXACT status counts for normal buckets:
 *   - no filter        → denormalized organizationStats fast path
 *   - HCR/TRIP facet   → loadTags bucket, get each load, tally
 *   - HCR ∩ TRIP       → only loads carrying BOTH facets
 *   - date range only  → loadInformation date-index scan
 */

const ORG = 'org_count_test';
const USER = 'user_count_test';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
async function seedCustomer(ctx: any): Promise<Id<'customers'>> {
  const now = Date.now();
  return ctx.db.insert('customers', {
    name: 'C',
    companyType: 'Shipper',
    status: 'Active',
    addressLine1: '1 St',
    city: 'Town',
    state: 'CA',
    zip: '00000',
    country: 'USA',
    workosOrgId: ORG,
    createdBy: USER,
    createdAt: now,
    updatedAt: now,
  });
}

type LoadStatus = 'Open' | 'Assigned' | 'Completed' | 'Canceled' | 'Expired';

async function seedLoad(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  ctx: any,
  customerId: Id<'customers'>,
  opts: { status: LoadStatus; firstStopDate?: string; hcr?: string; trip?: string },
): Promise<Id<'loadInformation'>> {
  const now = Date.now();
  const loadId = await ctx.db.insert('loadInformation', {
    internalId: `LD-${Math.round(now)}-${Math.floor(now % 100000)}-${opts.status}`,
    orderNumber: 'ORD',
    status: opts.status,
    trackingStatus: 'In Transit',
    customerId,
    fleet: 'Default',
    units: 'Pallets',
    firstStopDate: opts.firstStopDate,
    workosOrgId: ORG,
    createdBy: USER,
    createdAt: now,
    updatedAt: now,
  });
  if (opts.hcr) {
    await ctx.db.insert('loadTags', {
      workosOrgId: ORG,
      loadId,
      facetKey: 'HCR',
      canonicalValue: opts.hcr.toUpperCase(),
      value: opts.hcr,
      firstStopDate: opts.firstStopDate,
    });
  }
  if (opts.trip) {
    await ctx.db.insert('loadTags', {
      workosOrgId: ORG,
      loadId,
      facetKey: 'TRIP',
      canonicalValue: opts.trip.toUpperCase(),
      value: opts.trip,
      firstStopDate: opts.firstStopDate,
    });
  }
  return loadId;
}

function authed() {
  return convexTest(schema).withIdentity({ subject: USER, org_id: ORG });
}

describe('countLoadsByStatusFiltered', () => {
  it('no filter → reads denormalized organizationStats (Completed maps to Delivered)', async () => {
    const t = authed();
    await t.run(async (ctx) => {
      await ctx.db.insert('organizationStats', {
        workosOrgId: ORG,
        loadCounts: { Open: 5, Assigned: 3, Completed: 7, Canceled: 2, Expired: 1 },
        invoiceCounts: {
          MISSING_DATA: 0,
          DRAFT: 0,
          BILLED: 0,
          PENDING_PAYMENT: 0,
          PAID: 0,
          VOID: 0,
        },
        updatedAt: Date.now(),
      });
    });

    const counts = await t.query(api.loads.countLoadsByStatusFiltered, {
      workosOrgId: ORG,
    });

    expect(counts).toEqual({ Open: 5, Assigned: 3, Delivered: 7, Canceled: 2, Expired: 1 });
  });

  it('HCR facet → tallies only loads carrying that HCR, by status', async () => {
    const t = authed();
    await t.run(async (ctx) => {
      const customerId = await seedCustomer(ctx);
      await seedLoad(ctx, customerId, { status: 'Open', hcr: '917DK', firstStopDate: '2026-05-10' });
      await seedLoad(ctx, customerId, { status: 'Assigned', hcr: '917DK', firstStopDate: '2026-05-11' });
      await seedLoad(ctx, customerId, { status: 'Completed', hcr: '917DK', firstStopDate: '2026-05-12' });
      // Different HCR — must NOT be counted.
      await seedLoad(ctx, customerId, { status: 'Open', hcr: 'OTHER', firstStopDate: '2026-05-12' });
      // No tag at all — must NOT be counted.
      await seedLoad(ctx, customerId, { status: 'Assigned', firstStopDate: '2026-05-12' });
    });

    const counts = await t.query(api.loads.countLoadsByStatusFiltered, {
      workosOrgId: ORG,
      hcr: '917dk', // lower-case → canonicalized to 917DK
    });

    expect(counts).toEqual({ Open: 1, Assigned: 1, Delivered: 1, Canceled: 0, Expired: 0 });
  });

  it('HCR ∩ TRIP → counts only loads carrying BOTH facets', async () => {
    const t = authed();
    await t.run(async (ctx) => {
      const customerId = await seedCustomer(ctx);
      // Both facets — counted.
      await seedLoad(ctx, customerId, {
        status: 'Assigned',
        hcr: '917DK',
        trip: 'T100',
        firstStopDate: '2026-05-10',
      });
      // HCR matches but TRIP differs — not counted.
      await seedLoad(ctx, customerId, {
        status: 'Open',
        hcr: '917DK',
        trip: 'T999',
        firstStopDate: '2026-05-11',
      });
      // TRIP matches but no HCR — not counted.
      await seedLoad(ctx, customerId, {
        status: 'Open',
        trip: 'T100',
        firstStopDate: '2026-05-11',
      });
    });

    const counts = await t.query(api.loads.countLoadsByStatusFiltered, {
      workosOrgId: ORG,
      hcr: '917DK',
      tripNumber: 'T100',
    });

    expect(counts).toEqual({ Open: 0, Assigned: 1, Delivered: 0, Canceled: 0, Expired: 0 });
  });

  it('date range only → counts loads whose firstStopDate is in-window', async () => {
    const t = authed();
    await t.run(async (ctx) => {
      const customerId = await seedCustomer(ctx);
      await seedLoad(ctx, customerId, { status: 'Open', firstStopDate: '2026-05-10' });
      await seedLoad(ctx, customerId, { status: 'Completed', firstStopDate: '2026-05-15' });
      // Out of window — excluded.
      await seedLoad(ctx, customerId, { status: 'Assigned', firstStopDate: '2026-06-01' });
      await seedLoad(ctx, customerId, { status: 'Open', firstStopDate: '2026-04-01' });
    });

    const counts = await t.query(api.loads.countLoadsByStatusFiltered, {
      workosOrgId: ORG,
      startDate: '2026-05-01',
      endDate: '2026-05-31',
    });

    expect(counts).toEqual({ Open: 1, Assigned: 0, Delivered: 1, Canceled: 0, Expired: 0 });
  });

  it('rejects a caller whose identity org does not match', async () => {
    const t = convexTest(schema).withIdentity({ subject: USER, org_id: 'other_org' });
    await expect(
      t.query(api.loads.countLoadsByStatusFiltered, { workosOrgId: ORG, hcr: 'X' }),
    ).rejects.toThrow(/Not authorized/);
  });
});
