import { redirect } from 'next/navigation';

/**
 * Settlements moved under Accounting alongside its carrier sibling:
 *   /accounting/driver-settlements   /accounting/carrier-settlements
 */
export default function SettlementsRedirect() {
  redirect('/accounting/driver-settlements');
}
