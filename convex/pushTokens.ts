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
 * The server is the source of truth — clients call this on every
 * tracking-state inflection (mount, foreground, session change). The
 * mutation is idempotent: if the active session already holds the
 * exact same (token, platform) pair, we skip the DB patch and return
 * `changed: false`. This lets clients drop their own caching layer
 * (which leaked across day-2-onward shifts when the device token
 * didn't rotate but the active session did) and keep correctness.
 *
 * Resolution order:
 *   1. Authenticate via Clerk phone claim → driver row.
 *   2. Look up the driver's active session (status='active'). If none,
 *      return { registered: false, changed: false, reason: 'no_active_session' }.
 *   3. If session.pushToken === token AND session.pushTokenPlatform ===
 *      platform → return { registered: true, changed: false } without
 *      patching. This is the steady-state hot path: a foregrounded app
 *      that's still on the same shift and same device.
 *   4. Otherwise patch pushToken / pushTokenPlatform / pushTokenUpdatedAt
 *      and return { registered: true, changed: true }.
 *
 * `changed: true` is the only signal that drives a `push_token_registered`
 * analytics event on the client. `changed: false` is silent — dashboards
 * count real registrations, not redundant heartbeat calls.
 */
export const registerPushToken = mutation({
  args: {
    token: v.string(),
    platform: v.union(v.literal('ios'), v.literal('android')),
  },
  returns: v.object({
    registered: v.boolean(),
    changed: v.boolean(),
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
      return { registered: false, changed: false, reason: 'no_active_session' };
    }

    // Idempotency check — read-then-no-op when the row is already correct.
    // Saves a DB write and the index churn that comes with it. The server
    // is the source of truth; if ANYTHING differs (token rotation, fresh
    // session without token, platform changed because driver swapped
    // devices) we patch.
    if (
      activeSession.pushToken === token &&
      activeSession.pushTokenPlatform === platform
    ) {
      return { registered: true, changed: false };
    }

    await ctx.db.patch(activeSession._id, {
      pushToken: token,
      pushTokenPlatform: platform,
      pushTokenUpdatedAt: Date.now(),
    });
    return { registered: true, changed: true };
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
 *
 * Compare-and-clear discipline: re-checks `session.pushToken === token`
 * on the loaded row before patching. The index lookup already filters
 * by token, but a concurrent `registerPushToken` mutation that lands
 * between this fn's index read and the patch could leave us with a row
 * whose pushToken has been replaced. Convex OCC will retry the txn on
 * the index-write conflict, but the explicit re-check is cheap insurance
 * AND documents the invariant for future readers.
 *
 * Today this fn has no callers in code — fcmWake.recordResult does the
 * clear inline so it has the sessionId in hand. The defensive check
 * stays here so that if a future caller wires it up, the race-safety
 * comes for free.
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
      // Compare-and-clear: re-verify the row still holds the token we
      // were asked to clear. If `registerPushToken` overwrote it during
      // this txn, leave the fresh value alone — wiping it would silently
      // undo a registration the mobile side intended.
      if (session.pushToken !== token) {
        console.warn(
          `[pushTokens.clearPushToken] skipped sessionId=${session._id} note=token_rotated`,
        );
        continue;
      }
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
