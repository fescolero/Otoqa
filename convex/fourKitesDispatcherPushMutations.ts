import { v } from 'convex/values';
import { internalMutation, internalQuery } from './_generated/server';
import type { Id } from './_generated/dataModel';
import { parseStopDateTime } from './_helpers/timeUtils';

// ============================================
// FOURKITES DISPATCHER PUSH — V8-runtime queries and mutations
// Counterpart to fourKitesDispatcherPush.ts ('use node' action). Split so
// each runtime file stays single-purpose.
// ============================================

/**
 * The FourKites pull writes externalSource as "FourKites" (PascalCase) —
 * see convex/fourKitesSyncHelpers.ts. The schema comment says 'FOURKITES'
 * (uppercase) but actual data is mixed-case. The partner API at
 * convex/externalTracking.ts:resolveLoad already handles both as a
 * fallback; we do the same here so the push cron picks up every FK load
 * regardless of which casing variant it carries.
 */
function isFourKitesSource(externalSource: string | undefined): boolean {
  if (!externalSource) return false;
  return externalSource === 'FourKites' || externalSource === 'FOURKITES';
}

// ============================================
// QUERIES
// ============================================

/**
 * Cross-org sweep: list every workosOrgId that has an active FourKites
 * integration. The push cron uses this to find which orgs to process each
 * tick. Filters provider at the by_provider_only index level so we only
 * scan FK-provider rows; isEnabled is a nested field that stays in JS.
 */
export const listFourKitesOrgsWithIntegration = internalQuery({
  args: {},
  returns: v.array(v.string()),
  handler: async (ctx) => {
    const fourkitesIntegrations = await ctx.db
      .query('orgIntegrations')
      .withIndex('by_provider_only', (q) => q.eq('provider', 'fourkites'))
      .collect();
    const seen = new Set<string>();
    for (const i of fourkitesIntegrations) {
      if (!i.syncSettings?.isEnabled) continue;
      seen.add(i.workosOrgId);
    }
    return Array.from(seen);
  },
});

/**
 * Resolve the FourKites push context for one org: API key + active flag.
 * Reuses the same orgIntegrations row that powers the FourKites pull — one
 * credential bundle for all FourKites operations per org.
 *
 * Returns null when no integration exists, syncSettings.isEnabled is false,
 * or credentials don't include a usable apiKey.
 */
export const getFourKitesPushContext = internalQuery({
  args: { workosOrgId: v.string() },
  returns: v.union(
    v.null(),
    v.object({
      apiKey: v.string(),
    }),
  ),
  handler: async (ctx, args) => {
    const integration = await ctx.db
      .query('orgIntegrations')
      .withIndex('by_provider', (q) =>
        q.eq('workosOrgId', args.workosOrgId).eq('provider', 'fourkites'),
      )
      .first();
    if (!integration) return null;
    if (!integration.syncSettings?.isEnabled) return null;

    const apiKey = extractApiKey(integration.credentials);
    if (!apiKey) return null;
    return { apiKey };
  },
});

/**
 * Resolve a single FK load's push-payload inputs by loadRef (internalId
 * preferred, externalLoadId as fallback). Used by the previewPushPayload
 * action so we can show the customer/client the EXACT body we'd send for
 * a specific load, without having to also POST it.
 *
 * Returns null if the load isn't found in this org or isn't FK-sourced.
 */
export const getPushPayloadInputsForLoad = internalQuery({
  args: {
    workosOrgId: v.string(),
    loadRef: v.string(),
  },
  returns: v.union(
    v.null(),
    v.object({
      loadId: v.id('loadInformation'),
      internalId: v.string(),
      externalLoadId: v.string(),
      orderNumber: v.string(),
      trackingStatus: v.string(),
    }),
  ),
  handler: async (ctx, args) => {
    let load = await ctx.db
      .query('loadInformation')
      .withIndex('by_internal_id', (q) =>
        q.eq('workosOrgId', args.workosOrgId).eq('internalId', args.loadRef),
      )
      .first();
    if (!load) {
      load =
        (await ctx.db
          .query('loadInformation')
          .withIndex('by_external_id', (q: any) =>
            q.eq('externalSource', 'FourKites').eq('externalLoadId', args.loadRef),
          )
          .first()) ||
        (await ctx.db
          .query('loadInformation')
          .withIndex('by_external_id', (q: any) =>
            q.eq('externalSource', 'FOURKITES').eq('externalLoadId', args.loadRef),
          )
          .first());
      if (load && load.workosOrgId !== args.workosOrgId) load = null;
    }
    if (!load) return null;
    if (!isFourKitesSource(load.externalSource)) return null;
    if (!load.externalLoadId) return null;

    return {
      loadId: load._id,
      internalId: load.internalId,
      externalLoadId: load.externalLoadId,
      orderNumber: load.orderNumber ?? '',
      trackingStatus: load.trackingStatus,
    };
  },
});

/**
 * List FourKites loads that are candidates for a push tick.
 *
 * Filter:
 *   - externalSource === 'FOURKITES' (so we have a Dispatcher identifier)
 *   - externalLoadId is set (required for identifierKeys[].identifier)
 *   - trackingStatus IN ('In Transit', 'Pending')
 *     — 'In Transit' covers post-check-in.
 *     — 'Pending' covers pre-check-in approach pings (the partner's whole
 *        ask: see pings BEFORE the driver checks in).
 *
 * Result rides on the by_org_tracking_status index for both branches.
 * Each row carries its companion fourKitesPushState cursor (if any) so the
 * action can dedup without a second N+1 query.
 */
