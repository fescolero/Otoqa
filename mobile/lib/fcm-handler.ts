/**
 * fcm-handler.ts — Phase 1c wake-push receive + FGS resume
 *
 * Consumes the server-dispatched wake pushes from `convex/fcmWake.ts`
 * (§ 6.2 in the architecture doc). The payload shape is intentionally
 * tiny (4KB FCM ceiling):
 *     { type: 'wake_tracking', sessionId: Id<'driverSessions'> }
 *
 * Receive paths (both wired at root init):
 *   1. Foreground: `Notifications.addNotificationReceivedListener`
 *      fires while the app is in the foreground. Rare for wake
 *      pushes — if the app is already open, FGS is almost certainly
 *      still running — but we handle it defensively (idempotent).
 *   2. Background: `TaskManager.defineTask` + `Notifications.registerTaskAsync`
 *      fires when the app is backgrounded or killed. This is the
 *      point of the whole path: a high-priority data message gives
 *      us a foreground-service-start exemption (§ 4.1 #3).
 *
 * Gating, in order:
 *   1. `type === 'wake_tracking'` — filter out non-wake messages that
 *      might flow through the same delivery pipe in the future.
 *   2. `fcm_wake_enabled` feature flag — kill-switch. Checked locally
 *      (cached flag); real-time refresh is wired in feature-flags.ts.
 *   3. Session-active guard — the sweep dispatches based on a
 *      potentially-stale `driverSessions.lastPingAt`; between dispatch
 *      and delivery the driver may have clocked out. We query
 *      `getActiveSession` and verify the returned `_id` matches the
 *      payload `sessionId`. Emits `fcm_wake_session_inactive` and
 *      returns without touching FGS on mismatch.
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
import { resumeTracking, getBufferedLocationCount } from './location-tracking';
import {
  trackFcmWakeReceived,
  trackFcmWakeResumeSuccess,
  trackFcmWakeSessionInactive,
  trackFcmWakeIgnored,
} from './analytics';

const lg = log('FcmHandler');

const BACKGROUND_NOTIFICATION_TASK_NAME = 'otoqa-fcm-wake-task';

// Match the payload shape dispatched by convex/fcmWake.ts:sendWake.
const WAKE_PAYLOAD_TYPE = 'wake_tracking';

type WakePayload = {
  type: string;
  sessionId: string;
};

function isWakePayload(data: unknown): data is WakePayload {
  if (!data || typeof data !== 'object') return false;
  const d = data as Record<string, unknown>;
  return d.type === WAKE_PAYLOAD_TYPE && typeof d.sessionId === 'string';
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

  // Session-active guard. The sweep dispatched this push based on a
  // server-side freshness probe; if the driver clocked out between
  // dispatch and delivery, starting FGS here would resurrect a session
  // the driver explicitly ended. Verify the _id still matches.
  //
  // Use a fresh ConvexHttpClient (not the ConvexReactClient) because
  // background-task context may fire before React mounts.
  const url = process.env.EXPO_PUBLIC_CONVEX_URL;
  if (!url) {
    lg.warn('EXPO_PUBLIC_CONVEX_URL not set — cannot verify session');
    trackFcmWakeIgnored({ reason: 'no_convex_url' });
    return;
  }

  let active: Awaited<
    ReturnType<ConvexHttpClient['query']>
  > | null = null;
  try {
    const token = await getFreshToken();
    if (!token) {
      trackFcmWakeIgnored({ reason: 'no_auth_token' });
      return;
    }
    const httpClient = new ConvexHttpClient(url);
    httpClient.setAuth(token);
    active = await httpClient.query(api.driverSessions.getActiveSession, {});
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    lg.warn(`getActiveSession failed: ${msg}`);
    trackFcmWakeIgnored({ reason: 'session_query_error', error: msg });
    return;
  }

  if (!active || active._id !== data.sessionId) {
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
 * Subscribe to foreground notifications for the same wake payload.
 * Returns the subscription's remove() function so callers can clean
 * up (the root layout does, on unmount).
 */
export function registerForegroundWakeListener(): () => void {
  const sub = Notifications.addNotificationReceivedListener((notification) => {
    const data = notification.request?.content?.data;
    handleWakePayload(data, 'foreground').catch((err) => {
      lg.warn(
        `foreground handleWakePayload threw: ${err instanceof Error ? err.message : err}`,
      );
    });
  });
  return () => sub.remove();
}

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
    await handleWakePayload(payload, 'background').catch((err) => {
      lg.warn(
        `background handleWakePayload threw: ${err instanceof Error ? err.message : err}`,
      );
    });
  },
);
