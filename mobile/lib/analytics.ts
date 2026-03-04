import PostHog from 'posthog-react-native';
import type { PostHogEventProperties } from '@posthog/core';

let posthogClient: PostHog | null = null;

// Buffer events that fire before PostHog is initialized (e.g. auth setup
// events that race with the PostHogProvider useEffect).
let eventBuffer: Array<{ event: string; properties?: PostHogEventProperties }> = [];

export function setPostHogClient(client: PostHog) {
  posthogClient = client;
  for (const { event, properties } of eventBuffer) {
    client.capture(event, properties);
  }
  eventBuffer = [];
}

function capture(event: string, properties?: PostHogEventProperties) {
  if (posthogClient) {
    posthogClient.capture(event, properties);
  } else {
    eventBuffer.push({ event, properties });
  }
}

export function identifyUser(user: {
  id: string;
  phone?: string;
  name?: string;
  organizationId?: string;
  role: 'driver' | 'owner' | 'both';
}) {
  posthogClient?.identify(user.id, {
    phone: user.phone ?? null,
    name: user.name ?? null,
    organization_id: user.organizationId ?? null,
    role: user.role,
    platform: 'mobile',
  });

  if (user.organizationId) {
    posthogClient?.group('organization', user.organizationId);
  }
}

export function resetUser() {
  posthogClient?.reset();
}

export function trackScreen(name: string, properties?: PostHogEventProperties) {
  capture('screen_viewed', { screen_name: name, ...properties });
}

export function trackSignInStarted(phone: string) {
  capture('sign_in_started', { phone_masked: maskPhone(phone) });
}

export function trackSignInCodeSent(phone: string) {
  capture('sign_in_code_sent', { phone_masked: maskPhone(phone) });
}

export function trackSignInFailed(phone: string, errorCode?: string, errorMessage?: string) {
  capture('sign_in_failed', {
    phone_masked: maskPhone(phone),
    error_code: errorCode ?? null,
    error_message: errorMessage ?? null,
  });
}

export function trackVerificationStarted() {
  capture('verification_started');
}

export function trackVerificationSuccess() {
  capture('verification_success');
}

export function trackVerificationFailed(errorCode?: string, errorMessage?: string) {
  capture('verification_failed', {
    error_code: errorCode ?? null,
    error_message: errorMessage ?? null,
  });
}

export function trackResendCode(success: boolean) {
  capture('verification_resend_code', { success });
}

export function trackRoleSelected(role: 'driver' | 'owner') {
  capture('role_selected', { role });
}

export function trackPhotoCapture(success: boolean, loadId?: string, error?: string) {
  capture('photo_capture', { success, load_id: loadId ?? null, error: error ?? null });
}

export function trackPhotoSaved(loadId?: string) {
  capture('photo_saved', { load_id: loadId ?? null });
}

export function trackPhotoSaveFailed(loadId?: string, error?: string) {
  capture('photo_save_failed', { load_id: loadId ?? null, error: error ?? null });
}

export function trackOtaUpdateCheck(result: 'available' | 'none' | 'error', error?: string) {
  capture('ota_update_check', { result, error: error ?? null });
}

export function trackWeatherFetchFailed(error: string) {
  capture('weather_fetch_failed', { error });
}

export function trackErrorBoundary(error: string, componentStack?: string) {
  capture('error_boundary_crash', {
    error,
    component_stack: componentStack ?? null,
  });
}

export function trackPermissionRequest(
  permission: string,
  granted: boolean,
) {
  capture('permission_request', { permission, granted });
}

// ============================================
// PERFORMANCE & RELIABILITY TRACKING
// ============================================

export type LoadingGate =
  | 'clerk_load'
  | 'convex_auth'
  | 'user_roles'
  | 'driver_profile'
  | 'carrier_org'
  | 'sign_in_request'
  | 'verification_request';

export function trackLoadingGateTimeout(gate: LoadingGate, elapsedMs: number, context?: Record<string, unknown>) {
  capture('loading_gate_timeout', {
    gate,
    elapsed_ms: elapsedMs,
    ...context,
  });
}

export function trackLoadingGateResolved(gate: LoadingGate, elapsedMs: number, context?: Record<string, unknown>) {
  capture('loading_gate_resolved', {
    gate,
    elapsed_ms: elapsedMs,
    ...context,
  });
}

export function trackLoadingGateRetry(gate: LoadingGate, attemptNumber: number, context?: Record<string, unknown>) {
  capture('loading_gate_retry', {
    gate,
    attempt: attemptNumber,
    ...context,
  });
}

export function trackConvexAuthEvent(
  event: 'setup_started' | 'setup_complete' | 'token_fetch_failed' | 'auth_timeout' | 'debouncing_false' | 'auth_false_propagated' | 'foreground_return',
  context?: Record<string, unknown>,
) {
  capture(`convex_auth_${event}`, context);
}

export function trackAppSessionHealth(context: {
  gate_reached: LoadingGate;
  total_elapsed_ms: number;
  was_stuck: boolean;
  recovered: boolean;
}) {
  capture('app_session_health', context);
}

export function trackQueryAuthFailure(query: string, context?: Record<string, unknown>) {
  capture('query_auth_failure', {
    query,
    ...context,
  });
}

function maskPhone(phone: string): string {
  if (phone.length <= 4) return '****';
  return phone.slice(0, -4).replace(/\d/g, '*') + phone.slice(-4);
}
