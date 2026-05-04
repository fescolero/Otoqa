/**
 * DriversList — the new Drivers screen, built on the Otoqa Web chassis.
 *
 * Composes PageHeader + SavedViews + TableToolbar + FilterBar + Table +
 * BulkBar + InfiniteFooter, with a click-to-open DetailsSlideOver wired
 * to buildDriverDetails. Filtering is client-side (matches the existing
 * page's behavior), and saved views are persisted via Convex
 * (api.savedViews) on top of code-defined system defaults.
 *
 * Data is passed in (not fetched) so the page wrapper owns auth /
 * mutations / loading state.
 */

'use client';

import * as React from 'react';
import Link from 'next/link';
import {
  BulkAction,
  BulkBar,
  Chip,
  CountBadge,
  DetailsSlideOver,
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
  Avatar,
} from '@/components/web';
import { useUserPreferences } from '@/components/web/shell/use-user-preferences';
import {
  buildDriverDetails,
  countAttention,
  getDocStatus,
  type DriverRow,
} from './build-driver-details';

interface SystemView {
  id: string;
  label: string;
  /** Predicate run against each driver. */
  predicate: (d: DriverRow) => boolean;
  /** Tone for the count badge. */
  tone?: 'neutral' | 'accent' | 'warn' | 'danger';
}

const isActive   = (d: DriverRow) => !d.isDeleted && d.employmentStatus === 'Active';
const isOnLeave  = (d: DriverRow) => !d.isDeleted && d.employmentStatus === 'On Leave';
const isInactive = (d: DriverRow) => !d.isDeleted && d.employmentStatus === 'Inactive';
const needsAttention = (d: DriverRow) => !d.isDeleted && countAttention(d) > 0;

const SYSTEM_VIEWS: SystemView[] = [
  { id: 'all',       label: 'All Drivers',     predicate: (d) => !d.isDeleted },
  { id: 'active',    label: 'Active',          predicate: isActive },
  { id: 'attention', label: 'Needs Attention', predicate: needsAttention, tone: 'warn' },
  { id: 'on-leave',  label: 'On Leave',        predicate: isOnLeave },
  { id: 'inactive',  label: 'Inactive',        predicate: isInactive },
  { id: 'deleted',   label: 'Deleted',         predicate: (d) => !!d.isDeleted },
];

const COLUMNS: TableColumn<DriverRow>[] = [
  {
    key: 'name',
    label: 'Driver',
    width: '1.5fr',
    render: (d) => {
      const full = [d.firstName, d.lastName].filter(Boolean).join(' ');
      return (
        <span className="flex items-center gap-2 min-w-0">
          <Avatar name={full} size={26} />
          <span className="min-w-0 flex flex-col leading-tight">
            <span className="text-[13px] text-foreground truncate">{full}</span>
            <span className="text-[11.5px] text-[var(--text-tertiary)] truncate">{d.email}</span>
          </span>
        </span>
      );
    },
  },
  {
    key: 'phone',
    label: 'Phone',
    width: '1.1fr',
    sortable: false,
    render: (d) => fmtPhone(d.phone),
  },
  {
    key: 'license',
    label: 'License',
    width: '1.2fr',
    render: (d) => (
      <span className="flex items-center gap-1.5 min-w-0">
        <span className="num text-[13px] text-foreground truncate">
          {d.licenseClass ?? '—'} · {d.licenseExpiration ? fmtDate(d.licenseExpiration) : '—'}
        </span>
        <Chip status={chipForDoc(d.licenseExpiration)} dotOnly />
      </span>
    ),
  },
  {
    key: 'medical',
    label: 'Medical',
    width: '1.1fr',
    render: (d) => (
      <span className="flex items-center gap-1.5 min-w-0">
        <span className="num text-[13px] text-foreground truncate">
          {d.medicalExpiration ? fmtDate(d.medicalExpiration) : '—'}
        </span>
        <Chip status={chipForDoc(d.medicalExpiration)} dotOnly />
      </span>
    ),
  },
  {
    key: 'state',
    label: 'State',
    width: '70px',
    align: 'left',
    render: (d) => d.licenseState ?? '—',
  },
  {
    key: 'employmentStatus',
    label: 'Status',
    width: '120px',
    render: (d) => (
      <Chip
        status={
          d.employmentStatus === 'Active' ? 'active'
            : d.employmentStatus === 'On Leave' ? 'pending'
            : d.isDeleted ? 'cancelled'
            : 'inactive'
        }
      />
    ),
  },
];

