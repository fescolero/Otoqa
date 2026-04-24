import PostHog from 'posthog-react-native';
import type { PostHogEventProperties } from '@posthog/core';
import * as Updates from 'expo-updates';
import * as Application from 'expo-application';

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

// ============================================
// OTA / APP VERSION HELPERS
// ============================================

/**
 * Returns OTA bundle and native app version info for inclusion in analytics.
 * This lets us determine exactly which JS bundle and native build a device is running.
 */
export function getAppVersionContext(): Record<string, string | null> {
  return {
    ota_update_id: Updates.updateId ?? null,
    ota_created_at: Updates.createdAt?.toISOString() ?? null,
    ota_channel: Updates.channel ?? null,
    ota_runtime_version: Updates.runtimeVersion ?? null,
    ota_is_embedded: Updates.isEmbeddedLaunch ? 'true' : 'false',
    native_version: Application.nativeApplicationVersion ?? null,
    native_build: Application.nativeBuildVersion ?? null,
  };
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
  capture('ota_update_check', { result, error: error ?? null, ...getAppVersionContext() });
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

export function trackPermissionRequest(permission: string, granted: boolean) {
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
  event:
    | 'setup_started'
    | 'setup_complete'
    | 'token_fetch_failed'
    | 'auth_timeout'
    | 'debouncing_false'
    | 'auth_false_propagated'
    | 'foreground_return',
  context?: PostHogEventProperties,
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

// ============================================
// OFFLINE / CONNECTIVITY TRACKING
// ============================================

export function trackConnectionQualityChange(
  quality: 'good' | 'poor' | 'offline',
  context?: { connectionType?: string | null; cellularGeneration?: string | null },
) {
  capture('connection_quality_changed', { quality, ...context });
}

export function trackOfflineQueueEnqueued(
  mutationType: string,
  context?: { connectionQuality?: string; stopId?: string; loadId?: string },
) {
  capture('offline_queue_enqueued', { mutation_type: mutationType, ...context });
}

export function trackOfflineQueueProcessed(context: {
  total: number;
  succeeded: number;
  failed: number;
  elapsed_ms: number;
}) {
  capture('offline_queue_processed', context);
}

export function trackOfflineQueueItemSynced(
  mutationType: string,
  context?: { retryCount?: number; queuedAgeMs?: number },
) {
  capture('offline_queue_item_synced', { mutation_type: mutationType, ...context });
}

export function trackOfflineQueueItemFailed(mutationType: string, context?: { retryCount?: number; error?: string }) {
  capture('offline_queue_item_failed', { mutation_type: mutationType, ...context });
}

// ============================================
// GPS TRACKING
// ============================================

export function trackGPSPrewarmComplete(context: {
  source: 'balanced' | 'high';
  accuracy_m: number | null;
  elapsed_ms: number;
}) {
  capture('gps_prewarm_complete', context);
}

export function trackGPSPrewarmFailed(error: string) {
  capture('gps_prewarm_failed', { error });
}

export function trackGPSFreshFixObtained(context: {
  source: 'prewarmed_high' | 'prewarmed_balanced' | 'fresh_balanced';
  accuracy_m: number | null;
  age_ms: number;
}) {
  capture('gps_fresh_fix_obtained', context);
}

export function trackGPSFreshFixTimeout(elapsed_ms: number) {
  capture('gps_fresh_fix_timeout', { elapsed_ms });
}

export function trackGPSHighAccuracyUpgrade(context: { accuracy_m: number | null; elapsed_since_balanced_ms: number }) {
  capture('gps_high_accuracy_upgrade', context);
}

export function trackGPSPermissionDenied() {
  capture('gps_permission_denied');
}

export function trackWatchLocationReceived(context: {
  accuracy_m: number | null;
  age_ms: number;
  speed_mps: number | null;
  heading_deg: number | null;
}) {
  capture('watch_location_received', context);
}

export function trackWatchLocationFiltered(context: {
  reason: 'inactive' | 'accuracy' | 'time_floor' | 'distance_time_gate';
  accuracy_m: number | null;
  age_ms: number;
  distance_m?: number | null;
  gap_ms?: number | null;
}) {
  capture('watch_location_filtered', context);
}

export function trackWatchLocationSaved(context: {
  reason: 'distance' | 'time' | 'heartbeat';
  accuracy_m: number | null;
  distance_m: number | null;
  gap_ms: number | null;
  used_fallback: boolean;
}) {
  capture('watch_location_saved', context);
}

export function trackWatchLocationError(context: { step: 'callback' | 'insert' | 'sync'; error: string }) {
  capture('watch_location_error', context);
}

// ============================================
// BACKGROUND LOCATION TASK DIAGNOSTICS
// ============================================

export function trackBGTaskFired(context: {
  locationCount: number;
  accuracies: string;
  ages: string;
  sqliteAvailable: boolean;
  trackingActive: boolean;
}) {
  capture('bg_task_fired', context);
}

export function trackBGTaskResult(context: {
  saved: number;
  total: number;
  rejectedAccuracy: number;
  rejectedDistance: number;
  rejectedStale: number;
  usedFallback: boolean;
  syncAttempted: boolean;
  syncSuccess?: boolean;
  syncCount?: number;
  durationMs: number;
}) {
  capture('bg_task_result', context);
}

export function trackBGTaskError(context: { step: string; error: string }) {
  capture('bg_task_error', context);
}

export function trackBGTaskReregistered(context: {
  source: 'foreground_return' | 'app_resume' | 'heartbeat';
  wasRegistered: boolean;
  success: boolean;
  error?: string;
}) {
  capture('bg_task_reregistered', { ...context, ...getAppVersionContext() });
}

export function trackForegroundResume(context: {
  bgTaskLastAliveAgoSec: number | null;
  fallbackRecovered: number;
  unsyncedCount: number;
  isExpoGo?: boolean;
  isPhysicalDevice?: boolean;
  platform?: string;
}) {
  capture('foreground_resume', { ...context, ...getAppVersionContext() });
}

// ============================================
// CHECK-IN/OUT OFFLINE FLOW TRACKING
// ============================================

export function trackCheckinOfflineQueued(context: {
  stopId: string;
  loadId?: string;
  connectionQuality: string;
  action: 'check_in' | 'check_out';
}) {
  capture('checkin_offline_queued', context);
}

export function trackCheckinMutationTimeout(context: {
  stopId: string;
  loadId?: string;
  action: 'check_in' | 'check_out';
  elapsed_ms: number;
}) {
  capture('checkin_mutation_timeout', context);
}

export function trackPendingActionRecorded(context: { stopId: string; loadId: string; action: 'in' | 'out' }) {
  capture('pending_action_recorded', context);
}

export function trackPendingActionReconciled(context: { stopId: string; loadId: string; action: 'in' | 'out' }) {
  capture('pending_action_reconciled', context);
}

// ============================================
// LOCATION QUEUE TELEMETRY
// Fires from mobile/lib/location-queue.ts (MMKV backend). Combined with
// the queue_backend super-property registered on setPostHogClient, every
// tracking event carries backend context for side-by-side MMKV-vs-SQLite
// comparison during canary.
// ============================================

export function trackLocationQueueOpFailed(context: {
  op: string;
  error: string;
  consecutiveFailures: number;
}) {
  capture('location_queue_op_failed', context);
}

export function trackLocationQueueAutoReset(context: {
  trigger: 'consecutive_failures' | 'interrupted_migration' | 'manual';
  op?: string;
}) {
  capture('location_queue_auto_reset', context);
}

export function trackLocationQueueEvicted(context: {
  reason: 'queue_full';
  queueSize: number;
}) {
  capture('location_queue_evicted', context);
}

export function trackLocationQueueMigrated(context: {
  sqliteRows: number;
  fallbackRows: number;
  sqliteReadable: boolean;
  fallbackReadable: boolean;
}) {
  capture('location_queue_migrated', context);
}

export function trackLocationQueueEncryptionMigrated(context: {
  pingsDrained: number;
  durationMs: number;
  resumed: boolean;
}) {
  capture('location_queue_encryption_migrated', context);
}

/**
 * Register the queue backend as a super-property so every subsequent event
 * (watch_location_saved, bg_task_result, etc.) carries `queue_backend` in
 * its properties. Filter by this in PostHog to compare MMKV-vs-SQLite
 * failure rates side-by-side during the canary.
 */
export function registerQueueBackend(backend: 'mmkv' | 'sqlite') {
  posthogClient?.register({ queue_backend: backend });
}

// ============================================
// PHASE 1C — PUSH TOKEN + FCM WAKE EVENTS
// ============================================

export function trackPushTokenRegistered(context: {
  platform: 'ios' | 'android';
  rotated: boolean;
}) {
  capture('push_token_registered', context);
}

export function trackPushTokenSkipped(context: {
  reason: string;
  server_reason?: string;
  error?: string;
}) {
  capture('push_token_skipped', context);
}

export function trackPushTokenCleared(context: { reason: string }) {
  capture('push_token_cleared', context);
}

export function trackFcmWakeReceived(context: {
  type: string;
  sessionId: string;
  deliveryPath: 'foreground' | 'background';
}) {
  capture('fcm_wake_received', context);
}

export function trackFcmWakeIgnored(context: {
  reason: string;
  detail?: string;
  error?: string;
}) {
  capture('fcm_wake_ignored', context);
}

export function trackFcmWakeSessionInactive(context: {
  payloadSessionId: string;
  currentSessionId: string | null;
}) {
  capture('fcm_wake_session_inactive', context);
}

export function trackFcmWakeResumeSuccess(context: {
  pingCaptured: boolean;
  preFlushQueueSize: number;
}) {
  capture('fcm_wake_resume_success', context);
}

function maskPhone(phone: string): string {
  if (phone.length <= 4) return '****';
  return phone.slice(0, -4).replace(/\d/g, '*') + phone.slice(-4);
}
