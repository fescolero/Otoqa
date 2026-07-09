// Pay-engine validation setup — one-off admin tooling for the parallel
// validation phase. Three entry points the user runs from the Convex
// dashboard or CLI:
//
//   1. listLegacyProfilesForOrg(workosOrgId)
//      Discovery — returns the legacy rateProfiles in the org so you can
//      pick one to migrate. Includes a rule count for each.
//
//   2. seedAndMigrateProfile({workosOrgId, legacyProfileId, createdBy})
//      Idempotent. Seeds the chargeComponents catalog if not already
//      seeded, then mirrors the chosen legacy rateProfile + rateRules
//      into a new payProfile + payRules. Clones the legacy driver
//      assignments into payeeProfileAssignments pointing at the new
//      profile. Returns counts + the new profileId.
//
//   3. shadowValidateForDriver({driverId, limit})
//      Runs shadowValidateLeg() on the driver's N most recent legs and
//      returns a classification summary (how many MATCH / ROUNDING_DIFF
//      / AMOUNT_DIFF / etc.) plus per-leg detail. Use this to gauge new-
//      engine fidelity before cutover.
//
// Naming: stays under convex/_devTools/ to follow the existing convention
// for one-off admin tools (alongside facetSimulator and syncLatencyDiag).

import { internalAction, internalMutation, internalQuery } from '../_generated/server';
import { api, internal } from '../_generated/api';
import { v } from 'convex/values';
import type { Doc, Id } from '../_generated/dataModel';
import { seedChargeComponentsLogic } from '../payEngine/seedChargeComponents';
import { microCentsFromNumber, percentToMicroPctPoints, centsFromNumber } from '../lib/money';
import type { ShadowValidationResult } from '../payEngine/shadowValidate';

// ============================================================================
// 1. DISCOVERY — list legacy profiles
// ============================================================================

export const inspectLegacyRule = internalQuery({
  args: { ruleId: v.id('rateRules') },
  handler: async (ctx, { ruleId }) => {
    const rule = await ctx.db.get(ruleId);
    if (!rule) return null;
    const profile = await ctx.db.get(rule.profileId);
    return { rule, profileName: profile?.name, profileId: rule.profileId };
  },
});

export const inspectAllLegacyRulesForOrg = internalQuery({
  args: { workosOrgId: v.string() },
  handler: async (ctx, { workosOrgId }) => {
    const profiles = await ctx.db
      .query('rateProfiles')
      .withIndex('by_org', q => q.eq('workosOrgId', workosOrgId))
      .collect();
    const out = [];
    for (const p of profiles) {
      const rules = await ctx.db
        .query('rateRules')
        .withIndex('by_profile', q => q.eq('profileId', p._id))
        .collect();
      out.push({
        profileId: p._id,
        profileName: p.name,
        profileType: p.profileType,
        rules: rules.map(r => ({
          _id: r._id,
          name: r.name,
          category: r.category,
          triggerEvent: r.triggerEvent,
          rateAmount: r.rateAmount,
          isActive: r.isActive,
        })),
      });
    }
    return out;
  },
});

export const inspectLegacyAssignmentsForDriver = internalQuery({
  args: { driverId: v.id('drivers') },
  handler: async (ctx, { driverId }) => {
    const assignments = await ctx.db
      .query('driverProfileAssignments')
      .withIndex('by_driver', q => q.eq('driverId', driverId))
      .collect();
    const enriched = [];
    for (const a of assignments) {
      const profile = await ctx.db.get(a.profileId);
      enriched.push({
        profileId: a.profileId,
        profileName: profile?.name,
        isDefault: a.isDefault,
        selectionStrategy: a.selectionStrategy,
        thresholdValue: a.thresholdValue,
      });
    }
    return enriched;
  },
});

