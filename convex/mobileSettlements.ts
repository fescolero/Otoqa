import { v } from 'convex/values';
import { query } from './_generated/server';
import type { QueryCtx } from './_generated/server';
import type { Doc, Id } from './_generated/dataModel';
import { resolveAuthenticatedDriver } from './driverMobile';
import { requireCarrierAuth } from './carrierMobile';
import {
  buildShiftLoadRows,
  classifyPayable,
  newWorkStartCaches,
  payDateFromLag,
  payDateFromTerms,
  resolveDriverPayBasis,
  resolveWorkStartTimestamp,
  summarizeLines,
  unitsLabel,
  type ShiftLoadRow,
  type WorkStartCaches,
} from './lib/settlementShared';
import {
  SETTLEMENTS_READ_LEDGER_FLAG,
  bucketOf,
  bucketToCategory,
  linesFromItems,
  newAdapterCaches,
  payItemsForSettlement,
  toLegacyStatus,
} from './payEngine/settlementReads';
import { FINALIZED_SETTLEMENT_STATUSES } from './payEngine/schema';

/**
 * Mobile Settlements — PAYEE-scoped, READ-ONLY statement views.
 *
 * Every other settlement surface is broker/org-admin scoped; these queries are
 * the payee's own window into their pay:
 *   - Drivers (Clerk phone auth via resolveAuthenticatedDriver) see their own
 *     statements for the org that employs them.
 *   - Carrier owners (Clerk org auth via requireCarrierAuth) see the statements
 *     each broker partnership has cut for them, labeled per broker.
 *
 * Ledger source mirrors the web dashboard: per BROKER org, the
 * `settlements_read_ledger` feature flag picks legacy (driverSettlements /
 * carrierSettlements + payables) or the new payEngine ledger (settlements +
 * payItems), so the payee always sees the same numbers the broker does.
 *
 * Payee-safe by construction: no blockers, audit flags, reviewer notes,
 * warning messages, or edit-audit internals are returned — just the statement
 * envelope, its lines, and payment info. VOID statements are hidden entirely.
 */

// ≈ 1.5 years of biweekly statements — plenty for a phone list.
const STATEMENT_LIST_CAP = 36;
// Largest line set a phone should render; carrier catch-up statements can
// carry thousands of lines (summary stays exact — see linesTruncated).
const DETAIL_LINE_CAP = 400;

// ── payee-facing status ───────────────────────────────────────────────────────
// DRAFT on a still-running period is the live accrual ("earned so far");
// DRAFT on a closed period and PENDING are both broker-side review. VOID is
// hidden (mobileStatus → null drops the row).
export type MobileStatementStatus = 'ACCRUING' | 'IN_REVIEW' | 'APPROVED' | 'PAID' | 'DISPUTED';

type LegacyStatus = 'DRAFT' | 'PENDING' | 'APPROVED' | 'PAID' | 'VOID' | 'DISPUTED';

function mobileStatus(legacyStatus: LegacyStatus, periodEnd: number): MobileStatementStatus | null {
  switch (legacyStatus) {
    case 'DRAFT':
      return periodEnd > Date.now() ? 'ACCRUING' : 'IN_REVIEW';
    case 'PENDING':
      return 'IN_REVIEW';
    case 'APPROVED':
      return 'APPROVED';
    case 'PAID':
      return 'PAID';
    case 'DISPUTED':
      return 'DISPUTED';
    case 'VOID':
      return null;
  }
}

async function orgReadsNewLedger(ctx: QueryCtx, workosOrgId: string): Promise<boolean> {
  const row = await ctx.db
    .query('featureFlags')
    .withIndex('by_org_key', (q) =>
      q.eq('workosOrgId', workosOrgId).eq('key', SETTLEMENTS_READ_LEDGER_FLAG),
    )
    .first();
  return row?.value === 'new';
}

// ── shared row / line shapes ─────────────────────────────────────────────────

