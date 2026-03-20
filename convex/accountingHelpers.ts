/**
 * Shared helper functions for accounting reports
 *
 * These helpers are used by accountingReports.ts queries to derive
 * calculated values that don't exist as stored fields.
 */

import { QueryCtx } from './_generated/server';
import { Doc, Id } from './_generated/dataModel';

// ============================================
// PAYMENT TERMS CONSTANTS
// ============================================

const PAYMENT_TERMS_DAYS: Record<string, number> = {
  NET_15: 15,
  NET_30: 30,
  NET_45: 45,
  NET_60: 60,
  NET_90: 90,
  DUE_ON_RECEIPT: 0,
};

const DEFAULT_NET_DAYS = 30;

// ============================================
// DUE DATE CALCULATION
// ============================================

/**
 * Calculate the effective due date for an invoice.
 * Cascade:
 * 1. Explicit dueDate on invoice
 * 2. Customer paymentTerms + invoice date
 * 3. Default Net-30 from invoice date
 * 4. Fallback: createdAt + 30 days
 */
export function getEffectiveDueDate(
  invoice: {
    dueDate?: string;
    invoiceDateNumeric?: number;
    createdAt: number;
  },
  customer?: { paymentTerms?: string } | null,
): number {
  // 1. Explicit due date on the invoice
  if (invoice.dueDate) {
    const parsed = new Date(invoice.dueDate).getTime();
    if (!isNaN(parsed)) return parsed;
  }

  // Base date for calculating terms
  const baseDate = invoice.invoiceDateNumeric ?? invoice.createdAt;

  // 2. Customer-specific payment terms
  if (customer?.paymentTerms && customer.paymentTerms in PAYMENT_TERMS_DAYS) {
    const days = PAYMENT_TERMS_DAYS[customer.paymentTerms];
    return baseDate + days * 24 * 60 * 60 * 1000;
  }

  // 3. Default Net-30
  return baseDate + DEFAULT_NET_DAYS * 24 * 60 * 60 * 1000;
}

/**
 * Calculate days outstanding from a base date to now.
 */
export function getDaysOutstanding(invoiceDateTimestamp: number): number {
  const now = Date.now();
  const diff = now - invoiceDateTimestamp;
  return Math.max(0, Math.floor(diff / (24 * 60 * 60 * 1000)));
}

/**
 * Calculate average days to payment from invoice date to payment date.
 */
export function getDaysToPayment(
  invoiceDateTimestamp: number,
  paymentDateStr?: string,
  updatedAt?: number,
): number | null {
  let paymentTimestamp: number | null = null;

  if (paymentDateStr) {
    const parsed = new Date(paymentDateStr).getTime();
    if (!isNaN(parsed)) paymentTimestamp = parsed;
  }

  if (!paymentTimestamp && updatedAt) {
    paymentTimestamp = updatedAt;
  }

  if (!paymentTimestamp) return null;

  const diff = paymentTimestamp - invoiceDateTimestamp;
  return Math.max(0, Math.floor(diff / (24 * 60 * 60 * 1000)));
}

// ============================================
// LANE LABEL EXTRACTION
// ============================================

/**
 * Extract a human-readable lane label from a contract lane's stops array.
 * Returns "City, ST -> City, ST" or the contract name as fallback.
 */
export function extractLaneLabel(
  contractLane?: {
    contractName?: string;
    stops?: Array<{
      city: string;
      state: string;
      stopOrder: number;
      stopType: string;
    }>;
  } | null,
): string {
  if (!contractLane) return 'N/A';

  const stops = contractLane.stops;
  if (!stops || stops.length === 0) {
    return contractLane.contractName || 'N/A';
  }

  const pickups = stops.filter((s) => s.stopType === 'Pickup').sort((a, b) => a.stopOrder - b.stopOrder);
  const deliveries = stops.filter((s) => s.stopType === 'Delivery').sort((a, b) => a.stopOrder - b.stopOrder);

  const origin = pickups[0];
  const dest = deliveries[deliveries.length - 1];

  if (origin && dest) {
    return `${origin.city}, ${origin.state} \u2192 ${dest.city}, ${dest.state}`;
  }

  return contractLane.contractName || 'N/A';
}

// ============================================
// LOAD DELIVERY DATE
// ============================================

/**
 * Get the delivery date for a load.
 * Cascade:
 * 1. load.deliveredAt (denormalized, set on Completed transition)
 * 2. Last delivery stop's checkedOutAt
 * 3. Last delivery stop's windowEndTime
 * 4. load.firstStopDate (approximate)
 * 5. load.createdAt (final fallback)
 */