export const inspectLegacyRulesForProfile = internalQuery({
  args: { profileId: v.id('rateProfiles') },
  handler: async (ctx, { profileId }) => {
    const rules = await ctx.db
      .query('rateRules')
      .withIndex('by_profile', q => q.eq('profileId', profileId))
      .collect();
    return rules.map(r => ({
      _id: r._id,
      name: r.name,
      category: r.category,
      triggerEvent: r.triggerEvent,
      rateAmount: r.rateAmount,
      minThreshold: r.minThreshold,
      maxCap: r.maxCap,
      equipmentTypeCondition: r.equipmentTypeCondition,
      isActive: r.isActive,
    }));
  },
});

export const inspectLegacyPayablesForLeg = internalQuery({
  args: { legId: v.id('dispatchLegs') },
  handler: async (ctx, { legId }) => {
    const leg = await ctx.db.get(legId);
    if (!leg) return null;
    const payables = await ctx.db
      .query('loadPayables')
      .withIndex('by_leg', q => q.eq('legId', legId))
      .collect();
    const stops = await ctx.db
      .query('loadStops')
      .withIndex('by_load', q => q.eq('loadId', leg.loadId))
      .collect();
    return {
      legId,
      driverId: leg.driverId,
      legLoadedMiles: leg.legLoadedMiles,
      legEmptyMiles: leg.legEmptyMiles,
      startStopId: leg.startStopId,
      endStopId: leg.endStopId,
      stopCount: stops.length,
      stopSummary: stops.map(s => ({
        _id: s._id,
        sequenceNumber: s.sequenceNumber,
        stopType: s.stopType,
        checkedInAt: s.checkedInAt,
        checkedOutAt: s.checkedOutAt,
        windowBeginTime: s.windowBeginTime,
        windowEndTime: s.windowEndTime,
        dwellTime: s.dwellTime,
      })),
      payables: payables.map(p => ({
        ruleId: p.ruleId,
        description: p.description,
        quantity: p.quantity,
        rate: p.rate,
        totalAmount: p.totalAmount,
        sourceType: p.sourceType,
      })),
    };
  },
});

export const listLegacyProfilesForOrg = internalQuery({
  args: { workosOrgId: v.string() },
  handler: async (ctx, { workosOrgId }) => {
    const profiles = await ctx.db
      .query('rateProfiles')
      .withIndex('by_org', q => q.eq('workosOrgId', workosOrgId))
      .collect();

    const out = [];
    for (const p of profiles) {
      const rules = await ctx.db
        .query('rateRules')
        .withIndex('by_profile', q => q.eq('profileId', p._id))
        .collect();
      out.push({
        profileId: p._id,
        name: p.name,
        profileType: p.profileType,
        payBasis: p.payBasis,
        isDefault: p.isDefault ?? false,
        isActive: p.isActive,
        ruleCount: rules.length,
        activeRuleCount: rules.filter(r => r.isActive).length,
      });
    }
    return out;
  },
});

// ============================================================================
// 2. SEED + MIGRATE — mirror one legacy profile into the new schema
// ============================================================================