interface MobileStatementRow {
  id: string;
  /** Which ledger the id belongs to — pass back to the details query. */
  source: 'legacy' | 'ledger';
  statementNumber: string | null;
  status: MobileStatementStatus;
  periodStart: number;
  periodEnd: number;
  payDate: number | null;
  paidAt: number | null;
  paidMethod: string | null;
  paidReference: string | null;
  earnTotal: number;
  reimbTotal: number;
  deductTotal: number;
  net: number;
  lineCount: number | null;
  loadCount: number | null;
  units: string | null;
  planDetail: string | null;
  /** Carrier rows only — which broker this statement is from. */
  brokerName?: string;
  partnershipId?: string;
}

interface MobileStatementLine {
  id: string;
  description: string;
  quantity: number;
  rate: number;
  /** Signed dollars — deductions negative. */
  totalAmount: number;
  category: 'EARNING' | 'REIMBURSEMENT' | 'DEDUCTION';
  kind: 'SYSTEM' | 'MANUAL';
  loadLabel: string | null;
  workStart: number | null;
  workEnd: number | null;
  /** Shift lines only — the loads run during the session. */
  shiftLoads: ShiftLoadRow[] | null;
}

async function loadLabel(
  ctx: QueryCtx,
  cache: Map<string, Doc<'loadInformation'> | null>,
  loadId: Id<'loadInformation'>,
): Promise<string | null> {
  const key = loadId as string;
  let load = cache.get(key);
  if (load === undefined) {
    load = ((await ctx.db.get(loadId)) ?? null) as Doc<'loadInformation'> | null;
    cache.set(key, load);
  }
  return load?.orderNumber ?? load?.internalId ?? null;
}

async function cachedSession(
  ctx: QueryCtx,
  caches: WorkStartCaches,
  sessionId: Id<'driverSessions'>,
): Promise<Doc<'driverSessions'> | null> {
  const key = sessionId as string;
  let session = caches.sessions.get(key);
  if (session === undefined) {
    session = ((await ctx.db.get(sessionId)) ?? null) as Doc<'driverSessions'> | null;
    caches.sessions.set(key, session);
  }
  return session;
}

async function cachedPayPlan(
  ctx: QueryCtx,
  cache: Map<string, Doc<'payPlans'> | null>,
  planId: Id<'payPlans'>,
): Promise<Doc<'payPlans'> | null> {
  const key = planId as string;
  let plan = cache.get(key);
  if (plan === undefined) {
    plan = (await ctx.db.get(planId)) ?? null;
    cache.set(key, plan);
  }
  return plan;
}

// ═════════════════════════════════════════════════════════════════════════════
// DRIVER — "My Pay"
// ═════════════════════════════════════════════════════════════════════════════

/**
 * The authenticated driver's statements, newest first: the current period's
 * accruing draft, statements in broker review, and approved/paid history.
 */
export const getMyStatements = query({
  args: { driverId: v.optional(v.id('drivers')) },
  handler: async (ctx, args): Promise<MobileStatementRow[]> => {
    let driver: Doc<'drivers'>;
    try {
      driver = await resolveAuthenticatedDriver(ctx, args.driverId);
    } catch {
      return []; // graceful for dual-mode users without a driver record
    }
    const useNew = await orgReadsNewLedger(ctx, driver.organizationId);
    const rows = useNew ? await newDriverRows(ctx, driver) : await legacyDriverRows(ctx, driver);
    rows.sort((a, b) => b.periodStart - a.periodStart);
    return rows.slice(0, STATEMENT_LIST_CAP);
  },
});

