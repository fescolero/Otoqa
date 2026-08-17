import { v, ConvexError } from 'convex/values';
import { query, mutation, internalMutation } from '../_generated/server';
import type { MutationCtx, QueryCtx } from '../_generated/server';
import type { Doc } from '../_generated/dataModel';
import { requirePlatformStaff, requireRecentStaffAuth } from '../lib/auth';
import { logPlatformAudit } from '../lib/platformAudit';
import { logSystemEvent } from '../lib/systemEvents';
import { consumeCredits, issueCredit, releaseCreditsForInvoice } from './credits';
import { DEFAULT_BILLING_RATE_PER_LOAD } from '../platformUsageHelpers';
import { platformInvoiceNumber } from '../platformUsage';
import { getPeriodKey } from '../accountingStatsHelpers';

/**
 * Platform invoice ledger (Phase 3 — docs/platform-billing-spec.md).
 *
 * The metering layer (platformUsageStats) is never edited; this module
 * freezes commercial state on top of it. Immutability rule: once an
 * invoice leaves 'draft', its lines/rate/subtotal/tax never change —
 * corrections are next-cycle adjustments or void+reissue.
 */

const money = (n: number) => Math.round(n * 100) / 100;

/**
 * The ONE metered invoice for an org × period, or null.
 *
 * `by_org_period` is no longer unique: one-off invoices (kind='manual') can
 * share a period with the metered one, so `.unique()` on this index would
 * throw the moment an operator raises an onboarding fee. Every lookup that
 * means "the cycle's invoice" must go through here. Rows created before
 * `kind` existed are metered by definition (cycle close was the only writer).
 */
export async function meteredInvoiceForPeriod(
  ctx: MutationCtx | QueryCtx,
  workosOrgId: string,
  periodKey: string,
): Promise<Doc<'platformInvoices'> | null> {
  const rows = await ctx.db
    .query('platformInvoices')
    .withIndex('by_org_period', (q) => q.eq('workosOrgId', workosOrgId).eq('periodKey', periodKey))
    .collect();
  const metered = rows.filter((r) => r.kind !== 'manual');
  // A voided row is a cancelled document, not the cycle's live invoice —
  // prefer a live one so a void in the history never shadows it, and so
  // cycleClose can re-draft a period whose only invoice was cancelled.
  return metered.find((r) => r.status !== 'void') ?? metered[0] ?? null;
}

/** The live (non-void) metered invoice for a period, if the cycle still has one. */
async function liveMeteredInvoice(
  ctx: MutationCtx,
  workosOrgId: string,
  periodKey: string,
): Promise<Doc<'platformInvoices'> | null> {
  const invoice = await meteredInvoiceForPeriod(ctx, workosOrgId, periodKey);
  return invoice && invoice.status !== 'void' ? invoice : null;
}

/** Statuses that represent a real, collectible obligation. */
const COMMITTED_STATUSES: ReadonlySet<Doc<'platformInvoices'>['status']> = new Set([
  'issued',
  'sent',
  'partially_paid',
  'paid',
  'written_off',
]);

const OPEN_STATUSES = ['issued', 'sent', 'partially_paid'] as const;

/** Payment ids are per-invoice and derived, never random: the array is append-only. */
function nextPaymentId(invoice: Doc<'platformInvoices'>): string {
  return `pay_${invoice.payments.length}_${invoice.periodKey}`;
}

/** Stable handle for a payment, including legacy rows written without an id. */
function paymentKey(payment: Doc<'platformInvoices'>['payments'][number], index: number): string {
  return payment.id ?? `idx:${index}`;
}

/** amountPaid is ALWAYS the sum of the append-only ledger, never incremented. */
function sumPayments(payments: Doc<'platformInvoices'>['payments']): number {
  return money(payments.reduce((s, p) => s + p.amount, 0));
}

/**
 * Status implied by the money, for an invoice that has left draft. Keeps
 * `paid`/`partially_paid`/`issued`/`sent` consistent no matter which direction
 * the ledger moved — a reversal walks the status back down exactly the way a
 * payment walked it up.
 *
 * `void` and `written_off` are decisions, not arithmetic, so they're preserved.
 */
function statusFromLedger(
  invoice: Doc<'platformInvoices'>,
  amountPaid: number,
): Doc<'platformInvoices'>['status'] {
  if (invoice.status === 'void' || invoice.status === 'written_off' || invoice.status === 'draft') {
    return invoice.status;
  }
  if (amountPaid >= invoice.total && invoice.total > 0) return 'paid';
  if (amountPaid > 0) return 'partially_paid';
  // Nothing paid: fall back to whether the customer ever received it.
  return invoice.sentAt ? 'sent' : 'issued';
}

// ─── Pure computation helpers (exported for tests) ──────────────────────

export function resolveRateForPeriod(
  org: Pick<Doc<'organizations'>, 'billingRatePerLoad' | 'rateSchedule'>,
  periodKey: string,
): number {
  const steps = (org.rateSchedule ?? [])
    .filter((s) => s.effectiveFromPeriod <= periodKey)
    .sort((a, b) => a.effectiveFromPeriod.localeCompare(b.effectiveFromPeriod));
  if (steps.length > 0) return steps[steps.length - 1].ratePerLoad;
  return org.billingRatePerLoad ?? DEFAULT_BILLING_RATE_PER_LOAD;
}

export function computeLines(
  org: Pick<
    Doc<'organizations'>,
    'billingRatePerLoad' | 'rateSchedule' | 'recurringCharges' | 'minimumMonthlyCharge'
  >,
  periodKey: string,
  loadsWritten: number,
): { lines: { kind: 'usage' | 'recurring' | 'minimum_true_up'; label: string; amount: number }[]; ratePerLoad: number } {
  const ratePerLoad = resolveRateForPeriod(org, periodKey);
  const lines: { kind: 'usage' | 'recurring' | 'minimum_true_up'; label: string; amount: number }[] = [];

  if (loadsWritten > 0) {
    lines.push({
      kind: 'usage',
      label: `${loadsWritten} loads × $${ratePerLoad.toFixed(2)}`,
      amount: money(loadsWritten * ratePerLoad),
    });
  }

  const month = Number(periodKey.split('-')[1]); // 1-based
  let monthlyRecurring = 0;
  for (const charge of org.recurringCharges ?? []) {
    if (charge.cadence === 'monthly') {
      lines.push({ kind: 'recurring', label: charge.label, amount: money(charge.amount) });
      monthlyRecurring += charge.amount;
    } else if (charge.cadence === 'annual' && charge.anniversaryMonth === month) {
      lines.push({
        kind: 'recurring',
        label: `${charge.label} (annual)`,
        amount: money(charge.amount),
      });
    }
  }

  // Minimum commitment: true-up against usage + MONTHLY recurring only
  // (annual charges don't count toward the floor — spec §3).
  if (org.minimumMonthlyCharge != null && org.minimumMonthlyCharge > 0) {
    const counted = money(loadsWritten * ratePerLoad + monthlyRecurring);
    const shortfall = money(org.minimumMonthlyCharge - counted);
    if (shortfall > 0) {
      lines.push({
        kind: 'minimum_true_up',
        label: `Minimum commitment true-up (floor $${org.minimumMonthlyCharge.toFixed(2)})`,
        amount: shortfall,
      });
    }
  }

  return { lines, ratePerLoad };
}

/**
 * Due date from terms (spec §3): net → issued + days; dayOfMonth → the next
 * occurrence of that calendar day STRICTLY after the issue date, clamped to
 * the end of short months. Default: net-15.
 */
export function computeDueAt(
  issuedAt: number,
  terms: Doc<'organizations'>['billingTerms'],
): number {
  const t = terms ?? { kind: 'net' as const, days: 15 };
  if (t.kind === 'net') {
    return issuedAt + t.days * 24 * 60 * 60 * 1000;
  }
  const d = new Date(issuedAt);
  const y = d.getUTCFullYear();
  const m = d.getUTCMonth();
  const clamp = (year: number, month0: number, day: number) =>
    Date.UTC(year, month0, Math.min(day, new Date(Date.UTC(year, month0 + 1, 0)).getUTCDate()));
  const thisMonth = clamp(y, m, t.day);
  if (thisMonth > issuedAt) return thisMonth;
  return clamp(m === 11 ? y + 1 : y, (m + 1) % 12, t.day);
}

function sumSubtotal(invoice: Pick<Doc<'platformInvoices'>, 'lines' | 'adjustments'>): number {
  return money(
    invoice.lines.reduce((s, l) => s + l.amount, 0) +
      invoice.adjustments.reduce((s, a) => s + a.amountDelta, 0),
  );
}

/**
 * Drift hook (spec §5), called by the nightly recalc when it RAISES a
 * period's count: if that period is already invoiced (non-draft, non-void),
 * flag the invoice and emit a systemEvent — never silently change money.
 */
export async function flagDriftIfInvoiced(
  ctx: MutationCtx,
  workosOrgId: string,
  periodKey: string,
  newCount: number,
): Promise<void> {
  const invoice = await meteredInvoiceForPeriod(ctx, workosOrgId, periodKey);
  if (!invoice || invoice.status === 'draft' || invoice.status === 'void') return;
  if (newCount <= invoice.loadsWritten) return;

  await ctx.db.patch(invoice._id, { driftDetectedAt: Date.now(), updatedAt: Date.now() });
  await logSystemEvent(ctx, {
    severity: 'warn',
    source: 'billing',
    code: 'billing.drift',
    message: `Usage for ${workosOrgId} ${periodKey} rose to ${newCount} after invoice ${invoice.invoiceNumber} froze ${invoice.loadsWritten} — bill the delta as a next-cycle adjustment or waive it`,
    orgId: workosOrgId,
    context: { periodKey, invoiced: invoice.loadsWritten, newCount },
  });
}

/** Rebaseline guard (spec §5): true when any period is committed. */
export async function orgHasCommittedInvoices(
  ctx: MutationCtx,
  workosOrgId: string,
): Promise<boolean> {
  const rows = await ctx.db
    .query('platformInvoices')
    .withIndex('by_org_period', (q) => q.eq('workosOrgId', workosOrgId))
    .collect();
  return rows.some((r) => COMMITTED_STATUSES.has(r.status));
}

