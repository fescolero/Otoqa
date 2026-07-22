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
import { useQuery } from 'convex/react';
import { api } from '@/convex/_generated/api';
import { OrganizationProvider, useOrganizationId } from '@/contexts/organization-context';
import { GoogleMapsProvider } from '@/contexts/google-maps-context';
import { Avatar, OrgMark } from '@/components/web';
import { setOrgFormatPrefs } from '@/lib/org-format';
import { identifyUser } from '@/lib/posthog';
import { CommandPalette, useCmdkShortcut } from './command-palette';
import { Sidebar } from './sidebar';
import { Topbar } from './topbar';
import { UiPreferencesProvider } from './use-user-preferences';

interface OrgSettings {
  name?: string;
  logoUrl?: string | null;
  logoTraits?: { tone: 'dark' | 'light' | 'colorful'; hasAlpha: boolean } | null;
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

  // Live org subscription — the server-rendered `orgSettings` prop is a
  // snapshot from the layout; subscribing here keeps the sidebar name/logo
  // in sync when they're edited on Settings → General. Falls back to the
  // snapshot while the client query loads.
  const organizationId = useOrganizationId();
  const liveOrgSettings = useQuery(api.settings.getOrgSettings, { workosOrgId: organizationId });
  const org = liveOrgSettings === undefined ? orgSettings : liveOrgSettings;

  // Publish the workspace's Regional & formats preferences so the shared
  // formatters (lib/utils/format.ts → lib/org-format.ts) and calendar
  // pickers respect them everywhere.
  React.useEffect(() => {
    if (liveOrgSettings === undefined) return;
    setOrgFormatPrefs({
      dateFormat: liveOrgSettings?.dateFormat,
      numberFormat: liveOrgSettings?.numberFormat,
      distanceUnit: liveOrgSettings?.distanceUnit,
      weekStart: liveOrgSettings?.weekStart,
      currency: liveOrgSettings?.defaultCurrency,
    });
  }, [liveOrgSettings]);

  const orgName = org?.name ?? 'Organization';

  return (
    <div className="flex h-screen w-screen overflow-hidden bg-background text-foreground">
      <Sidebar
        onCmdk={() => setCmdkOpen(true)}
        header={
          <span className="flex items-center gap-2 min-w-0">
            <OrgMark name={orgName} logoUrl={org?.logoUrl} logoTraits={org?.logoTraits} size={28} />
            <span className="flex flex-col min-w-0 leading-tight">
              <span className="text-[12.5px] font-semibold text-foreground truncate">{orgName}</span>
              {org?.subscriptionPlan && (
                <span className="text-[10.5px] text-[var(--text-tertiary)] truncate">{org.subscriptionPlan}</span>
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
