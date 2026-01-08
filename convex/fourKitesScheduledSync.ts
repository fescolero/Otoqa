import { internalMutation } from "./_generated/server";
import { internal } from "./_generated/api";

export const dispatch = internalMutation({
  args: {}, // No args, it runs automatically
  handler: async (ctx) => {
    const now = Date.now();

    // 1. Query: Get ONLY enabled FourKites integrations
    const allIntegrations = await ctx.db
      .query("orgIntegrations")
      .collect();
    
    // Filter for FourKites with sync enabled
    const configs = allIntegrations.filter(
      (config) => 
        config.provider === "fourkites" && 
        config.syncSettings.isEnabled === true
    );

    let dispatchedCount = 0;

    for (const config of configs) {
      // 2. Frequency Check
      // Calculate how many minutes have passed since the last run
      const lastRun = config.lastSyncStats?.lastSyncTime || 0;
      const intervalMinutes = config.syncSettings.pull?.intervalMinutes || 60; // Default 1 hour
      
      const minutesSinceLastRun = (now - lastRun) / (1000 * 60);

      // If it's too early, skip this org
      if (minutesSinceLastRun < intervalMinutes) {
        continue;
      }

      // 3. Fan-Out: Dispatch the Worker
      // We use runAfter(0) to execute it immediately in a separate background transaction.
      // Even if this loop fails later, this job is already scheduled.
      await ctx.scheduler.runAfter(0, internal.fourKitesPullSyncAction.processOrg, {
        orgId: config.workosOrgId, // Pass ID for logging
        integrationId: config._id, // Pass DB ID to update stats later
        
        // Pass credentials down so the worker doesn't need to re-query
        credentials: config.credentials,
        
        // Pass specific settings
        lookbackHours: config.syncSettings.pull?.lookbackWindowHours || 24,
      });

      dispatchedCount++;
    }

    console.log(`FourKites Dispatcher: Checked ${configs.length} configs, triggered ${dispatchedCount} jobs.`);
  },
});
