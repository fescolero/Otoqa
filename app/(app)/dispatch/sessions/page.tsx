'use client';

/**
 * /dispatch/sessions — Active driver sessions live ops.
 *
 * This route previously rendered a flat table with "Force End" actions.
 * It now hosts the full live-ops experience from the Otoqa Web design
 * bundle: search + filter chips + status-grouped accordion on the left,
 * a Google-Maps surface with clustered driver pins on the right, and a
 * slide-in activity panel with Trips + GPS pings tabs when a driver is
 * selected.
 *
 * See `components/web/sessions/active-sessions-page.tsx` for the layout
 * and `convex/sessionsLiveOps.ts` for the server queries that back it.
 */

import { ActiveSessionsPage } from '@/components/web/sessions';

export default function DispatchSessionsPage() {
  return <ActiveSessionsPage />;
}
