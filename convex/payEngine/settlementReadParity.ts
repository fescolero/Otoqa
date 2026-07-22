// Read-adapter parity check (Milestone #4, validation phase).
//
// Before wiring the settlements dashboard to read the new ledger, prove the
// new ledger + adapter produce the SAME settlement financials as legacy for the
// same driver+period. The trick: run BOTH sides through the shared
// summarizeLines() so any difference is the LEDGER, not the formula.
//
// Compares RAW vs RAW (legacy originalTotalAmount pre-edit; new payItems are
// raw — the reviewer-edit layer M5.2 isn't applied to this data yet), so a
// clean result is "the ledgers agree on the raw calc". Reviewer edits are
// surfaced separately, not counted as calc mismatches. Read-only.
import { internalQuery } from '../_generated/server';
import { v } from 'convex/values';
import type { Doc } from '../_generated/dataModel';
import { summarizeLines, type PayableCategory } from '../lib/settlementShared';

const CENTS = 0.01;

/** Map a new-ledger payItem to the legacy line shape summarizeLines expects. */
function payItemToLine(it: Doc<'payItems'>, bucket: string) {
  const category: PayableCategory =
    bucket === 'DEDUCTION' ? 'DEDUCTION' : bucket === 'REIMBURSEMENT' ? 'REIMBURSEMENT' : 'EARNING';
  const dollars = Number(it.amountCents) / 100; // stored as magnitude
  return {
    category,
    totalAmount: category === 'DEDUCTION' ? -dollars : dollars, // legacy expects signed
    sourceType: (it.kind === 'MANUAL_ADJUSTMENT' ? 'MANUAL' : 'SYSTEM') as 'MANUAL' | 'SYSTEM',
    quantity: it.quantity,
    loadId: it.sourceRef.loadId,
  };
}

/** Map a legacy loadPayable to a RAW (pre-edit) line. */
function legacyPayableToRawLine(p: Doc<'loadPayables'>) {
  return {
    category: p.category as PayableCategory | undefined,
    totalAmount: p.originalTotalAmount ?? p.totalAmount, // RAW
    sourceType: p.sourceType,
    quantity: p.originalQuantity ?? p.quantity,
    loadId: p.loadId,
    isRebillable: p.isRebillable,
  };
}

export const validateDriverReadParity = internalQuery({
  args: { workosOrgId: v.string() },
  handler: async (ctx, args) => {
    // Component bucket + code lookup (cache).
    const compCache = new Map<string, { bucket: string; code: string }>();
    const compOf = async (componentId: string): Promise<{ bucket: string; code: string }> => {
      const hit = compCache.get(componentId);
      if (hit !== undefined) return hit;
      const c = await ctx.db.get(componentId as Doc<'payItems'>['componentId']);
      const info = { bucket: c?.bucket ?? '', code: c?.code ?? '?' };
      compCache.set(componentId, info);
      return info;
    };

    const legacySettlements = await ctx.db
      .query('driverSettlements')
      .withIndex('by_org_status', (q) => q.eq('workosOrgId', args.workosOrgId))
      .collect();

    const rows: Array<{
      driverId: string; periodStart: number; legacyStatus: string;
      legacyRawNet: number; newNet: number; deltaNet: number;
      legacyEarn: number; newEarn: number; legacyDeduct: number; newDeduct: number;
      newByCode: Record<string, number>; newSessions: number; legacyLoads: number;
      edited: boolean; verdict: string;
    }> = [];

    for (const s of legacySettlements as Doc<'driverSettlements'>[]) {
      // Legacy RAW lines for this settlement.
      const legacyPayables = await ctx.db
        .query('loadPayables')
        .withIndex('by_settlement', (q) => q.eq('settlementId', s._id))
        .collect();
      if (legacyPayables.length === 0) continue;
      const edited = legacyPayables.some((p) => p.editedAt != null);
      const legacySummary = summarizeLines(legacyPayables.map(legacyPayableToRawLine));

      // New-ledger payItems for the same driver + period window.
      const newItemsAll = await ctx.db
        .query('payItems')
        .withIndex('by_payee_period', (q) =>
          q.eq('payeeType', 'DRIVER').eq('payeeId', s.driverId as string)
            .gte('periodAnchorAt', s.periodStart).lte('periodAnchorAt', s.periodEnd))
        .collect();
      const newItems = newItemsAll.filter((it) => !it.isVoided);
      const newLines = [];
      const newByCode: Record<string, number> = {};
      let newSessions = 0;
      for (const it of newItems) {
        const info = await compOf(it.componentId as string);
        newLines.push(payItemToLine(it, info.bucket));
        const signed = info.bucket === 'DEDUCTION' ? -Number(it.amountCents) / 100 : Number(it.amountCents) / 100;
        newByCode[info.code] = Math.round(((newByCode[info.code] ?? 0) + signed) * 100) / 100;
        if (it.sourceRef.sessionId) newSessions++;
      }
      const newSummary = summarizeLines(newLines);

      const deltaNet = Math.round((newSummary.net - legacySummary.net) * 100) / 100;
      const verdict =
        newItems.length === 0 ? 'NEW_LEDGER_EMPTY'
        : Math.abs(deltaNet) <= CENTS ? 'RAW_PARITY'
        : 'RAW_MISMATCH';

      rows.push({
        driverId: s.driverId as string, periodStart: s.periodStart, legacyStatus: s.status,
        legacyRawNet: Math.round(legacySummary.net * 100) / 100,
        newNet: Math.round(newSummary.net * 100) / 100,
        deltaNet,
        legacyEarn: Math.round(legacySummary.earnTotal * 100) / 100,
        newEarn: Math.round(newSummary.earnTotal * 100) / 100,
        legacyDeduct: Math.round(legacySummary.deductTotal * 100) / 100,
        newDeduct: Math.round(newSummary.deductTotal * 100) / 100,
        newByCode, newSessions, legacyLoads: legacySummary.loadCount,
        edited, verdict,
      });
    }

    const histogram: Record<string, number> = {};
    for (const r of rows) histogram[r.verdict] = (histogram[r.verdict] ?? 0) + 1;
    rows.sort((a, b) => Math.abs(b.deltaNet) - Math.abs(a.deltaNet));

    return { settlements: rows.length, histogram, rows };
  },
});
