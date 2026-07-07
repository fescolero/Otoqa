/**
 * Sync-latency diagnostic for a single driver.
 *
 * Answers "is BG sync firing per-capture or in bursts?" from existing
 * driverLocations data alone — no device-side telemetry required.
 *
 * Every ping carries:
 *   recordedAt — device wall-clock when GPS was captured
 *   createdAt  — Convex server wall-clock when the ping landed
 *
 * createdAt - recordedAt = the exact end-to-end latency that PR #150's
 * bg_sync_outcome event was being added to measure. Burst-clustering on
 * createdAt distinguishes per-capture sync (mostly singletons) from
 * batched flush (large clusters separated by gaps).
 *
 * Usage (CLI):
 *   npx convex run --prod _devTools/syncLatencyDiag:analyzeDriver \
 *     '{"driverId":"k123abc...","windowHours":12}'
 *
 *   npx convex run --prod _devTools/syncLatencyDiag:analyzeBySession \
 *     '{"sessionId":"k456..."}'
 *
 * internalQuery means it's invokable only via the Convex dashboard / CLI,
 * not from deployed clients, so no OTOQA_ENABLE_DEV_TOOLS gate is needed.
 */

import { v } from 'convex/values';
import { internalQuery } from '../_generated/server';
import type { Doc, Id } from '../_generated/dataModel';

const BURST_GAP_MS = 30 * 1000;      // pings within 30s of each other = same burst
const RECORDED_GAP_MS = 60 * 1000;   // device-side quiet > 1min = notable gap
const CREATED_GAP_MS = 60 * 1000;    // sync-side quiet > 1min = notable gap
const SAMPLE_CAP = 10;               // cap on gap samples returned
const TIMELINE_CAP = 50;             // cap on row-level timeline samples

function percentile(sorted: number[], p: number): number {
  if (sorted.length === 0) return 0;
  const idx = Math.min(sorted.length - 1, Math.floor(sorted.length * p));
  return sorted[idx];
}

function summarizeMs(values: number[]) {
  if (values.length === 0) {
    return { count: 0, minSec: 0, p50Sec: 0, p75Sec: 0, p95Sec: 0, p99Sec: 0, maxSec: 0, meanSec: 0 };
  }
  const sorted = [...values].sort((a, b) => a - b);
  const sum = sorted.reduce((a, b) => a + b, 0);
  return {
    count: sorted.length,
    minSec: Math.round(sorted[0] / 1000),
    p50Sec: Math.round(percentile(sorted, 0.5) / 1000),
    p75Sec: Math.round(percentile(sorted, 0.75) / 1000),
    p95Sec: Math.round(percentile(sorted, 0.95) / 1000),
    p99Sec: Math.round(percentile(sorted, 0.99) / 1000),
    maxSec: Math.round(sorted[sorted.length - 1] / 1000),
    meanSec: Math.round(sum / sorted.length / 1000),
  };
}

interface BurstSummary {
  totalBursts: number;
  singletons: number;
  multiBursts: number;
  singletonRatio: number;
  biggestBurst: number;
  histogram: { bucket: string; count: number }[];
}

function clusterBursts(byCreated: Doc<'driverLocations'>[]): BurstSummary {
  if (byCreated.length === 0) {
    return { totalBursts: 0, singletons: 0, multiBursts: 0, singletonRatio: 0, biggestBurst: 0, histogram: [] };
  }
  const sizes: number[] = [];
  let cur = 1;
  for (let i = 1; i < byCreated.length; i++) {
    const gap = byCreated[i].createdAt - byCreated[i - 1].createdAt;
    if (gap <= BURST_GAP_MS) {
      cur++;
    } else {
      sizes.push(cur);
      cur = 1;
    }
  }
  sizes.push(cur);

  const buckets = new Map<string, number>();
  let singletons = 0;
  let biggest = 0;
  for (const s of sizes) {
    const key = s === 1 ? '1' : s <= 5 ? '2-5' : s <= 20 ? '6-20' : s <= 50 ? '21-50' : '50+';
    buckets.set(key, (buckets.get(key) ?? 0) + 1);
    if (s === 1) singletons++;
    if (s > biggest) biggest = s;
  }
  const histogram = Array.from(buckets.entries()).map(([bucket, count]) => ({ bucket, count }));
  return {
    totalBursts: sizes.length,
    singletons,
    multiBursts: sizes.length - singletons,
    singletonRatio: sizes.length === 0 ? 0 : singletons / sizes.length,
    biggestBurst: biggest,
    histogram,
  };
}

