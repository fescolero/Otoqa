import { v } from 'convex/values';
import { internalMutation, internalQuery } from './_generated/server';

// ============================================
// FOURKITES DISPATCHER PUSH — V8-runtime queries and mutations
// Counterpart to fourKitesDispatcherPush.ts ('use node' action). Split so
// each runtime file stays single-purpose.
// ============================================

// ============================================
// QUERIES
// ============================================

/**
 * Cross-org sweep: list every workosOrgId that has an active FourKites
 * integration. The push cron uses this to find which orgs to process each
 * tick. Acceptable at expected fleet size (tens to low hundreds of orgs);
 * add a by_provider_only index on orgIntegrations if this ever grows.
 */
export const listFourKitesOrgsWithIntegration = internalQuery({
  args: {},
  returns: v.array(v.string()),
  handler: async (ctx) => {
    const all = await ctx.db.query('orgIntegrations').collect();
    const seen = new Set<string>();
    for (const i of all) {
      if (i.provider !== 'fourkites') continue;
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
      lastPushedRecordedAt?: number;
      pushStateId?: any;
    }> = [];

    for (const load of [...branches[0], ...branches[1]]) {
      if (load.externalSource !== 'FOURKITES') continue;
      if (!load.externalLoadId) continue;

      const pushState = await ctx.db
        .query('fourKitesPushState')
        .withIndex('by_load', (q) => q.eq('loadId', load._id))
        .first();

      candidates.push({
        loadId: load._id,
        externalLoadId: load.externalLoadId,
        internalId: load.internalId,
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
        await ctx.db.patch(ok.pushStateId, {
          lastPushedAt: now,
          lastPushedRecordedAt: ok.pushedRecordedAt,
          lastRequestId: ok.requestId,
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
