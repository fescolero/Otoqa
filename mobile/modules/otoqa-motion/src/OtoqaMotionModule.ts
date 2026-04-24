import { NativeModule, requireNativeModule } from 'expo';
import type { OtoqaMotionEvents } from './OtoqaMotion.types';

declare class OtoqaMotionModule extends NativeModule<OtoqaMotionEvents> {
  /**
   * Subscribe to STILL ↔ IN_VEHICLE ActivityTransitions via Google
   * Play Services. Requires `ACTIVITY_RECOGNITION` runtime permission
   * on Android 10+. Idempotent — safe to call when already registered.
   *
   * Returns `true` on success; throws on permission denial or Play
   * Services unavailability.
   */
  registerTransitions(): Promise<boolean>;

  /**
   * Tear down the ActivityRecognition subscription and the in-process
   * BroadcastReceiver. Idempotent.
   */
  unregisterTransitions(): Promise<boolean>;

  /**
   * Dev-only: inject a synthetic transition event into the emitter.
   * Gated at the JS layer behind EXPO_PUBLIC_MOTION_MOCK=1 so release
   * builds never call this even if a developer forgets to strip a
   * dev-only code path.
   *
   * @param activity   'IN_VEHICLE' | 'STILL'
   * @param transition 'ENTER' | 'EXIT'
   */
  fakeTransition(activity: string, transition: string): Promise<void>;
}

// Name must match the `Name("OtoqaMotion")` in the Kotlin module
// definition. expo-modules autolinking resolves this at native-bridge
// attach time.
export default requireNativeModule<OtoqaMotionModule>('OtoqaMotion');
