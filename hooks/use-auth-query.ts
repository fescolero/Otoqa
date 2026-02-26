'use client';

import { useConvexAuth, useQuery } from 'convex/react';
import type { FunctionReference } from 'convex/server';

/**
 * Wrapper around Convex's `useQuery` that automatically skips execution
 * until the Convex auth token has been established. Prevents "Not
 * authenticated" server errors from queries that fire before the client-
 * side auth handshake completes.
 *
 * Drop-in replacement for `useQuery` — same signature, same return type.
 */
export function useAuthQuery<Query extends FunctionReference<'query'>>(
  query: Query,
  args: Query['_args'] | 'skip',
): Query['_returnType'] | undefined {
  const { isAuthenticated } = useConvexAuth();
  const shouldSkip = !isAuthenticated || args === 'skip';
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return useQuery(query, (shouldSkip ? 'skip' : args) as any);
}
