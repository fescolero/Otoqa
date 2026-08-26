/**
 * Fuel vendor schema — drives both the create and edit flows.
 *
 * Maps 1:1 to `api.fuelVendors.create`; `update` takes the same fields
 * with everything optional, so one schema with a `mode` parameter
 * covers both. Short-form — single Identity / Contact / Address /
 * Notes layout. No draft persistence because the create flow is fast
 * (~30 seconds to fill in name + fuel-card account number) and the
 * abandonment rate is too low to justify the table-row cost.
 *
 * Sections:
 *   - Identity         — legal name + optional fleet-card code + account #
 *   - Contact          — primary contact name / email / phone
 *   - Address          — composite (optional)
 *   - Notes
 *
 * Country defaults to 'US' so the address composite stays valid even
 * when filled manually (Google Places autocomplete writes 'US' on
 * pick).
 */

import type {
  CreateFormSchema,
  FieldOption,
} from '@/components/web/create-form';

const DISCOUNT_PROGRAM_OPTIONS: FieldOption[] = [
  { value: 'COMDATA', label: 'Comdata' },
  { value: 'EFS', label: 'EFS' },
  { value: 'TCH', label: 'TCH' },
  { value: 'WEX', label: 'WEX' },
  { value: 'DIRECT', label: 'Direct billing' },
  { value: 'OTHER', label: 'Other' },
];

export const FUEL_VENDOR_FIELD_IDS = {
  name: 'name',
  code: 'code',
  accountNumber: 'accountNumber',
  discountProgram: 'discountProgram',
  contactName: 'contactName',
  contactEmail: 'contactEmail',
  contactPhone: 'contactPhone',
  addrStreet: 'addressLine',
  addrSuite: 'addrSuite', // UI-only — vendor table has no addressLine2
  addrCity: 'city',
  addrState: 'state',
  addrZip: 'zip',
  country: 'country',
  notes: 'notes',
} as const;

export interface BuildFuelVendorSchemaArgs {
  /**
   * 'create' (default) → new-record title + breadcrumb.
   * 'edit'             → edit title. Field layout is identical for both
   *                      modes: `fuelVendors.update` accepts exactly the
   *                      fields `create` does, all optional.
   */
  mode?: 'create' | 'edit';
  /**
   * The record's stored `discountProgram` when editing. The picker is a
   * fixed six-option select, but the legacy hand-rolled edit form was a
   * free-text input — so rows can hold values outside the list. Passing
   * the current value appends it as an option instead of leaving the
   * trigger showing a placeholder over a value the user never chose.
   */
  currentDiscountProgram?: string;
}

export function buildFuelVendorSchema(
  args: BuildFuelVendorSchemaArgs = {},
): CreateFormSchema {
  const ids = FUEL_VENDOR_FIELD_IDS;
  const { mode = 'create', currentDiscountProgram } = args;
  const isEdit = mode === 'edit';

  const discountOptions: FieldOption[] =
    currentDiscountProgram &&
    !DISCOUNT_PROGRAM_OPTIONS.some((o) => o.value === currentDiscountProgram)
      ? [
          ...DISCOUNT_PROGRAM_OPTIONS,
          { value: currentDiscountProgram, label: currentDiscountProgram },
        ]
      : DISCOUNT_PROGRAM_OPTIONS;

  return {
    entity: 'fuelVendor',
    breadcrumb: [
      'Company Operations',
      'Fuel Vendors',
      isEdit ? 'Edit vendor' : 'New vendor',
    ],
    title: isEdit ? 'Edit fuel vendor' : 'New fuel vendor',
    subtitle: isEdit
      ? 'Update the vendor’s identity, contact, and billing address. Name is required; everything else can stay blank.'
      : 'A fuel-card processor (Comdata, EFS, WEX, etc.) or a direct-billing chain. Required: name. Everything else can be added later.',
    sections: [
      {
        id: 'identity',
        title: 'Identity',
        fields: [
          {
            id: ids.name,
            label: 'Vendor name',
            kind: 'text',
            required: 'tier1',
            span: 2,
            placeholder: 'e.g. Loves Travel Stops',
            hint: 'How drivers and dispatchers refer to this vendor.',
          },
          {
            id: ids.code,
            label: 'Code',
            kind: 'mono',
            placeholder: 'LV',
            hint: '2–4 chars; printed on the fleet card statement.',
          },
          {
            id: ids.discountProgram,
            label: 'Discount program',
            kind: 'select',
            recommended: true,
            options: discountOptions,
            hint: 'Drives IFTA grouping + nightly discount reconciliation.',
          },
          {
            id: ids.accountNumber,
            label: 'Account #',
            kind: 'mono',
            span: 2,
            placeholder: '000000000',
            hint: 'Your fleet account on the vendor side — used by reconciliation.',
          },
        ],
      },
      {
        id: 'contact',
        title: 'Primary contact',
        subtitle:
          'Who do we call when there\'s a fuel-card dispute or a new-card request?',
        fields: [
          {
            id: ids.contactName,
            label: 'Name',
            kind: 'text',
            placeholder: 'First Last',
          },
          {
            id: ids.contactEmail,
            label: 'Email',
            kind: 'text',
            placeholder: 'support@example.com',
            validate: (v) =>
              typeof v === 'string' && v && !v.includes('@')
                ? 'Looks like an incomplete email — did you mean to include @?'
                : null,
          },
          {
            id: ids.contactPhone,
            label: 'Phone',
            kind: 'text',
            placeholder: '(555) 555-0123',
            format: 'phone-us',
          },
        ],
      },
      {
        id: 'address',
        title: 'Address',
        subtitle: 'Optional — only useful for direct-billing chains, not for fuel-card processors.',
        fields: [
          {
            id: 'addressComposite',
            label: 'Physical address',
            kind: 'address',
            ids: {
              street: ids.addrStreet,
              suite: ids.addrSuite,
              city: ids.addrCity,
              state: ids.addrState,
              zip: ids.addrZip,
            },
          },
        ],
      },
      {
        id: 'notes',
        title: 'Notes',
        fields: [
          {
            id: ids.notes,
            label: 'Internal notes',
            kind: 'textarea',
            span: 2,
            rows: 3,
            placeholder:
              'Anything dispatchers should know — quirks, discount conditions, etc.',
          },
        ],
      },
    ],
  };
}

