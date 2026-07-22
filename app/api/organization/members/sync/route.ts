import { withAuth } from '@workos-inc/authkit-nextjs';
import { NextResponse } from 'next/server';
import { requireWorkOS } from '@/lib/workos';
import { syncOrgMembersToConvex } from '@/lib/sync-org-members';

/**
 * On-demand sync of the caller's org member directory from WorkOS into
 * Convex. Normally the login callback keeps the directory current; this
 * exists as a self-heal for sessions that predate the directory — audit
 * UIs call it once per tab when they encounter a user ID they can't
 * resolve, and Convex reactivity delivers the resolved names.
 */
export async function POST() {
  try {
    const auth = await withAuth();

    if (!auth.user) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }

    // Sessions established before org claims were configured may lack the
    // org on the session — fall back to the user's membership.
    let orgId = auth.organizationId;
    if (!orgId) {
      const workos = requireWorkOS();
      const memberships = await workos.userManagement.listOrganizationMemberships({
        userId: auth.user.id,
        limit: 1,
      });
      orgId = memberships.data[0]?.organizationId;
    }

    if (!orgId) {
      return NextResponse.json({ error: 'No organization found' }, { status: 404 });
    }

    await syncOrgMembersToConvex({ organizationId: orgId, accessToken: auth.accessToken });

    return NextResponse.json({ ok: true });
  } catch (error) {
    console.error('Error syncing organization members:', error);
    return NextResponse.json({ error: 'Failed to sync organization members' }, { status: 500 });
  }
}
