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
 * Cross-platform: stalls happen on both OSes (network restrictions,
 * broken local sync bookkeeping). The Android-specific background-data
 * settings hint is appended to the notification copy only on Android.
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
const ZERO_PROGRESS_KEY = 'sync_stall_zero_progress_count';
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
// Consecutive zero-progress "successes" (HTTP 200, nothing inserted, batch
// all duplicates) before we treat the sync as stalled. Higher than
// MIN_FAILURES because one-off all-dup batches are normal — a response
// lost in transit or two sync loops racing both produce one. Five in a
// row with a deep queue means local sync bookkeeping isn't persisting
// (observed 2026-07-11: every batch re-sent everything previously sent,
// dup count growing 9→12→14, new pings crowded out once the queue passed
// the 50-row batch cap).
const MIN_ZERO_PROGRESS = 5;

/**
 * Post (or refresh) the stall notification and emit the analytics event.
 * Shared by the hard-failure and zero-progress detectors. Throttled by
 * LAST_ALERT_KEY; the fixed identifier replaces rather than stacks.
 */
async function postStallAlert(context: {
  queueDepth: number;
  consecutive: number;
  trigger: 'failures' | 'zero_progress';
  oldestUnsyncedAgeSec?: number;
  error?: string;
}): Promise<void> {
  const now = Date.now();
  const lastAlert =
    Number((await storage.getString(LAST_ALERT_KEY)) ?? '0') || 0;
  if (now - lastAlert < REALERT_INTERVAL_MS) return;
  await storage.set(LAST_ALERT_KEY, String(now));

  if (Platform.OS === 'android') {
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
  }

  // The background-data settings hint only applies to Android — iOS has
  // no per-app background data toggle; there, opening the app is the fix.
  const androidHint =
    Platform.OS === 'android'
      ? ` If this keeps happening, check Settings → Apps → Otoqa Driver → ` +
        `Mobile data → "Allow background data usage".`
      : '';
  await Notifications.scheduleNotificationAsync({
    identifier: NOTIFICATION_ID,
    content: {
      title: 'GPS sync is stalled',
      body:
        `${context.queueDepth} location updates are recorded but aren't reaching ` +
        `dispatch. Open the app to sync now.${androidHint}`,
    },
    // channelId-only trigger = deliver immediately on that channel
    // (Android). iOS: null trigger = present immediately.
    trigger: Platform.OS === 'android' ? { channelId: CHANNEL_ID } : null,
  });

  trackSyncStallAlert({
    queueDepth: context.queueDepth,
    consecutiveFailures: context.consecutive,
    trigger: context.trigger,
    oldestUnsyncedAgeSec: context.oldestUnsyncedAgeSec,
    lastError: context.error,
  });
  lg.warn(
    `Sync stall alert posted (${context.trigger}): ${context.queueDepth} pings queued after ${context.consecutive} consecutive cycles`,
  );
}

/**
 * Record a failed BG sync attempt and post the stall notification when
 * the failure streak + queue depth cross the alert thresholds. Call from
 * the BG task's sync-failure paths — including a marking failure after a
 * successful HTTP call, which strands the batch just as thoroughly.
 * Never throws.
 */
export async function noteSyncFailure(context: {
  queueDepth: number;
  oldestUnsyncedAgeSec?: number;
  error?: string;
}): Promise<void> {
  try {
    const prev = Number((await storage.getString(FAILURES_KEY)) ?? '0') || 0;
    const failures = prev + 1;
    await storage.set(FAILURES_KEY, String(failures));

    if (failures < MIN_FAILURES) return;
    if (context.queueDepth < MIN_QUEUE_DEPTH) return;

    await postStallAlert({
      queueDepth: context.queueDepth,
      consecutive: failures,
      trigger: 'failures',
      oldestUnsyncedAgeSec: context.oldestUnsyncedAgeSec,
      error: context.error,
    });
  } catch (err) {
    lg.warn(
      `noteSyncFailure failed (non-fatal): ${err instanceof Error ? err.message : err}`,
    );
  }
}

/**
 * Record a successful BG sync. Real progress (rows inserted, or the queue
 * fully drained) resets both streaks and dismisses any posted alert. A
 * "success" that inserted nothing and was entirely duplicates counts
 * toward the zero-progress streak instead: one is normal (a lost
 * response, two sync loops racing), but several in a row with a deep
 * queue means local marking isn't persisting and the queue is silently
 * re-sending the same rows while fresh pings pile up behind the batch
 * cap. Never throws.
 */
export async function noteSyncSuccess(context: {
  inserted: number;
  duplicates: number;
  queueDepth: number;
}): Promise<void> {
  try {
    await storage.delete(FAILURES_KEY);

    const zeroProgress = context.inserted === 0 && context.duplicates > 0;
    if (!zeroProgress) {
      await storage.delete(ZERO_PROGRESS_KEY);
      await Notifications.dismissNotificationAsync(NOTIFICATION_ID);
      return;
    }

    const streak =
      (Number((await storage.getString(ZERO_PROGRESS_KEY)) ?? '0') || 0) + 1;
    await storage.set(ZERO_PROGRESS_KEY, String(streak));
    if (streak < MIN_ZERO_PROGRESS) return;
    if (context.queueDepth < MIN_QUEUE_DEPTH) return;

    await postStallAlert({
      queueDepth: context.queueDepth,
      consecutive: streak,
      trigger: 'zero_progress',
      error: 'all_duplicates_no_insert',
    });
  } catch {
    // Best-effort — a leftover notification or stale counter is cosmetic.
  }
}