async function legacyDriverRows(ctx: QueryCtx, driver: Doc<'drivers'>): Promise<MobileStatementRow[]> {
  const settlements = (
    await ctx.db
      .query('driverSettlements')
      .withIndex('by_driver', (q) => q.eq('driverId', driver._id))
      .collect()
  )
    .filter((s) => s.status !== 'VOID')
    .sort((a, b) => b.periodStart - a.periodStart)
    .slice(0, STATEMENT_LIST_CAP);

  const payPlan = driver.payPlanId ? await ctx.db.get(driver.payPlanId) : null;
  const basis = await resolveDriverPayBasis(ctx, driver._id);

  const rows: MobileStatementRow[] = [];
  for (const s of settlements) {
    const status = mobileStatus(s.status, s.periodEnd);
    if (!status) continue;
    // Driver statements are small (dozens of lines) — summarize live so the
    // ACCRUING row tracks the cron-topped-up draft exactly.
    const payables = await ctx.db
      .query('loadPayables')
      .withIndex('by_settlement', (q) => q.eq('settlementId', s._id))
      .collect();
    const summary = summarizeLines(payables);
    rows.push({
      id: s._id as string,
      source: 'legacy',
      statementNumber: s.statementNumber,
      status,
      periodStart: s.periodStart,
      periodEnd: s.periodEnd,
      payDate: payPlan ? payDateFromLag(s.periodEnd, payPlan.paymentLagDays) : null,
      paidAt: s.paidAt ?? null,
      paidMethod: s.paidMethod ?? null,
      paidReference: s.paidReference ?? null,
      earnTotal: summary.earnTotal,
      reimbTotal: summary.reimbTotal,
      deductTotal: summary.deductTotal,
      net: summary.net,
      lineCount: summary.lineCount,
      loadCount: summary.loadCount,
      units: unitsLabel(basis?.basis ?? null, summary),
      planDetail: basis?.planDetail ?? null,
    });
  }
  return rows;
}

async function newDriverRows(ctx: QueryCtx, driver: Doc<'drivers'>): Promise<MobileStatementRow[]> {
  const settlements = (
    await ctx.db
      .query('settlements')
      .withIndex('by_payee_period', (q) =>
        q.eq('payeeType', 'DRIVER').eq('payeeId', driver._id as string),
      )
      .collect()
  )
    .filter((s) => s.status !== 'VOID' && s.workosOrgId === driver.organizationId)
    .sort((a, b) => b.periodStart - a.periodStart)
    .slice(0, STATEMENT_LIST_CAP);

  const caches = newAdapterCaches();
  const basis = await resolveDriverPayBasis(ctx, driver._id);

  const rows: MobileStatementRow[] = [];
  for (const s of settlements) {
    const status = mobileStatus(toLegacyStatus(s.status), s.periodEnd);
    if (!status) continue;
    const planId = s.payPlanId ?? driver.payPlanId;
    const payPlan = planId ? await cachedPayPlan(ctx, caches.payPlans, planId) : null;
    const lines = await linesFromItems(ctx, caches, await payItemsForSettlement(ctx, s));
    const summary = summarizeLines(lines);
    rows.push({
      id: s._id as string,
      source: 'ledger',
      statementNumber: s.statementNumber ?? null,
      status,
      periodStart: s.periodStart,
      periodEnd: s.periodEnd,
      payDate: payPlan ? payDateFromLag(s.periodEnd, payPlan.paymentLagDays) : null,
      paidAt: s.paidAt ?? null,
      paidMethod: s.paymentMethod ?? null,
      paidReference: s.paymentReference ?? null,
      earnTotal: summary.earnTotal,
      reimbTotal: summary.reimbTotal,
      deductTotal: summary.deductTotal,
      net: summary.net,
      lineCount: summary.lineCount,
      loadCount: summary.loadCount,
      units: unitsLabel(basis?.basis ?? null, summary),
      planDetail: basis?.planDetail ?? null,
    });
  }
  return rows;
}

/** One statement, itemized — the driver's own only. */
export const getMyStatementDetails = query({
  args: {
    settlementId: v.string(),
    source: v.union(v.literal('legacy'), v.literal('ledger')),
    driverId: v.optional(v.id('drivers')),
  },
  handler: async (ctx, args) => {
    const driver = await resolveAuthenticatedDriver(ctx, args.driverId);
    return args.source === 'legacy'
      ? legacyDriverDetails(ctx, driver, args.settlementId)
      : newDriverDetails(ctx, driver, args.settlementId);
  },
});

