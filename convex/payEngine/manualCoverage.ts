// Write-coverage for NON-earning lines (the last cutover prerequisite).
//
// The new ledger dual-writes EARNING items (leg + session) but not the manual
// adjustments legacy carries: driver deductions/reimbursements/bonuses via
// loadPayables.addManual, and carrier adjustments via loadCarrierPayables /
// carrierSettlements.addManualAdjustment. A read adapter over an EARNING-only
// ledger would omit those lines. This module mirrors them into payItems (kind
// MANUAL_ADJUSTMENT), mapping:
//   • totalAmount < 0  → LEGACY_DEDUCTION component (DEBIT → subtracts from net)
//   • totalAmount >= 0 → LEGACY_MANUAL    component (CREDIT → adds to net)
// amountCents is stored as a MAGNITUDE (the rollup derives sign from the
// component), matching the engine's "emit magnitudes" contract.
//
//   backfillManualPayItems — one-shot import of EXISTING manual lines.
//   syncManualPayItem      — forward dual-write: scheduled from the legacy
//                            add/update/remove mutations, it upserts (or voids,
//                            when the line is edited away/deleted) the mirrored
//                            payItem. Idempotent via sourceData.legacyRowId.
import { internalMutation } from '../_generated/server';
import type { MutationCtx } from '../_generated/server';
import { v } from 'convex/values';
import type { Id, Doc } from '../_generated/dataModel';
import { centsFromNumber, microCentsFromNumber, rawCents, rawMicroCents } from '../lib/money';
import { FINALIZED_SETTLEMENT_STATUSES } from './schema';
import { makeForwardAnchorResolver } from './periodAnchor';

type ManualTable = 'loadPayables' | 'loadCarrierPayables';

/** Component code a legacy manual line maps to, by sign. */
export function legacyManualComponentCode(totalAmount: number): 'LEGACY_DEDUCTION' | 'LEGACY_MANUAL' {
  return totalAmount < 0 ? 'LEGACY_DEDUCTION' : 'LEGACY_MANUAL';
}

/** Normalized view of a legacy manual payable (driver or carrier). */
type ManualLine = {
  _id: string;
  description: string;
  quantity: number;
  rate: number;
  totalAmount: number;
  isLocked?: boolean;
  loadId?: Id<'loadInformation'>;
  legId?: Id<'dispatchLegs'>;
  category?: string;
  createdAt: number;
  settlementId?: Id<'driverSettlements'> | Id<'carrierSettlements'>;
};

async function resolveLegacyComponents(ctx: MutationCtx, workosOrgId: string) {
  const byCode = async (code: string) =>
    ctx.db
      .query('chargeComponents')
      .withIndex('by_org_code', (q) => q.eq('workosOrgId', workosOrgId).eq('code', code))
      .first();
  const deductionComp = await byCode('LEGACY_DEDUCTION');
  const manualComp = await byCode('LEGACY_MANUAL');
  if (!deductionComp || !manualComp) return null;
  return { deductionComp, manualComp };
}

/** Period anchor = the legacy settlement's periodStart (so it windows into the
 * same period), else the line's createdAt. */
async function anchorFor(ctx: MutationCtx, line: ManualLine): Promise<number> {
  if (!line.settlementId) return line.createdAt;
  const s = await ctx.db.get(line.settlementId);
  return (s as { periodStart?: number } | null)?.periodStart ?? line.createdAt;
}

/**
 * Forward-path anchor with roll-forward. A manual line whose natural period
 * already has a FINALIZED new-ledger statement can't be aggregated into it — it
 * would orphan (show nowhere / silently inflate a re-derived total). Instead,
 * roll it onto the payee's NEXT open period so the next aggregation attaches it.
 * Falls back to `now` when no open period exists yet (it lands when that
 * period's statement is generated). Non-finalized natural period → unchanged.
 */
async function resolveForwardAnchor(
  ctx: MutationCtx,
  payeeType: 'DRIVER' | 'CARRIER',
  payeeId: string,
  naturalAnchor: number,
  now: number,
): Promise<{ anchor: number; rolledForward: boolean }> {
  const resolve = await makeForwardAnchorResolver(ctx, payeeType, payeeId);
  return resolve(naturalAnchor, now);
}

/**
 * True if a mirror payItem is already frozen on a FINALIZED settlement. Such a
 * mirror was settled/paid and must not be voided by a downstream legacy edit —
 * doing so would drop money from a locked statement (its frozen totals still
 * count it, but the by_settlement read no longer would). Post-payment
 * corrections belong on a fresh adjustment, not a retroactive void.
 */
async function isOnFinalizedSettlement(ctx: MutationCtx, item: Doc<'payItems'>): Promise<boolean> {
  if (!item.settlementId) return false;
  const s = await ctx.db.get(item.settlementId);
  return s != null && FINALIZED_SETTLEMENT_STATUSES.has(s.status);
}

