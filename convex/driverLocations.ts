import { v } from 'convex/values';
import {
  query,
  mutation,
  internalAction,
  internalQuery,
  internalMutation,
  MutationCtx,
} from './_generated/server';
import { internal } from './_generated/api';
import { Id, Doc } from './_generated/dataModel';
import { assertCallerOwnsOrg, requireCallerOrgId } from './lib/auth';

// ============================================
// DRIVER LOCATION TRACKING
// For helicopter view and route history polylines
// ============================================

// ============================================
// SHARED INGEST HELPER
// ============================================

/**
 * Shape of a single ping as accepted by the batch-insert mutations.
 *
 * Invariants (enforced below):
 *   - At least one of { loadId, sessionId } must be present.
 *   - trackingType must match attachment:
 *       LOAD_ROUTE     ↔ loadId present  (driver actively on a load)
 *       SESSION_ROUTE  ↔ loadId absent   (on-shift but not on a load)
 *   - If both loadId and sessionId present, trackingType must be LOAD_ROUTE.
 *   - sessionId (if present) must belong to the claimed driver in the claimed org.
 */
const pingValidator = v.object({
  driverId: v.id('drivers'),
  loadId: v.optional(v.id('loadInformation')),
  sessionId: v.optional(v.id('driverSessions')),
  latitude: v.float64(),
  longitude: v.float64(),
  accuracy: v.optional(v.float64()),
  speed: v.optional(v.float64()),
  heading: v.optional(v.float64()),
  trackingType: v.union(v.literal('LOAD_ROUTE'), v.literal('SESSION_ROUTE')),
  recordedAt: v.float64(),
  // Optional source tag. Mobile callers omit it (rows default to MOBILE on
  // read). Samsara backup-ingest stamps 'SAMSARA'. Stripped before partner
  // API serialization — internal-only.
  source: v.optional(v.union(v.literal('MOBILE'), v.literal('SAMSARA'))),
});

export type PingInput = {
  driverId: Id<'drivers'>;
  loadId?: Id<'loadInformation'>;
  sessionId?: Id<'driverSessions'>;
  latitude: number;
  longitude: number;
  accuracy?: number;
  speed?: number;
  heading?: number;
  trackingType: 'LOAD_ROUTE' | 'SESSION_ROUTE';
  recordedAt: number;
  source?: 'MOBILE' | 'SAMSARA';
};

/**
 * Insert a batch of GPS pings with org scoping, session/load consistency
 * validation, exact-key dedup, and scheduled geofence evaluation.
 *
 * Dedup strategy: one exact (sessionId|loadId, recordedAt) index probe per
 * ping, issued concurrently. Each probe's read set is a single index key,
 * so concurrent ingest mutations for the same session (mobile HTTP batches
 * vs. the org-wide Samsara poll) never intersect unless they carry the
 * literal same timestamp — which is the one case where OCC serialization
 * is wanted. The previous "latest stored ping" shortcut read the head of
 * the by_session_time index instead, which conflicted with EVERY concurrent
 * insert of a newer ping and was the dominant source of the write-conflict
 * retries on driverLocations reported by Convex Health.
 */
/**
 * Structured outcome of a batch insert. The mobile client uses these to
 * decide which queued rows to mark synced (and stop retrying).
 *
 *   • inserted              — newly stored. Mark synced.
 *   • duplicates            — server already had this exact (sessionId,
 *                             recordedAt) or (loadId, recordedAt). Data is
 *                             on the server already. Mark synced.
 *   • permanentlyRejected   — driver/org/load/session not found, shape
 *                             invariant violated, or clock-skew guard
 *                             tripped. Will NEVER succeed on retry. Mark
 *                             synced + telemetry. Includes skew
 *                             rejections — see rejectedIndices below.
 *   • transientlyRejected   — reserved for future use (none today). Do
 *                             NOT mark synced; let the client retry.
 *   • rejectedIndices       — zero-based indices into the incoming
 *                             `locations` array for pings that were
 *                             rejected specifically by the clock-skew
 *                             guard. The client flags these as
 *                             `permanentlyFailed` on the local queue
 *                             (retained for forensic inspection until
 *                             the 48h age purge), rather than removing
 *                             them as it does for other permanent
 *                             rejections. Other permanent rejections
 *                             (driver/org/session/shape) do NOT appear
 *                             here — they flow through the scalar
 *                             `permanentlyRejected` count and are
 *                             removed from the local queue as before.
 *
 * Invariant: inserted + duplicates + permanentlyRejected + transientlyRejected
 *            === pings.length (modulo bugs — telemetry surfaces drift).
 */
export type IngestOutcome = {
  inserted: number;
  duplicates: number;
  permanentlyRejected: number;
  transientlyRejected: number;
  rejectedIndices: number[];
};

// Clock-skew guard thresholds. Tuned so:
//   • Future > 5min:  covers RTC / NTP drift on consumer hardware. A real
//                     driver's phone shouldn't ever record a timestamp
//                     more than a few seconds ahead of the server; 5 min
//                     is comfortably above that noise floor.
//   • Past > 48h:     matches MAX_PING_AGE_MS in mobile/location-tracking.ts.
//                     A ping older than 48h was already going to be purged
//                     client-side; rejecting it here prevents storing a
//                     stale ping whose ordering would confuse geofence
//                     evaluation and the dispatcher freshness heuristic.
const SKEW_FUTURE_MS = 5 * 60 * 1000;
const SKEW_PAST_MS = 48 * 60 * 60 * 1000;

