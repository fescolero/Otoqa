'use client';

import { useState, useMemo, useEffect } from 'react';
import { useMutation, useQuery, usePaginatedQuery } from 'convex/react';
import { api } from '@/convex/_generated/api';
import { useAuthQuery } from '@/hooks/use-auth-query';
import { useRouter } from 'next/navigation';
import { Id } from '@/convex/_generated/dataModel';
import { trackError } from '@/lib/posthog';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { SavedViews, type SavedView, WBtn } from '@/components/web';
import { DraftListPill } from '@/components/web/create-form';
import { LoadFilterState } from './loads/load-filter-bar';
import type { ColumnVisibility } from './loads/column-visibility';
import { DEFAULT_COLUMN_VISIBILITY } from './loads/column-visibility';
import { BulkActionResolutionModal } from './loads/bulk-action-resolution-modal';
import { CancellationReasonModal, CancellationReasonCode } from './loads/cancellation-reason-modal';
import { toast } from 'sonner';
import { formatDateOnly } from '@/lib/format-date-timezone';
import { useDebounce } from '@/hooks/use-debounce';
import {
  BulkAction,
  BulkBar,
  Chip,
  type ChipStatus,
  type ColumnDef,
  FilterBar,
  type FilterChipValue,
  type FilterProperty,
  formatDateRangeValue,
  InfiniteFooter,
  parseDateRangeValue,
  Table,
  type TableColumn,
  TableToolbar,
  WIcon,
} from '@/components/web';
import Link from 'next/link';

interface LoadsTableProps {
  organizationId: string;
  userId: string;
}

