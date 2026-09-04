import { v } from 'convex/values';
import { internalMutation, internalAction, internalQuery } from './_generated/server';
import type { MutationCtx } from './_generated/server';
import { internal } from './_generated/api';
import { Id, Doc } from './_generated/dataModel';
import { getLoadFacets } from './lib/loadFacets';
import { matchRouteAssignment } from './lib/routeMatch';
import { horizonEndDate, isBeyondHorizon } from './lib/assignHorizon';
import { logAudit } from './lib/audit';
import type { OverlapInfo } from './_helpers/timeUtils';

/**
 * Auto-Assignment System
 * Automatically assigns loads to pre-configured drivers/carriers based on route rules
 */

// Result type for auto-assignment attempts
type AutoAssignResult = {
  success: boolean;
  loadId: Id<'loadInformation'>;
  action:
    | 'ASSIGNED_DRIVER'
    | 'ASSIGNED_CARRIER'
    | 'NO_MATCH'
    | 'ALREADY_ASSIGNED'
    | 'OPTED_OUT'
    | 'DAY_RESTRICTED'
    | 'NO_SERVICE_DATE'
    | 'BEYOND_HORIZON'
    | 'OVERLAP_CONFLICT'
    | 'DRIVER_INACTIVE'
    | 'CARRIER_INACTIVE'
    | 'ERROR';
  message: string;
  routeAssignmentId?: Id<'routeAssignments'>;
  driverId?: Id<'drivers'>;
  carrierPartnershipId?: Id<'carrierPartnerships'>;
};

const autoAssignResultValidator = v.object({
  success: v.boolean(),
  loadId: v.id('loadInformation'),
  action: v.union(
    v.literal('ASSIGNED_DRIVER'),
    v.literal('ASSIGNED_CARRIER'),
    v.literal('NO_MATCH'),
    v.literal('ALREADY_ASSIGNED'),
    v.literal('OPTED_OUT'),
    v.literal('DAY_RESTRICTED'),
    v.literal('NO_SERVICE_DATE'),
    v.literal('BEYOND_HORIZON'),
    v.literal('OVERLAP_CONFLICT'),
    v.literal('DRIVER_INACTIVE'),
    v.literal('CARRIER_INACTIVE'),
    v.literal('ERROR')
  ),
  message: v.string(),
  routeAssignmentId: v.optional(v.id('routeAssignments')),
  driverId: v.optional(v.id('drivers')),
  carrierPartnershipId: v.optional(v.id('carrierPartnerships')),
});

// Internal query to get auto-assignment settings
export const getAutoAssignmentSettings = internalQuery({
  args: {
    workosOrgId: v.string(),
  },
  handler: async (ctx, args) => {
    return await ctx.db
      .query('autoAssignmentSettings')
      .withIndex('by_organization', (q) => q.eq('workosOrgId', args.workosOrgId))
      .first();
  },
});

/**
 * The assignment decision, shared by the scheduled sweep (autoAssignLoad)
 * and the on-create trigger (triggerAutoAssignmentForLoad).
 *
 * These used to be two near-identical copies. The service-day work already
 * showed how that ends (see lib/routeMatch.ts: four drifting matchers), and
 * the horizon and provenance below would have had to be added to both. One
 * body, two entry points that differ only in which settings flag gates them
 * and whether declines are noted on the load.
 */