// Debounce threshold for driverSessions.lastPingAt writes. A session
// patched on every batch would churn reactive query subscriptions for
// dispatchers watching the session row AND collide with the parallel
// writer (mobile + Samsara ingest paths both flow through ingestBatch).
//
// 60s cuts write rate by ~60× for a driver reporting every second while
// keeping the freshness probe accurate enough for the fcmWake.sweep cron
// (which trips at 2 min of silence — debounce window + threshold = 3 min
// worst-case-to-detect, well within the wake intent).
//
// History: was 15s; bumped to 60s after observing OCC retries between
// samsaraIngestMutations:processVehicleStats and
// driverLocations:batchInsertLocations on the lastPingAt patch.
const LAST_PING_DEBOUNCE_MS = 60_000;

// Phase 1: fallback sample rate for the ping_ingested server-side emit
// when the `ping_ingested_sample_rate` flag is missing or malformed. 1%
// matches the default documented in mobile/docs/gps-tracking-architecture.md
// and keeps PostHog event volume bounded at scale.
const PING_INGESTED_SAMPLE_RATE_FALLBACK = 0.01;

export async function ingestBatch(
  ctx: MutationCtx,
  pings: PingInput[],
  orgId: string
): Promise<IngestOutcome> {
  const now = Date.now();
  let inserted = 0;
  let skippedDriver = 0;
  let skippedOrgMismatch = 0;
  let skippedLoad = 0;
  let skippedSession = 0;
  // Counts pings rejected because they arrived after the session was
  // ended (status === 'completed') or after session.endedAt. Tracked
  // separately from skippedSession so we can monitor mobile shutdown
  // bugs vs. unrelated session/driver mismatches.
  let skippedSessionEnded = 0;
  // Counts pings rejected because they carried a loadId stamped to a
  // dispatchLeg that's now COMPLETED or CANCELED. Surfaces drivers who
  // forgot to check out before the next leg started.
  let skippedLegInactive = 0;
  let skippedShape = 0;
  let skippedDuplicate = 0;
  let skippedSkew = 0;
  // Indices (in the original `pings` array) of pings rejected by the
  // clock-skew guard. Returned so the client can mark those specific
  // local rows `permanentlyFailed` instead of removing them outright —
  // retained for forensic inspection until the 48h age purge sweeps
  // them up.
  const rejectedIndices: number[] = [];

  // Cache per-batch to avoid re-reads when multiple pings share a driver.
  const driverCache = new Map<Id<'drivers'>, Doc<'drivers'> | null>();
  const sessionCache = new Map<Id<'driverSessions'>, Doc<'driverSessions'> | null>();
  const loadCache = new Map<Id<'loadInformation'>, Doc<'loadInformation'> | null>();

  const getDriver = async (id: Id<'drivers'>) => {
    if (!driverCache.has(id)) driverCache.set(id, await ctx.db.get(id));
    return driverCache.get(id)!;
  };
  const getSession = async (id: Id<'driverSessions'>) => {
    if (!sessionCache.has(id)) sessionCache.set(id, await ctx.db.get(id));
    return sessionCache.get(id)!;
  };
  const getLoad = async (id: Id<'loadInformation'>) => {
    if (!loadCache.has(id)) loadCache.set(id, await ctx.db.get(id));
    return loadCache.get(id)!;
  };

  // Memo for the leg-active check below. Keyed on `${driverId}|${loadId}`
  // so repeated pings in the same batch (same driver, same load) share
  // a single index lookup instead of N redundant ones. true = at least
  // one ACTIVE leg matches the (driver, load) pair.
  const activeLegByDriverLoad = new Map<string, boolean>();

  // First pass: per-ping validation. Build the "valid" list for dedup + insert.
  const valid: PingInput[] = [];
  for (let idx = 0; idx < pings.length; idx++) {
    const loc = pings[idx];

    // Clock-skew guard — runs first. A ping with a garbage timestamp
    // would poison downstream logic (dedup on recordedAt, geofence
    // evaluation on the "latest" ping, dispatcher freshness checks
    // that compare `recordedAt` against wall-clock "now"), so reject
    // before anything else touches it.
    const futureSkewMs = loc.recordedAt - now;
    const pastSkewMs = now - loc.recordedAt;
    if (futureSkewMs > SKEW_FUTURE_MS) {
      skippedSkew++;
      rejectedIndices.push(idx);
      console.warn(
        `[driverLocations.ingestBatch] tracking_skewed_ping_rejected ` +
          `driverId=${loc.driverId} skewMs=${futureSkewMs} direction=future`,
      );
      continue;
    }
    if (pastSkewMs > SKEW_PAST_MS) {
      skippedSkew++;
      rejectedIndices.push(idx);
      console.warn(
        `[driverLocations.ingestBatch] tracking_skewed_ping_rejected ` +
          `driverId=${loc.driverId} skewMs=${pastSkewMs} direction=past`,
      );
      continue;
    }

    // Shape invariants
    if (!loc.loadId && !loc.sessionId) {
      skippedShape++;
      continue;
    }
    if (loc.loadId && loc.trackingType !== 'LOAD_ROUTE') {
      skippedShape++;
      continue;
    }
    if (!loc.loadId && loc.trackingType !== 'SESSION_ROUTE') {
      skippedShape++;
      continue;
    }

    const driver = await getDriver(loc.driverId);
    if (!driver || driver.isDeleted) {
      skippedDriver++;
      continue;
    }
    if (driver.organizationId !== orgId) {
      skippedOrgMismatch++;
      continue;
    }

    if (loc.sessionId) {
      const session = await getSession(loc.sessionId);
      if (!session) {
        skippedSession++;
        continue;
      }
      if (session.driverId !== loc.driverId || session.organizationId !== orgId) {
        skippedSession++;
        continue;
      }
      // STRICT session-end rejection. Mobile is supposed to call
      // stopSessionTracking() on shift end, but without a server→mobile
      // signal it sometimes keeps sending pings after the session is
      // closed (dispatch override, auto-timeout, or another device
      // ending). Dropping them here is the simple, deterministic fix.
      //
      // Two conditions catch the same family of bugs from different
      // angles:
      //   • status !== 'active': the session row is closed. Anything
      //     stamped with this sessionId is now post-shift drift.
      //   • recordedAt > endedAt: defensive on clock skew. If somehow
      //     status is still 'active' but endedAt is set (race during
      //     end), still reject.
      if (session.status !== 'active') {
        skippedSessionEnded++;
        continue;
      }
      if (session.endedAt != null && loc.recordedAt > session.endedAt) {
        skippedSessionEnded++;
        continue;
      }
    }

    if (loc.loadId) {
      const load = await getLoad(loc.loadId);
      if (!load) {
        skippedLoad++;
        continue;
      }
      // STRICT leg-status rejection. If the ping carries a loadId, the
      // driver should currently be ACTIVE on a dispatch leg for that
      // load. If no ACTIVE leg matches the (driverId, loadId) pair, the
      // loadId is stamped stale (driver forgot to check out and
      // mobile's foreground tracker kept assigning the old loadId).
      //
      // Memoized: most batches contain many pings sharing one or two
      // loadIds, so we query the dispatchLegs index at most once per
      // unique (driver, load) pair across the whole batch.
      const cacheKey = `${loc.driverId}|${loc.loadId}`;
      let hasActiveLeg = activeLegByDriverLoad.get(cacheKey);
      if (hasActiveLeg === undefined) {
        const activeLegForLoad = await ctx.db
          .query('dispatchLegs')
          .withIndex('by_driver', (q) =>
            q.eq('driverId', loc.driverId).eq('status', 'ACTIVE'),
          )
          .filter((q) => q.eq(q.field('loadId'), loc.loadId))
          .first();
        hasActiveLeg = !!activeLegForLoad;
        activeLegByDriverLoad.set(cacheKey, hasActiveLeg);
      }
      if (!hasActiveLeg) {
        skippedLegInactive++;
        continue;
      }
    }

    valid.push(loc);
  }

  // Batch-boundary dedup. Group by sessionId (new mode) or loadId (legacy).
  // For each group, read the latest stored ping once; if the batch starts
  // after that timestamp there's no possible overlap, so skip the per-ping
  // dedup reads entirely.
  //
  // Dedup caveat (documented, intentionally permissive): the batch-boundary
  // shortcut assumes one active device per (sessionId|loadId) at a time.
  // With a single device, the ping queue's timestamp-based ids (see
  // mobile/lib/location-queue.ts:43) all but guarantee monotonic
  // recordedAt within a batch; collisions there would indicate a client
  // bug. With two devices reporting against the same sessionId, both can
  // independently sample a GPS fix at the same millisecond — a genuine
  // cross-device dup. We observe here (below) but do not reject, so we
  // don't surprise any unintentional multi-device users while the rate
  // is measured.
  const sessionGroups = new Map<Id<'driverSessions'>, PingInput[]>();
  const legacyLoadGroups = new Map<Id<'loadInformation'>, PingInput[]>();

  for (const loc of valid) {
    if (loc.sessionId) {
      const list = sessionGroups.get(loc.sessionId) ?? [];
      list.push(loc);
      sessionGroups.set(loc.sessionId, list);
    } else if (loc.loadId) {
      const list = legacyLoadGroups.get(loc.loadId) ?? [];
      list.push(loc);
      legacyLoadGroups.set(loc.loadId, list);
    }
  }

  // Observe intra-batch duplicates BEFORE dedup — the "clean boundary"
  // shortcut (below) will happily insert them all, so the telemetry here
  // is the only way to measure how often this happens. If the rate
  // exceeds 0.1% of inserts over a 7-day window, the § 6.4 plan note
  // says to revisit and add per-ping dedup. Until then: observe only.
  let internalDupCount = 0;
  for (const [sessionId, group] of sessionGroups) {
    const seen = new Set<number>();
    let groupDups = 0;
    for (const p of group) {
      if (seen.has(p.recordedAt)) groupDups++;
      else seen.add(p.recordedAt);
    }
    if (groupDups > 0) {
      internalDupCount += groupDups;
      console.warn(
        `[driverLocations.ingestBatch] location_queue_internal_dup_observed ` +
          `count=${groupDups} sessionId=${sessionId}`,
      );
    }
  }
  for (const [loadId, group] of legacyLoadGroups) {
    const seen = new Set<number>();
    let groupDups = 0;
    for (const p of group) {
      if (seen.has(p.recordedAt)) groupDups++;
      else seen.add(p.recordedAt);
    }
    if (groupDups > 0) {
      internalDupCount += groupDups;
      console.warn(
        `[driverLocations.ingestBatch] location_queue_internal_dup_observed ` +
          `count=${groupDups} loadId=${loadId}`,
      );
    }
  }

  // Phase 1: read the ping_ingested sample-rate flag once per batch.
  // Cheap indexed lookup, amortized across every ping in the mutation.
  // Malformed / missing rows fall back to 1% to match the in-code default.
  const sampleRateRow = await ctx.db
    .query('featureFlags')
    .withIndex('by_org_key', (q) =>
      q.eq('workosOrgId', orgId).eq('key', 'ping_ingested_sample_rate'),
    )
    .first();
  const parsedRate = sampleRateRow ? Number(sampleRateRow.value) : NaN;
  const pingIngestedSampleRate =
    Number.isFinite(parsedRate) && parsedRate >= 0 && parsedRate <= 1
      ? parsedRate
      : PING_INGESTED_SAMPLE_RATE_FALLBACK;

  // Phase 1: per-session max recordedAt among SUCCESSFULLY inserted pings.
  // Used by the debounced lastPingAt patch below. Legacy loadId-only pings
  // (no sessionId) are excluded — the FCM wake path only targets sessions.
  const insertedMaxRecordedAtBySession = new Map<Id<'driverSessions'>, number>();

  // Per-driver "newest ping seen in this batch" — drives the
  // driverLatestLocation upsert at end-of-batch. Tracks the whole ping
  // (not just recordedAt) because the upsert copies position + context
  // fields off the winning ping.
  const newestPingByDriver = new Map<Id<'drivers'>, PingInput>();

  const insertPing = async (loc: PingInput) => {
    await ctx.db.insert('driverLocations', {
      driverId: loc.driverId,
      loadId: loc.loadId,
      sessionId: loc.sessionId,
      organizationId: orgId,
      latitude: loc.latitude,
      longitude: loc.longitude,
      accuracy: loc.accuracy,
      speed: loc.speed,
      heading: loc.heading,
      trackingType: loc.trackingType,
      recordedAt: loc.recordedAt,
      createdAt: now,
      source: loc.source,
    });
    inserted++;

    if (loc.sessionId) {
      const prev = insertedMaxRecordedAtBySession.get(loc.sessionId) ?? 0;
      if (loc.recordedAt > prev) {
        insertedMaxRecordedAtBySession.set(loc.sessionId, loc.recordedAt);
      }
    }

    // Track newest ping per driver for the driverLatestLocation upsert
    // below. Captures the whole ping so the upsert has all the position
    // + context fields available without a re-read.
    const prevNewest = newestPingByDriver.get(loc.driverId);
    if (!prevNewest || loc.recordedAt > prevNewest.recordedAt) {
      newestPingByDriver.set(loc.driverId, loc);
    }

    // Sampled ping_ingested emit. Sole server-side source of the
    // recordedToCreatedLagMs KPI documented in § 6.5 / § 10.4 / § 12. Log
    // format matches the tracking_skewed_ping_rejected line above so both
    // surface through the same downstream parser.
    if (Math.random() < pingIngestedSampleRate) {
      const lagMs = now - loc.recordedAt;
      console.warn(
        `[driverLocations.ingestBatch] ping_ingested ` +
          `recordedToCreatedLagMs=${lagMs}`,
      );
    }
  };

  // Session-keyed groups — exact-key probes, all issued concurrently.
  // A probe that finds nothing only adds the single (sessionId, recordedAt)
  // key to the read set, so concurrent batches with different timestamps
  // commit without OCC retries. Intra-batch duplicates are still inserted
  // (probes run before inserts) — matching the documented observe-only
  // stance on cross-device dups above.
  for (const [sessionId, group] of sessionGroups) {
    const probes = await Promise.all(
      group.map((loc) =>
        ctx.db
          .query('driverLocations')
          .withIndex('by_session_time', (q) =>
            q.eq('sessionId', sessionId).eq('recordedAt', loc.recordedAt)
          )
          .first()
      )
    );
    for (let i = 0; i < group.length; i++) {
      if (probes[i]) {
        skippedDuplicate++;
        continue;
      }
      await insertPing(group[i]);
    }
  }

  // Legacy loadId-only groups (no sessionId — pre-rollout flow)
  for (const [loadId, group] of legacyLoadGroups) {
    const probes = await Promise.all(
      group.map((loc) =>
        ctx.db
          .query('driverLocations')
          .withIndex('by_load', (q) =>
            q.eq('loadId', loadId).eq('recordedAt', loc.recordedAt)
          )
          .first()
      )
    );
    for (let i = 0; i < group.length; i++) {
      if (probes[i]) {
        skippedDuplicate++;
        continue;
      }
      await insertPing(group[i]);
    }
  }

  // Schedule geofence evaluation — at most once per (sessionId, loadId)
  // pair, with the latest ping that targets it (earlier pings are history
  // that the frontier flags would no-op on anyway). A pair qualifies two
  // ways:
  //   1. LOAD_ROUTE pings from a driver with an ACTIVE leg for that load
  //      (the arrival + departure watches while driving it), or
  //   2. a pending loadTrackingState row found via the session — after
  //      last-stop checkout the leg is COMPLETED and pings revert to
  //      SESSION_ROUTE (no loadId), but a loadCompleted row may still be
  //      waiting to confirm the final DEPARTED.
  const newerPing = (a: PingInput, b: PingInput) => (b.recordedAt > a.recordedAt ? b : a);
  // key: sessionId|loadId — keyed per pair (not per load) so a batch that
  // spans a session rollover still evaluates both sessions' latest pings.
  const evaluatorTargets = new Map<string, { loadId: Id<'loadInformation'>; loc: PingInput }>();
  const considerTarget = (
    sessionId: Id<'driverSessions'>,
    loadId: Id<'loadInformation'>,
    loc: PingInput
  ) => {
    const key = `${sessionId}|${loadId}`;
    const prev = evaluatorTargets.get(key);
    evaluatorTargets.set(key, { loadId, loc: prev ? newerPing(prev.loc, loc) : loc });
  };

  // Path 1: loadId pings with an ACTIVE leg. Validation already rejected
  // pings whose (driver, load) pair has no ACTIVE leg (skippedLegInactive),
  // so the memo populated there is authoritative within this transaction's
  // snapshot — no re-read, which keeps the mutation's read set small and
  // narrows the OCC write-conflict window for concurrent ingest batches
  // (mobile + Samsara) competing on the driverLocations rows.
  const loadPingCandidates = new Map<string, PingInput>(); // key: sessionId|loadId
  for (const loc of valid) {
    if (!loc.sessionId || !loc.loadId) continue;
    const key = `${loc.sessionId}|${loc.loadId}`;
    const prev = loadPingCandidates.get(key);
    loadPingCandidates.set(key, prev ? newerPing(prev, loc) : loc);
  }
  for (const loc of loadPingCandidates.values()) {
    if (!activeLegByDriverLoad.get(`${loc.driverId}|${loc.loadId}`)) continue;
    considerTarget(loc.sessionId!, loc.loadId!, loc);
  }

  // Path 2: pending watch rows for the batch's sessions (all active here —
  // validation drops ended-session pings via skippedSessionEnded). Only
  // runs for groups containing SESSION_ROUTE pings — that's the
  // post-checkout window this path exists for — so the common
  // all-LOAD_ROUTE batch skips the read entirely. The driverId guard skips
  // rows handed off to another driver whose row still points at this
  // session (transferFrontierToDriver re-binds lazily).
  for (const [sessionId, group] of sessionGroups) {
    if (!group.some((p) => !p.loadId)) continue;
    const session = sessionCache.get(sessionId);
    if (!session || session.status !== 'active') continue;
    const watchRows = await ctx.db
      .query('loadTrackingState')
      .withIndex('by_session', (q) => q.eq('sessionId', sessionId))
      .collect();
    if (watchRows.length === 0) continue;
    const latest = group.reduce(newerPing);
    for (const row of watchRows) {
      if (row.driverId !== session.driverId) continue;
      considerTarget(sessionId, row.loadId, latest);
    }
  }

  for (const { loadId, loc } of evaluatorTargets.values()) {
    await ctx.scheduler.runAfter(0, internal.geofenceEvaluator.evaluateLatestPing, {
      loadId,
      sessionId: loc.sessionId,
      ping: {
        latitude: loc.latitude,
        longitude: loc.longitude,
        recordedAt: loc.recordedAt,
        accuracy: loc.accuracy,
      },
    });
  }

  // Phase 1: debounced driverSessions.lastPingAt patch. Reuses the
  // session doc already loaded into sessionCache during validation — no
  // extra reads. Only advances the timestamp; the comparison uses >
  // (not ≥) so concurrent batches can't oscillate the value. Per-session
  // OCC on the patch is Convex's guarantee — retries re-read and see the
  // newer lastPingAt, so they correctly no-op if the debounce is still
  // within window.
  for (const [sessionId, maxRecordedAt] of insertedMaxRecordedAtBySession) {
    const session = sessionCache.get(sessionId);
    if (!session) continue;
    const prev = session.lastPingAt ?? 0;
    if (maxRecordedAt > prev + LAST_PING_DEBOUNCE_MS) {
      await ctx.db.patch(sessionId, { lastPingAt: maxRecordedAt });
      console.warn(
        `[driverLocations.ingestBatch] session_last_ping_patched ` +
          `sessionId=${sessionId} newLastPingAt=${maxRecordedAt}`,
      );
    }
  }

  // Denormalized "latest ping per driver" upsert. Powers the dispatcher
  // helicopter-view reactive subscription so it doesn't have to scan the
  // full driverLocations history (~9k rows per org per 30min window) on
  // every new ping. One read + one patch/insert per driver per batch
  // (NOT per ping) — negligible compared to the per-ping write rate.
  //
  // recordedAt-guard: a stale ping (older than what we have stored) never
  // overwrites a fresher one. Concurrent batches for the same driver
  // (mobile + Samsara) OCC on this row; Convex's OCC retry re-reads, sees
  // the newer recordedAt, and the loser correctly no-ops.
  for (const [driverId, newest] of newestPingByDriver) {
    const existing = await ctx.db
      .query('driverLatestLocation')
      .withIndex('by_driver', (q) => q.eq('driverId', driverId))
      .first();

    if (existing && existing.recordedAt >= newest.recordedAt) {
      // Stored ping is at least as fresh — nothing to do.
      continue;
    }

    const row = {
      driverId,
      organizationId: orgId,
      latitude: newest.latitude,
      longitude: newest.longitude,
      accuracy: newest.accuracy,
      speed: newest.speed,
      heading: newest.heading,
      loadId: newest.loadId,
      sessionId: newest.sessionId,
      trackingType: newest.trackingType,
      recordedAt: newest.recordedAt,
      updatedAt: now,
    };

    if (existing) {
      await ctx.db.patch(existing._id, row);
    } else {
      await ctx.db.insert('driverLatestLocation', row);
    }
  }

  const skippedTotal =
    skippedDriver +
    skippedOrgMismatch +
    skippedLoad +
    skippedSession +
    skippedSessionEnded +
    skippedLegInactive +
    skippedShape +
    skippedDuplicate +
    skippedSkew;
  if (skippedTotal > 0) {
    // recordedAt range of the incoming batch, so repeated all-dup batches
    // are diagnosable from server logs alone: a client whose sync queue
    // is jammed re-sends the SAME window every time, while one draining
    // a backlog shows the window advancing batch over batch (2026-07-11
    // incident — 50/50-dup batches every ~2 min with no way to tell
    // which failure mode we were watching).
    let minRec = Infinity;
    let maxRec = -Infinity;
    for (const p of pings) {
      if (p.recordedAt < minRec) minRec = p.recordedAt;
      if (p.recordedAt > maxRec) maxRec = p.recordedAt;
    }
    const range =
      pings.length > 0
        ? `${new Date(minRec).toISOString()}..${new Date(maxRec).toISOString()}`
        : 'empty';
    console.warn(
      `[driverLocations.ingestBatch] Skipped ${skippedTotal}/${pings.length}:`,
      `driver=${skippedDriver}, orgMismatch=${skippedOrgMismatch} (passed="${orgId}"),`,
      `load=${skippedLoad}, session=${skippedSession}, sessionEnded=${skippedSessionEnded},`,
      `legInactive=${skippedLegInactive}, shape=${skippedShape},`,
      `dup=${skippedDuplicate}, skew=${skippedSkew}, internalDup=${internalDupCount},`,
      `recordedAtRange=${range}`
    );
  }

  // Categorize skips for the client. Everything except duplicates is
  // permanent — these conditions don't heal on retry. Reserved
  // transientlyRejected bucket stays at 0 for now; if we later add a
  // transient failure mode (e.g. rate-limit / temporary server error
  // surfaced via this path), we can route it here without changing the
  // contract.
  //
  // sessionEnded + legInactive both land in permanentlyRejected so the
  // mobile client marks the queued pings as synced (they will never
  // succeed on retry). The mobile push handler we ship in parallel
  // ensures these counters drop to ~0 once devices receive the
  // session-ended notification.
  const permanentlyRejected =
    skippedDriver +
    skippedOrgMismatch +
    skippedLoad +
    skippedSession +
    skippedSessionEnded +
    skippedLegInactive +
    skippedShape +
    skippedSkew;

  return {
    inserted,
    duplicates: skippedDuplicate,
    permanentlyRejected,
    transientlyRejected: 0,
    rejectedIndices,
  };
}

