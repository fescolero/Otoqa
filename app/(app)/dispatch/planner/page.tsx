import { withAuth } from '@workos-inc/authkit-nextjs';
import { redirect } from 'next/navigation';
import { DispatchPlannerClient } from '@/components/dispatch/planner/dispatch-planner-client';
import { requireWorkOS } from '@/lib/workos';

export default async function DispatchPlannerPage({
  searchParams,
}: {
  searchParams: Promise<{ order?: string }>;
}) {
  const { order } = await searchParams;
  const { user } = await withAuth();

  if (!user) {
    redirect('/sign-in');
  }

  const workos = requireWorkOS();

  // Fetch organization data
  let organizationId = '';
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

  if (!organizationId) {
    redirect('/sign-in');
  }

  const userName = user.firstName && user.lastName 
    ? `${user.firstName} ${user.lastName}` 
    : user.email || 'Unknown User';

  return (
    <>
      <div className="flex-1 overflow-hidden">
        <DispatchPlannerClient
          organizationId={organizationId}
          userId={user.id}
          userName={userName}
          initialSearch={order}
        />
      </div>
    </>
  );
}
