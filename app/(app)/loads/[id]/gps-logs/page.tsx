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
                <BreadcrumbLink href={`/loads/${id}`}>Load Details</BreadcrumbLink>
              </BreadcrumbItem>
              <BreadcrumbSeparator className="hidden md:block" />
              <BreadcrumbItem>
                <BreadcrumbPage>GPS Logs</BreadcrumbPage>
              </BreadcrumbItem>
            </BreadcrumbList>
          </Breadcrumb>
        </div>
      </header>

      <div className="flex flex-1 flex-col gap-6 p-6">
        {organization && (
          <GpsLogsView loadId={id} organizationId={organization.id} />
        )}
      </div>
    </>
  );
}