// ============================================
// PUBLIC MUTATIONS
// ============================================

/**
 * Batch insert locations from mobile app (Clerk-authenticated path).
 * Accepts both the legacy loadId-only shape and the new sessionId shape.
 */
export const batchInsertLocations = mutation({
  args: {
    locations: v.array(pingValidator),
    organizationId: v.string(),
  },
  returns: v.object({
    inserted: v.number(),
    duplicates: v.number(),
    permanentlyRejected: v.number(),
    transientlyRejected: v.number(),
    rejectedIndices: v.array(v.number()),
  }),
  handler: async (ctx, args) => {
    const identity = await ctx.auth.getUserIdentity();
    if (!identity) throw new Error('Not authenticated');
    return ingestBatch(ctx, args.locations, args.organizationId);
  },
});

/**
 * Internal mutation for inserting locations from the mobile HTTP endpoint.
 * Skips Clerk auth — the HTTP endpoint validates a static API key instead.
 * Same ingest logic as batchInsertLocations minus the identity check.
 */
export const internalBatchInsertLocations = internalMutation({
  args: {
    locations: v.array(pingValidator),
    organizationId: v.string(),
  },
  returns: v.object({
    inserted: v.number(),
    duplicates: v.number(),
    permanentlyRejected: v.number(),
    transientlyRejected: v.number(),
    rejectedIndices: v.array(v.number()),
  }),
  handler: async (ctx, args) => {
    return ingestBatch(ctx, args.locations, args.organizationId);
  },
});

