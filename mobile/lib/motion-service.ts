/**
 * motion-service.ts — Phase 1d Activity Recognition → FGS wake glue.
 *
 * Consumes transition events from the `otoqa-motion` native module
 * (STILL ↔ IN_VEHICLE only, per § 6.2). Three behaviours layered on
 * top of the raw stream:
 *
 *   1. 30-second debounce. A STILL→IN_VEHICLE that is followed by
 *      IN_VEHICLE→STILL within 30s is treated as flappy noise — the
 *      FGS restart scheduled for the forward transition gets
 *      cancelled. Protects against one-off motion (phone picked up,
 *      briefly jostled) triggering an FGS churn cycle.
 *
 *   2. 60-second rate limit. At most one FGS restart per 60s, even
 *      across multiple legitimate transitions. A transition that
 *      fires inside this window emits telemetry with
 *      `rateLimited=true` and is otherwise ignored.
 *
 *   3. Flag gating, in order:
 *        - `ar_wake_enabled=false`: register subscription, fire NO
 *          telemetry, do not start FGS. Effectively inert.
 *        - `ar_shadow_mode=true`:   fire telemetry, do NOT start FGS.
 *          The mandatory ≥7-day observation step before the live flip.
 *        - both false ('unset'):    inert, same as ar_wake_enabled=false.
 *        - ar_wake_enabled=true + ar_shadow_mode=false: real mode.
 *
 * Confidence gating is intentionally absent: `ActivityTransitionEvent`
 * does not expose a confidence score (only the older
 * `requestActivityUpdates` API does). Debounce + rate-limit + the
 * shadow-mode phantom-rate check are our false-positive defenses.
 *
 * Dead-app wake: out of scope for PR 1d. The Kotlin receiver is
 * lifecycle-bound to JS, so AR events only fire while the JS runtime
 * is alive. The FCM wake path (PR 1b) handles the dead-app case.
 * A follow-up can add a static manifest receiver + HeadlessJS task
 * if canary data shows FCM's ~2min wake isn't fast enough.
 */

import {
  addTransitionListener,
  registerTransitions,
  unregisterTransitions,
  type ActivityTransitionEvent,
} from 'otoqa-motion';
import { Platform } from 'react-native';
import { resumeTracking, isTracking } from './location-tracking';
import {
  getFlagBool,
  FLAG_AR_WAKE_ENABLED,
  FLAG_AR_SHADOW_MODE,
} from './feature-flags';
import { log } from './log';
import {
  trackActivityRecognitionTransition,
  trackActivityRecognitionFgsRestart,
} from './analytics';

const lg = log('MotionService');

// --- TUNING CONSTANTS (mirror the spec in the arch doc) ---

const DEBOUNCE_MS = 30_000;
const RATE_LIMIT_MS = 60_000;

// --- MODULE STATE ---

type TransitionSubscription = { remove: () => void } | null;

let transitionSub: TransitionSubscription = null;
let pendingFgsTimer: ReturnType<typeof setTimeout> | null = null;
let lastFgsRestartAt = 0;
let lastStillTimestamp = 0;
let isRegistered = false;

function clearPendingTimer() {
  if (pendingFgsTimer) {
    clearTimeout(pendingFgsTimer);
    pendingFgsTimer = null;
  }
}

// --- RESOLVE MODE ON EACH EVENT ---
// Read flags per-transition (not at register time) so the real-time
// kill-switch in (app)/_layout.tsx takes effect within seconds: a flag
// flip on the server updates the cache via applyFlagSnapshot, and the
// next transition picks up the new mode without re-subscribing.

type Mode = 'inert' | 'shadow' | 'live';

async function resolveMode(): Promise<Mode> {
  const enabled = await getFlagBool(FLAG_AR_WAKE_ENABLED, false);
  if (!enabled) return 'inert';
  const shadow = await getFlagBool(FLAG_AR_SHADOW_MODE, false);
  return shadow ? 'shadow' : 'live';
}

// --- CORE HANDLER ---

