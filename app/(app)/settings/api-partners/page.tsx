'use client';

/**
 * Settings → API partners.
 *
 * Keys, webhooks, health and the request audit log for partners that
 * integrate against Otoqa's API. Same PartnerApiSettings panel the legacy
 * /org-settings "API Partners" tab rendered — only the doorway moved into
 * the Settings dropdown.
 */

import * as React from 'react';
import { useOrganizationId } from '@/contexts/organization-context';
import { SettingsHeader } from '@/components/web';
import { PartnerApiSettings } from '@/components/partner-api-settings';

export default function ApiPartnersSettingsPage() {
  const organizationId = useOrganizationId();

  return (
    <div className="flex-1 flex flex-col min-h-0 overflow-auto bg-[var(--bg-canvas)]">
      <SettingsHeader
        eyebrow="Settings"
        title="API partners"
        subtitle="API keys, webhooks, and request health for partners integrating against your workspace."
      />
      <div className="px-6 py-6 max-w-[1100px]">
        {organizationId ? (
          <PartnerApiSettings organizationId={organizationId} />
        ) : (
          <div className="text-sm text-muted-foreground">Loading…</div>
        )}
      </div>
    </div>
  );
}
