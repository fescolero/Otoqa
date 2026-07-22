import { withAuth } from '@workos-inc/authkit-nextjs';
import { redirect } from 'next/navigation';
import { DispatchScheduleClient } from '@/components/dispatch/schedule/dispatch-schedule-client';
import { requireWorkOS } from '@/lib/workos';

export default async function DispatchSchedulePage() {
  const { user } = await withAuth();

  if (!user) {
    redirect('/sign-in');
  }

  const workos = requireWorkOS();

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

  return (
    <div className="flex-1 overflow-hidden">
      <DispatchScheduleClient organizationId={organizationId} />
    </div>
  );
}
