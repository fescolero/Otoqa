import { useEffect, useState, useRef, createContext, useContext, type ReactNode } from 'react';
import { AppState, AppStateStatus } from 'react-native';
import { ConvexReactClient } from 'convex/react';
import { useAuth } from '@clerk/clerk-expo';
import { trackConvexAuthEvent } from './analytics';

// ============================================
// CONVEX CLIENT SETUP
// ============================================

const CONVEX_URL = process.env.EXPO_PUBLIC_CONVEX_URL;

if (!CONVEX_URL) {
  throw new Error('EXPO_PUBLIC_CONVEX_URL is not set');
}

export const convex = new ConvexReactClient(CONVEX_URL, {
  unsavedChangesWarning: false,
});

// ============================================
// CONVEX AUTH CONTEXT
// Share auth state across the app
// ============================================

interface ConvexAuthState {
  isLoading: boolean;
  isAuthenticated: boolean;
}

const ConvexAuthContext = createContext<ConvexAuthState>({
  isLoading: true,
  isAuthenticated: false,
});

export function useConvexAuthState() {
  return useContext(ConvexAuthContext);
}

// How long to wait before propagating onChange(false) to React state.
// Convex's AuthenticationManager has its own retry logic (tryToReauthenticate)
// that fires with forceRefreshToken:true. We give it time to resolve before
// telling the UI that auth is gone.
const AUTH_FALSE_DEBOUNCE_MS = 3_000;
const AUTH_TIMEOUT_MS = 10_000;

