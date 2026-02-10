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
import { DispatchPlannerClient } from '@/components/dispatch/planner/dispatch-planner-client';
import { requireWorkOS } from '@/lib/workos';

export default async function DispatchPlannerPage() {
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
              <BreadcrumbItem className="hidden md:block">
                <BreadcrumbLink href="/dispatch">Dispatch</BreadcrumbLink>
              </BreadcrumbItem>
              <BreadcrumbSeparator className="hidden md:block" />
              <BreadcrumbItem>
                <BreadcrumbPage>Planner</BreadcrumbPage>
              </BreadcrumbItem>
            </BreadcrumbList>
          </Breadcrumb>
        </div>
      </header>

      <div className="flex-1 overflow-hidden">
        <DispatchPlannerClient
          organizationId={organizationId}
          userId={user.id}
          userName={userName}
        />
      </div>
    </>
  );
}
