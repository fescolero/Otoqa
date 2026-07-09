'use client';

/**
 * TrailerDetailPage — full-page record landing built on `DetailsFullPage`.
 *
 * Mirrors the design's `buildTrailerDetails` section vocabulary:
 *   Overview · Inspections · Loads carried · Maintenance · Activity
 *
 * Inspections / Loads carried / Maintenance tabs render the design's
 * mini-tables with MOCK rows — clearly flagged in the UI — until the
 * corresponding backend tables exist. Overview cards support inline edits
 * via `DSPropsEditable` wired to `api.trailers.update`.
 *
 * Toolbar: Back / prev-next / Deactivate. Edit button removed — every field
 * is editable inline.
 */

import * as React from 'react';
import { useRouter, useParams } from 'next/navigation';
import { useAuth } from '@workos-inc/authkit-nextjs/components';
import { useMutation, useQuery } from 'convex/react';
import { Loader2 } from 'lucide-react';
import { toast } from 'sonner';

import { api } from '@/convex/_generated/api';
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

// Year picker — current year + 1 down 35 years.
const YEAR_OPTIONS = (() => {
  const now = new Date().getFullYear();
  const opts: Array<{ value: string; label: string }> = [{ value: '', label: '—' }];
  for (let y = now + 1; y >= now - 35; y--) opts.push({ value: String(y), label: String(y) });
  return opts;
})();

// Common trailer makes.
const TRAILER_MAKE_OPTIONS = [
  { value: '', label: '—' },
  { value: 'Wabash',           label: 'Wabash' },
  { value: 'Great Dane',       label: 'Great Dane' },
  { value: 'Utility',          label: 'Utility' },
  { value: 'Hyundai Translead',label: 'Hyundai Translead' },
  { value: 'Stoughton',        label: 'Stoughton' },
  { value: 'Vanguard',         label: 'Vanguard' },
  { value: 'Strick',           label: 'Strick' },
  { value: 'Manac',            label: 'Manac' },
  { value: 'Fontaine',         label: 'Fontaine' },
  { value: 'Other',            label: 'Other' },
];

const BODY_TYPE_OPTIONS = [
  { value: '', label: '—' },
  { value: 'Dry Van', label: 'Dry Van' },
  { value: 'Refrigerated', label: 'Refrigerated' },
  { value: 'Flatbed', label: 'Flatbed' },
  { value: 'Tanker', label: 'Tanker' },
  { value: 'Step Deck', label: 'Step Deck' },
  { value: 'Lowboy', label: 'Lowboy' },
];

const OWNERSHIP_OPTIONS = [
  { value: '', label: '—' },
  { value: 'Owned', label: 'Owned' },
  { value: 'Leased', label: 'Leased' },
  { value: 'Financed', label: 'Financed' },
  { value: 'Renting', label: 'Renting' },
];

