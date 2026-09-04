import { v } from 'convex/values';
import { internalAction, internalMutation, internalQuery } from './_generated/server';
import type { ActionCtx, MutationCtx, QueryCtx } from './_generated/server';
import { internal } from './_generated/api';
import type { Doc, Id } from './_generated/dataModel';
import { matchRouteAssignment, routeServesDate } from './lib/routeMatch';
import { serviceDateOf } from './lib/assignHorizon';
import { unassignLoadResources } from './dispatchLegs';
import { getLoadFacets } from './lib/loadFacets';
import { ASSIGNMENT_ACTIONS, isRobotActor } from './lib/robotActors';

/**
 * Route re-sync — when a rule changes, the loads it placed are released
 * and auto-assignment places them again under whatever rule applies now.
 *
 * The model: with the assignment horizon set to one day (see
 * lib/assignHorizon.ts), each rule holds at most a day's worth of loads,
 * so a rule change is small. The load the rule placed is simply returned
 * to Open — the same cascade a dispatcher's unassign runs, minus the
 * opt-out flag — and the ordinary assignment decision runs on it again:
 * new driver, new days, a different rule entirely, or nobody (it stays
 * Open, in front of a dispatcher, and the run says why).
 *
 * Release FIRST, across every load involved, and only then re-place. That
 * ordering is the whole design: when two rules trade drivers, each load
 * would otherwise be blocked by the other still sitting on its target.
 * Once both are Open there is nothing to collide with except genuine
 * bookings, which the robot still refuses to double-book.
 *
 * What makes this safe to automate is provenance: loadInformation
 * .autoAssignedRouteId is written only by auto-assignment and cleared by
 * every human assign / reassign / unassign. So "loads with this rule's
 * id" is exactly "loads the robot placed under this rule that nobody has
 * touched since". A dispatcher's hand-placed load is never in the set.
 */

export type RotationHoldReason =
  | 'IN_MOTION' // a leg has started or finished, or the carrier is en route
  | 'PAST' // service date is before today — too late to re-plan
  | 'NO_SERVICE_DATE' // cannot tell whether it is upcoming
  | 'MOVED_BY_HUMAN' // provenance says the rule's, but state disagrees (belt and braces)
  | 'IN_SYNC'; // on the rule's resource, on a day the rule covers — nothing to do

export type RotationTarget = {
  driverId?: Id<'drivers'>;
  carrierPartnershipId?: Id<'carrierPartnerships'>;
};

export type RotationVerdict =
  | { eligible: true }
  | { eligible: false; reason: RotationHoldReason };

/**
 * Pure: should this load be released?
 *
 * Yes when the rule that placed it would not place it there today: it
 * sits on a different resource than the rule names, or on a date the
 * rule's calendar (or effective range) no longer covers.
 */
export function classifyForRotation(input: {
  load: Doc<'loadInformation'>;
  legs: Doc<'dispatchLegs'>[];
  carrierAssignments: Doc<'loadCarrierAssignments'>[];
  rule: Doc<'routeAssignments'>;
  today: string;
}): RotationVerdict {
  const { load, legs, carrierAssignments, rule, today } = input;

  if (load.status !== 'Assigned') return { eligible: false, reason: 'MOVED_BY_HUMAN' };

  const inMotion =
    legs.some((l) => l.status === 'ACTIVE' || l.status === 'COMPLETED') ||
    carrierAssignments.some((a) => a.status === 'IN_PROGRESS');
  if (inMotion) return { eligible: false, reason: 'IN_MOTION' };

  if (!load.firstStopDate) return { eligible: false, reason: 'NO_SERVICE_DATE' };
  if (load.firstStopDate < today) return { eligible: false, reason: 'PAST' };

  const target = targetOf(rule);
  const onTarget =
    (target.driverId !== undefined && load.primaryDriverId === target.driverId) ||
    (target.carrierPartnershipId !== undefined &&
      load.primaryCarrierPartnershipId === target.carrierPartnershipId);
  const stillCovered = rule.isActive && routeServesDate(rule, load.firstStopDate).serves;
  if (onTarget && stillCovered) return { eligible: false, reason: 'IN_SYNC' };

  return { eligible: true };
}

