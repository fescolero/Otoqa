import { v } from 'convex/values';
import { internalAction, internalMutation, internalQuery } from './_generated/server';
import type { ActionCtx, MutationCtx, QueryCtx } from './_generated/server';
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

export type HeldLoad = {
  orderNumber: string;
  serviceDate?: string;
  reason: string;
  detail?: string;
};

/** Loads the assessment holds before anything is attempted, with why. */
export const listHolds = internalQuery({
  args: { routeId: v.id('routeAssignments'), ...previousValidator },
  handler: async (ctx, args): Promise<HeldLoad[]> => {
    const rule = await ctx.db.get(args.routeId);
    if (!rule) return [];
    const assessed = await assessRuleLoads(ctx, rule, targetOf(rule), previousFrom(args));
    return assessed
      .filter((a) => !a.verdict.eligible)
      .map((a) => ({
        orderNumber: a.load.orderNumber,
        serviceDate: a.load.firstStopDate,
        reason: a.verdict.eligible ? '' : a.verdict.reason,
      }));
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
  ): Promise<
    | { moved: true; orderNumber: string; serviceDate?: string }
    | {
        moved: false;
        reason: RotationHoldReason;
        orderNumber?: string;
        serviceDate?: string;
        detail?: string;
      }
  > => {
    const rule = await ctx.db.get(args.routeId);
    const load = await ctx.db.get(args.loadId);
    if (!rule || !load || load.autoAssignedRouteId !== rule._id) {
      return { moved: false, reason: 'MOVED_BY_HUMAN', orderNumber: load?.orderNumber };
    }
    const who = { orderNumber: load.orderNumber, serviceDate: load.firstStopDate };

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
    if (!verdict.eligible) return { moved: false, reason: verdict.reason, ...who };

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
        return { moved: false, reason: 'TARGET_INACTIVE', ...who };
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
      if (result.status === 'OVERLAP') {
        // Name the loads the driver already has across this window. This
        // is what decides whether the conflict is real: a dispatcher can
        // look at both and, if the windows are soft, place it by hand.
        const conflicts = (result.overlaps ?? [])
          .map((o) => `#${o.orderNumber ?? o.loadId} (${Math.round(o.overlapMinutes)} min)`)
          .join(', ');
        return {
          moved: false,
          reason: 'OVERLAP_CONFLICT',
          ...who,
          detail: `${driver.firstName} ${driver.lastName} already has ${conflicts}`,
        };
      }
      if (result.status !== 'SUCCESS') {
        return { moved: false, reason: 'ERROR', ...who, detail: result.message };
      }
    } else if (target.carrierPartnershipId) {
      const carrier = await ctx.db.get(target.carrierPartnershipId);
      if (!carrier || carrier.status !== 'ACTIVE') {
        return { moved: false, reason: 'TARGET_INACTIVE', ...who };
      }
      await closeCarrierAward();
      const result = await ctx.runMutation(internal.dispatchLegs.assignCarrierInternal, {
        loadId: load._id,
        carrierPartnershipId: target.carrierPartnershipId,
        ...actor,
        autoAssignedRouteId: rule._id,
      });
      if (result.status !== 'SUCCESS') {
        return { moved: false, reason: 'ERROR', ...who, detail: result.message };
      }
    } else {
      return { moved: false, reason: 'TARGET_INACTIVE', ...who };
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

    return { moved: true, ...who };
  },
});

const heldLoadValidator = v.object({
  orderNumber: v.string(),
  serviceDate: v.optional(v.string()),
  reason: v.string(),
  detail: v.optional(v.string()),
});
const MAX_HELD_LISTED = 50;

