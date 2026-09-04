/**
 * completeLeg stamps deliveriesEvaluated / deliveriesOnTime from the leg's
 * stops (lib/legOnTime.ts) so the driver On-time KPI never re-derives it.
 */

import { convexTest } from 'convex-test';
import { describe, it, expect } from 'vitest';
import schema from './schema';
import { internal } from './_generated/api';
import type { MutationCtx } from './_generated/server';

const ORG = 'org_ontime_stamp';
const MIN = 60_000;
const WINDOW_END = Date.UTC(2026, 5, 10, 17, 0, 0);
const iso = (ms: number) => new Date(ms).toISOString();

async function insertFixtures(ctx: MutationCtx) {
  const now = WINDOW_END + 3 * 60 * MIN;

  await ctx.db.insert('organizations', {
    name: 'Stamp Carrier',
    workosOrgId: ORG,
    orgType: 'BROKER_CARRIER',
    billingEmail: 'b@t.co',
    billingAddress: { addressLine1: '1', city: 'C', state: 'S', zip: 'Z', country: 'US' },
    subscriptionPlan: 'E',
    subscriptionStatus: 'Active',
    billingCycle: 'Annual',
    createdAt: now,
    updatedAt: now,
  });
  const driverId = await ctx.db.insert('drivers', {
    firstName: 'Stamp', lastName: 'D', email: 'stamp@t.co', phone: '+15550002222',
    licenseState: 'CA', licenseExpiration: '2030-01-01', licenseClass: 'A', hireDate: '2024-01-01',
    employmentStatus: 'Active', employmentType: 'Full-time', organizationId: ORG,
    createdBy: 'u', createdAt: now, updatedAt: now,
  });
  const customerId = await ctx.db.insert('customers', {
    name: 'Cust', companyType: 'Shipper', status: 'Active', addressLine1: '1', city: 'C', state: 'S', zip: 'Z', country: 'US',
    workosOrgId: ORG, createdBy: 'u', createdAt: now, updatedAt: now,
  });
  const loadId = await ctx.db.insert('loadInformation', {
    internalId: 'STAMP-1', orderNumber: 'STAMP-1', status: 'Assigned', trackingStatus: 'In Transit',
    customerId, customerName: 'Cust', fleet: 'Main', units: 'Pallets',
    workosOrgId: ORG, createdBy: 'u', createdAt: now, updatedAt: now,
  });
  const stop = (sequenceNumber: number, stopType: 'PICKUP' | 'DELIVERY', extra: Record<string, unknown>) =>
    ctx.db.insert('loadStops', {
      loadId, internalId: 'STAMP-1', sequenceNumber, stopType, loadingType: 'APPT',
      address: '1 Dock St', city: 'C', state: 'CA', workosOrgId: ORG, createdAt: now, updatedAt: now,
      ...extra,
    });
  const s1 = await stop(1, 'PICKUP', { windowEndDate: '2026-06-10', windowEndTime: iso(WINDOW_END - 4 * 60 * MIN), checkedInAt: iso(WINDOW_END) }); // late pickup: ignored
  await stop(2, 'DELIVERY', { windowEndDate: '2026-06-10', windowEndTime: iso(WINDOW_END), checkedInAt: iso(WINDOW_END + 10 * MIN) }); // within grace
  await stop(3, 'DELIVERY', { windowEndDate: '2026-06-10', windowEndTime: iso(WINDOW_END), checkedInAt: iso(WINDOW_END + 90 * MIN), autoArrivedAt: WINDOW_END - MIN }); // fence rescues late tap
  const s4 = await stop(4, 'DELIVERY', { windowEndDate: '2026-06-10', windowEndTime: iso(WINDOW_END), checkedInAt: iso(WINDOW_END + 16 * MIN) }); // 1 min past grace → late

  const legId = await ctx.db.insert('dispatchLegs', {
    loadId, driverId, sequence: 1, startStopId: s1, endStopId: s4,
    legLoadedMiles: 120, legEmptyMiles: 0, status: 'ACTIVE', scheduledStartMs: WINDOW_END - 8 * 60 * MIN,
    workosOrgId: ORG, createdAt: now, updatedAt: now,
  });
  return { legId, now };
}

describe('dispatchLegs.completeLeg on-time stamp', () => {
  it('writes evaluated/on-time counts for the delivery stops the leg covers', async () => {
    const t = convexTest(schema);
    const { legId, now } = await t.run(insertFixtures);
    await t.mutation(internal.dispatchLegs.completeLeg, { legId, endReason: 'completed', endedAt: now });
    const leg = await t.run((ctx) => ctx.db.get(legId));
    expect(leg?.status).toBe('COMPLETED');
    expect(leg?.deliveriesEvaluated).toBe(3);
    expect(leg?.deliveriesOnTime).toBe(2);
    expect(leg?.deliveriesMaxLateMs).toBe(1 * MIN); // stop 4: 16 min past a 15-min grace
  });
});
