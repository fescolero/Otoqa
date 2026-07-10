import { v } from 'convex/values';
import { internalMutation, internalQuery } from '../_generated/server';
import { parseStopDateTime } from '../_helpers/timeUtils';
import { updateLoadCount } from '../stats_helpers';

/**
 * Diagnostic: find the N most recently-updated Expired loads in an org.
 * Use this to figure out when the bad cron actually fired before picking
 * a `since` timestamp for the revive run.
 *
 * Run:
 *   npx convex run migrations/013_revive_miscron_expired_loads:recentExpired \
 *     '{"workosOrgId":"org_..."}'
 */
/**
 * Diagnostic: audit log + first stop for a load by orderNumber. Shows
 * every status transition recorded against this load so we can see
 * whether/when the cron expired it.
 *
 * Run:
 *   npx convex run migrations/013_revive_miscron_expired_loads:auditByOrderNumber \
 *     '{"workosOrgId":"org_...","orderNumber":"110766808"}'
 */
export const auditByOrderNumber = internalQuery({
  args: { workosOrgId: v.string(), orderNumber: v.string() },
  handler: async (ctx, args) => {
    const load = await ctx.db
      .query('loadInformation')
      .withIndex('by_order_number', (q) =>
        q.eq('workosOrgId', args.workosOrgId).eq('orderNumber', args.orderNumber),
      )
      .first();
    if (!load) return { found: false };

    // Audit log entries — schema uses 'load' for entityType per the
    // comment in schema.ts, but query both spellings just in case.
    const [aLoad, aLoadInfo] = await Promise.all([
      ctx.db
        .query('auditLog')
        .withIndex('by_org_entity', (q: any) =>
          q.eq('organizationId', args.workosOrgId).eq('entityType', 'load').eq('entityId', load._id),
        )
        .order('desc')
        .take(50),
      ctx.db
        .query('auditLog')
        .withIndex('by_org_entity', (q: any) =>
          q.eq('organizationId', args.workosOrgId).eq('entityType', 'loadInformation').eq('entityId', load._id),
        )
        .order('desc')
        .take(50),
    ]);
    const auditEntries = [...aLoad, ...aLoadInfo].sort((a, b) => b.timestamp - a.timestamp);

    return {
      found: true,
      loadId: load._id,
      currentStatus: load.status,
      currentTrackingStatus: load.trackingStatus,
      updatedAtIso: new Date(load.updatedAt).toISOString(),
      auditCount: auditEntries.length,
      audit: auditEntries.slice(0, 30).map((a) => ({
        tsIso: new Date(a.timestamp).toISOString(),
        action: a.action,
        description: a.description,
        performedBy: a.performedBy,
        performedByName: a.performedByName,
        changedFields: a.changedFields,
        changesBefore: a.changesBefore,
        changesAfter: a.changesAfter,
      })),
    };
  },
});

/**
 * Diagnostic: fetch a single load by orderNumber along with its first stop
 * and the parsed pickup timestamp. Useful for investigating why a specific
 * load got expired prematurely.
 *
 * Run:
 *   npx convex run migrations/013_revive_miscron_expired_loads:inspectByOrderNumber \
 *     '{"workosOrgId":"org_...","orderNumber":"110766808"}'
 */
