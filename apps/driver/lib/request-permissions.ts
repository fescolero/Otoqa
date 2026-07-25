import { Alert, Platform, PermissionsAndroid } from 'react-native';
import { useEffect, useRef } from 'react';
import * as Location from 'expo-location';
import { Camera } from 'expo-camera';
import * as Notifications from 'expo-notifications';
import * as ImagePicker from 'expo-image-picker';
import AsyncStorage from '@react-native-async-storage/async-storage';

const PERMISSIONS_REQUESTED_KEY = '@permissions_requested_v1';

/**
 * Show a user-visible explanation BEFORE the OS background-location prompt.
 *
 * Android 14+ requires apps that request `ACCESS_BACKGROUND_LOCATION` to show
 * a rationale that explains why background location is needed. The system
 * dialog after this point lets the user choose "Allow all the time" — without
 * a rationale Android may auto-deny or strip the permission later.
 *
 * On iOS the system handles the explanation via `NSLocationAlwaysAnd-
 * WhenInUseUsageDescription` in the plist, so we skip the in-app rationale.
 */
async function explainBackgroundLocationThenAsk(): Promise<Location.LocationPermissionResponse | null> {
  if (Platform.OS === 'android') {
    await new Promise<void>((resolve) => {
      Alert.alert(
        'Allow Location In Background',
        "Otoqa records your route during your shift to share progress with your dispatcher and customers. We only collect GPS while a shift is active — never when you're off shift.\n\nOn the next screen, tap 'Allow all the time' to enable shift tracking.",
        [{ text: 'Continue', onPress: () => resolve() }],
        { cancelable: false },
      );
    });
  }
  return await Location.requestBackgroundPermissionsAsync();
}

async function requestAllPermissions() {
  const already = await AsyncStorage.getItem(PERMISSIONS_REQUESTED_KEY);
  if (already) return;

  // 1. Camera
  await Camera.requestCameraPermissionsAsync();

  // 2. Microphone (needed for video/voice features)
  await Camera.requestMicrophonePermissionsAsync();

  // 3. Foreground location first (required before background on both platforms)
  const { status: fgStatus } = await Location.requestForegroundPermissionsAsync();

  // 4. Background location with Android 14+ rationale screen.
  if (fgStatus === 'granted') {
    await explainBackgroundLocationThenAsk();
  }

  // 5. Push notifications
  if (Platform.OS === 'android') {
    await Notifications.setNotificationChannelAsync('default', {
      name: 'Default',
      importance: Notifications.AndroidImportance.MAX,
    });
  }
  await Notifications.requestPermissionsAsync();

  // 6. Photo library
  await ImagePicker.requestMediaLibraryPermissionsAsync();

  // NOTE: ACTIVITY_RECOGNITION is NOT requested here. It has its own
  // hook (useRequestActivityRecognitionOnce below) because users who
  // signed in before Phase 1d shipped already have the
  // PERMISSIONS_REQUESTED_KEY set, which would short-circuit this
  // whole function before the AR request could fire. Bumping the key
  // to _v2 would re-prompt camera/mic/location for every existing
  // user — overkill for adding one permission. A dedicated hook
  // with its own gate (or better: a runtime `check()` call) handles
  // the upgrade path cleanly.

  await AsyncStorage.setItem(PERMISSIONS_REQUESTED_KEY, Date.now().toString());
}

/**
 * Re-request the background location permission with a rationale. Called
 * from the Start Shift / location-tracking flows when GPS init fails because
 * the user previously denied background access. Returns the latest grant
 * status so callers can react accordingly.
 */
export async function ensureBackgroundLocation(): Promise<Location.PermissionStatus> {
  // Foreground first — the OS won't grant background without it.
  const { status: fgStatus } = await Location.getForegroundPermissionsAsync();
  if (fgStatus !== 'granted') {
    const fg = await Location.requestForegroundPermissionsAsync();
    if (fg.status !== 'granted') return fg.status;
  }
  const { status: bgStatus } = await Location.getBackgroundPermissionsAsync();
  if (bgStatus === 'granted') return bgStatus;
  const result = await explainBackgroundLocationThenAsk();
  return result?.status ?? bgStatus;
}

/**
 * Requests all app permissions once after the user signs in.
 * Subsequent app launches skip the prompts since the OS remembers the user's choice.
 */
export function useRequestPermissionsOnce() {
  const requested = useRef(false);

  useEffect(() => {
    if (requested.current) return;
    requested.current = true;
    requestAllPermissions().catch((e) =>
      console.log('Permission request error:', e)
    );
  }, []);
}

/**
 * Phase 1d — request Google Play Services `ACTIVITY_RECOGNITION` runtime
 * permission on Android 10+. Separate hook (not folded into
 * `requestAllPermissions`) because the upgrade path matters: existing
 * drivers already have `@permissions_requested_v1` set, which would
 * short-circuit the broader permission loop and skip this. Using
 * `PermissionsAndroid.check()` as the gate — no storage key — because
 * the OS is already the source of truth for "did the user answer
 * yes/no." If they denied with "don't ask again," `request()` returns
 * `never_ask_again` without re-prompting.
 *
 * On denial: `motion-service.ts` stays inert (registerTransitions
 * throws at the native layer) and FCM wake (PR 1b) remains the
 * primary dead-FGS recovery path. No in-app UI consequence; we'd
 * surface a rationale banner in a follow-up PR if canary data shows
 * denial rates matter.
 */
export function useRequestActivityRecognitionOnce() {
  const requested = useRef(false);

  useEffect(() => {
    if (requested.current) return;
    requested.current = true;
    (async () => {
      if (Platform.OS !== 'android') return;
      if (Platform.Version < 29) return; // pre-Q: install-time permission
      try {
        const already = await PermissionsAndroid.check(
          PermissionsAndroid.PERMISSIONS.ACTIVITY_RECOGNITION,
        );
        if (already) return;
        await PermissionsAndroid.request(
          PermissionsAndroid.PERMISSIONS.ACTIVITY_RECOGNITION,
        );
      } catch (err) {
        console.log('ACTIVITY_RECOGNITION request error:', err);
      }
    })();
  }, []);
}
