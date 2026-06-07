/**
 * AppShell — top-level Otoqa Web layout.
 *
 * Wraps children in OrganizationProvider + GoogleMapsProvider (preserving
 * existing behavior), mounts the new Sidebar + Topbar, and provides the
 * UiPreferencesProvider so density / theme / sidebar mode persist per user.
 *
 * Replaces components/app-layout-client.tsx wholesale. Page content lives
 * inside <main> as a normal scrolling region.
 */

'use client';

import * as React from 'react';
import { OrganizationProvider } from '@/contexts/organization-context';
import { GoogleMapsProvider } from '@/contexts/google-maps-context';
import { Avatar } from '@/components/web';
import { identifyUser } from '@/lib/posthog';
import { CommandPalette, useCmdkShortcut } from './command-palette';
import { Sidebar } from './sidebar';
import { Topbar } from './topbar';
import { UiPreferencesProvider } from './use-user-preferences';

interface OrgSettings {
  name?: string;
  logoUrl?: string | null;
  subscriptionPlan?: string;
}

export interface AppShellProps {
  user: { name: string; email: string; avatar: string; initials?: string };
  workosUserId: string;
  organizationId: string;
  orgSettings: OrgSettings | null;
  googleMapsApiKey?: string;
  children: React.ReactNode;
}

export function AppShell({
  user,
  workosUserId,
  organizationId,
  orgSettings,
  googleMapsApiKey,
  children,
}: AppShellProps) {
  // Identify user with PostHog once per mount — same pattern as the legacy
  // AppLayoutClient.
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
      <GoogleMapsProvider apiKey={googleMapsApiKey}>
        <UiPreferencesProvider>
          <ShellLayout user={user} orgSettings={orgSettings}>
            {children}
          </ShellLayout>
        </UiPreferencesProvider>
      </GoogleMapsProvider>
    </OrganizationProvider>
  );
}

function ShellLayout({
  user,
  orgSettings,
  children,
}: {
  user: AppShellProps['user'];
  orgSettings: OrgSettings | null;
  children: React.ReactNode;
}) {
  const [cmdkOpen, setCmdkOpen] = React.useState(false);
  useCmdkShortcut(setCmdkOpen);

  const orgName = orgSettings?.name ?? 'Organization';
  const orgInitials = orgName
    .split(' ')
    .map((s) => s[0] ?? '')
    .slice(0, 1)
    .join('')
    .toUpperCase();

  return (
    <div className="flex h-screen w-screen overflow-hidden bg-background text-foreground">
      <Sidebar
        onCmdk={() => setCmdkOpen(true)}
        header={
          <span className="flex items-center gap-2 min-w-0">
            <span
              className="h-7 w-7 rounded-md inline-flex items-center justify-center text-white text-[12px] font-semibold shrink-0"
              style={{ background: 'var(--accent)' }}
            >
              {orgInitials}
            </span>
            <span className="flex flex-col min-w-0 leading-tight">
              <span className="text-[12.5px] font-semibold text-foreground truncate">{orgName}</span>
              {orgSettings?.subscriptionPlan && (
                <span className="text-[10.5px] text-[var(--text-tertiary)] truncate">{orgSettings.subscriptionPlan}</span>
              )}
            </span>
          </span>
        }
        footer={
          <span className="flex items-center gap-2 min-w-0">
            <Avatar name={user.name} size={28} />
            <span className="flex flex-col min-w-0 leading-tight">
              <span className="text-[12.5px] font-medium text-foreground truncate">{user.name}</span>
              <span className="text-[10.5px] text-[var(--text-tertiary)] truncate">{user.email}</span>
            </span>
          </span>
        }
      />
      {/* `min-h-0` is load-bearing: without it, the flex-col can't
          shrink below its content, so a child <main> with `flex-1
          min-h-0 overflow-hidden` (e.g. on a tall create-form page)
          ends up sized to its content instead of to the viewport — and
          its own scroll context never engages. Every detail/list page
          already has its own overflow boundary so adding this here is
          a no-op for them; the create-form rollout was the first
          screen to surface the bug. */}
      <div className="flex-1 flex flex-col min-w-0 min-h-0">
        <Topbar onCmdk={() => setCmdkOpen(true)} />
        {/* main is a flex column with no scroll of its own — pages own
            their scroll context. Migrated screens (e.g. DriversList) use
            a flex-col layout with sticky chrome (PageHeader / SavedViews /
            TableToolbar) at the top and the Table managing internal
            overflow. Legacy screens that expect main to scroll wrap
            themselves in <main className="flex-1 overflow-auto"> already. */}
        <main className="flex-1 flex flex-col min-h-0 overflow-hidden relative">{children}</main>
      </div>
      <CommandPalette open={cmdkOpen} onOpenChange={setCmdkOpen} />
    </div>
  );
}
