/**
 * push-token.ts — Phase 1c wake-push device token registration
 *
 * Manages the raw FCM/APNs device token that server-side fcmWake.sweep
 * uses to deliver high-priority wake pushes (§ 6.2 in the architecture
 * doc). Distinct from `useRegisterPushToken` / `driverPushTokens` which
 * stores **Expo** push tokens for driver-facing notifications.
 *
 * Path B: uses `expo-notifications` only — no `@react-native-firebase/*`
 * dependency. `getDevicePushTokenAsync()` returns:
 *   • Android: raw FCM registration token
 *   • iOS:     raw APNs device token
 *
 * Server-authoritative model: the client calls `registerPushToken` on
 * every tracking-state inflection (mount, foreground, session change),
 * and the server short-circuits with `changed: false` when the active
 * session row already holds the same (token, platform) pair. No
 * client-side cache — that approach (an earlier iteration of this file)
 * leaked across day-2-onward shifts: the device token didn't rotate but
 * the active session did, so the cache hit and a fresh session was
 * created without any pushToken on the server. Letting the server
 * decide makes correctness self-healing.
 *
 * iOS caveat (same as server-side § 6.2 note): Phase 1c registers iOS
 * tokens as `platform: 'ios'`, but the server-side sweep filters to
 * `pushTokenPlatform='android'` only — FCM HTTP v1 can't route raw
 * APNs tokens. Phase 4 decides Option A (Firebase iOS SDK) vs B
 * (server-side APNs HTTP/2) and unblocks iOS wake end-to-end.
 */

import * as Notifications from 'expo-notifications';
import Constants, { ExecutionEnvironment } from 'expo-constants';
import { Platform } from 'react-native';
import { convex } from './convex';
import { api } from '../../convex/_generated/api';
import { log } from './log';
import {
  trackPushTokenRegistered,
  trackPushTokenSkipped,
  trackPushTokenCleared,
} from './analytics';

const lg = log('PushToken');

/**
 * Fetch the current device push token and ask the server to register it
 * against the active session. The mutation is idempotent server-side —
 * if the session row already has the matching (token, platform) pair,
 * the mutation returns `{ changed: false }` and we silently no-op (no
 * DB write, no analytics event).
 *
 * Safe to call eagerly and frequently — early-returns on Expo Go,
 * swallows errors (push is supplementary; not surfacing to the driver).
 */
export async function refreshPushTokenIfChanged(): Promise<void> {
  // Expo Go doesn't include the FCM native module, so getDevicePushTokenAsync
  // throws there. Matches the existing gate in useRegisterPushToken.ts.
  if (Constants.executionEnvironment === ExecutionEnvironment.StoreClient) {
    trackPushTokenSkipped({ reason: 'expo_go' });
    return;
  }

  let device: Notifications.DevicePushToken;
  try {
    device = await Notifications.getDevicePushTokenAsync();
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    lg.warn(`getDevicePushTokenAsync failed: ${msg}`);
    trackPushTokenSkipped({ reason: 'device_token_error', error: msg });
    return;
  }

  if (!device.data) {
    trackPushTokenSkipped({ reason: 'empty_token' });
    return;
  }

  const platform: 'ios' | 'android' = Platform.OS === 'ios' ? 'ios' : 'android';

  try {
    const result = await convex.mutation(api.pushTokens.registerPushToken, {
      token: device.data,
      platform,
    });
    if (!result.registered) {
      // Most common reason: no active session yet. The mobile side will
      // re-call this on the next tracking-start.
      trackPushTokenSkipped({
        reason: 'not_registered_by_server',
        server_reason: result.reason ?? 'unknown',
      });
      return;
    }
    if (!result.changed) {
      // Server short-circuited — session already had this exact token.
      // Silent: dashboards count `push_token_registered` as actual
      // registration writes, not heartbeat calls.
      return;
    }
    // `rotated` semantics: the server changed something — either a fresh
    // session getting its first token, or a real token rotation. The
    // server doesn't distinguish (and doesn't need to) for Phase 1's
    // FCM wake purposes.
    trackPushTokenRegistered({ platform, rotated: false });
    lg.debug(`Registered push token on active session`);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    lg.warn(`registerPushToken mutation failed: ${msg}`);
    trackPushTokenSkipped({ reason: 'mutation_error', error: msg });
  }
}

/**
 * Sign-out hook. Kept for API stability with logout.ts; emits a
 * telemetry event so we can see sign-out frequency.
 *
 * Previously wiped a SecureStore cache. With server-authoritative
 * registration, no client cache exists. Server-side cleanup is
 * unnecessary too: the next driver on this device will overwrite the
 * session's pushToken on their first registration call.
 */
export async function clearCachedPushToken(reason: string): Promise<void> {
  trackPushTokenCleared({ reason });
  lg.debug(`Push-token cleared marker (reason=${reason}) — no cache to wipe`);
}
