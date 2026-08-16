import { v } from 'convex/values';
import { makeFunctionReference } from 'convex/server';
import { internalAction, internalMutation } from '../_generated/server';
import { internal } from '../_generated/api';
import { logSystemEvent } from '../lib/systemEvents';

/**
 * Generic cron wrapper — gives every job in crons.ts a run ledger without
 * touching the job implementations.
 *
 * Why an ACTION (plan §11-5): if a cron target is a mutation and it throws,
 * the whole transaction rolls back — including any ledger row written
 * inside it. Running the target from an action lets `record` commit in its
 * own transaction regardless of the target's outcome. The error is
 * RETHROWN after recording so Convex's own logs (→ Axiom) still see the
 * failure exactly as before.
 *
 * Volume policy (plan §11-6): `cronHealth` is upserted every tick (one row
 * per job — cheap even at the Samsara poll's 10s cadence). `cronRuns`
 * history is appended only when `recordHistory` is true (jobs ≥ 5-minute
 * cadence) or the tick FAILED (failures always leave a row).
 */

const ERROR_SNIPPET = 500;

export const run = internalAction({
  args: {
    jobName: v.string(),
    // 'module:function' (or 'dir/module:function') — the original cron
    // target, resolved via makeFunctionReference so crons.ts stays the
    // single place that knows which function each job runs.
    fn: v.string(),
    fnType: v.union(v.literal('mutation'), v.literal('action')),
    recordHistory: v.boolean(),
    // Declared cadence. Persisted on cronHealth so the console and the alert
    // evaluator can tell "healthy" from "hasn't run since Tuesday" — without
    // it, a job that stops firing keeps its last-good row forever.
    expectedIntervalMs: v.optional(v.number()),
  },
  returns: v.null(),
  handler: async (ctx, args) => {
    const startedAt = Date.now();
    let error: string | undefined;

    // Claim the run BEFORE executing. If the action is killed mid-flight
    // (timeout, deploy, infrastructure), `record` never runs and this marker
    // is the only evidence the tick happened at all — staleness detection
    // reads it to distinguish "hung" from "never started".
    await ctx.runMutation(internal.platform.cronRunner.markStarted, {
      jobName: args.jobName,
      startedAt,
      expectedIntervalMs: args.expectedIntervalMs,
    });

    try {
      if (args.fnType === 'mutation') {
        await ctx.runMutation(makeFunctionReference<'mutation'>(args.fn), {});
      } else {
        await ctx.runAction(makeFunctionReference<'action'>(args.fn), {});
      }
    } catch (e) {
      error = e instanceof Error ? e.message : String(e);
    }

    await ctx.runMutation(internal.platform.cronRunner.record, {
      jobName: args.jobName,
      startedAt,
      durationMs: Date.now() - startedAt,
      error: error?.slice(0, ERROR_SNIPPET),
      recordHistory: args.recordHistory,
      expectedIntervalMs: args.expectedIntervalMs,
    });

    if (error !== undefined) {
      // Rethrow so the failure still lands in Convex logs / Axiom with the
      // job's own stack context preserved in the message.
      throw new Error(`[cron:${args.jobName}] ${error}`);
    }
    return null;
  },
});

/**
 * Claim a run. Also the place the declared cadence lands, and where a
 * retired-then-resurrected job clears its retirement.
 */
export const markStarted = internalMutation({
  args: {
    jobName: v.string(),
    startedAt: v.number(),
    expectedIntervalMs: v.optional(v.number()),
  },
  returns: v.null(),
  handler: async (ctx, args) => {
    const existing = await ctx.db
      .query('cronHealth')
      .withIndex('by_job', (q) => q.eq('jobName', args.jobName))
      .unique();
    if (!existing) return null; // first-ever tick: `record` creates the row

    await ctx.db.patch(existing._id, {
      inFlightSince: args.startedAt,
      ...(args.expectedIntervalMs !== undefined
        ? { expectedIntervalMs: args.expectedIntervalMs }
        : {}),
      // A job that fires again was not retired after all.
      ...(existing.retiredAt !== undefined ? { retiredAt: undefined, retiredBy: undefined } : {}),
    });
    return null;
  },
});

