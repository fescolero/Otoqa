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
  asMicroCents,
  rawCents,
  rawMicroCents,
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
import {
  applyPostCalcRules,
  CAP_OFFSET_COMPONENT_CODE,
  type PostCalcBasisItem,
} from './applyPostCalcRules';
import type { ChargeComponentLite, PayProfile } from './calculatePay';
import { specToPayItemRow } from './calculatePayForLeg';
import { CHARGE_COMPONENT_TEMPLATES } from './chargeComponentsCatalog';

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

// ── post-calc rules (period-level caps / guarantees) ────────────────────────
//
// The aggregator is the only pass that sees ALL of a period's lines, so
// period-scoped rules (weekly H&W hour caps, minimum guarantees) run here.
// Emitted items are synced into `payItems` idempotently by their stable
// sourceRef.id — recomputes patch in place, rules that stop firing void their
// stale rows, and reviewer-locked rows are never touched. Because every
// aggregation run recomputes from the current basis, a cap self-corrects
// whenever shift hours change.

/** The payee's default/always-active profile — the one whose postCalcRules
 *  govern the period. Mirrors calculateSessionPay's fallback resolution
 *  (jurisdiction/distance strategies need a leg, which a period doesn't have). */
async function resolvePostCalcProfile(
  ctx: MutationCtx,
  params: { workosOrgId: string; payeeType: 'CARRIER' | 'DRIVER'; payeeId: string; periodEnd: number },
): Promise<Doc<'payProfiles'> | null> {
  const assignments = await ctx.db
    .query('payeeProfileAssignments')
    .withIndex('by_payee_active', (q) =>
      q.eq('payeeType', params.payeeType).eq('payeeId', params.payeeId).eq('isActive', true),
    )
    .collect();
  const effective = assignments.filter(
    (a) =>
      (a.effectiveStart === undefined || a.effectiveStart <= params.periodEnd) &&
      (a.effectiveEnd === undefined || a.effectiveEnd >= params.periodEnd),
  );
  const chosen = effective.find((a) => a.isDefault)
    ?? effective.find((a) => a.selectionStrategy === 'ALWAYS_ACTIVE');
  if (!chosen) return null;
  const profile = await ctx.db.get(chosen.profileId);
  if (!profile || !profile.isActive || profile.workosOrgId !== params.workosOrgId) return null;
  return profile;
}

/** Get-or-seed the org's PAY_CAP_OFFSET component so cap rules work for orgs
 *  created before the template existed. Idempotent by (org, code). */
async function ensureCapOffsetComponent(
  ctx: MutationCtx,
  workosOrgId: string,
  now: number,
): Promise<Doc<'chargeComponents'> | null> {
  const existing = await ctx.db
    .query('chargeComponents')
    .withIndex('by_org_code', (q) => q.eq('workosOrgId', workosOrgId).eq('code', CAP_OFFSET_COMPONENT_CODE))
    .first();
  if (existing) return existing;
  const template = CHARGE_COMPONENT_TEMPLATES.find((t) => t.code === CAP_OFFSET_COMPONENT_CODE);
  if (!template) return null;
  // pairCode is seeder-only metadata, not a chargeComponents field.
  const { pairCode, ...rest } = template;
  void pairCode;
  const id = await ctx.db.insert('chargeComponents', {
    ...rest,
    workosOrgId,
    createdAt: now,
    updatedAt: now,
    createdBy: 'system:post-calc',
  });
  return ctx.db.get(id);
}

/**
 * Recompute the period's post-calc items and reconcile them into `payItems`.
 * Returns the item set the rollup should use (basis + live post-calc rows)
 * plus any variances. `keptDocs` is the aggregator's relevance-filtered window.
 */
