/**
 * Truck create schema.
 *
 * Maps 1:1 to `api.trucks.create`. Sections group fields for the rail:
 * Identity / Specs / Engine / Registration & insurance / Financial /
 * Notes. The schema is a pure factory — no live data, no Convex
 * imports — and the page wrapper handles auth and translation.
 *
 * Why no `kind: 'address'` here: trucks don't carry an address.
 * Domicile is a free-text field on the truck itself (no dedicated
 * column on this schema yet — defer to a follow-up).
 *
 * ARB / IFTA stickers are stored as booleans in Convex. The schema
 * uses `kind: 'toggle'` for natural Yes/No semantics; the translator
 * passes the boolean through unchanged.
 */

import type {
  CreateFormSchema,
  FieldOption,
} from '@/components/web/create-form';

const STATUS_OPTIONS: FieldOption[] = [
  { value: 'Active', label: 'Active' },
  { value: 'Out of Service', label: 'Out of service' },
  { value: 'In Repair', label: 'In repair' },
  { value: 'Maintenance', label: 'Maintenance' },
  { value: 'Sold', label: 'Sold' },
  { value: 'Lost', label: 'Lost' },
];

const BODY_TYPE_OPTIONS: FieldOption[] = [
  { value: 'Semi', label: 'Semi' },
  { value: 'Bobtail', label: 'Bobtail' },
];

const FUEL_TYPE_OPTIONS: FieldOption[] = [
  { value: 'Diesel', label: 'Diesel' },
  { value: 'Gas', label: 'Gas' },
  { value: 'Electric', label: 'Electric' },
  { value: 'CNG', label: 'CNG' },
  { value: 'Hybrid', label: 'Hybrid' },
];

const OWNERSHIP_OPTIONS: FieldOption[] = [
  { value: 'Owned', label: 'Owned' },
  { value: 'Leased', label: 'Leased' },
  { value: 'Financed', label: 'Financed' },
  { value: 'Renting', label: 'Renting' },
];

export const TRUCK_FIELD_IDS = {
  unitId: 'unitId',
  vin: 'vin',
  plate: 'plate',
  status: 'status',
  year: 'year',
  make: 'make',
  model: 'model',
  bodyType: 'bodyType',
  fuelType: 'fuelType',
  gvwr: 'gvwr',
  gcwr: 'gcwr',
  engineManufacturer: 'engineManufacturer',
  engineModel: 'engineModel',
  engineFamilyName: 'engineFamilyName',
  engineModelYear: 'engineModelYear',
  engineSerialNumber: 'engineSerialNumber',
  registrationExpiration: 'registrationExpiration',
  arb: 'arb',
  ifta: 'ifta',
  insuranceFirm: 'insuranceFirm',
  insurancePolicyNumber: 'insurancePolicyNumber',
  insuranceExpiration: 'insuranceExpiration',
  insuranceComments: 'insuranceComments',
  purchaseDate: 'purchaseDate',
  purchasePrice: 'purchasePrice',
  ownershipType: 'ownershipType',
  lienholder: 'lienholder',
  comments: 'comments',
} as const;

