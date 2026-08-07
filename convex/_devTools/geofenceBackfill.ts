import { v } from 'convex/values';
import { internalAction, internalMutation, type MutationCtx } from '../_generated/server';
import { internal } from '../_generated/api';
import type { Doc, Id } from '../_generated/dataModel';

// Self-references through `internal` from handlers in the same file create
// a TS inference cycle that degrades types across the whole generated api
// (same issue facetSimulator hit — same fix). Runtime behavior unchanged.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const self: any = (internal as any)['_devTools/geofenceBackfill'];
import {
  calculateDistanceMeters,
  OUTER_RING_METERS,
  INNER_RING_METERS,
  GEOFENCE_MAX_ACCURACY_METERS,
  exitRadiusFor,
} from '../lib/geo';
import { facilityArrivalRadius } from '../loadTrackingState';

/**
 * Geofence event backfill (DEV/OPS TOOL).
 *
 * Replays each completed load's stored GPS pings through the same ring /
 * debounce / accuracy semantics as the live evaluator
 * (convex/geofenceEvaluator.ts) and inserts the events the live path would
 * have produced had it been deployed at the time. Exists because:
 *   - DEPARTED detection shipped later than APPROACHING/ARRIVED, so
 *     historical loads have no departure timestamps at all;
 *   - the old frontier logic skipped stop 2's arrival events entirely.
 *
 * Guarantees:
 *   - Append-only: existing events are never modified. The same
 *     one-event-per-(load, stop, type) dedup as the live path means live
 *     events always win and re-runs are idempotent.
 *   - Every inserted event is flagged `backfilled: true` and is computed
 *     exclusively from pings the trucks actually recorded.
 *   - Dry-run by default: `commit: true` is required to write anything.
 *
 * Usage (from the project root, against the deployment you mean to touch):
 *
 *   # Dry run — report what WOULD be inserted for the last 30 days
 *   npx convex run _devTools/geofenceBackfill:run \
 *     '{"organizationId": "org_..."}'
 *
 *   # Narrower window / cap the number of loads examined
 *   npx convex run _devTools/geofenceBackfill:run \
 *     '{"organizationId": "org_...", "sinceDays": 14, "maxLoads": 50}'
 *
 *   # Commit — actually insert (run the dry run first!). Writes are gated
 *   # behind the deployment env flag, same as facetSimulator:
 *   #   npx convex env set OTOQA_ENABLE_DEV_TOOLS true
 *   npx convex run _devTools/geofenceBackfill:run \
 *     '{"organizationId": "org_...", "commit": true}'
 *
 *   # Orphaned loadTrackingState rows (frontier rows whose load is long
 *   # done — leftovers from the pre-departure-watch era). List, then delete:
 *   npx convex run _devTools/geofenceBackfill:cleanupTrackingState '{}'
 *   npx convex run _devTools/geofenceBackfill:cleanupTrackingState '{"commit": true}'
 *
 *   # One-time repair of DEPARTED event positions. Events stamped before
 *   # the candidate-fix change carried the CONFIRMING ping's coordinates
 *   # with the CANDIDATE ping's timestamp, so map pins sat down-road from
 *   # the actual crossing. The candidate ping still exists in
 *   # driverLocations (event.triggeredAt === ping.recordedAt exactly), so
 *   # this re-stamps position/accuracy/distance from the true ping.
 *   # Correction of a stamping bug — timestamps are never altered.
 *   npx convex run _devTools/geofenceBackfill:repairDepartedPositions '{"organizationId": "org_..."}'
 *   npx convex run _devTools/geofenceBackfill:repairDepartedPositions '{"organizationId": "org_...", "commit": true}'
 *
 * Limits: only pings still in hot storage are replayed (30-day archive
 * window — see convex/gpsArchive.ts). Per-load ping reads are capped; a
 * load that exceeds the cap is reported with a warning instead of being
 * silently half-processed.
 */

