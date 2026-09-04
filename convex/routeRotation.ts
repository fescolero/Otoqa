import { v } from 'convex/values';
import { internalAction, internalMutation, internalQuery } from './_generated/server';
import type { MutationCtx, QueryCtx } from './_generated/server';
import { internal } from './_generated/api';
import type { Doc, Id } from './_generated/dataModel';
import { routeServesDate } from './lib/routeMatch';
import { serviceDateOf } from './lib/assignHorizon';
import { logAudit } from './lib/audit';

/**
 * Route rotation — re-point the upcoming loads a route rule auto-assigned
 * at the rule's (new) driver or carrier.
 *
 * The problem this solves: a rule put next week's loads on Dana, then the
 * rotation changed and the rule now names Sam. Editing the rule only
 * affects loads that have not been assigned yet. The ones already on Dana
 * stay there, and the manual fix (unassign, then wait for the sweep) does
 * not work either — unassigning sets autoAssignOptOut (R11), so the sweep
 * will never hand them to Sam.
 *
 * What makes this safe to automate is provenance: loadInformation
 * .autoAssignedRouteId is written only by the auto-assignment paths and
 * cleared by every human assign / reassign / unassign. So "loads with this
 * rule's id" is exactly "loads the robot placed under this rule that
 * nobody has touched since". A dispatcher's hand-placed load is never in
 * the set, whatever driver it is on.
 *
 * Holds are per-load and reported, never silent — same posture as the
 * sweep's lastRun breakdown. A load that is in motion, in the past, or
 * would double-book the new driver stays where it is and shows up in the
 * count with its reason.
 */

export type RotationHoldReason =
  | 'IN_MOTION' // a leg has started or finished, or the carrier is en route
  | 'PAST' // service date is before today — too late to re-plan
  | 'NO_SERVICE_DATE' // cannot tell whether it is upcoming
  | 'MOVED_BY_HUMAN' // no longer on the resource the rule had (belt and braces — provenance should already be cleared)
  | 'ALREADY_ON_TARGET'
  | 'DAY_RESTRICTED' // the rule's calendar no longer covers this load's date
  | 'TARGET_INACTIVE'
  | 'OVERLAP_CONFLICT'
  | 'ERROR';

export type RotationTarget = {
  driverId?: Id<'drivers'>;
  carrierPartnershipId?: Id<'carrierPartnerships'>;
};

export type RotationVerdict =
  | { eligible: true }
  | { eligible: false; reason: RotationHoldReason };

/**
 * Pure: may this load be moved?
 *
 * `previous` is the resource the rule named before the edit. When given, a
 * load must still be on it — otherwise someone moved the load by hand and
 * it is theirs. When absent (the explicit "re-sync" action) any load the
 * rule owns that is not already on the target qualifies.
 */
export function classifyForRotation(input: {
  load: Doc<'loadInformation'>;
  legs: Doc<'dispatchLegs'>[];
  carrierAssignments: Doc<'loadCarrierAssignments'>[];
  rule: Doc<'routeAssignments'>;
  target: RotationTarget;
  previous?: RotationTarget;
  today: string;
}): RotationVerdict {
  const { load, legs, carrierAssignments, rule, target, previous, today } = input;

  if (load.status !== 'Assigned') return { eligible: false, reason: 'MOVED_BY_HUMAN' };

  const inMotion =
    legs.some((l) => l.status === 'ACTIVE' || l.status === 'COMPLETED') ||
    carrierAssignments.some((a) => a.status === 'IN_PROGRESS');
  if (inMotion) return { eligible: false, reason: 'IN_MOTION' };

  if (!load.firstStopDate) return { eligible: false, reason: 'NO_SERVICE_DATE' };
  if (load.firstStopDate < today) return { eligible: false, reason: 'PAST' };

  const onDriver = load.primaryDriverId;
  const onCarrier = load.primaryCarrierPartnershipId;

  if (previous) {
    const stillOnPrevious =
      (previous.driverId !== undefined && onDriver === previous.driverId) ||
      (previous.carrierPartnershipId !== undefined &&
        onCarrier === previous.carrierPartnershipId);
    if (!stillOnPrevious) return { eligible: false, reason: 'MOVED_BY_HUMAN' };
  }

  const alreadyOnTarget =
    (target.driverId !== undefined && onDriver === target.driverId) ||
    (target.carrierPartnershipId !== undefined && onCarrier === target.carrierPartnershipId);
  if (alreadyOnTarget) return { eligible: false, reason: 'ALREADY_ON_TARGET' };

  // The edit may have changed the calendar too. A load the rule would no
  // longer take is left where it is and reported, not moved onto a driver
  // who does not run that day.
  if (!routeServesDate(rule, load.firstStopDate).serves) {
    return { eligible: false, reason: 'DAY_RESTRICTED' };
  }

  return { eligible: true };
}

