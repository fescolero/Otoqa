// New-ledger READ ADAPTER (Milestone #4).
//
// Emits the SAME SettlementRow / getSettlementDetails shapes the settlements
// dashboard already consumes (see app/(app)/accounting/_components/settlements/
// settlement-meta.tsx), but sourced from the new settlements + payItems ledger
// instead of legacy driverSettlements + loadPayables. The dashboard swaps
// between legacy and these behind the `settlements_read_ledger` feature flag.
//
// Parity by construction: new payItems are converted to the legacy "line" shape
// and run through the SAME shared helpers legacy uses (summarizeLines,
// computeDriverBlockers, bucketForSettlement, resolveDriverPayBasis, …), so the
// numbers, buckets, and blockers are computed by identical code.
import { query } from '../_generated/server';
import type { QueryCtx } from '../_generated/server';
import { v } from 'convex/values';
import { paginationOptsValidator } from 'convex/server';
import type { Doc, Id } from '../_generated/dataModel';
import { FINALIZED_SETTLEMENT_STATUSES } from './schema';
import { requireCallerOrgId, assertCallerOwnsOrg } from '../lib/auth';
import {
  ageDays,
  applyAcknowledgements,
  bucketForSettlement,
  cadenceFromFrequency,
  cadenceFromPaymentTerms,
  computeCarrierBlockers,
  computeDriverBlockers,
  loadsForPayables,
  newWorkStartCaches,
  payDateFromLag,
  payDateFromTerms,
  resolveCarrierPayBasis,
  resolveDriverPayBasis,
  summarizeLines,
  unitsLabel,
  type PayableCategory,
  type PayBasisInfo,
} from '../lib/settlementShared';

const ACTIVE_ROW_CAP = 500;

// Per-org feature flag (featureFlags table) the dashboard reads to choose the
// settlements source. Absent/any-other value ⇒ legacy; 'new' ⇒ this adapter.
// Default is legacy — cutover is an explicit, per-org flip.
export const SETTLEMENTS_READ_LEDGER_FLAG = 'settlements_read_ledger';

// New lifecycle status → the legacy status the dashboard + bucket logic expect.
type NewStatus = Doc<'settlements'>['status'];
export function toLegacyStatus(s: NewStatus): 'DRAFT' | 'PENDING' | 'APPROVED' | 'PAID' | 'VOID' {
  switch (s) {
    case 'OPEN': return 'DRAFT';
    case 'IN_REVIEW': return 'PENDING';
    case 'VERIFIED':
    case 'SENT': return 'APPROVED';
    case 'PAID':
    case 'CLOSED': return 'PAID';
    case 'VOID': return 'VOID';
  }
}

/**
 * Authoritative net (dollars) straight off the materialized settlement totals.
 * Settled-bucket stat sums use this so they never re-collect a statement's
 * payItems. It EQUALS the read adapter's summarized net for all current data;
 * the two only diverge once TAX_WITHHOLDING / GARNISHMENT / REVERSAL items exist
 * (M6/M7), and `totals.netCents` is the correct value then (the aggregator
 * subtracts them at net; summarizeLines does not). See settlementReads.test.ts.
 */
function netUsdOf(s: Doc<'settlements'>): number {
  return Number(s.totals.netCents) / 100;
}

// A payItem projected into the legacy line shape that summarizeLines +
// computeDriverBlockers understand.
interface AdaptedLine {
  _id: string;
  category: PayableCategory;
  totalAmount: number;          // signed dollars (deductions negative)
  sourceType: 'SYSTEM' | 'MANUAL';
  quantity: number;
  loadId?: Id<'loadInformation'>;
  warningMessage?: string;
  sessionId?: Id<'driverSessions'>;
  receiptStorageId?: Id<'_storage'>;
  isRebillable?: boolean;
}

export function bucketToCategory(bucket: string): PayableCategory {
  return bucket === 'DEDUCTION' ? 'DEDUCTION' : bucket === 'REIMBURSEMENT' ? 'REIMBURSEMENT' : 'EARNING';
}

