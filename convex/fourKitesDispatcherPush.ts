'use node';

import { v } from 'convex/values';
import { internalAction } from './_generated/server';
import { internal } from './_generated/api';
import {
  postDispatcherUpdates,
  buildLocationUpdate,
  type DispatcherUpdate,
} from './fourKitesDispatcherClient';

// ============================================
// FOURKITES DISPATCHER PUSH — orchestration
//
// Cron-driven (60s). Each tick:
//   1. Walk every org with an active FourKites integration.
//   2. For each org: list FK-sourced loads in In Transit / Pending state.
//   3. For each load: read the latest ping via externalTracking.getLatestPosition
//      (already implements the session-window union + 30-min approach cap,
//      including the pre-check-in fallback).
//   4. Skip if no ping OR the ping's recordedAt <= lastPushedRecordedAt
//      (dedup against republishing the same point).
//   5. Build DispatcherUpdate entries, batch into groups of MAX_UPDATES_PER_REQ,
//      POST each batch.
//   6. Record per-load successes / non-retryable failures.
// ============================================

// FourKites rate limit: 60 req/min per key. One request can carry many
// updates, so even at hundreds of active loads per org we're well under.
// Cap per-batch size to keep payloads reasonable and to amortize cost of
// a single API call across many loads.
const MAX_UPDATES_PER_REQ = 100;

// Default FourKites base URL. Override via env for staging in dev/test.
function getFourKitesBaseUrl(): string {
  return (
    process.env.FOURKITES_DISPATCHER_URL ??
    'https://api.fourkites.com'
  );
}

export const pushFourKitesUpdates = internalAction({
  args: {},
  returns: v.object({
    orgsProcessed: v.number(),
    pushedLoads: v.number(),
    skippedLoads: v.number(),
    failedLoads: v.number(),
  }),
  handler: async (ctx): Promise<{
    orgsProcessed: number;
    pushedLoads: number;
    skippedLoads: number;
    failedLoads: number;
  }> => {
    // Find every org with an active FourKites integration. We collect across
    // orgIntegrations rather than carry our own cross-org table — same
    // pattern as the Samsara poll cron uses.
    const orgIds: string[] = await ctx.runQuery(
      internal.fourKitesDispatcherPushMutations.listFourKitesOrgsWithIntegration,
      {},
    );

    let pushedLoads = 0;
    let skippedLoads = 0;
    let failedLoads = 0;

    for (const workosOrgId of orgIds) {
      try {
        const result = await ctx.runAction(
          internal.fourKitesDispatcherPush.pushOneOrg,
          { workosOrgId },
        );
        pushedLoads += result.pushedLoads;
        skippedLoads += result.skippedLoads;
        failedLoads += result.failedLoads;
      } catch (err) {
        console.error(
          `[fourKitesDispatcherPush] pushOneOrg failed orgId=${workosOrgId}`,
          err,
        );
      }
    }

    return {
      orgsProcessed: orgIds.length,
      pushedLoads,
      skippedLoads,
      failedLoads,
    };
  },
});

