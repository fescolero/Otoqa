'use client';

import { useEffect } from 'react';

// Once per tab: the directory changes only when org membership does, so
// repeat requests within a tab's lifetime would be wasted work.
let syncRequested = false;

/**
 * Self-heal trigger for the Convex org member directory. Audit UIs call
 * this when their (server-enriched) data still contains a raw WorkOS user
 * ID, which means the caller's org hasn't been synced since the directory
 * was introduced (sync normally happens at login). Fires the sync at most
 * once per tab; when it lands, Convex reactivity re-delivers the queries
 * with names resolved.
 */
export function useOrgMemberSync(hasUnresolvedIds: boolean): void {
  useEffect(() => {
    if (!hasUnresolvedIds || syncRequested) return;
    syncRequested = true;
    fetch('/api/organization/members/sync', { method: 'POST' }).catch(() => {
      // Retry on next mount that still sees unresolved IDs.
      syncRequested = false;
    });
  }, [hasUnresolvedIds]);
}