export interface AdapterCaches {
  drivers: Map<string, Doc<'drivers'> | null>;
  partnerships: Map<string, Doc<'carrierPartnerships'> | null>;
  payPlans: Map<string, Doc<'payPlans'> | null>;
  payBasis: Map<string, PayBasisInfo | null>;
  components: Map<string, string>; // componentId → bucket
  loads: ReturnType<typeof newWorkStartCaches>['loads'];
}
export const newAdapterCaches = (): AdapterCaches => ({
  drivers: new Map(), partnerships: new Map(), payPlans: new Map(), payBasis: new Map(),
  components: new Map(), loads: new Map(),
});

export async function bucketOf(ctx: QueryCtx, caches: AdapterCaches, componentId: string): Promise<string> {
  const hit = caches.components.get(componentId);
  if (hit !== undefined) return hit;
  const c = await ctx.db.get(componentId as Id<'chargeComponents'>);
  const b = c?.bucket ?? '';
  caches.components.set(componentId, b);
  return b;
}

/**
 * Live period window (accruing) — used for OPEN / IN_REVIEW settlements. Mirrors
 * the aggregator's relevance filter (aggregateSettlement.ts): only APPLIED items,
 * and never an item already stamped onto a DIFFERENT settlement (cross-settlement
 * exclusion), so a non-finalized row's preview net can't exceed the totals it
 * will freeze to. isVoided is filtered downstream in linesFromItems / payables.
 */
async function payItemsForPeriod(ctx: QueryCtx, settlement: Doc<'settlements'>): Promise<Doc<'payItems'>[]> {
  const items = await ctx.db
    .query('payItems')
    .withIndex('by_payee_period', (q) =>
      q.eq('payeeType', settlement.payeeType).eq('payeeId', settlement.payeeId)
        .gte('periodAnchorAt', settlement.periodStart).lte('periodAnchorAt', settlement.periodEnd))
    .collect();
  return items.filter(
    (it) =>
      it.lifecycleStatus === 'APPLIED' &&
      (it.settlementId == null || it.settlementId === settlement._id),
  );
}

/** Frozen membership — exactly the items the aggregator attached to this row. */
function payItemsOnSettlement(ctx: QueryCtx, settlementId: Id<'settlements'>): Promise<Doc<'payItems'>[]> {
  return ctx.db
    .query('payItems')
    .withIndex('by_settlement', (q) => q.eq('settlementId', settlementId).eq('isVoided', false))
    .collect();
}

/**
 * The payItems a settlement's lines/net are derived from. A finalized statement
 * is frozen to the exact set the aggregator stamped (so list, stats, and detail
 * all match `totals.netCents` and a post-approval line can't leak into it). An
 * OPEN / IN_REVIEW statement reads the live period window so accruals show
 * before the next aggregation stamps them.
 */
export function payItemsForSettlement(ctx: QueryCtx, settlement: Doc<'settlements'>): Promise<Doc<'payItems'>[]> {
  return FINALIZED_SETTLEMENT_STATUSES.has(settlement.status)
    ? payItemsOnSettlement(ctx, settlement._id)
    : payItemsForPeriod(ctx, settlement);
}

/** Project already-collected payItems into the legacy line shape. */
export async function linesFromItems(
  ctx: QueryCtx,
  caches: AdapterCaches,
  items: Doc<'payItems'>[],
): Promise<AdaptedLine[]> {
  const lines: AdaptedLine[] = [];
  for (const it of items) {
    if (it.isVoided) continue;
    const category = bucketToCategory(await bucketOf(ctx, caches, it.componentId as string));
    const dollars = Number(it.amountCents) / 100;
    const receiptStorageId =
      it.sourceData?._variant === 'TRIP_EXPENSE' ? it.sourceData.receiptStorageId : undefined;
    lines.push({
      _id: it._id,
      category,
      totalAmount: category === 'DEDUCTION' ? -dollars : dollars,
      sourceType: it.kind === 'MANUAL_ADJUSTMENT' ? 'MANUAL' : 'SYSTEM',
      quantity: it.quantity,
      loadId: it.sourceRef.loadId,
      warningMessage: it.warning,
      sessionId: it.sourceRef.sessionId,
      receiptStorageId: receiptStorageId as Id<'_storage'> | undefined,
    });
  }
  return lines;
}

