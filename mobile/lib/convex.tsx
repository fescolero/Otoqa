import React, { useEffect, useState, useRef, createContext, useContext } from 'react';
import { ConvexReactClient } from 'convex/react';
import { useAuth } from '@clerk/clerk-expo';

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

// Provider component - use this ONCE in root layout
export function ConvexAuthProvider({ children }: { children: React.ReactNode }) {
  const { isLoaded, isSignedIn, getToken } = useAuth();
  const [authState, setAuthState] = useState<ConvexAuthState>({
    isLoading: true,
    isAuthenticated: false,
  });
  const setupDoneRef = useRef(false);

  useEffect(() => {
    // Only run setup once
    if (setupDoneRef.current) return;
    if (!isLoaded) return;

    async function setupAuth() {
      if (!isSignedIn) {
        console.log('[ConvexAuth] Not signed in, clearing auth');
        convex.clearAuth();
        setAuthState({ isLoading: false, isAuthenticated: false });
        return;
      }

      try {
        setupDoneRef.current = true;
        console.log('[ConvexAuth] Setting up auth...');

        // Set auth with token fetcher - Convex will call this when needed
        convex.setAuth(async (forceRefresh) => {
          try {
            const token = await getToken({
              template: 'convex',
              skipCache: forceRefresh,
            });
            return token;
          } catch (error) {
            console.error('[ConvexAuth] Token fetch error:', error);
            return null;
          }
        });

        // Give Convex a moment to authenticate
        // The setAuth is async internally
        await new Promise(resolve => setTimeout(resolve, 500));
        
        console.log('[ConvexAuth] Auth setup complete');
        setAuthState({ isLoading: false, isAuthenticated: true });
      } catch (error) {
        console.error('[ConvexAuth] Setup error:', error);
        setupDoneRef.current = false;
        setAuthState({ isLoading: false, isAuthenticated: false });
      }
    }

    setupAuth();
  }, [isLoaded, isSignedIn]); // Removed getToken from deps - it shouldn't change

  // Handle sign out
  useEffect(() => {
    if (isLoaded && !isSignedIn && setupDoneRef.current) {
      console.log('[ConvexAuth] Signed out, resetting');
      setupDoneRef.current = false;
      convex.clearAuth();
      setAuthState({ isLoading: false, isAuthenticated: false });
    }
  }, [isLoaded, isSignedIn]);

  return (
    <ConvexAuthContext.Provider value={authState}>
      {children}
    </ConvexAuthContext.Provider>
  );
}