async function legacyDriverDetails(ctx: QueryCtx, driver: Doc<'drivers'>, rawId: string) {
  const id = ctx.db.normalizeId('driverSettlements', rawId);
  const settlement = id ? await ctx.db.get(id) : null;
  if (!settlement || settlement.driverId !== driver._id || settlement.status === 'VOID') {
    throw new Error('Statement not found');
  }

  const payables = await ctx.db
    .query('loadPayables')
    .withIndex('by_settlement', (q) => q.eq('settlementId', settlement._id))
    .collect();

  const caches = newWorkStartCaches();
  const lines: MobileStatementLine[] = [];
  for (const p of payables) {
    const workStart = await resolveWorkStartTimestamp(ctx, p, caches);
    let workEnd: number | null = null;
    let shiftLoads: ShiftLoadRow[] | null = null;
    if (p.sessionId) {
      const session = await cachedSession(ctx, caches, p.sessionId);
      workEnd = session?.endedAt ?? null;
      if (session?.endedAt) {
        shiftLoads = (await buildShiftLoadRows(ctx, driver._id, session, caches)) ?? null;
      }
    }
    lines.push({
      id: p._id as string,
      description: p.description,
      quantity: p.quantity,
      rate: p.rate,
      totalAmount: p.totalAmount,
      category: classifyPayable(p),
      kind: p.sourceType,
      loadLabel: p.loadId ? await loadLabel(ctx, caches.loads, p.loadId) : null,
      workStart: workStart ?? p.createdAt,
      workEnd,
      shiftLoads,
    });
  }
  lines.sort((a, b) => (a.workStart ?? 0) - (b.workStart ?? 0));

  const summary = summarizeLines(payables);
  const basis = await resolveDriverPayBasis(ctx, driver._id);
  const payPlan = driver.payPlanId ? await ctx.db.get(driver.payPlanId) : null;

  return {
    statement: {
      id: settlement._id as string,
      source: 'legacy' as const,
      statementNumber: settlement.statementNumber as string | null,
      status: mobileStatus(settlement.status, settlement.periodEnd)!,
      periodStart: settlement.periodStart,
      periodEnd: settlement.periodEnd,
      payDate: payPlan ? payDateFromLag(settlement.periodEnd, payPlan.paymentLagDays) : null,
      paidAt: settlement.paidAt ?? null,
      paidMethod: settlement.paidMethod ?? null,
      paidReference: settlement.paidReference ?? null,
    },
    lines: lines.slice(0, DETAIL_LINE_CAP),
    linesTruncated: lines.length > DETAIL_LINE_CAP,
    summary: {
      earnTotal: summary.earnTotal,
      reimbTotal: summary.reimbTotal,
      deductTotal: summary.deductTotal,
      net: summary.net,
      lineCount: summary.lineCount,
      loadCount: summary.loadCount,
      units: unitsLabel(basis?.basis ?? null, summary),
      planDetail: basis?.planDetail ?? null,
    },
  };
}

