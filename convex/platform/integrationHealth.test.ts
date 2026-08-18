import { convexTest } from 'convex-test';
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import schema from '../schema';
import { api, internal } from '../_generated/api';
import type { MutationCtx } from '../_generated/server';

const STAFF_ISSUER = 'https://staff.example.com';
const STAFF_EMAIL = 'ops@otoqa.test';
const saved: Record<string, string | undefined> = {};

beforeEach(() => {
  saved.STAFF_ISSUER = process.env.STAFF_ISSUER;
  saved.STAFF_EMAIL_ALLOWLIST = process.env.STAFF_EMAIL_ALLOWLIST;
  process.env.STAFF_ISSUER = STAFF_ISSUER;
  process.env.STAFF_EMAIL_ALLOWLIST = STAFF_EMAIL;
});
afterEach(() => {
  process.env.STAFF_ISSUER = saved.STAFF_ISSUER;
  process.env.STAFF_EMAIL_ALLOWLIST = saved.STAFF_EMAIL_ALLOWLIST;
});

const staff = { issuer: STAFF_ISSUER, subject: 's', email: STAFF_EMAIL } as never;
const MINUTE = 60_000;

/** One orgIntegrations row, with only the parts a test cares about spelled out. */
async function seedIntegration(
  ctx: MutationCtx,
  opts: {
    org: string;
    provider: string;
    enabled?: boolean;
    pullIntervalMinutes?: number;
    lastSyncTime?: number;
    lastSyncStatus?: string;
    recordsProcessed?: number;
    errorMessage?: string;
  },
) {
  const now = Date.now();
  return await ctx.db.insert('orgIntegrations', {
    workosOrgId: opts.org,
    provider: opts.provider,
    credentials: '{}',
    syncSettings: {
      isEnabled: opts.enabled ?? true,
      ...(opts.pullIntervalMinutes
        ? {
            pull: {
              loadsEnabled: true,
              intervalMinutes: opts.pullIntervalMinutes,
              lookbackWindowHours: 24,
            },
          }
        : {}),
    },
    lastSyncStats: {
      lastSyncTime: opts.lastSyncTime,
      lastSyncStatus: opts.lastSyncStatus,
      recordsProcessed: opts.recordsProcessed,
      errorMessage: opts.errorMessage,
    },
    createdBy: 'user_1',
    createdAt: now,
    updatedAt: now,
  });
}