async function handleTransition(event: ActivityTransitionEvent) {
  const mode = await resolveMode();
  if (mode === 'inert') return;

  const isForward =
    event.activityType === 'IN_VEHICLE' && event.transition === 'ENTER';
  const isReverse =
    event.activityType === 'IN_VEHICLE' && event.transition === 'EXIT';
  const stillEnter =
    event.activityType === 'STILL' && event.transition === 'ENTER';

  // Record STILL-enter for Phase 2's stationary geofence + the
  // phantom-rate observation in shadow mode. Not gated — this is a
  // useful signal regardless of forward/reverse polarity.
  if (stillEnter) {
    lastStillTimestamp = event.timestamp;
  }

  // --- FORWARD: STILL → IN_VEHICLE ---
  if (isForward) {
    // Cancel any prior pending timer — the most recent forward
    // transition is the one we honor.
    const hadPendingDebounce = pendingFgsTimer !== null;
    clearPendingTimer();

    const now = Date.now();
    const withinRateLimit = now - lastFgsRestartAt < RATE_LIMIT_MS;
    if (withinRateLimit) {
      trackActivityRecognitionTransition({
        from: 'STILL',
        to: 'IN_VEHICLE',
        shadow: mode === 'shadow',
        rateLimited: true,
        mock: event.mock,
      });
      return;
    }

    // In shadow mode, fire telemetry and return — do NOT schedule FGS.
    if (mode === 'shadow') {
      trackActivityRecognitionTransition({
        from: 'STILL',
        to: 'IN_VEHICLE',
        shadow: true,
        mock: event.mock,
      });
      return;
    }

    // Live mode: schedule the debounced FGS restart. If a reverse
    // transition arrives inside DEBOUNCE_MS, we clear the timer and
    // emit `debounced=true` for telemetry (the next branch).
    pendingFgsTimer = setTimeout(async () => {
      pendingFgsTimer = null;
      lastFgsRestartAt = Date.now();
      trackActivityRecognitionTransition({
        from: 'STILL',
        to: 'IN_VEHICLE',
        shadow: false,
        mock: event.mock,
      });

      try {
        // If FGS is already running (app foreground, tracking never
        // stopped), resumeTracking no-ops gracefully. The restart
        // matters only for the "JS alive but FGS was killed" edge.
        const alreadyRunning = await isTracking();
        if (alreadyRunning) {
          lg.debug('FGS already running on AR-forward; no restart needed');
          return;
        }
        const result = await resumeTracking();
        trackActivityRecognitionFgsRestart({
          success: result.resumed,
          error: result.resumed ? undefined : result.message,
          mock: event.mock,
        });
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        lg.warn(`resumeTracking threw after AR-forward: ${msg}`);
        trackActivityRecognitionFgsRestart({
          success: false,
          error: msg,
          mock: event.mock,
        });
      }
    }, DEBOUNCE_MS);

    // If we JUST cancelled a prior timer (rapid re-triggering of
    // forward transitions), that's not the debounce case — it's the
    // rate-limit case above. We don't emit anything extra here.
    if (hadPendingDebounce) {
      lg.debug('Cancelled prior pending FGS timer on fresh forward transition');
    }
    return;
  }

  // --- REVERSE: IN_VEHICLE → STILL ---
  if (isReverse) {
    // If there's a pending FGS timer scheduled by the forward
    // transition, the reverse fires the debounce — cancel it and
    // flag the telemetry.
    if (pendingFgsTimer !== null) {
      clearPendingTimer();
      trackActivityRecognitionTransition({
        from: 'IN_VEHICLE',
        to: 'STILL',
        shadow: mode === 'shadow',
        debounced: true,
        mock: event.mock,
      });
      return;
    }
    trackActivityRecognitionTransition({
      from: 'IN_VEHICLE',
      to: 'STILL',
      shadow: mode === 'shadow',
      mock: event.mock,
    });
    return;
  }

  // STILL-enter / anything else: emit telemetry only. STILL-exit is
  // redundant with IN_VEHICLE-enter in the transition stream; we let
  // it pass through as-is.
  trackActivityRecognitionTransition({
    from:
      event.activityType === 'STILL' && event.transition === 'ENTER'
        ? 'NONE'
        : undefined,
    to: `${event.activityType}_${event.transition}`,
    shadow: mode === 'shadow',
    mock: event.mock,
  });
}

// --- PUBLIC API ---

/**
 * Register the AR transition subscription. Called from (app)/_layout
 * on mount (Android only; no-op on iOS). Idempotent — safe to call
 * multiple times.
 *
 * Throws only if the permission isn't granted AND registration was
 * attempted — callers should await the ACTIVITY_RECOGNITION runtime
 * permission before invoking. The `(app)/_layout` hook handles this
 * via request-permissions.ts.
 */
export async function startMotionService(): Promise<void> {
  if (Platform.OS !== 'android') {
    lg.debug('startMotionService: non-Android platform; skipping');
    return;
  }
  if (isRegistered) return;

  try {
    await registerTransitions();
    transitionSub = addTransitionListener((event) => {
      handleTransition(event).catch((err) => {
        lg.warn(
          `handleTransition threw: ${err instanceof Error ? err.message : err}`,
        );
      });
    });
    isRegistered = true;
    lg.debug('AR subscription registered');
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    // Most common: permission not yet granted. The JS
    // permissions layer prompts the driver; the next mount cycle
    // re-attempts registration.
    lg.warn(`registerTransitions failed: ${msg}`);
  }
}

/**
 * Tear down the subscription. Called from location-tracking.ts's
 * stopLocationTracking / stopSessionTracking flows.
 */
export async function stopMotionService(): Promise<void> {
  clearPendingTimer();
  if (transitionSub) {
    try {
      transitionSub.remove();
    } catch {
      // Listener already removed — tolerate.
    }
    transitionSub = null;
  }
  if (isRegistered) {
    try {
      await unregisterTransitions();
    } catch (err) {
      lg.warn(
        `unregisterTransitions failed (continuing): ${err instanceof Error ? err.message : err}`,
      );
    }
    isRegistered = false;
  }
}

/**
 * Phase 2 uses the last STILL-enter timestamp to implement the
 * stationary geofence pattern (§ 6.1). Expose it as a read-only
 * accessor so geofence code doesn't need its own STILL listener.
 * Returns 0 if STILL has never been seen this session.
 */
export function getLastStillTimestamp(): number {
  return lastStillTimestamp;
}