// ============================================
// PUBLIC QUERIES
// ============================================

/**
 * Get latest location for all active drivers (helicopter view).
 * Returns drivers whose latest ping is within the last 30 minutes AND
 * is attached to a load (load-centric view — session-only pings are
 * filtered).
 *
 * Reads from driverLatestLocation (denormalized cache maintained by
 * ingestBatch) rather than scanning the full driverLocations history.
 * That collapses the reactive-subscription invalidation surface from
 * O(history rows in 30min window) to O(active drivers) — critical
 * because this query is subscribed to by helicopter-view + live-route-map
 * components on the dispatcher dashboard.
 */
export const getActiveDriverLocations = query({
  args: { organizationId: v.string(), nowMs: v.number() },
  returns: v.array(
    v.object({
      driverId: v.id('drivers'),
      driverName: v.string(),
      latitude: v.float64(),
      longitude: v.float64(),
      accuracy: v.optional(v.float64()),
      speed: v.optional(v.float64()),
      heading: v.optional(v.float64()),
      loadId: v.id('loadInformation'),
      loadInternalId: v.string(),
      trackingType: v.string(),
      recordedAt: v.float64(),
      truckUnitId: v.optional(v.string()),
    })
  ),
  handler: async (ctx, args) => {
    await assertCallerOwnsOrg(ctx, args.organizationId);
    const cutoff = args.nowMs - 30 * 60 * 1000;

    const latestRows = await ctx.db
      .query('driverLatestLocation')
      .withIndex('by_org_recordedAt', (q) =>
        q.eq('organizationId', args.organizationId).gte('recordedAt', cutoff)
      )
      .collect();

    const results: Array<{
      driverId: Id<'drivers'>;
      driverName: string;
      latitude: number;
      longitude: number;
      accuracy?: number;
      speed?: number;
      heading?: number;
      loadId: Id<'loadInformation'>;
      loadInternalId: string;
      trackingType: string;
      recordedAt: number;
      truckUnitId?: string;
    }> = [];

    for (const loc of latestRows) {
      // Session-only pings (no loadId) aren't included in this view — it's
      // a load-centric feed. They still occupy a driverLatestLocation row
      // (for other future consumers), but this query filters them out.
      if (!loc.loadId) continue;

      const driver = await ctx.db.get(loc.driverId);
      if (!driver || driver.isDeleted) continue;

      const load = await ctx.db.get(loc.loadId);
      if (!load) continue;

      let truckUnitId: string | undefined;
      if (driver.currentTruckId) {
        const truck = await ctx.db.get(driver.currentTruckId);
        if (truck && !truck.isDeleted) {
          truckUnitId = truck.unitId;
        }
      }

      results.push({
        driverId: loc.driverId,
        driverName: `${driver.firstName} ${driver.lastName}`,
        latitude: loc.latitude,
        longitude: loc.longitude,
        accuracy: loc.accuracy,
        speed: loc.speed,
        heading: loc.heading,
        loadId: loc.loadId,
        loadInternalId: load.internalId,
        trackingType: loc.trackingType,
        recordedAt: loc.recordedAt,
        truckUnitId,
      });
    }

    return results;
  },
});

