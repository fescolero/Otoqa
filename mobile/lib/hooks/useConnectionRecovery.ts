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

const AUTO_RECOVERY_INTERVAL_MS = 20_000;

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

  // (1) Edge trigger: offline → online while stuck.
  const wasOfflineRef = useRef(isOffline);
  useEffect(() => {
    const cameBackOnline = wasOfflineRef.current && !isOffline;
    wasOfflineRef.current = isOffline;
    if (cameBackOnline && isStuck) {
      trackConvexAuthEvent('auto_recovery', {
        trigger: 'network_return',
        connection_quality: connectionQuality,
      });
      onRecoverRef.current();
    }
  }, [isOffline, isStuck, connectionQuality]);

  // (2) Periodic backstop while stuck and online.
  useEffect(() => {
    if (!isStuck || isOffline) return;
    const timer = setInterval(() => {
      trackConvexAuthEvent('auto_recovery', {
        trigger: 'periodic',
        is_websocket_connected: connRef.current.isWebSocketConnected,
        connection_retries: connRef.current.connectionRetries,
      });
      onRecoverRef.current();
    }, AUTO_RECOVERY_INTERVAL_MS);
    return () => clearInterval(timer);
  }, [isStuck, isOffline]);

  return { isOffline, connectionQuality, connectionType, isWebSocketConnected, connectionRetries };
}
