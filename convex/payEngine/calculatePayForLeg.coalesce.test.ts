import { convexTest } from 'convex-test';
import { describe, it, expect } from 'vitest';
import schema from '../schema';
import { internal } from '../_generated/api';
import type { Id } from '../_generated/dataModel';

/**
 * Tests for the latest-wins coalesce guard on calculatePayForLeg.
 *
 * When two upstream sites (driverPayCalculation + carrierPayCalculation)
 * schedule a pay-engine recalc for the same leg, we don't want both
 * scheduled jobs to do work — they'd OCC-conflict on payItems.
 *
 * Contract:
 *   - Upstream patches leg.latestRecalcRequestedAt = Date.now() BEFORE
 *     scheduling calculatePayForLeg, and passes the same value as
 *     `requestedAt` in the scheduled args.
 *   - calculatePayForLeg exits early (without writing) if args.requestedAt
 *     is older than leg.latestRecalcRequestedAt — a newer recalc has been
 *     queued and our work would be immediately stale.
 *   - The returned warnings array carries 'COALESCED_NEWER_PENDING' so
 *     callers can detect the skip.
 */

const ORG = 'org_pay_coalesce_test';
const USER_SUBJECT = 'user_pay_coalesce_test';

interface World {
  driverId: Id<'drivers'>;
  loadId: Id<'loadInformation'>;
  loadStopId: Id<'loadStops'>;
  legId: Id<'dispatchLegs'>;
}

async function seedLegWithoutPayee(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  ctx: any,
): Promise<World> {
  const now = Date.now();
  const customerId = await ctx.db.insert('customers', {
    name: 'Pay Coalesce Customer',
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
  const driverId = await ctx.db.insert('drivers', {
    firstName: 'Pay',
    lastName: 'Driver',
    email: 'p@t.com',
    phone: '+15555550111',
    licenseState: 'CA',
    licenseExpiration: '2030-01-01',
    licenseClass: 'A',
    hireDate: '2020-01-01',
    employmentStatus: 'Active',
    employmentType: 'Full-time',
    organizationId: ORG,
    createdBy: USER_SUBJECT,
    createdAt: now,
    updatedAt: now,
  });
  const loadId = await ctx.db.insert('loadInformation', {
    internalId: 'LD-PAY-1',
    orderNumber: 'LD-PAY-1',
    status: 'Assigned',
    trackingStatus: 'Pending',
    customerId,
    fleet: 'Default',
    units: 'Pallets',
    workosOrgId: ORG,
    createdBy: USER_SUBJECT,
    createdAt: now,
    updatedAt: now,
  });
  const loadStopId = await ctx.db.insert('loadStops', {
    loadId,
    internalId: 'LD-PAY-1',
    sequenceNumber: 1,
    stopType: 'PICKUP',
    loadingType: 'APPT',
    address: '1 Pickup St',
    city: 'Pickupville',
    state: 'CA',
    windowBeginDate: '2026-05-20',
    windowBeginTime: '09:00:00-07:00',
    windowEndDate: '2026-05-20',
    windowEndTime: '11:00:00-07:00',
    workosOrgId: ORG,
    createdBy: USER_SUBJECT,
    createdAt: now,
    updatedAt: now,
  });
  // Leg with NO driverId / drivers[] / carrierPartnershipId — the
  // calculatePayForLeg early-exit for LEG_UNASSIGNED still goes through
  // the coalesce check first, which is what we're testing. This keeps
  // the test focused on the coalesce path without dragging in pay-rule
  // resolution.
  const legId = await ctx.db.insert('dispatchLegs', {
    loadId,
    sequence: 1,
    startStopId: loadStopId,
    endStopId: loadStopId,
    legLoadedMiles: 100,
    legEmptyMiles: 0,
    status: 'PENDING',
    workosOrgId: ORG,
    createdAt: now,
    updatedAt: now,
  });
  return { driverId, loadId, loadStopId, legId };
}

describe('calculatePayForLeg latest-wins coalesce', () => {
  it('exits early when args.requestedAt < leg.latestRecalcRequestedAt', async () => {
    const t = convexTest(schema);
    const { legId } = await t.run(async (ctx) => seedLegWithoutPayee(ctx));

    const tOld = Date.now() - 5_000;
    const tNew = Date.now();

    // Upstream simulation: a newer recalc has been queued. The leg's
    // latestRecalcRequestedAt reflects the LATER timestamp.
    await t.run(async (ctx) =>
      ctx.db.patch(legId, { latestRecalcRequestedAt: tNew }),
    );

    // The OLDER scheduled job now runs. It should detect the coalesce
    // and exit without doing work.
    const result = await t.mutation(
      internal.payEngine.calculatePayForLeg.calculatePayForLeg,
      { legId, userId: USER_SUBJECT, requestedAt: tOld },
    );

    expect(result.warnings).toContain('COALESCED_NEWER_PENDING');
    expect(result.emitted).toBe(0);
    expect(result.voided).toBe(0);
  });

  it('proceeds when args.requestedAt === leg.latestRecalcRequestedAt (the winning job)', async () => {
    const t = convexTest(schema);
    const { legId } = await t.run(async (ctx) => seedLegWithoutPayee(ctx));

    const tNow = Date.now();
    await t.run(async (ctx) =>
      ctx.db.patch(legId, { latestRecalcRequestedAt: tNow }),
    );

    // The winning job (same requestedAt). Should proceed past the
    // coalesce check. Falls through to LEG_UNASSIGNED in this seeded
    // world (no driver/carrier), which is fine — we're only verifying
    // the coalesce didn't short-circuit it.
    const result = await t.mutation(
      internal.payEngine.calculatePayForLeg.calculatePayForLeg,
      { legId, userId: USER_SUBJECT, requestedAt: tNow },
    );

    expect(result.warnings).not.toContain('COALESCED_NEWER_PENDING');
  });

  it('proceeds when leg.latestRecalcRequestedAt is undefined (backward compat)', async () => {
    const t = convexTest(schema);
    const { legId } = await t.run(async (ctx) => seedLegWithoutPayee(ctx));

    // No latestRecalcRequestedAt patched. A scheduled job carrying a
    // requestedAt arg should still run — otherwise legacy paths that
    // don't patch the field would be silently broken.
    const result = await t.mutation(
      internal.payEngine.calculatePayForLeg.calculatePayForLeg,
      { legId, userId: USER_SUBJECT, requestedAt: Date.now() },
    );

    expect(result.warnings).not.toContain('COALESCED_NEWER_PENDING');
  });

  it('proceeds when requestedAt is omitted entirely (direct/legacy callers)', async () => {
    const t = convexTest(schema);
    const { legId } = await t.run(async (ctx) => seedLegWithoutPayee(ctx));

    // Even with a newer latestRecalcRequestedAt on the leg, a caller
    // that doesn't pass requestedAt at all is treated as authoritative —
    // there's nothing to compare against.
    await t.run(async (ctx) =>
      ctx.db.patch(legId, { latestRecalcRequestedAt: Date.now() + 60_000 }),
    );

    const result = await t.mutation(
      internal.payEngine.calculatePayForLeg.calculatePayForLeg,
      { legId, userId: USER_SUBJECT },
    );

    expect(result.warnings).not.toContain('COALESCED_NEWER_PENDING');
  });
});
