/**
 * push-token.ts — Phase 1c wake-push device token registration
 *
 * Manages the raw FCM/APNs device token that server-side fcmWake.sweep
 * uses to deliver high-priority wake pushes (§ 6.2 in the architecture
 * doc). Distinct from `useRegisterPushToken` / `driverPushTokens` which
 * stores **Expo** push tokens for driver-facing notifications.
 *
 * Path B: uses `expo-notifications` only — no `@react-native-firebase/*`
 * dependency, no runtime-version bump beyond the one landing with this
 * PR. `getDevicePushTokenAsync()` returns:
 *   • Android: raw FCM registration token
 *   • iOS:     raw APNs device token
 *
 * Token lifecycle:
 *   1. On tracking start → call refreshPushTokenIfChanged()
 *   2. On app foreground → refreshPushTokenIfChanged() diff-checks
 *      against the secure-store cache. This is Path B's stand-in for
 *      Firebase's `onTokenRefresh` callback, which only fires in the
 *      `@react-native-firebase/messaging` path we're not using.
 *   3. On sign-out → clearCachedPushToken() wipes the local cache.
 *
 * iOS caveat (same as server-side § 6.2 note): Phase 1c registers iOS
 * tokens as `platform: 'ios'`, but the server-side sweep filters to
 * `pushTokenPlatform='android'` only — FCM HTTP v1 can't route raw
 * APNs tokens. Phase 4 decides Option A (Firebase iOS SDK) vs B
 * (server-side APNs HTTP/2) and unblocks iOS wake end-to-end.
 */

import * as Notifications from 'expo-notifications';
import * as SecureStore from 'expo-secure-store';
import Constants, { ExecutionEnvironment } from 'expo-constants';
import { Platform } from 'react-native';
import { convex } from './convex';
import { api } from '../../convex/_generated/api';
import { log } from './log';
import {
  trackPushTokenRegistered,
  trackPushTokenCleared,
  trackPushTokenSkipped,
} from './analytics';

const lg = log('PushToken');

// Keychain / Keystore-backed storage. The device token itself is not a
// secret (Google/Apple return the same value to every caller on the same
// install), but routing it through SecureStore avoids one more writer
// on the AsyncStorage surface and guarantees the rotation-diff key
// survives app upgrades and storage clears.
const SECURE_KEY = 'otoqa.pushToken.lastRegistered';

/**
 * Fetch the current device push token, compare against the local cache,
 * and call the Convex `registerPushToken` mutation if it's new or rotated.
 *
 * Safe to call eagerly — early-returns on Expo Go (no native FCM) and
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

  let cached: string | null = null;
  try {
    cached = await SecureStore.getItemAsync(SECURE_KEY);
  } catch (err) {
    // SecureStore failures are rare (usually mean Keystore is locked or
    // the key was deleted). Proceed with registration — worst case we
    // register a token that was already registered, which the server
    // upserts idempotently.
    lg.warn(`SecureStore read failed: ${err instanceof Error ? err.message : err}`);
  }

  if (cached === device.data) return; // Nothing to do.

  const platform: 'ios' | 'android' = Platform.OS === 'ios' ? 'ios' : 'android';

  try {
    const result = await convex.mutation(api.pushTokens.registerPushToken, {
      token: device.data,
      platform,
    });
    if (!result.registered) {
      // Most common reason: no active session yet. The mobile side will
      // re-call this on the next tracking-start, so don't cache the
      // token as registered until the server accepted it.
      trackPushTokenSkipped({
        reason: 'not_registered_by_server',
        server_reason: result.reason ?? 'unknown',
      });
      return;
    }
    await SecureStore.setItemAsync(SECURE_KEY, device.data).catch(() => {});
    trackPushTokenRegistered({ platform, rotated: cached !== null });
    lg.debug(`Registered token (rotated=${cached !== null})`);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    lg.warn(`registerPushToken mutation failed: ${msg}`);
    trackPushTokenSkipped({ reason: 'mutation_error', error: msg });
  }
}

/**
 * Clear the local token cache on sign-out so the next driver who signs
 * in on the same device will register their token on first tracking
 * start (cache miss → fresh registration).
 *
 * Does NOT call the server's clearPushToken — that's scoped to
 * invalid-token responses from FCM and would wipe the token off an
 * active session mid-shift.
 */
export async function clearCachedPushToken(reason: string): Promise<void> {
  try {
    await SecureStore.deleteItemAsync(SECURE_KEY);
  } catch {
    // If the entry doesn't exist, delete throws on some SDK versions.
    // Treat as success.
  }
  trackPushTokenCleared({ reason });
  lg.debug(`Cleared cached push token (reason=${reason})`);
}
