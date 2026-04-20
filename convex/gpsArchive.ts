'use node';

import { v } from 'convex/values';
import { internalAction, action } from './_generated/server';
import { internal } from './_generated/api';
import { S3Client, PutObjectCommand, GetObjectCommand } from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import { gzipSync } from 'zlib';

/**
 * GPS Archive — Phase 7
 *
 * Nightly cron pulls driverLocations older than 30 days, groups them by
 * (orgId, date, hour), gzips the JSONL payload, PUTs to a dedicated S3
 * bucket, records an audit row in gpsArchiveLog, and deletes the rows
 * from Convex. Object keys are deterministic:
 *
 *   s3://<bucket>/gps-archive/org={orgId}/date={YYYY-MM-DD}/part-{HH}.jsonl.gz
 *
 * If the cron crashes between upload and delete we re-upload the same range
 * on next run — the S3 object key is stable per (orgId, date, hour), so
 * we overwrite rather than duplicate. The gpsArchiveLog entry is inserted
 * only after a successful PUT, so a replay produces one extra audit row —
 * acceptable for forensics.
 *
 * Retrieval for the rare ≥30d window doesn't download on the server; it
 * returns short-lived signed GET URLs and lets the caller stream + parse.
 * Keeps Convex action size tiny and avoids loading large Parquet readers.
 *
 * Format is JSONL+gzip (not Parquet). Parquet would be nicer for analytics
 * but this is cold retrieval; an ETL job can Parquet-ify later if needed.
 */

// ============================================
// CONFIG
// ============================================

const RETENTION_DAYS = 30;
const BATCH_SIZE = 5000; // Read cap per cron tick; ~7 days of one driver's shift