/**
 * Periods at or after `fromPeriod` that already carry a committed invoice.
 *
 * A rate step at period P re-prices P and every period after it, so a
 * back-dated rate change is only safe when NOTHING from P onward has been
 * billed. `orgHasCommittedInvoices` is too coarse for this — it would block
 * every back-date for any org that has ever invoiced.
 */
export async function committedPeriodsFrom(
  ctx: MutationCtx,
  workosOrgId: string,
  fromPeriod: string,
): Promise<string[]> {
  const rows = await ctx.db
    .query('platformInvoices')
    .withIndex('by_org_period', (q) => q.eq('workosOrgId', workosOrgId))
    .collect();
  return rows
    .filter((r) => r.kind !== 'manual' && r.periodKey >= fromPeriod && COMMITTED_STATUSES.has(r.status))
    .map((r) => r.periodKey)
    .sort();
}

// ─── Cycle close ─────────────────────────────────────────────────────────

function previousPeriodKey(now: number): string {
  const d = new Date(now);
  const y = d.getUTCFullYear();
  const m = d.getUTCMonth(); // 0-based current month
  return m === 0 ? `${y - 1}-12` : `${y}-${String(m).padStart(2, '0')}`;
}

/**
 * Draft invoices for a closed cycle (cron: 2nd of the month, after the
 * nightly recalc has settled the closed month). Idempotent: upserts by
 * (org, period) and never touches an existing row.
 */
export const cycleClose = internalMutation({
  args: { periodKey: v.optional(v.string()) },
  returns: v.null(),
  handler: async (ctx, args) => {
    const periodKey = args.periodKey ?? previousPeriodKey(Date.now());
    if (periodKey >= getPeriodKey(Date.now())) {
      throw new ConvexError(`Refusing to close the open/future cycle ${periodKey}`);
    }

    const orgs = await ctx.db.query('organizations').collect();
    let drafted = 0;
    for (const org of orgs) {
      if (!org.workosOrgId) continue;

      // Idempotent re-runs never touch an existing invoice. A CANCELLED one
      // doesn't count: voiding the cycle's draft used to block that period
      // from ever being drafted again.
      const existing = await liveMeteredInvoice(ctx, org.workosOrgId, periodKey);
      if (existing) continue;

      const usageRow = await ctx.db
        .query('platformUsageStats')
        .withIndex('by_org_period', (q) =>
          q.eq('workosOrgId', org.workosOrgId!).eq('periodKey', periodKey),
        )
        .first();
      const loadsWritten = usageRow?.loadsWritten ?? 0;

      const { lines, ratePerLoad } = computeLines(org, periodKey, loadsWritten);
      if (lines.length === 0) continue; // zero-line cycle: no invoice (spec D-B2)

      const now = Date.now();
      const subtotal = money(lines.reduce((s, l) => s + l.amount, 0));
      await ctx.db.insert('platformInvoices', {
        workosOrgId: org.workosOrgId,
        periodKey,
        kind: 'metered',
        invoiceNumber: platformInvoiceNumber(org.workosOrgId, periodKey),
        loadsWritten,
        ratePerLoad,
        lines,
        adjustments: [],
        subtotal,
        total: subtotal, // tax snapshots at ISSUE, not draft
        payments: [],
        amountPaid: 0,
        status: 'draft',
        createdAt: now,
        updatedAt: now,
      });
      drafted++;
    }
    console.log(`Cycle close ${periodKey}: drafted ${drafted} invoices`);
    return null;
  },
});

/**
 * One-time backfill: closed cycles that predate the ledger become 'paid'
 * rows frozen at today's resolved rate — so the tenant page has exactly one
 * code path and history stops re-pricing when rates change. Run from the
 * CLI after deploy; idempotent.
 */
export const backfillHistoricalPaidInvoices = internalMutation({
  args: {},
  returns: v.null(),
  handler: async (ctx) => {
    const currentPeriod = getPeriodKey(Date.now());
    const orgs = await ctx.db.query('organizations').collect();
    let created = 0;

    for (const org of orgs) {
      if (!org.workosOrgId) continue;
      const usageRows = await ctx.db
        .query('platformUsageStats')
        .withIndex('by_org', (q) => q.eq('workosOrgId', org.workosOrgId!))
        .collect();

      for (const row of usageRows) {
        if (row.periodKey >= currentPeriod || row.loadsWritten === 0) continue;
        const existing = await liveMeteredInvoice(ctx, org.workosOrgId, row.periodKey);
        if (existing) continue;

        const { lines, ratePerLoad } = computeLines(org, row.periodKey, row.loadsWritten);
        if (lines.length === 0) continue;
        const subtotal = money(lines.reduce((s, l) => s + l.amount, 0));
        const [y, m] = row.periodKey.split('-').map(Number);
        const issuedAt = Date.UTC(y, m, 1); // 1st of following month (legacy display dates)
        const now = Date.now();
        await ctx.db.insert('platformInvoices', {
          workosOrgId: org.workosOrgId,
          periodKey: row.periodKey,
          kind: 'metered',
          invoiceNumber: platformInvoiceNumber(org.workosOrgId, row.periodKey),
          loadsWritten: row.loadsWritten,
          ratePerLoad,
          lines,
          adjustments: [],
          subtotal,
          total: subtotal,
          payments: [],
          amountPaid: subtotal,
          status: 'paid',
          issuedAt,
          dueAt: Date.UTC(y, m, 15),
          paidAt: Date.UTC(y, m, 3),
          backfilled: true,
          createdAt: now,
          updatedAt: now,
        });
        created++;
      }
    }
    console.log(`Invoice backfill: created ${created} historical paid invoices`);
    return null;
  },
});

// ─── Staff lifecycle mutations ───────────────────────────────────────────

export const issueInvoice = mutation({
  args: {
    id: v.id('platformInvoices'),
    // Recording work that was invoiced (or should have been) in the past:
    // without this, an invoice for June work entered in August is stamped
    // August and never looks overdue, so aging and history both lie. The
    // audit row still carries the real wall-clock time of the action.
    issuedAt: v.optional(v.number()),
    dueAt: v.optional(v.number()),
  },
  returns: v.null(),
  handler: async (ctx, args) => {
    const staff = await requirePlatformStaff(ctx);
    const invoice = await ctx.db.get(args.id);
    if (!invoice) throw new ConvexError('Invoice not found');
    if (invoice.status !== 'draft') throw new ConvexError('Only drafts can be issued');
    if (args.issuedAt !== undefined && args.issuedAt > Date.now()) {
      throw new ConvexError('An invoice cannot be issued with a future date');
    }
    if (args.dueAt !== undefined && args.issuedAt !== undefined && args.dueAt < args.issuedAt) {
      throw new ConvexError('Due date must be on or after the issue date');
    }

    const org = await ctx.db
      .query('organizations')
      .withIndex('by_organization', (q) => q.eq('workosOrgId', invoice.workosOrgId))
      .unique();

    const now = Date.now();
    const issuedAt = args.issuedAt ?? now;
    const backdated = issuedAt < now - 60_000;
    const subtotal = sumSubtotal(invoice);
    const taxRatePercent = org?.taxRatePercent;
    const taxAmount =
      taxRatePercent != null ? money(subtotal * (taxRatePercent / 100)) : undefined;
    const total = money(subtotal + (taxAmount ?? 0));

    // Carry-forward: apply any available org credit to the balance NOW, as a
    // payment rather than a line. A credit from a prior overpayment must not
    // shrink this cycle's taxable subtotal, and the lines are about to freeze.
    // Capped at `total`, so a credit never makes an invoice negative — the
    // unused remainder stays available for the next cycle.
    const { applied: creditApplied } =
      total > 0
        ? await consumeCredits(
            ctx,
            invoice.workosOrgId,
            total,
            { _id: args.id, invoiceNumber: invoice.invoiceNumber, issuedAt },
            issuedAt, // credit applied AT issue, by definition
          )
        : { applied: 0 };

    const payments = [...invoice.payments];
    if (creditApplied > 0) {
      payments.push({
        id: nextPaymentId(invoice),
        amount: creditApplied,
        method: 'credit' as const,
        reference: 'org credit',
        recordedByEmail: staff.email,
        receivedAt: issuedAt,
      });
    }
    const amountPaid = sumPayments(payments);
    const paidInFull = amountPaid >= total && total > 0;

    await ctx.db.patch(args.id, {
      subtotal,
      taxRatePercent,
      taxJurisdiction: org?.taxJurisdiction,
      taxAmount,
      total,
      payments,
      amountPaid,
      status: paidInFull ? 'paid' : amountPaid > 0 ? 'partially_paid' : 'issued',
      ...(paidInFull ? { paidAt: issuedAt } : {}),
      issuedAt,
      // Terms run from the issue date, so a back-dated invoice gets a
      // back-dated due date and lands in the right aging bucket on its own.
      dueAt: args.dueAt ?? computeDueAt(issuedAt, org?.billingTerms),
      updatedAt: now,
    });
    await logPlatformAudit(ctx, {
      actorEmail: staff.email,
      action: 'invoice_issued',
      targetOrgId: invoice.workosOrgId,
      targetTable: 'platformInvoices',
      targetId: args.id,
      after: JSON.stringify({
        invoiceNumber: invoice.invoiceNumber,
        total,
        creditApplied: creditApplied || undefined,
        // Recorded explicitly so a back-dated issue can never be mistaken for
        // one entered on the day.
        issuedAt,
        backdated: backdated || undefined,
      }),
    });
    return null;
  },
});

export const markSent = mutation({
  args: { id: v.id('platformInvoices') },
  returns: v.null(),
  handler: async (ctx, args) => {
    const staff = await requirePlatformStaff(ctx);
    const invoice = await ctx.db.get(args.id);
    if (!invoice) throw new ConvexError('Invoice not found');
    if (invoice.status !== 'issued' && invoice.status !== 'partially_paid') {
      throw new ConvexError('Only issued invoices can be marked sent');
    }
    const now = Date.now();
    // sentAt is recorded independently of status: a partially-paid invoice
    // stays 'partially_paid', and a later reversal needs to know the customer
    // already received it (statusFromLedger reads this).
    await ctx.db.patch(args.id, {
      status: invoice.status === 'issued' ? 'sent' : invoice.status,
      sentAt: now,
      updatedAt: now,
    });
    await logPlatformAudit(ctx, {
      actorEmail: staff.email,
      action: 'invoice_sent',
      targetOrgId: invoice.workosOrgId,
      targetTable: 'platformInvoices',
      targetId: args.id,
    });
    return null;
  },
});

