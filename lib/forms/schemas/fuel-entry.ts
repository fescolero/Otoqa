/**
 * Fuel-entry schema factory.
 *
 * Drives BOTH diesel (`api.fuelEntries.create`) and DEF
 * (`api.defEntries.create`) create flows — the form is identical except
 * for the title/breadcrumb/copy. The two mutations share the same
 * field shape, so one schema with a `kind: 'fuel' | 'def'` parameter
 * is enough.
 *
 * Why a factory and not a literal:
 *   - Vendor / driver / truck / carrier dropdowns are populated from
 *     live Convex queries on the page. The schema can't know those
 *     values up front, so the page wrapper calls
 *     `buildFuelEntrySchema({ kind, vendors, drivers, … })` inside a
 *     `useMemo` and the result is what's handed to `<CreateForm>`.
 *   - Schemas are pure data. No `useQuery` here; no Convex imports.
 *
 * Value-shape translator `mapValsToFuelEntryArgs` lives at the bottom
 * of this file. The shell stores everything as plain scalars
 * (`vals.date` is `'YYYY-MM-DD'`, `vals.vendorId` is a string id);
 * `mapValsToFuelEntryArgs(vals)` produces the object the mutation
 * actually accepts.
 *
 *   - date string  → Unix ms number
 *   - city + state → location: { city, state } (or undefined)
 *   - empty string → undefined for any optional id field
 *   - The shell-side `paymentMethod` uses the same UPPERCASE literal
 *     the mutation validator accepts (FUEL_CARD, CASH, …) so no
 *     remap is needed; this matches the existing FuelEntryForm.
 *
 * The shell never imports `convex/_generated/api`. This file follows
 * that rule — it imports only the type `Id` (a phantom string), which
 * is type-only and doesn't pull runtime Convex code.
 */

import type { Id, TableNames } from '@/convex/_generated/dataModel';
import {
  FUEL_TYPES,
  FUEL_TYPE_LABELS,
  DEFAULT_FUEL_TYPE,
  type FuelType,
} from '@/convex/lib/fuelTypes';
import type {
  CreateFormSchema,
  FieldOption,
} from '@/components/web/create-form';

/* ────────────────────────────────────────────────────────────────────
 *  Option-source types — what the page wrapper hands in.
 *  Each row matches the shape of its corresponding Convex query so the
 *  page can pass the array straight through with no remap.
 * ──────────────────────────────────────────────────────────────── */

export interface FuelVendorRow {
  _id: Id<'fuelVendors'>;
  name: string;
}

export interface DriverRow {
  _id: Id<'drivers'>;
  firstName: string;
  lastName: string;
}

export interface TruckRow {
  _id: Id<'trucks'>;
  unitId: string;
  make?: string;
  model?: string;
}

export interface CarrierRow {
  _id: Id<'carrierPartnerships'>;
  carrierName: string;
  trackFuelConsumption?: boolean;
}

export interface BuildFuelEntrySchemaArgs {
  /** 'fuel' = diesel pump fill-up. 'def' = DEF jug top-off. */
  kind: 'fuel' | 'def';
  /**
   * 'create' (default) → fresh-record title + draftKey set.
   * 'edit'             → edit-record title, no draftKey (drafts are
   *                      only for in-flight create flows). Tactical
   *                      difference; the field/section layout is
   *                      identical for both modes since the create
   *                      and update mutations accept the same fields.
   */
  mode?: 'create' | 'edit';
  vendors: FuelVendorRow[];
  drivers: DriverRow[];
  trucks: TruckRow[];
  carriers: CarrierRow[];
}

/* ────────────────────────────────────────────────────────────────────
 *  Payment methods — value strings match the Convex validator literals
 *  exactly. Schema author wins by skipping the slug-to-literal remap.
 * ──────────────────────────────────────────────────────────────── */

const FUEL_TYPE_OPTIONS: FieldOption[] = FUEL_TYPES.map((t) => ({
  value: t,
  label: FUEL_TYPE_LABELS[t],
}));

