/**
 * Dispatch push registration (§5.7) — asks for notification permission
 * once the session is live, fetches the Expo push token, and upserts it
 * via dispatchMobile.registerPushToken. No-ops gracefully in simulators,
 * on permission denial, and before `eas init` stamps a projectId.
 */
import * as React from 'react';
import { Platform } from 'react-native';
import * as Notifications from 'expo-notifications';
import * as Device from 'expo-device';
import Constants from 'expo-constants';
import { useMutation } from 'convex/react';
import { api } from '@otoqa/convex-client';

export function usePushRegistration(enabled: boolean) {
  const register = useMutation(api.dispatchMobile.registerPushToken);
  const ran = React.useRef(false);

  React.useEffect(() => {
    if (!enabled || ran.current) return;
    ran.current = true;
    void (async () => {
      try {
        if (!Device.isDevice) return; // simulators have no push tokens
        const projectId =
          Constants.expoConfig?.extra?.eas?.projectId ?? Constants.easConfig?.projectId;
        if (!projectId) return; // pre-`eas init` builds: skip silently
        const current = await Notifications.getPermissionsAsync();
        const granted = current.granted
          ? true
          : (await Notifications.requestPermissionsAsync()).granted;
        if (!granted) return;
        if (Platform.OS === 'android') {
          await Notifications.setNotificationChannelAsync('default', {
            name: 'Dispatch alerts',
            importance: Notifications.AndroidImportance.HIGH,
          });
        }
        const { data: token } = await Notifications.getExpoPushTokenAsync({ projectId });
        await register({ token, platform: Platform.OS === 'ios' ? 'ios' : 'android' });
      } catch (e) {
        console.warn('[push] registration skipped:', e);
      }
    })();
  }, [enabled, register]);
}
