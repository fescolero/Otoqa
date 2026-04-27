/**
 * Centralized status -> color helpers.
 *
 * Two output shapes exist across the codebase:
 *
 *   1. Tailwind class strings (e.g. "bg-green-100 text-green-800 ...") used
 *      with `<Badge variant="outline" className={...}>` and plain spans.
 *   2. Badge variant tokens ("success" | "default" | ...) used with
 *      `<Badge variant={...}>`.
 *
 * Helpers that return class strings are suffixed with `Color`. Helpers that
 * return a Badge variant are suffixed with `Variant`. Call sites should not
 * change shape — pick the helper that matches their existing JSX.
 *
 * All class-string helpers include `dark:` variants. Existing virtualized
 * tables previously used light-only classes; converging on the dark-aware
 * palette matches the list-item components and is the canonical mapping.
 */

import type { VariantProps } from 'class-variance-authority';
import type { badgeVariants } from '@/components/ui/badge';

export type BadgeVariant = NonNullable<VariantProps<typeof badgeVariants>['variant']>;

export type ExpirationStatus = 'expired' | 'expiring' | 'warning' | 'valid' | 'unknown';

// ---------------------------------------------------------------------------
// Expiration date status (license, medical, registration, insurance, etc.)
// ---------------------------------------------------------------------------

/**
 * Compute expiration status from a YYYY-MM-DD or ISO date string.
 *
 * - `expired`: date is before today
 * - `expiring`: date is within 30 days
 * - `warning`: date is within 60 days
 * - `valid`: date is more than 60 days out
 * - `unknown`: input missing or unparseable
 *
 * Parses YYYY-MM-DD as a local date to avoid timezone shifts.
 */
export function getExpirationStatus(dateString?: string): ExpirationStatus {
  if (!dateString) return 'unknown';

  const m = dateString.match(/^(\d{4})-(\d{2})-(\d{2})/);
  const date = m
    ? new Date(parseInt(m[1], 10), parseInt(m[2], 10) - 1, parseInt(m[3], 10))
    : new Date(dateString);
  if (Number.isNaN(date.getTime())) return 'unknown';
  date.setHours(0, 0, 0, 0);

  const today = new Date();
  today.setHours(0, 0, 0, 0);

  const diffDays = Math.ceil((date.getTime() - today.getTime()) / (1000 * 60 * 60 * 24));

  if (diffDays < 0) return 'expired';
  if (diffDays <= 30) return 'expiring';
  if (diffDays <= 60) return 'warning';
  return 'valid';
}

/** Tailwind classes for an expiration status badge/pill. */
export function getExpirationStatusColor(status: string): string {
  switch (status) {
    case 'expired':
      return 'bg-red-100 text-red-800 border-red-200 dark:bg-red-900 dark:text-red-200';
    case 'expiring':
      return 'bg-orange-100 text-orange-800 border-orange-200 dark:bg-orange-900 dark:text-orange-200';
    case 'warning':
      return 'bg-yellow-100 text-yellow-800 border-yellow-200 dark:bg-yellow-900 dark:text-yellow-200';
    case 'valid':
      return 'bg-green-100 text-green-800 border-green-200 dark:bg-green-900 dark:text-green-200';
    default:
      return 'bg-gray-100 text-gray-800 border-gray-200 dark:bg-gray-800 dark:text-gray-200';
  }
}

/**
 * 3-bucket expiration status (no `warning` band) used by truck/trailer tables
 * which render the bucket name verbatim. Adding a `warning` band here would
 * change user-visible text for assets in the 31–60d window.
 */
export type AssetExpirationStatus = 'expired' | 'expiring' | 'valid' | 'unknown';

export function getAssetExpirationStatus(dateString?: string): AssetExpirationStatus {
  if (!dateString) return 'unknown';
  const date = new Date(dateString);
  if (Number.isNaN(date.getTime())) return 'unknown';
  date.setHours(0, 0, 0, 0);
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  const diffDays = Math.ceil((date.getTime() - today.getTime()) / (1000 * 60 * 60 * 24));
  if (diffDays < 0) return 'expired';
  if (diffDays <= 30) return 'expiring';
  return 'valid';
}

/** Tailwind classes for the 3-bucket asset expiration status. */
export function getAssetExpirationStatusColor(status: string): string {
  switch (status) {
    case 'valid':
      return 'bg-green-100 text-green-800 border-green-200';
    case 'expiring':
      return 'bg-orange-100 text-orange-800 border-orange-200';
    case 'expired':
      return 'bg-red-100 text-red-800 border-red-200';
    default:
      return 'bg-gray-100 text-gray-800 border-gray-200';
  }
}

