import { requireOptionalNativeModule } from 'expo-modules-core';

/**
 * Native binding for the lock-screen shift surface. Resolved OPTIONALLY:
 * dev clients / release binaries built before this module shipped (and
 * Expo Go) return null here, and the wrappers in index.ts degrade to
 * no-ops. This matters because JS updates via expo-updates can land on
 * binaries that predate the native code — never hard-require it.
 */
interface OtoqaShiftStatusNativeModule {
  startShiftStatus(startedAtMs: number, statusLine: string): Promise<boolean>;
  updateShiftStatus(statusLine: string): Promise<boolean>;
  endShiftStatus(): Promise<boolean>;
}

export default requireOptionalNativeModule<OtoqaShiftStatusNativeModule>('OtoqaShiftStatus');
