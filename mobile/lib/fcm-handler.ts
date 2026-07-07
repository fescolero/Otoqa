/**
 * fcm-handler.ts — server-dispatched push receive handlers
 *
 * Consumes data-only FCM pushes from `convex/fcmWake.ts`. Two payload
 * families flow through the same delivery pipe (foreground listener +
 * background task), dispatched by their `type` field:
 *
 *   ┌────────────────────┬────────────────────────────────────────────┐
 *   │ type='wake_tracking' │ Server sweep noticed the device went quiet  │
 *   │                    │ during an active shift. Wake the FGS and    │
 *   │                    │ flush queued pings. Source: fcmWake.sweep   │
 *   │                    │ → sendWake (§ 6.2).                         │
 *   ├────────────────────┼────────────────────────────────────────────┤
 *   │ type='session_ended' │ A session ended server-side (dispatch       │
 *   │                    │ override, auto-timeout, handoff, another    │
 *   │                    │ device). Tear down the FGS so we stop        │
 *   │                    │ emitting doomed pings. Source: fcmWake      │
 *   │                    │ ::sendSessionEnded, fired from              │
 *   │                    │ endSessionInternal.                          │
 *   └────────────────────┴────────────────────────────────────────────┘
 *
 * Receive paths (both wired at root init):
 *   1. Foreground: `Notifications.addNotificationReceivedListener`
 *      fires while the app is in the foreground.
 *   2. Background: `TaskManager.defineTask` + `Notifications.registerTaskAsync`
 *      fires when the app is backgrounded or killed. High-priority
 *      data delivery gives us a foreground-service-start exemption
 *      on Android (§ 4.1 #3).
 *
 * Path B: `expo-notifications` + `expo-task-manager` only — no
 * `@react-native-firebase/messaging`. The background task hook is
 * Expo's abstraction over FCM data-only message delivery on Android
 * and silent APNs on iOS.
 */

import * as Notifications from 'expo-notifications';
import * as TaskManager from 'expo-task-manager';
import { ConvexHttpClient } from 'convex/browser';
import { api } from '../../convex/_generated/api';
import { log } from './log';
import { getFlagBool, FLAG_FCM_WAKE_ENABLED } from './feature-flags';
import { getFreshToken } from './auth-token-store';
import {
  resumeTracking,
  getBufferedLocationCount,
  stopSessionTracking,
  getTrackingState,
  forceFlush,
} from './location-tracking';
import {
  trackFcmWakeReceived,
  trackFcmWakeResumeSuccess,
  trackFcmWakeSessionInactive,
  trackFcmWakeIgnored,
  trackFcmWakeAuthFallback,
  trackFcmSessionEndedReceived,
  trackFcmSessionEndedStopped,
  trackFcmSessionEndedIgnored,
} from './analytics';

const lg = log('FcmHandler');

const BACKGROUND_NOTIFICATION_TASK_NAME = 'otoqa-fcm-wake-task';

// Match the payload shape dispatched by convex/fcmWake.ts:sendWake.
const WAKE_PAYLOAD_TYPE = 'wake_tracking';
// Match the payload shape dispatched by convex/fcmWake.ts::sendSessionEnded.
const SESSION_ENDED_PAYLOAD_TYPE = 'session_ended';

type WakePayload = {
  type: string;
  sessionId: string;
};

type SessionEndedPayload = {
  type: string;
  sessionId: string;
  endedAt?: string;
  endReason?: string;
};

function isWakePayload(data: unknown): data is WakePayload {
  if (!data || typeof data !== 'object') return false;
  const d = data as Record<string, unknown>;
  return d.type === WAKE_PAYLOAD_TYPE && typeof d.sessionId === 'string';
}

function isSessionEndedPayload(data: unknown): data is SessionEndedPayload {
  if (!data || typeof data !== 'object') return false;
  const d = data as Record<string, unknown>;
  return (
    d.type === SESSION_ENDED_PAYLOAD_TYPE && typeof d.sessionId === 'string'
  );
}

/**
 * Read the `type` field defensively. Used by the top-level routers to
 * decide which handler to dispatch to without committing to a typed
 * payload until inside that handler.
 */
function readPayloadType(data: unknown): string | null {
  if (!data || typeof data !== 'object') return null;
  const t = (data as Record<string, unknown>).type;
  return typeof t === 'string' ? t : null;
}

/**
 * Core handler for a wake payload, shared by foreground + background
 * receive paths. Idempotent: safe to call with the same sessionId
 * multiple times; resumeTracking no-ops if the FGS is already live
 * and the task is already registered.
 */
