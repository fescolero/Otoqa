'use client';

import * as React from 'react';
import { usePathname } from 'next/navigation';
import {
  Building2,
  Calculator,
  LayoutDashboard,
  Package,
  Truck,
} from 'lucide-react';

import { NavMain } from '@/components/nav-main';
import { NavUser } from '@/components/nav-user';
import { TeamSwitcher } from '@/components/team-switcher';
import { Sidebar, SidebarContent, SidebarFooter, SidebarHeader, SidebarRail } from '@/components/ui/sidebar';

const getNavData = (pathname: string) => ({
  navMain: [
    {
      title: 'Dashboard',
      url: '/dashboard',
      icon: LayoutDashboard,
      isActive: pathname === '/dashboard',
    },
    {
      title: 'Fleet Management',
      url: '#',
      icon: Truck,
      isActive: pathname.startsWith('/fleet'),
      items: [
        {
          title: 'Drivers',
          url: '/fleet/drivers',
        },
        {
          title: 'Trucks',
          url: '/fleet/trucks',
        },
        {
          title: 'Trailers',
          url: '/fleet/trailers',
        },
      ],
    },
    {
      title: 'Company Operations',
      url: '#',
      icon: Building2,
      isActive: pathname.startsWith('/operations'),
      items: [
        {
          title: 'Carriers',
          url: '/operations/carriers',
        },
        {
          title: 'Customers',
          url: '/operations/customers',
        },
        {
          title: 'Compliance',
          url: '/operations/compliance',
        },
        {
          title: 'Diesel',
          url: '/operations/diesel',
        },
      ],
    },
    {
      title: 'Load Operations',
      url: '#',
      icon: Package,
      isActive: pathname.startsWith('/loads') || pathname.startsWith('/dispatch'),
      items: [
        {
          title: 'Loads',
          url: '/loads',
        },
        {
          title: 'Dispatch Planner',
          url: '/dispatch/planner',
        },
      ],
    },
    {
      title: 'Accounting',
      url: '#',
      icon: Calculator,
      isActive: pathname.startsWith('/accounting') || pathname.startsWith('/invoices') || pathname.startsWith('/settlements'),
      items: [
        {
          title: 'Invoices',
          url: '/invoices',
        },
        {
          title: 'Driver Settlements',
          url: '/settlements',
        },
        {
          title: 'Carrier Settlements',
          url: '/accounting/carrier-settlements',
        },
        {
          title: 'Reports',
          url: '/accounting/reports',
        },
      ],
    },
  ],
});

interface OrgSettings {
  name?: string;
  logoUrl?: string | null;
  subscriptionPlan?: string;
}

const AppSidebarComponent = ({
  user,
  organizationId,
  orgSettings,
  ...props
}: React.ComponentProps<typeof Sidebar> & {
  user: {
    name: string;
    email: string;
    avatar: string;
  };
  organizationId: string;
  orgSettings: OrgSettings | null;
}) => {
  const pathname = usePathname();
  const data = getNavData(pathname);

  // Build organizations array from server-fetched data (instant, no loading!)
  const organizations = React.useMemo(() => {
    if (!orgSettings) return [];
    
    return [{
      id: organizationId,
      name: orgSettings.name || 'Organization',
      logoUrl: orgSettings.logoUrl || null,
      plan: orgSettings.subscriptionPlan || 'Enterprise'
    }];
  }, [organizationId, orgSettings?.name, orgSettings?.logoUrl, orgSettings?.subscriptionPlan]);

  return (
    <Sidebar collapsible="icon" {...props}>
      <SidebarHeader>
        {organizations.length > 0 && (
          <TeamSwitcher organizations={organizations} />
        )}
      </SidebarHeader>
      <SidebarContent>
        <NavMain items={data.navMain} />
      </SidebarContent>
      <SidebarFooter>
        <NavUser user={user} />
      </SidebarFooter>
      <SidebarRail />
    </Sidebar>
  );
};

// Memoize AppSidebar to prevent unnecessary re-renders
export const AppSidebar = React.memo(AppSidebarComponent, (prev, next) => {
  return (
    prev.user.name === next.user.name &&
    prev.user.email === next.user.email &&
    prev.user.avatar === next.user.avatar &&
    prev.organizationId === next.organizationId &&
    prev.orgSettings?.name === next.orgSettings?.name &&
    prev.orgSettings?.logoUrl === next.orgSettings?.logoUrl &&
    prev.orgSettings?.subscriptionPlan === next.orgSettings?.subscriptionPlan
  );
});
