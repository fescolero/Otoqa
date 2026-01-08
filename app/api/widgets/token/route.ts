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

    // Create widget token
    const token = await workos.widgets.getToken({
      organizationId,
      userId: user.id,
    });

    return NextResponse.json({ token });
  } catch (error) {
    console.error('Error generating widget token:', error);
    return NextResponse.json({ error: 'Failed to generate widget token' }, { status: 500 });
  }
}
