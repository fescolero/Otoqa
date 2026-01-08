import { withAuth } from '@workos-inc/authkit-nextjs';
import { WorkOS } from '@workos-inc/node';
import { NextResponse } from 'next/server';

const workos = new WorkOS(process.env.WORKOS_API_KEY);

export async function GET() {
  try {
    const { user } = await withAuth();

    if (!user) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }

    // Get all user's organization memberships
    const memberships = await workos.userManagement.listOrganizationMemberships({
      userId: user.id,
    });

    if (!memberships.data || memberships.data.length === 0) {
      return NextResponse.json({ organizations: [] });
    }

    // Fetch full details for each organization
    const organizations = await Promise.all(
      memberships.data.map(async (membership) => {
        const org = await workos.organizations.getOrganization(membership.organizationId);
        return {
          id: org.id,
          name: org.name,
          domains: org.domains,
          createdAt: org.createdAt,
          updatedAt: org.updatedAt,
        };
      })
    );

    return NextResponse.json({ organizations });
  } catch (error) {
    console.error('Error fetching organizations:', error);
    return NextResponse.json({ error: 'Failed to fetch organizations' }, { status: 500 });
  }
}
