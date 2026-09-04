import { v } from 'convex/values';
import { internalAction, internalMutation } from '../_generated/server';
import { internal } from '../_generated/api';
import type { FunctionReference } from 'convex/server';
import { getLoadFacets } from '../lib/loadFacets';
import { matchRouteAssignment } from '../lib/routeMatch';

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
 * Run:
 *   npx convex run migrations/018_backfill_auto_assign_provenance:startBackfill
 *   npx convex run migrations/018_backfill_auto_assign_provenance:startBackfill '{"workosOrgId":"org_…"}'
 *   npx convex run migrations/018_backfill_auto_assign_provenance:startBackfill '{"dryRun":true}'
 */

const BATCH_SIZE = 50;

const SYSTEM_ACTORS = new Set(['system', 'fourkites-sync', 'recurring-generator']);
const SYSTEM_NAMES = new Set([
  'Auto-Assignment System',
  'Scheduled Auto-Assignment',
  'FourKites Sync',
  'FourKites Sync (Promotion)',
  'Recurring Load Generator',
]);

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
});

export const backfillBatch = internalMutation({
  args: {
    cursor: v.optional(v.string()),
    workosOrgId: v.optional(v.string()),
    dryRun: v.optional(v.boolean()),
  },
  returns: v.object({
    ...countsValidator.fields,
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

    const counts = { scanned: 0, stamped: 0, skippedHuman: 0, skippedNoAudit: 0, skippedNoRule: 0 };

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
      const latest = history.find(
        (row) =>
          row.action === 'driver_assigned' ||
          row.action === 'carrier_assigned' ||
          row.action === 'resource_unassigned' ||
          row.action === 'auto_assign_rotated',
      );
      if (!latest) {
        counts.skippedNoAudit++;
        continue;
      }
      const robot =
        (latest.action === 'driver_assigned' || latest.action === 'carrier_assigned') &&
        (SYSTEM_ACTORS.has(latest.performedBy) ||
          (latest.performedByName !== undefined && SYSTEM_NAMES.has(latest.performedByName)));
      if (!robot) {
        counts.skippedHuman++;
        continue;
      }

      const facets = await getLoadFacets(ctx, load._id);
      if (!facets.hcr) {
        counts.skippedNoRule++;
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
      isDone: result.isDone,
      nextCursor: result.isDone ? null : result.continueCursor,
    };
  },
});

export const startBackfill = internalAction({
  args: { workosOrgId: v.optional(v.string()), dryRun: v.optional(v.boolean()) },
  returns: countsValidator,
  handler: async (ctx, args) => {
    let cursor: string | null = null;
    const totals = { scanned: 0, stamped: 0, skippedHuman: 0, skippedNoAudit: 0, skippedNoRule: 0 };
    let iterations = 0;
    const MAX_ITERATIONS = 20_000;

    while (iterations < MAX_ITERATIONS) {
      iterations++;
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const batch: any = await ctx.runMutation(self.backfillBatch, {
        cursor: cursor ?? undefined,
        workosOrgId: args.workosOrgId,
        dryRun: args.dryRun,
      });
      totals.scanned += batch.scanned;
      totals.stamped += batch.stamped;
      totals.skippedHuman += batch.skippedHuman;
      totals.skippedNoAudit += batch.skippedNoAudit;
      totals.skippedNoRule += batch.skippedNoRule;
      if (batch.isDone) break;
      cursor = batch.nextCursor;
    }

    console.log(
      `[backfillAutoAssignProvenance]${args.dryRun ? ' DRY RUN' : ''} scanned=${totals.scanned} stamped=${totals.stamped} ` +
        `skippedHuman=${totals.skippedHuman} skippedNoAudit=${totals.skippedNoAudit} skippedNoRule=${totals.skippedNoRule}`,
    );
    return totals;
  },
});