/** Everything a rule currently owns that is still Assigned, classified. */
export async function assessRuleLoads(
  ctx: QueryCtx | MutationCtx,
  rule: Doc<'routeAssignments'>,
  target: RotationTarget,
  previous: RotationTarget | undefined,
  nowMs = Date.now(),
): Promise<Array<{ load: Doc<'loadInformation'>; verdict: RotationVerdict }>> {
  const today = serviceDateOf(nowMs);
  const loads = await ctx.db
    .query('loadInformation')
    .withIndex('by_auto_assigned_route_status', (q) =>
      q.eq('autoAssignedRouteId', rule._id).eq('status', 'Assigned'),
    )
    .collect();

  return Promise.all(
    loads.map(async (load) => {
      const [legs, carrierAssignments] = await Promise.all([
        ctx.db
          .query('dispatchLegs')
          .withIndex('by_load', (q) => q.eq('loadId', load._id))
          .collect(),
        ctx.db
          .query('loadCarrierAssignments')
          .withIndex('by_load', (q) => q.eq('loadId', load._id))
          .collect(),
      ]);
      return {
        load,
        verdict: classifyForRotation({
          load,
          legs,
          carrierAssignments,
          rule,
          target,
          previous,
          today,
        }),
      };
    }),
  );
}

export function targetOf(rule: {
  driverId?: Id<'drivers'>;
  carrierPartnershipId?: Id<'carrierPartnerships'>;
}): RotationTarget {
  return rule.driverId
    ? { driverId: rule.driverId }
    : rule.carrierPartnershipId
      ? { carrierPartnershipId: rule.carrierPartnershipId }
      : {};
}

const previousValidator = {
  previousDriverId: v.optional(v.id('drivers')),
  previousCarrierPartnershipId: v.optional(v.id('carrierPartnerships')),
};

function previousFrom(args: {
  previousDriverId?: Id<'drivers'>;
  previousCarrierPartnershipId?: Id<'carrierPartnerships'>;
}): RotationTarget | undefined {
  if (args.previousDriverId) return { driverId: args.previousDriverId };
  if (args.previousCarrierPartnershipId) {
    return { carrierPartnershipId: args.previousCarrierPartnershipId };
  }
  return undefined;
}

/** Candidate load ids for the action to work through one by one. */
export const listCandidates = internalQuery({
  args: { routeId: v.id('routeAssignments'), ...previousValidator },
  handler: async (ctx, args): Promise<Id<'loadInformation'>[]> => {
    const rule = await ctx.db.get(args.routeId);
    if (!rule) return [];
    const assessed = await assessRuleLoads(ctx, rule, targetOf(rule), previousFrom(args));
    // Only the ones worth a mutation. Holds are re-derived (and counted)
    // by the action from a second assessment so the tally reflects the
    // whole set, not just what was attempted.
    return assessed.filter((a) => a.verdict.eligible).map((a) => a.load._id);
  },
});

