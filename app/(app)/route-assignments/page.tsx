'use client';

import * as React from 'react';
import { useMemo, useState } from 'react';
import { useAuth } from '@workos-inc/authkit-nextjs/components';
import { useMutation, useQuery } from 'convex/react';
import { api } from '@/convex/_generated/api';
import { Id } from '@/convex/_generated/dataModel';
import { useOrganizationId } from '@/contexts/organization-context';

import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '@/components/ui/alert-dialog';

import {
  Avatar,
  BulkAction,
  BulkBar,
  Chip,
  type ChipStatus,
  type ColumnDef,
  FilterBar,
  type FilterChipValue,
  type FilterProperty,
  InfiniteFooter,
  PageHeader,
  RecordActionsMenu,
  SavedViews,
  type SavedView,
  Table,
  type TableColumn,
  TableToolbar,
  WBtn,
  WIcon,
} from '@/components/web';

import { AutoAssignModal } from '@/components/route-assignments/auto-assign-modal';
import type { CombinedAssignment } from '@/components/route-assignments/route-assignments-table';

// ─── helpers ────────────────────────────────────────────────────────────

const DAYS_SHORT = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

function formatSchedule(days: number[] | undefined): string {
  if (!days || days.length === 0) return '—';
  if (days.length === 7) return 'Every day';
  return [...days].sort().map((d) => DAYS_SHORT[d]).join(' · ');
}

function formatLastGenerated(timestamp?: number): string {
  if (!timestamp) return 'Never';
  const date = new Date(timestamp);
  const now = new Date();
  const diffMs = now.getTime() - date.getTime();
  const diffDays = Math.floor(diffMs / 86_400_000);
  if (diffDays === 0) return 'Today';
  if (diffDays === 1) return 'Yesterday';
  if (diffDays < 7) return `${diffDays}d ago`;
  return date.toLocaleDateString();
}

/** Returns days remaining until ISO-formatted endDate (YYYY-MM-DD), or null. */
function daysUntil(endDate?: string): number | null {
  if (!endDate) return null;
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  const end = new Date(endDate + 'T00:00:00');
  if (Number.isNaN(end.getTime())) return null;
  return Math.round((end.getTime() - today.getTime()) / 86_400_000);
}

type DerivedStatus = 'active' | 'inactive' | 'expiring' | 'expired';

function deriveStatus(item: CombinedAssignment): DerivedStatus {
  if (item.type === 'internal') {
    const endIso = item.recurringTemplateData?.endDate;
    const dl = daysUntil(endIso);
    if (dl != null) {
      if (dl < 0) return 'expired';
      if (dl <= 7 && item.isActive) return 'expiring';
    }
  }
  return item.isActive ? 'active' : 'inactive';
}

function statusChip(s: DerivedStatus) {
  if (s === 'expiring') return <Chip status="expiring" label="Expiring" />;
  if (s === 'expired') return <Chip status="expired" label="Expired" />;
  if (s === 'active') return <Chip status="active" label="Active" />;
  return <Chip status="inactive" label="Paused" />;
}

// ─── row type ───────────────────────────────────────────────────────────

type Row = CombinedAssignment & {
  derivedStatus: DerivedStatus;
  daysLeft: number | null;
};

// ─── column primitives (inline so they read top-to-bottom) ──────────────

function TriggerSummary({ hcr, tripNumber }: { hcr?: string; tripNumber?: string }) {
  const chips: Array<{ label: string; value: string; mono?: boolean }> = [];
  if (hcr) chips.push({ label: 'HCR', value: hcr, mono: true });
  if (tripNumber) chips.push({ label: 'Trip', value: tripNumber, mono: true });
  if (chips.length === 0) {
    return <span className="text-[12px] text-[var(--text-tertiary)] italic">No trigger</span>;
  }
  return (
    <div className="flex items-center gap-1.5 min-w-0 overflow-hidden">
      {chips.map((c, i) => (
        <span
          key={i}
          className="inline-flex items-center gap-1.5 h-[22px] px-2 rounded-[5px] bg-[var(--bg-surface-2)] border border-[var(--border-hairline)] text-[11.5px] max-w-[160px] overflow-hidden shrink"
        >
          <span className="text-[var(--text-tertiary)] font-medium shrink-0">{c.label}</span>
          <span className={'text-foreground font-medium truncate ' + (c.mono ? 'num' : '')}>
            {c.value}
          </span>
        </span>
      ))}
    </div>
  );
}