async function newDriverDetails(ctx: QueryCtx, driver: Doc<'drivers'>, rawId: string) {
  const id = ctx.db.normalizeId('settlements', rawId);
  const settlement = id ? await ctx.db.get(id) : null;
  if (
    !settlement ||
    settlement.payeeType !== 'DRIVER' ||
    settlement.payeeId !== (driver._id as string) ||
    settlement.status === 'VOID'
  ) {
    throw new Error('Statement not found');
  }

  const items = await payItemsForSettlement(ctx, settlement);
  const caches = newAdapterCaches();
  const wsCaches = newWorkStartCaches();

  const lines: MobileStatementLine[] = [];
  for (const it of items) {
    if (it.isVoided) continue;
    const category = bucketToCategory(await bucketOf(ctx, caches, it.componentId as string));
    const dollars = Number(it.amountCents) / 100;
    let workEnd: number | null = null;
    let shiftLoads: ShiftLoadRow[] | null = null;
    const sessionId = it.sourceRef.sessionId;
    if (sessionId) {
      const session = await cachedSession(ctx, wsCaches, sessionId);
      workEnd = session?.endedAt ?? null;
      if (session?.endedAt) {
        shiftLoads = (await buildShiftLoadRows(ctx, driver._id, session, wsCaches)) ?? null;
      }
    }
    lines.push({
      id: it._id as string,
      description: it.description,
      quantity: it.quantity,
      rate: Number(it.rateMicroCents) / 100000,
      totalAmount: category === 'DEDUCTION' ? -dollars : dollars,
      category,
      kind: it.kind === 'MANUAL_ADJUSTMENT' ? 'MANUAL' : 'SYSTEM',
      loadLabel: it.sourceRef.loadId ? await loadLabel(ctx, wsCaches.loads, it.sourceRef.loadId) : null,
      // periodAnchorAt IS the work start (session check-in / first pickup).
      workStart: it.periodAnchorAt,
      workEnd,
      shiftLoads,
    });
  }
  lines.sort((a, b) => (a.workStart ?? 0) - (b.workStart ?? 0));

  const summary = summarizeLines(await linesFromItems(ctx, caches, items));
  const basis = await resolveDriverPayBasis(ctx, driver._id);
  const planId = settlement.payPlanId ?? driver.payPlanId;
  const payPlan = planId ? await cachedPayPlan(ctx, caches.payPlans, planId) : null;

  return {
    statement: {
      id: settlement._id as string,
      source: 'ledger' as const,
      statementNumber: (settlement.statementNumber ?? null) as string | null,
      status: mobileStatus(toLegacyStatus(settlement.status), settlement.periodEnd)!,
      periodStart: settlement.periodStart,
      periodEnd: settlement.periodEnd,
      payDate: payPlan ? payDateFromLag(settlement.periodEnd, payPlan.paymentLagDays) : null,
      paidAt: settlement.paidAt ?? null,
      paidMethod: settlement.paymentMethod ?? null,
      paidReference: settlement.paymentReference ?? null,
    },
    lines: lines.slice(0, DETAIL_LINE_CAP),
    linesTruncated: lines.length > DETAIL_LINE_CAP,
    summary: {
      earnTotal: summary.earnTotal,
      reimbTotal: summary.reimbTotal,
      deductTotal: summary.deductTotal,
      net: summary.net,
      lineCount: summary.lineCount,
      loadCount: summary.loadCount,
      units: unitsLabel(basis?.basis ?? null, summary),
      planDetail: basis?.planDetail ?? null,
    },
  };
}

// ═════════════════════════════════════════════════════════════════════════════
// CARRIER OWNER — settlement statements from each broker partnership
// ═════════════════════════════════════════════════════════════════════════════

/**
 * partnerships.carrierOrgId historically stores whichever identifier the
 * linking flow had on hand — clerkOrgId, workosOrgId, or the Convex org _id
 * (see carrierPartnerships.ts). Match all forms of the AUTHENTICATED org.
 */
function orgIdCandidates(org: { _id: string; clerkOrgId?: string; workosOrgId?: string }): string[] {
  return [org.clerkOrgId, org.workosOrgId, org._id as string].filter(
    (x): x is string => typeof x === 'string' && x.length > 0,
  );
}

async function partnershipsForOrg(
  ctx: QueryCtx,
  org: { _id: string; clerkOrgId?: string; workosOrgId?: string },
): Promise<Doc<'carrierPartnerships'>[]> {
  const out = new Map<string, Doc<'carrierPartnerships'>>();
  for (const candidate of orgIdCandidates(org)) {
    const batch = await ctx.db
      .query('carrierPartnerships')
      .withIndex('by_carrier', (q) => q.eq('carrierOrgId', candidate))
      .collect();
    for (const p of batch) out.set(p._id as string, p);
  }
  return [...out.values()];
}

/**
 * All settlement statements cut for the authenticated carrier org, across
 * every broker partnership, newest first. Each row carries the broker's name.
 */
export const getCarrierStatements = query({
  args: { carrierOrgId: v.string() },
  handler: async (ctx, args): Promise<MobileStatementRow[]> => {
    const auth = await requireCarrierAuth(ctx, args.carrierOrgId);
    if (!auth) return [];

    const partnerships = await partnershipsForOrg(ctx, auth.org);

    const rows: MobileStatementRow[] = [];
    for (const p of partnerships) {
      const brokerOrg = await ctx.db
        .query('organizations')
        .withIndex('by_organization', (q) => q.eq('workosOrgId', p.brokerOrgId))
        .first();
      const brokerName = brokerOrg?.name ?? 'Broker';
      // Ledger choice is the BROKER org's flag — same numbers the broker sees.
      const useNew = await orgReadsNewLedger(ctx, p.brokerOrgId);
      const partnershipRows = useNew
        ? await newCarrierRows(ctx, p)
        : await legacyCarrierRows(ctx, p);
      for (const r of partnershipRows) {
        rows.push({ ...r, brokerName, partnershipId: p._id as string });
      }
    }
    rows.sort((a, b) => b.periodStart - a.periodStart);
    return rows.slice(0, STATEMENT_LIST_CAP);
  },
});