export const listFourKitesPushCandidates = internalQuery({
  args: { workosOrgId: v.string() },
  returns: v.array(
    v.object({
      loadId: v.id('loadInformation'),
      externalLoadId: v.string(),
      internalId: v.string(),
      // FK loadNumber (shipment.loadNumber) — what FK matches against.
      // Empty string when inbound sync didn't have a loadNumber upstream;
      // the action falls back to externalLoadId in that case.
      orderNumber: v.string(),
      lastPushedRecordedAt: v.optional(v.number()),
      pushStateId: v.optional(v.id('fourKitesPushState')),
    }),
  ),
  handler: async (ctx, args) => {
    const branches = await Promise.all([
      ctx.db
        .query('loadInformation')
        .withIndex('by_org_tracking_status', (q) =>
          q.eq('workosOrgId', args.workosOrgId).eq('trackingStatus', 'In Transit'),
        )
        .collect(),
      ctx.db
        .query('loadInformation')
        .withIndex('by_org_tracking_status', (q) =>
          q.eq('workosOrgId', args.workosOrgId).eq('trackingStatus', 'Pending'),
        )
        .collect(),
    ]);

    const candidates: Array<{
      loadId: any;
      externalLoadId: string;
      internalId: string;
      orderNumber: string;
      lastPushedRecordedAt?: number;
      pushStateId?: any;
    }> = [];

    for (const load of [...branches[0], ...branches[1]]) {
      if (!isFourKitesSource(load.externalSource)) continue;
      if (!load.externalLoadId) continue;

      const pushState = await ctx.db
        .query('fourKitesPushState')
        .withIndex('by_load', (q) => q.eq('loadId', load._id))
        .first();

      candidates.push({
        loadId: load._id,
        externalLoadId: load.externalLoadId,
        internalId: load.internalId,
        orderNumber: load.orderNumber ?? '',
        lastPushedRecordedAt: pushState?.lastPushedRecordedAt,
        pushStateId: pushState?._id,
      });
    }
    return candidates;
  },
});

// ============================================
// MUTATIONS
// ============================================

/**
 * Record the outcome of a push tick for a batch of loads.
 * One mutation per batch so we don't churn the table with many small writes.
 *
 *   - successes: loads whose latest ping was successfully POSTed. Updates
 *     cursor + clears error trail.
 *   - failures: loads where building/posting failed for a non-retryable
 *     reason (validation, identifier mismatch). Records the error and
 *     bumps consecutiveFailures. Transient errors aren't passed here —
 *     they're left to retry next tick with no state mutation.
 */
export const recordPushResults = internalMutation({
  args: {
    workosOrgId: v.string(),
    successes: v.array(
      v.object({
        loadId: v.id('loadInformation'),
        pushStateId: v.optional(v.id('fourKitesPushState')),
        pushedRecordedAt: v.number(),
        requestId: v.optional(v.string()),
        // AUDIT-ONLY: JSON-stringified single-update body for this load.
        // See schema.ts note on fourKitesPushState.lastRequestBody —
        // safe to drop once customer integration is verified stable.
        requestBody: v.optional(v.string()),
      }),
    ),
    failures: v.array(
      v.object({
        loadId: v.id('loadInformation'),
        pushStateId: v.optional(v.id('fourKitesPushState')),
        error: v.string(),
      }),
    ),
  },
  returns: v.null(),
  handler: async (ctx, args) => {
    const now = Date.now();

    for (const ok of args.successes) {
      if (ok.pushStateId) {
        const existing = await ctx.db.get(ok.pushStateId);
        await ctx.db.patch(ok.pushStateId, {
          lastPushedAt: now,
          lastPushedRecordedAt: ok.pushedRecordedAt,
          lastRequestId: ok.requestId,
          lastRequestBody: ok.requestBody,
          pushCount: (existing?.pushCount ?? 0) + 1,
          // Clear error trail on a clean push.
          lastError: undefined,
          lastErrorAt: undefined,
          consecutiveFailures: 0,
          updatedAt: now,
        });
      } else {
        await ctx.db.insert('fourKitesPushState', {
          loadId: ok.loadId,
          workosOrgId: args.workosOrgId,
          lastPushedAt: now,
          lastPushedRecordedAt: ok.pushedRecordedAt,
          lastRequestId: ok.requestId,
          lastRequestBody: ok.requestBody,
          pushCount: 1,
          consecutiveFailures: 0,
          updatedAt: now,
        });
      }
    }

    for (const failure of args.failures) {
      if (failure.pushStateId) {
        const existing = await ctx.db.get(failure.pushStateId);
        await ctx.db.patch(failure.pushStateId, {
          lastError: failure.error,
          lastErrorAt: now,
          consecutiveFailures:
            (existing?.consecutiveFailures ?? 0) + 1,
          updatedAt: now,
        });
      } else {
        await ctx.db.insert('fourKitesPushState', {
          loadId: failure.loadId,
          workosOrgId: args.workosOrgId,
          lastError: failure.error,
          lastErrorAt: now,
          consecutiveFailures: 1,
          updatedAt: now,
        });
      }
    }
    return null;
  },
});

/**
 * Upsert the per-org tick health row. Called once at the end of every
 * pushOneOrg run, regardless of outcome. Designed so a dashboard can
 * answer "is FK push healthy right now?" with a single by_org read.
 *
 * `consecutiveTransientTicks` resets to 0 whenever any batch ok'd this
 * tick; otherwise increments. Use this to gate alerting — > N transient
 * ticks in a row is the actionable signal.
 */
export const recordTickHealth = internalMutation({
  args: {
    workosOrgId: v.string(),
    tickKind: v.union(
      v.literal('empty'),
      v.literal('ok'),
      v.literal('partial'),
      v.literal('all_failed'),
    ),
    candidateCount: v.number(),
    skippedNoPing: v.number(),
    skippedAlreadyPushed: v.number(),
    plansBuilt: v.number(),
    batchesSent: v.number(),
    batchOk: v.number(),
    batchValidationFail: v.number(),
    batchAuthFail: v.number(),
    batchRateLimit: v.number(),
    batchTransient: v.number(),
    lastErrorKind: v.optional(v.string()),
    lastErrorStatus: v.optional(v.number()),
    lastErrorBody: v.optional(v.string()),
    tickDurationMs: v.number(),
  },
  returns: v.null(),
  handler: async (ctx, args) => {
    const now = Date.now();
    const existing = await ctx.db
      .query('fourKitesPushTickHealth')
      .withIndex('by_org', (q) => q.eq('workosOrgId', args.workosOrgId))
      .first();

    const hadOk = args.batchOk > 0;
    const prevStreak = existing?.consecutiveTransientTicks ?? 0;
    const consecutiveTransientTicks = hadOk
      ? 0
      : args.tickKind === 'empty'
        ? prevStreak // 'empty' doesn't progress or reset the streak — nothing was tried
        : prevStreak + 1;

    const errorAt =
      args.lastErrorKind !== undefined ? now : undefined;

    const row = {
      workosOrgId: args.workosOrgId,
      lastTickAt: now,
      lastTickKind: args.tickKind,
      candidateCount: args.candidateCount,
      skippedNoPing: args.skippedNoPing,
      skippedAlreadyPushed: args.skippedAlreadyPushed,
      plansBuilt: args.plansBuilt,
      batchesSent: args.batchesSent,
      batchOk: args.batchOk,
      batchValidationFail: args.batchValidationFail,
      batchAuthFail: args.batchAuthFail,
      batchRateLimit: args.batchRateLimit,
      batchTransient: args.batchTransient,
      lastErrorKind: args.lastErrorKind,
      lastErrorStatus: args.lastErrorStatus,
      lastErrorBody: args.lastErrorBody,
      lastErrorAt: errorAt,
      consecutiveTransientTicks,
      tickDurationMs: args.tickDurationMs,
    };

    if (existing) {
      await ctx.db.patch(existing._id, row);
    } else {
      await ctx.db.insert('fourKitesPushTickHealth', row);
    }
    return null;
  },
});

