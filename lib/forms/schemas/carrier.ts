/**
 * Carrier (broker→carrier partnership) create schema.
 *
 * Maps 1:1 to `api.carrierPartnerships.create`. Org arg is
 * `brokerOrgId` (not `organizationId` / `workosOrgId`) — see the
 * rollout doc for the per-mutation naming map.
 *
 * Sections:
 *   - Identity         — MC# (Required), legal name (Required), DBA, USDOT
 *   - Contact          — first/last/email/phone
 *   - Address          — composite (recommended; partnership row stores
 *                        the address fields directly, no nested object)
 *   - Insurance        — provider + expiration
 *   - Pay terms        — default Net-X + fuel-tracking toggle
 *   - Notes
 *
 * Notes on the design bundle's CARRIER schema:
 *   - The prototype's `type: 'fleet' | 'owner-op'` toggle revealed a
 *     dedicated driver-license section. That section's fields
 *     (driverLicense, driverClass, driverExp) are NOT supported by
 *     `carrierPartnerships.create` — those would belong on a separate
 *     driver record created via `createOwnerDriverRecord`. To keep
 *     this migration mechanical, we drop the showIf driver block and
 *     handle Owner Op as a follow-up (a future page wrapper can chain
 *     a driver create after the partnership lands).
 */

import type {
  CreateFormSchema,
  FieldOption,
} from '@/components/web/create-form';

const PAYMENT_TERMS_OPTIONS: FieldOption[] = [
  { value: 'Net15', label: 'Net 15' },
  { value: 'Net30', label: 'Net 30' },
  { value: 'Net45', label: 'Net 45' },
  { value: 'QuickPay', label: 'Quick pay · 96% same-day' },
];

export const CARRIER_FIELD_IDS = {
  mcNumber: 'mcNumber',
  carrierName: 'carrierName',
  carrierDba: 'carrierDba',
  usdotNumber: 'usdotNumber',
  contactFirstName: 'contactFirstName',
  contactLastName: 'contactLastName',
  contactEmail: 'contactEmail',
  contactPhone: 'contactPhone',
  insuranceProvider: 'insuranceProvider',
  insuranceExpiration: 'insuranceExpiration',
  // Address sub-fields
  addrStreet: 'addressLine',
  addrSuite: 'addressLine2',
  addrCity: 'city',
  addrState: 'state',
  addrZip: 'zip',
  country: 'country',
  defaultPaymentTerms: 'defaultPaymentTerms',
  trackFuelConsumption: 'trackFuelConsumption',
  internalNotes: 'internalNotes',
} as const;

