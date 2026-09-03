/**
 * Settings → Company file — the org's OWN compliance documents (COI, W-9,
 * operating authority, …), documents-storage-spec.md §6.
 *
 * For a carrier org linked to brokers, documents of a shared-by-default
 * type appear read-only on every linked broker's partnership page unless
 * withheld here per document. Which types are shared by default is set on
 * Settings › Documents (Company tab).
 */
'use client';

import * as React from 'react';
import { SettingsHeader } from '@/components/web';
import { useOrganizationId } from '@/contexts/organization-context';
import { EntityDocumentsTab } from '@/components/web/documents/entity-documents-tab';
import { ExportAllDocumentsButton } from '@/components/web/documents/export-all-documents-button';
import { usePermissions } from '@/lib/use-permissions';

export default function CompanyDocumentsPage() {
  const organizationId = useOrganizationId();
  const { can } = usePermissions();

  return (
    <div className="flex flex-col gap-4">
      <SettingsHeader
        eyebrow="Settings"
        title="Company file"
        subtitle="Your organization's own compliance documents. Shared types are visible to brokers you are linked with; withhold any document individually."
        actions={can('settings', 'manage') ? <ExportAllDocumentsButton /> : null}
      />
      {organizationId ? (
        <EntityDocumentsTab entity="organization" entityId={organizationId} entityName="Company" />
      ) : (
        <div className="px-4 py-8 text-center text-[12.5px] text-[var(--text-tertiary)]">Loading…</div>
      )}
    </div>
  );
}