// ============================================
// DIAGNOSTIC — push health snapshot
// Internal, dashboard-runnable. Joins active FK loads with their push
// state so you can see in one read whether the cron is landing successful
// posts (lastRequestId present + recent lastPushedAt), missing them
// (no push-state row), or failing (lastError populated).
// ============================================

export const getFourKitesPushHealth = internalQuery({
  args: { workosOrgId: v.string() },
  returns: v.object({
    integrationConnected: v.boolean(),
    integrationEnabled: v.boolean(),
    candidateCount: v.number(),
    pushedCount: v.number(),
    erroringCount: v.number(),
    neverPushedCount: v.number(),
    candidates: v.array(
      v.object({
        loadRef: v.string(),
        externalLoadId: v.string(),
        trackingStatus: v.string(),
        status: v.union(
          v.literal('PUSHED_OK'),
          v.literal('PUSHED_THEN_ERRORED'),
          v.literal('ERRORED'),
          v.literal('NEVER_PUSHED'),
        ),
        lastPushedAt: v.optional(v.number()),
        secondsSinceLastPush: v.optional(v.number()),
        lastPushedRecordedAt: v.optional(v.number()),
        lastRequestId: v.optional(v.string()),
        pushCount: v.optional(v.number()),
        lastError: v.optional(v.string()),
        lastErrorAt: v.optional(v.number()),
        consecutiveFailures: v.optional(v.number()),
      }),
    ),
  }),
  handler: async (ctx, args) => {
    const integration = await ctx.db
      .query('orgIntegrations')
      .withIndex('by_provider', (q) =>
        q.eq('workosOrgId', args.workosOrgId).eq('provider', 'fourkites'),
      )
      .first();

    const integrationConnected = !!integration;
    const integrationEnabled = !!integration?.syncSettings?.isEnabled;

    // Same filter the push cron uses — FK-sourced loads in In Transit
    // or Pending state.
    const branches = await Promise.all([
      ctx.db
        .query('loadInformation')
        .withIndex('by_org_tracking_status', (q) =>
          q.eq('workosOrgId', args.workosOrgId).eq('trackingStatus', 'In Transit'),
        )
        .collect(),
      ctx.db
        .query('loadInformation')
        .withIndex('by_org_tracking_status', (q) =>
          q.eq('workosOrgId', args.workosOrgId).eq('trackingStatus', 'Pending'),
        )
        .collect(),
    ]);

    const now = Date.now();
    const out: Array<{
      loadRef: string;
      externalLoadId: string;
      trackingStatus: string;
      status: 'PUSHED_OK' | 'PUSHED_THEN_ERRORED' | 'ERRORED' | 'NEVER_PUSHED';
      lastPushedAt?: number;
      secondsSinceLastPush?: number;
      lastPushedRecordedAt?: number;
      lastRequestId?: string;
      pushCount?: number;
      lastError?: string;
      lastErrorAt?: number;
      consecutiveFailures?: number;
    }> = [];

    let pushedCount = 0;
    let erroringCount = 0;
    let neverPushedCount = 0;

    for (const load of [...branches[0], ...branches[1]]) {
      if (!isFourKitesSource(load.externalSource)) continue;
      if (!load.externalLoadId) continue;

      const pushState = await ctx.db
        .query('fourKitesPushState')
        .withIndex('by_load', (q) => q.eq('loadId', load._id))
        .first();

      let status: 'PUSHED_OK' | 'PUSHED_THEN_ERRORED' | 'ERRORED' | 'NEVER_PUSHED';
      if (!pushState) {
        status = 'NEVER_PUSHED';
        neverPushedCount++;
      } else if (
        pushState.lastError &&
        (pushState.consecutiveFailures ?? 0) > 0 &&
        !pushState.lastPushedAt
      ) {
        status = 'ERRORED';
        erroringCount++;
      } else if (
        pushState.lastError &&
        pushState.lastErrorAt &&
        pushState.lastPushedAt &&
        pushState.lastErrorAt > pushState.lastPushedAt
      ) {
        status = 'PUSHED_THEN_ERRORED';
        erroringCount++;
      } else if (pushState.lastPushedAt) {
        status = 'PUSHED_OK';
        pushedCount++;
      } else {
        status = 'NEVER_PUSHED';
        neverPushedCount++;
      }

      out.push({
        loadRef: load.internalId,
        externalLoadId: load.externalLoadId,
        trackingStatus: load.trackingStatus,
        status,
        lastPushedAt: pushState?.lastPushedAt,
        secondsSinceLastPush: pushState?.lastPushedAt
          ? Math.floor((now - pushState.lastPushedAt) / 1000)
          : undefined,
        lastPushedRecordedAt: pushState?.lastPushedRecordedAt,
        lastRequestId: pushState?.lastRequestId,
        pushCount: pushState?.pushCount,
        lastError: pushState?.lastError,
        lastErrorAt: pushState?.lastErrorAt,
        consecutiveFailures: pushState?.consecutiveFailures,
      });
    }

    return {
      integrationConnected,
      integrationEnabled,
      candidateCount: out.length,
      pushedCount,
      erroringCount,
      neverPushedCount,
      candidates: out,
    };
  },
});

// ============================================
// PER-LOAD DIAGNOSTIC
// Pass a loadRef (internalId) or externalLoadId. Returns every signal the
// push cron checks so you can pin down which step blocked the push for
// THIS specific load — missing leg, no driver, no session, no pings, or
// pings outside the approach window.
// ============================================

const APPROACH_WINDOW_MS = 30 * 60 * 1000;

