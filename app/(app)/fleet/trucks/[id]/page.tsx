'use client';

/**
 * TruckDetailPage — full-page record landing built on `DetailsFullPage`.
 *
 * Mirrors the design's `buildTruckDetails` section vocabulary:
 *   Overview · Inspections · Maintenance · Fuel · Telematics · Activity
 *
 * Inspections / Maintenance / Fuel tabs render the design's mini-tables with
 * MOCK rows — clearly flagged in the UI — until the corresponding backend
 * tables (`dvirs`, `workOrders`, `fuelTransactions`) exist. Overview cards
 * support inline edits via `DSPropsEditable` wired to `api.trucks.update`.
 *
 * Toolbar: Back / prev-next / Deactivate. Edit button removed — every field
 * is editable inline directly on the Overview cards.
 */

import * as React from 'react';
import { useRouter, useParams } from 'next/navigation';
import { useAuth } from '@workos-inc/authkit-nextjs/components';
import { useMutation, useQuery } from 'convex/react';
import { Loader2 } from 'lucide-react';
import { toast } from 'sonner';

import { api } from '@/convex/_generated/api';
import { EntityAuditTimeline } from '@/components/audit/entity-audit-timeline';
import type { Id } from '@/convex/_generated/dataModel';
import { useOrganizationId } from '@/contexts/organization-context';

import {
  AttentionBand,
  type AttentionItem,
  Avatar,
  Chip,
  type ChipStatus,
  DSActivity,
  DSCard,
  DSMiniTable,
  type DSMiniColumn,
  DSProps,
  type DSPropItem,
  DSPropsEditable,
  type DSPropsEditableItem,
  DetailsFullPage,
  type FPSection,
  QRPlacardCard,
  StatusChipPopover,
  type StatusChipOption,
  WBtn,
  WIcon,
} from '@/components/web';

// ─── helpers ─────────────────────────────────────────────────────────────

function getDocStatus(date?: string): 'expired' | 'expiring' | 'valid' | 'na' {
  if (!date) return 'na';
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(date);
  if (!m) return 'na';
  const target = new Date(Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3]))).getTime();
  const now = Date.now();
  const day = 86_400_000;
  if (target < now) return 'expired';
  if (target - now < 30 * day) return 'expiring';
  return 'valid';
}

function chipForDoc(date?: string): ChipStatus {
  const s = getDocStatus(date);
  return s === 'expired' ? 'expired' : s === 'expiring' ? 'expiring' : s === 'na' ? 'na' : 'valid';
}

function fmtDate(date?: string): string {
  if (!date) return '—';
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(date);
  if (!m) return date;
  const d = new Date(Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3])));
  return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric', timeZone: 'UTC' });
}

function fmtMoney(cents?: number): string {
  if (cents == null) return '—';
  return `$${cents.toLocaleString()}`;
}

const STATUS_TO_CHIP: Record<string, ChipStatus> = {
  Active: 'active',
  'Out of Service': 'inactive',
  'In Repair': 'pending',
  Maintenance: 'pending',
  Sold: 'cancelled',
  Lost: 'expired',
};

// Options shown in the header status chip — schema-matched labels.
const STATUS_CHIP_OPTIONS: StatusChipOption[] = [
  { value: 'Active',         label: 'Active',         chip: 'active' },
  { value: 'In Repair',      label: 'In Repair',      chip: 'pending' },
  { value: 'Maintenance',    label: 'Maintenance',    chip: 'pending' },
  { value: 'Out of Service', label: 'Out of Service', chip: 'inactive' },
  { value: 'Sold',           label: 'Sold',           chip: 'cancelled' },
  { value: 'Lost',           label: 'Lost',           chip: 'expired' },
];

// Year picker — current year + 1 (for next-year models) down 35 years.
const YEAR_OPTIONS = (() => {
  const now = new Date().getFullYear();
  const opts: Array<{ value: string; label: string }> = [{ value: '', label: '—' }];
  for (let y = now + 1; y >= now - 35; y--) opts.push({ value: String(y), label: String(y) });
  return opts;
})();

