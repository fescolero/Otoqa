/**
 * Dual-provider auth for Otoqa Dispatch (split-plan §3.2, decision D4).
 *
 * Two token sources feed one Convex client:
 *   - clerk:  phone-OTP owner-operators (primary sign-in path)
 *   - workos: Google-Workspace staff via hosted AuthKit + PKCE
 *
 * The active provider is remembered in SecureStore so returning users
 * skip the choice (v8 sign-in design). The app NEVER branches feature
 * visibility on the provider — that comes from dispatchMobile.getSession
 * capability flags (D3).
 */
import * as SecureStore from 'expo-secure-store';

export type AuthProvider = 'clerk' | 'workos';

const PROVIDER_KEY = 'otoqa-dispatch-auth-provider';

export async function getStoredProvider(): Promise<AuthProvider | null> {
  const v = await SecureStore.getItemAsync(PROVIDER_KEY);
  return v === 'clerk' || v === 'workos' ? v : null;
}

export async function setStoredProvider(p: AuthProvider | null): Promise<void> {
  if (p === null) await SecureStore.deleteItemAsync(PROVIDER_KEY);
  else await SecureStore.setItemAsync(PROVIDER_KEY, p);
}

/**
 * The contract both sources implement — shaped for Convex's
 * ConvexProviderWithAuth useAuth prop (docs.convex.dev custom auth).
 */
export interface TokenSource {
  isLoading: boolean;
  isAuthenticated: boolean;
  fetchAccessToken(args: { forceRefreshToken: boolean }): Promise<string | null>;
  signOut(): Promise<void>;
}