export const diagnoseFourKitesPushForLoad = internalQuery({
  args: {
    workosOrgId: v.string(),
    loadRef: v.string(), // internalId, e.g. "FK-109589035"
  },
  returns: v.union(
    v.null(),
    v.object({
      // Load-level
      loadId: v.id('loadInformation'),
      internalId: v.string(),
      externalLoadId: v.optional(v.string()),
      externalSource: v.optional(v.string()),
      trackingStatus: v.string(),
      isFourKitesSourced: v.boolean(),

      // Legs + sessions
      legCount: v.number(),
      legs: v.array(
        v.object({
          legId: v.id('dispatchLegs'),
          legStatus: v.string(),
          driverId: v.optional(v.id('drivers')),
          sessionIdOnLeg: v.optional(v.id('driverSessions')),
          driverOpenSessionId: v.optional(v.id('driverSessions')),
          resolvedSessionId: v.optional(v.id('driverSessions')),
          scheduledStartMs: v.optional(v.number()),
          startStopWindowParsedMs: v.optional(v.number()),
          approachFloorMs: v.optional(v.number()),
          secondsUntilApproachOpens: v.optional(v.number()),
          sessionPingCount: v.number(),
          sessionLatestPingRecordedAtMs: v.optional(v.number()),
          sessionLatestPingPassesApproachFloor: v.boolean(),
          // Source breakdown of ALL pings on this session (not just
          // load-tagged ones). NOTE: mobile callers omit the source field
          // (rows default to MOBILE on read per driverLocations.ts:44).
          // So `unknown` here = mobile in practice; `mobile` = pings that
          // explicitly set source='MOBILE' (none today); `samsara` = pings
          // stamped by the Samsara backup ingest.
          sessionPingSources: v.object({
            mobile: v.number(),
            samsara: v.number(),
            unknown: v.number(),
          }),
          // Per-source min/max recordedAt — tells you whether Samsara polls
          // overlap the leg's ACTIVE window or fall outside it. If Samsara's
          // [earliest, latest] window straddles leg.startedAt and leg.endedAt
          // but no load-tagged Samsara pings exist, the attribution failed
          // even though the timing was right.
          sessionSamsaraEarliestMs: v.optional(v.number()),
          sessionSamsaraLatestMs: v.optional(v.number()),
          sessionMobileEarliestMs: v.optional(v.number()), // includes "unknown" (= mobile per schema comment)
          sessionMobileLatestMs: v.optional(v.number()),
          // Truck context for Samsara debugging.
          truckId: v.optional(v.id('trucks')),
          truckSamsaraVehicleId: v.optional(v.string()),
          // Leg lifecycle timestamps from the dispatchLegs row.
          legStartedAt: v.optional(v.number()),
          legEndedAt: v.optional(v.number()),
          legEndReason: v.optional(v.string()),
          // Session lifecycle for the leg's resolved session.
          sessionStartedAt: v.optional(v.number()),
          sessionEndedAt: v.optional(v.number()),
          sessionStatus: v.optional(v.string()),
          sessionEndReason: v.optional(v.string()),
        }),
      ),

      // Load-tagged (post-check-in) pings — completely independent of legs
      loadTaggedPingCount: v.number(),
      loadTaggedLatestRecordedAtMs: v.optional(v.number()),
      // Source breakdown of load-tagged pings: tells you whether Samsara
      // ever contributed for this load or if it was mobile-only.
      // 'unknown' covers rows written before the source field existed.
      loadTaggedPingSources: v.object({
        mobile: v.number(),
        samsara: v.number(),
        unknown: v.number(),
      }),

      // Duplicate-row detection: other loadInformation rows for the same
      // externalLoadId in this org. If a sibling has legs/pings while the
      // queried row has none, the cron picked a ghost row.
      siblingRows: v.array(
        v.object({
          loadId: v.id('loadInformation'),
          internalId: v.string(),
          externalSource: v.optional(v.string()),
          trackingStatus: v.string(),
          legCount: v.number(),
          loadTaggedPingCount: v.number(),
        }),
      ),

      // Push state for this load
      pushState: v.union(
        v.null(),
        v.object({
          lastPushedAt: v.optional(v.number()),
          lastPushedRecordedAt: v.optional(v.number()),
          lastRequestId: v.optional(v.string()),
          // AUDIT-ONLY (see schema note): JSON body of the most recent
          // successful push. Safe to drop once integration is verified.
          lastRequestBody: v.optional(v.string()),
          pushCount: v.optional(v.number()),
          lastError: v.optional(v.string()),
        }),
      ),

      // Top-level conclusion
      diagnosis: v.string(),
      wouldPushNow: v.boolean(),
    }),
  ),
  handler: async (ctx, args) => {
    // Try multiple lookup strategies — loadRef may be internalId
    // ("FK-109562482") OR externalLoadId ("663929530"). Use .first()
    // instead of .unique() so an unexpected duplicate doesn't throw.
    let load = await ctx.db
      .query('loadInformation')
      .withIndex('by_internal_id', (q) =>
        q.eq('workosOrgId', args.workosOrgId).eq('internalId', args.loadRef),
      )
      .first();
    if (!load) {
      // Fall back to externalLoadId on either FOURKITES or FourKites casings.
      load =
        (await ctx.db
          .query('loadInformation')
          .withIndex('by_external_id', (q: any) =>
            q.eq('externalSource', 'FourKites').eq('externalLoadId', args.loadRef),
          )
          .first()) ||
        (await ctx.db
          .query('loadInformation')
          .withIndex('by_external_id', (q: any) =>
            q.eq('externalSource', 'FOURKITES').eq('externalLoadId', args.loadRef),
          )
          .first());
      // Verify org match on the external-id fallback.
      if (load && load.workosOrgId !== args.workosOrgId) load = null;
    }
    if (!load) return null;

    const isFkSourced = isFourKitesSource(load.externalSource);
    const now = Date.now();

    // ─── Load-tagged pings (post-check-in) ────────────────────────────────
    const loadTaggedPings = await ctx.db
      .query('driverLocations')
      .withIndex('by_load', (q) => q.eq('loadId', load._id))
      .collect();
    const loadTaggedLatestRecordedAtMs = loadTaggedPings.length
      ? Math.max(...loadTaggedPings.map((p) => p.recordedAt))
      : undefined;
    const loadTaggedPingSources = {
      mobile: 0,
      samsara: 0,
      unknown: 0,
    };
    for (const p of loadTaggedPings) {
      if (p.source === 'MOBILE') loadTaggedPingSources.mobile++;
      else if (p.source === 'SAMSARA') loadTaggedPingSources.samsara++;
      else loadTaggedPingSources.unknown++;
    }

    // ─── Legs ─────────────────────────────────────────────────────────────
    const legs = await ctx.db
      .query('dispatchLegs')
      .withIndex('by_load', (q) => q.eq('loadId', load._id))
      .collect();

    const legDiagnostics: Array<{
      legId: any;
      legStatus: string;
      driverId?: any;
      sessionIdOnLeg?: any;
      driverOpenSessionId?: any;
      resolvedSessionId?: any;
      scheduledStartMs?: number;
      startStopWindowParsedMs?: number;
      approachFloorMs?: number;
      secondsUntilApproachOpens?: number;
      sessionPingCount: number;
      sessionLatestPingRecordedAtMs?: number;
      sessionLatestPingPassesApproachFloor: boolean;
      sessionPingSources: { mobile: number; samsara: number; unknown: number };
      sessionSamsaraEarliestMs?: number;
      sessionSamsaraLatestMs?: number;
      sessionMobileEarliestMs?: number;
      sessionMobileLatestMs?: number;
      truckId?: any;
      truckSamsaraVehicleId?: string;
      legStartedAt?: number;
      legEndedAt?: number;
      legEndReason?: string;
      sessionStartedAt?: number;
      sessionEndedAt?: number;
      sessionStatus?: string;
      sessionEndReason?: string;
    }> = [];

    let anyEligiblePing = false;

    for (const leg of legs) {
      // Resolve session for this leg.
      let resolvedSessionId: any = leg.sessionId ?? null;
      let driverOpenSessionId: any = undefined;
      if (!resolvedSessionId && leg.driverId) {
        const openSession = await ctx.db
          .query('driverSessions')
          .withIndex('by_driver_status', (q) =>
            q.eq('driverId', leg.driverId!).eq('status', 'active'),
          )
          .first();
        driverOpenSessionId = openSession?._id;
        resolvedSessionId = openSession?._id ?? null;
      }

      // Pickup anchor.
      let pickupAnchorMs: number | undefined = leg.scheduledStartMs;
      let startStopWindowParsedMs: number | undefined;
      if (pickupAnchorMs === undefined) {
        const startStop = await ctx.db.get(leg.startStopId);
        if (startStop?.windowBeginDate && startStop?.windowBeginTime) {
          const combined = startStop.windowBeginTime.includes('T')
            ? startStop.windowBeginTime
            : `${startStop.windowBeginDate}T${startStop.windowBeginTime}`;
          const parsed = new Date(combined).getTime();
          if (!isNaN(parsed)) {
            startStopWindowParsedMs = parsed;
            pickupAnchorMs = parsed;
          }
        }
      }
      const approachFloorMs =
        pickupAnchorMs !== undefined
          ? pickupAnchorMs - APPROACH_WINDOW_MS
          : undefined;
      const secondsUntilApproachOpens =
        approachFloorMs !== undefined
          ? Math.floor((approachFloorMs - now) / 1000)
          : undefined;

      // Session ping count + latest + source breakdown.
      let sessionPings: any[] = [];
      if (resolvedSessionId) {
        sessionPings = await ctx.db
          .query('driverLocations')
          .withIndex('by_session_time', (q: any) =>
            q.eq('sessionId', resolvedSessionId),
          )
          .collect();
      }
      const sessionPingCount = sessionPings.length;
      const sessionLatestPingRecordedAtMs = sessionPings.length
        ? Math.max(...sessionPings.map((p) => p.recordedAt))
        : undefined;
      const sessionLatestPingPassesApproachFloor =
        sessionLatestPingRecordedAtMs !== undefined &&
        (approachFloorMs === undefined ||
          sessionLatestPingRecordedAtMs >= approachFloorMs);
      const sessionPingSources = { mobile: 0, samsara: 0, unknown: 0 };
      let sessionSamsaraEarliestMs: number | undefined = undefined;
      let sessionSamsaraLatestMs: number | undefined = undefined;
      let sessionMobileEarliestMs: number | undefined = undefined;
      let sessionMobileLatestMs: number | undefined = undefined;
      for (const p of sessionPings) {
        if (p.source === 'SAMSARA') {
          sessionPingSources.samsara++;
          if (sessionSamsaraEarliestMs === undefined || p.recordedAt < sessionSamsaraEarliestMs) {
            sessionSamsaraEarliestMs = p.recordedAt;
          }
          if (sessionSamsaraLatestMs === undefined || p.recordedAt > sessionSamsaraLatestMs) {
            sessionSamsaraLatestMs = p.recordedAt;
          }
        } else if (p.source === 'MOBILE') {
          sessionPingSources.mobile++;
          if (sessionMobileEarliestMs === undefined || p.recordedAt < sessionMobileEarliestMs) {
            sessionMobileEarliestMs = p.recordedAt;
          }
          if (sessionMobileLatestMs === undefined || p.recordedAt > sessionMobileLatestMs) {
            sessionMobileLatestMs = p.recordedAt;
          }
        } else {
          // Untagged = mobile in practice (mobile callers omit source field).
          sessionPingSources.unknown++;
          if (sessionMobileEarliestMs === undefined || p.recordedAt < sessionMobileEarliestMs) {
            sessionMobileEarliestMs = p.recordedAt;
          }
          if (sessionMobileLatestMs === undefined || p.recordedAt > sessionMobileLatestMs) {
            sessionMobileLatestMs = p.recordedAt;
          }
        }
      }

      if (sessionLatestPingPassesApproachFloor) anyEligiblePing = true;

      // Truck + session lifecycle context — pull from the resolved session,
      // then the truck row.
      let truckId: any = undefined;
      let truckSamsaraVehicleId: string | undefined = undefined;
      let sessionStartedAt: number | undefined = undefined;
      let sessionEndedAt: number | undefined = undefined;
      let sessionStatus: string | undefined = undefined;
      let sessionEndReason: string | undefined = undefined;
      if (resolvedSessionId) {
        const sess = await ctx.db.get(
          resolvedSessionId as Id<'driverSessions'>,
        );
        if (sess) {
          truckId = sess.truckId;
          sessionStartedAt = sess.startedAt;
          sessionEndedAt = sess.endedAt;
          sessionStatus = sess.status;
          sessionEndReason = sess.endReason;
          const truck = await ctx.db.get(sess.truckId);
          truckSamsaraVehicleId = truck?.samsaraVehicleId;
        }
      }

      legDiagnostics.push({
        legId: leg._id,
        legStatus: leg.status,
        driverId: leg.driverId,
        sessionIdOnLeg: leg.sessionId,
        driverOpenSessionId,
        resolvedSessionId: resolvedSessionId ?? undefined,
        scheduledStartMs: leg.scheduledStartMs,
        startStopWindowParsedMs,
        approachFloorMs,
        secondsUntilApproachOpens,
        sessionPingCount,
        sessionLatestPingRecordedAtMs,
        sessionLatestPingPassesApproachFloor,
        sessionPingSources,
        sessionSamsaraEarliestMs,
        sessionSamsaraLatestMs,
        sessionMobileEarliestMs,
        sessionMobileLatestMs,
        truckId,
        truckSamsaraVehicleId,
        legStartedAt: leg.startedAt,
        legEndedAt: leg.endedAt,
        legEndReason: leg.endReason,
        sessionStartedAt,
        sessionEndedAt,
        sessionStatus,
        sessionEndReason,
      });
    }

    // ─── Sibling rows with the same externalLoadId (duplicate detection) ──
    // The FourKites pull can create multiple loadInformation rows for the
    // same shipment over time. If the cron picked a ghost row but the web
    // UI is showing pings from a sibling, we surface it here.
    const siblingRows: Array<{
      loadId: any;
      internalId: string;
      externalSource?: string;
      trackingStatus: string;
      legCount: number;
      loadTaggedPingCount: number;
    }> = [];
    if (load.externalLoadId) {
      const siblings = (
        await Promise.all([
          ctx.db
            .query('loadInformation')
            .withIndex('by_external_id', (q: any) =>
              q.eq('externalSource', 'FourKites').eq('externalLoadId', load.externalLoadId),
            )
            .collect(),
          ctx.db
            .query('loadInformation')
            .withIndex('by_external_id', (q: any) =>
              q.eq('externalSource', 'FOURKITES').eq('externalLoadId', load.externalLoadId),
            )
            .collect(),
        ])
      ).flat();

      for (const s of siblings) {
        if (s._id === load._id) continue; // we already counted the queried row
        if (s.workosOrgId !== args.workosOrgId) continue;
        const sLegs = await ctx.db
          .query('dispatchLegs')
          .withIndex('by_load', (q) => q.eq('loadId', s._id))
          .collect();
        const sPings = await ctx.db
          .query('driverLocations')
          .withIndex('by_load', (q) => q.eq('loadId', s._id))
          .collect();
        siblingRows.push({
          loadId: s._id,
          internalId: s.internalId,
          externalSource: s.externalSource,
          trackingStatus: s.trackingStatus,
          legCount: sLegs.length,
          loadTaggedPingCount: sPings.length,
        });
      }
    }

    // ─── Push state ───────────────────────────────────────────────────────
    const pushStateRow = await ctx.db
      .query('fourKitesPushState')
      .withIndex('by_load', (q) => q.eq('loadId', load._id))
      .first();
    const pushState = pushStateRow
      ? {
          lastPushedAt: pushStateRow.lastPushedAt,
          lastPushedRecordedAt: pushStateRow.lastPushedRecordedAt,
          lastRequestId: pushStateRow.lastRequestId,
          lastRequestBody: pushStateRow.lastRequestBody,
          pushCount: pushStateRow.pushCount,
          lastError: pushStateRow.lastError,
        }
      : null;

    // ─── Conclusion ───────────────────────────────────────────────────────
    const hasLoadTaggedPing = loadTaggedLatestRecordedAtMs !== undefined;
    const ELIGIBLE_TRACKING_STATUSES = new Set(['In Transit', 'Pending']);
    const statusIsEligible = ELIGIBLE_TRACKING_STATUSES.has(load.trackingStatus);
    const wouldPushNow =
      statusIsEligible && (hasLoadTaggedPing || anyEligiblePing);

    let diagnosis: string;
    if (!isFkSourced) {
      diagnosis = `Load is not FourKites-sourced (externalSource="${load.externalSource ?? 'undefined'}"). Push cron filter excludes it.`;
    } else if (!load.externalLoadId) {
      diagnosis = 'Load has no externalLoadId — push cron has no FourKites identifier to send.';
    } else if (!statusIsEligible) {
      // The cron's candidate query filters to trackingStatus IN ('In Transit', 'Pending').
      // Any other status (Completed, Cancelled, Expired, etc.) is permanently
      // excluded. If pushState is null on a Completed load, it means no tick
      // ever caught it during its active phase — usually because the load
      // transitioned past 'In Transit' before the cron started running, or
      // before the load was first synced from FourKites.
      diagnosis =
        `Load trackingStatus="${load.trackingStatus}" is not in {'In Transit', 'Pending'} — ` +
        `the push cron filter excludes it. No further pushes will happen.`;
    } else if (legs.length === 0) {
      const richSibling = siblingRows.find(
        (s) => s.legCount > 0 || s.loadTaggedPingCount > 0,
      );
      if (richSibling) {
        diagnosis =
          `Load has no dispatchLegs, but a DUPLICATE row for the same externalLoadId ` +
          `does (internalId=${richSibling.internalId}, ${richSibling.legCount} legs, ` +
          `${richSibling.loadTaggedPingCount} pings). The cron is pointed at a ghost ` +
          `row; the live row has the data. De-dup loadInformation by externalLoadId.`;
      } else {
        diagnosis = 'Load has no dispatchLegs — no driver assigned, no GPS to push.';
      }
    } else {
      const anyLegHasDriver = legs.some((l) => l.driverId);
      const anyLegHasSession = legDiagnostics.some((l) => l.resolvedSessionId);
      const anyLegHasPings = legDiagnostics.some((l) => l.sessionPingCount > 0);

      if (!anyLegHasDriver) {
        diagnosis = 'Load has dispatchLegs but no driverId on any leg — load is dispatched but unstaffed.';
      } else if (!anyLegHasSession) {
        diagnosis = 'Driver(s) assigned but no active driverSession — driver(s) have not started a shift.';
      } else if (!anyLegHasPings && !hasLoadTaggedPing) {
        diagnosis = 'Session(s) open but no driverLocations rows exist yet.';
      } else if (!hasLoadTaggedPing && !anyEligiblePing) {
        const earliest = legDiagnostics
          .filter((l) => l.secondsUntilApproachOpens !== undefined)
          .map((l) => l.secondsUntilApproachOpens!)
          .sort((a, b) => a - b)[0];
        if (earliest !== undefined && earliest > 0) {
          const mins = Math.floor(earliest / 60);
          const hours = Math.floor(mins / 60);
          diagnosis = `Pings exist but all are before the 30-min approach window. Approach opens in ~${hours}h ${mins % 60}m.`;
        } else {
          diagnosis = 'Pings exist but none pass the approach-window filter for this load.';
        }
      } else if (
        pushState?.lastPushedRecordedAt !== undefined &&
        loadTaggedLatestRecordedAtMs !== undefined &&
        loadTaggedLatestRecordedAtMs <= pushState.lastPushedRecordedAt
      ) {
        diagnosis = 'Already pushed the latest available ping (cursor caught up). Will push again when a newer ping arrives.';
      } else {
        diagnosis = 'Should push on the next 60s cron tick.';
      }
    }

    return {
      loadId: load._id,
      internalId: load.internalId,
      externalLoadId: load.externalLoadId,
      externalSource: load.externalSource,
      trackingStatus: load.trackingStatus,
      isFourKitesSourced: isFkSourced,
      legCount: legs.length,
      legs: legDiagnostics,
      loadTaggedPingCount: loadTaggedPings.length,
      loadTaggedLatestRecordedAtMs,
      loadTaggedPingSources,
      siblingRows,
      pushState,
      diagnosis,
      wouldPushNow,
    };
  },
});

