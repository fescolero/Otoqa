/**
 * VendorsList — Otoqa Web chassis applied to fuel vendors. Mirrors the
 * design in fuel-vendors-screen.jsx:
 *
 *   PageHeader → SavedViews (All / Active / Inactive / Contracted) →
 *   TableToolbar (search + filter + columns + 30-day spend strip) →
 *   Table (brand badge + name, type, discount program, coverage, avg $/gal,
 *          gallons30, spend30, status) → InfiniteFooter → BulkBar.
 *
 * 30-day aggregates (gallons / spend / avg-ppg / txns) are computed
 * client-side off the org's recent fuel entries so the table reflects
 * real activity. When the analytics rollup ships server-side we can swap
 * this for a single dedicated query without touching consumers.
 */

'use client';

import * as React from 'react';
import { useRouter } from 'next/navigation';
import { useMutation } from 'convex/react';
import { toast } from 'sonner';

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
  type SavedView,
  Table,
  type TableColumn,
  TableToolbar,
  WBtn,
  WIcon,
} from '@/components/web';
import { api } from '@/convex/_generated/api';
import type { Id } from '@/convex/_generated/dataModel';
import { useAuth } from '@workos-inc/authkit-nextjs/components';
import { useAuthQuery } from '@/hooks/use-auth-query';
import { useUserPreferences } from '@/components/web/shell/use-user-preferences';
import { VendorBrandBadge } from './vendor-brand-badge';

const FLEET_AVG_PPG = 4.21;
const THIRTY_DAYS_MS = 30 * 24 * 60 * 60 * 1000;

interface VendorRow {
  _id: string;
  _creationTime: number;
  name: string;
  code?: string;
  accountNumber?: string;
  discountProgram?: string;
  contactName?: string;
  contactEmail?: string;
  contactPhone?: string;
  isActive: boolean;
  // Derived 30-day stats (computed client-side from fuelEntries).
  gallons30: number;
  spend30: number;
  txns30: number;
  avgPpg: number;
}

interface SystemView {
  id: string;
  label: string;
  predicate: (v: VendorRow) => boolean;
  tone?: 'neutral' | 'accent' | 'warn' | 'danger';
}

const SYSTEM_VIEWS: SystemView[] = [
  { id: 'all',         label: 'All vendors',  predicate: () => true },
  { id: 'active',      label: 'Active',       predicate: (v) => v.isActive,                                   tone: 'accent' },
  { id: 'contracted',  label: 'Contracted',   predicate: (v) => Boolean(v.discountProgram && v.discountProgram.trim()) },
  { id: 'inactive',    label: 'Inactive',     predicate: (v) => !v.isActive },
];

function vendorStatus(v: VendorRow): { status: ChipStatus; label: string } {
  if (!v.isActive) return { status: 'inactive', label: 'Inactive' };
  if (v.discountProgram && v.discountProgram.trim()) return { status: 'assigned', label: 'Preferred' };
  return { status: 'active', label: 'Active' };
}

interface VendorsListProps {
  workosOrgId: string;
}

