import { internalAction, internalQuery } from './_generated/server';
import { internal } from './_generated/api';

/**
 * Recurring Loads Cron Handler
 * Generates loads from recurring templates on a daily schedule
 */

// Get all organizations that have active recurring templates
export const getOrgsWithActiveTemplates = internalQuery({
  args: {},
  handler: async (ctx): Promise<string[]> => {
    // Get distinct organizations with active templates
    const templates = await ctx.db
      .query('recurringLoadTemplates')
      .filter((q) => q.eq(q.field('isActive'), true))
      .collect();

    const orgIds = new Set(templates.map((t) => t.workosOrgId));
    return Array.from(orgIds);
  },
});

/**
 * Daily cron job to generate recurring loads
 * Iterates through all orgs with active templates and generates loads
 */
export const generateDailyLoads = internalAction({
  args: {},
  handler: async (ctx): Promise<{
    orgsProcessed: number;
    totalGenerated: number;
    totalSkipped: number;
    totalErrors: number;
  }> => {
    // Get today's date in YYYY-MM-DD format (UTC)
    const generationDate = new Date().toISOString().split('T')[0];

    // Get all orgs with active templates
    const orgIds = await ctx.runQuery(internal.recurringLoadsCron.getOrgsWithActiveTemplates, {});

    let totalGenerated = 0;
    let totalSkipped = 0;
    let totalErrors = 0;

    // Process each org
    for (const workosOrgId of orgIds) {
      try {
        const result = await ctx.runAction(internal.recurringLoads.processRecurringTemplates, {
          workosOrgId,
          targetDate: generationDate,
        });

        totalGenerated += result.generated;
        totalSkipped += result.skipped;
        totalErrors += result.errors;
      } catch (error) {
        console.error(`Error processing recurring templates for org ${workosOrgId}:`, error);
        totalErrors++;
      }
    }

    console.log(
      `Recurring load generation complete: ${totalGenerated} generated, ${totalSkipped} skipped, ${totalErrors} errors across ${orgIds.length} orgs`
    );

    return {
      orgsProcessed: orgIds.length,
      totalGenerated,
      totalSkipped,
      totalErrors,
    };
  },
});