export const recordPayment = mutation({
  args: {
    id: v.id('platformInvoices'),
    amount: v.number(),
    method: v.union(
      v.literal('ach'),
      v.literal('check'),
      v.literal('wire'),
      v.literal('other'),
    ),
    reference: v.optional(v.string()),
    receivedAt: v.optional(v.number()), // back-date to the real deposit date
  },
  returns: v.null(),
  handler: async (ctx, args) => {
    const staff = await requirePlatformStaff(ctx);
    const invoice = await ctx.db.get(args.id);
    if (!invoice) throw new ConvexError('Invoice not found');
    if (!(OPEN_STATUSES as readonly string[]).includes(invoice.status)) {
      throw new ConvexError(`Cannot record a payment on a ${invoice.status} invoice`);
    }
    if (!(args.amount > 0)) throw new ConvexError('Payment amount must be positive');

    const now = Date.now();
    const paymentId = nextPaymentId(invoice);
    const payments = [
      ...invoice.payments,
      {
        id: paymentId,
        amount: money(args.amount),
        method: args.method,
        reference: args.reference,
        recordedByEmail: staff.email,
        receivedAt: args.receivedAt ?? now,
      },
    ];
    const amountPaid = sumPayments(payments);
    const paidInFull = amountPaid >= invoice.total;

    // Overpayment doesn't vanish: the excess becomes an org credit, carried to
    // the next cycle by issueInvoice. Tied to this payment id so a reversal can
    // claw it back.
    const overpaid = money(amountPaid - invoice.total);
    let creditId: string | undefined;
    if (overpaid > 0) {
      creditId = await issueCredit(ctx, {
        workosOrgId: invoice.workosOrgId,
        amount: overpaid,
        source: 'overpayment',
        reason: `Overpayment on ${invoice.invoiceNumber}`,
        createdByEmail: staff.email,
        sourceInvoiceId: args.id,
        sourcePaymentId: paymentId,
        // The overpayment arrived with the payment, not when it was keyed.
        createdAt: args.receivedAt ?? now,
      });
    }

    await ctx.db.patch(args.id, {
      payments,
      amountPaid,
      status: paidInFull ? 'paid' : 'partially_paid',
      ...(paidInFull ? { paidAt: args.receivedAt ?? now } : {}),
      updatedAt: now,
    });
    await logPlatformAudit(ctx, {
      actorEmail: staff.email,
      action: 'invoice_payment_recorded',
      targetOrgId: invoice.workosOrgId,
      targetTable: 'platformInvoices',
      targetId: args.id,
      metadata: JSON.stringify({
        paymentId,
        amount: money(args.amount),
        method: args.method,
        reference: args.reference,
        paidInFull,
        creditIssued: overpaid > 0 ? overpaid : undefined,
        creditId,
      }),
    });
    return null;
  },
});

/**
 * Fill in a payment that was never written down.
 *
 * An invoice can be marked paid with an empty payment ledger — the historical
 * backfill does exactly that (`payments: []`, `amountPaid: subtotal`), and so
 * does any row settled before the console could record payments. The money is
 * accounted for, but *how* and *when* it arrived is missing, so it can't be
 * reconciled against a bank statement and can't be reversed.
 *
 * This documents that money without moving any: it only ever fills the gap
 * between `amountPaid` (what the invoice claims) and the sum of the payment
 * entries (what it can show), so it cannot invent a payment or change what is
 * owed. Adding NEW money is `recordPayment`, which needs an open invoice.
 */
export const documentPayment = mutation({
  args: {
    id: v.id('platformInvoices'),
    amount: v.number(),
    method: v.union(
      v.literal('ach'),
      v.literal('check'),
      v.literal('wire'),
      v.literal('credit'),
      v.literal('other'),
    ),
    reference: v.optional(v.string()),
    receivedAt: v.optional(v.number()),
    reason: v.string(),
  },
  returns: v.null(),
  handler: async (ctx, args) => {
    const staff = await requirePlatformStaff(ctx);
    const invoice = await ctx.db.get(args.id);
    if (!invoice) throw new ConvexError('Invoice not found');
    if (invoice.status === 'draft') {
      throw new ConvexError('A draft has nothing paid against it yet');
    }

    const documented = sumPayments(invoice.payments);
    const undocumented = money(invoice.amountPaid - documented);
    if (undocumented <= 0) {
      throw new ConvexError(
        `${invoice.invoiceNumber} already has a full payment record — use Record payment to add money, or Reverse to correct an entry.`,
      );
    }
    if (!(args.amount > 0)) throw new ConvexError('Amount must be positive');
    if (money(args.amount) > undocumented) {
      throw new ConvexError(
        `Only ${undocumented.toFixed(2)} is undocumented on this invoice. Documenting more would change what was paid — use Record payment for new money.`,
      );
    }

    const now = Date.now();
    const payments = [
      ...invoice.payments,
      {
        id: nextPaymentId(invoice),
        amount: money(args.amount),
        method: args.method,
        reference: args.reference,
        recordedByEmail: staff.email,
        receivedAt: args.receivedAt ?? invoice.paidAt ?? invoice.issuedAt ?? now,
      },
    ];
    // amountPaid deliberately NOT recomputed: the invoice already claimed this
    // money. This writes the record, not the amount.
    await ctx.db.patch(args.id, { payments, updatedAt: now });

    await logPlatformAudit(ctx, {
      actorEmail: staff.email,
      action: 'invoice_payment_recorded',
      targetOrgId: invoice.workosOrgId,
      targetTable: 'platformInvoices',
      targetId: args.id,
      reason: args.reason,
      metadata: JSON.stringify({
        documenting: true,
        amount: money(args.amount),
        method: args.method,
        reference: args.reference,
        stillUndocumented: money(undocumented - args.amount) || undefined,
      }),
    });
    return null;
  },
});

/**
 * Record ONE payment against an organization and let it settle their open
 * invoices oldest-first.
 *
 * A customer catching up on arrears sends one transfer covering several
 * months. Recording that per-invoice by hand means splitting the amount
 * yourself and getting the arithmetic right across half a dozen rows — easy to
 * fumble, and the parts only tie back together if you remember to reuse the
 * reference. This does the split, applies the same date and reference to every
 * part, and posts any excess as account credit exactly as a single-invoice
 * overpayment would.
 *
 * Oldest-first by due date is the standard application order and the one a
 * customer will assume: it clears the most overdue balance first, which is also
 * what makes the aging report settle correctly afterwards.
 *
 * Cash only. Applying existing account credit stays a separate, deliberate act
 * (`applyCreditToInvoice`) — sweeping it in automatically would spend the
 * customer's balance without anyone choosing to.
 */
export const allocatePayment = mutation({
  args: {
    workosOrgId: v.string(),
    amount: v.number(),
    method: v.union(
      v.literal('ach'),
      v.literal('check'),
      v.literal('wire'),
      v.literal('other'),
    ),
    reference: v.optional(v.string()),
    receivedAt: v.optional(v.number()),
    reason: v.string(),
  },
  returns: v.object({
    applied: v.array(
      v.object({
        invoiceNumber: v.string(),
        periodKey: v.string(),
        amount: v.number(),
        status: v.string(),
      }),
    ),
    creditPosted: v.number(),
  }),
  handler: async (ctx, args) => {
    const staff = await requirePlatformStaff(ctx);
    if (!(args.amount > 0)) throw new ConvexError('Payment amount must be positive');

    const all = await ctx.db
      .query('platformInvoices')
      .withIndex('by_org_period', (q) => q.eq('workosOrgId', args.workosOrgId))
      .collect();

    const receivedAt = args.receivedAt ?? Date.now();
    const reference = args.reference?.trim() || undefined;

    // Guard against a double submission turning one transfer into two. The
    // same reference on the same day for the same money is far more likely to
    // be a repeated click than a genuine second payment.
    if (reference) {
      const duplicate = all.some((inv) =>
        inv.payments.some(
          (p) => p.reference === reference && p.receivedAt === receivedAt && p.amount > 0,
        ),
      );
      if (duplicate) {
        throw new ConvexError(
          `A payment referenced "${reference}" is already recorded for that date. If this really is a second transfer, give it a distinct reference.`,
        );
      }
    }

    // Oldest obligation first: due date, falling back to issue date and then
    // the cycle itself for rows that predate those fields.
    const open = all
      .filter((inv) => (OPEN_STATUSES as readonly string[]).includes(inv.status))
      .filter((inv) => money(inv.total - inv.amountPaid) > 0)
      .sort(
        (a, b) =>
          (a.dueAt ?? a.issuedAt ?? 0) - (b.dueAt ?? b.issuedAt ?? 0) ||
          a.periodKey.localeCompare(b.periodKey),
      );

    let remaining = money(args.amount);
    const applied: { invoiceNumber: string; periodKey: string; amount: number; status: string }[] =
      [];

    for (const invoice of open) {
      if (remaining <= 0) break;
      const balance = money(invoice.total - invoice.amountPaid);
      const part = money(Math.min(balance, remaining));
      if (part <= 0) continue;

      const payments = [
        ...invoice.payments,
        {
          id: nextPaymentId(invoice),
          amount: part,
          method: args.method,
          reference,
          recordedByEmail: staff.email,
          receivedAt,
        },
      ];
      const amountPaid = sumPayments(payments);
      const paidInFull = amountPaid >= invoice.total;
      const status = paidInFull ? ('paid' as const) : ('partially_paid' as const);

      await ctx.db.patch(invoice._id, {
        payments,
        amountPaid,
        status,
        ...(paidInFull ? { paidAt: receivedAt } : {}),
        updatedAt: Date.now(),
      });
      // One audit row per invoice: the per-invoice history has to stand on its
      // own, and the shared reference is what ties the parts back together.
      await logPlatformAudit(ctx, {
        actorEmail: staff.email,
        action: 'invoice_payment_recorded',
        targetOrgId: args.workosOrgId,
        targetTable: 'platformInvoices',
        targetId: invoice._id,
        reason: args.reason,
        metadata: JSON.stringify({
          allocated: true,
          amount: part,
          method: args.method,
          reference,
          ofTotal: money(args.amount),
        }),
      });

      applied.push({
        invoiceNumber: invoice.invoiceNumber,
        periodKey: invoice.periodKey,
        amount: part,
        status,
      });
      remaining = money(remaining - part);
    }

    // Anything left over is money paid ahead — same treatment as overpaying a
    // single invoice: it becomes credit and lands on the next invoice issued.
    let creditPosted = 0;
    if (remaining > 0) {
      creditPosted = remaining;
      await issueCredit(ctx, {
        workosOrgId: args.workosOrgId,
        amount: remaining,
        source: 'overpayment',
        reason: reference
          ? `Paid ahead on ${reference}: ${args.reason}`
          : `Paid ahead: ${args.reason}`,
        createdByEmail: staff.email,
        createdAt: receivedAt,
      });
    }

    return { applied, creditPosted };
  },
});

