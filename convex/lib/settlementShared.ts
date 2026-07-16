import type { Doc, Id } from '../_generated/dataModel';

/**
 * Shared vocabulary for Driver & Carrier settlements.
 *
 * The settlements screens (web) work in terms of lifecycle *buckets* layered
 * over the raw statuses, line-item *categories* (statement sections), and
 * *blockers* (what prevents a closed period from being approved). Everything
 * here is pure or takes a narrow ctx surface so both driverSettlements.ts and
 * carrierSettlements.ts share one implementation.
 *
 * Bucket mapping (no schema migration — computed per row):
 *   DRAFT | PENDING + period still running          → 'open'
 *   DRAFT | PENDING + period ended + hard blockers  → 'attention'
 *   DRAFT | PENDING + period ended + clean          → 'ready'
 *   APPROVED → 'approved', PAID → 'paid', VOID → 'void', DISPUTED → 'disputed'
 */

// ── line-item classification ────────────────────────────────────────────────

export type PayableCategory = 'EARNING' | 'REIMBURSEMENT' | 'DEDUCTION';

interface ClassifiablePayable {
  category?: PayableCategory;
  totalAmount: number;
  isRebillable?: boolean;
  sourceType: 'SYSTEM' | 'MANUAL';
}

/**
 * Statement section for a payable. Rows written before `category` existed
 * are classified by fallback: negative amounts are deductions; rebillable
 * manual accessorials (tolls, lumper — passed through to the customer) are
 * reimbursements; everything else is an earning.
 */
export function classifyPayable(p: ClassifiablePayable): PayableCategory {
  if (p.category) return p.category;
  if (p.totalAmount < 0) return 'DEDUCTION';
  if (p.sourceType === 'MANUAL' && p.isRebillable) return 'REIMBURSEMENT';
  return 'EARNING';
}

export interface LineSummary {
  earnTotal: number;
  reimbTotal: number;
  /** Positive magnitude — deduction rows store negative totalAmount. */
  deductTotal: number;
  net: number;
  /** Sum of SYSTEM earning quantities (miles or hours depending on basis). */
  systemQuantity: number;
  /** Hours counted ONCE. The new ledger emits several rate lines over the
   *  same hours (shift H&W + per-leg base + per-leg premium), so summing
   *  quantities double-counts. Dedupe: max quantity per session (a shift's
   *  activeMinutes-based line spans its leg lines), falling back to max per
   *  load when no session lines exist. Miles keep the plain sum — loaded and
   *  empty mile lines cover DIFFERENT miles and must add. */
  workedQuantity: number;
  loadCount: number;
  lineCount: number;
}

export function summarizeLines(
  payables: Array<ClassifiablePayable & {
    quantity: number;
    loadId?: Id<'loadInformation'>;
    sessionId?: Id<'driverSessions'>;
  }>,
): LineSummary {
  let earnTotal = 0;
  let reimbTotal = 0;
  let deductTotal = 0;
  let systemQuantity = 0;
  const loadIds = new Set<string>();
  const bySession = new Map<string, number>();
  const byLoad = new Map<string, number>();
  let unanchoredQuantity = 0;

  for (const p of payables) {
    const category = classifyPayable(p);
    if (category === 'DEDUCTION') {
      deductTotal += Math.abs(p.totalAmount);
    } else if (category === 'REIMBURSEMENT') {
      reimbTotal += p.totalAmount;
    } else {
      earnTotal += p.totalAmount;
      if (p.sourceType === 'SYSTEM') {
        systemQuantity += p.quantity;
        if (p.sessionId) {
          const k = p.sessionId as string;
          bySession.set(k, Math.max(bySession.get(k) ?? 0, p.quantity));
        } else if (p.loadId) {
          const k = p.loadId as string;
          byLoad.set(k, Math.max(byLoad.get(k) ?? 0, p.quantity));
        } else {
          unanchoredQuantity += p.quantity;
        }
      }
    }
    if (p.loadId) loadIds.add(p.loadId);
  }

  // Session lines (activeMinutes-based) span the shift's leg lines, so when
  // any exist, per-load groups are subsets and drop out of the count.
  const workedQuantity =
    (bySession.size > 0
      ? [...bySession.values()].reduce((s, v) => s + v, 0)
      : [...byLoad.values()].reduce((s, v) => s + v, 0)) + unanchoredQuantity;

  return {
    earnTotal,
    reimbTotal,
    deductTotal,
    net: earnTotal + reimbTotal - deductTotal,
    systemQuantity,
    workedQuantity,
    loadCount: loadIds.size,
    lineCount: payables.length,
  };
}

