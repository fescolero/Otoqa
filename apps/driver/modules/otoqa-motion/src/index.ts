import { EventSubscription } from 'expo-modules-core';
import OtoqaMotionModule from './OtoqaMotionModule';
import type {
  ActivityTransitionEvent,
  ActivityType,
  TransitionType,
} from './OtoqaMotion.types';

export type { ActivityTransitionEvent, ActivityType, TransitionType };

export async function registerTransitions(): Promise<boolean> {
  return OtoqaMotionModule.registerTransitions();
}

export async function unregisterTransitions(): Promise<boolean> {
  return OtoqaMotionModule.unregisterTransitions();
}

/**
 * Subscribe to transition events emitted by the native module. Returns
 * an EventSubscription whose `remove()` method tears down the listener.
 */
export function addTransitionListener(
  listener: (event: ActivityTransitionEvent) => void,
): EventSubscription {
  return OtoqaMotionModule.addListener('onActivityTransition', listener);
}

/**
 * Dev-only synthetic transition injector. Gated here — will throw (or
 * silently no-op, depending on how EXPO_PUBLIC_MOTION_MOCK is set) in
 * release builds so accidental calls can't ship motion noise to the
 * canary dashboards.
 */
export async function fakeTransition(
  activity: ActivityType,
  transition: TransitionType,
): Promise<void> {
  if (process.env.EXPO_PUBLIC_MOTION_MOCK !== '1') {
    throw new Error(
      'fakeTransition is gated behind EXPO_PUBLIC_MOTION_MOCK=1 (release builds must not call this)',
    );
  }
  return OtoqaMotionModule.fakeTransition(activity, transition);
}