/**
 * Withdraw a claim of payment that has no evidence behind it.
 *
 * The mirror of `documentPayment`, over the same gap and with the same safety:
 * that one says "this money did arrive, here is the record", this one says "it
 * never arrived, drop the claim". Both touch ONLY the undocumented portion, so
 * neither can alter a payment that was actually recorded.
 *
 * The case this exists for: `backfillHistoricalPaidInvoices` marks every
 * historical cycle `paid` with an empty ledger. For cycles that genuinely were
 * settled that is a reasonable shortcut; for cycles that were never paid it
 * fabricates a settlement, hides a real receivable, and there was no way to
 * take it back.
 */
export const clearUnevidencedPayment = mutation({
  args: { id: v.id('platformInvoices'), reason: v.string() },
  returns: v.null(),
  handler: async (ctx, args) => {
    const staff = await requireRecentStaffAuth(ctx);
    if (!args.reason.trim()) throw new ConvexError('A reason is required');
    const invoice = await ctx.db.get(args.id);
    if (!invoice) throw new ConvexError('Invoice not found');

    const documented = sumPayments(invoice.payments);
    const undocumented = money(invoice.amountPaid - documented);
    if (undocumented <= 0) {
      throw new ConvexError(
        `${invoice.invoiceNumber} has a full payment record — reverse the entry instead, so the correction stays visible.`,
      );
    }

    const now = Date.now();
    const status = statusFromLedger(invoice, documented);
    await ctx.db.patch(args.id, {
      amountPaid: documented,
      status,
      ...(documented < invoice.total ? { paidAt: undefined } : {}),
      updatedAt: now,
    });
    await logPlatformAudit(ctx, {
      actorEmail: staff.email,
      action: 'invoice_payment_claim_cleared',
      targetOrgId: invoice.workosOrgId,
      targetTable: 'platformInvoices',
      targetId: args.id,
      before: JSON.stringify({ amountPaid: invoice.amountPaid, status: invoice.status }),
      after: JSON.stringify({ amountPaid: documented, status }),
      reason: args.reason,
    });
    return null;
  },
});

/**
 * Withdraw every unevidenced paid claim for one organization.
 *
 * The backfill marks a whole history paid in one go, so undoing it one invoice
 * at a time is a dozen identical decisions with a dozen chances to mistype.
 * This applies the same rule as the single version to every row that has one:
 * only the undocumented portion, never a payment that was actually recorded.
 */
export const clearUnevidencedPayments = mutation({
  args: { workosOrgId: v.string(), reason: v.string() },
  returns: v.object({
    cleared: v.array(
      v.object({ invoiceNumber: v.string(), periodKey: v.string(), restored: v.number() }),
    ),
    totalRestored: v.number(),
  }),
  handler: async (ctx, args) => {
    const staff = await requireRecentStaffAuth(ctx);
    if (!args.reason.trim()) throw new ConvexError('A reason is required');

    const rows = await ctx.db
      .query('platformInvoices')
      .withIndex('by_org_period', (q) => q.eq('workosOrgId', args.workosOrgId))
      .collect();

    const cleared: { invoiceNumber: string; periodKey: string; restored: number }[] = [];
    let totalRestored = 0;

    for (const invoice of rows) {
      if (invoice.status === 'draft' || invoice.status === 'void') continue;
      const documented = sumPayments(invoice.payments);
      const undocumented = money(invoice.amountPaid - documented);
      if (undocumented <= 0) continue;

      const status = statusFromLedger(invoice, documented);
      await ctx.db.patch(invoice._id, {
        amountPaid: documented,
        status,
        ...(documented < invoice.total ? { paidAt: undefined } : {}),
        updatedAt: Date.now(),
      });
      await logPlatformAudit(ctx, {
        actorEmail: staff.email,
        action: 'invoice_payment_claim_cleared',
        targetOrgId: args.workosOrgId,
        targetTable: 'platformInvoices',
        targetId: invoice._id,
        before: JSON.stringify({ amountPaid: invoice.amountPaid, status: invoice.status }),
        after: JSON.stringify({ amountPaid: documented, status }),
        reason: args.reason,
      });
      cleared.push({
        invoiceNumber: invoice.invoiceNumber,
        periodKey: invoice.periodKey,
        restored: undocumented,
      });
      totalRestored = money(totalRestored + undocumented);
    }

    cleared.sort((a, b) => a.periodKey.localeCompare(b.periodKey));
    return { cleared, totalRestored };
  },
});

/**
 * Spend an organization's account credit across its open invoices,
 * oldest-first — the credit counterpart of `allocatePayment`.
 *
 * Credit is consumed at issue time, so a balance that accumulated while
 * invoices sat open (or arrived before those invoices were corrected) has to
 * be placed by hand. Doing that per invoice is fine for one; for a year of
 * arrears it is the same tedium as the single-invoice payment split.
 *
 * Explicit by design: `allocatePayment` will never sweep credit in on its own,
 * because spending a customer's balance should be somebody's decision.
 */
export const allocateCredit = mutation({
  args: {
    workosOrgId: v.string(),
    // Omit to spend as much as the open invoices can absorb.
    amount: v.optional(v.number()),
    // Override the derived application date (rarely needed).
    appliedAt: v.optional(v.number()),
    reason: v.string(),
  },
  returns: v.object({
    applied: v.array(
      v.object({
        invoiceNumber: v.string(),
        periodKey: v.string(),
        amount: v.number(),
        status: v.string(),
      }),
    ),
    creditRemaining: v.number(),
    stillOwed: v.number(),
  }),
  handler: async (ctx, args) => {
    const staff = await requirePlatformStaff(ctx);
    if (args.amount !== undefined && !(args.amount > 0)) {
      throw new ConvexError('Amount must be positive');
    }

    const all = await ctx.db
      .query('platformInvoices')
      .withIndex('by_org_period', (q) => q.eq('workosOrgId', args.workosOrgId))
      .collect();
    const open = all
      .filter((inv) => (OPEN_STATUSES as readonly string[]).includes(inv.status))
      .filter((inv) => money(inv.total - inv.amountPaid) > 0)
      .sort(
        (a, b) =>
          (a.dueAt ?? a.issuedAt ?? 0) - (b.dueAt ?? b.issuedAt ?? 0) ||
          a.periodKey.localeCompare(b.periodKey),
      );
    if (open.length === 0) throw new ConvexError('No open invoices to apply credit to');

    let budget = args.amount !== undefined ? money(args.amount) : Number.POSITIVE_INFINITY;
    const applied: { invoiceNumber: string; periodKey: string; amount: number; status: string }[] =
      [];
    const now = Date.now();

    for (const invoice of open) {
      if (budget <= 0) break;
      const balance = money(invoice.total - invoice.amountPaid);
      const want = money(Math.min(balance, budget === Number.POSITIVE_INFINITY ? balance : budget));
      if (want <= 0) continue;

      const { applied: part, appliedAt } = await consumeCredits(
        ctx,
        args.workosOrgId,
        want,
        { _id: invoice._id, invoiceNumber: invoice.invoiceNumber, issuedAt: invoice.issuedAt },
        args.appliedAt,
      );
      if (part <= 0) break; // credit exhausted

      const payments = [
        ...invoice.payments,
        {
          id: nextPaymentId(invoice),
          amount: part,
          method: 'credit' as const,
          reference: 'account credit',
          recordedByEmail: staff.email,
          receivedAt: appliedAt,
        },
      ];
      const amountPaid = sumPayments(payments);
      const paidInFull = amountPaid >= invoice.total;
      const status = paidInFull ? ('paid' as const) : ('partially_paid' as const);

      await ctx.db.patch(invoice._id, {
        payments,
        amountPaid,
        status,
        ...(paidInFull ? { paidAt: appliedAt } : {}),
        updatedAt: now,
      });
      await logPlatformAudit(ctx, {
        actorEmail: staff.email,
        action: 'credit_applied',
        targetOrgId: args.workosOrgId,
        targetTable: 'platformInvoices',
        targetId: invoice._id,
        after: JSON.stringify({ applied: part, balanceBefore: balance }),
        reason: args.reason,
      });

      applied.push({
        invoiceNumber: invoice.invoiceNumber,
        periodKey: invoice.periodKey,
        amount: part,
        status,
      });
      if (budget !== Number.POSITIVE_INFINITY) budget = money(budget - part);
    }

    // What the account looks like afterwards, so the operator doesn't have to
    // work it out from three separate figures.
    const after = await ctx.db
      .query('platformInvoices')
      .withIndex('by_org_period', (q) => q.eq('workosOrgId', args.workosOrgId))
      .collect();
    const stillOwed = money(
      after
        .filter((inv) => (OPEN_STATUSES as readonly string[]).includes(inv.status))
        .reduce((s, inv) => s + Math.max(0, money(inv.total - inv.amountPaid)), 0),
    );
    const remainingCredits = await ctx.db
      .query('platformCredits')
      .withIndex('by_org_status', (q) =>
        q.eq('workosOrgId', args.workosOrgId).eq('status', 'available'),
      )
      .collect();
    const creditRemaining = money(remainingCredits.reduce((s, c) => s + c.remaining, 0));

    return { applied, creditRemaining, stillOwed };
  },
});

