import { useEffect, useState, useRef, useCallback, useMemo, createContext, useContext, type ReactNode } from 'react';
import { AppState, AppStateStatus } from 'react-native';
import { ConvexReactClient } from 'convex/react';
import { useAuth } from '@clerk/clerk-expo';
import { trackConvexAuthEvent } from './analytics';
import { storeAuthToken, clearAuthToken, hasStoredAuthToken } from './auth-token-store';

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
  /**
   * True once automatic recovery has exhausted MAX_AUTO_RECOVERY_ATTEMPTS
   * without a successful handshake. The auto-recovery backstop stops firing
   * at this point; escape requires a user action (manual Retry or sign out).
   * Surfaced so gate screens can stop showing an indefinite spinner and
   * offer that action instead.
   */
  isAuthBlocked: boolean;
  /**
   * Force a fresh Convex auth cycle. Re-registers `convex.setAuth`, which
   * tears down and rebuilds the AuthenticationManager (and nudges the
   * WebSocket to reconnect). This is the imperative the UI's Retry buttons
   * and the auto-recovery hook call when the app is stuck on a loading/error
   * gate — without it, "Retry" only resets a visual timer and re-auth never
   * actually happens. No-op when not signed in, and debounced so a button
   * tap that races the auto-recovery tick doesn't double-fire.
   *
   * `manual: true` marks a user-initiated retry, which is the ONLY thing
   * that clears the reauth/recovery budgets. Automatic callers must leave it
   * unset — an automatic trigger that resets its own budget is an unbounded
   * loop, which is exactly the defect this signature exists to prevent.
   */
  forceReauth: (opts?: { manual?: boolean }) => void;
}

const ConvexAuthContext = createContext<ConvexAuthState>({
  isLoading: true,
  isAuthenticated: false,
  isAuthBlocked: false,
  forceReauth: () => {},
});

export function useConvexAuthState() {
  return useContext(ConvexAuthContext);
}

/**
 * Subscribe to the live Convex WebSocket connection state. This is the
 * ground-truth signal — distinct from NetInfo (which only knows about the
 * device radio) and from our auth state (which is about tokens, not the
 * socket). Lets the UI tell "phone is offline" apart from "phone is online
 * but our backend is unreachable/slow".
 *
 * Deduped to the two fields we actually render off, because the underlying
 * `subscribeToConnectionState` fires on every inflight-request change
 * (i.e. on essentially every query/mutation) — storing the raw state would
 * re-render consumers constantly. Only components that call this hook
 * subscribe; the rest of the tree is untouched.
 */
export function useConvexConnectionState() {
  const [state, setState] = useState<{ isWebSocketConnected: boolean; connectionRetries: number }>(
    () => {
      const cs = convex.connectionState();
      return { isWebSocketConnected: cs.isWebSocketConnected, connectionRetries: cs.connectionRetries };
    },
  );

  useEffect(() => {
    const apply = (cs: { isWebSocketConnected: boolean; connectionRetries: number }) => {
      setState((prev) =>
        prev.isWebSocketConnected === cs.isWebSocketConnected &&
        prev.connectionRetries === cs.connectionRetries
          ? prev
          : { isWebSocketConnected: cs.isWebSocketConnected, connectionRetries: cs.connectionRetries },
      );
    };
    apply(convex.connectionState());
    const unsubscribe = convex.subscribeToConnectionState(apply);
    return unsubscribe;
  }, []);

  return state;
}

// How long to wait before propagating onChange(false) to React state.
// Convex's AuthenticationManager has its own retry logic (tryToReauthenticate)
// that fires with forceRefreshToken:true. We give it time to resolve before
// telling the UI that auth is gone.
const AUTH_FALSE_DEBOUNCE_MS = 3_000;
const AUTH_TIMEOUT_MS = 10_000;
const MAX_REAUTH_ATTEMPTS = 3;

// How many *automatic* recovery cycles we'll run before giving up and
// handing the user an explicit action (sign out / manual Retry).
//
// This cap exists because MAX_REAUTH_ATTEMPTS alone never terminated the
// loop: `forceReauth` used to zero `reauthAttemptsRef` unconditionally, and
// the 20s auto-recovery backstop calls it, so the 3-attempt budget was
// re-armed forever. A permanently unauthable session therefore re-registered
// `convex.setAuth` indefinitely — and because each registration tears down
// the AuthenticationManager and pauses the WebSocket, the recovery loop was
// itself preventing the handshake it was trying to rescue.
const MAX_AUTO_RECOVERY_ATTEMPTS = 5;

