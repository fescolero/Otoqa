/**
 * Tests for `yardLocations.listForDriver` — the fence-only projection the
 * driver app caches for the end-shift reminder
 * (docs/end-shift-reminder-spec.md).
 *
 * What matters here is that it authorizes the way drivers actually
 * authenticate (Clerk phone claim, not the WorkOS org claim `list` uses),
 * that it scopes to the driver's own org, and that the radii it hands the
 * device match what convex/yardGeofence.ts evaluates against server-side.
 */
import { convexTest } from 'convex-test';
import { describe, it, expect } from 'vitest';
import schema from './schema';
import { api } from './_generated/api';
import type { MutationCtx } from './_generated/server';

const ORG = 'org_test_yard_driver';
const OTHER_ORG = 'org_someone_else';
const DRIVER_PHONE = '+15305550144';

async function insertFixtures(ctx: MutationCtx) {
  const now = Date.now();
  await ctx.db.insert('drivers', {
    firstName: 'Fence',
    lastName: 'Reader',
    email: 'fence@test.com',
    phone: DRIVER_PHONE,
    licenseState: 'CA',
    licenseExpiration: '2030-01-01',
    licenseClass: 'A',
    hireDate: '2024-01-01',
    employmentStatus: 'Active',
    employmentType: 'Full-time',
    organizationId: ORG,
    createdBy: 'user_test',
    createdAt: now,
    updatedAt: now,
  });
  const yard = (name: string, org: string, radiusMeters?: number) =>
    ctx.db.insert('yardLocations', {
      workosOrgId: org,
      name,
      locationType: 'YARD',
      latitude: 34,
      longitude: -117,
      radiusMeters,
      addressLine1: '1 Yard Way',
      city: 'Fontana',
      state: 'CA',
      notes: 'gate code 4417',
      isDeleted: false,
      createdBy: 'user_test',
      createdAt: now,
      updatedAt: now,
    });
  await yard('Default Radius Yard', ORG);
  await yard('Wide Yard', ORG, 1000);
  await yard('Other Org Yard', OTHER_ORG);
  const deleted = await yard('Closed Yard', ORG);
  await ctx.db.patch(deleted, { isDeleted: true });
}

function asDriver(t: ReturnType<typeof convexTest>) {
  return t.withIdentity({ subject: 'user_fence_reader', phone_number: DRIVER_PHONE } as never);
}

describe('yardLocations.listForDriver', () => {
  it('returns the driver org\'s live fences, and no one else\'s', async () => {
    const t = convexTest(schema);
    await t.run(insertFixtures);
    const rows = await asDriver(t).query(api.yardLocations.listForDriver, {});
    expect(rows.map((r) => r.name).sort()).toEqual(['Default Radius Yard', 'Wide Yard']);
  });

  it('applies the default radius and derives the exit ring from it', async () => {
    const t = convexTest(schema);
    await t.run(insertFixtures);
    const rows = await asDriver(t).query(api.yardLocations.listForDriver, {});
    const plain = rows.find((r) => r.name === 'Default Radius Yard')!;
    // The device must never see a bare `undefined` radius: deriving the exit
    // ring from one yields the load-stop departure ring (1207 m), not 375 m.
    expect(plain.radiusMeters).toBe(250);
    expect(plain.exitRadiusMeters).toBe(375);
  });

  it('honors a per-yard radius override', async () => {
    const t = convexTest(schema);
    await t.run(insertFixtures);
    const rows = await asDriver(t).query(api.yardLocations.listForDriver, {});
    const wide = rows.find((r) => r.name === 'Wide Yard')!;
    expect(wide.radiusMeters).toBe(1000);
    expect(wide.exitRadiusMeters).toBe(1500);
  });

  it('ships the fence and nothing else — no notes, address, or audit fields', async () => {
    const t = convexTest(schema);
    await t.run(insertFixtures);
    const rows = await asDriver(t).query(api.yardLocations.listForDriver, {});
    expect(Object.keys(rows[0]).sort()).toEqual([
      '_id',
      'exitRadiusMeters',
      'latitude',
      'longitude',
      'name',
      'radiusMeters',
    ]);
  });

  it('rejects an unauthenticated caller', async () => {
    const t = convexTest(schema);
    await t.run(insertFixtures);
    await expect(t.query(api.yardLocations.listForDriver, {})).rejects.toThrow();
  });

  it('rejects a caller with no driver record', async () => {
    const t = convexTest(schema);
    await t.run(insertFixtures);
    await expect(
      t
        .withIdentity({ subject: 'user_stranger', phone_number: '+15305550999' } as never)
        .query(api.yardLocations.listForDriver, {}),
    ).rejects.toThrow();
  });

  it('an org with no yards gets an empty list, not an error', async () => {
    const t = convexTest(schema);
    await t.run(async (ctx) => {
      const now = Date.now();
      await ctx.db.insert('drivers', {
        firstName: 'Yardless',
        lastName: 'Driver',
        email: 'yardless@test.com',
        phone: '+15305550155',
        licenseState: 'CA',
        licenseExpiration: '2030-01-01',
        licenseClass: 'A',
        hireDate: '2024-01-01',
        employmentStatus: 'Active',
        employmentType: 'Full-time',
        organizationId: 'org_no_yards',
        createdBy: 'user_test',
        createdAt: now,
        updatedAt: now,
      });
    });
    const rows = await t
      .withIdentity({ subject: 'user_yardless', phone_number: '+15305550155' } as never)
      .query(api.yardLocations.listForDriver, {});
    expect(rows).toEqual([]);
  });
});