function AssigneeCell({
  driverName,
  carrierName,
}: {
  driverName?: string;
  carrierName?: string;
}) {
  if (driverName) {
    return (
      <div className="flex items-center gap-2 min-w-0 overflow-hidden">
        <span className="shrink-0">
          <Avatar name={driverName} size={22} />
        </span>
        <span className="text-[12.5px] font-medium truncate">{driverName}</span>
      </div>
    );
  }
  if (carrierName) {
    return (
      <div className="flex items-center gap-2 min-w-0 overflow-hidden">
        <span
          aria-hidden
          className="inline-flex items-center justify-center rounded-md shrink-0"
          style={{
            width: 22,
            height: 22,
            background: 'var(--bg-surface-2)',
            color: 'var(--text-secondary)',
          }}
        >
          <WIcon name="building" size={12} />
        </span>
        <div className="min-w-0 flex-1">
          <div className="text-[12.5px] font-medium truncate">{carrierName}</div>
          <div className="text-[11px] text-[var(--text-tertiary)] truncate mt-px">Carrier</div>
        </div>
      </div>
    );
  }
  return <span className="text-[12px] text-[var(--text-tertiary)] italic truncate">Unassigned</span>;
}

function ScheduleCell({ row }: { row: Row }) {
  if (row.type === 'external') {
    return <span className="text-[12px] text-[var(--text-tertiary)] truncate">On import</span>;
  }
  return (
    <div className="min-w-0 overflow-hidden">
      <div className="text-[12px] text-foreground truncate">{formatSchedule(row.schedule)}</div>
      <div className="text-[11px] text-[var(--text-tertiary)] mt-px truncate">
        Last: {formatLastGenerated(row.lastGenerated)}
      </div>
    </div>
  );
}

function TypeCell({ type }: { type: 'external' | 'internal' }) {
  const accent = type === 'external' ? '#1A47E6' : '#7C3AED';
  const bg =
    type === 'external'
      ? 'rgba(46,92,255,0.08)'
      : 'rgba(124,58,237,0.08)';
  return (
    <span
      className="inline-flex items-center gap-1.5 h-[22px] px-2 rounded-[5px] text-[11.5px] font-medium"
      style={{ background: bg, color: accent }}
    >
      <WIcon name={type === 'external' ? 'arrow-up-right' : 'refresh'} size={11} />
      {type === 'external' ? 'External' : 'Internal'}
    </span>
  );
}

function NameCell({ row }: { row: Row }) {
  const accent = 'var(--accent)';
  return (
    <div className="flex items-start gap-2.5 min-w-0 overflow-hidden">
      <span
        aria-hidden
        className="inline-flex items-center justify-center rounded-md shrink-0"
        style={{
          width: 24,
          height: 24,
          background: 'var(--bg-sidebar-active)',
          color: accent,
        }}
      >
        <WIcon name="sparkle" size={13} />
      </span>
      <div className="min-w-0 flex-1">
        <div className="text-[13px] font-medium text-foreground truncate">{row.name}</div>
        {(row.hcr || row.tripNumber) && (
          <div className="text-[11.5px] text-[var(--text-tertiary)] truncate mt-px">
            {[row.hcr && `HCR ${row.hcr}`, row.tripNumber && `Trip ${row.tripNumber}`]
              .filter(Boolean)
              .join(' · ')}
          </div>
        )}
      </div>
    </div>
  );
}

// ─── page ───────────────────────────────────────────────────────────────

