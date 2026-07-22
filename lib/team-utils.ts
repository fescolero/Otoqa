/**
 * Pure helpers for Settings → Team & roles.
 */

import { formatDate } from '@/lib/utils/format';

/** "a@x.com, b@x.com; c@x.com" → deduped, lowercased list of addresses. */
export function parseInviteEmails(input: string): string[] {
  const seen = new Set<string>();
  for (const token of input.split(/[\s,;]+/)) {
    const email = token.trim().toLowerCase();
    if (email.includes('@') && email.includes('.') && !seen.has(email)) seen.add(email);
  }
  return [...seen];
}

/** Activity timestamp → "Active now" / "12 min ago" / "Yesterday" / date. */
export function relativeActivity(ms: number, now: number = Date.now()): string {
  const diff = now - ms;
  if (diff < 2 * 60 * 1000) return 'Active now';
  if (diff < 60 * 60 * 1000) return `${Math.floor(diff / 60000)} min ago`;
  if (diff < 24 * 60 * 60 * 1000) return `${Math.floor(diff / 3600000)} hr ago`;
  if (diff < 48 * 60 * 60 * 1000) return 'Yesterday';
  if (diff < 7 * 24 * 60 * 60 * 1000) return `${Math.floor(diff / 86400000)} days ago`;
  return formatDate(ms);
}

/** "billing-admin" → "Billing admin". Fallback label for role slugs the
 *  roles API didn't name (org- prefix stripped for readability). */
export function humanizeRoleSlug(slug: string): string {
  const cleaned = slug.replace(/^org-/, '').replace(/[-_]+/g, ' ').trim();
  return cleaned ? cleaned[0].toUpperCase() + cleaned.slice(1) : slug;
}
