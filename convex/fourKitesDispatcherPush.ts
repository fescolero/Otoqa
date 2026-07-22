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

// Per-query read budget for the batched getLatestPositionsForLoads query.
// At ~5–10 driverLocations + dispatchLegs reads per load, 200 loads/chunk
// uses ~1–2k reads — well under Convex's 16k-doc query limit, leaving
// 8× headroom for outlier loads with many legs.
const POSITION_BATCH_CHUNK = 200;

// Truncate FK response bodies before persisting to keep the diagnostic
// row small (Convex doc-size limit is 1MB; we want this row << that).
const ERROR_BODY_MAX = 500;

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
    const tickStart = Date.now();

    // Telemetry counters — these flow into the fourKitesPushTickHealth
    // upsert at end-of-tick so a dashboard can answer "what just happened"
    // with a single by_org read.
    let skippedNoPing = 0;
    let skippedAlreadyPushed = 0;
    let batchesSent = 0;
    let batchOk = 0;
    let batchValidationFail = 0;
    let batchAuthFail = 0;
    let batchRateLimit = 0;
    let batchTransient = 0;
    let lastErrorKind: string | undefined;
    let lastErrorStatus: number | undefined;
    let lastErrorBody: string | undefined;

    const recordHealth = async (
      tickKind: 'empty' | 'ok' | 'partial' | 'all_failed',
      candidateCount: number,
      plansBuilt: number,
    ): Promise<void> => {
      await ctx.runMutation(
        internal.fourKitesDispatcherPushMutations.recordTickHealth,
        {
          workosOrgId: args.workosOrgId,
          tickKind,
          candidateCount,
          skippedNoPing,
          skippedAlreadyPushed,
          plansBuilt,
          batchesSent,
          batchOk,
          batchValidationFail,
          batchAuthFail,
          batchRateLimit,
          batchTransient,
          lastErrorKind,
          lastErrorStatus,
          lastErrorBody,
          tickDurationMs: Date.now() - tickStart,
        },
      );
    };

    const pushContext: { apiKey: string } | null = await ctx.runQuery(
      internal.fourKitesDispatcherPushMutations.getFourKitesPushContext,
      { workosOrgId: args.workosOrgId },
    );
    if (!pushContext) {
      // Integration vanished or disabled mid-cron. Treat as empty so the
      // health row reflects "nothing tried" rather than a stale value.
      await recordHealth('empty', 0, 0);
      console.log(
        `[fk-push] tick_summary orgId=${args.workosOrgId} kind=empty reason=no_integration durationMs=${Date.now() - tickStart}`,
      );
      return { pushedLoads: 0, skippedLoads: 0, failedLoads: 0 };
    }

    const candidates: Array<{
      loadId: any;
      externalLoadId: string;
      internalId: string;
      orderNumber: string;
      lastPushedRecordedAt?: number;
      pushStateId?: any;
    }> = await ctx.runQuery(
      internal.fourKitesDispatcherPushMutations.listFourKitesPushCandidates,
      { workosOrgId: args.workosOrgId },
    );

    if (candidates.length === 0) {
      await recordHealth('empty', 0, 0);
      console.log(
        `[fk-push] tick_summary orgId=${args.workosOrgId} kind=empty reason=no_candidates durationMs=${Date.now() - tickStart}`,
      );
      return { pushedLoads: 0, skippedLoads: 0, failedLoads: 0 };
    }

    // ─── Phase 1: gather per-load latest pings (BATCHED) ─────────────────
    // Previously this called ctx.runQuery(getLatestPosition) once per load,
    // burning ~7ms × N in Node↔V8 RPC overhead (~11s at 1,650 loads). The
    // new getLatestPositionsForLoads collapses each chunk to one roundtrip.
    // Chunk size is bounded by Convex's 16k-read-per-query cap.
    type LoadPlan = {
      candidate: (typeof candidates)[number];
      latestRecordedAtMs: number;
      latitude: number;
      longitude: number;
    };
    const plans: LoadPlan[] = [];

    for (let i = 0; i < candidates.length; i += POSITION_BATCH_CHUNK) {
      const chunk = candidates.slice(i, i + POSITION_BATCH_CHUNK);
      const chunkResults: Array<{
        loadId: string;
        position: {
          latitude: number;
          longitude: number;
          recordedAt: string;
        } | null;
      }> = await ctx.runQuery(
        internal.externalTracking.getLatestPositionsForLoads,
        {
          loadIds: chunk.map((c) => c.loadId as string),
          isSandbox: false,
        },
      );

      // Index by loadId for the next-pass join. Map preserves insertion
      // order but we need O(1) lookup by loadId.
      const byLoadId = new Map(
        chunkResults.map((r) => [r.loadId, r.position]),
      );

      for (const c of chunk) {
        const ping = byLoadId.get(c.loadId as string);
        if (!ping) {
          skippedNoPing++;
          continue;
        }
        const recordedAtMs = Date.parse(ping.recordedAt);
        if (!Number.isFinite(recordedAtMs)) {
          skippedNoPing++;
          continue;
        }
        if (
          c.lastPushedRecordedAt !== undefined &&
          recordedAtMs <= c.lastPushedRecordedAt
        ) {
          skippedAlreadyPushed++;
          continue;
        }
        plans.push({
          candidate: c,
          latestRecordedAtMs: recordedAtMs,
          latitude: ping.latitude,
          longitude: ping.longitude,
        });
      }
    }

    if (plans.length === 0) {
      // All candidates were either pingless or already-up-to-date. This
      // is "nothing to send right now" — NOT a failure.
      await recordHealth('empty', candidates.length, 0);
      console.log(
        `[fk-push] tick_summary orgId=${args.workosOrgId} kind=empty reason=no_fresh_pings ` +
          `candidates=${candidates.length} skippedNoPing=${skippedNoPing} ` +
          `skippedAlreadyPushed=${skippedAlreadyPushed} durationMs=${Date.now() - tickStart}`,
      );
      return {
        pushedLoads: 0,
        skippedLoads: skippedNoPing + skippedAlreadyPushed,
        failedLoads: 0,
      };
    }

    // ─── Phase 2: batch + POST ────────────────────────────────────────────
    const baseUrl = getFourKitesBaseUrl();
    let pushedLoads = 0;
    let failedLoads = 0;

    for (let i = 0; i < plans.length; i += MAX_UPDATES_PER_REQ) {
      const batch = plans.slice(i, i + MAX_UPDATES_PER_REQ);
      const updates: DispatcherUpdate[] = batch.map((p) => {
        // FK matches on the FourKites loadNumber (shipment.loadNumber from
        // inbound sync, persisted on the load as orderNumber). When that
        // wasn't present upstream, orderNumber is empty and the sync
        // helper falls back to using externalLoadId — mirror that here.
        const identifier =
          p.candidate.orderNumber && p.candidate.orderNumber.length > 0
            ? p.candidate.orderNumber
            : p.candidate.externalLoadId;
        return buildLocationUpdate({
          externalLoadId: identifier,
          // FK shipment id (their internal handle) — informational; their
          // support can use it to look up the load if they need to.
          rawIdentifier: p.candidate.externalLoadId,
          // identifierType defaults to 'loadNumber' (FK-standard).
          latitude: p.latitude,
          longitude: p.longitude,
          recordedAtMs: p.latestRecordedAtMs,
        });
      });

      const result = await postDispatcherUpdates({
        apiKey: pushContext.apiKey,
        baseUrl,
        updates,
      });
      batchesSent++;

      if (result.kind === 'ok') {
        await ctx.runMutation(
          internal.fourKitesDispatcherPushMutations.recordPushResults,
          {
            workosOrgId: args.workosOrgId,
            successes: batch.map((p, idx) => ({
              loadId: p.candidate.loadId,
              pushStateId: p.candidate.pushStateId,
              pushedRecordedAt: p.latestRecordedAtMs,
              requestId: result.requestId,
              // AUDIT-ONLY: persist the single-update body for this load
              // (not the batched body) so the per-load diagnostic can
              // surface exactly what we sent. See schema.ts note on
              // fourKitesPushState.lastRequestBody — safe to stop
              // populating once the integration is verified stable.
              requestBody: JSON.stringify(updates[idx]),
            })),
            failures: [],
          },
        );
        pushedLoads += batch.length;
        batchOk++;
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
        if (result.kind === 'auth_failed') {
          batchAuthFail++;
        } else {
          batchValidationFail++;
        }
        lastErrorKind = result.kind;
        lastErrorStatus = result.status;
        lastErrorBody = result.message.slice(0, ERROR_BODY_MAX);

        // Auth failure: stop pushing for this org this tick. Next cron tick
        // will re-attempt, but it'll keep failing until the key is fixed.
        if (result.kind === 'auth_failed') break;
        continue;
      }

      // rate_limited / transient_error — log AND capture diagnostics
      // before breaking so the health row reveals what FK actually returned.
      // No fourKitesPushState write because the per-load cursor must stay
      // unchanged; next tick will retry the same pings cleanly.
      if (result.kind === 'rate_limited') {
        batchRateLimit++;
        lastErrorKind = 'rate_limited';
        lastErrorStatus = 429;
        lastErrorBody = (result.responseBody ?? '').slice(0, ERROR_BODY_MAX);
        console.warn(
          `[fk-push] tick interrupted kind=rate_limited orgId=${args.workosOrgId} retryAfterSec=${result.retryAfterSec}`,
        );
      } else {
        batchTransient++;
        lastErrorKind = 'transient_error';
        lastErrorStatus = result.status;
        lastErrorBody = (result.responseBody ?? result.message).slice(
          0,
          ERROR_BODY_MAX,
        );
        console.warn(
          `[fk-push] tick interrupted kind=transient_error orgId=${args.workosOrgId} status=${result.status ?? 'n/a'} msg=${result.message.slice(0, 200)}`,
        );
      }
      break;
    }

    // ─── Tick health rollup ───────────────────────────────────────────────
    // `partial` = at least one batch ok'd AND at least one didn't.
    // `all_failed` = batches sent but none ok'd.
    // `ok` = every batch sent was accepted.
    const totalFailedBatches =
      batchValidationFail + batchAuthFail + batchRateLimit + batchTransient;
    const tickKind: 'ok' | 'partial' | 'all_failed' =
      batchOk > 0 && totalFailedBatches === 0
        ? 'ok'
        : batchOk > 0
          ? 'partial'
          : 'all_failed';

    await recordHealth(tickKind, candidates.length, plans.length);

    console.log(
      `[fk-push] tick_summary orgId=${args.workosOrgId} kind=${tickKind} ` +
        `candidates=${candidates.length} skippedNoPing=${skippedNoPing} ` +
        `skippedAlreadyPushed=${skippedAlreadyPushed} plansBuilt=${plans.length} ` +
        `batchesSent=${batchesSent} batchOk=${batchOk} ` +
        `batchValidationFail=${batchValidationFail} batchAuthFail=${batchAuthFail} ` +
        `batchRateLimit=${batchRateLimit} batchTransient=${batchTransient} ` +
        `durationMs=${Date.now() - tickStart} ` +
        `firstErrorBody=${lastErrorBody?.slice(0, 200) ?? 'n/a'}`,
    );

    return {
      pushedLoads,
      skippedLoads: skippedNoPing + skippedAlreadyPushed,
      failedLoads,
    };
  },
});

// Cross-org sweep lives in the V8 mutations file
// (fourKitesDispatcherPushMutations.listFourKitesOrgsWithIntegration) —
// V8 queries can't be defined alongside 'use node' actions.
