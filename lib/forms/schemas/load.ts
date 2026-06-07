/**
 * Load create schema.
 *
 * Maps 1:1 to `api.loads.createLoad`. Org arg is `workosOrgId` and
 * the customer dropdown needs to be populated from live Convex
 * data — both reasons this is a *factory* schema (like fuel-entry),
 * not a literal.
 *
 * Sections:
 *   - Customer + reference — customer (Required), internal id, order #,
 *                            PO #, HCR / Trip
 *   - Stops               — full-width stops-list composite
 *   - Commodity / equipment — equipmentType, equipmentLength,
 *                              load-level commodity, weight, units,
 *                              temperatures
 *   - Contact             — load-level point of contact (overrides
 *                              customer's primary contact)
 *   - Miles & instructions — contractMiles, generalInstructions
 *
 * Why no Assign-on-create section yet: the prior CreateLoadForm
 * allowed picking a driver/carrier at create time which immediately
 * spawned a dispatch leg. That's an operational habit but adds wiring
 * and conditional flows. Defer until the basic Load → detail flow is
 * proven.
 */

import type { Id, TableNames } from '@/convex/_generated/dataModel';
import type {
  CreateFormSchema,
  FieldOption,
} from '@/components/web/create-form';
import type { StopsListItem } from '@/components/web/create-form/controls/stops-list';

const EQUIPMENT_TYPE_OPTIONS: FieldOption[] = [
  { value: 'Dry Van', label: 'Dry van' },
  { value: 'Reefer', label: 'Reefer' },
  { value: 'Flatbed', label: 'Flatbed' },
  { value: 'Step Deck', label: 'Step deck' },
  { value: 'Lowboy', label: 'Lowboy' },
  { value: 'Tanker', label: 'Tanker' },
];

const UNITS_OPTIONS: FieldOption[] = [
  { value: 'Pallets', label: 'Pallets' },
  { value: 'Boxes', label: 'Boxes' },
  { value: 'Pieces', label: 'Pieces' },
  { value: 'Lbs', label: 'Lbs' },
  { value: 'Kg', label: 'Kg' },
];

const FLEET_OPTIONS: FieldOption[] = [
  { value: 'COMPANY', label: 'Company fleet' },
  { value: 'OWNER_OP', label: 'Owner operator' },
  { value: 'PARTNER', label: 'Partner carrier' },
];

export interface CustomerOptionRow {
  _id: Id<'customers'>;
  name: string;
}

export interface BuildLoadSchemaArgs {
  customers: CustomerOptionRow[];
}

export const LOAD_FIELD_IDS = {
  customerId: 'customerId',
  fleet: 'fleet',
  internalId: 'internalId',
  orderNumber: 'orderNumber',
  poNumber: 'poNumber',
  parsedHcr: 'parsedHcr',
  parsedTripNumber: 'parsedTripNumber',
  stops: 'stops',
  equipmentType: 'equipmentType',
  equipmentLength: 'equipmentLength',
  commodityDescription: 'commodityDescription',
  weight: 'weight',
  units: 'units',
  temperature: 'temperature',
  maxTemperature: 'maxTemperature',
  contactPersonName: 'contactPersonName',
  contactPersonPhone: 'contactPersonPhone',
  contactPersonEmail: 'contactPersonEmail',
  contractMiles: 'contractMiles',
  generalInstructions: 'generalInstructions',
} as const;

