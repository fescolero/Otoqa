import { v } from 'convex/values';
import { internalMutation, internalQuery } from './_generated/server';
import { Doc, Id } from './_generated/dataModel';
import { ingestBatch, type PingInput } from './driverLocations';
import { resolvePingContext } from './samsaraResolve';

// ============================================
// SAMSARA INGEST — V8-runtime queries and mutations
// Counterpart to samsaraIngest.ts ("use node" actions). Split so each
// runtime file stays single-purpose.
// ============================================

// ============================================
// QUERIES — called from pollAllIntegrations / pollOneIntegration
// ============================================

export const getActiveSamsaraIntegrations = internalQuery({
  args: {},
  returns: v.array(
    v.object({
      integrationId: v.id('orgIntegrations'),
    }),
  ),
  handler: async (ctx) => {
    // No global "all-orgs by provider" index on orgIntegrations today —
    // by_provider is keyed on (workosOrgId, provider). For the cron we
    // need a cross-org sweep. .collect() across `orgIntegrations` is fine
    // at expected fleet size (tens to low hundreds of org rows). If this
    // ever grows, add `by_provider_only` index on `[provider]`.
    const all = await ctx.db.query('orgIntegrations').collect();
    return all
      .filter(
        (i) =>
          i.provider === 'samsara' &&
          i.syncSettings?.isEnabled === true,
      )
      .map((i) => ({ integrationId: i._id }));
  },
});

export const getIntegrationForPoll = internalQuery({
  args: { integrationId: v.id('orgIntegrations') },
  returns: v.union(
    v.null(),
    v.object({
      workosOrgId: v.string(),
      encryptedApiToken: v.string(),
      environment: v.union(v.literal('sandbox'), v.literal('production')),
      syncStateId: v.id('samsaraSyncState'),
      pollCursor: v.optional(v.string()),
    }),
  ),
  handler: async (ctx, args) => {
    const integration = await ctx.db.get(args.integrationId);
    if (!integration || integration.provider !== 'samsara') return null;
    if (!integration.syncSettings?.isEnabled) return null;

    let parsed: { apiTokenEncrypted: string; environment: 'sandbox' | 'production' };
    try {
      parsed = JSON.parse(integration.credentials);
    } catch {
      console.error(
        `[samsara] integration ${integration._id} has malformed credentials JSON`,
      );
      return null;
    }
    if (!parsed.apiTokenEncrypted || !parsed.environment) {
      console.error(
        `[samsara] integration ${integration._id} credentials missing required fields`,
      );
      return null;
    }

    const syncState = await ctx.db
      .query('samsaraSyncState')
      .withIndex('by_integration', (q) =>
        q.eq('integrationId', integration._id),
      )
      .first();
    if (!syncState) {
      // Should never happen — the seed flow creates them together. Log
      // and bail so the next tick's drift-fix can run.
      console.error(
        `[samsara] integration ${integration._id} missing companion samsaraSyncState row`,
      );
      return null;
    }

    return {
      workosOrgId: integration.workosOrgId,
      encryptedApiToken: parsed.apiTokenEncrypted,
      environment: parsed.environment,
      syncStateId: syncState._id,
      pollCursor: syncState.pollCursor,
    };
  },
});

export const listMappedSamsaraVehicleIds = internalQuery({
  args: { workosOrgId: v.string() },
  returns: v.array(v.string()),
  handler: async (ctx, args) => {
    const trucks = await ctx.db
      .query('trucks')
      .withIndex('by_organization', (q) =>
        q.eq('organizationId', args.workosOrgId),
      )
      .collect();
    const ids: string[] = [];
    for (const t of trucks) {
      if (t.isDeleted) continue;
      if (t.samsaraVehicleId) ids.push(t.samsaraVehicleId);
    }
    return ids;
  },
});

// ============================================
// MUTATIONS
// ============================================

const samsaraGpsPointValidator = v.object({
  latitude: v.number(),
  longitude: v.number(),
  headingDegrees: v.optional(v.number()),
  speedMilesPerHour: v.optional(v.number()),
  time: v.string(), // RFC 3339
});

const samsaraVehicleEntryValidator = v.object({
  id: v.string(),
  name: v.string(),
  gps: v.optional(v.array(samsaraGpsPointValidator)),
});

