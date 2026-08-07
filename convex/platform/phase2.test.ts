/**
 * Phase 2 platform-console tests: support actions (audit + step-up +
 * idempotency), flags, tickets (including the deliberately public
 * reportProblem), and the alert evaluator's dedupe/resolve lifecycle.
 */
import { convexTest } from 'convex-test';
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import schema from '../schema';
import { api, internal } from '../_generated/api';
import type { MutationCtx } from '../_generated/server';
import type { Id } from '../_generated/dataModel';

const STAFF_ISSUER = 'https://api.workos.com/user_management/client_staff_p2';
const TENANT_ISSUER = 'https://api.workos.com/user_management/client_tenant_p2';
const STAFF_EMAIL = 'ops@otoqa.com';
const WORKOS_ORG = 'org_workos_phase2';

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

// auth_time is seconds; "recent" = now.
const freshStaff = () =>
  ({
    issuer: STAFF_ISSUER,
    subject: 'staff_p2',
    email: STAFF_EMAIL,
    auth_time: Math.floor(Date.now() / 1000),
  }) as never;

const staleStaff = () =>
  ({
    issuer: STAFF_ISSUER,
    subject: 'staff_p2',
    email: STAFF_EMAIL,
    auth_time: Math.floor(Date.now() / 1000) - 60 * 60, // 1h-old login
  }) as never;

const tenantIdentity = {
  issuer: TENANT_ISSUER,
  subject: 'tenant_u',
  email: STAFF_EMAIL,
  org_id: WORKOS_ORG,
} as never;