interface Gap {
  fromMs: number;
  toMs: number;
  gapSec: number;
}

function findGaps(rows: Doc<'driverLocations'>[], field: 'recordedAt' | 'createdAt', thresholdMs: number): Gap[] {
  const gaps: Gap[] = [];
  for (let i = 1; i < rows.length; i++) {
    const gap = rows[i][field] - rows[i - 1][field];
    if (gap > thresholdMs) {
      gaps.push({
        fromMs: rows[i - 1][field],
        toMs: rows[i][field],
        gapSec: Math.round(gap / 1000),
      });
    }
  }
  return gaps;
}

const burstHistogramValidator = v.array(v.object({ bucket: v.string(), count: v.number() }));
const burstSummaryValidator = v.object({
  totalBursts: v.number(),
  singletons: v.number(),
  multiBursts: v.number(),
  singletonRatio: v.number(),
  biggestBurst: v.number(),
  histogram: burstHistogramValidator,
});
const latencyValidator = v.object({
  count: v.number(),
  minSec: v.number(),
  p50Sec: v.number(),
  p75Sec: v.number(),
  p95Sec: v.number(),
  p99Sec: v.number(),
  maxSec: v.number(),
  meanSec: v.number(),
});
const gapsValidator = v.object({
  count: v.number(),
  samples: v.array(v.object({ fromMs: v.number(), toMs: v.number(), gapSec: v.number() })),
});
const sessionMetaValidator = v.array(v.object({
  sessionId: v.id('driverSessions'),
  startedAt: v.float64(),
  endedAt: v.optional(v.float64()),
  endReason: v.optional(v.string()),
  status: v.string(),
  lastPingAt: v.optional(v.float64()),
  fcmLastPushAt: v.optional(v.float64()),
  fcmConsecutiveFailures: v.optional(v.float64()),
  pingsInWindow: v.number(),
}));
const timelineValidator = v.array(v.object({
  recordedAt: v.float64(),
  createdAt: v.float64(),
  latencySec: v.number(),
  sessionId: v.optional(v.id('driverSessions')),
  trackingType: v.string(),
}));

const analyzeReturn = v.union(
  v.object({
    empty: v.literal(true),
    driverId: v.id('drivers'),
    windowFromMs: v.number(),
    windowToMs: v.number(),
    message: v.string(),
  }),
  v.object({
    empty: v.literal(false),
    driverId: v.id('drivers'),
    windowFromMs: v.number(),
    windowToMs: v.number(),
    pingCount: v.number(),
    latencySec: latencyValidator,
    bursts: burstSummaryValidator,
    recordedGaps: gapsValidator,
    createdGaps: gapsValidator,
    sessions: sessionMetaValidator,
    timelineSample: timelineValidator,
    interpretation: v.string(),
  }),
);

function interpret(
  latency: ReturnType<typeof summarizeMs>,
  bursts: BurstSummary,
): string {
  // Heuristics for the headline read of the data.
  if (bursts.totalBursts === 0) return 'No data.';
  const r = bursts.singletonRatio;
  const p50 = latency.p50Sec;

  if (r > 0.7 && p50 < 30) {
    return `per-capture sync working: ${Math.round(r * 100)}% singletons, p50 latency ${p50}s. BG task appears to flush each ping individually.`;
  }
  if (r > 0.7 && p50 >= 30) {
    return `per-capture sync firing but slow: ${Math.round(r * 100)}% singletons but p50 latency ${p50}s — network/server path is the bottleneck, not batching.`;
  }
  if (r < 0.3 && p50 >= 60) {
    return `BATCHED flush, not per-capture: only ${Math.round(r * 100)}% singletons, biggest burst ${bursts.biggestBurst}, p50 latency ${p50}s. BG task is NOT firing per-capture — pings accumulate and flush in clumps. This is the failure mode #150's telemetry was added to confirm.`;
  }
  if (r < 0.3 && p50 < 60) {
    return `mixed: ${Math.round(r * 100)}% singletons with biggest burst ${bursts.biggestBurst}, but p50 latency only ${p50}s — likely per-capture sync works most of the time, with occasional catch-up flushes after brief stalls.`;
  }
  return `mixed pattern: ${Math.round(r * 100)}% singletons, p50 latency ${p50}s, biggest burst ${bursts.biggestBurst}. Inspect timeline samples + gaps for a clearer read.`;
}

