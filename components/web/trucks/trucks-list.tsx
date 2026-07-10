/**
 * TrucksList — Otoqa Web chassis for the fleet trucks screen.
 *
 * Mirrors `DriversList` (PageHeader + SavedViews + TableToolbar + Table +
 * BulkBar + InfiniteFooter). Differences:
 *   - Row shape is a Convex `trucks` row, not a driver
 *   - Saved views cover Active / Needs attention (expiring docs) /
 *     Out of service / Maintenance / Deleted
 *   - Columns: Unit, Vehicle, Registration, Insurance, Status
 *   - Click → routes to /fleet/trucks/[id] (detail page already exists)
 *
 * Data is passed in by the page wrapper; this component owns view +
 * filter + search + selection state only.
 */

'use client';

import * as React from 'react';
import { useRouter } from 'next/navigation';
import {
  BulkAction,
  BulkBar,
  Chip,
  type ChipStatus,
  FilterBar,
  type FilterChipValue,
  type FilterProperty,
  InfiniteFooter,
  PageHeader,
  SavedViews,
  type SavedView as SavedViewTab,
  Table,
  type TableColumn,
  TableToolbar,
  WBtn,
  WIcon,
} from '@/components/web';
import { useUserPreferences } from '@/components/web/shell/use-user-preferences';

// ─── Row type ───────────────────────────────────────────────────────────

export interface TruckRow {
  _id: string;
  organizationId: string;
  unitId: string;
  vin: string;
  plate?: string;
  make?: string;
  model?: string;
  year?: number;
  status: string;
  bodyType?: string;
  registrationExpiration?: string;
  insuranceExpiration?: string;
  insuranceFirm?: string;
  isDeleted?: boolean;
  samsaraVehicleId?: string;
  createdAt: number;
  updatedAt: number;
}

// ─── Expiration helpers ─────────────────────────────────────────────────

/** Returns `'expired' | 'expiring' | 'valid' | 'na'` for a YYYY-MM-DD date. */
export function getDocStatus(date?: string): 'expired' | 'expiring' | 'valid' | 'na' {
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

const chipForDoc = (date?: string): ChipStatus => {
  const s = getDocStatus(date);
  return s === 'expired' ? 'expired' : s === 'expiring' ? 'expiring' : s === 'na' ? 'na' : 'valid';
};

function fmtDate(date?: string): string {
  if (!date) return '—';
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(date);
  if (!m) return date;
  const d = new Date(Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3])));
  return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric', timeZone: 'UTC' });
}

function needsAttentionTruck(t: TruckRow): boolean {
  if (t.isDeleted) return false;
  return (
    getDocStatus(t.registrationExpiration) !== 'valid' ||
    getDocStatus(t.insuranceExpiration) !== 'valid'
  );
}

// ─── System views ───────────────────────────────────────────────────────

interface SystemView {
  id: string;
  label: string;
  predicate: (t: TruckRow) => boolean;
  tone?: 'neutral' | 'accent' | 'warn' | 'danger';
}

const SYSTEM_VIEWS: SystemView[] = [
  { id: 'all',         label: 'All Trucks',      predicate: (t) => !t.isDeleted },
  { id: 'active',      label: 'Active',          predicate: (t) => !t.isDeleted && t.status === 'Active' },
  { id: 'attention',   label: 'Needs Attention', predicate: needsAttentionTruck, tone: 'warn' },
  { id: 'maintenance', label: 'In Maintenance',  predicate: (t) => !t.isDeleted && (t.status === 'In Repair' || t.status === 'Maintenance') },
  { id: 'oos',         label: 'Out of Service',  predicate: (t) => !t.isDeleted && t.status === 'Out of Service' },
  { id: 'deleted',     label: 'Deleted',         predicate: (t) => !!t.isDeleted },
];

// ─── Columns ────────────────────────────────────────────────────────────