/** Collect a settlement's items (frozen if finalized) and project them to lines. */
async function linesFor(ctx: QueryCtx, caches: AdapterCaches, settlement: Doc<'settlements'>): Promise<AdaptedLine[]> {
  return linesFromItems(ctx, caches, await payItemsForSettlement(ctx, settlement));
}

/** Project already-collected payItems into the detail-shape payable rows (driver + carrier). */
async function payablesFromItems(ctx: QueryCtx, caches: AdapterCaches, items: Doc<'payItems'>[]) {
  const payables = [];
  for (const it of items) {
    if (it.isVoided) continue;
    const category = bucketToCategory(await bucketOf(ctx, caches, it.componentId as string));
    const dollars = Number(it.amountCents) / 100;
    payables.push({
      _id: it._id,
      loadId: it.sourceRef.loadId,
      description: it.description,
      quantity: it.quantity,
      rate: Number(it.rateMicroCents) / 100000,
      totalAmount: category === 'DEDUCTION' ? -dollars : dollars,
      sourceType: (it.kind === 'MANUAL_ADJUSTMENT' ? 'MANUAL' : 'SYSTEM') as 'MANUAL' | 'SYSTEM',
      category,
      isLocked: it.isLocked,
      warningMessage: it.warning,
      createdAt: it.createdAt,
      edited: it.reviewerEdit != null,
    });
  }
  return payables;
}

/** One new-ledger settlement → the dashboard's SettlementRow (driver). */
async function enrichNewDriverSettlement(
  ctx: QueryCtx,
  settlement: Doc<'settlements'>,
  caches: AdapterCaches,
  options: { withBlockers: boolean },
) {
  const driverKey = settlement.payeeId;
  let driver = caches.drivers.get(driverKey);
  if (driver === undefined) {
    driver = ((await ctx.db.get(settlement.payeeId as Id<'drivers'>)) ?? null) as Doc<'drivers'> | null;
    caches.drivers.set(driverKey, driver);
  }

  const planId = settlement.payPlanId ?? driver?.payPlanId;
  let payPlan: Doc<'payPlans'> | null = null;
  if (planId) {
    const cached = caches.payPlans.get(planId as string);
    if (cached === undefined) {
      payPlan = (await ctx.db.get(planId)) ?? null;
      caches.payPlans.set(planId as string, payPlan);
    } else payPlan = cached;
  }

  let basisInfo = caches.payBasis.get(driverKey);
  if (basisInfo === undefined) {
    basisInfo = await resolveDriverPayBasis(ctx, settlement.payeeId as Id<'drivers'>);
    caches.payBasis.set(driverKey, basisInfo);
  }

  const lines = await linesFor(ctx, caches, settlement);
  const summary = summarizeLines(lines);

  let blockers: ReturnType<typeof computeDriverBlockers> = [];
  if (options.withBlockers) {
    const loads = await loadsForPayables(ctx, lines, caches.loads);
    // _id on our lines is a payItems id (used only as opaque lineIds for the
    // jump target); the shared blocker input types it as a legacy payable id.
    const blockerLines = lines as unknown as Parameters<typeof computeDriverBlockers>[0]['payables'];
    blockers = applyAcknowledgements(
      computeDriverBlockers({ payables: blockerLines, loads, net: summary.net }),
      settlement.acknowledgedBlockers,
    );
  }

  const legacyStatus = toLegacyStatus(settlement.status);
  const payDate = payPlan ? payDateFromLag(settlement.periodEnd, payPlan.paymentLagDays) : null;

  return {
    _id: settlement._id,
    statementNumber: settlement.statementNumber,
    status: legacyStatus,
    bucket: bucketForSettlement(legacyStatus, settlement.periodEnd, blockers),
    payeeId: settlement.payeeId,
    payeeName: driver ? `${driver.firstName} ${driver.lastName}` : 'Unknown Driver',
    payeeSub: payPlan?.name ?? null,
    periodStart: settlement.periodStart,
    periodEnd: settlement.periodEnd,
    periodNumber: null,
    payDate,
    paidAt: settlement.paidAt ?? null,
    paidMethod: settlement.paymentMethod ?? null,
    paidReference: settlement.paymentReference ?? null,
    planBasis: basisInfo?.basis ?? null,
    planDetail: basisInfo?.planDetail ?? null,
    cadence: cadenceFromFrequency(payPlan?.frequency),
    units: unitsLabel(basisInfo?.basis ?? null, summary),
    loadCount: summary.loadCount,
    lineCount: summary.lineCount,
    earnTotal: summary.earnTotal,
    reimbTotal: summary.reimbTotal,
    deductTotal: summary.deductTotal,
    net: summary.net,
    blockers,
    ageDays: ageDays(settlement.periodEnd),
    voidReason: settlement.voidReason ?? null,
    notes: settlement.notes ?? null,
  };
}

