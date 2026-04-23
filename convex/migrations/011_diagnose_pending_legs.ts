import { v } from 'convex/values';
import {
  internalAction,
  internalQuery,
} from '../_generated/server';
import { internal } from '../_generated/api';
import type { FunctionReference } from 'convex/server';

/**
 * Diagnostic: bucket PENDING dispatchLegs so we can size data-hygiene
 * cleanup for a given org before writing any destructive mutation.
 *
 * Paginated to stay under the 4096-read per-function limit on orgs with
 * thousands of pending legs. Read-only — no mutations.
 *
 * Buckets reported:
 *   - byParentLoadStatus      → legs whose parent load is in each Load.status
 *   - byParentLoadMissing     → legs whose parent load was deleted
 *   - byLegAgeDays            → buckets of days-since-createdAt
 *   - byScheduledStartBucket  → past / next7d / next30d / next90d / later / undefined
 *   - byDriverState           → activeDriver / inactiveDriver / deletedDriver / missingDriver / noDriver
 *
 * Legs counted in multiple buckets (e.g. "parent load Canceled" AND
 * "scheduled in past") appear in both. Totals are the distinct PENDING
 * leg count.
 *
 * Run:
 *   npx convex run migrations/011_diagnose_pending_legs:run '{"workosOrgId":"org_..."}'
 */

const BATCH_SIZE = 100;

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const self: any = (internal as any)['migrations/011_diagnose_pending_legs'];
type _Ref = FunctionReference<'action' | 'query', 'internal'>;
void (null as unknown as _Ref);

const DAY_MS = 24 * 60 * 60 * 1000;

type Buckets = {
  totalPendingLegs: number;
  byParentLoadStatus: Record<string, number>;
  byParentLoadMissing: number;
  byLegAgeDays: {
    under30: number;
    days30to90: number;
    days90to180: number;
    over180: number;
  };
  byScheduledStartBucket: {
    past: number;
    next7d: number;
    next30d: number;
    next90d: number;
    later: number;
    undefinedOrInvalid: number;
  };
  byDriverState: {
    activeDriver: number;
    inactiveDriver: number;
    deletedDriver: number;
    missingDriver: number;
    noDriver: number;
  };
  // Cleanup-candidate tallies (overlap with buckets above).
  cleanupCandidates: {
    parentLoadCanceled: number;
    parentLoadCompleted: number;
    parentLoadExpired: number;
    parentLoadMissing: number;
    scheduledInPastOver14d: number;
    assignedToDeletedDriver: number;
  };
};

function emptyBuckets(): Buckets {
  return {
    totalPendingLegs: 0,
    byParentLoadStatus: {},
    byParentLoadMissing: 0,
    byLegAgeDays: { under30: 0, days30to90: 0, days90to180: 0, over180: 0 },
    byScheduledStartBucket: {
      past: 0,
      next7d: 0,
      next30d: 0,
      next90d: 0,
      later: 0,
      undefinedOrInvalid: 0,
    },
    byDriverState: {
      activeDriver: 0,
      inactiveDriver: 0,
      deletedDriver: 0,
      missingDriver: 0,
      noDriver: 0,
    },
    cleanupCandidates: {
      parentLoadCanceled: 0,
      parentLoadCompleted: 0,
      parentLoadExpired: 0,
      parentLoadMissing: 0,
      scheduledInPastOver14d: 0,
      assignedToDeletedDriver: 0,
    },
  };
}

function merge(acc: Buckets, next: Buckets) {
  acc.totalPendingLegs += next.totalPendingLegs;
  for (const [k, v] of Object.entries(next.byParentLoadStatus)) {
    acc.byParentLoadStatus[k] = (acc.byParentLoadStatus[k] ?? 0) + v;
  }
  acc.byParentLoadMissing += next.byParentLoadMissing;
  acc.byLegAgeDays.under30 += next.byLegAgeDays.under30;
  acc.byLegAgeDays.days30to90 += next.byLegAgeDays.days30to90;
  acc.byLegAgeDays.days90to180 += next.byLegAgeDays.days90to180;
  acc.byLegAgeDays.over180 += next.byLegAgeDays.over180;
  acc.byScheduledStartBucket.past += next.byScheduledStartBucket.past;
  acc.byScheduledStartBucket.next7d += next.byScheduledStartBucket.next7d;
  acc.byScheduledStartBucket.next30d += next.byScheduledStartBucket.next30d;
  acc.byScheduledStartBucket.next90d += next.byScheduledStartBucket.next90d;
  acc.byScheduledStartBucket.later += next.byScheduledStartBucket.later;
  acc.byScheduledStartBucket.undefinedOrInvalid += next.byScheduledStartBucket.undefinedOrInvalid;
  acc.byDriverState.activeDriver += next.byDriverState.activeDriver;
  acc.byDriverState.inactiveDriver += next.byDriverState.inactiveDriver;
  acc.byDriverState.deletedDriver += next.byDriverState.deletedDriver;
  acc.byDriverState.missingDriver += next.byDriverState.missingDriver;
  acc.byDriverState.noDriver += next.byDriverState.noDriver;
  acc.cleanupCandidates.parentLoadCanceled += next.cleanupCandidates.parentLoadCanceled;
  acc.cleanupCandidates.parentLoadCompleted += next.cleanupCandidates.parentLoadCompleted;
  acc.cleanupCandidates.parentLoadExpired += next.cleanupCandidates.parentLoadExpired;
  acc.cleanupCandidates.parentLoadMissing += next.cleanupCandidates.parentLoadMissing;
  acc.cleanupCandidates.scheduledInPastOver14d += next.cleanupCandidates.scheduledInPastOver14d;
  acc.cleanupCandidates.assignedToDeletedDriver += next.cleanupCandidates.assignedToDeletedDriver;
}

