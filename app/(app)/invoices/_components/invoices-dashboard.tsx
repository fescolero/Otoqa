'use client';

/**
 * InvoicesDashboard — Accounting → Invoices, on the Otoqa Web chassis.
 *
 * PageHeader (title + AR stat-chips) → SavedViews tabs → TableToolbar +
 * FilterBar → shared Table → BulkBar → InfiniteFooter, mirroring the
 * loads-table migration. Views:
 *   Needs attention → unmapped load groups → FixLaneModal (our real flow)
 *   Ready to invoice → DRAFT   Sent → PENDING_PAYMENT
 *   Overdue → PENDING_PAYMENT past-due (listInvoices `overdueOnly`)
 *   Paid → PAID                Void → VOID
 *
 * All prior behavior is preserved: bulk actions, preview sheet (+ keyboard
 * nav), fix-lane modal, payment CSV import, reset-paid→draft, re-match lanes,
 * and the PAID payment-discrepancy indicator.
 */

import { useState, useMemo, useCallback, startTransition } from 'react';
import { useQuery, useMutation, usePaginatedQuery } from 'convex/react';
import { useAuthQuery } from '@/hooks/use-auth-query';
import { api } from '@/convex/_generated/api';
import { Id } from '@/convex/_generated/dataModel';
import { toast } from 'sonner';
import { TrendingDown, TrendingUp } from 'lucide-react';
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from '@/components/ui/tooltip';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
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
import { Input } from '@/components/ui/input';
import {
  AttentionBand,
  BulkAction,
  BulkBar,
  CountBadge,
  type ColumnDef,
  FilterBar,
  type FilterChipValue,
  type FilterProperty,
  InfiniteFooter,
  PageHeader,
  type PageHeaderStat,
  SavedViews,
  type SavedView,
  Table,
  type TableColumn,
  TableToolbar,
  WBtn,
  WIcon,
  parseDateRangeValue,
} from '@/components/web';
import { useUserPreferences } from '@/components/web/shell/use-user-preferences';
import { useDebounce } from '@/hooks/use-debounce';
import { FixLaneModal } from './fix-lane-modal';
import { InvoicePreviewSheet } from './invoice-preview-sheet';
import { KeyboardShortcutsDialog } from './keyboard-shortcuts-dialog';
import { PaymentCsvImportDialog } from './payment-csv-import-dialog';
import { InvoiceStatusBadge } from './invoice-status-badge';
import { useKeyboardNavigation } from './use-keyboard-navigation';
import { useBulkActions, type UndoableStatus } from './use-bulk-actions';
import {
  fmtShortDate,
  fmtUSD,
  fmtUSDCompact,
  InvoiceBillChip,
  invoiceBalance,
  invoiceDaysLate,
  isInvoiceOverdue,
  type InvoiceRow,
} from './invoice-bill-chip';

interface InvoicesDashboardProps {
  organizationId: string;
  userId: string;
}

type ViewId = 'attention' | 'ready' | 'sent' | 'overdue' | 'paid' | 'void';

const VIEW_STATUS: Record<Exclude<ViewId, 'attention'>, 'DRAFT' | 'PENDING_PAYMENT' | 'PAID' | 'VOID'> = {
  ready: 'DRAFT',
  sent: 'PENDING_PAYMENT',
  overdue: 'PENDING_PAYMENT',
  paid: 'PAID',
  void: 'VOID',
};

// ── per-cell renderers ──────────────────────────────────────────────────
function AmountCell({ inv }: { inv: InvoiceRow }) {
  const showDiff =
    inv.status === 'PAID' &&
    inv.paymentDifference !== undefined &&
    Math.abs(inv.paymentDifference) > 0.005;
  return (
    <span className="inline-flex items-center justify-end gap-1.5">
      <span className="num text-[13px] font-medium">{fmtUSD(inv.totalAmount, false)}</span>
      {showDiff && (
        <TooltipProvider delayDuration={200}>
          <Tooltip>
            <TooltipTrigger asChild>
              <span
                className={`num inline-flex items-center gap-0.5 text-[11px] font-medium rounded px-1 py-0.5 ${
                  inv.paymentDifference! > 0
                    ? 'text-amber-700 bg-amber-50 dark:text-amber-300 dark:bg-amber-950/40'
                    : 'text-red-700 bg-red-50 dark:text-red-300 dark:bg-red-950/40'
                }`}
              >
                {inv.paymentDifference! > 0 ? (
                  <TrendingUp className="h-3 w-3" />
                ) : (
                  <TrendingDown className="h-3 w-3" />
                )}
                {fmtUSD(Math.abs(inv.paymentDifference!), false)}
              </span>
            </TooltipTrigger>
            <TooltipContent side="top">
              <p>
                Paid {fmtUSD(inv.paidAmount ?? 0)} vs invoiced {fmtUSD(inv.totalAmount)}
              </p>
              <p className="text-xs text-muted-foreground">
                {inv.paymentDifference! > 0 ? 'Overpaid' : 'Underpaid'} by{' '}
                {fmtUSD(Math.abs(inv.paymentDifference!))}
              </p>
            </TooltipContent>
          </Tooltip>
        </TooltipProvider>
      )}
    </span>
  );
}