// Per-load read caps. A multi-day load at the mobile cadence (~1 ping/30s
// while moving) stays well under this; the cap exists so one pathological
// load can't blow the mutation's read budget.
const MAX_PINGS_PER_LOAD = 8000;
// Post-checkout pings are SESSION_ROUTE (no loadId); the final stop's
// departure is resolved from the session's pings in this window after the
// last checkout.
const POST_CHECKOUT_TAIL_MS = 4 * 60 * 60 * 1000;
const MAX_TAIL_PINGS = 500;

type ReplayPing = {
  latitude: number;
  longitude: number;
  recordedAt: number;
  accuracy?: number;
  sessionId?: Id<'driverSessions'>;
  driverId: Id<'drivers'>;
};

type ReplayStop = {
  sequenceNumber: number;
  stopType: 'PICKUP' | 'DELIVERY' | 'DETOUR';
  status?: string;
  latitude?: number;
  longitude?: number;
  checkedInAt?: number; // parsed ms
  // Facility ARRIVED-radius override (facilities.radiusMeters); absent =
  // INNER_RING_METERS. Exit radius derives via exitRadiusFor, mirroring
  // the live snapshot in setFrontierOnCheckIn.
  arrivalRadiusMeters?: number;
};

export type ReplayEvent = {
  stopSequenceNumber: number;
  eventType: 'APPROACHING' | 'ARRIVED' | 'DEPARTED';
  triggeredAt: number;
  latitude: number;
  longitude: number;
  distanceMeters: number;
  accuracy?: number;
  sessionId?: Id<'driverSessions'>;
  driverId: Id<'drivers'>;
};

/**
 * Pure replay of the live evaluator's state machine over a load's history.
 *
 * The simulation walks the load's check-ins chronologically. Each check-in
 * re-arms the watches exactly like loadTrackingState.setFrontierOnCheckIn:
 *   - arrival watch → next non-detour, non-canceled stop with coordinates
 *     (by sequence) after the checked-in stop;
 *   - departure watch → the checked-in stop (armedAt = check-in time).
 * Pings between one check-in and the next are evaluated against both
 * watches with the live thresholds and guards (candidate/confirm exit
 * debounce, accuracy gate, no pings at/before armedAt, stale pings can't
 * reset a newer candidate).
 *
 * Exported for unit tests.
 */
