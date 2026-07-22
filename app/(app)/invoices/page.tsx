import { withAuth } from '@workos-inc/authkit-nextjs';
import { redirect } from 'next/navigation';
import { InvoicesDashboard } from './_components/invoices-dashboard';
import { requireWorkOS } from '@/lib/workos';

export default async function InvoicesPage() {
  const { user } = await withAuth();

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

  // Get user initials
  const getUserInitials = (name?: string, email?: string) => {
    if (name) {
      const names = name.split(' ');
      if (names.length >= 2) {
        return `${names[0][0]}${names[1][0]}`.toUpperCase();
      }
      return name.slice(0, 2).toUpperCase();
    }
    if (email) {
      return email.slice(0, 2).toUpperCase();
    }
    return 'U';
  };

  const userData = JSON.parse(
    JSON.stringify({
      name: user.firstName && user.lastName ? `${user.firstName} ${user.lastName}` : user.email,
      email: user.email,
      avatar: user.profilePictureUrl || '',
      initials: getUserInitials(
        user.firstName && user.lastName ? `${user.firstName} ${user.lastName}` : undefined,
        user.email,
      ),
      id: user.id,
    }),
  );

  return (
    <>
      <div className="flex-1 overflow-hidden">
        {organization && <InvoicesDashboard organizationId={organization.id} userId={userData.id} />}
      </div>
    </>
  );
}