function DueCell({ inv }: { inv: InvoiceRow }) {
  const overdue = isInvoiceOverdue(inv);
  const late = overdue ? invoiceDaysLate(inv) : 0;
  return (
    <span className="inline-flex items-center gap-1.5 whitespace-nowrap">
      <span className={`num text-[12.5px] ${overdue ? 'text-[#B43030] font-semibold' : 'text-[var(--text-secondary)]'}`}>
        {fmtShortDate(inv.dueDate)}
      </span>
      {overdue && late > 0 && (
        <span className="num text-[10.5px] font-semibold text-[#B43030] bg-[rgba(239,68,68,0.10)] px-1.5 rounded-full">
          {late}d late
        </span>
      )}
    </span>
  );
}

function BalanceCell({ inv }: { inv: InvoiceRow }) {
  if (inv.status === 'VOID') return <span className="text-[var(--text-tertiary)]">—</span>;
  // A paid invoice is settled — any over/under-payment is surfaced by the
  // Amount discrepancy badge, not as a (possibly negative) balance here.
  if (inv.status === 'PAID') return <span className="num text-[12.5px] text-[var(--text-tertiary)]">{fmtUSD(0, false)}</span>;
  const balance = invoiceBalance(inv);
  const partial = balance > 0 && balance < (inv.totalAmount ?? 0);
  const color = balance === 0 ? 'text-[var(--text-tertiary)]' : partial ? 'text-[#A66800] font-semibold' : 'text-[var(--text-secondary)]';
  return <span className={`num text-[12.5px] ${color}`}>{fmtUSD(balance, false)}</span>;
}

const INVOICE_COLUMNS: TableColumn<InvoiceRow>[] = [
  {
    key: 'invoiceNumber',
    label: 'Invoice #',
    width: '150px',
    sortable: false,
    render: (r) => (
      <span className="num text-[12.5px] font-medium text-[var(--accent)] whitespace-nowrap">
        {r.invoiceNumber || '—'}
      </span>
    ),
  },
  {
    key: 'customer',
    label: 'Customer',
    width: '1.4fr',
    sortable: false,
    render: (r) => <span className="text-[13px] truncate">{r.customer?.name || 'Unknown'}</span>,
  },
  {
    key: 'order',
    label: 'Order #',
    width: '120px',
    sortable: false,
    render: (r) => <span className="num text-[12.5px] text-[var(--text-secondary)] whitespace-nowrap">{r.load?.orderNumber || '—'}</span>,
  },
  {
    key: 'type',
    label: 'Type',
    width: '108px',
    sortable: false,
    render: (r) =>
      r.load?.loadType ? (
        <InvoiceStatusBadge type={r.load.loadType} value={r.load.loadType} />
      ) : (
        <span className="text-[var(--text-tertiary)]">—</span>
      ),
  },
  {
    key: 'issued',
    label: 'Issued',
    width: '92px',
    sortable: false,
    tnum: true,
    render: (r) => <span className="num text-[12.5px] text-[var(--text-secondary)]">{fmtShortDate(r.invoiceDate)}</span>,
  },
  {
    key: 'due',
    label: 'Due',
    width: '136px',
    sortable: false,
    tnum: true,
    render: (r) => <DueCell inv={r} />,
  },
  {
    key: 'amount',
    label: 'Amount',
    width: '128px',
    align: 'right',
    sortable: false,
    tnum: true,
    render: (r) => <AmountCell inv={r} />,
  },
  {
    key: 'balance',
    label: 'Balance',
    width: '110px',
    align: 'right',
    sortable: false,
    tnum: true,
    render: (r) => <BalanceCell inv={r} />,
  },
  {
    key: 'status',
    label: 'Status',
    width: '120px',
    sortable: false,
    render: (r) => <InvoiceBillChip inv={r} />,
  },
];

const INVOICE_COLUMN_DEFS: ColumnDef[] = INVOICE_COLUMNS.map((c) => ({
  key: c.key,
  label: typeof c.label === 'string' ? c.label : c.key,
}));