async function decideAndAssign(
  ctx: MutationCtx,
  args: {
    load: Doc<'loadInformation'>;
    settings: Doc<'autoAssignmentSettings'>;
    userId: string;
    userName?: string;
    /** On-create path only — the sweep would rewrite the same audit row
     *  every cycle (see noteDecline). */
    noteDeclines: boolean;
  },
): Promise<AutoAssignResult> {
  const { load, settings } = args;
  const loadId = load._id;

  // Skip if already assigned
  if (load.status === 'Assigned' || load.primaryDriverId || load.primaryCarrierPartnershipId) {
    return {
      success: false,
      loadId,
      action: 'ALREADY_ASSIGNED',
      message: 'Load is already assigned',
    };
  }

  // Skip if a human deliberately returned this load to Open (R11).
  // getOpenLoadsWithHcr already filters these out; this is the guard for
  // anything that reaches the mutation directly.
  if (load.autoAssignOptOut) {
    return {
      success: false,
      loadId,
      action: 'OPTED_OUT',
      message: 'Auto-assignment was turned off for this load after a manual unassignment',
    };
  }

  // Not yet due. Not a decline — the sweep re-evaluates every cycle and
  // takes the load the day it crosses the horizon. Checked before the
  // facet read because it is the cheapest test and, with a horizon set,
  // the most common outcome for a freshly imported schedule.
  if (isBeyondHorizon(load.firstStopDate, settings.assignAheadDays)) {
    return {
      success: false,
      loadId,
      action: 'BEYOND_HORIZON',
      message: `Load runs on ${load.firstStopDate}, more than ${settings.assignAheadDays} day${settings.assignAheadDays === 1 ? '' : 's'} out — will be assigned once it comes due`,
    };
  }

  // Read facets from tags. Skip if no HCR.
  // (routeAssignments still uses its own hcr/tripNumber columns + indexes
  // — we're only swapping the read of the load's own facets.)
  const loadFacets = await getLoadFacets(ctx, loadId);
  if (!loadFacets.hcr) {
    return {
      success: false,
      loadId,
      action: 'NO_MATCH',
      message: 'Load has no HCR - cannot auto-assign',
    };
  }

  // Find the route rule — shared matcher, see lib/routeMatch.ts
  const match = await matchRouteAssignment(ctx, {
    workosOrgId: load.workosOrgId,
    hcr: loadFacets.hcr,
    trip: loadFacets.trip,
    // The route calendar is evaluated against the load's SERVICE date,
    // not the clock — see lib/routeMatch.ts.
    serviceDate: load.firstStopDate,
  });
  const routeAssignment = match.route;

  if (!routeAssignment) {
    if (match.declinedBecause === 'NO_SERVICE_DATE') {
      if (args.noteDeclines) {
        await noteDecline(ctx, load, 'NO_SERVICE_DATE',
          `Auto-assignment skipped: the route for HCR ${loadFacets.hcr} runs only on set days and this load has no service date yet`);
      }
      return {
        success: false,
        loadId,
        action: 'NO_SERVICE_DATE',
        message: `Route for HCR ${loadFacets.hcr} runs only on set days, and this load has no service date yet`,
      };
    }
    if (match.declinedBecause === 'CALENDAR') {
      if (args.noteDeclines) {
        await noteDecline(ctx, load, 'DAY_RESTRICTED',
          `Auto-assignment skipped: no route for HCR ${loadFacets.hcr} runs on ${load.firstStopDate}`);
      }
      return {
        success: false,
        loadId,
        action: 'DAY_RESTRICTED',
        message: `No route for HCR ${loadFacets.hcr} runs on ${load.firstStopDate}`,
      };
    }
    return {
      success: false,
      loadId,
      action: 'NO_MATCH',
      message: `No route assignment found for HCR ${loadFacets.hcr}${loadFacets.trip ? ` / Trip ${loadFacets.trip}` : ''}`,
    };
  }

  // Assign to driver or carrier based on route assignment
  if (routeAssignment.driverId) {
    // Check if driver is still active
    const driver = await ctx.db.get(routeAssignment.driverId);
    if (!driver || driver.isDeleted || driver.employmentStatus !== 'Active') {
      return {
        success: false,
        loadId,
        action: 'DRIVER_INACTIVE',
        message: `Driver for route ${routeAssignment.name || routeAssignment.hcr} is inactive or deleted. Please update the route assignment.`,
        routeAssignmentId: routeAssignment._id,
        driverId: routeAssignment.driverId,
      };
    }

    const result = await ctx.runMutation(internal.dispatchLegs.assignDriverInternal, {
      loadId,
      driverId: routeAssignment.driverId,
      truckId: driver.currentTruckId,
      assignedBy: args.userId,
      assignedByName: args.userName ?? 'Auto-Assignment System',
      // The robot does not get to double-book. A dispatcher may.
      blockOnOverlap: true,
      // Provenance: this rule owns the load until a person touches it.
      autoAssignedRouteId: routeAssignment._id,
    });

    if (result.status === 'OVERLAP') {
      // Name each conflicting load's owner: the rule that placed it, or
      // "not placed by a rule" (a dispatcher's, or a pre-provenance
      // leftover). That is what decides whether the overlap is the rules
      // contradicting each other or something a re-sync should clear.
      const conflicts: string[] = [];
      for (const o of result.overlaps ?? []) {
        const other = await ctx.db.get(o.loadId as Id<'loadInformation'>);
        const rule = other?.autoAssignedRouteId ? await ctx.db.get(other.autoAssignedRouteId) : null;
        const owner = rule
          ? `rule "${rule.name ?? `${rule.hcr}${rule.tripNumber ? ` / ${rule.tripNumber}` : ''}`}"`
          : 'not placed by a rule';
        conflicts.push(`Load #${o.orderNumber ?? o.loadId} — ${owner}`);
      }
      return {
        success: false,
        loadId,
        action: 'OVERLAP_CONFLICT',
        message: `${driver.firstName} ${driver.lastName} is already booked across this load's window (${conflicts.join('; ')})`,
        routeAssignmentId: routeAssignment._id,
        driverId: routeAssignment.driverId,
      };
    }

    if (result.status === 'SUCCESS') {
      // No overlap note: blockOnOverlap means a conflicting assignment
      // returned OVERLAP above and never got here.
      return {
        success: true,
        loadId,
        action: 'ASSIGNED_DRIVER',
        message: `Auto-assigned to driver ${driver.firstName} ${driver.lastName}`,
        routeAssignmentId: routeAssignment._id,
        driverId: routeAssignment.driverId,
      };
    }
    return {
      success: false,
      loadId,
      action: 'ERROR',
      message: result.message ?? 'Failed to assign driver',
      routeAssignmentId: routeAssignment._id,
      driverId: routeAssignment.driverId,
    };
  }

  if (routeAssignment.carrierPartnershipId) {
    // Check if carrier is still active
    const carrier = await ctx.db.get(routeAssignment.carrierPartnershipId);
    if (!carrier || carrier.status !== 'ACTIVE') {
      return {
        success: false,
        loadId,
        action: 'CARRIER_INACTIVE',
        message: `Carrier for route ${routeAssignment.name || routeAssignment.hcr} is inactive. Please update the route assignment.`,
        routeAssignmentId: routeAssignment._id,
        carrierPartnershipId: routeAssignment.carrierPartnershipId,
      };
    }

    const result = await ctx.runMutation(internal.dispatchLegs.assignCarrierInternal, {
      loadId,
      carrierPartnershipId: routeAssignment.carrierPartnershipId,
      assignedBy: args.userId,
      assignedByName: args.userName ?? 'Auto-Assignment System',
      autoAssignedRouteId: routeAssignment._id,
    });

    if (result.status === 'SUCCESS') {
      return {
        success: true,
        loadId,
        action: 'ASSIGNED_CARRIER',
        message: `Auto-assigned to carrier ${carrier.carrierName}`,
        routeAssignmentId: routeAssignment._id,
        carrierPartnershipId: routeAssignment.carrierPartnershipId,
      };
    }
    return {
      success: false,
      loadId,
      action: 'ERROR',
      message: result.message ?? 'Failed to assign carrier',
      routeAssignmentId: routeAssignment._id,
      carrierPartnershipId: routeAssignment.carrierPartnershipId,
    };
  }

  return {
    success: false,
    loadId,
    action: 'ERROR',
    message: 'Route assignment has no driver or carrier configured',
    routeAssignmentId: routeAssignment._id,
  };
}

