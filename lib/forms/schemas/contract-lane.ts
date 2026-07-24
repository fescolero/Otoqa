/**
 * Contract-lane create/edit schema.
 *
 * Maps 1:1 to `api.contractLanes.create` / `update`. Mirrors the
 * design's CONTRACT_SCHEMA (record-create-schemas.jsx) with sections:
 *
 *   - Contract information — name, HCR, trip #, priority, term,
 *                            notes, active toggle
 *   - Lane details         — lane-stops composite (facility binding),
 *                            miles, commodity
 *   - Equipment requirements — class + size
 *   - Operating schedule   — days-of-week + exclude-holidays toggle
 *   - Rate information     — rate, type, currency, minimums, subsidiary
 *
 * A *factory* schema (like fuel-entry): the customer's facility rows
 * feed the per-stop facility dropdown, so the page wrapper passes
 * them in. Option values use the Convex literals directly ('Dry Van',
 * 'Per Mile', …) so the vals→args mapping is a straight copy.
 */

import type { Id } from '@/convex/_generated/dataModel';
import type {
  CreateFormSchema,
  FieldOption,
} from '@/components/web/create-form';
import type {
  LaneStopItem,
  LaneFacilityOption,
} from '@/components/web/create-form/controls/lane-stops';
import { emptyLaneStop } from '@/components/web/create-form/controls/lane-stops';

const PRIORITY_OPTIONS: FieldOption[] = [
  { value: 'Primary', label: 'Primary' },
  { value: 'Secondary', label: 'Secondary' },
];

const EQUIPMENT_CLASS_OPTIONS: FieldOption[] = [
  { value: 'Bobtail', label: 'Bobtail' },
  { value: 'Dry Van', label: 'Dry van' },
  { value: 'Refrigerated', label: 'Refrigerated' },
  { value: 'Flatbed', label: 'Flatbed' },
  { value: 'Tanker', label: 'Tanker' },
];

const EQUIPMENT_SIZE_OPTIONS: FieldOption[] = [
  { value: '53ft', label: '53′' },
  { value: '48ft', label: '48′' },
  { value: '45ft', label: '45′' },
];

const RATE_TYPE_OPTIONS: FieldOption[] = [
  { value: 'Per Mile', label: 'Per mile' },
  { value: 'Flat Rate', label: 'Flat rate' },
  { value: 'Per Stop', label: 'Per stop' },
];

const CURRENCY_OPTIONS: FieldOption[] = [
  { value: 'USD', label: 'USD' },
  { value: 'CAD', label: 'CAD' },
  { value: 'MXN', label: 'MXN' },
];

export const CONTRACT_LANE_FIELD_IDS = {
  contractName: 'contractName',
  hcr: 'hcr',
  tripNumber: 'tripNumber',
  lanePriority: 'lanePriority',
  contractPeriodStart: 'contractPeriodStart',
  contractPeriodEnd: 'contractPeriodEnd',
  notes: 'notes',
  isActive: 'isActive',
  stops: 'stops',
  miles: 'miles',
  loadCommodity: 'loadCommodity',
  equipmentClass: 'equipmentClass',
  equipmentSize: 'equipmentSize',
  activeDays: 'activeDays',
  excludeHolidays: 'excludeHolidays',
  rate: 'rate',
  rateType: 'rateType',
  currency: 'currency',
  minimumRate: 'minimumRate',
  minimumQuantity: 'minimumQuantity',
  subsidiary: 'subsidiary',
} as const;

export interface BuildContractLaneSchemaArgs {
  mode?: 'create' | 'edit';
  /** Customer facility rows for the per-stop facility binding. */
  facilities?: LaneFacilityOption[];
}

