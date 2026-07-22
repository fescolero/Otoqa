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
    cursor: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    const page = await ctx.db
      .query('loadInformation')
      .filter((q) => q.eq(q.field('status'), 'Expired'))
      .paginate({ cursor: args.cursor ?? null, numItems: 100 });

    let inserted = 0;
    for (const load of page.page) {
      const existing = await ctx.db
        .query('auditLog')
        .withIndex('by_org_entity', (q) =>
          q.eq('organizationId', load.workosOrgId).eq('entityType', 'load').eq('entityId', load._id),
        )
        .collect();
      if (existing.some((row) => row.action === 'expired')) continue;

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
    }

    if (!page.isDone) {
      await ctx.scheduler.runAfter(0, internal.auditLogMigration.backfillExpiredLoadAuditRows, {
        cursor: page.continueCursor,
      });
    }

    return { inserted, done: page.isDone };
  },
});