const PAYMENT_METHODS: FieldOption[] = [
  { value: 'FUEL_CARD', label: 'Fuel card' },
  { value: 'CASH', label: 'Cash · driver paid' },
  { value: 'COMDATA', label: 'Comdata' },
  { value: 'EFS', label: 'EFS' },
  { value: 'CREDIT_CARD', label: 'Company credit card' },
  { value: 'CHECK', label: 'Check' },
];

/* ────────────────────────────────────────────────────────────────────
 *  Field IDs — exported so `mapValsToFuelEntryArgs` and the page
 *  wrapper can refer to them by symbol instead of stringly-typed key
 *  duplication. Same trick the schema-types file recommends.
 * ──────────────────────────────────────────────────────────────── */

export const FUEL_ENTRY_FIELD_IDS = {
  date: 'date',
  vendorId: 'vendorId',
  city: 'city',
  state: 'state',
  fuelType: 'fuelType',
  gallons: 'gallons',
  pricePerGallon: 'pricePerGallon',
  driverId: 'driverId',
  truckId: 'truckId',
  carrierId: 'carrierId',
  loadId: 'loadId',
  odometerReading: 'odometerReading',
  paymentMethod: 'paymentMethod',
  fuelCardNumber: 'fuelCardNumber',
  receiptNumber: 'receiptNumber',
  attachment: 'attachment',
  notes: 'notes',
} as const;

/* ────────────────────────────────────────────────────────────────────
 *  Schema factory
 * ──────────────────────────────────────────────────────────────── */