// ── pay basis ───────────────────────────────────────────────────────────────

export type PayBasisKey = 'mile' | 'hourly' | 'flat' | 'pct';

const BASIS_FROM_PROFILE: Record<Doc<'rateProfiles'>['payBasis'], PayBasisKey> = {
  MILEAGE: 'mile',
  HOURLY: 'hourly',
  FLAT: 'flat',
  PERCENTAGE: 'pct',
};

export function planDetailLabel(basis: PayBasisKey, rate: number | null): string | null {
  if (rate == null) return null;
  switch (basis) {
    case 'mile':
      return `$${rate.toFixed(2)}/mi`;
    case 'hourly':
      return `$${rate}/hr`;
    case 'pct':
      return `${Math.round(rate * 100) === rate * 100 ? rate * 100 : (rate * 100).toFixed(1)}% of revenue`;
    case 'flat':
      return `$${rate.toLocaleString('en-US')} flat per load`;
  }
}

export interface PayBasisInfo {
  basis: PayBasisKey;
  /** Human label like "$0.62/mi" — null when no BASE rule rate is resolvable. */
  planDetail: string | null;
}

// Narrow ctx surface so helpers work from any query/mutation. Method syntax
// (not arrow-property) keeps parameter checking bivariant, so the generated
// QueryCtx/MutationCtx types are structurally assignable.
interface DbReaderCtx {
  db: {
    get(id: any): Promise<any>;
    query(table: any): any;
  };
}

async function resolvePayBasisFromProfile(
  ctx: DbReaderCtx,
  profileId: Id<'rateProfiles'>,
): Promise<PayBasisInfo | null> {
  const profile = await ctx.db.get(profileId);
  if (!profile) return null;
  const basis = BASIS_FROM_PROFILE[profile.payBasis as Doc<'rateProfiles'>['payBasis']];

  const rules = await ctx.db
    .query('rateRules')
    .withIndex('by_profile', (q: any) => q.eq('profileId', profileId))
    .collect();
  const baseRule =
    rules.find((r: Doc<'rateRules'>) => r.category === 'BASE' && r.isActive && !r.equipmentTypeCondition) ??
    rules.find((r: Doc<'rateRules'>) => r.category === 'BASE' && r.isActive);

  // PCT_OF_LOAD rules store the percentage as the rate amount (e.g. 28 or 0.28
  // depending on org convention) — normalize values above 1 to a fraction.
  let rate: number | null = baseRule ? baseRule.rateAmount : null;
  if (rate != null && basis === 'pct' && rate > 1) rate = rate / 100;

  return { basis, planDetail: planDetailLabel(basis, rate) };
}

/** Pay basis for a driver via their default rate-profile assignment. */
export async function resolveDriverPayBasis(
  ctx: DbReaderCtx,
  driverId: Id<'drivers'>,
): Promise<PayBasisInfo | null> {
  const assignments = await ctx.db
    .query('driverProfileAssignments')
    .withIndex('by_driver', (q: any) => q.eq('driverId', driverId))
    .collect();
  if (assignments.length === 0) return null;
  const chosen =
    assignments.find((a: Doc<'driverProfileAssignments'>) => a.isDefault) ?? assignments[0];
  return resolvePayBasisFromProfile(ctx, chosen.profileId);
}

/** Pay basis for a carrier via their default rate-profile assignment. */
export async function resolveCarrierPayBasis(
  ctx: DbReaderCtx,
  carrierPartnershipId: Id<'carrierPartnerships'>,
): Promise<PayBasisInfo | null> {
  const assignments = await ctx.db
    .query('carrierProfileAssignments')
    .withIndex('by_carrier_partnership', (q: any) =>
      q.eq('carrierPartnershipId', carrierPartnershipId),
    )
    .collect();
  if (assignments.length === 0) return null;
  const chosen =
    assignments.find((a: Doc<'carrierProfileAssignments'>) => a.isDefault) ?? assignments[0];
  return resolvePayBasisFromProfile(ctx, chosen.profileId);
}