/**
 * Put existing account credit against an invoice that is ALREADY issued.
 *
 * `issueInvoice` consumes credit at issue time, which covers the normal path —
 * but it leaves credit stranded when the credit arrives after the invoice did.
 * That is precisely the overdue case: months of unpaid invoices sitting open
 * while a customer's overpayment sits unusable beside them, with the aging
 * report overstating what is actually owed.
 *
 * Capped at the invoice's balance, so a credit never overpays and the unused
 * remainder stays on the account.
 */
export const applyCreditToInvoice = mutation({
  args: {
    id: v.id('platformInvoices'),
    // Omit to apply as much as the balance allows.
    amount: v.optional(v.number()),
    // Override the derived application date (rarely needed).
    appliedAt: v.optional(v.number()),
    reason: v.string(),
  },
  returns: v.null(),
  handler: async (ctx, args) => {
    const staff = await requirePlatformStaff(ctx);
    const invoice = await ctx.db.get(args.id);
    if (!invoice) throw new ConvexError('Invoice not found');
    if (!(OPEN_STATUSES as readonly string[]).includes(invoice.status)) {
      throw new ConvexError(`Cannot apply credit to a ${invoice.status.replace('_', ' ')} invoice`);
    }
    const balance = money(invoice.total - invoice.amountPaid);
    if (balance <= 0) throw new ConvexError('Nothing outstanding on this invoice');

    const cap = args.amount !== undefined ? money(Math.min(args.amount, balance)) : balance;
    if (!(cap > 0)) throw new ConvexError('Amount must be positive');

    const { applied, appliedAt } = await consumeCredits(
      ctx,
      invoice.workosOrgId,
      cap,
      { _id: args.id, invoiceNumber: invoice.invoiceNumber, issuedAt: invoice.issuedAt },
      args.appliedAt,
    );
    if (applied <= 0) {
      throw new ConvexError('This organization has no available credit');
    }

    const now = Date.now();
    const payments = [
      ...invoice.payments,
      {
        id: nextPaymentId(invoice),
        amount: applied,
        method: 'credit' as const,
        reference: 'account credit',
        recordedByEmail: staff.email,
        // Dated when the credit could first have settled this invoice, not
        // when someone got round to clicking.
        receivedAt: appliedAt,
      },
    ];
    const amountPaid = sumPayments(payments);
    await ctx.db.patch(args.id, {
      payments,
      amountPaid,
      status: statusFromLedger(invoice, amountPaid),
      ...(amountPaid >= invoice.total ? { paidAt: appliedAt } : {}),
      updatedAt: now,
    });
    await logPlatformAudit(ctx, {
      actorEmail: staff.email,
      action: 'credit_applied',
      targetOrgId: invoice.workosOrgId,
      targetTable: 'platformInvoices',
      targetId: args.id,
      after: JSON.stringify({ applied, balanceBefore: balance, appliedAt }),
      reason: args.reason,
    });
    return null;
  },
});

/**
 * Invoices whose `amountPaid` doesn't match their payment entries — money the
 * ledger asserts but cannot evidence. Backfilled rows are the usual source.
 */
export const paymentLedgerGaps = query({
  args: {},
  handler: async (ctx) => {
    await requirePlatformStaff(ctx);
    const rows = (
      await Promise.all(
        (['paid', 'partially_paid', 'written_off', 'issued', 'sent'] as const).map((status) =>
          ctx.db
            .query('platformInvoices')
            .withIndex('by_status', (q) => q.eq('status', status))
            .take(300),
        ),
      )
    ).flat();

    return rows
      .map((r) => ({
        _id: r._id,
        invoiceNumber: r.invoiceNumber,
        workosOrgId: r.workosOrgId,
        periodKey: r.periodKey,
        kind: r.kind ?? 'metered',
        status: r.status,
        total: r.total,
        amountPaid: r.amountPaid,
        documented: sumPayments(r.payments),
        undocumented: money(r.amountPaid - sumPayments(r.payments)),
        backfilled: r.backfilled === true,
        paidAt: r.paidAt,
      }))
      .filter((r) => r.undocumented > 0)
      .sort((a, b) => b.undocumented - a.undocumented);
  },
});

/**
 * Correct a wrong payment WITHOUT editing history: appends a negative entry
 * referencing the original, so the invoice shows both the error and the fix.
 * `amountPaid` and status are recomputed from the whole ledger, which walks a
 * 'paid' invoice back down to 'partially_paid'/'sent'/'issued' correctly.
 *
 * Covers the real cases: a typo'd amount, a payment recorded against the wrong
 * invoice, a bounced check, an ACH return.
 *
 * Note: this moves OUR ledger only. A reversal on a Stripe-collected payment
 * does not refund the customer — that's a Stripe-side refund, and the nightly
 * reconcile will flag the disagreement until both sides match.
 */
export const reversePayment = mutation({
  args: {
    id: v.id('platformInvoices'),
    paymentIndex: v.number(), // index into the append-only payments array
    reason: v.string(),
  },
  returns: v.null(),
  handler: async (ctx, args) => {
    const staff = await requireRecentStaffAuth(ctx);
    if (!args.reason.trim()) throw new ConvexError('A reason is required');
    const invoice = await ctx.db.get(args.id);
    if (!invoice) throw new ConvexError('Invoice not found');

    const target = invoice.payments[args.paymentIndex];
    if (!target) throw new ConvexError('Payment not found');
    if (target.amount < 0) throw new ConvexError('That entry is itself a reversal');

    const key = paymentKey(target, args.paymentIndex);
    if (invoice.payments.some((p) => p.reversalOfId === key)) {
      return null; // already reversed — idempotent on double-click
    }

    // A credit created by this payment's overpayment must not survive it. If
    // that credit has already been spent on another invoice, reversing here
    // would conjure money — refuse and make the operator unwind the other side.
    if (target.id) {
      const sourced = await ctx.db
        .query('platformCredits')
        .withIndex('by_source_payment', (q) => q.eq('sourcePaymentId', target.id))
        .collect();
      for (const credit of sourced) {
        if (credit.status === 'void') continue;
        if (credit.applications.length > 0) {
          throw new ConvexError(
            `The overpayment credit from this payment ($${credit.amount.toFixed(2)}) has already been applied to ${credit.applications[0].invoiceNumber}. Void or adjust that invoice first, then reverse this payment.`,
          );
        }
        await ctx.db.patch(credit._id, {
          status: 'void',
          remaining: 0,
          voidedAt: Date.now(),
          voidReason: `Source payment reversed: ${args.reason}`,
          updatedAt: Date.now(),
        });
      }
    }

    const now = Date.now();
    const payments = [
      ...invoice.payments,
      {
        id: nextPaymentId(invoice),
        amount: money(-target.amount),
        method: target.method,
        reference: target.reference,
        recordedByEmail: staff.email,
        receivedAt: now,
        reversalOfId: key,
        reversalReason: args.reason,
      },
    ];
    const amountPaid = sumPayments(payments);

    await ctx.db.patch(args.id, {
      payments,
      amountPaid,
      status: statusFromLedger(invoice, amountPaid),
      // Clearing paidAt matters: aging and the tenant page both read it.
      ...(amountPaid < invoice.total ? { paidAt: undefined } : {}),
      updatedAt: now,
    });
    await logPlatformAudit(ctx, {
      actorEmail: staff.email,
      action: 'invoice_payment_reversed',
      targetOrgId: invoice.workosOrgId,
      targetTable: 'platformInvoices',
      targetId: args.id,
      before: JSON.stringify({ amountPaid: invoice.amountPaid, status: invoice.status }),
      after: JSON.stringify({ amountPaid, reversed: money(target.amount) }),
      reason: args.reason,
    });
    return null;
  },
});

/**
 * Uncollectible debt as an explicit decision rather than an invoice that sits
 * open forever. The balance stays visible on the row — a write-off records
 * that we stopped chasing it, not that it was paid.
 */
export const writeOffInvoice = mutation({
  args: { id: v.id('platformInvoices'), reason: v.string() },
  returns: v.null(),
  handler: async (ctx, args) => {
    const staff = await requireRecentStaffAuth(ctx);
    if (!args.reason.trim()) throw new ConvexError('A reason is required');
    const invoice = await ctx.db.get(args.id);
    if (!invoice) throw new ConvexError('Invoice not found');
    if (invoice.status === 'written_off') return null; // idempotent
    if (!(OPEN_STATUSES as readonly string[]).includes(invoice.status)) {
      throw new ConvexError(`Cannot write off a ${invoice.status} invoice`);
    }
    const balance = money(invoice.total - invoice.amountPaid);
    if (balance <= 0) throw new ConvexError('Nothing outstanding to write off');

    const now = Date.now();
    await ctx.db.patch(args.id, {
      status: 'written_off',
      writtenOffAt: now,
      writeOffReason: args.reason,
      updatedAt: now,
    });
    await logPlatformAudit(ctx, {
      actorEmail: staff.email,
      action: 'invoice_written_off',
      targetOrgId: invoice.workosOrgId,
      targetTable: 'platformInvoices',
      targetId: args.id,
      before: JSON.stringify({ status: invoice.status, balance }),
      after: JSON.stringify({ status: 'written_off' }),
      reason: args.reason,
    });
    await logSystemEvent(ctx, {
      severity: 'warn',
      source: 'billing',
      code: 'billing.written_off',
      message: `${invoice.invoiceNumber} written off ($${balance.toFixed(2)}): ${args.reason}`,
      orgId: invoice.workosOrgId,
      context: { invoiceNumber: invoice.invoiceNumber, balance },
    });
    return null;
  },
});

