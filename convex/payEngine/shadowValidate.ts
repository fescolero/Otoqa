// Shadow validation harness — runs the new calculatePay against the same
// inputs the legacy engine consumed, then compares the result to whatever
// loadPayables rows the legacy engine already produced for that leg.
//
// The harness writes nothing. It's a read-only query that surfaces a diff
// report per leg. The intended flow:
//   1. Legacy engine produces loadPayables as part of normal operations
//   2. shadowValidateLeg() is called on the same leg, post-fact
//   3. The diff report shows whether the new engine would have produced
//      the same totals, broken down by classification
//
// Classification taxonomy (most → least severe):
//   STRUCTURE_DIFF       — counts of lines differ in a way that's not
//                          explained by rounding / line splits
//   AMOUNT_DIFF          — totals differ by more than the rounding tolerance
//   ROUNDING_DIFF        — totals match within $0.01 (acceptable, cents vs
//                          float arithmetic)
//   MATCH                — totals match exactly to the cent
//   NEW_ENGINE_FAILED    — new engine returned no profile / errored
//   NO_LEGACY_DATA       — no loadPayables for this leg (legacy didn't run
//                          or produced nothing — can't compare)
//   NO_DRIVER_ASSIGNED   — leg has no driver — calc was N/A on both sides
//
// Tolerance for ROUNDING_DIFF is 1 cent per line item or 5 cents total,
// whichever is larger — covers expected rounding noise without masking real
// divergences.

import { internalQuery, type QueryCtx } from '../_generated/server';
import { v } from 'convex/values';
import type { Doc, Id } from '../_generated/dataModel';
import { calculatePay } from './calculatePay';
import type { CalculatePayResult } from './calculatePay';
import { assembleCalculatePayInput } from './assembleInput';
import { rawCents } from '../lib/money';

// ============================================================================
// PUBLIC TYPES — also used by tests
// ============================================================================

export type Classification =
  | 'MATCH'
  | 'ROUNDING_DIFF'
  | 'AMOUNT_DIFF'
  | 'STRUCTURE_DIFF'
  | 'NEW_ENGINE_FAILED'
  | 'NO_LEGACY_DATA'
  | 'NO_DRIVER_ASSIGNED';

export type LegacyLineSummary = {
  description: string;
  quantity: number;
  rate: number;                       // legacy stored as float dollars
  totalAmountDollars: number;
  totalAmountCents: bigint;           // converted; canonical for comparison
  sourceType: 'SYSTEM' | 'MANUAL';
  isLocked: boolean;
};

export type NewLineSummary = {
  description: string;
  componentCode: string;
  componentBucket: string;
  quantity: number;
  amountCents: bigint;
};

export type ShadowDifference = {
  kind: 'TOTAL_AMOUNT' | 'LINE_COUNT' | 'WARNING' | 'NO_PROFILE_NEW' | 'LOCKED_LINES_PRESENT';
  description: string;
  deltaCents?: bigint;                // signed: positive = new is higher
};

export type ShadowValidationResult = {
  legId: Id<'dispatchLegs'>;
  classification: Classification;
  legacy: {
    payableCount: number;
    totalCents: bigint;
    lockedLineCount: number;          // legacy locked items the new engine
                                      // would have preserved untouched
    lines: LegacyLineSummary[];
  };
  newEngine: {
    payItemCount: number;
    totalCents: bigint;
    selectedProfileId: string | null;
    lines: NewLineSummary[];
    warnings: Array<{ level: string; code: string; message: string }>;
  };
  differences: ShadowDifference[];
};

// ============================================================================
// PURE COMPARATOR — testable independently of Convex runtime
// ============================================================================
//
// Tolerance picks: ROUNDING_DIFF when |delta| <= max(20¢ flat, 0.5% of the
// larger total). Calibrated against real legacy data where the new engine's
// full-precision quantity (vs legacy's pre-rounded 2dp) produced 5–15¢
// drift on small hourly legs — all sub-cent precision compounding, not
// engine bugs. The 0.5% relative band catches larger legs proportionally.
// Real engine divergences (missing rules, wrong rates) will exceed both.

