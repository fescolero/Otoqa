import { v, ConvexError } from 'convex/values';
import { query, mutation, internalMutation } from '../_generated/server';
import type { MutationCtx } from '../_generated/server';
import type { Doc } from '../_generated/dataModel';
import { requirePlatformStaff, requireRecentStaffAuth } from '../lib/auth';
import { logPlatformAudit } from '../lib/platformAudit';
import { logSystemEvent } from '../lib/systemEvents';
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
  const invoice = await ctx.db
    .query('platformInvoices')
    .withIndex('by_org_period', (q) => q.eq('workosOrgId', workosOrgId).eq('periodKey', periodKey))
    .unique();
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
  return rows.some((r) => r.status !== 'draft' && r.status !== 'void');
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

      const existing = await ctx.db
        .query('platformInvoices')
        .withIndex('by_org_period', (q) =>
          q.eq('workosOrgId', org.workosOrgId!).eq('periodKey', periodKey),
        )
        .unique();
      if (existing) continue; // never touch — idempotent re-runs

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
        const existing = await ctx.db
          .query('platformInvoices')
          .withIndex('by_org_period', (q) =>
            q.eq('workosOrgId', org.workosOrgId!).eq('periodKey', row.periodKey),
          )
          .unique();
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
  args: { id: v.id('platformInvoices') },
  returns: v.null(),
  handler: async (ctx, args) => {
    const staff = await requirePlatformStaff(ctx);
    const invoice = await ctx.db.get(args.id);
    if (!invoice) throw new ConvexError('Invoice not found');
    if (invoice.status !== 'draft') throw new ConvexError('Only drafts can be issued');

    const org = await ctx.db
      .query('organizations')
      .withIndex('by_organization', (q) => q.eq('workosOrgId', invoice.workosOrgId))
      .unique();

    const issuedAt = Date.now();
    const subtotal = sumSubtotal(invoice);
    const taxRatePercent = org?.taxRatePercent;
    const taxAmount =
      taxRatePercent != null ? money(subtotal * (taxRatePercent / 100)) : undefined;

    await ctx.db.patch(args.id, {
      subtotal,
      taxRatePercent,
      taxJurisdiction: org?.taxJurisdiction,
      taxAmount,
      total: money(subtotal + (taxAmount ?? 0)),
      status: 'issued',
      issuedAt,
      dueAt: computeDueAt(issuedAt, org?.billingTerms),
      updatedAt: issuedAt,
    });
    await logPlatformAudit(ctx, {
      actorEmail: staff.email,
      action: 'invoice_issued',
      targetOrgId: invoice.workosOrgId,
      targetTable: 'platformInvoices',
      targetId: args.id,
      after: JSON.stringify({ invoiceNumber: invoice.invoiceNumber, total: money(subtotal + (taxAmount ?? 0)) }),
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
    if (invoice.status !== 'issued') throw new ConvexError('Only issued invoices can be marked sent');
    await ctx.db.patch(args.id, { status: 'sent', updatedAt: Date.now() });
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
  },
  returns: v.null(),
  handler: async (ctx, args) => {
    const staff = await requirePlatformStaff(ctx);
    const invoice = await ctx.db.get(args.id);
    if (!invoice) throw new ConvexError('Invoice not found');
    if (invoice.status !== 'issued' && invoice.status !== 'sent') {
      throw new ConvexError(`Cannot record a payment on a ${invoice.status} invoice`);
    }
    if (!(args.amount > 0)) throw new ConvexError('Payment amount must be positive');

    const amountPaid = money(invoice.amountPaid + args.amount);
    const paidInFull = amountPaid >= invoice.total;
    await ctx.db.patch(args.id, {
      payments: [
        ...invoice.payments,
        {
          amount: money(args.amount),
          method: args.method,
          reference: args.reference,
          recordedByEmail: staff.email,
          receivedAt: Date.now(),
        },
      ],
      amountPaid,
      ...(paidInFull ? { status: 'paid' as const, paidAt: Date.now() } : {}),
      updatedAt: Date.now(),
    });
    await logPlatformAudit(ctx, {
      actorEmail: staff.email,
      action: 'invoice_payment_recorded',
      targetOrgId: invoice.workosOrgId,
      targetTable: 'platformInvoices',
      targetId: args.id,
      metadata: JSON.stringify({
        amount: args.amount,
        method: args.method,
        reference: args.reference,
        paidInFull,
      }),
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
    if (invoice.status === 'paid') throw new ConvexError('Paid invoices cannot be voided — use a credit on the next cycle');
    if (invoice.amountPaid > 0) throw new ConvexError('Invoice has recorded payments — resolve those first');
    if (invoice.status === 'void') return null; // idempotent

    await ctx.db.patch(args.id, {
      status: 'void',
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

// ─── Console queries ─────────────────────────────────────────────────────

export const listInvoices = query({
  args: {
    status: v.optional(
      v.union(
        v.literal('draft'),
        v.literal('issued'),
        v.literal('sent'),
        v.literal('paid'),
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
    const open = [
      ...(await ctx.db
        .query('platformInvoices')
        .withIndex('by_status', (q) => q.eq('status', 'issued'))
        .take(300)),
      ...(await ctx.db
        .query('platformInvoices')
        .withIndex('by_status', (q) => q.eq('status', 'sent'))
        .take(300)),
    ];
    const buckets = { current: 0, d1_30: 0, d31_60: 0, d61_90: 0, d90_plus: 0 };
    let outstanding = 0;
    for (const inv of open) {
      const balance = money(inv.total - inv.amountPaid);
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
    return {
      outstanding,
      buckets,
      openCount: open.length,
      draftCount: drafts.length,
      driftCount: open.filter((i) => i.driftDetectedAt).length,
    };
  },
});