/**
 * Auto-assign a single load based on its HCR + Trip
 * Called during scheduled runs (and by anything else holding a load id)
 */
export const autoAssignLoad = internalMutation({
  args: {
    loadId: v.id('loadInformation'),
    userId: v.string(), // System user ID for audit
    userName: v.optional(v.string()),
  },
  handler: async (ctx, args): Promise<AutoAssignResult> => {
    const load = await ctx.db.get(args.loadId);
    if (!load) {
      return {
        success: false,
        loadId: args.loadId,
        action: 'ERROR',
        message: 'Load not found',
      };
    }

    const settings = await ctx.db
      .query('autoAssignmentSettings')
      .withIndex('by_organization', (q) => q.eq('workosOrgId', load.workosOrgId))
      .first();

    if (!settings?.enabled) {
      return {
        success: false,
        loadId: args.loadId,
        action: 'NO_MATCH',
        message: 'Auto-assignment is disabled for this organization',
      };
    }

    return decideAndAssign(ctx, {
      load,
      settings,
      userId: args.userId,
      userName: args.userName,
      noteDeclines: false,
    });
  },
});

/**
 * Process all pending loads for auto-assignment
 * Called by scheduled cron job
 */
export const autoAssignPendingLoads = internalAction({
  args: {
    workosOrgId: v.string(),
  },
  handler: async (ctx, args): Promise<{
    processed: number;
    assigned: number;
    skipped: number;
    errors: number;
    byAction: Array<{ action: string; count: number }>;
    results: AutoAssignResult[];
  }> => {
    // 1. Check if scheduled auto-assignment is enabled
    const settings = await ctx.runQuery(internal.autoAssignment.getAutoAssignmentSettings, {
      workosOrgId: args.workosOrgId,
    });

    if (!settings?.enabled || !settings.scheduledEnabled) {
      return {
        processed: 0,
        assigned: 0,
        skipped: 0,
        errors: 0,
        byAction: [],
        results: [],
      };
    }

    // 2. Get all Open loads that have HCR — bounded to the horizon when
    // one is set, so a month of imported schedule is not re-read hourly.
    const openLoads = await ctx.runQuery(internal.autoAssignment.getOpenLoadsWithHcr, {
      workosOrgId: args.workosOrgId,
      maxFirstStopDate:
        settings.assignAheadDays !== undefined
          ? horizonEndDate(settings.assignAheadDays)
          : undefined,
    });

    const results: AutoAssignResult[] = [];

    let assigned = 0;
    let skipped = 0;
    let errors = 0;
    // Why each load ended where it did. The counts alone can't distinguish
    // "no rule configured" from "the rule declined today's date".
    const byAction = new Map<string, number>();
    const tally = (action: string) => byAction.set(action, (byAction.get(action) ?? 0) + 1);

    const MAX_RETRIES = 3;

    // 3. Process each load
    for (let i = 0; i < openLoads.length; i++) {
      const load = openLoads[i];
      let succeeded = false;

      for (let attempt = 0; attempt < MAX_RETRIES; attempt++) {
        try {
          const result = await ctx.runMutation(internal.autoAssignment.autoAssignLoad, {
            loadId: load._id,
            userId: 'system',
            userName: 'Scheduled Auto-Assignment',
          });

          results.push(result);
          tally(result.action);

          if (result.success) {
            assigned++;
          } else if (
            result.action === 'NO_MATCH' ||
            result.action === 'ALREADY_ASSIGNED' ||
            result.action === 'OPTED_OUT' ||
            result.action === 'DAY_RESTRICTED' ||
            result.action === 'NO_SERVICE_DATE' ||
            result.action === 'BEYOND_HORIZON' ||
            result.action === 'OVERLAP_CONFLICT'
          ) {
            skipped++;
          } else {
            errors++;
          }
          succeeded = true;
          break;
        } catch (err) {
          const isRetryable = String(err).includes("couldn't be completed");
          if (isRetryable && attempt < MAX_RETRIES - 1) {
            const backoffMs = 500 * Math.pow(2, attempt);
            await new Promise((resolve) => setTimeout(resolve, backoffMs));
            continue;
          }
          errors++;
          tally('ERROR');
          results.push({
            success: false,
            loadId: load._id,
            action: 'ERROR' as const,
            message: `Exception: ${String(err)}`,
          });
          succeeded = true;
          break;
        }
      }

      if (!succeeded) {
        errors++;
        tally('ERROR');
        results.push({
          success: false,
          loadId: load._id,
          action: 'ERROR' as const,
          message: 'Max retries exceeded',
        });
      }
    }

    return {
      processed: openLoads.length,
      assigned,
      skipped,
      errors,
      byAction: [...byAction.entries()]
        .map(([action, count]) => ({ action, count }))
        .sort((a, b) => b.count - a.count),
      results,
    };
  },
});