export const pushOneOrg = internalAction({
  args: { workosOrgId: v.string() },
  returns: v.object({
    pushedLoads: v.number(),
    skippedLoads: v.number(),
    failedLoads: v.number(),
  }),
  handler: async (ctx, args): Promise<{
    pushedLoads: number;
    skippedLoads: number;
    failedLoads: number;
  }> => {
    const pushContext: { apiKey: string } | null = await ctx.runQuery(
      internal.fourKitesDispatcherPushMutations.getFourKitesPushContext,
      { workosOrgId: args.workosOrgId },
    );
    if (!pushContext) {
      return { pushedLoads: 0, skippedLoads: 0, failedLoads: 0 };
    }

    const candidates: Array<{
      loadId: any;
      externalLoadId: string;
      internalId: string;
      lastPushedRecordedAt?: number;
      pushStateId?: any;
    }> = await ctx.runQuery(
      internal.fourKitesDispatcherPushMutations.listFourKitesPushCandidates,
      { workosOrgId: args.workosOrgId },
    );

    if (candidates.length === 0) {
      return { pushedLoads: 0, skippedLoads: 0, failedLoads: 0 };
    }

    // ─── Phase 1: gather per-load latest pings ────────────────────────────
    // Sequential through ctx.runQuery — these are cheap indexed reads
    // (getLatestPosition is bounded to legCount + 1 candidate pings per load).
    // For huge orgs we'd want parallel, but sequential keeps memory predictable.
    type LoadPlan = {
      candidate: (typeof candidates)[number];
      latestRecordedAtMs: number;
      latitude: number;
      longitude: number;
    };
    const plans: LoadPlan[] = [];
    let skippedLoads = 0;

    for (const c of candidates) {
      const ping: {
        latitude: number;
        longitude: number;
        recordedAt: string;
      } | null = await ctx.runQuery(
        internal.externalTracking.getLatestPosition,
        {
          loadId: c.loadId as any,
          isSandbox: false,
        },
      );
      if (!ping) {
        skippedLoads++;
        continue;
      }
      const recordedAtMs = Date.parse(ping.recordedAt);
      if (!Number.isFinite(recordedAtMs)) {
        skippedLoads++;
        continue;
      }
      if (
        c.lastPushedRecordedAt !== undefined &&
        recordedAtMs <= c.lastPushedRecordedAt
      ) {
        skippedLoads++;
        continue;
      }
      plans.push({
        candidate: c,
        latestRecordedAtMs: recordedAtMs,
        latitude: ping.latitude,
        longitude: ping.longitude,
      });
    }

    if (plans.length === 0) {
      return { pushedLoads: 0, skippedLoads, failedLoads: 0 };
    }

    // ─── Phase 2: batch + POST ────────────────────────────────────────────
    const baseUrl = getFourKitesBaseUrl();
    let pushedLoads = 0;
    let failedLoads = 0;

    for (let i = 0; i < plans.length; i += MAX_UPDATES_PER_REQ) {
      const batch = plans.slice(i, i + MAX_UPDATES_PER_REQ);
      const updates: DispatcherUpdate[] = batch.map((p) =>
        buildLocationUpdate({
          externalLoadId: p.candidate.externalLoadId,
          rawIdentifier: p.candidate.internalId,
          // identifierType defaults to 'BillOfLading' per V1 decision.
          latitude: p.latitude,
          longitude: p.longitude,
          recordedAtMs: p.latestRecordedAtMs,
        }),
      );

      const result = await postDispatcherUpdates({
        apiKey: pushContext.apiKey,
        baseUrl,
        updates,
      });

      if (result.kind === 'ok') {
        await ctx.runMutation(
          internal.fourKitesDispatcherPushMutations.recordPushResults,
          {
            workosOrgId: args.workosOrgId,
            successes: batch.map((p) => ({
              loadId: p.candidate.loadId,
              pushStateId: p.candidate.pushStateId,
              pushedRecordedAt: p.latestRecordedAtMs,
              requestId: result.requestId,
            })),
            failures: [],
          },
        );
        pushedLoads += batch.length;
        continue;
      }

      // Non-retryable errors → record per-load failure so the row carries
      // the diagnostic. Retryable errors (rate_limit / transient) → break
      // out of the batch loop; next cron tick retries naturally.
      if (
        result.kind === 'validation_failed' ||
        result.kind === 'auth_failed'
      ) {
        const errLabel =
          result.kind === 'auth_failed'
            ? `auth_failed status=${result.status} ${result.message}`
            : `validation_failed status=${result.status} ${result.message}`;

        await ctx.runMutation(
          internal.fourKitesDispatcherPushMutations.recordPushResults,
          {
            workosOrgId: args.workosOrgId,
            successes: [],
            failures: batch.map((p) => ({
              loadId: p.candidate.loadId,
              pushStateId: p.candidate.pushStateId,
              error: errLabel,
            })),
          },
        );
        failedLoads += batch.length;

        // Auth failure: stop pushing for this org this tick. Next cron tick
        // will re-attempt, but it'll keep failing until the key is fixed.
        if (result.kind === 'auth_failed') break;
        continue;
      }

      // rate_limited / transient_error — log and break. No state mutation
      // means next tick retries the same pings cleanly.
      console.warn(
        `[fourKitesDispatcherPush] tick interrupted kind=${result.kind} orgId=${args.workosOrgId}`,
      );
      break;
    }

    return { pushedLoads, skippedLoads, failedLoads };
  },
});

// Cross-org sweep lives in the V8 mutations file
// (fourKitesDispatcherPushMutations.listFourKitesOrgsWithIntegration) —
// V8 queries can't be defined alongside 'use node' actions.
