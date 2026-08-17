/**
 * Ops-readiness tests — the operator ACTIONS added on top of the read-only
 * console (docs/platform-admin-ops-readiness-plan.md §4–§5):
 *
 *   - payment reversal (append-only correction, status walk-back)
 *   - the credit ledger (overpayment → credit → consumed next cycle)
 *   - write-off, effective-dated rates, manual invoices
 *   - cron staleness / hang detection
 *   - webhook dead-letter requeue
 *   - systemEvents dedupe + acknowledgement
 *
 * The bias throughout: prove the EDGE cases, not the happy path. Money that
 * can move in two directions is where a console does real damage.
 */
import { convexTest } from 'convex-test';
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import schema from '../schema';
import { api, internal } from '../_generated/api';
import type { MutationCtx } from '../_generated/server';
import { jobState } from './jobHealth';

const STAFF_ISSUER = 'https://api.workos.com/user_management/client_staff_p5';
const STAFF_EMAIL = 'ops@otoqa.com';
const WORKOS_ORG = 'org_workos_phase5';
// Two CLOSED cycles: cycleClose refuses the open/future period.
const PERIOD = '2026-05';
const NEXT_PERIOD = '2026-06';

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
    subject: 'staff_p5',
    email: STAFF_EMAIL,
    auth_time: Math.floor(Date.now() / 1000),
  }) as never;

/** A staff token whose last sign-in is an hour old — fails step-up. */
const staleStaff = () =>
  ({
    issuer: STAFF_ISSUER,
    subject: 'staff_p5',
    email: STAFF_EMAIL,
    auth_time: Math.floor(Date.now() / 1000) - 3600,
  }) as never;