function chipForDoc(date?: string) {
  const s = getDocStatus(date);
  return s === 'expired' ? 'expired' : s === 'expiring' ? 'expiring' : s === 'na' ? 'na' : 'valid';
}

function fmtDate(dateStr?: string): string {
  if (!dateStr) return '—';
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(dateStr);
  if (!m) return dateStr;
  const d = new Date(Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3])));
  return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric', timeZone: 'UTC' });
}

function fmtPhone(p?: string): string {
  if (!p) return '—';
  const digits = p.replace(/\D/g, '');
  if (digits.length === 10) return `(${digits.slice(0, 3)}) ${digits.slice(3, 6)}-${digits.slice(6)}`;
  return p;
}

interface DriversListProps {
  drivers: DriverRow[];
  loading?: boolean;
  onCreate: () => void;
  onImport: () => void;
  onExport: () => void;
  /** Bulk deactivate the given driver ids. Resolves when complete. */
  onBulkDeactivate: (ids: string[]) => Promise<void> | void;
}

export function DriversList({ drivers, loading, onCreate, onImport, onExport, onBulkDeactivate }: DriversListProps) {
  const { density } = useUserPreferences();
  const [viewId, setViewId] = React.useState('all');
  const [search, setSearch] = React.useState('');
  const [filters, setFilters] = React.useState<FilterChipValue[]>([]);
  const [selected, setSelected] = React.useState<Set<string>>(new Set());
  const [activeRecord, setActiveRecord] = React.useState<DriverRow | null>(null);
  const [sortKey, setSortKey] = React.useState<string | undefined>('name');
  const [sortDir, setSortDir] = React.useState<'asc' | 'desc'>('asc');
  const [visibleCols, setVisibleCols] = React.useState<Set<string>>(
    new Set(COLUMNS.map((c) => c.key)),
  );

  // Counts per view for the saved-views badges.
  const counts = React.useMemo(() => {
    const out: Record<string, number> = {};
    for (const v of SYSTEM_VIEWS) out[v.id] = drivers.filter(v.predicate).length;
    return out;
  }, [drivers]);

  // Apply view + filters + search.
  const view = SYSTEM_VIEWS.find((v) => v.id === viewId) ?? SYSTEM_VIEWS[0];
  const filtered = React.useMemo(() => {
    let rows = drivers.filter(view.predicate);
    for (const chip of filters) {
      const wanted = new Set(chip.values);
      rows = rows.filter((d) => {
        switch (chip.propId) {
          case 'class':       return d.licenseClass ? wanted.has(d.licenseClass) : false;
          case 'state':       return d.licenseState ? wanted.has(d.licenseState) : false;
          case 'type':        return d.employmentType ? wanted.has(d.employmentType) : false;
          case 'license-st': {
            const s = getDocStatus(d.licenseExpiration);
            const tag = s === 'expired' ? 'expired' : s === 'expiring' ? 'expiring' : 'valid';
            return wanted.has(tag);
          }
          default: return true;
        }
      });
    }
    if (search.trim()) {
      const q = search.toLowerCase();
      rows = rows.filter(
        (d) =>
          d.firstName.toLowerCase().includes(q) ||
          d.lastName.toLowerCase().includes(q) ||
          d.email.toLowerCase().includes(q) ||
          (d.phone ?? '').toLowerCase().includes(q) ||
          (d.licenseNumber ?? '').toLowerCase().includes(q),
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
  }, [drivers, view, filters, search, sortKey, sortDir]);

  // Filter properties driven by data + static enums.
  const properties: FilterProperty[] = React.useMemo(() => {
    const stateOptions = uniqueValues(drivers, (d) => d.licenseState).map((v) => ({ value: v, label: v }));
    const classOptions = uniqueValues(drivers, (d) => d.licenseClass).map((v) => ({ value: v, label: v }));
    const typeOptions  = uniqueValues(drivers, (d) => d.employmentType).map((v) => ({ value: v, label: v }));
    return [
      { id: 'class',      label: 'License class', kind: 'enum', icon: 'id-card', options: classOptions },
      { id: 'state',      label: 'State',         kind: 'enum', icon: 'compass', options: stateOptions },
      { id: 'type',       label: 'Type',          kind: 'enum', icon: 'briefcase', options: typeOptions },
      {
        id: 'license-st',
        label: 'License status',
        kind: 'enum',
        icon: 'shield',
        options: [
          { value: 'valid',    label: 'Valid' },
          { value: 'expiring', label: 'Expiring' },
          { value: 'expired',  label: 'Expired' },
        ],
      },
    ];
  }, [drivers]);

  const visibleColumns = COLUMNS.filter((c) => visibleCols.has(c.key));
  const detailProps = activeRecord ? buildDriverDetails(activeRecord, { withComments: true }) : null;

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
      return new Set(filtered.map((d) => d._id));
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
        title="Drivers"
        stats={stats}
        actions={
          <>
            <WBtn variant="ghost" size="sm" leading="export" onClick={onExport}>Export CSV</WBtn>
            <WBtn variant="ghost" size="sm" leading="import" onClick={onImport}>Import CSV</WBtn>
            <WBtn variant="primary" size="sm" leading="plus" onClick={onCreate}>Create Driver</WBtn>
          </>
        }
      />
      <SavedViews views={tabs} activeId={viewId} onChange={setViewId} />
      <TableToolbar
        searchPlaceholder="Search drivers…"
        searchValue={search}
        onSearchChange={setSearch}
        filterTrigger={<FilterBar properties={properties} value={filters} onChange={setFilters} slot="trigger" />}
        columns={COLUMNS.map((c) => ({ key: c.key, label: typeof c.label === 'string' ? c.label : c.key }))}
        visibleColumns={visibleCols}
        onVisibleColumnsChange={setVisibleCols}
      >
        <FilterBar properties={properties} value={filters} onChange={setFilters} slot="chips" />
      </TableToolbar>

      {loading && drivers.length === 0 ? (
        <div className="flex-1 flex items-center justify-center">
          <p className="text-[12.5px] text-[var(--text-tertiary)]">Loading drivers…</p>
        </div>
      ) : filtered.length === 0 ? (
        <EmptyState
          hasData={drivers.length > 0}
          onCreate={onCreate}
          onClearFilters={() => {
            setSearch('');
            setFilters([]);
          }}
        />
      ) : (
        <Table<DriverRow>
          columns={visibleColumns}
          rows={filtered}
          density={density}
          selected={[...selected]}
          onSelect={(id) => onToggleSelect(String(id))}
          onSelectAll={onToggleSelectAll}
          sortKey={sortKey}
          sortDir={sortDir}
          onSort={onSort}
          onRowClick={(r) => setActiveRecord(r)}
          activeRowId={activeRecord?._id ?? null}
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

      {activeRecord && detailProps && (
        <DetailsSlideOver
          open
          onClose={() => setActiveRecord(null)}
          layout="tabs"
          width={520}
          header={
            <div className="flex items-start justify-between gap-2">
              {detailProps.header}
            </div>
          }
          sections={detailProps.sections}
          onOpenFull={() => {
            // Escalate to the existing detail page route.
            window.location.assign(`/fleet/drivers/${activeRecord._id}`);
          }}
        />
      )}
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
        <WIcon name="users" size={18} />
      </span>
      {hasData ? (
        <>
          <p className="m-0 text-[14px] text-foreground font-medium">No drivers match these filters</p>
          <p className="m-0 text-[12.5px] text-[var(--text-tertiary)] max-w-xs">
            Try removing a filter or clearing your search.
          </p>
          <WBtn variant="secondary" size="sm" onClick={onClearFilters}>Clear filters</WBtn>
        </>
      ) : (
        <>
          <p className="m-0 text-[14px] text-foreground font-medium">No drivers yet</p>
          <p className="m-0 text-[12.5px] text-[var(--text-tertiary)] max-w-xs">
            Add your first driver to start tracking compliance, assignments, and pay.
          </p>
          <WBtn variant="primary" size="sm" leading="plus" onClick={onCreate}>Create Driver</WBtn>
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

function sortValueOf(d: DriverRow, key: string): string | number {
  switch (key) {
    case 'name':    return `${d.lastName} ${d.firstName}`.toLowerCase();
    case 'license': return d.licenseExpiration ?? '';
    case 'medical': return d.medicalExpiration ?? '';
    case 'state':   return d.licenseState ?? '';
    case 'employmentStatus': return d.employmentStatus ?? '';
    default: return '';
  }
}

// CountBadge re-exported for tests/storybook convenience.
export { CountBadge };