export function VendorsList({ workosOrgId }: VendorsListProps) {
  const router = useRouter();
  const { user } = useAuth();
  const { density } = useUserPreferences();
  const [viewId, setViewId] = React.useState('all');
  const [search, setSearch] = React.useState('');
  const [filters, setFilters] = React.useState<FilterChipValue[]>([]);
  const [selected, setSelected] = React.useState<Set<string>>(new Set());
  const [sortKey, setSortKey] = React.useState<string | undefined>('name');
  const [sortDir, setSortDir] = React.useState<'asc' | 'desc'>('asc');
  const [visibleCols, setVisibleCols] = React.useState<Set<string>>(new Set());

  const vendors = useAuthQuery(
    api.fuelVendors.list,
    workosOrgId ? { organizationId: workosOrgId } : 'skip',
  );

  // 30-day fuel-entry rollup — we pull recent entries with paginationOpts
  // so the client-side aggregate stays bounded. 500 rows is plenty for a
  // small/medium fleet's last 30 days; beyond that, the analytics rollup
  // lands as a real Convex query.
  const recentEntries = useAuthQuery(
    api.fuelEntries.list,
    workosOrgId
      ? ({
          organizationId: workosOrgId,
          paginationOpts: { numItems: 500, cursor: null },
        } as never)
      : 'skip',
  );

  const toggleActive = useMutation(api.fuelVendors.toggleActive);

  const statsByVendor = React.useMemo(() => {
    const cutoff = Date.now() - THIRTY_DAYS_MS;
    const m = new Map<string, { gallons: number; spend: number; txns: number; ppgSum: number }>();
    const results = recentEntries
      ? ((recentEntries as { page: Array<Record<string, unknown>> }).page ?? [])
      : [];
    for (const e of results) {
      if (typeof e.entryDate !== 'number' || e.entryDate < cutoff) continue;
      const vid = e.vendorId as string | undefined;
      if (!vid) continue;
      const acc = m.get(vid) ?? { gallons: 0, spend: 0, txns: 0, ppgSum: 0 };
      acc.gallons += (e.gallons as number) ?? 0;
      acc.spend += (e.totalCost as number) ?? 0;
      acc.txns += 1;
      acc.ppgSum += (e.pricePerGallon as number) ?? 0;
      m.set(vid, acc);
    }
    return m;
  }, [recentEntries]);

  const rows: VendorRow[] = React.useMemo(() => {
    if (!vendors) return [];
    return (vendors as Array<Record<string, unknown>>).map((v) => {
      const id = v._id as string;
      const stats = statsByVendor.get(id);
      return {
        _id: id,
        _creationTime: (v._creationTime as number) ?? 0,
        name: (v.name as string) ?? 'Unknown',
        code: v.code as string | undefined,
        accountNumber: v.accountNumber as string | undefined,
        discountProgram: v.discountProgram as string | undefined,
        contactName: v.contactName as string | undefined,
        contactEmail: v.contactEmail as string | undefined,
        contactPhone: v.contactPhone as string | undefined,
        isActive: (v.isActive as boolean) ?? false,
        gallons30: stats?.gallons ?? 0,
        spend30: stats?.spend ?? 0,
        txns30: stats?.txns ?? 0,
        avgPpg: stats && stats.txns > 0 ? stats.ppgSum / stats.txns : 0,
      };
    });
  }, [vendors, statsByVendor]);

  // Filter properties driven by data + static enums.
  const stateOptions = React.useMemo(() => {
    const set = new Set<string>();
    const list = vendors as Array<Record<string, unknown>> | undefined;
    for (const v of list ?? []) {
      if (typeof v.state === 'string' && v.state) set.add(v.state);
    }
    return [...set].sort().map((s) => ({ value: s, label: s }));
  }, [vendors]);

  const properties: FilterProperty[] = React.useMemo(
    () => [
      {
        id: 'status',
        label: 'Status',
        kind: 'enum',
        operator: 'is',
        icon: 'pulse',
        options: [
          { value: 'active',   label: 'Active' },
          { value: 'inactive', label: 'Inactive' },
        ],
      },
      {
        id: 'contract',
        label: 'Contract',
        kind: 'enum',
        operator: 'is',
        icon: 'doc-dollar',
        options: [
          { value: 'contracted', label: 'Negotiated discount' },
          { value: 'retail',     label: 'Retail / no contract' },
        ],
      },
      {
        id: 'state',
        label: 'State',
        kind: 'enum',
        operator: 'is any of',
        icon: 'compass',
        options: stateOptions,
      },
    ],
    [stateOptions],
  );

  const systemView = SYSTEM_VIEWS.find((v) => v.id === viewId) ?? SYSTEM_VIEWS[0];

  const filtered = React.useMemo(() => {
    let out = rows.filter(systemView.predicate);
    for (const chip of filters) {
      const want = new Set(chip.values);
      out = out.filter((r) => {
        switch (chip.propId) {
          case 'status':
            return want.has(r.isActive ? 'active' : 'inactive');
          case 'contract': {
            const contracted = Boolean(r.discountProgram && r.discountProgram.trim());
            return want.has(contracted ? 'contracted' : 'retail');
          }
          case 'state': {
            const s = (r as unknown as { state?: unknown }).state;
            return typeof s === 'string' ? want.has(s) : false;
          }
          default:
            return true;
        }
      });
    }
    if (search.trim()) {
      const q = search.toLowerCase();
      out = out.filter((r) =>
        r.name.toLowerCase().includes(q) ||
        (r.code ?? '').toLowerCase().includes(q) ||
        (r.discountProgram ?? '').toLowerCase().includes(q) ||
        (r.accountNumber ?? '').toLowerCase().includes(q),
      );
    }
    if (sortKey) {
      const dir = sortDir === 'asc' ? 1 : -1;
      out = [...out].sort((a, b) => {
        const av = sortValueOf(a, sortKey);
        const bv = sortValueOf(b, sortKey);
        if (av === bv) return 0;
        return av > bv ? dir : -dir;
      });
    }
    return out;
  }, [rows, systemView, filters, search, sortKey, sortDir]);

  const COLUMNS: TableColumn<VendorRow>[] = React.useMemo(
    () => [
      {
        key: 'name',
        label: 'Vendor',
        width: '1.6fr',
        render: (r) => (
          <span className="flex items-center gap-2.5 min-w-0">
            <VendorBrandBadge name={r.name} code={r.code} size={30} />
            <span className="min-w-0 flex flex-col leading-tight">
              <span className="text-[13px] text-foreground truncate">{r.name}</span>
            </span>
          </span>
        ),
      },
      {
        key: 'program',
        label: 'Discount program',
        width: '1.5fr',
        sortable: false,
        render: (r) => (
          r.discountProgram && r.discountProgram.trim() ? (
            <span className="min-w-0 flex flex-col leading-tight">
              <span className="text-[12.5px] font-medium text-foreground truncate">{r.discountProgram}</span>
              {r.accountNumber && (
                <span className="num text-[11.5px] text-[var(--text-tertiary)] truncate">{r.accountNumber}</span>
              )}
            </span>
          ) : (
            <span className="min-w-0 flex flex-col leading-tight">
              <span className="text-[12.5px] text-[var(--text-secondary)]">Retail</span>
              <span className="text-[11.5px] text-[var(--text-tertiary)]">No fleet contract</span>
            </span>
          )
        ),
      },
      {
        key: 'contact',
        label: 'Contact',
        width: '1.4fr',
        sortable: false,
        render: (r) => (
          <span className="min-w-0 flex flex-col leading-tight">
            {r.contactName && <span className="text-[12.5px] text-foreground truncate">{r.contactName}</span>}
            {r.contactEmail && (
              <span className="text-[11.5px] text-[var(--text-tertiary)] truncate">{r.contactEmail}</span>
            )}
            {!r.contactName && !r.contactEmail && r.contactPhone && (
              <span className="num text-[12.5px] text-foreground truncate">{r.contactPhone}</span>
            )}
            {!r.contactName && !r.contactEmail && !r.contactPhone && (
              <span className="text-[12.5px] text-[var(--text-tertiary)]">—</span>
            )}
          </span>
        ),
      },
      {
        key: 'avgPpg',
        label: 'Avg $/gal',
        width: '110px',
        align: 'right',
        tnum: true,
        render: (r) => (
          r.txns30 > 0 ? (
            <span className="inline-flex flex-col items-end leading-tight">
              <span className="num text-[12.5px] font-medium">${r.avgPpg.toFixed(3)}</span>
              <PriceDelta ppg={r.avgPpg} />
            </span>
          ) : <span className="text-[11.5px] text-[var(--text-tertiary)]">—</span>
        ),
      },
      {
        key: 'gallons30',
        label: 'Gallons · 30d',
        width: '110px',
        align: 'right',
        tnum: true,
        render: (r) => (
          r.txns30 > 0
            ? <span className="num text-[12.5px]">{r.gallons30.toLocaleString(undefined, { maximumFractionDigits: 0 })}</span>
            : <span className="text-[11.5px] text-[var(--text-tertiary)]">—</span>
        ),
      },
      {
        key: 'spend30',
        label: 'Spend · 30d',
        width: '120px',
        align: 'right',
        tnum: true,
        render: (r) => (
          r.txns30 > 0
            ? <span className="num text-[13px] font-semibold">${r.spend30.toLocaleString(undefined, { maximumFractionDigits: 0 })}</span>
            : <span className="text-[11.5px] text-[var(--text-tertiary)]">—</span>
        ),
      },
      {
        key: 'status',
        label: 'Status',
        width: '120px',
        render: (r) => {
          const s = vendorStatus(r);
          return <Chip status={s.status} label={s.label} />;
        },
      },
    ],
    [],
  );

  // Default to all-columns-visible after the column list mounts. Doing this
  // after the COLUMNS memo runs avoids initialising state with an empty Set
  // and then immediately overwriting it on first render.
  React.useEffect(() => {
    if (visibleCols.size === 0) setVisibleCols(new Set(COLUMNS.map((c) => c.key)));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [COLUMNS]);

  const visibleColumns = COLUMNS.filter((c) => visibleCols.size === 0 || visibleCols.has(c.key));

  // Saved-view counts off the unfiltered base, so they don't shift when the
  // user types in the search box.
  const counts = React.useMemo(() => {
    const out: Record<string, number> = {};
    for (const v of SYSTEM_VIEWS) out[v.id] = rows.filter(v.predicate).length;
    return out;
  }, [rows]);

  const tabs: SavedView[] = SYSTEM_VIEWS.map((v) => ({
    id: v.id,
    label: v.label,
    count: counts[v.id],
    tone: v.tone,
  }));

  // Hero stats — totals across the unfiltered base. "Avg $/gal" is the
  // weighted mean over the visible vendors with activity; "Spend · 30d"
  // sums their spend.
  const stats = React.useMemo(() => {
    const active = rows.filter((r) => r.isActive);
    let totalGal = 0;
    let totalSpend = 0;
    let weightedPpgSum = 0;
    for (const r of rows) {
      totalGal += r.gallons30;
      totalSpend += r.spend30;
      weightedPpgSum += r.avgPpg * r.gallons30;
    }
    const avgPpg = totalGal > 0 ? weightedPpgSum / totalGal : 0;
    return [
      { value: rows.length, label: 'vendors' },
      { value: active.length, label: 'active' },
      { value: avgPpg > 0 ? `$${avgPpg.toFixed(3)}` : '—', label: 'avg $/gal' },
      {
        value: totalSpend > 0
          ? `$${Math.round(totalSpend).toLocaleString()}`
          : '—',
        label: 'spend · 30d',
      },
    ];
  }, [rows]);

  const onSort = (key: string) => {
    if (sortKey === key) setSortDir((d) => (d === 'asc' ? 'desc' : 'asc'));
    else {
      setSortKey(key);
      setSortDir('asc');
    }
  };
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
      return new Set(filtered.map((r) => r._id));
    });
  };

  const handleBulkToggleActive = async () => {
    const ids = [...selected];
    if (ids.length === 0 || !user) return;
    try {
      await Promise.all(
        ids.map((id) =>
          toggleActive({
            vendorId: id as Id<'fuelVendors'>,
            updatedBy: user.id,
          }),
        ),
      );
      toast.success(`Toggled status on ${ids.length} vendor${ids.length !== 1 ? 's' : ''}`);
      setSelected(new Set());
    } catch (e) {
      console.error(e);
      toast.error('Failed to toggle vendor status');
    }
  };

  const loading = vendors === undefined;

  return (
    <div className="flex-1 flex flex-col min-h-0 relative">
      <PageHeader
        title="Fuel Vendors"
        stats={stats}
        actions={
          <>
            <WBtn variant="ghost" size="sm" leading="export" onClick={() => console.log('Export not implemented')}>
              Export
            </WBtn>
            <WBtn variant="ghost" size="sm" leading="import" onClick={() => console.log('Import not implemented')}>
              Import
            </WBtn>
            <WBtn
              variant="primary"
              size="sm"
              leading="plus"
              onClick={() => router.push('/operations/diesel/vendors/create')}
            >
              New vendor
            </WBtn>
          </>
        }
      />
      <SavedViews views={tabs} activeId={viewId} onChange={(id) => { setViewId(id); setFilters([]); }} />
      <TableToolbar
        searchPlaceholder="Search vendor, code, program…"
        searchValue={search}
        onSearchChange={setSearch}
        filterTrigger={<FilterBar properties={properties} value={filters} onChange={setFilters} slot="trigger" />}
        columns={COLUMNS.map((c) => ({ key: c.key, label: typeof c.label === 'string' ? c.label : c.key }))}
        visibleColumns={visibleCols}
        onVisibleColumnsChange={setVisibleCols}
      >
        <FilterBar properties={properties} value={filters} onChange={setFilters} slot="chips" />
      </TableToolbar>

      {loading ? (
        <div className="flex-1 flex items-center justify-center">
          <p className="text-[12.5px] text-[var(--text-tertiary)]">Loading vendors…</p>
        </div>
      ) : filtered.length === 0 ? (
        <EmptyState
          hasData={rows.length > 0}
          onCreate={() => router.push('/operations/diesel/vendors/create')}
          onClearFilters={() => {
            setSearch('');
            setFilters([]);
          }}
        />
      ) : (
        <Table<VendorRow>
          columns={visibleColumns}
          rows={filtered}
          density={density}
          selected={[...selected]}
          onSelect={(id) => onToggleSelect(String(id))}
          onSelectAll={onToggleSelectAll}
          sortKey={sortKey}
          sortDir={sortDir}
          onSort={onSort}
          onRowClick={(r) => router.push(`/operations/diesel/vendors/${r._id}`)}
          getRowId={(r) => r._id}
        />
      )}

      <InfiniteFooter loaded={filtered.length} total={rows.length} />

      <BulkBar
        count={selected.size}
        onClear={() => setSelected(new Set())}
        actions={
          <>
            <BulkAction icon="export" label="Export" onClick={() => console.log('Export not implemented')} />
            <BulkAction icon="settings" label="Toggle status" onClick={handleBulkToggleActive} />
          </>
        }
      />
    </div>
  );
}