async function handleWakePayload(
  data: unknown,
  deliveryPath: 'foreground' | 'background',
): Promise<void> {
  if (!isWakePayload(data)) {
    // Not our payload — silently ignore. Expo's notification pipe is
    // shared across all message types; other surfaces (driver-facing
    // dispatch notifications) flow through the same listener.
    return;
  }

  trackFcmWakeReceived({
    type: data.type,
    sessionId: data.sessionId,
    deliveryPath,
  });

  // Flag gate. Use the cached typed accessor — same pattern as
  // feature-flags.ts queue-backend check. Default false = inert until
  // explicitly enabled on a canary org.
  const enabled = await getFlagBool(FLAG_FCM_WAKE_ENABLED, false);
  if (!enabled) {
    trackFcmWakeIgnored({ reason: 'flag_disabled' });
    return;
  }

  // Session-active guard, best-effort.
  //
  // Why best-effort: the previous "hard guard" implementation blocked
  // every background-context wake for two days in canary. Cold-start
  // background JS can't always authenticate to Convex — Clerk's React
  // singleton isn't loaded, and the fallback `getStoredAuthToken()`
  // returns the last cached JWT which is typically expired (Clerk
  // tokens live ~1 hour). Convex rejected those tokens with
  // "Could not verify OIDC token claim" and we silently dropped the
  // wake. Empirical evidence: 3 fcm_wake_received events on
  // 04-25 PDT, all 3 followed by fcm_wake_ignored
  // reason=session_query_error, zero fcm_wake_resume_success.
  //
  // The guard's purpose is to prevent waking a session the driver has
  // already ended. Two things give us defense-in-depth:
  //   1. Server's `claimSendSlot` mutation atomically re-checks
  //      `session.status === 'active'` at dispatch time. The race
  //      window between claim and FCM delivery is seconds.
  //   2. `resumeTracking()` reads local TrackingState and bails if
  //      `state.isActive === false` — which `stopLocationTracking()`
  //      sets when the driver hits End Shift on this same device.
  //
  // The unique value the server-side guard adds is the multi-device
  // case: driver ends shift on Device A, Device B's FGS dies, push
  // arrives at Device B with stale local state. We preserve that
  // protection in foreground (where Clerk auth works) and gracefully
  // degrade in background (where local state suffices).
  //
  // A future-perfect alternative is signed wake tokens in the FCM
  // payload — out of scope for this fix; tracked as an architecture
  // option if multi-device becomes a real concern.
  const url = process.env.EXPO_PUBLIC_CONVEX_URL;
  if (!url) {
    lg.warn('EXPO_PUBLIC_CONVEX_URL not set — proceeding without guard');
    trackFcmWakeAuthFallback({ reason: 'no_convex_url' });
  }

  let active: Awaited<ReturnType<ConvexHttpClient['query']>> | null = null;
  let guardSucceeded = false;
  if (url) {
    try {
      const token = await getFreshToken();
      if (!token) {
        // No Clerk session reachable at all — common in cold-start
        // background. Skip guard; trust payload + resumeTracking's
        // local state check.
        trackFcmWakeAuthFallback({ reason: 'no_auth_token' });
      } else {
        const httpClient = new ConvexHttpClient(url);
        httpClient.setAuth(token);
        active = await httpClient.query(api.driverSessions.getActiveSession, {});
        guardSucceeded = true;
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      const isAuthError = msg.includes('Unauthenticated') || msg.includes('OIDC');
      lg.warn(`getActiveSession failed (proceeding without guard): ${msg}`);
      trackFcmWakeAuthFallback({
        reason: isAuthError ? 'token_rejected' : 'query_error',
        error: msg,
      });
    }
  }

  // Only enforce the guard when we successfully got an answer. If the
  // guard couldn't run (auth fallback above), we trust the payload's
  // sessionId and let resumeTracking's local-state check serve as
  // secondary defense.
  if (guardSucceeded && (!active || active._id !== data.sessionId)) {
    trackFcmWakeSessionInactive({
      payloadSessionId: data.sessionId,
      currentSessionId: active?._id ?? null,
    });
    return;
  }

  // Valid wake. Resume tracking (force-cycles the background task →
  // restarts FGS). Any queued pings from before the kill get synced
  // as part of the resume flow.
  try {
    const preFlushCount = await getBufferedLocationCount().catch(() => 0);
    const result = await resumeTracking();
    if (!result.resumed) {
      lg.warn(`resumeTracking declined: ${result.message}`);
      trackFcmWakeIgnored({ reason: 'resume_declined', detail: result.message });
      return;
    }
    trackFcmWakeResumeSuccess({
      pingCaptured: true,
      preFlushQueueSize: preFlushCount,
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    lg.error(`resumeTracking threw: ${msg}`);
    trackFcmWakeIgnored({ reason: 'resume_error', error: msg });
  }
}

/**
 * Core handler for a session_ended payload. Tears down the foreground
 * location service so we stop emitting GPS pings that the server is
 * going to reject anyway (see convex/driverLocations.ts::ingestBatch
 * skippedSessionEnded counter).
 *
 * Always stops on receipt — no auth-gated guard like the wake path
 * needs. The "false stop" risk (push for the wrong session) is small:
 *   • If the local TrackingState is for a DIFFERENT session, stopping
 *     it on a stale payload would be a bug. We guard against this by
 *     comparing payload.sessionId to the local state's sessionId. If
 *     they mismatch, we skip the stop and emit an ignore event.
 *   • If TrackingState is already inactive (driver hit End Shift on
 *     this device + the push raced), stop is a harmless no-op.
 *
 * Idempotent — `stopSessionTracking()` already checks `isActive` and
 * no-ops if there's nothing to tear down. Safe to call from both
 * foreground + background delivery paths.
 */
async function handleSessionEndedPayload(
  data: unknown,
  deliveryPath: 'foreground' | 'background',
): Promise<void> {
  if (!isSessionEndedPayload(data)) {
    trackFcmSessionEndedIgnored({ reason: 'invalid_payload' });
    return;
  }

  trackFcmSessionEndedReceived({
    sessionId: data.sessionId,
    endReason: data.endReason ?? 'unknown',
    deliveryPath,
  });

  // Same kill-switch as the wake path. If FCM features are off
  // org-wide, we don't touch local state. The driver can still end
  // their shift manually via the UI; this push is a UX accelerator
  // for the remote-end case.
  const enabled = await getFlagBool(FLAG_FCM_WAKE_ENABLED, false);
  if (!enabled) {
    trackFcmSessionEndedIgnored({ reason: 'flag_disabled' });
    return;
  }

  // Mismatch guard. Local TrackingState carries the sessionId mobile
  // is actively pinging against. If the push refers to a *different*
  // session than what we're tracking, the local session is either:
  //   1. A newer session the driver started (push is stale) → keep
  //      tracking the new one
  //   2. Already cleared (driver hit End Shift here) → no-op
  // Both cases: don't stop. Emit an ignore event so we can see the
  // rate; if it climbs, the server is over-pushing.
  let wasActive = false;
  let preFlushCount = 0;
  try {
    const state = await getTrackingState();
    wasActive = !!state?.isActive;
    if (state?.sessionId && state.sessionId !== data.sessionId) {
      trackFcmSessionEndedIgnored({
        reason: 'session_mismatch',
        detail: `payload=${data.sessionId} local=${state.sessionId}`,
      });
      return;
    }
    preFlushCount = await getBufferedLocationCount().catch(() => 0);
  } catch (err) {
    // getTrackingState shouldn't throw in normal operation; if it
    // does, fall through to the stop. Better to over-stop than leave
    // a stale tracker running.
    lg.warn(
      `getTrackingState threw before session-ended stop: ${
        err instanceof Error ? err.message : String(err)
      }`,
    );
  }

  // Drain the outbound queue BEFORE tearing down so any in-flight
  // valid pings (recorded before session.endedAt) make it to the
  // server. After stopSessionTracking the foreground service is
  // gone; flushing afterward still works (the queue persists in
  // SQLite) but cleaner to flush first.
  try {
    await forceFlush();
  } catch (err) {
    lg.warn(
      `forceFlush threw before session-ended stop: ${
        err instanceof Error ? err.message : String(err)
      }`,
    );
  }

  try {
    const result = await stopSessionTracking();
    lg.debug(
      `session_ended stop result: success=${result.success} msg=${result.message}`,
    );
    trackFcmSessionEndedStopped({
      sessionId: data.sessionId,
      wasActive,
      drainedQueueSize: preFlushCount,
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    lg.error(`stopSessionTracking threw: ${msg}`);
    trackFcmSessionEndedIgnored({ reason: 'stop_error', detail: msg });
  }
}

/**
 * Define + register the background notification task. Must be called
 * at module top level (before React mounts) so TaskManager picks it
 * up on cold-start wake. `registerTaskAsync` is idempotent — calling
 * it a second time is a no-op.
 */
let backgroundTaskRegistered = false;
export async function registerBackgroundWakeTask(): Promise<void> {
  if (backgroundTaskRegistered) return;
  backgroundTaskRegistered = true;

  // defineTask must be called at the module's import time (not inside
  // a function invoked later), but registerTaskAsync can be deferred.
  // We call defineTask eagerly below (see top-level side-effect at
  // the end of this file) and register here.
  try {
    await Notifications.registerTaskAsync(BACKGROUND_NOTIFICATION_TASK_NAME);
    lg.debug('Background wake task registered');
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    lg.warn(`registerTaskAsync failed: ${msg}`);
  }
}

/**
 * Subscribe to foreground notifications and dispatch by payload type.
 * Returns the subscription's remove() function so callers can clean
 * up (the root layout does, on unmount).
 *
 * Kept named `registerForegroundWakeListener` for backward-compat with
 * the root layout that already imports it; it now handles all
 * server-dispatched data-only message types, not just wakes.
 */
export function registerForegroundWakeListener(): () => void {
  const sub = Notifications.addNotificationReceivedListener((notification) => {
    const data = notification.request?.content?.data;
    routePayload(data, 'foreground').catch((err) => {
      lg.warn(
        `foreground routePayload threw: ${err instanceof Error ? err.message : err}`,
      );
    });
  });
  return () => sub.remove();
}

/**
 * Dispatch a received payload to the right handler based on its
 * `type` field. Both delivery paths (foreground listener + background
 * task) funnel through here so the routing rules stay in one place.
 */
async function routePayload(
  data: unknown,
  deliveryPath: 'foreground' | 'background',
): Promise<void> {
  const type = readPayloadType(data);
  switch (type) {
    case WAKE_PAYLOAD_TYPE:
      await handleWakePayload(data, deliveryPath);
      return;
    case SESSION_ENDED_PAYLOAD_TYPE:
      await handleSessionEndedPayload(data, deliveryPath);
      return;
    default:
      // Not one of ours — could be a driver-facing dispatch message,
      // a future payload type, etc. Silently ignore.
      return;
  }
}

// ---------------------------------------------------------------------------
// FOREGROUND NOTIFICATION HANDLER (module-level — no React needed)
// ---------------------------------------------------------------------------
//
// Wake pushes should NEVER render as visible banners — they're silent
// data messages. Default expo-notifications behavior is to show a
// banner + play sound when a notification arrives in the foreground;
// without this handler the driver would see a random "wake_tracking"
// banner every 2 minutes during an FCM wake test.
//
// Returns the full set of `shouldShow*` booleans the SDK supports so
// we're forward-compatible: older versions use `shouldShowAlert`,
// 0.30+ renamed it to `shouldShowBanner` + `shouldShowList`. We set
// all of them for the wake case (suppress everything) and default-
// allow for driver-facing messages.

Notifications.setNotificationHandler({
  handleNotification: async (notification) => {
    const data = notification.request?.content?.data;
    const type = (data as { type?: string } | null)?.type;
    // Silent data-only messages: wake_tracking + session_ended. Both
    // are infrastructure pushes the driver shouldn't see as banners.
    if (type === WAKE_PAYLOAD_TYPE || type === SESSION_ENDED_PAYLOAD_TYPE) {
      return {
        shouldShowAlert: false,
        shouldShowBanner: false,
        shouldShowList: false,
        shouldPlaySound: false,
        shouldSetBadge: false,
      };
    }
    // Driver-facing pushes (dispatch messages, etc.) — default visible.
    return {
      shouldShowAlert: true,
      shouldShowBanner: true,
      shouldShowList: true,
      shouldPlaySound: true,
      shouldSetBadge: true,
    };
  },
});

// ---------------------------------------------------------------------------
// TASK DEFINITION (module-level side effect — required by TaskManager)
// ---------------------------------------------------------------------------
//
// expo-task-manager requires defineTask to be called during JS module
// evaluation at cold-start, not inside a React useEffect — otherwise
// the native runtime's background wake can't find the task handler.
// This matches the existing LOCATION_TASK_NAME pattern in
// location-tracking.ts.

TaskManager.defineTask(
  BACKGROUND_NOTIFICATION_TASK_NAME,
  async ({ data, error }) => {
    if (error) {
      lg.warn(`Background task error: ${error.message}`);
      return;
    }
    // expo-notifications wraps the FCM data payload in a notification
    // envelope. The shape varies by platform; the data sits at
    // `data.notification.data` on Android and `data` on iOS.
    const rawData = data as {
      notification?: { data?: unknown };
      data?: unknown;
    } | null | undefined;
    const payload =
      rawData?.notification?.data ?? rawData?.data ?? rawData ?? null;
    await routePayload(payload, 'background').catch((err) => {
      lg.warn(
        `background routePayload threw: ${err instanceof Error ? err.message : err}`,
      );
    });
  },
);
