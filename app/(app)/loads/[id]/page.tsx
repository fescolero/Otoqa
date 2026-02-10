import {
  Breadcrumb,
  BreadcrumbItem,
  BreadcrumbLink,
  BreadcrumbList,
  BreadcrumbPage,
  BreadcrumbSeparator,
} from '@/components/ui/breadcrumb';
import { Separator } from '@/components/ui/separator';
import { SidebarTrigger } from '@/components/ui/sidebar';
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
    }),
  );

  return (
    <>
        <header className="flex h-16 shrink-0 items-center gap-2 transition-[width,height] ease-linear group-has-data-[collapsible=icon]/sidebar-wrapper:h-12 border-b">
          <div className="flex items-center gap-2 px-4">
            <SidebarTrigger className="-ml-1" />
            <Separator orientation="vertical" className="mr-2 data-[orientation=vertical]:h-4" />
            <Breadcrumb>
              <BreadcrumbList>
                <BreadcrumbItem className="hidden md:block">
                  <BreadcrumbLink href="/dashboard">Dashboard</BreadcrumbLink>
                </BreadcrumbItem>
                <BreadcrumbSeparator className="hidden md:block" />
                <BreadcrumbItem>
                  <BreadcrumbLink href="/loads">Loads</BreadcrumbLink>
                </BreadcrumbItem>
                <BreadcrumbSeparator className="hidden md:block" />
                <BreadcrumbItem>
                  <BreadcrumbPage>Load Details</BreadcrumbPage>
                </BreadcrumbItem>
              </BreadcrumbList>
            </Breadcrumb>
          </div>
        </header>

        <div className="flex flex-1 flex-col gap-6 p-6">
          {organization && <LoadDetail loadId={id} organizationId={organization.id} userId={user.id} />}
        </div>
      </>
  );
}
