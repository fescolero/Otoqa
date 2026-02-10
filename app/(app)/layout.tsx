import { AppLayoutClient } from '@/components/app-layout-client';
import { withAuth } from '@workos-inc/authkit-nextjs';
import { redirect } from 'next/navigation';
import { fetchQuery } from 'convex/nextjs';
import { api } from '@/convex/_generated/api';
import { requireWorkOS } from '@/lib/workos';

export default async function AppLayout({ children }: { children: React.ReactNode }) {
  const { user, accessToken } = await withAuth();

  if (!user) {
    redirect('/sign-in');
  }

  const workos = requireWorkOS();

  // Get user's organization
  const memberships = await workos.userManagement.listOrganizationMemberships({
    userId: user.id,
    limit: 1,
  });

  if (!memberships.data || memberships.data.length === 0) {
    redirect('/sign-in');
  }

  const organizationId = memberships.data[0].organizationId;

  // Fetch organization settings from Convex with auth
  const orgSettings = await fetchQuery(
    api.settings.getOrgSettings,
    { workosOrgId: organizationId },
    { token: accessToken }
  );

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

  const userData = {
    name: user.firstName && user.lastName ? `${user.firstName} ${user.lastName}` : user.email,
    email: user.email,
    avatar: user.profilePictureUrl || '',
    initials: getUserInitials(
      user.firstName && user.lastName ? `${user.firstName} ${user.lastName}` : undefined,
      user.email,
    ),
  };

  return (
    <AppLayoutClient 
      user={userData} 
      organizationId={organizationId}
      orgSettings={orgSettings}
    >
      {children}
    </AppLayoutClient>
  );
}