// ── driver settlement statuses that map to each legacy grouping ──────────────
const ACTIVE_NEW_STATUSES: NewStatus[] = ['OPEN', 'IN_REVIEW'];
// Each settled tab maps to the new-ledger status that actually occurs today.
// SENT (post-VERIFIED) and CLOSED (post-PAID) exist in the status union but NO
// mutation writes them yet (updateSettlementStatus only sets VERIFIED/PAID/VOID).
// list and getViewStats both read from this map, so keeping ONE status per group
// guarantees the rows and the counts can't diverge. When the send/close flows
// land, these groups will need real multi-status pagination (a denormalized
// settled-group field, or a first-page merge of the rare secondary status).
const SETTLED_MAP: Record<'APPROVED' | 'PAID' | 'VOID', NewStatus[]> = {
  APPROVED: ['VERIFIED'],
  PAID: ['PAID'],
  VOID: ['VOID'],
};

async function driverSettlementsByStatus(ctx: QueryCtx, orgId: string, statuses: NewStatus[]) {
  const out: Doc<'settlements'>[] = [];
  for (const st of statuses) {
    const rows = await ctx.db
      .query('settlements')
      .withIndex('by_org_payee_status', (q) =>
        q.eq('workosOrgId', orgId).eq('payeeType', 'DRIVER').eq('status', st))
      .collect();
    out.push(...rows);
  }
  return out;
}

export const listActive = query({
  args: {
    workosOrgId: v.string(),
    view: v.union(v.literal('open'), v.literal('attention'), v.literal('ready')),
    search: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    await assertCallerOwnsOrg(ctx, args.workosOrgId);
    const active = (await driverSettlementsByStatus(ctx, args.workosOrgId, ACTIVE_NEW_STATUSES))
      .sort((a, b) => b.periodStart - a.periodStart)
      .slice(0, ACTIVE_ROW_CAP);

    const caches = newAdapterCaches();
    const rows = [];
    for (const s of active) rows.push(await enrichNewDriverSettlement(ctx, s, caches, { withBlockers: true }));

    let filtered = rows.filter((r) => r.bucket === args.view);
    if (args.search && args.search.trim() !== '') {
      const needle = args.search.toLowerCase().trim();
      filtered = filtered.filter(
        (r) => r.statementNumber.toLowerCase().includes(needle) || r.payeeName.toLowerCase().includes(needle),
      );
    }
    return { rows: filtered, truncated: active.length === ACTIVE_ROW_CAP };
  },
});

export const listSettled = query({
  args: {
    workosOrgId: v.string(),
    status: v.union(v.literal('APPROVED'), v.literal('PAID'), v.literal('VOID')),
    paginationOpts: paginationOptsValidator,
    search: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    await assertCallerOwnsOrg(ctx, args.workosOrgId);
    // One status per settled group today (see SETTLED_MAP); paginate it directly.
    const [primary] = SETTLED_MAP[args.status];
    const result = await ctx.db
      .query('settlements')
      .withIndex('by_org_payee_status', (q) =>
        q.eq('workosOrgId', args.workosOrgId).eq('payeeType', 'DRIVER').eq('status', primary))
      .order('desc')
      .paginate(args.paginationOpts);

    const caches = newAdapterCaches();
    let page = [];
    for (const s of result.page) {
      page.push(await enrichNewDriverSettlement(ctx, s, caches, { withBlockers: false }));
    }
    if (args.search && args.search.trim() !== '') {
      const needle = args.search.toLowerCase().trim();
      page = page.filter(
        (r) => r.statementNumber.toLowerCase().includes(needle) || r.payeeName.toLowerCase().includes(needle),
      );
    }
    return { ...result, page };
  },
});