export function replayLoadEvents(stops: ReplayStop[], pings: ReplayPing[]): ReplayEvent[] {
  const events: ReplayEvent[] = [];
  const emitted = new Set<string>(); // `${seq}|${type}` — one per stop per type
  const emit = (e: ReplayEvent) => {
    const key = `${e.stopSequenceNumber}|${e.eventType}`;
    if (emitted.has(key)) return;
    emitted.add(key);
    events.push(e);
  };

  const bySequence = [...stops].sort((a, b) => a.sequenceNumber - b.sequenceNumber);
  const checkIns = stops
    .filter((s) => s.checkedInAt !== undefined)
    .sort((a, b) => a.checkedInAt! - b.checkedInAt!);
  if (checkIns.length === 0) return events; // never checked in — live path would have no state either

  const sortedPings = [...pings].sort((a, b) => a.recordedAt - b.recordedAt);

  const nextArrivalTarget = (afterSeq: number): ReplayStop | undefined =>
    bySequence.find(
      (s) =>
        s.sequenceNumber > afterSeq &&
        s.stopType !== 'DETOUR' &&
        s.status !== 'Canceled' &&
        s.latitude !== undefined &&
        s.longitude !== undefined,
    );

  for (let i = 0; i < checkIns.length; i++) {
    const stop = checkIns[i];
    const armedAt = stop.checkedInAt!;
    const intervalEnd = checkIns[i + 1]?.checkedInAt ?? Number.POSITIVE_INFINITY;

    const arrivalTarget = nextArrivalTarget(stop.sequenceNumber);
    let approachingFired = false;
    let arrivedFired = false;

    const departureArmed = stop.latitude !== undefined && stop.longitude !== undefined;
    const exitRadius = exitRadiusFor(stop.arrivalRadiusMeters);
    let departureCandidate:
      | { at: number; latitude: number; longitude: number; accuracy?: number }
      | undefined;
    let departureDone = false;

    for (const ping of sortedPings) {
      if (ping.recordedAt <= armedAt || ping.recordedAt >= intervalEnd) continue;

      // Arrival watch — same thresholds as the live evaluator; no accuracy
      // gate on arrivals (live parity).
      if (arrivalTarget && (!approachingFired || !arrivedFired)) {
        const d = calculateDistanceMeters(
          ping.latitude,
          ping.longitude,
          arrivalTarget.latitude!,
          arrivalTarget.longitude!,
        );
        if (d < OUTER_RING_METERS && !approachingFired) {
          approachingFired = true;
          emit({
            stopSequenceNumber: arrivalTarget.sequenceNumber,
            eventType: 'APPROACHING',
            triggeredAt: ping.recordedAt,
            latitude: ping.latitude,
            longitude: ping.longitude,
            distanceMeters: d,
            accuracy: ping.accuracy,
            sessionId: ping.sessionId,
            driverId: ping.driverId,
          });
        }
        if (d < (arrivalTarget.arrivalRadiusMeters ?? INNER_RING_METERS) && !arrivedFired) {
          arrivedFired = true;
          emit({
            stopSequenceNumber: arrivalTarget.sequenceNumber,
            eventType: 'ARRIVED',
            triggeredAt: ping.recordedAt,
            latitude: ping.latitude,
            longitude: ping.longitude,
            distanceMeters: d,
            accuracy: ping.accuracy,
            sessionId: ping.sessionId,
            driverId: ping.driverId,
          });
        }
      }

      // Departure watch — candidate/confirm debounce with accuracy gate.
      if (departureArmed && !departureDone) {
        const accuracyOk =
          ping.accuracy === undefined || ping.accuracy <= GEOFENCE_MAX_ACCURACY_METERS;
        if (accuracyOk) {
          const d = calculateDistanceMeters(
            ping.latitude,
            ping.longitude,
            stop.latitude!,
            stop.longitude!,
          );
          if (d > exitRadius) {
            if (departureCandidate === undefined) {
              departureCandidate = {
                at: ping.recordedAt,
                latitude: ping.latitude,
                longitude: ping.longitude,
                accuracy: ping.accuracy,
              };
            } else if (ping.recordedAt > departureCandidate.at) {
              departureDone = true;
              // Live parity: the event carries the CANDIDATE fix — where
              // the truck actually crossed out — not the confirming ping.
              emit({
                stopSequenceNumber: stop.sequenceNumber,
                eventType: 'DEPARTED',
                triggeredAt: departureCandidate.at,
                latitude: departureCandidate.latitude,
                longitude: departureCandidate.longitude,
                distanceMeters: calculateDistanceMeters(
                  departureCandidate.latitude,
                  departureCandidate.longitude,
                  stop.latitude!,
                  stop.longitude!,
                ),
                accuracy: departureCandidate.accuracy,
                sessionId: ping.sessionId,
                driverId: ping.driverId,
              });
            }
          } else if (departureCandidate !== undefined && ping.recordedAt > departureCandidate.at) {
            departureCandidate = undefined;
          }
        }
      }
    }
  }

  return events;
}

const loadReportValidator = v.object({
  loadId: v.id('loadInformation'),
  internalId: v.string(),
  pingCount: v.number(),
  existingEvents: v.number(),
  candidates: v.array(
    v.object({
      stopSequenceNumber: v.number(),
      eventType: v.string(),
      triggeredAt: v.number(),
    }),
  ),
  inserted: v.number(),
  warnings: v.array(v.string()),
});

/**
 * Analyze (and with commit=true, backfill) one load. Bounded reads: the
 * load's stops, its existing events, its LOAD_ROUTE pings (capped), and a
 * capped session tail after the last checkout for the final departure.
 */
