import { withAuth } from '@workos-inc/authkit-nextjs';
import { redirect } from 'next/navigation';
import { LaneAnalyzerDashboard } from './_components/lane-analyzer-dashboard';
import { requireWorkOS } from '@/lib/workos';

export default async function LaneAnalyzerPage() {
  const { user } = await withAuth();

  if (!user) {
    redirect('/sign-in');
  }

  const workos = requireWorkOS();

  let organization = null;
  try {
    const memberships = await workos.userManagement.listOrganizationMemberships({
      userId: user.id,
      limit: 1,
    });

    if (memberships.data && memberships.data.length > 0) {
      const organizationId = memberships.data[0].organizationId;
      organization = { id: organizationId };
    }
  } catch (error) {
    console.error('Error fetching organization:', error);
  }

  const userData = JSON.parse(
    JSON.stringify({
      name: user.firstName && user.lastName ? `${user.firstName} ${user.lastName}` : user.email,
      email: user.email,
      id: user.id,
    }),
  );

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="flex min-h-0 flex-1 overflow-hidden w-full">
        {organization && (
          <LaneAnalyzerDashboard organizationId={organization.id} userId={userData.id} />
        )}
      </div>
    </div>
  );
}