function createArchiveS3Client() {
  // GPS archive lives on AWS S3 — distinct from POD photos which live on
  // Cloudflare R2 (see convex/s3Upload.ts). Credentials are NOT shared:
  // POD's S3_ACCESS_KEY_ID is an R2 key and would fail against AWS.
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
// GROUPING HELPERS
// ============================================

type ArchivableLocation = {
  _id: string;
  driverId: string;
  loadId?: string;
  sessionId?: string;
  organizationId: string;
  latitude: number;
  longitude: number;
  accuracy?: number;
  speed?: number;
  heading?: number;
  trackingType: 'LOAD_ROUTE' | 'SESSION_ROUTE';
  recordedAt: number;
  createdAt: number;
};

function groupKey(loc: ArchivableLocation): {
  organizationId: string;
  date: string;
  hour: number;
  key: string;
} {
  const dt = new Date(loc.recordedAt);
  const y = dt.getUTCFullYear();
  const m = String(dt.getUTCMonth() + 1).padStart(2, '0');
  const d = String(dt.getUTCDate()).padStart(2, '0');
  const date = `${y}-${m}-${d}`;
  const hour = dt.getUTCHours();
  const key = `${loc.organizationId}|${date}|${hour}`;
  return { organizationId: loc.organizationId, date, hour, key };
}

function s3KeyFor(orgId: string, date: string, hour: number): string {
  const hh = String(hour).padStart(2, '0');
  return `gps-archive/org=${orgId}/date=${date}/part-${hh}.jsonl.gz`;
}

// ============================================
// ARCHIVE CRON
// ============================================

/**
 * Nightly archive orchestrator. Reads a bounded batch of old rows, groups
 * them, uploads + audits + deletes per group, then reschedules itself if
 * more data remains. Bounded by BATCH_SIZE per tick so we stay far under
 * Convex's per-function time and memory limits.
 */
export const archiveOldLocations = internalAction({
  args: {},
  returns: v.null(),
  handler: async (ctx) => {
    const s3 = createArchiveS3Client();
    if (!s3) {
      // Fail-closed: without a configured bucket we don't delete anything.
      // An unconfigured archive bucket silently losing GPS data would be
      // much worse than old rows lingering in hot storage for a few days.
      console.warn(
        '[gpsArchive] GPS_ARCHIVE_S3_BUCKET not configured — skipping archive run'
      );
      return null;
    }

    const cutoffTime = Date.now() - RETENTION_DAYS * 24 * 60 * 60 * 1000;

    const oldLocations = await ctx.runQuery(
      internal.driverLocations.getLocationsOlderThan,
      { cutoffTime, limit: BATCH_SIZE }
    );

    if (oldLocations.length === 0) {
      console.log('[gpsArchive] No rows to archive');
      return null;
    }

    // Group by (orgId, date, hour). One S3 object per group.
    const groups = new Map<
      string,
      {
        organizationId: string;
        date: string;
        hour: number;
        rows: ArchivableLocation[];
      }
    >();
    for (const loc of oldLocations as ArchivableLocation[]) {
      const k = groupKey(loc);
      let g = groups.get(k.key);
      if (!g) {
        g = {
          organizationId: k.organizationId,
          date: k.date,
          hour: k.hour,
          rows: [],
        };
        groups.set(k.key, g);
      }
      g.rows.push(loc);
    }

    console.log(
      `[gpsArchive] ${oldLocations.length} rows → ${groups.size} (org, date, hour) groups`
    );

    let totalUploaded = 0;
    let totalDeleted = 0;
    let groupFailures = 0;

    for (const group of groups.values()) {
      const key = s3KeyFor(group.organizationId, group.date, group.hour);

      // Serialize to newline-delimited JSON with a stable shape. Preserves
      // all query-relevant fields; archivedAt is added for forensics.
      const archivedAt = Date.now();
      const lines: string[] = [];
      let minRecordedAt = Number.POSITIVE_INFINITY;
      let maxRecordedAt = Number.NEGATIVE_INFINITY;
      for (const row of group.rows) {
        lines.push(
          JSON.stringify({
            _id: row._id,
            driverId: row.driverId,
            loadId: row.loadId,
            sessionId: row.sessionId,
            organizationId: row.organizationId,
            latitude: row.latitude,
            longitude: row.longitude,
            accuracy: row.accuracy,
            speed: row.speed,
            heading: row.heading,
            trackingType: row.trackingType,
            recordedAt: row.recordedAt,
            createdAt: row.createdAt,
            archivedAt,
          })
        );
        if (row.recordedAt < minRecordedAt) minRecordedAt = row.recordedAt;
        if (row.recordedAt > maxRecordedAt) maxRecordedAt = row.recordedAt;
      }
      const jsonl = lines.join('\n') + '\n';
      const gz = gzipSync(Buffer.from(jsonl, 'utf8'));

      try {
        await s3.client.send(
          new PutObjectCommand({
            Bucket: s3.bucket,
            Key: key,
            Body: gz,
            ContentType: 'application/x-ndjson',
            ContentEncoding: 'gzip',
            // Metadata is visible via HEAD — handy for ops forensics without
            // downloading the file.
            Metadata: {
              rowcount: String(group.rows.length),
              minrecordedat: String(minRecordedAt),
              maxrecordedat: String(maxRecordedAt),
              archivedat: String(archivedAt),
            },
          })
        );

        // Log the upload BEFORE deleting — we want an audit trail even if
        // the subsequent delete mutation fails.
        await ctx.runMutation(internal.driverLocations.logArchiveUpload, {
          organizationId: group.organizationId,
          date: group.date,
          hour: group.hour,
          s3Bucket: s3.bucket,
          s3Key: key,
          rowCount: group.rows.length,
          byteCount: gz.byteLength,
          minRecordedAt,
          maxRecordedAt,
        });

        // Delete the source rows in bounded chunks — Convex's per-mutation
        // write cap is 16k, but smaller chunks reduce transaction size
        // and OCC contention with any concurrent ingest.
        const ids = group.rows.map((r) => r._id) as any[];
        const CHUNK = 500;
        let deletedForGroup = 0;
        for (let i = 0; i < ids.length; i += CHUNK) {
          const slice = ids.slice(i, i + CHUNK);
          const result = await ctx.runMutation(
            internal.driverLocations.deleteArchivedLocations,
            { ids: slice }
          );
          deletedForGroup += result.deleted;
        }
        totalUploaded += group.rows.length;
        totalDeleted += deletedForGroup;
      } catch (err) {
        groupFailures++;
        console.error(
          `[gpsArchive] Group ${group.organizationId}/${group.date}/${group.hour} failed:`,
          err instanceof Error ? err.message : err
        );
        // Continue other groups — one bad upload shouldn't stall the whole
        // archive run. Failed groups will retry on tomorrow's cron tick.
      }
    }

    console.log(
      `[gpsArchive] Uploaded=${totalUploaded} deleted=${totalDeleted} groupFailures=${groupFailures}`
    );

    // If we hit the batch limit there's likely more to process. Reschedule
    // immediately so we catch up rather than waiting for tomorrow's cron.
    if (oldLocations.length >= BATCH_SIZE && groupFailures === 0) {
      console.log('[gpsArchive] Batch limit hit — rescheduling for another pass');
      await ctx.scheduler.runAfter(
        0,
        internal.gpsArchive.archiveOldLocations,
        {}
      );
    }

    return null;
  },
});

// ============================================
// RETRIEVAL — signed GET URLs for cold reads
// ============================================

/**
 * Returns short-lived signed GET URLs for every archive file that could
 * contain GPS data in the requested window. Caller streams + parses the
 * JSONL locally and filters to the loadId it cares about.
 *
 * Default usage: the external tracking API's /positions endpoint detects
 * that the requested `since` is older than the hot retention boundary and
 * augments its hot-data response with these URLs for the caller to read.
 *
 * URL TTL is 15 minutes — long enough to download a few MB, short enough
 * to not leak access if the response is mishandled.
 */
// Explicit type aliases break the circular inference between this action's
// return type and the internal query's type (which comes from the same
// generated api file that this action's type feeds into). Without these
// annotations TypeScript reports all the downstream bindings as `any`.
type ArchiveFileRow = {
  date: string;
  hour: number;
  s3Bucket: string;
  s3Key: string;
  rowCount: number;
  byteCount: number;
  minRecordedAt: number;
  maxRecordedAt: number;
};
type ArchiveSignedUrlRow = {
  date: string;
  hour: number;
  s3Key: string;
  signedUrl: string;
  rowCount: number;
  byteCount: number;
  minRecordedAt: number;
  maxRecordedAt: number;
};

export const getArchivedPositionFiles = action({
  args: {
    organizationId: v.string(),
    from: v.number(), // epoch ms, inclusive
    to: v.number(), // epoch ms, inclusive
  },
  returns: v.array(
    v.object({
      date: v.string(),
      hour: v.number(),
      s3Key: v.string(),
      signedUrl: v.string(),
      rowCount: v.number(),
      byteCount: v.number(),
      minRecordedAt: v.number(),
      maxRecordedAt: v.number(),
    })
  ),
  handler: async (ctx, args): Promise<ArchiveSignedUrlRow[]> => {
    const s3 = createArchiveS3Client();
    if (!s3) {
      throw new Error('Archive storage not configured');
    }

    const files: ArchiveFileRow[] = await ctx.runQuery(
      internal.driverLocations.listArchivedFilesInWindow,
      {
        organizationId: args.organizationId,
        from: args.from,
        to: args.to,
      }
    );

    // Sign each object separately. 15-minute expiry is enough for a caller
    // to sequentially download a handful of files; if they need longer they
    // can call this action again.
    const SIGNED_URL_TTL_SECONDS = 15 * 60;
    const signed: ArchiveSignedUrlRow[] = await Promise.all(
      files.map(async (f: ArchiveFileRow): Promise<ArchiveSignedUrlRow> => {
        const url = await getSignedUrl(
          s3.client,
          new GetObjectCommand({ Bucket: f.s3Bucket, Key: f.s3Key }),
          { expiresIn: SIGNED_URL_TTL_SECONDS }
        );
        return {
          date: f.date,
          hour: f.hour,
          s3Key: f.s3Key,
          signedUrl: url,
          rowCount: f.rowCount,
          byteCount: f.byteCount,
          minRecordedAt: f.minRecordedAt,
          maxRecordedAt: f.maxRecordedAt,
        };
      })
    );

    return signed;
  },
});
