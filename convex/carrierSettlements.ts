import { v } from 'convex/values';
import { internalMutation, mutation, query } from './_generated/server';
import { internal } from './_generated/api';
import { Doc, Id } from './_generated/dataModel';
import { assertCallerOwnsOrg, requireCallerOrgId, requireCallerIdentity } from './lib/auth';
import { paginationOptsValidator } from 'convex/server';
import {
  ageDays,
  applyAcknowledgements,
  bucketForSettlement,
  cadenceFromPaymentTerms,
  classifyPayable,
  computeCarrierBlockers,
  loadsForPayables,
  newWorkStartCaches,
  nextStatementNumber,
  payDateFromTerms,
  resolveCarrierPayBasis,
  resolveWorkStartTimestamp,
  summarizeLines,
  unitsLabel,
  type PayBasisInfo,
} from './lib/settlementShared';

/**
 * Carrier Settlement Engine
 *
 * The carrier mirror of convex/driverSettlements.ts: groups loadCarrierPayables
 * into pay-period statements per carrier partnership and drives the same
 * approval workflow (DRAFT → PENDING → APPROVED → PAID, with VOID / DISPUTED).
 *
 * Key Features:
 * - Groups carrier payables by pay period
 * - Statement numbering (CST-YYYY-NNN, per org per year)
 * - Approval workflow with frozen totals
 * - Settlements Hub queries returning the same row shape as the driver engine
 *   so the web UI renders either party with one component
 */

// ============================================
// HELPER FUNCTIONS
// ============================================

/**
 * Generate unique statement number (CST-YYYY-NNN) via the settlementCounters
 * doc — one read + one write instead of collecting every settlement in the
 * org per generated statement.
 */
async function generateCarrierStatementNumber(
  ctx: any,
  workosOrgId: string
): Promise<string> {
  return nextStatementNumber(ctx, { workosOrgId, scope: 'CARRIER' });
}

/**
 * Unassigned payables for a partnership whose WORK START falls within the
 * period window. Work is attributed to when it was done — the load's first
 * pickup (see lib/settlementShared.resolveWorkStartTimestamp) — never
 * payable.createdAt, which is just when the pay calculation ran. Standalone
 * adjustments (no load) date by createdAt.
 */
async function unassignedCarrierPayablesInWindow(
  ctx: any,
  carrierPartnershipId: Id<'carrierPartnerships'>,
  periodStart: number,
  periodEnd: number
): Promise<Array<Doc<'loadCarrierPayables'>>> {
  const allUnassigned = await ctx.db
    .query('loadCarrierPayables')
    .withIndex('by_carrier_unassigned', (q: any) =>
      q.eq('carrierPartnershipId', carrierPartnershipId).eq('settlementId', undefined)
    )
    .collect();

  const caches = newWorkStartCaches();
  const inWindow: Array<Doc<'loadCarrierPayables'>> = [];
  for (const payable of allUnassigned as Array<Doc<'loadCarrierPayables'>>) {
    const workStart = await resolveWorkStartTimestamp(ctx, payable, caches);
    if (workStart != null && workStart >= periodStart && workStart <= periodEnd) {
      inWindow.push(payable);
    }
  }
  return inWindow;
}

/**
 * Prevent two statements for the same partnership + exact period.
 * VOID statements don't block regeneration.
 */
async function assertNoDuplicateCarrierStatement(
  ctx: any,
  carrierPartnershipId: Id<'carrierPartnerships'>,
  periodStart: number,
  periodEnd: number
): Promise<void> {
  const existing = await ctx.db
    .query('carrierSettlements')
    .withIndex('by_carrier_partnership', (q: any) =>
      q.eq('carrierPartnershipId', carrierPartnershipId)
    )
    .collect();

  const duplicate = (existing as Array<Doc<'carrierSettlements'>>).find(
    (s) =>
      s.status !== 'VOID' &&
      s.periodStart === periodStart &&
      s.periodEnd === periodEnd
  );
  if (duplicate) {
    throw new Error(
      `A statement already exists for this carrier and period (${duplicate.statementNumber ?? duplicate._id})`
    );
  }
}

/**
 * Insert a DRAFT carrier settlement and assign the given payables to it.
 * Totals come from summarizeLines: gross = earnings + reimbursements,
 * deductions stored as positive magnitude, net = gross - deductions.
 */
async function insertCarrierStatement(
  ctx: any,
  opts: {
    partnership: Doc<'carrierPartnerships'>;
    workosOrgId: string;
    periodStart: number;
    periodEnd: number;
    userId: string;
    statementNumber: string;
    payables: Array<Doc<'loadCarrierPayables'>>;
  }
): Promise<{ settlementId: Id<'carrierSettlements'>; totalNet: number }> {
  const now = Date.now();
  const summary = summarizeLines(opts.payables);

  const settlementId = await ctx.db.insert('carrierSettlements', {
    carrierPartnershipId: opts.partnership._id,
    workosOrgId: opts.workosOrgId,
    periodStart: opts.periodStart,
    periodEnd: opts.periodEnd,
    status: 'DRAFT',
    statementNumber: opts.statementNumber,
    totalGross: summary.earnTotal + summary.reimbTotal,
    totalDeductions: summary.deductTotal,
    totalNet: summary.net,
    carrierName: opts.partnership.carrierName,
    carrierMcNumber: opts.partnership.mcNumber,
    createdAt: now,
    createdBy: opts.userId,
    updatedAt: now,
  });

  for (const payable of opts.payables) {
    await ctx.db.patch(payable._id, {
      settlementId,
      updatedAt: now,
    });
  }

  return { settlementId, totalNet: summary.net };
}