export function buildFuelEntrySchema(
  args: BuildFuelEntrySchemaArgs,
): CreateFormSchema {
  const { kind, mode = 'create', vendors, drivers, trucks, carriers } = args;
  const isFuel = kind === 'fuel';
  const isEdit = mode === 'edit';
  const ids = FUEL_ENTRY_FIELD_IDS;

  const vendorOptions: FieldOption[] = vendors.map((v) => ({
    value: v._id,
    label: v.name,
  }));

  const driverOptions: FieldOption[] = drivers.map((d) => ({
    value: d._id,
    label: `${d.firstName} ${d.lastName}`,
  }));

  const truckOptions: FieldOption[] = trucks.map((t) => ({
    value: t._id,
    label: t.make ? `${t.unitId} · ${t.make}${t.model ? ` ${t.model}` : ''}` : t.unitId,
  }));

  const carrierOptions: FieldOption[] = carriers.map((c) => ({
    value: c._id,
    label: c.carrierName,
  }));

  // Edit mode skips the title prefix and uses an "Edit" label. The
  // breadcrumb still ends with the current page's name. Drafts are
  // never set for edit — `draftKey` is conditionally added only on
  // create.
  const createLabel = isFuel ? 'Log fill-up' : 'Log DEF top-off';
  const editLabel = isFuel ? 'Edit fuel entry' : 'Edit DEF entry';
  const label = isEdit ? editLabel : createLabel;

  return {
    entity: kind === 'fuel' ? 'fuelEntry' : 'defEntry',
    breadcrumb: ['Company Operations', 'Diesel', label],
    title: label,
    subtitle: isEdit
      ? 'Update the captured values; gallons × price-per-gallon = total recomputes on save.'
      : isFuel
        ? 'One row per pump transaction. Gallons × price-per-gallon = total — we compute that on save.'
        : 'One row per DEF top-off. Gallons × price-per-gallon = total — we compute that on save.',
    sections: [
      {
        id: 'when',
        title: 'When',
        fields: [
          {
            id: ids.date,
            label: 'Date',
            kind: 'date',
            required: 'tier1',
            default: todayYmd(),
          },
        ],
      },
      {
        id: 'where',
        title: 'Where',
        subtitle: 'City + state are required so IFTA reports group correctly.',
        fields: [
          {
            id: ids.vendorId,
            label: 'Vendor',
            kind: 'select',
            required: 'tier1',
            placeholder:
              vendorOptions.length === 0
                ? 'No vendors loaded'
                : '— Select —',
            options: vendorOptions,
          },
          {
            id: ids.city,
            label: 'City',
            kind: 'text',
            required: 'tier1',
            placeholder: 'e.g. Reno',
          },
          {
            id: ids.state,
            label: 'State',
            kind: 'text',
            required: 'tier1',
            placeholder: 'NV',
            hint: 'Two-letter code.',
            validate: (v) =>
              typeof v === 'string' && v.trim() && v.trim().length !== 2
                ? 'State must be a 2-letter code.'
                : null,
          },
        ],
      },
      {
        id: 'amounts',
        title: 'Amounts',
        subtitle:
          'Enter the two values printed clearest on the receipt — we compute the total on save.',
        fields: [
          // DEF has its own table + workflow, so the type picker only
          // exists on the diesel form. Missing values read as Diesel.
          ...(isFuel
            ? [
                {
                  id: ids.fuelType,
                  label: 'Fuel type',
                  kind: 'select' as const,
                  default: DEFAULT_FUEL_TYPE,
                  options: FUEL_TYPE_OPTIONS,
                  hint: 'Keeps the fuel report separated by product.',
                },
              ]
            : []),
          {
            id: ids.gallons,
            label: 'Gallons',
            kind: 'number',
            required: 'tier1',
            placeholder: '0.0',
            suffix: 'gal',
          },
          {
            id: ids.pricePerGallon,
            label: 'Price / gal',
            kind: 'currency',
            required: 'tier1',
            placeholder: '0.000',
          },
        ],
      },
      {
        id: 'assignment',
        title: 'Assignment',
        subtitle: 'Who made the purchase + what they were driving.',
        fields: [
          // Optional (recommended): imports already create unassigned
          // entries, so the manual form matches — the mutations accept
          // both as v.optional and reports render "Unassigned".
          {
            id: ids.driverId,
            label: 'Driver',
            kind: 'select',
            recommended: true,
            placeholder:
              driverOptions.length === 0 ? 'No drivers loaded' : '— None —',
            options: driverOptions,
          },
          {
            id: ids.truckId,
            label: 'Truck',
            kind: 'select',
            recommended: true,
            placeholder:
              truckOptions.length === 0 ? 'No trucks loaded' : '— None —',
            options: truckOptions,
          },
          {
            id: ids.carrierId,
            label: 'Carrier',
            kind: 'select',
            placeholder: '— None —',
            options: carrierOptions,
            hint: 'Only set when the fill-up was for an outside carrier.',
          },
          {
            id: ids.odometerReading,
            label: 'Odometer',
            kind: 'number',
            recommended: true,
            suffix: 'mi',
            placeholder: '0',
          },
        ],
      },
      {
        id: 'payment',
        title: 'Payment',
        fields: [
          {
            // span:2 — six payment options at their natural pill
            // widths wrap awkwardly into a one-track (232px) cell.
            // Two tracks (~478px) lays all six on a single row.
            id: ids.paymentMethod,
            label: 'Payment method',
            kind: 'segmented',
            required: 'tier1',
            default: 'FUEL_CARD',
            span: 2,
            options: PAYMENT_METHODS,
          },
          {
            id: ids.fuelCardNumber,
            label: 'Card / last 4',
            kind: 'mono',
            showIf: (v) =>
              v[ids.paymentMethod] === 'FUEL_CARD' ||
              v[ids.paymentMethod] === 'COMDATA' ||
              v[ids.paymentMethod] === 'EFS',
            placeholder: '****0000',
          },
        ],
      },
      {
        id: 'receipt-and-notes',
        title: 'Receipt & notes',
        fields: [
          {
            id: ids.attachment,
            label: 'Receipt scan',
            kind: 'file',
            recommended: true,
            span: 2,
            accept: 'image/*,application/pdf',
            hint: 'PDF or photo. IFTA requires one — flagged on the record if missing.',
          },
          {
            id: ids.receiptNumber,
            label: 'Receipt #',
            kind: 'mono',
            placeholder: 'R-000000',
          },
          {
            id: ids.loadId,
            label: 'Linked load',
            kind: 'mono',
            placeholder: '0000000000',
            hint: 'Leave blank if this fill-up wasn’t for a specific load.',
          },
          {
            id: ids.notes,
            label: 'Notes',
            kind: 'textarea',
            span: 2,
            rows: 2,
            placeholder: 'e.g. “Top-off before Donner Pass.”',
          },
        ],
      },
    ],
  };
}

