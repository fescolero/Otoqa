import { v } from 'convex/values';
import { query, mutation, internalMutation } from './_generated/server';
import { requireCallerOrgId } from './lib/auth';

// ============================================================================
// FEATURE FLAGS — per-org runtime toggles
// ============================================================================
//
// Scaffolding for the MMKV GPS-queue rollout (see
// mobile/docs/location-queue-mmkv.md). Deleted in Phase 5 cleanup after
// the global flip to MMKV lands and `expo-sqlite` is removed.
//
// Keys currently in use:
//   gps_queue_backend → 'mmkv' | 'sqlite'  (default: 'sqlite')
//
// Admins flip flags via the setFlag mutation from the Convex dashboard.
// ============================================================================

/**
 * Returns every flag set for the caller's org as a flat map.
 *
 * Callers cache this in AsyncStorage for offline boot — a device with no
 * cached value and no network at launch falls back to the in-code default
 * (sqlite for gps_queue_backend). That's the right behavior: first-launch
 * offline on a canary org stays on the legacy backend until the device
 * gets a chance to read the flag.
 */
export const getForOrg = query({
  args: {},
  returns: v.record(v.string(), v.string()),
  handler: async (ctx) => {
    const orgId = await requireCallerOrgId(ctx);
    const rows = await ctx.db
      .query('featureFlags')
      .withIndex('by_org', (q) => q.eq('workosOrgId', orgId))
      .collect();
    const flags: Record<string, string> = {};
    for (const row of rows) {
      flags[row.key] = row.value;
    }
    return flags;
  },
});

/**
 * Set a flag value for the caller's org. Upsert semantics. Callable from
 * the Convex dashboard or any authenticated admin context. Deliberately
 * does NOT require a role check beyond "has org claim" — the surface is
 * dashboard-only until we wire a proper admin UI, and the flags here are
 * operational (no PII exposure).
 */
export const setFlag = mutation({
  args: {
    key: v.string(),
    value: v.string(),
  },
  returns: v.null(),
  handler: async (ctx, { key, value }) => {
    const orgId = await requireCallerOrgId(ctx);
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