export function buildContractLaneSchema(
  args: BuildContractLaneSchemaArgs,
): CreateFormSchema {
  const { mode = 'create', facilities = [] } = args;
  const isEdit = mode === 'edit';
  const ids = CONTRACT_LANE_FIELD_IDS;
  const label = isEdit ? 'Edit contract lane' : 'New contract lane';

  return {
    entity: 'contractLane',
    breadcrumb: ['Company Operations', 'Customers', label],
    title: label,
    subtitle: isEdit
      ? 'Update this standing lane. Changes apply to loads generated from now on.'
      : 'A standing lane under a customer. Loads that match get generated on the operating schedule at the contracted rate.',
    sections: [
      {
        id: 'info',
        title: 'Contract information',
        fields: [
          {
            id: ids.contractName,
            label: 'Contract name',
            required: 'tier1',
            placeholder: 'e.g. 945L4-5',
          },
          {
            id: ids.hcr,
            label: 'HCR',
            kind: 'mono',
            recommended: true,
            placeholder: '945L4',
          },
          {
            id: ids.tripNumber,
            label: 'Trip number',
            kind: 'mono',
            placeholder: '5',
          },
          {
            id: ids.lanePriority,
            label: 'Priority',
            kind: 'select',
            options: PRIORITY_OPTIONS,
            placeholder: 'Select priority',
          },
          {
            id: ids.contractPeriodStart,
            label: 'Contract start',
            kind: 'date',
            required: 'tier1',
          },
          {
            id: ids.contractPeriodEnd,
            label: 'Contract end',
            kind: 'date',
            required: 'tier1',
          },
          {
            id: ids.notes,
            label: 'Notes',
            kind: 'textarea',
            span: 2,
            rows: 2,
            placeholder: 'Internal notes about this lane.',
          },
          {
            id: ids.isActive,
            label: 'Status',
            kind: 'toggle',
            toggleLabel: 'Active',
            default: true,
          },
        ],
      },
      {
        id: 'lane',
        title: 'Lane details',
        subtitle:
          'The ordered stops that define this lane. At least a pickup and a delivery.',
        fields: [
          {
            id: ids.stops,
            label: 'Stops',
            kind: 'lane-stops',
            required: 'tier1',
            span: 2,
            facilities,
            default: [emptyLaneStop(1, 'Pickup'), emptyLaneStop(2, 'Delivery')],
            validate: (v) => {
              // Existing lanes may legitimately have a single stop
              // (e.g. USPS HCR loops), so only per-stop completeness
              // blocks save — not the count.
              const stops = Array.isArray(v) ? (v as LaneStopItem[]) : [];
              if (stops.length === 0) return 'Add at least one stop.';
              for (let i = 0; i < stops.length; i++) {
                const s = stops[i];
                if (!s.address.trim()) return `Stop ${i + 1}: enter an address.`;
                if (!s.city.trim() || !s.state.trim())
                  return `Stop ${i + 1}: enter a city and state.`;
              }
              return null;
            },
          },
          {
            id: ids.miles,
            label: 'Miles',
            kind: 'number',
            recommended: true,
            suffix: 'mi',
            placeholder: '177.1',
            grouping: false,
          },
          {
            id: ids.loadCommodity,
            label: 'Load commodity',
            placeholder: 'e.g. US Mail',
          },
        ],
      },
      {
        id: 'equipment',
        title: 'Equipment requirements',
        fields: [
          {
            id: ids.equipmentClass,
            label: 'Equipment class',
            kind: 'select',
            recommended: true,
            options: EQUIPMENT_CLASS_OPTIONS,
            placeholder: 'Select class',
          },
          {
            id: ids.equipmentSize,
            label: 'Equipment size',
            kind: 'select',
            options: EQUIPMENT_SIZE_OPTIONS,
            placeholder: 'Select size',
          },
        ],
      },
      {
        id: 'schedule',
        title: 'Operating schedule',
        subtitle: 'Which days this lane runs. Loads generate on these days only.',
        fields: [
          {
            id: ids.activeDays,
            label: 'Operating days',
            kind: 'days',
            required: 'tier1',
            span: 2,
            // Mon–Fri, the overwhelmingly common contract schedule.
            default: [1, 2, 3, 4, 5],
            requiredMsg: 'Pick at least one operating day.',
          },
          {
            id: ids.excludeHolidays,
            label: 'Holidays',
            kind: 'toggle',
            toggleLabel: 'Exclude federal holidays',
            default: true,
            span: 2,
          },
        ],
      },
      {
        id: 'rate',
        title: 'Rate information',
        fields: [
          {
            id: ids.rate,
            label: 'Rate',
            kind: 'currency',
            required: 'tier1',
            placeholder: '2.87',
          },
          {
            id: ids.rateType,
            label: 'Rate type',
            kind: 'select',
            required: 'tier1',
            options: RATE_TYPE_OPTIONS,
            default: 'Per Mile',
          },
          {
            id: ids.currency,
            label: 'Currency',
            kind: 'select',
            options: CURRENCY_OPTIONS,
            default: 'USD',
          },
          {
            id: ids.minimumRate,
            label: 'Minimum rate',
            kind: 'currency',
            placeholder: '0.00',
          },
          {
            id: ids.minimumQuantity,
            label: 'Minimum quantity',
            kind: 'number',
            placeholder: '0',
            grouping: false,
          },
          {
            id: ids.subsidiary,
            label: 'Subsidiary',
            placeholder: 'Optional',
          },
        ],
      },
    ],
  };
}

