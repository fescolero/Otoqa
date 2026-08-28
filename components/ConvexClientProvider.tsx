'use client';

import { ReactNode, useCallback, useRef, useState } from 'react';
import { ConvexReactClient } from 'convex/react';
import { ConvexProviderWithAuth } from 'convex/react';
import { AuthKitProvider, useAuth, useAccessToken } from '@workos-inc/authkit-nextjs/components';
import { fetchConvexAccessToken } from '@/lib/convex-access-token';

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

  // Policy lives in lib/convex-access-token.ts — see the header there for why
  // returning `null` on a transient failure tears down every live query.
  const fetchAccessToken = useCallback(
    ({ forceRefreshToken }: { forceRefreshToken?: boolean } = {}): Promise<string | null> =>
      fetchConvexAccessToken({
        hasUser: !!user,
        forceRefreshToken,
        refresh,
        getAccessToken,
      }),
    [user, refresh, getAccessToken],
  );

  return {
    isLoading,
    isAuthenticated,
    fetchAccessToken,
  };
}