async function legacyCarrierRows(
  ctx: QueryCtx,
  partnership: Doc<'carrierPartnerships'>,
): Promise<MobileStatementRow[]> {
  const settlements = (
    await ctx.db
      .query('carrierSettlements')
      .withIndex('by_carrier_partnership', (q) => q.eq('carrierPartnershipId', partnership._id))
      .collect()
  )
    .filter((s) => s.status !== 'VOID')
    .sort((a, b) => b.periodStart - a.periodStart)
    .slice(0, STATEMENT_LIST_CAP);

  return settlements.flatMap((s) => {
    const status = mobileStatus(s.status, s.periodEnd);
    if (!status) return [];
    // Denormalized statement totals — a carrier statement can carry thousands
    // of lines; the list never collects them.
    const deductTotal = s.totalDeductions ?? Math.max(s.totalGross - s.totalNet, 0);
    return [
      {
        id: s._id as string,
        source: 'legacy' as const,
        statementNumber: s.statementNumber ?? null,
        status,
        periodStart: s.periodStart,
        periodEnd: s.periodEnd,
        payDate: payDateFromTerms(s.periodEnd, partnership.defaultPaymentTerms),
        paidAt: s.paidAt ?? null,
        paidMethod: s.paymentMethod ?? null,
        paidReference: s.paymentReference ?? null,
        earnTotal: s.totalGross,
        reimbTotal: 0,
        deductTotal,
        net: s.totalNet,
        lineCount: null,
        loadCount: null,
        units: null,
        planDetail: null,
      },
    ];
  });
}

async function newCarrierRows(
  ctx: QueryCtx,
  partnership: Doc<'carrierPartnerships'>,
): Promise<MobileStatementRow[]> {
  const settlements = (
    await ctx.db
      .query('settlements')
      .withIndex('by_payee_period', (q) =>
        q.eq('payeeType', 'CARRIER').eq('payeeId', partnership._id as string),
      )
      .collect()
  )
    .filter((s) => s.status !== 'VOID' && s.workosOrgId === partnership.brokerOrgId)
    .sort((a, b) => b.periodStart - a.periodStart)
    .slice(0, STATEMENT_LIST_CAP);

  return settlements.flatMap((s) => {
    const status = mobileStatus(toLegacyStatus(s.status), s.periodEnd);
    if (!status) return [];
    // Materialized aggregator totals — exact once finalized; an ACCRUING row
    // refreshes on the hourly generation cron.
    const t = s.totals;
    const adjustments = Number(t.adjustmentsCents) / 100;
    const debits = Number(t.deductionsCents + t.taxWithholdingCents + t.garnishmentsCents) / 100;
    return [
      {
        id: s._id as string,
        source: 'ledger' as const,
        statementNumber: s.statementNumber ?? null,
        status,
        periodStart: s.periodStart,
        periodEnd: s.periodEnd,
        payDate: payDateFromTerms(s.periodEnd, partnership.defaultPaymentTerms),
        paidAt: s.paidAt ?? null,
        paidMethod: s.paymentMethod ?? null,
        paidReference: s.paymentReference ?? null,
        earnTotal: Number(t.grossCents) / 100 + Math.max(adjustments, 0),
        reimbTotal: 0,
        deductTotal: debits + Math.max(-adjustments, 0),
        net: Number(t.netCents) / 100,
        lineCount: t.itemCount,
        loadCount: null,
        units: null,
        planDetail: null,
      },
    ];
  });
}