// ============================================
// HELPERS
// ============================================

/**
 * Pull an apiKey out of a credentials field. Mirrors the resolution rules
 * the existing FourKites pull uses (convex/fourKitesPullSyncAction.ts):
 *
 *   - Credentials may be a JSON object with `apiKey`, or a raw string.
 *   - We only need apiKey for the Dispatcher endpoint; other auth fields
 *     (username/password/OAuth) are ignored here even if present.
 */
function extractApiKey(credentials: unknown): string | null {
  if (!credentials) return null;

  let parsed: unknown = credentials;
  if (typeof credentials === 'string') {
    const trimmed = credentials.trim();
    if (!trimmed) return null;
    try {
      parsed = JSON.parse(trimmed);
    } catch {
      // Raw string — treat the whole value as the apiKey.
      return trimmed;
    }
  }

  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null;
  const apiKey = (parsed as Record<string, unknown>).apiKey;
  if (typeof apiKey !== 'string') return null;
  const trimmed = apiKey.trim();
  return trimmed || null;
}

// ============================================
// APPROACH-WINDOW VERIFIER
//
// Returns every Pending FK-sourced load whose pickup time falls within
// ±30 minutes of "now" — i.e. the loads the approach window is supposed
// to be pushing for right now. For each, surfaces:
//   - whether a driver is assigned + has an active session
//   - whether there's an eligible ping (recorded >= pickup - 30min)
//   - the load's current push status
//
// Comparing "should push" (driver+session+eligible ping) vs "is pushing"
// (PUSHED_OK with recent lastPushedAt) tells you whether the 30-min
// approach window is actually firing in production.
// ============================================