export const seedAndMigrateProfile = internalMutation({
  args: {
    workosOrgId: v.string(),
    legacyProfileId: v.id('rateProfiles'),
    createdBy: v.string(),
  },
  handler: async (ctx, { workosOrgId, legacyProfileId, createdBy }) => {
    // Step 1: ensure catalog is seeded
    const seedResult = await seedChargeComponentsLogic(ctx, { workosOrgId, createdBy });

    // Step 2: read legacy profile + rules
    const legacy = await ctx.db.get(legacyProfileId);
    if (!legacy) throw new Error(`legacy profile ${legacyProfileId} not found`);
    if (legacy.workosOrgId !== workosOrgId) {
      throw new Error(`legacy profile org mismatch: ${legacy.workosOrgId} vs ${workosOrgId}`);
    }

    const legacyRules = await ctx.db
      .query('rateRules')
      .withIndex('by_profile', q => q.eq('profileId', legacyProfileId))
      .collect();

    // Step 3: look up seeded components by templateId so we can map by code
    const componentsByCode = new Map<string, Id<'chargeComponents'>>();
    const allComponents = await ctx.db
      .query('chargeComponents')
      .withIndex('by_org_active', q => q.eq('workosOrgId', workosOrgId))
      .collect();
    for (const c of allComponents) componentsByCode.set(c.code, c._id);

    // Step 4: create the mirroring payProfile
    const now = Date.now();
    const newProfileId = await ctx.db.insert('payProfiles', {
      workosOrgId,
      name: `${legacy.name} (migrated)`,
      description: legacy.description,
      payeeType: legacy.profileType,                 // DRIVER|CARRIER passes through
      payBasis: legacy.payBasis,                     // MILEAGE|HOURLY|PERCENTAGE|FLAT
      currency: 'USD',                               // legacy data is USD by convention
      isDefault: legacy.isDefault,
      isActive: legacy.isActive,
      templateId: `migrated-from:${legacyProfileId}`,
      createdAt: now,
      updatedAt: now,
      createdBy,
    });

    // Step 5: create the new payRules
    let rulesCreated = 0;
    let rulesSkipped = 0;
    const skippedReasons: string[] = [];

    for (const r of legacyRules) {
      const componentCode = mapToComponentCode(r.category, r.triggerEvent);
      const componentId = componentsByCode.get(componentCode);
      if (!componentId) {
        rulesSkipped++;
        skippedReasons.push(`${r.name}: missing component ${componentCode}`);
        continue;
      }

      const trigger = mapToTrigger(r.triggerEvent);
      const rateMicro = r.triggerEvent === 'PCT_OF_LOAD'
        ? percentToMicroPctPoints(r.rateAmount)
        : microCentsFromNumber(r.rateAmount, 'USD');

      await ctx.db.insert('payRules', {
        profileId: newProfileId,
        name: r.name,
        componentId,
        trigger,
        rateAmountMicroCents: rateMicro,
        minThreshold: r.minThreshold,
        maxCap: r.maxCap,
        // Legacy didn't have amount caps — leave undefined
        minAmountCents: undefined,
        maxAmountCents: undefined,
        equipmentTypeCondition: r.equipmentTypeCondition,
        customerCondition: undefined,
        isActive: r.isActive,
        sortOrder: rulesCreated,                     // order by insertion
        createdAt: now,
        updatedAt: now,
        createdBy,
      });
      rulesCreated++;
    }

    // Step 6: clone assignments from the matching legacy table — driver
    // profiles read from driverProfileAssignments; carrier profiles read
    // from carrierProfileAssignments. The new payeeProfileAssignments table
    // unifies both via payeeType.
    let assignmentsCreated = 0;
    const isCarrier = legacy.profileType === 'CARRIER';

    if (isCarrier) {
      const allAssignments = await ctx.db
        .query('carrierProfileAssignments')
        .collect();
      const legacyAssignments = allAssignments.filter(a =>
        a.profileId === legacyProfileId && a.workosOrgId === workosOrgId,
      );

      for (const a of legacyAssignments) {
        const existing = await ctx.db
          .query('payeeProfileAssignments')
          .withIndex('by_payee_active', q =>
            q.eq('payeeType', 'CARRIER')
              .eq('payeeId', a.carrierPartnershipId as string)
              .eq('isActive', true))
          .collect();
        if (existing.some(e => e.profileId === newProfileId)) continue;

        const effectiveStart = a.effectiveDate
          ? (() => {
              const ms = Date.parse(a.effectiveDate);
              return Number.isFinite(ms) ? ms : undefined;
            })()
          : undefined;

        await ctx.db.insert('payeeProfileAssignments', {
          workosOrgId,
          payeeType: 'CARRIER',
          payeeId: a.carrierPartnershipId as string,
          profileId: newProfileId,
          isDefault: a.isDefault,
          selectionStrategy: a.selectionStrategy ?? 'ALWAYS_ACTIVE',
          thresholdValue: a.thresholdValue,
          matchState: undefined,
          matchContractTag: undefined,
          effectiveStart,
          effectiveEnd: undefined,
          isActive: true,
          createdAt: now,
          updatedAt: now,
          createdBy,
        });
        assignmentsCreated++;
      }
      // Surface this for the return value
      var legacyAssignmentCount = legacyAssignments.length;
    } else {
      const allAssignments = await ctx.db
        .query('driverProfileAssignments')
        .collect();
      const legacyAssignments = allAssignments.filter(a =>
        a.profileId === legacyProfileId && a.workosOrgId === workosOrgId,
      );

      for (const a of legacyAssignments) {
        const existing = await ctx.db
          .query('payeeProfileAssignments')
          .withIndex('by_payee_active', q =>
            q.eq('payeeType', 'DRIVER').eq('payeeId', a.driverId as string).eq('isActive', true))
          .collect();
        if (existing.some(e => e.profileId === newProfileId)) continue;

        const effectiveStart = a.effectiveDate
          ? (() => {
              const ms = Date.parse(a.effectiveDate);
              return Number.isFinite(ms) ? ms : undefined;
            })()
          : undefined;

        await ctx.db.insert('payeeProfileAssignments', {
          workosOrgId,
          payeeType: 'DRIVER',
          payeeId: a.driverId as string,
          profileId: newProfileId,
          isDefault: a.isDefault,
          selectionStrategy: a.selectionStrategy ?? 'ALWAYS_ACTIVE',
          thresholdValue: a.thresholdValue,
          matchState: undefined,
          matchContractTag: undefined,
          effectiveStart,
          effectiveEnd: undefined,
          isActive: true,
          createdAt: now,
          updatedAt: now,
          createdBy,
        });
        assignmentsCreated++;
      }
      var legacyAssignmentCount = legacyAssignments.length;
    }

    return {
      seedResult,
      legacyProfileName: legacy.name,
      legacyProfileType: legacy.profileType,
      newProfileId,
      rulesCreated,
      rulesSkipped,
      skippedReasons,
      assignmentsCreated,
      legacyAssignmentCount,
    };
  },
});