export const inspectByOrderNumber = internalQuery({
  args: { workosOrgId: v.string(), orderNumber: v.string() },
  handler: async (ctx, args) => {
    const load = await ctx.db
      .query('loadInformation')
      .withIndex('by_order_number', (q) =>
        q.eq('workosOrgId', args.workosOrgId).eq('orderNumber', args.orderNumber),
      )
      .first();
    if (!load) return { found: false };

    const stops = await ctx.db
      .query('loadStops')
      .withIndex('by_load', (q) => q.eq('loadId', load._id))
      .collect();
    stops.sort((a, b) => a.sequenceNumber - b.sequenceNumber);

    const firstStop = stops[0];
    const pickupTs = firstStop
      ? parseStopDateTime(firstStop.windowBeginDate, firstStop.windowBeginTime)
      : null;
    const now = Date.now();

    return {
      found: true,
      load: {
        _id: load._id,
        internalId: load.internalId,
        orderNumber: load.orderNumber,
        status: load.status,
        trackingStatus: load.trackingStatus,
        firstStopDate: load.firstStopDate,
        primaryDriverId: load.primaryDriverId,
        primaryCarrierPartnershipId: load.primaryCarrierPartnershipId,
        createdAt: load.createdAt,
        createdAtIso: new Date(load.createdAt).toISOString(),
        updatedAt: load.updatedAt,
        updatedAtIso: new Date(load.updatedAt).toISOString(),
      },
      firstStop: firstStop
        ? {
            _id: firstStop._id,
            sequenceNumber: firstStop.sequenceNumber,
            stopType: firstStop.stopType,
            windowBeginDate: firstStop.windowBeginDate,
            windowBeginTime: firstStop.windowBeginTime,
            windowEndDate: firstStop.windowEndDate,
            windowEndTime: firstStop.windowEndTime,
            timeZone: firstStop.timeZone,
          }
        : null,
      stopsCount: stops.length,
      pickupTs,
      pickupTsIso: pickupTs ? new Date(pickupTs).toISOString() : null,
      now,
      nowIso: new Date(now).toISOString(),
      idleMs: now - load.updatedAt,
      idleHours: (now - load.updatedAt) / 3_600_000,
      pickupVsUpdatedAtMs: pickupTs ? pickupTs - load.updatedAt : null,
      pickupHasArrived: pickupTs !== null ? now >= pickupTs : null,
    };
  },
});

export const recentExpired = internalQuery({
  args: {
    workosOrgId: v.string(),
    limit: v.optional(v.number()),
    /**
     * Optional pickup date filter (YYYY-MM-DD). When provided we use the
     * by_org_first_stop_date index — small result set, no 16MB overflow.
     */
    firstStopDate: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    const limit = args.limit ?? 10;
    let all;
    if (args.firstStopDate) {
      all = await ctx.db
        .query('loadInformation')
        .withIndex('by_org_first_stop_date', (q) =>
          q.eq('workosOrgId', args.workosOrgId).eq('firstStopDate', args.firstStopDate),
        )
        .collect();
      all = all.filter((l) => l.status === 'Expired');
    } else {
      all = await ctx.db
        .query('loadInformation')
        .withIndex('by_status', (q) =>
          q.eq('workosOrgId', args.workosOrgId).eq('status', 'Expired'),
        )
        .collect();
    }
    const sorted = all
      .filter((l) => typeof l.updatedAt === 'number')
      .sort((a, b) => b.updatedAt - a.updatedAt)
      .slice(0, limit);
    const out = [];
    for (const load of sorted) {
      const firstStop = await ctx.db
        .query('loadStops')
        .withIndex('by_sequence', (q) =>
          q.eq('loadId', load._id).eq('sequenceNumber', 1),
        )
        .first();
      const pickupTs = firstStop
        ? parseStopDateTime(firstStop.windowBeginDate, firstStop.windowBeginTime)
        : null;
      out.push({
        loadId: load._id,
        internalId: load.internalId,
        orderNumber: load.orderNumber,
        status: load.status,
        trackingStatus: load.trackingStatus,
        updatedAt: load.updatedAt,
        updatedAtIso: new Date(load.updatedAt).toISOString(),
        firstStopDate: load.firstStopDate,
        windowBeginDate: firstStop?.windowBeginDate,
        windowBeginTime: firstStop?.windowBeginTime,
        pickupTs,
        pickupTsIso: pickupTs ? new Date(pickupTs).toISOString() : null,
        pickupAfterExpire: pickupTs !== null && pickupTs > load.updatedAt,
      });
    }
    return { totalExpired: all.length, sample: out };
  },
});