export function LoadsTable({ organizationId, userId }: LoadsTableProps) {
  const [activeTab, setActiveTab] = useState<string>('all');
  const [selectedLoadIds, setSelectedLoadIds] = useState<Set<Id<'loadInformation'>>>(new Set());
  const [filters, setFilters] = useState<LoadFilterState>({
    search: '',
  });
  const [columnVisibility, setColumnVisibility] = useState<ColumnVisibility>(DEFAULT_COLUMN_VISIBILITY);

  // Bulk action modal state
  const [showResolutionModal, setShowResolutionModal] = useState(false);
  const [showCancellationModal, setShowCancellationModal] = useState(false);
  const [pendingTargetStatus, setPendingTargetStatus] = useState<
    'Open' | 'Assigned' | 'Delivered' | 'Canceled' | 'Expired' | null
  >(null);
  const [validationResult, setValidationResult] = useState<any>(null);
  const [isValidating, setIsValidating] = useState(false);
  const [cancellationLoads, setCancellationLoads] = useState<{ id: string; orderNumber?: string }[]>([]);

  const loadCounts = useAuthQuery(api.loads.countLoadsByStatus, {
    workosOrgId: organizationId,
  });

  // Determine status filter from tab (map UI 'Delivered' back to DB 'Completed')
  const statusFilter = activeTab === 'all' ? undefined : activeTab === 'Delivered' ? 'Completed' : activeTab;

  // ✅ Debounce search input to prevent excessive queries (300ms delay)
  const debouncedSearch = useDebounce(filters.search, 300);

  // Force query refresh by temporarily skipping query
  const [skipQuery, setSkipQuery] = useState(false);

  // Helper to convert timestamp to YYYY-MM-DD string for Convex query.
  // Uses local date components (not UTC) so the calendar date the user
  // selected in the date picker is preserved regardless of timezone.
  const formatDateForQuery = (timestamp: number | undefined): string | undefined => {
    if (!timestamp) return undefined;
    const date = new Date(timestamp);
    const year = date.getFullYear();
    const month = String(date.getMonth() + 1).padStart(2, '0');
    const day = String(date.getDate()).padStart(2, '0');
    return `${year}-${month}-${day}`;
  };

  // Fetch loads with infinite scroll via usePaginatedQuery.
  // The hook manages cursor state internally and resets when args change.
  const {
    results,
    status: paginationStatus,
    loadMore,
  } = usePaginatedQuery(
    api.loads.getLoads,
    skipQuery
      ? 'skip'
      : {
          workosOrgId: organizationId,
          status: statusFilter as any,
          hcr: filters.hcr,
          tripNumber: filters.trip,
          search: debouncedSearch || undefined,
          mileRange: filters.mileRange,
          trackingStatus: filters.trackingStatus,
          startDate: formatDateForQuery(filters.dateRange?.start),
          endDate: formatDateForQuery(filters.dateRange?.end),
        },
    { initialNumItems: 50 },
  );

  // Mutations
  const bulkUpdateLoadStatus = useMutation(api.loads.bulkUpdateLoadStatus);
  const deleteLoad = useMutation(api.loads.deleteLoad);

  // Validation query (manual fetch for on-demand validation)
  const validateBulkChange = useQuery(
    api.loads.validateBulkStatusChange,
    isValidating && pendingTargetStatus
      ? {
          loadIds: Array.from(selectedLoadIds),
          targetStatus: pendingTargetStatus === 'Delivered' ? 'Completed' : pendingTargetStatus,
        }
      : 'skip',
  );

  const currentLoads = results ?? [];

  // Extract unique HCRs and Trips from current loads
  const availableHCRs = useMemo(() => {
    const hcrs = new Set<string>();
    currentLoads.forEach((load) => {
      if (load.parsedHcr) hcrs.add(load.parsedHcr);
    });
    return Array.from(hcrs).sort();
  }, [currentLoads]);

  const availableTrips = useMemo(() => {
    const trips = new Set<string>();
    currentLoads.forEach((load) => {
      if (load.parsedTripNumber) trips.add(load.parsedTripNumber);
    });
    return Array.from(trips).sort();
  }, [currentLoads]);

  // Clear selection when changing tabs
  const handleTabChange = (value: string) => {
    setActiveTab(value);
    setSelectedLoadIds(new Set());
  };

  // Selection handlers
  const handleSelectAll = (checked: boolean) => {
    if (checked) {
      setSelectedLoadIds(new Set(currentLoads.map((load) => load._id)));
    } else {
      setSelectedLoadIds(new Set());
    }
  };

  const handleSelectRow = (loadId: Id<'loadInformation'>, checked: boolean) => {
    const newSelected = new Set(selectedLoadIds);
    if (checked) {
      newSelected.add(loadId);
    } else {
      newSelected.delete(loadId);
    }
    setSelectedLoadIds(newSelected);
  };

  const isAllSelected = currentLoads.length > 0 && selectedLoadIds.size === currentLoads.length;

  // Date formatting - handles both ISO strings and timestamps
  const formatDate = (timestampOrIso: number | string) => {
    let isoString: string;
    if (typeof timestampOrIso === 'string') {
      isoString = timestampOrIso;
    } else {
      const date = new Date(timestampOrIso);
      isoString = date.toISOString();
    }
    return formatDateOnly(isoString).display;
  };

  // Status color helpers
  const getStatusColor = (status: string) => {
    const displayStatus = status === 'Completed' ? 'Delivered' : status;
    switch (displayStatus) {
      case 'Delivered':
        return 'bg-green-100 text-green-800 border-green-200';
      case 'Assigned':
        return 'bg-blue-100 text-blue-800 border-blue-200';
      case 'Open':
        return 'bg-yellow-100 text-yellow-800 border-yellow-200';
      case 'Expired':
        return 'bg-orange-100 text-orange-800 border-orange-200';
      case 'Canceled':
        return 'bg-gray-100 text-gray-800 border-gray-200';
      default:
        return 'bg-gray-100 text-gray-800 border-gray-200';
    }
  };

  const getTrackingColor = (status: string) => {
    switch (status) {
      case 'Completed':
        return 'bg-green-100 text-green-700';
      case 'In Transit':
        return 'bg-blue-100 text-blue-700';
      case 'Delayed':
        return 'bg-red-100 text-red-700';
      case 'Pending':
        return 'bg-gray-100 text-gray-700';
      default:
        return 'bg-gray-100 text-gray-700';
    }
  };

  // Handle validation result when it arrives
  useEffect(() => {
    if (validateBulkChange && isValidating) {
      setValidationResult(validateBulkChange);
      setIsValidating(false);

      const hasResolutionItems =
        validateBulkChange.safe.length > 0 ||
        validateBulkChange.imminent.length > 0 ||
        validateBulkChange.active.length > 0 ||
        validateBulkChange.finalized.length > 0 ||
        validateBulkChange.blocked.length > 0;

      // Check for blocked transitions first
      if (validateBulkChange.blocked && validateBulkChange.blocked.length > 0) {
        const blockedReasons = validateBulkChange.blocked.map((l: any) => l.orderNumber || l.id.slice(-6)).join(', ');
        toast.error(`Cannot change status: ${validateBulkChange.blocked[0].reason}`, {
          description: `Affected loads: ${blockedReasons}`,
          duration: 5000,
        });

        if (hasResolutionItems) {
          setShowResolutionModal(true);
        } else {
          setPendingTargetStatus(null);
        }
        return;
      }

      // Check if cancellation requires reason codes
      if (validateBulkChange.requiresReason && validateBulkChange.requiresReason.length > 0) {
        setCancellationLoads(validateBulkChange.requiresReason);
        setShowCancellationModal(true);
        return;
      }

      // If all safe, proceed directly; otherwise show modal
      if (validateBulkChange.summary.canProceedSafely && validateBulkChange.safe.length > 0) {
        // All clear - proceed without modal
        executeBulkStatusUpdate(validateBulkChange.safe.map((l: any) => l.id));
      } else if (hasResolutionItems) {
        setShowResolutionModal(true);
      } else {
        // Nothing to update
        toast.info('No loads can be updated with this status change');
        setPendingTargetStatus(null);
      }
    }
  }, [validateBulkChange, isValidating]);

  // Bulk action handlers
  const handleBulkDownload = async () => {
    // TODO: Implement bulk manifest download
    console.log('Download manifests for:', Array.from(selectedLoadIds));
    toast.info('Bulk download feature coming soon!');
  };

  // Execute the actual status update
  const executeBulkStatusUpdate = async (loadIds: string[]) => {
    if (!pendingTargetStatus || loadIds.length === 0) return;

    try {
      const dbStatus = pendingTargetStatus === 'Delivered' ? 'Completed' : pendingTargetStatus;
      const result = await bulkUpdateLoadStatus({
        loadIds: loadIds as Id<'loadInformation'>[],
        status: dbStatus as any,
      });

      if (result.failed > 0) {
        toast.warning(
          `Updated ${result.success} load${result.success !== 1 ? 's' : ''} to ${pendingTargetStatus}. ${result.failed} failed.`,
        );
      } else {
        toast.success(`Updated ${result.success} load${result.success !== 1 ? 's' : ''} to ${pendingTargetStatus}`);
      }
      setSelectedLoadIds(new Set());

      setSkipQuery(true);
      setTimeout(() => setSkipQuery(false), 0);
    } catch (error) {
      trackError('loads_bulk_status_update', error, { targetStatus: pendingTargetStatus, count: selectedLoadIds.size });
      console.error('Error updating status:', error);
      toast.error('Failed to update load status');
    } finally {
      setPendingTargetStatus(null);
      setValidationResult(null);
    }
  };

  // Initiate bulk status update with validation
  const handleUpdateStatus = async (status: 'Open' | 'Assigned' | 'Delivered' | 'Canceled' | 'Expired') => {
    const needsValidation = status === 'Open' || status === 'Delivered' || status === 'Canceled';

    if (needsValidation) {
      setPendingTargetStatus(status);
      setIsValidating(true);
    } else {
      setPendingTargetStatus(status);
      const dbStatus = status;
      try {
        const result = await bulkUpdateLoadStatus({
          loadIds: Array.from(selectedLoadIds),
          status: dbStatus as any,
        });

        if (result.failed > 0) {
          toast.warning(
            `Updated ${result.success} load${result.success !== 1 ? 's' : ''} to ${status}. ${result.failed} failed.`,
          );
        } else {
          toast.success(`Updated ${result.success} load${result.success !== 1 ? 's' : ''} to ${status}`);
        }
        setSelectedLoadIds(new Set());

        setSkipQuery(true);
        setTimeout(() => setSkipQuery(false), 0);
      } catch (error) {
        trackError('loads_status_update', error, { targetStatus: status, count: selectedLoadIds.size });
        console.error('Error updating status:', error);
        toast.error('Failed to update load status');
      } finally {
        setPendingTargetStatus(null);
      }
    }
  };

  // Handle cancellation with reason code
  const handleCancellationConfirm = async (reasonCode: CancellationReasonCode, notes?: string) => {
    try {
      const result = await bulkUpdateLoadStatus({
        loadIds: cancellationLoads.map((load) => load.id as Id<'loadInformation'>),
        status: 'Canceled',
        cancellationReason: reasonCode,
        cancellationNotes: notes,
        canceledBy: userId,
      });

      if (result.failed > 0) {
        toast.warning(`Canceled ${result.success} load${result.success !== 1 ? 's' : ''}. ${result.failed} failed.`);
      } else {
        toast.success(`Canceled ${result.success} load${result.success !== 1 ? 's' : ''}`);
      }
      setSelectedLoadIds(new Set());

      setSkipQuery(true);
      setTimeout(() => setSkipQuery(false), 0);
    } catch (error) {
      trackError('loads_cancel', error, { count: cancellationLoads.length });
      console.error('Error canceling loads:', error);
      toast.error('Failed to cancel loads');
    } finally {
      setShowCancellationModal(false);
      setCancellationLoads([]);
      setPendingTargetStatus(null);
      setValidationResult(null);
    }
  };

  // Handle modal actions
  const handleProceedSafe = () => {
    if (validationResult?.safe) {
      executeBulkStatusUpdate(validationResult.safe.map((l: any) => l.id));
    }
    setShowResolutionModal(false);
  };

  const handleProceedAll = () => {
    if (validationResult) {
      const allIds = [
        ...validationResult.safe.map((l: any) => l.id),
        ...validationResult.imminent.map((l: any) => l.id),
      ];
      executeBulkStatusUpdate(allIds);
    }
    setShowResolutionModal(false);
  };

  const handleCancelResolution = () => {
    setShowResolutionModal(false);
    setPendingTargetStatus(null);
    setValidationResult(null);
  };

  const handleExport = () => {
    // TODO: Implement CSV export
    const selectedLoads = currentLoads.filter((load) => selectedLoadIds.has(load._id));
    console.log('Export loads:', selectedLoads);
    toast.info('Export feature coming soon!');
  };

  const handleDelete = async () => {
    if (!confirm(`Are you sure you want to delete ${selectedLoadIds.size} load(s)?`)) {
      return;
    }
    try {
      await Promise.all(Array.from(selectedLoadIds).map((loadId) => deleteLoad({ loadId })));
      toast.success(`Deleted ${selectedLoadIds.size} load${selectedLoadIds.size !== 1 ? 's' : ''}`);
      setSelectedLoadIds(new Set());
    } catch (error) {
      trackError('loads_delete', error, { count: selectedLoadIds.size });
      console.error('Error deleting loads:', error);
      toast.error('Failed to delete loads');
    }
  };

  // Map load status for display in table.
  type LoadTableRow = (typeof currentLoads)[number] & { id: string };
  const loadRows: LoadTableRow[] = currentLoads.map((load) => ({
    ...load,
    id: load._id as unknown as string,
    status: load.status === 'Completed' ? 'Delivered' : load.status,
  }));
  const selectedRowIds = Array.from(selectedLoadIds) as unknown as string[];

  // Server tells us how many rows match the current view; for "all" we
  // sum the per-status counts. Used by InfiniteFooter.
  const totalForCurrentView =
    activeTab === 'all'
      ? Object.values(loadCounts ?? {}).reduce<number>((acc, n) => acc + (n ?? 0), 0)
      : (loadCounts?.[activeTab as keyof typeof loadCounts] ?? loadRows.length);
  const infiniteTotal = paginationStatus === 'CanLoadMore' || paginationStatus === 'LoadingMore'
    ? Math.max(loadRows.length, totalForCurrentView)
    : loadRows.length;

  // FilterBar properties — mirrors the design's HCR / Type / Miles /
  // Tracking / Load date set, but only HCR / Trip / Miles / Date map to
  // backing data today. Type and Tracking are deferred (no schema).
  const filterProps: FilterProperty[] = [
    {
      id: 'hcr', label: 'HCR', icon: 'doc-dollar', kind: 'enum', operator: 'is',
      options: availableHCRs.map((h) => ({ value: h, label: h })),
    },
    {
      id: 'trip', label: 'Trip', icon: 'truck', kind: 'enum', operator: 'is',
      options: availableTrips.map((t) => ({ value: t, label: t })),
    },
    {
      id: 'miles', label: 'Miles', icon: 'route', kind: 'enum', operator: 'is',
      options: [
        { value: 'short',  label: '0–50 mi' },
        { value: 'medium', label: '50–150 mi' },
        { value: 'long',   label: '150–300 mi' },
        { value: 'xlong',  label: '300+ mi' },
      ],
    },
    {
      id: 'tracking', label: 'Tracking', icon: 'compass', kind: 'enum', operator: 'is',
      options: [
        { value: 'Pending',    label: 'Pending' },
        { value: 'In Transit', label: 'In Transit' },
        { value: 'Completed',  label: 'Completed' },
        { value: 'Delayed',    label: 'Delayed' },
        { value: 'Canceled',   label: 'Canceled' },
      ],
    },
    {
      id: 'date', label: 'Load date', icon: 'calendar', kind: 'date',
      operator: 'is',
      presets: ['Today', 'Tomorrow', 'Next 7 days', 'Last 7 days', 'This month'],
    },
  ];

  // Bridge LoadFilterState ↔ FilterChipValue[].
  // Bridge LoadFilterState ↔ FilterChipValue[]. The Load date chip stores
  // its preset name as the chip value; on commit we translate it to a
  // concrete {start, end} timestamp pair the Convex query understands.
  const datePresetLabel = filters.dateRange
    ? labelForDateRange(filters.dateRange)
    : undefined;
  const chipFilters: FilterChipValue[] = [
    filters.hcr ? { propId: 'hcr', op: 'is' as const, values: [filters.hcr] } : null,
    filters.trip ? { propId: 'trip', op: 'is' as const, values: [filters.trip] } : null,
    filters.mileRange ? { propId: 'miles', op: 'is' as const, values: [filters.mileRange] } : null,
    filters.trackingStatus ? { propId: 'tracking', op: 'is' as const, values: [filters.trackingStatus] } : null,
    datePresetLabel ? { propId: 'date', op: 'is' as const, values: [datePresetLabel] } : null,
  ].filter(Boolean) as FilterChipValue[];

  const onChipFiltersChange = (next: FilterChipValue[]) => {
    const byId = new Map(next.map((c) => [c.propId, c.values[0]]));
    const datePreset = byId.get('date');
    const range = datePreset ? rangeForDatePreset(datePreset) : undefined;
    setFilters((prev) => ({
      ...prev,
      hcr: byId.get('hcr') ?? undefined,
      trip: byId.get('trip') ?? undefined,
      mileRange: byId.get('miles') ?? undefined,
      trackingStatus: byId.get('tracking') ?? undefined,
      dateRange: range,
    }));
  };

  // Table columns — render once, filter visible at render-time.
  const STATUS_TO_CHIP: Record<string, ChipStatus> = {
    Open: 'open',
    Assigned: 'assigned',
    Delivered: 'delivered',
    Completed: 'delivered',
    Canceled: 'cancelled',
    Cancelled: 'cancelled',
    Expired: 'expired',
  };
  const TRACKING_TO_CHIP: Record<string, ChipStatus> = {
    Pending: 'pending',
    'In Transit': 'active',
    Completed: 'delivered',
    Delayed: 'danger',
    Canceled: 'cancelled',
  };

  const allColumns: Array<{ key: keyof ColumnVisibility; col: TableColumn<LoadTableRow> }> = [
    {
      key: 'orderNumber',
      col: {
        key: 'orderNumber', label: 'Order #', width: '120px',
        render: (r) => (
          <Link
            href={`/loads/${r._id}`}
            onClick={(e) => e.stopPropagation()}
            className="num text-[var(--accent)] font-medium hover:underline"
          >
            {r.orderNumber}
          </Link>
        ),
      },
    },
    { key: 'customer', col: { key: 'customer', label: 'Customer', width: '1fr', render: (r) => r.customerName ?? '—' } },
    { key: 'hcr',        col: { key: 'hcr',        label: 'HCR',     width: '90px',  render: (r) => r.parsedHcr        || '—' } },
    { key: 'tripNumber', col: { key: 'tripNumber', label: 'Trip #',  width: '90px',  render: (r) => r.parsedTripNumber || '—' } },
    {
      key: 'route',
      col: {
        key: 'route', label: 'Route', width: '2.4fr',
        render: (r) => (
          <span className="inline-flex items-center gap-2 truncate uppercase">
            <span>{[r.origin?.city, r.origin?.state].filter(Boolean).join(', ') || '—'}</span>
            <WIcon name="arrow-right" size={11} color="var(--text-tertiary)" />
            <span>{[r.destination?.city, r.destination?.state].filter(Boolean).join(', ') || '—'}</span>
          </span>
        ),
      },
    },
    { key: 'stops', col: { key: 'stops', label: 'Stops', width: '70px', align: 'center', tnum: true, render: (r) => r.stopsCount } },
    {
      key: 'status',
      col: {
        key: 'status', label: 'Status', width: '110px',
        render: (r) => <Chip status={STATUS_TO_CHIP[r.status] ?? 'inactive'} />,
      },
    },
    {
      key: 'tracking',
      col: {
        key: 'tracking', label: 'Tracking', width: '110px',
        render: (r) => <Chip status={TRACKING_TO_CHIP[r.trackingStatus] ?? 'inactive'} label={r.trackingStatus} />,
      },
    },
    {
      key: 'loadDate',
      col: {
        key: 'loadDate', label: 'Load date', width: '110px', tnum: true,
        render: (r) => (
          <span className="num">{r.firstStopDate ? formatDate(r.firstStopDate) : '—'}</span>
        ),
      },
    },
  ];
  const visibleTableColumns = allColumns.filter(({ key }) => columnVisibility[key]).map(({ col }) => col);

  // ColumnsButton inside TableToolbar uses Set<string>.
  const visibleColumnKeys = new Set(allColumns.filter(({ key }) => columnVisibility[key]).map(({ col }) => col.key));
  const columnDefs: ColumnDef[] = allColumns.map(({ col }) => ({ key: col.key, label: typeof col.label === 'string' ? col.label : col.key }));
  const onColumnsChange = (next: Set<string>) => {
    setColumnVisibility((prev) => {
      const updated = { ...prev } as ColumnVisibility;
      allColumns.forEach(({ key, col }) => {
        updated[key] = next.has(col.key);
      });
      return updated;
    });
  };

  // SavedViews-driven tab strip — replaces the old shadcn Tabs row. The
  // status filter still flows through `activeTab` ('all' | DB status), but
  // the chrome (top header h1, Create Load button) is gone — actions live
  // in the SavedViews actions slot per the new design.
  const router = useRouter();
  const views: SavedView[] = [
    { id: 'all',      label: 'All' },
    { id: 'Open',     label: 'Open',      count: loadCounts?.Open      ?? 0, tone: 'warn' },
    { id: 'Assigned', label: 'Assigned',  count: loadCounts?.Assigned  ?? 0, tone: 'accent' },
    { id: 'Delivered',label: 'Delivered', count: loadCounts?.Delivered ?? 0, tone: 'neutral' },
    { id: 'Canceled', label: 'Cancelled', count: loadCounts?.Canceled  ?? 0, tone: 'neutral' },
    { id: 'Expired',  label: 'Expired',   count: loadCounts?.Expired   ?? 0, tone: 'neutral' },
  ];

  return (
    <div className="h-full flex flex-col">
      <SavedViews
        views={views}
        activeId={activeTab}
        onChange={handleTabChange}
        actions={
          <>
            <DraftListPill
              entity="load"
              draftKey="load-create-v1"
              createHref="/loads/new"
            />
            <WBtn size="sm" leading="export">Export</WBtn>
            <WBtn size="sm" variant="primary" leading="plus" onClick={() => router.push('/loads/new')}>
              New load
            </WBtn>
          </>
        }
      />

      <TableToolbar
        searchPlaceholder="Search order #, customer, city…"
        searchValue={filters.search}
        onSearchChange={(v) => setFilters((f) => ({ ...f, search: v }))}
        columns={columnDefs}
        visibleColumns={visibleColumnKeys}
        onVisibleColumnsChange={onColumnsChange}
        filterTrigger={chipFilters.length === 0 ? (
          <FilterBar
            properties={filterProps}
            value={chipFilters}
            onChange={onChipFiltersChange}
            slot="trigger"
          />
        ) : null}
      >
        {chipFilters.length > 0 && (
          <>
            <FilterBar
              properties={filterProps}
              value={chipFilters}
              onChange={onChipFiltersChange}
              slot="chips"
            />
            <FilterBar
              properties={filterProps}
              value={chipFilters}
              onChange={onChipFiltersChange}
              slot="trigger"
            />
          </>
        )}
      </TableToolbar>

      <div className="flex-1 min-h-0 flex flex-col relative bg-card">
        <Table<LoadTableRow>
          columns={visibleTableColumns}
          rows={loadRows}
          density="compact"
          selected={selectedRowIds}
          onSelect={(id) => handleSelectRow(id as Id<'loadInformation'>, !selectedLoadIds.has(id as Id<'loadInformation'>))}
          onSelectAll={() => handleSelectAll(!isAllSelected)}
          onRowClick={(row) => router.push(`/loads/${row._id}`)}
          getRowId={(row) => row._id as unknown as string}
        />
        {paginationStatus === 'LoadingFirstPage' && loadRows.length === 0 && (
          <div className="absolute inset-0 flex items-center justify-center text-[12.5px] text-[var(--text-tertiary)]">
            Loading loads…
          </div>
        )}
        {paginationStatus !== 'LoadingFirstPage' && loadRows.length === 0 && (
          <div className="absolute inset-0 flex items-center justify-center text-[12.5px] text-[var(--text-tertiary)]">
            {`No ${activeTab === 'all' ? '' : activeTab.toLowerCase() + ' '}loads${filters.search ? ' matching your search' : ''}`}
          </div>
        )}
        <InfiniteFooter
          loaded={loadRows.length}
          total={infiniteTotal}
          loading={paginationStatus === 'LoadingMore'}
        />
        <BulkBar
          count={selectedLoadIds.size}
          onClear={() => setSelectedLoadIds(new Set())}
          actions={
            <>
              <BulkAction icon="download" label="Manifests" onClick={handleBulkDownload} />
              <UpdateStatusBulkMenu onUpdateStatus={handleUpdateStatus} />
              <BulkAction icon="export" label="Export" onClick={handleExport} />
              <BulkAction icon="close" label="Delete" danger onClick={handleDelete} />
            </>
          }
        />
      </div>

      {/* Bulk Action Resolution Modal */}
      <BulkActionResolutionModal
        open={showResolutionModal}
        onOpenChange={setShowResolutionModal}
        validationResult={validationResult}
        targetStatus={pendingTargetStatus || 'Open'}
        onProceedSafe={handleProceedSafe}
        onProceedAll={handleProceedAll}
        onCancel={handleCancelResolution}
      />

      {/* Cancellation Reason Modal */}
      <CancellationReasonModal
        open={showCancellationModal}
        onOpenChange={(open) => {
          setShowCancellationModal(open);
          if (!open) {
            setCancellationLoads([]);
            setPendingTargetStatus(null);
            setValidationResult(null);
          }
        }}
        loadCount={cancellationLoads.length}
        loads={cancellationLoads}
        onConfirm={handleCancellationConfirm}
      />
    </div>
  );
}

