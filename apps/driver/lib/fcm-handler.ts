/**
 * fcm-handler.ts — server-dispatched push receive handlers
 *
 * Consumes the server-dispatched pushes from `convex/fcmWake.ts`. Two
 * payload families flow through the same delivery pipe (foreground
 * listener + background task), dispatched by their `type` field:
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
 * Wake pushes are a combined `notification + data` FCM message
 * (session_ended pushes remain data-only, HIGH priority):
 *   notification: { title, body, channel_id: 'otoqa_wake', priority: MIN }
 *   data:         { type: 'wake_tracking', sessionId: Id<'driverSessions'> }
 *
 * Why combined notification+data (changed 2026-04-28 in PR #133):
 *
 *   The previous data-only payload was being silently dropped by Google's
 *   anti-abuse system. Per Firebase docs:
 *   https://firebase.google.com/docs/cloud-messaging/concept-options#delivery
 *   high-priority pushes that don't generate user-facing interaction get
 *   deprioritized to normal priority or delegated to Google Play services.
 *   We dispatch ~80+ silent wakes per device per day with zero user-visible
 *   result — exactly the abuse pattern Google flags.
 *
 *   Reproduced 2026-04-28 on a Samsung S26 Ultra in EXEMPTED app-standby
 *   bucket: HTTP v1 returned `outcome=success` for every dispatch but
 *   the device's expo-notifications wake task NEVER fired. Logcat
 *   confirmed only LOCATION FGS task invocations (from Find My Device's
 *   periodic location reporting) — no `otoqa-fcm-wake-task` invocations
 *   ever. See PR #133 for the full diagnostic trail.
 *
 *   The notification block routes through expo-notifications' battle-
 *   tested notification path instead of the data-only path that has
 *   open expo bugs (#27345, #38223 — TaskManager + Notifications
 *   reliability on Android 14 / SDK 54).
 *
 *   UX cost: PRIORITY_MIN means the notification appears only in the
 *   shade (no popup, no sound, no peek) and we dismiss it from the
 *   handler immediately after the wake completes (see
 *   dismissInfraNotifications below). Driver sees at most a 1-second
 *   flash in the shade.
 *
 * Receive paths (both wired at root init):
 *   1. Foreground: `Notifications.addNotificationReceivedListener`
 *      fires while the app is in the foreground.
 *   2. Background: `TaskManager.defineTask` + `Notifications.registerTaskAsync`
 *      fires when the app is backgrounded or killed. This is the
 *      point of the whole path: a high-priority message gives us a
 *      foreground-service-start exemption on Android (§ 4.1 #3).
 *
 * Gating, in order:
 *   1. `type` routing — `wake_tracking` and `session_ended` dispatch to
 *      their respective handlers; anything else that flows through the
 *      same delivery pipe (driver-facing dispatch notifications, etc.)
 *      is silently ignored.
 *   2. `fcm_wake_enabled` feature flag — kill-switch for both handlers.
 *      Checked locally (cached flag); real-time refresh is wired in
 *      feature-flags.ts.
 *
 * What we explicitly DO NOT gate on (changed 2026-04-28 in PR #133):
 *
 *   The previous implementation did an authenticated Convex round-trip
 *   (`getActiveSession`) to verify the wake target was still the active
 *   session. That round-trip was the root cause of the day-1 failure
 *   mode (cold-start background JS can't reach Clerk auth) and is
 *   exactly the kind of "first inner promise" that expo issue #38223
 *   describes failing in the headless context.
 *
 *   We rely on two existing defenses for the same correctness property:
 *     1. Server's `claimSendSlot` mutation atomically re-checks
 *        `session.status === 'active'` at FCM dispatch time. The race
 *        window between dispatch and device receipt is seconds.
 *     2. `resumeTracking()` reads local TrackingState and bails if
 *        `state.isActive === false` — which `stopLocationTracking()`
 *        sets when the driver hits End Shift on this same device.
 *
 *   Multi-device: the only scenario these defenses miss is "driver ends
 *   shift on Device A, Device B's FGS is dead, push arrives at Device B
 *   with stale local state." Today we'd resume tracking briefly on B
 *   until its next ping reveals the session is over. Acceptable for
 *   Phase 1; signed wake tokens in the FCM payload are the long-term
 *   fix if multi-device becomes a real concern.
 */

import * as Notifications from 'expo-notifications';
import * as TaskManager from 'expo-task-manager';
import { Platform } from 'react-native';
import { log } from './log';
import { getFlagBool, FLAG_FCM_WAKE_ENABLED } from './feature-flags';
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
  trackFcmWakeIgnored,
  flushAnalytics,
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

// The Android notification channel ID used for wake pushes. Must match
// `android.notification.channel_id` in the FCM payload constructed by
// convex/fcmWake.ts:sendWake. Created on the device at app startup via
// registerBackgroundWakeTask() — must exist before the first wake
// arrives or Android falls back to the default channel and our
// PRIORITY_MIN / no-sound hints are ignored.
const WAKE_CHANNEL_ID = 'otoqa_wake';

type WakePayload = {
  type: string;
  sessionId: string;
};