// Internal query to get open loads with HCR.
// Capped to stay under Convex's 8,192-element return limit and keep
// per-run action execution time reasonable. Remaining loads are picked
// up by the next scheduled run.
const AUTO_ASSIGN_BATCH_SIZE = 4000;

export const getOpenLoadsWithHcr = internalQuery({
  args: {
    workosOrgId: v.string(),
    // Inclusive upper bound on firstStopDate (YYYY-MM-DD) — the assignment
    // horizon. Loads with NO firstStopDate sort before every string in the
    // index, so a `lte` range keeps them, which matches isBeyondHorizon:
    // an undated load is never "too far out".
    maxFirstStopDate: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    const maxDate = args.maxFirstStopDate;
    const loads =
      maxDate !== undefined
        ? await ctx.db
            .query('loadInformation')
            .withIndex('by_org_status_first_stop', (q) =>
              q
                .eq('workosOrgId', args.workosOrgId)
                .eq('status', 'Open')
                .lte('firstStopDate', maxDate),
            )
            .collect()
        : await ctx.db
            .query('loadInformation')
            .withIndex('by_status', (q) =>
              q.eq('workosOrgId', args.workosOrgId).eq('status', 'Open'),
            )
            .collect();

    // Drop loads a human opted out of (R11) BEFORE the facet fan-out —
    // they can never be assigned, so paying a tag read for each is waste.
    const eligible = loads.filter((load) => !load.autoAssignOptOut);

    // Enrich with facet values from tags. Filter to loads that have HCR.
    // O(N) tag lookups across the org's open loads — acceptable here
    // because Open-status loads are typically a small slice.
    const enriched = await Promise.all(
      eligible.map(async (load) => {
        const facets = await getLoadFacets(ctx, load._id);
        return { load, facets };
      }),
    );

    return enriched
      .filter(({ facets }) => !!facets.hcr)
      .slice(0, AUTO_ASSIGN_BATCH_SIZE)
      .map(({ load, facets }) => ({
        _id: load._id,
        parsedHcr: facets.hcr!,
        parsedTripNumber: facets.trip,
      }));
  },
});

