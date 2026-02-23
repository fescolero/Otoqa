'use client';

import * as React from 'react';
import { AppSidebar } from '@/components/app-sidebar';
import { SidebarInset, SidebarProvider } from '@/components/ui/sidebar';
import { OrganizationProvider } from '@/contexts/organization-context';
import { identifyUser } from '@/lib/posthog';

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
  workosUserId: string;
  organizationId: string;
  orgSettings: OrgSettings | null;
  children: React.ReactNode;
}

export function AppLayoutClient({ user, workosUserId, organizationId, orgSettings, children }: AppLayoutClientProps) {
  const identifiedRef = React.useRef(false);

  React.useEffect(() => {
    if (identifiedRef.current) return;
    identifiedRef.current = true;

    identifyUser({
      id: workosUserId,
      email: user.email,
      name: user.name,
      organizationId,
      orgName: orgSettings?.name,
    });
  }, [workosUserId, user.email, user.name, organizationId, orgSettings?.name]);

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
