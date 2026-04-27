'use client';

import { useAuth } from '@workos-inc/authkit-nextjs/components';
import { useConvexAuth } from 'convex/react';
import { useRouter } from 'next/navigation';
import { useOrganizationId } from '@/contexts/organization-context';

/**
 * Bundles the auth/org/router boilerplate that nearly every page in
 * `app/(app)` repeats. Page-level loading/redirect logic stays the
 * caller's responsibility — this hook only consolidates the lookups.
 *
 * `isReady` mirrors what each page already gates on: WorkOS user
 * resolved, Convex auth handshake complete, organization id present.
 * It is conservative on purpose so swapping a page over to this hook
 * does not change when queries fire.
 */
export function usePageInitialize() {
  const { user } = useAuth();
  const { isAuthenticated, isLoading: convexAuthLoading } = useConvexAuth();
  const orgId = useOrganizationId();
  const router = useRouter();

  const isReady = !!user && isAuthenticated && !convexAuthLoading && !!orgId;

  return { user, orgId, router, isAuthenticated, isReady };
}
