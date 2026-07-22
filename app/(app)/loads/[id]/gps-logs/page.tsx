import { withAuth } from '@workos-inc/authkit-nextjs';
import { redirect } from 'next/navigation';
import { requireWorkOS } from '@/lib/workos';
import { GpsLogsView } from '@/components/dispatch/gps-logs-view';

export default async function GpsLogsPage({ params }: { params: Promise<{ id: string }> }) {
  const { user } = await withAuth();
  const { id } = await params;

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

  return (
    <>
      <div className="flex flex-1 flex-col gap-6 p-6">
        {organization && (
          <GpsLogsView loadId={id} organizationId={organization.id} />
        )}
      </div>
    </>
  );
}
