'use node';

import { v } from 'convex/values';
import { internalAction } from './_generated/server';
import { internal } from './_generated/api';
import { S3Client, PutObjectCommand } from '@aws-sdk/client-s3';
import type { Id } from './_generated/dataModel';

/**
 * Audit Log Archive
 *
 * Monthly cron pulls auditLog rows older than 12 months, groups them by
 * the calendar month of their timestamp, serializes to JSONL, PUTs to the
 * same S3 bucket used by the GPS archive (see convex/gpsArchive.ts), and
 * deletes the rows from Convex. Object keys:
 *
 *   s3://<bucket>/audit-archive/{YYYY-MM}/batch-{runTimestamp}.jsonl
 *
 * Modeled on convex/gpsArchive.ts (Node runtime action; DB helpers live in
 * convex/auditLogArchiveDb.ts because 'use node' files may only export
 * actions). Two deliberate differences:
 *
 * 1. Plain JSONL, not gzipped — audit rows are small text; simplicity wins.
 *
 * 2. Batch keys embed the run timestamp instead of being deterministic.
 *    gpsArchive's (orgId, date, hour) keys are safe to overwrite because a
 *    replay re-produces identical content; an audit batch's membership
 *    varies run-to-run, so overwriting a prior key could clobber already
 *    archived-and-deleted rows. Unique keys mean a crash between upload
 *    and delete yields a duplicate object on the next run (rows appear in
 *    two files) — duplication is acceptable for forensics, data loss is not.
 *
 * Rows are deleted ONLY after a confirmed S3 PUT. If the upload fails the
 * rows stay in Convex and are retried on the next run.
 *
 * Batch summaries are logged via console.log rather than recorded in
 * gpsArchiveLog: that table is GPS-specific (required `hour` column, and
 * driverLocations.listArchivedFilesInWindow reads it to serve GPS archive
 * retrieval — audit rows in it would pollute those results). A dedicated
 * auditArchiveLog table can be added later if retrieval tooling needs it.
 */

// ============================================
// CONFIG
// ============================================

const RETENTION_DAYS = 365; // 12 months
const BATCH_SIZE = 5000; // Read cap per run; self-reschedules if hit
const DELETE_CHUNK = 200; // Rows deleted per mutation transaction

function createArchiveS3Client() {
  // Same bucket + credentials as the GPS archive (convex/gpsArchive.ts) —
  // audit archives live under a distinct `audit-archive/` key prefix.
  // Distinct from POD photos which live on Cloudflare R2 (convex/s3Upload.ts).
  const bucket = process.env.GPS_ARCHIVE_S3_BUCKET;
  const region = process.env.GPS_ARCHIVE_S3_REGION ?? 'us-east-2';
  const accessKeyId = process.env.GPS_ARCHIVE_S3_ACCESS_KEY_ID;
  const secretAccessKey = process.env.GPS_ARCHIVE_S3_SECRET_ACCESS_KEY;

  if (!bucket || !accessKeyId || !secretAccessKey) {
    return null;
  }

  return {
    client: new S3Client({
      region,
      credentials: { accessKeyId, secretAccessKey },
    }),
    bucket,
  };
}

// ============================================
// HELPERS
// ============================================

/** YYYY-MM (UTC) of the row's timestamp — the S3 key prefix bucket. */
function monthKey(timestamp: number): string {
  const dt = new Date(timestamp);
  const y = dt.getUTCFullYear();
  const m = String(dt.getUTCMonth() + 1).padStart(2, '0');
  return `${y}-${m}`;
}

function s3KeyFor(month: string, runTimestamp: number): string {
  return `audit-archive/${month}/batch-${runTimestamp}.jsonl`;
}

// ============================================
// ARCHIVE CRON
// ============================================

type ArchivableRow = { _id: Id<'auditLog'>; timestamp: number } & Record<string, unknown>;

/**
 * Monthly archive orchestrator. Reads a bounded batch of old rows, groups
 * them by calendar month, uploads + deletes per group, then reschedules
 * itself if more data remains. Bounded by BATCH_SIZE per tick so we stay
 * far under Convex's per-function time and memory limits.
 */
