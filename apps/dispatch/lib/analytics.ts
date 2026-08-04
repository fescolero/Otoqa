/**
 * PostHog wiring (plan D17/D18) — deliberately lean vs the driver app's
 * module: the dispatch app has no background tasks, offline queue, or
 * GPS, so one foreground client + a pre-init buffer covers everything.
 *
 * Every event carries the `app: 'dispatch'` super-property (D18) so the
 * shared PostHog project separates the two apps, plus the OTA bundle
 * context that made the driver app's delivery mysteries debuggable.
 */
import type PostHog from 'posthog-react-native';
import type { PostHogEventProperties } from '@posthog/core';

// Lazy require — same OTA-safety rule as the other native-adjacent modules.
/* eslint-disable @typescript-eslint/no-var-requires */
let Updates: {
  updateId: string | null;
  createdAt: Date | null;
  channel: string | null;
  runtimeVersion: string | null;
  isEmbeddedLaunch: boolean;
} | null = null;
try {
  Updates = require('expo-updates');
} catch {
  Updates = null;
}
/* eslint-enable @typescript-eslint/no-var-requires */

let client: PostHog | null = null;
let buffer: Array<{ event: string; properties?: PostHogEventProperties }> = [];

export function getAppVersionContext(): Record<string, string | null> {
  return {
    ota_update_id: Updates?.updateId ?? null,
    ota_created_at: Updates?.createdAt?.toISOString?.() ?? null,
    ota_channel: Updates?.channel ?? null,
    ota_runtime_version: Updates?.runtimeVersion ?? null,
    ota_is_embedded: Updates ? (Updates.isEmbeddedLaunch ? 'true' : 'false') : null,
  };
}

export function setPostHogClient(c: PostHog) {
  client = c;
  c.register({ app: 'dispatch', ...getAppVersionContext() });
  for (const { event, properties } of buffer) c.capture(event, properties);
  buffer = [];
}

function capture(event: string, properties?: PostHogEventProperties) {
  if (client) client.capture(event, properties);
  else buffer.push({ event, properties });
}

/** Org + persona context once the session resolves. The distinct id stays
 *  the device-scoped anonymous id — getSession exposes no stable user id,
 *  and ops telemetry groups by org anyway. */
export function attachSessionContext(s: {
  provider: string | null;
  orgExternalId: string | null;
  orgName: string | null;
  persona: string | null;
}) {
  client?.register({
    persona: s.persona ?? null,
    auth_provider: s.provider ?? null,
    organization_id: s.orgExternalId ?? null,
  });
  if (s.orgExternalId) {
    client?.group('organization', s.orgExternalId, s.orgName ? { name: s.orgName } : undefined);
  }
}

export function resetAnalytics() {
  client?.reset();
}

export function trackScreen(pathname: string) {
  capture('screen_viewed', { screen_name: pathname });
}

/** Product actions — one event name, `action` distinguishes. */
export function trackAction(action: string, properties?: PostHogEventProperties) {
  capture('dispatch_action', { action, ...properties });
}

/** D17 error tracking: render crashes and uncaught JS errors. */
export function trackError(
  kind: 'error_boundary' | 'js_uncaught',
  error: string,
  extra?: PostHogEventProperties,
) {
  capture('app_error', { kind, error, ...extra, ...getAppVersionContext() });
  void client?.flush().catch(() => undefined);
}

/** Wrap the RN global handler so fatal JS errors reach PostHog before the
 *  crash (this is exactly the visibility the OTA rollback saga lacked). */
export function installGlobalErrorTracking() {
  const g = globalThis as unknown as {
    ErrorUtils?: {
      getGlobalHandler(): (error: unknown, isFatal?: boolean) => void;
      setGlobalHandler(h: (error: unknown, isFatal?: boolean) => void): void;
    };
  };
  const prev = g.ErrorUtils?.getGlobalHandler();
  g.ErrorUtils?.setGlobalHandler((error, isFatal) => {
    try {
      trackError('js_uncaught', error instanceof Error ? error.message : String(error), {
        fatal: !!isFatal,
        stack: error instanceof Error ? (error.stack ?? null) : null,
      });
    } catch {
      // Telemetry must never mask the original error.
    }
    prev?.(error, isFatal);
  });
}