// ── cadence & pay date ──────────────────────────────────────────────────────

export function cadenceFromFrequency(
  frequency: Doc<'payPlans'>['frequency'] | undefined,
): string | null {
  switch (frequency) {
    case 'WEEKLY':
      return 'Weekly';
    case 'BIWEEKLY':
      return 'Bi-weekly';
    case 'SEMIMONTHLY':
      return 'Semi-monthly';
    case 'MONTHLY':
      return 'Monthly';
    default:
      return null;
  }
}

/** Normalize free-form carrier payment terms ("Net15", "QuickPay") for display. */
export function cadenceFromPaymentTerms(terms: string | undefined): string | null {
  if (!terms) return null;
  const compact = terms.replace(/[\s-]/g, '').toLowerCase();
  if (compact === 'quickpay') return 'Quick-pay';
  const net = compact.match(/^net(\d+)$/);
  if (net) return `Net ${net[1]}`;
  return terms;
}

const DAY_MS = 24 * 60 * 60 * 1000;

export function payDateFromLag(periodEnd: number, paymentLagDays: number): number {
  return periodEnd + paymentLagDays * DAY_MS;
}

/** Pay date implied by carrier payment terms; Quick-pay assumed 3 days. */
export function payDateFromTerms(periodEnd: number, terms: string | undefined): number | null {
  if (!terms) return null;
  const compact = terms.replace(/[\s-]/g, '').toLowerCase();
  if (compact === 'quickpay') return periodEnd + 3 * DAY_MS;
  const net = compact.match(/^net(\d+)$/);
  if (net) return periodEnd + parseInt(net[1], 10) * DAY_MS;
  return null;
}

// ── blockers ────────────────────────────────────────────────────────────────

export type BlockerSeverity = 'hard' | 'soft';

export interface SettlementBlocker {
  key: string;
  sev: BlockerSeverity;
  /** Extra context for the readiness checklist (e.g. which loads). */
  detail?: string;
  /** Payable line ids this blocker points at — lets the UI jump to them. */
  lineIds?: string[];
  /** Reviewer marked this verified — no longer gates approval, stays shown. */
  acknowledged?: boolean;
  acknowledgedBy?: string;
  acknowledgedAt?: number;
}

/** Stamp `acknowledged` onto blockers the reviewer has verified. */
export function applyAcknowledgements(
  blockers: SettlementBlocker[],
  acks: Array<{ key: string; by: string; at: number }> | undefined,
): SettlementBlocker[] {
  if (!acks || acks.length === 0) return blockers;
  const byKey = new Map(acks.map((a) => [a.key, a]));
  return blockers.map((b) => {
    const a = byKey.get(b.key);
    return a ? { ...b, acknowledged: true, acknowledgedBy: a.by, acknowledgedAt: a.at } : b;
  });
}

interface BlockerPayable extends ClassifiablePayable {
  _id?: Id<'loadPayables'> | Id<'loadCarrierPayables'>;
  quantity: number;
  loadId?: Id<'loadInformation'>;
  sessionId?: Id<'driverSessions'>;
  warningMessage?: string;
  receiptStorageId?: Id<'_storage'>;
}

/** Fetch the loads referenced by a set of payables, deduped through a cache. */
export async function loadsForPayables(
  ctx: DbReaderCtx,
  payables: Array<{ loadId?: Id<'loadInformation'> }>,
  cache: Map<string, Doc<'loadInformation'> | null>,
): Promise<Array<Doc<'loadInformation'>>> {
  const out: Array<Doc<'loadInformation'>> = [];
  const seen = new Set<string>();
  for (const p of payables) {
    if (!p.loadId || seen.has(p.loadId)) continue;
    seen.add(p.loadId);
    let load = cache.get(p.loadId);
    if (load === undefined) {
      load = ((await ctx.db.get(p.loadId)) ?? null) as Doc<'loadInformation'> | null;
      cache.set(p.loadId, load);
    }
    if (load) out.push(load);
  }
  return out;
}

