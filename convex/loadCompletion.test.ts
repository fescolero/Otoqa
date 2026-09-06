/**
 * Load completion reconcile (lib/loadCompletion) — a load completes when its
 * counted stops are all closed by ANY source, stamped with who closed it:
 *
 *   - geofence grace check on the last open stop → Completed / 'geofence'
 *   - shift end with every stop closed → Completed / 'session_end'
 *   - shift end with a stop still open → load stays Assigned (honest state)
 *   - dispatcher status change → 'dispatcher'
 *   - a late-synced tap after the fence lands next to the fence record, and
 *     the derived progress reads it as manual_late_sync
 */

import { convexTest } from 'convex-test';
import { describe, it, expect } from 'vitest';
import schema from './schema';
import { internal } from './_generated/api';
import { runTapGraceCheck, TAP_GRACE_MS } from './geofenceEvaluator';
import { endSessionInternal } from './driverSessions';
import { loadProgressForLoad, reconcileLoadCompletion } from './lib/loadCompletion';
import type { Doc, Id } from './_generated/dataModel';
import type { MutationCtx } from './_generated/server';

const ORG = 'org_test_load_completion';
const MIN = 60_000;
const iso = (ms: number) => new Date(ms).toISOString();

async function insertFixtures(ctx: MutationCtx) {
  const now = Date.now();
  await ctx.db.insert('organizations', {
    name: 'Completion Carrier',
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
    firstName: 'Jorge', lastName: 'R', email: 'jr@t.co', phone: '+15550009999',
    licenseState: 'CA', licenseExpiration: '2030-01-01', licenseClass: 'A', hireDate: '2024-01-01',
    employmentStatus: 'Active', employmentType: 'Full-time', organizationId: ORG,
    createdBy: 'u', createdAt: now, updatedAt: now,
  });
  const truckId = await ctx.db.insert('trucks', {
    unitId: 'T-1', vin: 'VIN-1', status: 'Active', organizationId: ORG, createdBy: 'u', createdAt: now, updatedAt: now,
  });
  const sessionId = await ctx.db.insert('driverSessions', {
    driverId, truckId, organizationId: ORG, startedAt: now - 3 * 60 * MIN, status: 'active',
  });
  const customerId = await ctx.db.insert('customers', {
    name: 'USPS', companyType: 'Shipper', status: 'Active', addressLine1: '1', city: 'C', state: 'S', zip: 'Z', country: 'US',
    workosOrgId: ORG, createdBy: 'u', createdAt: now, updatedAt: now,
  });
  const loadId = await ctx.db.insert('loadInformation', {
    internalId: '121536139', orderNumber: '121536139', status: 'Assigned', trackingStatus: 'In Transit',
    customerId, customerName: 'USPS', fleet: 'Main', units: 'Pallets', primaryDriverId: driverId,
    workosOrgId: ORG, createdBy: 'u', createdAt: now, updatedAt: now,
  });
  const stop = (sequenceNumber: number, stopType: 'PICKUP' | 'DELIVERY', extra: Record<string, unknown> = {}) =>
    ctx.db.insert('loadStops', {
      loadId, internalId: '121536139', sequenceNumber, stopType, loadingType: 'APPT', status: 'Pending',
      address: `${sequenceNumber} Dock St`, city: `City${sequenceNumber}`, state: 'CA', workosOrgId: ORG,
      createdBy: 'u', createdAt: now, updatedAt: now, ...extra,
    });
  // Driver tapped stops 1 and 2; 3 and 4 are still open.
  const s1 = await stop(1, 'PICKUP', { status: 'Completed', checkedInAt: iso(now - 150 * MIN), checkedOutAt: iso(now - 142 * MIN) });
  const s2 = await stop(2, 'DELIVERY', { status: 'Completed', checkedInAt: iso(now - 120 * MIN), checkedOutAt: iso(now - 112 * MIN) });
  const s3 = await stop(3, 'DELIVERY');
  const s4 = await stop(4, 'DELIVERY');
  const legId = await ctx.db.insert('dispatchLegs', {
    loadId, driverId, sequence: 1, startStopId: s1, endStopId: s4, legLoadedMiles: 64, legEmptyMiles: 0,
    status: 'ACTIVE', startedAt: now - 160 * MIN, workosOrgId: ORG, createdAt: now, updatedAt: now,
  });
  return { now, driverId, sessionId, loadId, s1, s2, s3, s4, legId };
}

async function closeByFence(ctx: MutationCtx, stopId: Id<'loadStops'>, detectedAt: number) {
  await runTapGraceCheck(ctx, { stopId, kind: 'checkin', detectedAt });
  await runTapGraceCheck(ctx, { stopId, kind: 'checkout', detectedAt: detectedAt + 8 * MIN });
}