export const analyzeLoad = internalMutation({
  args: {
    loadId: v.id('loadInformation'),
    commit: v.boolean(),
  },
  returns: loadReportValidator,
  handler: async (ctx, args) => {
    if (args.commit && process.env.OTOQA_ENABLE_DEV_TOOLS !== 'true') {
      throw new Error(
        'Commit disabled in this deployment — set OTOQA_ENABLE_DEV_TOOLS=true to enable writes ' +
          '(dry runs need no flag)',
      );
    }
    const warnings: string[] = [];
    const load = await ctx.db.get(args.loadId);
    if (!load) throw new Error('Load not found');

    const stopDocs = await ctx.db
      .query('loadStops')
      .withIndex('by_load', (q) => q.eq('loadId', args.loadId))
      .collect();

    const parseMs = (iso?: string): number | undefined => {
      if (!iso) return undefined;
      const ms = new Date(iso).getTime();
      return Number.isFinite(ms) ? ms : undefined;
    };
    const stops: ReplayStop[] = await Promise.all(
      stopDocs.map(async (s) => ({
        sequenceNumber: s.sequenceNumber,
        stopType: s.stopType,
        status: s.status,
        latitude: s.latitude,
        longitude: s.longitude,
        checkedInAt: parseMs(s.checkedInAt),
        arrivalRadiusMeters: await facilityArrivalRadius(ctx, s),
      })),
    );
    for (const s of stopDocs) {
      if (s.latitude === undefined && s.stopType !== 'DETOUR') {
        warnings.push(`stop ${s.sequenceNumber} has no coordinates`);
      }
    }

    const pingDocs = await ctx.db
      .query('driverLocations')
      .withIndex('by_load', (q) => q.eq('loadId', args.loadId))
      .take(MAX_PINGS_PER_LOAD);
    if (pingDocs.length === MAX_PINGS_PER_LOAD) {
      warnings.push(`ping cap hit (${MAX_PINGS_PER_LOAD}); replay may be incomplete`);
    }

    // Session tail for the final stop's departure: post-checkout pings have
    // no loadId, so pull them via the session of the load's last pings.
    const lastCheckoutMs = stopDocs
      .map((s) => parseMs(s.checkedOutAt))
      .filter((t): t is number => t !== undefined)
      .sort((a, b) => b - a)[0];
    const tailSessionId = [...pingDocs].reverse().find((p) => p.sessionId)?.sessionId;
    let tailPings: Doc<'driverLocations'>[] = [];
    if (lastCheckoutMs !== undefined && tailSessionId) {
      tailPings = await ctx.db
        .query('driverLocations')
        .withIndex('by_session_time', (q) =>
          q
            .eq('sessionId', tailSessionId)
            .gt('recordedAt', lastCheckoutMs)
            .lt('recordedAt', lastCheckoutMs + POST_CHECKOUT_TAIL_MS),
        )
        .take(MAX_TAIL_PINGS);
    } else if (lastCheckoutMs !== undefined) {
      warnings.push('no sessionId on pings; final-stop departure not replayable');
    }

    const toReplayPing = (p: Doc<'driverLocations'>): ReplayPing => ({
      latitude: p.latitude,
      longitude: p.longitude,
      recordedAt: p.recordedAt,
      accuracy: p.accuracy,
      sessionId: p.sessionId,
      driverId: p.driverId,
    });
    const replayed = replayLoadEvents(stops, [...pingDocs, ...tailPings].map(toReplayPing));

    // Dedup against ALL existing events for the load (live ones win).
    const existing = await ctx.db
      .query('geofenceEvents')
      .withIndex('by_load', (q) => q.eq('loadId', args.loadId))
      .collect();
    const existingKeys = new Set(existing.map((e) => `${e.stopSequenceNumber}|${e.eventType}`));
    const fresh = replayed.filter(
      (e) => !existingKeys.has(`${e.stopSequenceNumber}|${e.eventType}`),
    );

    let inserted = 0;
    if (args.commit) {
      for (const e of fresh) {
        if (!e.sessionId) {
          warnings.push(
            `stop ${e.stopSequenceNumber} ${e.eventType}: ping has no sessionId; skipped`,
          );
          continue;
        }
        await ctx.db.insert('geofenceEvents', {
          sessionId: e.sessionId,
          loadId: args.loadId,
          stopSequenceNumber: e.stopSequenceNumber,
          driverId: e.driverId,
          organizationId: load.workosOrgId,
          eventType: e.eventType,
          triggeredAt: e.triggeredAt,
          latitude: e.latitude,
          longitude: e.longitude,
          distanceMeters: e.distanceMeters,
          accuracy: e.accuracy,
          backfilled: true,
        });
        inserted++;
      }
    }

    return {
      loadId: args.loadId,
      internalId: load.internalId,
      pingCount: pingDocs.length + tailPings.length,
      existingEvents: existing.length,
      candidates: fresh.map((e) => ({
        stopSequenceNumber: e.stopSequenceNumber,
        eventType: e.eventType,
        triggeredAt: e.triggeredAt,
      })),
      inserted,
      warnings,
    };
  },
});

