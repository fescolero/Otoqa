/**
 * Trailer create schema.
 *
 * Maps 1:1 to `api.trailers.create`. The mutation accepts a flat row
 * (no nested objects); the schema groups fields into Identity /
 * Specs / Registration & Insurance / Financial / Notes sections for
 * presentation only. `bodyType === 'Refrigerated'` reveals the reefer
 * spec hints inline — those are stored as text in `comments`, since
 * the trailers table has no dedicated reefer columns.
 *
 * The shell stores everything as flat scalars in `vals`; the page
 * wrapper's `mapValsToTrailerArgs` does the small bit of translation
 * (number parsing for year/gvwr/purchasePrice).
 *
 * Why no `kind: 'address'` here: trailers don't carry an address.
 * Domicile lives on the truck record.
 */

import type {
  CreateFormSchema,
  FieldOption,
} from '@/components/web/create-form';

/** Status values match the existing /trailers/create page exactly so
 *  history before/after the migration stays comparable. */
const STATUS_OPTIONS: FieldOption[] = [
  { value: 'Active', label: 'Active' },
  { value: 'Out of Service', label: 'Out of service' },
  { value: 'In Repair', label: 'In repair' },
  { value: 'Maintenance', label: 'Maintenance' },
  { value: 'Sold', label: 'Sold' },
  { value: 'Lost', label: 'Lost' },
];

const SIZE_OPTIONS: FieldOption[] = [
  { value: '53ft', label: '53 ft' },
  { value: '48ft', label: '48 ft' },
  { value: '40ft', label: '40 ft' },
  { value: '28ft', label: '28 ft' },
  { value: '20ft', label: '20 ft' },
];

const BODY_TYPE_OPTIONS: FieldOption[] = [
  { value: 'Dry Van', label: 'Dry van' },
  { value: 'Refrigerated', label: 'Refrigerated' },
  { value: 'Flatbed', label: 'Flatbed' },
  { value: 'Tanker', label: 'Tanker' },
  { value: 'Lowboy', label: 'Lowboy' },
  { value: 'Step Deck', label: 'Step deck' },
];

const OWNERSHIP_OPTIONS: FieldOption[] = [
  { value: 'Owned', label: 'Owned' },
  { value: 'Leased', label: 'Leased' },
  { value: 'Financed', label: 'Financed' },
  { value: 'Renting', label: 'Renting' },
];

/** Field IDs — exported so the page wrapper can `bindUploaders` or
 *  remap values by symbol instead of stringly typed key strings. */
export const TRAILER_FIELD_IDS = {
  unitId: 'unitId',
  vin: 'vin',
  plate: 'plate',
  status: 'status',
  year: 'year',
  make: 'make',
  model: 'model',
  size: 'size',
  bodyType: 'bodyType',
  gvwr: 'gvwr',
  reeferNotes: 'reeferNotes', // local-only — folded into `comments` on save
  registrationExpiration: 'registrationExpiration',
  comments: 'comments',
  insuranceFirm: 'insuranceFirm',
  insurancePolicyNumber: 'insurancePolicyNumber',
  insuranceExpiration: 'insuranceExpiration',
  insuranceComments: 'insuranceComments',
  purchaseDate: 'purchaseDate',
  purchasePrice: 'purchasePrice',
  ownershipType: 'ownershipType',
  lienholder: 'lienholder',
} as const;

