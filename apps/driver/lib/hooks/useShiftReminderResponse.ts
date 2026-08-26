/**
 * useShiftReminderResponse — routes what the driver does with the end-shift
 * reminder notification (design frame 04c).
 *
 * Three ways in, all handled the same way:
 *   "End shift"     → the End-shift confirmation sheet on the More tab
 *   "Still working" → dismiss and collapse the in-app banner for the rest
 *                     of this yard visit
 *   tapping the body → the More tab, where the shift controls live
 *
 * Ending the shift deliberately does NOT happen from the notification. It
 * closes any ACTIVE legs, and the sheet is where that gets surfaced along
 * with the shift's elapsed / loads / miles / stops — worth one extra tap.
 *
 * Both the live listener and the cold-start response are handled: a driver
 * whose app was killed taps the reminder, the app launches, and
 * `getLastNotificationResponseAsync` reports the tap that started it.
 * Responses are deduped so a re-render can't route twice.
 *
 * Same hoisting rule as `useRegisterPushToken` — call it above any
 * conditional return in the layout.
 */
import { useEffect, useRef } from 'react';
import * as Notifications from 'expo-notifications';
import { useRouter } from 'expo-router';
import { trackShiftReminderAction } from '../analytics';
import { acknowledgeShiftReminder } from '../end-shift-reminder';
import { log } from '../log';
import {
  END_SHIFT_REMINDER_TYPE,
  ACTION_END_SHIFT,
  ACTION_STILL_WORKING,
  dismissEndShiftReminder,
} from '../end-shift-notification';

const lg = log('ShiftReminderResponse');

export function useShiftReminderResponse(enabled: boolean) {
  const router = useRouter();
  // Response identifiers already acted on. The cold-start read and the live
  // listener can both surface the same tap.
  const handled = useRef<Set<string>>(new Set());

  useEffect(() => {
    if (!enabled) return;
    let cancelled = false;

    const handle = (response: Notifications.NotificationResponse) => {
      const request = response.notification.request;
      const data = request.content.data as { type?: string; sessionId?: string } | null;
      if (data?.type !== END_SHIFT_REMINDER_TYPE) return;

      const key = `${request.identifier}:${response.actionIdentifier}`;
      if (handled.current.has(key)) return;
      handled.current.add(key);

      const sessionId = data.sessionId ?? 'unknown';
      void dismissEndShiftReminder();

      if (response.actionIdentifier === ACTION_STILL_WORKING) {
        // Collapses the in-app banner too (frame 04e): the nudge itself was
        // already spent when it fired, but answering it is what separates a
        // deliberate "not yet" from an ignored notification.
        void acknowledgeShiftReminder();
        trackShiftReminderAction({ sessionId, action: 'still_working', surface: 'notification' });
        lg.debug('Driver chose "Still working"');
        return;
      }

      const action = response.actionIdentifier === ACTION_END_SHIFT ? 'end' : 'opened';
      trackShiftReminderAction({ sessionId, action, surface: 'notification' });
      router.push(
        action === 'end'
          ? '/(app)/(driver-tabs)/more?endShift=1'
          : '/(app)/(driver-tabs)/more',
      );
    };

    const subscription = Notifications.addNotificationResponseReceivedListener(handle);

    // Cold start: the tap that launched the app never reaches the listener.
    void Notifications.getLastNotificationResponseAsync()
      .then((response) => {
        if (!cancelled && response) handle(response);
      })
      .catch(() => {
        // Best-effort — a missed cold-start route just leaves the driver on
        // whatever screen they landed on.
      });

    return () => {
      cancelled = true;
      subscription.remove();
    };
  }, [enabled, router]);
}
