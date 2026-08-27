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
 * Country is a real field defaulting to 'US' — new vendors get the
 * common case for free, and it stays editable for the direct-billing
 * chains that aren't US-based. On edit it seeds from the record, so a
 * row with no country stays blank rather than being backfilled.
 */

import type { Doc } from '@/convex/_generated/dataModel';
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

/**
 * Fold a stored discount program onto the canonical option value when
 * it differs only by casing.
 *
 * The picker matches options by exact value, so a legacy row holding
 * 'Comdata' would neither select the 'COMDATA' option nor compare
 * equal to it — it would be appended as a second, visually identical
 * entry. Normalizing on seed means the canonical option is selected
 * and the next save rewrites the row to the canonical value, so rows
 * converge as they are edited instead of needing a migration.
 *
 * A genuinely off-list value ('Comdata network') is returned
 * unchanged and still gets appended as an option, so nothing the user
 * never chose is silently discarded.
 */
export function canonicalDiscountProgram(raw: string): string {
  const match = DISCOUNT_PROGRAM_OPTIONS.find(
    (o) => o.value.toLowerCase() === raw.trim().toLowerCase(),
  );
  return match ? match.value : raw;
}

export const FUEL_VENDOR_FIELD_IDS = {
  name: 'name',
  code: 'code',
  accountNumber: 'accountNumber',
  discountProgram: 'discountProgram',
  contactName: 'contactName',
  contactEmail: 'contactEmail',
  contactPhone: 'contactPhone',
  addrStreet: 'addressLine',
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

  const canonical = currentDiscountProgram
    ? canonicalDiscountProgram(currentDiscountProgram)
    : undefined;
  const discountOptions: FieldOption[] =
    canonical && !DISCOUNT_PROGRAM_OPTIONS.some((o) => o.value === canonical)
      ? [...DISCOUNT_PROGRAM_OPTIONS, { value: canonical, label: canonical }]
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
              city: ids.addrCity,
              state: ids.addrState,
              zip: ids.addrZip,
              // Wired so picking a non-US address from the
              // autocomplete fills the country field below instead of
              // leaving it on its 'US' default.
              country: ids.country,
            },
          },
          {
            // Rendered outside the composite because the composite
            // forces a full-width row, so this lands on its own line
            // beneath it. The composite still WRITES here on
            // autocomplete via its optional `country` id slot.
            //
            // No length validation on purpose — rows written by the
            // legacy hand-rolled edit form can hold 'United States',
            // and a 2-letter rule would block saving them until fixed.
            id: ids.country,
            label: 'Country',
            kind: 'text',
            default: 'US',
            placeholder: 'US',
            hint: 'Two-letter code. Blank on older records is left as-is.',
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
 *  No special-case fields here — every entry is a flat scalar.
 *
 *  The composite is deliberately wired without a `suite` id: the
 *  vendor table has no `addressLine2` column, so rendering that input
 *  would collect a value with nowhere to store it and drop it on
 *  save. Add the column first if suite support is ever wanted.
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
    country: optionalStr(vals[ids.country]),
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
 *  `country` seeds from the record rather than from the field's 'US'
 *  default: `useFormState` only falls back to a field default when the
 *  key is absent from `initialValues`, so seeding '' here is what keeps
 *  an older row's blank country blank instead of backfilling it.
 * ──────────────────────────────────────────────────────────────── */

/**
 * Subset of the persisted row the schema reads.
 *
 * Derived from the generated `Doc<'fuelVendors'>` rather than
 * hand-redeclared: a hand-written copy lets a column rename in
 * convex/schema.ts compile cleanly here, and the mapper would then
 * seed a blank field that the next save writes back over the real
 * value. `Pick` turns that into a build error. (`fuel-entry.ts`
 * already imports from `_generated/dataModel`, so this is the file's
 * existing convention, not a new dependency.)
 */
export type FuelVendorRecord = Pick<
  Doc<'fuelVendors'>,
  | 'name'
  | 'code'
  | 'accountNumber'
  | 'discountProgram'
  | 'contactName'
  | 'contactEmail'
  | 'contactPhone'
  | 'addressLine'
  | 'city'
  | 'state'
  | 'zip'
  | 'country'
  | 'notes'
>;

export function mapRecordToFuelVendorVals(
  record: FuelVendorRecord,
): Record<string, unknown> {
  const ids = FUEL_VENDOR_FIELD_IDS;
  return {
    [ids.name]: record.name ?? '',
    [ids.code]: record.code ?? '',
    [ids.accountNumber]: record.accountNumber ?? '',
    // Normalized so a legacy 'Comdata' selects the COMDATA option and
    // the next save converges the row — see canonicalDiscountProgram.
    [ids.discountProgram]: record.discountProgram
      ? canonicalDiscountProgram(record.discountProgram)
      : '',
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
  return mapValsToFuelVendorArgs(vals);
}

function optionalStr(v: unknown): string | undefined {
  const s = typeof v === 'string' ? v.trim() : '';
  return s.length > 0 ? s : undefined;
}
