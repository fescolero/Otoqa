/**
 * Shared formatting utilities.
 *
 * All of these delegate to `lib/org-format.ts`, so they respect the
 * workspace's Regional & formats preferences (Settings → General): number
 * separators, default currency, distance units, and date format. With no
 * preferences set they behave exactly as the original en-US versions.
 */

import {
  orgFormatCurrency,
  orgFormatDate,
  orgFormatDistance,
  orgFormatNumber,
} from '@/lib/org-format';

export function formatCurrency(amount: number, currency?: string): string {
  return orgFormatCurrency(amount, currency);
}

export function formatNumber(n: number, decimals: number = 0): string {
  return orgFormatNumber(n, decimals);
}

export function formatPercent(n: number, decimals: number = 1): string {
  return orgFormatNumber(n, decimals) + '%';
}

/** `n` is miles (the stored unit); renders in the workspace distance unit. */
export function formatMiles(n: number): string {
  return orgFormatDistance(n);
}

export function formatDate(timestamp: number): string {
  return orgFormatDate(timestamp, 'long');
}

export function formatDateShort(timestamp: number): string {
  return orgFormatDate(timestamp, 'short');
}