export const analyzeDriver = internalQuery({
  args: {
    driverId: v.id('drivers'),
    windowHours: v.optional(v.number()),
  },
  returns: analyzeReturn,
  handler: async (ctx, args) => {
    const windowHours = args.windowHours ?? 12;
    const nowMs = Date.now();
    const cutoffMs = nowMs - windowHours * 60 * 60 * 1000;

    const pings = await ctx.db
      .query('driverLocations')
      .withIndex('by_driver_time', (q) =>
        q.eq('driverId', args.driverId).gte('recordedAt', cutoffMs),
      )
      .collect();

    if (pings.length === 0) {
      return {
        empty: true as const,
        driverId: args.driverId,
        windowFromMs: cutoffMs,
        windowToMs: nowMs,
        message: `No driverLocations rows for driver ${args.driverId} in the last ${windowHours}h.`,
      };
    }

    const latencies = pings.map((p) => p.createdAt - p.recordedAt);
    const latency = summarizeMs(latencies);

    const byCreated = [...pings].sort((a, b) => a.createdAt - b.createdAt);
    const byRecorded = [...pings].sort((a, b) => a.recordedAt - b.recordedAt);

    const bursts = clusterBursts(byCreated);
    const recordedGapsAll = findGaps(byRecorded, 'recordedAt', RECORDED_GAP_MS);
    const createdGapsAll = findGaps(byCreated, 'createdAt', CREATED_GAP_MS);

    // Per-session overlay: pull every session whose pings show up here so we
    // can correlate with fcmLastPushAt and endReason.
    const sessionIdSet = new Set<Id<'driverSessions'>>();
    const sessionPingCount = new Map<Id<'driverSessions'>, number>();
    for (const p of pings) {
      if (p.sessionId) {
        sessionIdSet.add(p.sessionId);
        sessionPingCount.set(p.sessionId, (sessionPingCount.get(p.sessionId) ?? 0) + 1);
      }
    }
    const sessions: Doc<'driverSessions'>[] = [];
    for (const id of sessionIdSet) {
      const s = await ctx.db.get(id);
      if (s) sessions.push(s);
    }
    sessions.sort((a, b) => b.startedAt - a.startedAt);

    // Sampled timeline: every N rows by recordedAt to fit under TIMELINE_CAP.
    const stride = Math.max(1, Math.floor(byRecorded.length / TIMELINE_CAP));
    const timelineSample = byRecorded
      .filter((_, i) => i % stride === 0)
      .slice(0, TIMELINE_CAP)
      .map((p) => ({
        recordedAt: p.recordedAt,
        createdAt: p.createdAt,
        latencySec: Math.round((p.createdAt - p.recordedAt) / 1000),
        sessionId: p.sessionId,
        trackingType: p.trackingType,
      }));

    return {
      empty: false as const,
      driverId: args.driverId,
      windowFromMs: cutoffMs,
      windowToMs: nowMs,
      pingCount: pings.length,
      latencySec: latency,
      bursts,
      recordedGaps: {
        count: recordedGapsAll.length,
        samples: recordedGapsAll.slice(0, SAMPLE_CAP),
      },
      createdGaps: {
        count: createdGapsAll.length,
        samples: createdGapsAll.slice(0, SAMPLE_CAP),
      },
      sessions: sessions.map((s) => ({
        sessionId: s._id,
        startedAt: s.startedAt,
        endedAt: s.endedAt,
        endReason: s.endReason,
        status: s.status,
        lastPingAt: s.lastPingAt,
        fcmLastPushAt: s.fcmLastPushAt,
        fcmConsecutiveFailures: s.fcmConsecutiveFailures,
        pingsInWindow: sessionPingCount.get(s._id) ?? 0,
      })),
      timelineSample,
      interpretation: interpret(latency, bursts),
    };
  },
});

