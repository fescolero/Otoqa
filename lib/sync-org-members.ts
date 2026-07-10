import { ConvexHttpClient } from 'convex/browser';
import { api } from '@/convex/_generated/api';
import { getWorkOS } from './workos';

/**
 * Push the org's member list from WorkOS (system of record for user
 * profiles) into Convex's `orgMembers` table, authenticated as the given
 * user. Convex uses this directory to resolve raw WorkOS user IDs to
 * display names server-side (audit log performers, created-by fields).
 *
 * Called from the login callback and from POST
 * /api/organization/members/sync. Server-side only.
 */
export async function syncOrgMembersToConvex({
  organizationId,
  accessToken,
}: {
  organizationId: string;
  accessToken: string;
}): Promise<void> {
  const workos = getWorkOS();
  const convexUrl = process.env.NEXT_PUBLIC_CONVEX_URL;
  if (!workos || !convexUrl) return;

  const members: Array<{
    workosUserId: string;
    firstName?: string;
    lastName?: string;
    email?: string;
  }> = [];

  let after: string | undefined;
  do {
    const page = await workos.userManagement.listUsers({
      organizationId,
      limit: 100,
      after,
    });
    for (const user of page.data) {
      members.push({
        workosUserId: user.id,
        firstName: user.firstName ?? undefined,
        lastName: user.lastName ?? undefined,
        email: user.email,
      });
    }
    after = page.listMetadata?.after ?? undefined;
  } while (after);

  if (members.length === 0) return;

  const convex = new ConvexHttpClient(convexUrl);
  convex.setAuth(accessToken);
  await convex.mutation(api.orgMembers.syncMembers, { members });
}
