/**
 * useLocationService — owns the location-tracking lifecycle for the
 * authenticated app shell.
 *
 * Responsibilities:
 *   1. Resume tracking on app start once a driver profile is hydrated.
 *      Idempotent; the underlying `resumeTracking()` no-ops if the
 *      SQLite session row is inactive.
 *   2. On foreground transition: restart the foreground watch + sync
 *      timer (iOS suspends JS timers in background) and flush any
 *      buffered locations collected while we were backgrounded.
 *   3. Self-heal orphan tracking. Several codepaths flip `mode`
 *      without going through the graceful teardown in
 *      RoleSwitchSheet (which ends the session and stops tracking
 *      before calling setMode). Examples:
 *        • The auto-switch effect that flips driver→owner when
 *          `profile === null` fires during a reactive query hiccup.
 *        • The AsyncStorage mode-load on app start after a crash
 *          mid-role-switch (state.isActive=true in SQLite but stored
 *          mode flipped to 'owner' before the crash).
 *        • Any future codepath that calls `setMode` directly.
 *      Wrapping setMode isn't enough — `setModeState` is also called
 *      directly (AsyncStorage load) and would bypass a wrapper.
 *      This declarative effect is the backstop: whenever mode is NOT
 *      driver, tracking must not be running. If it is, end the session
 *      (best-effort) and stop tracking. endSession failure is
 *      non-fatal — stopping the client-side tracking is the critical
 *      half, because that's what orphans the GPS stream against a dead
 *      context.
 *
 * MUST be called above any conditional return in the layout — same
 * hoisting rule as `useRegisterPushToken` — so React's hook count
 * stays stable across renders.
 */
import { useEffect, useRef } from 'react';
import { AppState } from 'react-native';
import { useMutation } from 'convex/react';
import { api } from '../../../convex/_generated/api';
import type { Id } from '../../../convex/_generated/dataModel';
import {
  resumeTracking,
  getTrackingState,
  getBufferedLocationCount,
  forceFlush,
  restartForegroundServices,
  stopSessionTracking,
} from '../location-tracking';

interface ActiveSession {
  _id: Id<'driverSessions'>;
}

export function useLocationService(params: {
  mode: 'driver' | 'owner';
  driverId: Id<'drivers'> | null | undefined;
  activeSession: ActiveSession | null | undefined;
}) {
  const { mode, driverId, activeSession } = params;
  const hasResumedRef = useRef(false);
  const endSessionMutation = useMutation(api.driverSessions.endSession);

  // Resume location tracking on app start if it was active.
  useEffect(() => {
    let cancelled = false;
    if (!hasResumedRef.current && driverId) {
      hasResumedRef.current = true;
      resumeTracking().then((result) => {
        if (!cancelled && result.resumed) {
          console.log('[App] Location tracking resumed:', result.message);
        }
      });
    }
    return () => { cancelled = true; };
  }, [driverId]);

  // When app returns to foreground:
  // 1. Restart foreground watch + sync interval (iOS suspends JS timers in background)
  // 2. Flush any buffered locations collected while backgrounded
  useEffect(() => {
    const subscription = AppState.addEventListener('change', async (nextState) => {
      if (nextState === 'active') {
        try {
          await restartForegroundServices();

          const state = await getTrackingState();
          if (!state?.isActive) return;
          const count = await getBufferedLocationCount();
          if (count > 0) {
            console.log(`[App] Foreground: ${count} buffered locations, flushing...`);
            const result = await forceFlush();
            console.log(`[App] Foreground flush result: synced=${result.synced}, success=${result.success}`);
          }
        } catch (err) {
          console.warn('[App] Foreground resume failed:', err);
        }
      }
    });
    return () => subscription.remove();
  }, []);

  // Orphan-tracking self-heal — see hook docblock for full rationale.
  useEffect(() => {
    if (mode === 'driver') return;
    let cancelled = false;
    (async () => {
      try {
        const state = await getTrackingState();
        if (cancelled || !state?.isActive) return;
        console.warn(
          '[AppLayout] Orphan tracking detected in non-driver mode; self-healing',
        );
        if (activeSession) {
          await endSessionMutation({
            sessionId: activeSession._id,
            endReason: 'driver_manual',
          }).catch((err) => {
            // Non-fatal. Server may have already ended the session, or
            // the driver's auth might be in a weird state. What matters
            // is stopping the client-side tracking below.
            console.warn(
              '[AppLayout] endSession failed during self-heal:',
              err instanceof Error ? err.message : String(err),
            );
          });
        }
        await stopSessionTracking();
      } catch (err) {
        console.warn(
          '[AppLayout] Self-heal failed:',
          err instanceof Error ? err.message : String(err),
        );
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [mode, activeSession, endSessionMutation]);
}
