/**
 * DieselList — Otoqa Web chassis applied to fuel + DEF entry tracking.
 *
 * The All / Fuel / DEF tabs become saved views. Pagination remains driven
 * by usePaginatedQuery so we still get incremental loading; the FilterBar
 * surfaces driver / carrier / truck / vendor / date-range chips that map
 * back to the existing server-side query args.
 */

'use client';

import * as React from 'react';
import { useRouter } from 'next/navigation';
import { useAuth } from '@workos-inc/authkit-nextjs/components';
import { useConvexAuth, useMutation, usePaginatedQuery } from 'convex/react';
import { format } from 'date-fns';
import { toast } from 'sonner';
import {
  Avatar,
  BulkAction,
  BulkBar,
  Chip,
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
import { useAuthQuery } from '@/hooks/use-auth-query';
import { useOrganizationId } from '@/contexts/organization-context';
import { useUserPreferences } from '@/components/web/shell/use-user-preferences';
import { exportToCSV } from '@/lib/csv-export';

type TabValue = 'all' | 'fuel' | 'def';

interface EnrichedEntry {
  _id: string;
  entryDate: number;
  vendorName: string;
  driverName?: string;
  carrierName?: string;
  truckUnitId?: string;
  gallons: number;
  pricePerGallon: number;
  totalCost: number;
  type: 'fuel' | 'def';
  paymentMethod?: string;
  location?: { city: string; state: string };
}

function fmtCurrency(v: number): string {
  return `$${v.toFixed(2)}`;
}

const COLUMNS: TableColumn<EnrichedEntry>[] = [
  {
    key: 'date',
    label: 'Date',
    width: '110px',
    render: (e) => (
      <span className="num text-[12.5px] text-foreground">
        {format(new Date(e.entryDate), 'MMM d, yyyy')}
      </span>
    ),
  },
  {
    key: 'driver',
    label: 'Driver / Carrier',
    width: '1.4fr',
    sortable: false,
    render: (e) => (
      <span className="flex items-center gap-2 min-w-0">
        {e.driverName ? (
          <Avatar name={e.driverName} size={24} />
        ) : (
          <span
            className="shrink-0 h-6 w-6 rounded-full inline-flex items-center justify-center"
            style={{ background: 'var(--bg-surface-2)', color: 'var(--text-tertiary)' }}
          >
            <WIcon name="building" size={12} />
          </span>
        )}
        <span className="min-w-0 flex flex-col leading-tight">
          {e.driverName && (
            <span className="text-[13px] text-foreground truncate">{e.driverName}</span>
          )}
          {e.carrierName && (
            <span className="text-[11.5px] text-[var(--text-tertiary)] truncate">{e.carrierName}</span>
          )}
          {!e.driverName && !e.carrierName && (
            <span className="text-[12.5px] text-[var(--text-tertiary)]">—</span>
          )}
        </span>
      </span>
    ),
  },
  {
    key: 'truck',
    label: 'Truck',
    width: '100px',
    sortable: false,
    render: (e) => (
      <span className="num text-[12.5px] text-foreground truncate">{e.truckUnitId ?? '—'}</span>
    ),
  },
  {
    key: 'vendor',
    label: 'Vendor',
    width: '1.1fr',
    sortable: false,
    render: (e) => <span className="text-[12.5px] text-foreground truncate">{e.vendorName}</span>,
  },
  {
    key: 'location',
    label: 'Location',
    width: '1fr',
    sortable: false,
    render: (e) => (
      <span className="text-[12.5px] text-foreground truncate">
        {e.location ? `${e.location.city}, ${e.location.state}` : '—'}
      </span>
    ),
  },
  {
    key: 'gallons',
    label: 'Gallons',
    width: '90px',
    align: 'right',
    tnum: true,
    sortable: false,
    render: (e) => (
      <span className="num text-[12.5px] text-foreground">{e.gallons.toFixed(2)}</span>
    ),
  },
  {
    key: 'price',
    label: 'Price / Gal',
    width: '90px',
    align: 'right',
    tnum: true,
    sortable: false,
    render: (e) => (
      <span className="num text-[12.5px] text-foreground">{fmtCurrency(e.pricePerGallon)}</span>
    ),
  },
  {
    key: 'total',
    label: 'Total',
    width: '110px',
    align: 'right',
    tnum: true,
    sortable: false,
    render: (e) => (
      <span className="num text-[13px] font-medium text-foreground">{fmtCurrency(e.totalCost)}</span>
    ),
  },
  {
    key: 'type',
    label: 'Type',
    width: '90px',
    render: (e) => (
      <Chip status={e.type === 'def' ? 'pending' : 'assigned'} label={e.type === 'def' ? 'DEF' : 'Fuel'} />
    ),
  },
  {
    key: 'payment',
    label: 'Payment',
    width: '120px',
    sortable: false,
    render: (e) => (
      <span className="text-[12.5px] text-foreground truncate">{e.paymentMethod ?? '—'}</span>
    ),
  },
];

const SYSTEM_VIEWS: { id: TabValue; label: string }[] = [
  { id: 'all',  label: 'All' },
  { id: 'fuel', label: 'Fuel' },
  { id: 'def',  label: 'DEF' },
];

export function DieselList() {
  const router = useRouter();
  const { user } = useAuth();
  const { isAuthenticated } = useConvexAuth();
  const organizationId = useOrganizationId();
  const { density } = useUserPreferences();
  const [isLoadingMore, startLoadMoreTransition] = React.useTransition();

  const [viewId, setViewId] = React.useState<TabValue>('all');
  const [search, setSearch] = React.useState('');
  const [filters, setFilters] = React.useState<FilterChipValue[]>([]);
  const [selected, setSelected] = React.useState<Set<string>>(new Set());
  const [sortKey, setSortKey] = React.useState<string | undefined>('date');
  const [sortDir, setSortDir] = React.useState<'asc' | 'desc'>('desc');
  const [visibleCols, setVisibleCols] = React.useState<Set<string>>(
    new Set(COLUMNS.map((c) => c.key)),
  );

  // Lookups powering the FilterBar enums.
  const driversData = useAuthQuery(api.drivers.list, organizationId ? { organizationId } : 'skip');
  const trucksData = useAuthQuery(api.trucks.list, organizationId ? { organizationId } : 'skip');
  const vendorsData = useAuthQuery(api.fuelVendors.list, organizationId ? { organizationId } : 'skip');
  const carriersData = useAuthQuery(
    api.carrierPartnerships.listForBroker,
    organizationId ? { brokerOrgId: organizationId } : 'skip',
  );

  // Translate FilterBar chips into the server-side filter args. The list
  // queries already accept driverId / carrierId / truckId / vendorId, so we
  // just plumb the selected ID through.
  const driverChip = filters.find((f) => f.propId === 'driver');
  const carrierChip = filters.find((f) => f.propId === 'carrier');
  const truckChip = filters.find((f) => f.propId === 'truck');
  const vendorChip = filters.find((f) => f.propId === 'vendor');

  const paginatedQueryArgs =
    organizationId && isAuthenticated
      ? ({
          organizationId,
          ...(driverChip?.values[0]  ? { driverId:  driverChip.values[0]  as never } : {}),
          ...(carrierChip?.values[0] ? { carrierId: carrierChip.values[0] as never } : {}),
          ...(truckChip?.values[0]   ? { truckId:   truckChip.values[0]   as never } : {}),
          ...(vendorChip?.values[0]  ? { vendorId:  vendorChip.values[0]  as never } : {}),
          ...(search.trim() ? { search: search.trim() } : {}),
        } as never)
      : 'skip';

  const {
    results: fuelResults,
    status: fuelPaginationStatus,
    loadMore: loadMoreFuel,
  } = usePaginatedQuery(api.fuelEntries.list, paginatedQueryArgs, { initialNumItems: 50 });
  const {
    results: defResults,
    status: defPaginationStatus,
    loadMore: loadMoreDef,
  } = usePaginatedQuery(api.defEntries.list, paginatedQueryArgs, { initialNumItems: 50 });
  const {
    results: allResults,
    status: allPaginationStatus,
    loadMore: loadMoreAll,
  } = usePaginatedQuery(api.fuelEntries.listCombined, paginatedQueryArgs, { initialNumItems: 100 });

  const fuelCount = useAuthQuery(api.fuelEntries.count, organizationId ? paginatedQueryArgs : 'skip');
  const defCount = useAuthQuery(api.defEntries.count, organizationId ? paginatedQueryArgs : 'skip');

  const removeFuelEntry = useMutation(api.fuelEntries.remove);
  const removeDefEntry = useMutation(api.defEntries.remove);

  const drivers = React.useMemo(() => {
    if (!driversData) return [] as { _id: string; firstName: string; lastName: string }[];
    return (driversData as Array<Record<string, unknown>>).map((d) => ({
      _id: d._id as string,
      firstName: d.firstName as string,
      lastName: d.lastName as string,
    }));
  }, [driversData]);

  const trucks = React.useMemo(() => {
    if (!trucksData) return [] as { _id: string; unitId: string }[];
    return (trucksData as Array<Record<string, unknown>>).map((t) => ({
      _id: t._id as string,
      unitId: t.unitId as string,
    }));
  }, [trucksData]);

  const vendors = React.useMemo(() => {
    if (!vendorsData) return [] as { _id: string; name: string }[];
    return (vendorsData as Array<Record<string, unknown>>).map((v) => ({
      _id: v._id as string,
      name: v.name as string,
    }));
  }, [vendorsData]);

  const carriers = React.useMemo(() => {
    if (!carriersData) return [] as { _id: string; name: string }[];
    return (carriersData as Array<Record<string, unknown>>).map((c) => ({
      _id: c._id as string,
      name: (c.carrierName as string) ?? 'Unknown',
    }));
  }, [carriersData]);

  const fuelEntries: EnrichedEntry[] = React.useMemo(() => {
    if (!fuelResults) return [];
    return fuelResults.map((e: Record<string, unknown>) => normalizeEntry(e, 'fuel'));
  }, [fuelResults]);

  const defEntries: EnrichedEntry[] = React.useMemo(() => {
    if (!defResults) return [];
    return defResults.map((e: Record<string, unknown>) => normalizeEntry(e, 'def'));
  }, [defResults]);

  const allEntries: EnrichedEntry[] = React.useMemo(() => {
    if (!allResults) return [];
    return allResults.map((e: Record<string, unknown>) =>
      normalizeEntry(e, (e.type as 'fuel' | 'def') ?? 'fuel'),
    );
  }, [allResults]);

  const displayEntries = React.useMemo(() => {
    if (viewId === 'fuel') return fuelEntries;
    if (viewId === 'def') return defEntries;
    return allEntries;
  }, [viewId, fuelEntries, defEntries, allEntries]);

  const sortedEntries = React.useMemo(() => {
    if (!sortKey) return displayEntries;
    const dir = sortDir === 'asc' ? 1 : -1;
    return [...displayEntries].sort((a, b) => {
      const av = sortValueOf(a, sortKey);
      const bv = sortValueOf(b, sortKey);
      if (av === bv) return 0;
      return av > bv ? dir : -dir;
    });
  }, [displayEntries, sortKey, sortDir]);

  const canLoadMore =
    viewId === 'fuel'
      ? fuelPaginationStatus === 'CanLoadMore'
      : viewId === 'def'
      ? defPaginationStatus === 'CanLoadMore'
      : allPaginationStatus === 'CanLoadMore';

  const handleLoadMore = () => {
    startLoadMoreTransition(() => {
      if (viewId === 'fuel' && fuelPaginationStatus === 'CanLoadMore') loadMoreFuel(50);
      else if (viewId === 'def' && defPaginationStatus === 'CanLoadMore') loadMoreDef(50);
      else if (allPaginationStatus === 'CanLoadMore') loadMoreAll(100);
    });
  };

  const totalFuel = fuelCount ?? fuelEntries.length;
  const totalDef = defCount ?? defEntries.length;
  const totalAll = totalFuel + totalDef;

  const tabs: SavedView[] = [
    { id: 'all',  label: 'All',  count: totalAll },
    { id: 'fuel', label: 'Fuel', count: totalFuel, tone: 'accent' },
    { id: 'def',  label: 'DEF',  count: totalDef,  tone: 'warn' },
  ];

  const stats = [
    { value: totalAll,  label: 'entries' },
    { value: totalFuel, label: 'fuel' },
    { value: totalDef,  label: 'DEF' },
  ];

  const properties: FilterProperty[] = React.useMemo(
    () => [
      {
        id: 'driver',
        label: 'Driver',
        kind: 'enum',
        operator: 'is',
        icon: 'users',
        options: drivers.map((d) => ({ value: d._id, label: `${d.firstName} ${d.lastName}`.trim() })),
      },
      {
        id: 'carrier',
        label: 'Carrier',
        kind: 'enum',
        operator: 'is',
        icon: 'handshake',
        options: carriers.map((c) => ({ value: c._id, label: c.name })),
      },
      {
        id: 'truck',
        label: 'Truck',
        kind: 'enum',
        operator: 'is',
        icon: 'truck',
        options: trucks.map((t) => ({ value: t._id, label: t.unitId })),
      },
      {
        id: 'vendor',
        label: 'Vendor',
        kind: 'enum',
        operator: 'is',
        icon: 'fuel',
        options: vendors.map((v) => ({ value: v._id, label: v.name })),
      },
    ],
    [drivers, carriers, trucks, vendors],
  );

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
      if (s.size === sortedEntries.length) return new Set();
      return new Set(sortedEntries.map((e) => e._id));
    });
  };

  const onSort = (key: string) => {
    if (sortKey === key) setSortDir((d) => (d === 'asc' ? 'desc' : 'asc'));
    else {
      setSortKey(key);
      setSortDir('desc');
    }
  };

  const handleBulkDelete = async () => {
    const ids = [...selected];
    if (ids.length === 0 || !user) return;
    if (!window.confirm(`Delete ${ids.length} entry${ids.length !== 1 ? 'ies' : ''}?`)) return;
    const userId = user.id;
    const entriesToDelete = sortedEntries.filter((e) => selected.has(e._id));
    try {
      await Promise.all(
        entriesToDelete.map((entry) =>
          entry.type === 'fuel'
            ? removeFuelEntry({ entryId: entry._id as never, deletedBy: userId })
            : removeDefEntry({ entryId: entry._id as never, deletedBy: userId }),
        ),
      );
      toast.success(`Deleted ${ids.length} entry${ids.length !== 1 ? 'ies' : ''}`);
      setSelected(new Set());
    } catch (e) {
      console.error(e);
      toast.error('Failed to delete entries.');
    }
  };

  const handleExportCSV = () => {
    if (sortedEntries.length === 0) return;
    exportToCSV(
      sortedEntries,
      [
        { header: 'Date',     accessor: (row) => format(new Date(row.entryDate), 'yyyy-MM-dd') },
        { header: 'Driver',   accessor: (row) => row.driverName ?? '' },
        { header: 'Carrier',  accessor: (row) => row.carrierName ?? '' },
        { header: 'Truck',    accessor: (row) => row.truckUnitId ?? '' },
        { header: 'Vendor',   accessor: (row) => row.vendorName },
        { header: 'Location', accessor: (row) => (row.location ? `${row.location.city}, ${row.location.state}` : '') },
        { header: 'Gallons',  accessor: (row) => row.gallons },
        { header: 'Price/Gal', accessor: (row) => row.pricePerGallon },
        { header: 'Total',    accessor: (row) => row.totalCost },
        { header: 'Type',     accessor: (row) => (row.type === 'def' ? 'DEF' : 'Fuel') },
        { header: 'Payment Method', accessor: (row) => row.paymentMethod ?? '' },
      ],
      `diesel-entries-${format(new Date(), 'yyyy-MM-dd')}`,
    );
  };

  const isInitialLoading = !fuelResults && !defResults && !allResults;

  return (
    <div className="flex-1 flex flex-col min-h-0 relative">
      <PageHeader
        title="Diesel / Fuel"
        stats={stats}
        actions={
          <>
            <WBtn variant="ghost" size="sm" leading="upload" onClick={() => router.push('/operations/diesel/import/ocr')}>Import OCR</WBtn>
            <WBtn variant="ghost" size="sm" leading="import" onClick={() => router.push('/operations/diesel/import')}>Import CSV</WBtn>
            <WBtn variant="ghost" size="sm" leading="export" onClick={handleExportCSV}>Export CSV</WBtn>
            <WBtn variant="secondary" size="sm" leading="droplet" onClick={() => router.push('/operations/diesel/def/create')}>DEF Entry</WBtn>
            <WBtn variant="primary" size="sm" leading="plus" onClick={() => router.push('/operations/diesel/create')}>Fuel Entry</WBtn>
          </>
        }
      />
      <SavedViews
        views={tabs}
        activeId={viewId}
        onChange={(id) => {
          setViewId(id as TabValue);
          setSelected(new Set());
        }}
      />
      <TableToolbar
        searchPlaceholder="Search driver, carrier, vendor, location…"
        searchValue={search}
        onSearchChange={setSearch}
        filterTrigger={<FilterBar properties={properties} value={filters} onChange={setFilters} slot="trigger" />}
        columns={COLUMNS.map((c) => ({ key: c.key, label: typeof c.label === 'string' ? c.label : c.key }))}
        visibleColumns={visibleCols}
        onVisibleColumnsChange={setVisibleCols}
      >
        <FilterBar properties={properties} value={filters} onChange={setFilters} slot="chips" />
      </TableToolbar>

      {isInitialLoading ? (
        <div className="flex-1 flex items-center justify-center">
          <p className="text-[12.5px] text-[var(--text-tertiary)]">Loading entries…</p>
        </div>
      ) : sortedEntries.length === 0 ? (
        <EmptyState
          hasData={totalAll > 0}
          onCreate={() => router.push('/operations/diesel/create')}
          onClearFilters={() => {
            setSearch('');
            setFilters([]);
          }}
        />
      ) : (
        <Table<EnrichedEntry>
          columns={visibleColumns}
          rows={sortedEntries}
          density={density}
          selected={[...selected]}
          onSelect={(id) => onToggleSelect(String(id))}
          onSelectAll={onToggleSelectAll}
          sortKey={sortKey}
          sortDir={sortDir}
          onSort={onSort}
          onRowClick={(r) => router.push(`/operations/diesel/${r._id}?type=${r.type}`)}
          getRowId={(r) => r._id}
          onEndReached={canLoadMore && !isLoadingMore ? handleLoadMore : undefined}
        />
      )}

      <InfiniteFooter
        loaded={sortedEntries.length}
        total={
          viewId === 'fuel' ? totalFuel : viewId === 'def' ? totalDef : totalAll
        }
      />
      {isLoadingMore && (
        <div className="border-t border-[var(--border-hairline)] bg-card px-6 py-2 flex items-center justify-center gap-2 text-[12px] text-[var(--text-tertiary)]">
          <span className="inf-dots"><span /><span /><span /></span>
          Loading more entries…
        </div>
      )}

      <BulkBar
        count={selected.size}
        onClear={() => setSelected(new Set())}
        actions={
          <>
            <BulkAction icon="export" label="Export" onClick={handleExportCSV} />
            <BulkAction icon="trash" label="Delete" danger onClick={handleBulkDelete} />
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
        <WIcon name="fuel" size={18} />
      </span>
      {hasData ? (
        <>
          <p className="m-0 text-[14px] text-foreground font-medium">No entries match these filters</p>
          <p className="m-0 text-[12.5px] text-[var(--text-tertiary)] max-w-xs">
            Try removing a filter or clearing your search.
          </p>
          <WBtn variant="secondary" size="sm" onClick={onClearFilters}>Clear filters</WBtn>
        </>
      ) : (
        <>
          <p className="m-0 text-[14px] text-foreground font-medium">No fuel entries yet</p>
          <p className="m-0 text-[12.5px] text-[var(--text-tertiary)] max-w-xs">
            Log your first fuel or DEF purchase to start tracking spend across the fleet.
          </p>
          <WBtn variant="primary" size="sm" leading="plus" onClick={onCreate}>Create Fuel Entry</WBtn>
        </>
      )}
    </div>
  );
}

