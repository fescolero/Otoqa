/**
 * auto-update.ts — sole reload-decision point for downloaded OTA bundles.
 *
 * Background: `app.json` sets `updates.checkAutomatically: ON_LOAD`, which
 * makes expo-updates check + download new bundles on every cold launch.
 * The bundle lands on disk and `useUpdates().isUpdatePending` flips to
 * true, but expo-updates DOES NOT activate it automatically — activation
 * waits for the next cold launch. Drivers who keep the app warm in the
 * background (the common case for a long shift) can sit on a downloaded-
 * but-not-applied bundle for days.
 *
 * Empirical evidence (2026-04-27): Christian's device cold-launched at
 * 12:09 UTC, emitted four `ota_update_check result=available` events
 * within 2.5s, but never activated PR #118's bundle. PostHog showed his
 * `ota_update_id` stuck on the embedded build's UUID for the next 10
 * hours of continuous shift use, while the actual PR #118 bundle sat
 * downloaded on disk.
 *
 * The pre-existing reload step in `mobile/app/_layout.tsx` had two
 * problems: (1) a `cancelled` flag race during the deeply-nested provider
 * mount sequence (Posthog → Clerk → Convex → ConvexAuth → ...) caused
 * every in-flight reload to bail before firing; (2) it had no
 * active-tracking gate, so if the race ever didn't bite, it would have
 * killed the FGS mid-shift on a foreground transition. We removed it.
 *
 * This hook is now the sole place that calls `Updates.reloadAsync()`. It
 * subscribes to the `useUpdates()` reactive hook (the supported public
 * API) and reloads only at "safe boundaries" — defined as:
 *
 *   `isUpdatePending` AND
 *   `AppState === 'active'` (foreground transition, not mid-tap) AND
 *   `!isTracking()` (no driver session — would otherwise kill the FGS)
 *
 * Mounted in `mobile/app/(app)/_layout.tsx` (post-auth layout, stays
 * mounted for the entire signed-in driver session). The hook is a no-op
 * until `isUpdatePending` becomes true — there's no polling cost.
 *
 * What we explicitly DO NOT do:
 *   • Force reload during active tracking. Killing the FGS to deliver a
 *     bundle is worse than the bundle being a day late. Drivers running
 *     30h+ shifts who never end-shift are a known edge case; in that
 *     scenario the natural cold launch on their next phone reboot
 *     activates the bundle (expo-updates default behavior).
 *   • Try to reload from inside the reactive effect synchronously. We
 *     wait for an `AppState` foreground transition so the reload feels
 *     like a "the app refreshed" moment to the driver, not a surprise
 *     spinner mid-flow.
 *   • Re-implement download. The existing flow in `_layout.tsx` still
 *     does check + fetch on mount and foreground; this hook only
 *     activates what that flow has already downloaded.
 */

import { useEffect } from 'react';
import { AppState } from 'react-native';
import * as Updates from 'expo-updates';
import { isTracking } from './location-tracking';
import {
  trackAutoUpdateReload,
  trackAutoUpdateSkipped,
} from './analytics';
import { log } from './log';

const lg = log('AutoUpdate');

export function useAutoUpdate(): void {
  const { isUpdatePending } = Updates.useUpdates();

  useEffect(() => {
    if (!isUpdatePending) return;
    if (__DEV__) return; // Updates are inert in dev anyway.

    let attempted = false;

    const tryReload = async (
      trigger: 'mount_no_tracking' | 'foreground_no_tracking',
    ): Promise<void> => {
      // `attempted` guards against a double-fire if both the immediate
      // mount-time attempt and a near-simultaneous foreground transition
      // both clear all gates. Idempotent in practice (reload destroys
      // the JS context anyway), but emitting two telemetry events would
      // be noisy.
      if (attempted) return;

      if (AppState.currentState !== 'active') {
        // Don't reload while backgrounded — wait for the next foreground
        // transition. Reloading from background works mechanically (next
        // foreground shows the new bundle) but the driver loses any
        // in-app state we'd preferred to surface in context.
        trackAutoUpdateSkipped({ reason: 'app_not_active' });
        return;
      }

      // Active-tracking gate. MUST be the last check before reload.
      // `isTracking()` reads MMKV-persisted TrackingState; sub-millisecond
      // on a warm cache. A `true` result means the driver is on a shift
      // and the FGS is registered (whether motion-paused or actively
      // capturing). Reload would kill the FGS — unacceptable.
      const tracking = await isTracking();
      if (tracking) {
        trackAutoUpdateSkipped({ reason: 'active_tracking' });
        lg.debug(`Reload deferred — active tracking session in progress`);
        return;
      }

      attempted = true;
      trackAutoUpdateReload({ trigger });
      lg.debug(`Reloading to apply downloaded OTA bundle (${trigger})`);
      try {
        await Updates.reloadAsync();
      } catch (err) {
        // reloadAsync rarely throws — it tears down the JS context, so
        // any throw means the call itself was rejected before the swap
        // (e.g. running in dev / no update on disk despite the flag).
        // Reset `attempted` so the next foreground transition retries.
        attempted = false;
        lg.warn(
          `reloadAsync threw: ${err instanceof Error ? err.message : err}`,
        );
      }
    };

    // Try immediately — if the bundle finished downloading while the app
    // was already foregrounded with no active session, we can activate
    // right now without waiting for a state transition.
    tryReload('mount_no_tracking');

    // And re-try on every subsequent foreground transition until one
    // clears the gates.
    const sub = AppState.addEventListener('change', (state) => {
      if (state === 'active') {
        tryReload('foreground_no_tracking');
      }
    });

    return () => {
      sub.remove();
    };
  }, [isUpdatePending]);
}
