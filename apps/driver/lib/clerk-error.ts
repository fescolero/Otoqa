/**
 * Clerk error shape helpers for the Core 3 sign-in flow.
 *
 * Core 3 changed how the custom-flow methods report failure in two ways:
 *
 * 1. Shape. Core 2 threw an object carrying an `errors` array, so call sites
 *    read `error.errors[0].code`. Core 3's `ClerkError` is a flat `Error`
 *    subclass with `code` / `message` / `longMessage` directly on it.
 *
 * 2. Channel. The `signIn.phoneCode.*` methods RETURN `{ error }` rather than
 *    throwing. They can still throw for anything outside Clerk's own error
 *    handling (a dropped connection mid-request, for instance), so call sites
 *    have to handle both.
 *
 * These read defensively across both shapes rather than assuming the new one.
 * The `code` values themselves (`form_identifier_not_found` and friends) are
 * unchanged between cores, so the branching that consumes them still holds.
 */

type UnknownClerkError = {
  code?: unknown;
  message?: unknown;
  longMessage?: unknown;
  errors?: Array<{ code?: unknown; message?: unknown; longMessage?: unknown }>;
};

function asString(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

/** Machine-stable Clerk error code, e.g. `form_identifier_not_found`. */
export function clerkErrorCode(error: unknown): string | undefined {
  if (!error || typeof error !== 'object') return undefined;
  const e = error as UnknownClerkError;
  return asString(e.code) ?? asString(e.errors?.[0]?.code);
}

/**
 * Human-readable text for an alert. Prefers `longMessage`, which Clerk
 * documents as the user-facing string; `message` is developer-facing and
 * explicitly not guaranteed to be stable.
 */
export function clerkErrorMessage(error: unknown): string | undefined {
  if (!error || typeof error !== 'object') return undefined;
  const e = error as UnknownClerkError;
  return (
    asString(e.longMessage) ??
    asString(e.errors?.[0]?.longMessage) ??
    asString(e.message) ??
    asString(e.errors?.[0]?.message)
  );
}