describe('integration health — provider-agnostic board', () => {
  it('lists every provider from orgIntegrations, not a hardcoded set', async () => {
    // The point of the rewrite: a provider nobody wrote a panel for still
    // appears the day it is configured.
    const t = convexTest(schema);
    await t.run(async (ctx) => {
      const now = Date.now();
      await seedIntegration(ctx, { org: 'org_a', provider: 'fourkites', lastSyncTime: now });
      await seedIntegration(ctx, { org: 'org_a', provider: 'samsara', lastSyncTime: now });
      // Never implemented here, named only in the schema's comment.
      await seedIntegration(ctx, { org: 'org_b', provider: 'project44', lastSyncTime: now });
    });

    const health = await t.withIdentity(staff).query(api.platform.health.integrationHealth, {});
    expect(health.summary.providers).toEqual(['fourkites', 'project44', 'samsara']);
    expect(health.summary.total).toBe(3);
    expect(health.summary.ok).toBe(3);
  });

  it('derives state, and puts what needs a human first', async () => {
    const t = convexTest(schema);
    await t.run(async (ctx) => {
      const now = Date.now();
      await seedIntegration(ctx, { org: 'org_ok', provider: 'samsara', lastSyncTime: now });
      await seedIntegration(ctx, {
        org: 'org_fail',
        provider: 'fourkites',
        lastSyncTime: now,
        lastSyncStatus: 'failed',
        errorMessage: 'Rate Limited by Aws',
      });
      // Declares a 5-minute pull cadence and last ran 40 minutes ago: late by
      // far more than three cycles.
      await seedIntegration(ctx, {
        org: 'org_stale',
        provider: 'fourkites',
        pullIntervalMinutes: 5,
        lastSyncTime: now - 40 * MINUTE,
      });
      await seedIntegration(ctx, { org: 'org_new', provider: 'samsara' });
      await seedIntegration(ctx, {
        org: 'org_off',
        provider: 'samsara',
        enabled: false,
        lastSyncTime: now - 400 * MINUTE,
      });
    });

    const health = await t.withIdentity(staff).query(api.platform.health.integrationHealth, {});
    const byOrg = Object.fromEntries(health.integrations.map((r) => [r.workosOrgId, r.state]));
    expect(byOrg).toEqual({
      org_ok: 'ok',
      org_fail: 'failing',
      org_stale: 'stale',
      org_new: 'never_run',
      // Switched off is not broken: an operator must not be paged for a
      // deliberate choice, and its staleness is meaningless.
      org_off: 'disabled',
    });
    expect(health.integrations.map((r) => r.state)).toEqual([
      'failing',
      'stale',
      'never_run',
      'ok',
      'disabled',
    ]);
    expect(health.summary).toMatchObject({ failing: 1, stale: 1, neverRun: 1, ok: 1, disabled: 1 });
  });

  it('reads Samsara poll state, which lastSyncStats alone never records', async () => {
    // The 10s GPS poll writes samsaraSyncState, not lastSyncStats. Before the
    // rewrite this integration was invisible on the page entirely.
    const t = convexTest(schema);
    await t.run(async (ctx) => {
      const now = Date.now();
      const id = await seedIntegration(ctx, { org: 'org_s', provider: 'samsara' });
      await ctx.db.insert('samsaraSyncState', {
        integrationId: id,
        workosOrgId: 'org_s',
        lastPolledAt: now,
        lastTickPingsIngested: 42,
        updatedAt: now,
      });
    });

    const health = await t.withIdentity(staff).query(api.platform.health.integrationHealth, {});
    const row = health.integrations[0];
    expect(row.state).toBe('ok'); // lastSyncTime is unset; the poll timestamp carries it
    expect(row.samsaraPingsLastTick).toBe(42);
  });

  it('calls an integration failing when its last word was an error', async () => {
    // A tick that ran after the error but logged no success is not a
    // recovery, and reporting it as ok would hide a live outage.
    const t = convexTest(schema);
    await t.run(async (ctx) => {
      const now = Date.now();
      const id = await seedIntegration(ctx, { org: 'org_s', provider: 'samsara' });
      await ctx.db.insert('samsaraSyncState', {
        integrationId: id,
        workosOrgId: 'org_s',
        lastPolledAt: now - 1000,
        lastErrorAt: now,
        lastErrorMessage: 'Rate Limited by Aws',
        updatedAt: now,
      });
    });

    const health = await t.withIdentity(staff).query(api.platform.health.integrationHealth, {});
    expect(health.integrations[0].state).toBe('failing');
    expect(health.integrations[0].lastError).toBe('Rate Limited by Aws');
  });

  it('surfaces the FourKites push tick, including an all-failed tick', async () => {
    const t = convexTest(schema);
    await t.run(async (ctx) => {
      const now = Date.now();
      await seedIntegration(ctx, { org: 'org_f', provider: 'fourkites' });
      await ctx.db.insert('fourKitesPushTickHealth', {
        workosOrgId: 'org_f',
        lastTickAt: now,
        lastTickKind: 'all_failed',
        candidateCount: 5,
        skippedNoPing: 0,
        skippedAlreadyPushed: 0,
        plansBuilt: 5,
        batchesSent: 1,
        batchOk: 0,
        batchValidationFail: 0,
        batchAuthFail: 1,
        batchRateLimit: 0,
        batchTransient: 0,
        lastErrorKind: 'auth',
        lastErrorStatus: 401,
        consecutiveTransientTicks: 0,
        tickDurationMs: 120,
      });
    });

    const health = await t.withIdentity(staff).query(api.platform.health.integrationHealth, {});
    expect(health.integrations[0].state).toBe('failing');
    expect(health.integrations[0].pushTickKind).toBe('all_failed');
    expect(health.integrations[0].lastError).toBe('auth (401)');
  });

  it('is staff-only', async () => {
    const t = convexTest(schema);
    await expect(t.query(api.platform.health.integrationHealth, {})).rejects.toThrow(
      /Not platform staff|Unauthenticated/,
    );
  });
});