/* ────────────────────────────────────────────────────────────────────
 *  Value-shape translator
 *
 *  No special-case fields here — every entry is a flat scalar. The
 *  vendor table has no `addressLine2` column, so the UI-only Suite
 *  field (`addrSuite`) is silently dropped. If we ever add suite
 *  support to the schema, surface it by promoting addrSuite to a real
 *  Convex field.
 * ──────────────────────────────────────────────────────────────── */

export interface FuelVendorCreateArgs {
  name: string;
  code?: string;
  accountNumber?: string;
  discountProgram?: string;
  contactName?: string;
  contactEmail?: string;
  contactPhone?: string;
  addressLine?: string;
  city?: string;
  state?: string;
  zip?: string;
  country?: string;
  notes?: string;
}

export function mapValsToFuelVendorArgs(
  vals: Record<string, unknown>,
): FuelVendorCreateArgs {
  const ids = FUEL_VENDOR_FIELD_IDS;
  return {
    name: String(vals[ids.name] ?? '').trim(),
    code: optionalStr(vals[ids.code]),
    accountNumber: optionalStr(vals[ids.accountNumber]),
    discountProgram: optionalStr(vals[ids.discountProgram]),
    contactName: optionalStr(vals[ids.contactName]),
    contactEmail: optionalStr(vals[ids.contactEmail]),
    contactPhone: optionalStr(vals[ids.contactPhone]),
    addressLine: optionalStr(vals[ids.addrStreet]),
    city: optionalStr(vals[ids.addrCity]),
    state: optionalStr(vals[ids.addrState]),
    zip: optionalStr(vals[ids.addrZip]),
    country: optionalStr(vals[ids.country]) ?? 'US',
    notes: optionalStr(vals[ids.notes]),
  };
}

/* ────────────────────────────────────────────────────────────────────
 *  Edit-mode helpers
 *
 *  `mapRecordToFuelVendorVals(record)` is the inverse of
 *  `mapValsToFuelVendorArgs(vals)` — takes a stored fuelVendors row
 *  and produces the flat `vals` object the shell seeds the form with.
 *  Every column is already a flat string, so there's no translation
 *  work beyond `undefined → ''`.
 *
 *  `country` has no rendered field (the create flow stamps 'US'), but
 *  it IS seeded here so an existing non-US value survives a round-trip
 *  through the form instead of being reset to 'US' on save.
 * ──────────────────────────────────────────────────────────────── */

/** Subset of the persisted row the schema reads. Redeclared locally so
 *  this file stays free of Convex imports, matching the fuel-entry
 *  schema's convention. */
export interface FuelVendorRecord {
  name: string;
  code?: string;
  accountNumber?: string;
  discountProgram?: string;
  contactName?: string;
  contactEmail?: string;
  contactPhone?: string;
  addressLine?: string;
  city?: string;
  state?: string;
  zip?: string;
  country?: string;
  notes?: string;
}

export function mapRecordToFuelVendorVals(
  record: FuelVendorRecord,
): Record<string, unknown> {
  const ids = FUEL_VENDOR_FIELD_IDS;
  return {
    [ids.name]: record.name ?? '',
    [ids.code]: record.code ?? '',
    [ids.accountNumber]: record.accountNumber ?? '',
    [ids.discountProgram]: record.discountProgram ?? '',
    [ids.contactName]: record.contactName ?? '',
    [ids.contactEmail]: record.contactEmail ?? '',
    [ids.contactPhone]: record.contactPhone ?? '',
    [ids.addrStreet]: record.addressLine ?? '',
    [ids.addrCity]: record.city ?? '',
    [ids.addrState]: record.state ?? '',
    [ids.addrZip]: record.zip ?? '',
    [ids.country]: record.country ?? '',
    [ids.notes]: record.notes ?? '',
  };
}

/** `fuelVendors.update` takes every field as optional, including
 *  `name` — so the update args are just the create args with `name`
 *  relaxed. Same translator; narrower return type. */
export type FuelVendorUpdateArgs = Partial<FuelVendorCreateArgs>;

export function mapValsToFuelVendorUpdateArgs(
  vals: Record<string, unknown>,
): FuelVendorUpdateArgs {
  return {
    ...mapValsToFuelVendorArgs(vals),
    // The create translator stamps 'US' when country is absent. On
    // update that would backfill every edited row with a country it
    // never had, so pass the seeded value through as-is instead.
    country: optionalStr(vals[FUEL_VENDOR_FIELD_IDS.country]),
  };
}

function optionalStr(v: unknown): string | undefined {
  const s = typeof v === 'string' ? v.trim() : '';
  return s.length > 0 ? s : undefined;
}