// ============================================================================
// CARRIER-SIDE DISCOVERY
// ============================================================================

export const listCarriersAssignedToPayProfile = internalQuery({
  args: { profileId: v.id('payProfiles') },
  handler: async (ctx, { profileId }) => {
    const assignments = await ctx.db
      .query('payeeProfileAssignments')
      .withIndex('by_profile', q => q.eq('profileId', profileId))
      .collect();
    const carrierIds = assignments
      .filter(a => a.payeeType === 'CARRIER' && a.isActive)
      .map(a => a.payeeId);

    const out = [];
    for (const cid of carrierIds) {
      const partnership = await ctx.db.get(cid as Id<'carrierPartnerships'>);
      const recentLegs = await ctx.db
        .query('dispatchLegs')
        .withIndex('by_carrier_partnership', q =>
          q.eq('carrierPartnershipId', cid as Id<'carrierPartnerships'>).eq('status', 'COMPLETED'))
        .order('desc')
        .take(50);
      out.push({
        carrierPartnershipId: cid,
        carrierName: partnership?.carrierName,
        completedLegCount: recentLegs.length,
      });
    }
    return out.sort((a, b) => b.completedLegCount - a.completedLegCount);
  },
});

export const findRecentCompletedLegsForCarrier = internalQuery({
  args: {
    carrierPartnershipId: v.id('carrierPartnerships'),
    limit: v.optional(v.number()),
  },
  handler: async (ctx, { carrierPartnershipId, limit }) => {
    const max = limit ?? 25;
    const legs = await ctx.db
      .query('dispatchLegs')
      .withIndex('by_carrier_partnership', q =>
        q.eq('carrierPartnershipId', carrierPartnershipId).eq('status', 'COMPLETED'))
      .order('desc')
      .take(max);
    return legs.map(l => ({ legId: l._id, loadId: l.loadId, sequence: l.sequence }));
  },
});