describe('external service health — our own dependencies', () => {
  it('lists every declared service, called or not, and never leaks a secret', async () => {
    const t = convexTest(schema);
    const health = await t
      .withIdentity(staff)
      .query(api.platform.health.externalServiceHealth, {});

    // The registry is the inventory: a dependency we have never called is
    // still a dependency, and the board has to be able to say so.
    expect(health.services.length).toBeGreaterThanOrEqual(15);
    expect(health.services.map((s) => s.key)).toContain('stripe');
    expect(health.services.map((s) => s.key)).toContain('slack');

    // Only the variable NAME is ever returned, never a value.
    const serialised = JSON.stringify(health);
    expect(serialised).toContain('STRIPE_SECRET_KEY');
    expect(serialised).not.toMatch(/sk_live|sk_test|Bearer /);
  });

  it('records a failure, counts consecutive ones, and clears on success', async () => {
    const t = convexTest(schema);
    const call = (ok: boolean, errorMessage?: string) =>
      t.mutation(internal.lib.externalHealth.recordExternalCall, {
        service: 'stripe',
        ok,
        durationMs: 12,
        statusCode: ok ? 200 : 503,
        errorMessage,
      });

    await call(false, 'HTTP 503 Service Unavailable');
    await call(false, 'HTTP 503 Service Unavailable');
    let row = await t.run(async (ctx) =>
      ctx.db
        .query('externalServiceHealth')
        .withIndex('by_service', (q) => q.eq('service', 'stripe'))
        .unique(),
    );
    expect(row?.consecutiveFailures).toBe(2);
    expect(row?.lastErrorMessage).toBe('HTTP 503 Service Unavailable');

    // A success is a recovery: the streak resets rather than decaying.
    await call(true);
    row = await t.run(async (ctx) =>
      ctx.db
        .query('externalServiceHealth')
        .withIndex('by_service', (q) => q.eq('service', 'stripe'))
        .unique(),
    );
    expect(row?.consecutiveFailures).toBe(0);
    expect(row?.lastOkAt).toBeGreaterThan(0);
  });

  it('throttles repeated successes but never throttles a failure', async () => {
    // A hot dependency must not turn telemetry into write contention on one
    // row; an outage must never be the thing that gets dropped.
    const t = convexTest(schema);
    const ok = () =>
      t.mutation(internal.lib.externalHealth.recordExternalCall, {
        service: 'google_maps',
        ok: true,
        durationMs: 5,
      });

    await ok();
    const first = await t.run(async (ctx) =>
      ctx.db
        .query('externalServiceHealth')
        .withIndex('by_service', (q) => q.eq('service', 'google_maps'))
        .unique(),
    );
    await ok();
    await ok();
    const later = await t.run(async (ctx) =>
      ctx.db
        .query('externalServiceHealth')
        .withIndex('by_service', (q) => q.eq('service', 'google_maps'))
        .unique(),
    );
    // Within the throttle window the row is left completely alone.
    expect(later!.lastOkAt).toBe(first!.lastOkAt);

    await t.mutation(internal.lib.externalHealth.recordExternalCall, {
      service: 'google_maps',
      ok: false,
      durationMs: 9,
      errorMessage: 'quota exceeded',
    });
    const afterFailure = await t.run(async (ctx) =>
      ctx.db
        .query('externalServiceHealth')
        .withIndex('by_service', (q) => q.eq('service', 'google_maps'))
        .unique(),
    );
    expect(afterFailure!.consecutiveFailures).toBe(1);
    expect(afterFailure!.lastErrorMessage).toBe('quota exceeded');
  });

  it('lets a recorded failure outrank a missing key', async () => {
    // DEEPGRAM_API_KEY is unset here, so this service would otherwise report
    // "not configured" — while sitting on a live 401. If we recorded a
    // failure we plainly called it, and the error is what to act on.
    const t = convexTest(schema);
    await t.mutation(internal.lib.externalHealth.recordExternalCall, {
      service: 'deepgram',
      ok: false,
      durationMs: 3,
      errorMessage: 'HTTP 401 Unauthorized',
    });
    const health = await t
      .withIdentity(staff)
      .query(api.platform.health.externalServiceHealth, {});
    const row = health.services.find((s) => s.key === 'deepgram')!;
    expect(row.state).toBe('failing');
    expect(row.lastError).toBe('HTTP 401 Unauthorized');
    // Worst first, so what needs a human is not below the fold.
    expect(health.services[0].state).toBe('failing');
  });

  it('is staff-only', async () => {
    const t = convexTest(schema);
    await expect(t.query(api.platform.health.externalServiceHealth, {})).rejects.toThrow(
      /Not platform staff|Unauthenticated/,
    );
  });
});
