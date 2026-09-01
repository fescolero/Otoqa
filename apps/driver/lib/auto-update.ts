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
 *   • Retry a bundle forever. Each attempt is spent from a persisted,
 *     per-update budget BEFORE the reload runs, so a bundle that crashes
 *     on launch exhausts its budget and stops instead of feeding a loop.
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

import { useEffect, useState } from 'react';
import { AppState } from 'react-native';
import * as Updates from 'expo-updates';
import { isTracking } from './location-tracking';
import {
  trackAutoUpdateReload,
  trackAutoUpdateSkipped,
  trackAutoUpdateExhausted,
} from './analytics';
import { storage } from './storage';
import {
  decideReload,
  MAX_RELOAD_ATTEMPTS,
  type ReloadBudget,
} from './auto-update-budget';
import { log } from './log';

const lg = log('AutoUpdate');

// ---------------------------------------------------------------------------
// RELOAD BUDGET
// ---------------------------------------------------------------------------
//
// A bundle that crashes on launch puts this hook in a loop it cannot see:
// expo-updates rolls back to the embedded bundle, the app restarts,
// `isUpdatePending` is still true, and the effect below reloads again.
//
// The old `attempted` flag could never bound that. It lives in the effect's
// closure, and `reloadAsync()` destroys the JS context — so the guard was
// wiped by the very action it was meant to limit. Exactly the shape of the
// auth bug in `fix(driver-auth): bound the auth recovery loop that was
// re-arming itself`, where `forceReauth` zeroed the attempt counter that was
// supposed to stop it.
//
// So the budget has to outlive the context: it goes to storage, keyed by the
// pending update's id. Keyed, not global — a bundle that won't launch must
// not poison the budget of the next one that would.
const RELOAD_BUDGET_KEY = 'ota_reload_budget';

async function readBudget(): Promise<ReloadBudget | null> {
  try {
    const raw = await storage.getString(RELOAD_BUDGET_KEY);
    return raw ? (JSON.parse(raw) as ReloadBudget) : null;
  } catch {
    return null; // Unreadable budget must not block updates forever.
  }
}

async function writeBudget(budget: ReloadBudget): Promise<void> {
  await storage.set(RELOAD_BUDGET_KEY, JSON.stringify(budget));
}

async function clearBudget(): Promise<void> {
  try {
    await storage.delete(RELOAD_BUDGET_KEY);
  } catch {
    // Non-critical: a stale budget is scoped to an update id that has
    // already been superseded, so it can only expire, never misfire.
  }
}

/**
 * Drop the budget once the update it was tracking is the one running. This is
 * the only success signal available — the reload that worked took the JS
 * context with it, so nothing could have recorded it at the time.
 */
async function clearBudgetIfUpdateApplied(): Promise<void> {
  const budget = await readBudget();
  if (!budget) return;
  if (Updates.updateId && budget.updateId === Updates.updateId) {
    lg.debug('Pending update is now running — clearing reload budget');
    await clearBudget();
  }
}

export function useAutoUpdate(): { isUpdateBlocked: boolean } {
  const { isUpdatePending, downloadedUpdate } = Updates.useUpdates();
  // True once a bundle has spent its whole budget without launching. Exposed
  // so a surface can eventually say "this update won't install" instead of
  // the app quietly restarting forever.
  const [isUpdateBlocked, setIsUpdateBlocked] = useState(false);

  // Independent of `isUpdatePending`: the success case is precisely the one
  // where nothing is pending any more.
  useEffect(() => {
    void clearBudgetIfUpdateApplied();
  }, []);

  useEffect(() => {
    if (!isUpdatePending) return;
    if (__DEV__) return; // Updates are inert in dev anyway.

    let attempted = false;
    // Identifies the budget. Falling back to a constant is deliberate: an
    // unidentifiable pending update still gets bounded, it just shares one
    // budget line.
    const pendingUpdateId = downloadedUpdate?.updateId ?? 'unknown_pending';

    const tryReload = async (
      trigger: 'mount_no_tracking' | 'foreground_no_tracking',
    ): Promise<void> => {
      // In-context guard against a double-fire when the mount-time attempt
      // and a near-simultaneous foreground transition both clear the gates.
      // This one is NOT the loop guard — see the budget below.
      if (attempted) return;

      if (AppState.currentState !== 'active') {
        // Don't reload while backgrounded — wait for the next foreground
        // transition. Reloading from background works mechanically (next
        // foreground shows the new bundle) but the driver loses any
        // in-app state we'd preferred to surface in context.
        trackAutoUpdateSkipped({ reason: 'app_not_active' });
        return;
      }

      // Active-tracking gate. Last check that can still be wrong a moment
      // later — only the budget lookup follows, and a shift cannot start
      // during it. `isTracking()` reads MMKV-persisted TrackingState; sub-millisecond
      // on a warm cache. A `true` result means the driver is on a shift
      // and the FGS is registered (whether motion-paused or actively
      // capturing). Reload would kill the FGS — unacceptable.
      const tracking = await isTracking();
      if (tracking) {
        trackAutoUpdateSkipped({ reason: 'active_tracking' });
        lg.debug(`Reload deferred — active tracking session in progress`);
        return;
      }

      // Loop guard. Read AFTER the cheap gates so a deferred reload (asleep,
      // on shift) never spends budget it didn't use.
      const decision = decideReload({
        budget: await readBudget(),
        pendingUpdateId,
        now: Date.now(),
      });

      if (decision.kind === 'blocked') {
        setIsUpdateBlocked(true);
        trackAutoUpdateSkipped({ reason: 'budget_spent' });
        lg.warn(
          `Reload budget spent for ${pendingUpdateId} (${decision.attempts} attempts) — ` +
            `this bundle does not launch. Staying on the current one.`,
        );
        return;
      }
      if (decision.kind === 'backoff') {
        trackAutoUpdateSkipped({ reason: 'backoff' });
        return;
      }

      attempted = true;
      const { attempts } = decision;

      // Spend BEFORE reloading, and await it. `reloadAsync` destroys the JS
      // context, so a write started after it — or merely started and not
      // awaited — is a write that never lands, and the budget stays at zero
      // through every restart. That is the whole bug.
      try {
        await writeBudget({
          updateId: pendingUpdateId,
          attempts,
          lastAttemptAt: Date.now(),
        });
      } catch (err) {
        // If the budget can't be persisted we cannot bound the loop, so
        // don't start one.
        lg.warn(
          `Reload budget write failed — skipping reload: ${err instanceof Error ? err.message : err}`,
        );
        attempted = false;
        return;
      }

      if (decision.isLastAttempt) {
        // Fire on the last attempt rather than after it: if this bundle also
        // fails to launch, the context dies before anything could report it.
        trackAutoUpdateExhausted({ pendingUpdateId, attempts });
      }

      trackAutoUpdateReload({ trigger });
      lg.debug(
        `Reloading to apply downloaded OTA bundle (${trigger}, attempt ${attempts}/${MAX_RELOAD_ATTEMPTS})`,
      );
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
  }, [isUpdatePending, downloadedUpdate?.updateId]);

  return { isUpdateBlocked };
}