function PriceDelta({ ppg }: { ppg: number }) {
  const delta = ppg - FLEET_AVG_PPG;
  const cheaper = delta <= 0;
  return (
    <span
      className="num text-[11px] font-medium"
      style={{ color: cheaper ? '#0F8C5F' : '#C33C3C' }}
    >
      {delta > 0 ? '+' : '−'}${Math.abs(delta).toFixed(2)}
    </span>
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
      <span
        className="h-10 w-10 rounded-full inline-flex items-center justify-center text-[var(--text-tertiary)]"
        style={{ background: 'var(--bg-surface-2)' }}
      >
        <WIcon name="fuel" size={18} />
      </span>
      {hasData ? (
        <>
          <p className="m-0 text-[14px] text-foreground font-medium">No vendors match these filters</p>
          <p className="m-0 text-[12.5px] text-[var(--text-tertiary)] max-w-xs">
            Try clearing your search or removing a filter chip.
          </p>
          <WBtn variant="secondary" size="sm" onClick={onClearFilters}>Clear filters</WBtn>
        </>
      ) : (
        <>
          <p className="m-0 text-[14px] text-foreground font-medium">No fuel vendors yet</p>
          <p className="m-0 text-[12.5px] text-[var(--text-tertiary)] max-w-xs">
            Add your first vendor to start tracking purchases, discount programs, and 30-day spend.
          </p>
          <WBtn variant="primary" size="sm" leading="plus" onClick={onCreate}>New vendor</WBtn>
        </>
      )}
    </div>
  );
}

function sortValueOf(v: VendorRow, key: string): string | number {
  switch (key) {
    case 'name':       return v.name.toLowerCase();
    case 'program':    return (v.discountProgram ?? '').toLowerCase();
    case 'contact':    return (v.contactName ?? v.contactEmail ?? '').toLowerCase();
    case 'avgPpg':     return v.avgPpg;
    case 'gallons30':  return v.gallons30;
    case 'spend30':    return v.spend30;
    case 'status':     return v.isActive ? 0 : 1;
    default:           return '';
  }
}

export { FLEET_AVG_PPG };
