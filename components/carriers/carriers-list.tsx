/**
 * CarriersList — Otoqa Web chassis applied to carrier partnerships.
 *
 * Composes PageHeader + SavedViews + TableToolbar + FilterBar + Table +
 * BulkBar. Mirrors the structure of components/web/drivers/drivers-list.tsx
 * so look + behavior stays consistent across operations.
 *
 * Data is fetched here (counts + listForBroker) and bulk mutations resolve
 * through carrierPartnerships.bulk*. The legacy CarrierList component is
 * still around for any pages that haven't been migrated.
 */

'use client';

import * as React from 'react';
import { useQuery, useMutation } from 'convex/react';
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
import { api } from '@/convex/_generated/api';
import type { Id } from '@/convex/_generated/dataModel';
import { toast } from 'sonner';
import { runChunkedBulk } from '@/lib/chunked-bulk';
import { useUserPreferences } from '@/components/web/shell/use-user-preferences';
import { DraftListPill } from '@/components/web/create-form';

type PartnershipStatus = 'ACTIVE' | 'PENDING' | 'INVITED' | 'SUSPENDED' | 'TERMINATED';

interface CarrierRow {
  _id: string;
  carrierName?: string;
  companyName?: string;
  carrierDba?: string;
  dba?: string;
  contactFirstName?: string;
  contactLastName?: string;
  primaryContactName?: string;
  contactEmail?: string;
  email?: string;
  contactPhone?: string;
  phoneNumber?: string;
  mcNumber?: string;
  usdotNumber?: string;
  insuranceProvider?: string;
  insuranceExpiration?: string | number;
  safetyRating?: string;
  status: string;
  isOwnerOperator?: boolean;
  carrierOrgId?: string;
  carrierOrg?: {
    _id: string;
    name: string;
    orgType?: string;
    isOwnerOperator?: boolean;
  } | null;
}

interface SystemView {
  id: string;
  label: string;
  /** API status filter — `undefined` for "all". */
  apiStatus?: PartnershipStatus;
  tone?: 'neutral' | 'accent' | 'warn' | 'danger';
}

const SYSTEM_VIEWS: SystemView[] = [
  { id: 'all',        label: 'All Partners' },
  { id: 'active',     label: 'Active',      apiStatus: 'ACTIVE',     tone: 'accent' },
  { id: 'invited',    label: 'Invited',     apiStatus: 'INVITED' },
  { id: 'pending',    label: 'Pending',     apiStatus: 'PENDING',    tone: 'warn' },
  { id: 'suspended',  label: 'Suspended',   apiStatus: 'SUSPENDED',  tone: 'danger' },
  { id: 'terminated', label: 'Terminated',  apiStatus: 'TERMINATED' },
];

function carrierDisplayName(c: CarrierRow): string {
  return c.carrierName ?? c.companyName ?? 'Unknown';
}

function carrierDba(c: CarrierRow): string | undefined {
  return c.carrierDba ?? c.dba;
}

function carrierContactName(c: CarrierRow): string | undefined {
  const full = `${c.contactFirstName ?? ''} ${c.contactLastName ?? ''}`.trim();
  return full || c.primaryContactName;
}

function carrierContactEmail(c: CarrierRow): string | undefined {
  return c.contactEmail ?? c.email;
}

function carrierContactPhone(c: CarrierRow): string | undefined {
  return c.contactPhone ?? c.phoneNumber;
}

function chipStatusFor(status: string): ChipStatus {
  switch (status.toUpperCase()) {
    case 'ACTIVE':     return 'active';
    case 'INVITED':    return 'pending';
    case 'PENDING':    return 'pending';
    case 'SUSPENDED':  return 'danger';
    case 'TERMINATED': return 'cancelled';
    case 'INACTIVE':   return 'inactive';
    case 'VETTING':    return 'draft';
    default:           return 'draft';
  }
}

