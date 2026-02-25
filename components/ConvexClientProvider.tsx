'use client';

import { ReactNode, useCallback, useRef, useState } from 'react';
import { ConvexReactClient } from 'convex/react';
import { ConvexProviderWithAuth } from 'convex/react';
import { AuthKitProvider, useAuth, useAccessToken } from '@workos-inc/authkit-nextjs/components';

export function ConvexClientProvider({ children }: { children: ReactNode }) {
  const [convex] = useState(() => {
    return new ConvexReactClient(process.env.NEXT_PUBLIC_CONVEX_URL!);
  });
  return (
    <AuthKitProvider>
      <ConvexProviderWithAuth client={convex} useAuth={useAuthFromAuthKit}>
        {children}
      </ConvexProviderWithAuth>
    </AuthKitProvider>
  );
}

function useAuthFromAuthKit() {
  const { user, loading } = useAuth();
  const { getAccessToken, refresh } = useAccessToken();
  const hasResolved = useRef(false);

  const isAuthenticated = !!user;

  if (isAuthenticated) {
    hasResolved.current = true;
  }

  // Stay in "loading" state until auth has definitively resolved.
  // Prevents Convex from sending queries without a token during the
  // brief window where AuthKit reports loading=false before the user
  // object is hydrated on the client.
  const isLoading = loading || (!isAuthenticated && !hasResolved.current);

  const fetchAccessToken = useCallback(
    async ({ forceRefreshToken }: { forceRefreshToken?: boolean } = {}): Promise<string | null> => {
      if (!user) return null;

      const MAX_RETRIES = 3;
      for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
        try {
          const token = forceRefreshToken
            ? ((await refresh()) ?? null)
            : ((await getAccessToken()) ?? null);

          if (token) return token;
        } catch {
          // Transient failure — fall through to retry
        }

        if (attempt < MAX_RETRIES) {
          await new Promise((r) => setTimeout(r, 100 * (attempt + 1)));
        }
      }

      return null;
    },
    [user, refresh, getAccessToken],
  );

  return {
    isLoading,
    isAuthenticated,
    fetchAccessToken,
  };
}