/**
 * Data-backed driver blockers. Blockers without a backing data model
 * (timesheets, bank details, W-9) are intentionally absent — they join the
 * checklist when their data exists, not before.
 */
export function computeDriverBlockers(opts: {
  payables: BlockerPayable[];
  loads: Array<Doc<'loadInformation'>>;
  net: number;
}): SettlementBlocker[] {
  const blockers: SettlementBlocker[] = [];

  // Shift-based warnings (auto-timeout, etc.) point at session lines, which
  // have no load — keep them distinct from load-pay warnings so the fix hint
  // and jump target make sense.
  const shiftWarned = opts.payables.filter((p) => p.warningMessage && p.sessionId);
  if (shiftWarned.length > 0) {
    blockers.push({
      key: 'shiftreview',
      sev: 'hard',
      detail:
        shiftWarned.length === 1
          ? shiftWarned[0].warningMessage
          : `${shiftWarned.length} shifts need their hours verified`,
      lineIds: shiftWarned.map((p) => p._id as string).filter(Boolean),
    });
  }

  const loadWarned = opts.payables.filter((p) => p.warningMessage && !p.sessionId);
  if (loadWarned.length > 0) {
    blockers.push({
      key: 'loadpay',
      sev: 'hard',
      detail:
        loadWarned.length === 1
          ? loadWarned[0].warningMessage
          : `${loadWarned.length} load lines need attention`,
      lineIds: loadWarned.map((p) => p._id as string).filter(Boolean),
    });
  }

  if (opts.net < 0) {
    blockers.push({ key: 'negative', sev: 'hard' });
  }

  const missingPods = opts.loads.filter((l) => !l.podStorageId);
  if (missingPods.length > 0) {
    blockers.push({
      key: 'pod',
      sev: 'soft',
      detail: `${missingPods.length} load${missingPods.length > 1 ? 's' : ''} without POD`,
    });
  }

  const missingReceipts = opts.payables.filter(
    (p) => classifyPayable(p) === 'REIMBURSEMENT' && !p.receiptStorageId,
  );
  if (missingReceipts.length > 0) {
    blockers.push({
      key: 'receipts',
      sev: 'soft',
      detail: `${missingReceipts.length} reimbursement${missingReceipts.length > 1 ? 's' : ''} without a receipt`,
    });
  }

  return blockers;
}

/** Data-backed carrier blockers (POD, insurance, load-pay warnings, negative net). */
export function computeCarrierBlockers(opts: {
  payables: BlockerPayable[];
  loads: Array<Doc<'loadInformation'>>;
  partnership: Doc<'carrierPartnerships'> | null;
  net: number;
}): SettlementBlocker[] {
  const blockers: SettlementBlocker[] = [];

  const missingPods = opts.loads.filter((l) => !l.podStorageId);
  if (missingPods.length > 0) {
    blockers.push({
      key: 'pod',
      sev: 'hard',
      detail: `${missingPods.length} load${missingPods.length > 1 ? 's' : ''} without POD`,
    });
  }

  if (opts.partnership) {
    const expiration = opts.partnership.insuranceExpiration
      ? new Date(opts.partnership.insuranceExpiration).getTime()
      : null;
    const lapsed = expiration != null && !isNaN(expiration) && expiration < Date.now();
    const unverified = opts.partnership.insuranceCoverageVerified === false;
    if (lapsed || unverified) {
      blockers.push({
        key: 'insurance',
        sev: 'hard',
        detail: lapsed ? 'Certificate expired' : 'Coverage not verified',
      });
    }
  }

  const warned = opts.payables.filter((p) => p.warningMessage);
  if (warned.length > 0) {
    blockers.push({
      key: 'loadpay',
      sev: 'hard',
      detail:
        warned.length === 1 ? warned[0].warningMessage : `${warned.length} pay lines need attention`,
      lineIds: warned.map((p) => p._id as string).filter(Boolean),
    });
  }

  if (opts.net < 0) {
    blockers.push({ key: 'negative', sev: 'hard' });
  }

  return blockers;
}

