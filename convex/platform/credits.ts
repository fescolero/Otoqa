import { v, ConvexError } from 'convex/values';
import { query, mutation } from '../_generated/server';
import type { MutationCtx } from '../_generated/server';
import type { Doc, Id } from '../_generated/dataModel';
import { requirePlatformStaff, requireRecentStaffAuth } from '../lib/auth';
import { logPlatformAudit } from '../lib/platformAudit';

/**
 * Org credit ledger — the carry-forward mechanism that
 * docs/platform-admin-ops-readiness-plan.md §5 identified as missing. Before
 * this existed, `addAdjustment` told operators that post-issue corrections
 * "ride the NEXT cycle" and nothing carried anything forward.
 *
 * Shape of the rule:
 *   - Credits are created by overpayment (automatically, at payment time) or
 *     by staff (goodwill, dispute, service credit).
 *   - They are consumed at ISSUE time as a `credit`-method payment, never as
 *     an invoice line: a credit must not reduce the new cycle's taxable
 *     subtotal, and issued lines are frozen.
 *   - Consumption can split across invoices (`remaining` + `applications`).
 *   - Nothing is ever edited backwards. A credit that shouldn't exist is
 *     VOIDED (audited, with a reason), which is only possible while it is
 *     still unconsumed.
 */

const money = (n: number) => Math.round(n * 100) / 100;

/** Credits with an unconsumed balance, oldest first (FIFO consumption). */
export async function availableCredits(
  ctx: MutationCtx,
  workosOrgId: string,
): Promise<Doc<'platformCredits'>[]> {
  const rows = await ctx.db
    .query('platformCredits')
    .withIndex('by_org_status', (q) => q.eq('workosOrgId', workosOrgId).eq('status', 'available'))
    .collect();
  return rows.filter((r) => r.remaining > 0).sort((a, b) => a.createdAt - b.createdAt);
}

/**
 * Post a credit. `sourcePaymentId` ties an overpayment credit back to the
 * payment that produced it so a later reversal can claw it back.
 */
export async function issueCredit(
  ctx: MutationCtx,
  args: {
    workosOrgId: string;
    amount: number;
    source: Doc<'platformCredits'>['source'];
    reason: string;
    createdByEmail: string;
    sourceInvoiceId?: Id<'platformInvoices'>;
    sourcePaymentId?: string;
  },
): Promise<Id<'platformCredits'>> {
  if (!(args.amount > 0)) throw new ConvexError('Credit amount must be positive');
  const amount = money(args.amount);
  const now = Date.now();
  return await ctx.db.insert('platformCredits', {
    workosOrgId: args.workosOrgId,
    amount,
    remaining: amount,
    source: args.source,
    reason: args.reason,
    status: 'available',
    createdByEmail: args.createdByEmail,
    sourceInvoiceId: args.sourceInvoiceId,
    sourcePaymentId: args.sourcePaymentId,
    applications: [],
    createdAt: now,
    updatedAt: now,
  });
}

/**
 * Consume up to `maxAmount` of an org's available credit against an invoice.
 * Returns the total applied (0 when there's nothing available). Caller records
 * the matching `credit` payment on the invoice — this function only moves the
 * credit ledger, so both sides stay in one transaction.
 *
 * Capped at the invoice balance by the caller: a credit never makes an invoice
 * negative, and the unused remainder stays available for the next cycle.
 */
export async function consumeCredits(
  ctx: MutationCtx,
  workosOrgId: string,
  maxAmount: number,
  invoice: { _id: Id<'platformInvoices'>; invoiceNumber: string; issuedAt?: number },
  explicitAppliedAt?: number,
): Promise<{ applied: number; appliedAt: number }> {
  const now = Date.now();
  if (!(maxAmount > 0)) return { applied: 0, appliedAt: explicitAppliedAt ?? now };
  let budget = money(maxAmount);
  let applied = 0;
  let appliedAt = 0;

  for (const credit of await availableCredits(ctx, workosOrgId)) {
    if (budget <= 0) break;
    const take = money(Math.min(credit.remaining, budget));
    if (take <= 0) continue;

    // WHEN this credit could first have settled this invoice: both had to
    // exist. Stamping "now" instead would make a credit that sat unused for
    // months read as a payment made months late — the opposite of the truth,
    // and the customer's reputation is what pays for that mistake. Clamped to
    // now so a future-dated row can never appear.
    const effectiveAt =
      explicitAppliedAt ?? Math.min(now, Math.max(credit.createdAt, invoice.issuedAt ?? 0));

    const remaining = money(credit.remaining - take);
    await ctx.db.patch(credit._id, {
      remaining,
      status: remaining <= 0 ? 'consumed' : 'available',
      applications: [
        ...credit.applications,
        {
          invoiceId: invoice._id,
          invoiceNumber: invoice.invoiceNumber,
          amount: take,
          appliedAt: effectiveAt,
        },
      ],
      updatedAt: now,
    });
    applied = money(applied + take);
    budget = money(budget - take);
    // An invoice covered by several credits is only settled once the last of
    // them arrived, so the latest date wins.
    appliedAt = Math.max(appliedAt, effectiveAt);
  }
  return { applied, appliedAt: applied > 0 ? appliedAt : (explicitAppliedAt ?? now) };
}

