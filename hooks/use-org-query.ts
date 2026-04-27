'use client';

import type { FunctionReference } from 'convex/server';
import { useOrganizationId } from '@/contexts/organization-context';
import { useAuthQuery } from '@/hooks/use-auth-query';

/**
 * Wrapper around `useAuthQuery` that injects the current organization id
 * under the arg key the Convex function expects (`organizationId`,
 * `workosOrgId`, `brokerOrgId`, …). Removes the per-page
 * `orgId ? { organizationId: orgId, …rest } : 'skip'` boilerplate while
 * preserving the same skip-until-authenticated semantics.
 *
 * Defaults to `organizationId`. Pass `orgIdKey` for queries whose arg
 * uses a different name.
 */
export function useOrgQuery<
  Query extends FunctionReference<'query'>,
  K extends keyof Query['_args'] & string = 'organizationId' & keyof Query['_args'],
>(
  query: Query,
  args: Omit<Query['_args'], K> | 'skip',
  orgIdKey?: K,
): Query['_returnType'] | undefined {
  const orgId = useOrganizationId();
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const key = (orgIdKey ?? 'organizationId') as any;
  const merged =
    args === 'skip' || !orgId
      ? 'skip'
      : ({ ...(args as object), [key]: orgId } as Query['_args']);
  return useAuthQuery(query, merged);
}
