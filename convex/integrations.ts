import { v } from 'convex/values';
import { mutation, query, internalQuery, internalMutation } from './_generated/server';
import { assertCallerOwnsOrg } from './lib/auth';
import { logAudit } from './lib/audit';

// Get all integrations for an organization
export const getIntegrations = query({
  args: {
    workosOrgId: v.string(),
  },
  handler: async (ctx, args) => {
    await assertCallerOwnsOrg(ctx, args.workosOrgId);
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
    await assertCallerOwnsOrg(ctx, args.workosOrgId);
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
    const { userId, userName, userEmail } = await assertCallerOwnsOrg(ctx, args.workosOrgId);

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

      await logAudit(ctx, {
        organizationId: args.workosOrgId,
        entityType: 'integration',
        entityId: existing._id,
        entityName: args.provider,
        action: 'updated',
        performedBy: userId,
        performedByName: userName,
        performedByEmail: userEmail,
        description: `Updated integration "${args.provider}"`,
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
        createdBy: userId,
        createdAt: now,
        updatedAt: now,
      });

      await logAudit(ctx, {
        organizationId: args.workosOrgId,
        entityType: 'integration',
        entityId: integrationId,
        entityName: args.provider,
        action: 'created',
        performedBy: userId,
        performedByName: userName,
        performedByEmail: userEmail,
        description: `Created integration "${args.provider}"`,
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
    apiKey: v.optional(v.string()),
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
    const { userId, userName, userEmail } = await assertCallerOwnsOrg(ctx, args.workosOrgId);

    const integration = await ctx.db
      .query('orgIntegrations')
      .withIndex('by_provider', (q) => q.eq('workosOrgId', args.workosOrgId).eq('provider', args.provider))
      .first();

    if (!integration) {
      throw new Error('Integration not found');
    }

    const patchData: {
      syncSettings: typeof args.syncSettings;
      updatedAt: number;
      credentials?: string;
    } = {
      syncSettings: args.syncSettings,
      updatedAt: Date.now(),
    };

    if (args.apiKey !== undefined) {
      const trimmedApiKey = args.apiKey.trim();
      if (!trimmedApiKey) {
        throw new Error('API key cannot be empty');
      }

      let currentCredentials: Record<string, unknown> = {};
      try {
        const parsed = JSON.parse(integration.credentials);
        if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
          currentCredentials = parsed as Record<string, unknown>;
        }
      } catch {
        currentCredentials = {};
      }

      patchData.credentials = JSON.stringify({
        ...currentCredentials,
        apiKey: trimmedApiKey,
      });
    }

    await ctx.db.patch(integration._id, patchData);

    // Credential values are intentionally excluded from the audit entry.
    await logAudit(ctx, {
      organizationId: args.workosOrgId,
      entityType: 'integration',
      entityId: integration._id,
      entityName: args.provider,
      action: 'updated',
      performedBy: userId,
      performedByName: userName,
      performedByEmail: userEmail,
      description: `Updated sync settings for integration "${args.provider}"`,
      changedFields: Object.keys(patchData).filter((key) => key !== 'updatedAt'),
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
    const { userId, userName, userEmail } = await assertCallerOwnsOrg(ctx, args.workosOrgId);

    const integration = await ctx.db
      .query('orgIntegrations')
      .withIndex('by_provider', (q) => q.eq('workosOrgId', args.workosOrgId).eq('provider', args.provider))
      .first();

    if (!integration) {
      throw new Error('Integration not found');
    }

    await ctx.db.delete(integration._id);

    // No changesBefore snapshot: the integration doc contains raw credentials.
    await logAudit(ctx, {
      organizationId: args.workosOrgId,
      entityType: 'integration',
      entityId: integration._id,
      entityName: integration.provider,
      action: 'deleted',
      performedBy: userId,
      performedByName: userName,
      performedByEmail: userEmail,
      description: `Deleted integration "${integration.provider}"`,
    });
  },
});

// Update last sync stats (internal only — called by sync jobs)
export const updateSyncStats = internalMutation({
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
// SECURITY: internalQuery — not callable from client code
export const getCredentials = internalQuery({
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

// Get credential field info for the UI (masked — only shows which fields have values)
export const getCredentialFields = query({
  args: {
    workosOrgId: v.string(),
    provider: v.string(),
  },
  handler: async (ctx, args) => {
    await assertCallerOwnsOrg(ctx, args.workosOrgId);

    const integration = await ctx.db
      .query('orgIntegrations')
      .withIndex('by_provider', (q) => q.eq('workosOrgId', args.workosOrgId).eq('provider', args.provider))
      .first();

    if (!integration) {
      return null;
    }

    // Return a masked version: only indicate which fields are set
    try {
      const creds = JSON.parse(integration.credentials);
      if (creds && typeof creds === 'object' && !Array.isArray(creds)) {
        const masked: Record<string, string> = {};
        for (const key of Object.keys(creds)) {
          masked[key] = creds[key] ? '***' : '';
        }
        return JSON.stringify(masked);
      }
    } catch {
      // Ignore parse errors
    }
    return null;
  },
});