const COLUMNS: TableColumn<TruckRow>[] = [
  {
    key: 'unit',
    label: 'Unit',
    width: '1.2fr',
    render: (t) => (
      <span className="flex items-center gap-2.5 min-w-0">
        <span
          aria-hidden
          className="inline-flex items-center justify-center rounded-md shrink-0"
          style={{
            width: 28,
            height: 28,
            background: 'rgba(15,140,95,0.10)',
            color: '#0F8C5F',
          }}
        >
          <WIcon name="truck" size={14} />
        </span>
        <span className="min-w-0 flex flex-col leading-tight">
          <span className="num text-[13px] font-medium text-foreground truncate">{t.unitId}</span>
          <span className="num text-[11.5px] text-[var(--text-tertiary)] truncate">VIN {t.vin}</span>
        </span>
      </span>
    ),
  },
  {
    key: 'vehicle',
    label: 'Vehicle',
    width: '1.3fr',
    sortable: false,
    render: (t) => {
      const ymm = [t.year, t.make, t.model].filter(Boolean).join(' ');
      return (
        <span className="flex flex-col leading-tight min-w-0">
          <span className="text-[13px] text-foreground truncate">{ymm || '—'}</span>
          {t.bodyType && (
            <span className="text-[11.5px] text-[var(--text-tertiary)] truncate">{t.bodyType}</span>
          )}
        </span>
      );
    },
  },
  {
    key: 'plate',
    label: 'Plate',
    width: '110px',
    sortable: false,
    render: (t) => <span className="num text-[12.5px]">{t.plate ?? '—'}</span>,
  },
  {
    key: 'registration',
    label: 'Registration',
    // Fixed at 200px so the date + chip fit comfortably without truncation
    // while leaving the leftover flex space to Unit + Vehicle. Keeps the
    // Reg / Insurance / Status trio huddled together at the right edge.
    width: '200px',
    render: (t) => (
      <span className="flex items-center gap-1.5 min-w-0">
        <span className="num text-[12.5px] text-foreground truncate">
          {fmtDate(t.registrationExpiration)}
        </span>
        <Chip status={chipForDoc(t.registrationExpiration)} dotOnly />
      </span>
    ),
  },
  {
    key: 'insurance',
    label: 'Insurance',
    width: '200px',
    render: (t) => (
      <span className="flex items-center gap-1.5 min-w-0">
        <span className="num text-[12.5px] text-foreground truncate">
          {fmtDate(t.insuranceExpiration)}
        </span>
        <Chip status={chipForDoc(t.insuranceExpiration)} dotOnly />
      </span>
    ),
  },
  {
    key: 'status',
    label: 'Status',
    width: '140px',
    render: (t) => {
      const map: Record<string, ChipStatus> = {
        Active: 'active',
        'Out of Service': 'inactive',
        'In Repair': 'pending',
        Maintenance: 'pending',
        Sold: 'cancelled',
        Lost: 'expired',
      };
      const tone = t.isDeleted ? 'cancelled' : (map[t.status] ?? 'inactive');
      return <Chip status={tone} label={t.isDeleted ? 'Deleted' : t.status} />;
    },
  },
];

// ─── Component ──────────────────────────────────────────────────────────

interface TrucksListProps {
  trucks: TruckRow[];
  loading?: boolean;
  onCreate: () => void;
  onImport: () => void;
  onExport: () => void;
  /** Bulk-deactivate the given truck ids. Resolves when complete. */
  onBulkDeactivate: (ids: string[]) => Promise<void> | void;
}