/** One carrier statement, itemized — only for a partnership the caller owns. */
export const getCarrierStatementDetails = query({
  args: {
    carrierOrgId: v.string(),
    settlementId: v.string(),
    source: v.union(v.literal('legacy'), v.literal('ledger')),
  },
  handler: async (ctx, args) => {
    const auth = await requireCarrierAuth(ctx, args.carrierOrgId);
    if (!auth) throw new Error('Statement not found');
    const candidates = orgIdCandidates(auth.org);
    return args.source === 'legacy'
      ? legacyCarrierDetails(ctx, candidates, args.settlementId)
      : newCarrierDetails(ctx, candidates, args.settlementId);
  },
});

async function brokerNameFor(ctx: QueryCtx, brokerOrgId: string): Promise<string> {
  const org = await ctx.db
    .query('organizations')
    .withIndex('by_organization', (q) => q.eq('workosOrgId', brokerOrgId))
    .first();
  return org?.name ?? 'Broker';
}

async function legacyCarrierDetails(ctx: QueryCtx, orgCandidates: string[], rawId: string) {
  const id = ctx.db.normalizeId('carrierSettlements', rawId);
  const settlement = id ? await ctx.db.get(id) : null;
  if (!settlement || settlement.status === 'VOID') throw new Error('Statement not found');
  const partnership = await ctx.db.get(settlement.carrierPartnershipId);
  if (!partnership?.carrierOrgId || !orgCandidates.includes(partnership.carrierOrgId)) {
    throw new Error('Statement not found');
  }

  // Bounded fetch — catch-up statements can carry thousands of lines. When
  // capped, the summary falls back to the statement's denormalized totals so
  // the money is still exact.
  const fetched = await ctx.db
    .query('loadCarrierPayables')
    .withIndex('by_settlement', (q) => q.eq('settlementId', settlement._id))
    .take(DETAIL_LINE_CAP + 1);
  const truncated = fetched.length > DETAIL_LINE_CAP;
  const payables = truncated ? fetched.slice(0, DETAIL_LINE_CAP) : fetched;

  const caches = newWorkStartCaches();
  const lines: MobileStatementLine[] = [];
  for (const p of payables) {
    const workStart = await resolveWorkStartTimestamp(ctx, p, caches);
    lines.push({
      id: p._id as string,
      description: p.description,
      quantity: p.quantity,
      rate: p.rate,
      totalAmount: p.totalAmount,
      category: classifyPayable(p),
      kind: p.sourceType,
      loadLabel: p.loadId ? await loadLabel(ctx, caches.loads, p.loadId) : null,
      workStart: workStart ?? p.createdAt,
      workEnd: null,
      shiftLoads: null,
    });
  }
  lines.sort((a, b) => (a.workStart ?? 0) - (b.workStart ?? 0));

  const summary = truncated
    ? {
        earnTotal: settlement.totalGross,
        reimbTotal: 0,
        deductTotal: settlement.totalDeductions ?? Math.max(settlement.totalGross - settlement.totalNet, 0),
        net: settlement.totalNet,
        lineCount: null as number | null,
        loadCount: null as number | null,
      }
    : (({ earnTotal, reimbTotal, deductTotal, net, lineCount, loadCount }) => ({
        earnTotal, reimbTotal, deductTotal, net,
        lineCount: lineCount as number | null, loadCount: loadCount as number | null,
      }))(summarizeLines(payables));

  return {
    statement: {
      id: settlement._id as string,
      source: 'legacy' as const,
      statementNumber: (settlement.statementNumber ?? null) as string | null,
      status: mobileStatus(settlement.status, settlement.periodEnd)!,
      periodStart: settlement.periodStart,
      periodEnd: settlement.periodEnd,
      payDate: payDateFromTerms(settlement.periodEnd, partnership.defaultPaymentTerms),
      paidAt: settlement.paidAt ?? null,
      paidMethod: settlement.paymentMethod ?? null,
      paidReference: settlement.paymentReference ?? null,
      brokerName: await brokerNameFor(ctx, partnership.brokerOrgId),
    },
    lines,
    linesTruncated: truncated,
    summary,
  };
}

