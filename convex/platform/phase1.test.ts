/**
 * Phase 1 platform-console tests: staff gating on every new query, the
 * cron ledger's recording semantics, and the org-health snapshot builder.
 */
import { convexTest } from 'convex-test';
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import schema from '../schema';
import { api, internal } from '../_generated/api';
import type { MutationCtx } from '../_generated/server';

const STAFF_ISSUER = 'https://api.workos.com/user_management/client_staff_p1';
const TENANT_ISSUER = 'https://api.workos.com/user_management/client_tenant_p1';
const STAFF_EMAIL = 'ops@otoqa.com';
const WORKOS_ORG = 'org_workos_phase1';

const savedEnv: Record<string, string | undefined> = {};

beforeEach(() => {
  savedEnv.STAFF_ISSUER = process.env.STAFF_ISSUER;
  savedEnv.STAFF_EMAIL_ALLOWLIST = process.env.STAFF_EMAIL_ALLOWLIST;
  process.env.STAFF_ISSUER = STAFF_ISSUER;
  process.env.STAFF_EMAIL_ALLOWLIST = STAFF_EMAIL;
});

afterEach(() => {
  process.env.STAFF_ISSUER = savedEnv.STAFF_ISSUER;
  process.env.STAFF_EMAIL_ALLOWLIST = savedEnv.STAFF_EMAIL_ALLOWLIST;
});

const staffIdentity = { issuer: STAFF_ISSUER, subject: 'staff_p1', email: STAFF_EMAIL } as never;
const tenantIdentity = {
  issuer: TENANT_ISSUER,
  subject: 'tenant_admin',
  email: STAFF_EMAIL,
  org_id: WORKOS_ORG,
  role: 'admin',
} as never;

async function seedOrg(ctx: MutationCtx) {
  const now = Date.now();
  const orgId = await ctx.db.insert('organizations', {
    name: 'Phase1 Carrier LLC',
    workosOrgId: WORKOS_ORG,
    orgType: 'CARRIER',
    billingEmail: 'billing@p1.test',
    billingAddress: {
      addressLine1: '1 Test St',
      city: 'Oakland',
      state: 'California',
      zip: '94601',
      country: 'USA',
    },
    subscriptionPlan: 'Enterprise',
    subscriptionStatus: 'Active',
    billingCycle: 'Annual',
    createdAt: now,
    updatedAt: now,
  });
  await ctx.db.insert('orgMembers', {
    organizationId: WORKOS_ORG,
    workosUserId: 'user_member_1',
    email: 'member@p1.test',
    updatedAt: now,
  });
  await ctx.db.insert('drivers', {
    firstName: 'P1',
    lastName: 'Driver',
    email: 'd@p1.test',
    phone: '+15305550990',
    licenseState: 'CA',
    licenseExpiration: '2030-01-01',
    licenseClass: 'A',
    hireDate: '2024-01-01',
    employmentStatus: 'Active',
    employmentType: 'Full-time',
    organizationId: WORKOS_ORG,
    createdBy: 'u',
    createdAt: now,
    updatedAt: now,
  });
  await ctx.db.insert('featureFlags', {
    workosOrgId: WORKOS_ORG,
    key: 'test_flag',
    value: 'on',
    updatedAt: now,
  });
  const currentPeriod = new Date().toISOString().slice(0, 7);
  await ctx.db.insert('platformUsageStats', {
    workosOrgId: WORKOS_ORG,
    periodKey: currentPeriod,
    loadsWritten: 42,
    updatedAt: now,
  });
  return orgId;
}

describe('platform Phase 1 — staff gating', () => {
  it('rejects tenant tokens on every new platform query', async () => {
    const t = convexTest(schema);
    const tenant = t.withIdentity(tenantIdentity);
    await expect(tenant.query(api.platform.orgs.listOrgs, {})).rejects.toThrow(/Not platform staff/);
    await expect(tenant.query(api.platform.billing.revenueOverview, {})).rejects.toThrow(/Not platform staff/);
    await expect(tenant.query(api.platform.jobs.listJobs, {})).rejects.toThrow(/Not platform staff/);
    await expect(tenant.query(api.platform.health.integrationHealth, {})).rejects.toThrow(/Not platform staff/);
    await expect(tenant.query(api.platform.events.recentEvents, {})).rejects.toThrow(/Not platform staff/);
  });
});