// ============================================
// SETTLEMENTS HUB (web redesign)
// ============================================
//
// Mirrors the driver Settlements Hub (see the end of driverSettlements.ts):
// active rows (DRAFT + PENDING) ship as one enriched, bucketed list; settled
// history (APPROVED / PAID / VOID / DISPUTED) is paginated. Rows share the
// driver row shape so the web UI renders either party with one component.

interface CarrierEnrichCaches {
  partnerships: Map<string, Doc<'carrierPartnerships'> | null>;
  payBasis: Map<string, PayBasisInfo | null>;
  loads: Map<string, Doc<'loadInformation'> | null>;
}

const newCarrierCaches = (): CarrierEnrichCaches => ({
  partnerships: new Map(),
  payBasis: new Map(),
  loads: new Map(),
});

/**
 * One settlement → one screen row. Reads payables + referenced loads to
 * compute totals and blockers; resolves pay basis from the carrier's
 * rate-profile assignment and cadence / pay date from payment terms.
 */
async function enrichCarrierSettlement(
  ctx: any,
  settlement: Doc<'carrierSettlements'>,
  caches: CarrierEnrichCaches,
  options: { withBlockers: boolean },
) {
  const partnershipKey = settlement.carrierPartnershipId as string;
  let partnership = caches.partnerships.get(partnershipKey);
  if (partnership === undefined) {
    partnership = ((await ctx.db.get(settlement.carrierPartnershipId)) ??
      null) as Doc<'carrierPartnerships'> | null;
    caches.partnerships.set(partnershipKey, partnership);
  }

  let basisInfo = caches.payBasis.get(partnershipKey);
  if (basisInfo === undefined) {
    basisInfo = await resolveCarrierPayBasis(ctx, settlement.carrierPartnershipId);
    caches.payBasis.set(partnershipKey, basisInfo);
  }

  const payables = await ctx.db
    .query('loadCarrierPayables')
    .withIndex('by_settlement', (q: any) => q.eq('settlementId', settlement._id))
    .collect();

  const summary = summarizeLines(payables);
  let blockers: ReturnType<typeof computeCarrierBlockers> = [];
  if (options.withBlockers) {
    const loads = await loadsForPayables(ctx, payables, caches.loads);
    blockers = applyAcknowledgements(
      computeCarrierBlockers({ payables, loads, partnership, net: summary.net }),
      settlement.acknowledgedBlockers,
    );
  }

  const mcNumber = partnership?.mcNumber ?? settlement.carrierMcNumber;
  const payeeSub = partnership
    ? `MC-${partnership.mcNumber} · ${partnership.isOwnerOperator ? 'Owner Op' : 'Fleet'}`
    : mcNumber
      ? `MC-${mcNumber}`
      : null;

  return {
    _id: settlement._id,
    statementNumber: settlement.statementNumber ?? '—',
    status: settlement.status,
    bucket: bucketForSettlement(settlement.status, settlement.periodEnd, blockers),
    payeeId: settlement.carrierPartnershipId,
    payeeName: partnership?.carrierName ?? settlement.carrierName ?? 'Unknown Carrier',
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

export type EnrichedCarrierSettlementRow = Awaited<ReturnType<typeof enrichCarrierSettlement>>;

/** Cap on the active (DRAFT + PENDING) working set returned in one shot. */
const ACTIVE_ROW_CAP = 500;

/**
 * Active settlements (DRAFT + PENDING) for the open / attention / ready
 * views, enriched and bucketed. The active set is bounded by the number of
 * carriers × open periods, so this returns the full filtered set (capped).
 */
export const listActive = query({
  args: {
    workosOrgId: v.string(),
    view: v.union(v.literal('open'), v.literal('attention'), v.literal('ready')),
    search: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    await assertCallerOwnsOrg(ctx, args.workosOrgId);

    const [drafts, pendings] = await Promise.all([
      ctx.db
        .query('carrierSettlements')
        .withIndex('by_org_status', (q) =>
          q.eq('workosOrgId', args.workosOrgId).eq('status', 'DRAFT'),
        )
        .collect(),
      ctx.db
        .query('carrierSettlements')
        .withIndex('by_org_status', (q) =>
          q.eq('workosOrgId', args.workosOrgId).eq('status', 'PENDING'),
        )
        .collect(),
    ]);

    const active = [...drafts, ...pendings]
      .sort((a, b) => b.periodStart - a.periodStart)
      .slice(0, ACTIVE_ROW_CAP);

    const caches = newCarrierCaches();
    const rows = [];
    for (const settlement of active) {
      rows.push(await enrichCarrierSettlement(ctx, settlement, caches, { withBlockers: true }));
    }

    let filtered = rows.filter((r) => r.bucket === args.view);
    if (args.search && args.search.trim() !== '') {
      const needle = args.search.toLowerCase().trim();
      filtered = filtered.filter(
        (r) =>
          r.statementNumber.toLowerCase().includes(needle) ||
          r.payeeName.toLowerCase().includes(needle),
      );
    }
    return { rows: filtered, truncated: active.length === ACTIVE_ROW_CAP };
  },
});

/**
 * Settled history (APPROVED / PAID / VOID / DISPUTED) — properly paginated
 * since paid history grows without bound.
 */
export const listSettled = query({
  args: {
    workosOrgId: v.string(),
    status: v.union(
      v.literal('APPROVED'),
      v.literal('PAID'),
      v.literal('VOID'),
      v.literal('DISPUTED'),
    ),
    paginationOpts: paginationOptsValidator,
    search: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    await assertCallerOwnsOrg(ctx, args.workosOrgId);

    const result = await ctx.db
      .query('carrierSettlements')
      .withIndex('by_org_status', (q) =>
        q.eq('workosOrgId', args.workosOrgId).eq('status', args.status),
      )
      .order('desc')
      .paginate(args.paginationOpts);

    const caches = newCarrierCaches();
    let page = [];
    for (const settlement of result.page) {
      // Blockers only matter pre-approval; settled rows skip the load reads.
      page.push(await enrichCarrierSettlement(ctx, settlement, caches, { withBlockers: false }));
    }

    if (args.search && args.search.trim() !== '') {
      const needle = args.search.toLowerCase().trim();
      page = page.filter(
        (r) =>
          r.statementNumber.toLowerCase().includes(needle) ||
          r.payeeName.toLowerCase().includes(needle),
      );
    }

    return { ...result, page };
  },
});

/**
 * View counts + header stats for the settlements screen:
 * due this run (ready + approved net), open accruing, blocked net, paid MTD.
 */
export const getViewStats = query({
  args: { workosOrgId: v.string() },
  handler: async (ctx, args) => {
    await assertCallerOwnsOrg(ctx, args.workosOrgId);

    const [drafts, pendings, approved] = await Promise.all([
      ctx.db
        .query('carrierSettlements')
        .withIndex('by_org_status', (q) =>
          q.eq('workosOrgId', args.workosOrgId).eq('status', 'DRAFT'),
        )
        .collect(),
      ctx.db
        .query('carrierSettlements')
        .withIndex('by_org_status', (q) =>
          q.eq('workosOrgId', args.workosOrgId).eq('status', 'PENDING'),
        )
        .collect(),
      ctx.db
        .query('carrierSettlements')
        .withIndex('by_org_status', (q) =>
          q.eq('workosOrgId', args.workosOrgId).eq('status', 'APPROVED'),
        )
        .collect(),
    ]);

    const caches = newCarrierCaches();
    let openCount = 0;
    let attentionCount = 0;
    let readyCount = 0;
    let openAccruing = 0;
    let readyNet = 0;
    let blockedNet = 0;
    let oldestBlockedId: Id<'carrierSettlements'> | null = null;
    let oldestBlockedAge = -1;

    for (const settlement of [...drafts, ...pendings].slice(0, ACTIVE_ROW_CAP)) {
      const row = await enrichCarrierSettlement(ctx, settlement, caches, { withBlockers: true });
      if (row.bucket === 'open') {
        openCount++;
        openAccruing += row.net;
      } else if (row.bucket === 'attention') {
        attentionCount++;
        blockedNet += Math.max(row.net, 0);
        if (row.ageDays > oldestBlockedAge) {
          oldestBlockedAge = row.ageDays;
          oldestBlockedId = settlement._id;
        }
      } else {
        readyCount++;
        readyNet += row.net;
      }
    }

    // Approved totals were frozen at approval time.
    const approvedNet = approved.reduce((sum, s) => sum + (s.totalNet ?? s.totalGross ?? 0), 0);

    // Paid month-to-date. Recent-first scan capped — paid history is the one
    // unbounded status; a month of statements sits far below the cap.
    const monthStart = new Date();
    monthStart.setDate(1);
    monthStart.setHours(0, 0, 0, 0);
    const paidRecent = await ctx.db
      .query('carrierSettlements')
      .withIndex('by_org_status', (q) =>
        q.eq('workosOrgId', args.workosOrgId).eq('status', 'PAID'),
      )
      .order('desc')
      .take(1000);
    const paidMtd = paidRecent
      .filter((s) => (s.paidAt ?? 0) >= monthStart.getTime())
      .reduce((sum, s) => sum + (s.totalNet ?? 0), 0);

    const [paidCount, voidCount, disputedCount] = await Promise.all([
      ctx.db
        .query('carrierSettlements')
        .withIndex('by_org_status', (q) =>
          q.eq('workosOrgId', args.workosOrgId).eq('status', 'PAID'),
        )
        .collect()
        .then((r) => r.length),
      ctx.db
        .query('carrierSettlements')
        .withIndex('by_org_status', (q) =>
          q.eq('workosOrgId', args.workosOrgId).eq('status', 'VOID'),
        )
        .collect()
        .then((r) => r.length),
      ctx.db
        .query('carrierSettlements')
        .withIndex('by_org_status', (q) =>
          q.eq('workosOrgId', args.workosOrgId).eq('status', 'DISPUTED'),
        )
        .collect()
        .then((r) => r.length),
    ]);

    return {
      counts: {
        attention: attentionCount,
        open: openCount,
        ready: readyCount,
        approved: approved.length,
        paid: paidCount,
        void: voidCount,
        disputed: disputedCount,
      },
      dueThisRun: readyNet + approvedNet,
      openAccruing,
      blockedNet,
      paidMtd,
      oldestBlockedId,
    };
  },
});

/**
 * Detailed settlement view: raw doc + partnership snapshot + classified
 * payable lines + blockers + line summary.
 */
export const getSettlementDetails = query({
  args: {
    settlementId: v.id('carrierSettlements'),
  },
  handler: async (ctx, args) => {
    const callerOrgId = await requireCallerOrgId(ctx);
    const settlement = await ctx.db.get(args.settlementId);
    if (!settlement) throw new Error('Settlement not found');
    if (settlement.workosOrgId !== callerOrgId) {
      throw new Error('Settlement not found');
    }

    const partnership = await ctx.db.get(settlement.carrierPartnershipId);

    const payables = await ctx.db
      .query('loadCarrierPayables')
      .withIndex('by_settlement', (q) => q.eq('settlementId', args.settlementId))
      .collect();

    const loadCache = new Map<string, Doc<'loadInformation'> | null>();
    const detailCaches = newWorkStartCaches();
    detailCaches.loads = loadCache; // share the load reads with the loop below
    const enrichedPayables = [];
    for (const payable of payables) {
      let loadInternalId: string | undefined = undefined;
      let loadOrderNumber: string | undefined = undefined;
      if (payable.loadId) {
        let load = loadCache.get(payable.loadId);
        if (load === undefined) {
          load = ((await ctx.db.get(payable.loadId)) ?? null) as Doc<'loadInformation'> | null;
          loadCache.set(payable.loadId, load);
        }
        loadInternalId = load?.internalId;
        loadOrderNumber = load?.orderNumber;
      }

      const workStart = await resolveWorkStartTimestamp(ctx as any, payable, detailCaches);

      enrichedPayables.push({
        _id: payable._id,
        loadId: payable.loadId,
        loadInternalId,
        loadOrderNumber,
        description: payable.description,
        quantity: payable.quantity,
        rate: payable.rate,
        totalAmount: payable.totalAmount,
        sourceType: payable.sourceType,
        category: classifyPayable(payable),
        isLocked: payable.isLocked,
        warningMessage: payable.warningMessage,
        createdAt: payable.createdAt,
        // When the work happened (load first pickup) — drives day grouping.
        workStart: workStart ?? undefined,
        workEnd: undefined as number | undefined,
        // Review-edit state (carrier lines: rate/quantity only).
        edited: payable.editedAt != null,
        breakMinutes: undefined as number | undefined,
        clockStart: undefined as number | undefined,
        clockEnd: undefined as number | undefined,
        originalRate: payable.originalRate,
        originalQuantity: payable.originalQuantity,
        originalTotalAmount: payable.originalTotalAmount,
        rulesChanged: payable.rulesChangedAt != null,
        rulesAmount: payable.rulesAmount,
      });
    }

    const summary = summarizeLines(payables);
    // DbReaderCtx is a narrow structural surface; the generated QueryCtx
    // doesn't satisfy it nominally (same pattern as the ctx:any enrich helper).
    const loads = await loadsForPayables(ctx as any, payables, loadCache);
    const blockers = applyAcknowledgements(
      computeCarrierBlockers({
        payables,
        loads,
        partnership: partnership ?? null,
        net: summary.net,
      }),
      settlement.acknowledgedBlockers,
    );

    return {
      settlement,
      partnership: partnership
        ? {
            _id: partnership._id,
            name: partnership.carrierName,
            mcNumber: partnership.mcNumber,
            isOwnerOperator: partnership.isOwnerOperator,
            defaultPaymentTerms: partnership.defaultPaymentTerms,
            insuranceExpiration: partnership.insuranceExpiration,
            insuranceCoverageVerified: partnership.insuranceCoverageVerified,
          }
        : null,
      payables: enrichedPayables,
      blockers,
      summary,
    };
  },
});

// ============================================
// MUTATIONS
// ============================================

/**
 * Generate a new settlement statement for one carrier partnership.
 * Gathers all unassigned payables whose createdAt falls within the period.
 */
export const generateStatement = mutation({
  args: {
    carrierPartnershipId: v.id('carrierPartnerships'),
    periodStart: v.float64(),
    periodEnd: v.float64(),
    workosOrgId: v.string(),
    userId: v.string(),
  },
  handler: async (ctx, args) => {
    const { orgId: callerOrgId, userId } = await assertCallerOwnsOrg(ctx, args.workosOrgId);
    const partnership = await ctx.db.get(args.carrierPartnershipId);
    if (!partnership || partnership.brokerOrgId !== callerOrgId) {
      throw new Error('Carrier partnership not found');
    }

    await assertNoDuplicateCarrierStatement(
      ctx,
      args.carrierPartnershipId,
      args.periodStart,
      args.periodEnd
    );

    const payables = await unassignedCarrierPayablesInWindow(
      ctx,
      args.carrierPartnershipId,
      args.periodStart,
      args.periodEnd
    );

    const statementNumber = await generateCarrierStatementNumber(ctx, args.workosOrgId);

    const { settlementId, totalNet } = await insertCarrierStatement(ctx, {
      partnership,
      workosOrgId: args.workosOrgId,
      periodStart: args.periodStart,
      periodEnd: args.periodEnd,
      userId,
      statementNumber,
      payables,
    });

    return {
      settlementId,
      statementNumber,
      payablesAssigned: payables.length,
      totalNet,
    };
  },
});

/**
 * Per-partnership statement generation — the fan-out target for
 * generateForAllCarriers. One bounded transaction per chunk: a carrier's
 * unassigned backlog can exceed the per-transaction read budget (observed:
 * 2,700+ payables), so each run scans one page of unassigned payables,
 * assigns the in-window ones, and reschedules itself with the continuation
 * cursor. The first page with matches creates the DRAFT; later pages top it
 * up and roll the denormalized totals forward.
 */
export const generateForPartnership = internalMutation({
  args: {
    carrierPartnershipId: v.id('carrierPartnerships'),
    workosOrgId: v.string(),
    periodStart: v.float64(),
    periodEnd: v.float64(),
    userId: v.string(),
    /** Continuation cursor for chunked sweeps (self-rescheduled). */
    cursor: v.optional(v.string()),
  },
  returns: v.null(),
  handler: async (ctx, args) => {
    const partnership = await ctx.db.get(args.carrierPartnershipId);
    if (!partnership || partnership.brokerOrgId !== args.workosOrgId) return null;

    // Exact-period statement, if any: DRAFT → top up; anything else
    // (non-VOID) is owned by the approval workflow → skip.
    const statements = await ctx.db
      .query('carrierSettlements')
      .withIndex('by_carrier_partnership', (q: any) =>
        q.eq('carrierPartnershipId', args.carrierPartnershipId)
      )
      .collect();
    let existing = (statements as Array<Doc<'carrierSettlements'>>).find(
      (s) =>
        s.status !== 'VOID' &&
        s.periodStart === args.periodStart &&
        s.periodEnd === args.periodEnd,
    );
    if (existing && existing.status !== 'DRAFT') return null;

    const CHUNK = 200;
    const page = await ctx.db
      .query('loadCarrierPayables')
      .withIndex('by_carrier_unassigned', (q: any) =>
        q.eq('carrierPartnershipId', args.carrierPartnershipId).eq('settlementId', undefined)
      )
      .paginate({ numItems: CHUNK, cursor: args.cursor ?? null });

    const caches = newWorkStartCaches();
    const inWindow: Array<Doc<'loadCarrierPayables'>> = [];
    for (const payable of page.page as Array<Doc<'loadCarrierPayables'>>) {
      const workStart = await resolveWorkStartTimestamp(ctx, payable, caches);
      if (workStart != null && workStart >= args.periodStart && workStart <= args.periodEnd) {
        inWindow.push(payable);
      }
    }

    if (inWindow.length > 0) {
      const now = Date.now();
      if (!existing) {
        const statementNumber = await generateCarrierStatementNumber(ctx, args.workosOrgId);
        await insertCarrierStatement(ctx, {
          partnership,
          workosOrgId: args.workosOrgId,
          periodStart: args.periodStart,
          periodEnd: args.periodEnd,
          userId: args.userId,
          statementNumber,
          payables: inWindow,
        });
      } else {
        // Top up the DRAFT and roll the denormalized totals forward.
        const summary = summarizeLines(inWindow);
        for (const payable of inWindow) {
          await ctx.db.patch(payable._id, { settlementId: existing._id, updatedAt: now });
        }
        await ctx.db.patch(existing._id, {
          totalGross: (existing.totalGross ?? 0) + summary.earnTotal + summary.reimbTotal,
          totalDeductions: (existing.totalDeductions ?? 0) + summary.deductTotal,
          totalNet: (existing.totalNet ?? 0) + summary.net,
          updatedAt: now,
        });
      }
    }

    if (!page.isDone) {
      await ctx.scheduler.runAfter(0, internal.carrierSettlements.generateForPartnership, {
        carrierPartnershipId: args.carrierPartnershipId,
        workosOrgId: args.workosOrgId,
        periodStart: args.periodStart,
        periodEnd: args.periodEnd,
        userId: args.userId,
        cursor: page.continueCursor,
      });
    }
    return null;
  },
});

/**
 * Bulk statement generation: one DRAFT statement per ACTIVE partnership with
 * unassigned payables in the window. Fans out one scheduled transaction per
 * partnership — the monolithic loop hit Convex's system-operation limit at
 * fleet scale (same failure mode as the old driver bulkGenerateByPlan).
 * Statements stream into the list reactively as each transaction commits.
 */
export const generateForAllCarriers = mutation({
  args: {
    workosOrgId: v.string(),
    periodStart: v.float64(),
    periodEnd: v.float64(),
    userId: v.string(),
  },
  returns: v.object({ scheduled: v.number() }),
  handler: async (ctx, args) => {
    const { userId } = await assertCallerOwnsOrg(ctx, args.workosOrgId);

    const partnerships = await ctx.db
      .query('carrierPartnerships')
      .withIndex('by_broker', (q) =>
        q.eq('brokerOrgId', args.workosOrgId).eq('status', 'ACTIVE'),
      )
      .collect();

    let scheduled = 0;
    for (const partnership of partnerships) {
      // Stagger slightly so the statement-number counter doc isn't hammered
      // by N simultaneous transactions (OCC retries are safe but wasteful).
      await ctx.scheduler.runAfter(
        scheduled * 150,
        internal.carrierSettlements.generateForPartnership,
        {
          carrierPartnershipId: partnership._id,
          workosOrgId: args.workosOrgId,
          periodStart: args.periodStart,
          periodEnd: args.periodEnd,
          userId,
        },
      );
      scheduled++;
    }

    return { scheduled };
  },
});

/**
 * Reviewer acknowledges (verifies) a readiness blocker so it no longer gates
 * approval — recorded with who/when for audit. Mirrors the driver engine.
 */
export const acknowledgeBlocker = mutation({
  args: {
    settlementId: v.id('carrierSettlements'),
    blockerKey: v.string(),
    note: v.optional(v.string()),
    userId: v.string(),
  },
  returns: v.null(),
  handler: async (ctx, args) => {
    const { orgId: callerOrgId, userId } = await requireCallerIdentity(ctx);
    const settlement = await ctx.db.get(args.settlementId);
    if (!settlement || settlement.workosOrgId !== callerOrgId) throw new Error('Settlement not found');
    if (settlement.status === 'APPROVED' || settlement.status === 'PAID') {
      throw new Error('Settlement is already finalized');
    }
    const existing = settlement.acknowledgedBlockers ?? [];
    if (existing.some((a) => a.key === args.blockerKey)) return null;
    await ctx.db.patch(args.settlementId, {
      acknowledgedBlockers: [...existing, { key: args.blockerKey, by: userId, at: Date.now(), note: args.note }],
      updatedAt: Date.now(),
    });
    return null;
  },
});

export const unacknowledgeBlocker = mutation({
  args: { settlementId: v.id('carrierSettlements'), blockerKey: v.string() },
  returns: v.null(),
  handler: async (ctx, args) => {
    const callerOrgId = await requireCallerOrgId(ctx);
    const settlement = await ctx.db.get(args.settlementId);
    if (!settlement || settlement.workosOrgId !== callerOrgId) throw new Error('Settlement not found');
    if (settlement.status === 'APPROVED' || settlement.status === 'PAID') return null;
    await ctx.db.patch(args.settlementId, {
      acknowledgedBlockers: (settlement.acknowledgedBlockers ?? []).filter((a) => a.key !== args.blockerKey),
      updatedAt: Date.now(),
    });
    return null;
  },
});

/**
 * Update settlement status with approval workflow
 * When moving to APPROVED, freeze the totals and lock the payables.
 */
export const updateSettlementStatus = mutation({
  args: {
    settlementId: v.id('carrierSettlements'),
    newStatus: v.union(
      v.literal('DRAFT'),
      v.literal('PENDING'),
      v.literal('APPROVED'),
      v.literal('PAID'),
      v.literal('VOID'),
      v.literal('DISPUTED')
    ),
    userId: v.string(),
    notes: v.optional(v.string()),
    paidMethod: v.optional(v.string()),
    paidReference: v.optional(v.string()),
    voidReason: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    const { orgId: callerOrgId, userId } = await requireCallerIdentity(ctx);
    const settlement = await ctx.db.get(args.settlementId);
    if (!settlement) throw new Error('Settlement not found');
    if (settlement.workosOrgId !== callerOrgId) {
      throw new Error('Settlement not found');
    }

    const now = Date.now();
    const updates: Partial<Doc<'carrierSettlements'>> = {
      status: args.newStatus,
      updatedAt: now,
    };

    // Status-specific logic
    if (args.newStatus === 'APPROVED') {
      // FREEZE the totals - recompute from payables and lock
      const payables = await ctx.db
        .query('loadCarrierPayables')
        .withIndex('by_settlement', (q) => q.eq('settlementId', args.settlementId))
        .collect();

      const summary = summarizeLines(payables);
      updates.totalGross = summary.earnTotal + summary.reimbTotal;
      updates.totalDeductions = summary.deductTotal;
      updates.totalNet = summary.net;
      updates.approvedBy = userId;
      updates.approvedAt = now;

      // Lock payables when settlement is approved
      for (const payable of payables) {
        await ctx.db.patch(payable._id, {
          approvedAt: now,
          isLocked: true,
          updatedAt: now,
        });
      }
    } else if (args.newStatus === 'PAID') {
      updates.paidAt = now;
      updates.paidBy = userId;
      updates.paymentMethod = args.paidMethod;
      updates.paymentReference = args.paidReference;
    } else if (args.newStatus === 'VOID') {
      updates.voidedBy = userId;
      updates.voidedAt = now;
      updates.voidReason = args.voidReason;
    }

    if (args.notes) {
      updates.notes = args.notes;
    }

    await ctx.db.patch(args.settlementId, updates);

    return null;
  },
});

/**
 * Reverse a recorded payment: PAID → APPROVED.
 *
 * Undoes a mistaken "Record payment" — restores the statement to its approved
 * (still-locked) state and clears the payment stamps so it can be re-recorded.
 * Totals stay frozen from approval; payables stay locked. Only a currently-PAID
 * statement can be reversed.
 */
export const reversePayment = mutation({
  args: {
    settlementId: v.id('carrierSettlements'),
  },
  returns: v.null(),
  handler: async (ctx, args) => {
    const { orgId: callerOrgId } = await requireCallerIdentity(ctx);
    const settlement = await ctx.db.get(args.settlementId);
    if (!settlement) throw new Error('Settlement not found');
    if (settlement.workosOrgId !== callerOrgId) {
      throw new Error('Settlement not found');
    }
    if (settlement.status !== 'PAID') {
      throw new Error('Only a paid statement can have its payment reversed');
    }

    await ctx.db.patch(args.settlementId, {
      status: 'APPROVED',
      paidAt: undefined,
      paidBy: undefined,
      paymentMethod: undefined,
      paymentReference: undefined,
      updatedAt: Date.now(),
    });

    return null;
  },
});

/**
 * Reopen an APPROVED carrier statement back to DRAFT to correct a mistake.
 * Mirrors driverSettlements.reopenSettlement: clears approval stamps, unlocks
 * pristine SYSTEM lines (reviewer-edited + manual stay locked), records the
 * reopen for audit. PAID statements must be payment-reversed first.
 */
export const reopenSettlement = mutation({
  args: {
    settlementId: v.id('carrierSettlements'),
    reason: v.string(),
  },
  returns: v.null(),
  handler: async (ctx, args) => {
    const { orgId: callerOrgId, userId } = await requireCallerIdentity(ctx);
    const settlement = await ctx.db.get(args.settlementId);
    if (!settlement || settlement.workosOrgId !== callerOrgId) {
      throw new Error('Settlement not found');
    }
    if (settlement.status !== 'APPROVED') {
      throw new Error(
        settlement.status === 'PAID'
          ? 'Reverse the payment before reopening a paid statement'
          : 'Only an approved statement can be reopened',
      );
    }
    const reason = args.reason.trim();
    if (!reason) throw new Error('A reason is required to reopen a statement');

    const now = Date.now();
    const payables = await ctx.db
      .query('loadCarrierPayables')
      .withIndex('by_settlement', (q) => q.eq('settlementId', args.settlementId))
      .collect();
    for (const p of payables) {
      await ctx.db.patch(p._id, {
        approvedAt: undefined,
        isLocked: p.sourceType === 'MANUAL' || p.editedAt != null,
        updatedAt: now,
      });
    }

    await ctx.db.patch(args.settlementId, {
      status: 'DRAFT',
      approvedBy: undefined,
      approvedAt: undefined,
      reopenedBy: userId,
      reopenedAt: now,
      reopenReason: reason,
      updatedAt: now,
    });

    return null;
  },
});

/**
 * Add a manual adjustment to a settlement
 * This is the "Quick Add" feature for accountants
 */
export const addManualAdjustment = mutation({
  args: {
    settlementId: v.id('carrierSettlements'),
    carrierPartnershipId: v.id('carrierPartnerships'),
    loadId: v.optional(v.id('loadInformation')),
    description: v.string(),
    amount: v.float64(),
    category: v.optional(v.union(
      v.literal('EARNING'),
      v.literal('REIMBURSEMENT'),
      v.literal('DEDUCTION'),
    )),
    workosOrgId: v.string(),
    userId: v.string(),
  },
  handler: async (ctx, args) => {
    const { orgId: callerOrgId, userId } = await assertCallerOwnsOrg(ctx, args.workosOrgId);
    const settlement = await ctx.db.get(args.settlementId);
    if (!settlement) throw new Error('Settlement not found');
    if (settlement.workosOrgId !== callerOrgId) {
      throw new Error('Settlement not found');
    }

    // Cannot add to approved/paid settlements
    if (settlement.status === 'APPROVED' || settlement.status === 'PAID') {
      throw new Error('Cannot add adjustments to approved or paid settlements');
    }

    const now = Date.now();

    const payableId = await ctx.db.insert('loadCarrierPayables', {
      loadId: args.loadId,
      legId: undefined,
      carrierPartnershipId: args.carrierPartnershipId,
      settlementId: args.settlementId,
      description: args.description,
      quantity: 1,
      rate: args.amount,
      totalAmount: args.amount,
      sourceType: 'MANUAL',
      // Deductions are stored as negative amounts; default classification
      // follows the sign unless the caller picks a section explicitly.
      category: args.category ?? (args.amount < 0 ? 'DEDUCTION' : 'EARNING'),
      isLocked: true, // Manual adjustments are always locked
      workosOrgId: args.workosOrgId,
      createdAt: now,
      createdBy: userId,
      updatedAt: now,
    });

    // Shadow dual-write: mirror this manual adjustment into the new-ledger payItems.
    await ctx.scheduler.runAfter(0, internal.payEngine.manualCoverage.syncManualPayItem, {
      workosOrgId: args.workosOrgId, table: 'loadCarrierPayables', payableId,
    });

    return payableId;
  },
});

/**
 * Review-time line edit — override a SYSTEM carrier line's rate (and/or
 * quantity) in place, recompute amount, lock it, preserve the original for
 * audit. Carriers have no shift/session lines, so this is rate/quantity only.
 */
export const editPayableLine = mutation({
  args: {
    payableId: v.id('loadCarrierPayables'),
    rate: v.optional(v.float64()),
    quantity: v.optional(v.float64()),
    reason: v.optional(v.string()),
    userId: v.string(),
  },
  returns: v.object({ totalAmount: v.float64(), quantity: v.float64(), rate: v.float64() }),
  handler: async (ctx, args) => {
    const { orgId: callerOrgId, userId } = await requireCallerIdentity(ctx);
    const payable = await ctx.db.get(args.payableId);
    if (!payable || payable.workosOrgId !== callerOrgId) throw new Error('Line not found');
    if (payable.settlementId) {
      const settlement = await ctx.db.get(payable.settlementId);
      if (settlement && (settlement.status === 'APPROVED' || settlement.status === 'PAID')) {
        throw new Error('Cannot edit a finalized settlement');
      }
    }
    const now = Date.now();
    const newRate = args.rate != null ? +args.rate.toFixed(4) : payable.rate;
    const newQuantity = args.quantity != null ? args.quantity : payable.quantity;
    const newTotal = +(newQuantity * newRate).toFixed(2);
    const firstEdit = payable.editedAt == null;
    await ctx.db.patch(args.payableId, {
      rate: newRate,
      quantity: newQuantity,
      totalAmount: newTotal,
      isLocked: true,
      editedAt: now,
      editedBy: userId,
      editReason: args.reason ?? payable.editReason,
      ...(firstEdit
        ? {
            originalQuantity: payable.quantity,
            originalRate: payable.rate,
            originalTotalAmount: payable.totalAmount,
          }
        : {}),
      updatedAt: now,
    });
    return { totalAmount: newTotal, quantity: newQuantity, rate: newRate };
  },
});

export const revertPayableEdit = mutation({
  args: { payableId: v.id('loadCarrierPayables') },
  returns: v.null(),
  handler: async (ctx, args) => {
    const callerOrgId = await requireCallerOrgId(ctx);
    const payable = await ctx.db.get(args.payableId);
    if (!payable || payable.workosOrgId !== callerOrgId) throw new Error('Line not found');
    if (payable.editedAt == null) return null;
    if (payable.settlementId) {
      const settlement = await ctx.db.get(payable.settlementId);
      if (settlement && (settlement.status === 'APPROVED' || settlement.status === 'PAID')) {
        throw new Error('Cannot edit a finalized settlement');
      }
    }
    await ctx.db.patch(args.payableId, {
      quantity: payable.originalQuantity ?? payable.quantity,
      rate: payable.originalRate ?? payable.rate,
      totalAmount: payable.originalTotalAmount ?? payable.totalAmount,
      originalQuantity: undefined,
      originalRate: undefined,
      originalTotalAmount: undefined,
      editedAt: undefined,
      editedBy: undefined,
      editReason: undefined,
      rulesAmount: undefined,
      rulesChangedAt: undefined,
      isLocked: payable.sourceType === 'MANUAL',
      updatedAt: Date.now(),
    });
    return null;
  },
});

/** Adopt the rules engine's current amount for a drifted carrier line. */
export const applyRulesAmount = mutation({
  args: { payableId: v.id('loadCarrierPayables') },
  returns: v.null(),
  handler: async (ctx, args) => {
    const callerOrgId = await requireCallerOrgId(ctx);
    const payable = await ctx.db.get(args.payableId);
    if (!payable || payable.workosOrgId !== callerOrgId) throw new Error('Line not found');
    if (payable.rulesAmount == null) return null;
    if (payable.settlementId) {
      const settlement = await ctx.db.get(payable.settlementId);
      if (settlement && (settlement.status === 'APPROVED' || settlement.status === 'PAID')) {
        throw new Error('Cannot edit a finalized settlement');
      }
    }
    const newTotal = payable.rulesAmount;
    await ctx.db.patch(args.payableId, {
      totalAmount: newTotal,
      rate: payable.quantity ? +(newTotal / payable.quantity).toFixed(4) : newTotal,
      originalQuantity: undefined,
      originalRate: undefined,
      originalTotalAmount: undefined,
      editedAt: undefined,
      editedBy: undefined,
      editReason: undefined,
      rulesAmount: undefined,
      rulesChangedAt: undefined,
      isLocked: false,
      updatedAt: Date.now(),
    });
    return null;
  },
});

/**
 * Remove a payable from a settlement (unassign it)
 */
export const removePayableFromSettlement = mutation({
  args: {
    payableId: v.id('loadCarrierPayables'),
  },
  handler: async (ctx, args) => {
    const callerOrgId = await requireCallerOrgId(ctx);
    const payable = await ctx.db.get(args.payableId);
    if (payable && payable.workosOrgId !== callerOrgId) {
      throw new Error('Payable not found');
    }
    if (!payable) throw new Error('Payable not found');

    if (!payable.settlementId) {
      throw new Error('Payable is not assigned to a settlement');
    }

    const settlement = await ctx.db.get(payable.settlementId);
    if (!settlement) throw new Error('Settlement not found');

    // Cannot remove from approved/paid settlements
    if (settlement.status === 'APPROVED' || settlement.status === 'PAID') {
      throw new Error('Cannot remove payables from approved or paid settlements');
    }

    await ctx.db.patch(args.payableId, {
      settlementId: undefined,
      updatedAt: Date.now(),
    });

    return null;
  },
});

/**
 * Delete a settlement (must be DRAFT or VOID)
 * - Load-based payables are UNASSIGNED (can be picked up by next settlement)
 * - Standalone adjustments are PERMANENTLY DELETED (they're per-statement)
 */
export const deleteSettlement = mutation({
  args: {
    settlementId: v.id('carrierSettlements'),
  },
  handler: async (ctx, args) => {
    const callerOrgId = await requireCallerOrgId(ctx);
    const settlement = await ctx.db.get(args.settlementId);
    if (!settlement) throw new Error('Settlement not found');
    if (settlement.workosOrgId !== callerOrgId) {
      throw new Error('Settlement not found');
    }

    // Can only delete DRAFT or VOID settlements
    if (settlement.status !== 'DRAFT' && settlement.status !== 'VOID') {
      throw new Error('Can only delete DRAFT or VOID settlements');
    }

    // Get all payables for this settlement
    const payables = await ctx.db
      .query('loadCarrierPayables')
      .withIndex('by_settlement', (q) => q.eq('settlementId', args.settlementId))
      .collect();

    for (const payable of payables) {
      // Standalone adjustments (no loadId) are deleted permanently
      // They were added specifically for this statement
      if (!payable.loadId) {
        await ctx.db.delete(payable._id);
        continue;
      }

      // Load-based payables are unassigned so they can be picked up by next settlement
      await ctx.db.patch(payable._id, {
        settlementId: undefined,
        updatedAt: Date.now(),
      });
    }

    // Delete the settlement
    await ctx.db.delete(args.settlementId);

    return null;
  },
});
