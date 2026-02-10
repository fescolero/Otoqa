import { v } from 'convex/values';
import { internalAction, internalMutation, internalQuery } from './_generated/server';
import { internal } from './_generated/api';
import { Id } from './_generated/dataModel';
import { shouldRunInterval } from './_helpers/cronUtils';

/**
 * Auto-Assignment Cron Handler
 * Processes pending loads for organizations with scheduled auto-assignment enabled
 */

// Get all organizations that have scheduled auto-assignment enabled
export const getOrgsWithScheduledAutoAssignment = internalQuery({
  args: {},
  handler: async (
    ctx
  ): Promise<
    Array<{
      _id: Id<'autoAssignmentSettings'>;
      workosOrgId: string;
      scheduleIntervalMinutes?: number;
      lastScheduledRunAt?: number;
    }>
  > => {
    const settings = await ctx.db
      .query('autoAssignmentSettings')
      .filter((q) =>
        q.and(q.eq(q.field('enabled'), true), q.eq(q.field('scheduledEnabled'), true))
      )
      .collect();

    return settings.map((s) => ({
      _id: s._id,
      workosOrgId: s.workosOrgId,
      scheduleIntervalMinutes: s.scheduleIntervalMinutes,
      lastScheduledRunAt: s.lastScheduledRunAt,
    }));
  },
});

export const updateLastScheduledRunAt = internalMutation({
  args: {
    settingsId: v.id('autoAssignmentSettings'),
    lastScheduledRunAt: v.number(),
  },
  returns: v.null(),
  handler: async (ctx, args) => {
    await ctx.db.patch(args.settingsId, {
      lastScheduledRunAt: args.lastScheduledRunAt,
    });
    return null;
  },
});

/**
 * Hourly cron job to run scheduled auto-assignment
 * Picks up any loads that weren't auto-assigned on creation
 */
export const runScheduledAutoAssignment = internalAction({
  args: {},
  handler: async (ctx): Promise<{
    orgsProcessed: number;
    totalAssigned: number;
    totalSkipped: number;
    totalErrors: number;
  }> => {
    // Get all orgs with scheduled auto-assignment enabled
    const orgSettings = await ctx.runQuery(
      internal.autoAssignmentCron.getOrgsWithScheduledAutoAssignment,
      {}
    );

    const now = Date.now();
    let totalAssigned = 0;
    let totalSkipped = 0;
    let totalErrors = 0;
    let orgsProcessed = 0;

    // Process each org
    for (const setting of orgSettings) {
      const shouldRun = shouldRunInterval({
        nowMs: now,
        lastRunAtMs: setting.lastScheduledRunAt,
        intervalMinutes: setting.scheduleIntervalMinutes,
        defaultIntervalMinutes: 60,
      });

      if (!shouldRun) {
        continue;
      }

      try {
        const result = await ctx.runAction(internal.autoAssignment.autoAssignPendingLoads, {
          workosOrgId: setting.workosOrgId,
        });

        totalAssigned += result.assigned;
        totalSkipped += result.skipped;
        totalErrors += result.errors;
        orgsProcessed++;

        await ctx.runMutation(internal.autoAssignmentCron.updateLastScheduledRunAt, {
          settingsId: setting._id,
          lastScheduledRunAt: now,
        });
      } catch (error) {
        console.error(`Error running auto-assignment for org ${setting.workosOrgId}:`, error);
        totalErrors++;
      }
    }

    console.log(
      `Scheduled auto-assignment complete: ${totalAssigned} assigned, ${totalSkipped} skipped, ${totalErrors} errors across ${orgsProcessed} orgs`
    );

    return {
      orgsProcessed,
      totalAssigned,
      totalSkipped,
      totalErrors,
    };
  },
});
