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

    // Process each org in parallel. Orgs are tenant-isolated by workosOrgId
    // (processRecurringTemplates only reads/writes documents scoped to its
    // own workosOrgId), so concurrent runs don't share mutable state.
    // Promise.allSettled preserves the inline per-org error-handling profile
    // — DO NOT switch to ctx.scheduler.runAfter(0, ...) because scheduled
    // actions are at-most-once and silent failures would hide here.
    const results = await Promise.allSettled(
      orgIds.map((workosOrgId) =>
        ctx.runAction(internal.recurringLoads.processRecurringTemplates, {
          workosOrgId,
          targetDate: generationDate,
        })
      )
    );

    for (let i = 0; i < results.length; i++) {
      const r = results[i];
      if (r.status === 'fulfilled') {
        totalGenerated += r.value.generated;
        totalSkipped += r.value.skipped;
        totalErrors += r.value.errors;
      } else {
        console.error(
          `Error processing recurring templates for org ${orgIds[i]}:`,
          r.reason
        );
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