export default function TrailerDetailPage() {
  const router = useRouter();
  const params = useParams();
  const { user } = useAuth();
  const organizationId = useOrganizationId();
  const trailerId = params.id as Id<'trailers'>;

  const trailer = useQuery(api.trailers.get, { id: trailerId });
  const allTrailers = useQuery(
    api.trailers.list,
    organizationId ? { organizationId, includeDeleted: true } : 'skip',
  );

  const updateTrailer = useMutation(api.trailers.update);
  const deactivate = useMutation(api.trailers.deactivate);

  const [activeSection, setActiveSection] = React.useState('overview');

  if (trailer === undefined) {
    return (
      <div className="flex-1 flex items-center justify-center">
        <Loader2 className="h-5 w-5 animate-spin text-[var(--text-tertiary)]" />
      </div>
    );
  }
  if (trailer === null) {
    return (
      <div className="flex-1 flex items-center justify-center text-[12.5px] text-[var(--text-tertiary)]">
        Trailer not found.
      </div>
    );
  }

  // Prev / next nav (skip deleted)
  const list = (allTrailers ?? []).filter((t) => !t.isDeleted);
  const idx = list.findIndex((t) => t._id === trailerId);
  const prev = idx > 0 ? list[idx - 1] : null;
  const next = idx >= 0 && idx < list.length - 1 ? list[idx + 1] : null;

  const userName =
    user?.firstName && user?.lastName ? `${user.firstName} ${user.lastName}` : user?.email ?? '';

  const onDeactivate = async () => {
    if (!user) return;
    if (!window.confirm(`Deactivate trailer ${trailer.unitId}?`)) return;
    try {
      await deactivate({ id: trailerId, userId: user.id, userName });
      toast.success('Trailer deactivated');
      router.push('/fleet/trailers');
    } catch (e) {
      console.error(e);
      toast.error('Failed to deactivate trailer');
    }
  };

  // ── Inline edit commit ──
  type UpdateArgs = Parameters<typeof updateTrailer>[0];
  type WritableField = Exclude<keyof UpdateArgs, 'id' | 'userId' | 'userName' | 'organizationId'>;

  const NUMBER_FIELDS = new Set<WritableField>(['year', 'gvwr', 'purchasePrice']);
  const DATE_FIELDS = new Set<WritableField>([
    'registrationExpiration',
    'insuranceExpiration',
    'purchaseDate',
  ]);

  const commitField = async (key: string, next: string | string[]) => {
    if (!user) return;
    if (Array.isArray(next)) return;
    const field = key as WritableField;
    const trimmed = next.trim();
    const payload: Record<string, unknown> = {};
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
      await updateTrailer({ id: trailerId, userId: user.id, userName, ...payload });
    } catch (e) {
      console.error(e);
      toast.error(`Failed to update ${field}`);
    }
  };

  // ── Hero pieces ──
  const headline = [trailer.size, trailer.bodyType].filter(Boolean).join(' ');
  const ym = [trailer.year, trailer.make].filter(Boolean).join(' ');
  const titleNode = (
    <span className="inline-flex items-center gap-3">
      <span className="num">{trailer.unitId}</span>
      {headline && (
        <span className="text-[var(--text-tertiary)] font-normal">· {headline}</span>
      )}
      {trailer.isDeleted ? (
        <Chip status="cancelled" label="Deleted" />
      ) : (
        <StatusChipPopover
          current={trailer.status}
          options={STATUS_CHIP_OPTIONS}
          onChange={(next) => commitField('status', next)}
        />
      )}
    </span>
  );

  const subtitle = (
    <span className="flex items-center flex-wrap gap-x-4 gap-y-1 text-[13px] text-[var(--text-secondary)]">
      <span className="inline-flex items-center gap-1.5 num">
        <WIcon name="shield" size={13} /> VIN {trailer.vin}
      </span>
      {trailer.plate && (
        <span className="inline-flex items-center gap-1.5 num">
          <WIcon name="id-card" size={13} /> Plate {trailer.plate}
        </span>
      )}
      {ym && (
        <span className="inline-flex items-center gap-1.5">
          <WIcon name="package" size={13} /> {ym}
        </span>
      )}
      {trailer.bodyType && (
        <span className="inline-flex items-center gap-1.5">
          <WIcon name="box-trailer" size={13} /> {trailer.bodyType}
        </span>
      )}
    </span>
  );

  // ── Compliance ──
  const regStatus = getDocStatus(trailer.registrationExpiration);
  const insStatus = getDocStatus(trailer.insuranceExpiration);
  const needsAttention = regStatus !== 'valid' || insStatus !== 'valid';

  const attentionItems: AttentionItem[] = [];
  if (!needsAttention && trailer.status === 'Active') {
    attentionItems.push({ tone: 'ok', icon: 'check', title: 'In service', detail: 'All compliance current' });
  }
  if (regStatus === 'expired') {
    attentionItems.push({ tone: 'crit', icon: 'id-card', title: 'Registration expired', detail: fmtDate(trailer.registrationExpiration) });
  } else if (regStatus === 'expiring') {
    attentionItems.push({ tone: 'warn', icon: 'id-card', title: 'Registration expiring soon', detail: fmtDate(trailer.registrationExpiration) });
  }
  if (insStatus === 'expired') {
    attentionItems.push({ tone: 'crit', icon: 'shield', title: 'Insurance expired', detail: fmtDate(trailer.insuranceExpiration) });
  } else if (insStatus === 'expiring') {
    attentionItems.push({ tone: 'warn', icon: 'shield', title: 'Insurance expiring soon', detail: fmtDate(trailer.insuranceExpiration) });
  }

  const bandHeadline = (
    <span>
      <strong className="text-foreground">Trailer {trailer.unitId}</strong>{' '}
      {needsAttention ? (
        <>has compliance items that need attention.</>
      ) : trailer.status === 'Active' ? (
        <>is <span style={{ color: '#0F8C5F', fontWeight: 500 }}>in service</span> with all compliance current.</>
      ) : (
        <>is currently {trailer.status.toLowerCase()}.</>
      )}
    </span>
  );

  // ── Editable cards ──
  // Status lives in the hero (click the chip to change) — intentionally
  // excluded from the Trailer card so it isn't shown twice.
  const trailerItems: Array<DSPropsEditableItem | null> = [
    { key: 'unitId',   label: 'Unit #', value: trailer.unitId, editor: { type: 'text' } },
    { key: 'vin',      label: 'VIN',    value: trailer.vin,    editor: { type: 'text' } },
    { key: 'year',     label: 'Year',
      value: trailer.year != null ? String(trailer.year) : '',
      editor: { type: 'select', options: YEAR_OPTIONS },
      placeholder: 'Pick a year',
    },
    { key: 'make',     label: 'Make',
      value: trailer.make ?? '',
      editor: { type: 'select', options: TRAILER_MAKE_OPTIONS },
      placeholder: 'Pick a make',
    },
    { key: 'model',    label: 'Model',  value: trailer.model ?? '', editor: { type: 'text' } },
    { key: 'bodyType', label: 'Type',   value: trailer.bodyType ?? '', editor: { type: 'select', options: BODY_TYPE_OPTIONS } },
    { key: 'size',     label: 'Length', value: trailer.size ?? '',     editor: { type: 'text' }, placeholder: 'e.g. 53ft' },
    { key: 'gvwr',     label: 'GVWR (lb)', value: trailer.gvwr != null ? String(trailer.gvwr) : '', editor: { type: 'text' } },
  ];

  const regInsItems: Array<DSPropsEditableItem | null> = [
    { key: 'plate', label: 'Plate', value: trailer.plate ?? '', editor: { type: 'text' } },
    {
      key: 'registrationExpiration',
      label: 'Reg. expires',
      value: trailer.registrationExpiration ?? '',
      editor: { type: 'date' },
      display: (
        <span className="inline-flex items-center gap-2">
          <span className="num">{fmtDate(trailer.registrationExpiration)}</span>
          <Chip status={chipForDoc(trailer.registrationExpiration)} />
        </span>
      ),
    },
    { key: 'insuranceFirm',         label: 'Insurance carrier', value: trailer.insuranceFirm ?? '',         editor: { type: 'text' } },
    { key: 'insurancePolicyNumber', label: 'Policy #',          value: trailer.insurancePolicyNumber ?? '', editor: { type: 'text' } },
    {
      key: 'insuranceExpiration',
      label: 'Ins. expires',
      value: trailer.insuranceExpiration ?? '',
      editor: { type: 'date' },
      display: (
        <span className="inline-flex items-center gap-2">
          <span className="num">{fmtDate(trailer.insuranceExpiration)}</span>
          <Chip status={chipForDoc(trailer.insuranceExpiration)} />
        </span>
      ),
    },
  ];

  const financialItems: Array<DSPropsEditableItem | null> = [
    { key: 'ownershipType', label: 'Ownership',  value: trailer.ownershipType ?? '', editor: { type: 'select', options: OWNERSHIP_OPTIONS } },
    {
      key: 'purchaseDate',  label: 'Purchased',
      value: trailer.purchaseDate ?? '',
      editor: { type: 'date' },
      display: trailer.purchaseDate ? <span className="num">{fmtDate(trailer.purchaseDate)}</span> : undefined,
    },
    {
      key: 'purchasePrice', label: 'Price',
      value: trailer.purchasePrice != null ? String(trailer.purchasePrice) : '',
      editor: { type: 'text' },
      display: trailer.purchasePrice ? <span className="num">{fmtMoney(trailer.purchasePrice)}</span> : undefined,
    },
    { key: 'lienholder', label: 'Lienholder', value: trailer.lienholder ?? '', editor: { type: 'text' } },
  ];

  // ── Sections ──
  const overviewContent = (
    <div className="flex flex-col gap-3.5">
      <AttentionBand
        headline={bandHeadline}
        items={attentionItems}
        onJump={(id) => setActiveSection(id)}
      />

      <div className="grid grid-cols-1 md:grid-cols-2 gap-3 items-start">
        <DSCard title="Trailer">
          <DSPropsEditable items={trailerItems} onCommit={commitField} />
        </DSCard>
        <DSCard title="Registration & insurance">
          <DSPropsEditable items={regInsItems} onCommit={commitField} />
        </DSCard>
      </div>

      <div className="grid grid-cols-1 md:grid-cols-2 gap-3 items-start">
        <DSCard title="Financial">
          <DSPropsEditable items={financialItems} onCommit={commitField} />
        </DSCard>
        <CurrentlyMatedCard />
      </div>
    </div>
  );

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

  const loadsContent = (
    <DSCard
      title="Loads carried"
      bodyClassName="p-0"
      action={<MockDataBadge />}
    >
      <DSMiniTable
        columns={loadsCols}
        rows={MOCK_LOADS}
        total={MOCK_LOADS.length}
      />
    </DSCard>
  );

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

  const activityContent = (
    <DSCard title="Recent activity">
      <DSActivity
        items={[
          ...(trailer.isDeleted && trailer.deletedAt
            ? [{ icon: 'trash' as const, text: `Deactivated · ${fmtDate(new Date(trailer.deletedAt).toISOString().slice(0, 10))}`, when: '' }]
            : []),
          ...(trailer.updatedAt !== trailer.createdAt
            ? [{ icon: 'edit-pen' as const, text: `Last updated · ${fmtDate(new Date(trailer.updatedAt).toISOString().slice(0, 10))}`, when: '' }]
            : []),
          { icon: 'package' as const, text: `Trailer created · ${fmtDate(new Date(trailer.createdAt).toISOString().slice(0, 10))}`, when: '' },
        ]}
      />
    </DSCard>
  );

  const sections: FPSection[] = [
    { id: 'overview',    label: 'Overview',     icon: 'home',      content: overviewContent },
    { id: 'inspections', label: 'Inspections',  icon: 'list-tree', count: MOCK_INSPECTIONS.length, content: inspectionsContent },
    { id: 'loads',       label: 'Loads carried', icon: 'truck',    count: MOCK_LOADS.length, content: loadsContent },
    { id: 'maintenance', label: 'Maintenance',  icon: 'settings',  count: MOCK_MAINTENANCE.length, content: maintenanceContent },
    { id: 'activity',    label: 'Activity',     icon: 'pulse',     content: activityContent },
  ];

  const rightRail = (
    <div className="flex flex-col gap-3">
      <DSCard title="Compliance">
        <div className="flex flex-col gap-2.5">
          <ComplianceRow label="Registration" date={trailer.registrationExpiration} status={chipForDoc(trailer.registrationExpiration)} />
          <ComplianceRow label="Insurance"    date={trailer.insuranceExpiration}    status={chipForDoc(trailer.insuranceExpiration)} />
        </div>
      </DSCard>
      <QRPlacardCard
        kind="trailer"
        unit={trailer.unitId}
        recordId={String(trailerId)}
        subtitle={[trailer.size, trailer.bodyType].filter(Boolean).join(' ')}
      />
      <DSCard title="Upcoming" action={<MockDataBadge />}>
        <DSActivity
          items={[
            { icon: 'circle-dot', text: 'Annual inspection due', when: '~Aug 14' },
            { icon: 'shield',     text: 'Registration renewal',  when: fmtDate(trailer.registrationExpiration) },
          ]}
        />
      </DSCard>
    </div>
  );

  return (
    <DetailsFullPage
      breadcrumb={
        <span className="inline-flex items-center gap-1.5 text-[var(--text-secondary)]">
          <button type="button" onClick={() => router.push('/fleet/trailers')} className="hover:text-foreground">
            Trailers
          </button>
          <span className="text-[var(--text-tertiary)]">/</span>
          <span className="num text-foreground font-medium truncate max-w-[280px]">{trailer.unitId}</span>
        </span>
      }
      onBack={() => router.push('/fleet/trailers')}
      prevLabel={prev ? prev.unitId : undefined}
      onPrev={prev ? () => router.push(`/fleet/trailers/${prev._id}`) : null}
      nextLabel={next ? next.unitId : undefined}
      onNext={next ? () => router.push(`/fleet/trailers/${next._id}`) : null}
      toolbarActions={
        <>
          {!trailer.isDeleted && (
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

// ─── Mock data + columns ─────────────────────────────────────────────────

interface InspectionRow {
  id: number;
  date: string;
  type: string;
  who: string;
  defects: number;
  status: ChipStatus;
}
const MOCK_INSPECTIONS: InspectionRow[] = [
  { id: 1, date: 'Apr 24', type: 'Pre-trip',  who: 'Andres Cuellar',   defects: 0, status: 'valid' },
  { id: 2, date: 'Apr 18', type: 'Post-trip', who: 'Andres Cuellar',   defects: 1, status: 'expiring' },
  { id: 3, date: 'Mar 02', type: 'Annual',    who: 'WestState Diesel', defects: 1, status: 'valid' },
  { id: 4, date: 'Feb 11', type: 'Roadside',  who: 'CHP — I-5',        defects: 0, status: 'valid' },
  { id: 5, date: 'Jan 28', type: 'Pre-trip',  who: 'Jorge Romero',     defects: 0, status: 'valid' },
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

interface LoadRow {
  id: number;
  order: string;
  route: string;
  driver: string;
  date: string;
  status: ChipStatus;
}
const MOCK_LOADS: LoadRow[] = [
  { id: 1, order: 'OT-2026-0418', route: 'Sacramento → Salt Lake City', driver: 'Andres Cuellar', date: 'Apr 30', status: 'active' },
  { id: 2, order: 'OT-2026-0411', route: 'Reno → Phoenix',              driver: 'Andres Cuellar', date: 'Apr 27', status: 'valid' },
  { id: 3, order: 'OT-2026-0408', route: 'Sacramento → Portland',       driver: 'Andres Cuellar', date: 'Apr 24', status: 'valid' },
  { id: 4, order: 'OT-2026-0402', route: 'Bakersfield → Las Vegas',     driver: 'Sergio Barba',   date: 'Apr 20', status: 'valid' },
  { id: 5, order: 'OT-2026-0397', route: 'Stockton → Boise',            driver: 'Andres Cuellar', date: 'Apr 16', status: 'valid' },
];
const loadsCols: DSMiniColumn<LoadRow>[] = [
  { key: 'order',  label: 'Trip',   width: '1fr',   render: (r) => <span className="num text-[var(--accent)] font-medium">{r.order}</span> },
  { key: 'route',  label: 'Route',  width: '1.6fr' },
  { key: 'driver', label: 'Driver', width: '1fr',
    render: (r) => (
      <span className="inline-flex items-center gap-2 min-w-0">
        <Avatar name={r.driver} size={20} />
        <span className="truncate">{r.driver}</span>
      </span>
    ),
  },
  { key: 'date',   label: 'Date',   width: '100px', render: (r) => <span className="num">{r.date}</span> },
  { key: 'status', label: 'Status', width: '100px', render: (r) => <Chip status={r.status} /> },
];

interface MaintenanceRow {
  id: number;
  wo: string;
  desc: string;
  date: string;
  cost: string;
}
const MOCK_MAINTENANCE: MaintenanceRow[] = [
  { id: 1, wo: 'WO-1188', desc: 'ABS sensor — left rear',        date: 'Mar 02', cost: '$420'   },
  { id: 2, wo: 'WO-1162', desc: 'Reefer thermostat replacement', date: 'Feb 14', cost: '$890'   },
  { id: 3, wo: 'WO-1141', desc: 'Tires — outer drive (4)',       date: 'Jan 18', cost: '$2,140' },
];
const maintenanceCols: DSMiniColumn<MaintenanceRow>[] = [
  { key: 'wo',   label: 'WO #',        width: '100px', render: (r) => <span className="num text-[var(--accent)] font-medium">{r.wo}</span> },
  { key: 'desc', label: 'Description', width: '1.4fr' },
  { key: 'date', label: 'Closed',      width: '100px', render: (r) => <span className="num">{r.date}</span> },
  { key: 'cost', label: 'Cost',        width: '100px', align: 'right', render: (r) => <span className="num">{r.cost}</span> },
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

function CurrentlyMatedCard() {
  return (
    <DSCard title="Currently" action={<MockDataBadge />}>
      <div className="grid gap-0" style={{ gridTemplateColumns: '120px 1fr' }}>
        {[
          { label: 'Truck',    value: <span className="num text-[var(--accent)]">T-204 · Volvo VNL 760</span> },
          { label: 'Driver',   value: <span className="inline-flex items-center gap-2"><Avatar name="Andres Cuellar Ortega" size={20} /><span>Andres Cuellar Ortega</span></span> },
          { label: 'Trip',     value: <span className="num text-[var(--accent)]">OT-2026-0418</span> },
          { label: 'Location', value: 'I-80 EB · Wells, NV' },
        ].map((it, i) => (
          <React.Fragment key={i}>
            <div className={`py-2.5 pr-3 text-[12.5px] text-[var(--text-tertiary)] ${i > 0 ? 'border-t border-[var(--border-hairline)]' : ''}`}>
              {it.label}
            </div>
            <div className={`py-2.5 m-0 text-[13px] text-foreground inline-flex items-center gap-2 ${i > 0 ? 'border-t border-[var(--border-hairline)]' : ''}`}>
              {it.value}
            </div>
          </React.Fragment>
        ))}
      </div>
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
