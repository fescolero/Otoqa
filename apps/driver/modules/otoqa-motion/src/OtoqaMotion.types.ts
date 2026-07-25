export type ActivityType = 'IN_VEHICLE' | 'STILL';
export type TransitionType = 'ENTER' | 'EXIT';

/**
 * Payload emitted by the `onActivityTransition` event. `mock: true`
 * marks synthetic events injected via `fakeTransition` for Maestro /
 * simulator workflows — JS consumers should pass it through as a
 * property on the `activity_recognition_transition` analytics event
 * so canary dashboards can filter real vs. synthetic.
 */
export type ActivityTransitionEvent = {
  activityType: ActivityType | string;
  transition: TransitionType | string;
  elapsedRealtimeNanos: number;
  timestamp: number;
  mock: boolean;
};

export type OtoqaMotionEvents = {
  onActivityTransition: (event: ActivityTransitionEvent) => void;
};