/**
 * Get route history for a specific load (polyline data)
 * Returns all location points for drawing the route on a map
 */
export const getRouteHistoryForLoad = query({
  args: { loadId: v.id('loadInformation') },
  returns: v.array(
    v.object({
      latitude: v.float64(),
      longitude: v.float64(),
      speed: v.optional(v.float64()),
      heading: v.optional(v.float64()),
      recordedAt: v.float64(),
    })
  ),
  handler: async (ctx, args) => {
    const callerOrgId = await requireCallerOrgId(ctx);
    const load = await ctx.db.get(args.loadId);
    if (!load || load.workosOrgId !== callerOrgId) return [];

    const locations = await ctx.db
      .query('driverLocations')
      .withIndex('by_load', (q) => q.eq('loadId', args.loadId))
      .order('asc')
      .collect();

    return locations.map((loc) => ({
      latitude: loc.latitude,
      longitude: loc.longitude,
      speed: loc.speed,
      heading: loc.heading,
      recordedAt: loc.recordedAt,
    }));
  },
});

/**
 * Get detailed route history for GPS diagnostics page.
 * Returns all fields including accuracy and createdAt (for sync delay analysis).
 */
export const getDetailedRouteHistoryForLoad = query({
  args: { loadId: v.id('loadInformation') },
  returns: v.array(
    v.object({
      _id: v.id('driverLocations'),
      latitude: v.float64(),
      longitude: v.float64(),
      accuracy: v.optional(v.float64()),
      speed: v.optional(v.float64()),
      heading: v.optional(v.float64()),
      recordedAt: v.float64(),
      createdAt: v.float64(),
    })
  ),
  handler: async (ctx, args) => {
    const callerOrgId = await requireCallerOrgId(ctx);
    const load = await ctx.db.get(args.loadId);
    if (!load || load.workosOrgId !== callerOrgId) return [];

    const locations = await ctx.db
      .query('driverLocations')
      .withIndex('by_load', (q) => q.eq('loadId', args.loadId))
      .order('asc')
      .collect();

    return locations.map((loc) => ({
      _id: loc._id,
      latitude: loc.latitude,
      longitude: loc.longitude,
      accuracy: loc.accuracy,
      speed: loc.speed,
      heading: loc.heading,
      recordedAt: loc.recordedAt,
      createdAt: loc.createdAt,
    }));
  },
});