// ── work-start timestamp ────────────────────────────────────────────────────
// Settlement periods include work by WHEN IT WAS DONE — the load's start
// (first pickup), never payable.createdAt (calculation time) or delivery /
// completion fallbacks. Resolution order, most-actual to most-planned:
//   leg start stop:  checkedInAt → checkedOutAt → windowBeginTime
//   load first PICKUP stop: checkedInAt → checkedOutAt → windowBeginTime
//   load.firstStopDate (denormalized planned date, day precision)
// Standalone adjustments (no load/leg) date by createdAt — that IS when the
// item was incurred. Unresolvable load-backed payables return null and are
// excluded from period windows rather than mis-dated.

export interface WorkStartCaches {
  loads: Map<string, Doc<'loadInformation'> | null>;
  legs: Map<string, Doc<'dispatchLegs'> | null>;
  stopsByLoad: Map<string, Doc<'loadStops'>[]>;
  stopDocs: Map<string, Doc<'loadStops'> | null>;
  sessions: Map<string, Doc<'driverSessions'> | null>;
}

export const newWorkStartCaches = (): WorkStartCaches => ({
  loads: new Map(),
  legs: new Map(),
  stopsByLoad: new Map(),
  stopDocs: new Map(),
  sessions: new Map(),
});

const parseStopTime = (iso: string | undefined): number | null => {
  if (!iso) return null;
  const t = new Date(iso).getTime();
  return isNaN(t) ? null : t;
};

const stopWorkStart = (stop: Doc<'loadStops'> | null): number | null => {
  if (!stop) return null;
  return (
    parseStopTime(stop.checkedInAt) ??
    parseStopTime(stop.checkedOutAt) ??
    parseStopTime(stop.windowBeginTime)
  );
};

export async function resolveWorkStartTimestamp(
  ctx: DbReaderCtx,
  payable: {
    loadId?: Id<'loadInformation'>;
    legId?: Id<'dispatchLegs'>;
    sessionId?: Id<'driverSessions'>;
    createdAt: number;
  },
  caches: WorkStartCaches,
): Promise<number | null> {
  // Shift-based pay: the work started when the driver checked in.
  if (payable.sessionId) {
    const sessionKey = payable.sessionId as string;
    let session = caches.sessions.get(sessionKey);
    if (session === undefined) {
      session = ((await ctx.db.get(payable.sessionId)) ?? null) as Doc<'driverSessions'> | null;
      caches.sessions.set(sessionKey, session);
    }
    return session?.startedAt ?? payable.createdAt;
  }

  // Standalone adjustment — dated when it was entered.
  if (!payable.loadId && !payable.legId) return payable.createdAt;

  // Leg-scoped payables: the leg's start stop is the work start.
  if (payable.legId) {
    const legKey = payable.legId as string;
    let leg = caches.legs.get(legKey);
    if (leg === undefined) {
      leg = ((await ctx.db.get(payable.legId)) ?? null) as Doc<'dispatchLegs'> | null;
      caches.legs.set(legKey, leg);
    }
    if (leg?.startStopId) {
      const stopKey = leg.startStopId as string;
      let stop = caches.stopDocs.get(stopKey);
      if (stop === undefined) {
        stop = ((await ctx.db.get(leg.startStopId)) ?? null) as Doc<'loadStops'> | null;
        caches.stopDocs.set(stopKey, stop);
      }
      const t = stopWorkStart(stop);
      if (t != null) return t;
    }
  }

  if (payable.loadId) {
    const loadKey = payable.loadId as string;

    // First PICKUP stop on the load.
    let stops = caches.stopsByLoad.get(loadKey);
    if (stops === undefined) {
      stops = (await ctx.db
        .query('loadStops')
        .withIndex('by_load', (q: any) => q.eq('loadId', payable.loadId))
        .collect()) as Doc<'loadStops'>[];
      caches.stopsByLoad.set(loadKey, stops);
    }
    const firstPickup = stops
      .filter((s) => s.stopType === 'PICKUP')
      .sort((a, b) => (a.sequenceNumber ?? 0) - (b.sequenceNumber ?? 0))[0];
    const t = stopWorkStart(firstPickup ?? null);
    if (t != null) return t;

    // Planned first-stop date (day precision) as the last resort.
    let load = caches.loads.get(loadKey);
    if (load === undefined) {
      load = ((await ctx.db.get(payable.loadId)) ?? null) as Doc<'loadInformation'> | null;
      caches.loads.set(loadKey, load);
    }
    if (load?.firstStopDate) {
      const planned = new Date(`${load.firstStopDate}T00:00:00`).getTime();
      if (!isNaN(planned)) return planned;
    }
  }

  return null;
}