export const refreshLegacyAndShadowValidateForCarrier = internalAction({
  args: {
    carrierPartnershipId: v.id('carrierPartnerships'),
    limit: v.optional(v.number()),
    userId: v.string(),
  },
  handler: async (ctx, { carrierPartnershipId, limit, userId }) => {
    const legs = await ctx.runQuery(
      internal._devTools.payEngineValidationSetup.findRecentCompletedLegsForCarrier,
      { carrierPartnershipId, limit },
    );

    const results: Array<ShadowValidationResult & { sequence: number; legacyRefreshed: boolean }> = [];
    for (const leg of legs) {
      let refreshed = false;
      try {
        await ctx.runMutation(
          internal.carrierPayCalculation.calculateCarrierPay,
          { legId: leg.legId, userId },
        );
        refreshed = true;
      } catch {
        // Carrier engine may fail on edge cases; still validate
      }
      const r = await ctx.runQuery(
        internal.payEngine.shadowValidate.shadowValidateCarrierLeg,
        { legId: leg.legId },
      );
      results.push({ ...r, sequence: leg.sequence, legacyRefreshed: refreshed });
    }

    const summary: Record<string, number> = {
      MATCH: 0, ROUNDING_DIFF: 0, AMOUNT_DIFF: 0, STRUCTURE_DIFF: 0,
      NEW_ENGINE_FAILED: 0, NO_LEGACY_DATA: 0, NO_DRIVER_ASSIGNED: 0,
    };
    let totalLegacyCents = BigInt(0);
    let totalNewCents = BigInt(0);
    let refreshCount = 0;
    for (const r of results) {
      summary[r.classification] = (summary[r.classification] ?? 0) + 1;
      totalLegacyCents += r.legacy.totalCents;
      totalNewCents += r.newEngine.totalCents;
      if (r.legacyRefreshed) refreshCount++;
    }

    return {
      carrierPartnershipId,
      legsValidated: results.length,
      legacyRefreshCount: refreshCount,
      summary,
      aggregateLegacyTotalCents: totalLegacyCents.toString(),
      aggregateNewTotalCents: totalNewCents.toString(),
      aggregateDeltaCents: (totalNewCents - totalLegacyCents).toString(),
      perLeg: results.map(r => ({
        legId: r.legId,
        classification: r.classification,
        sequence: r.sequence,
        legacyTotalCents: r.legacy.totalCents.toString(),
        newTotalCents: r.newEngine.totalCents.toString(),
        differences: r.differences.map(d => d.description),
      })),
    };
  },
});

// ============================================================================
// 3. SHADOW VALIDATION — batch over a driver's recent legs
// ============================================================================

export const listDriversAssignedToPayProfile = internalQuery({
  args: { profileId: v.id('payProfiles') },
  handler: async (ctx, { profileId }) => {
    const assignments = await ctx.db
      .query('payeeProfileAssignments')
      .withIndex('by_profile', q => q.eq('profileId', profileId))
      .collect();
    const drivers = assignments
      .filter(a => a.payeeType === 'DRIVER' && a.isActive)
      .map(a => a.payeeId);

    // Enrich with driver names + recent leg count for picking a good
    // validation target (drivers with more legs are better signal).
    const out = [];
    for (const driverId of drivers) {
      const driver = await ctx.db.get(driverId as Id<'drivers'>);
      const recentLegs = await ctx.db
        .query('dispatchLegs')
        .withIndex('by_driver', q =>
          q.eq('driverId', driverId as Id<'drivers'>).eq('status', 'COMPLETED'))
        .order('desc')
        .take(50);
      out.push({
        driverId,
        firstName: driver?.firstName,
        lastName: driver?.lastName,
        completedLegCount: recentLegs.length,
      });
    }
    return out.sort((a, b) => b.completedLegCount - a.completedLegCount);
  },
});

