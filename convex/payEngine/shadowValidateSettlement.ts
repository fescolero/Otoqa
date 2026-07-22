// Shadow validation for the NEW settlement aggregator (Milestone 1, carriers).
// Read-only: compares the new `settlements` rollup against the live legacy
// `carrierSettlements` for the same carrier+period and classifies the result.
// Writes nothing — same contract as convex/payEngine/shadowValidate.ts.
//
// Tolerance + taxonomy mirror the per-leg shadow harness: legacy stores float
// dollars (accumulated, drifts a few cents on many-line statements), new stores
// exact int64 cents, so a small ROUNDING_DIFF band absorbs the float drift while
// real divergences (missing/extra lines, wrong rates) exceed it.
import { internalQuery, type QueryCtx } from '../_generated/server';
import { v } from 'convex/values';
import type { Doc, Id } from '../_generated/dataModel';

const ROUND_FLAT_CENTS = BigInt(20);
const ROUND_PERCENT_BPS = BigInt(50); // 0.5%

type Classification =
  | 'MATCH'
  | 'ROUNDING_DIFF'
  | 'AMOUNT_DIFF'
  | 'STRUCTURE_DIFF'
  | 'NO_NEW_DATA'
  | 'NO_LEGACY_DATA';

const absBig = (x: bigint): bigint => (x < BigInt(0) ? -x : x);
const dollarsToCents = (d: number | undefined): bigint => BigInt(Math.round((d ?? 0) * 100));
const centsToUsd = (c: bigint): number => Number(c) / 100;

async function compareOneCarrier(
  ctx: QueryCtx,
  payeeId: string,
  periodStart: number,
  periodEnd: number,
) {
  // NEW side
  const newSettlement = await ctx.db
    .query('settlements')
    .withIndex('by_payee_period', (q) =>
      q.eq('payeeType', 'CARRIER').eq('payeeId', payeeId).eq('periodStart', periodStart),
    )
    .first();

  // LEGACY side — match partnership + exact period, non-void.
  const legacyAll = await ctx.db
    .query('carrierSettlements')
    .withIndex('by_carrier_partnership', (q) =>
      q.eq('carrierPartnershipId', payeeId as Id<'carrierPartnerships'>),
    )
    .collect();
  const legacy = legacyAll.find(
    (s) => s.status !== 'VOID' && s.periodStart === periodStart && s.periodEnd === periodEnd,
  );

  const newNet = newSettlement ? newSettlement.totals.netCents : null;
  const legacyNet = legacy ? dollarsToCents(legacy.totalNet) : null;

  let classification: Classification;
  const differences: Array<{ kind: string; description: string; deltaCents: string }> = [];

  if (newNet === null && legacyNet === null) {
    classification = 'NO_LEGACY_DATA'; // neither side — nothing to compare
  } else if (newNet === null) {
    classification = 'NO_NEW_DATA';
  } else if (legacyNet === null) {
    classification = 'NO_LEGACY_DATA';
  } else {
    const delta = newNet - legacyNet;
    const maxAbs = absBig(newNet) > absBig(legacyNet) ? absBig(newNet) : absBig(legacyNet);
    const percentTol = (maxAbs * ROUND_PERCENT_BPS) / BigInt(10000);
    const tolerance = ROUND_FLAT_CENTS > percentTol ? ROUND_FLAT_CENTS : percentTol;

    if (delta === BigInt(0)) classification = 'MATCH';
    else if (absBig(delta) <= tolerance) classification = 'ROUNDING_DIFF';
    else classification = 'AMOUNT_DIFF';

    if (delta !== BigInt(0)) {
      differences.push({ kind: 'NET_AMOUNT', description: `net new−legacy`, deltaCents: delta.toString() });
    }
    // Secondary signals: gross + deductions (catch an offsetting split).
    const grossDelta = newSettlement!.totals.grossCents - dollarsToCents(legacy!.totalGross);
    if (grossDelta !== BigInt(0)) differences.push({ kind: 'GROSS_AMOUNT', description: 'gross new−legacy', deltaCents: grossDelta.toString() });
    const dedDelta = newSettlement!.totals.deductionsCents - dollarsToCents(legacy!.totalDeductions);
    if (dedDelta !== BigInt(0)) differences.push({ kind: 'DEDUCTIONS', description: 'deductions new−legacy', deltaCents: dedDelta.toString() });
  }

  return {
    payeeId,
    classification,
    newNetUsd: newNet !== null ? centsToUsd(newNet) : null,
    legacyNetUsd: legacyNet !== null ? centsToUsd(legacyNet) : null,
    newStatement: newSettlement?.statementNumber ?? null,
    legacyStatement: legacy?.statementNumber ?? null,
    newItemCount: newSettlement?.totals.itemCount ?? null,
    differences,
    newVariances: newSettlement?.variances ?? [],
  };
}