// Common Class 7-8 truck makes (heavy-duty).
const TRUCK_MAKE_OPTIONS = [
  { value: '', label: '—' },
  { value: 'Freightliner',  label: 'Freightliner' },
  { value: 'Kenworth',      label: 'Kenworth' },
  { value: 'Peterbilt',     label: 'Peterbilt' },
  { value: 'Volvo',         label: 'Volvo' },
  { value: 'Mack',          label: 'Mack' },
  { value: 'International', label: 'International' },
  { value: 'Western Star',  label: 'Western Star' },
  { value: 'Hino',          label: 'Hino' },
  { value: 'Isuzu',         label: 'Isuzu' },
  { value: 'Other',         label: 'Other' },
];

const FUEL_TYPE_OPTIONS = [
  { value: '', label: '—' },
  { value: 'Diesel', label: 'Diesel' },
  { value: 'Gas', label: 'Gas' },
  { value: 'Electric', label: 'Electric' },
  { value: 'CNG', label: 'CNG' },
  { value: 'Hybrid', label: 'Hybrid' },
];

const BODY_TYPE_OPTIONS = [
  { value: '', label: '—' },
  { value: 'Semi', label: 'Semi' },
  { value: 'Bobtail', label: 'Bobtail' },
];

const OWNERSHIP_OPTIONS = [
  { value: '', label: '—' },
  { value: 'Owned', label: 'Owned' },
  { value: 'Leased', label: 'Leased' },
  { value: 'Financed', label: 'Financed' },
  { value: 'Renting', label: 'Renting' },
];