const MPH_TO_MPS = 0.44704;
// Hardware vehicle GPS doesn't expose accuracy in the stats feed. Defaulting
// to 5m matches Samsara's documented typical accuracy for their ELD GPS
// units. driverLocations.accuracy is optional, so we could also omit it —
// but downstream consumers that prefer concrete numbers (e.g. dispatcher
// freshness UI) read better with a sensible default.
const DEFAULT_SAMSARA_ACCURACY_M = 5;

/**
 * Ingest a single batch of Samsara vehicle stats. For each vehicle entry:
 *   - look up its Otoqa truck via samsaraVehicleId (org-scoped guard)
 *   - resolve the ping context (open session → ACTIVE leg → trackingType)
 *   - convert MPH → m/s, ISO time → epoch ms, default accuracy
 *   - aggregate into one pings[] array and call the shared ingestBatch helper
 */
export const processVehicleStats = internalMutation({
  args: {
    workosOrgId: v.string(),
    vehicleEntries: v.array(samsaraVehicleEntryValidator),
  },
  returns: v.object({
    pingsIngested: v.number(),
    vehiclesSkipped: v.number(),
    orphanPingsDropped: v.number(),
  }),
  handler: async (ctx, args) => {
    const pings: PingInput[] = [];
    let vehiclesSkipped = 0;
    let orphanPingsDropped = 0;

    // Per-truck resolver result cache. Multiple GPS points for the same
    // vehicle within one batch hit the same session+leg; resolving once
    // saves N-1 lookups per vehicle.
    type ResolvedSlot =
      | { kind: 'ok'; ctx: NonNullable<Awaited<ReturnType<typeof resolvePingContext>>> }
      | { kind: 'no_session' }
      | { kind: 'no_truck' };
    const truckCache = new Map<string, ResolvedSlot>();

    for (const entry of args.vehicleEntries) {
      if (!entry.gps || entry.gps.length === 0) continue;

      let slot = truckCache.get(entry.id);
      if (!slot) {
        const truck = await lookupTruck(ctx, entry.id, args.workosOrgId);
        if (!truck) {
          slot = { kind: 'no_truck' };
        } else {
          const resolved = await resolvePingContext(ctx, truck);
          slot = resolved
            ? { kind: 'ok', ctx: resolved }
            : { kind: 'no_session' };
        }
        truckCache.set(entry.id, slot);
      }

      if (slot.kind === 'no_truck') {
        vehiclesSkipped++;
        continue;
      }
      if (slot.kind === 'no_session') {
        orphanPingsDropped += entry.gps.length;
        continue;
      }

      const resolvedCtx = slot.ctx;
      for (const point of entry.gps) {
        const recordedAt = Date.parse(point.time);
        if (Number.isNaN(recordedAt)) continue;

        const ping: PingInput = {
          driverId: resolvedCtx.driverId,
          sessionId: resolvedCtx.sessionId,
          loadId: resolvedCtx.loadId,
          latitude: point.latitude,
          longitude: point.longitude,
          accuracy: DEFAULT_SAMSARA_ACCURACY_M,
          speed:
            point.speedMilesPerHour !== undefined
              ? point.speedMilesPerHour * MPH_TO_MPS
              : undefined,
          heading: point.headingDegrees,
          trackingType: resolvedCtx.trackingType,
          recordedAt,
          source: 'SAMSARA',
        };
        pings.push(ping);
      }
    }

    if (pings.length === 0) {
      return { pingsIngested: 0, vehiclesSkipped, orphanPingsDropped };
    }

    const outcome = await ingestBatch(ctx, pings, args.workosOrgId);
    return {
      pingsIngested: outcome.inserted,
      vehiclesSkipped,
      orphanPingsDropped,
    };
  },
});

async function lookupTruck(
  ctx: { db: { query: any } },
  samsaraVehicleId: string,
  workosOrgId: string,
): Promise<Doc<'trucks'> | null> {
  const truck = await ctx.db
    .query('trucks')
    .withIndex('by_samsara_vehicle', (q: any) =>
      q.eq('samsaraVehicleId', samsaraVehicleId),
    )
    .first();
  if (!truck) return null;
  // Tenant boundary — paranoid double-check on top of the per-org feed filter.
  if (truck.organizationId !== workosOrgId) return null;
  if (truck.isDeleted) return null;
  return truck;
}

