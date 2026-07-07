import { withAuth } from '@workos-inc/authkit-nextjs';
import { redirect } from 'next/navigation';
import { LoadDetail } from '@/components/load-detail';
import { requireWorkOS } from '@/lib/workos';

export default async function LoadDetailPage({ params }: { params: Promise<{ id: string }> }) {
  const { user } = await withAuth();
  const { id } = await params;

  if (!user) {
    redirect('/sign-in');
  }

  const workos = requireWorkOS();

  // Fetch organization data
  let organization = null;
  try {
    const memberships = await workos.userManagement.listOrganizationMemberships({
      userId: user.id,
      limit: 1,
    });

    if (memberships.data && memberships.data.length > 0) {
      const organizationId = memberships.data[0].organizationId;
      const org = await workos.organizations.getOrganization(organizationId);

      organization = JSON.parse(
        JSON.stringify({
          id: org.id,
          name: org.name,
        }),
      );
    }
  } catch (error) {
    console.error('Error fetching organization:', error);
  }

  return organization ? (
    <LoadDetail loadId={id} organizationId={organization.id} userId={user.id} />
  ) : null;
}