export default function TruckDetailPage() {
  const router = useRouter();
  const params = useParams();
  const { user } = useAuth();
  const organizationId = useOrganizationId();
  const truckId = params.id as Id<'trucks'>;

  const truck = useQuery(api.trucks.get, { id: truckId });
  const allTrucks = useQuery(
    api.trucks.list,
    organizationId ? { organizationId, includeDeleted: true } : 'skip',
  );

  const updateTruck = useMutation(api.trucks.update);
  const deactivate = useMutation(api.trucks.deactivate);

  const [activeSection, setActiveSection] = React.useState('overview');

  if (truck === undefined) {
    return (
      <div className="flex-1 flex items-center justify-center">
        <Loader2 className="h-5 w-5 animate-spin text-[var(--text-tertiary)]" />
      </div>
    );
  }
  if (truck === null) {
    return (
      <div className="flex-1 flex items-center justify-center text-[12.5px] text-[var(--text-tertiary)]">
        Truck not found.
      </div>
    );
  }

  // Prev / next nav (skip deleted)
  const list = (allTrucks ?? []).filter((t) => !t.isDeleted);
  const idx = list.findIndex((t) => t._id === truckId);
  const prev = idx > 0 ? list[idx - 1] : null;
  const next = idx >= 0 && idx < list.length - 1 ? list[idx + 1] : null;

  const userName =
    user?.firstName && user?.lastName ? `${user.firstName} ${user.lastName}` : user?.email ?? '';

  const onDeactivate = async () => {
    if (!user) return;
    if (!window.confirm(`Deactivate truck ${truck.unitId}?`)) return;
    try {
      await deactivate({ id: truckId, userId: user.id, userName });
      toast.success('Truck deactivated');
      router.push('/fleet/trucks');
    } catch (e) {
      console.error(e);
      toast.error('Failed to deactivate truck');
    }
  };

  // ── Inline edit commit ──
  // Maps a DSPropsEditable key/value pair onto the trucks.update mutation.
  // Numeric and date fields are parsed/normalized; empty strings clear the
  // value (we patch with `undefined` to wipe it).
  type UpdateArgs = Parameters<typeof updateTruck>[0];
  type WritableField = Exclude<keyof UpdateArgs, 'id' | 'userId' | 'userName' | 'organizationId'>;

  const NUMBER_FIELDS = new Set<WritableField>([
    'year',
    'gvwr',
    'gcwr',
    'purchasePrice',
    'engineModelYear',
  ]);
  const DATE_FIELDS = new Set<WritableField>([
    'registrationExpiration',
    'insuranceExpiration',
    'purchaseDate',
  ]);

  const commitField = async (key: string, next: string | string[]) => {
    if (!user) return;
    if (Array.isArray(next)) return; // none of our editors are multiselect
    const field = key as WritableField;
    const trimmed = next.trim();
    let payload: Record<string, unknown> = {};
    if (NUMBER_FIELDS.has(field)) {
      if (trimmed === '') payload[field] = undefined;
      else {
        const n = Number(trimmed);
        if (Number.isNaN(n)) {
          toast.error(`${field} must be a number`);
          return;
        }
        payload[field] = n;
      }
    } else if (DATE_FIELDS.has(field)) {
      payload[field] = trimmed === '' ? undefined : trimmed;
    } else {
      payload[field] = trimmed === '' ? undefined : trimmed;
    }
    try {
      await updateTruck({ id: truckId, userId: user.id, userName, ...payload });
    } catch (e) {
      console.error(e);
      toast.error(`Failed to update ${field}`);
    }
  };

  // ── Hero pieces ──
  const ymm = [truck.year, truck.make, truck.model].filter(Boolean).join(' ');
  const titleNode = (
    <span className="inline-flex items-center gap-3">
      <span className="num">{truck.unitId}</span>
      {ymm && <span className="text-[var(--text-tertiary)] font-normal">· {ymm}</span>}
      {truck.isDeleted ? (
        <Chip status="cancelled" label="Deleted" />
      ) : (
        <StatusChipPopover
          current={truck.status}
          options={STATUS_CHIP_OPTIONS}
          onChange={(next) => commitField('status', next)}
        />
      )}
    </span>
  );

  const subtitle = (
    <span className="flex items-center flex-wrap gap-x-4 gap-y-1 text-[13px] text-[var(--text-secondary)]">
      <span className="inline-flex items-center gap-1.5 num">
        <WIcon name="shield" size={13} /> VIN {truck.vin}
      </span>
      {truck.plate && (
        <span className="inline-flex items-center gap-1.5 num">
          <WIcon name="id-card" size={13} /> Plate {truck.plate}
        </span>
      )}
      {truck.bodyType && (
        <span className="inline-flex items-center gap-1.5">
          <WIcon name="box-trailer" size={13} /> {truck.bodyType}
        </span>
      )}
      {truck.samsaraVehicleId && (
        <span className="inline-flex items-center gap-1.5 text-[var(--accent)]">
          <WIcon name="pulse" size={13} /> Samsara connected
        </span>
      )}
    </span>
  );

  // ── Compliance + AttentionBand ──
  const regStatus = getDocStatus(truck.registrationExpiration);
  const insStatus = getDocStatus(truck.insuranceExpiration);
  const needsAttention = regStatus !== 'valid' || insStatus !== 'valid';

  const attentionItems: AttentionItem[] = [];
  if (!needsAttention && truck.status === 'Active') {
    attentionItems.push({ tone: 'ok', icon: 'check', title: 'In service', detail: 'All compliance current' });
  }
  if (regStatus === 'expired') {
    attentionItems.push({ tone: 'crit', icon: 'id-card', title: 'Registration expired', detail: fmtDate(truck.registrationExpiration) });
  } else if (regStatus === 'expiring') {
    attentionItems.push({ tone: 'warn', icon: 'id-card', title: 'Registration expiring soon', detail: fmtDate(truck.registrationExpiration) });
  }
  if (insStatus === 'expired') {
    attentionItems.push({ tone: 'crit', icon: 'shield', title: 'Insurance expired', detail: fmtDate(truck.insuranceExpiration) });
  } else if (insStatus === 'expiring') {
    attentionItems.push({ tone: 'warn', icon: 'shield', title: 'Insurance expiring soon', detail: fmtDate(truck.insuranceExpiration) });
  }

  const headline = (
    <span>
      <strong className="text-foreground">Truck {truck.unitId}</strong>{' '}
      {needsAttention ? (
        <>has compliance items that need attention.</>
      ) : truck.status === 'Active' ? (
        <>is <span style={{ color: '#0F8C5F', fontWeight: 500 }}>in service</span> with all compliance current.</>
      ) : (
        <>is currently {truck.status.toLowerCase()}.</>
      )}
    </span>
  );

  // ── Editable cards ──
  // Status lives in the hero (click the chip to change) — intentionally
  // excluded from the Vehicle card so it isn't shown twice.
  const vehicleItems: Array<DSPropsEditableItem | null> = [
    { key: 'unitId', label: 'Unit #', value: truck.unitId, editor: { type: 'text' } },
    { key: 'vin',    label: 'VIN',    value: truck.vin,    editor: { type: 'text' } },
    { key: 'year',   label: 'Year',
      value: truck.year != null ? String(truck.year) : '',
      editor: { type: 'select', options: YEAR_OPTIONS },
      placeholder: 'Pick a year',
    },
    { key: 'make',   label: 'Make',
      value: truck.make ?? '',
      editor: { type: 'select', options: TRUCK_MAKE_OPTIONS },
      placeholder: 'Pick a make',
    },
    { key: 'model',  label: 'Model',  value: truck.model ?? '', editor: { type: 'text' } },
    { key: 'bodyType', label: 'Body type', value: truck.bodyType ?? '', editor: { type: 'select', options: BODY_TYPE_OPTIONS } },
    { key: 'fuelType', label: 'Fuel', value: truck.fuelType ?? '', editor: { type: 'select', options: FUEL_TYPE_OPTIONS } },
    { key: 'gvwr',     label: 'GVWR (lb)', value: truck.gvwr != null ? String(truck.gvwr) : '', editor: { type: 'text' } },
    { key: 'gcwr',     label: 'GCWR (lb)', value: truck.gcwr != null ? String(truck.gcwr) : '', editor: { type: 'text' } },
  ];

  const regInsItems: Array<DSPropsEditableItem | null> = [
    { key: 'plate', label: 'Plate', value: truck.plate ?? '', editor: { type: 'text' } },
    {
      key: 'registrationExpiration',
      label: 'Reg. expires',
      value: truck.registrationExpiration ?? '',
      editor: { type: 'date' },
      display: (
        <span className="inline-flex items-center gap-2">
          <span className="num">{fmtDate(truck.registrationExpiration)}</span>
          <Chip status={chipForDoc(truck.registrationExpiration)} />
        </span>
      ),
    },
    { key: 'insuranceFirm',         label: 'Insurance carrier', value: truck.insuranceFirm ?? '', editor: { type: 'text' } },
    { key: 'insurancePolicyNumber', label: 'Policy #', value: truck.insurancePolicyNumber ?? '', editor: { type: 'text' } },
    {
      key: 'insuranceExpiration',
      label: 'Ins. expires',
      value: truck.insuranceExpiration ?? '',
      editor: { type: 'date' },
      display: (
        <span className="inline-flex items-center gap-2">
          <span className="num">{fmtDate(truck.insuranceExpiration)}</span>
          <Chip status={chipForDoc(truck.insuranceExpiration)} />
        </span>
      ),
    },
    {
      key: 'arb',
      label: 'ARB',
      value: '',
      readOnly: true,
      display: truck.arb ? <Chip status="valid" label="Certified" /> : <Chip status="na" label="Not on file" />,
    },
    {
      key: 'ifta',
      label: 'IFTA',
      value: '',
      readOnly: true,
      display: truck.ifta ? <Chip status="valid" label="Enrolled" /> : <Chip status="na" label="Not on file" />,
    },
  ];

  const engineItems: Array<DSPropsEditableItem | null> = [
    { key: 'engineManufacturer', label: 'Manufacturer', value: truck.engineManufacturer ?? '', editor: { type: 'text' } },
    { key: 'engineModel',        label: 'Model',        value: truck.engineModel ?? '',        editor: { type: 'text' } },
    { key: 'engineFamilyName',   label: 'Family',       value: truck.engineFamilyName ?? '',   editor: { type: 'text' } },
    { key: 'engineModelYear',    label: 'Model year',   value: truck.engineModelYear != null ? String(truck.engineModelYear) : '', editor: { type: 'text' } },
    { key: 'engineSerialNumber', label: 'Serial',       value: truck.engineSerialNumber ?? '', editor: { type: 'text' } },
  ];

  const financialItems: Array<DSPropsEditableItem | null> = [
    { key: 'ownershipType', label: 'Ownership',  value: truck.ownershipType ?? '', editor: { type: 'select', options: OWNERSHIP_OPTIONS } },
    { key: 'purchaseDate',  label: 'Purchased',
      value: truck.purchaseDate ?? '',
      editor: { type: 'date' },
      display: truck.purchaseDate ? <span className="num">{fmtDate(truck.purchaseDate)}</span> : undefined,
    },
    { key: 'purchasePrice', label: 'Price',
      value: truck.purchasePrice != null ? String(truck.purchasePrice) : '',
      editor: { type: 'text' },
      display: truck.purchasePrice ? <span className="num">{fmtMoney(truck.purchasePrice)}</span> : undefined,
    },
    { key: 'lienholder', label: 'Lienholder', value: truck.lienholder ?? '', editor: { type: 'text' } },
  ];

  // ── Section: Overview ─────────────────────────────────────────────────
  const overviewContent = (
    <div className="flex flex-col gap-3.5">
      <AttentionBand
        headline={headline}
        items={attentionItems}
        onJump={(id) => setActiveSection(id)}
      />

      <div className="grid grid-cols-1 md:grid-cols-2 gap-3 items-start">
        <DSCard title="Vehicle">
          <DSPropsEditable items={vehicleItems} onCommit={commitField} />
        </DSCard>
        <DSCard title="Registration & insurance">
          <DSPropsEditable items={regInsItems} onCommit={commitField} />
        </DSCard>
      </div>

      <div className="grid grid-cols-1 md:grid-cols-2 gap-3 items-start">
        <DSCard title="Engine">
          <DSPropsEditable items={engineItems} onCommit={commitField} />
        </DSCard>
        <DSCard title="Financial">
          <DSPropsEditable items={financialItems} onCommit={commitField} />
        </DSCard>
      </div>

      <CurrentlyMatedCard kind="truck" />
    </div>
  );

  // ── Section: Inspections (mock) ──────────────────────────────────────
  const inspectionsContent = (
    <DSCard
      title="Inspections"
      bodyClassName="p-0"
      action={
        <span className="inline-flex items-center gap-2">
          <MockDataBadge />
          <WBtn size="sm" leading="plus">New DVIR</WBtn>
        </span>
      }
    >
      <DSMiniTable
        columns={inspectionCols}
        rows={MOCK_INSPECTIONS}
        total={MOCK_INSPECTIONS.length}
      />
    </DSCard>
  );

  // ── Section: Maintenance (mock) ──────────────────────────────────────
  const maintenanceContent = (
    <DSCard
      title="Maintenance"
      bodyClassName="p-0"
      action={
        <span className="inline-flex items-center gap-2">
          <MockDataBadge />
          <WBtn size="sm" leading="plus">New work order</WBtn>
        </span>
      }
    >
      <DSMiniTable
        columns={maintenanceCols}
        rows={MOCK_MAINTENANCE}
        total={MOCK_MAINTENANCE.length}
      />
    </DSCard>
  );

  // ── Section: Fuel (mock) ─────────────────────────────────────────────
  const fuelContent = (
    <DSCard title="Fuel — last 30 days" action={<MockDataBadge />}>
      <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
        <FuelStat label="Gallons" value="412.8" />
        <FuelStat label="Cost" value="$1,728" />
        <FuelStat label="Avg MPG" value="7.4" delta="+0.2" deltaTone="up" />
        <FuelStat label="Idle hours" value="38" delta="−12" deltaTone="up" />
      </div>
    </DSCard>
  );

  // ── Section: Telematics ──────────────────────────────────────────────
  const hasLocation = truck.lastLocationLat != null && truck.lastLocationLng != null;
  const locationItems: DSPropItem[] = [
    {
      label: 'Samsara vehicle',
      value: truck.samsaraVehicleId
        ? <span className="num">{truck.samsaraVehicleId}</span>
        : <span className="text-[var(--text-tertiary)] italic">Not mapped</span>,
    },
    {
      label: 'Last position',
      value: hasLocation
        ? <span className="num">{truck.lastLocationLat?.toFixed(4)}, {truck.lastLocationLng?.toFixed(4)}</span>
        : '—',
    },
    {
      label: 'Reported',
      value: truck.lastLocationUpdatedAt
        ? <span className="num">{new Date(truck.lastLocationUpdatedAt).toLocaleString(undefined, { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' })}</span>
        : '—',
    },
  ];

  const telematicsContent = (
    <div className="flex flex-col gap-3.5">
      <DSCard title="Samsara mapping">
        <DSProps items={locationItems} />
      </DSCard>
      {!truck.samsaraVehicleId && (
        <DSCard title="Connect telematics">
          <div className="flex items-center justify-between gap-3">
            <p className="m-0 text-[12.5px] text-[var(--text-secondary)] leading-[18px] max-w-[420px]">
              Map this truck to a Samsara vehicle to stream live GPS pings into Otoqa. Connect Samsara
              under Settings → Integrations, then come back here to choose the vehicle.
            </p>
            <WBtn
              size="sm"
              variant="primary"
              leading="sparkle"
              onClick={() => router.push('/settings/integrations')}
            >
              Open Integrations
            </WBtn>
          </div>
        </DSCard>
      )}
    </div>
  );

  // ── Section: Activity ────────────────────────────────────────────────
  const activityContent = (
    <DSCard title="Recent activity">
      <EntityAuditTimeline
        entityType="truck"
        entityId={String(truckId)}
        recordFallback={{
          createdAt: truck.createdAt,
          createdBy: truck.createdBy,
          updatedAt: truck.updatedAt,
          deactivatedAt: truck.isDeleted ? truck.deletedAt : undefined,
          deactivatedBy: truck.isDeleted ? truck.deletedBy : undefined,
        }}
      />
    </DSCard>
  );

  const sections: FPSection[] = [
    { id: 'overview',     label: 'Overview',     icon: 'home',      content: overviewContent },
    { id: 'inspections',  label: 'Inspections',  icon: 'list-tree', count: MOCK_INSPECTIONS.length, content: inspectionsContent },
    { id: 'maintenance',  label: 'Maintenance',  icon: 'settings',  count: MOCK_MAINTENANCE.length, content: maintenanceContent },
    { id: 'fuel',         label: 'Fuel',         icon: 'droplet',   content: fuelContent },
    { id: 'telematics',   label: 'Telematics',   icon: 'pulse',     content: telematicsContent },
    { id: 'activity',     label: 'Activity',     icon: 'pulse',     content: activityContent },
  ];

  // Right rail: Compliance + QR placard + Health (mock) + Upcoming (mock)
  const rightRail = (
    <div className="flex flex-col gap-3">
      <DSCard title="Compliance">
        <div className="flex flex-col gap-2.5">
          <ComplianceRow label="Registration" date={truck.registrationExpiration} status={chipForDoc(truck.registrationExpiration)} />
          <ComplianceRow label="Insurance"    date={truck.insuranceExpiration}    status={chipForDoc(truck.insuranceExpiration)} />
          <ComplianceRow label="ARB" chip={truck.arb ? <Chip status="valid" label="Certified" /> : <Chip status="na" label="Not on file" />} />
          <ComplianceRow label="IFTA" chip={truck.ifta ? <Chip status="valid" label="Enrolled" /> : <Chip status="na" label="Not on file" />} />
        </div>
      </DSCard>
      <QRPlacardCard
        kind="truck"
        unit={truck.unitId}
        recordId={String(truckId)}
        subtitle={[truck.year, truck.make, truck.model].filter(Boolean).join(' ')}
      />
      <DSCard
        title="Health"
        action={<MockDataBadge />}
      >
        <DSActivity
          items={[
            { icon: 'check',      text: 'Brakes OK (12d ago service)', when: '' },
            { icon: 'check',      text: 'DPF OK',                       when: '' },
            { icon: 'circle-dot', text: 'Tire rotation due in 2,400 mi', when: '' },
          ]}
        />
      </DSCard>
      <DSCard title="Upcoming" action={<MockDataBadge />}>
        <DSActivity
          items={[
            { icon: 'circle-dot', text: '90k service in 5,790 mi', when: '~Jun 12' },
            { icon: 'shield',     text: 'Registration renewal',     when: fmtDate(truck.registrationExpiration) },
          ]}
        />
      </DSCard>
    </div>
  );

  return (
    <DetailsFullPage
      breadcrumb={
        <span className="inline-flex items-center gap-1.5 text-[var(--text-secondary)]">
          <button type="button" onClick={() => router.push('/fleet/trucks')} className="hover:text-foreground">
            Trucks
          </button>
          <span className="text-[var(--text-tertiary)]">/</span>
          <span className="num text-foreground font-medium truncate max-w-[280px]">{truck.unitId}</span>
        </span>
      }
      onBack={() => router.push('/fleet/trucks')}
      prevLabel={prev ? prev.unitId : undefined}
      onPrev={prev ? () => router.push(`/fleet/trucks/${prev._id}`) : null}
      nextLabel={next ? next.unitId : undefined}
      onNext={next ? () => router.push(`/fleet/trucks/${next._id}`) : null}
      toolbarActions={
        <>
          {!truck.isDeleted && (
            <WBtn size="sm" danger onClick={onDeactivate}>
              Deactivate
            </WBtn>
          )}
        </>
      }
      title={titleNode}
      subtitle={subtitle}
      sections={sections}
      activeId={activeSection}
      onActiveChange={setActiveSection}
      rightRail={rightRail}
    />
  );
}

// ─── Mock data + table columns ───────────────────────────────────────────

interface InspectionRow {
  id: number;
  date: string;
  type: string;
  who: string;
  defects: number;
  status: ChipStatus;
}
const MOCK_INSPECTIONS: InspectionRow[] = [
  { id: 1, date: 'Apr 30', type: 'Pre-trip',  who: 'Andres Cuellar',  defects: 0, status: 'valid' },
  { id: 2, date: 'Apr 27', type: 'Post-trip', who: 'Andres Cuellar',  defects: 1, status: 'expiring' },
  { id: 3, date: 'Apr 12', type: 'Annual',    who: 'WestState Diesel', defects: 2, status: 'valid' },
  { id: 4, date: 'Apr 02', type: 'Pre-trip',  who: 'Jorge Romero',     defects: 0, status: 'valid' },
  { id: 5, date: 'Mar 28', type: 'Roadside',  who: 'CHP — I-5',        defects: 0, status: 'valid' },
];

const inspectionCols: DSMiniColumn<InspectionRow>[] = [
  { key: 'date',    label: 'Date',    width: '100px', render: (r) => <span className="num">{r.date}</span> },
  { key: 'type',    label: 'Type',    width: '120px' },
  { key: 'who',     label: 'By',      width: '1fr',
    render: (r) => (
      <span className="inline-flex items-center gap-2 min-w-0">
        <Avatar name={r.who} size={20} />
        <span className="truncate">{r.who}</span>
      </span>
    ),
  },
  { key: 'defects', label: 'Defects', width: '80px', align: 'right', render: (r) => <span className="num">{r.defects}</span> },
  { key: 'status',  label: 'Status',  width: '100px', render: (r) => <Chip status={r.status} /> },
];

interface MaintenanceRow {
  id: number;
  wo: string;
  desc: string;
  date: string;
  cost: string;
}
const MOCK_MAINTENANCE: MaintenanceRow[] = [
  { id: 1, wo: 'WO-2104', desc: 'Brake pads — front & rear',  date: 'Apr 12', cost: '$1,420' },
  { id: 2, wo: 'WO-2087', desc: 'DPF regen + injector check', date: 'Mar 22', cost: '$840'   },
  { id: 3, wo: 'WO-2061', desc: 'Tire rotation (8)',          date: 'Feb 18', cost: '$120'   },
  { id: 4, wo: 'WO-2044', desc: 'Oil change · 50k svc',       date: 'Jan 30', cost: '$640'   },
];

const maintenanceCols: DSMiniColumn<MaintenanceRow>[] = [
  { key: 'wo',   label: 'WO #',         width: '100px', render: (r) => <span className="num text-[var(--accent)] font-medium">{r.wo}</span> },
  { key: 'desc', label: 'Description',  width: '1.4fr' },
  { key: 'date', label: 'Closed',       width: '100px', render: (r) => <span className="num">{r.date}</span> },
  { key: 'cost', label: 'Cost',         width: '100px', align: 'right', render: (r) => <span className="num">{r.cost}</span> },
];

// ─── Inline helpers ──────────────────────────────────────────────────────

function MockDataBadge() {
  return (
    <span
      className="inline-flex items-center gap-1 font-medium uppercase tracking-wide"
      style={{
        height: 18,
        padding: '0 8px',
        borderRadius: 9,
        background: 'rgba(245,158,11,0.10)',
        color: '#A66800',
        fontSize: 10,
        letterSpacing: 0.04,
      }}
      title="This data isn't wired to a backend yet — the design's section is preserved with sample rows."
    >
      <WIcon name="alert" size={10} /> Mock data
    </span>
  );
}

function FuelStat({
  label,
  value,
  delta,
  deltaTone,
}: {
  label: string;
  value: React.ReactNode;
  delta?: React.ReactNode;
  deltaTone?: 'up' | 'down' | 'neutral';
}) {
  const deltaColor = deltaTone === 'up' ? '#0F8C5F' : deltaTone === 'down' ? '#B43030' : 'var(--text-tertiary)';
  return (
    <div>
      <div className="tw-label text-[10.5px]">{label}</div>
      <div className="num text-[18px] font-semibold mt-1">{value}</div>
      {delta && (
        <div className="num text-[11px] mt-1" style={{ color: deltaColor }}>
          {delta}
        </div>
      )}
    </div>
  );
}

function CurrentlyMatedCard({ kind }: { kind: 'truck' | 'trailer' }) {
  // Placeholder: this surface will read from the assigned load record once
  // we add a `findAssignedLoadFor{Truck|Trailer}` query. Showing the design's
  // structure with mock content so dispatchers see the layout.
  return (
    <DSCard title="Currently" action={<MockDataBadge />}>
      <DSProps
        items={[
          { label: 'Driver',   value: <span className="inline-flex items-center gap-2"><Avatar name="Andres Cuellar Ortega" size={20} /><span>Andres Cuellar Ortega</span></span> },
          { label: 'Trip',     value: <span className="num text-[var(--accent)]">OT-2026-0418</span> },
          { label: kind === 'truck' ? 'Trailer' : 'Truck', value: <span className="num">{kind === 'truck' ? 'TR-118 · 53′ reefer' : 'T-204 · Volvo VNL 760'}</span> },
          { label: 'Domicile', value: 'Sacramento, CA' },
        ]}
      />
    </DSCard>
  );
}

function ComplianceRow({
  label,
  date,
  status,
  chip,
}: {
  label: string;
  date?: string;
  status?: ChipStatus;
  chip?: React.ReactNode;
}) {
  return (
    <div className="flex items-center justify-between gap-3">
      <div className="flex flex-col leading-tight min-w-0">
        <span className="text-[12px] text-[var(--text-tertiary)]">{label}</span>
        {date != null && (
          <span className="num text-[12.5px] text-foreground truncate">{fmtDate(date)}</span>
        )}
      </div>
      {chip ?? (status && <Chip status={status} />)}
    </div>
  );
}