export const getViewStats = query({
  args: { workosOrgId: v.string() },
  handler: async (ctx, args) => {
    await assertCallerOwnsOrg(ctx, args.workosOrgId);
    const caches = newAdapterCaches();

    // Same subset listActive shows (most-recent-first, capped) so tiles and rows agree.
    const active = (await driverSettlementsByStatus(ctx, args.workosOrgId, ACTIVE_NEW_STATUSES))
      .sort((a, b) => b.periodStart - a.periodStart)
      .slice(0, ACTIVE_ROW_CAP);
    let openCount = 0, attentionCount = 0, readyCount = 0;
    let openAccruing = 0, readyNet = 0, blockedNet = 0;
    let oldestBlockedId: Id<'settlements'> | null = null, oldestBlockedAge = -1;
    for (const s of active) {
      const row = await enrichNewDriverSettlement(ctx, s, caches, { withBlockers: true });
      if (row.bucket === 'open') { openCount++; openAccruing += row.net; }
      else if (row.bucket === 'attention') {
        attentionCount++; blockedNet += Math.max(row.net, 0);
        if (row.ageDays > oldestBlockedAge) { oldestBlockedAge = row.ageDays; oldestBlockedId = s._id; }
      } else { readyCount++; readyNet += row.net; }
    }

    // Settled buckets: sum the materialized net off each statement — no payItems
    // re-collect. Unbounded status buckets (paid/void grow forever) so enriching
    // each on every reactive tick was the main scaling cliff.
    const approved = await driverSettlementsByStatus(ctx, args.workosOrgId, SETTLED_MAP.APPROVED);
    let approvedNet = 0;
    for (const s of approved) approvedNet += netUsdOf(s);

    const paid = await driverSettlementsByStatus(ctx, args.workosOrgId, SETTLED_MAP.PAID);
    const monthStart = (() => { const d = new Date(); d.setDate(1); d.setHours(0, 0, 0, 0); return d.getTime(); })();
    let paidMtd = 0;
    for (const s of paid) if ((s.paidAt ?? 0) >= monthStart) paidMtd += netUsdOf(s);
    const voidCount = (await driverSettlementsByStatus(ctx, args.workosOrgId, SETTLED_MAP.VOID)).length;

    return {
      counts: { open: openCount, attention: attentionCount, ready: readyCount, approved: approved.length, paid: paid.length, void: voidCount },
      dueThisRun: readyNet + approvedNet,
      openAccruing,
      blockedNet,
      paidMtd,
      oldestBlockedId,
    };
  },
});