function insuranceChipStatus(expiration?: string | number): ChipStatus {
  if (expiration === undefined || expiration === null || expiration === '') return 'na';
  let ms: number;
  if (typeof expiration === 'string') {
    const m = expiration.match(/^(\d{4})-(\d{2})-(\d{2})/);
    if (m) ms = Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
    else   ms = new Date(expiration).getTime();
  } else {
    ms = expiration;
  }
  if (!Number.isFinite(ms)) return 'na';
  const now = new Date();
  const today = Date.UTC(now.getFullYear(), now.getMonth(), now.getDate());
  const days = Math.ceil((ms - today) / 86_400_000);
  if (days < 0)  return 'expired';
  if (days <= 30) return 'expiring';
  return 'valid';
}

function fmtInsuranceDate(expiration?: string | number): string {
  if (!expiration) return '—';
  if (typeof expiration === 'string') {
    const m = expiration.match(/^(\d{4})-(\d{2})-(\d{2})/);
    if (m) return `${m[2]}/${m[3]}/${m[1]}`;
  }
  const d = new Date(expiration);
  if (Number.isNaN(d.getTime())) return '—';
  const mm = String(d.getMonth() + 1).padStart(2, '0');
  const dd = String(d.getDate()).padStart(2, '0');
  return `${mm}/${dd}/${d.getFullYear()}`;
}

