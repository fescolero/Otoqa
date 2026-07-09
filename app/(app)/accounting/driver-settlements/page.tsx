import { withAuth } from '@workos-inc/authkit-nextjs';
import { redirect } from 'next/navigation';
import { SettlementsDashboard } from '../_components/settlements/settlements-dashboard';
import { requireWorkOS } from '@/lib/workos';

export default async function DriverSettlementsPage() {
  const { user } = await withAuth();

  if (!user) {
    redirect('/sign-in');
  }

  const workos = requireWorkOS();

  let organizationId: string | null = null;
  try {
    const memberships = await workos.userManagement.listOrganizationMemberships({
      userId: user.id,
      limit: 1,
    });
    if (memberships.data && memberships.data.length > 0) {
      organizationId = memberships.data[0].organizationId;
    }
  } catch (error) {
    console.error('Error fetching organization:', error);
  }

  return (
    <div className="flex-1 overflow-hidden">
      {organizationId && (
        <SettlementsDashboard party="driver" organizationId={organizationId} userId={user.id} />
      )}
    </div>
  );
}
