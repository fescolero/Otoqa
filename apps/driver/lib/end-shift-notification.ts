/**
 * end-shift-notification.ts — the lock-screen half of the end-shift
 * reminder (design frame 04c).
 *
 * A local notification, not a push: the decision is already made on the
 * device (see end-shift-reminder.ts), so there is nothing to wait for a
 * server round-trip on, and this works with the phone offline in a yard
 * with no signal.
 *
 * Its own channel, deliberately. The ongoing shift-status notification
 * (otoqa-shift-status) is MIN importance and SECRET visibility by design —
 * it is a passive mirror of shift state and must stay silent. Raising it to
 * alert would turn every shift into a nagging notification; this reminder
 * gets a DEFAULT channel of its own instead, visible in the shade and on the
 * lock screen, with no sound: the driver should notice it next time they
 * look at the phone, not be startled while they are still rolling.
 *
 * See docs/end-shift-reminder-spec.md §6.
 */

import * as Notifications from 'expo-notifications';
import { Platform } from 'react-native';
import { log } from './log';

const lg = log('EndShiftNotification');

export const REMINDER_CHANNEL_ID = 'otoqa_shift_reminders';
export const REMINDER_CATEGORY_ID = 'otoqa_end_shift';
/**
 * Fixed identifier: a re-fire replaces the standing notification rather than
 * stacking a second one. Mute-per-visit should already make a re-fire
 * impossible; this is the belt to that suspenders.
 */
export const REMINDER_NOTIFICATION_ID = 'otoqa-end-shift-reminder';

/** Marks our notifications so handlers and listeners can recognise them. */
export const END_SHIFT_REMINDER_TYPE = 'end_shift_reminder';

export const ACTION_END_SHIFT = 'END_SHIFT';
export const ACTION_STILL_WORKING = 'STILL_WORKING';

export type EndShiftReminderData = {
  type: typeof END_SHIFT_REMINDER_TYPE;
  sessionId: string;
  yardName: string;
};

let configured = false;

/**
 * Ensure the channel and the action category exist. Idempotent and safe to
 * call from anywhere — including the headless background task, which is
 * where the first reminder of a shift is usually posted from.
 */
export async function configureShiftReminderNotifications(): Promise<void> {
  if (configured) return;
  configured = true;
  try {
    if (Platform.OS === 'android') {
      await Notifications.setNotificationChannelAsync(REMINDER_CHANNEL_ID, {
        name: 'Shift reminders',
        description:
          "Reminders to end your shift when you're back at the yard you started from.",
        importance: Notifications.AndroidImportance.DEFAULT,
        sound: null,
        enableVibrate: false,
        showBadge: true,
        // PUBLIC: the whole point is to be readable on the lock screen
        // without unlocking — the opposite of the tracking-heartbeat
        // channel, which is SECRET.
        lockscreenVisibility: Notifications.AndroidNotificationVisibility.PUBLIC,
      });
    }

    // Action buttons. Both platforms support these through categories;
    // neither action opens a foreground app on its own, so the response
    // listener does the routing.
    await Notifications.setNotificationCategoryAsync(REMINDER_CATEGORY_ID, [
      {
        identifier: ACTION_END_SHIFT,
        buttonTitle: 'End shift',
        options: { opensAppToForeground: true },
      },
      {
        identifier: ACTION_STILL_WORKING,
        buttonTitle: 'Still working',
        options: { opensAppToForeground: false },
      },
    ]);
    lg.debug('Shift reminder channel + category ensured');
  } catch (err) {
    configured = false; // let a later attempt retry
    lg.warn(
      `Failed to configure reminder notifications: ${err instanceof Error ? err.message : err}`,
    );
  }
}

/**
 * Post the reminder. Returns false when the OS won't show it — the caller
 * records that as a suppression rather than a delivery, so the telemetry
 * doesn't credit a nudge nobody saw.
 *
 * Permission is checked, never requested: a request can't be answered from a
 * background task, and asking for the first time at the end of a long shift
 * is the worst possible moment. The Permissions screen is where that grant
 * is meant to happen.
 */
export async function presentEndShiftReminder(args: {
  sessionId: string;
  yardName: string;
  shiftElapsedLabel: string;
}): Promise<boolean> {
  try {
    const permission = await Notifications.getPermissionsAsync();
    if (!permission.granted) {
      lg.debug('Reminder suppressed — notifications not granted');
      return false;
    }

    await configureShiftReminderNotifications();

    const data: EndShiftReminderData = {
      type: END_SHIFT_REMINDER_TYPE,
      sessionId: args.sessionId,
      yardName: args.yardName,
    };

    await Notifications.scheduleNotificationAsync({
      identifier: REMINDER_NOTIFICATION_ID,
      content: {
        title: `Back at ${args.yardName}`,
        body: `You're still on shift — ${args.shiftElapsedLabel} so far. End it now?`,
        categoryIdentifier: REMINDER_CATEGORY_ID,
        data,
        // No sound on either platform: the channel already silences it on
        // Android, and this covers iOS, where the category has no say.
        sound: false,
      },
      // channelId-only trigger = deliver immediately on that channel
      // (Android). iOS: null trigger = present immediately.
      trigger: Platform.OS === 'android' ? { channelId: REMINDER_CHANNEL_ID } : null,
    });
    lg.debug(`Reminder posted for "${args.yardName}"`);
    return true;
  } catch (err) {
    lg.warn(
      `Failed to post end-shift reminder: ${err instanceof Error ? err.message : err}`,
    );
    return false;
  }
}

/** Take the reminder down — on shift end, or when the driver acts on it. */
export async function dismissEndShiftReminder(): Promise<void> {
  try {
    await Notifications.dismissNotificationAsync(REMINDER_NOTIFICATION_ID);
  } catch {
    // Nothing to dismiss, or the OS declined. Not worth a log line.
  }
}
