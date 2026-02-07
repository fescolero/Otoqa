'use client';

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
import { useAuth } from '@workos-inc/authkit-nextjs/components';
import { OrgSettingsTabs } from '@/components/org-settings-tabs';
import { useEffect, useState } from 'react';
import { useOrganizationId } from '@/contexts/organization-context';

interface Organization {
  id: string;
  name: string;
  domains?: Array<{ id: string; domain: string }>;
  createdAt?: string;
  updatedAt?: string;
}

export default function OrgSettingsPage() {
  const { user } = useAuth();
  const organizationId = useOrganizationId();
  const [organization, setOrganization] = useState<Organization | null>(null);

  // Fetch organization data client-side for additional details
  useEffect(() => {
    async function fetchOrganization() {
      if (!user?.id) return;

      try {
        const response = await fetch('/api/organization');
        const data = await response.json();

        if (data.organizationId) {
          setOrganization({
            id: data.organizationId,
            name: data.name || 'Organization',
            domains: data.domains || [],
            createdAt: data.createdAt,
            updatedAt: data.updatedAt,
          });
        }
      } catch (error) {
        console.error('Error fetching organization:', error);
      }
    }

    fetchOrganization();
  }, [user]);

  // Get user initials for avatar fallback
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

  // Prepare user data for sidebar
  const userData = user
    ? {
        name: user.firstName && user.lastName ? `${user.firstName} ${user.lastName}` : user.email,
        email: user.email,
        avatar: user.profilePictureUrl || '',
        initials: getUserInitials(
          user.firstName && user.lastName ? `${user.firstName} ${user.lastName}` : undefined,
          user.email,
        ),
      }
    : {
        name: 'Guest',
        email: 'guest@example.com',
        avatar: '',
        initials: 'GU',
      };

  // Prepare user object for OrgSettingsTabs
  const serializedUser = user
    ? {
        id: user.id,
        firstName: user.firstName ?? undefined,
        lastName: user.lastName ?? undefined,
        email: user.email,
        profilePictureUrl: user.profilePictureUrl ?? undefined,
      }
    : null;

  // Middleware already protects this route - user is guaranteed to exist
  // Render immediately - data will load via useQuery in child components
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
                  <BreadcrumbPage>Organization Settings</BreadcrumbPage>
                </BreadcrumbItem>
              </BreadcrumbList>
            </Breadcrumb>
          </div>
        </header>

        <div className="flex flex-1 flex-col gap-6 p-6">
          {/* Page Header */}
          <div>
            <h1 className="text-3xl font-bold tracking-tight">Organization Settings</h1>
            <p className="text-muted-foreground">Manage your organization&apos;s settings and members</p>
          </div>

          {/* Tabs */}
          {serializedUser && <OrgSettingsTabs organization={organization} user={serializedUser} />}
        </div>
      </>
  );
}
