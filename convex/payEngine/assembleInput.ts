// Shared input-assembly for the pure calculatePay function.
//
// Both calculatePayForLeg (mutation) and shadowValidate (query) need to
// read from the same tables and build a CalculatePayInput shape. Keeping
// that logic in one place prevents drift — most importantly around
// periodAnchorAt resolution (last-stop-checkout vs leg.endedAt fallback)
// and stop time field aliasing.
//
// Parameterized over QueryCtx since both MutationCtx and QueryCtx satisfy
// the read-only db surface. Pure async function — no writes.

import type { Doc, Id } from '../_generated/dataModel';
import type { QueryCtx } from '../_generated/server';
import { asCents, asMicroCents, centsFromNumber } from '../lib/money';
import type {
  CalculatePayInput,
  ChargeComponentLite,
  LegPayeeSplit,
  PayProfile,
  PayRule,
  PayeeType,
  ProfileAssignment,
  StopInput,
} from './calculatePay';

// ============================================================================
// Public: assemble a CalculatePayInput for one payee on a leg
// ============================================================================

export async function assembleCalculatePayInput(
  ctx: QueryCtx,
  leg: Doc<'dispatchLegs'>,
  load: Doc<'loadInformation'>,
  payeeType: PayeeType,
  payeeId: string,
  splitBps: number,
): Promise<CalculatePayInput> {
  const stopDocs = await ctx.db
    .query('loadStops')
    .withIndex('by_load', q => q.eq('loadId', leg.loadId))
    .collect();

  const stops = stopDocsToStopInput(stopDocs);
  const periodAnchorAt = resolvePeriodAnchorAt(stopDocs, leg);

  // Invoice totals for PCT_OF_LOAD rules (percentage-of-linehaul / -invoice pay,
  // common for owner-operators). loadInvoices stores dollars: `subtotal` is the
  // freight/linehaul base, `totalAmount` the grand total — frozen once the
  // invoice is finalized. DRAFT/MISSING_DATA invoices may not have stored
  // numbers yet, in which case percentage rules resolve to $0 (with a warning)
  // until the load is billed. Pick the most recent non-void invoice.
  const invoices = await ctx.db
    .query('loadInvoices')
    .withIndex('by_load', q => q.eq('loadId', load._id))
    .collect();
  const invoice = invoices
    .filter(inv => inv.status !== 'VOID')
    .sort((a, b) => b.createdAt - a.createdAt)[0];
  const invoiceTotalCents = invoice?.totalAmount != null
    ? centsFromNumber(invoice.totalAmount, invoice.currency)
    : undefined;
  const linehaulTotalCents = invoice?.subtotal != null
    ? centsFromNumber(invoice.subtotal, invoice.currency)
    : undefined;

  // 1. Active assignments for this payee
  const assignments = await ctx.db
    .query('payeeProfileAssignments')
    .withIndex('by_payee_active', q =>
      q.eq('payeeType', payeeType).eq('payeeId', payeeId).eq('isActive', true))
    .collect();

  // 2. Candidate profile ids — assignments + load/leg overrides
  const candidateProfileIds = new Set<string>();
  for (const a of assignments) candidateProfileIds.add(a.profileId);
  if (load.payProfileOverrideId) candidateProfileIds.add(load.payProfileOverrideId);
  if (leg.payProfileOverrideId) candidateProfileIds.add(leg.payProfileOverrideId);

  const profiles = new Map<string, PayProfile>();
  for (const pid of candidateProfileIds) {
    const p = await ctx.db.get(pid as Id<'payProfiles'>);
    if (!p) continue;
    profiles.set(p._id, {
      _id: p._id,
      workosOrgId: p.workosOrgId,
      name: p.name,
      payeeType: p.payeeType as PayeeType,
      currency: p.currency,
      country: p.country,
      state: p.state,
      contractTag: p.contractTag,
      // postCalcRules deliberately NOT loaded — they fire at settlement-build
      // time (applyPostCalcRules.ts), not in the per-leg calc engine.
      postCalcRules: undefined,
      isDefault: p.isDefault,
      isActive: p.isActive,
    });
  }

  // 3. Active rules for every candidate profile
  const rules: PayRule[] = [];
  for (const profileId of profiles.keys()) {
    const profileRules = await ctx.db
      .query('payRules')
      .withIndex('by_profile_active', q =>
        q.eq('profileId', profileId as Id<'payProfiles'>).eq('isActive', true))
      .collect();
    for (const r of profileRules) {
      rules.push({
        _id: r._id,
        profileId: r.profileId,
        name: r.name,
        componentId: r.componentId,
        trigger: r.trigger,
        rateAmountMicroCents: r.rateAmountMicroCents !== undefined
          ? asMicroCents(r.rateAmountMicroCents) : undefined,
        tieredRate: r.tieredRate?.map(t => ({
          minQty: t.minQty,
          maxQty: t.maxQty,
          rateMicroCents: asMicroCents(t.rateMicroCents),
        })),
        minThreshold: r.minThreshold,
        maxCap: r.maxCap,
        minAmountCents: r.minAmountCents !== undefined ? asCents(r.minAmountCents) : undefined,
        maxAmountCents: r.maxAmountCents !== undefined ? asCents(r.maxAmountCents) : undefined,
        equipmentTypeCondition: r.equipmentTypeCondition,
        customerCondition: r.customerCondition,
        isActive: r.isActive,
        sortOrder: r.sortOrder,
      });
    }
  }

  // 4. Components referenced by any rule
  const componentIds = new Set<Id<'chargeComponents'>>();
  for (const r of rules) componentIds.add(r.componentId as Id<'chargeComponents'>);
  const components = new Map<string, ChargeComponentLite>();
  for (const cid of componentIds) {
    const c = await ctx.db.get(cid);
    if (!c) continue;
    components.set(c._id, { _id: c._id, code: c.code, bucket: c.bucket, sign: c.sign });
  }

  // 5. Convert assignments to the calc-engine shape
  const calcAssignments: ProfileAssignment[] = assignments.map(a => ({
    payeeType: a.payeeType as PayeeType,
    payeeId: a.payeeId,
    profileId: a.profileId,
    isDefault: a.isDefault,
    selectionStrategy: a.selectionStrategy,
    thresholdValue: a.thresholdValue,
    matchState: a.matchState,
    matchContractTag: a.matchContractTag,
    effectiveStart: a.effectiveStart,
    effectiveEnd: a.effectiveEnd,
    isActive: a.isActive,
  }));

  const payeeSplits: LegPayeeSplit[] = [{ payeeId, splitBps }];

  return {
    leg: {
      _id: leg._id,
      legLoadedMiles: leg.legLoadedMiles,
      legEmptyMiles: leg.legEmptyMiles,
      sequence: leg.sequence,
      payeeSplits,
      payProfileOverrideId: leg.payProfileOverrideId,
      workState: leg.workState,
      workCountry: leg.workCountry,
    },
    load: {
      _id: load._id,
      isHazmat: load.isHazmat ?? false,
      requiresTarp: load.requiresTarp ?? false,
      isOversize: load.isOversize ?? false,
      equipmentType: load.equipmentType,
      // Wired from the load's invoice (dollars → cents) above, so PCT_OF_LOAD
      // rules resolve against the linehaul/invoice total once the load is billed.
      invoiceTotalCents,
      linehaulTotalCents,
      contractTag: load.contractTag,
      payProfileOverrideId: load.payProfileOverrideId,
      customerId: load.customerId,
      workStateAllocation: load.workStateAllocation,
    },
    stops,
    payeeType,
    profileAssignments: calcAssignments,
    profiles,
    rules,
    components,
    periodAnchorAt,
  };
}