function buildManualRow(
  workosOrgId: string,
  payeeType: 'DRIVER' | 'CARRIER',
  payeeId: string,
  line: ManualLine,
  comp: Doc<'chargeComponents'>,
  periodAnchorAt: number,
  legacyTable: ManualTable,
  now: number,
  runId: string,
) {
  const magnitude = Math.abs(line.totalAmount);
  return {
    workosOrgId,
    payeeType,
    payeeId,
    kind: 'MANUAL_ADJUSTMENT' as const,
    componentId: comp._id,
    lifecycleStatus: 'APPLIED' as const,
    description: line.description,
    quantity: Math.abs(line.quantity),
    rateMicroCents: rawMicroCents(microCentsFromNumber(Math.abs(line.rate), 'USD')),
    amountCents: rawCents(centsFromNumber(magnitude, 'USD')),
    currency: 'USD' as const,
    periodAnchorAt,
    sourceRef: {
      kind: 'LEGACY_IMPORT' as const,
      id: line._id,
      loadId: line.loadId,
      legId: line.legId,
    },
    sourceData: {
      _variant: 'LEGACY_IMPORT' as const,
      legacyTable,
      legacyRowId: line._id,
      legacyCategory: line.category,
      legacyCalcSnapshot: JSON.stringify({ quantity: line.quantity, rate: line.rate, totalAmount: line.totalAmount }),
      backfillRunId: runId,
      backfilledAt: now,
    },
    isLocked: line.isLocked ?? true, // manual lines are locked in legacy
    isVoided: false,
    createdAt: now,
    updatedAt: now,
    createdBy: 'manual-coverage',
  };
}

/** Existing non-voided imported payItems for a legacy row id, in one org. */
async function existingImports(ctx: MutationCtx, workosOrgId: string, legacyRowId: string) {
  const rows = await ctx.db
    .query('payItems')
    .withIndex('by_kind_org', (q) => q.eq('workosOrgId', workosOrgId).eq('kind', 'MANUAL_ADJUSTMENT'))
    .collect();
  return rows.filter(
    (it) => !it.isVoided && it.sourceData?._variant === 'LEGACY_IMPORT' && it.sourceData.legacyRowId === legacyRowId,
  );
}

function normalizeDriver(p: Doc<'loadPayables'>): ManualLine {
  return {
    _id: p._id, description: p.description, quantity: p.quantity, rate: p.rate, totalAmount: p.totalAmount,
    isLocked: p.isLocked, loadId: p.loadId, legId: p.legId, category: p.category, createdAt: p.createdAt,
    settlementId: p.settlementId,
  };
}
function normalizeCarrier(p: Doc<'loadCarrierPayables'>): ManualLine {
  return {
    _id: p._id, description: p.description, quantity: p.quantity, rate: p.rate, totalAmount: p.totalAmount,
    isLocked: p.isLocked, loadId: p.loadId, legId: p.legId, category: p.category, createdAt: p.createdAt,
    settlementId: p.settlementId,
  };
}

// ============================================================================
// FORWARD dual-write — scheduled from the legacy add/update/remove mutations.
// ============================================================================
//
// Upsert-or-void semantics keep the mirror consistent across the full lifecycle:
//   • line created / edited → (re)insert a fresh mirrored payItem
//   • line deleted or no longer MANUAL → void the mirror
// Idempotent: an unchanged line that already has a matching mirror is a no-op.