async function seedOrg(ctx: MutationCtx, loads = 100, extra: Record<string, unknown> = {}) {
  const now = Date.now();
  const orgId = await ctx.db.insert('organizations', {
    name: 'P5 Carrier LLC',
    workosOrgId: WORKOS_ORG,
    orgType: 'CARRIER',
    billingEmail: 'b@p5.test',
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

/** Cycle-close + issue, returning the issued invoice. */
async function issuedInvoice(t: ReturnType<typeof convexTest>, period = PERIOD) {
  await t.mutation(internal.platform.invoices.cycleClose, { periodKey: period });
  const staff = t.withIdentity(freshStaff());
  const invoices = await staff.query(api.platform.invoices.listInvoices, {});
  const draft = invoices.find((i) => i.periodKey === period && i.status === 'draft')!;
  await staff.mutation(api.platform.invoices.issueInvoice, { id: draft._id });
  return draft._id;
}

describe('payment reversal — correcting money without editing history', () => {
  it('appends a negative entry and walks the status back down', async () => {
    const t = convexTest(schema);
    await t.run((ctx) => seedOrg(ctx));
    const id = await issuedInvoice(t);
    const staff = t.withIdentity(freshStaff());

    // Fat-fingered: $3,000 instead of $300 (100 loads × $3).
    await staff.mutation(api.platform.invoices.recordPayment, {
      id,
      amount: 3000,
      method: 'ach',
      reference: 'typo',
    });
    let [inv] = await staff.query(api.platform.invoices.listInvoices, {});
    expect(inv.status).toBe('paid');

    await staff.mutation(api.platform.invoices.reversePayment, {
      id,
      paymentIndex: 0,
      reason: 'Keyed 3000 instead of 300',
    });

    [inv] = await staff.query(api.platform.invoices.listInvoices, {});
    // Both entries survive: the error AND the correction.
    expect(inv.payments).toHaveLength(2);
    expect(inv.payments[1].amount).toBe(-3000);
    expect(inv.payments[1].reversalOfId).toBe(inv.payments[0].id);
    expect(inv.amountPaid).toBe(0);
    // Walked back to 'issued' (never sent), not stuck on 'paid'.
    expect(inv.status).toBe('issued');
    expect(inv.paidAt).toBeUndefined();
  });

  it('walks back to sent (not issued) when the customer already received it', async () => {
    const t = convexTest(schema);
    await t.run((ctx) => seedOrg(ctx));
    const id = await issuedInvoice(t);
    const staff = t.withIdentity(freshStaff());

    await staff.mutation(api.platform.invoices.markSent, { id });
    await staff.mutation(api.platform.invoices.recordPayment, { id, amount: 300, method: 'check' });
    await staff.mutation(api.platform.invoices.reversePayment, {
      id,
      paymentIndex: 0,
      reason: 'Check bounced',
    });

    const [inv] = await staff.query(api.platform.invoices.listInvoices, {});
    expect(inv.status).toBe('sent');
    expect(inv.amountPaid).toBe(0);
  });

  it('leaves a partial balance in partially_paid after reversing one of two payments', async () => {
    const t = convexTest(schema);
    await t.run((ctx) => seedOrg(ctx));
    const id = await issuedInvoice(t);
    const staff = t.withIdentity(freshStaff());

    await staff.mutation(api.platform.invoices.recordPayment, { id, amount: 100, method: 'ach' });
    await staff.mutation(api.platform.invoices.recordPayment, { id, amount: 200, method: 'ach' });
    await staff.mutation(api.platform.invoices.reversePayment, {
      id,
      paymentIndex: 1,
      reason: 'Applied to the wrong invoice',
    });

    const [inv] = await staff.query(api.platform.invoices.listInvoices, {});
    expect(inv.amountPaid).toBe(100);
    expect(inv.status).toBe('partially_paid');
  });

  it('is idempotent and refuses to reverse a reversal', async () => {
    const t = convexTest(schema);
    await t.run((ctx) => seedOrg(ctx));
    const id = await issuedInvoice(t);
    const staff = t.withIdentity(freshStaff());
    await staff.mutation(api.platform.invoices.recordPayment, { id, amount: 300, method: 'ach' });

    await staff.mutation(api.platform.invoices.reversePayment, {
      id,
      paymentIndex: 0,
      reason: 'first',
    });
    // Double-click: no second negative entry.
    await staff.mutation(api.platform.invoices.reversePayment, {
      id,
      paymentIndex: 0,
      reason: 'first',
    });
    const [inv] = await staff.query(api.platform.invoices.listInvoices, {});
    expect(inv.payments).toHaveLength(2);

    await expect(
      staff.mutation(api.platform.invoices.reversePayment, {
        id,
        paymentIndex: 1,
        reason: 'nope',
      }),
    ).rejects.toThrow(/itself a reversal/);
  });

  it('demands step-up and a reason', async () => {
    const t = convexTest(schema);
    await t.run((ctx) => seedOrg(ctx));
    const id = await issuedInvoice(t);
    await t
      .withIdentity(freshStaff())
      .mutation(api.platform.invoices.recordPayment, { id, amount: 300, method: 'ach' });

    await expect(
      t.withIdentity(staleStaff()).mutation(api.platform.invoices.reversePayment, {
        id,
        paymentIndex: 0,
        reason: 'x',
      }),
    ).rejects.toThrow(/Step-up required/);
    await expect(
      t.withIdentity(freshStaff()).mutation(api.platform.invoices.reversePayment, {
        id,
        paymentIndex: 0,
        reason: '   ',
      }),
    ).rejects.toThrow(/reason is required/);
  });
});

describe('credit ledger — overpayment carries forward', () => {
  it('turns an overpayment into a credit and consumes it on the next invoice', async () => {
    const t = convexTest(schema);
    await t.run((ctx) => seedOrg(ctx));
    const id = await issuedInvoice(t);
    const staff = t.withIdentity(freshStaff());

    // $400 against a $300 invoice.
    await staff.mutation(api.platform.invoices.recordPayment, { id, amount: 400, method: 'wire' });

    const balance = await staff.query(api.platform.credits.creditBalance, {
      workosOrgId: WORKOS_ORG,
    });
    expect(balance.available).toBe(100);
    const [credit] = await staff.query(api.platform.credits.listCredits, {
      workosOrgId: WORKOS_ORG,
    });
    expect(credit).toMatchObject({ source: 'overpayment', amount: 100, remaining: 100 });

    // Next cycle: 50 loads × $3 = $150, of which $100 is covered by credit.
    await t.run(async (ctx) => {
      await ctx.db.insert('platformUsageStats', {
        workosOrgId: WORKOS_ORG,
        periodKey: NEXT_PERIOD,
        loadsWritten: 50,
        updatedAt: Date.now(),
      });
    });
    const nextId = await issuedInvoice(t, NEXT_PERIOD);

    const next = (await staff.query(api.platform.invoices.listInvoices, {})).find(
      (i) => i._id === nextId,
    )!;
    expect(next.total).toBe(150);
    expect(next.amountPaid).toBe(100);
    expect(next.status).toBe('partially_paid');
    expect(next.payments[0]).toMatchObject({ method: 'credit', amount: 100 });
    // Credit is spent, and the taxable subtotal was NOT touched.
    expect(next.subtotal).toBe(150);
    const after = await staff.query(api.platform.credits.creditBalance, {
      workosOrgId: WORKOS_ORG,
    });
    expect(after.available).toBe(0);
  });

  it('never over-applies: credit larger than the invoice leaves a remainder', async () => {
    const t = convexTest(schema);
    await t.run((ctx) => seedOrg(ctx, 10)); // 10 loads × $3 = $30
    const staff = t.withIdentity(freshStaff());
    await staff.mutation(api.platform.credits.createCredit, {
      workosOrgId: WORKOS_ORG,
      amount: 500,
      source: 'goodwill',
      reason: 'Outage compensation',
    });

    const id = await issuedInvoice(t);
    const inv = (await staff.query(api.platform.invoices.listInvoices, {})).find(
      (i) => i._id === id,
    )!;
    expect(inv.total).toBe(30);
    expect(inv.amountPaid).toBe(30); // exactly the invoice, not the credit
    expect(inv.status).toBe('paid');

    const balance = await staff.query(api.platform.credits.creditBalance, {
      workosOrgId: WORKOS_ORG,
    });
    expect(balance.available).toBe(470);
  });

  it('refuses to reverse an overpayment whose credit was already spent', async () => {
    const t = convexTest(schema);
    await t.run((ctx) => seedOrg(ctx));
    const id = await issuedInvoice(t);
    const staff = t.withIdentity(freshStaff());
    await staff.mutation(api.platform.invoices.recordPayment, { id, amount: 400, method: 'wire' });

    // Spend the credit on the next cycle.
    await t.run(async (ctx) => {
      await ctx.db.insert('platformUsageStats', {
        workosOrgId: WORKOS_ORG,
        periodKey: NEXT_PERIOD,
        loadsWritten: 50,
        updatedAt: Date.now(),
      });
    });
    await issuedInvoice(t, NEXT_PERIOD);

    // Reversing now would conjure money — the credit is already someone's payment.
    await expect(
      staff.mutation(api.platform.invoices.reversePayment, {
        id,
        paymentIndex: 0,
        reason: 'bounced',
      }),
    ).rejects.toThrow(/already been applied/);
  });

  it('claws back an UNSPENT overpayment credit when the payment is reversed', async () => {
    const t = convexTest(schema);
    await t.run((ctx) => seedOrg(ctx));
    const id = await issuedInvoice(t);
    const staff = t.withIdentity(freshStaff());
    await staff.mutation(api.platform.invoices.recordPayment, { id, amount: 400, method: 'wire' });
    await staff.mutation(api.platform.invoices.reversePayment, {
      id,
      paymentIndex: 0,
      reason: 'ACH returned',
    });

    const balance = await staff.query(api.platform.credits.creditBalance, {
      workosOrgId: WORKOS_ORG,
    });
    expect(balance.available).toBe(0);
    const [credit] = await staff.query(api.platform.credits.listCredits, {
      workosOrgId: WORKOS_ORG,
    });
    expect(credit.status).toBe('void');
  });

  it('returns consumed credit to the org when the invoice is voided', async () => {
    const t = convexTest(schema);
    await t.run((ctx) => seedOrg(ctx, 10));
    const staff = t.withIdentity(freshStaff());
    await staff.mutation(api.platform.credits.createCredit, {
      workosOrgId: WORKOS_ORG,
      amount: 30,
      source: 'dispute',
      reason: 'Disputed line',
    });
    const id = await issuedInvoice(t); // $30 invoice fully covered by credit

    await staff.mutation(api.platform.invoices.voidInvoice, {
      id,
      reason: 'Raised against the wrong entity',
    });

    const balance = await staff.query(api.platform.credits.creditBalance, {
      workosOrgId: WORKOS_ORG,
    });
    expect(balance.available).toBe(30); // not destroyed with the invoice
  });

  it('keeps amountPaid equal to the payment ledger after a void returns credit', async () => {
    const t = convexTest(schema);
    await t.run((ctx) => seedOrg(ctx, 10)); // $30 invoice
    const staff = t.withIdentity(freshStaff());
    await staff.mutation(api.platform.credits.createCredit, {
      workosOrgId: WORKOS_ORG,
      amount: 30,
      source: 'goodwill',
      reason: 'x',
    });
    const id = await issuedInvoice(t);
    await staff.mutation(api.platform.invoices.voidInvoice, { id, reason: 'wrong entity' });

    const [inv] = await staff.query(api.platform.invoices.listInvoices, {});
    // The returned credit is an ENTRY, not a silent adjustment: amountPaid
    // must still be the sum of payments on every row, void ones included.
    const ledgerSum = Math.round(inv.payments.reduce((s, p) => s + p.amount, 0) * 100) / 100;
    expect(inv.amountPaid).toBe(ledgerSum);
    expect(inv.amountPaid).toBe(0);
    expect(inv.payments).toHaveLength(2); // credit applied, credit returned
  });

  it('refuses to void a credit that is already applied', async () => {
    const t = convexTest(schema);
    await t.run((ctx) => seedOrg(ctx, 10));
    const staff = t.withIdentity(freshStaff());
    await staff.mutation(api.platform.credits.createCredit, {
      workosOrgId: WORKOS_ORG,
      amount: 30,
      source: 'goodwill',
      reason: 'x',
    });
    await issuedInvoice(t);
    const [credit] = await staff.query(api.platform.credits.listCredits, {
      workosOrgId: WORKOS_ORG,
    });
    await expect(
      staff.mutation(api.platform.credits.voidCredit, { creditId: credit._id, reason: 'oops' }),
    ).rejects.toThrow(/already been applied/);
  });
});

describe('draft editing — a draft is a working document', () => {
  async function draftInvoice(t: ReturnType<typeof convexTest>) {
    await t.mutation(internal.platform.invoices.cycleClose, { periodKey: PERIOD });
    const staff = t.withIdentity(freshStaff());
    const [draft] = await staff.query(api.platform.invoices.listInvoices, {});
    return draft._id;
  }

  it('edits and removes an adjustment, repricing as it goes', async () => {
    const t = convexTest(schema);
    await t.run((ctx) => seedOrg(ctx));
    const id = await draftInvoice(t);
    const staff = t.withIdentity(freshStaff());

    await staff.mutation(api.platform.invoices.addAdjustment, {
      id,
      label: 'Godwill credit', // typo, and the wrong amount
      amountDelta: -500,
      reason: 'Service credit',
    });
    let [inv] = await staff.query(api.platform.invoices.listInvoices, {});
    expect(inv.subtotal).toBe(-200); // 300 - 500

    await staff.mutation(api.platform.invoices.updateAdjustment, {
      id,
      index: 0,
      label: 'Goodwill credit',
      amountDelta: -50,
      reason: 'Fixed typo and amount',
    });
    [inv] = await staff.query(api.platform.invoices.listInvoices, {});
    expect(inv.adjustments[0].label).toBe('Goodwill credit');
    expect(inv.subtotal).toBe(250);
    expect(inv.total).toBe(250);

    await staff.mutation(api.platform.invoices.removeAdjustment, {
      id,
      index: 0,
      reason: 'Not applicable after all',
    });
    [inv] = await staff.query(api.platform.invoices.listInvoices, {});
    expect(inv.adjustments).toHaveLength(0);
    expect(inv.subtotal).toBe(300);
  });

  it('refreshes a draft from the current rate, keeping adjustments', async () => {
    const t = convexTest(schema);
    const orgId = await t.run((ctx) => seedOrg(ctx));
    const id = await draftInvoice(t); // 100 loads × $3 = $300
    const staff = t.withIdentity(freshStaff());
    await staff.mutation(api.platform.invoices.addAdjustment, {
      id,
      label: 'Agreed discount',
      amountDelta: -25,
      reason: 'Sales agreement',
    });

    // The rate was wrong when cycle close ran; fix it, then refresh.
    await staff.mutation(api.platform.invoices.setRateStep, {
      organizationId: orgId,
      effectiveFromPeriod: PERIOD,
      ratePerLoad: 2,
      reason: 'Contract rate corrected',
    });
    await staff.mutation(api.platform.invoices.refreshDraft, {
      id,
      reason: 'Re-derive after rate fix',
    });

    const [inv] = await staff.query(api.platform.invoices.listInvoices, {});
    expect(inv.ratePerLoad).toBe(2);
    expect(inv.lines[0].amount).toBe(200);
    // Operator intent survives a re-derive; only derived data is replaced.
    expect(inv.adjustments).toHaveLength(1);
    expect(inv.subtotal).toBe(175);
  });

  it('picks up a usage correction on refresh', async () => {
    const t = convexTest(schema);
    await t.run((ctx) => seedOrg(ctx));
    const id = await draftInvoice(t);
    const staff = t.withIdentity(freshStaff());

    await t.run(async (ctx) => {
      const row = await ctx.db
        .query('platformUsageStats')
        .withIndex('by_org_period', (q) =>
          q.eq('workosOrgId', WORKOS_ORG).eq('periodKey', PERIOD),
        )
        .first();
      await ctx.db.patch(row!._id, { loadsWritten: 140 });
    });
    await staff.mutation(api.platform.invoices.refreshDraft, { id, reason: 'Late loads landed' });

    const [inv] = await staff.query(api.platform.invoices.listInvoices, {});
    expect(inv.loadsWritten).toBe(140);
    expect(inv.subtotal).toBe(420);
  });

  it('edits the lines of a one-off, and refuses to on a metered draft', async () => {
    const t = convexTest(schema);
    const orgId = await t.run((ctx) => seedOrg(ctx));
    const staff = t.withIdentity(freshStaff());
    await staff.mutation(api.platform.invoices.createManualInvoice, {
      organizationId: orgId,
      periodKey: PERIOD,
      lines: [{ label: 'Onboarding', amount: 2500 }],
      reason: 'SOW #12',
    });
    const metered = await draftInvoice(t);
    const manual = (await staff.query(api.platform.invoices.listInvoices, {})).find(
      (i) => i.kind === 'manual',
    )!;

    await staff.mutation(api.platform.invoices.updateManualLines, {
      id: manual._id,
      lines: [
        { label: 'Onboarding & implementation', amount: 2000 },
        { label: 'Data migration', amount: 750 },
      ],
      reason: 'Scope changed before sending',
    });
    const updated = (await staff.query(api.platform.invoices.listInvoices, {})).find(
      (i) => i._id === manual._id,
    )!;
    expect(updated.lines).toHaveLength(2);
    expect(updated.total).toBe(2750);

    // Metered lines come from the meter — they are never typed by hand.
    await expect(
      staff.mutation(api.platform.invoices.updateManualLines, {
        id: metered,
        lines: [{ label: 'made up', amount: 1 }],
        reason: 'x',
      }),
    ).rejects.toThrow(/lines come from the meter/);
  });

  it('deletes a draft and lets cycle close re-draft the period', async () => {
    const t = convexTest(schema);
    await t.run((ctx) => seedOrg(ctx));
    const id = await draftInvoice(t);
    const staff = t.withIdentity(freshStaff());

    await staff.mutation(api.platform.invoices.deleteDraft, {
      id,
      reason: 'Raised against the wrong entity',
    });
    expect(await staff.query(api.platform.invoices.listInvoices, {})).toHaveLength(0);
    // The audit entry outlives the row.
    const audit = await staff.query(api.platform.access.recentAuditLog, {});
    expect(audit[0].action).toBe('invoice_draft_deleted');

    await t.mutation(internal.platform.invoices.cycleClose, { periodKey: PERIOD });
    const after = await staff.query(api.platform.invoices.listInvoices, {});
    expect(after).toHaveLength(1);
    expect(after[0].status).toBe('draft');
  });

  it('sends void away from drafts, and re-drafts past an already-cancelled row', async () => {
    const t = convexTest(schema);
    await t.run((ctx) => seedOrg(ctx));
    const id = await draftInvoice(t);
    const staff = t.withIdentity(freshStaff());

    await expect(
      staff.mutation(api.platform.invoices.voidInvoice, { id, reason: 'nope' }),
    ).rejects.toThrow(/delete the draft instead/);

    // A row voided before that rule existed must not block the cycle forever.
    await t.run(async (ctx) => {
      await ctx.db.patch(id, { status: 'void', voidedAt: Date.now(), voidReason: 'legacy' });
    });
    await t.mutation(internal.platform.invoices.cycleClose, { periodKey: PERIOD });
    const rows = await staff.query(api.platform.invoices.listInvoices, {});
    expect(rows.filter((r) => r.status === 'draft')).toHaveLength(1);
  });

  it('refuses every edit once the invoice is issued', async () => {
    const t = convexTest(schema);
    await t.run((ctx) => seedOrg(ctx));
    const id = await issuedInvoice(t);
    const staff = t.withIdentity(freshStaff());

    await expect(
      staff.mutation(api.platform.invoices.refreshDraft, { id, reason: 'x' }),
    ).rejects.toThrow(/frozen/);
    await expect(
      staff.mutation(api.platform.invoices.deleteDraft, { id, reason: 'x' }),
    ).rejects.toThrow(/frozen/);
    await expect(
      staff.mutation(api.platform.invoices.removeAdjustment, { id, index: 0, reason: 'x' }),
    ).rejects.toThrow(/frozen/);
  });
});

describe('recording history after the fact', () => {
  const DAY = 86_400_000;

  it('back-dates a one-off invoice, takes a late overpayment, and carries the excess forward', async () => {
    // The real case: integration setup work invoiced in arrears, the customer
    // paid weeks later and deliberately overpaid to cover the coming month.
    const t = convexTest(schema);
    const orgId = await t.run((ctx) => seedOrg(ctx));
    const staff = t.withIdentity(freshStaff());
    const workDoneAt = Date.now() - 60 * DAY;
    const moneyArrivedAt = Date.now() - 10 * DAY;

    await staff.mutation(api.platform.invoices.createManualInvoice, {
      organizationId: orgId,
      periodKey: PERIOD,
      lines: [{ label: 'Integration setup', amount: 1000 }],
      reason: 'Recording work completed in arrears',
    });
    const draft = (await staff.query(api.platform.invoices.listInvoices, {})).find(
      (i) => i.kind === 'manual',
    )!;

    // Issue AS OF the date the work was billed, not today.
    await staff.mutation(api.platform.invoices.issueInvoice, {
      id: draft._id,
      issuedAt: workDoneAt,
    });
    let inv = (await staff.query(api.platform.invoices.listInvoices, {})).find(
      (i) => i._id === draft._id,
    )!;
    expect(inv.issuedAt).toBe(workDoneAt);
    // Terms run from the issue date, so it was already overdue when paid.
    expect(inv.dueAt!).toBeLessThan(moneyArrivedAt);

    // They paid $1,300 — $1,000 owed plus $300 toward next month.
    await staff.mutation(api.platform.invoices.recordPayment, {
      id: draft._id,
      amount: 1300,
      method: 'wire',
      reference: 'wire 8841',
      receivedAt: moneyArrivedAt,
    });
    inv = (await staff.query(api.platform.invoices.listInvoices, {})).find(
      (i) => i._id === draft._id,
    )!;
    expect(inv.status).toBe('paid');
    expect(inv.amountPaid).toBe(1300);
    // Dates reflect reality, not when someone typed it in.
    expect(inv.payments[0].receivedAt).toBe(moneyArrivedAt);
    expect(inv.paidAt).toBe(moneyArrivedAt);

    // The extra $300 is sitting on the account, not lost.
    const balance = await staff.query(api.platform.credits.creditBalance, {
      workosOrgId: WORKOS_ORG,
    });
    expect(balance.available).toBe(300);

    // Next month's metered invoice: $300 of it is already covered.
    const monthly = await issuedInvoice(t); // 100 loads × $3 = $300
    const next = (await staff.query(api.platform.invoices.listInvoices, {})).find(
      (i) => i._id === monthly,
    )!;
    expect(next.total).toBe(300);
    expect(next.payments[0]).toMatchObject({ method: 'credit', amount: 300 });
    expect(next.status).toBe('paid');
    expect(next.subtotal).toBe(300); // credit never touched the taxable subtotal
  });

  it('refuses a future issue date and an inverted due date', async () => {
    const t = convexTest(schema);
    await t.run((ctx) => seedOrg(ctx));
    await t.mutation(internal.platform.invoices.cycleClose, { periodKey: PERIOD });
    const staff = t.withIdentity(freshStaff());
    const [draft] = await staff.query(api.platform.invoices.listInvoices, {});

    await expect(
      staff.mutation(api.platform.invoices.issueInvoice, {
        id: draft._id,
        issuedAt: Date.now() + 7 * DAY,
      }),
    ).rejects.toThrow(/future date/);
    await expect(
      staff.mutation(api.platform.invoices.issueInvoice, {
        id: draft._id,
        issuedAt: Date.now() - 10 * DAY,
        dueAt: Date.now() - 20 * DAY,
      }),
    ).rejects.toThrow(/on or after the issue date/);
  });

  it('puts a back-dated unpaid invoice straight into the right aging bucket', async () => {
    const t = convexTest(schema);
    await t.run((ctx) => seedOrg(ctx));
    await t.mutation(internal.platform.invoices.cycleClose, { periodKey: PERIOD });
    const staff = t.withIdentity(freshStaff());
    const [draft] = await staff.query(api.platform.invoices.listInvoices, {});

    await staff.mutation(api.platform.invoices.issueInvoice, {
      id: draft._id,
      issuedAt: Date.now() - 75 * DAY, // net-15 → ~60 days overdue
    });

    const aging = await staff.query(api.platform.invoices.agingOverview, {});
    expect(aging.outstanding).toBe(300);
    expect(aging.buckets.current).toBe(0);
    expect(aging.buckets.d31_60).toBe(300);
  });
});

describe('paid with no record of payment', () => {
  /** How the historical backfill leaves a row: paid, empty payment ledger. */
  async function seedBackfilledPaid(t: ReturnType<typeof convexTest>) {
    return await t.run(async (ctx) => {
      const now = Date.now();
      return await ctx.db.insert('platformInvoices', {
        workosOrgId: WORKOS_ORG,
        periodKey: PERIOD,
        kind: 'metered',
        invoiceNumber: 'INV-LEGACY-0001',
        loadsWritten: 100,
        ratePerLoad: 3,
        lines: [{ kind: 'usage', label: '100 loads × $3.00', amount: 300 }],
        adjustments: [],
        subtotal: 300,
        total: 300,
        payments: [], // the gap: money claimed, nothing to show for it
        amountPaid: 300,
        status: 'paid',
        issuedAt: now - 40 * 86_400_000,
        paidAt: now - 30 * 86_400_000,
        backfilled: true,
        createdAt: now,
        updatedAt: now,
      });
    });
  }

  it('surfaces the gap between what was paid and what is evidenced', async () => {
    const t = convexTest(schema);
    await t.run((ctx) => seedOrg(ctx));
    await seedBackfilledPaid(t);

    const gaps = await t
      .withIdentity(freshStaff())
      .query(api.platform.invoices.paymentLedgerGaps, {});
    expect(gaps).toHaveLength(1);
    expect(gaps[0]).toMatchObject({
      invoiceNumber: 'INV-LEGACY-0001',
      status: 'paid',
      amountPaid: 300,
      documented: 0,
      undocumented: 300,
      backfilled: true,
    });
  });

  it('documents the payment without changing what was paid', async () => {
    const t = convexTest(schema);
    await t.run((ctx) => seedOrg(ctx));
    const id = await seedBackfilledPaid(t);
    const staff = t.withIdentity(freshStaff());
    const receivedAt = Date.now() - 30 * 86_400_000;

    await staff.mutation(api.platform.invoices.documentPayment, {
      id,
      amount: 300,
      method: 'check',
      reference: 'check 2291',
      receivedAt,
      reason: 'Reconciling against the bank statement',
    });

    const [inv] = await staff.query(api.platform.invoices.listInvoices, {});
    expect(inv.payments).toHaveLength(1);
    expect(inv.payments[0]).toMatchObject({ amount: 300, method: 'check', receivedAt });
    // The money was never in question — only the record of it.
    expect(inv.amountPaid).toBe(300);
    expect(inv.status).toBe('paid');
    expect(await staff.query(api.platform.invoices.paymentLedgerGaps, {})).toHaveLength(0);
  });

  it('can be filled in across several entries, and refuses to exceed the gap', async () => {
    const t = convexTest(schema);
    await t.run((ctx) => seedOrg(ctx));
    const id = await seedBackfilledPaid(t);
    const staff = t.withIdentity(freshStaff());

    await staff.mutation(api.platform.invoices.documentPayment, {
      id,
      amount: 200,
      method: 'ach',
      reason: 'First transfer',
    });
    let gaps = await staff.query(api.platform.invoices.paymentLedgerGaps, {});
    expect(gaps[0].undocumented).toBe(100);

    // Documenting more than the invoice ever claimed would invent money.
    await expect(
      staff.mutation(api.platform.invoices.documentPayment, {
        id,
        amount: 250,
        method: 'ach',
        reason: 'too much',
      }),
    ).rejects.toThrow(/Only 100.00 is undocumented/);

    await staff.mutation(api.platform.invoices.documentPayment, {
      id,
      amount: 100,
      method: 'ach',
      reason: 'Second transfer',
    });
    gaps = await staff.query(api.platform.invoices.paymentLedgerGaps, {});
    expect(gaps).toHaveLength(0);
  });

  it('refuses on an invoice whose payments already add up', async () => {
    const t = convexTest(schema);
    await t.run((ctx) => seedOrg(ctx));
    const id = await issuedInvoice(t);
    const staff = t.withIdentity(freshStaff());
    await staff.mutation(api.platform.invoices.recordPayment, { id, amount: 300, method: 'ach' });

    await expect(
      staff.mutation(api.platform.invoices.documentPayment, {
        id,
        amount: 50,
        method: 'ach',
        reason: 'x',
      }),
    ).rejects.toThrow(/already has a full payment record/);
  });

  it('makes a documented payment reversible like any other', async () => {
    const t = convexTest(schema);
    await t.run((ctx) => seedOrg(ctx));
    const id = await seedBackfilledPaid(t);
    const staff = t.withIdentity(freshStaff());
    await staff.mutation(api.platform.invoices.documentPayment, {
      id,
      amount: 300,
      method: 'check',
      reason: 'Reconciled',
    });

    // The point of documenting: the entry now exists, so it can be corrected.
    await staff.mutation(api.platform.invoices.reversePayment, {
      id,
      paymentIndex: 0,
      reason: 'Cheque was for a different customer',
    });
    const [inv] = await staff.query(api.platform.invoices.listInvoices, {});
    expect(inv.amountPaid).toBe(0);
    expect(inv.status).toBe('issued');
  });
});

describe('catching up on months of unpaid cycles', () => {
  const DAY = 86_400_000;

  it('withdraws a paid claim that was never evidenced, putting the money back on the clock', async () => {
    const t = convexTest(schema);
    await t.run((ctx) => seedOrg(ctx));
    // How the backfill leaves a cycle nobody actually paid.
    const id = await t.run(async (ctx) => {
      const now = Date.now();
      return await ctx.db.insert('platformInvoices', {
        workosOrgId: WORKOS_ORG,
        periodKey: PERIOD,
        kind: 'metered',
        invoiceNumber: 'INV-UNPAID-0001',
        loadsWritten: 100,
        ratePerLoad: 3,
        lines: [{ kind: 'usage', label: '100 loads × $3.00', amount: 300 }],
        adjustments: [],
        subtotal: 300,
        total: 300,
        payments: [],
        amountPaid: 300,
        status: 'paid',
        issuedAt: now - 120 * DAY,
        dueAt: now - 105 * DAY,
        paidAt: now - 100 * DAY,
        backfilled: true,
        createdAt: now,
        updatedAt: now,
      });
    });
    const staff = t.withIdentity(freshStaff());

    await staff.mutation(api.platform.invoices.clearUnevidencedPayment, {
      id,
      reason: 'Backfill marked it paid; no payment was received for this cycle',
    });

    const [inv] = await staff.query(api.platform.invoices.listInvoices, {});
    expect(inv.status).toBe('issued');
    expect(inv.amountPaid).toBe(0);
    expect(inv.paidAt).toBeUndefined();
    // It is a receivable again, and an old one.
    const aging = await staff.query(api.platform.invoices.agingOverview, {});
    expect(aging.outstanding).toBe(300);
    expect(aging.buckets.d90_plus).toBe(300);
  });

  it('refuses to withdraw a payment that WAS recorded', async () => {
    const t = convexTest(schema);
    await t.run((ctx) => seedOrg(ctx));
    const id = await issuedInvoice(t);
    const staff = t.withIdentity(freshStaff());
    await staff.mutation(api.platform.invoices.recordPayment, { id, amount: 300, method: 'ach' });

    await expect(
      staff.mutation(api.platform.invoices.clearUnevidencedPayment, { id, reason: 'x' }),
    ).rejects.toThrow(/reverse the entry instead/);
  });

  it('applies stranded credit to an invoice that was already issued', async () => {
    const t = convexTest(schema);
    await t.run((ctx) => seedOrg(ctx));
    const id = await issuedInvoice(t); // $300, issued before the credit existed
    const staff = t.withIdentity(freshStaff());
    await staff.mutation(api.platform.credits.createCredit, {
      workosOrgId: WORKOS_ORG,
      amount: 120,
      source: 'goodwill',
      reason: 'Overpayment on the setup invoice',
    });

    // Aging knows the receivable is really smaller than the gross figure.
    let aging = await staff.query(api.platform.invoices.agingOverview, {});
    expect(aging.outstanding).toBe(300);
    expect(aging.outstandingNetOfCredit).toBe(180);

    await staff.mutation(api.platform.invoices.applyCreditToInvoice, {
      id,
      reason: 'Applying the account credit to the oldest open invoice',
    });

    const [inv] = await staff.query(api.platform.invoices.listInvoices, {});
    expect(inv.amountPaid).toBe(120);
    expect(inv.status).toBe('partially_paid');
    expect(inv.payments[0]).toMatchObject({ method: 'credit', amount: 120 });

    aging = await staff.query(api.platform.invoices.agingOverview, {});
    expect(aging.outstanding).toBe(180); // now the gross figure agrees
    expect(aging.creditAvailable).toBe(0);
  });

  it('never applies more credit than the invoice owes', async () => {
    const t = convexTest(schema);
    await t.run((ctx) => seedOrg(ctx));
    const id = await issuedInvoice(t); // $300
    const staff = t.withIdentity(freshStaff());
    await staff.mutation(api.platform.credits.createCredit, {
      workosOrgId: WORKOS_ORG,
      amount: 1000,
      source: 'goodwill',
      reason: 'Large credit',
    });

    await staff.mutation(api.platform.invoices.applyCreditToInvoice, { id, reason: 'Apply' });
    const [inv] = await staff.query(api.platform.invoices.listInvoices, {});
    expect(inv.amountPaid).toBe(300);
    expect(inv.status).toBe('paid');
    // The rest stays on the account for the next invoice.
    const balance = await staff.query(api.platform.credits.creditBalance, {
      workosOrgId: WORKOS_ORG,
    });
    expect(balance.available).toBe(700);
  });

  it('reconstructs an account backfilled as paid: clear the lot, then spend the credit', async () => {
    // The shape found in production: every metered cycle marked paid by the
    // backfill, and real payments that had nowhere to land so they became
    // credit. Outstanding reads $0 while a large credit balance sits beside it.
    const t = convexTest(schema);
    await t.run((ctx) => seedOrg(ctx, 0));
    const staff = t.withIdentity(freshStaff());
    const periods = ['2025-11', '2025-12', '2026-01', '2026-02'];
    const amounts = [238.5, 11805.75, 7904.95, 9603.6];
    const owed = 29552.8;

    await t.run(async (ctx) => {
      const now = Date.now();
      for (const [i, periodKey] of periods.entries()) {
        await ctx.db.insert('platformInvoices', {
          workosOrgId: WORKOS_ORG,
          periodKey,
          kind: 'metered',
          invoiceNumber: `INV-BACKFILL-${i}`,
          loadsWritten: 100,
          ratePerLoad: 2.65,
          lines: [{ kind: 'usage', label: 'usage', amount: amounts[i] }],
          adjustments: [],
          subtotal: amounts[i],
          total: amounts[i],
          payments: [],
          amountPaid: amounts[i], // the fiction
          status: 'paid',
          issuedAt: Date.parse(`${periodKey}-05T12:00:00Z`),
          dueAt: Date.parse(`${periodKey}-20T12:00:00Z`),
          backfilled: true,
          createdAt: now,
          updatedAt: now,
        });
      }
    });
    // Real cash that landed as credit because nothing was open.
    await staff.mutation(api.platform.credits.createCredit, {
      workosOrgId: WORKOS_ORG,
      amount: 20000,
      source: 'manual',
      reason: 'Transfers recorded while every invoice was marked paid',
    });

    let aging = await staff.query(api.platform.invoices.agingOverview, {});
    expect(aging.outstanding).toBe(0); // the misleading picture
    expect(aging.creditAvailable).toBe(20000);

    // 1. Withdraw every unevidenced claim in one action.
    const cleared = await staff.mutation(api.platform.invoices.clearUnevidencedPayments, {
      workosOrgId: WORKOS_ORG,
      reason: 'Backfill assumed payment; none was received for these cycles',
    });
    expect(cleared.cleared).toHaveLength(4);
    expect(cleared.totalRestored).toBe(owed);

    aging = await staff.query(api.platform.invoices.agingOverview, {});
    expect(aging.outstanding).toBe(owed);
    expect(aging.outstandingNetOfCredit).toBe(9552.8); // 29,552.80 − 20,000

    // 2. Spend the credit across them, oldest first.
    const applied = await staff.mutation(api.platform.invoices.allocateCredit, {
      workosOrgId: WORKOS_ORG,
      reason: 'Applying the account balance to the arrears',
    });
    expect(applied.stillOwed).toBe(9552.8);
    expect(applied.creditRemaining).toBe(0);
    // Oldest cleared first; the cycle the credit ran out on is part-paid.
    expect(applied.applied[0].periodKey).toBe('2025-11');
    expect(applied.applied.at(-1)!.status).toBe('partially_paid');

    aging = await staff.query(api.platform.invoices.agingOverview, {});
    expect(aging.outstanding).toBe(9552.8);
    expect(aging.outstandingNetOfCredit).toBe(9552.8); // the two now agree
  });

  it('dates a credit application to when it could have settled, not to today', async () => {
    // Credit created in October against an invoice issued in November: the
    // money was available the whole time, so the invoice was never really
    // 9 months late — stamping "now" would say it was.
    const t = convexTest(schema);
    await t.run((ctx) => seedOrg(ctx, 0));
    const staff = t.withIdentity(freshStaff());
    const creditAt = Date.parse('2025-10-15T12:00:00Z');
    const issuedAt = Date.parse('2025-11-05T12:00:00Z');

    const invoiceId = await t.run(async (ctx) => {
      const now = Date.now();
      await ctx.db.insert('platformCredits', {
        workosOrgId: WORKOS_ORG,
        amount: 500,
        remaining: 500,
        source: 'overpayment',
        reason: 'Paid ahead in October',
        status: 'available',
        createdByEmail: STAFF_EMAIL,
        applications: [],
        createdAt: creditAt,
        updatedAt: creditAt,
      });
      return await ctx.db.insert('platformInvoices', {
        workosOrgId: WORKOS_ORG,
        periodKey: '2025-11',
        kind: 'metered',
        invoiceNumber: 'INV-NOV',
        loadsWritten: 100,
        ratePerLoad: 2,
        lines: [{ kind: 'usage', label: 'usage', amount: 200 }],
        adjustments: [],
        subtotal: 200,
        total: 200,
        payments: [],
        amountPaid: 0,
        status: 'issued',
        issuedAt,
        dueAt: issuedAt + 15 * 86_400_000,
        createdAt: now,
        updatedAt: now,
      });
    });

    await staff.mutation(api.platform.invoices.applyCreditToInvoice, {
      id: invoiceId,
      reason: 'Applying the October balance',
    });

    const [inv] = await staff.query(api.platform.invoices.listInvoices, {});
    expect(inv.status).toBe('paid');
    // Settled the day the invoice was issued — the credit already existed.
    expect(inv.payments[0].receivedAt).toBe(issuedAt);
    expect(inv.paidAt).toBe(issuedAt);
    // Which means it reads as paid BEFORE its due date, not months late.
    expect(inv.paidAt!).toBeLessThan(inv.dueAt!);
  });

  it('dates to the credit when the credit arrived after the invoice', async () => {
    const t = convexTest(schema);
    await t.run((ctx) => seedOrg(ctx));
    const id = await issuedInvoice(t);
    const staff = t.withIdentity(freshStaff());
    // Credit created now, invoice issued a moment earlier: the later of the
    // two is when it could have been settled.
    await staff.mutation(api.platform.credits.createCredit, {
      workosOrgId: WORKOS_ORG,
      amount: 300,
      source: 'goodwill',
      reason: 'Later credit',
    });
    await staff.mutation(api.platform.invoices.applyCreditToInvoice, {
      id,
      reason: 'Apply',
    });

    const [inv] = await staff.query(api.platform.invoices.listInvoices, {});
    expect(inv.payments[0].receivedAt).toBeGreaterThanOrEqual(inv.issuedAt!);
    expect(inv.payments[0].receivedAt).toBeLessThanOrEqual(Date.now());
  });

  it('leaves credit on the account when the invoices cannot absorb it', async () => {
    const t = convexTest(schema);
    await t.run((ctx) => seedOrg(ctx));
    await issuedInvoice(t); // $300 owed
    const staff = t.withIdentity(freshStaff());
    await staff.mutation(api.platform.credits.createCredit, {
      workosOrgId: WORKOS_ORG,
      amount: 1000,
      source: 'manual',
      reason: 'Paid well ahead',
    });

    const result = await staff.mutation(api.platform.invoices.allocateCredit, {
      workosOrgId: WORKOS_ORG,
      reason: 'Apply what fits',
    });
    expect(result.stillOwed).toBe(0);
    expect(result.creditRemaining).toBe(700); // genuinely owed back to them
  });

  it('allocates one transfer across several overdue cycles, oldest first', async () => {
    const t = convexTest(schema);
    await t.run((ctx) => seedOrg(ctx));
    await t.run(async (ctx) => {
      await ctx.db.insert('platformUsageStats', {
        workosOrgId: WORKOS_ORG,
        periodKey: NEXT_PERIOD,
        loadsWritten: 100,
        updatedAt: Date.now(),
      });
    });
    const staff = t.withIdentity(freshStaff());
    // Two $300 cycles, the older one issued first.
    const oldest = await t.mutation(internal.platform.invoices.cycleClose, { periodKey: PERIOD });
    void oldest;
    await t.mutation(internal.platform.invoices.cycleClose, { periodKey: NEXT_PERIOD });
    const drafts = await staff.query(api.platform.invoices.listInvoices, { status: 'draft' });
    for (const d of drafts) {
      await staff.mutation(api.platform.invoices.issueInvoice, {
        id: d._id,
        issuedAt: Date.parse(`${d.periodKey}-05T12:00:00Z`),
      });
    }

    const paidOn = Date.parse('2026-04-22T12:00:00Z');
    const result = await staff.mutation(api.platform.invoices.allocatePayment, {
      workosOrgId: WORKOS_ORG,
      amount: 450,
      method: 'wire',
      reference: 'wire 22-04',
      receivedAt: paidOn,
      reason: 'Catch-up payment covering arrears',
    });

    // $300 clears the oldest, $150 lands on the next.
    expect(result.applied).toEqual([
      { invoiceNumber: expect.any(String), periodKey: PERIOD, amount: 300, status: 'paid' },
      {
        invoiceNumber: expect.any(String),
        periodKey: NEXT_PERIOD,
        amount: 150,
        status: 'partially_paid',
      },
    ]);
    expect(result.creditPosted).toBe(0);

    const rows = await staff.query(api.platform.invoices.listInvoices, {});
    const first = rows.find((r) => r.periodKey === PERIOD)!;
    expect(first.paidAt).toBe(paidOn);
    expect(first.payments[0]).toMatchObject({ reference: 'wire 22-04', receivedAt: paidOn });
  });

  it('turns the excess of an over-large transfer into credit', async () => {
    const t = convexTest(schema);
    await t.run((ctx) => seedOrg(ctx));
    await issuedInvoice(t); // one $300 cycle
    const staff = t.withIdentity(freshStaff());

    const result = await staff.mutation(api.platform.invoices.allocatePayment, {
      workosOrgId: WORKOS_ORG,
      amount: 500,
      method: 'wire',
      reference: 'wire over',
      reason: 'Paying ahead',
    });
    expect(result.applied).toHaveLength(1);
    expect(result.creditPosted).toBe(200);

    const balance = await staff.query(api.platform.credits.creditBalance, {
      workosOrgId: WORKOS_ORG,
    });
    expect(balance.available).toBe(200);
  });

  it('refuses a repeat of the same reference on the same day', async () => {
    const t = convexTest(schema);
    await t.run((ctx) => seedOrg(ctx));
    await issuedInvoice(t);
    const staff = t.withIdentity(freshStaff());
    const receivedAt = Date.parse('2026-05-25T12:00:00Z');

    await staff.mutation(api.platform.invoices.allocatePayment, {
      workosOrgId: WORKOS_ORG,
      amount: 100,
      method: 'wire',
      reference: 'wire 25-05',
      receivedAt,
      reason: 'Catch-up',
    });
    // A double-click must not turn one transfer into two.
    await expect(
      staff.mutation(api.platform.invoices.allocatePayment, {
        workosOrgId: WORKOS_ORG,
        amount: 100,
        method: 'wire',
        reference: 'wire 25-05',
        receivedAt,
        reason: 'Catch-up',
      }),
    ).rejects.toThrow(/already recorded for that date/);
  });

  it('handles the real sequence: three transfers clearing months of arrears', async () => {
    const t = convexTest(schema);
    await t.run((ctx) => seedOrg(ctx, 0));
    const staff = t.withIdentity(freshStaff());

    // Four unpaid cycles of $300 each, issued when they were billed.
    const periods = ['2025-10', '2025-11', '2025-12', '2026-01'];
    await t.run(async (ctx) => {
      for (const periodKey of periods) {
        await ctx.db.insert('platformUsageStats', {
          workosOrgId: WORKOS_ORG,
          periodKey,
          loadsWritten: 100,
          updatedAt: Date.now(),
        });
      }
    });
    for (const periodKey of periods) {
      await t.mutation(internal.platform.invoices.cycleClose, { periodKey });
    }
    for (const d of await staff.query(api.platform.invoices.listInvoices, { status: 'draft' })) {
      await staff.mutation(api.platform.invoices.issueInvoice, {
        id: d._id,
        issuedAt: Date.parse(`${d.periodKey}-05T12:00:00Z`),
      });
    }
    let aging = await staff.query(api.platform.invoices.agingOverview, {});
    expect(aging.outstanding).toBe(1200);

    const transfers = [
      { on: '2026-04-22', amount: 500, ref: 'wire 22-04' },
      { on: '2026-05-25', amount: 400, ref: 'wire 25-05' },
      { on: '2026-08-04', amount: 300, ref: 'wire 04-08' },
    ];
    for (const tr of transfers) {
      await staff.mutation(api.platform.invoices.allocatePayment, {
        workosOrgId: WORKOS_ORG,
        amount: tr.amount,
        method: 'wire',
        reference: tr.ref,
        receivedAt: Date.parse(`${tr.on}T12:00:00Z`),
        reason: 'Arrears catch-up',
      });
    }

    aging = await staff.query(api.platform.invoices.agingOverview, {});
    expect(aging.outstanding).toBe(0);
    const rows = await staff.query(api.platform.invoices.listInvoices, {});
    expect(rows.every((r) => r.status === 'paid')).toBe(true);
    // The middle cycle was settled by two different transfers, and the record
    // shows both — which is the point of allocating rather than lump-summing.
    const split = rows.find((r) => r.periodKey === '2025-11')!;
    expect(split.payments.map((p) => p.reference)).toEqual(['wire 22-04', 'wire 25-05']);
  });

  it('splits one late payment across two overdue cycles, oldest first', async () => {
    const t = convexTest(schema);
    await t.run((ctx) => seedOrg(ctx));
    await t.run(async (ctx) => {
      await ctx.db.insert('platformUsageStats', {
        workosOrgId: WORKOS_ORG,
        periodKey: NEXT_PERIOD,
        loadsWritten: 100,
        updatedAt: Date.now(),
      });
    });
    const oldest = await issuedInvoice(t, PERIOD); // $300
    const newer = await issuedInvoice(t, NEXT_PERIOD); // $300
    const staff = t.withIdentity(freshStaff());
    const paidOn = Date.parse('2026-04-22T12:00:00Z');

    // A single $450 transfer covering the older cycle and part of the next.
    await staff.mutation(api.platform.invoices.recordPayment, {
      id: oldest,
      amount: 300,
      method: 'wire',
      reference: 'wire 22-04',
      receivedAt: paidOn,
    });
    await staff.mutation(api.platform.invoices.recordPayment, {
      id: newer,
      amount: 150,
      method: 'wire',
      reference: 'wire 22-04',
      receivedAt: paidOn,
    });

    const rows = await staff.query(api.platform.invoices.listInvoices, {});
    const a = rows.find((r) => r._id === oldest)!;
    const b = rows.find((r) => r._id === newer)!;
    expect(a.status).toBe('paid');
    expect(a.paidAt).toBe(paidOn);
    expect(b.status).toBe('partially_paid');
    expect(b.amountPaid).toBe(150);
    // The shared reference is what ties the two halves back to one transfer.
    expect(a.payments[0].reference).toBe('wire 22-04');
    expect(b.payments[0].reference).toBe('wire 22-04');
  });
});

describe('invoice ordering', () => {
  it('lists the newest cycle first regardless of the order rows were written', async () => {
    const t = convexTest(schema);
    const orgId = await t.run((ctx) => seedOrg(ctx, 0));
    const staff = t.withIdentity(freshStaff());

    // Written deliberately out of order, the way a backfill produces them.
    const periods = ['2026-03', '2025-11', '2026-01', '2025-12'];
    await t.run(async (ctx) => {
      for (const periodKey of periods) {
        await ctx.db.insert('platformUsageStats', {
          workosOrgId: WORKOS_ORG,
          periodKey,
          loadsWritten: 10,
          updatedAt: Date.now(),
        });
      }
    });
    for (const periodKey of periods) {
      await t.mutation(internal.platform.invoices.cycleClose, { periodKey });
    }
    // A one-off sharing a period with a metered invoice sorts after it.
    await staff.mutation(api.platform.invoices.createManualInvoice, {
      organizationId: orgId,
      periodKey: '2026-01',
      lines: [{ label: 'Setup', amount: 500 }],
      reason: 'SOW',
    });

    const rows = await staff.query(api.platform.invoices.listInvoices, {});
    expect(rows.map((r) => `${r.periodKey}${r.kind === 'manual' ? '-M' : ''}`)).toEqual([
      '2026-03',
      '2026-01',
      '2026-01-M',
      '2025-12',
      '2025-11',
    ]);
  });
});

describe('tenant-facing one-off charges', () => {
  it('shows committed one-offs to the tenant, and hides drafts and voids', async () => {
    const t = convexTest(schema);
    const orgId = await t.run((ctx) => seedOrg(ctx));
    const staff = t.withIdentity(freshStaff());

    // Two one-offs: one issued and paid, one left as a draft.
    await staff.mutation(api.platform.invoices.createManualInvoice, {
      organizationId: orgId,
      periodKey: PERIOD,
      lines: [{ label: 'Integration setup', amount: 1000 }],
      reason: 'SOW',
    });
    await staff.mutation(api.platform.invoices.createManualInvoice, {
      organizationId: orgId,
      periodKey: PERIOD,
      lines: [{ label: 'Not agreed yet', amount: 400 }],
      reason: 'pending',
    });
    const manuals = (await staff.query(api.platform.invoices.listInvoices, {})).filter(
      (i) => i.kind === 'manual',
    );
    const issuedOne = manuals.find((m) => m.lines[0].label === 'Integration setup')!;
    await staff.mutation(api.platform.invoices.issueInvoice, { id: issuedOne._id });

    const tenant = t.withIdentity({
      issuer: 'https://api.workos.com/user_management/tenant',
      subject: 'u',
      org_id: WORKOS_ORG,
    } as never);
    const overview = await tenant.query(api.platformUsage.getBillingOverview, {
      workosOrgId: WORKOS_ORG,
    });

    // The draft is the customer's business only once we raise it.
    expect(overview.oneOffCharges).toHaveLength(1);
    expect(overview.oneOffCharges[0]).toMatchObject({
      description: 'Integration setup',
      amount: 1000,
      status: 'due',
    });
    // And a one-off never disturbs the cycle history.
    expect(overview.closedCycles.find((c) => c.periodKey === PERIOD)?.amount).toBe(300);
  });
});

describe('write-off', () => {
  it('closes an uncollectible balance and keeps it out of receivables', async () => {
    const t = convexTest(schema);
    await t.run((ctx) => seedOrg(ctx));
    const id = await issuedInvoice(t);
    const staff = t.withIdentity(freshStaff());
    await staff.mutation(api.platform.invoices.recordPayment, { id, amount: 50, method: 'check' });

    const before = await staff.query(api.platform.invoices.agingOverview, {});
    expect(before.outstanding).toBe(250);

    await staff.mutation(api.platform.invoices.writeOffInvoice, {
      id,
      reason: 'Customer insolvent — sent to collections and abandoned',
    });

    const [inv] = await staff.query(api.platform.invoices.listInvoices, {});
    expect(inv.status).toBe('written_off');
    // The balance stays visible on the row: written off ≠ paid.
    expect(inv.amountPaid).toBe(50);

    const after = await staff.query(api.platform.invoices.agingOverview, {});
    expect(after.outstanding).toBe(0);
    expect(after.writtenOffCount).toBe(1);
    expect(after.writtenOffAmount).toBe(250);
  });

  it('refuses when nothing is outstanding', async () => {
    const t = convexTest(schema);
    await t.run((ctx) => seedOrg(ctx));
    const id = await issuedInvoice(t);
    const staff = t.withIdentity(freshStaff());
    await staff.mutation(api.platform.invoices.recordPayment, { id, amount: 300, method: 'ach' });
    await expect(
      staff.mutation(api.platform.invoices.writeOffInvoice, { id, reason: 'x' }),
    ).rejects.toThrow(/Cannot write off a paid invoice/);
  });
});

describe('effective-dated rates', () => {
  it('back-dates a rate when nothing from that period on is committed', async () => {
    const t = convexTest(schema);
    const orgId = await t.run((ctx) => seedOrg(ctx));
    const staff = t.withIdentity(freshStaff());

    await staff.mutation(api.platform.invoices.setRateStep, {
      organizationId: orgId,
      effectiveFromPeriod: PERIOD, // the cycle being closed — a mid-month signing
      ratePerLoad: 2.5,
      reason: 'Contract signed 2026-07-14 at $2.50',
    });

    await t.mutation(internal.platform.invoices.cycleClose, { periodKey: PERIOD });
    const [draft] = await staff.query(api.platform.invoices.listInvoices, {});
    expect(draft.ratePerLoad).toBe(2.5);
    expect(draft.subtotal).toBe(250); // 100 × 2.50, not 100 × 3
  });

  it('refuses to re-price a period that is already billed, and names it', async () => {
    const t = convexTest(schema);
    const orgId = await t.run((ctx) => seedOrg(ctx));
    await issuedInvoice(t); // PERIOD is now committed
    const staff = t.withIdentity(freshStaff());

    await expect(
      staff.mutation(api.platform.invoices.setRateStep, {
        organizationId: orgId,
        effectiveFromPeriod: PERIOD,
        ratePerLoad: 2.5,
        reason: 'retro discount',
      }),
    ).rejects.toThrow(new RegExp(PERIOD));
  });

  it('still allows a FUTURE step when past periods are committed', async () => {
    const t = convexTest(schema);
    const orgId = await t.run((ctx) => seedOrg(ctx));
    await issuedInvoice(t);
    const staff = t.withIdentity(freshStaff());

    await staff.mutation(api.platform.invoices.setRateStep, {
      organizationId: orgId,
      effectiveFromPeriod: '2027-01',
      ratePerLoad: 4,
      reason: 'Annual escalator',
    });
    const org = await t.run(async (ctx) => await ctx.db.get(orgId));
    expect(org!.rateSchedule).toEqual([{ effectiveFromPeriod: '2027-01', ratePerLoad: 4 }]);
  });

  it('validates the period format and the rate', async () => {
    const t = convexTest(schema);
    const orgId = await t.run((ctx) => seedOrg(ctx));
    const staff = t.withIdentity(freshStaff());
    await expect(
      staff.mutation(api.platform.invoices.setRateStep, {
        organizationId: orgId,
        effectiveFromPeriod: '2026-13',
        ratePerLoad: 4,
        reason: 'x',
      }),
    ).rejects.toThrow(/YYYY-MM/);
    await expect(
      staff.mutation(api.platform.invoices.setRateStep, {
        organizationId: orgId,
        effectiveFromPeriod: '2027-01',
        ratePerLoad: 0,
        reason: 'x',
      }),
    ).rejects.toThrow(/positive/);
  });
});

describe('manual invoices', () => {
  it('coexists with the cycle invoice for the same period', async () => {
    const t = convexTest(schema);
    const orgId = await t.run((ctx) => seedOrg(ctx));
    const staff = t.withIdentity(freshStaff());

    await staff.mutation(api.platform.invoices.createManualInvoice, {
      organizationId: orgId,
      periodKey: PERIOD,
      lines: [{ label: 'Onboarding & implementation', amount: 2500 }],
      reason: 'Signed SOW #12',
    });

    // The metered close still runs — and does not trip over the manual row.
    await t.mutation(internal.platform.invoices.cycleClose, { periodKey: PERIOD });
    const invoices = await staff.query(api.platform.invoices.listInvoices, {});
    expect(invoices).toHaveLength(2);
    expect(invoices.filter((i) => i.kind === 'manual')).toHaveLength(1);
    expect(invoices.filter((i) => i.kind === 'metered')).toHaveLength(1);
    // Distinct number series, so neither shadows the other.
    const manual = invoices.find((i) => i.kind === 'manual')!;
    expect(manual.invoiceNumber).toMatch(/-M1$/);
    expect(manual.total).toBe(2500);

    // And the tenant billing page still reads the METERED row for the cycle.
    const overview = await t
      .withIdentity({
        issuer: 'https://api.workos.com/user_management/tenant',
        subject: 'u',
        org_id: WORKOS_ORG,
      } as never)
      .query(api.platformUsage.getBillingOverview, { workosOrgId: WORKOS_ORG });
    const cycle = overview.closedCycles.find((c) => c.periodKey === PERIOD);
    expect(cycle?.loadsWritten).toBe(100);
    expect(cycle?.amount).toBe(300); // the metered amount, not 2500
  });

  it('rejects empty and zero-amount lines', async () => {
    const t = convexTest(schema);
    const orgId = await t.run((ctx) => seedOrg(ctx));
    const staff = t.withIdentity(freshStaff());
    await expect(
      staff.mutation(api.platform.invoices.createManualInvoice, {
        organizationId: orgId,
        periodKey: PERIOD,
        lines: [],
        reason: 'x',
      }),
    ).rejects.toThrow(/At least one line/);
    await expect(
      staff.mutation(api.platform.invoices.createManualInvoice, {
        organizationId: orgId,
        periodKey: PERIOD,
        lines: [{ label: 'Freebie', amount: 0 }],
        reason: 'x',
      }),
    ).rejects.toThrow(/non-zero amount/);
  });
});

describe('contract editing', () => {
  it('updates contact and license fields with an audit trail', async () => {
    const t = convexTest(schema);
    const orgId = await t.run((ctx) => seedOrg(ctx));
    const staff = t.withIdentity(freshStaff());

    await staff.mutation(api.platform.invoices.updateContract, {
      organizationId: orgId,
      billingEmail: 'ap@p5.test',
      platformContractNumber: 'OTQ-2026-004',
      platformLicenseEnd: '2027-06-30',
      reason: 'Renewal signed',
    });

    const org = await t.run(async (ctx) => await ctx.db.get(orgId));
    expect(org).toMatchObject({
      billingEmail: 'ap@p5.test',
      platformContractNumber: 'OTQ-2026-004',
      platformLicenseEnd: '2027-06-30',
    });
    const audit = await staff.query(api.platform.access.recentAuditLog, {});
    expect(audit[0]).toMatchObject({ action: 'contract_updated', reason: 'Renewal signed' });
  });

  it('rejects an inverted license window and a malformed date', async () => {
    const t = convexTest(schema);
    const orgId = await t.run((ctx) => seedOrg(ctx));
    const staff = t.withIdentity(freshStaff());
    await expect(
      staff.mutation(api.platform.invoices.updateContract, {
        organizationId: orgId,
        platformLicenseStart: '2027-01-01',
        platformLicenseEnd: '2026-01-01',
        reason: 'x',
      }),
    ).rejects.toThrow(/on or before/);
    await expect(
      staff.mutation(api.platform.invoices.updateContract, {
        organizationId: orgId,
        platformLicenseEnd: '06/30/2027',
        reason: 'x',
      }),
    ).rejects.toThrow(/YYYY-MM-DD/);
  });
});

describe('cron staleness — a job that stops firing is not healthy', () => {
  const baseJob = {
    jobName: 'demo-job',
    lastFinishedAt: 0,
    lastDurationMs: 10,
    lastOutcome: 'ok' as const,
    consecutiveFailures: 0,
    totalRuns: 10,
    totalFailures: 0,
    updatedAt: 0,
  };

  it('reports stale only after the missed-cycle threshold', () => {
    const now = Date.now();
    const every = 60 * 60 * 1000; // hourly
    // One missed cycle: still fine (Convex interval scheduling drifts).
    expect(
      jobState({ ...baseJob, lastStartedAt: now - 2 * every, expectedIntervalMs: every } as never, now),
    ).toBe('ok');
    // Four missed cycles: stale.
    expect(
      jobState({ ...baseJob, lastStartedAt: now - 5 * every, expectedIntervalMs: every } as never, now),
    ).toBe('stale');
  });

  it('never alerts a high-frequency job over a brief hiccup', () => {
    const now = Date.now();
    const every = 10_000; // the Samsara poll
    // 3× cadence would be 90s — far too twitchy to page on. The floor keeps
    // a short scheduling gap out of the alert stream.
    expect(
      jobState({ ...baseJob, lastStartedAt: now - 2 * 60_000, expectedIntervalMs: every } as never, now),
    ).toBe('ok');
    expect(
      jobState({ ...baseJob, lastStartedAt: now - 10 * 60_000, expectedIntervalMs: every } as never, now),
    ).toBe('stale');
  });

  it('outranks a green last outcome', () => {
    const now = Date.now();
    const job = {
      ...baseJob,
      lastStartedAt: now - 10 * 60_000,
      expectedIntervalMs: 60_000,
      lastOutcome: 'ok' as const,
    };
    // The old board would show this as 'ok' forever.
    expect(jobState(job as never, now)).toBe('stale');
  });

  it('detects a run that started and never reported', () => {
    const now = Date.now();
    expect(
      jobState(
        {
          ...baseJob,
          lastStartedAt: now - 60_000,
          expectedIntervalMs: 24 * 60 * 60 * 1000,
          inFlightSince: now - 20 * 60 * 1000,
        } as never,
        now,
      ),
    ).toBe('hung');
  });

  it('reports unknown (never stale) for rows predating cadence declarations', () => {
    const now = Date.now();
    expect(jobState({ ...baseJob, lastStartedAt: now - 30 * 86_400_000 } as never, now)).toBe(
      'unknown',
    );
  });

  it('retire silences it, and a fresh tick un-retires it', async () => {
    const t = convexTest(schema);
    await t.run(async (ctx) => {
      await ctx.db.insert('cronHealth', {
        ...baseJob,
        jobName: 'removed-job',
        lastStartedAt: Date.now() - 30 * 86_400_000,
        expectedIntervalMs: 60_000,
      });
    });
    const staff = t.withIdentity(freshStaff());
    expect((await staff.query(api.platform.jobs.listJobs, {}))[0].state).toBe('stale');

    await staff.mutation(api.platform.jobs.retireJob, {
      jobName: 'removed-job',
      reason: 'Deleted from crons.ts in #482',
    });
    expect((await staff.query(api.platform.jobs.listJobs, {}))[0].state).toBe('retired');

    // If it ever fires again, retirement clears itself.
    await t.mutation(internal.platform.cronRunner.markStarted, {
      jobName: 'removed-job',
      startedAt: Date.now(),
      expectedIntervalMs: 60_000,
    });
    const [job] = await staff.query(api.platform.jobs.listJobs, {});
    expect(job.retiredAt).toBeUndefined();
  });

  it('raises a stale alert with a message that says what is wrong', async () => {
    const t = convexTest(schema);
    await t.run(async (ctx) => {
      await ctx.db.insert('cronHealth', {
        ...baseJob,
        jobName: 'silent-job',
        lastStartedAt: Date.now() - 6 * 60 * 60 * 1000,
        expectedIntervalMs: 60 * 60 * 1000,
      });
    });
    await t.mutation(internal.platform.alerts.evaluate, {});
    const alerts = await t
      .withIdentity(freshStaff())
      .query(api.platform.alerts.listAlerts, {});
    expect(alerts).toHaveLength(1);
    expect(alerts[0]).toMatchObject({ kind: 'cron_stale', severity: 'high' });
    expect(alerts[0].message).toContain('has not run');
  });
});

describe('alert workflow', () => {
  async function raiseAlert(t: ReturnType<typeof convexTest>) {
    await t.run(async (ctx) => {
      await ctx.db.insert('cronHealth', {
        jobName: 'broken-job',
        lastStartedAt: Date.now(),
        lastFinishedAt: Date.now(),
        lastDurationMs: 5,
        lastOutcome: 'error',
        consecutiveFailures: 5,
        totalRuns: 5,
        totalFailures: 5,
        expectedIntervalMs: 60_000,
        updatedAt: Date.now(),
      });
    });
    await t.mutation(internal.platform.alerts.evaluate, {});
    const [alert] = await t.withIdentity(freshStaff()).query(api.platform.alerts.listAlerts, {});
    return alert;
  }

  it('re-opens after a manual resolve when the condition still holds', async () => {
    const t = convexTest(schema);
    const alert = await raiseAlert(t);
    const staff = t.withIdentity(freshStaff());

    await staff.mutation(api.platform.alerts.resolveAlert, {
      alertId: alert._id,
      note: 'thought it was over',
    });
    await t.mutation(internal.platform.alerts.evaluate, {});

    const open = (await staff.query(api.platform.alerts.listAlerts, {})).filter(
      (a) => a.status === 'open',
    );
    expect(open).toHaveLength(1); // resolve is a belief, not a mute
  });

  it('snooze suppresses the re-open for its window', async () => {
    const t = convexTest(schema);
    const alert = await raiseAlert(t);
    const staff = t.withIdentity(freshStaff());

    await staff.mutation(api.platform.alerts.snoozeAlert, {
      alertId: alert._id,
      hours: 4,
      note: 'vendor ticket #55 open',
    });
    await t.mutation(internal.platform.alerts.evaluate, {});

    const all = await staff.query(api.platform.alerts.listAlerts, { includeResolved: true });
    expect(all.filter((a) => a.status === 'open')).toHaveLength(0);
    expect(all[0].note).toBe('vendor ticket #55 open');
  });

  it('bounds the snooze window', async () => {
    const t = convexTest(schema);
    const alert = await raiseAlert(t);
    await expect(
      t
        .withIdentity(freshStaff())
        .mutation(api.platform.alerts.snoozeAlert, { alertId: alert._id, hours: 720 }),
    ).rejects.toThrow(/168 hours/);
  });
});

describe('webhook dead-letter requeue', () => {
  async function seedDeadLetter(ctx: MutationCtx, orgId = WORKOS_ORG) {
    const partnerKeyId = await ctx.db.insert('partnerApiKeys', {
      workosOrgId: orgId,
      partnerName: 'Test Partner',
      keyPrefix: 'otq_test_a1b2',
      keyHash: 'sha256hash',
      environment: 'sandbox',
      permissions: ['tracking:read'],
      rateLimitTier: 'low',
      status: 'ACTIVE',
      createdBy: 'test',
      createdAt: Date.now(),
    } as never);
    const subscriptionId = await ctx.db.insert('webhookSubscriptions', {
      workosOrgId: orgId,
      partnerKeyId,
      url: 'https://partner.example/hook',
      events: ['position.update'],
      encryptedSecret: 'enc',
      intervalMinutes: 5,
      status: 'ACTIVE',
      consecutiveFailures: 0,
      createdAt: Date.now(),
      updatedAt: Date.now(),
    } as never);
    // The queue row references a real load; loadInformation has a wide
    // required surface, so this is the minimum that validates.
    const customerId = await ctx.db.insert('customers', {
      name: 'Shipper Co',
      companyType: 'Shipper',
      status: 'Active',
      addressLine1: '1 St',
      city: 'Oakland',
      state: 'California',
      zip: '94601',
      country: 'USA',
      workosOrgId: orgId,
      createdBy: 'test',
      createdAt: Date.now(),
      updatedAt: Date.now(),
    } as never);
    const loadId = await ctx.db.insert('loadInformation', {
      internalId: 'L-1',
      orderNumber: 'ORD-1',
      status: 'Completed',
      trackingStatus: 'Completed',
      customerId,
      fleet: 'Company',
      units: 'Pallets',
      workosOrgId: orgId,
      createdBy: 'test',
      createdAt: Date.now(),
      updatedAt: Date.now(),
    } as never);
    return await ctx.db.insert('webhookDeliveryQueue', {
      subscriptionId,
      workosOrgId: orgId,
      deliveryId: 'dlv_1',
      loadId,
      eventType: 'position.update',
      status: 'DEAD_LETTER',
      attempts: 5,
      maxAttempts: 5,
      lastHttpStatus: 500,
      lastErrorMessage: 'partner 500',
      createdAt: Date.now(),
    });
  }

  it('puts a dead delivery back on the queue with attempts reset', async () => {
    const t = convexTest(schema);
    const deliveryId = await t.run((ctx) => seedDeadLetter(ctx));
    const staff = t.withIdentity(freshStaff());

    const result = await staff.mutation(api.platform.support.requeueDeadLetters, {
      deliveryIds: [deliveryId],
      reason: 'Partner confirmed their endpoint is back',
    });
    expect(result).toEqual({ requeued: 1, skipped: 0 });

    const row = await t.run(async (ctx) => await ctx.db.get(deliveryId));
    expect(row).toMatchObject({ status: 'PENDING', attempts: 0 });
    expect(row!.lastErrorMessage).toBeUndefined();
  });

  it('is idempotent — a second requeue skips rather than resetting a live delivery', async () => {
    const t = convexTest(schema);
    const deliveryId = await t.run((ctx) => seedDeadLetter(ctx));
    const staff = t.withIdentity(freshStaff());
    await staff.mutation(api.platform.support.requeueDeadLetters, {
      deliveryIds: [deliveryId],
      reason: 'first',
    });
    const second = await staff.mutation(api.platform.support.requeueDeadLetters, {
      deliveryIds: [deliveryId],
      reason: 'again',
    });
    expect(second).toEqual({ requeued: 0, skipped: 1 });
  });

  it('skips deliveries whose subscription is gone', async () => {
    const t = convexTest(schema);
    const deliveryId = await t.run(async (ctx) => {
      const id = await seedDeadLetter(ctx);
      const row = await ctx.db.get(id);
      await ctx.db.delete(row!.subscriptionId);
      return id;
    });
    const result = await t
      .withIdentity(freshStaff())
      .mutation(api.platform.support.requeueDeadLetters, {
        deliveryIds: [deliveryId],
        reason: 'x',
      });
    expect(result).toEqual({ requeued: 0, skipped: 1 });
  });

  it('requires step-up and a reason', async () => {
    const t = convexTest(schema);
    const deliveryId = await t.run((ctx) => seedDeadLetter(ctx));
    await expect(
      t.withIdentity(staleStaff()).mutation(api.platform.support.requeueDeadLetters, {
        deliveryIds: [deliveryId],
        reason: 'x',
      }),
    ).rejects.toThrow(/Step-up required/);
  });
});

describe('systemEvents — dedupe and acknowledgement', () => {
  it('collapses repeats and resurfaces an acked event that happens again', async () => {
    const t = convexTest(schema);
    const staff = t.withIdentity(freshStaff());

    const fail = async (n: number) =>
      await t.mutation(internal.platform.cronRunner.record, {
        jobName: 'noisy-job',
        startedAt: Date.now(),
        durationMs: 1,
        error: `boom ${n}`,
        recordHistory: true,
      });

    await fail(1);
    await fail(2);
    let events = await staff.query(api.platform.events.recentEvents, {});
    expect(events).toHaveLength(1);
    expect(events[0].occurrences).toBe(2);

    await staff.mutation(api.platform.events.ackEvent, { eventId: events[0]._id });
    events = await staff.query(api.platform.events.recentEvents, {});
    expect(events).toHaveLength(0); // feed can reach zero

    // It happens again → back in the feed. An ack silences an occurrence,
    // never the condition.
    await fail(3);
    events = await staff.query(api.platform.events.recentEvents, {});
    expect(events).toHaveLength(1);
    expect(events[0].occurrences).toBe(3);
  });

  it('resurfaces a recurrence that lands in the same millisecond as the ack', async () => {
    const t = convexTest(schema);
    const staff = t.withIdentity(freshStaff());
    const now = Date.now();

    // An event acked at exactly its own lastSeenAt, then one more occurrence
    // stamped at the SAME instant. A timestamp comparison would swallow this;
    // the occurrence counter cannot.
    const id = await t.run(async (ctx) => {
      return await ctx.db.insert('systemEvents', {
        severity: 'error',
        source: 'test',
        code: 'test.race',
        message: 'boom',
        dedupeKey: 'test.race:*',
        occurrences: 1,
        lastSeenAt: now,
        createdAt: now,
      });
    });
    await staff.mutation(api.platform.events.ackEvent, { eventId: id });
    expect(await staff.query(api.platform.events.recentEvents, {})).toHaveLength(0);

    await t.run(async (ctx) => {
      const row = await ctx.db.get(id);
      await ctx.db.patch(id, { occurrences: (row!.occurrences ?? 1) + 1, lastSeenAt: row!.ackedAt });
    });
    const events = await staff.query(api.platform.events.recentEvents, {});
    expect(events).toHaveLength(1);
    expect(events[0].occurrences).toBe(2);
  });

  it('bulk-ack clears the backlog but never touches critical events', async () => {
    const t = convexTest(schema);
    await t.run(async (ctx) => {
      const now = Date.now();
      for (const [i, severity] of (['info', 'warn', 'error', 'critical'] as const).entries()) {
        await ctx.db.insert('systemEvents', {
          severity,
          source: 'test',
          code: `test.${severity}`,
          message: severity,
          dedupeKey: `test.${severity}:*`,
          occurrences: 1,
          lastSeenAt: now - i,
          createdAt: now - i,
        });
      }
    });
    const staff = t.withIdentity(freshStaff());
    const result = await staff.mutation(api.platform.events.ackAllEvents, {});
    expect(result.acked).toBe(3);

    const left = await staff.query(api.platform.events.recentEvents, {});
    expect(left).toHaveLength(1);
    expect(left[0].severity).toBe('critical');
  });
});

describe('Stripe interop with credits and the new statuses', () => {
  it('reconciliation covers partially_paid, and reports the BALANCE not the face value', async () => {
    const t = convexTest(schema);
    await t.run((ctx) => seedOrg(ctx));
    const id = await issuedInvoice(t);
    const staff = t.withIdentity(freshStaff());
    await staff.mutation(api.platform.invoices.recordPayment, { id, amount: 100, method: 'ach' });
    await t.run(async (ctx) => {
      await ctx.db.patch(id, { stripeInvoiceId: 'in_test_1' });
    });

    const open = await t.run(async (ctx) => {
      // Mirrors listPushedOpenInvoices' status set + balance projection.
      const rows = (
        await Promise.all(
          (['issued', 'sent', 'partially_paid'] as const).map((status) =>
            ctx.db
              .query('platformInvoices')
              .withIndex('by_status', (q) => q.eq('status', status))
              .take(200),
          ),
        )
      ).flat();
      return rows
        .filter((i) => i.stripeInvoiceId)
        .map((i) => ({ total: Math.round((i.total - i.amountPaid) * 100) / 100 }));
    });
    // A partially-paid invoice must not drop out of reconciliation, and the
    // amount tracked is what is still owed.
    expect(open).toEqual([{ total: 200 }]);
  });

  it('a Stripe payment sums the ledger and lands in partially_paid', async () => {
    const t = convexTest(schema);
    await t.run((ctx) => seedOrg(ctx));
    const id = await issuedInvoice(t);
    await t.run(async (ctx) => {
      await ctx.db.patch(id, { stripeInvoiceId: 'in_test_2' });
    });

    await t.mutation(internal.platform.stripe.applyStripeInvoicePaid, {
      stripeInvoiceId: 'in_test_2',
      amountPaidCents: 12_000, // $120 of $300
    });

    const [inv] = await t
      .withIdentity(freshStaff())
      .query(api.platform.invoices.listInvoices, {});
    expect(inv.amountPaid).toBe(120);
    expect(inv.status).toBe('partially_paid');
    // The entry carries an id, so it can be reversed like any other payment.
    expect(inv.payments[0].id).toBeDefined();
  });

  it('flags a Stripe payment arriving after a write-off instead of silently reviving it', async () => {
    const t = convexTest(schema);
    await t.run((ctx) => seedOrg(ctx));
    const id = await issuedInvoice(t);
    const staff = t.withIdentity(freshStaff());
    await staff.mutation(api.platform.invoices.writeOffInvoice, {
      id,
      reason: 'Uncollectible',
    });
    await t.run(async (ctx) => {
      await ctx.db.patch(id, { stripeInvoiceId: 'in_test_3' });
    });

    await t.mutation(internal.platform.stripe.applyStripeInvoicePaid, {
      stripeInvoiceId: 'in_test_3',
      amountPaidCents: 30_000,
    });

    const events = await staff.query(api.platform.events.recentEvents, {});
    expect(events.some((e) => e.code === 'stripe.paid_after_write_off')).toBe(true);
  });
});

describe('console self-check', () => {
  it('reports which integrations are unconfigured instead of failing silently', async () => {
    const t = convexTest(schema);
    const check = await t.withIdentity(freshStaff()).query(api.platform.selfCheck.consoleSelfCheck, {});

    const slack = check.integrations.find((i) => i.key === 'slack_alerts')!;
    expect(slack.configured).toBe(false); // no webhook in the test env
    expect(slack.impact).toMatch(/never delivered/);
    expect(check.staffAllowlistSize).toBe(1);
    expect(check.evaluator).toBeNull(); // hasn't run in this deployment yet
  });

  it('never leaks secret values', async () => {
    process.env.SLACK_ALERT_WEBHOOK_URL = 'https://hooks.slack.com/services/SUPER/SECRET';
    try {
      const t = convexTest(schema);
      const check = await t
        .withIdentity(freshStaff())
        .query(api.platform.selfCheck.consoleSelfCheck, {});
      expect(JSON.stringify(check)).not.toContain('SUPER');
      expect(check.integrations.find((i) => i.key === 'slack_alerts')!.configured).toBe(true);
    } finally {
      delete process.env.SLACK_ALERT_WEBHOOK_URL;
    }
  });
});