export function buildTruckSchema(): CreateFormSchema {
  const ids = TRUCK_FIELD_IDS;
  return {
    entity: 'truck',
    breadcrumb: ['Fleet Management', 'Trucks', 'New truck'],
    title: 'New truck',
    subtitle:
      'Identifying info + registration + assignment. Maintenance and inspections live on the truck record itself.',
    sections: [
      {
        id: 'identity',
        title: 'Identity',
        fields: [
          {
            id: ids.unitId,
            label: 'Unit #',
            kind: 'mono',
            required: 'tier1',
            prefix: 'T-',
            placeholder: '000',
            hint: 'Your fleet number — printed on the door.',
          },
          {
            id: ids.vin,
            label: 'VIN',
            kind: 'mono',
            required: 'tier1',
            span: 2,
            placeholder: '17-character VIN',
            validate: (v) =>
              typeof v === 'string' && v.length > 0 && v.length !== 17
                ? 'VIN should be exactly 17 characters.'
                : null,
          },
          {
            id: ids.status,
            label: 'Status',
            kind: 'select',
            required: 'tier1',
            default: 'Active',
            options: STATUS_OPTIONS,
          },
          {
            id: ids.year,
            label: 'Year',
            kind: 'number',
            recommended: true,
            placeholder: '2024',
          },
          {
            id: ids.make,
            label: 'Make',
            kind: 'text',
            recommended: true,
            placeholder: 'Freightliner',
          },
          {
            id: ids.model,
            label: 'Model',
            kind: 'text',
            recommended: true,
            placeholder: 'Cascadia',
          },
          {
            id: ids.plate,
            label: 'License plate',
            kind: 'mono',
            placeholder: 'XXX-0000',
          },
        ],
      },
      {
        id: 'specs',
        title: 'Specs',
        fields: [
          {
            id: ids.bodyType,
            label: 'Body type',
            kind: 'segmented',
            options: BODY_TYPE_OPTIONS,
          },
          {
            id: ids.fuelType,
            label: 'Fuel type',
            kind: 'select',
            recommended: true,
            options: FUEL_TYPE_OPTIONS,
          },
          {
            id: ids.gvwr,
            label: 'GVWR',
            kind: 'number',
            recommended: true,
            suffix: 'lbs',
            placeholder: '80,000',
          },
          {
            id: ids.gcwr,
            label: 'GCWR',
            kind: 'number',
            suffix: 'lbs',
            placeholder: '90,000',
            hint: 'Gross combination weight rating.',
          },
        ],
      },
      {
        id: 'engine',
        title: 'Engine',
        subtitle: 'Optional now — fill in if your VIN-decoded record arrived empty.',
        fields: [
          {
            id: ids.engineManufacturer,
            label: 'Manufacturer',
            kind: 'text',
            placeholder: 'Detroit',
          },
          {
            id: ids.engineModel,
            label: 'Model',
            kind: 'text',
            placeholder: 'DD15',
          },
          {
            id: ids.engineFamilyName,
            label: 'Family name',
            kind: 'mono',
            placeholder: 'NDDXH15.0DJC',
          },
          {
            id: ids.engineModelYear,
            label: 'Model year',
            kind: 'number',
            placeholder: '2024',
          },
          {
            id: ids.engineSerialNumber,
            label: 'Serial #',
            kind: 'mono',
            placeholder: '00000000',
          },
        ],
      },
      {
        id: 'registration',
        title: 'Registration & insurance',
        subtitle: 'Set expirations now — we’ll remind you 30 days before.',
        fields: [
          {
            id: ids.registrationExpiration,
            label: 'Registration expires',
            kind: 'date',
            recommended: true,
          },
          {
            id: ids.arb,
            label: 'ARB compliant',
            kind: 'toggle',
            toggleLabel: 'CARB ARB clean-truck check passed',
          },
          {
            id: ids.ifta,
            label: 'IFTA registered',
            kind: 'toggle',
            toggleLabel: 'IFTA sticker on file',
          },
          {
            id: ids.insuranceFirm,
            label: 'Insurer',
            kind: 'text',
            placeholder: 'e.g. Progressive Commercial',
          },
          {
            id: ids.insurancePolicyNumber,
            label: 'Policy #',
            kind: 'mono',
            placeholder: 'POL-0000000',
          },
          {
            id: ids.insuranceExpiration,
            label: 'Insurance expires',
            kind: 'date',
          },
          {
            id: ids.insuranceComments,
            label: 'Insurance notes',
            kind: 'textarea',
            span: 2,
            rows: 2,
            placeholder: 'Anything dispatchers should know about the COI.',
          },
        ],
      },
      {
        id: 'financial',
        title: 'Financial',
        subtitle:
          'Optional — fill in if you have the purchase or lease record handy.',
        fields: [
          {
            id: ids.ownershipType,
            label: 'Ownership',
            kind: 'segmented',
            span: 2,
            options: OWNERSHIP_OPTIONS,
          },
          {
            id: ids.lienholder,
            label: 'Lienholder',
            kind: 'text',
            showIf: (v) =>
              v[ids.ownershipType] === 'Financed' ||
              v[ids.ownershipType] === 'Leased',
            placeholder: 'Bank or leasing company',
          },
          {
            id: ids.purchaseDate,
            label: 'Purchase date',
            kind: 'date',
          },
          {
            id: ids.purchasePrice,
            label: 'Purchase price',
            kind: 'currency',
            placeholder: '180,000',
          },
        ],
      },
      {
        id: 'notes',
        title: 'Notes',
        fields: [
          {
            id: ids.comments,
            label: 'Internal notes',
            kind: 'textarea',
            span: 2,
            rows: 3,
            placeholder:
              'Anything dispatchers should know — equipment quirks, lane preferences, etc.',
          },
        ],
      },
    ],
  };
}

