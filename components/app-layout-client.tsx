'use client';

import * as React from 'react';
import { AppSidebar } from '@/components/app-sidebar';
import { SidebarInset, SidebarProvider } from '@/components/ui/sidebar';
import { OrganizationProvider } from '@/contexts/organization-context';

interface OrgSettings {
  name?: string;
  logoUrl?: string | null;
  subscriptionPlan?: string;
}

interface AppLayoutClientProps {
  user: {
    name: string;
    email: string;
    avatar: string;
    initials?: string;
  };
  organizationId: string;
  orgSettings: OrgSettings | null;
  children: React.ReactNode;
}

export function AppLayoutClient({ user, organizationId, orgSettings, children }: AppLayoutClientProps) {
  return (
    <OrganizationProvider organizationId={organizationId}>
      <SidebarProvider>
        <AppSidebar 
          user={user} 
          organizationId={organizationId}
          orgSettings={orgSettings}
        />
        <SidebarInset>{children}</SidebarInset>
      </SidebarProvider>
    </OrganizationProvider>
  );
}
