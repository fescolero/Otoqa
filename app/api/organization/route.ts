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

    // Get user's organization
    const memberships = await workos.userManagement.listOrganizationMemberships({
      userId: user.id,
      limit: 1,
    });

    if (!memberships.data || memberships.data.length === 0) {
      return NextResponse.json({ error: 'No organization found' }, { status: 404 });
    }

    const organizationId = memberships.data[0].organizationId;

    // Fetch full organization details
    const organization = await workos.organizations.getOrganization(organizationId);

    return NextResponse.json({
      organizationId: organization.id,
      name: organization.name,
      domains: organization.domains,
      createdAt: organization.createdAt,
      updatedAt: organization.updatedAt,
    });
  } catch (error) {
    console.error('Error fetching organization:', error);
    return NextResponse.json({ error: 'Failed to fetch organization' }, { status: 500 });
  }
}