export const recordRotation = internalMutation({
  args: {
    routeId: v.id('routeAssignments'),
    lastRotation: v.object({
      at: v.number(),
      considered: v.number(),
      moved: v.number(),
      held: v.number(),
      byReason: v.array(v.object({ reason: v.string(), count: v.number() })),
      heldLoads: v.optional(v.array(heldLoadValidator)),
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

export type RotationOutcome = {
  considered: number;
  moved: number;
  held: number;
  byReason: Array<{ reason: string; count: number }>;
};

/**
 * Rotate one rule: list its candidates, move them one mutation at a time,
 * record the outcome on the rule. Shared by the single-rule action and the
 * org-wide re-sync.
 *
 * Also logs one line per rule so the outcome is visible in the Convex
 * logs without opening the app — holds are otherwise only stored, never
 * thrown, since a held load is a reported decision rather than a failure.
 */
async function rotateRule(
  ctx: ActionCtx,
  args: {
    routeId: Id<'routeAssignments'>;
    previousDriverId?: Id<'drivers'>;
    previousCarrierPartnershipId?: Id<'carrierPartnerships'>;
    userId: string;
    userName?: string;
  },
): Promise<RotationOutcome> {
  const previous = {
    previousDriverId: args.previousDriverId,
    previousCarrierPartnershipId: args.previousCarrierPartnershipId,
  };
  const [candidates, preHolds] = await Promise.all([
    ctx.runQuery(internal.routeRotation.listCandidates, { routeId: args.routeId, ...previous }),
    ctx.runQuery(internal.routeRotation.listHolds, { routeId: args.routeId, ...previous }),
  ]);

  const heldLoads: HeldLoad[] = [...preHolds];
  const byReason = new Map<string, number>();
  const tally = (reason: string) => byReason.set(reason, (byReason.get(reason) ?? 0) + 1);
  for (const h of preHolds) tally(h.reason);

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
      if (r.moved) {
        moved++;
      } else {
        tally(r.reason);
        heldLoads.push({
          orderNumber: r.orderNumber ?? String(loadId),
          serviceDate: r.serviceDate,
          reason: r.reason,
          detail: r.detail,
        });
      }
    } catch (err) {
      console.error(`[rotation] rule ${args.routeId}: load ${loadId} failed:`, err);
      tally('ERROR');
      heldLoads.push({ orderNumber: String(loadId), reason: 'ERROR', detail: String(err) });
    }
  }

  const held = [...byReason.values()].reduce((a, b) => a + b, 0);
  const considered = moved + held;
  const byReasonList = [...byReason.entries()]
    .map(([reason, count]) => ({ reason, count }))
    .sort((a, b) => b.count - a.count);
  heldLoads.sort((a, b) => (a.serviceDate ?? '').localeCompare(b.serviceDate ?? ''));

  await ctx.runMutation(internal.routeRotation.recordRotation, {
    routeId: args.routeId,
    lastRotation: {
      at: Date.now(),
      considered,
      moved,
      held,
      byReason: byReasonList,
      heldLoads: heldLoads.slice(0, MAX_HELD_LISTED),
    },
  });

  console.log(
    `[rotation] rule ${args.routeId}: ${moved} moved, ${held} held` +
      (held > 0 ? ` (${byReasonList.map((r) => `${r.reason} ${r.count}`).join(', ')})` : ''),
  );
  // One line per held load, so the logs answer "which one, and with what".
  for (const h of heldLoads) {
    console.log(
      `[rotation]   held #${h.orderNumber}${h.serviceDate ? ` on ${h.serviceDate}` : ''}: ${h.reason}` +
        (h.detail ? ` — ${h.detail}` : ''),
    );
  }

  return { considered, moved, held, byReason: byReasonList };
}

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
  handler: async (ctx, args): Promise<RotationOutcome> => rotateRule(ctx, args),
});

/** Active rules with a resource — the set an org-wide re-sync walks. */
export const listOrgRuleIds = internalQuery({
  args: { workosOrgId: v.string() },
  handler: async (ctx, args): Promise<Id<'routeAssignments'>[]> => {
    const rules = await ctx.db
      .query('routeAssignments')
      .withIndex('by_org_active', (q) => q.eq('workosOrgId', args.workosOrgId).eq('isActive', true))
      .collect();
    return rules.filter((r) => r.driverId || r.carrierPartnershipId).map((r) => r._id);
  },
});

export const recordBulkRotation = internalMutation({
  args: {
    workosOrgId: v.string(),
    lastBulkRotation: v.object({
      at: v.number(),
      rules: v.number(),
      considered: v.number(),
      moved: v.number(),
      held: v.number(),
      byReason: v.array(v.object({ reason: v.string(), count: v.number() })),
    }),
  },
  returns: v.null(),
  handler: async (ctx, args) => {
    const settings = await ctx.db
      .query('autoAssignmentSettings')
      .withIndex('by_organization', (q) => q.eq('workosOrgId', args.workosOrgId))
      .first();
    if (!settings) return null;
    await ctx.db.patch(settings._id, { lastBulkRotation: args.lastBulkRotation });
    return null;
  },
});

/**
 * Org-wide re-sync: every active rule, one after another, each moving the
 * upcoming loads it owns onto its current resource. Sequential on purpose
 * — two rules that now name the same driver must see each other's moves
 * when the overlap pre-flight runs, or both could book him for the same
 * window. One summary lands on autoAssignmentSettings for the page banner;
 * each rule still gets its own lastRotation.
 */
export const runOrgRotation = internalAction({
  args: {
    workosOrgId: v.string(),
    userId: v.string(),
    userName: v.optional(v.string()),
  },
  handler: async (
    ctx,
    args,
  ): Promise<{ rules: number; considered: number; moved: number; held: number }> => {
    const ruleIds = await ctx.runQuery(internal.routeRotation.listOrgRuleIds, {
      workosOrgId: args.workosOrgId,
    });

    const byReason = new Map<string, number>();
    let considered = 0;
    let moved = 0;
    let held = 0;

    for (const routeId of ruleIds) {
      try {
        const r = await rotateRule(ctx, { routeId, userId: args.userId, userName: args.userName });
        considered += r.considered;
        moved += r.moved;
        held += r.held;
        for (const { reason, count } of r.byReason) {
          byReason.set(reason, (byReason.get(reason) ?? 0) + count);
        }
      } catch (err) {
        console.error(`[rotation] org ${args.workosOrgId}: rule ${routeId} failed:`, err);
        byReason.set('ERROR', (byReason.get('ERROR') ?? 0) + 1);
        held++;
        considered++;
      }
    }

    await ctx.runMutation(internal.routeRotation.recordBulkRotation, {
      workosOrgId: args.workosOrgId,
      lastBulkRotation: {
        at: Date.now(),
        rules: ruleIds.length,
        considered,
        moved,
        held,
        byReason: [...byReason.entries()]
          .map(([reason, count]) => ({ reason, count }))
          .sort((a, b) => b.count - a.count),
      },
    });

    console.log(
      `[rotation] org ${args.workosOrgId}: ${ruleIds.length} rules, ${moved} moved, ${held} held`,
    );

    return { rules: ruleIds.length, considered, moved, held };
  },
});