export const getSettlementDetails = query({
  args: { settlementId: v.id('settlements') },
  handler: async (ctx, args) => {
    const orgId = await requireCallerOrgId(ctx);
    const settlement = await ctx.db.get(args.settlementId);
    if (!settlement || settlement.workosOrgId !== orgId) throw new Error('Settlement not found');

    const caches = newAdapterCaches();
    const driver = (await ctx.db.get(settlement.payeeId as Id<'drivers'>)) as Doc<'drivers'> | null;
    // One collect (frozen membership if finalized), reused for both the summary
    // lines and the detail-shape payables below.
    const items = await payItemsForSettlement(ctx, settlement);
    const lines = await linesFromItems(ctx, caches, items);
    const summary = summarizeLines(lines);

    const loads = await loadsForPayables(ctx, lines, caches.loads);
    const blockerLines = lines as unknown as Parameters<typeof computeDriverBlockers>[0]['payables'];
    const blockers = applyAcknowledgements(
      computeDriverBlockers({ payables: blockerLines, loads, net: summary.net }),
      settlement.acknowledgedBlockers,
    );

    // Payables in the detail shape (description-level lines).
    const payables = await payablesFromItems(ctx, caches, items);

    return {
      settlement: {
        _id: settlement._id,
        statementNumber: settlement.statementNumber,
        status: toLegacyStatus(settlement.status),
        periodStart: settlement.periodStart,
        periodEnd: settlement.periodEnd,
        paidAt: settlement.paidAt ?? null,
        notes: settlement.notes ?? null,
        voidReason: settlement.voidReason ?? null,
      },
      driver: driver
        ? { _id: driver._id, firstName: driver.firstName, lastName: driver.lastName, email: driver.email }
        : null,
      payables,
      heldPayables: [], // new ledger uses payItems.holdback; none surfaced yet
      blockers,
      summary: {
        totalGross: summary.earnTotal + summary.reimbTotal,
        totalMiles: 0,
        totalHours: 0,
        uniqueLoads: summary.loadCount,
        earnTotal: summary.earnTotal,
        reimbTotal: summary.reimbTotal,
        deductTotal: summary.deductTotal,
        net: summary.net,
      },
    };
  },
});

// ============================================================================
// CARRIER — symmetric to driver, using carrier-specific enrichment helpers.
// ============================================================================

async function enrichNewCarrierSettlement(
  ctx: QueryCtx,
  settlement: Doc<'settlements'>,
  caches: AdapterCaches,
  options: { withBlockers: boolean },
) {
  const key = settlement.payeeId;
  let partnership = caches.partnerships.get(key);
  if (partnership === undefined) {
    partnership = ((await ctx.db.get(settlement.payeeId as Id<'carrierPartnerships'>)) ?? null) as Doc<'carrierPartnerships'> | null;
    caches.partnerships.set(key, partnership);
  }

  let basisInfo = caches.payBasis.get(key);
  if (basisInfo === undefined) {
    basisInfo = await resolveCarrierPayBasis(ctx, settlement.payeeId as Id<'carrierPartnerships'>);
    caches.payBasis.set(key, basisInfo);
  }

  const lines = await linesFor(ctx, caches, settlement);
  const summary = summarizeLines(lines);

  let blockers: ReturnType<typeof computeCarrierBlockers> = [];
  if (options.withBlockers) {
    const loads = await loadsForPayables(ctx, lines, caches.loads);
    const blockerLines = lines as unknown as Parameters<typeof computeCarrierBlockers>[0]['payables'];
    blockers = applyAcknowledgements(
      computeCarrierBlockers({ payables: blockerLines, loads, partnership, net: summary.net }),
      undefined,
    );
  }

  const legacyStatus = toLegacyStatus(settlement.status);
  const payeeSub = partnership
    ? `MC-${partnership.mcNumber} · ${partnership.isOwnerOperator ? 'Owner Op' : 'Fleet'}`
    : null;

  return {
    _id: settlement._id,
    statementNumber: settlement.statementNumber,
    status: legacyStatus,
    bucket: bucketForSettlement(legacyStatus, settlement.periodEnd, blockers),
    payeeId: settlement.payeeId,
    payeeName: partnership?.carrierName ?? 'Unknown Carrier',
    payeeSub,
    periodStart: settlement.periodStart,
    periodEnd: settlement.periodEnd,
    periodNumber: null,
    payDate: payDateFromTerms(settlement.periodEnd, partnership?.defaultPaymentTerms),
    paidAt: settlement.paidAt ?? null,
    paidMethod: settlement.paymentMethod ?? null,
    paidReference: settlement.paymentReference ?? null,
    planBasis: basisInfo?.basis ?? null,
    planDetail: basisInfo?.planDetail ?? null,
    cadence: cadenceFromPaymentTerms(partnership?.defaultPaymentTerms),
    units: unitsLabel(basisInfo?.basis ?? null, summary),
    loadCount: summary.loadCount,
    lineCount: summary.lineCount,
    earnTotal: summary.earnTotal,
    reimbTotal: summary.reimbTotal,
    deductTotal: summary.deductTotal,
    net: summary.net,
    blockers,
    ageDays: ageDays(settlement.periodEnd),
    voidReason: settlement.voidReason ?? null,
    notes: settlement.notes ?? null,
  };
}

