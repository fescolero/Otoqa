import posthog from 'posthog-js';

export const POSTHOG_KEY = process.env.NEXT_PUBLIC_POSTHOG_KEY;

export function identifyUser(user: {
  id: string;
  email: string;
  name: string;
  organizationId: string;
  orgName?: string;
}) {
  if (typeof window === 'undefined' || !POSTHOG_KEY) return;

  posthog.identify(user.id, {
    email: user.email,
    name: user.name,
    organization_id: user.organizationId,
    org_name: user.orgName,
    platform: 'web',
  });

  posthog.group('organization', user.organizationId, {
    name: user.orgName,
  });
}

export function trackError(
  source: string,
  error: unknown,
  extra?: Record<string, unknown>,
) {
  if (typeof window === 'undefined' || !POSTHOG_KEY) return;

  const message =
    error instanceof Error ? error.message : String(error);
  const stack =
    error instanceof Error ? error.stack : undefined;

  posthog.capture('web_error', {
    source,
    error: message,
    stack,
    ...extra,
  });
}

export { posthog };