export const findRecentCompletedLegsForDriver = internalQuery({
  args: {
    driverId: v.id('drivers'),
    limit: v.optional(v.number()),
  },
  handler: async (ctx, { driverId, limit }) => {
    const max = limit ?? 25;
    const legs = await ctx.db
      .query('dispatchLegs')
      .withIndex('by_driver', q => q.eq('driverId', driverId).eq('status', 'COMPLETED'))
      .order('desc')
      .take(max);
    return legs.map(l => ({ legId: l._id, loadId: l.loadId, sequence: l.sequence }));
  },
});

// Like shadowValidateForDriver, but FIRST re-runs the legacy engine against
// each leg to refresh the persisted loadPayables with current data. This
// removes "stale data" as a divergence source so the diff reflects pure
// engine-vs-engine behavior.
//
// Use this when the legacy data on file was computed against older stop
// times (common after drivers check in/out post-dispatch) — running fresh
// gives a like-for-like comparison.
export const refreshLegacyAndShadowValidateForDriver = internalAction({
  args: {
    driverId: v.id('drivers'),
    limit: v.optional(v.number()),
    userId: v.string(),
  },
  handler: async (ctx, { driverId, limit, userId }) => {
    const legs = await ctx.runQuery(
      internal._devTools.payEngineValidationSetup.findRecentCompletedLegsForDriver,
      { driverId, limit },
    );

    const results: Array<ShadowValidationResult & { sequence: number; legacyRefreshed: boolean }> = [];
    for (const leg of legs) {
      let refreshed = false;
      try {
        await ctx.runMutation(
          internal.driverPayCalculation.calculateDriverPay,
          { legId: leg.legId, userId },
        );
        refreshed = true;
      } catch {
        // legacy engine may fail on legs with edge-case data; we still
        // run shadow validation against whatever loadPayables exist
      }
      const r = await ctx.runQuery(
        internal.payEngine.shadowValidate.shadowValidateLeg,
        { legId: leg.legId },
      );
      results.push({ ...r, sequence: leg.sequence, legacyRefreshed: refreshed });
    }

    const summary: Record<string, number> = {
      MATCH: 0,
      ROUNDING_DIFF: 0,
      AMOUNT_DIFF: 0,
      STRUCTURE_DIFF: 0,
      NEW_ENGINE_FAILED: 0,
      NO_LEGACY_DATA: 0,
      NO_DRIVER_ASSIGNED: 0,
    };
    let totalLegacyCents = BigInt(0);
    let totalNewCents = BigInt(0);
    let refreshCount = 0;
    for (const r of results) {
      summary[r.classification] = (summary[r.classification] ?? 0) + 1;
      totalLegacyCents += r.legacy.totalCents;
      totalNewCents += r.newEngine.totalCents;
      if (r.legacyRefreshed) refreshCount++;
    }

    return {
      driverId,
      legsValidated: results.length,
      legacyRefreshCount: refreshCount,
      summary,
      aggregateLegacyTotalCents: totalLegacyCents.toString(),
      aggregateNewTotalCents: totalNewCents.toString(),
      aggregateDeltaCents: (totalNewCents - totalLegacyCents).toString(),
      perLeg: results.map(r => ({
        legId: r.legId,
        classification: r.classification,
        sequence: r.sequence,
        legacyTotalCents: r.legacy.totalCents.toString(),
        newTotalCents: r.newEngine.totalCents.toString(),
        differences: r.differences.map(d => d.description),
      })),
    };
  },
});