export default function RouteAssignmentsPage() {
  const { user } = useAuth();
  const organizationId = useOrganizationId();

  const [view, setView] = useState<'all' | DerivedStatus | 'external' | 'internal'>('all');
  const [search, setSearch] = useState('');
  const [chipFilters, setChipFilters] = useState<FilterChipValue[]>([]);
  const [selected, setSelected] = useState<string[]>([]);
  const [visibleCols, setVisibleCols] = useState<Set<string>>(
    new Set(['name', 'trigger', 'assignee', 'schedule', 'type', 'status']),
  );

  // Modals
  const [showCreate, setShowCreate] = useState(false);
  const [editingExternal, setEditingExternal] = useState<
    NonNullable<CombinedAssignment['routeAssignmentData']> | null
  >(null);
  const [deleting, setDeleting] = useState<CombinedAssignment | null>(null);

  // ── data ─────────────────────────────────────────────────────────────
  const routeAssignments = useQuery(
    api.routeAssignments.list,
    organizationId
      ? {
          workosOrgId: organizationId,
          search: search || undefined,
        }
      : 'skip',
  );

  const recurringTemplates = useQuery(
    api.recurringLoads.list,
    organizationId ? { workosOrgId: organizationId } : 'skip',
  );

  // Mutations
  const toggleRouteActive = useMutation(api.routeAssignments.toggleActive);
  const deleteRouteAssignment = useMutation(api.routeAssignments.remove);
  const toggleTemplateActive = useMutation(api.recurringLoads.toggleActive);
  const deleteTemplate = useMutation(api.recurringLoads.remove);

  const isLoading = routeAssignments === undefined || recurringTemplates === undefined;

  // ── combined + derived rows ──────────────────────────────────────────
  const allRows = useMemo<Row[]>(() => {
    const items: CombinedAssignment[] = [];

    if (routeAssignments) {
      routeAssignments.forEach((a) => {
        items.push({
          id: a._id,
          type: 'external',
          name: a.name || `${a.hcr} - ${a.tripNumber || 'All'}`,
          hcr: a.hcr,
          tripNumber: a.tripNumber,
          driverName: a.driverName,
          carrierName: a.carrierName,
          isActive: a.isActive,
          createdAt: a.createdAt,
          routeAssignmentData: a,
        });
      });
    }

    if (recurringTemplates) {
      const sLower = search.toLowerCase();
      recurringTemplates.forEach((t) => {
        if (search) {
          const matches =
            t.name.toLowerCase().includes(sLower) ||
            t.hcr?.toLowerCase().includes(sLower) ||
            t.tripNumber?.toLowerCase().includes(sLower);
          if (!matches) return;
        }
        items.push({
          id: t._id,
          type: 'internal',
          name: t.name,
          hcr: t.hcr,
          tripNumber: t.tripNumber,
          driverName: t.driverName,
          carrierName: t.carrierName,
          isActive: t.isActive,
          createdAt: t._creationTime,
          recurringTemplateData: t,
          schedule: t.activeDays,
          lastGenerated: t.lastGeneratedAt,
        });
      });
    }

    items.sort((a, b) => b.createdAt - a.createdAt);

    return items.map((it) => ({
      ...it,
      derivedStatus: deriveStatus(it),
      daysLeft:
        it.type === 'internal'
          ? daysUntil(it.recurringTemplateData?.endDate)
          : null,
    }));
  }, [routeAssignments, recurringTemplates, search]);

  // ── counts (for SavedViews + stats) ──────────────────────────────────
  const counts = useMemo(() => {
    let active = 0,
      paused = 0,
      expiring = 0,
      expired = 0,
      external = 0,
      internal = 0;
    for (const r of allRows) {
      if (r.derivedStatus === 'active') active++;
      else if (r.derivedStatus === 'inactive') paused++;
      else if (r.derivedStatus === 'expiring') expiring++;
      else if (r.derivedStatus === 'expired') expired++;
      if (r.type === 'external') external++;
      else internal++;
    }
    return { all: allRows.length, active, paused, expiring, expired, external, internal };
  }, [allRows]);

  // ── filtered (view + chips) ──────────────────────────────────────────
  const rows = useMemo(() => {
    let r = allRows;
    if (view !== 'all') {
      if (view === 'external' || view === 'internal') {
        r = r.filter((x) => x.type === view);
      } else {
        r = r.filter((x) => x.derivedStatus === view);
      }
    }
    for (const f of chipFilters) {
      if (!f.values || f.values.length === 0) continue;
      if (f.propId === 'type') {
        r = r.filter((x) => f.values.includes(x.type));
      } else if (f.propId === 'assignee') {
        r = r.filter((x) => {
          if (f.values.includes('driver')) return !!x.driverName;
          if (f.values.includes('carrier')) return !!x.carrierName;
          if (f.values.includes('unassigned')) return !x.driverName && !x.carrierName;
          return true;
        });
      } else if (f.propId === 'status') {
        r = r.filter((x) => f.values.includes(x.derivedStatus));
      }
    }
    return r;
  }, [allRows, view, chipFilters]);

  // ── views ───────────────────────────────────────────────────────────
  const views: SavedView[] = [
    { id: 'all', label: 'All', count: counts.all },
    { id: 'active', label: 'Active', count: counts.active, tone: 'accent' },
    { id: 'expiring', label: 'Expiring', count: counts.expiring, tone: 'warn' },
    { id: 'inactive', label: 'Paused', count: counts.paused },
    { id: 'expired', label: 'Expired', count: counts.expired },
  ];

  // ── filter properties ────────────────────────────────────────────────
  const filterProps: FilterProperty[] = [
    {
      id: 'status',
      label: 'Status',
      icon: 'pulse',
      kind: 'enum',
      operator: 'is any of',
      options: [
        { value: 'active', label: 'Active' },
        { value: 'expiring', label: 'Expiring soon' },
        { value: 'inactive', label: 'Paused' },
        { value: 'expired', label: 'Expired' },
      ],
    },
    {
      id: 'type',
      label: 'Type',
      icon: 'route',
      kind: 'enum',
      operator: 'is any of',
      options: [
        { value: 'external', label: 'External' },
        { value: 'internal', label: 'Internal' },
      ],
    },
    {
      id: 'assignee',
      label: 'Assignee',
      icon: 'users',
      kind: 'enum',
      operator: 'is',
      options: [
        { value: 'driver', label: 'Driver' },
        { value: 'carrier', label: 'Carrier' },
        { value: 'unassigned', label: 'Unassigned' },
      ],
    },
  ];

  // ── columns ─────────────────────────────────────────────────────────
  const columns: TableColumn<Row>[] = [
    // Each column reserves 28px (14px × 2) for the Table's cell padding,
    // so content widths are `width - 28`. The actions column must be wide
    // enough to fit the 32px kebab button (32 + 28 = 60px minimum).
    {
      key: 'name',
      label: 'Rule',
      width: '1fr',
      sortable: false,
      render: (r) => <NameCell row={r} />,
    },
    {
      key: 'trigger',
      label: 'Trigger',
      width: '200px', // 172 content fits 2 chips + gap
      sortable: false,
      render: (r) => <TriggerSummary hcr={r.hcr} tripNumber={r.tripNumber} />,
    },
    {
      key: 'assignee',
      label: 'Assigned to',
      width: '200px', // 172 content fits Avatar 22 + gap + truncated name
      sortable: false,
      render: (r) => <AssigneeCell driverName={r.driverName} carrierName={r.carrierName} />,
    },
    {
      key: 'schedule',
      label: 'Schedule',
      width: '150px', // 122 content fits "Mon · Tue · Wed · Thu · Fri" / truncates internal multi-day
      sortable: false,
      render: (r) => <ScheduleCell row={r} />,
    },
    {
      key: 'type',
      label: 'Type',
      width: '110px', // 82 content fits "↗ External" chip (~85, truncates if needed)
      sortable: false,
      render: (r) => <TypeCell type={r.type} />,
    },
    {
      key: 'status',
      label: 'Status',
      width: '110px', // 82 content fits "● Active" chip (~75)
      sortable: false,
      render: (r) => statusChip(r.derivedStatus),
    },
    {
      key: 'actions',
      label: '',
      width: '64px', // 36 content fits the 32px kebab button — this is the one that caused the scrollbar
      sortable: false,
      render: (r) => (
        <div onClick={(e) => e.stopPropagation()}>
          <RecordActionsMenu
            recordLabel={r.name}
            onAction={async (itemId) => {
              if (itemId === 'edit' && r.routeAssignmentData) {
                setEditingExternal(r.routeAssignmentData);
              } else if (itemId === 'toggle') {
                if (r.type === 'external') {
                  await toggleRouteActive({ id: r.id as Id<'routeAssignments'> });
                } else {
                  await toggleTemplateActive({
                    id: r.id as Id<'recurringLoadTemplates'>,
                  });
                }
              } else if (itemId === 'delete') {
                setDeleting(r);
              }
            }}
            groups={[
              {
                items: [
                  ...(r.type === 'external' && r.routeAssignmentData
                    ? [
                        {
                          id: 'edit',
                          label: 'Edit',
                          icon: 'edit-pen' as const,
                        },
                      ]
                    : []),
                  {
                    id: 'toggle',
                    label: r.isActive ? 'Pause' : 'Activate',
                    icon: r.isActive ? ('eye-off' as const) : ('eye' as const),
                  },
                ],
              },
              {
                items: [
                  {
                    id: 'delete',
                    label: 'Delete',
                    icon: 'trash' as const,
                    danger: true,
                  },
                ],
              },
            ]}
          />
        </div>
      ),
    },
  ];

  // ColumnsButton ColumnDef list (excluding actions which has no label).
  const columnDefs: ColumnDef[] = columns
    .filter((c) => c.label && String(c.label).trim() !== '')
    .map((c) => ({ key: c.key, label: String(c.label) }));

  const visibleColumns = columns.filter(
    (c) => !c.label || String(c.label).trim() === '' || visibleCols.has(c.key),
  );

  // ── bulk actions ─────────────────────────────────────────────────────
  const handleBulkToggle = async (activate: boolean) => {
    const targets = rows.filter((r) => selected.includes(String(r.id)));
    for (const r of targets) {
      if (r.isActive === activate) continue;
      if (r.type === 'external') {
        await toggleRouteActive({ id: r.id as Id<'routeAssignments'> });
      } else {
        await toggleTemplateActive({ id: r.id as Id<'recurringLoadTemplates'> });
      }
    }
    setSelected([]);
  };

  // ── delete confirm ──────────────────────────────────────────────────
  const handleDelete = async () => {
    if (!deleting) return;
    if (deleting.type === 'external') {
      await deleteRouteAssignment({ id: deleting.id as Id<'routeAssignments'> });
    } else {
      await deleteTemplate({ id: deleting.id as Id<'recurringLoadTemplates'> });
    }
    setDeleting(null);
  };

  return (
    <>
      <div className="flex-1 overflow-hidden flex flex-col min-w-0">
        <PageHeader
          title="Auto-assignments"
          stats={[
            { value: counts.active, label: 'active' },
            { value: counts.expiring, label: 'expiring soon' },
            { value: counts.all, label: 'rules total' },
          ]}
          actions={
            <>
              <WBtn size="sm" leading="export">
                Export
              </WBtn>
              <WBtn
                size="sm"
                variant="primary"
                leading="sparkle"
                onClick={() => setShowCreate(true)}
              >
                New rule
              </WBtn>
            </>
          }
        />

        {/* Expiring-soon banner */}
        {counts.expiring > 0 && view !== 'expired' && view !== 'expiring' && (
          <div
            className="shrink-0 flex items-center gap-2.5 px-6 py-2.5 border-b border-[var(--border-hairline)]"
            style={{ background: 'rgba(245,158,11,0.08)' }}
          >
            <span
              aria-hidden
              className="inline-flex items-center justify-center rounded-md shrink-0"
              style={{
                width: 24,
                height: 24,
                background: 'rgba(245,158,11,0.18)',
                color: '#A66800',
              }}
            >
              <WIcon name="clock" size={13} />
            </span>
            <div className="text-[12.5px] text-foreground">
              <strong className="font-semibold">
                {counts.expiring} rule{counts.expiring === 1 ? '' : 's'} expire within 7 days.
              </strong>{' '}
              <span className="text-[var(--text-secondary)]">
                Renew or extend their active window before they stop firing.
              </span>
            </div>
            <div className="flex-1" />
            <button
              type="button"
              onClick={() => setView('expiring')}
              className="focus-ring h-[26px] px-2.5 rounded-md bg-transparent border border-[var(--border-hairline-strong)] text-foreground text-[12px] font-medium cursor-pointer hover:bg-[var(--bg-row-hover)]"
            >
              Review expiring
            </button>
          </div>
        )}

        <SavedViews views={views} activeId={view} onChange={(id) => setView(id as typeof view)} />

        <TableToolbar
          searchPlaceholder="Search rule name, HCR, trip, driver…"
          searchValue={search}
          onSearchChange={setSearch}
          columns={columnDefs}
          visibleColumns={visibleCols}
          onVisibleColumnsChange={setVisibleCols}
          filterTrigger={
            chipFilters.length === 0 ? (
              <FilterBar
                properties={filterProps}
                value={chipFilters}
                onChange={setChipFilters}
                slot="trigger"
              />
            ) : null
          }
        >
          {chipFilters.length > 0 && (
            <>
              <FilterBar
                properties={filterProps}
                value={chipFilters}
                onChange={setChipFilters}
                slot="chips"
              />
              <FilterBar
                properties={filterProps}
                value={chipFilters}
                onChange={setChipFilters}
                slot="trigger"
              />
            </>
          )}
        </TableToolbar>

        <div className="flex-1 min-h-0 min-w-0 flex flex-col relative bg-card overflow-hidden">
          <Table<Row>
            columns={visibleColumns}
            rows={rows}
            density="compact"
            selected={selected}
            onSelect={(id) =>
              setSelected((prev) =>
                prev.includes(String(id))
                  ? prev.filter((x) => x !== String(id))
                  : [...prev, String(id)],
              )
            }
            onSelectAll={() =>
              setSelected((prev) =>
                prev.length === rows.length ? [] : rows.map((r) => String(r.id)),
              )
            }
            onRowClick={(r) => {
              if (r.type === 'external' && r.routeAssignmentData) {
                setEditingExternal(r.routeAssignmentData);
              }
            }}
            getRowId={(r) => String(r.id)}
          />

          {!isLoading && rows.length === 0 && (
            <div className="absolute inset-0 flex flex-col items-center justify-center gap-3 pointer-events-none">
              <span
                aria-hidden
                className="inline-flex items-center justify-center rounded-lg"
                style={{
                  width: 40,
                  height: 40,
                  background: 'var(--bg-surface-2)',
                  color: 'var(--text-tertiary)',
                }}
              >
                <WIcon name="sparkle" size={18} />
              </span>
              <div className="text-center pointer-events-auto">
                <div className="text-[13px] font-medium text-foreground">No rules yet</div>
                <p className="m-0 mt-1 text-[12px] text-[var(--text-tertiary)] max-w-[320px]">
                  Create auto-assignment rules to map incoming HCR + Trip orders to drivers or
                  carriers automatically.
                </p>
                <div className="mt-3">
                  <WBtn
                    size="sm"
                    variant="primary"
                    leading="sparkle"
                    onClick={() => setShowCreate(true)}
                  >
                    New rule
                  </WBtn>
                </div>
              </div>
            </div>
          )}

          {isLoading && (
            <div className="absolute inset-0 flex items-center justify-center text-[12.5px] text-[var(--text-tertiary)]">
              Loading auto-assignments…
            </div>
          )}

          <InfiniteFooter loaded={rows.length} total={rows.length} />

          <BulkBar
            count={selected.length}
            onClear={() => setSelected([])}
            actions={
              <>
                <BulkAction icon="eye" label="Activate" onClick={() => handleBulkToggle(true)} />
                <BulkAction
                  icon="eye-off"
                  label="Pause"
                  onClick={() => handleBulkToggle(false)}
                />
              </>
            }
          />
        </div>
      </div>

      {/* Create / Edit — unified AutoAssignModal (external rules) */}
      {organizationId && user && (
        <AutoAssignModal
          open={showCreate || !!editingExternal}
          onClose={() => {
            setShowCreate(false);
            setEditingExternal(null);
          }}
          organizationId={organizationId}
          userId={user.id}
          rule={editingExternal}
        />
      )}

      {/* Delete confirm */}
      <AlertDialog open={!!deleting} onOpenChange={(o) => !o && setDeleting(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>
              Delete {deleting?.type === 'external' ? 'auto-assignment rule' : 'recurring template'}?
            </AlertDialogTitle>
            <AlertDialogDescription>
              {deleting?.type === 'external'
                ? 'This will permanently delete this rule. Imported loads matching its HCR/Trip will no longer be auto-assigned. This cannot be undone.'
                : 'This will permanently delete this recurring template. No more loads will be generated from its schedule. This cannot be undone.'}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction
              onClick={handleDelete}
              className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
            >
              Delete
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  );
}
