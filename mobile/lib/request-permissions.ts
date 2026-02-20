import { Platform } from 'react-native';
import { useEffect, useRef } from 'react';
import * as Location from 'expo-location';
import { Camera } from 'expo-camera';
import * as Notifications from 'expo-notifications';
import * as ImagePicker from 'expo-image-picker';
import AsyncStorage from '@react-native-async-storage/async-storage';

const PERMISSIONS_REQUESTED_KEY = '@permissions_requested_v1';

async function requestAllPermissions() {
  const already = await AsyncStorage.getItem(PERMISSIONS_REQUESTED_KEY);
  if (already) return;

  // 1. Camera
  await Camera.requestCameraPermissionsAsync();

  // 2. Microphone (needed for video/voice features)
  await Camera.requestMicrophonePermissionsAsync();

  // 3. Foreground location first (required before background on both platforms)
  const { status: fgStatus } = await Location.requestForegroundPermissionsAsync();

  // 4. Background location (only ask if foreground was granted)
  if (fgStatus === 'granted') {
    await Location.requestBackgroundPermissionsAsync();
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

  await AsyncStorage.setItem(PERMISSIONS_REQUESTED_KEY, Date.now().toString());
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