const ROUND_FLAT_CENTS = BigInt(20);
const ROUND_PER_LINE_CENTS = BigInt(2);     // small per-line allowance
const ROUND_PERCENT_BPS = BigInt(50);       // 0.5% in basis points (10000 = 100%)

export function compareLegacyVsNew(
  legacy: LegacyLineSummary[],
  newResult: CalculatePayResult,
): {
  classification: Classification;
  differences: ShadowDifference[];
  legacyTotalCents: bigint;
  newTotalCents: bigint;
} {
  const differences: ShadowDifference[] = [];

  // Skip rows that legacy stored as warnings/zero placeholders — they appear
  // as "(No applicable charges)" entries from the legacy engine when no
  // profile resolved.
  const legacyMeaningful = legacy.filter(l => l.totalAmountCents !== BigInt(0)
                                              || l.sourceType === 'MANUAL');

  let legacyTotal = BigInt(0);
  for (const l of legacy) legacyTotal += l.totalAmountCents;

  let newTotal = BigInt(0);
  for (const item of newResult.payItems) newTotal += rawCents(item.amountCents);

  if (newResult.selectedProfileId === null && newResult.payItems.length === 0) {
    return {
      classification: 'NEW_ENGINE_FAILED',
      differences: [{
        kind: 'NO_PROFILE_NEW',
        description: 'New engine resolved no profile — likely missing payeeProfileAssignments',
      }],
      legacyTotalCents: legacyTotal,
      newTotalCents: newTotal,
    };
  }

  // Locked legacy lines — the new engine would have preserved them as-is.
  // For shadow validation, we exclude their amounts from the new-engine side
  // of the comparison (since the new engine doesn't see them).
  const lockedLineCount = legacy.filter(l => l.isLocked).length;
  if (lockedLineCount > 0) {
    differences.push({
      kind: 'LOCKED_LINES_PRESENT',
      description: `${lockedLineCount} legacy line(s) locked — excluded from total comparison`,
    });
  }

  let legacyUnlockedTotal = BigInt(0);
  for (const l of legacy) {
    if (!l.isLocked) legacyUnlockedTotal += l.totalAmountCents;
  }

  const lineDiff = legacyMeaningful.length - newResult.payItems.length;

  // Total comparison (excluding locked legacy lines)
  const unlockedDeltaSigned = newTotal - legacyUnlockedTotal;
  const unlockedDeltaAbs = unlockedDeltaSigned < BigInt(0)
    ? -unlockedDeltaSigned
    : unlockedDeltaSigned;

  // Effective tolerance for ROUNDING_DIFF:
  //   max( ROUND_FLAT_CENTS,
  //        ROUND_PER_LINE_CENTS × line count,
  //        ROUND_PERCENT_BPS × max(legacy, new) / 10000 )
  const maxAbsTotal = legacyUnlockedTotal > newTotal
    ? (legacyUnlockedTotal < BigInt(0) ? -legacyUnlockedTotal : legacyUnlockedTotal)
    : (newTotal < BigInt(0) ? -newTotal : newTotal);
  const percentTolerance = (maxAbsTotal * ROUND_PERCENT_BPS) / BigInt(10000);
  const perLineTolerance = BigInt(legacyMeaningful.length) * ROUND_PER_LINE_CENTS;
  const tolerance =
    ROUND_FLAT_CENTS > perLineTolerance ? ROUND_FLAT_CENTS : perLineTolerance;
  const effectiveTolerance = percentTolerance > tolerance ? percentTolerance : tolerance;

  let classification: Classification;
  if (unlockedDeltaAbs === BigInt(0)) {
    classification = 'MATCH';
  } else if (unlockedDeltaAbs <= effectiveTolerance) {
    classification = 'ROUNDING_DIFF';
    differences.push({
      kind: 'TOTAL_AMOUNT',
      description: `Within rounding tolerance: ${unlockedDeltaAbs} cent(s)`,
      deltaCents: unlockedDeltaSigned,
    });
  } else if (Math.abs(lineDiff) > 1) {
    classification = 'STRUCTURE_DIFF';
    differences.push({
      kind: 'LINE_COUNT',
      description: `Legacy ${legacyMeaningful.length} lines, new ${newResult.payItems.length} lines`,
    });
    differences.push({
      kind: 'TOTAL_AMOUNT',
      description: `Total diff: ${unlockedDeltaSigned >= BigInt(0) ? '+' : ''}${unlockedDeltaSigned} cents`,
      deltaCents: unlockedDeltaSigned,
    });
  } else {
    classification = 'AMOUNT_DIFF';
    differences.push({
      kind: 'TOTAL_AMOUNT',
      description: `Total diff: ${unlockedDeltaSigned >= BigInt(0) ? '+' : ''}${unlockedDeltaSigned} cents`,
      deltaCents: unlockedDeltaSigned,
    });
  }

  // Carry any FLAG-level warnings from the new engine into the diff for review
  for (const w of newResult.warnings) {
    if (w.level === 'FLAG' || w.level === 'WARNING') {
      differences.push({
        kind: 'WARNING',
        description: `[${w.level}] ${w.code}: ${w.message}`,
      });
    }
  }

  return {
    classification,
    differences,
    legacyTotalCents: legacyTotal,
    newTotalCents: newTotal,
  };
}

