import { redirect } from 'next/navigation';

/**
 * The legacy Organization Settings page is gone. Its tabs live under the
 * Settings dropdown now: General, Integrations, API partners,
 * Auto-assignment. Old links land on General. The pay-profile routes
 * under /org-settings/ are unaffected.
 */
export default function OrgSettingsRedirect() {
  redirect('/settings/general');
}
