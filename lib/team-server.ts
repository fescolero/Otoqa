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