export const voidInvoice = mutation({
  args: { id: v.id('platformInvoices'), reason: v.string() },
  returns: v.null(),
  handler: async (ctx, args) => {
    const staff = await requireRecentStaffAuth(ctx);
    const invoice = await ctx.db.get(args.id);
    if (!invoice) throw new ConvexError('Invoice not found');
    if (invoice.status === 'void') return null; // idempotent
    // Void cancels a document that exists commercially. A draft doesn't yet —
    // keeping the two apart is what lets cycle close re-draft the period.
    if (invoice.status === 'draft') {
      throw new ConvexError('Drafts are not issued documents — delete the draft instead');
    }
    if (invoice.status === 'paid' && invoice.payments.some((p) => p.method !== 'credit')) {
      throw new ConvexError('Paid invoices cannot be voided — use a credit on the next cycle');
    }
    // Cash received must be reversed first, so the ledger explains where the
    // money went. Credit applications are different: they're OUR bookkeeping,
    // and voiding gives them back to the customer below.
    if (invoice.payments.some((p) => p.method !== 'credit' && p.amount !== 0)) {
      const cashPaid = money(
        invoice.payments.filter((p) => p.method !== 'credit').reduce((s, p) => s + p.amount, 0),
      );
      if (cashPaid > 0) {
        throw new ConvexError(
          'Invoice has recorded payments — reverse those first (Detail → Reverse), then void',
        );
      }
    }

    // Give back any credit this invoice consumed; otherwise voiding would
    // silently destroy the customer's balance.
    const creditReleased = await releaseCreditsForInvoice(ctx, invoice.workosOrgId, args.id);

    // Returning the credit is itself a ledger movement, so it gets an entry
    // rather than a silent adjustment of the total — `amountPaid` must stay
    // equal to the sum of `payments` on every row, void ones included.
    const payments =
      creditReleased > 0
        ? [
            ...invoice.payments,
            {
              id: nextPaymentId(invoice),
              amount: money(-creditReleased),
              method: 'credit' as const,
              reference: 'credit returned on void',
              recordedByEmail: staff.email,
              receivedAt: Date.now(),
              reversalReason: args.reason,
            },
          ]
        : invoice.payments;

    await ctx.db.patch(args.id, {
      status: 'void',
      payments,
      amountPaid: sumPayments(payments),
      voidedAt: Date.now(),
      voidReason: args.reason,
      updatedAt: Date.now(),
    });
    await logPlatformAudit(ctx, {
      actorEmail: staff.email,
      action: 'invoice_voided',
      targetOrgId: invoice.workosOrgId,
      targetTable: 'platformInvoices',
      targetId: args.id,
      reason: args.reason,
      metadata: creditReleased > 0 ? JSON.stringify({ creditReleased }) : undefined,
    });
    return null;
  },
});

export const addAdjustment = mutation({
  args: {
    id: v.id('platformInvoices'),
    label: v.string(),
    amountDelta: v.number(),
    reason: v.string(),
  },
  returns: v.null(),
  handler: async (ctx, args) => {
    const staff = await requirePlatformStaff(ctx);
    const invoice = await ctx.db.get(args.id);
    if (!invoice) throw new ConvexError('Invoice not found');
    if (invoice.status !== 'draft') {
      throw new ConvexError(
        'Adjustments only apply to drafts — post-issue corrections ride the NEXT cycle (spec §4)',
      );
    }
    const adjustments = [
      ...invoice.adjustments,
      {
        label: args.label.trim(),
        amountDelta: money(args.amountDelta),
        reason: args.reason,
        addedByEmail: staff.email,
        addedAt: Date.now(),
      },
    ];
    const subtotal = sumSubtotal({ lines: invoice.lines, adjustments });
    await ctx.db.patch(args.id, {
      adjustments,
      subtotal,
      total: subtotal, // tax recomputes at issue
      updatedAt: Date.now(),
    });
    await logPlatformAudit(ctx, {
      actorEmail: staff.email,
      action: 'invoice_adjustment_added',
      targetOrgId: invoice.workosOrgId,
      targetTable: 'platformInvoices',
      targetId: args.id,
      reason: args.reason,
      metadata: JSON.stringify({ label: args.label, amountDelta: args.amountDelta }),
    });
    return null;
  },
});

// ─── Draft editing ───────────────────────────────────────────────────────
//
// A draft is a WORKING document, not a commercial one: nothing has been sent,
// nothing is owed. So everything on it is editable except the metered count
// itself, which is only ever re-derived from `platformUsageStats` and never
// typed by hand. Once issued, all of this stops working — that's the
// immutability rule, and it is not relaxed here.

/** Fail unless the invoice is still a draft, with a message that says why. */
function assertDraft(invoice: Doc<'platformInvoices'>): void {
  if (invoice.status !== 'draft') {
    throw new ConvexError(
      `${invoice.invoiceNumber} is ${invoice.status.replace('_', ' ')} — issued invoices are frozen. Correct it with a credit or a next-cycle adjustment.`,
    );
  }
}

/** Recompute the money on a draft after its lines or adjustments changed. */
async function repriceDraft(
  ctx: MutationCtx,
  id: Doc<'platformInvoices'>['_id'],
  next: Pick<Doc<'platformInvoices'>, 'lines' | 'adjustments'> & { ratePerLoad?: number; loadsWritten?: number },
): Promise<number> {
  const subtotal = sumSubtotal(next);
  await ctx.db.patch(id, {
    lines: next.lines,
    adjustments: next.adjustments,
    ...(next.ratePerLoad !== undefined ? { ratePerLoad: next.ratePerLoad } : {}),
    ...(next.loadsWritten !== undefined ? { loadsWritten: next.loadsWritten } : {}),
    subtotal,
    total: subtotal, // tax is snapshotted at issue, never on a draft
    updatedAt: Date.now(),
  });
  return subtotal;
}

export const updateAdjustment = mutation({
  args: {
    id: v.id('platformInvoices'),
    index: v.number(),
    label: v.optional(v.string()),
    amountDelta: v.optional(v.number()),
    reason: v.string(),
  },
  returns: v.null(),
  handler: async (ctx, args) => {
    const staff = await requirePlatformStaff(ctx);
    const invoice = await ctx.db.get(args.id);
    if (!invoice) throw new ConvexError('Invoice not found');
    assertDraft(invoice);

    const existing = invoice.adjustments[args.index];
    if (!existing) throw new ConvexError('Adjustment not found');
    if (args.amountDelta !== undefined && !Number.isFinite(args.amountDelta)) {
      throw new ConvexError('Amount must be a number');
    }

    const adjustments = invoice.adjustments.map((a, i) =>
      i === args.index
        ? {
            ...a,
            label: args.label?.trim() || a.label,
            amountDelta: args.amountDelta !== undefined ? money(args.amountDelta) : a.amountDelta,
            reason: args.reason,
            addedByEmail: staff.email, // whoever last touched it owns it
            addedAt: Date.now(),
          }
        : a,
    );
    await repriceDraft(ctx, args.id, { lines: invoice.lines, adjustments });
    await logPlatformAudit(ctx, {
      actorEmail: staff.email,
      action: 'invoice_draft_edited',
      targetOrgId: invoice.workosOrgId,
      targetTable: 'platformInvoices',
      targetId: args.id,
      before: JSON.stringify(existing),
      after: JSON.stringify(adjustments[args.index]),
      reason: args.reason,
    });
    return null;
  },
});

export const removeAdjustment = mutation({
  args: { id: v.id('platformInvoices'), index: v.number(), reason: v.string() },
  returns: v.null(),
  handler: async (ctx, args) => {
    const staff = await requirePlatformStaff(ctx);
    const invoice = await ctx.db.get(args.id);
    if (!invoice) throw new ConvexError('Invoice not found');
    assertDraft(invoice);
    const removed = invoice.adjustments[args.index];
    if (!removed) return null; // idempotent

    const adjustments = invoice.adjustments.filter((_, i) => i !== args.index);
    await repriceDraft(ctx, args.id, { lines: invoice.lines, adjustments });
    await logPlatformAudit(ctx, {
      actorEmail: staff.email,
      action: 'invoice_draft_edited',
      targetOrgId: invoice.workosOrgId,
      targetTable: 'platformInvoices',
      targetId: args.id,
      before: JSON.stringify(removed),
      after: JSON.stringify(null),
      reason: args.reason,
    });
    return null;
  },
});

/** Edit the lines of a one-off invoice. Metered lines are derived, not typed. */
export const updateManualLines = mutation({
  args: {
    id: v.id('platformInvoices'),
    lines: v.array(v.object({ label: v.string(), amount: v.number() })),
    reason: v.string(),
  },
  returns: v.null(),
  handler: async (ctx, args) => {
    const staff = await requirePlatformStaff(ctx);
    const invoice = await ctx.db.get(args.id);
    if (!invoice) throw new ConvexError('Invoice not found');
    assertDraft(invoice);
    if (invoice.kind !== 'manual') {
      throw new ConvexError(
        'This invoice bills metered usage — its lines come from the meter. Use Refresh to re-derive them, or add an adjustment.',
      );
    }
    if (args.lines.length === 0) throw new ConvexError('At least one line is required');

    const lines = args.lines.map((l) => {
      if (!l.label.trim()) throw new ConvexError('Every line needs a label');
      if (!Number.isFinite(l.amount) || l.amount === 0) {
        throw new ConvexError('Every line needs a non-zero amount');
      }
      return { kind: 'manual' as const, label: l.label.trim(), amount: money(l.amount) };
    });
    const subtotal = await repriceDraft(ctx, args.id, {
      lines,
      adjustments: invoice.adjustments,
    });
    if (subtotal <= 0) throw new ConvexError('Invoice total must be positive');

    await logPlatformAudit(ctx, {
      actorEmail: staff.email,
      action: 'invoice_draft_edited',
      targetOrgId: invoice.workosOrgId,
      targetTable: 'platformInvoices',
      targetId: args.id,
      before: JSON.stringify(invoice.lines),
      after: JSON.stringify(lines),
      reason: args.reason,
    });
    return null;
  },
});

/**
 * Re-derive a metered draft from the CURRENT rate schedule, recurring charges,
 * minimum, and usage count.
 *
 * Cycle close runs on the 2nd. Fixing an org's rate on the 3rd used to leave
 * the draft stale with no way to refresh it — you either hand-adjusted the
 * difference or discarded the cycle. Adjustments are preserved, because they
 * are operator intent rather than derived data.
 */