/**
 * Sweep already-presented infrastructure notifications (wake +
 * session-ended pushes) out of the shade. FCM system-renders their
 * notification block whenever the app is backgrounded/dead, and those
 * cards linger until the driver swipes them — this clears them the next
 * time our code runs (startup + every handled push).
 */
async function dismissInfraNotifications(): Promise<void> {
  if (Platform.OS !== 'android') return;
  try {
    const presented = await Notifications.getPresentedNotificationsAsync();
    for (const n of presented) {
      const type = (n.request?.content?.data as { type?: string } | null)?.type;
      if (type === WAKE_PAYLOAD_TYPE || type === SESSION_ENDED_PAYLOAD_TYPE) {
        await Notifications.dismissNotificationAsync(n.request.identifier);
      }
    }
  } catch {
    // Best-effort hygiene — never let cleanup interfere with wake handling.
  }
}

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
    // Not our payload — silently ignore. expo-notifications' delivery
    // pipe is shared across all message types; driver-facing dispatch
    // notifications flow through the same listener.
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

  // Resume tracking. resumeTracking reads local TrackingState first —
  // if the driver ended shift on this device, `state.isActive === false`
  // and resume bails with a `not_active` reason. Server-side
  // `claimSendSlot` independently re-checks `session.status === 'active'`
  // at FCM dispatch time, providing the second leg of defense for the
  // edge case where the driver ends shift between dispatch and delivery.
  try {
    const preFlushCount = await getBufferedLocationCount().catch(() => 0);
    const result = await resumeTracking();
    if (!result.resumed) {
      lg.warn(`resumeTracking declined: ${result.message}`);
      trackFcmWakeIgnored({ reason: 'resume_declined', detail: result.message });
      // Still dismiss — the notification served its delivery purpose;
      // we don't need the user to see a stale wake in the shade.
      await dismissInfraNotifications();
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
    return;
  }

  // Best-effort dismissal so the wake doesn't accumulate in the shade.
  // Runs after resumeTracking returns so the FGS-start exemption window
  // (~10s on Android 12+) isn't consumed by the dismissal call.
  await dismissInfraNotifications();
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
 * Define + register the background notification task AND set up the
 * Android wake notification channel. Must be called at app startup —
 * the channel must exist before the first wake arrives, otherwise
 * Android falls back to the default channel and our PRIORITY_MIN /
 * no-sound hints are ignored (resulting in a banner + ding every 5 min).
 *
 * Idempotent: safe to call multiple times. Channel and task registration
 * both no-op on re-call.
 */
let backgroundTaskRegistered = false;
export async function registerBackgroundWakeTask(): Promise<void> {
  if (backgroundTaskRegistered) return;
  backgroundTaskRegistered = true;

  // Channel setup — Android only. iOS uses APNs categories, not
  // channels, and is out of scope for Phase 1 (server-side filters out
  // iOS sessions in fcmWake.sweep).
  if (Platform.OS === 'android') {
    try {
      await Notifications.setNotificationChannelAsync(WAKE_CHANNEL_ID, {
        name: 'Tracking heartbeat',
        description:
          'Silent system notifications used to keep your tracking active. Should not normally be visible.',
        importance: Notifications.AndroidImportance.MIN,
        // No sound, no vibration, no badge, no lights — the channel
        // exists purely to satisfy Firebase's user-facing-interaction
        // requirement so wakes aren't deprioritized. The notification
        // is dismissed by the handler before the driver typically
        // notices.
        sound: null,
        vibrationPattern: null,
        enableVibrate: false,
        enableLights: false,
        showBadge: false,
        // SECRET: never render on the lock screen at all. (Visibility
        // can't be changed on channels that already exist from older
        // installs — those stay PRIVATE — but MIN importance keeps them
        // out of the way on stock Android; some OEMs still surface
        // them, which fresh installs won't hit.)
        lockscreenVisibility:
          Notifications.AndroidNotificationVisibility.SECRET,
      });
      lg.debug('Wake notification channel ensured');
      void dismissInfraNotifications();
    } catch (err) {
      lg.warn(
        `setNotificationChannelAsync failed: ${err instanceof Error ? err.message : err}`,
      );
    }
  }

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
      void dismissInfraNotifications();
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
// Wake pushes should NEVER render as a visible banner — even though
// the notification block in the FCM payload is required to bypass
// Firebase's silent-push deprioritization, we don't want the driver
// to see a peek/banner every 5 minutes during normal operation.
//
// Default expo-notifications behavior is to show a banner + play sound
// when a notification arrives in the foreground; without this handler
// the driver would see a "Tracking active" banner every ~5 min while
// they have the app open.
//
// We set the full set of `shouldShow*` booleans the SDK supports so
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
    // expo-notifications wraps the FCM payload in a notification
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
    // CRITICAL: flush analytics before this BG TaskManager task
    // returns. The headless JS context may be torn down immediately
    // after this function resolves, and any events captured into the
    // BG-only PostHog client (see analytics.ts note) live in memory
    // until uploaded. Without this flush, fcm_wake_received and
    // related events are lost to a dying context — leaving us blind
    // to whether the handler ran at all.
    await flushAnalytics().catch((err) => {
      lg.warn(
        `flushAnalytics threw (non-critical): ${err instanceof Error ? err.message : err}`,
      );
    });
  },
);
