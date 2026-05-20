'use node';

import { v } from 'convex/values';
import {
  internalAction,
} from './_generated/server';
import { internal } from './_generated/api';
import {
  fetchVehicleStatsFeed,
  type SamsaraVehicleEntry,
  type SamsaraEnvironment,
} from './samsaraApiClient';

// ============================================
// SAMSARA INGEST — ORCHESTRATION
//
// Three layers:
//
//   pollAllIntegrations   (action, cron entry)
//        │   queries: getActiveSamsaraIntegrations
//        ▼
//   pollOneIntegration    (action, per integration)
//        │   queries: getIntegrationForPoll, listMappedSamsaraVehicleIds
//        │   actions: samsaraCrypto.decryptSamsaraToken
//        │   client:  fetchVehicleStatsFeed (drain hasNextPage, max 10 iters)
//        │   mutation: processVehicleStats (per Samsara batch)
//        │   mutation: updateSyncStateAfterTick (cursor + status + counters)
//        ▼
//   processVehicleStats   (mutation, in samsaraIngestMutations.ts)
//        │   builds pings, calls ingestBatch helper
//        ▼
//   driverLocations table
//
// Mutations live in samsaraIngestMutations.ts so we don't mix runtimes —
// this file is "use node" (needs fetch + crypto via samsaraCrypto chain),
// mutations are V8.
// ============================================

const MAX_DRAIN_ITERATIONS = 10;

export const pollAllIntegrations = internalAction({
  args: {},
  returns: v.object({
    integrationsProcessed: v.number(),
  }),
  handler: async (ctx): Promise<{ integrationsProcessed: number }> => {
    const integrations: Array<{ integrationId: any }> = await ctx.runQuery(
      internal.samsaraIngestMutations.getActiveSamsaraIntegrations,
      {},
    );

    // Sequential by design — most orgs have one integration; the few that
    // don't won't have so many that 10s isn't enough. Bounded-parallel
    // (Promise.all with concurrency limit) is a later optimization if
    // needed; sequential keeps Samsara rate-limit accounting trivially
    // predictable.
    for (const { integrationId } of integrations) {
      try {
        await ctx.runAction(internal.samsaraIngest.pollOneIntegration, {
          integrationId,
        });
      } catch (err) {
        // One integration's failure mustn't poison the rest of the tick.
        console.error(
          `[samsaraIngest] pollOneIntegration failed integrationId=${integrationId}`,
          err,
        );
      }
    }

    return { integrationsProcessed: integrations.length };
  },
});