/* ────────────────────────────────────────────────────────────────────
 *  Value-shape translator
 * ──────────────────────────────────────────────────────────────── */

export interface TruckCreateArgs {
  unitId: string;
  vin: string;
  status: string;
  plate?: string;
  make?: string;
  model?: string;
  year?: number;
  bodyType?: string;
  fuelType?: string;
  gvwr?: number;
  gcwr?: number;
  engineManufacturer?: string;
  engineModel?: string;
  engineFamilyName?: string;
  engineModelYear?: number;
  engineSerialNumber?: string;
  registrationExpiration?: string;
  arb?: boolean;
  ifta?: boolean;
  insuranceFirm?: string;
  insurancePolicyNumber?: string;
  insuranceExpiration?: string;
  insuranceComments?: string;
  purchaseDate?: string;
  purchasePrice?: number;
  ownershipType?: string;
  lienholder?: string;
  comments?: string;
}

export function mapValsToTruckArgs(
  vals: Record<string, unknown>,
): TruckCreateArgs {
  const ids = TRUCK_FIELD_IDS;
  return {
    unitId: String(vals[ids.unitId] ?? '').trim(),
    vin: String(vals[ids.vin] ?? '').trim().toUpperCase(),
    status: String(vals[ids.status] ?? 'Active'),
    plate: optionalStr(vals[ids.plate]),
    make: optionalStr(vals[ids.make]),
    model: optionalStr(vals[ids.model]),
    year: optionalNumber(vals[ids.year]),
    bodyType: optionalStr(vals[ids.bodyType]),
    fuelType: optionalStr(vals[ids.fuelType]),
    gvwr: optionalNumber(vals[ids.gvwr]),
    gcwr: optionalNumber(vals[ids.gcwr]),
    engineManufacturer: optionalStr(vals[ids.engineManufacturer]),
    engineModel: optionalStr(vals[ids.engineModel]),
    engineFamilyName: optionalStr(vals[ids.engineFamilyName]),
    engineModelYear: optionalNumber(vals[ids.engineModelYear]),
    engineSerialNumber: optionalStr(vals[ids.engineSerialNumber]),
    registrationExpiration: optionalStr(vals[ids.registrationExpiration]),
    arb: optionalBool(vals[ids.arb]),
    ifta: optionalBool(vals[ids.ifta]),
    insuranceFirm: optionalStr(vals[ids.insuranceFirm]),
    insurancePolicyNumber: optionalStr(vals[ids.insurancePolicyNumber]),
    insuranceExpiration: optionalStr(vals[ids.insuranceExpiration]),
    insuranceComments: optionalStr(vals[ids.insuranceComments]),
    purchaseDate: optionalStr(vals[ids.purchaseDate]),
    purchasePrice: optionalNumber(vals[ids.purchasePrice]),
    ownershipType: optionalStr(vals[ids.ownershipType]),
    lienholder: optionalStr(vals[ids.lienholder]),
    comments: optionalStr(vals[ids.comments]),
  };
}

function optionalStr(v: unknown): string | undefined {
  const s = typeof v === 'string' ? v.trim() : '';
  return s.length > 0 ? s : undefined;
}

function optionalNumber(v: unknown): number | undefined {
  if (v === '' || v === null || v === undefined) return undefined;
  const n = Number(v);
  return Number.isFinite(n) ? n : undefined;
}

// Convex validator is `v.optional(v.boolean())`. A toggle's default
// value is `false`; we only send a boolean if the user actually
// flipped it (i.e. it's true). Sending `undefined` for unset toggles
// keeps the server-side field clean.
function optionalBool(v: unknown): boolean | undefined {
  if (v === true) return true;
  return undefined;
}