async function carrierSettlementsByStatus(ctx: QueryCtx, orgId: string, statuses: NewStatus[]) {
  const out: Doc<'settlements'>[] = [];
  for (const st of statuses) {
    const rows = await ctx.db
      .query('settlements')
      .withIndex('by_org_payee_status', (q) =>
        q.eq('workosOrgId', orgId).eq('payeeType', 'CARRIER').eq('status', st))
      .collect();
    out.push(...rows);
  }
  return out;
}

// One status per settled group today (see SETTLED_MAP for the SENT/CLOSED note);
// DISPUTED isn't modeled in the new ledger yet → [].
const CARRIER_SETTLED_MAP: Record<'APPROVED' | 'PAID' | 'VOID' | 'DISPUTED', NewStatus[]> = {
  APPROVED: ['VERIFIED'],
  PAID: ['PAID'],
  VOID: ['VOID'],
  DISPUTED: [],
};

export const carrierListActive = query({
  args: {
    workosOrgId: v.string(),
    view: v.union(v.literal('open'), v.literal('attention'), v.literal('ready')),
    search: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    await assertCallerOwnsOrg(ctx, args.workosOrgId);
    const active = (await carrierSettlementsByStatus(ctx, args.workosOrgId, ACTIVE_NEW_STATUSES))
      .sort((a, b) => b.periodStart - a.periodStart)
      .slice(0, ACTIVE_ROW_CAP);
    const caches = newAdapterCaches();
    const rows = [];
    for (const s of active) rows.push(await enrichNewCarrierSettlement(ctx, s, caches, { withBlockers: true }));

    let filtered = rows.filter((r) => r.bucket === args.view);
    if (args.search && args.search.trim() !== '') {
      const needle = args.search.toLowerCase().trim();
      filtered = filtered.filter(
        (r) => r.statementNumber.toLowerCase().includes(needle) || r.payeeName.toLowerCase().includes(needle),
      );
    }
    return { rows: filtered, truncated: active.length === ACTIVE_ROW_CAP };
  },
});

export const carrierListSettled = query({
  args: {
    workosOrgId: v.string(),
    status: v.union(v.literal('APPROVED'), v.literal('PAID'), v.literal('VOID'), v.literal('DISPUTED')),
    paginationOpts: paginationOptsValidator,
    search: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    await assertCallerOwnsOrg(ctx, args.workosOrgId);
    const [primary] = CARRIER_SETTLED_MAP[args.status];
    if (!primary) {
      return { page: [], isDone: true, continueCursor: '' }; // DISPUTED — unmodeled
    }
    const result = await ctx.db
      .query('settlements')
      .withIndex('by_org_payee_status', (q) =>
        q.eq('workosOrgId', args.workosOrgId).eq('payeeType', 'CARRIER').eq('status', primary))
      .order('desc')
      .paginate(args.paginationOpts);
    const caches = newAdapterCaches();
    let page = [];
    for (const s of result.page) {
      page.push(await enrichNewCarrierSettlement(ctx, s, caches, { withBlockers: false }));
    }
    if (args.search && args.search.trim() !== '') {
      const needle = args.search.toLowerCase().trim();
      page = page.filter(
        (r) => r.statementNumber.toLowerCase().includes(needle) || r.payeeName.toLowerCase().includes(needle),
      );
    }
    return { ...result, page };
  },
});

