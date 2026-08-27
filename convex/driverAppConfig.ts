import { ConvexError, v } from 'convex/values';
import { internalMutation, query } from './_generated/server';

/**
 * Driver-app release channel — which native build is current per platform,
 * and the oldest build still allowed to run.
 *
 * `get` is deliberately unauthenticated: the update gate must be able to
 * render on the sign-in screen (a driver stuck on a dead build may not be
 * able to sign in at all), and the payload is a build number plus an
 * install link — nothing org- or driver-scoped.
 *
 * Written from the CLI after each `eas build`:
 *
 *   npx convex run driverAppConfig:setConfig \
 *     '{"platform":"android","latestBuild":18,"minSupportedBuild":18,
 *       "installUrl":"https://expo.dev/accounts/otoqa/...","message":"..."}'
 */

const platformValidator = v.union(v.literal('android'), v.literal('ios'));

export const get = query({
  args: { platform: platformValidator },
  returns: v.union(
    v.null(),
    v.object({
      latestBuild: v.number(),
      minSupportedBuild: v.number(),
      installUrl: v.string(),
      latestVersion: v.union(v.string(), v.null()),
      dispatchPhone: v.union(v.string(), v.null()),
      message: v.union(v.string(), v.null()),
    })
  ),
  handler: async (ctx, args) => {
    const row = await ctx.db
      .query('driverAppConfig')
      .withIndex('by_platform', (q) => q.eq('platform', args.platform))
      .unique();
    if (!row) return null;
    return {
      latestBuild: row.latestBuild,
      minSupportedBuild: row.minSupportedBuild,
      installUrl: row.installUrl,
      latestVersion: row.latestVersion ?? null,
      dispatchPhone: row.dispatchPhone ?? null,
      message: row.message ?? null,
    };
  },
});

/**
 * Webhook-driven half of the release channel: EAS calls
 * /eas/build-webhook (convex/http.ts) when a build finishes, and that
 * route records it here. Merge semantics, not replace: the fields a
 * human owns — minSupportedBuild (the mandatory-update floor),
 * dispatchPhone, message — survive untouched; only what the build
 * pipeline knows (latestBuild, its display label, the install link)
 * moves. A stale or re-delivered webhook can never roll the channel
 * back: builds below the current latestBuild are dropped.
 */
export const recordBuild = internalMutation({
  args: {
    platform: platformValidator,
    latestBuild: v.number(),
    installUrl: v.string(),
    latestVersion: v.optional(v.string()),
  },
  returns: v.union(v.literal('recorded'), v.literal('ignored_stale')),
  handler: async (ctx, args) => {
    if (!Number.isInteger(args.latestBuild) || args.latestBuild <= 0) {
      throw new ConvexError('latestBuild must be a positive integer');
    }
    if (!/^https:\/\//.test(args.installUrl)) {
      throw new ConvexError('installUrl must be an https URL');
    }

    const existing = await ctx.db
      .query('driverAppConfig')
      .withIndex('by_platform', (q) => q.eq('platform', args.platform))
      .unique();

    if (existing && args.latestBuild < existing.latestBuild) return 'ignored_stale';

    if (existing) {
      await ctx.db.patch(existing._id, {
        latestBuild: args.latestBuild,
        installUrl: args.installUrl,
        latestVersion: args.latestVersion,
        updatedAt: Date.now(),
      });
    } else {
      await ctx.db.insert('driverAppConfig', {
        platform: args.platform,
        latestBuild: args.latestBuild,
        // Permissive floor until a human raises it — a webhook must never
        // lock drivers out on its own.
        minSupportedBuild: 1,
        installUrl: args.installUrl,
        latestVersion: args.latestVersion,
        updatedAt: Date.now(),
      });
    }
    return 'recorded';
  },
});

export const setConfig = internalMutation({
  args: {
    platform: platformValidator,
    latestBuild: v.number(),
    minSupportedBuild: v.number(),
    installUrl: v.string(),
    latestVersion: v.optional(v.string()),
    dispatchPhone: v.optional(v.string()),
    message: v.optional(v.string()),
  },
  returns: v.null(),
  handler: async (ctx, args) => {
    if (!Number.isInteger(args.latestBuild) || args.latestBuild <= 0) {
      throw new ConvexError('latestBuild must be a positive integer');
    }
    if (!Number.isInteger(args.minSupportedBuild) || args.minSupportedBuild <= 0) {
      throw new ConvexError('minSupportedBuild must be a positive integer');
    }
    if (args.minSupportedBuild > args.latestBuild) {
      throw new ConvexError('minSupportedBuild cannot exceed latestBuild');
    }
    if (!/^https:\/\//.test(args.installUrl)) {
      throw new ConvexError('installUrl must be an https URL');
    }

    const existing = await ctx.db
      .query('driverAppConfig')
      .withIndex('by_platform', (q) => q.eq('platform', args.platform))
      .unique();

    const doc = {
      platform: args.platform,
      latestBuild: args.latestBuild,
      minSupportedBuild: args.minSupportedBuild,
      installUrl: args.installUrl,
      latestVersion: args.latestVersion,
      dispatchPhone: args.dispatchPhone,
      message: args.message,
      updatedAt: Date.now(),
    };
    if (existing) {
      await ctx.db.replace(existing._id, doc);
    } else {
      await ctx.db.insert('driverAppConfig', doc);
    }
    return null;
  },
});
