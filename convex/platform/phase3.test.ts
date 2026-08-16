/**
 * Phase 3 — invoice ledger tests: cycle close line computation, the
 * immutability rule (issue freezes; rate changes and recalcs never touch
 * committed invoices), payments, void constraints, drift flagging, the
 * rebaseline guard, and the tenant overview reading frozen rows.
 */
import { convexTest } from 'convex-test';
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import schema from '../schema';
import { api, internal } from '../_generated/api';
import type { MutationCtx } from '../_generated/server';
import { computeDueAt, computeLines } from './invoices';

const STAFF_ISSUER = 'https://api.workos.com/user_management/client_staff_p3';
const STAFF_EMAIL = 'ops@otoqa.com';
const WORKOS_ORG = 'org_workos_phase3';

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

const freshStaff = () =>
  ({
    issuer: STAFF_ISSUER,
    subject: 'staff_p3',
    email: STAFF_EMAIL,
    auth_time: Math.floor(Date.now() / 1000),
  }) as never;

// A closed period well in the past so cycleClose accepts it.
const PERIOD = '2026-07';

async function seedOrg(
  ctx: MutationCtx,
  extra: Record<string, unknown> = {},
  loads = 100,
) {
  const now = Date.now();
  const orgId = await ctx.db.insert('organizations', {
    name: 'P3 Carrier LLC',
    workosOrgId: WORKOS_ORG,
    orgType: 'CARRIER',
    billingEmail: 'b@p3.test',
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
    billingRatePerLoad: 3,
    createdAt: now,
    updatedAt: now,
    ...extra,
  });
  if (loads > 0) {
    await ctx.db.insert('platformUsageStats', {
      workosOrgId: WORKOS_ORG,
      periodKey: PERIOD,
      loadsWritten: loads,
      updatedAt: now,
    });
  }
  return orgId;
}

describe('phase 3 — line computation (pure)', () => {
  it('usage + monthly recurring + annual anniversary + minimum true-up', () => {
    const org = {
      billingRatePerLoad: 3,
      rateSchedule: undefined,
      recurringCharges: [
        { label: 'Platform fee', amount: 100, cadence: 'monthly' as const },
        { label: 'License', amount: 1200, cadence: 'annual' as const, anniversaryMonth: 7 },
      ],
      minimumMonthlyCharge: 500,
    };
    const { lines } = computeLines(org, '2026-07', 50); // usage 150 + monthly 100 = 250 → true-up 250
    expect(lines.map((l) => [l.kind, l.amount])).toEqual([
      ['usage', 150],
      ['recurring', 100],
      ['recurring', 1200], // anniversary month hit; NOT counted toward minimum
      ['minimum_true_up', 250],
    ]);
    // Non-anniversary month: no annual line.
    const aug = computeLines(org, '2026-08', 50);
    expect(aug.lines.filter((l) => l.label.includes('annual'))).toHaveLength(0);
  });

  it('rate schedule step covering the period wins over the base rate', () => {
    const org = {
      billingRatePerLoad: 3,
      rateSchedule: [
        { effectiveFromPeriod: '2026-06', ratePerLoad: 4 },
        { effectiveFromPeriod: '2026-09', ratePerLoad: 5 },
      ],
      recurringCharges: undefined,
      minimumMonthlyCharge: undefined,
    };
    expect(computeLines(org, '2026-05', 10).ratePerLoad).toBe(3);
    expect(computeLines(org, '2026-07', 10).ratePerLoad).toBe(4);
    expect(computeLines(org, '2026-10', 10).ratePerLoad).toBe(5);
  });

  it('due dates: net-N and fixed day-of-month with clamping', () => {
    const issued = Date.UTC(2026, 7, 2); // Aug 2
    expect(computeDueAt(issued, { kind: 'net', days: 10 })).toBe(issued + 10 * 86_400_000);
    // Day 20 later this month.
    expect(computeDueAt(issued, { kind: 'dayOfMonth', day: 20 })).toBe(Date.UTC(2026, 7, 20));
    // Day already passed → next month.
    expect(computeDueAt(Date.UTC(2026, 7, 25), { kind: 'dayOfMonth', day: 20 })).toBe(
      Date.UTC(2026, 8, 20),
    );
    // Day 31 clamps in September (30 days).
    expect(computeDueAt(Date.UTC(2026, 8, 1), { kind: 'dayOfMonth', day: 31 })).toBe(
      Date.UTC(2026, 8, 30),
    );
    // Default terms = net-15.
    expect(computeDueAt(issued, undefined)).toBe(issued + 15 * 86_400_000);
  });
});