export function InvoicesDashboard({ organizationId, userId }: InvoicesDashboardProps) {
  const { density } = useUserPreferences();
  const [view, setView] = useState<ViewId>('attention');

  // Selection + keyboard focus
  const [selectedInvoiceIds, setSelectedInvoiceIds] = useState<Set<Id<'loadInvoices'>>>(new Set());
  const [focusedRowIndex, setFocusedRowIndex] = useState<number | null>(null);

  // Preview sheet
  const [previewInvoiceId, setPreviewInvoiceId] = useState<Id<'loadInvoices'> | null>(null);
  const [isPreviewOpen, setIsPreviewOpen] = useState(false);
  const [pendingPreviewAction, setPendingPreviewAction] = useState<'print' | 'download' | null>(null);

  // Dialogs / admin actions
  const [isPaymentImportOpen, setIsPaymentImportOpen] = useState(false);
  const [isResetting, setIsResetting] = useState(false);
  const [isRePromoting, setIsRePromoting] = useState(false);
  const [resetConfirmOpen, setResetConfirmOpen] = useState(false);
  const [resetConfirmText, setResetConfirmText] = useState('');
  const [isBackfilling, setIsBackfilling] = useState(false);
  const [selectedGroup, setSelectedGroup] = useState<any>(null);
  const resetPaidToDraft = useMutation(api.invoices.resetPaidToDraft);
  const rePromoteStuckLoads = useMutation(api.lanes.rePromoteStuckLoads);
  const backfillInvoiceNumbers = useMutation(api.invoices.backfillInvoiceNumbers);

  // Filters
  const [search, setSearch] = useState('');
  const [chipFilters, setChipFilters] = useState<FilterChipValue[]>([]);
  const [attentionSearch, setAttentionSearch] = useState('');
  const [attentionChips, setAttentionChips] = useState<FilterChipValue[]>([]);
  const [visibleCols, setVisibleCols] = useState<Set<string>>(new Set(INVOICE_COLUMNS.map((c) => c.key)));

  const debouncedSearch = useDebounce(search, 300);
  const debouncedAttentionSearch = useDebounce(attentionSearch, 300);

  const isAttention = view === 'attention';
  const currentStatus = isAttention ? null : VIEW_STATUS[view];

  // ── data ──
  const counts = useAuthQuery(api.invoices.countInvoicesByStatus, { workosOrgId: organizationId });
  const summary = useAuthQuery(api.invoices.getInvoiceSummary, { workosOrgId: organizationId });
  const allUnmappedGroups = useAuthQuery(api.analytics.getUnmappedLoadGroups, { workosOrgId: organizationId });

  // Derive query facet args from the filter chips.
  const chipMap = useMemo(() => new Map(chipFilters.map((c) => [c.propId, c.values[0]])), [chipFilters]);
  const issuedRange = useMemo(() => {
    const preset = chipMap.get('issued');
    return preset ? rangeForDatePreset(preset) : undefined;
  }, [chipMap]);

  const {
    results: paginatedInvoices,
    status: paginationStatus,
    loadMore,
  } = usePaginatedQuery(
    api.invoices.listInvoices,
    currentStatus
      ? {
          workosOrgId: organizationId,
          status: currentStatus,
          search: debouncedSearch || undefined,
          hcr: chipMap.get('hcr'),
          trip: chipMap.get('trip'),
          loadType: chipMap.get('loadType') as 'CONTRACT' | 'SPOT' | 'UNMAPPED' | undefined,
          dateRangeStart: issuedRange?.start,
          dateRangeEnd: issuedRange?.end,
          overdueOnly: view === 'overdue' ? true : undefined,
        }
      : 'skip',
    { initialNumItems: 100 },
  );

  const filterOptions = useQuery(
    api.invoices.getFilterOptions,
    currentStatus ? { workosOrgId: organizationId, status: currentStatus } : 'skip',
  );

  const currentInvoices = useMemo<InvoiceRow[]>(
    () => (isAttention ? [] : ((paginatedInvoices ?? []) as unknown as InvoiceRow[])),
    [isAttention, paginatedInvoices],
  );

  // Attention groups, filtered client-side (search + HCR/Trip chips).
  const attnChipMap = useMemo(() => new Map(attentionChips.map((c) => [c.propId, c.values[0]])), [attentionChips]);
  const filteredGroups = useMemo(() => {
    if (!allUnmappedGroups) return [];
    return allUnmappedGroups.filter((g) => {
      if (debouncedAttentionSearch) {
        const q = debouncedAttentionSearch.toLowerCase();
        const hit =
          g.hcr?.toLowerCase().includes(q) ||
          g.tripNumber?.toLowerCase().includes(q) ||
          g.sampleOrderNumber?.toLowerCase().includes(q);
        if (!hit) return false;
      }
      if (attnChipMap.get('hcr') && g.hcr !== attnChipMap.get('hcr')) return false;
      if (attnChipMap.get('trip') && g.tripNumber !== attnChipMap.get('trip')) return false;
      return true;
    });
  }, [allUnmappedGroups, debouncedAttentionSearch, attnChipMap]);

  // ── selection ──
  const onSelectRow = (id: string | number) => {
    setSelectedInvoiceIds((prev) => {
      const next = new Set(prev);
      const key = id as Id<'loadInvoices'>;
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  };
  const onSelectAll = () => {
    setSelectedInvoiceIds((prev) =>
      prev.size === currentInvoices.length ? new Set() : new Set(currentInvoices.map((i) => i._id)),
    );
  };
  const selectedRowIds = useMemo(() => Array.from(selectedInvoiceIds) as unknown as string[], [selectedInvoiceIds]);

  const bulkActions = useBulkActions(organizationId, userId, () => setSelectedInvoiceIds(new Set()));

  // ── preview ──
  const handlePreviewOpen = useCallback((invoiceId: Id<'loadInvoices'>) => {
    setPreviewInvoiceId(invoiceId);
    setIsPreviewOpen(true);
    setPendingPreviewAction(null);
  }, []);
  const handlePreviewClose = useCallback(() => {
    setIsPreviewOpen(false);
    setPreviewInvoiceId(null);
    setPendingPreviewAction(null);
  }, []);
  const handleAutoActionHandled = useCallback(() => {
    setPendingPreviewAction(null);
    if (!isPreviewOpen) setPreviewInvoiceId(null);
  }, [isPreviewOpen]);

  useKeyboardNavigation({
    invoices: currentInvoices as any,
    selectedIds: selectedInvoiceIds,
    setSelectedIds: setSelectedInvoiceIds,
    focusedRowIndex,
    setFocusedRowIndex,
    onOpenPreview: handlePreviewOpen,
    isSheetOpen: isPreviewOpen,
  });

  // ── view switching ──
  const onChangeView = (next: string) => {
    setView(next as ViewId);
    setSelectedInvoiceIds(new Set());
    setFocusedRowIndex(null);
  };

  // ── admin actions ──
  const handleReset = async () => {
    setResetConfirmOpen(false);
    setIsResetting(true);
    try {
      let totalReset = 0;
      let totalLineItems = 0;
      let hasMore = true;
      while (hasMore) {
        const result = await resetPaidToDraft({ workosOrgId: organizationId, batchSize: 100 });
        totalReset += result.reset;
        totalLineItems += result.lineItemsDeleted;
        hasMore = result.hasMore;
      }
      toast.success(`Reset ${totalReset} invoices to DRAFT (${totalLineItems} line items cleaned)`);
    } catch (err) {
      toast.error('Failed to reset invoices');
      console.error(err);
    } finally {
      setIsResetting(false);
      setResetConfirmText('');
    }
  };

  const handleBackfillNumbers = async () => {
    setIsBackfilling(true);
    try {
      let total = 0;
      let hasMore = true;
      while (hasMore) {
        const result = await backfillInvoiceNumbers({ workosOrgId: organizationId, batchSize: 200 });
        total += result.numbered;
        hasMore = result.hasMore;
      }
      if (total > 0) toast.success(`Assigned invoice numbers to ${total} invoices (chronological order)`);
      else toast.info('All finalized invoices already have numbers');
    } catch (err) {
      toast.error('Failed to backfill invoice numbers');
      console.error(err);
    } finally {
      setIsBackfilling(false);
    }
  };

  const handleRematch = async () => {
    setIsRePromoting(true);
    try {
      let totalPromoted = 0;
      let hasMore = true;
      while (hasMore) {
        const result = await rePromoteStuckLoads({ workosOrgId: organizationId, batchSize: 50 });
        totalPromoted += result.promoted;
        hasMore = result.hasMore && result.promoted > 0;
      }
      if (totalPromoted > 0) toast.success(`Re-promoted ${totalPromoted} loads from Attention → Ready`);
      else toast.info('No stuck loads found — all loads either lack a matching lane or are already promoted');
    } catch (err) {
      toast.error('Failed to re-promote loads');
      console.error(err);
    } finally {
      setIsRePromoting(false);
    }
  };

  // ── derived view chrome ──
  const stats: PageHeaderStat[] = [
    { value: fmtUSDCompact(summary?.outstanding ?? 0), label: 'outstanding' },
    { value: <span style={{ color: '#B43030' }}>{fmtUSDCompact(summary?.overdue ?? 0)}</span>, label: 'overdue' },
    { value: <span style={{ color: '#A66800' }}>{filteredGroups.length}</span>, label: 'need attention' },
    { value: counts?.DRAFT ?? 0, label: 'ready to bill' },
  ];

  const views: SavedView[] = [
    { id: 'attention', label: 'Needs attention', count: allUnmappedGroups?.length ?? 0, tone: 'warn' },
    { id: 'ready', label: 'Ready to invoice', count: counts?.DRAFT ?? 0, tone: 'accent' },
    { id: 'sent', label: 'Sent', count: counts?.PENDING_PAYMENT ?? 0, tone: 'neutral' },
    { id: 'overdue', label: 'Overdue', count: summary?.overdueCount ?? 0, tone: 'danger' },
    { id: 'paid', label: 'Paid', count: counts?.PAID ?? 0, tone: 'neutral' },
    { id: 'void', label: 'Void', count: counts?.VOID ?? 0, tone: 'neutral' },
  ];

  const headerActions = (
    <>
      <WBtn size="sm" variant="ghost" leading="import" onClick={() => setIsPaymentImportOpen(true)}>
        Import payments
      </WBtn>
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <WBtn size="sm" variant="ghost" aria-label="More actions">
            <WIcon name="refresh" size={14} />
          </WBtn>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end">
          <DropdownMenuLabel className="text-[11px] uppercase tracking-wide text-muted-foreground">
            Admin tools
          </DropdownMenuLabel>
          <DropdownMenuItem disabled={isBackfilling} onClick={handleBackfillNumbers}>
            {isBackfilling ? 'Numbering…' : 'Backfill invoice numbers'}
          </DropdownMenuItem>
          <DropdownMenuSeparator />
          <DropdownMenuItem
            disabled={isResetting}
            onSelect={(e) => {
              e.preventDefault();
              setResetConfirmText('');
              setResetConfirmOpen(true);
            }}
            className="text-destructive focus:text-destructive"
          >
            {isResetting ? 'Resetting…' : 'Reset paid → draft'}
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
    </>
  );

  // Filter properties
  const invoiceFilterProps: FilterProperty[] = useMemo(
    () => [
      {
        id: 'hcr', label: 'HCR', icon: 'doc-dollar', kind: 'enum', operator: 'is',
        options: (filterOptions?.hcrs ?? []).map((h) => ({ value: h, label: h })),
      },
      {
        id: 'trip', label: 'Trip', icon: 'truck', kind: 'enum', operator: 'is',
        options: (filterOptions?.trips ?? []).map((t) => ({ value: t, label: t })),
      },
      {
        id: 'loadType', label: 'Type', icon: 'briefcase', kind: 'enum', operator: 'is',
        options: [
          { value: 'CONTRACT', label: 'Contract' },
          { value: 'SPOT', label: 'Spot' },
          { value: 'UNMAPPED', label: 'Unmapped' },
        ],
      },
      {
        id: 'issued', label: 'Created', icon: 'calendar', kind: 'date', operator: 'is',
        presets: ['Today', 'Last 7 days', 'Last 30 days', 'This month'],
      },
    ],
    [filterOptions],
  );

  const attentionFilterProps: FilterProperty[] = useMemo(() => {
    const hcrs = new Set<string>();
    const trips = new Set<string>();
    (allUnmappedGroups ?? []).forEach((g) => {
      if (g.hcr) hcrs.add(g.hcr);
      if (g.tripNumber) trips.add(g.tripNumber);
    });
    return [
      { id: 'hcr', label: 'HCR', icon: 'doc-dollar', kind: 'enum', operator: 'is', options: Array.from(hcrs).sort().map((h) => ({ value: h, label: h })) },
      { id: 'trip', label: 'Trip', icon: 'truck', kind: 'enum', operator: 'is', options: Array.from(trips).sort().map((t) => ({ value: t, label: t })) },
    ];
  }, [allUnmappedGroups]);

  // InfiniteFooter total for the active view.
  const viewCount =
    view === 'ready' ? counts?.DRAFT
    : view === 'sent' ? counts?.PENDING_PAYMENT
    : view === 'paid' ? counts?.PAID
    : view === 'void' ? counts?.VOID
    : currentInvoices.length;
  const infiniteTotal =
    paginationStatus === 'CanLoadMore' || paginationStatus === 'LoadingMore'
      ? Math.max(currentInvoices.length, viewCount ?? currentInvoices.length)
      : currentInvoices.length;

  const visibleInvoiceColumns = INVOICE_COLUMNS.filter((c) => visibleCols.has(c.key));
  const isLoadingFirst = paginationStatus === 'LoadingFirstPage';
  const isEmpty = currentInvoices.length === 0;

  return (
    <div className="h-full flex flex-col min-h-0">
      <PageHeader title="Invoices" stats={stats} actions={headerActions} />
      <SavedViews views={views} activeId={view} onChange={onChangeView} />

      {isAttention ? (
        <>
          {(allUnmappedGroups?.length ?? 0) > 0 && (
            <div className="px-6 pt-4">
              <AttentionBand
                headline={
                  <span>
                    <strong>{allUnmappedGroups?.length} load group{(allUnmappedGroups?.length ?? 0) === 1 ? '' : 's'}</strong>{' '}
                    can&apos;t be invoiced yet — define a contract lane to backfill invoices, or void to discard.
                  </span>
                }
              />
            </div>
          )}

          <TableToolbar
            searchPlaceholder="Search HCR, trip, order #…"
            searchValue={attentionSearch}
            onSearchChange={setAttentionSearch}
            rightContent={
              <WBtn size="sm" variant="secondary" leading="refresh" disabled={isRePromoting} onClick={handleRematch}>
                {isRePromoting ? 'Re-matching…' : 'Re-match lanes'}
              </WBtn>
            }
            filterTrigger={
              attentionChips.length === 0 ? (
                <FilterBar properties={attentionFilterProps} value={attentionChips} onChange={setAttentionChips} slot="trigger" />
              ) : null
            }
          >
            {attentionChips.length > 0 && (
              <>
                <FilterBar properties={attentionFilterProps} value={attentionChips} onChange={setAttentionChips} slot="chips" />
                <FilterBar properties={attentionFilterProps} value={attentionChips} onChange={setAttentionChips} slot="trigger" />
              </>
            )}
          </TableToolbar>

          <div className="flex-1 min-h-0 flex flex-col relative bg-card">
            {filteredGroups.length === 0 ? (
              <EmptyAttention hasGroups={(allUnmappedGroups?.length ?? 0) > 0} onGoReady={() => onChangeView('ready')} />
            ) : (
              <AttentionTable groups={filteredGroups} density={density} onFix={setSelectedGroup} />
            )}
            <InfiniteFooter loaded={filteredGroups.length} total={allUnmappedGroups?.length ?? filteredGroups.length} />
          </div>
        </>
      ) : (
        <>
          <TableToolbar
            searchPlaceholder="Search invoice #, customer, order #…"
            searchValue={search}
            onSearchChange={setSearch}
            columns={INVOICE_COLUMN_DEFS}
            visibleColumns={visibleCols}
            onVisibleColumnsChange={setVisibleCols}
            filterTrigger={
              chipFilters.length === 0 ? (
                <FilterBar properties={invoiceFilterProps} value={chipFilters} onChange={setChipFilters} slot="trigger" />
              ) : null
            }
          >
            {chipFilters.length > 0 && (
              <>
                <FilterBar properties={invoiceFilterProps} value={chipFilters} onChange={setChipFilters} slot="chips" />
                <FilterBar properties={invoiceFilterProps} value={chipFilters} onChange={setChipFilters} slot="trigger" />
              </>
            )}
          </TableToolbar>

          <div className="flex-1 min-h-0 flex flex-col relative bg-card">
            <Table<InvoiceRow>
              columns={visibleInvoiceColumns}
              rows={currentInvoices}
              density={density}
              selected={selectedRowIds}
              onSelect={onSelectRow}
              onSelectAll={onSelectAll}
              onRowClick={(r) => handlePreviewOpen(r._id)}
              getRowId={(r) => r._id as unknown as string}
              onEndReached={paginationStatus === 'CanLoadMore' ? () => startTransition(() => loadMore(100)) : undefined}
            />
            {isLoadingFirst && isEmpty && (
              <div className="absolute inset-0 flex items-center justify-center text-[12.5px] text-[var(--text-tertiary)]">
                Loading invoices…
              </div>
            )}
            {!isLoadingFirst && isEmpty && (
              <div className="absolute inset-0 flex items-center justify-center text-[12.5px] text-[var(--text-tertiary)]">
                {`No ${VIEW_LABEL[view]} invoices${search ? ' matching your search' : ''}`}
              </div>
            )}
            <InfiniteFooter loaded={currentInvoices.length} total={infiniteTotal} loading={paginationStatus === 'LoadingMore'} />
            <BulkBar
              count={selectedInvoiceIds.size}
              onClear={() => setSelectedInvoiceIds(new Set())}
              actions={
                <>
                  <BulkAction icon="download" label="Download" onClick={() => bulkActions.handleBulkDownload(Array.from(selectedInvoiceIds))} />
                  {view === 'ready' && (
                    <BulkAction
                      icon="receipt"
                      label="Mark as billed"
                      onClick={() => bulkActions.handleMarkBilled(Array.from(selectedInvoiceIds))}
                    />
                  )}
                  {(view === 'ready' || view === 'sent' || view === 'overdue') && (
                    <BulkAction
                      icon="badge-check"
                      label="Mark as Paid"
                      onClick={() =>
                        bulkActions.handleMarkAsPaid(
                          Array.from(selectedInvoiceIds),
                          currentStatus as 'DRAFT' | 'PENDING_PAYMENT',
                        )
                      }
                    />
                  )}
                  <ChangeTypeBulkMenu onChange={(t) => bulkActions.handleChangeType(Array.from(selectedInvoiceIds), t)} />
                  {view !== 'void' && (
                    <BulkAction
                      icon="close"
                      label="Void"
                      danger
                      onClick={() =>
                        bulkActions.handleVoid(Array.from(selectedInvoiceIds), currentStatus as UndoableStatus)
                      }
                    />
                  )}
                </>
              }
            />
          </div>
        </>
      )}

      {/* Invoice preview */}
      <InvoicePreviewSheet
        invoiceId={previewInvoiceId}
        isOpen={isPreviewOpen}
        onClose={handlePreviewClose}
        allInvoiceIds={currentInvoices.map((inv) => inv._id)}
        onNavigate={handlePreviewOpen}
        autoAction={pendingPreviewAction}
        onAutoActionHandled={handleAutoActionHandled}
        onMarkBilled={(id) => bulkActions.handleMarkBilled([id])}
        workosOrgId={organizationId}
        userId={userId}
      />

      {/* Fix lane modal */}
      {selectedGroup && (
        <FixLaneModal
          group={selectedGroup}
          organizationId={organizationId}
          userId={userId}
          onClose={() => setSelectedGroup(null)}
        />
      )}

      <KeyboardShortcutsDialog />

      <PaymentCsvImportDialog
        open={isPaymentImportOpen}
        onOpenChange={setIsPaymentImportOpen}
        workosOrgId={organizationId}
        userId={userId}
      />

      {/* Destructive admin action — type-to-confirm */}
      <AlertDialog open={resetConfirmOpen} onOpenChange={setResetConfirmOpen}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Reset all paid invoices to draft?</AlertDialogTitle>
            <AlertDialogDescription>
              This resets <strong>every paid invoice in this organization</strong> back to DRAFT — clearing
              recorded payments, amounts, and line items, and reversing the accounting totals that feed Reports.
              This cannot be undone. Type <strong>RESET</strong> to confirm.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <Input
            value={resetConfirmText}
            onChange={(e) => setResetConfirmText(e.target.value)}
            placeholder="Type RESET"
            autoFocus
          />
          <AlertDialogFooter>
            <AlertDialogCancel onClick={() => setResetConfirmText('')}>Cancel</AlertDialogCancel>
            <AlertDialogAction
              disabled={resetConfirmText.trim() !== 'RESET' || isResetting}
              onClick={handleReset}
              className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
            >
              {isResetting ? 'Resetting…' : 'Reset all paid invoices'}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}

const VIEW_LABEL: Record<ViewId, string> = {
  attention: 'attention',
  ready: 'ready',
  sent: 'sent',
  overdue: 'overdue',
  paid: 'paid',
  void: 'voided',
};

// ── Bulk "Change type" dropdown (BulkAction is single-click; this needs a menu) ──
function ChangeTypeBulkMenu({ onChange }: { onChange: (type: 'CONTRACT' | 'SPOT') => void }) {
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <button
          type="button"
          className="focus-ring h-9 px-3 rounded-lg inline-flex items-center gap-1.5 text-[12.5px] font-medium text-white bg-transparent cursor-pointer transition-colors duration-[var(--dur-fast)] ease-[var(--ease-out)] hover:bg-white/10"
        >
          <WIcon name="file-text" size={14} />
          <span>Change type</span>
          <span className="opacity-70 text-[10px]">▾</span>
        </button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start">
        <DropdownMenuItem onClick={() => onChange('CONTRACT')}>Mark as Contract</DropdownMenuItem>
        <DropdownMenuItem onClick={() => onChange('SPOT')}>Mark as Spot</DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

// ── Attention table — flat list of pre-aggregated HCR/Trip groups ──
interface AttentionGroup {
  hcr: string;
  tripNumber: string;
  count: number;
  estimatedRevenue: number;
  firstLoadDate: number;
  lastLoadDate: number;
  sampleOrderNumber: string;
}

function AttentionTable({
  groups,
  density,
  onFix,
}: {
  groups: AttentionGroup[];
  density: 'compact' | 'comfortable';
  onFix: (g: AttentionGroup) => void;
}) {
  const gridCols = '1.6fr 110px 140px 1.5fr 130px 96px';
  const rowMinH = density === 'compact' ? 44 : 56;
  const fmtDate = (t: number) =>
    new Date(t).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });

  return (
    <div className="scroll-thin flex-1 overflow-auto bg-card">
      {/* header */}
      <div
        className="grid sticky top-0 z-[2] bg-[var(--bg-surface-2)] border-b border-[var(--border-hairline)]"
        style={{ gridTemplateColumns: gridCols }}
      >
        {['HCR + Trip', 'Loads', 'Est. revenue', 'Date range', 'Sample', ''].map((h, i) => (
          <div
            key={i}
            className="px-[var(--tbl-cell-px)] py-2.5 text-[11.5px] font-semibold uppercase tracking-[0.04em] text-[var(--text-tertiary)] whitespace-nowrap"
            style={{ textAlign: i === 2 ? 'right' : 'left' }}
          >
            {h}
          </div>
        ))}
      </div>
      {/* rows */}
      {groups.map((g) => (
        <div
          key={`${g.hcr}-${g.tripNumber}`}
          className="grid items-center border-b border-[var(--border-hairline)] cursor-pointer transition-colors hover:bg-[var(--bg-row-hover)]"
          style={{ gridTemplateColumns: gridCols, minHeight: rowMinH }}
          onClick={() => onFix(g)}
        >
          <div className="px-[var(--tbl-cell-px)] py-2 min-w-0">
            <div className="num text-[13px] font-semibold text-foreground truncate">{g.hcr}</div>
            <div className="num text-[11.5px] text-[var(--text-tertiary)] truncate">Trip: {g.tripNumber}</div>
          </div>
          <div className="px-[var(--tbl-cell-px)]">
            <CountBadge n={g.count} tone="warn" />
          </div>
          <div className="px-[var(--tbl-cell-px)] num text-[12.5px] text-[var(--text-secondary)] text-right">
            {g.estimatedRevenue > 0 ? fmtUSD(g.estimatedRevenue, false) : '—'}
          </div>
          <div className="px-[var(--tbl-cell-px)] text-[12.5px] text-[var(--text-tertiary)] whitespace-nowrap">
            {fmtDate(g.firstLoadDate)} → {fmtDate(g.lastLoadDate)}
          </div>
          <div className="px-[var(--tbl-cell-px)] num text-[12.5px] text-[var(--text-secondary)] truncate">
            {g.sampleOrderNumber}
          </div>
          <div className="px-[var(--tbl-cell-px)]" onClick={(e) => e.stopPropagation()}>
            <WBtn size="xs" variant="secondary" onClick={() => onFix(g)}>
              Fix
            </WBtn>
          </div>
        </div>
      ))}
    </div>
  );
}

function EmptyAttention({ hasGroups, onGoReady }: { hasGroups: boolean; onGoReady: () => void }) {
  return (
    <div className="flex-1 flex items-center justify-center bg-card">
      <div className="text-center max-w-sm px-6">
        <span className="inline-flex items-center justify-center rounded-2xl bg-[rgba(16,185,129,0.10)] text-[#0F8C5F] mb-3.5" style={{ height: 52, width: 52 }}>
          <WIcon name="badge-check" size={26} />
        </span>
        <div className="text-[16px] font-semibold text-foreground">All caught up</div>
        <div className="text-[13px] text-[var(--text-tertiary)] mt-1.5 leading-[19px]">
          {hasGroups
            ? 'No load groups match these filters.'
            : 'Every delivered load has a contract lane and is ready to bill. New exceptions land here automatically as loads complete.'}
        </div>
        {!hasGroups && (
          <div className="mt-4 flex justify-center">
            <WBtn size="sm" variant="primary" leading="arrow-right" onClick={onGoReady}>
              Go to ready to invoice
            </WBtn>
          </div>
        )}
      </div>
    </div>
  );
}

// ── date preset bridge (FilterBar 'date' chip → createdAt bounds) ──
const DAY_MS = 86_400_000;
const startOfDay = (t: number) => {
  const d = new Date(t);
  d.setHours(0, 0, 0, 0);
  return d.getTime();
};
const endOfDay = (t: number) => {
  const d = new Date(t);
  d.setHours(23, 59, 59, 999);
  return d.getTime();
};
function rangeForDatePreset(preset?: string): { start: number; end: number } | undefined {
  if (!preset) return undefined;
  const custom = parseDateRangeValue(preset);
  if (custom) return { start: startOfDay(custom.from.getTime()), end: endOfDay(custom.to.getTime()) };
  const now = Date.now();
  const todayStart = startOfDay(now);
  const todayEnd = endOfDay(now);
  switch (preset) {
    case 'Today':
      return { start: todayStart, end: todayEnd };
    case 'Last 7 days':
      return { start: todayStart - 6 * DAY_MS, end: todayEnd };
    case 'Last 30 days':
      return { start: todayStart - 29 * DAY_MS, end: todayEnd };
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