function normalizeEntry(e: Record<string, unknown>, type: 'fuel' | 'def'): EnrichedEntry {
  return {
    _id: e._id as string,
    entryDate: e.entryDate as number,
    vendorName: (e.vendorName as string) ?? 'Unknown',
    driverName: e.driverName as string | undefined,
    carrierName: e.carrierName as string | undefined,
    truckUnitId: e.truckUnitId as string | undefined,
    gallons: e.gallons as number,
    pricePerGallon: e.pricePerGallon as number,
    totalCost: e.totalCost as number,
    type,
    paymentMethod: e.paymentMethod as string | undefined,
    location: e.location as { city: string; state: string } | undefined,
  };
}

function sortValueOf(e: EnrichedEntry, key: string): string | number {
  switch (key) {
    case 'date':    return e.entryDate;
    case 'driver':  return (e.driverName ?? e.carrierName ?? '').toLowerCase();
    case 'truck':   return (e.truckUnitId ?? '').toLowerCase();
    case 'vendor':  return e.vendorName.toLowerCase();
    case 'location': return e.location ? `${e.location.state} ${e.location.city}`.toLowerCase() : '';
    case 'gallons': return e.gallons;
    case 'price':   return e.pricePerGallon;
    case 'total':   return e.totalCost;
    case 'type':    return e.type;
    case 'payment': return (e.paymentMethod ?? '').toLowerCase();
    default:        return '';
  }
}