/* ────────────────────────────────────────────────────────────────────
 *  Value-shape translator
 *
 *  Bridge from the shell's flat string-y `vals` to the Convex
 *  mutation's typed arg shape. This is the ONLY place that knows
 *  about the mutation's wire format — the schema above and the shell
 *  itself stay Convex-free.
 * ──────────────────────────────────────────────────────────────── */

export interface FuelEntryCreateArgs {
  entryDate: number;
  vendorId: Id<'fuelVendors'>;
  /** Only set for diesel (fuelEntries) rows — the DEF mutations don't
   *  accept it, and the translator omits the key when unset. */
  fuelType?: FuelType;
  gallons: number;
  pricePerGallon: number;
  driverId?: Id<'drivers'>;
  truckId?: Id<'trucks'>;
  carrierId?: Id<'carrierPartnerships'>;
  loadId?: Id<'loadInformation'>;
  odometerReading?: number;
  location?: { city: string; state: string };
  paymentMethod?:
    | 'FUEL_CARD'
    | 'CASH'
    | 'CHECK'
    | 'CREDIT_CARD'
    | 'EFS'
    | 'COMDATA';
  fuelCardNumber?: string;
  receiptNumber?: string;
  notes?: string;
  receiptStorageId?: Id<'_storage'>;
}

export function mapValsToFuelEntryArgs(
  vals: Record<string, unknown>,
): FuelEntryCreateArgs {
  const ids = FUEL_ENTRY_FIELD_IDS;
  const dateStr = String(vals[ids.date] ?? '');
  const city = trimStr(vals[ids.city]);
  const state = trimStr(vals[ids.state]);
  const paymentMethod = String(vals[ids.paymentMethod] ?? '');
  // Only present on the diesel form. Conditional spread below keeps the
  // key out of DEF create/update payloads (their validators reject it).
  const fuelTypeStr = trimStr(vals[ids.fuelType]);
  const fuelType = (FUEL_TYPES as readonly string[]).includes(fuelTypeStr)
    ? (fuelTypeStr as FuelType)
    : undefined;

  // Cast `as Id<'_branded'>` is safe here: the schema's select options
  // were populated from Convex ids, so any non-empty value came from a
  // real record. The optional-id helpers fall back to undefined on
  // empty strings.
  return {
    entryDate: ymdToUnixMs(dateStr),
    vendorId: String(vals[ids.vendorId] ?? '') as Id<'fuelVendors'>,
    ...(fuelType ? { fuelType } : {}),
    gallons: Number(vals[ids.gallons] ?? 0),
    pricePerGallon: Number(vals[ids.pricePerGallon] ?? 0),
    driverId: optionalId<'drivers'>(vals[ids.driverId]),
    truckId: optionalId<'trucks'>(vals[ids.truckId]),
    carrierId: optionalId<'carrierPartnerships'>(vals[ids.carrierId]),
    loadId: optionalId<'loadInformation'>(vals[ids.loadId]),
    odometerReading: optionalNumber(vals[ids.odometerReading]),
    location: city && state ? { city, state: state.toUpperCase() } : undefined,
    paymentMethod: paymentMethod
      ? (paymentMethod as FuelEntryCreateArgs['paymentMethod'])
      : undefined,
    fuelCardNumber: optionalStr(vals[ids.fuelCardNumber]),
    receiptNumber: optionalStr(vals[ids.receiptNumber]),
    notes: optionalStr(vals[ids.notes]),
    receiptStorageId: optionalId<'_storage'>(vals[ids.attachment]),
  };
}

/* ────────────────────────────────────────────────────────────────────
 *  Small helpers — kept private; not part of the schema's public
 *  surface.
 * ──────────────────────────────────────────────────────────────── */

/* ────────────────────────────────────────────────────────────────────
 *  Edit-mode helpers
 *
 *  `mapRecordToFuelEntryVals(record)` is the inverse of
 *  `mapValsToFuelEntryArgs(vals)` — takes a stored fuelEntries /
 *  defEntries row and produces the flat `vals` object the shell
 *  seeds the form with. Same field-id map, same scalar shapes — the
 *  only translation work is `entryDate: number → YYYY-MM-DD string`
 *  (the date control's expected shape).
 *
 *  Unknown record fields are skipped silently. Missing optional
 *  fields seed as empty strings (the shell would do the same via
 *  `emptyForKind` if we just didn't set the key, but being explicit
 *  here makes future schema evolution easier to diff).
 * ──────────────────────────────────────────────────────────────── */