export const refreshDraft = mutation({
  args: { id: v.id('platformInvoices'), reason: v.string() },
  returns: v.null(),
  handler: async (ctx, args) => {
    const staff = await requirePlatformStaff(ctx);
    const invoice = await ctx.db.get(args.id);
    if (!invoice) throw new ConvexError('Invoice not found');
    assertDraft(invoice);
    if (invoice.kind === 'manual') {
      throw new ConvexError('One-off invoices have no meter behind them — edit their lines directly');
    }

    const org = await ctx.db
      .query('organizations')
      .withIndex('by_organization', (q) => q.eq('workosOrgId', invoice.workosOrgId))
      .unique();
    if (!org) throw new ConvexError('Organization not found');

    const usageRow = await ctx.db
      .query('platformUsageStats')
      .withIndex('by_org_period', (q) =>
        q.eq('workosOrgId', invoice.workosOrgId).eq('periodKey', invoice.periodKey),
      )
      .first();
    const loadsWritten = usageRow?.loadsWritten ?? 0;

    const { lines, ratePerLoad } = computeLines(org, invoice.periodKey, loadsWritten);
    const before = {
      loadsWritten: invoice.loadsWritten,
      ratePerLoad: invoice.ratePerLoad,
      subtotal: invoice.subtotal,
    };
    const subtotal = await repriceDraft(ctx, args.id, {
      lines,
      adjustments: invoice.adjustments,
      ratePerLoad,
      loadsWritten,
    });

    await logPlatformAudit(ctx, {
      actorEmail: staff.email,
      action: 'invoice_draft_edited',
      targetOrgId: invoice.workosOrgId,
      targetTable: 'platformInvoices',
      targetId: args.id,
      before: JSON.stringify(before),
      after: JSON.stringify({ loadsWritten, ratePerLoad, subtotal }),
      reason: args.reason,
    });
    return null;
  },
});

/**
 * Discard a draft entirely.
 *
 * Distinct from void, which cancels a document the customer may have seen. A
 * draft has been seen by nobody, so it is deleted rather than kept as a
 * cancelled artefact — and deleting it lets cycle close re-draft the period
 * from scratch, which is usually what "start over" means. The audit entry
 * survives the row.
 */
export const deleteDraft = mutation({
  args: { id: v.id('platformInvoices'), reason: v.string() },
  returns: v.null(),
  handler: async (ctx, args) => {
    const staff = await requireRecentStaffAuth(ctx);
    if (!args.reason.trim()) throw new ConvexError('A reason is required');
    const invoice = await ctx.db.get(args.id);
    if (!invoice) return null; // idempotent
    assertDraft(invoice);
    if (invoice.amountPaid !== 0 || invoice.payments.length > 0) {
      throw new ConvexError('This draft has payments against it — resolve those first');
    }

    await ctx.db.delete(args.id);
    await logPlatformAudit(ctx, {
      actorEmail: staff.email,
      action: 'invoice_draft_deleted',
      targetOrgId: invoice.workosOrgId,
      targetTable: 'platformInvoices',
      targetId: args.id,
      before: JSON.stringify({
        invoiceNumber: invoice.invoiceNumber,
        periodKey: invoice.periodKey,
        kind: invoice.kind ?? 'metered',
        subtotal: invoice.subtotal,
        lines: invoice.lines,
        adjustments: invoice.adjustments,
      }),
      reason: args.reason,
    });
    return null;
  },
});

// ─── Billing config (org page) ───────────────────────────────────────────

export const updateBillingConfig = mutation({
  args: {
    organizationId: v.id('organizations'),
    // Rate changes take effect NEXT cycle via a schedule step (spec §6).
    ratePerLoadNextCycle: v.optional(v.number()),
    billingTerms: v.optional(
      v.union(
        v.object({ kind: v.literal('net'), days: v.number() }),
        v.object({ kind: v.literal('dayOfMonth'), day: v.number() }),
      ),
    ),
    taxRatePercent: v.optional(v.union(v.number(), v.null())),
    taxJurisdiction: v.optional(v.union(v.string(), v.null())),
    minimumMonthlyCharge: v.optional(v.union(v.number(), v.null())),
    recurringCharges: v.optional(
      v.array(
        v.object({
          label: v.string(),
          amount: v.number(),
          cadence: v.union(v.literal('monthly'), v.literal('annual')),
          anniversaryMonth: v.optional(v.number()),
        }),
      ),
    ),
    reason: v.string(),
  },
  returns: v.null(),
  handler: async (ctx, args) => {
    const staff = await requireRecentStaffAuth(ctx);
    const org = await ctx.db.get(args.organizationId);
    if (!org || !org.workosOrgId) throw new ConvexError('Organization not found');

    const before: Record<string, unknown> = {};
    const patch: Record<string, unknown> = { updatedAt: Date.now() };

    if (args.ratePerLoadNextCycle !== undefined) {
      if (!(args.ratePerLoadNextCycle > 0)) throw new ConvexError('Rate must be positive');
      const current = getPeriodKey(Date.now());
      const [y, m] = current.split('-').map(Number);
      const nextPeriod = m === 12 ? `${y + 1}-01` : `${y}-${String(m + 1).padStart(2, '0')}`;
      before.rateSchedule = org.rateSchedule ?? null;
      patch.rateSchedule = [
        ...(org.rateSchedule ?? []).filter((s) => s.effectiveFromPeriod !== nextPeriod),
        { effectiveFromPeriod: nextPeriod, ratePerLoad: args.ratePerLoadNextCycle },
      ];
    }
    if (args.billingTerms !== undefined) {
      before.billingTerms = org.billingTerms ?? null;
      patch.billingTerms = args.billingTerms;
    }
    if (args.taxRatePercent !== undefined) {
      before.taxRatePercent = org.taxRatePercent ?? null;
      patch.taxRatePercent = args.taxRatePercent ?? undefined;
    }
    if (args.taxJurisdiction !== undefined) {
      before.taxJurisdiction = org.taxJurisdiction ?? null;
      patch.taxJurisdiction = args.taxJurisdiction ?? undefined;
    }
    if (args.minimumMonthlyCharge !== undefined) {
      before.minimumMonthlyCharge = org.minimumMonthlyCharge ?? null;
      patch.minimumMonthlyCharge = args.minimumMonthlyCharge ?? undefined;
    }
    if (args.recurringCharges !== undefined) {
      before.recurringCharges = org.recurringCharges ?? null;
      patch.recurringCharges = args.recurringCharges;
    }

    await ctx.db.patch(args.organizationId, patch);
    await logPlatformAudit(ctx, {
      actorEmail: staff.email,
      action: 'billing_config_changed',
      targetOrgId: org.workosOrgId,
      targetTable: 'organizations',
      targetId: args.organizationId,
      before: JSON.stringify(before),
      after: JSON.stringify({ ...patch, updatedAt: undefined }),
      reason: args.reason,
    });
    return null;
  },
});

/**
 * Set (or replace) a rate step at an explicit period — including a PAST one.
 *
 * `updateBillingConfig.ratePerLoadNextCycle` can only ever move the rate
 * forward, which makes a mid-month contract signing unbillable at the agreed
 * price. Back-dating is allowed here, but only when nothing from that period
 * onward has been committed: a step at P re-prices P and every period after
 * it, so a single committed invoice in that range makes the change a silent
 * rewrite of billed history. When that happens we refuse and name the periods,
 * because the correct instrument is a credit, not a re-price.
 */
export const setRateStep = mutation({
  args: {
    organizationId: v.id('organizations'),
    effectiveFromPeriod: v.string(), // 'YYYY-MM'
    ratePerLoad: v.number(),
    reason: v.string(),
  },
  returns: v.null(),
  handler: async (ctx, args) => {
    const staff = await requireRecentStaffAuth(ctx);
    if (!/^\d{4}-(0[1-9]|1[0-2])$/.test(args.effectiveFromPeriod)) {
      throw new ConvexError('Period must be formatted YYYY-MM');
    }
    if (!(args.ratePerLoad > 0)) throw new ConvexError('Rate must be positive');
    if (!args.reason.trim()) throw new ConvexError('A reason is required');

    const org = await ctx.db.get(args.organizationId);
    if (!org || !org.workosOrgId) throw new ConvexError('Organization not found');

    const blocked = await committedPeriodsFrom(ctx, org.workosOrgId, args.effectiveFromPeriod);
    if (blocked.length > 0) {
      throw new ConvexError(
        `Cannot re-price ${args.effectiveFromPeriod} onward: ${blocked.join(', ')} already ${blocked.length === 1 ? 'has a committed invoice' : 'have committed invoices'}. Issue a credit instead.`,
      );
    }

    const before = org.rateSchedule ?? null;
    const rateSchedule = [
      ...(org.rateSchedule ?? []).filter((s) => s.effectiveFromPeriod !== args.effectiveFromPeriod),
      { effectiveFromPeriod: args.effectiveFromPeriod, ratePerLoad: args.ratePerLoad },
    ].sort((a, b) => a.effectiveFromPeriod.localeCompare(b.effectiveFromPeriod));

    await ctx.db.patch(args.organizationId, { rateSchedule, updatedAt: Date.now() });
    await logPlatformAudit(ctx, {
      actorEmail: staff.email,
      action: 'billing_config_changed',
      targetOrgId: org.workosOrgId,
      targetTable: 'organizations',
      targetId: args.organizationId,
      before: JSON.stringify({ rateSchedule: before }),
      after: JSON.stringify({ rateSchedule }),
      reason: args.reason,
    });
    return null;
  },
});

/** Remove a mis-entered rate step, under the same committed-period guard. */
export const removeRateStep = mutation({
  args: {
    organizationId: v.id('organizations'),
    effectiveFromPeriod: v.string(),
    reason: v.string(),
  },
  returns: v.null(),
  handler: async (ctx, args) => {
    const staff = await requireRecentStaffAuth(ctx);
    const org = await ctx.db.get(args.organizationId);
    if (!org || !org.workosOrgId) throw new ConvexError('Organization not found');
    const before = org.rateSchedule ?? [];
    if (!before.some((s) => s.effectiveFromPeriod === args.effectiveFromPeriod)) return null;

    const blocked = await committedPeriodsFrom(ctx, org.workosOrgId, args.effectiveFromPeriod);
    if (blocked.length > 0) {
      throw new ConvexError(
        `Cannot remove the ${args.effectiveFromPeriod} step: ${blocked.join(', ')} already billed at it.`,
      );
    }

    const rateSchedule = before.filter((s) => s.effectiveFromPeriod !== args.effectiveFromPeriod);
    await ctx.db.patch(args.organizationId, { rateSchedule, updatedAt: Date.now() });
    await logPlatformAudit(ctx, {
      actorEmail: staff.email,
      action: 'billing_config_changed',
      targetOrgId: org.workosOrgId,
      targetTable: 'organizations',
      targetId: args.organizationId,
      before: JSON.stringify({ rateSchedule: before }),
      after: JSON.stringify({ rateSchedule }),
      reason: args.reason,
    });
    return null;
  },
});

