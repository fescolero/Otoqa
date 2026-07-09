// One-time lifecycle-state migration for cutover.
//
// The new-ledger settlements are aggregated fresh (all status OPEN). Legacy
// settlements carry the reviewer lifecycle (APPROVED / PAID / VOID). Before an
// org flips to the new ledger, mirror that lifecycle so the Approved / Paid /
// Void views aren't empty: match each finalized legacy settlement to its new
// counterpart by (payee, periodStart) and transition its status + stamps.
// APPROVED→VERIFIED (locks the period's payItems), PAID→PAID, VOID→VOID.
// Idempotent + dry-run by default. Missing new counterparts (e.g. a driver with
// no new-ledger session) are reported, not created.
import { internalMutation } from '../_generated/server';
import type { MutationCtx } from '../_generated/server';
import { v } from 'convex/values';
import type { Doc } from '../_generated/dataModel';

const VALID_METHODS = new Set(['ACH', 'CHECK', 'WIRE', 'QUICKPAY']);

function toNewStatus(legacy: string): Doc<'settlements'>['status'] | null {
  switch (legacy) {
    case 'APPROVED': return 'VERIFIED';
    case 'PAID': return 'PAID';
    case 'VOID': return 'VOID';
    default: return null; // DRAFT/PENDING/DISPUTED — leave the new OPEN row alone
  }
}

async function lockPeriodItems(ctx: MutationCtx, s: Doc<'settlements'>, now: number) {
  const items = await ctx.db
    .query('payItems')
    .withIndex('by_payee_period', (q) =>
      q.eq('payeeType', s.payeeType).eq('payeeId', s.payeeId)
        .gte('periodAnchorAt', s.periodStart).lte('periodAnchorAt', s.periodEnd))
    .collect();
  for (const it of items) {
    if (!it.isVoided && !it.isLocked) await ctx.db.patch(it._id, { isLocked: true, updatedAt: now });
  }
}

type LegacyLike = {
  statementNumber?: string;
  status: string;
  periodStart: number;
  approvedAt?: number;
  approvedBy?: string;
  paidAt?: number;
  paidBy?: string;
  paidMethod?: string;
  paidReference?: string;
  voidedAt?: number;
  voidedBy?: string;
  voidReason?: string;
};

export const migrateLegacyLifecycle = internalMutation({
  args: { workosOrgId: v.string(), dryRun: v.optional(v.boolean()) },
  handler: async (ctx, args) => {
    const dryRun = args.dryRun ?? true;
    const now = Date.now();
    const changes: Array<Record<string, unknown>> = [];

    const apply = async (
      payeeType: 'DRIVER' | 'CARRIER',
      payeeId: string,
      legacy: LegacyLike,
    ) => {
      const target = toNewStatus(legacy.status);
      if (!target) return;
      const matches = await ctx.db
        .query('settlements')
        .withIndex('by_payee_period', (q) =>
          q.eq('payeeType', payeeType).eq('payeeId', payeeId).eq('periodStart', legacy.periodStart))
        .collect();
      const newS = matches.find((m) => !['VOID'].includes(m.status)) ?? matches[0];
      if (!newS) {
        changes.push({ payeeType, statement: legacy.statementNumber, legacyStatus: legacy.status, action: 'MISSING_NEW_SETTLEMENT' });
        return;
      }
      if (newS.status === target) {
        changes.push({ payeeType, statement: newS.statementNumber, action: 'ALREADY', status: target });
        return;
      }
      changes.push({ payeeType, statement: newS.statementNumber, from: newS.status, to: target, legacyStatus: legacy.status });
      if (dryRun) return;

      const patch: Partial<Doc<'settlements'>> = { status: target, updatedAt: now };
      // Any finalized state was approved first — carry the verify stamp + lock.
      patch.verifiedAt = legacy.approvedAt ?? now;
      patch.verifiedBy = legacy.approvedBy ?? 'lifecycle-migration';
      await lockPeriodItems(ctx, newS, now);
      if (target === 'PAID') {
        patch.paidAt = legacy.paidAt ?? now;
        patch.paidBy = legacy.paidBy ?? 'lifecycle-migration';
        const pm = (legacy.paidMethod ?? '').toUpperCase();
        patch.paymentMethod = VALID_METHODS.has(pm) ? (pm as Doc<'settlements'>['paymentMethod']) : undefined;
        patch.paymentReference = legacy.paidReference;
      } else if (target === 'VOID') {
        patch.voidedAt = legacy.voidedAt ?? now;
        patch.voidedBy = legacy.voidedBy ?? 'lifecycle-migration';
        patch.voidReason = legacy.voidReason;
      }
      await ctx.db.patch(newS._id, patch);
    };

    for (const status of ['APPROVED', 'PAID', 'VOID'] as const) {
      const drivers = await ctx.db
        .query('driverSettlements')
        .withIndex('by_org_status', (q) => q.eq('workosOrgId', args.workosOrgId).eq('status', status))
        .collect();
      for (const l of drivers) await apply('DRIVER', l.driverId as string, l as LegacyLike);

      const carriers = await ctx.db
        .query('carrierSettlements')
        .withIndex('by_org_status', (q) => q.eq('workosOrgId', args.workosOrgId).eq('status', status))
        .collect();
      for (const l of carriers) await apply('CARRIER', l.carrierPartnershipId as string, l as LegacyLike);
    }

    const summary: Record<string, number> = {};
    for (const c of changes) summary[String(c.action ?? `${c.from}->${c.to}`)] = (summary[String(c.action ?? `${c.from}->${c.to}`)] ?? 0) + 1;
    return { dryRun, summary, changes };
  },
});
