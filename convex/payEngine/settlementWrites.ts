// New-ledger settlement WRITE layer — the review/approve/pay lifecycle the
// settlements slide-over drives, ported to settlements + payItems. Mirrors the
// legacy driverSettlements/carrierSettlements write mutations so the dashboard
// can flip to the new ledger behind the feature flag with a working slide-over.
// (Line edits — editPayableLine/revert/applyRules — already exist as
// editPayItem/revertPayItemEdit/adoptEnginePayItem in editSessionPay.ts.)
import { mutation } from '../_generated/server';
import type { MutationCtx } from '../_generated/server';
import { internal } from '../_generated/api';
import { v } from 'convex/values';
import type { Doc, Id } from '../_generated/dataModel';
import { requireCallerIdentity, requireCallerOrgId } from '../lib/auth';
import { centsFromNumber, microCentsFromNumber, rawCents, rawMicroCents } from '../lib/money';
import { FINALIZED_SETTLEMENT_STATUSES as FINALIZED } from './schema';

// Legacy status the dashboard sends → new lifecycle status.
const STATUS_MAP: Record<'DRAFT' | 'PENDING' | 'APPROVED' | 'PAID' | 'VOID', Doc<'settlements'>['status']> = {
  DRAFT: 'OPEN',
  PENDING: 'IN_REVIEW',
  APPROVED: 'VERIFIED',
  PAID: 'PAID',
  VOID: 'VOID',
};

async function getOwnedSettlement(ctx: MutationCtx, settlementId: Id<'settlements'>, orgId: string) {
  const s = await ctx.db.get(settlementId);
  if (!s || s.workosOrgId !== orgId) throw new Error('Settlement not found');
  return s;
}

/** Non-voided payItems in a settlement's payee + period window. */
async function periodItems(ctx: MutationCtx, s: Doc<'settlements'>) {
  const items = await ctx.db
    .query('payItems')
    .withIndex('by_payee_period', (q) =>
      q.eq('payeeType', s.payeeType).eq('payeeId', s.payeeId)
        .gte('periodAnchorAt', s.periodStart).lte('periodAnchorAt', s.periodEnd))
    .collect();
  return items.filter((it) => !it.isVoided);
}

// ── blocker acknowledgements ────────────────────────────────────────────────

export const acknowledgeBlocker = mutation({
  args: { settlementId: v.id('settlements'), blockerKey: v.string(), note: v.optional(v.string()) },
  returns: v.null(),
  handler: async (ctx, args) => {
    const { orgId, userId } = await requireCallerIdentity(ctx);
    const s = await getOwnedSettlement(ctx, args.settlementId, orgId);
    if (FINALIZED.has(s.status)) throw new Error('Settlement is already finalized');
    const existing = s.acknowledgedBlockers ?? [];
    if (existing.some((a) => a.key === args.blockerKey)) return null; // idempotent
    await ctx.db.patch(args.settlementId, {
      acknowledgedBlockers: [...existing, { key: args.blockerKey, by: userId, at: Date.now(), note: args.note }],
      updatedAt: Date.now(),
    });
    return null;
  },
});

export const unacknowledgeBlocker = mutation({
  args: { settlementId: v.id('settlements'), blockerKey: v.string() },
  returns: v.null(),
  handler: async (ctx, args) => {
    const orgId = await requireCallerOrgId(ctx);
    const s = await getOwnedSettlement(ctx, args.settlementId, orgId);
    if (FINALIZED.has(s.status)) return null;
    await ctx.db.patch(args.settlementId, {
      acknowledgedBlockers: (s.acknowledgedBlockers ?? []).filter((a) => a.key !== args.blockerKey),
      updatedAt: Date.now(),
    });
    return null;
  },
});

// ── status lifecycle ────────────────────────────────────────────────────────

