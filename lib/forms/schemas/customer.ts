/**
 * Customer create schema.
 *
 * Maps 1:1 to `api.customers.create` (org arg is `workosOrgId`, NOT
 * `organizationId` — that varies per mutation, see the rollout doc).
 *
 * Sections:
 *   - Type            — companyType segmented + status
 *   - Identity        — legal name + office identifier
 *   - Address         — composite (Required) — every customer needs a
 *                       physical address for billing + dispatch
 *   - Contacts        — primary + (optional) secondary
 *   - Operations      — loadingType + scheduleType + pickup/delivery
 *                       instructions
 *   - Notes           — internal-only notes
 *
 * Country defaults to "US" so the address composite's mutation arg is
 * never empty — the Convex validator requires it.
 */

import type {
  CreateFormSchema,
  FieldOption,
} from '@/components/web/create-form';
import { US_STATE_OPTIONS } from '@/lib/forms/options/us-states';

const COMPANY_TYPE_OPTIONS: FieldOption[] = [
  { value: 'Shipper', label: 'Shipper' },
  { value: 'Broker', label: 'Broker' },
  { value: 'Manufacturer', label: 'Manufacturer' },
  { value: 'Distributor', label: 'Distributor' },
];

const STATUS_OPTIONS: FieldOption[] = [
  { value: 'Active', label: 'Active' },
  { value: 'Prospect', label: 'Prospect' },
  { value: 'Inactive', label: 'Inactive' },
];

const LOADING_TYPE_OPTIONS: FieldOption[] = [
  { value: 'Live Load', label: 'Live load' },
  { value: 'Drop & Hook', label: 'Drop & hook' },
  { value: 'Appointment', label: 'Appointment' },
];

const SCHEDULE_OPTIONS: FieldOption[] = [
  { value: '24/7', label: '24/7' },
  { value: 'Business Hours', label: 'Business hours' },
  { value: 'Appointment Only', label: 'Appointment only' },
  { value: 'Specific Hours', label: 'Specific hours' },
];

export const CUSTOMER_FIELD_IDS = {
  name: 'name',
  companyType: 'companyType',
  status: 'status',
  office: 'office',
  // Address sub-fields
  addrStreet: 'addressLine1',
  addrSuite: 'addressLine2',
  addrCity: 'city',
  addrState: 'state',
  addrZip: 'zip',
  country: 'country',
  // Primary contact
  primaryContactName: 'primaryContactName',
  primaryContactTitle: 'primaryContactTitle',
  primaryContactEmail: 'primaryContactEmail',
  primaryContactPhone: 'primaryContactPhone',
  // Secondary contact
  secondaryContactName: 'secondaryContactName',
  secondaryContactEmail: 'secondaryContactEmail',
  secondaryContactPhone: 'secondaryContactPhone',
  // Operations
  loadingType: 'loadingType',
  locationScheduleType: 'locationScheduleType',
  instructions: 'instructions',
  internalNotes: 'internalNotes',
} as const;