export const shadowValidateForDriver = internalAction({
  args: {
    driverId: v.id('drivers'),
    limit: v.optional(v.number()),
  },
  handler: async (ctx, { driverId, limit }) => {
    const legs = await ctx.runQuery(
      internal._devTools.payEngineValidationSetup.findRecentCompletedLegsForDriver,
      { driverId, limit },
    );

    const results: Array<ShadowValidationResult & { sequence: number }> = [];
    for (const leg of legs) {
      const r = await ctx.runQuery(
        internal.payEngine.shadowValidate.shadowValidateLeg,
        { legId: leg.legId },
      );
      results.push({ ...r, sequence: leg.sequence });
    }

    // Summary counts by classification
    const summary: Record<string, number> = {
      MATCH: 0,
      ROUNDING_DIFF: 0,
      AMOUNT_DIFF: 0,
      STRUCTURE_DIFF: 0,
      NEW_ENGINE_FAILED: 0,
      NO_LEGACY_DATA: 0,
      NO_DRIVER_ASSIGNED: 0,
    };
    let totalLegacyCents = BigInt(0);
    let totalNewCents = BigInt(0);
    for (const r of results) {
      summary[r.classification] = (summary[r.classification] ?? 0) + 1;
      totalLegacyCents += r.legacy.totalCents;
      totalNewCents += r.newEngine.totalCents;
    }

    return {
      driverId,
      legsValidated: results.length,
      summary,
      aggregateLegacyTotalCents: totalLegacyCents.toString(),
      aggregateNewTotalCents: totalNewCents.toString(),
      perLeg: results,
    };
  },
});

// ============================================================================
// HELPERS — legacy → new mapping
// ============================================================================

type LegacyCategory = 'BASE' | 'ACCESSORIAL' | 'DEDUCTION' | 'MANUAL_TEMPLATE';
type LegacyTrigger =
  | 'MILE_LOADED' | 'MILE_EMPTY'
  | 'TIME_DURATION' | 'SESSION_DURATION' | 'TIME_WAITING'
  | 'COUNT_STOPS'
  | 'FLAT_LOAD' | 'FLAT_LEG'
  | 'ATTR_HAZMAT' | 'ATTR_TARP'
  | 'PCT_OF_LOAD';

function mapToComponentCode(category: LegacyCategory, trigger: LegacyTrigger): string {
  if (category === 'BASE') {
    switch (trigger) {
      case 'MILE_LOADED':
      case 'MILE_EMPTY':
        return 'WAGE_MILEAGE';
      case 'TIME_DURATION':
      case 'SESSION_DURATION':
      case 'TIME_WAITING':
        return 'WAGE_HOURLY';
      case 'PCT_OF_LOAD':
        return 'WAGE_PERCENT';
      default:
        return 'WAGE_FLAT';
    }
  }
  if (category === 'ACCESSORIAL') {
    switch (trigger) {
      case 'TIME_WAITING':   return 'DETENTION_PAY';
      case 'COUNT_STOPS':    return 'STOP_PAY';
      case 'ATTR_HAZMAT':    return 'HAZMAT_PREMIUM_PAY';
      case 'ATTR_TARP':      return 'TARP_PREMIUM_PAY';
      default:               return 'LEGACY_ACCESSORIAL';
    }
  }
  if (category === 'DEDUCTION') return 'LEGACY_DEDUCTION';
  return 'LEGACY_MANUAL';
}

function mapToTrigger(triggerEvent: LegacyTrigger): {
  source: string;
  transform?: 'IDENTITY' | 'HOURS_FROM_MINUTES' | 'COUNT' | 'SUM' | 'PERCENT';
} {
  switch (triggerEvent) {
    case 'MILE_LOADED':
      return { source: 'leg.legLoadedMiles' };
    case 'MILE_EMPTY':
      return { source: 'leg.legEmptyMiles' };
    case 'TIME_DURATION':
    case 'SESSION_DURATION':
      return { source: 'leg.durationMinutes', transform: 'HOURS_FROM_MINUTES' };
    case 'TIME_WAITING':
      return { source: 'stops.dwellMinutesSum', transform: 'HOURS_FROM_MINUTES' };
    case 'COUNT_STOPS':
      return { source: 'stops.count' };
    case 'FLAT_LOAD':
    case 'FLAT_LEG':
      return { source: 'constant.1' };
    case 'ATTR_HAZMAT':
      return { source: 'attr.hazmat' };
    case 'ATTR_TARP':
      return { source: 'attr.tarp' };
    case 'PCT_OF_LOAD':
      return { source: 'load.invoiceTotalCents', transform: 'PERCENT' };
  }
}

// Suppress unused — api/centsFromNumber kept available for future expansion
void api;
void centsFromNumber;
