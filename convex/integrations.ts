import { v } from 'convex/values';
import { mutation, query } from './_generated/server';

// Get all integrations for an organization
export const getIntegrations = query({
  args: {
    workosOrgId: v.string(),
  },
  handler: async (ctx, args) => {
    const integrations = await ctx.db
      .query('orgIntegrations')
      .withIndex('by_organization', (q) => q.eq('workosOrgId', args.workosOrgId))
      .collect();

    // Remove sensitive credentials from the response
    return integrations.map((integration) => ({
      ...integration,
      credentials: '***', // Mask credentials
      hasCredentials: !!integration.credentials,
    }));
  },
});

// Get a specific integration by provider
export const getIntegrationByProvider = query({
  args: {
    workosOrgId: v.string(),
    provider: v.string(),
  },
  handler: async (ctx, args) => {
    const integration = await ctx.db
      .query('orgIntegrations')
      .withIndex('by_provider', (q) => q.eq('workosOrgId', args.workosOrgId).eq('provider', args.provider))
      .first();

    if (!integration) {
      return null;
    }

    // Remove sensitive credentials from the response
    return {
      ...integration,
      credentials: '***', // Mask credentials
      hasCredentials: !!integration.credentials,
    };
  },
});

// Create or update an integration
export const upsertIntegration = mutation({
  args: {
    workosOrgId: v.string(),
    provider: v.string(),
    credentials: v.string(), // JSON string
    syncSettings: v.object({
      isEnabled: v.boolean(),
      pull: v.optional(
        v.object({
          loadsEnabled: v.boolean(),
          intervalMinutes: v.number(),
          lookbackWindowHours: v.number(),
        }),
      ),
      push: v.optional(
        v.object({
          gpsTrackingEnabled: v.boolean(),
          driverAssignmentsEnabled: v.boolean(),
        }),
      ),
    }),
    createdBy: v.string(),
  },
  handler: async (ctx, args) => {
    // Check if integration already exists
    const existing = await ctx.db
      .query('orgIntegrations')
      .withIndex('by_provider', (q) => q.eq('workosOrgId', args.workosOrgId).eq('provider', args.provider))
      .first();

    const now = Date.now();

    if (existing) {
      // Update existing integration
      await ctx.db.patch(existing._id, {
        credentials: args.credentials,
        syncSettings: args.syncSettings,
        updatedAt: now,
      });
      return existing._id;
    } else {
      // Create new integration
      // Set default metadata for FourKites (uses meters)
      const metadata = args.provider === 'fourkites'
        ? { distanceUnit: 'meters' }
        : undefined;

      const integrationId = await ctx.db.insert('orgIntegrations', {
        workosOrgId: args.workosOrgId,
        provider: args.provider,
        credentials: args.credentials,
        syncSettings: args.syncSettings,
        integrationMetadata: metadata,
        lastSyncStats: {
          lastSyncTime: undefined,
          lastSyncStatus: undefined,
          recordsProcessed: undefined,
          errorMessage: undefined,
        },
        createdBy: args.createdBy,
        createdAt: now,
        updatedAt: now,
      });
      return integrationId;
    }
  },
});

// Update sync settings only
export const updateSyncSettings = mutation({
  args: {
    workosOrgId: v.string(),
    provider: v.string(),
    syncSettings: v.object({
      isEnabled: v.boolean(),
      pull: v.optional(
        v.object({
          loadsEnabled: v.boolean(),
          intervalMinutes: v.number(),
          lookbackWindowHours: v.number(),
        }),
      ),
      push: v.optional(
        v.object({
          gpsTrackingEnabled: v.boolean(),
          driverAssignmentsEnabled: v.boolean(),
        }),
      ),
    }),
  },
  handler: async (ctx, args) => {
    const integration = await ctx.db
      .query('orgIntegrations')
      .withIndex('by_provider', (q) => q.eq('workosOrgId', args.workosOrgId).eq('provider', args.provider))
      .first();

    if (!integration) {
      throw new Error('Integration not found');
    }

    await ctx.db.patch(integration._id, {
      syncSettings: args.syncSettings,
      updatedAt: Date.now(),
    });
  },
});

// Delete an integration
export const deleteIntegration = mutation({
  args: {
    workosOrgId: v.string(),
    provider: v.string(),
  },
  handler: async (ctx, args) => {
    const integration = await ctx.db
      .query('orgIntegrations')
      .withIndex('by_provider', (q) => q.eq('workosOrgId', args.workosOrgId).eq('provider', args.provider))
      .first();

    if (!integration) {
      throw new Error('Integration not found');
    }

    await ctx.db.delete(integration._id);
  },
});

// Update last sync stats
export const updateSyncStats = mutation({
  args: {
    workosOrgId: v.string(),
    provider: v.string(),
    lastSyncStats: v.object({
      lastSyncTime: v.optional(v.number()),
      lastSyncStatus: v.optional(v.string()),
      recordsProcessed: v.optional(v.number()),
      errorMessage: v.optional(v.string()),
    }),
  },
  handler: async (ctx, args) => {
    const integration = await ctx.db
      .query('orgIntegrations')
      .withIndex('by_provider', (q) => q.eq('workosOrgId', args.workosOrgId).eq('provider', args.provider))
      .first();

    if (!integration) {
      throw new Error('Integration not found');
    }

    await ctx.db.patch(integration._id, {
      lastSyncStats: args.lastSyncStats,
      updatedAt: Date.now(),
    });
  },
});

// Get credentials for internal use (e.g., by sync jobs)
// This should only be called from server-side code
export const getCredentials = query({
  args: {
    workosOrgId: v.string(),
    provider: v.string(),
  },
  handler: async (ctx, args) => {
    const integration = await ctx.db
      .query('orgIntegrations')
      .withIndex('by_provider', (q) => q.eq('workosOrgId', args.workosOrgId).eq('provider', args.provider))
      .first();

    if (!integration) {
      return null;
    }

    return integration.credentials;
  },
});
