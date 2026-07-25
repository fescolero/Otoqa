/**
 * usePermissionGates — fires the once-per-install permission prompts.
 *
 * Composes:
 *   • useRequestPermissionsOnce — camera, location (foreground +
 *     background), notifications. Gated by a storage key so we don't
 *     re-prompt on every app open.
 *   • useRequestActivityRecognitionOnce — Phase 1d ACTIVITY_RECOGNITION
 *     (Android 10+). Separate hook so existing drivers (who already have
 *     PERMISSIONS_REQUESTED_KEY set from pre-1d) get prompted on their
 *     next app open. Uses OS-level `check()` as the gate — no storage
 *     key — so it's a no-op once granted or permanently denied.
 *
 * Both hooks are inert until Clerk reports a signed-in user; safe to
 * call unconditionally from any layout that sits below the auth gate.
 */
import {
  useRequestPermissionsOnce,
  useRequestActivityRecognitionOnce,
} from '../request-permissions';

export function usePermissionGates() {
  useRequestPermissionsOnce();
  useRequestActivityRecognitionOnce();
}