// ── shift load rows ─────────────────────────────────────────────────────────

export interface ShiftLoadRow {
  label: string;
  /** Actual check-in at the leg's start stop — the reviewable truth. */
  actualAt?: number;
  /** Dispatch-planned start, shown alongside for comparison. */
  scheduledAt?: number;
  lane?: string;
}

/**
 * The loads a driver ran during a completed shift, one row each: legs whose
 * scheduled start falls inside the session window (padded 2h earlier — drivers
 * often check in after the first scheduled start). ACTIVE included so the live
 * shift's current load shows. Shared by the admin settlement detail
 * (driverSettlements.getSettlementDetails) and the driver-facing mobile
 * statement detail (mobileSettlements).
 */
export async function buildShiftLoadRows(
  ctx: DbReaderCtx,
  driverId: Id<'drivers'>,
  session: Doc<'driverSessions'>,
  caches: WorkStartCaches,
): Promise<ShiftLoadRow[] | undefined> {
  if (!session.endedAt) return undefined;
  const PAD = 2 * 60 * 60 * 1000;
  const legs: Doc<'dispatchLegs'>[] = [];
  for (const status of ['COMPLETED', 'ACTIVE'] as const) {
    const batch = await ctx.db
      .query('dispatchLegs')
      .withIndex('by_driver_status_scheduled_start', (q: any) =>
        q
          .eq('driverId', driverId)
          .eq('status', status)
          .gte('scheduledStartMs', session.startedAt - PAD)
          .lte('scheduledStartMs', session.endedAt!),
      )
      .take(50);
    legs.push(...batch);
  }
  legs.sort((a, b) => (a.scheduledStartMs ?? 0) - (b.scheduledStartMs ?? 0));
  const rows: ShiftLoadRow[] = [];
  const seen = new Set<string>();
  for (const leg of legs) {
    if (seen.has(leg.loadId)) continue;
    seen.add(leg.loadId);
    const loadKey = leg.loadId as string;
    let legLoad = caches.loads.get(loadKey);
    if (legLoad === undefined) {
      legLoad = ((await ctx.db.get(leg.loadId)) ?? null) as Doc<'loadInformation'> | null;
      caches.loads.set(loadKey, legLoad);
    }
    const label = legLoad?.orderNumber ?? legLoad?.internalId;
    if (!label) continue;

    // Actual check-in at the leg's start stop, when recorded.
    let actualAt: number | undefined;
    const stopKey = leg.startStopId as string;
    let startStop = caches.stopDocs.get(stopKey);
    if (startStop === undefined) {
      startStop = ((await ctx.db.get(leg.startStopId)) ?? null) as Doc<'loadStops'> | null;
      caches.stopDocs.set(stopKey, startStop);
    }
    if (startStop?.checkedInAt) {
      const t = new Date(startStop.checkedInAt).getTime();
      if (!isNaN(t)) actualAt = t;
    }
    const origin = legLoad?.originCity
      ? `${legLoad.originCity}${legLoad.originState ? ', ' + legLoad.originState : ''}`
      : null;
    const dest = legLoad?.destinationCity
      ? `${legLoad.destinationCity}${legLoad.destinationState ? ', ' + legLoad.destinationState : ''}`
      : null;
    rows.push({
      label,
      actualAt,
      scheduledAt: leg.scheduledStartMs ?? undefined,
      lane: origin && dest ? `${origin} → ${dest}` : (origin ?? dest ?? undefined),
    });
  }
  // Read in the order the work actually happened.
  rows.sort((a, b) => (a.actualAt ?? a.scheduledAt ?? 0) - (b.actualAt ?? b.scheduledAt ?? 0));
  return rows.length > 0 ? rows : undefined;
}