export function buildCustomerSchema(): CreateFormSchema {
  const ids = CUSTOMER_FIELD_IDS;
  return {
    entity: 'customer',
    // ⚠️ Bump on breaking changes. See docs/schema-evolution.md.
    draftKey: 'customer-create-v1',
    breadcrumb: ['Company Operations', 'Customers', 'New customer'],
    title: 'New customer',
    subtitle:
      'Shipper, broker, manufacturer, or distributor. The minimum we need to invoice is name, type, address, and a billing contact.',
    sections: [
      {
        id: 'type',
        title: 'Type',
        fields: [
          {
            id: ids.companyType,
            label: 'Customer type',
            // Was segmented (Shipper / Broker / Manufacturer /
            // Distributor pills). Dropping to a select keeps the
            // Type row clean and matches the Status select's
            // visual weight in the same row. Dropping `span: 2`
            // since a select needs no extra width.
            kind: 'select',
            required: 'tier1',
            default: 'Shipper',
            options: COMPANY_TYPE_OPTIONS,
          },
          {
            id: ids.status,
            label: 'Status',
            kind: 'select',
            required: 'tier1',
            default: 'Active',
            options: STATUS_OPTIONS,
          },
        ],
      },
      {
        id: 'identity',
        title: 'Identity',
        fields: [
          {
            id: ids.name,
            label: 'Legal name',
            kind: 'text',
            required: 'tier1',
            span: 2,
            placeholder: 'e.g. Foster Farms',
            hint: 'As shown on the customer’s W-9 or master agreement.',
          },
          {
            id: ids.office,
            label: 'Office / Branch',
            kind: 'text',
            placeholder:
              'e.g. "West Coast DC" — used when the customer has multiple locations.',
          },
        ],
      },
      {
        id: 'address',
        title: 'Address',
        subtitle: 'Required so we can invoice + dispatch correctly.',
        fields: [
          {
            id: 'addressComposite',
            label: 'Physical address',
            kind: 'address',
            required: 'tier1',
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
        id: 'primary-contact',
        title: 'Primary contact',
        subtitle:
          'Who do we talk to about loads + invoices? Add a secondary contact below for backup.',
        fields: [
          {
            id: ids.primaryContactName,
            label: 'Name',
            kind: 'text',
            recommended: true,
            placeholder: 'First Last',
          },
          {
            id: ids.primaryContactTitle,
            label: 'Title',
            kind: 'text',
            placeholder: 'Director of Logistics',
          },
          {
            id: ids.primaryContactEmail,
            label: 'Email',
            kind: 'text',
            recommended: true,
            placeholder: 'logistics@example.com',
            validate: (v) =>
              typeof v === 'string' && v && !v.includes('@')
                ? 'Looks like an incomplete email — did you mean to include @?'
                : null,
          },
          {
            id: ids.primaryContactPhone,
            label: 'Phone',
            kind: 'text',
            recommended: true,
            placeholder: '(555) 555-0123',
          },
        ],
      },
      {
        id: 'secondary-contact',
        title: 'Secondary contact',
        subtitle: 'Optional backup — dispatch tries them when the primary is unreachable.',
        fields: [
          {
            id: ids.secondaryContactName,
            label: 'Name',
            kind: 'text',
            placeholder: 'First Last',
          },
          {
            id: ids.secondaryContactEmail,
            label: 'Email',
            kind: 'text',
            placeholder: 'backup@example.com',
            validate: (v) =>
              typeof v === 'string' && v && !v.includes('@')
                ? 'Looks like an incomplete email — did you mean to include @?'
                : null,
          },
          {
            id: ids.secondaryContactPhone,
            label: 'Phone',
            kind: 'text',
            placeholder: '(555) 555-0123',
          },
        ],
      },
      {
        id: 'operations',
        title: 'Operations',
        subtitle:
          'How does this customer like loads picked up / delivered? Drivers see these instructions on the load page.',
        fields: [
          {
            id: ids.loadingType,
            label: 'Loading type',
            kind: 'segmented',
            recommended: true,
            span: 2,
            options: LOADING_TYPE_OPTIONS,
          },
          {
            id: ids.locationScheduleType,
            label: 'Schedule',
            kind: 'select',
            recommended: true,
            options: SCHEDULE_OPTIONS,
          },
          {
            id: ids.instructions,
            label: 'Pickup / delivery instructions',
            kind: 'textarea',
            span: 2,
            rows: 3,
            placeholder:
              'e.g. "Check in at security gate — give them your truck #. Lumper required."',
          },
        ],
      },
      {
        id: 'notes',
        title: 'Internal notes',
        fields: [
          {
            id: ids.internalNotes,
            label: 'Notes',
            kind: 'textarea',
            span: 2,
            rows: 3,
            placeholder: 'Optional · not shown to the customer.',
          },
        ],
      },
    ],
  };
}

/* ────────────────────────────────────────────────────────────────────
 *  Value-shape translator
 * ──────────────────────────────────────────────────────────────── */

export interface CustomerCreateArgs {
  name: string;
  companyType: 'Shipper' | 'Broker' | 'Manufacturer' | 'Distributor';
  status: 'Active' | 'Inactive' | 'Prospect';
  office?: string;
  addressLine1: string;
  addressLine2?: string;
  city: string;
  state: string;
  zip: string;
  country: string;
  primaryContactName?: string;
  primaryContactTitle?: string;
  primaryContactEmail?: string;
  primaryContactPhone?: string;
  secondaryContactName?: string;
  secondaryContactEmail?: string;
  secondaryContactPhone?: string;
  loadingType?: 'Live Load' | 'Drop & Hook' | 'Appointment';
  locationScheduleType?:
    | '24/7'
    | 'Business Hours'
    | 'Appointment Only'
    | 'Specific Hours';
  instructions?: string;
  internalNotes?: string;
}

export function mapValsToCustomerArgs(
  vals: Record<string, unknown>,
): CustomerCreateArgs {
  const ids = CUSTOMER_FIELD_IDS;
  return {
    name: String(vals[ids.name] ?? '').trim(),
    companyType: (String(vals[ids.companyType] ?? 'Shipper') ||
      'Shipper') as CustomerCreateArgs['companyType'],
    status: (String(vals[ids.status] ?? 'Active') ||
      'Active') as CustomerCreateArgs['status'],
    office: optionalStr(vals[ids.office]),
    addressLine1: String(vals[ids.addrStreet] ?? '').trim(),
    addressLine2: optionalStr(vals[ids.addrSuite]),
    city: String(vals[ids.addrCity] ?? '').trim(),
    state: String(vals[ids.addrState] ?? '').trim(),
    zip: String(vals[ids.addrZip] ?? '').trim(),
    // AddressAutocomplete writes 'US' on Google-Places picks; default
    // 'US' so a manually-typed address still produces a valid arg.
    country: String(vals[ids.country] ?? 'US') || 'US',
    primaryContactName: optionalStr(vals[ids.primaryContactName]),
    primaryContactTitle: optionalStr(vals[ids.primaryContactTitle]),
    primaryContactEmail: optionalStr(vals[ids.primaryContactEmail]),
    primaryContactPhone: optionalStr(vals[ids.primaryContactPhone]),
    secondaryContactName: optionalStr(vals[ids.secondaryContactName]),
    secondaryContactEmail: optionalStr(vals[ids.secondaryContactEmail]),
    secondaryContactPhone: optionalStr(vals[ids.secondaryContactPhone]),
    loadingType: optionalEnum<CustomerCreateArgs['loadingType']>(
      vals[ids.loadingType],
    ),
    locationScheduleType: optionalEnum<
      CustomerCreateArgs['locationScheduleType']
    >(vals[ids.locationScheduleType]),
    instructions: optionalStr(vals[ids.instructions]),
    internalNotes: optionalStr(vals[ids.internalNotes]),
  };
}

function optionalStr(v: unknown): string | undefined {
  const s = typeof v === 'string' ? v.trim() : '';
  return s.length > 0 ? s : undefined;
}

// Cast helper for optional literal-union fields. The shell stores
// option values as strings; the mutation validator narrows to a
// specific union. Empty string → undefined (Convex's
// `v.optional(v.union(...))` allows that).
function optionalEnum<T extends string | undefined>(v: unknown): T {
  const s = typeof v === 'string' ? v.trim() : '';
  return (s.length > 0 ? (s as T) : (undefined as T));
}