describe('reconcileLoadCompletion', () => {
  it('geofence closing the last open stop completes the load as geofence', async () => {
    const t = convexTest(schema);
    await t.run(async (ctx) => {
      const f = await insertFixtures(ctx);
      await closeByFence(ctx, f.s3, f.now - 80 * MIN);
      // Three of four closed: still Assigned, still in transit, 75%.
      let load = (await ctx.db.get(f.loadId)) as Doc<'loadInformation'>;
      expect(load.status).toBe('Assigned');
      let progress = await loadProgressForLoad(ctx, load);
      expect(progress.status).toBe('in_transit');
      expect(progress.percent).toBe(75);

      await closeByFence(ctx, f.s4, f.now - 30 * MIN);
      load = (await ctx.db.get(f.loadId)) as Doc<'loadInformation'>;
      expect(load.status).toBe('Completed');
      expect(load.trackingStatus).toBe('Completed');
      expect(load.completionSource).toBe('geofence');
      expect(load.deliveredAt).toBeTypeOf('number');

      // The completion cascade closed the leg too.
      const leg = (await ctx.db.get(f.legId)) as Doc<'dispatchLegs'>;
      expect(leg.status).toBe('COMPLETED');

      progress = await loadProgressForLoad(ctx, load);
      expect(progress.status).toBe('delivered');
      expect(progress.recordedStatus).toBe('Completed');
      expect(progress.evidence).toBe('mixed');
      expect(progress.closedBy.manual).toBe(2);
      expect(progress.closedBy.gps).toBe(2);
      expect(progress.completionSource).toBe('geofence');
    });
  });

  it('shift end completes the load when every stop is closed, and leaves it open otherwise', async () => {
    const t = convexTest(schema);
    await t.run(async (ctx) => {
      const f = await insertFixtures(ctx);
      const session = (await ctx.db.get(f.sessionId)) as Doc<'driverSessions'>;

      // Stops 3 and 4 still open: ending the shift closes the leg but the
      // load is honestly not delivered.
      await endSessionInternal(ctx, session, { endReason: 'driver_manual', endedAt: f.now });
      const leg = (await ctx.db.get(f.legId)) as Doc<'dispatchLegs'>;
      expect(leg.status).toBe('COMPLETED');
      expect(leg.endReason).toBe('session_ended');
      const load = (await ctx.db.get(f.loadId)) as Doc<'loadInformation'>;
      expect(load.status).toBe('Assigned');
      expect(load.completionSource).toBeUndefined();
    });

    const t2 = convexTest(schema);
    await t2.run(async (ctx) => {
      const f = await insertFixtures(ctx);
      // Close 3 and 4 by fence but make the grace check unable to reconcile
      // by patching directly (simulates rows closed before the reconcile
      // existed).
      await ctx.db.patch(f.s3, { status: 'Completed', autoArrivedAt: f.now - 80 * MIN, autoDepartedAt: f.now - 72 * MIN });
      await ctx.db.patch(f.s4, { status: 'Completed', autoArrivedAt: f.now - 30 * MIN, autoDepartedAt: f.now - 22 * MIN });
      const session = (await ctx.db.get(f.sessionId)) as Doc<'driverSessions'>;
      await endSessionInternal(ctx, session, { endReason: 'driver_manual', endedAt: f.now });
      const load = (await ctx.db.get(f.loadId)) as Doc<'loadInformation'>;
      expect(load.status).toBe('Completed');
      expect(load.completionSource).toBe('session_end');
    });
  });

  it('is a no-op for Open, Completed and Canceled loads and for loads with open stops', async () => {
    const t = convexTest(schema);
    await t.run(async (ctx) => {
      const f = await insertFixtures(ctx);
      expect(await reconcileLoadCompletion(ctx, f.loadId, 'reconcile')).toBe(false);
      await ctx.db.patch(f.s3, { status: 'Completed', autoDepartedAt: f.now });
      await ctx.db.patch(f.s4, { status: 'Completed', autoDepartedAt: f.now });
      await ctx.db.patch(f.loadId, { status: 'Open' });
      expect(await reconcileLoadCompletion(ctx, f.loadId, 'reconcile')).toBe(false);
      await ctx.db.patch(f.loadId, { status: 'Canceled', trackingStatus: 'Canceled' });
      expect(await reconcileLoadCompletion(ctx, f.loadId, 'reconcile')).toBe(false);
      await ctx.db.patch(f.loadId, { status: 'Assigned', trackingStatus: 'In Transit' });
      expect(await reconcileLoadCompletion(ctx, f.loadId, 'reconcile')).toBe(true);
      expect(await reconcileLoadCompletion(ctx, f.loadId, 'reconcile')).toBe(false); // already Completed
      const load = (await ctx.db.get(f.loadId)) as Doc<'loadInformation'>;
      expect(load.completionSource).toBe('reconcile');
    });
  });

  it('the hourly sweep completes stranded loads org-wide', async () => {
    const t = convexTest(schema);
    const loadId = await t.run(async (ctx) => {
      const f = await insertFixtures(ctx);
      await ctx.db.patch(f.s3, { status: 'Completed', autoArrivedAt: f.now - 80 * MIN, autoDepartedAt: f.now - 72 * MIN });
      await ctx.db.patch(f.s4, { status: 'Completed', autoArrivedAt: f.now - 30 * MIN, autoDepartedAt: f.now - 22 * MIN });
      return f.loadId;
    });
    const result = await t.mutation(internal.loads.reconcileStuckLoads, { orgId: ORG });
    expect(result).toEqual({ scanned: 1, completed: 1 });
    await t.run(async (ctx) => {
      const load = (await ctx.db.get(loadId)) as Doc<'loadInformation'>;
      expect(load.status).toBe('Completed');
      expect(load.completionSource).toBe('reconcile');
    });
  });

  it('a driver tap replaying after an inferred completion upgrades the provenance and keeps deliveredAt', async () => {
    const t = convexTest(schema);
    await t.run(async (ctx) => {
      const f = await insertFixtures(ctx);
      await ctx.db.patch(f.s3, { status: 'Completed', autoArrivedAt: f.now - 80 * MIN, autoDepartedAt: f.now - 72 * MIN });
      await ctx.db.patch(f.s4, { status: 'Completed', autoArrivedAt: f.now - 30 * MIN, autoDepartedAt: f.now - 22 * MIN });
      expect(await reconcileLoadCompletion(ctx, f.loadId, 'geofence')).toBe(true);
      const first = (await ctx.db.get(f.loadId)) as Doc<'loadInformation'>;
      expect(first.completionSource).toBe('geofence');

      // The driver's final check-out replays later through the tap path.
      await ctx.runMutation(internal.loads.updateLoadStatusInternal, {
        loadId: f.loadId,
        status: 'Completed',
        completionSource: 'driver_checkout',
      });
      const second = (await ctx.db.get(f.loadId)) as Doc<'loadInformation'>;
      expect(second.completionSource).toBe('driver_checkout');
      expect(second.deliveredAt).toBe(first.deliveredAt);

      // A later non-tap re-completion does not downgrade it.
      await ctx.runMutation(internal.loads.updateLoadStatusInternal, {
        loadId: f.loadId,
        status: 'Completed',
        completionSource: 'reconcile',
      });
      const third = (await ctx.db.get(f.loadId)) as Doc<'loadInformation'>;
      expect(third.completionSource).toBe('driver_checkout');
    });
  });

  it('dispatcher completion is stamped as dispatcher', async () => {
    const t = convexTest(schema);
    await t.run(async (ctx) => {
      const f = await insertFixtures(ctx);
      await ctx.runMutation(internal.loads.updateLoadStatusInternal, { loadId: f.loadId, status: 'Completed' });
      const load = (await ctx.db.get(f.loadId)) as Doc<'loadInformation'>;
      expect(load.completionSource).toBe('dispatcher');
    });
  });
});