export function buildTrailerSchema(): CreateFormSchema {
  const ids = TRAILER_FIELD_IDS;
  return {
    entity: 'trailer',
    breadcrumb: ['Fleet Management', 'Trailers', 'New trailer'],
    title: 'New trailer',
    subtitle:
      'Identifying info + capacity + registration. Inspections and reefer logs live on the trailer record itself.',
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
            prefix: 'TR-',
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
            id: ids.plate,
            label: 'License plate',
            kind: 'mono',
            recommended: true,
            placeholder: 'XXX-0000',
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
            placeholder: 'Wabash',
          },
          {
            id: ids.model,
            label: 'Model',
            kind: 'text',
            placeholder: '3000R',
          },
        ],
      },
      {
        id: 'specs',
        title: 'Specs',
        subtitle:
          'Size + body type drive equipment matching. Choose "Refrigerated" to surface a reefer-notes field for the temperature spec.',
        fields: [
          {
            id: ids.size,
            label: 'Size',
            kind: 'select',
            recommended: true,
            options: SIZE_OPTIONS,
          },
          {
            id: ids.bodyType,
            label: 'Body type',
            kind: 'select',
            recommended: true,
            options: BODY_TYPE_OPTIONS,
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
            id: ids.reeferNotes,
            label: 'Reefer notes',
            kind: 'textarea',
            span: 2,
            rows: 2,
            showIf: (v) => v[ids.bodyType] === 'Refrigerated',
            placeholder:
              'e.g. "Thermo King · keep at 36°F · TK alarm code book in glove box."',
            hint: 'Folded into the trailer’s general comments on save.',
          },
        ],
      },
      {
        id: 'registration',
        title: 'Registration & insurance',
        subtitle: 'Set the expirations now and we’ll remind you 30 days before.',
        fields: [
          {
            id: ids.registrationExpiration,
            label: 'Registration expires',
            kind: 'date',
            recommended: true,
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
        subtitle: 'Optional — fill in if you have the purchase or lease record handy.',
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
            placeholder: '150,000',
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
 *
 *  Same contract as fuel-entry: shell stores plain scalars / strings;
 *  the wrapper turns them into the mutation's typed arg shape.
 *
 *  Special-case: `reeferNotes` is a UI-only field — there's no
 *  matching column in the trailers table. Its content prepends the
 *  general `comments` field on save so reefer specs don't get lost.
 * ──────────────────────────────────────────────────────────────── */

export interface TrailerCreateArgs {
  unitId: string;
  vin: string;
  status: string;
  plate?: string;
  make?: string;
  model?: string;
  year?: number;
  size?: string;
  bodyType?: string;
  gvwr?: number;
  registrationExpiration?: string;
  comments?: string;
  insuranceFirm?: string;
  insurancePolicyNumber?: string;
  insuranceExpiration?: string;
  insuranceComments?: string;
  purchaseDate?: string;
  purchasePrice?: number;
  ownershipType?: string;
  lienholder?: string;
}

export function mapValsToTrailerArgs(
  vals: Record<string, unknown>,
): TrailerCreateArgs {
  const ids = TRAILER_FIELD_IDS;

  // Fold the UI-only reefer-notes field into `comments` so a reefer
  // spec entered at create-time isn't silently dropped.
  const reeferNotes = optionalStr(vals[ids.reeferNotes]);
  const baseComments = optionalStr(vals[ids.comments]);
  const comments = reeferNotes
    ? baseComments
      ? `Reefer: ${reeferNotes}\n\n${baseComments}`
      : `Reefer: ${reeferNotes}`
    : baseComments;

  return {
    unitId: String(vals[ids.unitId] ?? '').trim(),
    vin: String(vals[ids.vin] ?? '').trim().toUpperCase(),
    status: String(vals[ids.status] ?? 'Active'),
    plate: optionalStr(vals[ids.plate]),
    make: optionalStr(vals[ids.make]),
    model: optionalStr(vals[ids.model]),
    year: optionalNumber(vals[ids.year]),
    size: optionalStr(vals[ids.size]),
    bodyType: optionalStr(vals[ids.bodyType]),
    gvwr: optionalNumber(vals[ids.gvwr]),
    registrationExpiration: optionalStr(vals[ids.registrationExpiration]),
    comments,
    insuranceFirm: optionalStr(vals[ids.insuranceFirm]),
    insurancePolicyNumber: optionalStr(vals[ids.insurancePolicyNumber]),
    insuranceExpiration: optionalStr(vals[ids.insuranceExpiration]),
    insuranceComments: optionalStr(vals[ids.insuranceComments]),
    purchaseDate: optionalStr(vals[ids.purchaseDate]),
    purchasePrice: optionalNumber(vals[ids.purchasePrice]),
    ownershipType: optionalStr(vals[ids.ownershipType]),
    lienholder: optionalStr(vals[ids.lienholder]),
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