export const syncManualPayItem = internalMutation({
  args: {
    workosOrgId: v.string(),
    table: v.union(v.literal('loadPayables'), v.literal('loadCarrierPayables')),
    payableId: v.string(),
  },
  handler: async (ctx, args) => {
    const now = Date.now();
    const runId = `manual-sync:${now}`;
    const existing = await existingImports(ctx, args.workosOrgId, args.payableId);

    const raw =
      args.table === 'loadPayables'
        ? await ctx.db.get(args.payableId as Id<'loadPayables'>)
        : await ctx.db.get(args.payableId as Id<'loadCarrierPayables'>);
    const isManual = raw != null && raw.sourceType === 'MANUAL';

    // Deleted or no longer a manual line → void the mirror, EXCEPT any already
    // frozen on a finalized settlement (it was paid; leave it on that statement).
    if (!isManual) {
      let voided = 0;
      let keptFinalized = 0;
      for (const e of existing) {
        if (await isOnFinalizedSettlement(ctx, e)) { keptFinalized++; continue; }
        await ctx.db.patch(e._id, { isVoided: true, voidedAt: now, voidReason: 'legacy manual line removed/changed', updatedAt: now });
        voided++;
      }
      return { action: 'voided' as const, voided, keptFinalized };
    }

    const comps = await resolveLegacyComponents(ctx, args.workosOrgId);
    if (!comps) return { error: 'missing LEGACY_DEDUCTION / LEGACY_MANUAL components' as const };

    const line = args.table === 'loadPayables'
      ? normalizeDriver(raw as Doc<'loadPayables'>)
      : normalizeCarrier(raw as Doc<'loadCarrierPayables'>);
    const payeeType = args.table === 'loadPayables' ? 'DRIVER' as const : 'CARRIER' as const;
    const payeeId = args.table === 'loadPayables'
      ? (raw as Doc<'loadPayables'>).driverId as string | undefined
      : (raw as Doc<'loadCarrierPayables'>).carrierPartnershipId as string;
    if (!payeeId) return { action: 'skipped' as const, reason: 'no-payee' };

    const comp = line.totalAmount < 0 ? comps.deductionComp : comps.manualComp;
    const desiredAmount = rawCents(centsFromNumber(Math.abs(line.totalAmount), 'USD'));

    // Unchanged? single mirror already matching → no-op.
    if (existing.length === 1) {
      const e = existing[0];
      if (e.componentId === comp._id && e.amountCents === desiredAmount && e.description === line.description) {
        return { action: 'unchanged' as const };
      }
    }

    // Supersede any prior mirror, EXCEPT one frozen on a finalized settlement.
    let supersededFinalized = false;
    for (const e of existing) {
      if (await isOnFinalizedSettlement(ctx, e)) { supersededFinalized = true; continue; }
      await ctx.db.patch(e._id, { isVoided: true, voidedAt: now, voidReason: 'superseded by manual re-sync', updatedAt: now });
    }
    // The prior mirror is frozen/paid on a finalized statement: don't insert a
    // fresh full-amount mirror (that would double-pay). A post-payment correction
    // must be an explicit adjustment on an open period.
    if (supersededFinalized) return { action: 'skipped-finalized' as const };

    const natural = await anchorFor(ctx, line);
    const { anchor, rolledForward } = await resolveForwardAnchor(ctx, payeeType, payeeId, natural, now);
    await ctx.db.insert('payItems', buildManualRow(args.workosOrgId, payeeType, payeeId, line, comp, anchor, args.table, now, runId));
    return { action: 'upserted' as const, rolledForward };
  },
});

// ============================================================================
// BACKFILL — one-shot import of existing manual lines. Dry-run by default.
// ============================================================================

export const backfillManualPayItems = internalMutation({
  args: { workosOrgId: v.string(), dryRun: v.optional(v.boolean()) },
  handler: async (ctx, args) => {
    const dryRun = args.dryRun ?? true;
    const now = Date.now();
    const runId = `manual-backfill:${now}`;

    const comps = await resolveLegacyComponents(ctx, args.workosOrgId);
    if (!comps) return { error: 'missing LEGACY_DEDUCTION / LEGACY_MANUAL components — seed them first' };

    let inserted = 0;
    let skipped = 0;
    const byComponent: Record<string, { count: number; sumUsd: number }> = {};

    const importOne = async (line: ManualLine, payeeType: 'DRIVER' | 'CARRIER', payeeId: string, table: ManualTable) => {
      const already = await existingImports(ctx, args.workosOrgId, line._id);
      if (already.length > 0) { skipped++; return; }
      const comp = line.totalAmount < 0 ? comps.deductionComp : comps.manualComp;
      const magnitude = Math.abs(line.totalAmount);
      byComponent[comp.code] ??= { count: 0, sumUsd: 0 };
      byComponent[comp.code].count++;
      byComponent[comp.code].sumUsd += magnitude;
      if (dryRun) return;
      const anchor = await anchorFor(ctx, line);
      await ctx.db.insert('payItems', buildManualRow(args.workosOrgId, payeeType, payeeId, line, comp, anchor, table, now, runId));
      inserted++;
    };

    const driverPayables = await ctx.db
      .query('loadPayables')
      .withIndex('by_org', (q) => q.eq('workosOrgId', args.workosOrgId))
      .collect();
    for (const p of driverPayables) {
      if (p.sourceType !== 'MANUAL' || !p.driverId) continue;
      await importOne(normalizeDriver(p), 'DRIVER', p.driverId as string, 'loadPayables');
    }

    const carrierPayables = await ctx.db
      .query('loadCarrierPayables')
      .withIndex('by_org', (q) => q.eq('workosOrgId', args.workosOrgId))
      .collect();
    for (const p of carrierPayables) {
      if (p.sourceType !== 'MANUAL') continue;
      await importOne(normalizeCarrier(p), 'CARRIER', p.carrierPartnershipId as string, 'loadCarrierPayables');
    }

    return { dryRun, inserted, skipped, byComponent };
  },
});