export function buildCarrierSchema(): CreateFormSchema {
  const ids = CARRIER_FIELD_IDS;
  return {
    entity: 'carrier',
    // ⚠️ BUMP THIS when making breaking schema changes (renamed field,
    // removed field, changed enum value, changed field kind). See
    // `docs/schema-evolution.md` for the policy. Old drafts on a
    // stale key are abandoned and the 30-day cron sweeps them up.
    draftKey: 'carrier-create-v1',
    breadcrumb: ['Company Operations', 'Carriers', 'New carrier'],
    title: 'New carrier',
    subtitle:
      'Partner carrier — fleet or owner-op. MC# is the federal motor-carrier number; everything else can be filled in later if you’re onboarding fast.',
    sections: [
      {
        id: 'identity',
        title: 'Identity',
        fields: [
          {
            id: ids.carrierName,
            label: 'Legal name',
            kind: 'text',
            required: 'tier1',
            span: 2,
            placeholder: 'e.g. Pacific Crest Logistics LLC',
            hint: 'As shown on the W-9.',
          },
          {
            id: ids.carrierDba,
            label: 'DBA / Trade name',
            kind: 'text',
            placeholder: 'Leave blank if same as legal',
          },
          {
            id: ids.mcNumber,
            label: 'Operating Auth (MC#)',
            kind: 'mono',
            required: 'tier1',
            prefix: 'MC-',
            placeholder: '000000',
            hint: 'Federal motor-carrier number.',
            validate: (v) =>
              typeof v === 'string' &&
              v.trim().length > 0 &&
              !/^\d+$/.test(v.trim())
                ? 'MC# should be digits only — drop the "MC-" prefix when typing.'
                : null,
          },
          {
            id: ids.usdotNumber,
            label: 'USDOT #',
            kind: 'mono',
            recommended: true,
            placeholder: '0000000',
          },
        ],
      },
      {
        id: 'contact',
        title: 'Contact',
        subtitle: 'Who at the carrier do dispatch + accounting talk to?',
        fields: [
          {
            id: ids.contactFirstName,
            label: 'First name',
            kind: 'text',
            recommended: true,
            placeholder: 'First',
          },
          {
            id: ids.contactLastName,
            label: 'Last name',
            kind: 'text',
            recommended: true,
            placeholder: 'Last',
          },
          {
            id: ids.contactEmail,
            label: 'Email',
            kind: 'text',
            recommended: true,
            placeholder: 'dispatch@example.com',
            validate: (v) =>
              typeof v === 'string' && v && !v.includes('@')
                ? 'Looks like an incomplete email — did you mean to include @?'
                : null,
          },
          {
            id: ids.contactPhone,
            label: 'Phone',
            kind: 'text',
            recommended: true,
            placeholder: '(555) 555-0123',
            hint:
              'If filled, the carrier gets an Otoqa Driver account auto-provisioned on save.',
          },
        ],
      },
      {
        id: 'address',
        title: 'Address',
        subtitle: 'Physical or billing — used on settlements.',
        fields: [
          {
            id: 'addressComposite',
            label: 'Physical address',
            kind: 'address',
            recommended: true,
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
        id: 'insurance',
        title: 'Insurance',
        subtitle:
          'Required before dispatching the first load. You can add the COI later from the carrier page.',
        fields: [
          {
            id: ids.insuranceProvider,
            label: 'Provider',
            kind: 'text',
            recommended: true,
            placeholder: 'e.g. Progressive Commercial',
          },
          {
            id: ids.insuranceExpiration,
            label: 'Expires',
            kind: 'date',
            recommended: true,
            hint: 'We’ll remind you 30 days before expiration.',
          },
        ],
      },
      {
        id: 'pay',
        title: 'Pay terms',
        fields: [
          {
            id: ids.defaultPaymentTerms,
            label: 'Default terms',
            kind: 'select',
            recommended: true,
            options: PAYMENT_TERMS_OPTIONS,
          },
          {
            id: ids.trackFuelConsumption,
            label: 'Fuel tracking',
            kind: 'toggle',
            toggleLabel: 'Track fuel for this carrier on the diesel report',
            hint: 'Turn on for carriers whose drivers fuel up on our fuel cards.',
          },
        ],
      },
      {
        id: 'notes',
        title: 'Notes',
        fields: [
          {
            id: ids.internalNotes,
            label: 'Internal notes',
            kind: 'textarea',
            span: 2,
            rows: 3,
            placeholder:
              'Anything dispatch should know — lane preferences, equipment quirks, etc.',
          },
        ],
      },
    ],
  };
}

/* ────────────────────────────────────────────────────────────────────
 *  Value-shape translator
 *
 *  All field IDs already match the mutation's arg names, so the
 *  translator is mostly pass-through with empty-string → undefined
 *  coercion for the optionals.
 * ──────────────────────────────────────────────────────────────── */

export interface CarrierCreateArgs {
  mcNumber: string;
  carrierName: string;
  carrierDba?: string;
  usdotNumber?: string;
  contactFirstName?: string;
  contactLastName?: string;
  contactEmail?: string;
  contactPhone?: string;
  insuranceProvider?: string;
  insuranceExpiration?: string;
  addressLine?: string;
  addressLine2?: string;
  city?: string;
  state?: string;
  zip?: string;
  country?: string;
  defaultPaymentTerms?: string;
  trackFuelConsumption?: boolean;
  internalNotes?: string;
}

export function mapValsToCarrierArgs(
  vals: Record<string, unknown>,
): CarrierCreateArgs {
  const ids = CARRIER_FIELD_IDS;
  return {
    mcNumber: String(vals[ids.mcNumber] ?? '').trim(),
    carrierName: String(vals[ids.carrierName] ?? '').trim(),
    carrierDba: optionalStr(vals[ids.carrierDba]),
    usdotNumber: optionalStr(vals[ids.usdotNumber]),
    contactFirstName: optionalStr(vals[ids.contactFirstName]),
    contactLastName: optionalStr(vals[ids.contactLastName]),
    contactEmail: optionalStr(vals[ids.contactEmail]),
    contactPhone: optionalStr(vals[ids.contactPhone]),
    insuranceProvider: optionalStr(vals[ids.insuranceProvider]),
    insuranceExpiration: optionalStr(vals[ids.insuranceExpiration]),
    addressLine: optionalStr(vals[ids.addrStreet]),
    addressLine2: optionalStr(vals[ids.addrSuite]),
    city: optionalStr(vals[ids.addrCity]),
    state: optionalStr(vals[ids.addrState]),
    zip: optionalStr(vals[ids.addrZip]),
    // AddressAutocomplete writes 'US' when a Google Places result is
    // picked; default 'US' so a manually-typed address still produces
    // a valid country value.
    country: optionalStr(vals[ids.country]) ?? 'US',
    defaultPaymentTerms: optionalStr(vals[ids.defaultPaymentTerms]),
    trackFuelConsumption: vals[ids.trackFuelConsumption] === true ? true : undefined,
    internalNotes: optionalStr(vals[ids.internalNotes]),
  };
}

function optionalStr(v: unknown): string | undefined {
  const s = typeof v === 'string' ? v.trim() : '';
  return s.length > 0 ? s : undefined;
}