/**
 * List completed loads in the window that still have pings to replay.
 */
export const listCandidateLoads = internalMutation({
  args: {
    organizationId: v.string(),
    sinceMs: v.number(),
    maxLoads: v.number(),
  },
  returns: v.array(v.id('loadInformation')),
  handler: async (ctx, args) => {
    const loads = await ctx.db
      .query('loadInformation')
      .withIndex('by_status', (q) => q.eq('workosOrgId', args.organizationId).eq('status', 'Completed'))
      .order('desc')
      .take(1000);
    return loads
      .filter((l) => (l.deliveredAt ?? l.updatedAt) >= args.sinceMs)
      .slice(0, args.maxLoads)
      .map((l) => l._id);
  },
});

/**
 * Orchestrator. Dry-run by default; pass commit=true only after reviewing
 * the dry-run report.
 */
export const run = internalAction({
  args: {
    organizationId: v.string(),
    sinceDays: v.optional(v.number()), // default 30 (the hot-storage window)
    maxLoads: v.optional(v.number()), // default 200
    commit: v.optional(v.boolean()), // default false (dry run)
  },
  returns: v.object({
    mode: v.string(),
    loadsExamined: v.number(),
    loadsWithCandidates: v.number(),
    totalCandidates: v.number(),
    totalInserted: v.number(),
    byEventType: v.record(v.string(), v.number()),
    loads: v.array(loadReportValidator),
  }),
  handler: async (ctx, args) => {
    const commit = args.commit ?? false;
    const sinceMs = Date.now() - (args.sinceDays ?? 30) * 24 * 60 * 60 * 1000;

    const loadIds: Id<'loadInformation'>[] = await ctx.runMutation(self.listCandidateLoads, {
      organizationId: args.organizationId,
      sinceMs,
      maxLoads: args.maxLoads ?? 200,
    });

    type LoadReport = {
      loadId: Id<'loadInformation'>;
      internalId: string;
      pingCount: number;
      existingEvents: number;
      candidates: { stopSequenceNumber: number; eventType: string; triggeredAt: number }[];
      inserted: number;
      warnings: string[];
    };
    const reports: LoadReport[] = [];
    const byEventType: Record<string, number> = {};
    let totalCandidates = 0;
    let totalInserted = 0;
    for (const loadId of loadIds) {
      const report: LoadReport = await ctx.runMutation(self.analyzeLoad, {
        loadId,
        commit,
      });
      reports.push(report);
      totalCandidates += report.candidates.length;
      totalInserted += report.inserted;
      for (const c of report.candidates) {
        byEventType[c.eventType] = (byEventType[c.eventType] ?? 0) + 1;
      }
      if (report.candidates.length > 0) {
        console.log(
          `[geofenceBackfill] ${commit ? 'INSERTED' : 'would insert'} ` +
            `${report.candidates.length} events for load ${report.internalId} ` +
            `(${report.candidates.map((c) => `${c.eventType}@stop${c.stopSequenceNumber}`).join(', ')})`,
        );
      }
    }

    const summary = {
      mode: commit ? 'COMMIT' : 'DRY_RUN',
      loadsExamined: loadIds.length,
      loadsWithCandidates: reports.filter((r) => r.candidates.length > 0).length,
      totalCandidates,
      totalInserted,
      byEventType,
      loads: reports.filter((r) => r.candidates.length > 0 || r.warnings.length > 0),
    };
    console.log(
      `[geofenceBackfill] ${summary.mode}: ${summary.totalCandidates} candidate events ` +
        `across ${summary.loadsWithCandidates}/${summary.loadsExamined} loads; ` +
        `inserted ${summary.totalInserted}`,
    );
    return summary;
  },
});

