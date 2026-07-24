import { v } from 'convex/values';
import { internalMutation } from './_generated/server';
import { internal } from './_generated/api';

/**
 * One-time backfill: normalize legacy audit-log spellings to the canonical
 * vocabulary in `lib/audit.ts`.
 *
 * Rows written before the logAudit refactor carry `entityType: 'LOAD'` and
 * UPPER_CASE / off-convention actions. The read queries match entityType and
 * action by index equality, so un-normalized rows are invisible to them —
 * this backfill is required for pre-refactor history to appear in the UI.
 *
 * Self-schedules through the table in batches. Kick off once after deploy:
 *   npx convex run auditLogMigration:normalizeLegacyLiterals
 * Re-running is safe (already-normalized rows are left untouched).
 */

const ENTITY_TYPE_MAP: Record<string, string> = {
  LOAD: 'load',
};

const ACTION_MAP: Record<string, string> = {
  CREATE: 'created',
  UPDATE: 'updated',
  DELETE: 'deleted',
  BULK_CREATE: 'bulk_created',
  ASSIGN_DRIVER: 'driver_assigned',
  ASSIGN_CARRIER: 'carrier_assigned',
  UNASSIGN_RESOURCE: 'resource_unassigned',
  ACTIVATE: 'reactivated',
  DEACTIVATE: 'deactivated',
  activated: 'reactivated',
};

const BATCH_SIZE = 200;

export const normalizeLegacyLiterals = internalMutation({
  args: {
    cursor: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    const page = await ctx.db
      .query('auditLog')
      .paginate({ cursor: args.cursor ?? null, numItems: BATCH_SIZE });

    let patched = 0;
    for (const row of page.page) {
      const entityType = ENTITY_TYPE_MAP[row.entityType];
      const action = ACTION_MAP[row.action];
      if (entityType !== undefined || action !== undefined) {
        await ctx.db.patch(row._id, {
          ...(entityType !== undefined ? { entityType } : {}),
          ...(action !== undefined ? { action } : {}),
        });
        patched++;
      }
    }

    if (!page.isDone) {
      await ctx.scheduler.runAfter(0, internal.auditLogMigration.normalizeLegacyLiterals, {
        cursor: page.continueCursor,
      });
    }

    return { patched, done: page.isDone };
  },
});

/**
 * One-time backfill: give loads that expired BEFORE expiry logging shipped a
 * retroactive 'expired' audit row, so their History explains the status
 * instead of showing nothing.
 *
 * The row is timestamped from the load's `updatedAt` (the expiry patch was
 * the last write for cron-expired loads — an approximation, flagged as such)
 * and marked `backfilled` in metadata. Loads that already have an 'expired'
 * audit row are skipped, so re-running is safe.
 *
 * Kick off once after deploy:
 *   npx convex run auditLogMigration:backfillExpiredLoadAuditRows
 */
export const backfillExpiredLoadAuditRows = internalMutation({
  args: {
    orgId: v.optional(v.string()),
    cursor: v.optional(v.string()),
    insertedTotal: v.optional(v.number()),
    batchNumber: v.optional(v.number()),
  },
  handler: async (ctx, args) => {
    // Dispatch mode: fan out one chain per org so every page comes from the
    // selective by_status index range (workosOrgId, 'Expired'). A plain
    // .filter() over the whole table scans every load doc and blows the
    // 16MB per-function read limit on large tables.
    if (!args.orgId) {
      const orgs = await ctx.db.query('organizations').take(500);
      let dispatched = 0;
      for (const org of orgs) {
        if (!org.workosOrgId) continue;
        await ctx.scheduler.runAfter(0, internal.auditLogMigration.backfillExpiredLoadAuditRows, {
          orgId: org.workosOrgId,
        });
        dispatched++;
      }
      console.log(`[backfillExpiredLoadAuditRows] dispatched ${dispatched} per-org chains`);
      return { dispatched };
    }

    const batchNumber = (args.batchNumber ?? 0) + 1;
    const page = await ctx.db
      .query('loadInformation')
      .withIndex('by_status', (q) => q.eq('workosOrgId', args.orgId!).eq('status', 'Expired'))
      .paginate({ cursor: args.cursor ?? null, numItems: 100 });

    let inserted = 0;
    let failed = 0;
    for (const load of page.page) {
      // A single bad document must not kill the whole continuation chain.
      try {
        // Point read on by_org_entity_action (≤1 doc). Collecting the whole
        // by_org_entity history here read every audit row (with their
        // changesBefore/After JSON blobs) for 100 loads per batch, which is
        // what neared the per-mutation bytes/documents read limits.
        const existing = await ctx.db
          .query('auditLog')
          .withIndex('by_org_entity_action', (q) =>
            q
              .eq('organizationId', load.workosOrgId)
              .eq('entityType', 'load')
              .eq('entityId', load._id)
              .eq('action', 'expired'),
          )
          .first();
        if (existing) continue;

        await ctx.db.insert('auditLog', {
          organizationId: load.workosOrgId,
          entityType: 'load',
          entityId: load._id,
          entityName: load.internalId,
          action: 'expired',
          performedBy: 'system',
          performedByName: 'System (auto-expiry)',
          description: `Auto-expired load ${load.internalId}: pickup passed with no tracking activity (recorded retroactively — time approximated from the load's last update)`,
          metadata: JSON.stringify({ backfilled: true }),
          timestamp: load.updatedAt ?? load._creationTime,
        });
        inserted++;
      } catch (err) {
        failed++;
        console.error(
          `[backfillExpiredLoadAuditRows] load ${load._id} (${load.internalId ?? '?'}) failed:`,
          err instanceof Error ? err.message : err,
        );
      }
    }

    const insertedTotal = (args.insertedTotal ?? 0) + inserted;
    console.log(
      `[backfillExpiredLoadAuditRows] org=${args.orgId} batch ${batchNumber}: scanned=${page.page.length} inserted=${inserted} failed=${failed} totalInserted=${insertedTotal} done=${page.isDone}`,
    );

    if (!page.isDone) {
      await ctx.scheduler.runAfter(0, internal.auditLogMigration.backfillExpiredLoadAuditRows, {
        orgId: args.orgId,
        cursor: page.continueCursor,
        insertedTotal,
        batchNumber,
      });
    } else {
      console.log(
        `[backfillExpiredLoadAuditRows] org=${args.orgId} COMPLETE after ${batchNumber} batches, ${insertedTotal} rows inserted`,
      );
    }

    return { inserted, insertedTotal, failed, batchNumber, done: page.isDone };
  },
});
