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
