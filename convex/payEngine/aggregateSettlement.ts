// Settlement aggregator (NEW pay engine) — rolls `payItems` into the new
// `settlements` table. Milestone 1: CARRIERS only, in SHADOW (parallel to the
// live legacy `carrierSettlements`; nothing here is read by the legacy UI).
//
// Design notes / invariants:
//  - `payItems.amountCents` is an UNSIGNED magnitude; direction comes from the
//    item's `chargeComponents.bucket` + `sign`, never from the numeric sign.
//    The pure `rollupSettlementTotals` below buckets by that, and is unit-tested.
//  - Totals are FULLY RECOMPUTED from the current non-voided payItem set on
//    every run (never incremented), so re-running is idempotent and naturally
//    absorbs voids/supersedes from a leg recalc that ran in between.
//  - All money math goes through convex/lib/money.ts (bigint cents). No floats.
//  - Period windowing uses `payItems.periodAnchorAt` (work-start, after M0).
import { internalMutation, type MutationCtx } from '../_generated/server';
import { internal } from '../_generated/api';
import { v } from 'convex/values';
import type { Doc, Id } from '../_generated/dataModel';
import {
  asCents,
  rawCents,
  ZERO_CENTS,
  sumCents,
  negate,
  isNegative,
  serializeCents,
  type Cents,
  type Currency,
} from '../lib/money';
import { nextStatementNumber, cadenceFromPaymentTerms } from '../lib/settlementShared';
import { FINALIZED_SETTLEMENT_STATUSES as LOCKED_STATUSES } from './schema';

export type Variance = {
  level: 'INFO' | 'WARNING' | 'FLAG';
  code: string;
  message: string;
  payItemId?: Id<'payItems'>;
};

/** Minimal shape the pure rollup needs — component info already joined in. */
export interface RollupItem {
  id: Id<'payItems'>;
  componentId: Id<'chargeComponents'>;
  componentCode: string;
  bucket: string; // chargeComponents.bucket
  sign: 'CREDIT' | 'DEBIT';
  kind: string; // payItems.kind
  amountCents: Cents; // unsigned magnitude
  quantity: number;
  holdbackCents?: Cents;
  currency: Currency;
}

export interface RollupResult {
  totals: {
    earningsCents: bigint; bonusesCents: bigint; creditsCents: bigint; deductionsCents: bigint;
    taxWithholdingCents: bigint; garnishmentsCents: bigint; adjustmentsCents: bigint;
    grossCents: bigint; netCents: bigint; holdbackTotalCents: bigint; itemCount: number;
  };
  componentTotals: Array<{ componentId: Id<'chargeComponents'>; componentCode: string; bucket: string; quantity: number; amountCents: bigint; payItemCount: number }>;
  variances: Variance[];
}

/**
 * PURE rollup of payItems into settlement totals. No Convex ctx — fully testable.
 * Direction is taken ONLY from `bucket`/`sign`/`kind`, never the numeric sign of
 * `amountCents` (which is always an unsigned magnitude). Deductions/tax/
 * garnishments are stored as POSITIVE magnitudes and subtracted at `netCents`.
 */
