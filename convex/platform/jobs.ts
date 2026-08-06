import { v } from 'convex/values';
import { query } from '../_generated/server';
import { requirePlatformStaff } from '../lib/auth';

/**
 * Platform console — cron jobs board. Staff-only. Reads the cronHealth /
 * cronRuns ledger maintained by platform/cronRunner.
 */

export const listJobs = query({
  args: {},
  handler: async (ctx) => {
    await requirePlatformStaff(ctx);
    const jobs = await ctx.db.query('cronHealth').collect(); // one row per job
    jobs.sort((a, b) => a.jobName.localeCompare(b.jobName));
    return jobs;
  },
});

export const recentRuns = query({
  args: { jobName: v.optional(v.string()), limit: v.optional(v.number()) },
  handler: async (ctx, args) => {
    await requirePlatformStaff(ctx);
    const limit = Math.min(Math.max(args.limit ?? 50, 1), 200);
    if (args.jobName !== undefined) {
      const jobName = args.jobName;
      return await ctx.db
        .query('cronRuns')
        .withIndex('by_job_time', (q) => q.eq('jobName', jobName))
        .order('desc')
        .take(limit);
    }
    return await ctx.db.query('cronRuns').withIndex('by_time').order('desc').take(limit);
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