export function TrucksList({
  trucks,
  loading,
  onCreate,
  onImport,
  onExport,
  onBulkDeactivate,
}: TrucksListProps) {
  const router = useRouter();
  const { density } = useUserPreferences();
  const [viewId, setViewId] = React.useState('all');
  const [search, setSearch] = React.useState('');
  const [filters, setFilters] = React.useState<FilterChipValue[]>([]);
  const [selected, setSelected] = React.useState<Set<string>>(new Set());
  const [sortKey, setSortKey] = React.useState<string | undefined>('unit');
  const [sortDir, setSortDir] = React.useState<'asc' | 'desc'>('asc');
  const [visibleCols, setVisibleCols] = React.useState<Set<string>>(
    new Set(COLUMNS.map((c) => c.key)),
  );

  const counts = React.useMemo(() => {
    const out: Record<string, number> = {};
    for (const v of SYSTEM_VIEWS) out[v.id] = trucks.filter(v.predicate).length;
    return out;
  }, [trucks]);

  const systemView = SYSTEM_VIEWS.find((v) => v.id === viewId);

  const filtered = React.useMemo(() => {
    let rows = systemView ? trucks.filter(systemView.predicate) : trucks.filter((t) => !t.isDeleted);
    for (const chip of filters) {
      const wanted = new Set(chip.values);
      rows = rows.filter((t) => {
        switch (chip.propId) {
          case 'status':       return wanted.has(t.status);
          case 'make':         return t.make ? wanted.has(t.make) : false;
          case 'body-type':    return t.bodyType ? wanted.has(t.bodyType) : false;
          case 'reg-status': {
            const tag = chipForDoc(t.registrationExpiration);
            return wanted.has(tag);
          }
          case 'ins-status': {
            const tag = chipForDoc(t.insuranceExpiration);
            return wanted.has(tag);
          }
          case 'telematics':   return wanted.has(t.samsaraVehicleId ? 'connected' : 'none');
          default: return true;
        }
      });
    }
    if (search.trim()) {
      const q = search.toLowerCase();
      rows = rows.filter(
        (t) =>
          t.unitId.toLowerCase().includes(q) ||
          t.vin.toLowerCase().includes(q) ||
          (t.plate ?? '').toLowerCase().includes(q) ||
          (t.make ?? '').toLowerCase().includes(q) ||
          (t.model ?? '').toLowerCase().includes(q),
      );
    }
    if (sortKey) {
      const dir = sortDir === 'asc' ? 1 : -1;
      rows = [...rows].sort((a, b) => {
        const av = sortValueOf(a, sortKey);
        const bv = sortValueOf(b, sortKey);
        if (av === bv) return 0;
        return av > bv ? dir : -dir;
      });
    }
    return rows;
  }, [trucks, systemView, filters, search, sortKey, sortDir]);

  const properties: FilterProperty[] = React.useMemo(() => {
    const statusOptions = uniqueValues(trucks, (t) => t.status).map((v) => ({ value: v, label: v }));
    const makeOptions = uniqueValues(trucks, (t) => t.make).map((v) => ({ value: v, label: v }));
    const bodyOptions = uniqueValues(trucks, (t) => t.bodyType).map((v) => ({ value: v, label: v }));
    return [
      { id: 'status',     label: 'Status',           kind: 'enum', icon: 'pulse',    options: statusOptions },
      { id: 'make',       label: 'Make',             kind: 'enum', icon: 'truck',    options: makeOptions },
      { id: 'body-type',  label: 'Body type',        kind: 'enum', icon: 'box-trailer', options: bodyOptions },
      {
        id: 'reg-status',
        label: 'Registration',
        kind: 'enum',
        icon: 'id-card',
        options: [
          { value: 'valid',    label: 'Valid' },
          { value: 'expiring', label: 'Expiring' },
          { value: 'expired',  label: 'Expired' },
        ],
      },
      {
        id: 'ins-status',
        label: 'Insurance',
        kind: 'enum',
        icon: 'shield',
        options: [
          { value: 'valid',    label: 'Valid' },
          { value: 'expiring', label: 'Expiring' },
          { value: 'expired',  label: 'Expired' },
        ],
      },
      {
        id: 'telematics',
        label: 'Telematics',
        kind: 'enum',
        icon: 'pulse',
        options: [
          { value: 'connected', label: 'Samsara connected' },
          { value: 'none',      label: 'Not connected' },
        ],
      },
    ];
  }, [trucks]);

  const visibleColumns = COLUMNS.filter((c) => visibleCols.has(c.key));

  const onToggleSelect = (id: string) => {
    setSelected((s) => {
      const next = new Set(s);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };
  const onToggleSelectAll = () => {
    setSelected((s) => {
      if (s.size === filtered.length) return new Set();
      return new Set(filtered.map((t) => t._id));
    });
  };
  const onSort = (key: string) => {
    if (sortKey === key) setSortDir((d) => (d === 'asc' ? 'desc' : 'asc'));
    else {
      setSortKey(key);
      setSortDir('asc');
    }
  };

  const tabs: SavedViewTab[] = SYSTEM_VIEWS.map((v) => ({
    id: v.id,
    label: v.label,
    count: counts[v.id],
    tone: v.tone,
  }));

  const stats = [
    { value: counts.all,       label: 'total' },
    { value: counts.active,    label: 'active' },
    { value: counts.attention, label: 'need attention' },
  ];

  return (
    <div className="flex-1 flex flex-col min-h-0 relative">
      <PageHeader
        title="Trucks"
        stats={stats}
        actions={
          <>
            <WBtn variant="ghost" size="sm" leading="export" onClick={onExport}>Export CSV</WBtn>
            <WBtn variant="ghost" size="sm" leading="import" onClick={onImport}>Import CSV</WBtn>
            <WBtn variant="primary" size="sm" leading="plus" onClick={onCreate}>Create Truck</WBtn>
          </>
        }
      />
      <SavedViews views={tabs} activeId={viewId} onChange={setViewId} />
      <TableToolbar
        searchPlaceholder="Search unit, VIN, plate, make…"
        searchValue={search}
        onSearchChange={setSearch}
        filterTrigger={<FilterBar properties={properties} value={filters} onChange={setFilters} slot="trigger" />}
        columns={COLUMNS.map((c) => ({ key: c.key, label: typeof c.label === 'string' ? c.label : c.key }))}
        visibleColumns={visibleCols}
        onVisibleColumnsChange={setVisibleCols}
      >
        <FilterBar properties={properties} value={filters} onChange={setFilters} slot="chips" />
      </TableToolbar>

      {loading && trucks.length === 0 ? (
        <div className="flex-1 flex items-center justify-center">
          <p className="text-[12.5px] text-[var(--text-tertiary)]">Loading trucks…</p>
        </div>
      ) : filtered.length === 0 ? (
        <EmptyState
          hasData={trucks.length > 0}
          onCreate={onCreate}
          onClearFilters={() => {
            setSearch('');
            setFilters([]);
          }}
        />
      ) : (
        <Table<TruckRow>
          columns={visibleColumns}
          rows={filtered}
          density={density}
          selected={[...selected]}
          onSelect={(id) => onToggleSelect(String(id))}
          onSelectAll={onToggleSelectAll}
          sortKey={sortKey}
          sortDir={sortDir}
          onSort={onSort}
          onRowClick={(r) => router.push(`/fleet/trucks/${r._id}`)}
          getRowId={(r) => r._id}
        />
      )}

      <InfiniteFooter loaded={filtered.length} total={counts[viewId] ?? filtered.length} />

      <BulkBar
        count={selected.size}
        onClear={() => setSelected(new Set())}
        actions={
          <>
            <BulkAction icon="export" label="Export" onClick={onExport} />
            <BulkAction
              icon="alert"
              label="Deactivate"
              danger
              onClick={async () => {
                const ids = [...selected];
                await onBulkDeactivate(ids);
                setSelected(new Set());
              }}
            />
          </>
        }
      />
    </div>
  );
}

function EmptyState({
  hasData,
  onCreate,
  onClearFilters,
}: {
  hasData: boolean;
  onCreate: () => void;
  onClearFilters: () => void;
}) {
  return (
    <div className="flex-1 flex flex-col items-center justify-center gap-3 text-center px-6">
      <span className="h-10 w-10 rounded-full bg-[var(--bg-surface-2)] inline-flex items-center justify-center text-[var(--text-tertiary)]">
        <WIcon name="truck" size={18} />
      </span>
      {hasData ? (
        <>
          <p className="m-0 text-[14px] text-foreground font-medium">No trucks match these filters</p>
          <p className="m-0 text-[12.5px] text-[var(--text-tertiary)] max-w-xs">
            Try removing a filter or clearing your search.
          </p>
          <WBtn variant="secondary" size="sm" onClick={onClearFilters}>Clear filters</WBtn>
        </>
      ) : (
        <>
          <p className="m-0 text-[14px] text-foreground font-medium">No trucks yet</p>
          <p className="m-0 text-[12.5px] text-[var(--text-tertiary)] max-w-xs">
            Add your first truck to start tracking compliance, assignments, and maintenance.
          </p>
          <WBtn variant="primary" size="sm" leading="plus" onClick={onCreate}>Create Truck</WBtn>
        </>
      )}
    </div>
  );
}

function uniqueValues<T>(arr: T[], pick: (t: T) => string | undefined): string[] {
  const set = new Set<string>();
  for (const a of arr) {
    const v = pick(a);
    if (v) set.add(v);
  }
  return [...set].sort();
}

function sortValueOf(t: TruckRow, key: string): string | number {
  switch (key) {
    case 'unit':         return t.unitId.toLowerCase();
    case 'vehicle':      return `${t.year ?? 0} ${t.make ?? ''} ${t.model ?? ''}`.toLowerCase();
    case 'plate':        return (t.plate ?? '').toLowerCase();
    case 'registration': return t.registrationExpiration ?? '';
    case 'insurance':    return t.insuranceExpiration ?? '';
    case 'status':       return t.status;
    default: return '';
  }
}
