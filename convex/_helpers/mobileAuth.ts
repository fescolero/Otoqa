/**
 * Shared helpers for mobile (driver/carrier) auth flows.
 *
 * Internal-only — not a Convex query/mutation/action. Safe to import from
 * any convex/*.ts file.
 */

/**
 * Normalize a phone number to its 10-digit US form for comparison.
 * Handles +17607553340, 17607553340, 7607553340, +1760-755-3340, (760) 755-3340, etc.
 */
export function normalizePhoneForMatch(phone: string): string {
  const digits = phone.replace(/\D/g, '');
  if (digits.length === 11 && digits.startsWith('1')) {
    return digits.slice(1);
  }
  return digits;
}
