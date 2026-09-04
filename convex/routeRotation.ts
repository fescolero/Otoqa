import { v } from 'convex/values';
import { internalAction, internalMutation, internalQuery } from './_generated/server';
import type { ActionCtx, MutationCtx, QueryCtx } from './_generated/server';
import { internal } from './_generated/api';
import type { Doc, Id } from './_generated/dataModel';
import { routeServesDate } from './lib/routeMatch';
import { serviceDateOf } from './lib/assignHorizon';
import { unassignLoadResources } from './dispatchLegs';

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
  const heldLoads = [...holds].sort((a, b) => (a.serviceDate ?? '').localeCompare(b.serviceDate ?? ''));
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
  console.log(
    `[rotation] rule ${routeId}: ${outcome.moved} re-placed, ${outcome.held} not` +
      (outcome.held > 0 ? ` (${outcome.byReason.map((r) => `${r.reason} ${r.count}`).join(', ')})` : ''),
  );
  for (const h of outcome.heldLoads) {
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
 * Org-wide re-sync. Phase 1 releases every out-of-sync load under every
 * rule; phase 2 re-places them. Splitting the phases across rules is what
 * makes a driver exchange between two rules work: by the time anything is
 * re-placed, both drivers are free of the loads that are leaving them.
 * One summary lands on autoAssignmentSettings for the page banner; each
 * rule still gets its own record.
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
    const actor = { userId: args.userId, userName: args.userName };

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
    let considered = 0;
    let moved = 0;
    let held = 0;
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
      `[rotation] org ${args.workosOrgId}: ${ruleIds.length} rules, ${moved} re-placed, ${held} not`,
    );
    return { rules: ruleIds.length, considered, moved, held };
  },
});