/**
 * One-off revival for loads that the auto-expire cron incorrectly pushed to
 * Expired before their scheduled pickup time actually arrived.
 *
 * Background: prior to the time-of-day fix in autoExpireStaleLoads (see
 * convex/loads.ts), Phase 1 compared firstStopDate as a YYYY-MM-DD calendar
 * date. A load with pickup at 09:30 today and firstStopDate === todayStr
 * passed the gate, and if it had been idle for >= 6h (e.g. created
 * yesterday afternoon) the cron expired it before pickup.
 *
 * This migration finds loads that:
 *   - status === 'Expired'
 *   - trackingStatus === 'Canceled' (the Expired branch sets this)
 *   - updatedAt within [since, until] (the bad cron run's time window)
 *   - The scheduled pickup time (from loadStops sequenceNumber=1) is AFTER
 *     updatedAt — i.e. we expired the load BEFORE its pickup. This is the
 *     fingerprint of a miscron, not a legitimate expiration.
 *
 * Revival steps per affected load:
 *   1. Patch loadInformation:
 *        status -> 'Assigned' if primaryDriverId OR primaryCarrierPartnershipId
 *                  is still set on the load, otherwise 'Open'
 *        trackingStatus -> 'Pending'
 *        updatedAt -> now
 *   2. For dispatchLegs on the load with
 *        status === 'CANCELED' AND endReason === 'data_hygiene' AND
 *        endedAt in [since, until]
 *      restore:
 *        status -> 'PENDING' (Phase 1 only operates on Pending tracking, so
 *                             legs were necessarily PENDING before the cron
 *                             cascade ran)
 *        endReason -> undefined
 *        endedAt -> undefined
 *        updatedAt -> now
 *   3. Bump the org's load-count stats.
 *
 * Caveat — payables cannot be auto-restored. The Expired branch deletes
 * unlocked SYSTEM-sourced loadPayables. Those need to be recomputed by the
 * pay engine after revival; this migration does NOT trigger recompute.
 *
 * Run:
 *   npx convex run migrations/013_revive_miscron_expired_loads:run \
 *     '{"workosOrgId":"org_...","since":1748304000000,"dryRun":true}'
 *   # review counts, then:
 *   npx convex run migrations/013_revive_miscron_expired_loads:run \
 *     '{"workosOrgId":"org_...","since":1748304000000,"dryRun":false}'
 *
 * `since` is a Unix ms timestamp — pass the wall-clock time when the bad
 * cron started (or earlier to be safe). `until` defaults to now.
 *
 * Paginated to stay under the per-function read/write ceiling.
 */

const BATCH_SIZE = 100;

type Counts = {
  scanned: number;
  revivedLoads: number;
  revivedLegs: number;
  skipped: {
    notTouchedInWindow: number;
    noPickupStop: number;
    pickupAlreadyPast: number;
    pickupTimeUnparseable: number;
    trackingStatusNotCanceled: number;
  };
};

function emptyCounts(): Counts {
  return {
    scanned: 0,
    revivedLoads: 0,
    revivedLegs: 0,
    skipped: {
      notTouchedInWindow: 0,
      noPickupStop: 0,
      pickupAlreadyPast: 0,
      pickupTimeUnparseable: 0,
      trackingStatusNotCanceled: 0,
    },
  };
}