// Events whose stored position is within this of the true ping are left
// alone — float jitter, not the confirming-ping bug.
const REPAIR_TOLERANCE_METERS = 25;

/**
 * Core of repairDepartedPositions, exported for tests. Finds each DEPARTED
 * event's triggering ping (exact recordedAt === triggeredAt match, via the
 * event's session then the load as fallback) and re-stamps the event's
 * position, accuracy, and stop distance from it.
 */
export async function repairDepartedEventsCore(
  ctx: MutationCtx,
  args: { organizationId: string; commit: boolean; maxEvents: number },
): Promise<{
  mode: string;
  examined: number;
  repaired: number;
  alreadyAccurate: number;
  skippedNoPing: number;
  skippedNoStop: number;
  samples: Array<{ loadId: Id<'loadInformation'>; stopSequenceNumber: number; movedMeters: number }>;
}> {
  const all = await ctx.db.query('geofenceEvents').take(10_000);
  const departed = all
    .filter((e) => e.organizationId === args.organizationId && e.eventType === 'DEPARTED')
    .slice(0, args.maxEvents);

  const stopsCache = new Map<string, Doc<'loadStops'>[]>();
  const stopsForLoad = async (loadId: Id<'loadInformation'>) => {
    const key = loadId as string;
    if (!stopsCache.has(key)) {
      stopsCache.set(
        key,
        await ctx.db
          .query('loadStops')
          .withIndex('by_load', (q) => q.eq('loadId', loadId))
          .collect(),
      );
    }
    return stopsCache.get(key)!;
  };

  let repaired = 0;
  let alreadyAccurate = 0;
  let skippedNoPing = 0;
  let skippedNoStop = 0;
  const samples: Array<{
    loadId: Id<'loadInformation'>;
    stopSequenceNumber: number;
    movedMeters: number;
  }> = [];

  for (const event of departed) {
    // The triggering (candidate) ping: recordedAt matches the event's
    // triggeredAt exactly — both were copied from the same device fix.
    const ping =
      (await ctx.db
        .query('driverLocations')
        .withIndex('by_session_time', (q) =>
          q.eq('sessionId', event.sessionId).eq('recordedAt', event.triggeredAt),
        )
        .first()) ??
      (await ctx.db
        .query('driverLocations')
        .withIndex('by_load', (q) =>
          q.eq('loadId', event.loadId).eq('recordedAt', event.triggeredAt),
        )
        .first());
    if (!ping) {
      skippedNoPing++; // archived out of hot storage — position unrecoverable
      continue;
    }

    const movedMeters = calculateDistanceMeters(
      event.latitude,
      event.longitude,
      ping.latitude,
      ping.longitude,
    );
    if (movedMeters < REPAIR_TOLERANCE_METERS) {
      alreadyAccurate++;
      continue;
    }

    const stop = (await stopsForLoad(event.loadId)).find(
      (s) => s.sequenceNumber === event.stopSequenceNumber,
    );
    if (!stop || stop.latitude === undefined || stop.longitude === undefined) {
      skippedNoStop++;
      continue;
    }

    if (args.commit) {
      await ctx.db.patch(event._id, {
        latitude: ping.latitude,
        longitude: ping.longitude,
        accuracy: ping.accuracy,
        distanceMeters: calculateDistanceMeters(
          ping.latitude,
          ping.longitude,
          stop.latitude,
          stop.longitude,
        ),
      });
    }
    repaired++;
    if (samples.length < 10) {
      samples.push({
        loadId: event.loadId,
        stopSequenceNumber: event.stopSequenceNumber,
        movedMeters: Math.round(movedMeters),
      });
    }
  }

  return {
    mode: args.commit ? 'COMMIT' : 'DRY_RUN',
    examined: departed.length,
    repaired,
    alreadyAccurate,
    skippedNoPing,
    skippedNoStop,
    samples,
  };
}

