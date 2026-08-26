/**
 * useShiftReminder — the in-app half of the end-shift reminder
 * (design frames 04d / 04e).
 *
 * The reminder's state is decided on the GPS path, not in React: the
 * background task and the foreground watch both fold fixes into it, and
 * either can fire while no component is mounted. This hook mirrors that
 * state into the view.
 *
 * Two refresh triggers, because there are two ways the state can move:
 *   - an in-process subscription, for a fire that happens while the app is
 *     open (the foreground watch shares this JS runtime);
 *   - a re-read when the app foregrounds, for a fire that happened in the
 *     headless background task, whose runtime has no listeners to notify.
 *
 * See docs/end-shift-reminder-spec.md §7.
 */
import { useCallback, useEffect, useState } from 'react';
import { AppState } from 'react-native';
import {
  getShiftReminderSnapshot,
  subscribeShiftReminder,
  acknowledgeShiftReminder,
  type ShiftReminderSnapshot,
} from '../end-shift-reminder';

export function useShiftReminder(enabled: boolean): {
  reminder: ShiftReminderSnapshot;
  dismiss: () => void;
} {
  const [reminder, setReminder] = useState<ShiftReminderSnapshot>(null);

  const refresh = useCallback(() => {
    if (!enabled) {
      setReminder(null);
      return;
    }
    void getShiftReminderSnapshot().then(setReminder);
  }, [enabled]);

  useEffect(() => {
    refresh();
    if (!enabled) return;

    const unsubscribe = subscribeShiftReminder(refresh);
    const appState = AppState.addEventListener('change', (next) => {
      if (next === 'active') refresh();
    });
    return () => {
      unsubscribe();
      appState.remove();
    };
  }, [enabled, refresh]);

  const dismiss = useCallback(() => {
    // Optimistic: the write is a round-trip through storage, and the banner
    // should collapse under the driver's thumb, not a beat later.
    setReminder((prev) => (prev ? { ...prev, acknowledged: true } : prev));
    void acknowledgeShiftReminder();
  }, []);

  return { reminder, dismiss };
}