export function rollupSettlementTotals(items: RollupItem[]): RollupResult {
  const acc: Record<string, Cents[]> = {
    earnings: [], bonuses: [], credits: [], deductions: [], taxWithholding: [], garnishments: [], adjustments: [],
  };
  const holdbacks: Cents[] = [];
  const netContribs: Cents[] = []; // independent net cross-check
  const variances: Variance[] = [];
  const compRollup = new Map<string, { componentId: Id<'chargeComponents'>; componentCode: string; bucket: string; quantity: number; amounts: Cents[]; payItemCount: number }>();

  for (const it of items) {
    const mag = it.amountCents;
    if (isNegative(mag)) {
      variances.push({ level: 'FLAG', code: 'NEGATIVE_AMOUNT', message: `payItem ${it.id} has negative amountCents; engine emits magnitudes`, payItemId: it.id });
    }
    // A REVERSAL negates its component's natural contribution.
    const signedMag = it.kind === 'REVERSAL' ? negate(mag) : mag;

    if (it.kind === 'POST_CALC_ADJUSTMENT' || it.kind === 'MANUAL_ADJUSTMENT') {
      const adj = it.sign === 'DEBIT' ? negate(mag) : mag;
      acc.adjustments.push(adj);
      netContribs.push(adj);
    } else {
      switch (it.bucket) {
        case 'BASE_WAGE':
        case 'BASE_FRINGE':
        case 'ACCESSORIAL':
          acc.earnings.push(signedMag); netContribs.push(signedMag); break;
        case 'BONUS':
          acc.bonuses.push(signedMag); netContribs.push(signedMag); break;
        case 'REIMBURSEMENT':
          acc.credits.push(signedMag); netContribs.push(signedMag); break;
        case 'DEDUCTION':
          acc.deductions.push(signedMag); netContribs.push(negate(signedMag)); break;
        case 'TAX_WITHHOLDING':
          acc.taxWithholding.push(signedMag); netContribs.push(negate(signedMag)); break;
        case 'GARNISHMENT':
          acc.garnishments.push(signedMag); netContribs.push(negate(signedMag)); break;
        default:
          variances.push({ level: 'FLAG', code: 'UNKNOWN_BUCKET', message: `component ${it.componentCode} has unrecognized bucket ${it.bucket}`, payItemId: it.id });
          acc.earnings.push(signedMag); netContribs.push(signedMag);
      }
    }

    if (it.holdbackCents) holdbacks.push(it.holdbackCents);

    const rk = it.componentId as string;
    const r = compRollup.get(rk) ?? { componentId: it.componentId, componentCode: it.componentCode, bucket: it.bucket, quantity: 0, amounts: [], payItemCount: 0 };
    r.quantity += it.quantity;
    r.amounts.push(mag);
    r.payItemCount += 1;
    compRollup.set(rk, r);
  }

  const earningsCents = sumCents(acc.earnings);
  const bonusesCents = sumCents(acc.bonuses);
  const creditsCents = sumCents(acc.credits);
  const deductionsCents = sumCents(acc.deductions);
  const taxWithholdingCents = sumCents(acc.taxWithholding);
  const garnishmentsCents = sumCents(acc.garnishments);
  const adjustmentsCents = sumCents(acc.adjustments);
  const grossCents = sumCents([earningsCents, bonusesCents, creditsCents]);
  const netCents = sumCents([grossCents, negate(deductionsCents), negate(taxWithholdingCents), negate(garnishmentsCents), adjustmentsCents]);
  const holdbackTotalCents = sumCents(holdbacks);

  // Independent net cross-check — a sign/bucket bug makes these diverge.
  const netCheck = sumCents(netContribs);
  if (rawCents(netCheck) !== rawCents(netCents)) {
    variances.push({ level: 'FLAG', code: 'NET_RECONCILE', message: `net mismatch: bucketed ${serializeCents(netCents)} vs per-item ${serializeCents(netCheck)}` });
  }
  if (isNegative(netCents)) {
    variances.push({ level: 'WARNING', code: 'NEGATIVE_NET', message: 'settlement net is negative' });
  }

  return {
    totals: {
      earningsCents: rawCents(earningsCents), bonusesCents: rawCents(bonusesCents), creditsCents: rawCents(creditsCents),
      deductionsCents: rawCents(deductionsCents), taxWithholdingCents: rawCents(taxWithholdingCents), garnishmentsCents: rawCents(garnishmentsCents),
      adjustmentsCents: rawCents(adjustmentsCents), grossCents: rawCents(grossCents), netCents: rawCents(netCents),
      holdbackTotalCents: rawCents(holdbackTotalCents), itemCount: items.length,
    },
    componentTotals: [...compRollup.values()].map((r) => ({
      componentId: r.componentId, componentCode: r.componentCode, bucket: r.bucket,
      quantity: r.quantity, amountCents: rawCents(sumCents(r.amounts)), payItemCount: r.payItemCount,
    })),
    variances,
  };
}

// ── Convex wrapper ──────────────────────────────────────────────────────────


type PeriodSource =
  | { kind: 'PAY_PLAN'; payPlanId: Id<'payPlans'> }
  | { kind: 'CARRIER_TERMS'; paymentTerms?: string; cadence?: string };

type AggregationResult = {
  action: 'created' | 'regenerated' | 'skipped-locked' | 'skipped-review-locked' | 'empty';
  settlementId?: Id<'settlements'>;
  statementNumber?: string;
  itemCount: number;
  netCents: string;
};

const RESULT_VALIDATOR = v.object({
  action: v.union(
    v.literal('created'), v.literal('regenerated'), v.literal('skipped-locked'),
    v.literal('skipped-review-locked'), v.literal('empty'),
  ),
  settlementId: v.optional(v.id('settlements')),
  statementNumber: v.optional(v.string()),
  itemCount: v.number(),
  netCents: v.string(),
});

const ARGS = {
  workosOrgId: v.string(),
  payeeId: v.string(), // carrierPartnershipId / driverId as a string (payItems.payeeId is a string)
  periodStart: v.number(),
  periodEnd: v.number(),
  userId: v.string(),
};