/**
 * Re-stamp pre-fix DEPARTED events onto their true triggering ping. See
 * the header doc; dry-run by default, commit gated on the env flag.
 */
export const repairDepartedPositions = internalMutation({
  args: {
    organizationId: v.string(),
    commit: v.optional(v.boolean()),
    maxEvents: v.optional(v.number()),
  },
  returns: v.object({
    mode: v.string(),
    examined: v.number(),
    repaired: v.number(),
    alreadyAccurate: v.number(),
    skippedNoPing: v.number(),
    skippedNoStop: v.number(),
    samples: v.array(
      v.object({
        loadId: v.id('loadInformation'),
        stopSequenceNumber: v.number(),
        movedMeters: v.number(),
      }),
    ),
  }),
  handler: async (ctx, args) => {
    const commit = args.commit ?? false;
    if (commit && process.env.OTOQA_ENABLE_DEV_TOOLS !== 'true') {
      throw new Error(
        'Commit disabled in this deployment — set OTOQA_ENABLE_DEV_TOOLS=true to enable writes ' +
          '(dry runs need no flag)',
      );
    }
    const result = await repairDepartedEventsCore(ctx, {
      organizationId: args.organizationId,
      commit,
      maxEvents: args.maxEvents ?? 2000,
    });
    console.log(
      `[geofenceBackfill.repairDepartedPositions] ${result.mode}: ` +
        `${result.repaired} ${commit ? 'repaired' : 'would repair'} of ${result.examined} DEPARTED events ` +
        `(${result.alreadyAccurate} already accurate, ${result.skippedNoPing} pings archived)`,
    );
    return result;
  },
});

/**
 * Sweep loadTrackingState rows whose load is finished (Completed/Canceled)
 * — orphans from the pre-departure-watch era, when session-end paths could
 * leave the frontier row behind. List by default; commit=true deletes.
 */
export const cleanupTrackingState = internalMutation({
  args: {
    commit: v.optional(v.boolean()),
  },
  returns: v.object({
    mode: v.string(),
    examined: v.number(),
    orphaned: v.array(
      v.object({
        loadId: v.id('loadInformation'),
        internalId: v.union(v.string(), v.null()),
        loadStatus: v.union(v.string(), v.null()),
        ageDays: v.number(),
      }),
    ),
    deleted: v.number(),
  }),
  handler: async (ctx, args) => {
    const commit = args.commit ?? false;
    if (commit && process.env.OTOQA_ENABLE_DEV_TOOLS !== 'true') {
      throw new Error(
        'Commit disabled in this deployment — set OTOQA_ENABLE_DEV_TOOLS=true to enable writes ' +
          '(dry runs need no flag)',
      );
    }
    const rows = await ctx.db.query('loadTrackingState').collect();
    const orphaned = [];
    let deleted = 0;
    for (const row of rows) {
      const load = await ctx.db.get(row.loadId);
      const finished =
        !load || load.status === 'Completed' || load.status === 'Canceled' || load.status === 'Expired';
      if (!finished) continue;
      orphaned.push({
        loadId: row.loadId,
        internalId: load?.internalId ?? null,
        loadStatus: load?.status ?? null,
        ageDays: Math.round((Date.now() - row._creationTime) / 86_400_000),
      });
      if (commit) {
        await ctx.db.delete(row._id);
        deleted++;
      }
    }
    console.log(
      `[geofenceBackfill.cleanupTrackingState] ${commit ? 'DELETED' : 'found'} ` +
        `${orphaned.length} orphaned rows of ${rows.length} total`,
    );
    return { mode: commit ? 'COMMIT' : 'DRY_RUN', examined: rows.length, orphaned, deleted };
  },
});
