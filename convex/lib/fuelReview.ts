/**
 * Review disposition for a fuel / DEF purchase.
 *
 * An exception (price anomaly, missing receipt, off-card payment, …) is
 * only useful while somebody still has to look at it. Once a person has
 * looked, the entry carries a `review` and the reports stop counting it
 * as an exception — whatever the status, the human has taken the
 * decision the flag was asking for.
 *
 *   OK                 looked at it, the purchase is fine as recorded
 *   CORRECTED          the entry was wrong and has been fixed
 *   DRIVER_FOLLOW_UP   the purchase is being taken up with the driver
 *
 * Editing the figures the review judged (gallons, price, payment,
 * receipt, load) clears it, so a stale "OK" can never hide a later
 * change. See fuelEntries.update / defEntries.update.
 */

import { v, type Infer } from 'convex/values';

export const REVIEW_STATUSES = ['OK', 'CORRECTED', 'DRIVER_FOLLOW_UP'] as const;
export type ReviewStatus = (typeof REVIEW_STATUSES)[number];

export const reviewStatusValidator = v.union(
  v.literal('OK'),
  v.literal('CORRECTED'),
  v.literal('DRIVER_FOLLOW_UP'),
);

export const reviewValidator = v.object({
  status: reviewStatusValidator,
  reviewedAt: v.number(),
  /** Identity subject of the reviewer. */
  reviewedBy: v.string(),
  /** Display name at review time, so the page needn't resolve users. */
  reviewedByName: v.optional(v.string()),
  note: v.optional(v.string()),
});
export type EntryReview = Infer<typeof reviewValidator>;

export const REVIEW_LABELS: Record<ReviewStatus, string> = {
  OK: 'Reviewed OK',
  CORRECTED: 'Corrected',
  DRIVER_FOLLOW_UP: 'Driver follow-up',
};

/**
 * Fields whose change invalidates an existing review. Anything else
 * (notes, odometer, a re-typed city) leaves the decision standing.
 */
export const REVIEW_SENSITIVE_FIELDS = [
  'gallons',
  'pricePerGallon',
  'entryDate',
  'vendorId',
  'paymentMethod',
  'receiptStorageId',
  'loadId',
] as const;
