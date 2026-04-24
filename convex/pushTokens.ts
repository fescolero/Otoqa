import { v } from 'convex/values';
import { mutation, internalMutation } from './_generated/server';
import { resolveAuthenticatedDriver } from './driverMobile';

// ============================================================================
// PUSH TOKENS — Phase 1 wake-push path (distinct from driverPushTokens)
// ============================================================================
//
// Stores raw FCM (Android) / APNs (iOS) device tokens against the driver's
// active session, for consumption by the fcmWake.sweep cron that fires
// server-side wake pushes via FCM HTTP v1. Intentionally separate from
// `driverPushTokens` / `registerDriverPushToken` which stores Expo push
// tokens (routed through Expo's push service) for driver-facing
// notifications — different runtime path, different rotation lifecycle,
// different auth surface.
//
// Tokens are session-scoped: if the caller isn't currently on an active
// session, the register call is a telemetry-only no-op. The mobile client
// re-registers on the next tracking-start, so there's no persistent state
// to lose. A single driver can have ≤1 active session at a time (enforced
// by the startShift flow), so the "pick the active session" resolution is
// unambiguous.
// ============================================================================

/**
 * Register the raw device push token for the caller's active session.
 *
 * Resolution order:
 *   1. Authenticate via Clerk phone claim → driver row.
 *   2. Look up the driver's active session (status='active'). If none,
 *      return { registered: false, reason: 'no_active_session' } — the
 *      mobile client will re-register on the next tracking-start.
 *   3. Patch pushToken / pushTokenPlatform / pushTokenUpdatedAt on the
 *      session row.
 *
 * Idempotent: re-registering the same token is a cheap patch. Token
 * rotation (mobile-side diff-check sees a changed token) just overwrites.
 */
export const registerPushToken = mutation({
  args: {
    token: v.string(),
    platform: v.union(v.literal('ios'), v.literal('android')),
  },
  returns: v.object({
    registered: v.boolean(),
    reason: v.optional(v.string()),
  }),
  handler: async (ctx, { token, platform }) => {
    const driver = await resolveAuthenticatedDriver(ctx);

    const activeSession = await ctx.db
      .query('driverSessions')
      .withIndex('by_driver_status', (q) =>
        q.eq('driverId', driver._id).eq('status', 'active'),
      )
      .first();

    if (!activeSession) {
      // No-op: the mobile side calls us again on the next tracking-start,
      // so we don't need a driver-scoped fallback. Emit for visibility.
      console.warn(
        `[pushTokens.registerPushToken] no_active_session ` +
          `driverId=${driver._id}`,
      );
      return { registered: false, reason: 'no_active_session' };
    }

    await ctx.db.patch(activeSession._id, {
      pushToken: token,
      pushTokenPlatform: platform,
      pushTokenUpdatedAt: Date.now(),
    });
    return { registered: true };
  },
});

/**
 * Clear an invalid push token from the active session that holds it.
 *
 * Called from fcmWake.sendWake (PR 1b) when FCM HTTP v1 responds with
 * UNREGISTERED / INVALID_ARGUMENT / SENDER_ID_MISMATCH — the token is
 * permanently dead and should not be retried. Internal-only: no client
 * surface, auth is by virtue of being scheduled inside a trusted Convex
 * function.
 *
 * Scoped to active sessions. Ended sessions that still carry the token
 * as historical state are left alone — they're inert for the sweep cron
 * (which filters status='active') and keeping the value preserves
 * forensic context if the session is inspected later.
 */
export const clearPushToken = internalMutation({
  args: {
    token: v.string(),
  },
  returns: v.null(),
  handler: async (ctx, { token }) => {
    const matches = await ctx.db
      .query('driverSessions')
      .withIndex('by_push_token', (q) => q.eq('pushToken', token))
      .collect();

    for (const session of matches) {
      if (session.status !== 'active') continue;
      await ctx.db.patch(session._id, {
        pushToken: undefined,
        pushTokenPlatform: undefined,
        pushTokenUpdatedAt: Date.now(),
      });
      console.warn(
        `[pushTokens.clearPushToken] cleared sessionId=${session._id}`,
      );
    }
    return null;
  },
});