// Shared aggregation core — identical for carriers and drivers. Differs only in
// payeeType, statement-number scope, payPlanId, and periodSource (supplied by
// the thin wrappers below).
async function runAggregation(
  ctx: MutationCtx,
  params: {
    workosOrgId: string;
    payeeType: 'CARRIER' | 'DRIVER';
    payeeId: string;
    periodStart: number;
    periodEnd: number;
    userId: string;
    scope: 'CARRIER' | 'DRIVER';
    payPlanId?: Id<'payPlans'>;
    periodSource?: PeriodSource;
  },
): Promise<AggregationResult> {
  const now = Date.now();

  // 1. Status guard.
  const existing = await ctx.db
    .query('settlements')
    .withIndex('by_payee_period', (q) =>
      q.eq('payeeType', params.payeeType).eq('payeeId', params.payeeId).eq('periodStart', params.periodStart),
    )
    .first();
  if (existing) {
    if (LOCKED_STATUSES.has(existing.status)) {
      return { action: 'skipped-locked', settlementId: existing._id, statementNumber: existing.statementNumber, itemCount: existing.totals.itemCount, netCents: serializeCents(asCents(existing.totals.netCents)) };
    }
    if (existing.status === 'IN_REVIEW' && existing.reviewLock && existing.reviewLock.lockExpiresAt > now) {
      return { action: 'skipped-review-locked', settlementId: existing._id, statementNumber: existing.statementNumber, itemCount: existing.totals.itemCount, netCents: serializeCents(asCents(existing.totals.netCents)) };
    }
  }

  // 2. Read payItems in the period window (range on periodAnchorAt).
  const windowItems = await ctx.db
    .query('payItems')
    .withIndex('by_payee_period', (q) =>
      q.eq('payeeType', params.payeeType).eq('payeeId', params.payeeId)
        .gte('periodAnchorAt', params.periodStart).lte('periodAnchorAt', params.periodEnd),
    )
    .collect();

  const crossVariances: Variance[] = [];

  // 3. Relevance filter.
  const keptDocs: Array<Doc<'payItems'>> = [];
  for (const it of windowItems) {
    if (it.isVoided) continue;
    if (it.lifecycleStatus !== 'APPLIED') continue;
    if (it.settlementId && (!existing || it.settlementId !== existing._id)) {
      crossVariances.push({ level: 'WARNING', code: 'CROSS_SETTLEMENT_ITEM', message: `payItem ${it._id} is already on settlement ${it.settlementId}; excluded`, payItemId: it._id });
      continue;
    }
    keptDocs.push(it);
  }

  if (keptDocs.length === 0) {
    return { action: 'empty', settlementId: existing?._id, statementNumber: existing?.statementNumber, itemCount: 0, netCents: serializeCents(ZERO_CENTS) };
  }

  // 4. Join chargeComponents (cached) → build RollupItems.
  const compCache = new Map<string, Doc<'chargeComponents'> | null>();
  const rollupItems: RollupItem[] = [];
  let currency: Currency | null = null;
  for (const it of keptDocs) {
    const key = it.componentId as string;
    let comp = compCache.get(key);
    if (comp === undefined) { comp = (await ctx.db.get(it.componentId)) ?? null; compCache.set(key, comp); }
    currency = currency ?? it.currency;
    rollupItems.push({
      id: it._id, componentId: it.componentId,
      componentCode: comp?.code ?? 'UNKNOWN', bucket: comp?.bucket ?? 'BASE_WAGE', sign: comp?.sign ?? 'CREDIT',
      kind: it.kind, amountCents: asCents(it.amountCents), quantity: it.quantity,
      holdbackCents: it.holdback ? asCents(it.holdback.amountCents) : undefined, currency: it.currency,
    });
  }

  // 5. Pure rollup.
  const { totals, componentTotals, variances } = rollupSettlementTotals(rollupItems);
  const allVariances = [...crossVariances, ...variances];
  const resolvedCurrency: Currency = currency ?? 'USD';

  // 6. Insert or patch (full recompute).
  let settlementId: Id<'settlements'>;
  let statementNumber: string;
  let action: 'created' | 'regenerated';
  if (existing) {
    settlementId = existing._id;
    statementNumber = existing.statementNumber;
    action = 'regenerated';
    await ctx.db.patch(existing._id, {
      currency: resolvedCurrency, periodEnd: params.periodEnd, periodSource: params.periodSource, totals, componentTotals,
      variances: allVariances.length ? allVariances : undefined, updatedAt: now,
    });
  } else {
    statementNumber = await nextStatementNumber(ctx, { workosOrgId: params.workosOrgId, scope: params.scope });
    action = 'created';
    settlementId = await ctx.db.insert('settlements', {
      workosOrgId: params.workosOrgId, statementNumber, payeeType: params.payeeType, payeeId: params.payeeId,
      payPlanId: params.payPlanId, periodSource: params.periodSource, periodStart: params.periodStart, periodEnd: params.periodEnd,
      currency: resolvedCurrency, status: 'OPEN', totals, componentTotals,
      variances: allVariances.length ? allVariances : undefined,
      createdAt: now, updatedAt: now, createdBy: params.userId,
    });
  }

  // 7. Convergent settlementId stamping.
  const keptIds = new Set(keptDocs.map((k) => k._id as string));
  for (const it of keptDocs) {
    if (it.settlementId !== settlementId) await ctx.db.patch(it._id, { settlementId, updatedAt: now });
  }
  if (existing) {
    const previouslyOn = await ctx.db
      .query('payItems')
      .withIndex('by_settlement', (q) => q.eq('settlementId', settlementId))
      .collect();
    for (const it of previouslyOn) {
      if (!keptIds.has(it._id as string)) await ctx.db.patch(it._id, { settlementId: undefined, updatedAt: now });
    }
  }

  return { action, settlementId, statementNumber, itemCount: keptDocs.length, netCents: serializeCents(asCents(totals.netCents)) };
}

