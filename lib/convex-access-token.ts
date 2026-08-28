/**
 * Token-fetch policy for `ConvexProviderWithAuth`.
 *
 * Split out from `components/ConvexClientProvider.tsx` so the policy is pure
 * (its two token sources are injected) and can be tested without mounting
 * AuthKit or a Convex client.
 *
 * ── Why the return value matters more than it looks ──────────────────────
 *
 * Convex treats a `null` from `fetchAccessToken` as "this caller has no
 * identity". In `authentication_manager`, both the scheduled `refetchToken()`
 * and the reactive `tryToReauthenticate()` respond to a falsy token by
 * calling `clearAuth()` and reporting auth failed — which drops the token
 * from the websocket session and re-runs *every mounted subscription* with no
 * identity. Each of those queries then throws `ConvexError('Unauthenticated')`
 * server-side, in the same millisecond.
 *
 * So `null` must mean "signed out" and nothing else. In particular it must
 * not mean "the token endpoint was briefly unreachable" — that turns a
 * network blip into a page-wide auth teardown.
 *
 * Note that throwing is not an alternative: Convex does not wrap the
 * `fetchToken` call in a try/catch, so an exception escapes as an unhandled
 * rejection and leaves the socket paused. The policy has to resolve.
 */

export interface AccessTokenSources {
  /**
   * Force a server round-trip for a new token. AuthKit's `refresh()`.
   * Rejects (or resolves undefined) when the refresh cannot be completed.
   */
  refresh: () => Promise<string | undefined>;
  /**
   * Return a usable token, refreshing only if the cached one is at or past
   * AuthKit's expiry buffer. AuthKit's `getAccessToken()`.
   *
   * Critically, AuthKit *keeps* the previous token in its store when a
   * refresh throws ("Don't clear the token immediately - keep the stale one
   * while retrying"), so this still returns the last good token as long as
   * that token has not entered the expiry buffer.
   */
  getAccessToken: () => Promise<string | undefined>;
}

export interface FetchConvexAccessTokenOptions extends AccessTokenSources {
  /** Whether AuthKit currently has a signed-in user. */
  hasUser: boolean;
  /** Convex asks for a forced refresh on its scheduled pre-expiry refetch. */
  forceRefreshToken?: boolean;
  /** Attempts *after* the first, i.e. 3 means up to 4 calls. */
  maxRetries?: number;
  /** Injected so tests don't wait on real backoff. */
  sleep?: (ms: number) => Promise<void>;
}

const DEFAULT_MAX_RETRIES = 3;

const defaultSleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/**
 * Resolve an access token for the Convex client, or `null` if — and only if —
 * there is genuinely no identity to offer.
 */
export async function fetchConvexAccessToken({
  hasUser,
  forceRefreshToken,
  refresh,
  getAccessToken,
  maxRetries = DEFAULT_MAX_RETRIES,
  sleep = defaultSleep,
}: FetchConvexAccessTokenOptions): Promise<string | null> {
  // The one legitimate `null`: nobody is signed in.
  if (!hasUser) return null;

  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      const token = forceRefreshToken
        ? ((await refresh()) ?? null)
        : ((await getAccessToken()) ?? null);

      if (token) return token;
    } catch {
      // Transient failure — fall through to retry.
    }

    if (attempt < maxRetries) {
      await sleep(100 * (attempt + 1));
    }
  }

  // Every forced refresh failed but the user is still signed in. Convex
  // schedules this refetch *ahead* of expiry, so the cached token is normally
  // still valid for minutes; handing it back keeps the session alive through
  // the blip instead of tearing down every live query. `getAccessToken()`
  // only returns it while it is outside the expiry buffer, so this can never
  // hand Convex a token AuthKit already considers expired.
  //
  // Non-forced attempts already went through `getAccessToken()` above, so
  // there is nothing further to try on that path.
  if (forceRefreshToken) {
    try {
      const cached = (await getAccessToken()) ?? null;
      if (cached) return cached;
    } catch {
      // The cached token is inside the expiry buffer too and could not be
      // renewed — there is genuinely no usable identity left.
    }
  }

  return null;
}
