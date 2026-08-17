'use client';

import { useConvexAuth, useQuery, usePaginatedQuery } from 'convex/react';
import type { FunctionReference } from 'convex/server';
import type {
  PaginatedQueryReference,
  PaginatedQueryArgs,
  UsePaginatedQueryReturnType,
} from 'convex/react';

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

/**
 * Paginated counterpart to `useAuthQuery`, holding the query at `'skip'`
 * until the Convex auth handshake completes.
 *
 * This exists because the gate above only ever wrapped `useQuery`, so every
 * `usePaginatedQuery` call site had to remember to gate on
 * `useConvexAuth().isAuthenticated` by hand — and a site that forgot looked
 * exactly like one that had deliberately opted out. `loads:getLoads` was the
 * case that surfaced it: three of its four callers gated correctly and the
 * fourth fired on mount, throwing `Unauthenticated` server-side on every
 * page load.
 *
 * Drop-in replacement for `usePaginatedQuery` — same signature, same return
 * type. Pass `'skip'` yourself as usual for non-auth reasons; the two
 * conditions compose.
 */
export function useAuthPaginatedQuery<Query extends PaginatedQueryReference>(
  query: Query,
  args: PaginatedQueryArgs<Query> | 'skip',
  options: { initialNumItems: number },
): UsePaginatedQueryReturnType<Query> {
  const { isAuthenticated } = useConvexAuth();
  const shouldSkip = !isAuthenticated || args === 'skip';
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return usePaginatedQuery(query, (shouldSkip ? 'skip' : args) as any, options);
}
