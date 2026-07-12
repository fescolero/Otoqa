/**
 * sync-stall-alert.ts — driver-facing alarm for silently stalled uploads.
 *
 * Born from the 2026-07-11 incident: a Samsung device with the per-app
 * "Allow background data usage" toggle OFF kept capturing GPS normally
 * (FGS alive, queue growing to 97 pings) while every background HTTP
 * upload — ping sync AND analytics — silently failed. Foreground network
 * was unaffected, so the moment the driver opened the app everything
 * drained and looked healthy again. Nothing on the device or the
 * dispatch map said "sync is stalled" while it mattered.
 *
 * This module turns that silent failure into a visible one. The BG task
 * reports each sync outcome here; after MIN_FAILURES consecutive
 * failures with at least MIN_QUEUE_DEPTH pings waiting, we post a local
 * notification telling the driver to open the app (which restores
 * foreground network and drains the queue) and to check the background
 * data setting that caused the incident. A `sync_stall_alert` analytics
 * event records that we alerted — it will reach PostHog on the next
 * successful flush, i.e. typically right after the driver acts on the
 * notification.
 *
 * Android-only: the background-data restriction this detects is an
 * Android mechanism, and the notification copy points at an Android
 * settings path. iOS upload stalls surface through dispatch-side
 * staleness instead.
 *
 * Local notifications require no special permission beyond the
 * POST_NOTIFICATIONS grant the tracking FGS already needs, and the
 * channel is created lazily/idempotently before the first alert.
 */

import * as Notifications from 'expo-notifications';
import { Platform } from 'react-native';
import { storage } from './storage';
import { log } from './log';
import { trackSyncStallAlert } from './analytics';

const lg = log('SyncStallAlert');

const CHANNEL_ID = 'otoqa_sync_alerts';
const NOTIFICATION_ID = 'otoqa-sync-stall';

const FAILURES_KEY = 'sync_stall_consecutive_failures';
const LAST_ALERT_KEY = 'sync_stall_last_alert_at';

// Three consecutive failed BG sync attempts ≈ several minutes of no
// uploads at the normal task cadence — long enough to rule out a single
// dropped request, short enough to alert while the driver is still on
// the road.
const MIN_FAILURES = 3;
// Don't alarm over a couple of pings riding out a dead zone; ~20 queued
// pings means roughly ten minutes of route already missing from dispatch.
const MIN_QUEUE_DEPTH = 20;
// Re-alert cadence while the stall persists. The notification uses a
// fixed identifier so re-alerts replace the previous one, never stack.
const REALERT_INTERVAL_MS = 30 * 60 * 1000;

/**
 * Record a failed BG sync attempt and post the stall notification when
 * the failure streak + queue depth cross the alert thresholds. Call from
 * the BG task's sync-failure paths. Never throws.
 */
export async function noteSyncFailure(context: {
  queueDepth: number;
  oldestUnsyncedAgeSec?: number;
  error?: string;
}): Promise<void> {
  if (Platform.OS !== 'android') return;
  try {
    const prev = Number((await storage.getString(FAILURES_KEY)) ?? '0') || 0;
    const failures = prev + 1;
    await storage.set(FAILURES_KEY, String(failures));

    if (failures < MIN_FAILURES) return;
    if (context.queueDepth < MIN_QUEUE_DEPTH) return;

    const now = Date.now();
    const lastAlert =
      Number((await storage.getString(LAST_ALERT_KEY)) ?? '0') || 0;
    if (now - lastAlert < REALERT_INTERVAL_MS) return;
    await storage.set(LAST_ALERT_KEY, String(now));

    // Idempotent — safe to ensure on every alert rather than at startup.
    // DEFAULT importance: visible banner in the shade, no sound. The
    // driver should notice it next time they look at the phone; it must
    // not startle them while driving.
    await Notifications.setNotificationChannelAsync(CHANNEL_ID, {
      name: 'Sync alerts',
      description:
        'Warnings when recorded GPS data cannot be uploaded to dispatch.',
      importance: Notifications.AndroidImportance.DEFAULT,
      sound: null,
      enableVibrate: false,
      showBadge: true,
    });

    await Notifications.scheduleNotificationAsync({
      identifier: NOTIFICATION_ID,
      content: {
        title: 'GPS sync is stalled',
        body:
          `${context.queueDepth} location updates are recorded but can't upload. ` +
          `Open the app to sync now, then check Settings → Apps → Otoqa Driver → ` +
          `Mobile data → "Allow background data usage".`,
      },
      // channelId-only trigger = deliver immediately on that channel.
      trigger: { channelId: CHANNEL_ID },
    });

    trackSyncStallAlert({
      queueDepth: context.queueDepth,
      consecutiveFailures: failures,
      oldestUnsyncedAgeSec: context.oldestUnsyncedAgeSec,
      lastError: context.error,
    });
    lg.warn(
      `Sync stall alert posted: ${context.queueDepth} pings queued after ${failures} consecutive failures`,
    );
  } catch (err) {
    lg.warn(
      `noteSyncFailure failed (non-fatal): ${err instanceof Error ? err.message : err}`,
    );
  }
}

/**
 * Record a successful BG sync: reset the failure streak and take down
 * any stall notification still in the shade. Call from the BG task's
 * sync-success path. Never throws.
 */
export async function noteSyncSuccess(): Promise<void> {
  try {
    await storage.delete(FAILURES_KEY);
    if (Platform.OS === 'android') {
      await Notifications.dismissNotificationAsync(NOTIFICATION_ID);
    }
  } catch {
    // Best-effort — a leftover notification or stale counter is cosmetic.
  }
}