// ============================================================================
// HELPERS — shared between calc-engine wrapper and shadow validator
// ============================================================================

export function stopDocsToStopInput(stops: Array<Doc<'loadStops'>>): StopInput[] {
  return stops.map(s => {
    const sr = s as Doc<'loadStops'> & Record<string, unknown>;
    return {
      sequence: sr.sequenceNumber as number,
      dwellTimeMinutes: sr.dwellTime as number | undefined,
      // Legacy stops store time fields as ISO 8601 STRINGS, not ms numbers.
      // Parse to ms here so the calc engine's duration math (which expects
      // numbers) works correctly. Invalid/empty strings → undefined.
      checkedInAt: parseTimeFieldToMs(sr.checkedInAt),
      checkedOutAt: parseTimeFieldToMs(sr.checkedOutAt),
      windowBeginTime: parseTimeFieldToMs(sr.windowBeginTime)
                    ?? parseTimeFieldToMs(sr.windowBeginAt),
      windowEndTime: parseTimeFieldToMs(sr.windowEndTime)
                  ?? parseTimeFieldToMs(sr.windowEndAt),
    };
  });
}

function parseTimeFieldToMs(value: unknown): number | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value === 'number') {
    return Number.isFinite(value) ? value : undefined;
  }
  if (typeof value === 'string') {
    if (value === '') return undefined;
    const ms = Date.parse(value);
    return Number.isFinite(ms) ? ms : undefined;
  }
  return undefined;
}

/** Pick the timestamp used as periodAnchorAt for emitted payItems.
 *
 *  WORK-START semantics (first pickup / the leg's start stop), to match the
 *  product's settlement period rule: a payable belongs to the period in which
 *  the work STARTED, never the delivery/completion date (see
 *  resolveWorkStartTimestamp in convex/lib/settlementShared.ts, the legacy
 *  source of truth). This used to anchor on the last stop's checkout (delivery),
 *  which disagreed with that rule and would have windowed settlements wrong.
 *
 *  Resolution order mirrors the legacy leg-scoped path:
 *    leg start stop:           checkedInAt → checkedOutAt → windowBeginTime
 *    load first PICKUP stop:    checkedInAt → checkedOutAt → windowBeginTime
 *    leg.startedAt → leg.endedAt → now
 */
export function resolvePeriodAnchorAt(
  stops: Array<Doc<'loadStops'>>,
  leg: Doc<'dispatchLegs'>,
): number {
  const stopWorkStart = (s: Doc<'loadStops'> | undefined): number | undefined => {
    if (!s) return undefined;
    const sr = s as Doc<'loadStops'> & Record<string, unknown>;
    return (
      parseTimeFieldToMs(sr.checkedInAt) ??
      parseTimeFieldToMs(sr.checkedOutAt) ??
      parseTimeFieldToMs(sr.windowBeginTime) ??
      parseTimeFieldToMs(sr.windowBeginAt)
    );
  };

  // The leg's own start stop is the most precise work-start for this leg.
  const fromStartStop = stopWorkStart(stops.find((s) => s._id === leg.startStopId));
  if (fromStartStop !== undefined) return fromStartStop;

  // Fall back to the load's first PICKUP stop by sequence.
  const firstPickup = stops
    .filter((s) => (s as Doc<'loadStops'> & Record<string, unknown>).stopType === 'PICKUP')
    .sort((a, b) => a.sequenceNumber - b.sequenceNumber)[0];
  const fromPickup = stopWorkStart(firstPickup);
  if (fromPickup !== undefined) return fromPickup;

  // Last resort: the leg's own timing (startedAt = first check-in), then now.
  if (leg.startedAt !== undefined) return leg.startedAt;
  if (leg.endedAt !== undefined) return leg.endedAt;
  return Date.now();
}