describe('late-synced tap next to a fence record', () => {
  it('reads as manual_late_sync with the sync lag, not as a missed tap', async () => {
    const t = convexTest(schema);
    await t.run(async (ctx) => {
      const f = await insertFixtures(ctx);
      const detectedAt = f.now - 80 * MIN;
      // Fence fired first (driver's tap was stuck in the offline queue).
      await runTapGraceCheck(ctx, { stopId: f.s3, kind: 'checkin', detectedAt });
      // The tap replays later: made 4 min after detection, written now.
      const tapAt = detectedAt + 4 * MIN;
      await ctx.db.patch(f.s3, {
        checkedInAt: iso(tapAt),
        checkedInSync: { receivedAt: f.now, replayed: true, queuedAt: tapAt, retryCount: 3 },
      });
      const load = (await ctx.db.get(f.loadId)) as Doc<'loadInformation'>;
      const progress = await loadProgressForLoad(ctx, load);
      const s3 = progress.stops.find((s) => s.sequenceNumber === 3)!;
      expect(s3.phase).toBe('arrived');
      expect(s3.arrival?.source).toBe('manual_late_sync');
      expect(s3.arrival?.at).toBe(tapAt);
      expect(s3.arrival?.detectedAt).toBe(detectedAt);
      expect(s3.arrival?.syncLagMs).toBe(f.now - tapAt);
      expect(s3.arrival?.replayed).toBe(true);
      expect(s3.supported).toBe(true);

      // A tap made after the grace window is a late tap.
      const lateTap = detectedAt + TAP_GRACE_MS + MIN;
      await ctx.db.patch(f.s3, { checkedInAt: iso(lateTap), checkedInSync: { receivedAt: f.now } });
      const again = await loadProgressForLoad(ctx, load);
      expect(again.stops.find((s) => s.sequenceNumber === 3)!.arrival?.source).toBe('manual_late_tap');
    });
  });
});