export const record = internalMutation({
  args: {
    jobName: v.string(),
    startedAt: v.number(),
    durationMs: v.number(),
    error: v.optional(v.string()),
    recordHistory: v.boolean(),
    expectedIntervalMs: v.optional(v.number()),
  },
  returns: v.null(),
  handler: async (ctx, args) => {
    const now = Date.now();
    const failed = args.error !== undefined;

    const existing = await ctx.db
      .query('cronHealth')
      .withIndex('by_job', (q) => q.eq('jobName', args.jobName))
      .unique();

    const consecutiveFailures = failed ? (existing?.consecutiveFailures ?? 0) + 1 : 0;

    if (existing) {
      await ctx.db.patch(existing._id, {
        lastStartedAt: args.startedAt,
        lastFinishedAt: args.startedAt + args.durationMs,
        lastDurationMs: args.durationMs,
        lastOutcome: failed ? 'error' : 'ok',
        lastError: args.error,
        consecutiveFailures,
        totalRuns: existing.totalRuns + 1,
        totalFailures: existing.totalFailures + (failed ? 1 : 0),
        expectedIntervalMs: args.expectedIntervalMs ?? existing.expectedIntervalMs,
        inFlightSince: undefined, // the run reported; it is no longer in flight
        retiredAt: undefined,
        retiredBy: undefined,
        updatedAt: now,
      });
    } else {
      await ctx.db.insert('cronHealth', {
        jobName: args.jobName,
        lastStartedAt: args.startedAt,
        lastFinishedAt: args.startedAt + args.durationMs,
        lastDurationMs: args.durationMs,
        lastOutcome: failed ? 'error' : 'ok',
        lastError: args.error,
        consecutiveFailures,
        totalRuns: 1,
        totalFailures: failed ? 1 : 0,
        expectedIntervalMs: args.expectedIntervalMs,
        updatedAt: now,
      });
    }

    if (args.recordHistory || failed) {
      await ctx.db.insert('cronRuns', {
        jobName: args.jobName,
        startedAt: args.startedAt,
        durationMs: args.durationMs,
        outcome: failed ? 'error' : 'ok',
        error: args.error,
      });
    }

    if (failed) {
      // Third consecutive failure escalates — matches the alerting matrix
      // (plan §9): one flaky tick is noise, a stuck job is an incident.
      await logSystemEvent(ctx, {
        severity: consecutiveFailures >= 3 ? 'critical' : 'error',
        source: 'cron',
        code: 'cron.failed',
        message: `Cron ${args.jobName} failed (${consecutiveFailures} consecutive): ${args.error}`,
        context: { jobName: args.jobName, consecutiveFailures, durationMs: args.durationMs },
      });
    }
    return null;
  },
});

/**
 * Nightly retention sweep for the platform ledgers (30 days for both
 * cronRuns and systemEvents — plan §6). Bounded batches; if a batch cap is
 * hit the next nightly run catches up (backlogs here are tiny by
 * construction).
 */
const RETENTION_MS = 30 * 24 * 60 * 60 * 1000;
const PRUNE_BATCH = 500;

export const pruneLedger = internalMutation({
  args: {},
  returns: v.null(),
  handler: async (ctx) => {
    const cutoff = Date.now() - RETENTION_MS;

    const oldRuns = await ctx.db
      .query('cronRuns')
      .withIndex('by_time', (q) => q.lt('startedAt', cutoff))
      .take(PRUNE_BATCH);
    for (const row of oldRuns) await ctx.db.delete(row._id);

    const oldEvents = await ctx.db
      .query('systemEvents')
      .withIndex('by_time', (q) => q.lt('createdAt', cutoff))
      .take(PRUNE_BATCH);
    for (const row of oldEvents) await ctx.db.delete(row._id);

    return null;
  },
});