export const batch = internalQuery({
  args: {
    workosOrgId: v.string(),
    cursor: v.optional(v.string()),
    nowMs: v.number(),
  },
  handler: async (ctx, args) => {
    const result = await ctx.db
      .query('dispatchLegs')
      .withIndex('by_org', (q) => q.eq('workosOrgId', args.workosOrgId))
      .paginate({ cursor: args.cursor ?? null, numItems: BATCH_SIZE });

    const buckets = emptyBuckets();
    const now = args.nowMs;

    for (const leg of result.page) {
      if (leg.status !== 'PENDING') continue;
      buckets.totalPendingLegs++;

      // Parent load bucket
      const load = await ctx.db.get(leg.loadId);
      if (!load) {
        buckets.byParentLoadMissing++;
        buckets.cleanupCandidates.parentLoadMissing++;
      } else {
        const s = load.status;
        buckets.byParentLoadStatus[s] = (buckets.byParentLoadStatus[s] ?? 0) + 1;
        if (s === 'Canceled') buckets.cleanupCandidates.parentLoadCanceled++;
        if (s === 'Completed') buckets.cleanupCandidates.parentLoadCompleted++;
        if (s === 'Expired') buckets.cleanupCandidates.parentLoadExpired++;
      }

      // Age bucket
      const ageDays = (now - leg.createdAt) / DAY_MS;
      if (ageDays < 30) buckets.byLegAgeDays.under30++;
      else if (ageDays < 90) buckets.byLegAgeDays.days30to90++;
      else if (ageDays < 180) buckets.byLegAgeDays.days90to180++;
      else buckets.byLegAgeDays.over180++;

      // Scheduled-start bucket
      if (leg.scheduledStartMs === undefined) {
        buckets.byScheduledStartBucket.undefinedOrInvalid++;
      } else {
        const deltaDays = (leg.scheduledStartMs - now) / DAY_MS;
        if (deltaDays < 0) {
          buckets.byScheduledStartBucket.past++;
          if (deltaDays < -14) buckets.cleanupCandidates.scheduledInPastOver14d++;
        } else if (deltaDays < 7) buckets.byScheduledStartBucket.next7d++;
        else if (deltaDays < 30) buckets.byScheduledStartBucket.next30d++;
        else if (deltaDays < 90) buckets.byScheduledStartBucket.next90d++;
        else buckets.byScheduledStartBucket.later++;
      }

      // Driver-state bucket
      if (!leg.driverId) {
        buckets.byDriverState.noDriver++;
      } else {
        const driver = await ctx.db.get(leg.driverId);
        if (!driver) {
          buckets.byDriverState.missingDriver++;
        } else if (driver.isDeleted) {
          buckets.byDriverState.deletedDriver++;
          buckets.cleanupCandidates.assignedToDeletedDriver++;
        } else if (driver.employmentStatus === 'Active') {
          buckets.byDriverState.activeDriver++;
        } else {
          buckets.byDriverState.inactiveDriver++;
        }
      }
    }

    return {
      buckets,
      isDone: result.isDone,
      nextCursor: result.isDone ? null : result.continueCursor,
    };
  },
});

export const run = internalAction({
  args: { workosOrgId: v.string() },
  handler: async (ctx, args): Promise<Buckets> => {
    const acc = emptyBuckets();
    let cursor: string | null = null;
    let iterations = 0;
    const MAX_ITERATIONS = 20_000;
    const now = Date.now();

    while (iterations < MAX_ITERATIONS) {
      iterations++;
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const page: any = await ctx.runQuery(self.batch, {
        workosOrgId: args.workosOrgId,
        cursor: cursor ?? undefined,
        nowMs: now,
      });
      merge(acc, page.buckets);
      if (page.isDone) break;
      cursor = page.nextCursor;
    }

    console.log(
      `[diagnosePendingLegs] org=${args.workosOrgId} total=${acc.totalPendingLegs} cleanupCandidates=${JSON.stringify(acc.cleanupCandidates)}`,
    );
    return acc;
  },
});