const COLUMNS: TableColumn<CarrierRow>[] = [
  {
    key: 'name',
    label: 'Carrier',
    width: '1.6fr',
    render: (c) => {
      const name = carrierDisplayName(c);
      const dba = carrierDba(c);
      const isLinked = !!c.carrierOrgId;
      const isOO = c.isOwnerOperator ?? c.carrierOrg?.isOwnerOperator;
      return (
        <span className="flex items-center gap-2 min-w-0">
          <Avatar name={name} size={26} />
          <span className="min-w-0 flex flex-col leading-tight">
            <span className="text-[13px] text-foreground truncate flex items-center gap-1.5">
              {name}
              {isLinked && <WIcon name="badge-check" size={12} className="text-[var(--accent)] shrink-0" />}
              {isOO && (
                <span
                  className="text-[10px] px-1 py-0 rounded border shrink-0"
                  style={{
                    color: 'var(--bar-open-fg)',
                    background: 'var(--bar-open-bg)',
                    borderColor: 'var(--bar-open-bd)',
                  }}
                >
                  Owner-Op
                </span>
              )}
            </span>
            {dba && <span className="text-[11.5px] text-[var(--text-tertiary)] truncate">DBA: {dba}</span>}
          </span>
        </span>
      );
    },
  },
  {
    key: 'contact',
    label: 'Contact',
    width: '1.4fr',
    sortable: false,
    render: (c) => (
      <span className="min-w-0 flex flex-col leading-tight">
        {carrierContactName(c) && (
          <span className="text-[13px] text-foreground truncate">{carrierContactName(c)}</span>
        )}
        {carrierContactEmail(c) && (
          <span className="text-[11.5px] text-[var(--text-tertiary)] truncate">{carrierContactEmail(c)}</span>
        )}
        {!carrierContactName(c) && carrierContactPhone(c) && (
          <span className="num text-[12.5px] text-foreground truncate">{carrierContactPhone(c)}</span>
        )}
      </span>
    ),
  },
  {
    key: 'mc',
    label: 'MC# / DOT#',
    width: '1fr',
    sortable: false,
    render: (c) => (
      <span className="min-w-0 flex flex-col leading-tight">
        {c.mcNumber && <span className="num text-[12.5px] text-foreground truncate">MC# {c.mcNumber}</span>}
        {c.usdotNumber && <span className="num text-[11.5px] text-[var(--text-tertiary)] truncate">DOT# {c.usdotNumber}</span>}
        {!c.mcNumber && !c.usdotNumber && <span className="text-[12.5px] text-[var(--text-tertiary)]">—</span>}
      </span>
    ),
  },
  {
    key: 'insurance',
    label: 'Insurance',
    width: '1.3fr',
    sortable: false,
    render: (c) => (
      <span className="min-w-0 flex flex-col leading-tight">
        {c.insuranceProvider && (
          <span className="text-[12.5px] text-foreground truncate">{c.insuranceProvider}</span>
        )}
        <span className="flex items-center gap-1.5">
          <span className="num text-[11.5px] text-[var(--text-tertiary)]">
            {fmtInsuranceDate(c.insuranceExpiration)}
          </span>
          <Chip status={insuranceChipStatus(c.insuranceExpiration)} dotOnly />
        </span>
      </span>
    ),
  },
  {
    key: 'status',
    label: 'Status',
    width: '120px',
    render: (c) => <Chip status={chipStatusFor(c.status)} label={c.status} />,
  },
];

interface CarriersListProps {
  workosOrgId: string;
  onCreate: () => void;
  onImport: () => void;
  onExport: () => void;
}

export function CarriersList({ workosOrgId, onCreate, onImport, onExport }: CarriersListProps) {
  const router = useRouter();
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

  const counts = useQuery(api.carrierPartnerships.countPartnershipsByStatus, { brokerOrgId: workosOrgId });
  const partnerships = useQuery(api.carrierPartnerships.listForBroker, {
    brokerOrgId: workosOrgId,
    status: systemView.apiStatus,
  });

  const bulkTerminate = useMutation(api.carrierPartnerships.bulkTerminate);
  const bulkReactivate = useMutation(api.carrierPartnerships.bulkReactivate);
  const permanentlyDelete = useMutation(api.carrierPartnerships.permanentlyDelete);

  const rows = React.useMemo<CarrierRow[]>(() => (partnerships ?? []) as CarrierRow[], [partnerships]);

  const stateOptions = React.useMemo(() => {
    const set = new Set<string>();
    for (const r of rows) {
      const s = (r as unknown as { state?: unknown }).state;
      if (typeof s === 'string' && s) set.add(s);
    }
    return [...set].sort().map((v) => ({ value: v, label: v }));
  }, [rows]);

  const properties: FilterProperty[] = React.useMemo(
    () => [
      {
        id: 'safety',
        label: 'Safety rating',
        kind: 'enum',
        icon: 'shield',
        options: [
          { value: 'Satisfactory',     label: 'Satisfactory' },
          { value: 'Conditional',      label: 'Conditional' },
          { value: 'Unsatisfactory',   label: 'Unsatisfactory' },
          { value: 'Unrated',          label: 'Unrated' },
        ],
      },
      {
        id: 'insurance',
        label: 'Insurance',
        kind: 'enum',
        icon: 'badge-check',
        options: [
          { value: 'valid',    label: 'Valid' },
          { value: 'expiring', label: 'Expiring' },
          { value: 'expired',  label: 'Expired' },
        ],
      },
      {
        id: 'state',
        label: 'State',
        kind: 'enum',
        icon: 'compass',
        options: stateOptions,
      },
      {
        id: 'type',
        label: 'Type',
        kind: 'enum',
        icon: 'handshake',
        options: [
          { value: 'owner-op',  label: 'Owner-operator' },
          { value: 'fleet',     label: 'Fleet' },
        ],
      },
    ],
    [stateOptions],
  );

  const filtered = React.useMemo(() => {
    let out = rows;
    for (const chip of filters) {
      const want = new Set(chip.values);
      out = out.filter((r) => {
        switch (chip.propId) {
          case 'safety':
            return r.safetyRating ? want.has(r.safetyRating) : false;
          case 'insurance':
            return want.has(insuranceChipStatus(r.insuranceExpiration));
          case 'state': {
            const s = (r as unknown as { state?: unknown }).state;
            return typeof s === 'string' ? want.has(s) : false;
          }
          case 'type': {
            const isOO = r.isOwnerOperator ?? r.carrierOrg?.isOwnerOperator;
            const tag = isOO ? 'owner-op' : 'fleet';
            return want.has(tag);
          }
          default:
            return true;
        }
      });
    }
    if (search.trim()) {
      const q = search.toLowerCase();
      out = out.filter((r) =>
        carrierDisplayName(r).toLowerCase().includes(q) ||
        (carrierDba(r) ?? '').toLowerCase().includes(q) ||
        (carrierContactName(r) ?? '').toLowerCase().includes(q) ||
        (carrierContactEmail(r) ?? '').toLowerCase().includes(q) ||
        (carrierContactPhone(r) ?? '').toLowerCase().includes(q) ||
        (r.mcNumber ?? '').toLowerCase().includes(q) ||
        (r.usdotNumber ?? '').toLowerCase().includes(q),
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
  }, [rows, filters, search, sortKey, sortDir]);

  const visibleColumns = COLUMNS.filter((c) => visibleCols.has(c.key));

  const tabs: SavedView[] = SYSTEM_VIEWS.map((v) => ({
    id: v.id,
    label: v.label,
    count: counts
      ? v.id === 'all'
        ? counts.total
        : v.apiStatus === 'ACTIVE'     ? counts.active
        : v.apiStatus === 'PENDING'    ? counts.pending
        : v.apiStatus === 'INVITED'    ? counts.invited
        : v.apiStatus === 'SUSPENDED'  ? counts.suspended
        : v.apiStatus === 'TERMINATED' ? counts.terminated
        : undefined
      : undefined,
    tone: v.tone,
  }));

  const stats = counts
    ? [
        { value: counts.total,     label: 'total' },
        { value: counts.active,    label: 'active' },
        { value: counts.pending,   label: 'pending' },
        { value: counts.suspended, label: 'suspended' },
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

  const isTerminatedView = viewId === 'terminated';

  const handleBulkTerminate = async () => {
    const ids = [...selected];
    if (ids.length === 0) return;
    try {
      // Terminate cascades across the linked carrier org (assignments, drivers,
      // identity links), so keep chunks small to stay under the ~1s budget.
      const result = await runChunkedBulk(
        ids as Id<'carrierPartnerships'>[],
        async (chunk) => {
          const r = await bulkTerminate({ partnershipIds: chunk, userId: 'system', userName: 'System' });
          return { success: r.succeeded, failed: r.failed };
        },
        { chunkSize: 10 },
      );
      if (result.failed > 0) {
        toast.error(`Terminated ${result.success}, ${result.failed} failed`);
      } else {
        toast.success(`Terminated ${result.success} partnership${result.success !== 1 ? 's' : ''}`);
      }
      setSelected(new Set());
    } catch (e) {
      console.error(e);
      toast.error('Failed to terminate partnerships.');
    }
  };

  const handleBulkReactivate = async () => {
    const ids = [...selected];
    if (ids.length === 0) return;
    try {
      const result = await runChunkedBulk(
        ids as Id<'carrierPartnerships'>[],
        async (chunk) => {
          const r = await bulkReactivate({ partnershipIds: chunk, userId: 'system', userName: 'System' });
          return { success: r.succeeded, failed: r.failed };
        },
        { chunkSize: 10 },
      );
      if (result.failed > 0) {
        toast.error(`Reactivated ${result.success}, ${result.failed} failed`);
      } else {
        toast.success(`Reactivated ${result.success} partnership${result.success !== 1 ? 's' : ''}`);
      }
      setSelected(new Set());
    } catch (e) {
      console.error(e);
      toast.error('Failed to reactivate partnerships.');
    }
  };

  const handlePermanentDelete = async () => {
    const ids = [...selected];
    if (ids.length === 0) return;
    if (!window.confirm(`Permanently delete ${ids.length} partnership${ids.length !== 1 ? 's' : ''}? This cannot be undone.`)) return;
    try {
      // The most expensive path — deletes drivers, identity links, assignments
      // and the org itself per partnership. Small chunks.
      const result = await runChunkedBulk(
        ids as Id<'carrierPartnerships'>[],
        async (chunk) => {
          const r = await permanentlyDelete({ partnershipIds: chunk, userId: 'system', userName: 'System' });
          return { success: r.succeeded, failed: r.failed };
        },
        { chunkSize: 8 },
      );
      if (result.failed > 0) {
        toast.error(`Deleted ${result.success}, ${result.failed} failed`);
      } else {
        toast.success(`Permanently deleted ${result.success} partnership${result.success !== 1 ? 's' : ''}`);
      }
      setSelected(new Set());
    } catch (e) {
      console.error(e);
      toast.error('Failed to permanently delete partnerships.');
    }
  };

  const loading = partnerships === undefined;

  return (
    <div className="flex-1 flex flex-col min-h-0 relative">
      <PageHeader
        title="Carriers"
        stats={stats}
        actions={
          <>
            <WBtn variant="ghost" size="sm" leading="export" onClick={onExport}>Export CSV</WBtn>
            <WBtn variant="ghost" size="sm" leading="import" onClick={onImport}>Import CSV</WBtn>
            <WBtn variant="primary" size="sm" leading="plus" onClick={onCreate}>Create Carrier</WBtn>
          </>
        }
      />
      <SavedViews
        views={tabs}
        activeId={viewId}
        onChange={setViewId}
        actions={
          <DraftListPill
            entity="carrier"
            draftKey="carrier-create-v1"
            createHref="/operations/carriers/create"
          />
        }
      />
      <TableToolbar
        searchPlaceholder="Search name, MC#, DOT#, contact…"
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
          <p className="text-[12.5px] text-[var(--text-tertiary)]">Loading carriers…</p>
        </div>
      ) : filtered.length === 0 ? (
        <EmptyState
          hasData={rows.length > 0}
          onCreate={onCreate}
          onClearFilters={() => {
            setSearch('');
            setFilters([]);
          }}
        />
      ) : (
        <Table<CarrierRow>
          columns={visibleColumns}
          rows={filtered}
          density={density}
          selected={[...selected]}
          onSelect={(id) => onToggleSelect(String(id))}
          onSelectAll={onToggleSelectAll}
          sortKey={sortKey}
          sortDir={sortDir}
          onSort={onSort}
          onRowClick={(r) => router.push(`/operations/carriers/${r._id}`)}
          getRowId={(r) => r._id}
        />
      )}

      <InfiniteFooter loaded={filtered.length} total={counts?.total ?? filtered.length} />

      <BulkBar
        count={selected.size}
        onClear={() => setSelected(new Set())}
        actions={
          <>
            <BulkAction icon="export" label="Export" onClick={onExport} />
            {isTerminatedView ? (
              <>
                <BulkAction icon="restore" label="Reactivate" onClick={handleBulkReactivate} />
                <BulkAction icon="trash" label="Delete forever" danger onClick={handlePermanentDelete} />
              </>
            ) : (
              <BulkAction icon="alert" label="Terminate" danger onClick={handleBulkTerminate} />
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
        <WIcon name="handshake" size={18} />
      </span>
      {hasData ? (
        <>
          <p className="m-0 text-[14px] text-foreground font-medium">No carriers match these filters</p>
          <p className="m-0 text-[12.5px] text-[var(--text-tertiary)] max-w-xs">
            Try removing a filter or clearing your search.
          </p>
          <WBtn variant="secondary" size="sm" onClick={onClearFilters}>Clear filters</WBtn>
        </>
      ) : (
        <>
          <p className="m-0 text-[14px] text-foreground font-medium">No carriers yet</p>
          <p className="m-0 text-[12.5px] text-[var(--text-tertiary)] max-w-xs">
            Add a carrier partner to start dispatching loads to their drivers.
          </p>
          <WBtn variant="primary" size="sm" leading="plus" onClick={onCreate}>Create Carrier</WBtn>
        </>
      )}
    </div>
  );
}

function sortValueOf(c: CarrierRow, key: string): string | number {
  switch (key) {
    case 'name':    return carrierDisplayName(c).toLowerCase();
    case 'contact': return (carrierContactName(c) ?? '').toLowerCase();
    case 'mc':      return (c.mcNumber ?? '').toLowerCase();
    case 'insurance':
      return typeof c.insuranceExpiration === 'number'
        ? c.insuranceExpiration
        : c.insuranceExpiration ?? '';
    case 'status':  return c.status ?? '';
    default:        return '';
  }
}