const sessionReturn = v.union(
  v.object({
    empty: v.literal(true),
    sessionId: v.id('driverSessions'),
    message: v.string(),
  }),
  v.object({
    empty: v.literal(false),
    sessionId: v.id('driverSessions'),
    driverId: v.id('drivers'),
    startedAt: v.float64(),
    endedAt: v.optional(v.float64()),
    endReason: v.optional(v.string()),
    status: v.string(),
    fcmLastPushAt: v.optional(v.float64()),
    fcmConsecutiveFailures: v.optional(v.float64()),
    pingCount: v.number(),
    latencySec: latencyValidator,
    bursts: burstSummaryValidator,
    recordedGaps: gapsValidator,
    createdGaps: gapsValidator,
    timelineSample: timelineValidator,
    interpretation: v.string(),
  }),
);

// ────────────────────────────────────────────────────────────────────
// analyzeByLoad: look up a load by its user-facing internalId (e.g.
// "109248748"), then analyze every driverLocations row tagged to its
// _id. Useful when investigating a specific delivery rather than a
// driver-wide window. Returns the same shape as analyzeBySession.
// ────────────────────────────────────────────────────────────────────

const loadReturn = v.union(
  v.object({
    empty: v.literal(true),
    workosOrgId: v.string(),
    internalId: v.string(),
    message: v.string(),
  }),
  v.object({
    empty: v.literal(false),
    workosOrgId: v.string(),
    internalId: v.string(),
    loadId: v.id('loadInformation'),
    status: v.string(),
    trackingStatus: v.string(),
    pingCount: v.number(),
    latencySec: latencyValidator,
    bursts: burstSummaryValidator,
    recordedGaps: gapsValidator,
    createdGaps: gapsValidator,
    sessions: sessionMetaValidator,
    timelineSample: timelineValidator,
    interpretation: v.string(),
  }),
);