export function buildLoadSchema(args: BuildLoadSchemaArgs): CreateFormSchema {
  const ids = LOAD_FIELD_IDS;
  const customerOptions: FieldOption[] = args.customers.map((c) => ({
    value: c._id,
    label: c.name,
  }));

  return {
    entity: 'load',
    // ⚠️ Bump on breaking changes. See docs/schema-evolution.md.
    // The Load schema is the largest doc-size draft (stops-list ×
    // freeform instructions), so a bump abandons more bytes than
    // any other entity. Coordinate with whoever's mid-onboarding.
    draftKey: 'load-create-v1',
    breadcrumb: ['Load Operations', 'Loads', 'New load'],
    title: 'New load',
    subtitle:
      'Customer + at least one pickup and one delivery = enough to dispatch. Add HCR/Trip identifiers if this is contract freight.',
    sections: [
      {
        id: 'customer',
        title: 'Customer & reference',
        fields: [
          {
            id: ids.customerId,
            label: 'Customer',
            kind: 'select',
            required: 'tier1',
            span: 2,
            placeholder:
              customerOptions.length === 0
                ? 'No customers loaded'
                : '— Select —',
            options: customerOptions,
            hint: 'Pulls billing terms + contracted rates from the customer record.',
          },
          {
            id: ids.fleet,
            label: 'Fleet',
            kind: 'segmented',
            required: 'tier1',
            span: 2,
            default: 'COMPANY',
            options: FLEET_OPTIONS,
          },
          {
            id: ids.internalId,
            label: 'Internal ID',
            kind: 'mono',
            required: 'tier1',
            placeholder: 'OT-2026-0000',
            hint: 'Your internal load number — must be unique.',
          },
          {
            id: ids.orderNumber,
            label: 'Order #',
            kind: 'mono',
            required: 'tier1',
            placeholder: 'Customer order #',
          },
          {
            id: ids.poNumber,
            label: 'PO #',
            kind: 'mono',
            placeholder: 'Optional',
          },
          {
            id: ids.parsedHcr,
            label: 'HCR',
            kind: 'mono',
            placeholder: 'e.g. 917DK',
            hint: 'Highway contract route — leave blank for spot freight.',
          },
          {
            id: ids.parsedTripNumber,
            label: 'Trip',
            kind: 'mono',
            placeholder: 'e.g. 415',
          },
        ],
      },
      {
        id: 'stops',
        title: 'Stops',
        subtitle:
          'At least one pickup and one delivery. Add intermediate stops as needed. Drag-and-drop reordering is on the load page after save.',
        fields: [
          {
            id: ids.stops,
            label: 'Stops',
            kind: 'stops-list',
            required: 'tier1',
            requiredMsg:
              'A load needs at least one stop with an address and pickup window.',
            // Seed with a pickup + delivery — most loads need both,
            // and a pre-populated row is friendlier than an empty add
            // button.
            default: [
              seedStop(1, 'PICKUP'),
              seedStop(2, 'DELIVERY'),
            ],
            validate: (v) => {
              if (!Array.isArray(v) || v.length < 2) {
                return 'A load needs at least one pickup and one delivery.';
              }
              const stops = v as StopsListItem[];
              const hasPickup = stops.some((s) => s.stopType === 'PICKUP');
              const hasDelivery = stops.some((s) => s.stopType === 'DELIVERY');
              if (!hasPickup) return 'Add at least one pickup stop.';
              if (!hasDelivery) return 'Add at least one delivery stop.';
              for (let i = 0; i < stops.length; i++) {
                const s = stops[i];
                if (!s.address?.trim()) {
                  return `Stop ${i + 1}: address is required.`;
                }
                if (!s.windowBeginDate || !s.windowBeginTime) {
                  return `Stop ${i + 1}: window begin date + time are required.`;
                }
              }
              return null;
            },
          },
        ],
      },
      {
        id: 'equipment',
        title: 'Commodity & equipment',
        subtitle:
          'Load-level commodity summary. Per-stop details still go on each stop above.',
        fields: [
          {
            id: ids.commodityDescription,
            label: 'Commodity',
            kind: 'text',
            recommended: true,
            placeholder: 'e.g. Frozen poultry',
          },
          {
            id: ids.equipmentType,
            label: 'Equipment',
            kind: 'select',
            recommended: true,
            options: EQUIPMENT_TYPE_OPTIONS,
          },
          {
            id: ids.equipmentLength,
            label: 'Length',
            kind: 'number',
            suffix: 'ft',
            placeholder: '53',
          },
          {
            id: ids.weight,
            label: 'Weight',
            kind: 'number',
            recommended: true,
            suffix: 'lbs',
            placeholder: '0',
          },
          {
            id: ids.units,
            label: 'Units',
            kind: 'select',
            required: 'tier1',
            default: 'Pallets',
            options: UNITS_OPTIONS,
          },
          {
            id: ids.temperature,
            label: 'Temp (min)',
            kind: 'number',
            suffix: '°F',
            showIf: (v) => v[ids.equipmentType] === 'Reefer',
          },
          {
            id: ids.maxTemperature,
            label: 'Temp (max)',
            kind: 'number',
            suffix: '°F',
            showIf: (v) => v[ids.equipmentType] === 'Reefer',
          },
        ],
      },
      {
        id: 'contact',
        title: 'Load contact',
        subtitle:
          'Overrides the customer’s default contact when dispatch needs a specific person for this load.',
        fields: [
          {
            id: ids.contactPersonName,
            label: 'Name',
            kind: 'text',
            placeholder: 'First Last',
          },
          {
            id: ids.contactPersonPhone,
            label: 'Phone',
            kind: 'text',
            placeholder: '(555) 555-0123',
          },
          {
            id: ids.contactPersonEmail,
            label: 'Email',
            kind: 'text',
            placeholder: 'contact@example.com',
          },
        ],
      },
      {
        id: 'logistics',
        title: 'Miles & instructions',
        fields: [
          {
            id: ids.contractMiles,
            label: 'Contract miles',
            kind: 'number',
            placeholder: '0',
            hint: 'Leave blank to use Google miles computed on save.',
          },
          {
            id: ids.generalInstructions,
            label: 'General instructions',
            kind: 'textarea',
            span: 2,
            rows: 3,
            placeholder:
              'Anything that applies to the whole load — driver requirements, trailer wash, etc.',
          },
        ],
      },
    ],
  };
}