export const carrierGetViewStats = query({
  args: { workosOrgId: v.string() },
  handler: async (ctx, args) => {
    await assertCallerOwnsOrg(ctx, args.workosOrgId);
    const caches = newAdapterCaches();
    // Same subset carrierListActive shows (most-recent-first, capped) so tiles and rows agree.
    const active = (await carrierSettlementsByStatus(ctx, args.workosOrgId, ACTIVE_NEW_STATUSES))
      .sort((a, b) => b.periodStart - a.periodStart)
      .slice(0, ACTIVE_ROW_CAP);
    let openCount = 0, attentionCount = 0, readyCount = 0;
    let openAccruing = 0, readyNet = 0, blockedNet = 0;
    let oldestBlockedId: Id<'settlements'> | null = null, oldestBlockedAge = -1;
    for (const s of active) {
      const row = await enrichNewCarrierSettlement(ctx, s, caches, { withBlockers: true });
      if (row.bucket === 'open') { openCount++; openAccruing += row.net; }
      else if (row.bucket === 'attention') {
        attentionCount++; blockedNet += Math.max(row.net, 0);
        if (row.ageDays > oldestBlockedAge) { oldestBlockedAge = row.ageDays; oldestBlockedId = s._id; }
      } else { readyCount++; readyNet += row.net; }
    }
    // Settled buckets: materialized net, no payItems re-collect (see driver getViewStats).
    const approved = await carrierSettlementsByStatus(ctx, args.workosOrgId, CARRIER_SETTLED_MAP.APPROVED);
    let approvedNet = 0;
    for (const s of approved) approvedNet += netUsdOf(s);
    const paid = await carrierSettlementsByStatus(ctx, args.workosOrgId, CARRIER_SETTLED_MAP.PAID);
    const monthStart = (() => { const d = new Date(); d.setDate(1); d.setHours(0, 0, 0, 0); return d.getTime(); })();
    let paidMtd = 0;
    for (const s of paid) if ((s.paidAt ?? 0) >= monthStart) paidMtd += netUsdOf(s);
    const voidCount = (await carrierSettlementsByStatus(ctx, args.workosOrgId, CARRIER_SETTLED_MAP.VOID)).length;

    return {
      counts: { open: openCount, attention: attentionCount, ready: readyCount, approved: approved.length, paid: paid.length, void: voidCount, disputed: 0 },
      dueThisRun: readyNet + approvedNet,
      openAccruing,
      blockedNet,
      paidMtd,
      oldestBlockedId,
    };
  },
});

export const carrierGetSettlementDetails = query({
  args: { settlementId: v.id('settlements') },
  handler: async (ctx, args) => {
    const orgId = await requireCallerOrgId(ctx);
    const settlement = await ctx.db.get(args.settlementId);
    if (!settlement || settlement.workosOrgId !== orgId) throw new Error('Settlement not found');

    const caches = newAdapterCaches();
    const partnership = (await ctx.db.get(settlement.payeeId as Id<'carrierPartnerships'>)) as Doc<'carrierPartnerships'> | null;
    // One collect (frozen membership if finalized), reused for lines + payables.
    const items = await payItemsForSettlement(ctx, settlement);
    const lines = await linesFromItems(ctx, caches, items);
    const summary = summarizeLines(lines);

    const loads = await loadsForPayables(ctx, lines, caches.loads);
    const blockerLines = lines as unknown as Parameters<typeof computeCarrierBlockers>[0]['payables'];
    const blockers = applyAcknowledgements(
      computeCarrierBlockers({ payables: blockerLines, loads, partnership, net: summary.net }),
      settlement.acknowledgedBlockers,
    );

    const payables = await payablesFromItems(ctx, caches, items);

    return {
      settlement: {
        _id: settlement._id,
        statementNumber: settlement.statementNumber,
        status: toLegacyStatus(settlement.status),
        periodStart: settlement.periodStart,
        periodEnd: settlement.periodEnd,
        paidAt: settlement.paidAt ?? null,
        notes: settlement.notes ?? null,
        voidReason: settlement.voidReason ?? null,
      },
      partnership: partnership
        ? {
            _id: partnership._id, name: partnership.carrierName, mcNumber: partnership.mcNumber,
            isOwnerOperator: partnership.isOwnerOperator, defaultPaymentTerms: partnership.defaultPaymentTerms,
          }
        : null,
      payables,
      blockers,
      summary: {
        earnTotal: summary.earnTotal, reimbTotal: summary.reimbTotal,
        deductTotal: summary.deductTotal, net: summary.net,
        loadCount: summary.loadCount, lineCount: summary.lineCount,
      },
    };
  },
});
