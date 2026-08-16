import { v, ConvexError } from 'convex/values';
import { query, mutation } from '../_generated/server';
import { requirePlatformStaff, requireRecentStaffAuth } from '../lib/auth';
import { logPlatformAudit } from '../lib/platformAudit';
import { jobState, overdueMs } from './jobHealth';

/**
 * Platform console — cron jobs board. Staff-only. Reads the cronHealth /
 * cronRuns ledger maintained by platform/cronRunner.
 */

export const listJobs = query({
  args: {},
  handler: async (ctx) => {
    await requirePlatformStaff(ctx);
    const jobs = await ctx.db.query('cronHealth').collect(); // one row per job
    const now = Date.now();
    // `state` is computed here rather than in the client so the board and the
    // alert evaluator can never disagree about what "stale" means.
    const rows = jobs.map((j) => ({
      ...j,
      state: jobState(j, now),
      overdueMs: overdueMs(j, now),
    }));
    const severity = { hung: 0, stale: 1, failing: 2, unknown: 3, retired: 4, ok: 5 } as const;
    rows.sort(
      (a, b) => severity[a.state] - severity[b.state] || a.jobName.localeCompare(b.jobName),
    );
    return rows;
  },
});

/**
 * Retire a job whose row outlived its schedule (removed from crons.ts, or
 * renamed). Without this a deleted job alerts stale forever and the only fix
 * is a database edit. The row is kept — its history is still evidence — and
 * retirement clears itself automatically if the job ever fires again
 * (cronRunner.markStarted).
 */
export const retireJob = mutation({
  args: { jobName: v.string(), reason: v.string() },
  returns: v.null(),
  handler: async (ctx, args) => {
    const staff = await requireRecentStaffAuth(ctx);
    const job = await ctx.db
      .query('cronHealth')
      .withIndex('by_job', (q) => q.eq('jobName', args.jobName))
      .unique();
    if (!job) throw new ConvexError('Job not found');
    if (job.retiredAt !== undefined) return null; // idempotent
    await ctx.db.patch(job._id, { retiredAt: Date.now(), retiredBy: staff.email });
    await logPlatformAudit(ctx, {
      actorEmail: staff.email,
      action: 'cron_job_retired',
      targetTable: 'cronHealth',
      targetId: args.jobName,
      reason: args.reason,
    });
    return null;
  },
});

/**
 * Duration trend for one job: p50/p95 over retained history plus the last runs.
 * A job degrading from 2s to 45s is invisible on last-duration alone, and the
 * degradation usually arrives before the failure.
 */
export const jobTrend = query({
  args: { jobName: v.string() },
  handler: async (ctx, args) => {
    await requirePlatformStaff(ctx);
    const runs = await ctx.db
      .query('cronRuns')
      .withIndex('by_job_time', (q) => q.eq('jobName', args.jobName))
      .order('desc')
      .take(200);
    const durations = runs.map((r) => r.durationMs).sort((a, b) => a - b);
    const pct = (p: number) =>
      durations.length === 0
        ? null
        : durations[Math.min(durations.length - 1, Math.floor((p / 100) * durations.length))];
    return {
      sample: runs.length,
      p50Ms: pct(50),
      p95Ms: pct(95),
      maxMs: durations.at(-1) ?? null,
      failures: runs.filter((r) => r.outcome === 'error').length,
      recent: runs.slice(0, 25),
    };
  },
});

/** Failures across all jobs, newest first — the jobs page's incident strip. */
export const recentFailures = query({
  args: { limit: v.optional(v.number()) },
  handler: async (ctx, args) => {
    await requirePlatformStaff(ctx);
    const limit = Math.min(Math.max(args.limit ?? 25, 1), 100);
    // Failures are rare by construction; scan recent history and filter.
    const recent = await ctx.db
      .query('cronRuns')
      .withIndex('by_time')
      .order('desc')
      .take(500);
    return recent.filter((r) => r.outcome === 'error').slice(0, limit);
  },
});