// ---------------------------------------------------------------------------
// Driver employment status
// ---------------------------------------------------------------------------

/** Tailwind classes for `drivers.employmentStatus` ("Active" | "Inactive" | "On Leave"). */
export function getDriverEmploymentStatusColor(status: string): string {
  switch (status) {
    case 'Active':
      return 'bg-green-100 text-green-800 border-green-200 dark:bg-green-900 dark:text-green-200';
    case 'Inactive':
      return 'bg-gray-100 text-gray-800 border-gray-200 dark:bg-gray-800 dark:text-gray-200';
    case 'On Leave':
      return 'bg-yellow-100 text-yellow-800 border-yellow-200 dark:bg-yellow-900 dark:text-yellow-200';
    default:
      return 'bg-gray-100 text-gray-800 border-gray-200 dark:bg-gray-800 dark:text-gray-200';
  }
}

// ---------------------------------------------------------------------------
// Asset (truck / trailer) status
// ---------------------------------------------------------------------------

/** Tailwind classes for truck/trailer status ("Active" | "Out of Service" | "In Repair" | "Maintenance" | "Sold"). */
export function getAssetStatusColor(status: string): string {
  switch (status) {
    case 'Active':
      return 'bg-green-100 text-green-800 border-green-200 dark:bg-green-900 dark:text-green-200';
    case 'Out of Service':
      return 'bg-red-100 text-red-800 border-red-200 dark:bg-red-900 dark:text-red-200';
    case 'In Repair':
      return 'bg-orange-100 text-orange-800 border-orange-200 dark:bg-orange-900 dark:text-orange-200';
    case 'Maintenance':
      return 'bg-yellow-100 text-yellow-800 border-yellow-200 dark:bg-yellow-900 dark:text-yellow-200';
    case 'Sold':
      return 'bg-gray-100 text-gray-800 border-gray-200 dark:bg-gray-800 dark:text-gray-200';
    default:
      return 'bg-gray-100 text-gray-800 border-gray-200 dark:bg-gray-800 dark:text-gray-200';
  }
}

// ---------------------------------------------------------------------------
// Customer status
// ---------------------------------------------------------------------------

/** Tailwind classes for customer status. */
export function getCustomerStatusColor(status: string): string {
  switch (status) {
    case 'Active':
      return 'bg-green-100 text-green-800 border-green-200 dark:bg-green-900 dark:text-green-200';
    case 'Inactive':
      return 'bg-gray-100 text-gray-800 border-gray-200 dark:bg-gray-800 dark:text-gray-200';
    case 'Prospect':
      return 'bg-yellow-100 text-yellow-800 border-yellow-200 dark:bg-yellow-900 dark:text-yellow-200';
    default:
      return 'bg-gray-100 text-gray-800 border-gray-200 dark:bg-gray-800 dark:text-gray-200';
  }
}

/** Badge variant for customer status. */
export function getCustomerStatusVariant(status: string): BadgeVariant {
  switch (status) {
    case 'Active':
      return 'success';
    case 'Prospect':
      return 'default';
    case 'Inactive':
      return 'secondary';
    default:
      return 'default';
  }
}

// ---------------------------------------------------------------------------
// Carrier status
// ---------------------------------------------------------------------------

/** Tailwind classes for carrier status (case-sensitive: "Active", "Vetting", "Suspended", "Inactive"). */
export function getCarrierStatusColor(status: string): string {
  switch (status) {
    case 'Active':
      return 'bg-green-100 text-green-800 border-green-200 dark:bg-green-900 dark:text-green-200';
    case 'Inactive':
      return 'bg-gray-100 text-gray-800 border-gray-200 dark:bg-gray-800 dark:text-gray-200';
    case 'Vetting':
      return 'bg-yellow-100 text-yellow-800 border-yellow-200 dark:bg-yellow-900 dark:text-yellow-200';
    case 'Suspended':
      return 'bg-red-100 text-red-800 border-red-200 dark:bg-red-900 dark:text-red-200';
    default:
      return 'bg-gray-100 text-gray-800 border-gray-200 dark:bg-gray-800 dark:text-gray-200';
  }
}

/**
 * Badge variant for carrier status. Handles both legacy and partnership statuses
 * (matches uppercased forms as well — INVITED, PENDING, TERMINATED).
 */
export function getCarrierStatusVariant(status: string): BadgeVariant {
  switch (status.toUpperCase()) {
    case 'ACTIVE':
      return 'success';
    case 'VETTING':
    case 'INVITED':
      return 'default';
    case 'SUSPENDED':
    case 'TERMINATED':
      return 'destructive';
    case 'INACTIVE':
    case 'PENDING':
      return 'secondary';
    default:
      return 'default';
  }
}
