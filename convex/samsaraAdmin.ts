import { v } from 'convex/values';
import { internal } from './_generated/api';
import {
  action,
  internalAction,
  internalMutation,
} from './_generated/server';
import { assertCallerOwnsOrg } from './lib/auth';

// ============================================
// SAMSARA INTEGRATION — SEED / ADMIN
// V1 onboarding path: an operator runs these via the Convex dashboard or a
// CLI script. UI follows in a separate workstream.
//
// Flow:
//   1. createSamsaraIntegration (action)
//        → encrypts the raw API token via samsaraCrypto
//        → calls insertSamsaraIntegration (mutation) atomically
//   2. setTruckSamsaraVehicleId (mutation) — map each truck to its
//      Samsara vehicleId (one row at a time, or batch via a wrapper).
// ============================================

const ENVIRONMENT = v.union(v.literal('sandbox'), v.literal('production'));

/**
 * Create a Samsara integration row + companion samsaraSyncState row.
 * Encrypts the raw API token in the action (Node runtime), then writes
 * to the DB in a single mutation so the two rows can't end up out of sync.
 */
export const createSamsaraIntegration = internalAction({
  args: {
    workosOrgId: v.string(),
    rawApiToken: v.string(),
    environment: ENVIRONMENT,
    createdBy: v.string(), // WorkOS userId for audit trail
  },
  returns: v.object({
    integrationId: v.id('orgIntegrations'),
    syncStateId: v.id('samsaraSyncState'),
  }),
  handler: async (ctx, args): Promise<{ integrationId: any; syncStateId: any }> => {
    const encryptedToken = await ctx.runAction(
      internal.samsaraCrypto.encryptSamsaraToken,
      { rawToken: args.rawApiToken },
    );

    return await ctx.runMutation(internal.samsaraAdmin.insertSamsaraIntegration, {
      workosOrgId: args.workosOrgId,
      encryptedApiToken: encryptedToken,
      environment: args.environment,
      createdBy: args.createdBy,
    });
  },
});

/**
 * Internal mutation half of createSamsaraIntegration. Idempotency:
 * if an existing Samsara integration row exists for this org, throw —
 * caller should explicitly revoke and recreate rather than silently
 * replace credentials.
 */
export const insertSamsaraIntegration = internalMutation({
  args: {
    workosOrgId: v.string(),
    encryptedApiToken: v.string(),
    environment: ENVIRONMENT,
    createdBy: v.string(),
  },
  returns: v.object({
    integrationId: v.id('orgIntegrations'),
    syncStateId: v.id('samsaraSyncState'),
  }),
  handler: async (ctx, args) => {
    const existing = await ctx.db
      .query('orgIntegrations')
      .withIndex('by_provider', (q) =>
        q.eq('workosOrgId', args.workosOrgId).eq('provider', 'samsara'),
      )
      .first();

    if (existing) {
      throw new Error(
        `Samsara integration already exists for org ${args.workosOrgId} ` +
          `(id=${existing._id}). Revoke it before creating a new one.`,
      );
    }

    const now = Date.now();
    const credentials = JSON.stringify({
      apiTokenEncrypted: args.encryptedApiToken,
      environment: args.environment,
    });

    const integrationId = await ctx.db.insert('orgIntegrations', {
      workosOrgId: args.workosOrgId,
      provider: 'samsara',
      credentials,
      syncSettings: {
        isEnabled: true,
      },
      lastSyncStats: {},
      createdBy: args.createdBy,
      createdAt: now,
      updatedAt: now,
    });

    const syncStateId = await ctx.db.insert('samsaraSyncState', {
      integrationId,
      workosOrgId: args.workosOrgId,
      updatedAt: now,
    });

    return { integrationId, syncStateId };
  },
});

/**
 * Set the Samsara vehicleId on a truck so that the backup-ingest cron
 * knows where to attribute incoming pings. Pass undefined to unmap.
 */
export const setTruckSamsaraVehicleId = internalMutation({
  args: {
    truckId: v.id('trucks'),
    samsaraVehicleId: v.optional(v.string()),
  },
  returns: v.null(),
  handler: async (ctx, args) => {
    const truck = await ctx.db.get(args.truckId);
    if (!truck) throw new Error(`Truck not found: ${args.truckId}`);

    // Guard against silently swapping a vehicleId out from under another
    // truck — Samsara vehicleIds are unique within an org's Samsara fleet,
    // so a collision means an onboarding mistake.
    if (args.samsaraVehicleId !== undefined) {
      const collision = await ctx.db
        .query('trucks')
        .withIndex('by_samsara_vehicle', (q) =>
          q.eq('samsaraVehicleId', args.samsaraVehicleId),
        )
        .first();
      if (collision && collision._id !== args.truckId) {
        throw new Error(
          `Samsara vehicleId ${args.samsaraVehicleId} is already mapped to ` +
            `truck ${collision._id} (unitId=${collision.unitId}).`,
        );
      }
    }

    await ctx.db.patch(args.truckId, {
      samsaraVehicleId: args.samsaraVehicleId,
      updatedAt: Date.now(),
    });
    return null;
  },
});

/**
 * Revoke a Samsara integration. Disables the cron (via isEnabled=false)
 * and clears the sync-state cursor so a fresh integration starts clean.
 * Does not delete the row — kept for audit history.
 */
export const revokeSamsaraIntegration = internalMutation({
  args: { integrationId: v.id('orgIntegrations') },
  returns: v.null(),
  handler: async (ctx, args) => {
    const integration = await ctx.db.get(args.integrationId);
    if (!integration) throw new Error(`Integration not found: ${args.integrationId}`);
    if (integration.provider !== 'samsara') {
      throw new Error(`Not a Samsara integration: ${args.integrationId}`);
    }

    const now = Date.now();
    await ctx.db.patch(args.integrationId, {
      syncSettings: { ...integration.syncSettings, isEnabled: false },
      updatedAt: now,
    });

    const syncState = await ctx.db
      .query('samsaraSyncState')
      .withIndex('by_integration', (q) => q.eq('integrationId', args.integrationId))
      .first();
    if (syncState) {
      await ctx.db.patch(syncState._id, {
        pollCursor: undefined,
        updatedAt: now,
      });
    }
    return null;
  },
});

// ============================================
// PUBLIC CONNECT ENDPOINT
// Called from the Settings → Integrations connect modal. Wraps the internal
// seed flow with a WorkOS auth check so the client can drive onboarding
// without an operator. Same atomic guarantees as the dashboard path:
// encrypts the token in the action (Node runtime) then inserts both the
// orgIntegrations and samsaraSyncState rows in one mutation.
// ============================================
export const connectSamsara = action({
  args: {
    workosOrgId: v.string(),
    rawApiToken: v.string(),
    environment: ENVIRONMENT,
  },
  returns: v.object({
    integrationId: v.id('orgIntegrations'),
    syncStateId: v.id('samsaraSyncState'),
  }),
  handler: async (ctx, args): Promise<{ integrationId: any; syncStateId: any }> => {
    const { userId } = await assertCallerOwnsOrg(ctx, args.workosOrgId);

    const encryptedToken: string = await ctx.runAction(
      internal.samsaraCrypto.encryptSamsaraToken,
      { rawToken: args.rawApiToken },
    );

    return await ctx.runMutation(internal.samsaraAdmin.insertSamsaraIntegration, {
      workosOrgId: args.workosOrgId,
      encryptedApiToken: encryptedToken,
      environment: args.environment,
      createdBy: userId,
    });
  },
});