/** Subset of the persisted record shape that the schema reads. We
 *  redeclare these locally instead of importing from Convex's
 *  generated types so the schema file stays Convex-import-free. */
export interface FuelEntryRecord {
  entryDate: number;
  vendorId: string;
  fuelType?: string;
  gallons: number;
  pricePerGallon: number;
  driverId?: string;
  carrierId?: string;
  truckId?: string;
  loadId?: string;
  odometerReading?: number;
  location?: { city: string; state: string };
  paymentMethod?: string;
  fuelCardNumber?: string;
  receiptNumber?: string;
  notes?: string;
  receiptStorageId?: string;
}

export function mapRecordToFuelEntryVals(
  record: FuelEntryRecord,
): Record<string, unknown> {
  const ids = FUEL_ENTRY_FIELD_IDS;
  return {
    [ids.date]: unixMsToYmd(record.entryDate),
    [ids.vendorId]: record.vendorId,
    // Legacy fuel rows (pre-fuelType) seed the default; DEF records
    // never have the field and their schema drops the value anyway.
    [ids.fuelType]: record.fuelType ?? DEFAULT_FUEL_TYPE,
    [ids.gallons]: record.gallons,
    [ids.pricePerGallon]: record.pricePerGallon,
    [ids.driverId]: record.driverId ?? '',
    [ids.truckId]: record.truckId ?? '',
    [ids.carrierId]: record.carrierId ?? '',
    [ids.loadId]: record.loadId ?? '',
    [ids.odometerReading]: record.odometerReading ?? '',
    [ids.city]: record.location?.city ?? '',
    [ids.state]: record.location?.state ?? '',
    [ids.paymentMethod]: record.paymentMethod ?? '',
    [ids.fuelCardNumber]: record.fuelCardNumber ?? '',
    [ids.receiptNumber]: record.receiptNumber ?? '',
    [ids.notes]: record.notes ?? '',
    [ids.attachment]: record.receiptStorageId ?? '',
  };
}

/** Same wire shape as the create args but without `vendorId` / `gallons` /
 *  `pricePerGallon` being required — Convex's `update` validator
 *  accepts all fields as optional. We just narrow the create translator's
 *  return type so the page wrapper can spread it into the update call. */
export type FuelEntryUpdateArgs = Partial<FuelEntryCreateArgs>;

export function mapValsToFuelEntryUpdateArgs(
  vals: Record<string, unknown>,
): FuelEntryUpdateArgs {
  // Same shape; update mutation just doesn't require the
  // organizationId / createdBy that create needs.
  return mapValsToFuelEntryArgs(vals);
}

function unixMsToYmd(ms: number): string {
  const d = new Date(ms);
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

function todayYmd(): string {
  const d = new Date();
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

function ymdToUnixMs(ymd: string): number {
  if (!ymd) return Date.now();
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(ymd);
  if (!m) return new Date(ymd).getTime();
  // Construct in local time (matches the date control's parsing) so
  // "today" entered by the user lands on today's calendar date.
  return new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3])).getTime();
}

function trimStr(v: unknown): string {
  return typeof v === 'string' ? v.trim() : '';
}

function optionalStr(v: unknown): string | undefined {
  const s = trimStr(v);
  return s.length > 0 ? s : undefined;
}

function optionalNumber(v: unknown): number | undefined {
  if (v === '' || v === null || v === undefined) return undefined;
  const n = Number(v);
  return Number.isFinite(n) ? n : undefined;
}

// Convex Ids are branded strings at runtime. Empty strings become
// `undefined` so the optional-validator on the mutation passes. The
// `T` constraint matches `Id<…>` exactly — TableNames includes every
// user-defined table; `_storage` is the system table used for file
// uploads.
function optionalId<T extends TableNames | '_storage'>(
  v: unknown,
): Id<T> | undefined {
  if (typeof v !== 'string' || v.length === 0) return undefined;
  return v as Id<T>;
}