export const analyzeByLoad = internalQuery({
  args: {
    workosOrgId: v.string(),
    internalId: v.string(),
  },
  returns: loadReturn,
  handler: async (ctx, args) => {
    const load = await ctx.db
      .query('loadInformation')
      .withIndex('by_internal_id', (q) =>
        q.eq('workosOrgId', args.workosOrgId).eq('internalId', args.internalId),
      )
      .first();

    if (!load) {
      return {
        empty: true as const,
        workosOrgId: args.workosOrgId,
        internalId: args.internalId,
        message: `No loadInformation row found for internalId=${args.internalId} in org ${args.workosOrgId}.`,
      };
    }

    const pings = await ctx.db
      .query('driverLocations')
      .withIndex('by_load', (q) => q.eq('loadId', load._id))
      .collect();

    if (pings.length === 0) {
      return {
        empty: true as const,
        workosOrgId: args.workosOrgId,
        internalId: args.internalId,
        message: `Load ${args.internalId} (${load._id}) has no driverLocations rows.`,
      };
    }

    const latencies = pings.map((p) => p.createdAt - p.recordedAt);
    const latency = summarizeMs(latencies);
    const byCreated = [...pings].sort((a, b) => a.createdAt - b.createdAt);
    const byRecorded = [...pings].sort((a, b) => a.recordedAt - b.recordedAt);

    const bursts = clusterBursts(byCreated);
    const recordedGapsAll = findGaps(byRecorded, 'recordedAt', RECORDED_GAP_MS);
    const createdGapsAll = findGaps(byCreated, 'createdAt', CREATED_GAP_MS);

    const sessionIdSet = new Set<Id<'driverSessions'>>();
    const sessionPingCount = new Map<Id<'driverSessions'>, number>();
    for (const p of pings) {
      if (p.sessionId) {
        sessionIdSet.add(p.sessionId);
        sessionPingCount.set(p.sessionId, (sessionPingCount.get(p.sessionId) ?? 0) + 1);
      }
    }
    const sessions: Doc<'driverSessions'>[] = [];
    for (const id of sessionIdSet) {
      const s = await ctx.db.get(id);
      if (s) sessions.push(s);
    }
    sessions.sort((a, b) => b.startedAt - a.startedAt);

    const stride = Math.max(1, Math.floor(byRecorded.length / TIMELINE_CAP));
    const timelineSample = byRecorded
      .filter((_, i) => i % stride === 0)
      .slice(0, TIMELINE_CAP)
      .map((p) => ({
        recordedAt: p.recordedAt,
        createdAt: p.createdAt,
        latencySec: Math.round((p.createdAt - p.recordedAt) / 1000),
        sessionId: p.sessionId,
        trackingType: p.trackingType,
      }));

    return {
      empty: false as const,
      workosOrgId: args.workosOrgId,
      internalId: args.internalId,
      loadId: load._id,
      status: load.status,
      trackingStatus: load.trackingStatus,
      pingCount: pings.length,
      latencySec: latency,
      bursts,
      recordedGaps: {
        count: recordedGapsAll.length,
        samples: recordedGapsAll.slice(0, SAMPLE_CAP),
      },
      createdGaps: {
        count: createdGapsAll.length,
        samples: createdGapsAll.slice(0, SAMPLE_CAP),
      },
      sessions: sessions.map((s) => ({
        sessionId: s._id,
        startedAt: s.startedAt,
        endedAt: s.endedAt,
        endReason: s.endReason,
        status: s.status,
        lastPingAt: s.lastPingAt,
        fcmLastPushAt: s.fcmLastPushAt,
        fcmConsecutiveFailures: s.fcmConsecutiveFailures,
        pingsInWindow: sessionPingCount.get(s._id) ?? 0,
      })),
      timelineSample,
      interpretation: interpret(latency, bursts),
    };
  },
});

/**
 * Scratch helper: search for a load by internalId across the whole table.
 * Returns the orgId and convex _id so we know which org to pass to
 * analyzeByLoad. Limited to 5 hits so it stays cheap.
 */
export const findLoadByInternalId = internalQuery({
  args: { internalId: v.string() },
  returns: v.array(v.object({
    loadId: v.id('loadInformation'),
    workosOrgId: v.string(),
    internalId: v.string(),
    status: v.string(),
    trackingStatus: v.string(),
  })),
  handler: async (ctx, args) => {
    // No index across all orgs; fall back to a filtered full-table scan,
    // capped at the first 5 hits to keep budget contained.
    const matches: {
      loadId: Id<'loadInformation'>;
      workosOrgId: string;
      internalId: string;
      status: string;
      trackingStatus: string;
    }[] = [];
    for await (const load of ctx.db.query('loadInformation')) {
      if (load.internalId === args.internalId) {
        matches.push({
          loadId: load._id,
          workosOrgId: load.workosOrgId,
          internalId: load.internalId,
          status: load.status,
          trackingStatus: load.trackingStatus,
        });
        if (matches.length >= 5) break;
      }
    }
    return matches;
  },
});

/**
 * List the distinct loads referenced by a driver's recent pings (most-recent
 * first), with each load's internalId + status. Used to identify the load
 * the user is asking about when we only know the driver + a vague
 * "most recent" reference.
 */