function seedStop(
  sequenceNumber: number,
  stopType: StopsListItem['stopType'],
): StopsListItem {
  return {
    sequenceNumber,
    stopType,
    loadingType: 'APPT',
    address: '',
    city: '',
    state: '',
    postalCode: '',
    windowBeginDate: '',
    windowBeginTime: '',
    windowEndDate: '',
    windowEndTime: '',
    commodityDescription: '',
    commodityUnits: 'Pallets',
    pieces: 1,
  };
}

/* ────────────────────────────────────────────────────────────────────
 *  Value-shape translator
 *
 *  All field ids match the mutation arg names; the only translation
 *  work is number coercion + Convex Id cast on customerId, and the
 *  stops array passes through with light cleanup.
 * ──────────────────────────────────────────────────────────────── */

export interface LoadCreateArgs {
  internalId: string;
  orderNumber: string;
  poNumber?: string;
  customerId: Id<'customers'>;
  fleet: string;
  equipmentType?: string;
  equipmentLength?: number;
  commodityDescription?: string;
  weight?: number;
  units: 'Pallets' | 'Boxes' | 'Pieces' | 'Lbs' | 'Kg';
  temperature?: number;
  maxTemperature?: number;
  contactPersonName?: string;
  contactPersonPhone?: string;
  contactPersonEmail?: string;
  generalInstructions?: string;
  contractMiles?: number;
  parsedHcr?: string;
  parsedTripNumber?: string;
  stops: StopsListItem[];
}

export function mapValsToLoadArgs(vals: Record<string, unknown>): LoadCreateArgs {
  const ids = LOAD_FIELD_IDS;
  const rawStops = Array.isArray(vals[ids.stops])
    ? (vals[ids.stops] as StopsListItem[])
    : [];

  return {
    internalId: String(vals[ids.internalId] ?? '').trim(),
    orderNumber: String(vals[ids.orderNumber] ?? '').trim(),
    poNumber: optionalStr(vals[ids.poNumber]),
    customerId: optionalIdRequired<'customers'>(vals[ids.customerId]),
    fleet: String(vals[ids.fleet] ?? 'COMPANY'),
    equipmentType: optionalStr(vals[ids.equipmentType]),
    equipmentLength: optionalNumber(vals[ids.equipmentLength]),
    commodityDescription: optionalStr(vals[ids.commodityDescription]),
    weight: optionalNumber(vals[ids.weight]),
    units: (String(vals[ids.units] ?? 'Pallets') ||
      'Pallets') as LoadCreateArgs['units'],
    temperature: optionalNumber(vals[ids.temperature]),
    maxTemperature: optionalNumber(vals[ids.maxTemperature]),
    contactPersonName: optionalStr(vals[ids.contactPersonName]),
    contactPersonPhone: optionalStr(vals[ids.contactPersonPhone]),
    contactPersonEmail: optionalStr(vals[ids.contactPersonEmail]),
    generalInstructions: optionalStr(vals[ids.generalInstructions]),
    contractMiles: optionalNumber(vals[ids.contractMiles]),
    parsedHcr: optionalStr(vals[ids.parsedHcr]),
    parsedTripNumber: optionalStr(vals[ids.parsedTripNumber]),
    stops: rawStops.map((s, i) => ({
      ...s,
      sequenceNumber: i + 1,
      pieces: Number(s.pieces) || 1,
      weight: s.weight !== undefined ? Number(s.weight) : undefined,
    })),
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

// Required-id variant — the schema declares customerId as tier1, so
// by the time we hit this translator the value must be a real id.
// Cast for the wire validator; if a caller bypasses validate() we
// fall back to an empty string and let the server reject it.
function optionalIdRequired<T extends TableNames>(v: unknown): Id<T> {
  if (typeof v !== 'string' || v.length === 0) return '' as Id<T>;
  return v as Id<T>;
}