export const listLoadsInApproachWindow = internalQuery({
  args: { workosOrgId: v.string() },
  returns: v.array(
    v.object({
      loadRef: v.string(),
      externalLoadId: v.string(),
      trackingStatus: v.string(),
      pickupAtMs: v.number(),
      minutesUntilPickup: v.number(),
      approachFloorMs: v.number(),
      driverId: v.optional(v.id('drivers')),
      hasActiveSession: v.boolean(),
      resolvedSessionId: v.optional(v.id('driverSessions')),
      latestEligiblePingMs: v.optional(v.number()),
      pushStatus: v.union(
        v.literal('PUSHED_OK'),
        v.literal('NEVER_PUSHED'),
        v.literal('ERRORED'),
      ),
      lastPushedAt: v.optional(v.number()),
      lastPushedRecordedAt: v.optional(v.number()),
      // Verdict: what the cron should do on its next tick.
      verdict: v.string(),
    }),
  ),
  handler: async (ctx, args) => {
    const APPROACH_WINDOW_MS = 30 * 60 * 1000;
    const now = Date.now();

    const loads = await ctx.db
      .query('loadInformation')
      .withIndex('by_org_tracking_status', (q) =>
        q.eq('workosOrgId', args.workosOrgId).eq('trackingStatus', 'Pending'),
      )
      .collect();

    const results: Array<{
      loadRef: string;
      externalLoadId: string;
      trackingStatus: string;
      pickupAtMs: number;
      minutesUntilPickup: number;
      approachFloorMs: number;
      driverId?: any;
      hasActiveSession: boolean;
      resolvedSessionId?: any;
      latestEligiblePingMs?: number;
      pushStatus: 'PUSHED_OK' | 'NEVER_PUSHED' | 'ERRORED';
      lastPushedAt?: number;
      lastPushedRecordedAt?: number;
      verdict: string;
    }> = [];

    for (const load of loads) {
      if (!isFourKitesSource(load.externalSource)) continue;
      if (!load.externalLoadId) continue;

      // Find legs — for relay loads, the FIRST leg's pickup defines the
      // approach window. Single-leg loads are the common case.
      const legs = await ctx.db
        .query('dispatchLegs')
        .withIndex('by_load', (q) => q.eq('loadId', load._id))
        .collect();
      if (legs.length === 0) continue;
      legs.sort((a, b) => (a.sequence ?? 0) - (b.sequence ?? 0));
      const firstLeg = legs[0];

      // Pickup anchor (denormalized scheduledStartMs, fall back to stop).
      let pickupAnchorMs: number | undefined = firstLeg.scheduledStartMs;
      if (pickupAnchorMs === undefined) {
        const startStop = await ctx.db.get(firstLeg.startStopId);
        if (startStop?.windowBeginDate && startStop?.windowBeginTime) {
          const parsed = parseStopDateTime(
            startStop.windowBeginDate,
            startStop.windowBeginTime,
          );
          if (parsed !== null) pickupAnchorMs = parsed;
        }
      }
      if (pickupAnchorMs === undefined) continue;

      const minutesUntilPickup = (pickupAnchorMs - now) / 60000;
      // In or near the approach window: pickup is within the next 30 min,
      // or up to 30 min in the past (still "approaching" from a tooling
      // perspective — drivers running late are common).
      if (minutesUntilPickup < -30 || minutesUntilPickup > 30) continue;

      const approachFloorMs = pickupAnchorMs - APPROACH_WINDOW_MS;

      // Resolve session: leg.sessionId if set, else driver's open session.
      let resolvedSessionId: Id<'driverSessions'> | undefined =
        firstLeg.sessionId ?? undefined;
      let hasActiveSession = !!resolvedSessionId;
      if (!resolvedSessionId && firstLeg.driverId) {
        const openSession = await ctx.db
          .query('driverSessions')
          .withIndex('by_driver_status', (q) =>
            q.eq('driverId', firstLeg.driverId!).eq('status', 'active'),
          )
          .first();
        if (openSession) {
          resolvedSessionId = openSession._id;
          hasActiveSession = true;
        }
      }

      // Latest eligible ping on that session (recorded >= approachFloor).
      let latestEligiblePingMs: number | undefined = undefined;
      if (resolvedSessionId) {
        const latest = await ctx.db
          .query('driverLocations')
          .withIndex('by_session_time', (q: any) =>
            q.eq('sessionId', resolvedSessionId).gte('recordedAt', approachFloorMs),
          )
          .order('desc')
          .first();
        if (latest) latestEligiblePingMs = latest.recordedAt;
      }

      // Push state.
      const pushState = await ctx.db
        .query('fourKitesPushState')
        .withIndex('by_load', (q) => q.eq('loadId', load._id))
        .first();

      let pushStatus: 'PUSHED_OK' | 'NEVER_PUSHED' | 'ERRORED' = 'NEVER_PUSHED';
      if (pushState?.lastError && (pushState.consecutiveFailures ?? 0) > 0 && !pushState.lastPushedAt) {
        pushStatus = 'ERRORED';
      } else if (pushState?.lastPushedAt) {
        pushStatus = 'PUSHED_OK';
      }

      // Verdict — plain-English summary of what the cron should be doing.
      let verdict: string;
      if (!firstLeg.driverId) {
        verdict = 'No driver assigned — cannot push.';
      } else if (!hasActiveSession) {
        verdict = 'Driver assigned but no active session — driver has not started shift.';
      } else if (latestEligiblePingMs === undefined) {
        verdict =
          'Session active but no pings recorded since approach floor — ' +
          'mobile silent + Samsara not contributing (or truck not mapped).';
      } else if (pushStatus === 'PUSHED_OK' && pushState?.lastPushedRecordedAt !== undefined && latestEligiblePingMs <= pushState.lastPushedRecordedAt) {
        verdict = 'Already pushed the latest available ping. Will push again on next newer ping.';
      } else {
        verdict = 'Should push on the next 60s cron tick — eligible ping exists, not yet pushed.';
      }

      results.push({
        loadRef: load.internalId,
        externalLoadId: load.externalLoadId,
        trackingStatus: load.trackingStatus,
        pickupAtMs: pickupAnchorMs,
        minutesUntilPickup,
        approachFloorMs,
        driverId: firstLeg.driverId,
        hasActiveSession,
        resolvedSessionId,
        latestEligiblePingMs,
        pushStatus,
        lastPushedAt: pushState?.lastPushedAt,
        lastPushedRecordedAt: pushState?.lastPushedRecordedAt,
        verdict,
      });
    }

    // Sort by minutesUntilPickup ascending — soonest first.
    results.sort((a, b) => a.minutesUntilPickup - b.minutesUntilPickup);
    return results;
  },
});

