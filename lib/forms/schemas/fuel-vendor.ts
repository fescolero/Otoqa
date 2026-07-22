/**
 * Fuel vendor create schema.
 *
 * Maps 1:1 to `api.fuelVendors.create`. Short-form schema — single
 * Identity / Contact / Address / Notes layout. No draft persistence
 * because the create flow is fast (~30 seconds to fill in name +
 * fuel-card account number) and the abandonment rate is too low to
 * justify the table-row cost.
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

export function buildFuelVendorSchema(): CreateFormSchema {
  const ids = FUEL_VENDOR_FIELD_IDS;
  return {
    entity: 'fuelVendor',
    breadcrumb: ['Company Operations', 'Fuel Vendors', 'New vendor'],
    title: 'New fuel vendor',
    subtitle:
      'A fuel-card processor (Comdata, EFS, WEX, etc.) or a direct-billing chain. Required: name. Everything else can be added later.',
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
            options: DISCOUNT_PROGRAM_OPTIONS,
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

function optionalStr(v: unknown): string | undefined {
  const s = typeof v === 'string' ? v.trim() : '';
  return s.length > 0 ? s : undefined;
}