// ============================================
// INTERNAL QUERIES (for archival cron)
// ============================================

/**
 * Get locations older than cutoff time for archival
 */
export const getLocationsOlderThan = internalQuery({
  args: {
    cutoffTime: v.float64(),
    limit: v.number(),
  },
  returns: v.array(
    v.object({
      _id: v.id('driverLocations'),
      driverId: v.id('drivers'),
      // Optional: legacy rows always have it; session-only pings don't.
      loadId: v.optional(v.id('loadInformation')),
      sessionId: v.optional(v.id('driverSessions')),
      organizationId: v.string(),
      latitude: v.float64(),
      longitude: v.float64(),
      accuracy: v.optional(v.float64()),
      speed: v.optional(v.float64()),
      heading: v.optional(v.float64()),
      trackingType: v.union(v.literal('LOAD_ROUTE'), v.literal('SESSION_ROUTE')),
      recordedAt: v.float64(),
      createdAt: v.float64(),
    })
  ),
  handler: async (ctx, args) => {
    // Range-bound on the dedicated by_created index so we read AT MOST `limit`
    // rows (the oldest, in createdAt order). The previous form used
    // by_org_created with no range and a .filter() — that scans the whole
    // table in memory and, once archival has caught up (few/no rows past the
    // cutoff), reads every document/byte to confirm there's nothing left,
    // which is what neared the per-query read limit.
    const oldLocations = await ctx.db
      .query('driverLocations')
      .withIndex('by_created', (q) => q.lt('createdAt', args.cutoffTime))
      .take(args.limit);

    return oldLocations.map((loc) => ({
      _id: loc._id,
      driverId: loc.driverId,
      loadId: loc.loadId,
      sessionId: loc.sessionId,
      organizationId: loc.organizationId,
      latitude: loc.latitude,
      longitude: loc.longitude,
      accuracy: loc.accuracy,
      speed: loc.speed,
      heading: loc.heading,
      trackingType: loc.trackingType,
      recordedAt: loc.recordedAt,
      createdAt: loc.createdAt,
    }));
  },
});