// ─── Date preset bridge ─────────────────────────────────────────────────
// FilterBar's date kind commits a preset string (e.g. "Last 7 days"). The
// Convex `getLoads` query takes concrete YYYY-MM-DD bounds; we keep both
// in sync via these helpers. Range is inclusive on both ends.

const DAY_MS = 86_400_000;

function startOfDay(t: number): number {
  const d = new Date(t);
  d.setHours(0, 0, 0, 0);
  return d.getTime();
}
function endOfDay(t: number): number {
  const d = new Date(t);
  d.setHours(23, 59, 59, 999);
  return d.getTime();
}

function rangeForDatePreset(preset: string | undefined): { start: number; end: number } | undefined {
  if (!preset) return undefined;
  // Custom range — `YYYY-MM-DD..YYYY-MM-DD` from FilterBar's calendar.
  const custom = parseDateRangeValue(preset);
  if (custom) {
    return { start: startOfDay(custom.from.getTime()), end: endOfDay(custom.to.getTime()) };
  }
  const now = Date.now();
  const todayStart = startOfDay(now);
  const todayEnd = endOfDay(now);
  switch (preset) {
    case 'Today':
      return { start: todayStart, end: todayEnd };
    case 'Tomorrow':
      return { start: todayStart + DAY_MS, end: todayEnd + DAY_MS };
    case 'Next 7 days':
      return { start: todayStart, end: todayEnd + 6 * DAY_MS };
    case 'Last 7 days':
      return { start: todayStart - 6 * DAY_MS, end: todayEnd };
    case 'This month': {
      const d = new Date(now);
      const first = new Date(d.getFullYear(), d.getMonth(), 1).getTime();
      const last = new Date(d.getFullYear(), d.getMonth() + 1, 0);
      return { start: startOfDay(first), end: endOfDay(last.getTime()) };
    }
    default:
      return undefined;
  }
}