/** Hold counts for the whole set, for the action's tally. */
export const tallyHolds = internalQuery({
  args: { routeId: v.id('routeAssignments'), ...previousValidator },
  handler: async (ctx, args): Promise<Array<{ reason: string; count: number }>> => {
    const rule = await ctx.db.get(args.routeId);
    if (!rule) return [];
    const assessed = await assessRuleLoads(ctx, rule, targetOf(rule), previousFrom(args));
    const counts = new Map<string, number>();
    for (const a of assessed) {
      if (!a.verdict.eligible) {
        counts.set(a.verdict.reason, (counts.get(a.verdict.reason) ?? 0) + 1);
      }
    }
    return [...counts.entries()].map(([reason, count]) => ({ reason, count }));
  },
});

/**
 * Move one load. Re-classifies inside the transaction so a load that
 * started moving between the listing and now is left alone.
 */
export const rotateOneLoad = internalMutation({
  args: {
    loadId: v.id('loadInformation'),
    routeId: v.id('routeAssignments'),
    ...previousValidator,
    userId: v.string(),
    userName: v.optional(v.string()),
  },
  handler: async (
    ctx,
    args,
  ): Promise<{ moved: true } | { moved: false; reason: RotationHoldReason }> => {
    const rule = await ctx.db.get(args.routeId);
    const load = await ctx.db.get(args.loadId);
    if (!rule || !load || load.autoAssignedRouteId !== rule._id) {
      return { moved: false, reason: 'MOVED_BY_HUMAN' };
    }

    const [legs, carrierAssignments] = await Promise.all([
      ctx.db
        .query('dispatchLegs')
        .withIndex('by_load', (q) => q.eq('loadId', load._id))
        .collect(),
      ctx.db
        .query('loadCarrierAssignments')
        .withIndex('by_load', (q) => q.eq('loadId', load._id))
        .collect(),
    ]);
    const target = targetOf(rule);
    const verdict = classifyForRotation({
      load,
      legs,
      carrierAssignments,
      rule,
      target,
      previous: previousFrom(args),
      today: serviceDateOf(Date.now()),
    });
    if (!verdict.eligible) return { moved: false, reason: verdict.reason };

    const now = Date.now();
    const actor = { assignedBy: args.userId, assignedByName: args.userName ?? 'Route rotation' };

    // Leaving a carrier: the AWARDED row is what the carrier's mobile app
    // shows, and neither assign helper touches it. Close it out first so
    // the old carrier stops seeing a load that is no longer theirs.
    const closeCarrierAward = async () => {
      for (const a of carrierAssignments) {
        if (a.status === 'AWARDED') {
          await ctx.db.patch(a._id, {
            status: 'CANCELED',
            canceledAt: now,
            canceledBy: args.userId,
            canceledByParty: 'BROKER',
            cancellationReason: 'OTHER',
            cancellationNotes: `Route rule "${rule.name ?? rule.hcr}" rotated to a different resource`,
          });
        }
      }
    };

    if (target.driverId) {
      const driver = await ctx.db.get(target.driverId);
      if (!driver || driver.isDeleted || driver.employmentStatus !== 'Active') {
        return { moved: false, reason: 'TARGET_INACTIVE' };
      }
      await closeCarrierAward();
      const result = await ctx.runMutation(internal.dispatchLegs.assignDriverInternal, {
        loadId: load._id,
        driverId: target.driverId,
        truckId: driver.currentTruckId,
        ...actor,
        // Same rule as auto-assignment: the robot never double-books.
        blockOnOverlap: true,
        autoAssignedRouteId: rule._id,
      });
      if (result.status === 'OVERLAP') return { moved: false, reason: 'OVERLAP_CONFLICT' };
      if (result.status !== 'SUCCESS') return { moved: false, reason: 'ERROR' };
    } else if (target.carrierPartnershipId) {
      const carrier = await ctx.db.get(target.carrierPartnershipId);
      if (!carrier || carrier.status !== 'ACTIVE') {
        return { moved: false, reason: 'TARGET_INACTIVE' };
      }
      await closeCarrierAward();
      const result = await ctx.runMutation(internal.dispatchLegs.assignCarrierInternal, {
        loadId: load._id,
        carrierPartnershipId: target.carrierPartnershipId,
        ...actor,
        autoAssignedRouteId: rule._id,
      });
      if (result.status !== 'SUCCESS') return { moved: false, reason: 'ERROR' };
    } else {
      return { moved: false, reason: 'TARGET_INACTIVE' };
    }

    await logAudit(ctx, {
      organizationId: load.workosOrgId,
      entityType: 'load',
      entityId: load._id,
      entityName: load.internalId,
      action: 'auto_assign_rotated',
      performedBy: args.userId,
      performedByName: args.userName ?? 'Route rotation',
      description: `Moved load ${load.orderNumber} to the current resource on route rule "${rule.name ?? rule.hcr}"`,
      changedFields: ['primaryDriverId', 'primaryCarrierPartnershipId'],
    });

    return { moved: true };
  },
});

