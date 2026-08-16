/**
 * useConnectionRecovery — self-healing for the (app) bootstrap gates.
 *
 * The boot path (mobile/app/(app)/_layout.tsx) can get stuck on the
 * "Connecting to server…" / "Checking permissions…" / "Connection Slow"
 * screens when connectivity is flaky or the backend is slow. Historically
 * the only escape was a manual "Retry" that didn't actually re-drive auth.
 * This hook closes that gap by firing a *real* recovery (forceReauth, via
 * the `onRecover` callback) automatically:
 *
 *   1. Edge trigger — the device regains connectivity while stuck. This is
 *      the high-signal case: the radio just came back, so a fresh auth
 *      cycle has a genuine chance of succeeding.
 *   2. Periodic backstop — while stuck AND online, retry on an interval.
 *      Catches the case where NetInfo reports online but Convex still can't
 *      establish a session (server-side / WebSocket trouble). Skipped while
 *      offline — no point hammering auth with no radio.
 *
 * It also surfaces the live connection signals (NetInfo quality + the
 * Convex WebSocket state) so the gate screens can show accurate copy —
 * e.g. "You're offline" vs. "Our servers are slow to respond".
 *
 * MUST be called above any conditional return in the layout (it owns
 * hooks); see the hoisting note on useRegisterPushToken.
 */
import { useEffect, useRef } from 'react';
import { useNetworkStatus } from './useNetworkStatus';
import { useConvexConnectionState } from '../convex';
import { trackConvexAuthEvent } from '../analytics';

// Base delay for the periodic backstop. Each consecutive attempt doubles it
// (20s → 40s → 80s → 160s), capped at AUTO_RECOVERY_MAX_DELAY_MS.
//
// This used to be a fixed 20s `setInterval`, which is what turned a stuck
// session into ~20k auth cycles/day: every tick re-registered
// `convex.setAuth`, and each registration tears down the AuthenticationManager
// and pauses the WebSocket. Retrying faster than a handshake can complete
// doesn't recover the connection, it prevents it.
const AUTO_RECOVERY_BASE_DELAY_MS = 20_000;
const AUTO_RECOVERY_MAX_DELAY_MS = 160_000;

export function useConnectionRecovery({
  isStuck,
  onRecover,
}: {
  isStuck: boolean;
  onRecover: () => void;
}) {
  const { isOffline, connectionQuality, connectionType } = useNetworkStatus();
  const { isWebSocketConnected, connectionRetries } = useConvexConnectionState();

  // Latest onRecover + connection snapshot, read from inside timers/edges
  // so they don't re-arm the effects below. In particular connectionRetries
  // ticks up on every Convex reconnect attempt — if it were an interval
  // dependency, a flapping connection would reset the timer forever and the
  // backstop would never fire.
  const onRecoverRef = useRef(onRecover);
  const connRef = useRef({ isWebSocketConnected, connectionRetries });
  useEffect(() => { onRecoverRef.current = onRecover; }, [onRecover]);
  useEffect(() => {
    connRef.current = { isWebSocketConnected, connectionRetries };
  }, [isWebSocketConnected, connectionRetries]);

  // Consecutive periodic attempts since we were last unstuck. Drives the
  // backoff below and is cleared the moment `isStuck` goes false, so a
  // session that recovers gets an eager 20s backstop again next time.
  const attemptRef = useRef(0);
  useEffect(() => {
    if (!isStuck) attemptRef.current = 0;
  }, [isStuck]);

  // (1) Edge trigger: offline → online while stuck.
  // Not backed off and not budgeted — the radio just returned, which is a
  // genuinely new condition rather than a blind retry of the same state.
  const wasOfflineRef = useRef(isOffline);
  useEffect(() => {
    const cameBackOnline = wasOfflineRef.current && !isOffline;
    wasOfflineRef.current = isOffline;
    if (cameBackOnline && isStuck) {
      attemptRef.current = 0;
      trackConvexAuthEvent('auto_recovery', {
        trigger: 'network_return',
        connection_quality: connectionQuality,
      });
      onRecoverRef.current();
    }
  }, [isOffline, isStuck, connectionQuality]);

  // (2) Periodic backstop while stuck and online, with exponential backoff.
  // A self-rescheduling timeout rather than setInterval so each delay can be
  // computed from the attempt count. The hard stop lives in `forceReauth`,
  // which ignores automatic callers once its budget is spent.
  useEffect(() => {
    if (!isStuck || isOffline) return;

    let timer: ReturnType<typeof setTimeout>;
    const schedule = () => {
      const delay = Math.min(
        AUTO_RECOVERY_BASE_DELAY_MS * 2 ** attemptRef.current,
        AUTO_RECOVERY_MAX_DELAY_MS,
      );
      timer = setTimeout(() => {
        attemptRef.current++;
        trackConvexAuthEvent('auto_recovery', {
          trigger: 'periodic',
          attempt: attemptRef.current,
          delay_ms: delay,
          is_websocket_connected: connRef.current.isWebSocketConnected,
          connection_retries: connRef.current.connectionRetries,
        });
        onRecoverRef.current();
        schedule();
      }, delay);
    };
    schedule();

    return () => clearTimeout(timer);
  }, [isStuck, isOffline]);

  return { isOffline, connectionQuality, connectionType, isWebSocketConnected, connectionRetries };
}