/**
 * Undo credit applications made to one invoice — used when a draft/issued
 * invoice is voided, so the customer's credit is not destroyed along with it.
 * Restores `remaining` and flips 'consumed' rows back to 'available'.
 */
export async function releaseCreditsForInvoice(
  ctx: MutationCtx,
  workosOrgId: string,
  invoiceId: Id<'platformInvoices'>,
): Promise<number> {
  const rows = await ctx.db
    .query('platformCredits')
    .withIndex('by_org_status', (q) => q.eq('workosOrgId', workosOrgId))
    .collect();
  let released = 0;
  const now = Date.now();

  for (const credit of rows) {
    const mine = credit.applications.filter((a) => a.invoiceId === invoiceId);
    if (mine.length === 0) continue;
    const back = money(mine.reduce((s, a) => s + a.amount, 0));
    if (back <= 0) continue;
    // Never resurrect a voided credit — voiding is a deliberate decision that
    // outranks the invoice's lifecycle.
    if (credit.status === 'void') continue;
    await ctx.db.patch(credit._id, {
      remaining: money(credit.remaining + back),
      status: 'available',
      applications: credit.applications.filter((a) => a.invoiceId !== invoiceId),
      updatedAt: now,
    });
    released = money(released + back);
  }
  return released;
}

// ─── Console surface ─────────────────────────────────────────────────────

export const listCredits = query({
  args: { workosOrgId: v.optional(v.string()), limit: v.optional(v.number()) },
  handler: async (ctx, args) => {
    await requirePlatformStaff(ctx);
    const limit = Math.min(Math.max(args.limit ?? 100, 1), 300);
    if (args.workosOrgId !== undefined) {
      const workosOrgId = args.workosOrgId;
      const rows = await ctx.db
        .query('platformCredits')
        .withIndex('by_org_status', (q) => q.eq('workosOrgId', workosOrgId))
        .collect();
      return rows.sort((a, b) => b.createdAt - a.createdAt).slice(0, limit);
    }
    return await ctx.db.query('platformCredits').withIndex('by_time').order('desc').take(limit);
  },
});

/** Unconsumed balance for an org — shown on the org page and at issue time. */
export const creditBalance = query({
  args: { workosOrgId: v.string() },
  handler: async (ctx, args) => {
    await requirePlatformStaff(ctx);
    const rows = await ctx.db
      .query('platformCredits')
      .withIndex('by_org_status', (q) =>
        q.eq('workosOrgId', args.workosOrgId).eq('status', 'available'),
      )
      .collect();
    return {
      available: money(rows.reduce((s, r) => s + r.remaining, 0)),
      count: rows.filter((r) => r.remaining > 0).length,
    };
  },
});

export const createCredit = mutation({
  args: {
    workosOrgId: v.string(),
    amount: v.number(),
    source: v.union(
      v.literal('goodwill'),
      v.literal('dispute'),
      v.literal('service_credit'),
      v.literal('manual'),
    ),
    reason: v.string(),
  },
  returns: v.null(),
  handler: async (ctx, args) => {
    // Step-up: a credit is money moving out, same class as a write-off.
    const staff = await requireRecentStaffAuth(ctx);
    if (!args.reason.trim()) throw new ConvexError('A reason is required');
    const creditId = await issueCredit(ctx, {
      workosOrgId: args.workosOrgId,
      amount: args.amount,
      source: args.source,
      reason: args.reason,
      createdByEmail: staff.email,
    });
    await logPlatformAudit(ctx, {
      actorEmail: staff.email,
      action: 'credit_issued',
      targetOrgId: args.workosOrgId,
      targetTable: 'platformCredits',
      targetId: creditId,
      after: JSON.stringify({ amount: money(args.amount), source: args.source }),
      reason: args.reason,
    });
    return null;
  },
});

export const voidCredit = mutation({
  args: { creditId: v.id('platformCredits'), reason: v.string() },
  returns: v.null(),
  handler: async (ctx, args) => {
    const staff = await requireRecentStaffAuth(ctx);
    const credit = await ctx.db.get(args.creditId);
    if (!credit) throw new ConvexError('Credit not found');
    if (credit.status === 'void') return null; // idempotent
    // A credit already applied to an invoice is part of that invoice's
    // balance — voiding it here would silently make the invoice underpaid.
    if (credit.applications.length > 0) {
      throw new ConvexError(
        'This credit has already been applied to an invoice — void or adjust that invoice instead',
      );
    }
    await ctx.db.patch(args.creditId, {
      status: 'void',
      remaining: 0,
      voidedAt: Date.now(),
      voidReason: args.reason,
      updatedAt: Date.now(),
    });
    await logPlatformAudit(ctx, {
      actorEmail: staff.email,
      action: 'credit_voided',
      targetOrgId: credit.workosOrgId,
      targetTable: 'platformCredits',
      targetId: args.creditId,
      before: JSON.stringify({ amount: credit.amount, remaining: credit.remaining }),
      reason: args.reason,
    });
    return null;
  },
});