/* ────────────────────────────────────────────────────────────────────
 *  Record ↔ vals translation (page-wrapper side)
 * ──────────────────────────────────────────────────────────────── */

/** Subset of the persisted contractLanes row the schema reads.
 *  Redeclared locally so this file stays free of generated-API
 *  imports (`Id` types are fine — they're pure type aliases). */
export interface ContractLaneRecord {
  contractName: string;
  contractPeriodStart: string;
  contractPeriodEnd: string;
  hcr?: string;
  tripNumber?: string;
  lanePriority?: 'Primary' | 'Secondary';
  notes?: string;
  stops: LaneStopItem[];
  miles?: number;
  loadCommodity?: string;
  equipmentClass?: string;
  equipmentSize?: string;
  rate: number;
  rateType: string;
  currency?: string;
  minimumRate?: number;
  minimumQuantity?: number;
  scheduleRule?: {
    activeDays: number[];
    excludeFederalHolidays?: boolean;
    customExclusions?: string[];
  };
  subsidiary?: string;
  isActive?: boolean;
}

export function mapContractLaneRecordToVals(
  record: ContractLaneRecord,
): Record<string, unknown> {
  const ids = CONTRACT_LANE_FIELD_IDS;
  return {
    [ids.contractName]: record.contractName,
    [ids.hcr]: record.hcr ?? '',
    [ids.tripNumber]: record.tripNumber ?? '',
    [ids.lanePriority]: record.lanePriority ?? '',
    [ids.contractPeriodStart]: record.contractPeriodStart,
    [ids.contractPeriodEnd]: record.contractPeriodEnd,
    [ids.notes]: record.notes ?? '',
    [ids.isActive]: record.isActive ?? true,
    [ids.stops]: record.stops,
    [ids.miles]: record.miles ?? '',
    [ids.loadCommodity]: record.loadCommodity ?? '',
    [ids.equipmentClass]: record.equipmentClass ?? '',
    [ids.equipmentSize]: record.equipmentSize ?? '',
    [ids.activeDays]: record.scheduleRule?.activeDays ?? [1, 2, 3, 4, 5],
    [ids.excludeHolidays]: record.scheduleRule?.excludeFederalHolidays ?? true,
    [ids.rate]: record.rate,
    [ids.rateType]: record.rateType,
    [ids.currency]: record.currency ?? 'USD',
    [ids.minimumRate]: record.minimumRate ?? '',
    [ids.minimumQuantity]: record.minimumQuantity ?? '',
    [ids.subsidiary]: record.subsidiary ?? '',
  };
}

/** Wire shape shared by create and update (update takes everything
 *  optional; create additionally needs customerCompanyId /
 *  workosOrgId / createdBy, which the page wrapper appends). */
export interface ContractLaneArgs {
  contractName: string;
  contractPeriodStart: string;
  contractPeriodEnd: string;
  hcr?: string;
  tripNumber?: string;
  lanePriority?: 'Primary' | 'Secondary';
  notes?: string;
  stops: Array<Omit<LaneStopItem, 'facilityId'> & { facilityId?: Id<'facilities'> }>;
  miles?: number;
  loadCommodity?: string;
  equipmentClass?: 'Bobtail' | 'Dry Van' | 'Refrigerated' | 'Flatbed' | 'Tanker';
  equipmentSize?: '53ft' | '48ft' | '45ft';
  rate: number;
  rateType: 'Per Mile' | 'Flat Rate' | 'Per Stop';
  currency?: 'USD' | 'CAD' | 'MXN';
  minimumRate?: number;
  minimumQuantity?: number;
  scheduleRule: {
    activeDays: number[];
    excludeFederalHolidays: boolean;
    customExclusions: string[];
  };
  subsidiary?: string;
  isActive: boolean;
}

