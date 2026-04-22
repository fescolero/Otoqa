/**
 * useRegisterPushToken — fire-and-forget hook that registers the
 * driver's Expo push token with Convex once per authenticated session.
 *
 * Strategy:
 *   1. On mount (once the driverId is known), request notification
 *      permission. If already granted, the call is a no-op.
 *   2. If granted, fetch an Expo push token. Expo requires a
 *      `projectId` — we read it from expo-constants, which falls back
 *      to `app.json`'s EAS projectId.
 *   3. Call the Convex `registerDriverPushToken` mutation. Results are
 *      upserted on the server side so re-registration is cheap.
 *
 * Silent on failure: permissions are user-controlled, and push is
 * supplementary. Any problem logs to PostHog + console and doesn't
 * surface to the driver — Permissions screen is the right place for
 * manual intervention.
 *
 * Expo Go caveat: the native push token API requires a development
 * build (or production) for remote pushes. In Expo Go we no-op and
 * log so local dev doesn't spam permission prompts.
 */
import { useEffect, useRef } from 'react';
import { Platform } from 'react-native';
import { useMutation } from 'convex/react';
import { usePostHog } from 'posthog-react-native';
import * as Notifications from 'expo-notifications';
import * as Application from 'expo-application';
import Constants, { ExecutionEnvironment } from 'expo-constants';
import { api } from '../../../convex/_generated/api';
import type { Id } from '../../../convex/_generated/dataModel';

export function useRegisterPushToken(driverId: Id<'drivers'> | null | undefined) {
  const registerToken = useMutation(api.driverMobile.registerDriverPushToken);
  const posthog = usePostHog();
  // Guard so we only run the registration flow once per mount-with-driver.
  // Tokens change rarely; useEffect dependency on driverId already covers
  // the "driver signed into a new account" case.
  const didRun = useRef(false);

  useEffect(() => {
    if (!driverId) return;
    if (didRun.current) return;
    didRun.current = true;

    let cancelled = false;
    (async () => {
      // Expo Go doesn't support remote push tokens reliably — skip to
      // avoid confusing logs in dev. Development + production builds
      // (EAS) have the native module.
      if (Constants.executionEnvironment === ExecutionEnvironment.StoreClient) {
        posthog?.capture('push_token_skipped', { reason: 'expo_go' });
        return;
      }

      try {
        // Check first — requesting when already granted is a no-op but
        // it avoids surfacing a prompt on every cold start.
        const current = await Notifications.getPermissionsAsync();
        let granted = current.granted;

        if (!granted) {
          const req = await Notifications.requestPermissionsAsync({
            ios: { allowAlert: true, allowBadge: true, allowSound: true },
          });
          granted =
            req.status === 'granted' ||
            (Platform.OS === 'ios' &&
              (req.ios?.status === Notifications.IosAuthorizationStatus.AUTHORIZED ||
                req.ios?.status === Notifications.IosAuthorizationStatus.PROVISIONAL));
        }

        if (!granted) {
          posthog?.capture('push_token_denied');
          return;
        }

        // projectId is required by expo-notifications SDK 49+. It comes
        // from the EAS project linkage in app.json. If missing, punt —
        // we can't fetch a valid token without it.
        const projectId =
          Constants.expoConfig?.extra?.eas?.projectId ??
          (Constants as unknown as { easConfig?: { projectId?: string } })
            .easConfig?.projectId;
        if (!projectId) {
          posthog?.capture('push_token_missing_project_id');
          return;
        }

        const tokenResponse = await Notifications.getExpoPushTokenAsync({ projectId });
        if (cancelled) return;
        const token = tokenResponse.data;
        if (!token) {
          posthog?.capture('push_token_empty');
          return;
        }

        const result = await registerToken({
          driverId,
          token,
          platform: Platform.OS === 'ios' ? 'ios' : 'android',
          deviceId: Application.getAndroidId?.() ?? undefined,
          appVersion: Application.nativeApplicationVersion ?? undefined,
        });
        if (cancelled) return;

        posthog?.capture('push_token_registered', {
          created: result.created,
          platform: Platform.OS,
        });
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        console.warn('[useRegisterPushToken]', msg);
        posthog?.capture('push_token_failed', { error: msg });
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [driverId, registerToken, posthog]);
}
