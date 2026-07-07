import { withAuth } from '@workos-inc/authkit-nextjs';
import { redirect } from 'next/navigation';
import { OcrLaneImportClient } from './_components/ocr-lane-import-client';
import { requireWorkOS } from '@/lib/workos';

export default async function OcrLaneImportPage() {
  const { user } = await withAuth();
  if (!user) redirect('/sign-in');

  const workos = requireWorkOS();
  let organization = null;
  try {
    const memberships = await workos.userManagement.listOrganizationMemberships({
      userId: user.id,
      limit: 1,
    });
    if (memberships.data && memberships.data.length > 0) {
      organization = { id: memberships.data[0].organizationId };
    }
  } catch (error) {
    console.error('Error fetching organization:', error);
  }

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="flex min-h-0 flex-1 overflow-hidden w-full">
        {organization && (
          <OcrLaneImportClient
            organizationId={organization.id}
            userId={user.id}
          />
        )}
      </div>
    </div>
  );
}
