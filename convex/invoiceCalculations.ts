/**
 * Invoice Calculation Utilities
 * 
 * Provides reusable functions for calculating invoice amounts dynamically
 * based on load data and contract lane configuration.
 */

export interface InvoiceCalculationResult {
  subtotal: number;
  fuelSurcharge: number;
  accessorialsTotal: number;
  taxAmount: number;
  totalAmount: number;
  breakdown: {
    baseRate: number;
    rateType: string;
    milesUsed?: number;
    stopCount?: number;
    extraStops?: number;
    stopOffRate?: number;
  };
}

interface LoadData {
  effectiveMiles?: number;
  stopCount?: number;
}

interface ContractLaneData {
  rate: number;
  rateType: 'Per Mile' | 'Flat Rate' | 'Per Stop';
  miles?: number;
  currency: 'USD' | 'CAD' | 'MXN';
  
  // Accessorials
  stopOffRate?: number;
  includedStops?: number;
  
  // Fuel Surcharge
  fuelSurchargeType?: 'PERCENTAGE' | 'FLAT' | 'DOE_INDEX';
  fuelSurchargeValue?: number;
}

/**
 * Calculate invoice amounts based on load and contract lane
 * 
 * @param load - Load data with miles and stop count
 * @param contractLane - Contract lane configuration
 * @returns Calculated invoice amounts and breakdown
 */
export function calculateInvoiceAmounts(
  load: LoadData,
  contractLane: ContractLaneData
): InvoiceCalculationResult {
  const stopCount = load.stopCount || 0;
  const effectiveMiles = load.effectiveMiles;

  // Calculate base rate
  let baseRate = 0;
  let milesUsed: number | undefined;

  if (contractLane.rateType === 'Per Mile' && effectiveMiles) {
    baseRate = contractLane.rate * effectiveMiles;
    milesUsed = effectiveMiles;
  } else if (contractLane.rateType === 'Flat Rate') {
    baseRate = contractLane.rate;
  } else if (contractLane.rateType === 'Per Stop') {
    baseRate = contractLane.rate * stopCount;
  }

  // Calculate accessorials (stop-off charges)
  const includedStops = contractLane.includedStops || 2;
  const extraStops = Math.max(0, stopCount - includedStops);
  const stopOffRate = contractLane.stopOffRate || 0;
  const stopOffCharges = extraStops * stopOffRate;

  // Calculate fuel surcharge
  let fuelSurcharge = 0;
  if (contractLane.fuelSurchargeType === 'PERCENTAGE' && contractLane.fuelSurchargeValue) {
    fuelSurcharge = baseRate * (contractLane.fuelSurchargeValue / 100);
  } else if (contractLane.fuelSurchargeType === 'FLAT' && contractLane.fuelSurchargeValue) {
    fuelSurcharge = contractLane.fuelSurchargeValue;
  }
  // DOE_INDEX would require external API call - not implemented yet

  // Calculate totals
  const subtotal = baseRate;
  const accessorialsTotal = stopOffCharges;
  const taxAmount = 0; // Tax calculation not implemented yet
  const totalAmount = subtotal + fuelSurcharge + accessorialsTotal + taxAmount;

  return {
    subtotal,
    fuelSurcharge,
    accessorialsTotal,
    taxAmount,
    totalAmount,
    breakdown: {
      baseRate,
      rateType: contractLane.rateType,
      milesUsed,
      stopCount,
      extraStops: extraStops > 0 ? extraStops : undefined,
      stopOffRate: stopOffRate > 0 ? stopOffRate : undefined,
    },
  };
}

/**
 * Get zero amounts for invoices without contract lanes (MISSING_DATA)
 */
export function getZeroInvoiceAmounts(): InvoiceCalculationResult {
  return {
    subtotal: 0,
    fuelSurcharge: 0,
    accessorialsTotal: 0,
    taxAmount: 0,
    totalAmount: 0,
    breakdown: {
      baseRate: 0,
      rateType: 'N/A',
    },
  };
}
