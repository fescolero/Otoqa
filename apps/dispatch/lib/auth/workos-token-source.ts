/**
 * WorkOS AuthKit token source — hosted browser flow with PKCE, per the
 * official Expo integration (workos.com/docs/integrations/react-native-expo
 * and workos/expo-authkit-example). Access + refresh tokens live in
 * SecureStore; refresh happens on demand when Convex asks with
 * forceRefreshToken (mirrors the web adapter in
 * components/ConvexClientProvider.tsx).
 *
 * ⚠ Device-validation pending: this flow needs a real browser round-trip
 * (otoqa-dispatch://sso return) and a WorkOS client id with the redirect
 * allowlisted — neither exists in CI. Treat as scaffold until the Phase 1
 * auth matrix passes on device.
 */
import * as React from 'react';
import * as AuthSession from 'expo-auth-session';
import * as WebBrowser from 'expo-web-browser';
import * as SecureStore from 'expo-secure-store';
import type { TokenSource } from './token-source';

WebBrowser.maybeCompleteAuthSession();

const CLIENT_ID = process.env.EXPO_PUBLIC_WORKOS_CLIENT_ID ?? '';
const AUTHORIZE_URL = 'https://api.workos.com/user_management/authorize';
const AUTHENTICATE_URL = 'https://api.workos.com/user_management/authenticate';
const ACCESS_KEY = 'otoqa-dispatch-workos-access';
const REFRESH_KEY = 'otoqa-dispatch-workos-refresh';

export const workosRedirectUri = AuthSession.makeRedirectUri({
  scheme: 'otoqa-dispatch',
  path: 'sso',
});

async function authenticate(body: Record<string, string>): Promise<{
  access_token: string;
  refresh_token: string;
} | null> {
  const res = await fetch(AUTHENTICATE_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ client_id: CLIENT_ID, ...body }),
  });
  if (!res.ok) return null;
  return (await res.json()) as { access_token: string; refresh_token: string };
}

async function storeTokens(t: { access_token: string; refresh_token: string } | null) {
  if (!t) {
    await SecureStore.deleteItemAsync(ACCESS_KEY);
    await SecureStore.deleteItemAsync(REFRESH_KEY);
    return;
  }
  await SecureStore.setItemAsync(ACCESS_KEY, t.access_token);
  await SecureStore.setItemAsync(REFRESH_KEY, t.refresh_token);
}

/** Refresh-token grant; returns the new access token or null (revoked/expired). */
async function refreshAccessToken(): Promise<string | null> {
  const refresh = await SecureStore.getItemAsync(REFRESH_KEY);
  if (!refresh) return null;
  const t = await authenticate({ grant_type: 'refresh_token', refresh_token: refresh });
  await storeTokens(t);
  return t?.access_token ?? null;
}

export function useWorkOSTokenSource(): TokenSource & {
  /** Launch the hosted AuthKit flow. Resolves true on a completed sign-in. */
  signIn(): Promise<boolean>;
} {
  const [isLoading, setIsLoading] = React.useState(true);
  const [isAuthenticated, setIsAuthenticated] = React.useState(false);

  // Session restore: a stored refresh token counts as signed in; the first
  // Convex fetch validates it for real (and flips us out if it's dead).
  React.useEffect(() => {
    let alive = true;
    SecureStore.getItemAsync(REFRESH_KEY).then((r) => {
      if (!alive) return;
      setIsAuthenticated(!!r);
      setIsLoading(false);
    });
    return () => {
      alive = false;
    };
  }, []);

  const signIn = React.useCallback(async (): Promise<boolean> => {
    const request = new AuthSession.AuthRequest({
      clientId: CLIENT_ID,
      redirectUri: workosRedirectUri,
      responseType: AuthSession.ResponseType.Code,
      usePKCE: true,
      // AuthKit picks the connection (Google Workspace SSO) server-side.
      extraParams: { provider: 'authkit' },
      scopes: [],
    });
    const result = await request.promptAsync({ authorizationEndpoint: AUTHORIZE_URL });
    if (result.type !== 'success' || !result.params.code) return false;
    const t = await authenticate({
      grant_type: 'authorization_code',
      code: result.params.code,
      code_verifier: request.codeVerifier ?? '',
    });
    if (!t) return false;
    await storeTokens(t);
    setIsAuthenticated(true);
    return true;
  }, []);

  const fetchAccessToken = React.useCallback(
    async ({ forceRefreshToken }: { forceRefreshToken: boolean }) => {
      if (!forceRefreshToken) {
        const cached = await SecureStore.getItemAsync(ACCESS_KEY);
        if (cached) return cached;
      }
      const fresh = await refreshAccessToken();
      if (!fresh) setIsAuthenticated(false);
      return fresh;
    },
    [],
  );

  const signOut = React.useCallback(async () => {
    await storeTokens(null);
    setIsAuthenticated(false);
  }, []);

  return { isLoading, isAuthenticated, fetchAccessToken, signOut, signIn };
}