export const updateSettlementStatus = mutation({
  args: {
    settlementId: v.id('settlements'),
    newStatus: v.union(v.literal('DRAFT'), v.literal('PENDING'), v.literal('APPROVED'), v.literal('PAID'), v.literal('VOID')),
    notes: v.optional(v.string()),
    paidMethod: v.optional(v.string()),
    paidReference: v.optional(v.string()),
    voidReason: v.optional(v.string()),
  },
  returns: v.null(),
  handler: async (ctx, args) => {
    const { orgId, userId } = await requireCallerIdentity(ctx);
    const s = await getOwnedSettlement(ctx, args.settlementId, orgId);
    const now = Date.now();
    const target = STATUS_MAP[args.newStatus];

    if (args.newStatus === 'APPROVED') {
      // Freeze: lock every payItem in the period, re-aggregate final totals.
      for (const it of await periodItems(ctx, s)) {
        if (!it.isLocked) await ctx.db.patch(it._id, { isLocked: true, updatedAt: now });
      }
      const aggRef = s.payeeType === 'CARRIER'
        ? internal.payEngine.aggregateSettlement.aggregateCarrierSettlement
        : internal.payEngine.aggregateSettlement.aggregateDriverSettlement;
      await ctx.runMutation(aggRef, {
        workosOrgId: s.workosOrgId, payeeId: s.payeeId,
        periodStart: s.periodStart, periodEnd: s.periodEnd, userId,
      });
      // Aggregation may touch the doc — set the final status/stamps LAST.
      await ctx.db.patch(args.settlementId, {
        status: target, verifiedAt: now, verifiedBy: userId,
        ...(args.notes ? { notes: args.notes } : {}), updatedAt: now,
      });
      return null;
    }

    const updates: Partial<Doc<'settlements'>> = { status: target, updatedAt: now };
    if (args.newStatus === 'PAID') {
      updates.paidAt = now; updates.paidBy = userId;
      updates.paymentMethod = args.paidMethod as Doc<'settlements'>['paymentMethod'];
      updates.paymentReference = args.paidReference;
    } else if (args.newStatus === 'VOID') {
      updates.voidedAt = now; updates.voidedBy = userId; updates.voidReason = args.voidReason;
    }
    if (args.notes) updates.notes = args.notes;
    await ctx.db.patch(args.settlementId, updates);
    return null;
  },
});

/** Reverse a recorded payment: PAID → VERIFIED (mirrors legacy PAID → APPROVED). */
export const reversePayment = mutation({
  args: { settlementId: v.id('settlements') },
  returns: v.null(),
  handler: async (ctx, args) => {
    const orgId = await requireCallerOrgId(ctx);
    const s = await getOwnedSettlement(ctx, args.settlementId, orgId);
    if (s.status !== 'PAID') throw new Error('Only a paid settlement can have its payment reversed');
    await ctx.db.patch(args.settlementId, {
      status: 'VERIFIED', paidAt: undefined, paidBy: undefined,
      paymentMethod: undefined, paymentReference: undefined, updatedAt: Date.now(),
    });
    return null;
  },
});

// ── manual adjustments ──────────────────────────────────────────────────────

export const addManualAdjustment = mutation({
  args: {
    settlementId: v.id('settlements'),
    description: v.string(),
    amount: v.number(),                 // signed dollars (negative = deduction)
    loadId: v.optional(v.id('loadInformation')),
    category: v.optional(v.union(v.literal('EARNING'), v.literal('REIMBURSEMENT'), v.literal('DEDUCTION'))),
  },
  returns: v.id('payItems'),
  handler: async (ctx, args) => {
    const { orgId, userId } = await requireCallerIdentity(ctx);
    const s = await getOwnedSettlement(ctx, args.settlementId, orgId);
    if (FINALIZED.has(s.status)) throw new Error('Cannot add adjustments to a finalized settlement');

    const code = args.amount < 0 ? 'LEGACY_DEDUCTION' : 'LEGACY_MANUAL';
    const comp = await ctx.db
      .query('chargeComponents')
      .withIndex('by_org_code', (q) => q.eq('workosOrgId', orgId).eq('code', code))
      .first();
    if (!comp) throw new Error(`Missing ${code} charge component`);

    const now = Date.now();
    const magnitude = Math.abs(args.amount);
    const payItemId = await ctx.db.insert('payItems', {
      workosOrgId: orgId, payeeType: s.payeeType, payeeId: s.payeeId,
      kind: 'MANUAL_ADJUSTMENT', componentId: comp._id, lifecycleStatus: 'APPLIED',
      description: args.description, quantity: 1,
      rateMicroCents: rawMicroCents(microCentsFromNumber(magnitude, 'USD')),
      amountCents: rawCents(centsFromNumber(magnitude, 'USD')),
      currency: 'USD',
      periodAnchorAt: s.periodStart, // window it into this settlement's period
      settlementId: args.settlementId,
      sourceRef: { kind: 'MANUAL', id: undefined, loadId: args.loadId },
      sourceData: { _variant: 'MANUAL_ADJUSTMENT', reason: args.description },
      isLocked: true, isVoided: false,
      createdAt: now, updatedAt: now, createdBy: userId,
    });
    return payItemId;
  },
});

/** Remove a payItem from a settlement (append-only: void it). */
export const removePayItem = mutation({
  args: { payItemId: v.id('payItems') },
  returns: v.null(),
  handler: async (ctx, args) => {
    const orgId = await requireCallerOrgId(ctx);
    const item = await ctx.db.get(args.payItemId);
    if (!item || item.workosOrgId !== orgId) throw new Error('Pay item not found');
    if (item.isVoided) return null;
    // Guard against removing from a finalized settlement.
    if (item.settlementId) {
      const s = await ctx.db.get(item.settlementId);
      if (s && FINALIZED.has(s.status)) throw new Error('Cannot remove items from a finalized settlement');
    }
    await ctx.db.patch(args.payItemId, {
      isVoided: true, voidedAt: Date.now(), voidReason: 'removed from settlement by reviewer', updatedAt: Date.now(),
    });
    return null;
  },
});