export const run = internalMutation({
  args: {
    workosOrgId: v.string(),
    since: v.number(),
    until: v.optional(v.number()),
    dryRun: v.boolean(),
    cursor: v.optional(v.string()),
  },
  returns: v.object({
    counts: v.object({
      scanned: v.number(),
      revivedLoads: v.number(),
      revivedLegs: v.number(),
      skipped: v.object({
        notTouchedInWindow: v.number(),
        noPickupStop: v.number(),
        pickupAlreadyPast: v.number(),
        pickupTimeUnparseable: v.number(),
        trackingStatusNotCanceled: v.number(),
      }),
    }),
    nextCursor: v.union(v.string(), v.null()),
    isDone: v.boolean(),
  }),
  handler: async (ctx, args) => {
    const now = Date.now();
    const until = args.until ?? now;
    const counts = emptyCounts();

    const page = await ctx.db
      .query('loadInformation')
      .withIndex('by_status', (q) =>
        q.eq('workosOrgId', args.workosOrgId).eq('status', 'Expired'),
      )
      .paginate({ cursor: args.cursor ?? null, numItems: BATCH_SIZE });

    for (const load of page.page) {
      counts.scanned++;

      // The Expired branch sets trackingStatus -> 'Canceled'. If something
      // else flipped it afterward, this load isn't a clean miscron target.
      if (load.trackingStatus !== 'Canceled') {
        counts.skipped.trackingStatusNotCanceled++;
        continue;
      }

      if (!load.updatedAt || load.updatedAt < args.since || load.updatedAt > until) {
        counts.skipped.notTouchedInWindow++;
        continue;
      }

      const firstStop = await ctx.db
        .query('loadStops')
        .withIndex('by_sequence', (q) =>
          q.eq('loadId', load._id).eq('sequenceNumber', 1),
        )
        .first();
      if (!firstStop) {
        counts.skipped.noPickupStop++;
        continue;
      }

      const pickupTs = parseStopDateTime(firstStop.windowBeginDate, firstStop.windowBeginTime);
      if (pickupTs === null) {
        counts.skipped.pickupTimeUnparseable++;
        continue;
      }

      // Was the pickup actually still in the future when the cron killed it?
      // If pickup was already past at expire time, this was a legitimate
      // expiration (or at least not a victim of the time-of-day bug) — leave
      // it alone.
      if (pickupTs <= load.updatedAt) {
        counts.skipped.pickupAlreadyPast++;
        continue;
      }

      // ---- Revive ----
      const restoredStatus: 'Open' | 'Assigned' =
        load.primaryDriverId || load.primaryCarrierPartnershipId ? 'Assigned' : 'Open';

      if (!args.dryRun) {
        await ctx.db.patch(load._id, {
          status: restoredStatus,
          trackingStatus: 'Pending',
          updatedAt: now,
        });
        await updateLoadCount(ctx, load.workosOrgId, 'Expired', restoredStatus);
      }
      counts.revivedLoads++;

      // Restore the legs that the Expired cascade canceled in the same window.
      const legs = await ctx.db
        .query('dispatchLegs')
        .withIndex('by_load', (q) => q.eq('loadId', load._id))
        .collect();

      for (const leg of legs) {
        if (leg.status !== 'CANCELED') continue;
        if (leg.endReason !== 'data_hygiene') continue;
        if (!leg.endedAt || leg.endedAt < args.since || leg.endedAt > until) continue;

        if (!args.dryRun) {
          await ctx.db.patch(leg._id, {
            status: 'PENDING',
            endReason: undefined,
            endedAt: undefined,
            updatedAt: now,
          });
        }
        counts.revivedLegs++;
      }
    }

    return {
      counts,
      nextCursor: page.isDone ? null : page.continueCursor,
      isDone: page.isDone,
    };
  },
});

/**
 * Revive miscron-expired loads scoped to a single pickup date (firstStopDate).
 * Uses the by_org_first_stop_date index so the scan is tiny.
 *
 * A load is treated as a miscron victim when it was expired LESS THAN
 * `STALE_PENDING_THRESHOLD_MS` (6h) after — or any time before — its
 * scheduled pickup. The correct cron rule requires at least 6h past
 * pickup before considering a Pending load expired, so anything
 * expired sooner than that is a victim of one of the prior buggy
 * implementations (date-only gate OR updatedAt-as-idleness gate).
 *
 * Run:
 *   npx convex run migrations/013_revive_miscron_expired_loads:runByPickupDate \
 *     '{"workosOrgId":"org_...","firstStopDate":"2026-05-29","dryRun":true}'
 */
const STALE_PENDING_THRESHOLD_MS = 6 * 60 * 60 * 1000;