export const recordRotation = internalMutation({
  args: {
    routeId: v.id('routeAssignments'),
    lastRotation: v.object({
      at: v.number(),
      considered: v.number(),
      moved: v.number(),
      held: v.number(),
      byReason: v.array(v.object({ reason: v.string(), count: v.number() })),
    }),
  },
  returns: v.null(),
  handler: async (ctx, args) => {
    const rule = await ctx.db.get(args.routeId);
    if (!rule) return null;
    await ctx.db.patch(args.routeId, { lastRotation: args.lastRotation });
    return null;
  },
});

/**
 * The rotation itself. Scheduled (not inline in the rule edit) because
 * each move runs the full assignment cascade, pay recalculation included,
 * and a rule can own dozens of upcoming loads. One load per mutation keeps
 * each transaction small and means one overlap does not roll back the
 * rest. The outcome lands on the rule row for the UI.
 */
export const runRotation = internalAction({
  args: {
    routeId: v.id('routeAssignments'),
    ...previousValidator,
    userId: v.string(),
    userName: v.optional(v.string()),
  },
  handler: async (
    ctx,
    args,
  ): Promise<{ considered: number; moved: number; held: number }> => {
    const previous = {
      previousDriverId: args.previousDriverId,
      previousCarrierPartnershipId: args.previousCarrierPartnershipId,
    };
    const [candidates, preHolds] = await Promise.all([
      ctx.runQuery(internal.routeRotation.listCandidates, { routeId: args.routeId, ...previous }),
      ctx.runQuery(internal.routeRotation.tallyHolds, { routeId: args.routeId, ...previous }),
    ]);

    const byReason = new Map<string, number>(preHolds.map((h) => [h.reason, h.count]));
    const tally = (reason: string) => byReason.set(reason, (byReason.get(reason) ?? 0) + 1);

    let moved = 0;
    for (const loadId of candidates) {
      try {
        const r = await ctx.runMutation(internal.routeRotation.rotateOneLoad, {
          loadId,
          routeId: args.routeId,
          ...previous,
          userId: args.userId,
          userName: args.userName,
        });
        if (r.moved) moved++;
        else tally(r.reason);
      } catch (err) {
        console.error(`Rotation failed for load ${loadId}:`, err);
        tally('ERROR');
      }
    }

    const held = [...byReason.values()].reduce((a, b) => a + b, 0);
    const considered = moved + held;

    await ctx.runMutation(internal.routeRotation.recordRotation, {
      routeId: args.routeId,
      lastRotation: {
        at: Date.now(),
        considered,
        moved,
        held,
        byReason: [...byReason.entries()]
          .map(([reason, count]) => ({ reason, count }))
          .sort((a, b) => b.count - a.count),
      },
    });

    return { considered, moved, held };
  },
});