async function syncPostCalcItems(
  ctx: MutationCtx,
  params: {
    workosOrgId: string;
    payeeType: 'CARRIER' | 'DRIVER';
    payeeId: string;
    periodStart: number;
    periodEnd: number;
    userId: string;
    now: number;
  },
  keptDocs: Array<Doc<'payItems'>>,
  compCache: Map<string, Doc<'chargeComponents'> | null>,
): Promise<{ kept: Array<Doc<'payItems'>>; variances: Variance[] }> {
  const variances: Variance[] = [];
  const priorPostCalc = keptDocs.filter(
    (d) => d.kind === 'POST_CALC_ADJUSTMENT' && d.sourceRef.kind === 'POST_CALC_RULE',
  );
  const basisDocs = keptDocs.filter((d) => !priorPostCalc.includes(d));

  const profile = await resolvePostCalcProfile(ctx, params);
  const postCalcRules = profile?.postCalcRules ?? [];
  // Fast path: nothing configured and nothing stale to clean up.
  if (postCalcRules.length === 0 && priorPostCalc.length === 0) {
    return { kept: keptDocs, variances };
  }

  // Component map for the pure pass: each rule's component + the offset.
  const components = new Map<string, ChargeComponentLite>();
  const addComponent = (c: Doc<'chargeComponents'> | null) => {
    if (c) components.set(c._id, { _id: c._id, code: c.code, bucket: c.bucket, sign: c.sign });
  };
  const getCached = async (componentId: Id<'chargeComponents'>) => {
    const key = componentId as string;
    let c = compCache.get(key);
    if (c === undefined) { c = (await ctx.db.get(componentId)) ?? null; compCache.set(key, c); }
    return c;
  };
  let emitted: ReturnType<typeof applyPostCalcRules>['emittedPayItems'] = [];
  if (profile && postCalcRules.length > 0) {
    for (const rule of postCalcRules) addComponent(await getCached(rule.componentId));
    if (postCalcRules.some((r) => r.kind === 'MAXIMUM_CAP_WEEKLY' || r.kind === 'MAXIMUM_CAP_PERIOD')) {
      addComponent(await ensureCapOffsetComponent(ctx, params.workosOrgId, params.now));
    }

    const basisItems: PostCalcBasisItem[] = [];
    for (const d of basisDocs) {
      const comp = await getCached(d.componentId);
      basisItems.push({
        kind: d.kind as PostCalcBasisItem['kind'],
        componentId: d.componentId as string,
        componentSign: comp?.sign ?? 'CREDIT',
        quantity: d.quantity,
        rateMicroCents: asMicroCents(d.rateMicroCents),
        amountCents: asCents(d.amountCents),
        periodAnchorAt: d.periodAnchorAt,
      });
    }

    const profileArg: PayProfile = {
      _id: profile._id,
      workosOrgId: profile.workosOrgId,
      name: profile.name,
      payeeType: profile.payeeType as 'DRIVER' | 'CARRIER',
      currency: profile.currency,
      postCalcRules: profile.postCalcRules?.map((r) => ({
        name: r.name,
        kind: r.kind,
        componentId: r.componentId as string,
        thresholdCents: r.thresholdCents !== undefined ? asCents(r.thresholdCents) : undefined,
        thresholdQty: r.thresholdQty,
        multiplierBps: r.multiplierBps,
        sortOrder: r.sortOrder,
      })),
      isDefault: profile.isDefault,
      isActive: profile.isActive,
    };
    const result = applyPostCalcRules({
      payeeType: params.payeeType,
      payeeId: params.payeeId,
      periodStart: params.periodStart,
      periodEnd: params.periodEnd,
      profile: profileArg,
      payItems: basisItems,
      components,
    });
    emitted = result.emittedPayItems;
    for (const w of result.warnings) {
      variances.push({ level: w.level, code: w.code, message: w.message });
    }
  }

  // Reconcile emitted specs against the window's live post-calc rows.
  const kept: Array<Doc<'payItems'>> = [...basisDocs];
  const priorByKey = new Map<string, Doc<'payItems'>>();
  for (const d of priorPostCalc) {
    // Rows without a sourceRef.id can't be re-keyed; treat as stale below.
    if (d.sourceRef.id) priorByKey.set(d.sourceRef.id, d);
  }
  for (const spec of emitted) {
    const key = spec.sourceRef.id!;
    const match = priorByKey.get(key);
    if (match) {
      priorByKey.delete(key);
      if (match.isLocked) {
        // A reviewer edited/locked this adjustment — their correction wins.
        kept.push(match);
        continue;
      }
      const patch: Partial<Doc<'payItems'>> = {};
      if (match.amountCents !== rawCents(spec.amountCents)) patch.amountCents = rawCents(spec.amountCents);
      if (match.quantity !== spec.quantity) patch.quantity = spec.quantity;
      if (match.rateMicroCents !== rawMicroCents(spec.rateMicroCents)) patch.rateMicroCents = rawMicroCents(spec.rateMicroCents);
      if (match.description !== spec.description) patch.description = spec.description;
      if (match.periodAnchorAt !== spec.periodAnchorAt) patch.periodAnchorAt = spec.periodAnchorAt;
      if ((match.componentId as string) !== spec.componentId) patch.componentId = spec.componentId as Id<'chargeComponents'>;
      if (Object.keys(patch).length > 0) {
        await ctx.db.patch(match._id, { ...patch, updatedAt: params.now });
        kept.push({ ...match, ...patch });
      } else {
        kept.push(match);
      }
    } else {
      const row = specToPayItemRow(spec, params.workosOrgId, params.userId, params.now);
      const id = await ctx.db.insert('payItems', row);
      const doc = await ctx.db.get(id);
      if (doc) kept.push(doc);
    }
  }
  // Anything left is stale — its rule stopped firing or was removed.
  for (const stale of priorByKey.values()) {
    if (stale.isLocked) { kept.push(stale); continue; }
    await ctx.db.patch(stale._id, {
      isVoided: true, voidedAt: params.now,
      voidReason: 'post-calc recompute — rule no longer applies', updatedAt: params.now,
    });
  }
  for (const stale of priorPostCalc) {
    if (!stale.sourceRef.id && !stale.isLocked) {
      await ctx.db.patch(stale._id, {
        isVoided: true, voidedAt: params.now,
        voidReason: 'post-calc recompute — unkeyed row', updatedAt: params.now,
      });
    } else if (!stale.sourceRef.id && stale.isLocked) {
      kept.push(stale);
    }
  }

  return { kept, variances };
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

  // 3b. Post-calc rules (weekly caps, minimum guarantees) — recompute from the
  //     period's basis items and reconcile the emitted adjustment rows into
  //     payItems. Idempotent: unchanged rows are untouched, so repeated cron
  //     ticks don't churn the ledger.
  const compCache = new Map<string, Doc<'chargeComponents'> | null>();
  const postCalc = await syncPostCalcItems(
    ctx,
    {
      workosOrgId: params.workosOrgId, payeeType: params.payeeType, payeeId: params.payeeId,
      periodStart: params.periodStart, periodEnd: params.periodEnd, userId: params.userId, now,
    },
    keptDocs,
    compCache,
  );
  const finalDocs = postCalc.kept;
  crossVariances.push(...postCalc.variances);
  if (finalDocs.length === 0 && !existing) {
    return { action: 'empty', settlementId: undefined, statementNumber: undefined, itemCount: 0, netCents: serializeCents(ZERO_CENTS) };
  }

  // 4. Join chargeComponents (cached) → build RollupItems.
  const rollupItems: RollupItem[] = [];
  let currency: Currency | null = null;
  for (const it of finalDocs) {
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

  // 7. Convergent settlementId stamping (finalDocs: basis + live post-calc
  //    rows; voided post-calc rows fall out here and detach below).
  const keptIds = new Set(finalDocs.map((k) => k._id as string));
  for (const it of finalDocs) {
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

  return { action, settlementId, statementNumber, itemCount: finalDocs.length, netCents: serializeCents(asCents(totals.netCents)) };
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
    let i = 0;
    for (const p of partnerships) {
      await ctx.scheduler.runAfter(i * 150, internal.payEngine.aggregateSettlement.aggregateCarrierSettlement, {
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
    let i = 0;
    for (const d of drivers) {
      if (d.isDeleted) continue;
      await ctx.scheduler.runAfter(i * 120, internal.payEngine.aggregateSettlement.aggregateDriverSettlement, {
        workosOrgId: args.workosOrgId, payeeId: d._id as string,
        periodStart: args.periodStart, periodEnd: args.periodEnd, userId: args.userId,
      });
      i++;
    }
    return { scheduled: i };
  },
});
