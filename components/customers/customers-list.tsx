/**
 * CustomersList — Otoqa Web chassis applied to customer accounts.
 *
 * Composes PageHeader + SavedViews + TableToolbar + FilterBar + Table +
 * BulkBar. Server-side filtering for status (matches the existing API);
 * the rest of the filter chips run client-side.
 */

'use client';

import * as React from 'react';
import { useMutation } from 'convex/react';
import { useRouter } from 'next/navigation';
import {
  Avatar,
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
import { useAuthQuery } from '@/hooks/use-auth-query';
import { api } from '@/convex/_generated/api';
import type { Id } from '@/convex/_generated/dataModel';
import { useUserPreferences } from '@/components/web/shell/use-user-preferences';
import { useAuth } from '@workos-inc/authkit-nextjs/components';
import { toast } from 'sonner';
import { runChunkedBulk, runChunkedEach } from '@/lib/chunked-bulk';
import { DraftListPill } from '@/components/web/create-form';

interface CustomerRow {
  _id: string;
  name: string;
  city?: string;
  state?: string;
  companyType: string;
  primaryContactName?: string;
  primaryContactEmail?: string;
  primaryContactPhone?: string;
  loadingType?: string;
  status: string;
}

type ServerStatus = 'Active' | 'Inactive' | 'Prospect';
type CompanyType = 'Shipper' | 'Broker' | 'Manufacturer' | 'Distributor';
type LoadingType = 'Live Load' | 'Drop & Hook' | 'Appointment';

interface SystemView {
  id: string;
  label: string;
  serverStatus?: ServerStatus;
  includeDeleted?: boolean;
  tone?: 'neutral' | 'accent' | 'warn' | 'danger';
}

const SYSTEM_VIEWS: SystemView[] = [
  { id: 'all',      label: 'All Customers' },
  { id: 'active',   label: 'Active',   serverStatus: 'Active',   tone: 'accent' },
  { id: 'prospect', label: 'Prospect', serverStatus: 'Prospect', tone: 'warn' },
  { id: 'inactive', label: 'Inactive', serverStatus: 'Inactive' },
  { id: 'deleted',  label: 'Deleted',  includeDeleted: true },
];

function chipStatusFor(status: string): ChipStatus {
  switch (status) {
    case 'Active':   return 'active';
    case 'Prospect': return 'pending';
    case 'Inactive': return 'inactive';
    default:         return 'draft';
  }
}

const COLUMNS: TableColumn<CustomerRow>[] = [
  {
    key: 'name',
    label: 'Customer',
    width: '1.6fr',
    render: (c) => (
      <span className="flex items-center gap-2 min-w-0">
        <Avatar name={c.name} size={26} />
        <span className="min-w-0 flex flex-col leading-tight">
          <span className="text-[13px] text-foreground truncate">{c.name}</span>
          {c.companyType && (
            <span className="text-[11.5px] text-[var(--text-tertiary)] truncate">{c.companyType}</span>
          )}
        </span>
      </span>
    ),
  },
  {
    key: 'location',
    label: 'Location',
    width: '1fr',
    sortable: false,
    render: (c) => (
      <span className="text-[12.5px] text-foreground truncate">
        {c.city && c.state ? `${c.city}, ${c.state}` : c.state ?? c.city ?? '—'}
      </span>
    ),
  },
  {
    key: 'contact',
    label: 'Contact',
    width: '1.5fr',
    sortable: false,
    render: (c) => (
      <span className="min-w-0 flex flex-col leading-tight">
        {c.primaryContactName && (
          <span className="text-[13px] text-foreground truncate">{c.primaryContactName}</span>
        )}
        {c.primaryContactEmail && (
          <span className="text-[11.5px] text-[var(--text-tertiary)] truncate">{c.primaryContactEmail}</span>
        )}
        {!c.primaryContactName && c.primaryContactPhone && (
          <span className="num text-[12.5px] text-foreground truncate">{c.primaryContactPhone}</span>
        )}
      </span>
    ),
  },
  {
    key: 'loadingType',
    label: 'Loading',
    width: '120px',
    sortable: false,
    render: (c) => (
      <span className="text-[12.5px] text-foreground truncate">{c.loadingType ?? '—'}</span>
    ),
  },
  {
    key: 'status',
    label: 'Status',
    width: '120px',
    render: (c) => <Chip status={chipStatusFor(c.status)} label={c.status} />,
  },
];

interface CustomersListProps {
  workosOrgId: string;
  onCreate: () => void;
  onImport: () => void;
  onExport: () => void;
}

export function CustomersList({ workosOrgId, onCreate, onImport, onExport }: CustomersListProps) {
  const router = useRouter();
  const { user } = useAuth();
  const { density } = useUserPreferences();
  const [viewId, setViewId] = React.useState<string>('all');
  const [search, setSearch] = React.useState('');
  const [filters, setFilters] = React.useState<FilterChipValue[]>([]);
  const [selected, setSelected] = React.useState<Set<string>>(new Set());
  const [sortKey, setSortKey] = React.useState<string | undefined>('name');
  const [sortDir, setSortDir] = React.useState<'asc' | 'desc'>('asc');
  const [visibleCols, setVisibleCols] = React.useState<Set<string>>(
    new Set(COLUMNS.map((c) => c.key)),
  );

  const systemView = SYSTEM_VIEWS.find((v) => v.id === viewId) ?? SYSTEM_VIEWS[0];

  const counts = useAuthQuery(api.customers.countCustomersByStatus, {});

  // Derive server-side filters from local filter chips.
  const stateChip = filters.find((f) => f.propId === 'state');
  const companyTypeChip = filters.find((f) => f.propId === 'companyType');
  const loadingTypeChip = filters.find((f) => f.propId === 'loadingType');

  const customers = useAuthQuery(api.customers.list, {
    workosOrgId,
    status: systemView.serverStatus,
    includeDeleted: systemView.includeDeleted,
    searchQuery: search.trim() || undefined,
    companyType: companyTypeChip?.values[0] as CompanyType | undefined,
    state: stateChip?.values[0],
    loadingType: loadingTypeChip?.values[0] as LoadingType | undefined,
  });

  const bulkDeactivate = useMutation(api.customers.bulkDeactivate);
  const permanentDelete = useMutation(api.customers.permanentDelete);

  const rows = React.useMemo<CustomerRow[]>(() => (customers ?? []) as CustomerRow[], [customers]);

  const stateOptions = React.useMemo(() => {
    const set = new Set<string>();
    for (const r of rows) if (r.state) set.add(r.state);
    return [...set].sort().map((v) => ({ value: v, label: v }));
  }, [rows]);

  const properties: FilterProperty[] = React.useMemo(
    () => [
      {
        id: 'companyType',
        label: 'Company type',
        kind: 'enum',
        operator: 'is',
        icon: 'building',
        options: [
          { value: 'Shipper',      label: 'Shipper' },
          { value: 'Broker',       label: 'Broker' },
          { value: 'Manufacturer', label: 'Manufacturer' },
          { value: 'Distributor',  label: 'Distributor' },
        ],
      },
      {
        id: 'state',
        label: 'State',
        kind: 'enum',
        operator: 'is',
        icon: 'compass',
        options: stateOptions,
      },
      {
        id: 'loadingType',
        label: 'Loading type',
        kind: 'enum',
        operator: 'is',
        icon: 'package',
        options: [
          { value: 'Live Load',   label: 'Live Load' },
          { value: 'Drop & Hook', label: 'Drop & Hook' },
          { value: 'Appointment', label: 'Appointment' },
        ],
      },
    ],
    [stateOptions],
  );

  const filtered = React.useMemo(() => {
    if (!sortKey) return rows;
    const dir = sortDir === 'asc' ? 1 : -1;
    return [...rows].sort((a, b) => {
      const av = sortValueOf(a, sortKey);
      const bv = sortValueOf(b, sortKey);
      if (av === bv) return 0;
      return av > bv ? dir : -dir;
    });
  }, [rows, sortKey, sortDir]);

  const visibleColumns = COLUMNS.filter((c) => visibleCols.has(c.key));

  const tabs: SavedView[] = SYSTEM_VIEWS.map((v) => ({
    id: v.id,
    label: v.label,
    count: counts
      ? v.id === 'all'      ? counts.all
      : v.id === 'active'   ? counts.active
      : v.id === 'prospect' ? counts.prospect
      : v.id === 'inactive' ? counts.inactive
      : v.id === 'deleted'  ? counts.deleted
      : undefined
      : undefined,
    tone: v.tone,
  }));

  const stats = counts
    ? [
        { value: counts.all,      label: 'total' },
        { value: counts.active,   label: 'active' },
        { value: counts.prospect, label: 'prospect' },
      ]
    : [];

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

  const onSort = (key: string) => {
    if (sortKey === key) setSortDir((d) => (d === 'asc' ? 'desc' : 'asc'));
    else {
      setSortKey(key);
      setSortDir('asc');
    }
  };

  const isDeletedView = viewId === 'deleted';

  const handleBulkDeactivate = async () => {
    const ids = [...selected];
    if (ids.length === 0 || !user) return;
    const userName =
      user.firstName && user.lastName ? `${user.firstName} ${user.lastName}` : user.email ?? 'User';
    try {
      const result = await runChunkedBulk(
        ids as Id<'customers'>[],
        async (chunk) => {
          await bulkDeactivate({ customerIds: chunk, userId: user.id, userName });
        },
      );
      const done = result.success || ids.length;
      toast.success(`Deactivated ${done} customer${done !== 1 ? 's' : ''}`);
      setSelected(new Set());
    } catch (e) {
      console.error(e);
      toast.error('Failed to deactivate customers.');
    }
  };

  const handlePermanentDelete = async () => {
    const ids = [...selected];
    if (ids.length === 0) return;
    if (!window.confirm(`Permanently delete ${ids.length} customer${ids.length !== 1 ? 's' : ''}? This cannot be undone.`)) return;
    try {
      const result = await runChunkedEach(
        ids,
        (id) => permanentDelete({ id: id as Id<'customers'> }),
      );
      if (result.failed > 0) {
        toast.warning(`Deleted ${result.success} customer${result.success !== 1 ? 's' : ''}. ${result.failed} failed.`);
      } else {
        toast.success(`Permanently deleted ${result.success} customer${result.success !== 1 ? 's' : ''}`);
      }
      setSelected(new Set());
    } catch (e) {
      console.error(e);
      toast.error('Failed to permanently delete customers.');
    }
  };

  const loading = customers === undefined;

  return (
    <div className="flex-1 flex flex-col min-h-0 relative">
      <PageHeader
        title="Customers"
        stats={stats}
        actions={
          <>
            <WBtn variant="ghost" size="sm" leading="export" onClick={onExport}>Export CSV</WBtn>
            <WBtn variant="ghost" size="sm" leading="import" onClick={onImport}>Import CSV</WBtn>
            <WBtn variant="primary" size="sm" leading="plus" onClick={onCreate}>Create Customer</WBtn>
          </>
        }
      />
      <SavedViews
        views={tabs}
        activeId={viewId}
        onChange={setViewId}
        actions={
          <DraftListPill
            entity="customer"
            draftKey="customer-create-v1"
            createHref="/operations/customers/create"
          />
        }
      />
      <TableToolbar
        searchPlaceholder="Search name, city, contact…"
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
          <p className="text-[12.5px] text-[var(--text-tertiary)]">Loading customers…</p>
        </div>
      ) : filtered.length === 0 ? (
        <EmptyState
          hasData={(counts?.all ?? 0) > 0}
          onCreate={onCreate}
          onClearFilters={() => {
            setSearch('');
            setFilters([]);
          }}
        />
      ) : (
        <Table<CustomerRow>
          columns={visibleColumns}
          rows={filtered}
          density={density}
          selected={[...selected]}
          onSelect={(id) => onToggleSelect(String(id))}
          onSelectAll={onToggleSelectAll}
          sortKey={sortKey}
          sortDir={sortDir}
          onSort={onSort}
          onRowClick={(r) => router.push(`/operations/customers/${r._id}`)}
          getRowId={(r) => r._id}
        />
      )}

      <InfiniteFooter loaded={filtered.length} total={counts?.all ?? filtered.length} />

      <BulkBar
        count={selected.size}
        onClear={() => setSelected(new Set())}
        actions={
          <>
            <BulkAction icon="export" label="Export" onClick={onExport} />
            {isDeletedView ? (
              <BulkAction icon="trash" label="Delete forever" danger onClick={handlePermanentDelete} />
            ) : (
              <BulkAction icon="alert" label="Deactivate" danger onClick={handleBulkDeactivate} />
            )}
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
        <WIcon name="users" size={18} />
      </span>
      {hasData ? (
        <>
          <p className="m-0 text-[14px] text-foreground font-medium">No customers match these filters</p>
          <p className="m-0 text-[12.5px] text-[var(--text-tertiary)] max-w-xs">
            Try removing a filter or clearing your search.
          </p>
          <WBtn variant="secondary" size="sm" onClick={onClearFilters}>Clear filters</WBtn>
        </>
      ) : (
        <>
          <p className="m-0 text-[14px] text-foreground font-medium">No customers yet</p>
          <p className="m-0 text-[12.5px] text-[var(--text-tertiary)] max-w-xs">
            Add a customer to begin booking and invoicing loads.
          </p>
          <WBtn variant="primary" size="sm" leading="plus" onClick={onCreate}>Create Customer</WBtn>
        </>
      )}
    </div>
  );
}

function sortValueOf(c: CustomerRow, key: string): string | number {
  switch (key) {
    case 'name':        return c.name.toLowerCase();
    case 'location':    return `${c.state ?? ''} ${c.city ?? ''}`.toLowerCase();
    case 'contact':     return (c.primaryContactName ?? '').toLowerCase();
    case 'loadingType': return (c.loadingType ?? '').toLowerCase();
    case 'status':      return c.status ?? '';
    default:            return '';
  }
}
