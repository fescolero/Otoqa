/**
 * Shared date utilities for Convex backend functions.
 *
 * IMPORTANT: These helpers never call Date.now() or new Date() without
 * arguments. Convex queries must be deterministic — the current time
 * must be passed in as a parameter from the caller.
 */

const MS_PER_DAY = 1000 * 60 * 60 * 24;

/**
 * Parse a YYYY-MM-DD string into its numeric components.
 * Returns null if the string doesn't match the expected format.
 */
export function parseDateString(
  dateStr: string
): { year: number; month: number; day: number } | null {
  const m = dateStr.match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (!m) return null;
  return {
    year: parseInt(m[1], 10),
    month: parseInt(m[2], 10),
    day: parseInt(m[3], 10),
  };
}

/**
 * Convert a YYYY-MM-DD string to a UTC-midnight timestamp (ms).
 * Returns null if parsing fails.
 */
export function dateStringToUtcMs(dateStr: string): number | null {
  const parts = parseDateString(dateStr);
  if (!parts) return null;
  return Date.UTC(parts.year, parts.month - 1, parts.day);
}

/**
 * Compute the number of calendar days between two YYYY-MM-DD strings.
 * Positive means `dateStr` is in the future relative to `referenceStr`.
 */
export function diffCalendarDays(
  dateStr: string,
  referenceStr: string
): number | null {
  const dateMs = dateStringToUtcMs(dateStr);
  const refMs = dateStringToUtcMs(referenceStr);
  if (dateMs === null || refMs === null) return null;
  return Math.ceil((dateMs - refMs) / MS_PER_DAY);
}

type DateStatus = 'expired' | 'expiring' | 'warning' | 'valid';

/**
 * Determine the expiration status of a date-only string relative to today.
 *
 * @param dateStr   YYYY-MM-DD string (e.g. licenseExpiration)
 * @param todayStr  YYYY-MM-DD string representing "today" — must be passed
 *                  by the caller so queries remain deterministic.
 */
export function getDateStatus(
  dateStr: string | undefined,
  todayStr: string
): DateStatus {
  if (!dateStr) return 'valid';

  const diff = diffCalendarDays(dateStr, todayStr);
  if (diff === null) return 'valid';

  if (diff < 0) return 'expired';
  if (diff <= 30) return 'expiring';
  if (diff <= 60) return 'warning';
  return 'valid';
}

type ExpirationStatus = 'expired' | 'expiring' | 'valid' | 'unknown';

/**
 * Determine the expiration status for fleet assets (trailers, trucks).
 * Same logic as getDateStatus but returns 'unknown' for missing dates
 * and omits the 'warning' tier.
 */
export function getExpirationStatus(
  dateStr: string | undefined,
  todayStr: string
): ExpirationStatus {
  if (!dateStr) return 'unknown';

  const diff = diffCalendarDays(dateStr, todayStr);
  if (diff === null) return 'unknown';

  if (diff < 0) return 'expired';
  if (diff <= 30) return 'expiring';
  return 'valid';
}

/**
 * Build a YYYY-MM-DD string from a UTC timestamp (ms).
 * Useful for converting Date.now() on the client into a date string
 * to pass as a query argument.
 */
export function utcMsToDateString(timestampMs: number): string {
  const d = new Date(timestampMs);
  const year = d.getUTCFullYear();
  const month = String(d.getUTCMonth() + 1).padStart(2, '0');
  const day = String(d.getUTCDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}
