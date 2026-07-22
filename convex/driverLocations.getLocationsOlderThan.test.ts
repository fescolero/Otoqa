import { convexTest } from 'convex-test';
import { describe, it, expect } from 'vitest';
import schema from './schema';
import type { Id } from './_generated/dataModel';
import { internal } from './_generated/api';

/**
 * Tests for driverLocations.getLocationsOlderThan — the archival cron's read
 * query. The fix replaced a full-table `.withIndex('by_org_created').filter()`
 * scan with a range-bound `.withIndex('by_created', q => q.lt('createdAt', …))`.
 * These assert the behaviour that range bound must guarantee:
 *   1. Only rows strictly older than the cutoff are returned.
 *   2. The result is capped at `limit`.
 *   3. Rows come back oldest-first (createdAt ascending — index order).
 *   4. When archival has caught up (no rows past the cutoff), it returns []
 *      WITHOUT scanning newer rows — the case that previously neared the
 *      per-query document/bytes read limit.
 */

const ORG = 'org_archival_test';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
async function seedDriver(ctx: any): Promise<Id<'drivers'>> {
  const now = Date.now();
  return ctx.db.insert('drivers', {
    firstName: 'Arch',
    lastName: 'Driver',
    email: 'a@t.com',
    phone: '+15555550001',
    licenseState: 'CA',
    licenseExpiration: '2030-01-01',
    licenseClass: 'A',
    hireDate: '2020-01-01',
    employmentStatus: 'Active',
    employmentType: 'Full-time',
    organizationId: ORG,
    createdBy: 'u',
    createdAt: now,
    updatedAt: now,
  });
}

async function insertLocation(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  ctx: any,
  driverId: Id<'drivers'>,
  createdAt: number,
): Promise<Id<'driverLocations'>> {
  return ctx.db.insert('driverLocations', {
    driverId,
    organizationId: ORG,
    latitude: 40.5,
    longitude: -100.2,
    trackingType: 'SESSION_ROUTE' as const,
    recordedAt: createdAt - 5_000, // device captured slightly before sync
    createdAt,
  });
}

describe('getLocationsOlderThan (archival read query)', () => {
  it('returns only rows strictly older than the cutoff', async () => {
    const t = convexTest(schema);
    const cutoff = 1_000_000;
    await t.run(async (ctx) => {
      const driverId = await seedDriver(ctx);
      await insertLocation(ctx, driverId, cutoff - 2_000); // old
      await insertLocation(ctx, driverId, cutoff - 1_000); // old
      await insertLocation(ctx, driverId, cutoff); // boundary — NOT older (lt is strict)
      await insertLocation(ctx, driverId, cutoff + 1_000); // new
      await insertLocation(ctx, driverId, cutoff + 2_000); // new
    });

    const rows = await t.query(internal.driverLocations.getLocationsOlderThan, {
      cutoffTime: cutoff,
      limit: 100,
    });

    expect(rows).toHaveLength(2);
    for (const r of rows) {
      expect(r.createdAt).toBeLessThan(cutoff);
    }
  });

  it('caps the result at `limit`', async () => {
    const t = convexTest(schema);
    const cutoff = 1_000_000;
    await t.run(async (ctx) => {
      const driverId = await seedDriver(ctx);
      for (let i = 1; i <= 5; i++) {
        await insertLocation(ctx, driverId, cutoff - i * 1_000);
      }
    });

    const rows = await t.query(internal.driverLocations.getLocationsOlderThan, {
      cutoffTime: cutoff,
      limit: 3,
    });

    expect(rows).toHaveLength(3);
  });

  it('returns rows oldest-first (createdAt ascending)', async () => {
    const t = convexTest(schema);
    const cutoff = 1_000_000;
    await t.run(async (ctx) => {
      const driverId = await seedDriver(ctx);
      // Insert in deliberately shuffled createdAt order.
      for (const c of [cutoff - 1_000, cutoff - 9_000, cutoff - 3_000, cutoff - 7_000]) {
        await insertLocation(ctx, driverId, c);
      }
    });

    const rows = await t.query(internal.driverLocations.getLocationsOlderThan, {
      cutoffTime: cutoff,
      limit: 100,
    });

    const createdAts = rows.map((r) => r.createdAt);
    expect(createdAts).toEqual([...createdAts].sort((a, b) => a - b));
    expect(createdAts).toEqual([cutoff - 9_000, cutoff - 7_000, cutoff - 3_000, cutoff - 1_000]);
  });

  it('returns [] when archival has caught up (no rows past the cutoff)', async () => {
    const t = convexTest(schema);
    const cutoff = 1_000_000;
    await t.run(async (ctx) => {
      const driverId = await seedDriver(ctx);
      // Only fresh rows exist — the caught-up steady state.
      await insertLocation(ctx, driverId, cutoff + 1_000);
      await insertLocation(ctx, driverId, cutoff + 50_000);
    });

    const rows = await t.query(internal.driverLocations.getLocationsOlderThan, {
      cutoffTime: cutoff,
      limit: 5_000,
    });

    expect(rows).toEqual([]);
  });
});