async function newCarrierDetails(ctx: QueryCtx, orgCandidates: string[], rawId: string) {
  const id = ctx.db.normalizeId('settlements', rawId);
  const settlement = id ? await ctx.db.get(id) : null;
  if (!settlement || settlement.payeeType !== 'CARRIER' || settlement.status === 'VOID') {
    throw new Error('Statement not found');
  }
  const partnership = await ctx.db.get(settlement.payeeId as Id<'carrierPartnerships'>);
  if (!partnership?.carrierOrgId || !orgCandidates.includes(partnership.carrierOrgId)) {
    throw new Error('Statement not found');
  }

  // Finalized statements can be huge (frozen membership) — bounded fetch with
  // the exact materialized totals as summary. Open periods are one period's
  // worth of items, collected fully.
  const caches = newAdapterCaches();
  let items: Doc<'payItems'>[];
  let truncated = false;
  if (FINALIZED_SETTLEMENT_STATUSES.has(settlement.status)) {
    const fetched = await ctx.db
      .query('payItems')
      .withIndex('by_settlement', (q) => q.eq('settlementId', settlement._id).eq('isVoided', false))
      .take(DETAIL_LINE_CAP + 1);
    truncated = fetched.length > DETAIL_LINE_CAP;
    items = truncated ? fetched.slice(0, DETAIL_LINE_CAP) : fetched;
  } else {
    items = await payItemsForSettlement(ctx, settlement);
    truncated = items.length > DETAIL_LINE_CAP;
    if (truncated) items = items.slice(0, DETAIL_LINE_CAP);
  }

  const wsCaches = newWorkStartCaches();
  const lines: MobileStatementLine[] = [];
  for (const it of items) {
    if (it.isVoided) continue;
    const category = bucketToCategory(await bucketOf(ctx, caches, it.componentId as string));
    const dollars = Number(it.amountCents) / 100;
    lines.push({
      id: it._id as string,
      description: it.description,
      quantity: it.quantity,
      rate: Number(it.rateMicroCents) / 100000,
      totalAmount: category === 'DEDUCTION' ? -dollars : dollars,
      category,
      kind: it.kind === 'MANUAL_ADJUSTMENT' ? 'MANUAL' : 'SYSTEM',
      loadLabel: it.sourceRef.loadId ? await loadLabel(ctx, wsCaches.loads, it.sourceRef.loadId) : null,
      workStart: it.periodAnchorAt,
      workEnd: null,
      shiftLoads: null,
    });
  }
  lines.sort((a, b) => (a.workStart ?? 0) - (b.workStart ?? 0));

  let summary: {
    earnTotal: number; reimbTotal: number; deductTotal: number; net: number;
    lineCount: number | null; loadCount: number | null;
  };
  if (truncated) {
    const t = settlement.totals;
    const adjustments = Number(t.adjustmentsCents) / 100;
    summary = {
      earnTotal: Number(t.grossCents) / 100 + Math.max(adjustments, 0),
      reimbTotal: 0,
      deductTotal:
        Number(t.deductionsCents + t.taxWithholdingCents + t.garnishmentsCents) / 100 +
        Math.max(-adjustments, 0),
      net: Number(t.netCents) / 100,
      lineCount: t.itemCount,
      loadCount: null,
    };
  } else {
    const s = summarizeLines(await linesFromItems(ctx, caches, items));
    summary = {
      earnTotal: s.earnTotal, reimbTotal: s.reimbTotal, deductTotal: s.deductTotal,
      net: s.net, lineCount: s.lineCount, loadCount: s.loadCount,
    };
  }

  return {
    statement: {
      id: settlement._id as string,
      source: 'ledger' as const,
      statementNumber: (settlement.statementNumber ?? null) as string | null,
      status: mobileStatus(toLegacyStatus(settlement.status), settlement.periodEnd)!,
      periodStart: settlement.periodStart,
      periodEnd: settlement.periodEnd,
      payDate: payDateFromTerms(settlement.periodEnd, partnership.defaultPaymentTerms),
      paidAt: settlement.paidAt ?? null,
      paidMethod: settlement.paymentMethod ?? null,
      paidReference: settlement.paymentReference ?? null,
      brokerName: await brokerNameFor(ctx, partnership.brokerOrgId),
    },
    lines,
    linesTruncated: truncated,
    summary,
  };
}
