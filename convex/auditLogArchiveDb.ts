import { v } from 'convex/values';
import { internalQuery, internalMutation } from './_generated/server';

/**
 * DB helpers for the audit-log archive action (convex/auditLogArchive.ts).
 * They live here rather than in auditLogArchive.ts because that file runs
 * in the Node runtime ('use node') and may only export actions — the same
 * split gpsArchive.ts uses with driverLocations.ts.
 */

/**
 * Get audit log rows older than the cutoff for archival.
 *
 * Paging strategy: a plain table scan filtered on `timestamp`, capped by
 * `take(limit)` — the same filter+take shape gpsArchive's
 * getLocationsOlderThan uses. auditLog has no index leading with
 * `timestamp` (by_organization is [organizationId, timestamp], which only
 * helps per-org scans), but rows are written with timestamp = Date.now(),
 * so the default _creationTime order puts the oldest rows first and the
 * scan finds its matches at the front of the table.
 */
export const getAuditLogsOlderThan = internalQuery({
  args: {
    cutoffTime: v.number(),
    limit: v.number(),
  },
  returns: v.array(
    v.object({
      _id: v.id('auditLog'),
      _creationTime: v.number(),
      organizationId: v.string(),
      entityType: v.string(),
      entityId: v.string(),
      entityName: v.optional(v.string()),
      action: v.string(),
      description: v.optional(v.string()),
      performedBy: v.string(),
      performedByName: v.optional(v.string()),
      performedByEmail: v.optional(v.string()),
      changesBefore: v.optional(v.string()),
      changesAfter: v.optional(v.string()),
      changedFields: v.optional(v.array(v.string())),
      ipAddress: v.optional(v.string()),
      userAgent: v.optional(v.string()),
      metadata: v.optional(v.string()),
      timestamp: v.number(),
    })
  ),
  handler: async (ctx, args) => {
    const oldRows = await ctx.db
      .query('auditLog')
      .filter((q) => q.lt(q.field('timestamp'), args.cutoffTime))
      .take(args.limit);

    return oldRows.map((row) => ({
      _id: row._id,
      _creationTime: row._creationTime,
      organizationId: row.organizationId,
      entityType: row.entityType,
      entityId: row.entityId,
      entityName: row.entityName,
      action: row.action,
      description: row.description,
      performedBy: row.performedBy,
      performedByName: row.performedByName,
      performedByEmail: row.performedByEmail,
      changesBefore: row.changesBefore,
      changesAfter: row.changesAfter,
      changedFields: row.changedFields,
      ipAddress: row.ipAddress,
      userAgent: row.userAgent,
      metadata: row.metadata,
      timestamp: row.timestamp,
    }));
  },
});

/**
 * Delete audit log rows that have been archived. Called only after a
 * confirmed S3 upload, in bounded chunks to keep transactions small.
 */
export const deleteArchivedAuditLogs = internalMutation({
  args: {
    ids: v.array(v.id('auditLog')),
  },
  returns: v.object({ deleted: v.number() }),
  handler: async (ctx, args) => {
    let deleted = 0;
    for (const id of args.ids) {
      await ctx.db.delete(id);
      deleted++;
    }
    return { deleted };
  },
});