// Reactive half of the context — what actually drives re-renders. The
// public ConvexAuthState adds the stable `forceReauth` imperative on top.
type AuthStatus = { isLoading: boolean; isAuthenticated: boolean };

// Provider component - use this ONCE in root layout
export function ConvexAuthProvider({ children }: { children: ReactNode }) {
  const { isLoaded, isSignedIn, getToken } = useAuth();
  const [authState, setAuthState] = useState<AuthStatus>({
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
  const reauthAttemptsRef = useRef(0);
  // Consecutive *automatic* recovery cycles since the last successful auth.
  // Deliberately NOT reset by forceReauth's automatic path — only a genuine
  // onChange(true) or a user-initiated retry clears it.
  const autoRecoveryAttemptsRef = useRef(0);
  const [isAuthBlocked, setIsAuthBlocked] = useState(false);
  const [reauthTrigger, setReauthTrigger] = useState(0);
  // Wall-clock of the last forceReauth so a manual Retry tap and the
  // auto-recovery tick can't pile setAuth re-registrations on top of each
  // other (each re-registration pauses the WS).
  const lastForceReauthAtRef = useRef(0);

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

  // Auth setup — called when user signs in, and re-called on reauth attempts.
  // Each call to convex.setAuth resets the internal AuthenticationManager
  // (pauses WS, clears auth state), so we limit it to once per session plus
  // recovery retries when the token becomes unavailable.
  useEffect(() => {
    if (!isLoaded) return;

    if (!isSignedIn) {
      console.log('[ConvexAuth] Not signed in, clearing auth');
      convex.clearAuth();
      clearAuthToken().catch(() => {});
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
    const reason = reauthAttemptsRef.current > 0 ? 'reauth' : 'initial';
    trackConvexAuthEvent('setup_started', { reason, setup_id: setupId, attempt: reauthAttemptsRef.current });

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
            storeAuthToken(token).catch(() => {});
            return token;
          }
          // Token was null — Clerk session may not be ready yet (common right
          // after sign-in or after returning from background). Wait briefly
          // and retry with skipCache.
          if (tokenRetryCount < MAX_TOKEN_RETRIES) {
            tokenRetryCount++;
            await new Promise((r) => setTimeout(r, TOKEN_RETRY_DELAY_MS));
            const retryToken = await getTokenRef.current({
              template: 'convex',
              skipCache: true,
            });
            if (retryToken) {
              tokenRetryCount = 0;
              storeAuthToken(retryToken).catch(() => {});
              return retryToken;
            }
          }
          // `null_token_after_retry` on its own is undiagnosable — it was
          // ~20k events/day with no way to tell a locked-keychain read from
          // an expired session from a dead network. These three properties
          // are what separate those cases.
          trackConvexAuthEvent('token_fetch_failed', {
            reason, setup_id: setupId,
            error: 'null_token_after_retry',
            retry_count: tokenRetryCount,
            app_state: AppState.currentState,
            force_refresh: forceRefreshToken === true,
            has_cached_token: await hasStoredAuthToken(),
          });
          return null;
        } catch (error) {
          trackConvexAuthEvent('token_fetch_failed', {
            reason, setup_id: setupId,
            error: String(error),
            app_state: AppState.currentState,
            force_refresh: forceRefreshToken === true,
          });
          return null;
        }
      },
      (isAuthenticated) => {
        clearAuthTimeout();
        clearFalseDebounce();
        const elapsed = Date.now() - startTime;

        if (isAuthenticated) {
          wasAuthenticatedRef.current = true;
          // A completed handshake is the only automatic signal that clears
          // both budgets — this is what makes the caps below reachable.
          reauthAttemptsRef.current = 0;
          autoRecoveryAttemptsRef.current = 0;
          setIsAuthBlocked(false);
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
          // fails after the debounce, we either attempt re-auth or propagate
          // the failure.
          setAuthState({ isLoading: true, isAuthenticated: false });
          falseDebounceRef.current = setTimeout(() => {
            trackConvexAuthEvent('auth_false_propagated', { reason, setup_id: setupId, elapsed_ms: Date.now() - startTime });

            // Clerk still signed in — try a fresh setAuth cycle instead of
            // permanently losing auth. This handles the case where the JWT
            // expired while backgrounded and Clerk's session needs a moment
            // to refresh before it can issue new tokens.
            if (isSignedInRef.current && reauthAttemptsRef.current < MAX_REAUTH_ATTEMPTS) {
              reauthAttemptsRef.current++;
              trackConvexAuthEvent('setup_started', { reason: 'reauth', setup_id: setupId, attempt: reauthAttemptsRef.current });
              hasSetAuthRef.current = false;
              wasAuthenticatedRef.current = false;
              setAuthState({ isLoading: true, isAuthenticated: false });
              setReauthTrigger(c => c + 1);
              return;
            }

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
  }, [isLoaded, isSignedIn, reauthTrigger]);

  // When app returns to foreground, check if auth was lost and attempt
  // recovery. Convex's WebSocket reconnects automatically, but if auth
  // was permanently lost (debounce exhausted retries while backgrounded),
  // we need to start a fresh setAuth cycle.
  useEffect(() => {
    const handleAppStateChange = (nextState: AppStateStatus) => {
      const prevState = appStateRef.current;
      appStateRef.current = nextState;

      if (prevState.match(/inactive|background/) && nextState === 'active') {
        console.log('[ConvexAuth] App returned to foreground');
        trackConvexAuthEvent('foreground_return', { has_set_auth: hasSetAuthRef.current });

        // Auth was lost while backgrounded — trigger fresh auth cycle.
        // Skipped once automatic recovery is exhausted: this is the second
        // path that zeroes the reauth budget, so without the guard an app
        // that flaps between background and foreground re-arms the loop the
        // same way the 20s backstop used to.
        if (
          isSignedInRef.current &&
          !wasAuthenticatedRef.current &&
          hasSetAuthRef.current &&
          autoRecoveryAttemptsRef.current < MAX_AUTO_RECOVERY_ATTEMPTS
        ) {
          reauthAttemptsRef.current = 0;
          hasSetAuthRef.current = false;
          setAuthState({ isLoading: true, isAuthenticated: false });
          setReauthTrigger(c => c + 1);
        }
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
      clearAuthToken().catch(() => {});
      hasSetAuthRef.current = false;
      wasAuthenticatedRef.current = false;
      clearFalseDebounce();
      setAuthState({ isLoading: false, isAuthenticated: false });
    }
  }, [isLoaded, isSignedIn]);

  // Imperative recovery — same machinery the foreground-return handler
  // uses, exposed so the UI's Retry buttons and the auto-recovery hook can
  // actually re-drive auth (previously "Retry" only reset a visual timer).
  // A *manual* call resets the reauth-attempt budget so a user who's been
  // stuck through the automatic retries gets a clean run; an automatic call
  // spends from that budget instead. Either way it flips hasSetAuth so the
  // setup effect re-registers convex.setAuth, and bumps the trigger.
  const forceReauth = useCallback((opts?: { manual?: boolean }) => {
    if (!isSignedInRef.current) return;
    const manual = opts?.manual === true;

    // Blocked: only a user-initiated retry gets past this point.
    if (!manual && autoRecoveryAttemptsRef.current >= MAX_AUTO_RECOVERY_ATTEMPTS) return;

    // Debounce BEFORE spending budget — a call that gets debounced away does
    // no work, so charging it would let a double-fire burn the budget without
    // ever attempting a handshake.
    const now = Date.now();
    if (now - lastForceReauthAtRef.current < 4_000) return; // debounce double-fires
    lastForceReauthAtRef.current = now;

    // Automatic recovery is budgeted; a user tapping Retry is not. Without
    // this split the budget is meaningless — the caller that most needs to be
    // capped (a repeating timer) was the one zeroing the counter.
    if (!manual) {
      autoRecoveryAttemptsRef.current++;
      if (autoRecoveryAttemptsRef.current >= MAX_AUTO_RECOVERY_ATTEMPTS) {
        // Fire once per stuck episode, not once per attempt — the whole point
        // is a single actionable signal instead of thousands of retry events.
        trackConvexAuthEvent('recovery_exhausted', {
          attempts: autoRecoveryAttemptsRef.current,
          app_state: AppState.currentState,
        });
        setIsAuthBlocked(true);
      }
    }

    clearAuthTimeout();
    clearFalseDebounce();
    if (manual) {
      reauthAttemptsRef.current = 0;
      autoRecoveryAttemptsRef.current = 0;
      setIsAuthBlocked(false);
    }
    hasSetAuthRef.current = false;
    wasAuthenticatedRef.current = false;
    setAuthState({ isLoading: true, isAuthenticated: false });
    setReauthTrigger((c) => c + 1);
  }, []);

  // Stable forceReauth + auth state. forceReauth never changes identity, so
  // this memo only produces a new object when authState actually transitions
  // — consumers re-render no more often than before this field.
  const contextValue = useMemo<ConvexAuthState>(
    () => ({ ...authState, isAuthBlocked, forceReauth }),
    [authState, isAuthBlocked, forceReauth],
  );

  return (
    <ConvexAuthContext.Provider value={contextValue}>
      {children}
    </ConvexAuthContext.Provider>
  );
}
