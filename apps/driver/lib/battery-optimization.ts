import { Platform } from 'react-native';
import * as IntentLauncher from 'expo-intent-launcher';
import * as Application from 'expo-application';
import { storage } from './storage';
import { log } from './log';

// ============================================================================
// BATTERY-OPTIMIZATION EXEMPTION (ANDROID)
// ============================================================================
//
// Android's battery optimization layer (Doze + App Standby) will kill our
// foreground-service GPS tracker after idle windows, even though it holds a
// persistent notification. Drivers on long shifts with screen-locked phones
// hit this routinely — the capture silently stops and the dispatcher UI
// shows "stale." See mobile/docs/location-queue-mmkv.md for the distinction
// between this (capture-layer) bug and the storage-layer NPE bug that MMKV
// fixes.
//
// Android exposes ACTION_REQUEST_IGNORE_BATTERY_OPTIMIZATIONS — a one-tap
// system dialog that asks the user to exempt our app from battery
// optimization. Google Play explicitly permits this prompt for navigation /
// location-sharing apps (see
// https://support.google.com/googleplay/android-developer/answer/9888379).
//
// This only covers stock Android's battery layer. OEM-specific layers
// (Samsung Sleeping Apps, Xiaomi, etc.) require user-side settings we
// cannot trigger programmatically — those are addressed separately by the
// FCM server-push wake-up pattern (planned, not in this module).
//
// iOS has no equivalent: the OS handles background-location differently
// and doesn't require (or expose) an equivalent exemption. This module
// is a no-op on iOS.
// ============================================================================

const lg = log('BatteryOpt');
const ASKED_KEY = 'battery_opt_asked_v1';

/**
 * True if we've already asked the user to exempt us from battery
 * optimization on this install. Used to avoid re-prompting on every
 * app launch — the system dialog is one-shot; we honor the user's
 * decision until they reinstall or we bump the version suffix on the
 * key (if a future build needs to re-ask for a new reason).
 */
async function hasAsked(): Promise<boolean> {
  try {
    const v = await storage.getString(ASKED_KEY);
    return v === '1';
  } catch {
    return false;
  }
}

async function markAsked(): Promise<void> {
  try {
    await storage.set(ASKED_KEY, '1');
  } catch {
    // Non-critical — worst case we re-ask on next launch.
  }
}

/**
 * Fires the Android system dialog asking the user to exempt this app
 * from battery optimization. One-shot: persists a flag so subsequent
 * calls no-op even if the user denied.
 *
 * Returns true if we launched the prompt, false if we skipped
 * (non-Android, already asked, or intent dispatch failed).
 */
export async function requestIgnoreBatteryOptimizationOnce(): Promise<boolean> {
  if (Platform.OS !== 'android') return false;
  if (await hasAsked()) {
    lg.debug('Battery optimization exemption already requested this install');
    return false;
  }

  try {
    const packageName = Application.applicationId;
    if (!packageName) {
      lg.warn('No application id available, cannot request battery exemption');
      return false;
    }

    await IntentLauncher.startActivityAsync(
      'android.settings.REQUEST_IGNORE_BATTERY_OPTIMIZATIONS',
      {
        data: `package:${packageName}`,
      },
    );
    await markAsked();
    lg.debug('Fired REQUEST_IGNORE_BATTERY_OPTIMIZATIONS intent');
    return true;
  } catch (err) {
    // Some devices ship without the Doze dialog (rare, usually pre-M).
    // Mark as asked so we don't retry on every launch and spam.
    lg.warn(
      `Failed to launch battery optimization intent: ${err instanceof Error ? err.message : err}`,
    );
    await markAsked();
    return false;
  }
}