export const shadowValidateCarrierSettlement = internalQuery({
  args: { payeeId: v.string(), periodStart: v.number(), periodEnd: v.number() },
  handler: async (ctx, args) =>
    compareOneCarrier(ctx, args.payeeId, args.periodStart, args.periodEnd),
});

export const shadowValidateAllCarrierSettlements = internalQuery({
  args: { workosOrgId: v.string(), periodStart: v.number(), periodEnd: v.number() },
  handler: async (ctx, args) => {
    const partnerships = await ctx.db
      .query('carrierPartnerships')
      .withIndex('by_broker', (q) => q.eq('brokerOrgId', args.workosOrgId).eq('status', 'ACTIVE'))
      .collect();

    const histogram: Record<Classification, number> = {
      MATCH: 0, ROUNDING_DIFF: 0, AMOUNT_DIFF: 0, STRUCTURE_DIFF: 0, NO_NEW_DATA: 0, NO_LEGACY_DATA: 0,
    };
    const notable: Array<Awaited<ReturnType<typeof compareOneCarrier>>> = [];
    for (const p of partnerships) {
      const r = await compareOneCarrier(ctx, p._id as string, args.periodStart, args.periodEnd);
      histogram[r.classification]++;
      // Surface anything that isn't a clean match (or a both-empty no-op).
      if (r.classification !== 'MATCH' && !(r.classification === 'NO_LEGACY_DATA' && r.newNetUsd === null)) {
        notable.push(r);
      }
    }
    return { carriersScanned: partnerships.length, histogram, notable };
  },
});

// ── Driver per-shift validation ──────────────────────────────────────────────
// Drivers are session/shift paid, so a whole-settlement net compare is the wrong
// tool (legacy can have coverage gaps, and the new engine intentionally adds H&W
// fringe). This compares SHIFT BY SHIFT: it matches sessions, isolates the Base
// Wage line by rate (so the H&W line doesn't muddy the comparison), and reports:
//   - common shifts whose Base Wage matches legacy (to the cent) vs mismatches
//   - shifts the new engine pays but legacy never did (legacy coverage gaps)
//   - shifts legacy pays but the new engine doesn't (would be a NEW-engine gap)
const r2 = (n: number) => Math.round(n * 100) / 100;

