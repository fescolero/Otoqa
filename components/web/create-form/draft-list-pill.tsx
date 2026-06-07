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
import dynamic from 'next/dynamic';
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

/**
 * Public export. The real implementation runs client-only — see the
 * `dynamic({ ssr: false })` wrap below.
 *
 * Why client-only:
 *   The pill calls Convex's `useQuery` (via `useAuthQuery`). On the
 *   server side, `useConvexAuth()` returns `isAuthenticated: false`,
 *   so `useQuery` runs in 'skip' mode and contributes one shape to
 *   the React hook + id-counter state. On the client, after auth
 *   establishes, `useQuery` switches modes and Convex's internal
 *   subscription hooks change the React tree's `useId()` outputs.
 *   That shifts every Radix-generated `aria-controls` ID downstream,
 *   producing a hydration mismatch on the FilterBar's popover and
 *   the ColumnsButton trigger that come right after the pill in the
 *   SavedViews actions row.
 *
 *   A simple `mounted` state guard was insufficient because the
 *   pill's hooks still run on the SSR pass (they just gate the
 *   render). `next/dynamic({ ssr: false })` removes the component
 *   from the SSR tree entirely — the placeholder is a literal
 *   `null` — so the React tree is identical between SSR and the
 *   client's first paint.
 */
export const DraftListPill = dynamic(
  () => Promise.resolve(DraftListPillImpl),
  { ssr: false, loading: () => null },
);

function DraftListPillImpl({
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
