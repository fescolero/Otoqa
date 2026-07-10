import { convexTest } from 'convex-test';
import { describe, it, expect } from 'vitest';
import schema from './schema';
import { api } from './_generated/api';
import type { Id } from './_generated/dataModel';

/**
 * Integration tests for analyzeLanePerformance's load matching.
 *
 * The query matches a lane's loads through the facet system with a
 * date-bounded index scan (findLaneLoadIdsInRange). These tests pin the
 * matching semantics: date-window filtering, Completed-status filtering,
 * HCR verification for trip-specific lanes, and wildcard-trip lanes.
 */

const ORG = 'org_lane_perf_test';
const USER_SUBJECT = 'user_lane_perf';

const identity = {
  subject: USER_SUBJECT,
  org_id: ORG,
  name: 'Test User',
  email: 'test@test.com',
};

// eslint-disable-next-line @typescript-eslint/no-explicit-any
async function seedCustomer(ctx: any): Promise<Id<'customers'>> {
  const now = Date.now();
  return await ctx.db.insert('customers', {
    name: 'Lane Perf Test Customer',
    companyType: 'Shipper',
    status: 'Active',
    addressLine1: '1 Test St',
    city: 'Testville',
    state: 'CA',
    zip: '00000',
    country: 'USA',
    workosOrgId: ORG,
    createdBy: USER_SUBJECT,
    createdAt: now,
    updatedAt: now,
  });
}

async function seedLane(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  ctx: any,
  customerId: Id<'customers'>,
  hcr: string,
  tripNumber: string,
): Promise<Id<'contractLanes'>> {
  const now = Date.now();
  return await ctx.db.insert('contractLanes', {
    contractName: `Lane ${hcr}/${tripNumber}`,
    contractPeriodStart: '2026-01-01',
    contractPeriodEnd: '2026-12-31',
    hcr,
    tripNumber,
    customerCompanyId: customerId,
    stops: [],
    rate: 1000,
    rateType: 'Flat Rate' as const,
    currency: 'USD' as const,
    isDeleted: false,
    workosOrgId: ORG,
    createdBy: USER_SUBJECT,
    createdAt: now,
    updatedAt: now,
  });
}

const baseStop = (
  sequenceNumber: number,
  stopType: 'PICKUP' | 'DELIVERY',
  date: string,
) => ({
  sequenceNumber,
  stopType,
  loadingType: 'APPT' as const,
  address: '1 Stop St',
  city: 'Stopville',
  state: 'CA',
  postalCode: '00001',
  windowBeginDate: date,
  windowBeginTime: '09:00',
  windowEndDate: date,
  windowEndTime: '17:00',
  commodityDescription: 'Test',
  commodityUnits: 'Pallets' as const,
  pieces: 1,
});

interface SeedLoadArgs {
  internalId: string;
  hcr: string;
  trip: string;
  date: string;
  revenue: number;
  status?: 'Open' | 'Completed';
}

describe('laneAnalyzerOptimization.analyzeLanePerformance', () => {
  async function setup() {
    const t = convexTest(schema);
    const asUser = t.withIdentity(identity);
    const customerId = await t.run((ctx) => seedCustomer(ctx));

    const seedLoad = async (loadArgs: SeedLoadArgs) => {
      const loadId = await asUser.mutation(api.loads.createLoad, {
        workosOrgId: ORG,
        createdBy: USER_SUBJECT,
        internalId: loadArgs.internalId,
        orderNumber: loadArgs.internalId,
        customerId,
        fleet: 'Default',
        units: 'Pallets',
        parsedHcr: loadArgs.hcr,
        parsedTripNumber: loadArgs.trip,
        stops: [
          baseStop(1, 'PICKUP', loadArgs.date),
          baseStop(2, 'DELIVERY', loadArgs.date),
        ],
      });
      await t.run(async (ctx) => {
        await ctx.db.patch(loadId, {
          status: loadArgs.status ?? 'Completed',
          effectiveMiles: 100,
        });
        const now = Date.now();
        await ctx.db.insert('loadInvoices', {
          loadId,
          customerId,
          workosOrgId: ORG,
          status: 'PAID' as const,
          currency: 'USD' as const,
          totalAmount: loadArgs.revenue,
          createdBy: USER_SUBJECT,
          createdAt: now,
          updatedAt: now,
        });
      });
      return loadId;
    };

    // In the April window, matching lane 917DK/T01
    await seedLoad({ internalId: 'L1', hcr: '917DK', trip: 'T01', date: '2026-04-20', revenue: 1200 });
    // Same lane, outside the date window
    await seedLoad({ internalId: 'L2', hcr: '917DK', trip: 'T01', date: '2026-01-15', revenue: 500 });
    // Same trip number under a DIFFERENT HCR — must not match 917DK lanes
    await seedLoad({ internalId: 'L3', hcr: '999AA', trip: 'T01', date: '2026-04-21', revenue: 800 });
    // Same HCR, different trip — only matches the wildcard lane
    await seedLoad({ internalId: 'L4', hcr: '917DK', trip: 'T02', date: '2026-04-22', revenue: 700 });
    // In window and matching, but not Completed
    await seedLoad({ internalId: 'L5', hcr: '917DK', trip: 'T01', date: '2026-04-23', revenue: 999, status: 'Open' });

    return { t, asUser, customerId };
  }

  it('matches only Completed loads with the lane HCR+trip inside the date window', async () => {
    const { t, asUser, customerId } = await setup();
    const laneId = await t.run((ctx) => seedLane(ctx, customerId, '917DK', 'T01'));

    const results = await asUser.query(
      api.laneAnalyzerOptimization.analyzeLanePerformance,
      {
        workosOrgId: ORG,
        contractLaneIds: [laneId],
        dateRangeStart: '2026-04-01',
        dateRangeEnd: '2026-04-30',
      },
    );

    expect(results).toHaveLength(1);
    const lane = results[0];
    expect(lane.totalRuns).toBe(1); // only L1
    expect(lane.metrics.totalRevenue).toBe(1200);
    expect(lane.comparison.expectedRevenuePerRun).toBe(1000);
    expect(lane.comparison.revenueVariance).toBe(20);
    expect(lane.flags).toContain('LOW_SAMPLE_SIZE');
  });

  it('wildcard trip lane matches every trip of the HCR in the window', async () => {
    const { t, asUser, customerId } = await setup();
    const laneId = await t.run((ctx) => seedLane(ctx, customerId, '917DK', '*'));

    const results = await asUser.query(
      api.laneAnalyzerOptimization.analyzeLanePerformance,
      {
        workosOrgId: ORG,
        contractLaneIds: [laneId],
        dateRangeStart: '2026-04-01',
        dateRangeEnd: '2026-04-30',
      },
    );

    expect(results).toHaveLength(1);
    const lane = results[0];
    expect(lane.totalRuns).toBe(2); // L1 + L4; L3 is a different HCR
    expect(lane.metrics.totalRevenue).toBe(1900);
  });

  it('returns a NO_DATA row when nothing matches in the window', async () => {
    const { t, asUser, customerId } = await setup();
    const laneId = await t.run((ctx) => seedLane(ctx, customerId, '917DK', 'T01'));

    const results = await asUser.query(
      api.laneAnalyzerOptimization.analyzeLanePerformance,
      {
        workosOrgId: ORG,
        contractLaneIds: [laneId],
        dateRangeStart: '2027-01-01',
        dateRangeEnd: '2027-01-31',
      },
    );

    expect(results).toHaveLength(1);
    expect(results[0].totalRuns).toBe(0);
    expect(results[0].flags).toEqual(['NO_DATA']);
  });
});
