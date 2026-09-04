import { v } from 'convex/values';
import { internalAction, internalMutation } from '../_generated/server';
import { internal } from '../_generated/api';
import type { FunctionReference } from 'convex/server';
import { getLoadFacets } from '../lib/loadFacets';
import { matchRouteAssignment } from '../lib/routeMatch';
import { unassignLoadResources } from '../dispatchLegs';
import { serviceDateOf } from '../lib/assignHorizon';
import { ASSIGNMENT_ACTIONS, isRobotActor } from '../lib/robotActors';

/**
 * Migration: stamp `autoAssignedRouteId` / `autoAssignedAt` onto Assigned
 * loads the robot placed BEFORE provenance existed (see routeRotation.ts).
 *
 * Without this, a re-sync finds nothing to move for any load assigned
 * before the provenance change shipped — which, right after shipping, is
 * every load. The page then shows nothing out of sync and every rule
 * reports "0 moved", even though the loads are sitting on the previous
 * driver.
 *
 * Which loads count as the robot's is decided from the audit trail, not
 * guessed: the load's most recent assignment audit row must carry a
 * system actor. The auto-assignment paths write one of
 *   performedBy: 'system' | 'fourkites-sync' | 'recurring-generator'
 *   performedByName: 'Scheduled Auto-Assignment' | 'FourKites Sync' |
 *                    'FourKites Sync (Promotion)' | 'Recurring Load Generator'
 * A later human assignment (a dispatcher's `assignDriver`, description
 * "Assigned driver …") is the most recent row instead, so the load is left
 * alone. So is a load whose most recent row is an unassignment.
 *
 * Known gap, deliberate: a load created BY HAND and then auto-assigned on
 * creation carries the creator's own identity in that audit row (loads.ts
 * passes `createdBy` into the trigger), and is indistinguishable here
 * from a load the creator assigned directly. Those are skipped. FourKites
 * imports — the bulk of the volume — are covered.
 *
 * The owning rule is whatever rule matches the load's HCR / trip / service
 * date TODAY (lib/routeMatch.ts), not whatever matched at assignment
 * time. That is the rule a re-sync should move the load under.
 *
 * Idempotent: loads that already carry provenance are skipped. Scope to
 * one org with `workosOrgId` when rolling out gradually.
 *
 * `releaseUnclaimed`: a robot-assigned load that NO active rule claims
 * (listed under noRuleLoads) is sitting on a driver for no reason the
 * rules can state. If the answer is "nobody should hold it yet", this
 * returns it to Open — the same cascade a dispatcher's unassign runs
 * (legs cleared, system payables removed, audit row), but WITHOUT the
 * autoAssignOptOut flag, so a rule added later can claim it. Only
 * upcoming loads with no leg started are released; past or in-motion
 * ones are left alone and still listed. If the answer is instead "driver
 * X runs it", add that rule and re-run the backfill: the load is then
 * stamped and a re-sync moves it.
 *
 * Run:
 *   npx convex run migrations/018_backfill_auto_assign_provenance:startBackfill
 *   npx convex run migrations/018_backfill_auto_assign_provenance:startBackfill '{"workosOrgId":"org_…"}'
 *   npx convex run migrations/018_backfill_auto_assign_provenance:startBackfill '{"dryRun":true}'
 *   npx convex run migrations/018_backfill_auto_assign_provenance:startBackfill '{"releaseUnclaimed":true}'
 */

const BATCH_SIZE = 50;

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const self: any = (internal as any)['migrations/018_backfill_auto_assign_provenance'];
type _Ref = FunctionReference<'mutation' | 'action', 'internal'>;
void (null as unknown as _Ref);

const countsValidator = v.object({
  scanned: v.number(),
  stamped: v.number(),
  skippedHuman: v.number(),
  skippedNoAudit: v.number(),
  skippedNoRule: v.number(),
  released: v.number(),
});

/**
 * A robot-assigned load no active rule claims today. These are the ones a
 * re-sync cannot reach, so they are listed rather than just counted:
 *   NO_HCR      — the load carries no HCR facet
 *   NO_RULE     — no active rule for that HCR (or HCR + trip)
 *   CALENDAR    — a rule exists but its service days decline this date
 *   NO_DATE     — a day-restricted rule exists and the load has no date
 */
