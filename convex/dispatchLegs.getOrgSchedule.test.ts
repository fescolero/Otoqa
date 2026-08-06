/**
 * getOrgSchedule — the /dispatch/schedule Gantt read.
 *
 * This query used to fan out four database operations per leg (load doc, two
 * stop docs, facet index scan) across every non-canceled leg in the org's
 * history, which tripped Convex's "too many system operations" limit on
 * larger orgs. It now dedupes reads by document id and only enriches legs
 * that survive the window filter.
 *
 * These tests pin the observable contract that refactor had to preserve:
 * status filtering, window filtering, the live-stop fallback for legs
 * predating the scheduledStartMs/scheduledEndMs backfill, and per-load facet
 * values still landing on every leg of a shared load.
 */
import { convexTest } from 'convex-test';
import { describe, it, expect } from 'vitest';
import schema from './schema';
import { api } from './_generated/api';
import type { Id } from './_generated/dataModel';
import type { MutationCtx } from './_generated/server';

const ORG = 'org_workos_schedule';
const OTHER_ORG = 'org_workos_schedule_other';
const STAFF = 'user_schedule_staff';

const HOUR = 3600_000;
const DAY = 24 * HOUR;
// Fixed epoch so window math is deterministic (2026-03-02T00:00:00Z).
const T0 = Date.UTC(2026, 2, 2);

type LegOpts = {
  status: 'PENDING' | 'ACTIVE' | 'COMPLETED' | 'CANCELED';
  loadId: Id<'loadInformation'>;
  startStopId: Id<'loadStops'>;
  endStopId: Id<'loadStops'>;
  driverId?: Id<'drivers'>;
  sequence?: number;
  /** Omit both to exercise the live-stop fallback path. */
  scheduledStartMs?: number;
  scheduledEndMs?: number;
  workosOrgId?: string;
};

async function mkCustomer(ctx: MutationCtx, workosOrgId = ORG): Promise<Id<'customers'>> {
  const now = T0;
  return ctx.db.insert('customers', {
    name: 'Schedule Shipper',
    companyType: 'Shipper',
    status: 'Active',
    addressLine1: '1 St',
    city: 'Oakland',
    state: 'California',
    zip: '94601',
    country: 'USA',
    workosOrgId,
    createdBy: 'u',
    createdAt: now,
    updatedAt: now,
  });
}

async function mkLoad(
  ctx: MutationCtx,
  internalId: string,
  workosOrgId = ORG,
): Promise<Id<'loadInformation'>> {
  const now = T0;
  return ctx.db.insert('loadInformation', {
    internalId,
    orderNumber: `ORD-${internalId}`,
    status: 'Assigned',
    trackingStatus: 'Pending',
    customerId: await mkCustomer(ctx, workosOrgId),
    customerName: 'Schedule Shipper',
    fleet: 'Main',
    units: 'Pallets',
    workosOrgId,
    createdBy: 'u',
    createdAt: now,
    updatedAt: now,
  });
}

async function mkStop(
  ctx: MutationCtx,
  loadId: Id<'loadInformation'>,
  opts: {
    sequenceNumber: number;
    city: string;
    /** Written as windowBeginDate + windowBeginTime, which is what the
     *  fallback path parses. */
    windowBeginMs?: number;
    /** ISO string on loadStops — a reported time, not an epoch. */
    checkedInAt?: string;
  },
): Promise<Id<'loadStops'>> {
  const now = T0;
  const iso = opts.windowBeginMs != null ? new Date(opts.windowBeginMs).toISOString() : undefined;
  return ctx.db.insert('loadStops', {
    loadId,
    internalId: `S-${opts.sequenceNumber}-${opts.city}`,
    workosOrgId: ORG,
    sequenceNumber: opts.sequenceNumber,
    stopType: 'PICKUP',
    loadingType: 'APPT',
    address: '1 Dock Rd',
    city: opts.city,
    state: 'CA',
    ...(iso ? { windowBeginDate: iso.slice(0, 10), windowBeginTime: iso } : {}),
    ...(opts.checkedInAt ? { checkedInAt: opts.checkedInAt } : {}),
    createdAt: now,
    updatedAt: now,
  });
}

async function mkLeg(ctx: MutationCtx, opts: LegOpts): Promise<Id<'dispatchLegs'>> {
  const now = T0;
  return ctx.db.insert('dispatchLegs', {
    loadId: opts.loadId,
    driverId: opts.driverId,
    sequence: opts.sequence ?? 1,
    startStopId: opts.startStopId,
    endStopId: opts.endStopId,
    legLoadedMiles: 100,
    legEmptyMiles: 0,
    status: opts.status,
    workosOrgId: opts.workosOrgId ?? ORG,
    createdAt: now,
    updatedAt: now,
    ...(opts.scheduledStartMs != null ? { scheduledStartMs: opts.scheduledStartMs } : {}),
    ...(opts.scheduledEndMs != null ? { scheduledEndMs: opts.scheduledEndMs } : {}),
  });
}