export const pollOneIntegration = internalAction({
  args: { integrationId: v.id('orgIntegrations') },
  returns: v.object({
    ok: v.boolean(),
    pingsIngested: v.number(),
    pagesDrained: v.number(),
  }),
  handler: async (ctx, args): Promise<{
    ok: boolean;
    pingsIngested: number;
    pagesDrained: number;
  }> => {
    const context = await ctx.runQuery(
      internal.samsaraIngestMutations.getIntegrationForPoll,
      { integrationId: args.integrationId },
    );
    if (!context) {
      // Integration vanished between cron tick and now (revoked / deleted).
      return { ok: true, pingsIngested: 0, pagesDrained: 0 };
    }

    // Overlap guard. The cron fires every 10s but a slow Samsara response
    // or a stuck network call can push a tick past 10s — without this
    // claim, the next tick would race the previous one's cursor update
    // and cause OCC retries on samsaraSyncState. Lock auto-expires after
    // 30s so a genuinely hung tick can't block forever.
    const claim = await ctx.runMutation(
      internal.samsaraIngestMutations.tryClaimPollSlot,
      { syncStateId: context.syncStateId },
    );
    if (!claim.claimed) {
      console.log(
        `[samsaraIngest.pollOneIntegration] skipped integrationId=${args.integrationId} reason=${claim.reason}`,
      );
      return { ok: true, pingsIngested: 0, pagesDrained: 0 };
    }

    // Decrypt the API token in its own action (samsaraCrypto runs in node).
    const apiToken: string = await ctx.runAction(
      internal.samsaraCrypto.decryptSamsaraToken,
      { encryptedToken: context.encryptedApiToken },
    );

    // Optionally filter the feed to vehicles we actually map. Cuts payload
    // for orgs whose Samsara fleet is larger than their Otoqa fleet, and
    // avoids ingesting GPS for vehicles we'd just discard. If no mapped
    // trucks exist, there's nothing to do this tick.
    const mappedVehicleIds: string[] = await ctx.runQuery(
      internal.samsaraIngestMutations.listMappedSamsaraVehicleIds,
      { workosOrgId: context.workosOrgId },
    );
    if (mappedVehicleIds.length === 0) {
      await ctx.runMutation(
        internal.samsaraIngestMutations.updateSyncStateAfterTick,
        {
          syncStateId: context.syncStateId,
          newCursor: context.pollCursor,
          pingsIngested: 0,
          errorMessage: undefined,
        },
      );
      return { ok: true, pingsIngested: 0, pagesDrained: 0 };
    }

    let cursor = context.pollCursor;
    let totalIngested = 0;
    let pages = 0;
    let lastErrorMessage: string | undefined;
    let disableIntegration = false;

    for (let i = 0; i < MAX_DRAIN_ITERATIONS; i++) {
      const result = await fetchVehicleStatsFeed({
        apiToken,
        environment: context.environment as SamsaraEnvironment,
        cursor,
        vehicleIds: mappedVehicleIds,
      });

      if (result.kind === 'auth_failed') {
        lastErrorMessage = `auth_failed status=${result.status} msg=${result.message}`;
        disableIntegration = true;
        break;
      }
      if (result.kind === 'cursor_invalid') {
        lastErrorMessage = `cursor_invalid status=${result.status} msg=${result.message}`;
        cursor = undefined; // recover on next tick
        break;
      }
      if (result.kind === 'rate_limited') {
        lastErrorMessage = `rate_limited retryAfterSec=${result.retryAfterSec}`;
        break;
      }
      if (result.kind === 'transient_error') {
        lastErrorMessage = `transient_error status=${result.status ?? 'n/a'} msg=${result.message}`;
        break;
      }

      // ok
      pages++;
      // Project Samsara's response down to the exact shape our mutation
      // validator expects. Samsara periodically adds fields to GPS points
      // (isEcuSpeed, reverseGeo, address, etc.) and Convex's v.object()
      // rejects extras — projecting at the boundary keeps the mutation
      // validator strict without making us brittle to upstream additions.
      const vehicleEntries = (result.body.data as SamsaraVehicleEntry[]).map(
        (entry) => ({
          id: entry.id,
          name: entry.name,
          gps: entry.gps?.map((p) => ({
            latitude: p.latitude,
            longitude: p.longitude,
            headingDegrees: p.headingDegrees,
            speedMilesPerHour: p.speedMilesPerHour,
            time: p.time,
          })),
        }),
      );
      const ingestResult = await ctx.runMutation(
        internal.samsaraIngestMutations.processVehicleStats,
        {
          workosOrgId: context.workosOrgId,
          vehicleEntries,
        },
      );
      totalIngested += ingestResult.pingsIngested;
      cursor = result.body.pagination.endCursor;
      if (!result.body.pagination.hasNextPage) break;
    }

    await ctx.runMutation(
      internal.samsaraIngestMutations.updateSyncStateAfterTick,
      {
        syncStateId: context.syncStateId,
        newCursor: cursor,
        pingsIngested: totalIngested,
        errorMessage: lastErrorMessage,
      },
    );

    if (disableIntegration) {
      await ctx.runMutation(
        internal.samsaraIngestMutations.disableIntegration,
        { integrationId: args.integrationId, reason: lastErrorMessage ?? 'auth_failed' },
      );
    }

    return { ok: !disableIntegration && !lastErrorMessage, pingsIngested: totalIngested, pagesDrained: pages };
  },
});
