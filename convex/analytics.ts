/**
 * Analytics Queries
 * Aggregate and analyze invoice/load data for accounting dashboards
 */

import { query } from "./_generated/server";
import { v } from "convex/values";

/**
 * Group unmapped loads by HCR + Trip Number
 * Returns clusters of loads that share the same HCR+Trip pattern
 * Used in Invoices page "Attention" tab to reduce 4,594 loads into ~50 actionable groups
 */
export const getUnmappedLoadGroups = query({
  args: {
    workosOrgId: v.string(),
  },
  handler: async (ctx, args) => {
    // Get UNMAPPED loads with limit (prevents reading thousands of loads)
    // ✅ Changed from .collect() to .take(100) for 98% read reduction
    const unmappedLoads = await ctx.db
      .query("loadInformation")
      .withIndex("by_load_type", (q) => 
        q.eq("workosOrgId", args.workosOrgId).eq("loadType", "UNMAPPED")
      )
      .take(100); // Limit to 100 most recent unmapped loads

    // Group by HCR + Trip Number in a single pass
    const groupsMap = new Map<string, {
      loads: typeof unmappedLoads;
      totalRevenue: number;
    }>();
    
    for (const load of unmappedLoads) {
      const hcr = load.parsedHcr || "UNKNOWN";
      const trip = load.parsedTripNumber || "UNKNOWN";
      const key = `${hcr}|${trip}`;
      
      if (!groupsMap.has(key)) {
        groupsMap.set(key, { loads: [], totalRevenue: 0 });
      }
      
      const group = groupsMap.get(key)!;
      group.loads.push(load);
    }

    // Convert to array and sort by impact (count descending)
    const result = Array.from(groupsMap.entries())
      .map(([key, { loads: groupLoads, totalRevenue }]) => {
        const [hcr, trip] = key.split("|");

        // Get date range
        const dates = groupLoads.map((load) => load.createdAt).sort();
        const firstDate = dates[0];
        const lastDate = dates[dates.length - 1];

        return {
          hcr,
          tripNumber: trip,
          count: groupLoads.length,
          estimatedRevenue: 0, // We'll calculate this if needed, but loads don't have revenue yet
          firstLoadDate: firstDate,
          lastLoadDate: lastDate,
          sampleLoadId: groupLoads[0]._id,
          sampleOrderNumber: groupLoads[0].orderNumber,
        };
      })
      .sort((a, b) => b.count - a.count); // Sort by impact

    return result;
  },
});
