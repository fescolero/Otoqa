import { v } from 'convex/values';
import { internalMutation, internalQuery, query } from './_generated/server';
import { assertCallerOwnsOrg } from './lib/auth';

// ============================================
// SAMSARA VEHICLE MAPPING — V8-runtime helpers
// Counterpart to samsaraVehicleMapping.ts ("use node" action). Split so
// the public action can stay Node-only (for outbound fetch) while DB
// reads/writes stay in V8.
// ============================================

/**
 * Read the org's Samsara integration credentials (encrypted token +
 * environment). Returns null when no Samsara integration exists or it has
 * been disabled — the public action turns that into a user-facing error.
 */
export const getSamsaraCredsForOrg = internalQuery({
  args: { workosOrgId: v.string() },
  returns: v.union(
    v.null(),
    v.object({
      encryptedApiToken: v.string(),
      environment: v.union(v.literal('sandbox'), v.literal('production')),
    }),
  ),
  handler: async (ctx, args) => {
    const integration = await ctx.db
      .query('orgIntegrations')
      .withIndex('by_provider', (q) =>
        q.eq('workosOrgId', args.workosOrgId).eq('provider', 'samsara'),
      )
      .first();
    if (!integration) return null;
    if (!integration.syncSettings?.isEnabled) return null;

    let parsed: {
      apiTokenEncrypted: string;
      environment: 'sandbox' | 'production';
    };
    try {
      parsed = JSON.parse(integration.credentials);
    } catch {
      return null;
    }
    if (!parsed.apiTokenEncrypted || !parsed.environment) return null;

    return {
      encryptedApiToken: parsed.apiTokenEncrypted,
      environment: parsed.environment,
    };
  },
});

/**
 * Public read-only view of every truck in the org that currently has a
 * Samsara mapping. No Samsara API call — just a DB read — so it's free to
 * call repeatedly. Used by the Manage modal's "Current mappings" table so
 * the user can verify what's stored without re-running Map Fleet.
 *
 * The Samsara-side details (name, VIN) aren't included because we don't
 * have them without an API call. The samsaraVehicleId is the only Samsara
 * value we persist on `trucks` — the UI shows it directly and the user can
 * cross-reference with their Samsara dashboard if needed.
 */
export const listSamsaraMappedTrucks = query({
  args: { workosOrgId: v.string() },
  returns: v.array(
    v.object({
      truckId: v.id('trucks'),
      unitId: v.string(),
      otoqaVin: v.string(),
      samsaraVehicleId: v.string(),
    }),
  ),
  handler: async (ctx, args) => {
    await assertCallerOwnsOrg(ctx, args.workosOrgId);
    const trucks = await ctx.db
      .query('trucks')
      .withIndex('by_organization', (q) =>
        q.eq('organizationId', args.workosOrgId),
      )
      .collect();
    return trucks
      .filter((t) => !t.isDeleted && !!t.samsaraVehicleId)
      .map((t) => ({
        truckId: t._id,
        unitId: t.unitId,
        otoqaVin: t.vin,
        samsaraVehicleId: t.samsaraVehicleId!,
      }));
  },
});

/**
 * Trucks for an org that participate in fleet mapping. Excludes soft-deleted
 * trucks. Returns the minimum fields the matcher needs.
 */
export const listOtoqaTrucksForMapping = internalQuery({
  args: { workosOrgId: v.string() },
  returns: v.array(
    v.object({
      truckId: v.id('trucks'),
      unitId: v.string(),
      vin: v.string(),
      samsaraVehicleId: v.optional(v.string()),
    }),
  ),
  handler: async (ctx, args) => {
    const trucks = await ctx.db
      .query('trucks')
      .withIndex('by_organization', (q) =>
        q.eq('organizationId', args.workosOrgId),
      )
      .collect();
    return trucks
      .filter((t) => !t.isDeleted)
      .map((t) => ({
        truckId: t._id,
        unitId: t.unitId,
        vin: t.vin,
        samsaraVehicleId: t.samsaraVehicleId,
      }));
  },
});

/**
 * Apply a batch of truck → samsaraVehicleId mappings.
 *
 * Per-pair collision guard: skip pairs where the samsaraVehicleId is already
 * claimed by a different truck. We report skips rather than throwing — the
 * action then surfaces them in the final report so the user can investigate.
 * Throwing here would roll back valid mappings on the first conflict.
 */
export const applyVinMappings = internalMutation({
  args: {
    pairs: v.array(
      v.object({
        truckId: v.id('trucks'),
        samsaraVehicleId: v.string(),
      }),
    ),
  },
  returns: v.object({
    applied: v.number(),
    skippedCollisions: v.array(
      v.object({
        truckId: v.id('trucks'),
        samsaraVehicleId: v.string(),
        collidedWithTruckId: v.id('trucks'),
      }),
    ),
  }),
  handler: async (ctx, args) => {
    let applied = 0;
    const skippedCollisions: Array<{
      truckId: any;
      samsaraVehicleId: string;
      collidedWithTruckId: any;
    }> = [];

    const now = Date.now();
    for (const pair of args.pairs) {
      const truck = await ctx.db.get(pair.truckId);
      if (!truck || truck.isDeleted) continue;

      // Same collision guard as setTruckSamsaraVehicleId — a vehicleId
      // can only be claimed by one truck. If it's already on another
      // truck, skip and report.
      const collision = await ctx.db
        .query('trucks')
        .withIndex('by_samsara_vehicle', (q) =>
          q.eq('samsaraVehicleId', pair.samsaraVehicleId),
        )
        .first();
      if (collision && collision._id !== pair.truckId) {
        skippedCollisions.push({
          truckId: pair.truckId,
          samsaraVehicleId: pair.samsaraVehicleId,
          collidedWithTruckId: collision._id,
        });
        continue;
      }

      await ctx.db.patch(pair.truckId, {
        samsaraVehicleId: pair.samsaraVehicleId,
        updatedAt: now,
      });
      applied++;
    }

    return { applied, skippedCollisions };
  },
});