// ============================================
// INTERNAL MUTATIONS (for archival cron)
// ============================================

/**
 * Delete locations that have been archived
 */
export const deleteArchivedLocations = internalMutation({
  args: {
    ids: v.array(v.id('driverLocations')),
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

// ============================================
// ARCHIVAL — orchestrator moved to convex/gpsArchive.ts
// This file keeps only the helper query + mutation it calls.
// ============================================

/**
 * Write an audit row after a successful archive upload. Internal; only the
 * gpsArchive action calls this, between the S3 PUT and the row delete. If
 * the process crashes between upload and this write, the next cron run
 * will re-upload the same range — idempotent because S3 object keys are
 * deterministic per (orgId, date, hour).
 */
export const logArchiveUpload = internalMutation({
  args: {
    organizationId: v.string(),
    date: v.string(),
    hour: v.number(),
    s3Bucket: v.string(),
    s3Key: v.string(),
    rowCount: v.number(),
    byteCount: v.number(),
    minRecordedAt: v.number(),
    maxRecordedAt: v.number(),
  },
  returns: v.null(),
  handler: async (ctx, args) => {
    await ctx.db.insert('gpsArchiveLog', {
      ...args,
      archivedAt: Date.now(),
    });
    return null;
  },
});

/**
 * Called by the retrieval action (gpsArchive.getArchivedPositionFiles) to
 * find which archive files cover a requested [from, to] time window.
 *
 * Lives here (not in gpsArchive.ts) because gpsArchive.ts uses `'use node'`
 * and can only contain actions. Keeps the query close to the other archive
 * database helpers.
 */
export const listArchivedFilesInWindow = internalQuery({
  args: {
    organizationId: v.string(),
    from: v.number(),
    to: v.number(),
  },
  returns: v.array(
    v.object({
      date: v.string(),
      hour: v.number(),
      s3Bucket: v.string(),
      s3Key: v.string(),
      rowCount: v.number(),
      byteCount: v.number(),
      minRecordedAt: v.number(),
      maxRecordedAt: v.number(),
    })
  ),
  handler: async (ctx, args) => {
    // Range-scan by the archive log's maxRecordedAt — every file whose
    // maxRecordedAt is ≥ args.from MIGHT overlap the window. We further
    // filter by minRecordedAt in-memory to exclude files whose recorded
    // range falls entirely past args.to.
    const candidates = await ctx.db
      .query('gpsArchiveLog')
      .withIndex('by_org_window', (q) =>
        q.eq('organizationId', args.organizationId).gte('maxRecordedAt', args.from)
      )
      .collect();

    return candidates
      .filter((f) => f.minRecordedAt <= args.to)
      .map((f) => ({
        date: f.date,
        hour: f.hour,
        s3Bucket: f.s3Bucket,
        s3Key: f.s3Key,
        rowCount: f.rowCount,
        byteCount: f.byteCount,
        minRecordedAt: f.minRecordedAt,
        maxRecordedAt: f.maxRecordedAt,
      }));
  },
});

// ============================================
// DRIVER LATEST LOCATION — GC
// ============================================

/**
 * Daily GC for the driverLatestLocation denormalized cache. Drivers who
 * haven't pinged in 30 days get their cache row removed. If they ever
 * ping again, ingestBatch will re-insert. Keeps the table bounded
 * against driver churn (deleted drivers, seasonal fleets, etc.).
 *
 * Batched + paginated so a single mutation tick never exceeds Convex's
 * per-mutation read/write caps. Returns continueCursor so the orchestrator
 * action can loop until done.
 */
const LATEST_LOCATION_TTL_MS = 30 * 24 * 60 * 60 * 1000; // 30 days
const LATEST_LOCATION_GC_BATCH_SIZE = 500;

export const pruneStaleDriverLatestLocationBatch = internalMutation({
  args: { cursor: v.optional(v.string()) },
  returns: v.object({
    scanned: v.number(),
    pruned: v.number(),
    isDone: v.boolean(),
    continueCursor: v.union(v.string(), v.null()),
  }),
  handler: async (ctx, args) => {
    const cutoff = Date.now() - LATEST_LOCATION_TTL_MS;
    const result = await ctx.db
      .query('driverLatestLocation')
      .paginate({
        cursor: args.cursor ?? null,
        numItems: LATEST_LOCATION_GC_BATCH_SIZE,
      });

    let pruned = 0;
    for (const row of result.page) {
      if (row.recordedAt < cutoff) {
        await ctx.db.delete(row._id);
        pruned++;
      }
    }

    return {
      scanned: result.page.length,
      pruned,
      isDone: result.isDone,
      continueCursor: result.isDone ? null : result.continueCursor,
    };
  },
});

/**
 * Cron orchestrator. Loops the batch mutation until done. Bounded by a
 * MAX_ITERATIONS safety cap so a stuck pagination cursor can't infinite-
 * loop and burn the action budget.
 */
export const pruneStaleDriverLatestLocation = internalAction({
  args: {},
  returns: v.object({
    totalScanned: v.number(),
    totalPruned: v.number(),
  }),
  handler: async (ctx) => {
    const MAX_ITERATIONS = 20_000;
    let cursor: string | null = null;
    let totalScanned = 0;
    let totalPruned = 0;
    let iterations = 0;

    while (iterations < MAX_ITERATIONS) {
      iterations++;
      const batch: {
        scanned: number;
        pruned: number;
        isDone: boolean;
        continueCursor: string | null;
      } = await ctx.runMutation(
        internal.driverLocations.pruneStaleDriverLatestLocationBatch,
        { cursor: cursor ?? undefined },
      );
      totalScanned += batch.scanned;
      totalPruned += batch.pruned;
      if (batch.isDone) break;
      cursor = batch.continueCursor;
    }

    if (iterations >= MAX_ITERATIONS) {
      console.warn(
        `[driverLatestLocation.gc] iteration cap hit: scanned=${totalScanned} pruned=${totalPruned} ` +
          `(remaining rows will be picked up on tomorrow's cron run)`,
      );
    }

    console.log(
      `[driverLatestLocation.gc] scanned=${totalScanned} pruned=${totalPruned}`,
    );
    return { totalScanned, totalPruned };
  },
});