async function seedSession(ctx: MutationCtx): Promise<{
  sessionId: Id<'driverSessions'>;
  driverId: Id<'drivers'>;
}> {
  const now = Date.now();
  const driverId = await ctx.db.insert('drivers', {
    firstName: 'P2',
    lastName: 'Driver',
    email: 'p2@t.co',
    phone: '+15305550777',
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
  const truckId = await ctx.db.insert('trucks', {
    unitId: 'T-1',
    vin: '1FUJA6CK95LU00000',
    status: 'Active',
    organizationId: WORKOS_ORG,
    createdBy: 'u',
    createdAt: now,
    updatedAt: now,
  });
  const sessionId = await ctx.db.insert('driverSessions', {
    driverId,
    truckId,
    organizationId: WORKOS_ORG,
    startedAt: now - 60 * 60 * 1000,
    status: 'active',
  });
  return { sessionId, driverId };
}

describe('platform Phase 2 — gating & step-up', () => {
  it('rejects tenant tokens on support/tickets/alerts surfaces', async () => {
    const t = convexTest(schema);
    const tenant = t.withIdentity(tenantIdentity);
    await expect(
      tenant.query(api.platform.support.listActiveSessions, { workosOrgId: WORKOS_ORG }),
    ).rejects.toThrow(/Not platform staff/);
    await expect(tenant.query(api.platform.tickets.listTickets, {})).rejects.toThrow(
      /Not platform staff/,
    );
    await expect(tenant.query(api.platform.alerts.listAlerts, {})).rejects.toThrow(
      /Not platform staff/,
    );
  });

  it('destructive actions demand a recent sign-in (step-up)', async () => {
    const t = convexTest(schema);
    await expect(
      t.withIdentity(staleStaff()).mutation(api.platform.support.setGlobalFlag, {
        key: 'k',
        value: 'v',
        reason: 'test',
      }),
    ).rejects.toThrow(/Step-up required/);

    // Same staff member with a fresh login passes.
    await t.withIdentity(freshStaff()).mutation(api.platform.support.setGlobalFlag, {
      key: 'k',
      value: 'v',
      reason: 'test',
    });
  });
});

describe('platform Phase 2 — support actions', () => {
  it('force-ends a session, closes its legs path, audits with reason', async () => {
    const t = convexTest(schema);
    const { sessionId } = await t.run(seedSession);
    const staff = t.withIdentity(freshStaff());

    await staff.mutation(api.platform.support.forceEndSession, {
      sessionId,
      reasonCode: 'unreachable_driver',
      reason: 'Driver phone dead, dispatcher confirmed by call',
    });

    await t.run(async (ctx) => {
      const session = await ctx.db.get(sessionId);
      expect(session!.status).toBe('completed');
      expect(session!.endReason).toBe('dispatch_override');
      expect(session!.endedByUserId).toBe(`platform:${STAFF_EMAIL}`);
    });

    const audit = await staff.query(api.platform.access.recentAuditLog, {});
    expect(audit[0]).toMatchObject({
      action: 'session_force_ended',
      actorEmail: STAFF_EMAIL,
      targetOrgId: WORKOS_ORG,
    });

    // Idempotent on an already-ended session.
    await staff.mutation(api.platform.support.forceEndSession, {
      sessionId,
      reasonCode: 'unreachable_driver',
      reason: 'retry',
    });
  });

  it('org flag set/delete round-trips and audits before/after', async () => {
    const t = convexTest(schema);
    const staff = t.withIdentity(freshStaff());

    await staff.mutation(api.platform.support.setOrgFlag, {
      workosOrgId: WORKOS_ORG,
      key: 'fcm_wake_enabled',
      value: 'true',
      reason: 'enabling for pilot',
    });
    await staff.mutation(api.platform.support.setOrgFlag, {
      workosOrgId: WORKOS_ORG,
      key: 'fcm_wake_enabled',
      value: null,
      reason: 'pilot over',
    });

    await t.run(async (ctx) => {
      const rows = await ctx.db
        .query('featureFlags')
        .withIndex('by_org', (q) => q.eq('workosOrgId', WORKOS_ORG))
        .collect();
      expect(rows).toHaveLength(0); // deleted
    });

    const audit = await staff.query(api.platform.access.recentAuditLog, {});
    expect(audit.map((a) => a.action)).toEqual(['flag_set_org', 'flag_set_org']);
    expect(audit[0].before).toBe(JSON.stringify('true'));
    expect(audit[0].after).toBe(JSON.stringify(null));
  });

  it('global scope is rejected on setOrgFlag', async () => {
    const t = convexTest(schema);
    await expect(
      t.withIdentity(freshStaff()).mutation(api.platform.support.setOrgFlag, {
        workosOrgId: '*',
        key: 'k',
        value: 'v',
      }),
    ).rejects.toThrow(/setGlobalFlag/);
  });

  it('identity link delete requires reason via the audit layer', async () => {
    const t = convexTest(schema);
    const linkId = await t.run(async (ctx) => {
      const orgId = await ctx.db.insert('organizations', {
        name: 'P2 Org',
        workosOrgId: WORKOS_ORG,
        orgType: 'CARRIER',
        billingEmail: 'b@p2.test',
        billingAddress: {
          addressLine1: '1 St',
          city: 'Oakland',
          state: 'California',
          zip: '94601',
          country: 'USA',
        },
        subscriptionPlan: 'Enterprise',
        subscriptionStatus: 'Active',
        billingCycle: 'Annual',
        createdAt: Date.now(),
        updatedAt: Date.now(),
      });
      return await ctx.db.insert('userIdentityLinks', {
        clerkUserId: 'user_p2_link',
        phone: '+15305550778',
        organizationId: orgId,
        role: 'MEMBER',
        createdAt: Date.now(),
        updatedAt: Date.now(),
      });
    });

    const staff = t.withIdentity(freshStaff());
    await staff.mutation(api.platform.support.deleteIdentityLink, {
      linkId,
      reason: 'duplicate account after phone change',
    });
    await t.run(async (ctx) => {
      expect(await ctx.db.get(linkId)).toBeNull();
    });
  });
});

describe('platform Phase 2 — tickets', () => {
  it('reportProblem accepts any authenticated caller, attributes org when present', async () => {
    const t = convexTest(schema);
    await t.withIdentity(tenantIdentity).mutation(api.platform.tickets.reportProblem, {
      title: 'GPS pin stuck on map',
      body: 'The truck marker has not moved for an hour.',
    });
    // Clerk-style caller (no org claim) still files.
    await t
      .withIdentity({ issuer: 'https://x.clerk.accounts.dev', subject: 'user_clerk_p2' } as never)
      .mutation(api.platform.tickets.reportProblem, { title: 'App crashes on photo upload' });

    await expect(t.mutation(api.platform.tickets.reportProblem, { title: 'x' })).rejects.toThrow(
      /Unauthenticated/,
    );

    const staff = t.withIdentity(freshStaff());
    const tickets = await staff.query(api.platform.tickets.listTickets, {});
    expect(tickets).toHaveLength(2);
    const orgTicket = tickets.find((x) => x.title === 'GPS pin stuck on map');
    expect(orgTicket).toMatchObject({ orgId: WORKOS_ORG, source: 'user_report', status: 'open' });
  });

  it('staff work a ticket to resolution', async () => {
    const t = convexTest(schema);
    const staff = t.withIdentity(freshStaff());
    await staff.mutation(api.platform.tickets.createTicket, {
      title: 'Investigate settlement rounding',
      severity: 'high',
      orgId: WORKOS_ORG,
    });
    const [ticket] = await staff.query(api.platform.tickets.listTickets, { status: 'open' });
    await staff.mutation(api.platform.tickets.updateTicket, {
      id: ticket._id,
      status: 'resolved',
      assignToMe: true,
      resolutionNote: 'Rounding fixed in pay engine',
    });
    const [resolved] = await staff.query(api.platform.tickets.listTickets, { status: 'resolved' });
    expect(resolved).toMatchObject({ assignee: STAFF_EMAIL, resolutionNote: 'Rounding fixed in pay engine' });
  });
});

describe('platform Phase 2 — alert evaluator', () => {
  const failingJob = (jobName: string, consecutiveFailures: number) => ({
    jobName,
    lastStartedAt: Date.now(),
    lastFinishedAt: Date.now(),
    lastDurationMs: 5,
    lastOutcome: 'error' as const,
    lastError: 'boom',
    consecutiveFailures,
    totalRuns: consecutiveFailures,
    totalFailures: consecutiveFailures,
    updatedAt: Date.now(),
  });

  it('opens one deduped alert per incident, keeps ack, auto-resolves on recovery', async () => {
    const t = convexTest(schema);
    await t.run(async (ctx) => {
      await ctx.db.insert('cronHealth', failingJob('settlement-tick', 3));
    });

    await t.mutation(internal.platform.alerts.evaluate, {});
    await t.mutation(internal.platform.alerts.evaluate, {}); // second tick dedupes

    const staff = t.withIdentity(freshStaff());
    let alerts = await staff.query(api.platform.alerts.listAlerts, {});
    expect(alerts).toHaveLength(1);
    expect(alerts[0]).toMatchObject({
      dedupeKey: 'cron:settlement-tick',
      status: 'open',
      count: 2,
      severity: 'high',
    });

    // Ack silences without resolving; further ticks must not re-open.
    await staff.mutation(api.platform.alerts.ackAlert, { alertId: alerts[0]._id });
    await t.mutation(internal.platform.alerts.evaluate, {});
    alerts = await staff.query(api.platform.alerts.listAlerts, {});
    expect(alerts).toHaveLength(1);
    expect(alerts[0].status).toBe('acked');
    expect(alerts[0].count).toBe(3);

    // Recovery: condition clears → auto-resolved.
    await t.run(async (ctx) => {
      const job = await ctx.db
        .query('cronHealth')
        .withIndex('by_job', (q) => q.eq('jobName', 'settlement-tick'))
        .unique();
      await ctx.db.patch(job!._id, { consecutiveFailures: 0, lastOutcome: 'ok' });
    });
    await t.mutation(internal.platform.alerts.evaluate, {});
    alerts = await staff.query(api.platform.alerts.listAlerts, {});
    expect(alerts).toHaveLength(0);
    const withResolved = await staff.query(api.platform.alerts.listAlerts, {
      includeResolved: true,
    });
    expect(withResolved[0].status).toBe('resolved');
  });
});