export const aggregateCarrierSettlement = internalMutation({
  args: ARGS,
  returns: RESULT_VALIDATOR,
  handler: async (ctx, args): Promise<AggregationResult> => {
    const partnership = (await ctx.db.get(args.payeeId as Id<'carrierPartnerships'>)) as Doc<'carrierPartnerships'> | null;
    const paymentTerms = partnership?.defaultPaymentTerms;
    const periodSource: PeriodSource = {
      kind: 'CARRIER_TERMS', paymentTerms,
      cadence: paymentTerms ? (cadenceFromPaymentTerms(paymentTerms) ?? undefined) : undefined,
    };
    return runAggregation(ctx, { ...args, payeeType: 'CARRIER', scope: 'CARRIER', payPlanId: undefined, periodSource });
  },
});

export const aggregateDriverSettlement = internalMutation({
  args: ARGS,
  returns: RESULT_VALIDATOR,
  handler: async (ctx, args): Promise<AggregationResult> => {
    const driver = (await ctx.db.get(args.payeeId as Id<'drivers'>)) as Doc<'drivers'> | null;
    const payPlanId = (driver?.payPlanId ?? undefined) as Id<'payPlans'> | undefined;
    const periodSource: PeriodSource | undefined = payPlanId ? { kind: 'PAY_PLAN', payPlanId } : undefined;
    return runAggregation(ctx, { ...args, payeeType: 'DRIVER', scope: 'DRIVER', payPlanId, periodSource });
  },
});

export const aggregateAllCarrierSettlements = internalMutation({
  args: { workosOrgId: v.string(), periodStart: v.number(), periodEnd: v.number(), userId: v.string() },
  returns: v.object({ scheduled: v.number() }),
  handler: async (ctx, args) => {
    const partnerships = await ctx.db
      .query('carrierPartnerships')
      .withIndex('by_broker', (q) => q.eq('brokerOrgId', args.workosOrgId).eq('status', 'ACTIVE'))
      .collect();
    // 400ms stagger: aggregations that CREATE a settlement contend on the
    // org-wide settlementCounters doc (nextStatementNumber read+patch), and
    // Convex Health showed OCC retries there at the previous 120-150ms
    // spacing. Generation is async/hourly, so the wider spread is free.
    let i = 0;
    for (const p of partnerships) {
      await ctx.scheduler.runAfter(i * 400, internal.payEngine.aggregateSettlement.aggregateCarrierSettlement, {
        workosOrgId: args.workosOrgId, payeeId: p._id as string,
        periodStart: args.periodStart, periodEnd: args.periodEnd, userId: args.userId,
      });
      i++;
    }
    return { scheduled: i };
  },
});

export const aggregateAllDriverSettlements = internalMutation({
  args: { workosOrgId: v.string(), periodStart: v.number(), periodEnd: v.number(), userId: v.string() },
  returns: v.object({ scheduled: v.number() }),
  handler: async (ctx, args) => {
    const drivers = await ctx.db
      .query('drivers')
      .withIndex('by_organization', (q) => q.eq('organizationId', args.workosOrgId))
      .collect();
    // 400ms stagger — same settlementCounters-contention rationale as the
    // carrier fan-out above.
    let i = 0;
    for (const d of drivers) {
      if (d.isDeleted) continue;
      await ctx.scheduler.runAfter(i * 400, internal.payEngine.aggregateSettlement.aggregateDriverSettlement, {
        workosOrgId: args.workosOrgId, payeeId: d._id as string,
        periodStart: args.periodStart, periodEnd: args.periodEnd, userId: args.userId,
      });
      i++;
    }
    return { scheduled: i };
  },
});