// ============================================
// ORDERNUMBER-FALLBACK DETECTOR
//
// During inbound FK sync (fourKitesSyncHelpers.ts:321 and similar) we
// store orderNumber as `shipment.loadNumber || shipment.id`. When the
// inbound shipment is missing loadNumber, orderNumber silently falls
// back to the shipment ID (which is what we also store in
// externalLoadId).
//
// The Dispatcher push uses orderNumber as the FK `identifier` with
// `identifierType: 'loadNumber'`. For fallback loads, that means we're
// sending FK's internal shipment ID under a 'loadNumber' type — which
// FK won't match against their loadNumber lookup. Push silently returns
// 202 but no location lands.
//
// This query surfaces those loads so they can be patched manually
// (set orderNumber to the right value) or excluded from the push.
// ============================================

export const findFourKitesLoadsWithFallbackOrderNumber = internalQuery({
  args: {
    workosOrgId: v.string(),
    limit: v.optional(v.number()),
  },
  returns: v.object({
    totalFallbackLoads: v.number(),
    breakdownByTrackingStatus: v.object({
      pending: v.number(),
      inTransit: v.number(),
      completed: v.number(),
      delayed: v.number(),
      canceled: v.number(),
      other: v.number(),
    }),
    samples: v.array(
      v.object({
        loadRef: v.string(),
        externalLoadId: v.string(),
        orderNumber: v.string(),
        trackingStatus: v.string(),
        hasPushState: v.boolean(),
        lastError: v.optional(v.string()),
      }),
    ),
  }),
  handler: async (ctx, args) => {
    const limit = args.limit ?? 100;

    // Walk loads across every tracking-status branch. The by_org_tracking_status
    // index narrows by one status at a time, so we collect from each.
    const statuses = [
      'In Transit',
      'Pending',
      'Completed',
      'Delayed',
      'Canceled',
    ] as const;
    const allLoads: Array<any> = [];
    for (const status of statuses) {
      const branch = await ctx.db
        .query('loadInformation')
        .withIndex('by_org_tracking_status', (q) =>
          q.eq('workosOrgId', args.workosOrgId).eq('trackingStatus', status),
        )
        .collect();
      allLoads.push(...branch);
    }

    const breakdown = {
      pending: 0,
      inTransit: 0,
      completed: 0,
      delayed: 0,
      canceled: 0,
      other: 0,
    };
    const samples: Array<{
      loadRef: string;
      externalLoadId: string;
      orderNumber: string;
      trackingStatus: string;
      hasPushState: boolean;
      lastError?: string;
    }> = [];
    let total = 0;

    for (const load of allLoads) {
      if (!isFourKitesSource(load.externalSource)) continue;
      if (!load.externalLoadId) continue;
      if (!load.orderNumber) continue;
      // The signature of the fallback case: orderNumber === externalLoadId.
      // This is what fourKitesSyncHelpers does when shipment.loadNumber
      // is missing — both fields get the same value (shipment.id).
      if (load.orderNumber !== load.externalLoadId) continue;

      total++;
      const ts = load.trackingStatus;
      if (ts === 'Pending') breakdown.pending++;
      else if (ts === 'In Transit') breakdown.inTransit++;
      else if (ts === 'Completed') breakdown.completed++;
      else if (ts === 'Delayed') breakdown.delayed++;
      else if (ts === 'Canceled') breakdown.canceled++;
      else breakdown.other++;

      if (samples.length < limit) {
        const pushState = await ctx.db
          .query('fourKitesPushState')
          .withIndex('by_load', (q) => q.eq('loadId', load._id))
          .first();
        samples.push({
          loadRef: load.internalId,
          externalLoadId: load.externalLoadId,
          orderNumber: load.orderNumber,
          trackingStatus: load.trackingStatus,
          hasPushState: !!pushState,
          lastError: pushState?.lastError,
        });
      }
    }

    return {
      totalFallbackLoads: total,
      breakdownByTrackingStatus: breakdown,
      samples,
    };
  },
});