/**
 * Record on the load itself why auto-assignment passed it over (R9).
 *
 * Only from the on-create path. The scheduled sweep re-evaluates every Open
 * load every cycle, so logging declines there would write the same row every
 * hour for as long as the load sits — the sweep's aggregate goes to
 * autoAssignmentSettings.lastRun instead.
 *
 * Only actionable declines get a row. NO_MATCH — "no rule exists for this
 * HCR" — is the normal state for most loads in most orgs and would drown
 * the trail.
 */
async function noteDecline(
  ctx: MutationCtx,
  load: Doc<'loadInformation'>,
  action: string,
  description: string,
): Promise<void> {
  await logAudit(ctx, {
    organizationId: load.workosOrgId,
    entityType: 'load',
    entityId: load._id,
    entityName: load.internalId,
    action: 'auto_assign_skipped',
    performedBy: 'system',
    performedByName: 'Auto-Assignment System',
    description,
    changedFields: [action],
  });
}

/**
 * Trigger auto-assignment for a newly created load
 * Called from createLoad mutation when triggerOnCreate is enabled
 */
export const triggerAutoAssignmentForLoad = internalMutation({
  args: {
    loadId: v.id('loadInformation'),
    workosOrgId: v.string(),
    userId: v.string(),
    userName: v.optional(v.string()),
  },
  handler: async (ctx, args): Promise<AutoAssignResult | null> => {
    // Check if auto-assignment is enabled and triggerOnCreate is true
    const settings = await ctx.db
      .query('autoAssignmentSettings')
      .withIndex('by_organization', (q) => q.eq('workosOrgId', args.workosOrgId))
      .first();

    if (!settings?.enabled || !settings.triggerOnCreate) {
      return null;
    }

    const load = await ctx.db.get(args.loadId);
    if (!load) {
      return {
        success: false,
        loadId: args.loadId,
        action: 'ERROR',
        message: 'Load not found',
      };
    }

    return decideAndAssign(ctx, {
      load,
      settings,
      userId: args.userId,
      userName: args.userName,
      noteDeclines: true,
    });
  },
});