// Provider component - use this ONCE in root layout
export function ConvexAuthProvider({ children }: { children: ReactNode }) {
  const { isLoaded, isSignedIn, getToken } = useAuth();
  const [authState, setAuthState] = useState<ConvexAuthState>({
    isLoading: true,
    isAuthenticated: false,
  });
  const authSetupCount = useRef(0);
  const appStateRef = useRef<AppStateStatus>(AppState.currentState);
  const wasAuthenticatedRef = useRef(false);
  const authTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const falseDebounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  // Track whether setAuth has been called to avoid calling it again on foreground
  const hasSetAuthRef = useRef(false);

  const clearAuthTimeout = () => {
    if (authTimeoutRef.current) {
      clearTimeout(authTimeoutRef.current);
      authTimeoutRef.current = null;
    }
  };

  const clearFalseDebounce = () => {
    if (falseDebounceRef.current) {
      clearTimeout(falseDebounceRef.current);
      falseDebounceRef.current = null;
    }
  };

  // Use refs for Clerk values so the fetchToken callback always reads fresh
  // values without needing to re-register convex.setAuth.
  const getTokenRef = useRef(getToken);
  const isSignedInRef = useRef(isSignedIn);
  useEffect(() => { getTokenRef.current = getToken; }, [getToken]);
  useEffect(() => { isSignedInRef.current = isSignedIn; }, [isSignedIn]);

  // Initial auth setup — called ONCE when user signs in.
  // CRITICAL: Do NOT call convex.setAuth more than once per session.
  // Each call resets the internal AuthenticationManager (pauses WS, clears
  // auth state), causing all active queries to momentarily lose their identity.
  useEffect(() => {
    if (!isLoaded) return;

    if (!isSignedIn) {
      console.log('[ConvexAuth] Not signed in, clearing auth');
      convex.clearAuth();
      hasSetAuthRef.current = false;
      wasAuthenticatedRef.current = false;
      clearFalseDebounce();
      setAuthState({ isLoading: false, isAuthenticated: false });
      return;
    }

    // Already set up auth for this session — don't call setAuth again
    if (hasSetAuthRef.current) return;

    // Mark as loading while Convex authenticates with the server
    setAuthState({ isLoading: true, isAuthenticated: false });

    const setupId = ++authSetupCount.current;
    const startTime = Date.now();
    const reason = 'initial';
    trackConvexAuthEvent('setup_started', { reason, setup_id: setupId });

    clearAuthTimeout();
    authTimeoutRef.current = setTimeout(() => {
      trackConvexAuthEvent('auth_timeout', { reason, setup_id: setupId, elapsed_ms: AUTH_TIMEOUT_MS });
      wasAuthenticatedRef.current = false;
      setAuthState({ isLoading: false, isAuthenticated: false });
    }, AUTH_TIMEOUT_MS);

    hasSetAuthRef.current = true;

    let tokenRetryCount = 0;
    const MAX_TOKEN_RETRIES = 3;
    const TOKEN_RETRY_DELAY_MS = 1500;

    convex.setAuth(
      async ({ forceRefreshToken }) => {
        try {
          const token = await getTokenRef.current({
            template: 'convex',
            skipCache: forceRefreshToken,
          });
          if (token) {
            tokenRetryCount = 0;
            return token;
          }
          // Token was null — Clerk session may not be ready yet (common right
          // after sign-in). Wait briefly and retry with skipCache.
          if (tokenRetryCount < MAX_TOKEN_RETRIES) {
            tokenRetryCount++;
            await new Promise((r) => setTimeout(r, TOKEN_RETRY_DELAY_MS));
            const retryToken = await getTokenRef.current({
              template: 'convex',
              skipCache: true,
            });
            if (retryToken) {
              tokenRetryCount = 0;
              return retryToken;
            }
          }
          trackConvexAuthEvent('token_fetch_failed', {
            reason, setup_id: setupId,
            error: 'null_token_after_retry',
            retry_count: tokenRetryCount,
          });
          return null;
        } catch (error) {
          trackConvexAuthEvent('token_fetch_failed', { reason, setup_id: setupId, error: String(error) });
          return null;
        }
      },
      (isAuthenticated) => {
        clearAuthTimeout();
        clearFalseDebounce();
        const elapsed = Date.now() - startTime;

        if (isAuthenticated) {
          wasAuthenticatedRef.current = true;
          trackConvexAuthEvent('setup_complete', { reason, setup_id: setupId, is_authenticated: true, elapsed_ms: elapsed });
          setAuthState({ isLoading: false, isAuthenticated: true });
          return;
        }

        // onChange(false): Convex says auth failed.
        // If Clerk still considers us signed in, this is likely a transient
        // state (token not ready yet, or token refresh in progress).
        if (isSignedInRef.current) {
          trackConvexAuthEvent('debouncing_false', {
            reason, setup_id: setupId, elapsed_ms: elapsed,
            was_authenticated: wasAuthenticatedRef.current,
          });
          // Keep isLoading true so the UI shows a spinner instead of an error.
          // Convex's AuthenticationManager will retry internally. If it still
          // fails after the debounce, we propagate the failure.
          setAuthState({ isLoading: true, isAuthenticated: false });
          falseDebounceRef.current = setTimeout(() => {
            trackConvexAuthEvent('auth_false_propagated', { reason, setup_id: setupId, elapsed_ms: Date.now() - startTime });
            wasAuthenticatedRef.current = false;
            setAuthState({ isLoading: false, isAuthenticated: false });
          }, AUTH_FALSE_DEBOUNCE_MS);
          return;
        }

        wasAuthenticatedRef.current = false;
        trackConvexAuthEvent('setup_complete', { reason, setup_id: setupId, is_authenticated: false, elapsed_ms: elapsed });
        setAuthState({ isLoading: false, isAuthenticated: false });
      }
    );
  }, [isLoaded, isSignedIn]);

  // When app returns to foreground, DON'T call setAuth again.
  // Convex's WebSocket reconnects automatically and the existing
  // fetchToken callback will be invoked by the AuthenticationManager
  // when it needs a fresh token.
  useEffect(() => {
    const handleAppStateChange = (nextState: AppStateStatus) => {
      const prevState = appStateRef.current;
      appStateRef.current = nextState;

      if (prevState.match(/inactive|background/) && nextState === 'active') {
        console.log('[ConvexAuth] App returned to foreground');
        trackConvexAuthEvent('foreground_return', { has_set_auth: hasSetAuthRef.current });
        // No need to call setupAuth — Convex handles reconnection internally
      }
    };

    const subscription = AppState.addEventListener('change', handleAppStateChange);
    return () => subscription.remove();
  }, []);

  // Handle sign out
  useEffect(() => {
    if (isLoaded && !isSignedIn && authSetupCount.current > 0) {
      console.log('[ConvexAuth] Signed out, resetting');
      authSetupCount.current = 0;
      convex.clearAuth();
      hasSetAuthRef.current = false;
      wasAuthenticatedRef.current = false;
      clearFalseDebounce();
      setAuthState({ isLoading: false, isAuthenticated: false });
    }
  }, [isLoaded, isSignedIn]);

  return (
    <ConvexAuthContext.Provider value={authState}>
      {children}
    </ConvexAuthContext.Provider>
  );
}
