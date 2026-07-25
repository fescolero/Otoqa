/**
 * Convex wiring for Otoqa Dispatch — ConvexProviderWithAuth with a
 * pluggable token source (split-plan §3.2). The provider-selection flag
 * (SecureStore) decides whether Clerk or WorkOS feeds the client; both
 * hooks run unconditionally (hook-order safety), only one is consulted.
 *
 * Deliberately simpler than the driver app's hand-rolled provider: this
 * mirrors the web's proven useAuthFromAuthKit shape. The driver app's
 * recovery machinery (gate timeouts, reauth budgets, offline bypass)
 * gets ported in Phase 1 hardening once the happy path is device-proven.
 */
import * as React from 'react';
import { ConvexProviderWithAuth, ConvexReactClient } from 'convex/react';
import { useAuth as useClerkAuth } from '@clerk/clerk-expo';
import {
  getStoredProvider,
  setStoredProvider,
  type AuthProvider,
  type TokenSource,
} from './auth/token-source';
import { useWorkOSTokenSource } from './auth/workos-token-source';

const CONVEX_URL = process.env.EXPO_PUBLIC_CONVEX_URL;
if (!CONVEX_URL) throw new Error('EXPO_PUBLIC_CONVEX_URL is not set');

export const convex = new ConvexReactClient(CONVEX_URL, { unsavedChangesWarning: false });

interface ActiveAuth {
  provider: AuthProvider | null;
  /** Set after a successful sign-in on either path; null on sign-out. */
  selectProvider: (p: AuthProvider | null) => Promise<void>;
  clerk: TokenSource;
  workos: ReturnType<typeof useWorkOSTokenSource>;
  signOut: () => Promise<void>;
}

const ActiveAuthContext = React.createContext<ActiveAuth | null>(null);

export function useActiveAuth(): ActiveAuth {
  const v = React.useContext(ActiveAuthContext);
  if (!v) throw new Error('useActiveAuth outside provider');
  return v;
}

function useClerkTokenSource(): TokenSource {
  const { isLoaded, isSignedIn, getToken, signOut } = useClerkAuth();
  return {
    isLoading: !isLoaded,
    isAuthenticated: !!isSignedIn,
    // Same template + skipCache semantics as the driver app (lib/convex.tsx).
    fetchAccessToken: async ({ forceRefreshToken }) =>
      (await getToken({ template: 'convex', skipCache: forceRefreshToken })) ?? null,
    signOut: async () => {
      await signOut();
    },
  };
}

export function DispatchAuthProvider({ children }: { children: React.ReactNode }) {
  const [provider, setProvider] = React.useState<AuthProvider | null>(null);
  const [providerLoaded, setProviderLoaded] = React.useState(false);
  const clerk = useClerkTokenSource();
  const workos = useWorkOSTokenSource();

  React.useEffect(() => {
    getStoredProvider().then((p) => {
      setProvider(p);
      setProviderLoaded(true);
    });
  }, []);

  const selectProvider = React.useCallback(async (p: AuthProvider | null) => {
    await setStoredProvider(p);
    setProvider(p);
  }, []);

  const signOut = React.useCallback(async () => {
    // Sign out of whichever source is active; clear the flag either way.
    if (provider === 'clerk') await clerk.signOut();
    if (provider === 'workos') await workos.signOut();
    await setStoredProvider(null);
    setProvider(null);
  }, [provider, clerk, workos]);

  const active: TokenSource =
    provider === 'workos' ? workos : provider === 'clerk' ? clerk : NULL_SOURCE;

  // Convex's useAuth contract, driven by the active source. providerLoaded
  // gates the initial render so a stored session doesn't flash signed-out.
  const useAuthForConvex = React.useCallback(
    () => ({
      isLoading: !providerLoaded || active.isLoading,
      isAuthenticated: providerLoaded && active.isAuthenticated,
      fetchAccessToken: active.fetchAccessToken,
    }),
    [providerLoaded, active.isLoading, active.isAuthenticated, active.fetchAccessToken],
  );

  return (
    <ActiveAuthContext.Provider value={{ provider, selectProvider, clerk, workos, signOut }}>
      <ConvexProviderWithAuth client={convex} useAuth={useAuthForConvex}>
        {children}
      </ConvexProviderWithAuth>
    </ActiveAuthContext.Provider>
  );
}

const NULL_SOURCE: TokenSource = {
  isLoading: false,
  isAuthenticated: false,
  fetchAccessToken: async () => null,
  signOut: async () => {},
};