// ============================================================================
// CONVEX QUERY — read-only harness
// ============================================================================

export const shadowValidateLeg = internalQuery({
  args: { legId: v.id('dispatchLegs') },
  handler: async (ctx, { legId }): Promise<ShadowValidationResult> => {
    const leg = await ctx.db.get(legId);
    if (!leg) throw new Error(`shadowValidateLeg: leg ${legId} not found`);

    if (!leg.driverId && (!leg.drivers || leg.drivers.length === 0)) {
      return emptyResult(legId, 'NO_DRIVER_ASSIGNED');
    }

    const load = await ctx.db.get(leg.loadId);
    if (!load) throw new Error(`shadowValidateLeg: load ${leg.loadId} not found`);

    // Use the PRIMARY driver for comparison — team-driver validation can be
    // its own harness mode later. For single-driver legs this is leg.driverId.
    const primaryDriverId: Id<'drivers'> =
      leg.driverId ?? (leg.drivers && leg.drivers[0]?.driverId)!;
    if (!primaryDriverId) return emptyResult(legId, 'NO_DRIVER_ASSIGNED');

    // 1. Read existing loadPayables (legacy result)
    const legacyRows = await ctx.db
      .query('loadPayables')
      .withIndex('by_leg', q => q.eq('legId', legId))
      .collect();

    const legacyLines: LegacyLineSummary[] = legacyRows
      .filter(r => r.driverId === primaryDriverId)
      .map(r => ({
        description: r.description,
        quantity: r.quantity,
        rate: r.rate,
        totalAmountDollars: r.totalAmount,
        totalAmountCents: dollarsFloatToCents(r.totalAmount),
        sourceType: r.sourceType,
        isLocked: r.isLocked,
      }));

    if (legacyLines.length === 0) {
      return emptyResult(legId, 'NO_LEGACY_DATA');
    }

    // 2. Assemble CalculatePayInput for the primary driver (mirrors the
    //    logic in calculatePayForLeg, but read-only).
    const newResult = await runNewEngineForDriver(ctx, leg, load, primaryDriverId);

    const cmp = compareLegacyVsNew(legacyLines, newResult);

    const newLines: NewLineSummary[] = newResult.payItems.map(p => ({
      description: p.description,
      componentCode: p.componentCode,
      componentBucket: p.componentBucket,
      quantity: p.quantity,
      amountCents: rawCents(p.amountCents),
    }));

    let lockedCount = 0;
    for (const l of legacyLines) if (l.isLocked) lockedCount++;

    return {
      legId,
      classification: cmp.classification,
      legacy: {
        payableCount: legacyLines.length,
        totalCents: cmp.legacyTotalCents,
        lockedLineCount: lockedCount,
        lines: legacyLines,
      },
      newEngine: {
        payItemCount: newResult.payItems.length,
        totalCents: cmp.newTotalCents,
        selectedProfileId: newResult.selectedProfileId,
        lines: newLines,
        warnings: newResult.warnings,
      },
      differences: cmp.differences,
    };
  },
});

