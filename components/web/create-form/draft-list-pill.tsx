/**
 * DraftListPill — small chip surfaced on list pages (Carriers,
 * Customers, Drivers, Loads) to surface an in-flight create-form
 * draft. Renders nothing when no draft exists.
 *
 * Sits inline with the page header's primary action ("Create
 * Carrier" etc.) so the user sees it at the same moment they'd
 * decide to start a new one — "oh right, I already started this
 * yesterday" instead of starting fresh and overwriting their work.
 *
 * Discovery surface for Phase 4 drafts: until this lands, the only
 * way to find a draft is to navigate back to the create page. The
 * pill closes that gap on every list page that has a long-form
 * create flow.
 *
 * Click → navigates to the create page. The create page's existing
 * Resume banner takes over from there. This component never deletes
 * a draft directly — Discard lives on the banner, not the pill.
 */

'use client';

import * as React from 'react';
import { useRouter } from 'next/navigation';
import { api } from '@/convex/_generated/api';
import { useOrganizationId } from '@/contexts/organization-context';
import { useAuthQuery } from '@/hooks/use-auth-query';
import { WIcon } from '@/components/web/icons';

interface DraftListPillProps {
  /** Entity name — matches the schema's `entity` field. */
  entity: string;
  /** Schema's draftKey — must match the page wrapper's literal. */
  draftKey: string;
  /** Where to send the user on click — the create page's URL. */
  createHref: string;
}

export function DraftListPill({
  entity,
  draftKey,
  createHref,
}: DraftListPillProps) {
  const router = useRouter();
  const organizationId = useOrganizationId();
  const draftQ = useAuthQuery(
    api.createDrafts.getByEntity,
    organizationId
      ? { workosOrgId: organizationId, entity, draftKey }
      : 'skip',
  );

  // Nothing to surface — render nothing. Prevents an awkward flash
  // of "no drafts" copy when the user has none.
  if (!draftQ) return null;

  return (
    <button
      type="button"
      onClick={() => router.push(createHref)}
      className="focus-ring"
      title="You have an unsaved draft. Click to resume."
      style={{
        all: 'unset',
        display: 'inline-flex',
        alignItems: 'center',
        gap: 6,
        padding: '4px 10px',
        borderRadius: 999,
        // Match the autosave-error / draft-banner palette so users
        // who've seen one recognize the others.
        background: 'rgba(245, 158, 11, 0.10)',
        border: '1px solid rgba(245, 158, 11, 0.28)',
        color: '#7A4F00',
        fontSize: 11.5,
        fontWeight: 500,
        cursor: 'pointer',
      }}
    >
      <WIcon name="clock" size={11} color="#A66800" />
      <span>
        Unsaved draft{' '}
        <span style={{ color: '#A66800', fontWeight: 600 }}>
          · {formatShortRelative(draftQ.updatedAt)}
        </span>
      </span>
      <WIcon name="arrow-right" size={11} color="#A66800" />
    </button>
  );
}

/** Tight relative-time string — shorter than the create-form banner's
 *  version because the pill has less room. */
function formatShortRelative(ts: number): string {
  const ms = Date.now() - ts;
  if (ms < 60_000) return 'just now';
  if (ms < 3_600_000) return `${Math.floor(ms / 60_000)}m`;
  if (ms < 86_400_000) return `${Math.floor(ms / 3_600_000)}h`;
  return `${Math.floor(ms / 86_400_000)}d`;
}