/**
 * A one-off invoice: onboarding, implementation, professional services,
 * hardware — anything that isn't metered usage. Shares the ledger and the
 * whole lifecycle (issue / send / pay / reverse / void), but is marked
 * `kind: 'manual'` so it never collides with the cycle's metered invoice and
 * metered vs non-metered revenue stay separable.
 */
export const createManualInvoice = mutation({
  args: {
    organizationId: v.id('organizations'),
    periodKey: v.string(), // 'YYYY-MM' — which cycle it belongs to for reporting
    lines: v.array(v.object({ label: v.string(), amount: v.number() })),
    reason: v.string(),
  },
  returns: v.null(),
  handler: async (ctx, args) => {
    const staff = await requirePlatformStaff(ctx);
    if (!/^\d{4}-(0[1-9]|1[0-2])$/.test(args.periodKey)) {
      throw new ConvexError('Period must be formatted YYYY-MM');
    }
    if (args.lines.length === 0) throw new ConvexError('At least one line is required');
    const org = await ctx.db.get(args.organizationId);
    if (!org || !org.workosOrgId) throw new ConvexError('Organization not found');

    const lines = args.lines.map((l) => {
      if (!l.label.trim()) throw new ConvexError('Every line needs a label');
      if (!Number.isFinite(l.amount) || l.amount === 0) {
        throw new ConvexError('Every line needs a non-zero amount');
      }
      return { kind: 'manual' as const, label: l.label.trim(), amount: money(l.amount) };
    });
    const subtotal = money(lines.reduce((s, l) => s + l.amount, 0));
    if (subtotal <= 0) throw new ConvexError('Invoice total must be positive');

    // Distinct number series so a one-off never shadows the cycle invoice.
    const siblings = await ctx.db
      .query('platformInvoices')
      .withIndex('by_org_period', (q) =>
        q.eq('workosOrgId', org.workosOrgId!).eq('periodKey', args.periodKey),
      )
      .collect();
    const seq = siblings.filter((s) => s.kind === 'manual').length + 1;
    const invoiceNumber = `${platformInvoiceNumber(org.workosOrgId, args.periodKey)}-M${seq}`;

    const now = Date.now();
    const id = await ctx.db.insert('platformInvoices', {
      workosOrgId: org.workosOrgId,
      periodKey: args.periodKey,
      kind: 'manual',
      invoiceNumber,
      loadsWritten: 0,
      ratePerLoad: 0,
      lines,
      adjustments: [],
      subtotal,
      total: subtotal, // tax snapshots at issue, same as metered
      payments: [],
      amountPaid: 0,
      status: 'draft',
      createdAt: now,
      updatedAt: now,
    });
    await logPlatformAudit(ctx, {
      actorEmail: staff.email,
      action: 'invoice_manual_created',
      targetOrgId: org.workosOrgId,
      targetTable: 'platformInvoices',
      targetId: id,
      after: JSON.stringify({ invoiceNumber, subtotal, lines }),
      reason: args.reason,
    });
    return null;
  },
});

/**
 * Contract/commercial fields that were display-only on the org page. Separate
 * from updateBillingConfig because these describe WHO and UNTIL WHEN, not how
 * much — different review posture, and no invoice math depends on them.
 */
export const updateContract = mutation({
  args: {
    organizationId: v.id('organizations'),
    billingEmail: v.optional(v.string()),
    billingContactName: v.optional(v.union(v.string(), v.null())),
    billingPhone: v.optional(v.union(v.string(), v.null())),
    platformContractNumber: v.optional(v.union(v.string(), v.null())),
    platformLicenseStart: v.optional(v.union(v.string(), v.null())),
    platformLicenseEnd: v.optional(v.union(v.string(), v.null())),
    reason: v.string(),
  },
  returns: v.null(),
  handler: async (ctx, args) => {
    const staff = await requirePlatformStaff(ctx);
    const org = await ctx.db.get(args.organizationId);
    if (!org) throw new ConvexError('Organization not found');

    const isDate = (s: string) => /^\d{4}-\d{2}-\d{2}$/.test(s);
    for (const [field, value] of [
      ['platformLicenseStart', args.platformLicenseStart],
      ['platformLicenseEnd', args.platformLicenseEnd],
    ] as const) {
      if (typeof value === 'string' && value && !isDate(value)) {
        throw new ConvexError(`${field} must be formatted YYYY-MM-DD`);
      }
    }
    const start = args.platformLicenseStart ?? org.platformLicenseStart;
    const end = args.platformLicenseEnd ?? org.platformLicenseEnd;
    if (start && end && start > end) {
      throw new ConvexError('License start must be on or before license end');
    }
    if (args.billingEmail !== undefined && !args.billingEmail.includes('@')) {
      throw new ConvexError('Billing email looks invalid');
    }

    const before: Record<string, unknown> = {};
    const patch: Record<string, unknown> = { updatedAt: Date.now() };
    const apply = (key: string, value: string | null | undefined, current: unknown) => {
      if (value === undefined) return;
      before[key] = current ?? null;
      patch[key] = value === null || value === '' ? undefined : value;
    };
    // billingEmail is required on the org row, so it can be changed but never cleared.
    if (args.billingEmail !== undefined) {
      before.billingEmail = org.billingEmail;
      patch.billingEmail = args.billingEmail.trim();
    }
    apply('billingContactName', args.billingContactName, org.billingContactName);
    apply('billingPhone', args.billingPhone, org.billingPhone);
    apply('platformContractNumber', args.platformContractNumber, org.platformContractNumber);
    apply('platformLicenseStart', args.platformLicenseStart, org.platformLicenseStart);
    apply('platformLicenseEnd', args.platformLicenseEnd, org.platformLicenseEnd);

    await ctx.db.patch(args.organizationId, patch);
    await logPlatformAudit(ctx, {
      actorEmail: staff.email,
      action: 'contract_updated',
      targetOrgId: org.workosOrgId,
      targetTable: 'organizations',
      targetId: args.organizationId,
      before: JSON.stringify(before),
      after: JSON.stringify({ ...patch, updatedAt: undefined }),
      reason: args.reason,
    });
    return null;
  },
});

// ─── Console queries ─────────────────────────────────────────────────────

export const listInvoices = query({
  args: {
    status: v.optional(
      v.union(
        v.literal('draft'),
        v.literal('issued'),
        v.literal('sent'),
        v.literal('partially_paid'),
        v.literal('paid'),
        v.literal('written_off'),
        v.literal('void'),
      ),
    ),
    workosOrgId: v.optional(v.string()),
    limit: v.optional(v.number()),
  },
  handler: async (ctx, args) => {
    await requirePlatformStaff(ctx);
    const limit = Math.min(Math.max(args.limit ?? 100, 1), 300);
    if (args.workosOrgId !== undefined) {
      const workosOrgId = args.workosOrgId;
      const rows = await ctx.db
        .query('platformInvoices')
        .withIndex('by_org_period', (q) => q.eq('workosOrgId', workosOrgId))
        .collect();
      return rows
        .filter((r) => args.status === undefined || r.status === args.status)
        .sort((a, b) => b.periodKey.localeCompare(a.periodKey))
        .slice(0, limit);
    }
    if (args.status !== undefined) {
      const status = args.status;
      return await ctx.db
        .query('platformInvoices')
        .withIndex('by_status', (q) => q.eq('status', status))
        .order('desc')
        .take(limit);
    }
    return await ctx.db.query('platformInvoices').order('desc').take(limit);
  },
});

/** Receivables rollup: open balances bucketed by age (spec §9). */
export const agingOverview = query({
  args: {},
  handler: async (ctx) => {
    await requirePlatformStaff(ctx);
    const now = Date.now();
    const open = (
      await Promise.all(
        OPEN_STATUSES.map((status) =>
          ctx.db
            .query('platformInvoices')
            .withIndex('by_status', (q) => q.eq('status', status))
            .take(300),
        ),
      )
    ).flat();
    const buckets = { current: 0, d1_30: 0, d31_60: 0, d61_90: 0, d90_plus: 0 };
    let outstanding = 0;
    for (const inv of open) {
      // Clamp: an overpaid invoice has a negative raw balance, and letting
      // that offset other invoices would understate receivables. The excess
      // lives in the credit ledger, not here.
      const balance = Math.max(0, money(inv.total - inv.amountPaid));
      if (balance === 0) continue;
      outstanding = money(outstanding + balance);
      const overdueDays = inv.dueAt ? Math.floor((now - inv.dueAt) / 86_400_000) : 0;
      if (overdueDays <= 0) buckets.current = money(buckets.current + balance);
      else if (overdueDays <= 30) buckets.d1_30 = money(buckets.d1_30 + balance);
      else if (overdueDays <= 60) buckets.d31_60 = money(buckets.d31_60 + balance);
      else if (overdueDays <= 90) buckets.d61_90 = money(buckets.d61_90 + balance);
      else buckets.d90_plus = money(buckets.d90_plus + balance);
    }
    const drafts = await ctx.db
      .query('platformInvoices')
      .withIndex('by_status', (q) => q.eq('status', 'draft'))
      .take(300);
    const writtenOff = await ctx.db
      .query('platformInvoices')
      .withIndex('by_status', (q) => q.eq('status', 'written_off'))
      .take(300);
    const credits = await ctx.db.query('platformCredits').withIndex('by_time').take(500);
    const creditAvailable = money(
      credits.filter((c) => c.status === 'available').reduce((s, c) => s + c.remaining, 0),
    );

    return {
      outstanding,
      // What is actually collectable once account credit is applied. Credit is
      // consumed at issue, so an overdue invoice raised BEFORE the credit
      // existed still shows its full balance until someone applies it — which
      // makes the gross figure overstate the receivable.
      outstandingNetOfCredit: money(Math.max(0, outstanding - creditAvailable)),
      buckets,
      openCount: open.length,
      draftCount: drafts.length,
      driftCount: open.filter((i) => i.driftDetectedAt).length,
      writtenOffCount: writtenOff.length,
      writtenOffAmount: money(
        writtenOff.reduce((s, i) => s + Math.max(0, i.total - i.amountPaid), 0),
      ),
      // Credit outstanding is a liability, not a receivable — shown beside
      // aging so an operator sees what will be consumed next cycle.
      creditAvailable,
    };
  },
});