const noRuleLoadValidator = v.object({
  orderNumber: v.string(),
  hcr: v.optional(v.string()),
  trip: v.optional(v.string()),
  serviceDate: v.optional(v.string()),
  reason: v.string(),
  // With releaseUnclaimed: 'RELEASED', or why not ('PAST', 'IN_MOTION').
  outcome: v.optional(v.string()),
});
const MAX_LISTED = 200;

export const backfillBatch = internalMutation({
  args: {
    cursor: v.optional(v.string()),
    workosOrgId: v.optional(v.string()),
    dryRun: v.optional(v.boolean()),
    releaseUnclaimed: v.optional(v.boolean()),
  },
  returns: v.object({
    ...countsValidator.fields,
    noRuleLoads: v.array(noRuleLoadValidator),
    isDone: v.boolean(),
    nextCursor: v.union(v.string(), v.null()),
  }),
  handler: async (ctx, args) => {
    const result = args.workosOrgId
      ? await ctx.db
          .query('loadInformation')
          .withIndex('by_status', (q) => q.eq('workosOrgId', args.workosOrgId!).eq('status', 'Assigned'))
          .paginate({ cursor: args.cursor ?? null, numItems: BATCH_SIZE })
      : await ctx.db
          .query('loadInformation')
          .paginate({ cursor: args.cursor ?? null, numItems: BATCH_SIZE });

    const counts = { scanned: 0, stamped: 0, skippedHuman: 0, skippedNoAudit: 0, skippedNoRule: 0, released: 0 };
    const noRuleLoads: Array<{
      orderNumber: string;
      hcr?: string;
      trip?: string;
      serviceDate?: string;
      reason: string;
      outcome?: string;
    }> = [];
    const today = serviceDateOf(Date.now());

    // Return an unclaimed load to Open, if it is safe to: upcoming and not
    // started. Without the opt-out flag, so a rule added later can claim it.
    const release = async (
      load: (typeof result.page)[number],
      entry: (typeof noRuleLoads)[number],
    ) => {
      if (!args.releaseUnclaimed) return;
      if (!load.firstStopDate || load.firstStopDate < today) {
        entry.outcome = 'PAST';
        return;
      }
      const legs = await ctx.db
        .query('dispatchLegs')
        .withIndex('by_load', (q) => q.eq('loadId', load._id))
        .collect();
      if (legs.some((l) => l.status === 'ACTIVE' || l.status === 'COMPLETED')) {
        entry.outcome = 'IN_MOTION';
        return;
      }
      if (!args.dryRun) {
        await unassignLoadResources(
          ctx,
          load._id,
          { userId: 'system', userName: 'Provenance backfill' },
          'auto-assigned before service days existed; no active rule claims this load',
          false,
        );
      }
      entry.outcome = 'RELEASED';
      counts.released++;
    };

    for (const load of result.page) {
      if (load.status !== 'Assigned') continue;
      if (!load.primaryDriverId && !load.primaryCarrierPartnershipId) continue;
      if (load.autoAssignedRouteId !== undefined) continue;
      counts.scanned++;

      // Most recent assignment-shaped audit row decides who placed it.
      const history = await ctx.db
        .query('auditLog')
        .withIndex('by_org_entity', (q) =>
          q.eq('organizationId', load.workosOrgId).eq('entityType', 'load').eq('entityId', load._id),
        )
        .order('desc')
        .collect();
      const latest = history.find((row) => ASSIGNMENT_ACTIONS.has(row.action));
      if (!latest) {
        counts.skippedNoAudit++;
        continue;
      }
      const robot =
        (latest.action === 'driver_assigned' || latest.action === 'carrier_assigned') &&
        isRobotActor(latest);
      if (!robot) {
        counts.skippedHuman++;
        continue;
      }

      const facets = await getLoadFacets(ctx, load._id);
      if (!facets.hcr) {
        counts.skippedNoRule++;
        const entry = { orderNumber: load.orderNumber, serviceDate: load.firstStopDate, reason: 'NO_HCR' };
        noRuleLoads.push(entry);
        await release(load, entry);
        continue;
      }
      const match = await matchRouteAssignment(ctx, {
        workosOrgId: load.workosOrgId,
        hcr: facets.hcr,
        trip: facets.trip,
        serviceDate: load.firstStopDate,
      });
      if (!match.route) {
        counts.skippedNoRule++;
        const entry = {
          orderNumber: load.orderNumber,
          hcr: facets.hcr,
          trip: facets.trip,
          serviceDate: load.firstStopDate,
          reason:
            match.declinedBecause === 'CALENDAR'
              ? 'CALENDAR'
              : match.declinedBecause === 'NO_SERVICE_DATE'
                ? 'NO_DATE'
                : 'NO_RULE',
        };
        noRuleLoads.push(entry);
        await release(load, entry);
        continue;
      }

      if (!args.dryRun) {
        await ctx.db.patch(load._id, {
          autoAssignedRouteId: match.route._id,
          autoAssignedAt: latest.timestamp,
        });
      }
      counts.stamped++;
    }

    return {
      ...counts,
      noRuleLoads,
      isDone: result.isDone,
      nextCursor: result.isDone ? null : result.continueCursor,
    };
  },
});