/** Everything a rule currently owns that is still Assigned, classified. */
export async function assessRuleLoads(
  ctx: QueryCtx | MutationCtx,
  rule: Doc<'routeAssignments'>,
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
      return { load, verdict: classifyForRotation({ load, legs, carrierAssignments, rule, today }) };
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

export type HeldLoad = {
  orderNumber: string;
  serviceDate?: string;
  reason: string;
  detail?: string;
};

type Released = { loadId: Id<'loadInformation'>; orderNumber: string; serviceDate?: string };

/** The rule's loads, split into "release these" and "leave these, because". */
export const assess = internalQuery({
  args: { routeId: v.id('routeAssignments') },
  handler: async (
    ctx,
    args,
  ): Promise<{ release: Id<'loadInformation'>[]; holds: HeldLoad[] }> => {
    const rule = await ctx.db.get(args.routeId);
    if (!rule) return { release: [], holds: [] };
    const assessed = await assessRuleLoads(ctx, rule);
    return {
      release: assessed.filter((a) => a.verdict.eligible).map((a) => a.load._id),
      holds: assessed
        .filter((a) => !a.verdict.eligible)
        .map((a) => ({
          orderNumber: a.load.orderNumber,
          serviceDate: a.load.firstStopDate,
          reason: a.verdict.eligible ? '' : a.verdict.reason,
        })),
    };
  },
});

/**
 * Release one load: back to Open, provenance and legs cleared, no opt-out
 * flag. Re-classified inside the transaction so a load that started
 * moving since the assessment is left alone.
 */
export const releaseOne = internalMutation({
  args: {
    loadId: v.id('loadInformation'),
    routeId: v.id('routeAssignments'),
    userId: v.string(),
    userName: v.optional(v.string()),
  },
  handler: async (
    ctx,
    args,
  ): Promise<
    | { released: true; orderNumber: string; serviceDate?: string }
    | { released: false; reason: RotationHoldReason; orderNumber?: string; serviceDate?: string }
  > => {
    const rule = await ctx.db.get(args.routeId);
    const load = await ctx.db.get(args.loadId);
    if (!rule || !load || load.autoAssignedRouteId !== rule._id) {
      return { released: false, reason: 'MOVED_BY_HUMAN', orderNumber: load?.orderNumber };
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
    const verdict = classifyForRotation({
      load,
      legs,
      carrierAssignments,
      rule,
      today: serviceDateOf(Date.now()),
    });
    if (!verdict.eligible) return { released: false, reason: verdict.reason, ...who };

    // Leaving a carrier: the AWARDED row is what the carrier's app shows,
    // and unassignLoadResources does not touch it. Close it out.
    const now = Date.now();
    for (const a of carrierAssignments) {
      if (a.status === 'AWARDED') {
        await ctx.db.patch(a._id, {
          status: 'CANCELED',
          canceledAt: now,
          canceledBy: args.userId,
          canceledByParty: 'BROKER',
          cancellationReason: 'OTHER',
          cancellationNotes: `Route rule "${rule.name ?? rule.hcr}" changed; load released for re-assignment`,
        });
      }
    }

    const result = await unassignLoadResources(
      ctx,
      load._id,
      { userId: args.userId, userName: args.userName ?? 'Route re-sync' },
      `route rule "${rule.name ?? rule.hcr}" changed; released for re-assignment`,
      // No opt-out: the whole point is that auto-assignment takes it again.
      false,
    );
    if (result.status !== 'SUCCESS') {
      return { released: false, reason: 'MOVED_BY_HUMAN', ...who };
    }
    return { released: true, ...who };
  },
});

export type RotationOutcome = {
  considered: number;
  moved: number;
  held: number;
  byReason: Array<{ reason: string; count: number }>;
};

/**
 * Phase 1 for one rule: release what it placed that no longer fits.
 */
async function releasePhase(
  ctx: ActionCtx,
  routeId: Id<'routeAssignments'>,
  actor: { userId: string; userName?: string },
): Promise<{ released: Released[]; holds: HeldLoad[] }> {
  const { release, holds } = await ctx.runQuery(internal.routeRotation.assess, { routeId });
  const released: Released[] = [];
  const allHolds = [...holds];
  for (const loadId of release) {
    try {
      const r = await ctx.runMutation(internal.routeRotation.releaseOne, { loadId, routeId, ...actor });
      if (r.released) released.push({ loadId, orderNumber: r.orderNumber, serviceDate: r.serviceDate });
      else allHolds.push({ orderNumber: r.orderNumber ?? String(loadId), serviceDate: r.serviceDate, reason: r.reason });
    } catch (err) {
      console.error(`[rotation] rule ${routeId}: release of ${loadId} failed:`, err);
      allHolds.push({ orderNumber: String(loadId), reason: 'ERROR', detail: String(err) });
    }
  }
  return { released, holds: allHolds };
}

/**
 * Phase 2: the ordinary assignment decision, on each released load. A
 * load that is not re-placed stays Open — visible to dispatch — and the
 * decision's own reason is recorded (OVERLAP_CONFLICT, NO_MATCH,
 * DAY_RESTRICTED, BEYOND_HORIZON when it is simply not due yet, …).
 */
async function replacePhase(
  ctx: ActionCtx,
  released: Released[],
  actor: { userId: string; userName?: string },
): Promise<{ moved: number; open: HeldLoad[] }> {
  let moved = 0;
  const open: HeldLoad[] = [];
  for (const l of released) {
    try {
      const r = await ctx.runMutation(internal.autoAssignment.autoAssignLoad, {
        loadId: l.loadId,
        userId: actor.userId,
        userName: actor.userName ?? 'Route re-sync',
      });
      if (r.success) moved++;
      else open.push({ orderNumber: l.orderNumber, serviceDate: l.serviceDate, reason: r.action, detail: r.message });
    } catch (err) {
      console.error(`[rotation] re-place of ${l.loadId} failed:`, err);
      open.push({ orderNumber: l.orderNumber, serviceDate: l.serviceDate, reason: 'ERROR', detail: String(err) });
    }
  }
  return { moved, open };
}

const MAX_HELD_LISTED = 50;

function summarize(moved: number, holds: HeldLoad[]): RotationOutcome & { heldLoads: HeldLoad[] } {
  const byReason = new Map<string, number>();
  for (const h of holds) byReason.set(h.reason, (byReason.get(h.reason) ?? 0) + 1);
  // Counted, but not listed: in-sync loads are not something to act on.
  const heldLoads = holds
    .filter((h) => h.reason !== 'IN_SYNC')
    .sort((a, b) => (a.serviceDate ?? '').localeCompare(b.serviceDate ?? ''));
  return {
    considered: moved + holds.length,
    moved,
    held: holds.length,
    byReason: [...byReason.entries()]
      .map(([reason, count]) => ({ reason, count }))
      .sort((a, b) => b.count - a.count),
    heldLoads: heldLoads.slice(0, MAX_HELD_LISTED),
  };
}

async function record(
  ctx: ActionCtx,
  routeId: Id<'routeAssignments'>,
  outcome: RotationOutcome & { heldLoads: HeldLoad[] },
): Promise<void> {
  await ctx.runMutation(internal.routeRotation.recordRotation, {
    routeId,
    lastRotation: { at: Date.now(), ...outcome },
  });
  // In-sync loads are the healthy state, not a problem to list.
  const inSync = outcome.byReason.find((r) => r.reason === 'IN_SYNC')?.count ?? 0;
  const attention = outcome.byReason.filter((r) => r.reason !== 'IN_SYNC');
  console.log(
    `[rotation] rule ${routeId}: ${outcome.moved} re-placed, ${inSync} in sync, ${outcome.held - inSync} need attention` +
      (attention.length > 0 ? ` (${attention.map((r) => `${r.reason} ${r.count}`).join(', ')})` : ''),
  );
  for (const h of outcome.heldLoads) {
    if (h.reason === 'IN_SYNC') continue;
    console.log(
      `[rotation]   #${h.orderNumber}${h.serviceDate ? ` on ${h.serviceDate}` : ''}: ${h.reason}` +
        (h.detail ? ` — ${h.detail}` : ''),
    );
  }
}

const heldLoadValidator = v.object({
  orderNumber: v.string(),
  serviceDate: v.optional(v.string()),
  reason: v.string(),
  detail: v.optional(v.string()),
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

/**
 * Re-sync one rule. Scheduled (not inline in the rule edit) because each
 * re-placement runs the full assignment cascade, pay recalculation
 * included. One load per mutation keeps each transaction small and means
 * one refusal does not roll back the rest. The outcome lands on the rule.
 */
export const runRotation = internalAction({
  args: {
    routeId: v.id('routeAssignments'),
    userId: v.string(),
    userName: v.optional(v.string()),
  },
  handler: async (ctx, args): Promise<RotationOutcome> => {
    const actor = { userId: args.userId, userName: args.userName };
    const { released, holds } = await releasePhase(ctx, args.routeId, actor);
    const { moved, open } = await replacePhase(ctx, released, actor);
    const outcome = summarize(moved, [...holds, ...open]);
    await record(ctx, args.routeId, outcome);
    return outcome;
  },
});

/**
 * Robot-assigned loads that carry no provenance (assigned before it
 * existed) and that no rule claims today. They sit on a driver for no
 * reason the rules can state, and they block everything a re-sync tries
 * to place on him. Decided from the audit trail (lib/robotActors.ts):
 * the load's most recent assignment row must be the robot's. A
 * dispatcher's load never qualifies.
 */
async function isUnclaimedRobotLoad(
  ctx: QueryCtx | MutationCtx,
  load: Doc<'loadInformation'>,
  today: string,
): Promise<boolean> {
  if (load.status !== 'Assigned') return false;
  if (load.autoAssignedRouteId !== undefined) return false;
  if (!load.primaryDriverId && !load.primaryCarrierPartnershipId) return false;
  if (!load.firstStopDate || load.firstStopDate < today) return false;

  const legs = await ctx.db
    .query('dispatchLegs')
    .withIndex('by_load', (q) => q.eq('loadId', load._id))
    .collect();
  if (legs.some((l) => l.status === 'ACTIVE' || l.status === 'COMPLETED')) return false;

  const history = await ctx.db
    .query('auditLog')
    .withIndex('by_org_entity', (q) =>
      q.eq('organizationId', load.workosOrgId).eq('entityType', 'load').eq('entityId', load._id),
    )
    .order('desc')
    .collect();
  const latest = history.find((row) => ASSIGNMENT_ACTIONS.has(row.action));
  if (!latest) return false;
  if (latest.action !== 'driver_assigned' && latest.action !== 'carrier_assigned') return false;
  if (!isRobotActor(latest)) return false;

  const facets = await getLoadFacets(ctx, load._id);
  if (!facets.hcr) return true;
  const match = await matchRouteAssignment(ctx, {
    workosOrgId: load.workosOrgId,
    hcr: facets.hcr,
    trip: facets.trip,
    serviceDate: load.firstStopDate,
  });
  return match.route === null;
}

export const listUnclaimedRobotLoads = internalQuery({
  args: { workosOrgId: v.string() },
  handler: async (ctx, args): Promise<Id<'loadInformation'>[]> => {
    const today = serviceDateOf(Date.now());
    const loads = await ctx.db
      .query('loadInformation')
      .withIndex('by_org_status_first_stop', (q) =>
        q.eq('workosOrgId', args.workosOrgId).eq('status', 'Assigned').gte('firstStopDate', today),
      )
      .collect();
    const out: Id<'loadInformation'>[] = [];
    for (const load of loads) {
      if (load.autoAssignedRouteId !== undefined) continue; // cheap pre-filter
      if (await isUnclaimedRobotLoad(ctx, load, today)) out.push(load._id);
    }
    return out;
  },
});

export const releaseUnclaimedOne = internalMutation({
  args: { loadId: v.id('loadInformation'), userId: v.string(), userName: v.optional(v.string()) },
  handler: async (ctx, args): Promise<{ released: boolean; orderNumber?: string; serviceDate?: string }> => {
    const load = await ctx.db.get(args.loadId);
    if (!load) return { released: false };
    if (!(await isUnclaimedRobotLoad(ctx, load, serviceDateOf(Date.now())))) {
      return { released: false, orderNumber: load.orderNumber, serviceDate: load.firstStopDate };
    }
    const r = await unassignLoadResources(
      ctx,
      load._id,
      { userId: args.userId, userName: args.userName ?? 'Route re-sync' },
      'auto-assigned before rules had service days; no rule claims this load now',
      false,
    );
    return { released: r.status === 'SUCCESS', orderNumber: load.orderNumber, serviceDate: load.firstStopDate };
  },
});

/** Every rule with a resource — the set an org-wide re-sync walks. A
 *  paused rule is included: its loads should be released too. */
export const listOrgRuleIds = internalQuery({
  args: { workosOrgId: v.string() },
  handler: async (ctx, args): Promise<Id<'routeAssignments'>[]> => {
    const rules = await ctx.db
      .query('routeAssignments')
      .withIndex('by_organization', (q) => q.eq('workosOrgId', args.workosOrgId))
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
      sweepAssigned: v.optional(v.number()),
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
 * Org-wide re-sync. Phase 0 releases robot-assigned loads that no rule
 * claims (pre-provenance leftovers — they would block everything placed
 * on their driver). Phase 1 releases every out-of-sync load under every
 * rule; phase 2 re-places them. Splitting the phases across rules is what
 * makes a driver exchange between two rules work: by the time anything is
 * re-placed, both drivers are free of the loads that are leaving them.
 * Phase 3 runs the ordinary sweep for the org, so loads released by an
 * EARLIER run and refused then (the blocker was still there) are placed
 * now instead of waiting up to an hour. One summary lands on
 * autoAssignmentSettings for the page banner; each rule still gets its
 * own record.
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
  ): Promise<{ rules: number; considered: number; moved: number; held: number; sweepAssigned: number }> => {
    const ruleIds = await ctx.runQuery(internal.routeRotation.listOrgRuleIds, {
      workosOrgId: args.workosOrgId,
    });
    const actor = { userId: args.userId, userName: args.userName };

    // Phase 0 — unclaimed robot loads. Released and left Open (nothing
    // claims them, so there is nothing to re-place them under); counted
    // in the org summary so the banner says they were cleared.
    const unclaimedIds = await ctx.runQuery(internal.routeRotation.listUnclaimedRobotLoads, {
      workosOrgId: args.workosOrgId,
    });
    let unclaimedReleased = 0;
    for (const loadId of unclaimedIds) {
      try {
        const r = await ctx.runMutation(internal.routeRotation.releaseUnclaimedOne, { loadId, ...actor });
        if (r.released) {
          unclaimedReleased++;
          console.log(`[rotation]   released unclaimed #${r.orderNumber} on ${r.serviceDate}: no rule claims it`);
        }
      } catch (err) {
        console.error(`[rotation] org ${args.workosOrgId}: release of unclaimed ${loadId} failed:`, err);
      }
    }

    // Phase 1 — release, every rule.
    const perRule = new Map<Id<'routeAssignments'>, { released: Released[]; holds: HeldLoad[] }>();
    for (const routeId of ruleIds) {
      try {
        perRule.set(routeId, await releasePhase(ctx, routeId, actor));
      } catch (err) {
        console.error(`[rotation] org ${args.workosOrgId}: rule ${routeId} release failed:`, err);
        perRule.set(routeId, { released: [], holds: [{ orderNumber: '—', reason: 'ERROR', detail: String(err) }] });
      }
    }

    // Phase 2 — re-place, then record per rule. A load may land under a
    // DIFFERENT rule now (a day change hands it to whichever rule covers
    // that day); it is still counted for the rule that released it, since
    // that is the change the user made.
    const byReason = new Map<string, number>();
    let considered = unclaimedReleased;
    let moved = 0;
    let held = unclaimedReleased;
    if (unclaimedReleased > 0) byReason.set('UNCLAIMED_RELEASED', unclaimedReleased);
    for (const [routeId, phase] of perRule) {
      const { moved: m, open } = await replacePhase(ctx, phase.released, actor);
      const outcome = summarize(m, [...phase.holds, ...open]);
      await record(ctx, routeId, outcome);
      considered += outcome.considered;
      moved += outcome.moved;
      held += outcome.held;
      for (const { reason, count } of outcome.byReason) {
        byReason.set(reason, (byReason.get(reason) ?? 0) + count);
      }
    }

    // Phase 3 — the ordinary sweep, now. Anything Open and due (released
    // by this run or an earlier one) gets the assignment decision again
    // with the blockers gone. Respects the horizon and every other rule
    // the hourly sweep does; a load not due yet stays Open until it is.
    let sweepAssigned = 0;
    try {
      const sweep = await ctx.runAction(internal.autoAssignment.autoAssignPendingLoads, {
        workosOrgId: args.workosOrgId,
      });
      sweepAssigned = sweep.assigned;
      console.log(
        `[rotation] org ${args.workosOrgId}: closing sweep checked ${sweep.processed}, assigned ${sweep.assigned}`,
      );
    } catch (err) {
      console.error(`[rotation] org ${args.workosOrgId}: closing sweep failed:`, err);
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
        sweepAssigned,
      },
    });

    console.log(
      `[rotation] org ${args.workosOrgId}: ${ruleIds.length} rules, ${moved} re-placed, ${held} not` +
        (unclaimedReleased > 0 ? ` (${unclaimedReleased} unclaimed released)` : '') +
        (sweepAssigned > 0 ? `, sweep assigned ${sweepAssigned}` : ''),
    );
    return { rules: ruleIds.length, considered, moved, held, sweepAssigned };
  },
});