async function validateOneDriver(
  ctx: QueryCtx,
  args: { driverId: string; periodStart: number; periodEnd: number },
) {
    const sessionCache = new Map<string, Doc<'driverSessions'> | null>();
    const getSession = async (sid: string) => {
      let s = sessionCache.get(sid);
      if (s === undefined) { s = (await ctx.db.get(sid as Id<'driverSessions'>)) ?? null; sessionCache.set(sid, s); }
      return s;
    };

    // NEW: payItems in the window, grouped by session → [{rateUsd, usd}]
    const newItems = await ctx.db
      .query('payItems')
      .withIndex('by_payee_period', (q) =>
        q.eq('payeeType', 'DRIVER').eq('payeeId', args.driverId)
          .gte('periodAnchorAt', args.periodStart).lte('periodAnchorAt', args.periodEnd))
      .collect();
    const newBySession = new Map<string, Array<{ rateUsd: number; usd: number }>>();
    for (const it of newItems) {
      if (it.isVoided || it.lifecycleStatus !== 'APPLIED') continue;
      const sid = it.sourceRef.sessionId as string | undefined;
      if (!sid) continue;
      const arr = newBySession.get(sid) ?? [];
      arr.push({ rateUsd: Number(it.rateMicroCents) / 100000, usd: Number(it.amountCents) / 100 });
      newBySession.set(sid, arr);
    }

    // LEGACY: driver session payables, windowed by session.startedAt (work-start)
    const legacyPays = await ctx.db
      .query('loadPayables')
      .withIndex('by_driver', (q) => q.eq('driverId', args.driverId as Id<'drivers'>))
      .collect();
    // Legacy stores the reviewer-FINAL amount + (when edited) the pre-edit
    // ORIGINAL. The new engine pays RAW, so compare new-raw vs legacy-RAW
    // (original if edited, else final) for true calc parity, and surface
    // reviewer-edited sessions separately — those legitimately differ in FINAL
    // pay (auto-timeout corrections, break deductions) until the new ledger gets
    // the same review/edit step.
    const legacyBySession = new Map<string, { rawUsd: number; finalUsd: number; rate: number; edited: boolean; autoTimeout: boolean }>();
    for (const p of legacyPays) {
      if (!p.sessionId) continue;
      const s = await getSession(p.sessionId as string);
      const start = s?.startedAt;
      if (start === undefined || start < args.periodStart || start > args.periodEnd) continue;
      const pe = p as { originalTotalAmount?: number; editedAt?: number };
      const e = legacyBySession.get(p.sessionId as string) ?? { rawUsd: 0, finalUsd: 0, rate: p.rate, edited: false, autoTimeout: false };
      e.rawUsd += pe.originalTotalAmount ?? p.totalAmount;
      e.finalUsd += p.totalAmount;
      if (pe.editedAt != null) e.edited = true;
      if (s?.endReason === 'auto_timeout') e.autoTimeout = true;
      legacyBySession.set(p.sessionId as string, e);
    }

    const TOL = 0.01;
    const baseWageMismatches: Array<Record<string, unknown>> = [];
    const legacyMissedShifts: Array<Record<string, unknown>> = [];
    const newMissedShifts: Array<Record<string, unknown>> = [];
    const editedSessions: Array<Record<string, unknown>> = [];
    let common = 0, matches = 0, legacyRawSum = 0, newBaseSum = 0, newExtraSum = 0;

    for (const [sid, leg] of legacyBySession) {
      const newArr = newBySession.get(sid);
      if (!newArr) { newMissedShifts.push({ sid, legacyRawUsd: r2(leg.rawUsd) }); continue; }
      const newBase = newArr.filter((x) => Math.abs(x.rateUsd - leg.rate) < TOL).reduce((s, x) => s + x.usd, 0);
      const newExtra = newArr.filter((x) => Math.abs(x.rateUsd - leg.rate) >= TOL).reduce((s, x) => s + x.usd, 0);
      common++; legacyRawSum += leg.rawUsd; newBaseSum += newBase; newExtraSum += newExtra;
      if (Math.abs(newBase - leg.rawUsd) < TOL) matches++;
      else baseWageMismatches.push({ sid, legacyRawUsd: r2(leg.rawUsd), newBaseUsd: r2(newBase), deltaUsd: r2(newBase - leg.rawUsd) });
      if (leg.edited) editedSessions.push({ sid, legacyRawUsd: r2(leg.rawUsd), legacyFinalUsd: r2(leg.finalUsd), autoTimeout: leg.autoTimeout });
    }
    for (const [sid, newArr] of newBySession) {
      if (legacyBySession.has(sid)) continue;
      const s = await getSession(sid);
      legacyMissedShifts.push({ sid, newUsd: r2(newArr.reduce((a, x) => a + x.usd, 0)), endReason: s?.endReason ?? null, minutes: s?.totalActiveMinutes ?? null });
    }

    return {
      commonShifts: common,
      baseWageMatches: matches,         // new-raw == legacy-raw (true calc parity)
      baseWageMismatches,               // real RAW calc divergence (should be empty)
      editedSessions,                   // legacy reviewer-edited; FINAL pay differs until new ledger is reviewed too
      legacyMissedShifts,               // new pays, legacy never did → new MORE complete
      newMissedShifts,                  // legacy pays, new doesn't → new-engine GAP (should be empty)
      totals: { legacyRawBaseUsd: r2(legacyRawSum), newRawBaseUsd: r2(newBaseSum), newHwFringeUsd: r2(newExtraSum) },
      verdict:
        newMissedShifts.length > 0 ? 'NEW_ENGINE_GAP'
        : baseWageMismatches.length > 0 ? 'BASE_WAGE_MISMATCH'
        : 'RAW_CALC_PARITY', // raw matches; remaining diffs are reviewer-edits / coverage
    };
}

export const shadowValidateDriverSettlement = internalQuery({
  args: { driverId: v.string(), periodStart: v.number(), periodEnd: v.number() },
  handler: async (ctx, args) => validateOneDriver(ctx, args),
});

export const shadowValidateAllDriverSettlements = internalQuery({
  args: { workosOrgId: v.string(), periodStart: v.number(), periodEnd: v.number() },
  handler: async (ctx, args) => {
    const drivers = await ctx.db
      .query('drivers')
      .withIndex('by_organization', (q) => q.eq('organizationId', args.workosOrgId))
      .collect();
    const verdicts: Record<string, number> = {};
    const notable: Array<Record<string, unknown>> = [];
    let driversWithData = 0;
    for (const d of drivers) {
      if (d.isDeleted) continue;
      const r = await validateOneDriver(ctx, { driverId: d._id as string, periodStart: args.periodStart, periodEnd: args.periodEnd });
      // skip drivers with nothing in this window
      if (r.commonShifts === 0 && r.legacyMissedShifts.length === 0 && r.newMissedShifts.length === 0) continue;
      driversWithData++;
      verdicts[r.verdict] = (verdicts[r.verdict] ?? 0) + 1;
      if (r.verdict === 'NEW_ENGINE_GAP' || r.verdict === 'BASE_WAGE_MISMATCH') {
        notable.push({ driverId: d._id, name: `${d.firstName ?? ''} ${d.lastName ?? ''}`.trim(), verdict: r.verdict, baseWageMismatches: r.baseWageMismatches, newMissedShifts: r.newMissedShifts });
      }
    }
    return { driversScanned: drivers.length, driversWithData, verdicts, notable };
  },
});