export const updateSyncStateAfterTick = internalMutation({
  args: {
    syncStateId: v.id('samsaraSyncState'),
    newCursor: v.optional(v.string()),
    pingsIngested: v.number(),
    errorMessage: v.optional(v.string()),
  },
  returns: v.null(),
  handler: async (ctx, args) => {
    const now = Date.now();
    const patch: {
      pollCursor?: string;
      lastPolledAt: number;
      lastTickPingsIngested: number;
      lastErrorAt?: number;
      lastErrorMessage?: string;
      updatedAt: number;
    } = {
      pollCursor: args.newCursor,
      lastPolledAt: now,
      lastTickPingsIngested: args.pingsIngested,
      updatedAt: now,
    };
    if (args.errorMessage !== undefined) {
      patch.lastErrorAt = now;
      patch.lastErrorMessage = args.errorMessage;
    }
    await ctx.db.patch(args.syncStateId, patch);
    return null;
  },
});

export const disableIntegration = internalMutation({
  args: {
    integrationId: v.id('orgIntegrations'),
    reason: v.string(),
  },
  returns: v.null(),
  handler: async (ctx, args) => {
    const integration = await ctx.db.get(args.integrationId);
    if (!integration) return null;
    await ctx.db.patch(args.integrationId, {
      syncSettings: { ...integration.syncSettings, isEnabled: false },
      lastSyncStats: {
        ...integration.lastSyncStats,
        lastSyncStatus: 'failed',
        errorMessage: args.reason,
        lastSyncTime: Date.now(),
      },
      updatedAt: Date.now(),
    });
    console.error(
      `[samsara] disabled integration ${args.integrationId} reason=${args.reason}`,
    );
    return null;
  },
});

// ============================================
// HEALTH SNAPSHOT — for ops tooling
// ============================================

/**
 * Snapshot of every Samsara integration's runtime health for ops UI / CLI.
 * Joins orgIntegrations + samsaraSyncState + mapped-truck count in a
 * single read so the caller doesn't have to fan out. Keep this list short
 * enough that an unbounded sweep stays cheap; if integration count ever
 * gets large, paginate.
 */
export const getSamsaraIntegrationHealth = internalQuery({
  args: {},
  returns: v.array(
    v.object({
      integrationId: v.id('orgIntegrations'),
      workosOrgId: v.string(),
      isEnabled: v.boolean(),
      lastPolledAt: v.optional(v.number()),
      lastTickPingsIngested: v.optional(v.number()),
      lastErrorAt: v.optional(v.number()),
      lastErrorMessage: v.optional(v.string()),
      mappedTruckCount: v.number(),
    }),
  ),
  handler: async (ctx) => {
    const all = await ctx.db.query('orgIntegrations').collect();
    const samsaraIntegrations = all.filter((i) => i.provider === 'samsara');

    const rows: Array<{
      integrationId: Id<'orgIntegrations'>;
      workosOrgId: string;
      isEnabled: boolean;
      lastPolledAt?: number;
      lastTickPingsIngested?: number;
      lastErrorAt?: number;
      lastErrorMessage?: string;
      mappedTruckCount: number;
    }> = [];

    for (const integration of samsaraIntegrations) {
      const syncState = await ctx.db
        .query('samsaraSyncState')
        .withIndex('by_integration', (q) =>
          q.eq('integrationId', integration._id),
        )
        .first();

      const trucks = await ctx.db
        .query('trucks')
        .withIndex('by_organization', (q) =>
          q.eq('organizationId', integration.workosOrgId),
        )
        .collect();
      const mappedTruckCount = trucks.filter(
        (t) => !t.isDeleted && !!t.samsaraVehicleId,
      ).length;

      rows.push({
        integrationId: integration._id,
        workosOrgId: integration.workosOrgId,
        isEnabled: integration.syncSettings?.isEnabled ?? false,
        lastPolledAt: syncState?.lastPolledAt,
        lastTickPingsIngested: syncState?.lastTickPingsIngested,
        lastErrorAt: syncState?.lastErrorAt,
        lastErrorMessage: syncState?.lastErrorMessage,
        mappedTruckCount,
      });
    }

    return rows;
  },
});
