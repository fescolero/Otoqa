/**
 * fcm-handler.ts — Phase 1c wake-push receive + FGS resume
 *
 * Consumes the server-dispatched wake pushes from `convex/fcmWake.ts`.
 * The payload is a combined `notification + data` FCM message:
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
 *   dismissWakeNotifications below). Driver sees at most a 1-second
 *   flash in the shade.
 *
 * Receive paths (both wired at root init):
 *   1. Foreground: `Notifications.addNotificationReceivedListener`
 *      fires while the app is in the foreground. Rare for wake
 *      pushes — if the app is already open, FGS is almost certainly
 *      still running — but we handle it defensively (idempotent).
 *   2. Background: `TaskManager.defineTask` + `Notifications.registerTaskAsync`
 *      fires when the app is backgrounded or killed. This is the
 *      point of the whole path: a high-priority message gives us a
 *      foreground-service-start exemption.
 *
 * Gating, in order:
 *   1. `type === 'wake_tracking'` — filter out non-wake messages that
 *      flow through the same delivery pipe (driver-facing dispatch
 *      notifications, etc.).
 *   2. `fcm_wake_enabled` feature flag — kill-switch. Checked locally
 *      (cached flag); real-time refresh is wired in feature-flags.ts.
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
import { resumeTracking, getBufferedLocationCount } from './location-tracking';
import {
  trackFcmWakeReceived,
  trackFcmWakeResumeSuccess,
  trackFcmWakeIgnored,
} from './analytics';

const lg = log('FcmHandler');

const BACKGROUND_NOTIFICATION_TASK_NAME = 'otoqa-fcm-wake-task';

// Match the payload shape dispatched by convex/fcmWake.ts:sendWake.
const WAKE_PAYLOAD_TYPE = 'wake_tracking';

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

function isWakePayload(data: unknown): data is WakePayload {
  if (!data || typeof data !== 'object') return false;
  const d = data as Record<string, unknown>;
  return d.type === WAKE_PAYLOAD_TYPE && typeof d.sessionId === 'string';
}

/**
 * Find any presented wake notifications and dismiss them. Called after
 * a successful wake handler run so the driver doesn't see wake
 * notifications stacking up in the shade every ~5 minutes.
 *
 * Filters by `data.type === 'wake_tracking'` so we never dismiss
 * driver-facing dispatch notifications that share the notification
 * pipe.
 */
async function dismissWakeNotifications(): Promise<void> {
  try {
    const presented = await Notifications.getPresentedNotificationsAsync();
    const wakeIds = presented
      .filter(
        (n) =>
          (n.request?.content?.data as { type?: string } | null)?.type ===
          WAKE_PAYLOAD_TYPE,
      )
      .map((n) => n.request.identifier);
    for (const id of wakeIds) {
      await Notifications.dismissNotificationAsync(id);
    }
  } catch (err) {
    // Non-critical — notification will auto-clear on next wake or when
    // the user opens the shade.
    lg.debug(
      `dismissWakeNotifications failed: ${err instanceof Error ? err.message : err}`,
    );
  }
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
      await dismissWakeNotifications();
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
  await dismissWakeNotifications();
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
        lockscreenVisibility:
          Notifications.AndroidNotificationVisibility.PRIVATE,
      });
      lg.debug('Wake notification channel ensured');
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
    if ((data as { type?: string } | null)?.type === WAKE_PAYLOAD_TYPE) {
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
    await handleWakePayload(payload, 'background').catch((err) => {
      lg.warn(
        `background handleWakePayload threw: ${err instanceof Error ? err.message : err}`,
      );
    });
  },
);
