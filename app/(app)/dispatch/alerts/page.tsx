import { withAuth } from '@workos-inc/authkit-nextjs';
import { redirect } from 'next/navigation';
import { DispatchAlertsClient } from '@/components/dispatch/alerts/dispatch-alerts-client';

/** Web surface for the dispatch alerts feed (split-plan §5.2 / D19) —
 * reads the SAME dispatchAlerts source as the mobile Notifications tab,
 * so web and mobile dispatchers see identical live state. */
export default async function DispatchAlertsPage() {
  const { user } = await withAuth();
  if (!user) redirect('/sign-in');
  return <DispatchAlertsClient />;
}