// ── statement numbering ─────────────────────────────────────────────────────
// Counter-doc pattern (settlementCounters): one read + one write per number,
// instead of collecting every settlement in the org. Seeded once per
// org × scope × year from the existing max via the by_statement_number index.

interface DbWriterCtx {
  db: DbReaderCtx['db'] & {
    insert(table: any, doc: any): Promise<any>;
    patch(id: any, doc: any): Promise<void>;
  };
}

export async function nextStatementNumber(
  ctx: DbWriterCtx,
  opts: { workosOrgId: string; scope: 'DRIVER' | 'CARRIER' },
): Promise<string> {
  const year = new Date().getFullYear();
  const prefix = `${opts.scope === 'DRIVER' ? 'SET' : 'CST'}-${year}-`;
  const now = Date.now();

  const counter = await ctx.db
    .query('settlementCounters')
    .withIndex('by_org_scope_year', (q: any) =>
      q.eq('workosOrgId', opts.workosOrgId).eq('scope', opts.scope).eq('year', year),
    )
    .first();

  if (counter) {
    const next = counter.lastNumber + 1;
    await ctx.db.patch(counter._id, { lastNumber: next, updatedAt: now });
    return `${prefix}${String(next).padStart(3, '0')}`;
  }

  // Seed from the existing max for this year (one-time per org/scope/year).
  const table = opts.scope === 'DRIVER' ? 'driverSettlements' : 'carrierSettlements';
  const existing = await ctx.db
    .query(table)
    .withIndex('by_statement_number', (q: any) =>
      q.eq('workosOrgId', opts.workosOrgId).gte('statementNumber', prefix).lt('statementNumber', prefix + '￿'),
    )
    .collect();
  let max = 0;
  for (const doc of existing) {
    const num = parseInt(String(doc.statementNumber).slice(prefix.length), 10);
    if (!isNaN(num) && num > max) max = num;
  }

  const next = max + 1;
  await ctx.db.insert('settlementCounters', {
    workosOrgId: opts.workosOrgId,
    scope: opts.scope,
    year,
    lastNumber: next,
    updatedAt: now,
  });
  return `${prefix}${String(next).padStart(3, '0')}`;
}

// ── lifecycle buckets ───────────────────────────────────────────────────────

export type SettlementBucket =
  | 'open'
  | 'attention'
  | 'ready'
  | 'approved'
  | 'paid'
  | 'void'
  | 'disputed';

export function bucketForSettlement(
  status: string,
  periodEnd: number,
  blockers: SettlementBlocker[],
  now: number = Date.now(),
): SettlementBucket {
  switch (status) {
    case 'APPROVED':
      return 'approved';
    case 'PAID':
      return 'paid';
    case 'VOID':
      return 'void';
    case 'DISPUTED':
      return 'disputed';
    default: {
      // DRAFT / PENDING — period state + blockers decide the bucket.
      // Acknowledged (reviewer-verified) hard blockers no longer gate.
      if (periodEnd > now) return 'open';
      return blockers.some((b) => b.sev === 'hard' && !b.acknowledged) ? 'attention' : 'ready';
    }
  }
}

/** Whole days since the period closed (0 when still running). */
export function ageDays(periodEnd: number, now: number = Date.now()): number {
  return Math.max(0, Math.floor((now - periodEnd) / DAY_MS));
}

/** Display units for the work column, e.g. "1,234 mi" / "38.5 h" / "6 loads". */
export function unitsLabel(
  basis: PayBasisKey | null,
  summary: Pick<LineSummary, 'systemQuantity' | 'loadCount'> & Partial<Pick<LineSummary, 'workedQuantity'>>,
): string {
  if (basis === 'mile' && summary.systemQuantity > 0) {
    return `${Math.round(summary.systemQuantity).toLocaleString('en-US')} mi`;
  }
  // Hours use the deduped count — several rate lines can cover the same
  // hours (see LineSummary.workedQuantity).
  const hoursQuantity = summary.workedQuantity ?? summary.systemQuantity;
  if (basis === 'hourly' && hoursQuantity > 0) {
    return `${hoursQuantity.toFixed(1)} h`;
  }
  return `${summary.loadCount} load${summary.loadCount === 1 ? '' : 's'}`;
}
