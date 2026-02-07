import { v } from 'convex/values';
import { internalAction, internalQuery } from './_generated/server';
import { internal } from './_generated/api';

/**
 * Auto-Assignment Cron Handler
 * Processes pending loads for organizations with scheduled auto-assignment enabled
 */

// Get all organizations that have scheduled auto-assignment enabled
export const getOrgsWithScheduledAutoAssignment = internalQuery({
  args: {},
  handler: async (ctx): Promise<string[]> => {
    const settings = await ctx.db
      .query('autoAssignmentSettings')
      .filter((q) =>
        q.and(q.eq(q.field('enabled'), true), q.eq(q.field('scheduledEnabled'), true))
      )
      .collect();

    return settings.map((s) => s.workosOrgId);
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
    const orgIds = await ctx.runQuery(
      internal.autoAssignmentCron.getOrgsWithScheduledAutoAssignment,
      {}
    );

    let totalAssigned = 0;
    let totalSkipped = 0;
    let totalErrors = 0;

    // Process each org
    for (const workosOrgId of orgIds) {
      try {
        const result = await ctx.runAction(internal.autoAssignment.autoAssignPendingLoads, {
          workosOrgId,
        });

        totalAssigned += result.assigned;
        totalSkipped += result.skipped;
        totalErrors += result.errors;
      } catch (error) {
        console.error(`Error running auto-assignment for org ${workosOrgId}:`, error);
        totalErrors++;
      }
    }

    console.log(
      `Scheduled auto-assignment complete: ${totalAssigned} assigned, ${totalSkipped} skipped, ${totalErrors} errors across ${orgIds.length} orgs`
    );

    return {
      orgsProcessed: orgIds.length,
      totalAssigned,
      totalSkipped,
      totalErrors,
    };
  },
});
