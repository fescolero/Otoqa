/**
 * loads.getDriverYearStats — the "Loads YTD" / "Miles YTD" KPIs.
 *
 * Counts COMPLETED legs scheduled to start inside [yearStartMs, yearEndMs):
 * a load split into several legs counts once, miles sum across legs, and
 * legs outside the window or not yet completed are ignored.
 */

import { convexTest } from 'convex-test';
import { describe, it, expect } from 'vitest';
import schema from './schema';
import { api } from './_generated/api';
import type { MutationCtx } from './_generated/server';
import type { Id } from './_generated/dataModel';

const ORG = 'org_ytd_test';
const OTHER_ORG = 'org_ytd_other';
const staff = { subject: 's_ytd', org_id: ORG };
const outsider = { subject: 's_out', org_id: OTHER_ORG };

const YEAR_START = Date.UTC(2026, 0, 1);
const YEAR_END = Date.UTC(2027, 0, 1);
const DAY = 86_400_000;

async function insertFixtures(ctx: MutationCtx) {
  const now = YEAR_START + 100 * DAY;

  await ctx.db.insert('organizations', {
    name: 'YTD Carrier',
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
    firstName: 'Ytd',
    lastName: 'Driver',
    email: 'ytd@t.co',
    phone: '+15550001111',
    licenseState: 'CA',
    licenseExpiration: '2030-01-01',
    licenseClass: 'A',
    hireDate: '2024-01-01',
    employmentStatus: 'Active',
    employmentType: 'Full-time',
    organizationId: ORG,
    createdBy: 'u',
    createdAt: now,
    updatedAt: now,
  });

  const customerId = await ctx.db.insert('customers', {
    name: 'Cust',
    companyType: 'Shipper',
    status: 'Active',
    addressLine1: '1',
    city: 'C',
    state: 'S',
    zip: 'Z',
    country: 'US',
    workosOrgId: ORG,
    createdBy: 'u',
    createdAt: now,
    updatedAt: now,
  });

  const mkLoad = async (orderNumber: string) => {
    const loadId = await ctx.db.insert('loadInformation', {
      internalId: orderNumber,
      orderNumber,
      status: 'Completed',
      trackingStatus: 'In Transit',
      customerId,
      customerName: 'Cust',
      fleet: 'Main',
      units: 'Pallets',
      workosOrgId: ORG,
      createdBy: 'u',
      createdAt: now,
      updatedAt: now,
    });
    const mkStop = (stopType: 'PICKUP' | 'DELIVERY', sequenceNumber: number) =>
      ctx.db.insert('loadStops', {
        loadId,
        internalId: orderNumber,
        sequenceNumber,
        stopType,
        loadingType: 'APPT',
        address: '1 Dock St',
        city: 'C',
        state: 'CA',
        workosOrgId: ORG,
        createdAt: now,
        updatedAt: now,
      });
    return { loadId, s1: await mkStop('PICKUP', 1), s2: await mkStop('DELIVERY', 2) };
  };

  const mkLeg = (
    l: { loadId: Id<'loadInformation'>; s1: Id<'loadStops'>; s2: Id<'loadStops'> },
    status: 'COMPLETED' | 'ACTIVE' | 'PENDING',
    scheduledStartMs: number,
    legLoadedMiles: number,
    sequence = 1,
  ) =>
    ctx.db.insert('dispatchLegs', {
      loadId: l.loadId,
      driverId,
      sequence,
      startStopId: l.s1,
      endStopId: l.s2,
      legLoadedMiles,
      legEmptyMiles: 0,
      status,
      scheduledStartMs,
      workosOrgId: ORG,
      createdAt: now,
      updatedAt: now,
    });

  // Split load: two completed legs this year → counts once, miles sum.
  const split = await mkLoad('SPLIT');
  await mkLeg(split, 'COMPLETED', YEAR_START + 10 * DAY, 100, 1);
  await mkLeg(split, 'COMPLETED', YEAR_START + 11 * DAY, 50.4, 2);
  // Plain completed load this year.
  await mkLeg(await mkLoad('PLAIN'), 'COMPLETED', YEAR_START + 40 * DAY, 300);
  // Completed last year → excluded.
  await mkLeg(await mkLoad('LAST-YEAR'), 'COMPLETED', YEAR_START - 5 * DAY, 999);
  // Scheduled exactly at next year's start → excluded (half-open range).
  await mkLeg(await mkLoad('NEXT-YEAR'), 'COMPLETED', YEAR_END, 999);
  // Still running this year → excluded.
  await mkLeg(await mkLoad('ACTIVE'), 'ACTIVE', YEAR_START + 50 * DAY, 999);

  return { driverId };
}

describe('loads.getDriverYearStats', () => {
  it('counts distinct completed loads and rounds summed loaded miles inside the year', async () => {
    const t = convexTest(schema);
    const { driverId } = await t.run(insertFixtures);
    const stats = await t
      .withIdentity(staff as never)
      .query(api.loads.getDriverYearStats, { driverId, yearStartMs: YEAR_START, yearEndMs: YEAR_END });
    expect(stats).toEqual({ loads: 2, miles: 450 });
  });

  it('returns zeros for a year with no completed legs', async () => {
    const t = convexTest(schema);
    const { driverId } = await t.run(insertFixtures);
    const stats = await t
      .withIdentity(staff as never)
      .query(api.loads.getDriverYearStats, { driverId, yearStartMs: YEAR_END + 400 * DAY, yearEndMs: YEAR_END + 800 * DAY });
    expect(stats).toEqual({ loads: 0, miles: 0 });
  });

  it('refuses a driver from another organization', async () => {
    const t = convexTest(schema);
    const { driverId } = await t.run(insertFixtures);
    await expect(
      t.withIdentity(outsider as never).query(api.loads.getDriverYearStats, { driverId, yearStartMs: YEAR_START, yearEndMs: YEAR_END }),
    ).rejects.toThrow(/Not authorized/);
  });
});