describe('platform Phase 1 — cron ledger', () => {
  it('records ok ticks: health upserted, history only when recordHistory', async () => {
    const t = convexTest(schema);

    await t.mutation(internal.platform.cronRunner.record, {
      jobName: 'high-freq-job',
      startedAt: Date.now(),
      durationMs: 12,
      recordHistory: false,
    });
    await t.mutation(internal.platform.cronRunner.record, {
      jobName: 'hourly-job',
      startedAt: Date.now(),
      durationMs: 340,
      recordHistory: true,
    });

    const staff = t.withIdentity(staffIdentity);
    const jobs = await staff.query(api.platform.jobs.listJobs, {});
    expect(jobs).toHaveLength(2);
    expect(jobs.find((j) => j.jobName === 'high-freq-job')).toMatchObject({
      lastOutcome: 'ok',
      consecutiveFailures: 0,
      totalRuns: 1,
    });

    // Volume policy: only the recordHistory job appended run history.
    const hourly = await staff.query(api.platform.jobs.jobTrend, { jobName: 'hourly-job' });
    expect(hourly.sample).toBe(1);
    const highFreq = await staff.query(api.platform.jobs.jobTrend, { jobName: 'high-freq-job' });
    expect(highFreq.sample).toBe(0);
  });

  it('records failures: history always, consecutive counter, escalating events', async () => {
    const t = convexTest(schema);
    const tick = (error?: string) =>
      t.mutation(internal.platform.cronRunner.record, {
        jobName: 'flaky-job',
        startedAt: Date.now(),
        durationMs: 5,
        error,
        recordHistory: false, // failures must append history regardless
      });

    await tick('boom 1');
    await tick('boom 2');
    await tick('boom 3');

    const staff = t.withIdentity(staffIdentity);
    const job = (await staff.query(api.platform.jobs.listJobs, {}))[0];
    expect(job).toMatchObject({
      lastOutcome: 'error',
      consecutiveFailures: 3,
      totalFailures: 3,
      lastError: 'boom 3',
    });

    const failures = await staff.query(api.platform.jobs.recentFailures, {});
    expect(failures).toHaveLength(3);

    // Repeats of the same condition COLLAPSE onto one feed row — three ticks
    // of one stuck job is one thing to look at, not three. The occurrence
    // counter carries the repetition.
    const events = await staff.query(api.platform.events.recentEvents, {});
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ code: 'cron.failed', occurrences: 3 });
    // Escalation still lands: dedupe keeps the HIGHEST severity seen, so the
    // third consecutive failure's 'critical' is what the operator sees.
    expect(events[0].severity).toBe('critical');
    expect(events[0].message).toContain('boom 3');

    // Recovery resets the consecutive counter.
    await tick(undefined);
    const recovered = (await staff.query(api.platform.jobs.listJobs, {}))[0];
    expect(recovered).toMatchObject({ lastOutcome: 'ok', consecutiveFailures: 0 });
  });

  it('run wrapper records the error AND rethrows when the target fails', async () => {
    const t = convexTest(schema);
    await expect(
      t.action(internal.platform.cronRunner.run, {
        jobName: 'broken-target',
        fn: 'platform/doesNotExist:nope',
        fnType: 'mutation',
        recordHistory: true,
      }),
    ).rejects.toThrow(/broken-target/);

    const staff = t.withIdentity(staffIdentity);
    const job = (await staff.query(api.platform.jobs.listJobs, {}))[0];
    expect(job.jobName).toBe('broken-target');
    expect(job.lastOutcome).toBe('error');
    expect(job.totalFailures).toBe(1);
  });

  it('run wrapper executes a real mutation target and records ok', async () => {
    const t = convexTest(schema);
    await t.action(internal.platform.cronRunner.run, {
      jobName: 'ledger-prune',
      fn: 'platform/cronRunner:pruneLedger',
      fnType: 'mutation',
      recordHistory: true,
    });

    const staff = t.withIdentity(staffIdentity);
    const job = (await staff.query(api.platform.jobs.listJobs, {}))[0];
    expect(job).toMatchObject({ jobName: 'ledger-prune', lastOutcome: 'ok', totalRuns: 1 });
  });

  it('recentEvents filters by minimum severity', async () => {
    const t = convexTest(schema);
    await t.mutation(internal.platform.cronRunner.record, {
      jobName: 'j',
      startedAt: Date.now(),
      durationMs: 1,
      error: 'x',
      recordHistory: false,
    });
    const staff = t.withIdentity(staffIdentity);
    expect(await staff.query(api.platform.events.recentEvents, { minSeverity: 'critical' })).toHaveLength(0);
    expect(await staff.query(api.platform.events.recentEvents, { minSeverity: 'error' })).toHaveLength(1);
  });
});

describe('platform Phase 1 — org health snapshots', () => {
  it('builds a snapshot per org with index-scoped counts', async () => {
    const t = convexTest(schema);
    await t.run(seedOrg);

    await t.mutation(internal.platform.snapshots.rebuildAllOrgHealthSnapshots, {});

    const staff = t.withIdentity(staffIdentity);
    const orgs = await staff.query(api.platform.orgs.listOrgs, {});
    expect(orgs).toHaveLength(1);
    expect(orgs[0]).toMatchObject({
      name: 'Phase1 Carrier LLC',
      workosOrgId: WORKOS_ORG,
      isDeleted: false,
      memberCount: 1,
      driverCount: 1,
      activeSessionCount: 0,
      loadsThisCycle: 42,
      flagOverrideCount: 1,
    });
  });

  it('org detail returns targeted per-org data, staff-only', async () => {
    const t = convexTest(schema);
    const orgId = await t.run(seedOrg);
    await t.mutation(internal.platform.snapshots.rebuildAllOrgHealthSnapshots, {});

    const staff = t.withIdentity(staffIdentity);
    const detail = await staff.query(api.platform.orgs.getOrgDetail, { organizationId: orgId });
    expect(detail).not.toBeNull();
    expect(detail!.org.name).toBe('Phase1 Carrier LLC');
    expect(detail!.members).toHaveLength(1);
    expect(detail!.flags).toHaveLength(1);
    expect(detail!.usage.at(-1)).toMatchObject({ loadsWritten: 42 });
    expect(detail!.snapshot).toMatchObject({ driverCount: 1 });

    await expect(
      t.withIdentity(tenantIdentity).query(api.platform.orgs.getOrgDetail, { organizationId: orgId }),
    ).rejects.toThrow(/Not platform staff/);
  });

  it('revenue overview aggregates usage × rate across orgs', async () => {
    const t = convexTest(schema);
    await t.run(seedOrg);

    const staff = t.withIdentity(staffIdentity);
    const revenue = await staff.query(api.platform.billing.revenueOverview, {});
    expect(revenue.amountsAreDerived).toBe(true);
    const open = revenue.months.find((m) => m.isOpenCycle);
    expect(open).toMatchObject({ loads: 42 });
    expect(open!.amount).toBeCloseTo(42 * 2.65, 2);
    expect(revenue.currentCycleTopOrgs[0]).toMatchObject({ loads: 42 });
  });
});
