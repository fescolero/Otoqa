import { mutation, query } from "./_generated/server";
import { v } from "convex/values";
import { internal } from "./_generated/api";

/**
 * Manually trigger a FourKites sync for testing
 * This bypasses the cron scheduler and runs immediately
 */
export const triggerManualSync = mutation({
  args: {
    workosOrgId: v.string(),
  },
  handler: async (ctx, args) => {
    // Find the FourKites integration for this org
    const integration = await ctx.db
      .query("orgIntegrations")
      .withIndex("by_provider", (q) =>
        q.eq("workosOrgId", args.workosOrgId).eq("provider", "fourkites")
      )
      .first();

    if (!integration) {
      throw new Error("No FourKites integration found for this organization");
    }

    if (!integration.syncSettings.isEnabled) {
      throw new Error("FourKites sync is disabled for this organization");
    }

    // Parse credentials
    const credentials = JSON.parse(integration.credentials);

    // Trigger the sync worker immediately
    await ctx.scheduler.runAfter(0, internal.fourKitesPullSyncAction.processOrg, {
      orgId: args.workosOrgId,
      integrationId: integration._id,
      credentials: credentials,
      lookbackHours: integration.syncSettings.pull?.lookbackWindowHours || 24,
    });

    return {
      success: true,
      message: "Sync triggered successfully",
      integrationId: integration._id,
      lookbackHours: integration.syncSettings.pull?.lookbackWindowHours || 24,
    };
  },
});

/**
 * Get sync status and statistics
 */
export const getSyncStatus = query({
  args: {
    workosOrgId: v.string(),
  },
  handler: async (ctx, args) => {
    const integration = await ctx.db
      .query("orgIntegrations")
      .withIndex("by_provider", (q) =>
        q.eq("workosOrgId", args.workosOrgId).eq("provider", "fourkites")
      )
      .first();

    if (!integration) {
      return null;
    }

    // Get invoices with MISSING_DATA status (unmapped loads)
    const missingDataInvoices = await ctx.db
      .query("loadInvoices")
      .withIndex("by_status", (q) =>
        q.eq("workosOrgId", args.workosOrgId).eq("status", "MISSING_DATA")
      )
      .collect();

    // Get all invoices
    const allInvoices = await ctx.db
      .query("loadInvoices")
      .withIndex("by_organization", (q) => q.eq("workosOrgId", args.workosOrgId))
      .collect();

    // Get synced loads count
    const syncedLoads = await ctx.db
      .query("loadInformation")
      .withIndex("by_organization", (q) => q.eq("workosOrgId", args.workosOrgId))
      .filter((q) => q.eq(q.field("externalSource"), "FourKites"))
      .collect();

    return {
      integration: {
        id: integration._id,
        isEnabled: integration.syncSettings.isEnabled,
        intervalMinutes: integration.syncSettings.pull?.intervalMinutes,
        lookbackHours: integration.syncSettings.pull?.lookbackWindowHours,
      },
      lastSync: integration.lastSyncStats,
      counts: {
        missingData: missingDataInvoices.length,
        totalInvoices: allInvoices.length,
        synced: syncedLoads.length,
        draftInvoices: allInvoices.filter(i => i.status === "DRAFT").length,
      },
      missingDataInvoices: missingDataInvoices.slice(0, 5).map(inv => ({
        invoiceId: inv._id,
        loadId: inv.loadId,
        reason: inv.missingDataReason,
        createdAt: inv.createdAt,
      })),
    };
  },
});

/**
 * List all organizations with FourKites integrations
 */
export const listFourKitesOrgs = query({
  args: {},
  handler: async (ctx) => {
    const integrations = await ctx.db
      .query("orgIntegrations")
      .collect();

    const fourKitesIntegrations = integrations.filter(
      (i) => i.provider === "fourkites"
    );

    return fourKitesIntegrations.map((integration) => ({
      orgId: integration.workosOrgId,
      integrationId: integration._id,
      isEnabled: integration.syncSettings.isEnabled,
      lastSync: integration.lastSyncStats.lastSyncTime,
      lastStatus: integration.lastSyncStats.lastSyncStatus,
    }));
  },
});

/**
 * Get contract lanes for an organization (for debugging matching)
 */
export const getContractLanes = query({
  args: {
    workosOrgId: v.string(),
  },
  handler: async (ctx, args) => {
    const lanes = await ctx.db
      .query("contractLanes")
      .withIndex("by_organization", (q) => q.eq("workosOrgId", args.workosOrgId))
      .collect();

    return lanes.map((lane) => ({
      id: lane._id,
      contractName: lane.contractName,
      hcr: lane.hcr,
      tripNumber: lane.tripNumber,
      customerCompanyId: lane.customerCompanyId,
      isActive: lane.isActive,
      isDeleted: lane.isDeleted,
    }));
  },
});
