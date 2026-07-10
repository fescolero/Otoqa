import { withAuth } from '@workos-inc/authkit-nextjs';
import { NextResponse } from 'next/server';
import { getWorkOS } from '@/lib/workos';

/**
 * Members of the caller's organization, for resolving WorkOS user IDs to
 * display names client-side (e.g. audit timeline rows written before
 * performer names were denormalized onto the log).
 */
export async function GET() {
  try {
    const workos = getWorkOS();
    if (!workos) {
      return NextResponse.json({ error: 'WorkOS not configured' }, { status: 500 });
    }

    const { user } = await withAuth();

    if (!user) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }

    // Get user's organization
    const memberships = await workos.userManagement.listOrganizationMemberships({
      userId: user.id,
      limit: 1,
    });

    if (!memberships.data || memberships.data.length === 0) {
      return NextResponse.json({ error: 'No organization found' }, { status: 404 });
    }

    const organizationId = memberships.data[0].organizationId;

    const members: Array<{
      id: string;
      firstName: string | null;
      lastName: string | null;
      email: string;
    }> = [];

    let after: string | undefined;
    do {
      const page = await workos.userManagement.listUsers({
        organizationId,
        limit: 100,
        after,
      });
      for (const u of page.data) {
        members.push({
          id: u.id,
          firstName: u.firstName,
          lastName: u.lastName,
          email: u.email,
        });
      }
      after = page.listMetadata?.after ?? undefined;
    } while (after);

    return NextResponse.json({ members });
  } catch (error) {
    console.error('Error fetching organization members:', error);
    return NextResponse.json({ error: 'Failed to fetch organization members' }, { status: 500 });
  }
}
