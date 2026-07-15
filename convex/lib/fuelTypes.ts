/**
 * Fuel-type taxonomy shared by the fuel-entry mutations, the report
 * queries, and the web import/report surfaces.
 *
 * `fuelEntries.fuelType` is optional — rows created before the field
 * existed have no value and are treated as DIESEL everywhere
 * (`DEFAULT_FUEL_TYPE`). DEF is intentionally NOT a member: DEF
 * top-offs live in their own `defEntries` table and the import flows
 * reject DEF receipts with a pointer to that workflow.
 */

import { v } from 'convex/values';

export const FUEL_TYPES = [
  'DIESEL',
  'DYED_DIESEL',
  'BIODIESEL',
  'GASOLINE',
  'OTHER',
] as const;

export type FuelType = (typeof FUEL_TYPES)[number];

export const DEFAULT_FUEL_TYPE: FuelType = 'DIESEL';

export const FUEL_TYPE_LABELS: Record<FuelType, string> = {
  DIESEL: 'Diesel',
  DYED_DIESEL: 'Dyed diesel (reefer)',
  BIODIESEL: 'Biodiesel',
  GASOLINE: 'Gasoline',
  OTHER: 'Other',
};

/** What the fuel REPORT can show per row/bucket: every storable fuel
 *  type plus DEF (sourced from the defEntries table, not fuelEntries). */
export type FuelProduct = FuelType | 'DEF';

export function fuelProductLabel(product: FuelProduct): string {
  return product === 'DEF' ? 'DEF' : FUEL_TYPE_LABELS[product];
}

export const fuelTypeValidator = v.union(
  v.literal('DIESEL'),
  v.literal('DYED_DIESEL'),
  v.literal('BIODIESEL'),
  v.literal('GASOLINE'),
  v.literal('OTHER'),
);

/** Receipt product codes → canonical fuel type. 'DEF' is a valid
 *  normalization RESULT (so imports can detect and reject it) but not
 *  a storable `FuelType`. */
const FUEL_TYPE_NORMALIZATION_MAP: Record<string, FuelType | 'DEF'> = {
  'DSL': 'DIESEL',
  'DIESEL': 'DIESEL',
  'ULSD': 'DIESEL',
  'ULTRA LOW SULFUR DIESEL': 'DIESEL',
  'LSD': 'DIESEL',
  'AGO': 'DIESEL',
  'AUTOMOTIVE GAS OIL': 'DIESEL',
  'DYED': 'DYED_DIESEL',
  'DYED DIESEL': 'DYED_DIESEL',
  'REEFER': 'DYED_DIESEL',
  'REEFER FUEL': 'DYED_DIESEL',
  'B5': 'BIODIESEL',
  'B10': 'BIODIESEL',
  'B20': 'BIODIESEL',
  'BIODIESEL': 'BIODIESEL',
  'GSL': 'GASOLINE',
  'GAS': 'GASOLINE',
  'GASOLINE': 'GASOLINE',
  'REG': 'GASOLINE',
  'REGULAR': 'GASOLINE',
  'UNL': 'GASOLINE',
  'UNLEADED': 'GASOLINE',
  'PREM': 'GASOLINE',
  'PREMIUM': 'GASOLINE',
  'MID': 'GASOLINE',
  'MIDGRADE': 'GASOLINE',
  'DEF': 'DEF',
  'DIESEL EXHAUST FLUID': 'DEF',
};

/** Normalize a raw receipt/CSV product string to a canonical fuel
 *  type. Unrecognized values fall back to OTHER (callers surface a
 *  "verify this" warning for that case). */
export function normalizeFuelTypeCode(value: string): FuelType | 'DEF' {
  const normalized = value
    .trim()
    .toUpperCase()
    .replace(/[^A-Z0-9]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();

  if (!normalized) return 'OTHER';
  if ((FUEL_TYPES as readonly string[]).includes(normalized)) {
    return normalized as FuelType;
  }
  return FUEL_TYPE_NORMALIZATION_MAP[normalized] ?? 'OTHER';
}
