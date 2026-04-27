/**
 * usePushWake — Phase 1c FCM wake wiring + ongoing push-token refresh.
 *
 * MUST be called above any conditional return in the layout — same
 * hoisting rule as `useRegisterPushToken`. All sub-hooks are inert in
 * Expo Go + when not signed in (internal guards handle those cases).
 *
 * Responsibilities:
 *   1. Register the background task + foreground listener for wake
 *      pushes. Idempotent; the native task registration persists
 *      across JS reloads.
 *   2. Refresh the device push token on mount + on every foreground
 *      return. Path B's stand-in for Firebase's onTokenRefresh: we
 *      diff-check against the secure-store cache and re-register only
 *      on rotation. Non-blocking — errors swallowed inside the helper.
 *   3. Re-register the device push token whenever the active session
 *      _id transitions. Without this, the "sign in → Start Shift
 *      without backgrounding" flow never populates pushToken on the
 *      session: the mount effect fires before a session exists (server
 *      returns { registered: false, reason: 'no_active_session' }),
 *      the token isn't cached locally, and nothing else triggers
 *      another attempt. Reactive session query → re-run registration
 *      closes the gap with no user-visible seams.
 *   4. Reactive feature-flag subscription. Convex pushes new snapshots
 *      on every write to featureFlags for the caller's org, which
 *      means flipping `fcm_wake_enabled=false` (or any other capability
 *      flag) takes effect on live clients within seconds — no cold
 *      start required. applyFlagSnapshot writes both the in-memory
 *      cache and the MMKV-backed persistent cache so next cold start
 *      also sees the new value.
 *   5. Activity Recognition (Phase 1d). Native module registers
 *      STILL↔IN_VEHICLE transitions via Google Play Services and
 *      forwards them to motion-service, which gates on ar_wake_enabled
 *      + ar_shadow_mode flags. Telemetry fires in shadow mode; FGS
 *      restart fires only in live mode. No-op on iOS (Phase 4
 *      decision for the iOS motion path is separate). The subscription
 *      is torn down on unmount — the stopLocationTracking flow
 *      separately tears it down when the driver ends their shift.
 */
import { useEffect } from 'react';
import { AppState } from 'react-native';
import { useQuery } from 'convex/react';
import { api } from '../../../convex/_generated/api';
import {
  registerBackgroundWakeTask,
  registerForegroundWakeListener,
} from '../fcm-handler';
import { refreshPushTokenIfChanged } from '../push-token';
import { applyFlagSnapshot } from '../feature-flags';
import { startMotionService, stopMotionService } from '../motion-service';

interface ActiveSessionLite {
  _id: string;
}

export function usePushWake(activeSession: ActiveSessionLite | null | undefined) {
  // 1. Background wake task + foreground wake listener.
  useEffect(() => {
    registerBackgroundWakeTask().catch(() => {});
    const cleanup = registerForegroundWakeListener();
    return cleanup;
  }, []);

  // 2. Token refresh on mount + on every foreground return.
  useEffect(() => {
    refreshPushTokenIfChanged().catch(() => {});
    const sub = AppState.addEventListener('change', (s) => {
      if (s === 'active') refreshPushTokenIfChanged().catch(() => {});
    });
    return () => sub.remove();
  }, []);

  // 3. Re-register when the active session _id transitions.
  useEffect(() => {
    if (activeSession?._id) {
      refreshPushTokenIfChanged().catch(() => {});
    }
  }, [activeSession?._id]);

  // 4. Reactive feature-flag subscription.
  const liveFlags = useQuery(api.featureFlags.getForOrg, {});
  useEffect(() => {
    if (liveFlags) applyFlagSnapshot(liveFlags);
  }, [liveFlags]);

  // 5. Activity Recognition (Phase 1d).
  useEffect(() => {
    startMotionService().catch(() => {});
    return () => {
      stopMotionService().catch(() => {});
    };
  }, []);
}