export async function getLoadDeliveryDate(
  ctx: QueryCtx,
  load: {
    _id: Id<'loadInformation'>;
    deliveredAt?: number;
    firstStopDate?: string;
    createdAt: number;
  },
): Promise<number> {
  // 1. Denormalized delivery timestamp
  if (load.deliveredAt) return load.deliveredAt;

  // 2-3. Query last delivery stop
  const stops = await ctx.db
    .query('loadStops')
    .withIndex('by_load', (q) => q.eq('loadId', load._id))
    .collect();

  const deliveryStops = stops
    .filter((s) => s.stopType === 'DELIVERY')
    .sort((a, b) => b.sequenceNumber - a.sequenceNumber);

  if (deliveryStops.length > 0) {
    const lastDelivery = deliveryStops[0];

    if (lastDelivery.checkedOutAt) {
      const parsed = new Date(lastDelivery.checkedOutAt).getTime();
      if (!isNaN(parsed)) return parsed;
    }

    if (lastDelivery.windowEndTime) {
      const parsed = new Date(lastDelivery.windowEndTime).getTime();
      if (!isNaN(parsed)) return parsed;
    }

    if (lastDelivery.windowBeginTime) {
      const parsed = new Date(lastDelivery.windowBeginTime).getTime();
      if (!isNaN(parsed)) return parsed;
    }
  }

  // 4. Approximate from first stop date
  if (load.firstStopDate) {
    const parsed = new Date(load.firstStopDate).getTime();
    if (!isNaN(parsed)) return parsed;
  }

  // 5. Final fallback
  return load.createdAt;
}

// ============================================
// FUEL COST ESTIMATION
// ============================================

export type FuelCostResult = {
  amount: number | null;
  source: 'ACTUAL' | 'ESTIMATED' | 'NO_DATA';
};

/**
 * Estimate fuel cost for a load.
 * 1. Check for fuel entries directly linked to the load
 * 2. Else estimate from truck's cost-per-mile * load miles
 */
export async function estimateFuelCostForLoad(
  ctx: QueryCtx,
  loadId: Id<'loadInformation'>,
  loadMiles: number | undefined,
  truckCostPerMileCache: Map<string, number | null>,
  dateRangeStart?: number,
  dateRangeEnd?: number,
): Promise<FuelCostResult> {
  // 1. Check for direct fuel entries
  const directEntries = await ctx.db
    .query('fuelEntries')
    .withIndex('by_load', (q) => q.eq('loadId', loadId))
    .collect();

  if (directEntries.length > 0) {
    const total = directEntries.reduce((sum, e) => sum + e.totalCost, 0);
    return { amount: total, source: 'ACTUAL' };
  }

  // 2. Estimate from truck cost-per-mile
  if (!loadMiles || loadMiles <= 0) {
    return { amount: null, source: 'NO_DATA' };
  }

  // Find the truck via dispatch legs
  const legs = await ctx.db
    .query('dispatchLegs')
    .withIndex('by_load', (q) => q.eq('loadId', loadId))
    .collect();

  const truckIds = [...new Set(legs.filter((l) => l.truckId).map((l) => l.truckId!))];

  if (truckIds.length === 0) {
    return { amount: null, source: 'NO_DATA' };
  }

  let totalEstimatedCost = 0;
  let hasEstimate = false;

  for (const truckId of truckIds) {
    const cacheKey = truckId.toString();
    let costPerMile = truckCostPerMileCache.get(cacheKey);

    if (costPerMile === undefined) {
      // Calculate truck's cost per mile from fuel entries
      costPerMile = await calculateTruckCostPerMile(ctx, truckId, dateRangeStart, dateRangeEnd);
      truckCostPerMileCache.set(cacheKey, costPerMile);
    }

    if (costPerMile !== null) {
      // Sum miles from legs for this truck
      const truckLegs = legs.filter((l) => l.truckId === truckId);
      const truckMiles = truckLegs.reduce((sum, l) => sum + l.legLoadedMiles + l.legEmptyMiles, 0);
      totalEstimatedCost += costPerMile * truckMiles;
      hasEstimate = true;
    }
  }

  if (hasEstimate) {
    return { amount: Math.round(totalEstimatedCost * 100) / 100, source: 'ESTIMATED' };
  }

  return { amount: null, source: 'NO_DATA' };
}

/**
 * Calculate a truck's average fuel cost per mile from fuel entries.
 */
async function calculateTruckCostPerMile(
  ctx: QueryCtx,
  truckId: Id<'trucks'>,
  dateRangeStart?: number,
  dateRangeEnd?: number,
): Promise<number | null> {
  // Get fuel entries for this truck in the date range
  const entries = await ctx.db
    .query('fuelEntries')
    .withIndex('by_truck_date', (q) => {
      const q2 = q.eq('truckId', truckId);
      if (dateRangeStart && dateRangeEnd) {
        return q2.gte('entryDate', dateRangeStart).lte('entryDate', dateRangeEnd);
      } else if (dateRangeStart) {
        return q2.gte('entryDate', dateRangeStart);
      } else if (dateRangeEnd) {
        return q2.lte('entryDate', dateRangeEnd);
      }
      return q2;
    })
    .collect();
  if (entries.length === 0) return null;

  const totalCost = entries.reduce((sum, e) => sum + e.totalCost, 0);

  // Get total miles from dispatch legs for this truck
  const truckLegs = await ctx.db
    .query('dispatchLegs')
    .withIndex('by_truck', (q) => q.eq('truckId', truckId))
    .collect();

  const totalMiles = truckLegs.reduce((sum, l) => sum + l.legLoadedMiles + l.legEmptyMiles, 0);

  if (totalMiles <= 0) return null;

  return totalCost / totalMiles;
}
