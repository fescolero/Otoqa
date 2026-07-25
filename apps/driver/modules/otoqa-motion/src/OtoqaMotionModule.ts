import { NativeModule, requireOptionalNativeModule } from 'expo';
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

// expo-module.config.json declares `platforms: ['android']`, so on iOS
// (+ web, + any other platform) the native side isn't registered.
// `requireOptionalNativeModule` returns null on those platforms
// instead of throwing at module-eval — which is what would crash the
// iOS app the moment anyone imported `otoqa-motion` (via
// `motion-service.ts` → `(app)/_layout.tsx` → entire app).
//
// The Platform.OS === 'android' guard in motion-service.ts is the
// authoritative runtime gate; this Proxy stub is belt-and-suspenders
// so any errant caller gets a clear error rather than a cryptic
// `Cannot read property 'registerTransitions' of null`.
const nativeModule = requireOptionalNativeModule<OtoqaMotionModule>('OtoqaMotion');

const stub = new Proxy({} as OtoqaMotionModule, {
  get(_target, prop) {
    // `then` is accessed by the Promise machinery when something
    // attempts to `await` the whole module. Returning undefined here
    // prevents an accidental "this module is thenable" false positive.
    if (prop === 'then') return undefined;
    throw new Error(
      `OtoqaMotion native module is Android-only — call to '${String(prop)}' ` +
        `reached the iOS/web stub. Guard with Platform.OS === 'android' at the caller.`,
    );
  },
});

export default (nativeModule ?? stub) as OtoqaMotionModule;