export const archiveOldAuditLogs = internalAction({
  args: {},
  returns: v.null(),
  handler: async (ctx) => {
    const s3 = createArchiveS3Client();
    if (!s3) {
      // Fail-closed: without a configured bucket we don't delete anything.
      // An unconfigured archive bucket silently losing audit history would
      // be much worse than old rows lingering in hot storage.
      console.warn(
        '[auditLogArchive] GPS_ARCHIVE_S3_BUCKET not configured — skipping archive run'
      );
      return null;
    }

    const cutoffTime = Date.now() - RETENTION_DAYS * 24 * 60 * 60 * 1000;

    const oldRows: ArchivableRow[] = await ctx.runQuery(
      internal.auditLogArchiveDb.getAuditLogsOlderThan,
      { cutoffTime, limit: BATCH_SIZE }
    );

    if (oldRows.length === 0) {
      console.log('[auditLogArchive] No rows to archive');
      return null;
    }

    // Group by calendar month of the row's timestamp. One S3 object per
    // month per run.
    const groups = new Map<string, ArchivableRow[]>();
    for (const row of oldRows) {
      const month = monthKey(row.timestamp);
      let g = groups.get(month);
      if (!g) {
        g = [];
        groups.set(month, g);
      }
      g.push(row);
    }

    console.log(
      `[auditLogArchive] ${oldRows.length} rows → ${groups.size} month groups`
    );

    const runTimestamp = Date.now();
    let totalUploaded = 0;
    let totalDeleted = 0;
    let groupFailures = 0;

    for (const [month, rows] of groups) {
      const key = s3KeyFor(month, runTimestamp);

      // Serialize to newline-delimited JSON with a stable shape. Preserves
      // all fields; archivedAt is added for forensics.
      const archivedAt = Date.now();
      const lines: string[] = [];
      let minTimestamp = Number.POSITIVE_INFINITY;
      let maxTimestamp = Number.NEGATIVE_INFINITY;
      for (const row of rows) {
        lines.push(JSON.stringify({ ...row, archivedAt }));
        if (row.timestamp < minTimestamp) minTimestamp = row.timestamp;
        if (row.timestamp > maxTimestamp) maxTimestamp = row.timestamp;
      }
      const jsonl = lines.join('\n') + '\n';
      const body = new TextEncoder().encode(jsonl);

      try {
        await s3.client.send(
          new PutObjectCommand({
            Bucket: s3.bucket,
            Key: key,
            Body: body,
            ContentType: 'application/x-ndjson',
            // Metadata is visible via HEAD — handy for ops forensics without
            // downloading the file.
            Metadata: {
              rowcount: String(rows.length),
              mintimestamp: String(minTimestamp),
              maxtimestamp: String(maxTimestamp),
              archivedat: String(archivedAt),
            },
          })
        );

        // Log the upload BEFORE deleting — an audit trail in the function
        // logs even if the subsequent delete mutation fails. (gpsArchiveLog
        // is not used here: its schema is GPS-specific and feeds GPS
        // retrieval; see module docblock.)
        console.log(
          `[auditLogArchive] Uploaded s3://${s3.bucket}/${key} rows=${rows.length} bytes=${body.byteLength} minTimestamp=${minTimestamp} maxTimestamp=${maxTimestamp}`
        );

        // Delete the source rows in bounded chunks (~200 per transaction)
        // to keep transaction size small and reduce OCC contention with
        // concurrent audit writes.
        const ids = rows.map((r) => r._id);
        let deletedForGroup = 0;
        for (let i = 0; i < ids.length; i += DELETE_CHUNK) {
          const slice = ids.slice(i, i + DELETE_CHUNK);
          const result = await ctx.runMutation(
            internal.auditLogArchiveDb.deleteArchivedAuditLogs,
            { ids: slice }
          );
          deletedForGroup += result.deleted;
        }
        totalUploaded += rows.length;
        totalDeleted += deletedForGroup;
      } catch (err) {
        groupFailures++;
        console.error(
          `[auditLogArchive] Month group ${month} failed:`,
          err instanceof Error ? err.message : err
        );
        // Continue other groups — one bad upload shouldn't stall the whole
        // archive run. Failed groups retry on the next run; their rows are
        // NOT deleted.
      }
    }

    console.log(
      `[auditLogArchive] Uploaded=${totalUploaded} deleted=${totalDeleted} groupFailures=${groupFailures}`
    );

    // If we hit the batch limit there's likely more to process. Reschedule
    // immediately so a large backlog drains without waiting a month.
    if (oldRows.length >= BATCH_SIZE && groupFailures === 0) {
      console.log(
        '[auditLogArchive] Batch limit hit — rescheduling for another pass'
      );
      await ctx.scheduler.runAfter(
        0,
        internal.auditLogArchive.archiveOldAuditLogs,
        {}
      );
    }

    return null;
  },
});