describe('phase 3 — cycle close & lifecycle', () => {
  it('drafts once, idempotently, and skips zero-line orgs', async () => {
    const t = convexTest(schema);
    await t.run((ctx) => seedOrg(ctx));
    await t.mutation(internal.platform.invoices.cycleClose, { periodKey: PERIOD });
    await t.mutation(internal.platform.invoices.cycleClose, { periodKey: PERIOD }); // no dupes

    const staff = t.withIdentity(freshStaff());
    const drafts = await staff.query(api.platform.invoices.listInvoices, { status: 'draft' });
    expect(drafts).toHaveLength(1);
    expect(drafts[0]).toMatchObject({
      periodKey: PERIOD,
      loadsWritten: 100,
      ratePerLoad: 3,
      subtotal: 300,
      total: 300,
    });
  });

  it('issue freezes amounts against later rate changes; tax snapshots at issue', async () => {
    const t = convexTest(schema);
    const orgId = await t.run((ctx) => seedOrg(ctx, { taxRatePercent: 8.25, taxJurisdiction: 'TX' }));
    await t.mutation(internal.platform.invoices.cycleClose, { periodKey: PERIOD });

    const staff = t.withIdentity(freshStaff());
    const [draft] = await staff.query(api.platform.invoices.listInvoices, { status: 'draft' });

    // Draft adjustment applies pre-issue.
    await staff.mutation(api.platform.invoices.addAdjustment, {
      id: draft._id,
      label: 'Goodwill credit',
      amountDelta: -50,
      reason: 'onboarding hiccup',
    });
    await staff.mutation(api.platform.invoices.issueInvoice, { id: draft._id });

    // Change the org's rate AFTER issue — frozen invoice must not move.
    await t.run(async (ctx) => {
      await ctx.db.patch(orgId, { billingRatePerLoad: 99 });
    });

    const [issued] = await staff.query(api.platform.invoices.listInvoices, { status: 'issued' });
    expect(issued.subtotal).toBe(250); // 300 - 50
    expect(issued.taxAmount).toBeCloseTo(20.63, 2); // 250 × 8.25%
    expect(issued.total).toBeCloseTo(270.63, 2);
    expect(issued.dueAt).toBe(issued.issuedAt! + 15 * 86_400_000); // default net-15

    // Post-issue adjustments are refused (they ride the next cycle).
    await expect(
      staff.mutation(api.platform.invoices.addAdjustment, {
        id: draft._id,
        label: 'x',
        amountDelta: 1,
        reason: 'r',
      }),
    ).rejects.toThrow(/NEXT cycle/);
  });

  it('payments accumulate; full payment flips to paid; void refuses paid/partial', async () => {
    const t = convexTest(schema);
    await t.run((ctx) => seedOrg(ctx));
    await t.mutation(internal.platform.invoices.cycleClose, { periodKey: PERIOD });
    const staff = t.withIdentity(freshStaff());
    const [draft] = await staff.query(api.platform.invoices.listInvoices, {});
    await staff.mutation(api.platform.invoices.issueInvoice, { id: draft._id });

    await staff.mutation(api.platform.invoices.recordPayment, {
      id: draft._id,
      amount: 100,
      method: 'check',
      reference: '#1042',
    });
    let [inv] = await staff.query(api.platform.invoices.listInvoices, {});
    // Partial payment is its own state — an invoice with money against it is
    // neither 'issued' nor 'paid', and aging needs to tell them apart.
    expect(inv).toMatchObject({ status: 'partially_paid', amountPaid: 100 });

    // Partial payment blocks void.
    await expect(
      staff.mutation(api.platform.invoices.voidInvoice, { id: draft._id, reason: 'nope' }),
    ).rejects.toThrow(/recorded payments/);

    await staff.mutation(api.platform.invoices.recordPayment, {
      id: draft._id,
      amount: 200,
      method: 'ach',
    });
    [inv] = await staff.query(api.platform.invoices.listInvoices, {});
    expect(inv).toMatchObject({ status: 'paid', amountPaid: 300 });
    expect(inv.payments).toHaveLength(2);

    await expect(
      staff.mutation(api.platform.invoices.voidInvoice, { id: draft._id, reason: 'nope' }),
    ).rejects.toThrow(/Paid invoices/);
  });

  it('recalc raising an invoiced period flags drift; rebaseline is forbidden', async () => {
    const t = convexTest(schema);
    await t.run((ctx) => seedOrg(ctx));
    await t.mutation(internal.platform.invoices.cycleClose, { periodKey: PERIOD });
    const staff = t.withIdentity(freshStaff());
    const [draft] = await staff.query(api.platform.invoices.listInvoices, {});
    await staff.mutation(api.platform.invoices.issueInvoice, { id: draft._id });

    // Simulate the nightly recalc discovering 20 late-attributed loads.
    const { flagDriftIfInvoiced } = await import('./invoices');
    await t.run(async (ctx) => {
      await flagDriftIfInvoiced(ctx, WORKOS_ORG, PERIOD, 120);
    });

    const [inv] = await staff.query(api.platform.invoices.listInvoices, {});
    expect(inv.driftDetectedAt).toBeDefined();
    expect(inv.total).toBe(300); // money did NOT move
    const events = await staff.query(api.platform.events.recentEvents, {});
    expect(events[0]).toMatchObject({ code: 'billing.drift', severity: 'warn' });

    await expect(
      t.mutation(internal.platformUsage.rebaselineOrgPlatformUsage, { workosOrgId: WORKOS_ORG }),
    ).rejects.toThrow(/rebaseline is forbidden/);
  });

  it('tenant billing overview reads frozen rows and survives rate changes', async () => {
    const t = convexTest(schema);
    const orgId = await t.run((ctx) => seedOrg(ctx));
    await t.mutation(internal.platform.invoices.cycleClose, { periodKey: PERIOD });
    const staff = t.withIdentity(freshStaff());
    const [draft] = await staff.query(api.platform.invoices.listInvoices, {});
    await staff.mutation(api.platform.invoices.issueInvoice, { id: draft._id });
    await staff.mutation(api.platform.invoices.recordPayment, {
      id: draft._id,
      amount: 300,
      method: 'ach',
    });

    // The historical-bug scenario: change the rate after payment.
    await t.run(async (ctx) => {
      await ctx.db.patch(orgId, { billingRatePerLoad: 10 });
    });

    const tenant = t.withIdentity({
      issuer: 'https://api.workos.com/user_management/client_tenant_p3',
      subject: 'tenant_user',
      org_id: WORKOS_ORG,
    } as never);
    const overview = await tenant.query(api.platformUsage.getBillingOverview, {
      workosOrgId: WORKOS_ORG,
    });
    const cycle = overview.closedCycles.find((c) => c.periodKey === PERIOD);
    expect(cycle).toMatchObject({ amount: 300, status: 'paid', loadsWritten: 100 }); // frozen, not 100×$10
  });

  it('backfill creates paid rows once and never duplicates', async () => {
    const t = convexTest(schema);
    await t.run((ctx) => seedOrg(ctx));
    await t.mutation(internal.platform.invoices.backfillHistoricalPaidInvoices, {});
    await t.mutation(internal.platform.invoices.backfillHistoricalPaidInvoices, {});

    const staff = t.withIdentity(freshStaff());
    const paid = await staff.query(api.platform.invoices.listInvoices, { status: 'paid' });
    expect(paid).toHaveLength(1);
    expect(paid[0]).toMatchObject({ backfilled: true, amountPaid: 300, total: 300 });
  });

  it('billing config: rate change lands next cycle via schedule; audited', async () => {
    const t = convexTest(schema);
    const orgId = await t.run((ctx) => seedOrg(ctx, {}, 0));
    const staff = t.withIdentity(freshStaff());
    await staff.mutation(api.platform.invoices.updateBillingConfig, {
      organizationId: orgId,
      ratePerLoadNextCycle: 4.5,
      billingTerms: { kind: 'dayOfMonth', day: 20 },
      minimumMonthlyCharge: 250,
      reason: 'renewal terms',
    });
    await t.run(async (ctx) => {
      const org = await ctx.db.get(orgId);
      expect(org!.rateSchedule).toHaveLength(1);
      expect(org!.rateSchedule![0].ratePerLoad).toBe(4.5);
      expect(org!.billingRatePerLoad).toBe(3); // untouched — current cycle keeps its rate
      expect(org!.minimumMonthlyCharge).toBe(250);
    });
    const audit = await staff.query(api.platform.access.recentAuditLog, {});
    expect(audit[0].action).toBe('billing_config_changed');
  });

  it('aging overview buckets open balances', async () => {
    const t = convexTest(schema);
    await t.run((ctx) => seedOrg(ctx));
    await t.mutation(internal.platform.invoices.cycleClose, { periodKey: PERIOD });
    const staff = t.withIdentity(freshStaff());
    const [draft] = await staff.query(api.platform.invoices.listInvoices, {});
    await staff.mutation(api.platform.invoices.issueInvoice, { id: draft._id });

    const aging = await staff.query(api.platform.invoices.agingOverview, {});
    expect(aging.outstanding).toBe(300);
    expect(aging.openCount).toBe(1);
    expect(aging.buckets.current).toBe(300); // due in 15 days → current bucket
  });
});
