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
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { vi } from 'vitest';
import schema from './schema';
import { internal } from './_generated/api';
import { runTapGraceCheck, TAP_GRACE_MS } from './geofenceEvaluator';
import { endSessionInternal } from './driverSessions';
import { loadProgressForLoad, reconcileLoadCompletion } from './lib/loadCompletion';
import type { Doc, Id } from './_generated/dataModel';
import type { MutationCtx } from './_generated/server';

const ORG = 'org_test_load_completion';

// Completion schedules pay recalcs and the expiry sweep re-schedules
// itself; fake timers keep those from firing against a finished
// transaction after each test (same pattern as entityDocuments.test.ts).
beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());
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
  const yesterday = new Date(now - 24 * 60 * MIN).toISOString().slice(0, 10);
  const loadId = await ctx.db.insert('loadInformation', {
    internalId: '121536139', orderNumber: '121536139', status: 'Assigned', trackingStatus: 'In Transit',
    customerId, customerName: 'USPS', fleet: 'Main', units: 'Pallets', primaryDriverId: driverId,
    firstStopDate: yesterday,
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
  // Delivery windows ending an hour ago, so the on-time stamp has
  // something to evaluate when these stops close.
  const windowEnd = new Date(now - 60 * MIN);
  const win = { windowEndDate: windowEnd.toISOString().slice(0, 10), windowEndTime: windowEnd.toISOString() };
  const s3 = await stop(3, 'DELIVERY', win);
  const s4 = await stop(4, 'DELIVERY', win);
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

describe('inferred completion side effects', () => {
  it('stamps the leg like a driver check-out would (endedAt, endReason, on-time)', async () => {
    const t = convexTest(schema);
    await t.run(async (ctx) => {
      const f = await insertFixtures(ctx);
      await ctx.db.patch(f.s3, { status: 'Completed', autoArrivedAt: f.now - 80 * MIN, autoDepartedAt: f.now - 72 * MIN });
      await ctx.db.patch(f.s4, { status: 'Completed', autoArrivedAt: f.now - 30 * MIN, autoDepartedAt: f.now - 22 * MIN });
      expect(await reconcileLoadCompletion(ctx, f.loadId, 'geofence')).toBe(true);
      const leg = (await ctx.db.get(f.legId)) as Doc<'dispatchLegs'>;
      expect(leg.status).toBe('COMPLETED');
      expect(leg.endReason).toBe('completed');
      expect(leg.endedAt).toBeTypeOf('number');
      // Stops 3 and 4 carry windows and arrivals → both evaluated, both
      // early (arrived before the window end).
      expect(leg.deliveriesEvaluated).toBe(2);
      expect(leg.deliveriesOnTime).toBe(1); // stop 4 arrived past window end + grace
    });
  });

  it('a PENDING leg closed by a load-level completion is not stamped with someone else\'s deliveries', async () => {
    const t = convexTest(schema);
    await t.run(async (ctx) => {
      const f = await insertFixtures(ctx);
      const pendingLegId = await ctx.db.insert('dispatchLegs', {
        loadId: f.loadId, driverId: f.driverId, sequence: 2, startStopId: f.s3, endStopId: f.s4,
        legLoadedMiles: 10, legEmptyMiles: 0, status: 'PENDING', workosOrgId: ORG, createdAt: f.now, updatedAt: f.now,
      });
      await ctx.db.patch(f.s3, { status: 'Completed', autoArrivedAt: f.now - 80 * MIN, autoDepartedAt: f.now - 72 * MIN });
      await ctx.db.patch(f.s4, { status: 'Completed', autoArrivedAt: f.now - 30 * MIN, autoDepartedAt: f.now - 22 * MIN });
      expect(await reconcileLoadCompletion(ctx, f.loadId, 'geofence')).toBe(true);
      const pending = (await ctx.db.get(pendingLegId)) as Doc<'dispatchLegs'>;
      expect(pending.status).toBe('COMPLETED');
      expect(pending.deliveriesEvaluated).toBeUndefined();
    });
  });

  it('the pending-phase expiry completes a delivered-by-evidence Assigned load instead of warning it', async () => {
    const t = convexTest(schema);
    const H = 60 * MIN;
    const loadId = await t.run(async (ctx) => {
      const f = await insertFixtures(ctx);
      const pickup = new Date(f.now - 10 * H);
      // Never tapped at stop 1: trackingStatus still Pending, pickup 10h ago.
      await ctx.db.patch(f.loadId, { trackingStatus: 'Pending' });
      await ctx.db.patch(f.s1, { windowBeginDate: pickup.toISOString().slice(0, 10), windowBeginTime: pickup.toISOString() });
      await ctx.db.patch(f.s3, { status: 'Completed', autoArrivedAt: f.now - 8 * H, autoDepartedAt: f.now - 7.5 * H });
      await ctx.db.patch(f.s4, { status: 'Completed', autoArrivedAt: f.now - 7 * H, autoDepartedAt: f.now - 6.5 * H });
      return f.loadId;
    });
    // statusIndex 1 = 'Assigned' in the pending phase.
    await t.mutation(internal.loads.autoExpireStaleLoads, { orgId: ORG, statusIndex: 1, phase: 'pending' });
    await t.run(async (ctx) => {
      const load = (await ctx.db.get(loadId)) as Doc<'loadInformation'>;
      expect(load.status).toBe('Completed');
      expect(load.completionSource).toBe('reconcile');
      expect(load.expiryWarnedAt).toBeUndefined();
    });
  });

  it('a GPS arrival moves a Pending load to In Transit, as the tap does', async () => {
    const t = convexTest(schema);
    await t.run(async (ctx) => {
      const f = await insertFixtures(ctx);
      await ctx.db.patch(f.loadId, { trackingStatus: 'Pending' });
      await runTapGraceCheck(ctx, { stopId: f.s3, kind: 'checkin', detectedAt: f.now - 10 * MIN });
      const load = (await ctx.db.get(f.loadId)) as Doc<'loadInformation'>;
      expect(load.trackingStatus).toBe('In Transit');
      expect(load.status).toBe('Assigned');
    });
  });

  it('the stale-load expiry completes a delivered-by-evidence load instead of expiring it', async () => {
    const t = convexTest(schema);
    const H = 60 * MIN;
    const loadId = await t.run(async (ctx) => {
      const f = await insertFixtures(ctx);
      const pickup = new Date(f.now - 30 * H);
      const ymd = pickup.toISOString().slice(0, 10);
      // Pickup 30h ago, no activity for 26h, every stop closed by the fence.
      await ctx.db.patch(f.s1, { windowBeginDate: ymd, windowBeginTime: pickup.toISOString() });
      await ctx.db.patch(f.s3, { status: 'Completed', autoArrivedAt: f.now - 28 * H, autoDepartedAt: f.now - 27.5 * H });
      await ctx.db.patch(f.s4, { status: 'Completed', autoArrivedAt: f.now - 27 * H, autoDepartedAt: f.now - 26.5 * H });
      await ctx.db.patch(f.loadId, { updatedAt: f.now - 26 * H });
      return f.loadId;
    });
    await t.mutation(internal.loads.autoExpireStaleLoads, { orgId: ORG, phase: 'in-transit' });
    await t.run(async (ctx) => {
      const load = (await ctx.db.get(loadId)) as Doc<'loadInformation'>;
      expect(load.status).toBe('Completed');
      expect(load.completionSource).toBe('reconcile');
    });
  });

  it('the stale-load expiry still expires a load whose stops never closed', async () => {
    const t = convexTest(schema);
    const H = 60 * MIN;
    const loadId = await t.run(async (ctx) => {
      const f = await insertFixtures(ctx);
      const pickup = new Date(f.now - 30 * H);
      await ctx.db.patch(f.s1, { windowBeginDate: pickup.toISOString().slice(0, 10), windowBeginTime: pickup.toISOString() });
      await ctx.db.patch(f.loadId, { updatedAt: f.now - 26 * H });
      return f.loadId;
    });
    await t.mutation(internal.loads.autoExpireStaleLoads, { orgId: ORG, phase: 'in-transit' });
    await t.run(async (ctx) => {
      const load = (await ctx.db.get(loadId)) as Doc<'loadInformation'>;
      expect(load.status).toBe('Expired');
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