export const recentLoadsForDriver = internalQuery({
  args: { driverId: v.id('drivers'), windowHours: v.optional(v.number()) },
  returns: v.array(v.object({
    loadId: v.id('loadInformation'),
    internalId: v.string(),
    status: v.string(),
    trackingStatus: v.string(),
    pingsInWindow: v.number(),
    mostRecentPingRecordedAt: v.float64(),
  })),
  handler: async (ctx, args) => {
    const windowMs = (args.windowHours ?? 48) * 60 * 60 * 1000;
    const cutoffMs = Date.now() - windowMs;
    const pings = await ctx.db
      .query('driverLocations')
      .withIndex('by_driver_time', (q) =>
        q.eq('driverId', args.driverId).gte('recordedAt', cutoffMs),
      )
      .collect();

    const byLoad = new Map<Id<'loadInformation'>, { count: number; latest: number }>();
    for (const p of pings) {
      if (!p.loadId) continue;
      const cur = byLoad.get(p.loadId);
      if (!cur) {
        byLoad.set(p.loadId, { count: 1, latest: p.recordedAt });
      } else {
        cur.count++;
        if (p.recordedAt > cur.latest) cur.latest = p.recordedAt;
      }
    }

    const rows: {
      loadId: Id<'loadInformation'>;
      internalId: string;
      status: string;
      trackingStatus: string;
      pingsInWindow: number;
      mostRecentPingRecordedAt: number;
    }[] = [];
    for (const [loadId, agg] of byLoad) {
      const load = await ctx.db.get(loadId);
      if (!load) continue;
      rows.push({
        loadId,
        internalId: load.internalId,
        status: load.status,
        trackingStatus: load.trackingStatus,
        pingsInWindow: agg.count,
        mostRecentPingRecordedAt: agg.latest,
      });
    }
    rows.sort((a, b) => b.mostRecentPingRecordedAt - a.mostRecentPingRecordedAt);
    return rows;
  },
});

export const analyzeBySession = internalQuery({
  args: {
    sessionId: v.id('driverSessions'),
  },
  returns: sessionReturn,
  handler: async (ctx, args) => {
    const session = await ctx.db.get(args.sessionId);
    if (!session) {
      return {
        empty: true as const,
        sessionId: args.sessionId,
        message: `Session ${args.sessionId} not found.`,
      };
    }

    const pings = await ctx.db
      .query('driverLocations')
      .withIndex('by_session_time', (q) => q.eq('sessionId', args.sessionId))
      .collect();

    if (pings.length === 0) {
      return {
        empty: true as const,
        sessionId: args.sessionId,
        message: `Session ${args.sessionId} has no driverLocations rows.`,
      };
    }

    const latencies = pings.map((p) => p.createdAt - p.recordedAt);
    const latency = summarizeMs(latencies);
    const byCreated = [...pings].sort((a, b) => a.createdAt - b.createdAt);
    const byRecorded = [...pings].sort((a, b) => a.recordedAt - b.recordedAt);

    const bursts = clusterBursts(byCreated);
    const recordedGapsAll = findGaps(byRecorded, 'recordedAt', RECORDED_GAP_MS);
    const createdGapsAll = findGaps(byCreated, 'createdAt', CREATED_GAP_MS);

    const stride = Math.max(1, Math.floor(byRecorded.length / TIMELINE_CAP));
    const timelineSample = byRecorded
      .filter((_, i) => i % stride === 0)
      .slice(0, TIMELINE_CAP)
      .map((p) => ({
        recordedAt: p.recordedAt,
        createdAt: p.createdAt,
        latencySec: Math.round((p.createdAt - p.recordedAt) / 1000),
        sessionId: p.sessionId,
        trackingType: p.trackingType,
      }));

    return {
      empty: false as const,
      sessionId: session._id,
      driverId: session.driverId,
      startedAt: session.startedAt,
      endedAt: session.endedAt,
      endReason: session.endReason,
      status: session.status,
      fcmLastPushAt: session.fcmLastPushAt,
      fcmConsecutiveFailures: session.fcmConsecutiveFailures,
      pingCount: pings.length,
      latencySec: latency,
      bursts,
      recordedGaps: {
        count: recordedGapsAll.length,
        samples: recordedGapsAll.slice(0, SAMPLE_CAP),
      },
      createdGaps: {
        count: createdGapsAll.length,
        samples: createdGapsAll.slice(0, SAMPLE_CAP),
      },
      timelineSample,
      interpretation: interpret(latency, bursts),
    };
  },
});