async function mkDriver(ctx: MutationCtx, first: string): Promise<Id<'drivers'>> {
  const now = T0;
  return ctx.db.insert('drivers', {
    firstName: first,
    lastName: 'Driver',
    email: `${first}@t.co`,
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
}

describe('getOrgSchedule', () => {
  it('returns denormalized-window legs intersecting the window, and excludes CANCELED', async () => {
    const t = convexTest(schema);
    const ids = await t.run(async (ctx) => {
      const driver = await mkDriver(ctx, 'Ada');
      const loadId = await mkLoad(ctx, 'L-1');
      const a = await mkStop(ctx, loadId, { sequenceNumber: 1, city: 'Fresno' });
      const b = await mkStop(ctx, loadId, { sequenceNumber: 2, city: 'Reno' });

      const inside = await mkLeg(ctx, {
        status: 'ACTIVE',
        loadId,
        startStopId: a,
        endStopId: b,
        driverId: driver,
        scheduledStartMs: T0 + 2 * HOUR,
        scheduledEndMs: T0 + 6 * HOUR,
      });
      // Ends before the window opens.
      await mkLeg(ctx, {
        status: 'PENDING',
        loadId,
        startStopId: a,
        endStopId: b,
        driverId: driver,
        scheduledStartMs: T0 - 5 * DAY,
        scheduledEndMs: T0 - 4 * DAY,
      });
      // Starts after the window closes.
      await mkLeg(ctx, {
        status: 'PENDING',
        loadId,
        startStopId: a,
        endStopId: b,
        driverId: driver,
        scheduledStartMs: T0 + 5 * DAY,
        scheduledEndMs: T0 + 6 * DAY,
      });
      // Inside the window but canceled — must never render on the board.
      await mkLeg(ctx, {
        status: 'CANCELED',
        loadId,
        startStopId: a,
        endStopId: b,
        driverId: driver,
        scheduledStartMs: T0 + 3 * HOUR,
        scheduledEndMs: T0 + 4 * HOUR,
      });
      // Straddles the whole window (starts before, ends after) — must be kept.
      const straddling = await mkLeg(ctx, {
        status: 'ACTIVE',
        loadId,
        startStopId: a,
        endStopId: b,
        driverId: driver,
        scheduledStartMs: T0 - DAY,
        scheduledEndMs: T0 + 2 * DAY,
      });
      return { inside, straddling, driver };
    });

    const staff = t.withIdentity({ subject: STAFF, org_id: ORG });
    const rows = await staff.query(api.dispatchLegs.getOrgSchedule, {
      workosOrgId: ORG,
      startMs: T0,
      endMs: T0 + DAY,
    });

    expect(new Set(rows.map((r) => r._id))).toEqual(new Set([ids.inside, ids.straddling]));
    const inside = rows.find((r) => r._id === ids.inside)!;
    expect(inside.startMs).toBe(T0 + 2 * HOUR);
    expect(inside.endMs).toBe(T0 + 6 * HOUR);
    expect(inside.driverId).toBe(ids.driver);
    expect(inside.startCity).toBe('Fresno');
    expect(inside.endCity).toBe('Reno');
    expect(inside.load?.orderNumber).toBe('ORD-L-1');
  });

  it('falls back to live stop windows for legs predating the scheduled-times backfill', async () => {
    const t = convexTest(schema);
    const ids = await t.run(async (ctx) => {
      const loadId = await mkLoad(ctx, 'L-2');
      // windowBeginTime on BOTH stops is what getLegTimeRange uses.
      const a = await mkStop(ctx, loadId, {
        sequenceNumber: 1,
        city: 'Bakersfield',
        windowBeginMs: T0 + 3 * HOUR,
        checkedInAt: new Date(T0 + 3 * HOUR + 600_000).toISOString(),
      });
      const b = await mkStop(ctx, loadId, {
        sequenceNumber: 2,
        city: 'Barstow',
        windowBeginMs: T0 + 9 * HOUR,
      });
      const backfilled = await mkLeg(ctx, {
        status: 'PENDING',
        loadId,
        startStopId: a,
        endStopId: b,
      });

      // No denormalized times AND unparsable stop windows → dropped, not
      // surfaced with a bogus range.
      const noTimesLoad = await mkLoad(ctx, 'L-3');
      const c = await mkStop(ctx, noTimesLoad, { sequenceNumber: 1, city: 'Mojave' });
      const d = await mkStop(ctx, noTimesLoad, { sequenceNumber: 2, city: 'Needles' });
      const unparsable = await mkLeg(ctx, {
        status: 'PENDING',
        loadId: noTimesLoad,
        startStopId: c,
        endStopId: d,
      });
      return { backfilled, unparsable };
    });

    const staff = t.withIdentity({ subject: STAFF, org_id: ORG });
    const rows = await staff.query(api.dispatchLegs.getOrgSchedule, {
      workosOrgId: ORG,
      startMs: T0,
      endMs: T0 + DAY,
    });

    expect(rows.map((r) => r._id)).toEqual([ids.backfilled]);
    expect(rows[0].startMs).toBe(T0 + 3 * HOUR);
    expect(rows[0].endMs).toBe(T0 + 9 * HOUR);
    // Stop detail still resolves even though the same docs were read during
    // the fallback pass — the dedup must not lose them.
    expect(rows[0].startCity).toBe('Bakersfield');
    expect(rows[0].endCity).toBe('Barstow');
    expect(rows[0].startCheckedInAt).toBe(new Date(T0 + 3 * HOUR + 600_000).toISOString());
    expect(rows.some((r) => r._id === ids.unparsable)).toBe(false);
  });

  it('applies per-load facet values to every leg of a shared load', async () => {
    const t = convexTest(schema);
    const ids = await t.run(async (ctx) => {
      const loadId = await mkLoad(ctx, 'L-4');
      const a = await mkStop(ctx, loadId, { sequenceNumber: 1, city: 'Ontario' });
      const b = await mkStop(ctx, loadId, { sequenceNumber: 2, city: 'Phoenix' });
      const c = await mkStop(ctx, loadId, { sequenceNumber: 3, city: 'Tucson' });

      for (const [facetKey, value] of [
        ['HCR', '12345'],
        ['TRIP', 'T-99'],
      ] as const) {
        await ctx.db.insert('loadTags', {
          workosOrgId: ORG,
          loadId,
          facetKey,
          canonicalValue: value.toUpperCase(),
          value,
        });
      }

      // Two legs of one load, sharing stop `b` as endStop/startStop — the
      // exact shape the read dedup is built for.
      const leg1 = await mkLeg(ctx, {
        status: 'COMPLETED',
        loadId,
        startStopId: a,
        endStopId: b,
        sequence: 1,
        scheduledStartMs: T0 + HOUR,
        scheduledEndMs: T0 + 5 * HOUR,
      });
      const leg2 = await mkLeg(ctx, {
        status: 'ACTIVE',
        loadId,
        startStopId: b,
        endStopId: c,
        sequence: 2,
        scheduledStartMs: T0 + 6 * HOUR,
        scheduledEndMs: T0 + 11 * HOUR,
      });
      return { leg1, leg2 };
    });

    const staff = t.withIdentity({ subject: STAFF, org_id: ORG });
    const rows = await staff.query(api.dispatchLegs.getOrgSchedule, {
      workosOrgId: ORG,
      startMs: T0,
      endMs: T0 + DAY,
    });

    expect(rows).toHaveLength(2);
    for (const row of rows) {
      expect(row.hcr).toBe('12345');
      expect(row.tripNumber).toBe('T-99');
      expect(row.load?.internalId).toBe('L-4');
    }
    const first = rows.find((r) => r._id === ids.leg1)!;
    const second = rows.find((r) => r._id === ids.leg2)!;
    expect(first.endCity).toBe('Phoenix');
    expect(second.startCity).toBe('Phoenix');
    expect(second.endCity).toBe('Tucson');
  });

  it('never leaks another org\'s legs, and rejects a mismatched org claim', async () => {
    const t = convexTest(schema);
    await t.run(async (ctx) => {
      const mine = await mkLoad(ctx, 'L-5');
      const a = await mkStop(ctx, mine, { sequenceNumber: 1, city: 'Salinas' });
      await mkLeg(ctx, {
        status: 'ACTIVE',
        loadId: mine,
        startStopId: a,
        endStopId: a,
        scheduledStartMs: T0 + HOUR,
        scheduledEndMs: T0 + 2 * HOUR,
      });

      const theirs = await mkLoad(ctx, 'L-6', OTHER_ORG);
      const b = await mkStop(ctx, theirs, { sequenceNumber: 1, city: 'Elsewhere' });
      await mkLeg(ctx, {
        status: 'ACTIVE',
        loadId: theirs,
        startStopId: b,
        endStopId: b,
        scheduledStartMs: T0 + HOUR,
        scheduledEndMs: T0 + 2 * HOUR,
        workosOrgId: OTHER_ORG,
      });
    });

    const staff = t.withIdentity({ subject: STAFF, org_id: ORG });
    const rows = await staff.query(api.dispatchLegs.getOrgSchedule, {
      workosOrgId: ORG,
      startMs: T0,
      endMs: T0 + DAY,
    });
    expect(rows).toHaveLength(1);
    expect(rows[0].load?.internalId).toBe('L-5');

    await expect(
      staff.query(api.dispatchLegs.getOrgSchedule, {
        workosOrgId: OTHER_ORG,
        startMs: T0,
        endMs: T0 + DAY,
      }),
    ).rejects.toThrow(/Not authorized for this organization/);

    await expect(
      t.query(api.dispatchLegs.getOrgSchedule, {
        workosOrgId: ORG,
        startMs: T0,
        endMs: T0 + DAY,
      }),
    ).rejects.toThrow(/Unauthenticated/);
  });
});
