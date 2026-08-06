import { v } from 'convex/values';
import { query, mutation, internalMutation } from './_generated/server';
import {
  requireCallerOrgId,
  assertOrgPermission,
  resolveClerkCarrierMembership,
} from './lib/auth';
import { resolveAuthenticatedDriver } from './driverMobile';

// ============================================================================
// FEATURE FLAGS — per-org runtime toggles
// ============================================================================
//
// Values are always serialized as v.string(); the mobile client parses them
// to the right shape via typed accessors in mobile/lib/feature-flags.ts.
//
// Keys currently in use:
//   gps_queue_backend           → 'mmkv' | 'sqlite'  (default: 'sqlite')
//   queue_encryption_enabled    → 'true' | 'false'   (default: 'false')
//   ping_ingested_sample_rate   → '0.01'             (default: 0.01)
//   ar_wake_enabled             → 'true' | 'false'   (default: 'false')
//   ar_shadow_mode              → 'true' | 'false'   (default: 'false')
//   fcm_wake_enabled            → 'true' | 'false'   (default: 'false')
//   owner_mode_in_driver_app    → 'true' | 'false'   (default: 'true')
//     Split-plan §6 driver-cleanup migration window: 'false' replaces the
//     driver app's owner mode with the "get Otoqa Dispatch" interstitial.
//     Supports the global '*' scope for the flip-for-all step.
//
// Admins flip flags via the setFlag mutation from the Convex dashboard, or
// via setFlagInternal from the terminal during canary rollouts.
// ============================================================================

/**
 * Rows stored under this sentinel org id apply to EVERY org (org-specific
 * rows override key-by-key). Written only via setFlagInternal / dashboard:
 *   npx convex run featureFlags:setFlagInternal \
 *     '{"workosOrgId":"*","key":"owner_mode_in_driver_app","value":"false"}'
 */
export const GLOBAL_FLAG_SCOPE = '*';

/**
 * Returns every flag set for the caller's org as a flat map.
 *
 * Auth resolution: Mobile (Clerk) drivers authenticate with a PHONE claim,
 * not an org claim, so we can't use requireCallerOrgId here. Instead we
 * resolve the driver via phone and read driver.organizationId. Web (WorkOS)
 * callers are served by checking the org_id claim directly. Falling through
 * both paths returns {} so callers gracefully default to in-code values.
 *
 * Callers cache the result in AsyncStorage for offline boot — a device
 * with no cached value and no network at launch falls back to the in-code
 * default (sqlite for gps_queue_backend). That's the right behavior:
 * first-launch offline on a canary org stays on the legacy backend until
 * the device gets a chance to read the flag.
 */
export const getForOrg = query({
  args: {},
  returns: v.record(v.string(), v.string()),
  handler: async (ctx) => {
    let orgIds: string[] = [];

    // Web / WorkOS path: identity carries org_id directly.
    try {
      orgIds = [await requireCallerOrgId(ctx)];
    } catch {
      // Fall through to mobile resolution below.
    }

    // Mobile / Clerk path: resolve driver via phone claim → driver.organizationId.
    if (orgIds.length === 0) {
      try {
        const driver = await resolveAuthenticatedDriver(ctx);
        orgIds = [driver.organizationId];
      } catch {
        // Not a driver — fall through to owner resolution below.
      }
    }

    // Owner-only Clerk callers (no driver record) resolve via their
    // OWNER/ADMIN identity link. Split-plan §6 release N depends on this:
    // `owner_mode_in_driver_app` must reach exactly this population, and
    // the driver-first order above keeps every previously-served caller
    // on the org they already resolved to. Flag rows may be keyed by any
    // spelling of the org id, so all candidates are queried.
    if (orgIds.length === 0) {
      const membership = await resolveClerkCarrierMembership(ctx);
      if (membership) {
        orgIds = [
          membership.org.workosOrgId,
          membership.org.clerkOrgId,
          membership.org._id,
        ].filter((x): x is string => typeof x === 'string' && x.length > 0);
      }
    }

    // Unauthenticated or unrecognized caller — empty flags so the client
    // defaults to in-code fallback.
    if (orgIds.length === 0) return {};

    // Global rows (workosOrgId '*') apply to every org and are overlaid by
    // org-specific rows. This is what makes the §6 N+1 step — "flag off
    // for ALL orgs" — a single-row flip instead of a per-org sweep.
    const flags: Record<string, string> = {};
    for (const scope of [GLOBAL_FLAG_SCOPE, ...orgIds]) {
      const rows = await ctx.db
        .query('featureFlags')
        .withIndex('by_org', (q) => q.eq('workosOrgId', scope))
        .collect();
      for (const row of rows) {
        flags[row.key] = row.value;
      }
    }
    return flags;
  },
});

/**
 * Set a flag value for the caller's org. Upsert semantics.
 *
 * Requires the `settings:edit` RBAC permission: flags are operational
 * levers (GPS queue backend, wake mechanisms, rollout gates), so flipping
 * them is a settings-grade action, not something any org member should be
 * able to do. No client UI calls this today (verified — only the CLI
 * `setFlagInternal` path is used in runbooks), so tightening it breaks
 * nothing. Global-scope ('*') flags are NOT writable here at all — that
 * lever belongs to the platform console (convex/platform/) or the CLI.
 */
export const setFlag = mutation({
  args: {
    key: v.string(),
    value: v.string(),
  },
  returns: v.null(),
  handler: async (ctx, { key, value }) => {
    const orgId = await requireCallerOrgId(ctx);
    await assertOrgPermission(ctx, orgId, 'settings:edit');
    const identity = await ctx.auth.getUserIdentity();
    const updatedBy = identity?.subject;

    const existing = await ctx.db
      .query('featureFlags')
      .withIndex('by_org_key', (q) =>
        q.eq('workosOrgId', orgId).eq('key', key),
      )
      .first();

    const now = Date.now();
    if (existing) {
      await ctx.db.patch(existing._id, { value, updatedAt: now, updatedBy });
    } else {
      await ctx.db.insert('featureFlags', {
        workosOrgId: orgId,
        key,
        value,
        updatedAt: now,
        updatedBy,
      });
    }
    return null;
  },
});

/**
 * Set a flag for an explicit org, bypassing auth. `internalMutation` means
 * this is only reachable from other Convex functions, schedulers, or the
 * `npx convex run` CLI — never from an authenticated client. Used during
 * the MMKV rollout for flipping flags from the terminal without going
 * through the dashboard.
 *
 * Example:
 *   npx convex run featureFlags:setFlagInternal \
 *     '{"workosOrgId":"org_01KA…","key":"gps_queue_backend","value":"mmkv"}'
 *
 * Deleted in Phase 5 along with the rest of the featureFlags scaffolding.
 */
export const setFlagInternal = internalMutation({
  args: {
    workosOrgId: v.string(),
    key: v.string(),
    value: v.string(),
  },
  returns: v.null(),
  handler: async (ctx, { workosOrgId, key, value }) => {
    const existing = await ctx.db
      .query('featureFlags')
      .withIndex('by_org_key', (q) =>
        q.eq('workosOrgId', workosOrgId).eq('key', key),
      )
      .first();

    const now = Date.now();
    if (existing) {
      await ctx.db.patch(existing._id, {
        value,
        updatedAt: now,
        updatedBy: 'cli',
      });
    } else {
      await ctx.db.insert('featureFlags', {
        workosOrgId,
        key,
        value,
        updatedAt: now,
        updatedBy: 'cli',
      });
    }
    return null;
  },
});