export function mapValsToContractLaneArgs(
  vals: Record<string, unknown>,
  opts?: {
    /** Preserved from the existing record on edit — the form has no
     *  UI for custom exclusion dates yet. */
    customExclusions?: string[];
  },
): ContractLaneArgs {
  const ids = CONTRACT_LANE_FIELD_IDS;
  const str = (id: string) => String(vals[id] ?? '').trim();
  const optStr = (id: string) => str(id) || undefined;
  const optNum = (id: string) => {
    const v = vals[id];
    return typeof v === 'number' && !Number.isNaN(v) ? v : undefined;
  };

  const rawStops = Array.isArray(vals[ids.stops])
    ? (vals[ids.stops] as LaneStopItem[])
    : [];
  const stops = rawStops.map((s, i) => ({
    address: s.address.trim(),
    city: s.city.trim(),
    state: s.state.trim(),
    zip: s.zip.trim(),
    stopOrder: i + 1,
    stopType: s.stopType,
    type: s.type,
    arrivalTime: s.arrivalTime,
    facilityId: s.facilityId ? (s.facilityId as Id<'facilities'>) : undefined,
    nassCode: s.nassCode || undefined,
  }));

  const priority = str(ids.lanePriority);
  const equipClass = str(ids.equipmentClass);
  const equipSize = str(ids.equipmentSize);
  const currency = str(ids.currency);

  return {
    contractName: str(ids.contractName),
    contractPeriodStart: str(ids.contractPeriodStart),
    contractPeriodEnd: str(ids.contractPeriodEnd),
    hcr: optStr(ids.hcr),
    tripNumber: optStr(ids.tripNumber),
    lanePriority:
      priority === 'Primary' || priority === 'Secondary' ? priority : undefined,
    notes: optStr(ids.notes),
    stops,
    miles: optNum(ids.miles),
    loadCommodity: optStr(ids.loadCommodity),
    equipmentClass:
      equipClass === 'Bobtail' ||
      equipClass === 'Dry Van' ||
      equipClass === 'Refrigerated' ||
      equipClass === 'Flatbed' ||
      equipClass === 'Tanker'
        ? equipClass
        : undefined,
    equipmentSize:
      equipSize === '53ft' || equipSize === '48ft' || equipSize === '45ft'
        ? equipSize
        : undefined,
    rate: optNum(ids.rate) ?? 0,
    rateType:
      str(ids.rateType) === 'Flat Rate'
        ? 'Flat Rate'
        : str(ids.rateType) === 'Per Stop'
          ? 'Per Stop'
          : 'Per Mile',
    currency:
      currency === 'USD' || currency === 'CAD' || currency === 'MXN'
        ? currency
        : undefined,
    minimumRate: optNum(ids.minimumRate),
    minimumQuantity: optNum(ids.minimumQuantity),
    scheduleRule: {
      activeDays: Array.isArray(vals[ids.activeDays])
        ? (vals[ids.activeDays] as number[])
        : [],
      excludeFederalHolidays: Boolean(vals[ids.excludeHolidays]),
      customExclusions: opts?.customExclusions ?? [],
    },
    subsidiary: optStr(ids.subsidiary),
    isActive: Boolean(vals[ids.isActive]),
  };
}

/** Map facility registry rows into the shape the lane-stops control
 *  consumes. Lives here (not the page) so create + edit stay in sync. */
export function mapFacilitiesToOptions(
  facilities: Array<{
    _id: string;
    name: string;
    addressLine1?: string;
    city: string;
    state: string;
    postalCode?: string;
    externalCode?: string;
    verificationState?: string;
  }>,
): LaneFacilityOption[] {
  return facilities.map((f) => ({
    id: f._id,
    label: `${f.name} — ${f.city}, ${f.state}`,
    addressLine1: f.addressLine1,
    city: f.city,
    state: f.state,
    postalCode: f.postalCode,
    externalCode: f.externalCode,
    verified: f.verificationState === 'VERIFIED',
  }));
}