export const startBackfill = internalAction({
  args: {
    workosOrgId: v.optional(v.string()),
    dryRun: v.optional(v.boolean()),
    releaseUnclaimed: v.optional(v.boolean()),
  },
  returns: v.object({ ...countsValidator.fields, noRuleLoads: v.array(noRuleLoadValidator) }),
  handler: async (ctx, args) => {
    let cursor: string | null = null;
    const totals = { scanned: 0, stamped: 0, skippedHuman: 0, skippedNoAudit: 0, skippedNoRule: 0, released: 0 };
    const noRuleLoads: Array<{
      orderNumber: string;
      hcr?: string;
      trip?: string;
      serviceDate?: string;
      reason: string;
      outcome?: string;
    }> = [];
    let iterations = 0;
    const MAX_ITERATIONS = 20_000;

    while (iterations < MAX_ITERATIONS) {
      iterations++;
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const batch: any = await ctx.runMutation(self.backfillBatch, {
        cursor: cursor ?? undefined,
        workosOrgId: args.workosOrgId,
        dryRun: args.dryRun,
        releaseUnclaimed: args.releaseUnclaimed,
      });
      totals.scanned += batch.scanned;
      totals.stamped += batch.stamped;
      totals.skippedHuman += batch.skippedHuman;
      totals.skippedNoAudit += batch.skippedNoAudit;
      totals.skippedNoRule += batch.skippedNoRule;
      totals.released += batch.released;
      for (const l of batch.noRuleLoads) {
        if (noRuleLoads.length < MAX_LISTED) noRuleLoads.push(l);
      }
      if (batch.isDone) break;
      cursor = batch.nextCursor;
    }

    console.log(
      `[backfillAutoAssignProvenance]${args.dryRun ? ' DRY RUN' : ''} scanned=${totals.scanned} stamped=${totals.stamped} ` +
        `skippedHuman=${totals.skippedHuman} skippedNoAudit=${totals.skippedNoAudit} skippedNoRule=${totals.skippedNoRule}` +
        (args.releaseUnclaimed ? ` released=${totals.released}` : ''),
    );
    // One line per unclaimed load so the list is readable in the CLI and
    // in the Convex logs, sorted by HCR / trip / date.
    noRuleLoads.sort((a, b) =>
      `${a.hcr ?? ''}|${a.trip ?? ''}|${a.serviceDate ?? ''}`.localeCompare(
        `${b.hcr ?? ''}|${b.trip ?? ''}|${b.serviceDate ?? ''}`,
      ),
    );
    for (const l of noRuleLoads) {
      console.log(
        `[backfillAutoAssignProvenance] no rule: ${l.orderNumber} HCR ${l.hcr ?? '—'}` +
          `${l.trip ? ` / Trip ${l.trip}` : ''} on ${l.serviceDate ?? 'no date'} — ${l.reason}` +
          (l.outcome ? ` → ${l.outcome}` : ''),
      );
    }
    return { ...totals, noRuleLoads };
  },
});
