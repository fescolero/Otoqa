import { v } from 'convex/values';
import {
  internalAction,
  internalMutation,
} from '../_generated/server';
import { internal } from '../_generated/api';
import type { FunctionReference } from 'convex/server';

/**
 * Phase 3a cleanup: close out the ~3,100 PENDING dispatchLegs that are
 * stuck because nothing cascaded when their parent load reached a terminal
 * state (Expired, Completed, or was deleted) or when their driver was
 * deleted. Output of migration 011 (diagnose) informs the criteria here.
 *
 * Rules (applied to legs where status === 'PENDING'):
 *   1. Parent load status === 'Expired' → leg.status = 'CANCELED',
 *      endReason = 'data_hygiene', endedAt = now.
 *   2. Parent load status === 'Completed' → leg.status = 'COMPLETED',
 *      endReason = 'completed', endedAt = parentLoad.updatedAt.
 *   3. Parent load deleted / missing → leg.status = 'CANCELED',
 *      endReason = 'data_hygiene', endedAt = now.
 *   4. Parent load still active (Open/Assigned) AND leg.driverId points
 *      to a deleted driver → clear driverId/truckId/trailerId. Leg stays
 *      PENDING so it can be reassigned.
 *
 * Rule precedence: 1–3 take priority over 4. A leg on an Expired load
 * with a deleted driver is cancelled by rule 1, not unassigned by rule 4.
 *
 * Dry-run mode returns the same counts without writing. Always run dryRun
 * first and compare to migration 011's cleanupCandidates output.
 *
 * Paginated via the 010/011 pattern to stay under the 4096-read/write
 * limit per function execution.
 *
 * Run:
 *   npx convex run migrations/012_cleanup_orphaned_pending_legs:run \
 *     '{"workosOrgId":"org_...","dryRun":true}'
 *   # review counts, then:
 *   npx convex run migrations/012_cleanup_orphaned_pending_legs:run \
 *     '{"workosOrgId":"org_...","dryRun":false}'
 */

const BATCH_SIZE = 100;

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const self: any = (internal as any)['migrations/012_cleanup_orphaned_pending_legs'];
type _Ref = FunctionReference<'action' | 'mutation', 'internal'>;
void (null as unknown as _Ref);

type Counts = {
  scanned: number;
  pending: number;
  cancelled_expiredLoad: number;
  completed_completedLoad: number;
  cancelled_missingLoad: number;
  unassigned_deletedDriver: number;
  untouched: number;
};

function emptyCounts(): Counts {
  return {
    scanned: 0,
    pending: 0,
    cancelled_expiredLoad: 0,
    completed_completedLoad: 0,
    cancelled_missingLoad: 0,
    unassigned_deletedDriver: 0,
    untouched: 0,
  };
}

function merge(acc: Counts, next: Counts) {
  acc.scanned += next.scanned;
  acc.pending += next.pending;
  acc.cancelled_expiredLoad += next.cancelled_expiredLoad;
  acc.completed_completedLoad += next.completed_completedLoad;
  acc.cancelled_missingLoad += next.cancelled_missingLoad;
  acc.unassigned_deletedDriver += next.unassigned_deletedDriver;
  acc.untouched += next.untouched;
}

export const batch = internalMutation({
  args: {
    workosOrgId: v.string(),
    cursor: v.optional(v.string()),
    dryRun: v.boolean(),
    nowMs: v.number(),
  },
  handler: async (ctx, args) => {
    const result = await ctx.db
      .query('dispatchLegs')
      .withIndex('by_org', (q) => q.eq('workosOrgId', args.workosOrgId))
      .paginate({ cursor: args.cursor ?? null, numItems: BATCH_SIZE });

    const counts = emptyCounts();
    const now = args.nowMs;

    for (const leg of result.page) {
      counts.scanned++;
      if (leg.status !== 'PENDING') continue;
      counts.pending++;

      const load = await ctx.db.get(leg.loadId);

      // Rule 3: parent load missing — CANCEL with data_hygiene.
      if (!load) {
        if (!args.dryRun) {
          await ctx.db.patch(leg._id, {
            status: 'CANCELED',
            endReason: 'data_hygiene',
            endedAt: now,
            updatedAt: now,
          });
        }
        counts.cancelled_missingLoad++;
        continue;
      }

      // Rule 1: parent load Expired — CANCEL with data_hygiene.
      if (load.status === 'Expired') {
        if (!args.dryRun) {
          await ctx.db.patch(leg._id, {
            status: 'CANCELED',
            endReason: 'data_hygiene',
            endedAt: now,
            updatedAt: now,
          });
        }
        counts.cancelled_expiredLoad++;
        continue;
      }

      // Rule 2: parent load Completed — mark leg COMPLETED matching parent.
      if (load.status === 'Completed') {
        if (!args.dryRun) {
          await ctx.db.patch(leg._id, {
            status: 'COMPLETED',
            endReason: 'completed',
            endedAt: load.updatedAt,
            updatedAt: now,
          });
        }
        counts.completed_completedLoad++;
        continue;
      }

      // Rule 4: parent load active, driver is deleted — unassign.
      if (leg.driverId) {
        const driver = await ctx.db.get(leg.driverId);
        if (driver && driver.isDeleted) {
          if (!args.dryRun) {
            await ctx.db.patch(leg._id, {
              driverId: undefined,
              truckId: undefined,
              trailerId: undefined,
              updatedAt: now,
            });
          }
          counts.unassigned_deletedDriver++;
          continue;
        }
      }

      counts.untouched++;
    }

    return {
      counts,
      isDone: result.isDone,
      nextCursor: result.isDone ? null : result.continueCursor,
    };
  },
});

export const run = internalAction({
  args: {
    workosOrgId: v.string(),
    dryRun: v.boolean(),
  },
  handler: async (ctx, args): Promise<Counts> => {
    const acc = emptyCounts();
    let cursor: string | null = null;
    let iterations = 0;
    const MAX_ITERATIONS = 20_000;
    const now = Date.now();

    while (iterations < MAX_ITERATIONS) {
      iterations++;
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const page: any = await ctx.runMutation(self.batch, {
        workosOrgId: args.workosOrgId,
        cursor: cursor ?? undefined,
        dryRun: args.dryRun,
        nowMs: now,
      });
      merge(acc, page.counts);
      if (page.isDone) break;
      cursor = page.nextCursor;
    }

    console.log(
      `[cleanupOrphanedPendingLegs] org=${args.workosOrgId} dryRun=${args.dryRun} ${JSON.stringify(acc)}`,
    );
    return acc;
  },
});