// Reverse-map a saved {start, end} back to a preset label so the chip
// keeps the friendly name across remounts. Falls back to a serialized
// custom range string for ranges that don't match a named preset.
function labelForDateRange(range: { start: number; end: number }): string | undefined {
  const presets = ['Today', 'Tomorrow', 'Next 7 days', 'Last 7 days', 'This month'];
  for (const p of presets) {
    const r = rangeForDatePreset(p);
    if (r && r.start === range.start && r.end === range.end) return p;
  }
  return formatDateRangeValue({ from: new Date(range.start), to: new Date(range.end) });
}

// ─── BulkBar dropdown — Update Status ────────────────────────────────────
// BulkAction is a single-click button. The Update Status affordance needs
// a popover with four target states, so we render a Radix popover trigger
// styled to match the BulkAction pill.
function UpdateStatusBulkMenu({
  onUpdateStatus,
}: {
  onUpdateStatus: (status: 'Open' | 'Assigned' | 'Delivered' | 'Canceled' | 'Expired') => void;
}) {
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <button
          type="button"
          className="focus-ring h-9 px-3 rounded-lg inline-flex items-center gap-1.5 text-[12.5px] font-medium text-white bg-transparent cursor-pointer transition-colors duration-[var(--dur-fast)] ease-[var(--ease-out)] hover:bg-white/10"
        >
          <span>Update status</span>
          <span className="opacity-70 text-[10px]">▾</span>
        </button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start">
        <DropdownMenuItem onClick={() => onUpdateStatus('Open')}>Mark as Open</DropdownMenuItem>
        <DropdownMenuItem onClick={() => onUpdateStatus('Assigned')}>Mark as Assigned</DropdownMenuItem>
        <DropdownMenuItem onClick={() => onUpdateStatus('Delivered')}>Mark as Delivered</DropdownMenuItem>
        <DropdownMenuItem onClick={() => onUpdateStatus('Canceled')}>Mark as Canceled</DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
