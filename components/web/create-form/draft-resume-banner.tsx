/**
 * DraftResumeBanner — soft banner shown at the top of the content
 * column when the user lands on a create page that has an in-flight
 * server-side draft.
 *
 * Visible when ALL three are true:
 *   - the page wrapper passed an `initialDraft` to <CreateForm>
 *   - the user hasn't dismissed it (Resume / Discard click, or load
 *     of the next route)
 *   - the form is not already `dirty` — once a user starts typing
 *     they've implicitly chosen "fresh form", and surprising them
 *     with the draft would feel like data loss.
 *
 * The banner is intentionally calm — amber, not red, no alarm icon.
 * Resuming a draft is a normal flow, not an error state.
 */

'use client';

import * as React from 'react';
import { WBtn } from '@/components/web/btn';
import { WIcon } from '@/components/web/icons';

interface DraftResumeBannerProps {
  /** When this draft was last written. Drives the "23 minutes ago" copy. */
  updatedAt: number;
  /** User clicked Resume — apply the draft to the form. */
  onResume: () => void;
  /** User clicked Discard — delete the draft on the server. */
  onDiscard: () => void;
}

export function DraftResumeBanner({
  updatedAt,
  onResume,
  onDiscard,
}: DraftResumeBannerProps) {
  // Tick once a minute so the relative time stays current while the
  // user reads the banner. The save indicator does the same dance —
  // see header.tsx — so the cost is already on the page.
  const [, force] = React.useReducer((n: number) => n + 1, 0);
  React.useEffect(() => {
    const id = setInterval(() => force(), 60_000);
    return () => clearInterval(id);
  }, []);

  return (
    <div
      role="status"
      style={{
        display: 'flex',
        alignItems: 'center',
        gap: 12,
        padding: '10px 14px',
        marginBottom: 16,
        background: 'rgba(245, 158, 11, 0.08)',
        border: '1px solid rgba(245, 158, 11, 0.28)',
        borderRadius: 8,
      }}
    >
      <WIcon name="clock" size={14} color="#A66800" />
      <span
        style={{
          fontSize: 12.5,
          color: '#7A4F00',
          lineHeight: 1.4,
          flex: 1,
          minWidth: 0,
        }}
      >
        You have an unsaved draft from{' '}
        <strong style={{ fontWeight: 600 }}>{formatRelative(updatedAt)}</strong>
        . The form is locked until you{' '}
        <strong style={{ fontWeight: 600 }}>Resume</strong> the draft
        or <strong style={{ fontWeight: 600 }}>Discard</strong> it to
        start fresh — this prevents accidentally overwriting it.
      </span>
      <WBtn size="xs" variant="secondary" onClick={onResume}>
        Resume
      </WBtn>
      <WBtn size="xs" variant="ghost" onClick={onDiscard}>
        Discard
      </WBtn>
    </div>
  );
}

function formatRelative(timestamp: number): string {
  const ms = Date.now() - timestamp;
  if (ms < 60_000) return 'just now';
  if (ms < 3_600_000) {
    const m = Math.floor(ms / 60_000);
    return `${m} minute${m === 1 ? '' : 's'} ago`;
  }
  if (ms < 86_400_000) {
    const h = Math.floor(ms / 3_600_000);
    return `${h} hour${h === 1 ? '' : 's'} ago`;
  }
  const d = Math.floor(ms / 86_400_000);
  return `${d} day${d === 1 ? '' : 's'} ago`;
}
