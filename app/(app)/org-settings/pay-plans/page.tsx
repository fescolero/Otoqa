import { redirect } from 'next/navigation';

/**
 * Pay plans is no longer its own page — the cadence manager is a modal over
 * the Pay profiles list (design: PayPlansModal). Keep the route for old
 * links/bookmarks and land them there with the modal open.
 */
export default function PayPlansRedirect() {
  redirect('/org-settings/pay-profiles?pay-plans=open');
}
