/**
 * Server-side context for the /api/team/* routes: authenticated caller +
 * WorkOS client + resolved org. Mirrors the auth pattern of the existing
 * org routes (session org claim with a membership fallback for sessions
 * that predate org claims).
 *
 * NOTE ON AUTHORIZATION: any signed-in org member may currently manage the
 * team — matching the rest of the app, which has no RBAC enforcement yet.
 * When permission enforcement lands (Roles phase), these routes gate on the
 * team:manage permission claim.
 */

import { withAuth } from '@workos-inc/authkit-nextjs';
import type { WorkOS } from '@workos-inc/node';
import { requireWorkOS } from './workos';

export interface TeamContext {
  workos: WorkOS;
  organizationId: string;
  userId: string;
}

export interface TeamContextError {
  error: string;
  status: number;
}

export async function getTeamContext(): Promise<TeamContext | TeamContextError> {
  const auth = await withAuth();
  if (!auth.user) return { error: 'Unauthorized', status: 401 };

  const workos = requireWorkOS();

  let organizationId = auth.organizationId;
  if (!organizationId) {
    const memberships = await workos.userManagement.listOrganizationMemberships({
      userId: auth.user.id,
      limit: 1,
    });
    organizationId = memberships.data[0]?.organizationId;
  }
  if (!organizationId) return { error: 'No organization found', status: 404 };

  return { workos, organizationId, userId: auth.user.id };
}

export function isTeamContextError(
  ctx: TeamContext | TeamContextError,
): ctx is TeamContextError {
  return 'error' in ctx;
}

/** Every permission slug in the environment — listPermissions is paginated,
 *  so a single-page read misses slugs and breaks idempotent seeding. */
export async function listAllPermissionSlugs(workos: WorkOS): Promise<Set<string>> {
  const slugs = new Set<string>();
  let after: string | null | undefined;
  do {
    const page = await workos.authorization.listPermissions({
      limit: 100,
      ...(after ? { after } : {}),
    });
    for (const p of page.data ?? []) slugs.add(p.slug);
    after = page.listMetadata?.after;
  } while (after);
  return slugs;
}

/** WorkOS "already exists" conflict — safe to treat as success when the
 *  goal is idempotent creation. */
export function isConflict(error: unknown): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    (error as { status?: number }).status === 409
  );
}
