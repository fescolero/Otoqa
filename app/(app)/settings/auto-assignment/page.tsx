'use client';

/**
 * Settings → Auto-assignment.
 *
 * The org-level knobs for the auto-assignment engine: master switch, the
 * two triggers (on import / scheduled), the assignment horizon, and the
 * last scheduled run's outcome. The rules themselves live on the
 * Auto-assignments page (/route-assignments); this is where you decide
 * WHEN the engine acts on them.
 *
 * Replaces the Automation tab of the legacy /org-settings page. Same
 * component, same data (api.routeAssignments.getSettings /
 * updateSettings) — only the doorway moved into the Settings dropdown.
 */

import * as React from 'react';
import { useRouter } from 'next/navigation';
import { useAuth } from '@workos-inc/authkit-nextjs/components';
import { useOrganizationId } from '@/contexts/organization-context';
import { SettingsHeader, WBtn } from '@/components/web';
import { AutoAssignmentSettings } from '@/components/auto-assignment-settings';

export default function AutoAssignmentSettingsPage() {
  const organizationId = useOrganizationId();
  const { user } = useAuth();
  const router = useRouter();

  return (
    <div className="flex-1 flex flex-col min-h-0 overflow-auto bg-[var(--bg-canvas)]">
      <SettingsHeader
        eyebrow="Settings"
        title="Auto-assignment"
        subtitle="When the engine acts on your route rules: on import, on a schedule, and how far ahead of pickup. The rules themselves are managed on the Auto-assignments page."
        actions={
          <WBtn size="sm" leading="route" onClick={() => router.push('/route-assignments')}>
            Manage rules
          </WBtn>
        }
      />

      <div className="px-6 py-6 max-w-[880px]">
        {organizationId && user?.id ? (
          <AutoAssignmentSettings organizationId={organizationId} userId={user.id} />
        ) : (
          <div className="text-sm text-muted-foreground">Loading…</div>
        )}
      </div>
    </div>
  );
}