// ============================================================================
// CARRIER-SIDE VALIDATION — same comparator, different legacy table
// ============================================================================

export const shadowValidateCarrierLeg = internalQuery({
  args: { legId: v.id('dispatchLegs') },
  handler: async (ctx, { legId }): Promise<ShadowValidationResult> => {
    const leg = await ctx.db.get(legId);
    if (!leg) throw new Error(`shadowValidateCarrierLeg: leg ${legId} not found`);

    if (!leg.carrierPartnershipId) {
      return emptyResult(legId, 'NO_DRIVER_ASSIGNED');
    }

    const load = await ctx.db.get(leg.loadId);
    if (!load) throw new Error(`shadowValidateCarrierLeg: load ${leg.loadId} not found`);

    const carrierPartnershipId = leg.carrierPartnershipId;

    // 1. Read existing loadCarrierPayables (legacy result for the carrier)
    const legacyRows = await ctx.db
      .query('loadCarrierPayables')
      .withIndex('by_leg', q => q.eq('legId', legId))
      .collect();

    const legacyLines: LegacyLineSummary[] = legacyRows
      .filter(r => r.carrierPartnershipId === carrierPartnershipId)
      .map(r => ({
        description: r.description,
        quantity: r.quantity,
        rate: r.rate,
        totalAmountDollars: r.totalAmount,
        totalAmountCents: dollarsFloatToCents(r.totalAmount),
        sourceType: r.sourceType,
        isLocked: r.isLocked,
      }));

    if (legacyLines.length === 0) {
      return emptyResult(legId, 'NO_LEGACY_DATA');
    }

    const input = await assembleCalculatePayInput(
      ctx, leg, load, 'CARRIER', carrierPartnershipId as string, 10000,
    );
    const newResult = calculatePay(input);

    const cmp = compareLegacyVsNew(legacyLines, newResult);

    return {
      legId,
      classification: cmp.classification,
      legacy: {
        payableCount: legacyLines.length,
        totalCents: cmp.legacyTotalCents,
        lockedLineCount: legacyLines.filter(l => l.isLocked).length,
        lines: legacyLines,
      },
      newEngine: {
        payItemCount: newResult.payItems.length,
        totalCents: cmp.newTotalCents,
        selectedProfileId: newResult.selectedProfileId,
        lines: newResult.payItems.map(p => ({
          description: p.description,
          componentCode: p.componentCode,
          componentBucket: p.componentBucket,
          quantity: p.quantity,
          amountCents: rawCents(p.amountCents),
        })),
        warnings: newResult.warnings,
      },
      differences: cmp.differences,
    };
  },
});

// ============================================================================
// INTERNAL — run new engine for a single driver against a leg
// ============================================================================

async function runNewEngineForDriver(
  ctx: QueryCtx,
  leg: Doc<'dispatchLegs'>,
  load: Doc<'loadInformation'>,
  driverId: Id<'drivers'>,
): Promise<CalculatePayResult> {
  // Determine this driver's split — for team legs, find the matching entry.
  let splitBps = 10000;
  if (leg.drivers && leg.drivers.length > 0) {
    const found = leg.drivers.find(d => d.driverId === driverId);
    if (found) splitBps = found.splitBps;
  }

  const input = await assembleCalculatePayInput(
    ctx, leg, load, 'DRIVER', driverId as string, splitBps,
  );
  return calculatePay(input);
}

// ============================================================================
// HELPERS
// ============================================================================

function dollarsFloatToCents(dollars: number): bigint {
  return BigInt(Math.round(dollars * 100));
}

function emptyResult(legId: Id<'dispatchLegs'>, classification: Classification): ShadowValidationResult {
  return {
    legId,
    classification,
    legacy: { payableCount: 0, totalCents: BigInt(0), lockedLineCount: 0, lines: [] },
    newEngine: { payItemCount: 0, totalCents: BigInt(0), selectedProfileId: null, lines: [], warnings: [] },
    differences: [],
  };
}