export const runByPickupDate = internalMutation({
  args: {
    workosOrgId: v.string(),
    firstStopDate: v.string(),
    dryRun: v.boolean(),
    /** Optional updatedAt lower bound (default: 0 — accept any). */
    since: v.optional(v.number()),
    /** Optional updatedAt upper bound (default: now). */
    until: v.optional(v.number()),
  },
  returns: v.object({
    counts: v.object({
      scanned: v.number(),
      revivedLoads: v.number(),
      revivedLegs: v.number(),
      skipped: v.object({
        notTouchedInWindow: v.number(),
        noPickupStop: v.number(),
        pickupAlreadyPast: v.number(),
        pickupTimeUnparseable: v.number(),
        trackingStatusNotCanceled: v.number(),
        statusNotExpired: v.number(),
      }),
    }),
  }),
  handler: async (ctx, args) => {
    const now = Date.now();
    const since = args.since ?? 0;
    const until = args.until ?? now;
    const counts = {
      scanned: 0,
      revivedLoads: 0,
      revivedLegs: 0,
      skipped: {
        notTouchedInWindow: 0,
        noPickupStop: 0,
        pickupAlreadyPast: 0,
        pickupTimeUnparseable: 0,
        trackingStatusNotCanceled: 0,
        statusNotExpired: 0,
      },
    };

    const loads = await ctx.db
      .query('loadInformation')
      .withIndex('by_org_first_stop_date', (q) =>
        q.eq('workosOrgId', args.workosOrgId).eq('firstStopDate', args.firstStopDate),
      )
      .collect();

    for (const load of loads) {
      counts.scanned++;

      if (load.status !== 'Expired') {
        counts.skipped.statusNotExpired++;
        continue;
      }
      if (load.trackingStatus !== 'Canceled') {
        counts.skipped.trackingStatusNotCanceled++;
        continue;
      }
      if (!load.updatedAt || load.updatedAt < since || load.updatedAt > until) {
        counts.skipped.notTouchedInWindow++;
        continue;
      }

      const firstStop = await ctx.db
        .query('loadStops')
        .withIndex('by_sequence', (q) =>
          q.eq('loadId', load._id).eq('sequenceNumber', 1),
        )
        .first();
      if (!firstStop) {
        counts.skipped.noPickupStop++;
        continue;
      }

      const pickupTs = parseStopDateTime(firstStop.windowBeginDate, firstStop.windowBeginTime);
      if (pickupTs === null) {
        counts.skipped.pickupTimeUnparseable++;
        continue;
      }
      // Miscron criterion: expiration happened LESS than 6h after pickup
      // (or before pickup). A legitimate expiration would require at least
      // 6h past pickup with no transition to In Transit.
      if (load.updatedAt - pickupTs >= STALE_PENDING_THRESHOLD_MS) {
        counts.skipped.pickupAlreadyPast++;
        continue;
      }

      const restoredStatus: 'Open' | 'Assigned' =
        load.primaryDriverId || load.primaryCarrierPartnershipId ? 'Assigned' : 'Open';

      if (!args.dryRun) {
        await ctx.db.patch(load._id, {
          status: restoredStatus,
          trackingStatus: 'Pending',
          updatedAt: now,
        });
        await updateLoadCount(ctx, load.workosOrgId, 'Expired', restoredStatus);
      }
      counts.revivedLoads++;

      const legs = await ctx.db
        .query('dispatchLegs')
        .withIndex('by_load', (q) => q.eq('loadId', load._id))
        .collect();

      for (const leg of legs) {
        if (leg.status !== 'CANCELED') continue;
        if (leg.endReason !== 'data_hygiene') continue;
        if (!leg.endedAt || leg.endedAt < since || leg.endedAt > until) continue;

        if (!args.dryRun) {
          await ctx.db.patch(leg._id, {
            status: 'PENDING',
            endReason: undefined,
            endedAt: undefined,
            updatedAt: now,
          });
        }
        counts.revivedLegs++;
      }
    }

    return { counts };
  },
});
