'use client';

import { useState, useMemo, useCallback, useEffect, useRef, startTransition } from 'react';
import { useQuery, useMutation, usePaginatedQuery } from 'convex/react';
import { useAuthQuery } from '@/hooks/use-auth-query';
import { api } from '@/convex/_generated/api';
import { Id } from '@/convex/_generated/dataModel';
import { Card } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { Tabs, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { 
  AlertCircle, 
  FileText, 
  DollarSign, 
  CheckCircle2, 
  Ban,
  Info,
  Upload,
  RotateCcw,
} from 'lucide-react';
import { toast } from 'sonner';
import { FixLaneModal } from './fix-lane-modal';
import { InvoicePreviewSheet } from './invoice-preview-sheet';
import { FloatingActionBar } from './floating-action-bar';
import { InvoiceFilterBar, FilterState } from './invoice-filter-bar';
import { useKeyboardNavigation } from './use-keyboard-navigation';
import { useBulkActions } from './use-bulk-actions';
import { KeyboardShortcutsDialog } from './keyboard-shortcuts-dialog';
import { VirtualizedInvoiceTable } from './virtualized-invoice-table';
import { PaymentCsvImportDialog } from './payment-csv-import-dialog';
import { useDebounce } from '@/hooks/use-debounce';

interface InvoicesDashboardProps {
  organizationId: string;
  userId: string;
}

export function InvoicesDashboard({ organizationId, userId }: InvoicesDashboardProps) {
  const [activeTab, setActiveTab] = useState<string>('attention');
  const [selectedGroup, setSelectedGroup] = useState<any>(null);
  const [previewInvoiceId, setPreviewInvoiceId] = useState<Id<"loadInvoices"> | null>(null);
  const [isPreviewOpen, setIsPreviewOpen] = useState(false);
  const [pendingPreviewAction, setPendingPreviewAction] = useState<'print' | 'download' | null>(null);
  const [isPaymentImportOpen, setIsPaymentImportOpen] = useState(false);
  const [isResetting, setIsResetting] = useState(false);
  const [isRePromoting, setIsRePromoting] = useState(false);
  const resetPaidToDraft = useMutation(api.invoices.resetPaidToDraft);
  const rePromoteStuckLoads = useMutation(api.lanes.rePromoteStuckLoads);
  
  // Multi-select state
  const [selectedInvoiceIds, setSelectedInvoiceIds] = useState<Set<Id<"loadInvoices">>>(new Set());
  const [focusedRowIndex, setFocusedRowIndex] = useState<number | null>(null);
  
  // Filter state
  const [filters, setFilters] = useState<FilterState>({
    search: '',
  });
  
  // Attention tab filter state
  const [attentionFilters, setAttentionFilters] = useState<FilterState>({
    search: '',
  });

  // ✅ Debounce search inputs to prevent excessive queries (300ms delay)
  const debouncedSearch = useDebounce(filters.search, 300);
  const debouncedAttentionSearch = useDebounce(attentionFilters.search, 300);

  // Fetch data
  const invoiceCounts = useAuthQuery(api.invoices.countInvoicesByStatus, {
    workosOrgId: organizationId,
  });

  const allUnmappedGroups = useAuthQuery(api.analytics.getUnmappedLoadGroups, {
    workosOrgId: organizationId,
  });
  
  // Filter unmapped groups based on attention filters
  const unmappedGroups = useMemo(() => {
    if (!allUnmappedGroups) return [];
    
    return allUnmappedGroups.filter(group => {
      // Search filter (using debounced search)
      if (debouncedAttentionSearch) {
        const searchLower = debouncedAttentionSearch.toLowerCase();
        const matchesSearch = 
          group.hcr?.toLowerCase().includes(searchLower) ||
          group.tripNumber?.toLowerCase().includes(searchLower) ||
          group.sampleOrderNumber?.toLowerCase().includes(searchLower);
        if (!matchesSearch) return false;
      }
      
      // HCR filter
      if (attentionFilters.hcr && group.hcr !== attentionFilters.hcr) {
        return false;
      }
      
      // Trip filter
      if (attentionFilters.trip && group.tripNumber !== attentionFilters.trip) {
        return false;
      }
      
      return true;
    });
  }, [allUnmappedGroups, debouncedAttentionSearch, attentionFilters.hcr, attentionFilters.trip]);

  // Map tab names to invoice statuses
  const statusForTab = (tab: string) => {
    switch (tab) {
      case 'draft': return 'DRAFT' as const;
      case 'pending': return 'PENDING_PAYMENT' as const;
      case 'paid': return 'PAID' as const;
      case 'void': return 'VOID' as const;
      default: return null;
    }
  };

  const currentStatus = statusForTab(activeTab);

  // Paginated invoice query — only runs for the active tab
  const {
    results: paginatedInvoices,
    status: paginationStatus,
    loadMore,
  } = usePaginatedQuery(
    api.invoices.listInvoices,
    currentStatus ? {
      workosOrgId: organizationId,
      status: currentStatus,
      search: debouncedSearch || undefined,
      hcr: filters.hcr,
      trip: filters.trip,
      loadType: filters.loadType,
      dateRangeStart: filters.dateRange?.start,
      dateRangeEnd: filters.dateRange?.end,
    } : 'skip',
    { initialNumItems: 100 }
  );

  // Distinct filter values from ALL invoices (not just loaded page)
  const filterOptions = useQuery(
    api.invoices.getFilterOptions,
    currentStatus ? {
      workosOrgId: organizationId,
      status: currentStatus,
    } : 'skip'
  );

  // Compatibility shims so the rest of the component keeps working
  const draftInvoices = activeTab === 'draft' ? paginatedInvoices : undefined;
  const pendingInvoices = activeTab === 'pending' ? paginatedInvoices : undefined;
  const paidInvoices = activeTab === 'paid' ? paginatedInvoices : undefined;
  const voidInvoices = activeTab === 'void' ? paginatedInvoices : undefined;

  // Current invoices — all filtering is done server-side via paginated query
  const currentInvoices = useMemo(() => {
    if (activeTab === 'attention') return [];
    return paginatedInvoices ?? [];
  }, [activeTab, paginatedInvoices]);

  // Filter options from server (all distinct HCRs/Trips for this status)
  const availableHCRs = filterOptions?.hcrs ?? [];
  const availableTrips = filterOptions?.trips ?? [];
  
  // Extract unique HCRs and Trips from unmapped groups for attention tab
  const attentionAvailableHCRs = useMemo(() => {
    if (!allUnmappedGroups) return [];
    const hcrs = new Set<string>();
    allUnmappedGroups.forEach(group => {
      if (group.hcr) hcrs.add(group.hcr);
    });
    return Array.from(hcrs).sort();
  }, [allUnmappedGroups]);
  
  const attentionAvailableTrips = useMemo(() => {
    if (!allUnmappedGroups) return [];
    const trips = new Set<string>();
    allUnmappedGroups.forEach(group => {
      if (group.tripNumber) trips.add(group.tripNumber);
    });
    return Array.from(trips).sort();
  }, [allUnmappedGroups]);
  
  // Clear selection when changing tabs
  const handleTabChange = (value: string) => {
    setActiveTab(value);
    setSelectedInvoiceIds(new Set());
    setFocusedRowIndex(null);
  };
  
  // Bulk actions hook
  const bulkActions = useBulkActions(organizationId, userId, () => {
    setSelectedInvoiceIds(new Set());
  });
  
  // Selection handlers
  const handleSelectAll = (checked: boolean) => {
    if (checked) {
      setSelectedInvoiceIds(new Set(currentInvoices.map(inv => inv._id)));
    } else {
      setSelectedInvoiceIds(new Set());
    }
  };
  
  const handleSelectRow = (invoiceId: Id<'loadInvoices'>, checked: boolean) => {
    const newSelected = new Set(selectedInvoiceIds);
    if (checked) {
      newSelected.add(invoiceId);
    } else {
      newSelected.delete(invoiceId);
    }
    setSelectedInvoiceIds(newSelected);
  };
  
  const isAllSelected = currentInvoices.length > 0 && selectedInvoiceIds.size === currentInvoices.length;
  const isSomeSelected = selectedInvoiceIds.size > 0 && selectedInvoiceIds.size < currentInvoices.length;

  const handleRowDownload = useCallback((invoiceId: Id<'loadInvoices'>) => {
    setPreviewInvoiceId(invoiceId);
    setIsPreviewOpen(false);
    setPendingPreviewAction('download');
  }, []);

  const handleRowPrint = useCallback((invoiceId: Id<'loadInvoices'>) => {
    setPreviewInvoiceId(invoiceId);
    setIsPreviewOpen(false);
    setPendingPreviewAction('print');
  }, []);

  const handleLoadMore = useCallback(() => {
    if (paginationStatus === 'CanLoadMore') {
      startTransition(() => loadMore(100));
    }
  }, [paginationStatus, loadMore]);

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
    if (!isPreviewOpen) {
      setPreviewInvoiceId(null);
    }
  }, [isPreviewOpen]);

  // Keyboard navigation hook
  useKeyboardNavigation({
    invoices: currentInvoices,
    selectedIds: selectedInvoiceIds,
    setSelectedIds: setSelectedInvoiceIds,
    focusedRowIndex,
    setFocusedRowIndex,
    onOpenPreview: handlePreviewOpen,
    isSheetOpen: isPreviewOpen,
  });
  const formatDate = (timestamp: number) => {
    const date = new Date(timestamp);
    return date.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
  };

  const formatCurrency = (amount: number) => {
    return new Intl.NumberFormat('en-US', {
      style: 'currency',
      currency: 'USD',
    }).format(amount);
  };

  return (
    <div className="h-full flex flex-col gap-4 p-6">
      {/* Header */}
      <div className="flex-shrink-0 flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold tracking-tight">Invoices</h1>
          <p className="text-sm text-muted-foreground">Manage billing and resolve unmapped loads</p>
        </div>
        <div className="flex items-center gap-2">
          <Button
            variant="outline"
            size="sm"
            className="text-destructive border-destructive/30 hover:bg-destructive/10"
            disabled={isResetting}
            onClick={async () => {
              if (!confirm('This will reset ALL paid invoices back to DRAFT so they can be re-imported with proper line items. Continue?')) return;
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
              }
            }}
          >
            <RotateCcw className={`mr-2 h-4 w-4 ${isResetting ? 'animate-spin' : ''}`} />
            {isResetting ? 'Resetting...' : 'Reset Paid → Draft'}
          </Button>
          <Button
            variant="outline"
            size="sm"
            onClick={() => setIsPaymentImportOpen(true)}
          >
            <Upload className="mr-2 h-4 w-4" />
            Import Payments
          </Button>
        </div>
      </div>

      {/* Tabs */}
      <Card className="flex-1 flex flex-col p-0 gap-0 overflow-hidden min-h-0">
        <Tabs value={activeTab} onValueChange={handleTabChange} className="w-full flex-1 flex flex-col gap-0 min-h-0">
          <div className="flex-shrink-0 px-4">
            <TabsList className="h-auto p-0 bg-transparent border-0">
              <TabsTrigger 
                value="attention" 
                className="data-[state=active]:border-b-2 data-[state=active]:border-red-500 data-[state=active]:!bg-transparent data-[state=active]:!shadow-none data-[state=active]:border-l-0 data-[state=active]:border-r-0 data-[state=active]:border-t-0 rounded-none px-4 py-3 !bg-transparent !shadow-none border-0"
              >
                <AlertCircle className="mr-2 h-4 w-4" />
                Attention
                {(unmappedGroups?.length || 0) > 0 && (
                  <Badge variant="destructive" className="ml-2">
                    {unmappedGroups?.length}
                  </Badge>
                )}
              </TabsTrigger>
              <TabsTrigger 
                value="draft" 
                className="data-[state=active]:border-b-2 data-[state=active]:border-primary data-[state=active]:!bg-transparent data-[state=active]:!shadow-none data-[state=active]:border-l-0 data-[state=active]:border-r-0 data-[state=active]:border-t-0 rounded-none px-4 py-3 !bg-transparent !shadow-none border-0"
              >
                <FileText className="mr-2 h-4 w-4" />
                Draft
                {(invoiceCounts?.DRAFT || 0) > 0 && (
                  <Badge variant="secondary" className="ml-2">
                    {invoiceCounts?.DRAFT}
                  </Badge>
                )}
              </TabsTrigger>
              <TabsTrigger 
                value="pending" 
                className="data-[state=active]:border-b-2 data-[state=active]:border-primary data-[state=active]:!bg-transparent data-[state=active]:!shadow-none data-[state=active]:border-l-0 data-[state=active]:border-r-0 data-[state=active]:border-t-0 rounded-none px-4 py-3 !bg-transparent !shadow-none border-0"
              >
                <DollarSign className="mr-2 h-4 w-4" />
                Pending
                {(invoiceCounts?.PENDING_PAYMENT || 0) > 0 && (
                  <Badge variant="secondary" className="ml-2">
                    {invoiceCounts?.PENDING_PAYMENT}
                  </Badge>
                )}
              </TabsTrigger>
              <TabsTrigger 
                value="paid" 
                className="data-[state=active]:border-b-2 data-[state=active]:border-primary data-[state=active]:!bg-transparent data-[state=active]:!shadow-none data-[state=active]:border-l-0 data-[state=active]:border-r-0 data-[state=active]:border-t-0 rounded-none px-4 py-3 !bg-transparent !shadow-none border-0"
              >
                <CheckCircle2 className="mr-2 h-4 w-4" />
                Paid
                {(invoiceCounts?.PAID || 0) > 0 && (
                  <Badge variant="secondary" className="ml-2">
                    {invoiceCounts?.PAID}
                  </Badge>
                )}
              </TabsTrigger>
              <TabsTrigger 
                value="void" 
                className="data-[state=active]:border-b-2 data-[state=active]:border-primary data-[state=active]:!bg-transparent data-[state=active]:!shadow-none data-[state=active]:border-l-0 data-[state=active]:border-r-0 data-[state=active]:border-t-0 rounded-none px-4 py-3 !bg-transparent !shadow-none border-0"
              >
                <Ban className="mr-2 h-4 w-4" />
                Void
                {(invoiceCounts?.VOID || 0) > 0 && (
                  <Badge variant="secondary" className="ml-2">
                    {invoiceCounts?.VOID}
                  </Badge>
                )}
              </TabsTrigger>
            </TabsList>
          </div>

          {/* Attention Tab Content */}
          {activeTab === 'attention' && (
            <div className="flex-1 flex flex-col overflow-hidden min-h-0">
              {/* Filter Bar */}
              <InvoiceFilterBar 
                filters={attentionFilters}
                onFiltersChange={setAttentionFilters}
                availableHCRs={attentionAvailableHCRs}
                availableTrips={attentionAvailableTrips}
              />
              
              <div className="flex-1 p-4 overflow-hidden min-h-0 flex flex-col">
                <div className="border rounded-lg flex-1 min-h-0 overflow-hidden flex flex-col">
                  {/* Alert banner with re-promote action */}
                  <div className="flex-shrink-0 p-4 border-b flex items-center justify-between gap-4">
                    <Alert className="flex-1">
                      <Info className="h-4 w-4" />
                      <AlertDescription>
                        These loads need contract lanes. Define a contract to backfill invoices or void to discard.
                      </AlertDescription>
                    </Alert>
                    <Button
                      variant="outline"
                      size="sm"
                      disabled={isRePromoting}
                      onClick={async () => {
                        setIsRePromoting(true);
                        try {
                          let totalPromoted = 0;
                          let hasMore = true;
                          while (hasMore) {
                            const result = await rePromoteStuckLoads({ workosOrgId: organizationId, batchSize: 50 });
                            totalPromoted += result.promoted;
                            hasMore = result.hasMore && result.promoted > 0;
                          }
                          if (totalPromoted > 0) {
                            toast.success(`Re-promoted ${totalPromoted} loads from Attention → Draft`);
                          } else {
                            toast.info('No stuck loads found — all loads either lack a matching lane or are already promoted');
                          }
                        } catch (err) {
                          toast.error('Failed to re-promote loads');
                          console.error(err);
                        } finally {
                          setIsRePromoting(false);
                        }
                      }}
                      className="shrink-0"
                    >
                      <RotateCcw className={`mr-2 h-4 w-4 ${isRePromoting ? 'animate-spin' : ''}`} />
                      {isRePromoting ? 'Re-matching...' : 'Re-match Lanes'}
                    </Button>
                  </div>
                  
                  {/* Fixed Header */}
                  <div className="flex-shrink-0 border-b bg-background">
                    <div className="flex items-center h-10 w-full">
                      <div className="px-4 flex-[2] font-medium text-muted-foreground text-sm">HCR + Trip</div>
                      <div className="px-4 flex-1 font-medium text-muted-foreground text-sm">Load Count</div>
                      <div className="px-4 flex-1 font-medium text-muted-foreground text-sm text-right">Est. Revenue</div>
                      <div className="px-4 flex-[2] font-medium text-muted-foreground text-sm">Date Range</div>
                      <div className="px-4 flex-1 font-medium text-muted-foreground text-sm">Sample</div>
                      <div className="px-4 w-20"></div>
                    </div>
                  </div>
                  
                  {/* Scrollable Body */}
                  <div className="flex-1 overflow-auto min-h-0">
                    {unmappedGroups && unmappedGroups.length > 0 ? (
                      unmappedGroups.map((group) => {
                        const groupKey = `${group.hcr}-${group.tripNumber}`;
                        
                        return (
                          <div
                            key={groupKey}
                            className="h-[48px] hover:bg-slate-50/80 transition-colors group border-b flex items-center"
                          >
                            <div className="px-4 flex-[2]">
                              <div className="font-mono text-sm">
                                <div className="font-semibold">{group.hcr}</div>
                                <div className="text-muted-foreground">Trip: {group.tripNumber}</div>
                              </div>
                            </div>
                            <div className="px-4 flex-1">
                              <Badge variant="secondary" className="font-semibold">
                                {group.count} loads
                              </Badge>
                            </div>
                            <div className="px-4 flex-1 font-semibold text-sm text-right">
                              {formatCurrency(group.estimatedRevenue)}
                            </div>
                            <div className="px-4 flex-[2] text-sm text-muted-foreground">
                              {formatDate(group.firstLoadDate)} → {formatDate(group.lastLoadDate)}
                            </div>
                            <div className="px-4 flex-1 text-sm font-mono">
                              {group.sampleOrderNumber}
                            </div>
                            <div className="px-4 w-20">
                              <Button
                                size="sm"
                                onClick={() => setSelectedGroup(group)}
                              >
                                Fix
                              </Button>
                            </div>
                          </div>
                        );
                      })
                    ) : (
                      <div className="flex items-center justify-center py-8 text-muted-foreground">
                        <div className="text-center">
                          <CheckCircle2 className="h-8 w-8 mx-auto mb-2 text-green-500" />
                          <p className="font-medium">All loads mapped!</p>
                          <p className="text-sm">No attention needed at this time</p>
                        </div>
                      </div>
                    )}
                  </div>
                </div>
              </div>
            </div>
          )}

          {/* Draft Tab Content */}
          {activeTab === 'draft' && (
            <div className="flex-1 flex flex-col overflow-hidden min-h-0">
              {/* Filter Bar */}
              <InvoiceFilterBar 
                filters={filters}
                onFiltersChange={setFilters}
                availableHCRs={availableHCRs}
                availableTrips={availableTrips}
              />
              
              <div className="flex-1 p-4 overflow-hidden min-h-0 flex flex-col">
                <div className="border rounded-lg flex-1 min-h-0 overflow-hidden flex flex-col">
                  {/* Contextual Header - shown when rows are selected */}
                  {selectedInvoiceIds.size > 0 && (
                    <FloatingActionBar
                      selectedCount={selectedInvoiceIds.size}
                      onBulkDownload={() => bulkActions.handleBulkDownload(Array.from(selectedInvoiceIds))}
                      onMarkAsPaid={() => bulkActions.handleMarkAsPaid(Array.from(selectedInvoiceIds))}
                      onVoid={() => bulkActions.handleVoid(Array.from(selectedInvoiceIds))}
                      onChangeType={(type) => bulkActions.handleChangeType(Array.from(selectedInvoiceIds), type)}
                      onClearSelection={() => setSelectedInvoiceIds(new Set())}
                    />
                  )}
                  
                  <VirtualizedInvoiceTable
                    invoices={currentInvoices as any}
                    selectedIds={selectedInvoiceIds}
                    focusedRowIndex={focusedRowIndex}
                    isAllSelected={isAllSelected}
                    isSomeSelected={isSomeSelected}
                    onSelectAll={handleSelectAll}
                    onSelectRow={handleSelectRow}
                    onRowClick={handlePreviewOpen}
                    onDownload={handleRowDownload}
                    onPrint={handleRowPrint}
                    formatDate={formatDate}
                    formatCurrency={formatCurrency}
                    emptyMessage={`No draft invoices${filters.search ? ' matching your search' : ''}`}
                    onLoadMore={handleLoadMore}
                    canLoadMore={paginationStatus === 'CanLoadMore'}
                    isLoadingMore={paginationStatus === 'LoadingMore'}
                  />
                </div>
              </div>
            </div>
          )}

          {/* Pending Tab Content */}
          {activeTab === 'pending' && (
            <div className="flex-1 flex flex-col overflow-hidden min-h-0">
              {/* Filter Bar */}
              <InvoiceFilterBar 
                filters={filters}
                onFiltersChange={setFilters}
                availableHCRs={availableHCRs}
                availableTrips={availableTrips}
              />
              
              <div className="flex-1 p-4 overflow-hidden min-h-0 flex flex-col">
                <div className="border rounded-lg flex-1 min-h-0 overflow-hidden flex flex-col">
                  {/* Contextual Header - shown when rows are selected */}
                  {selectedInvoiceIds.size > 0 && (
                    <FloatingActionBar
                      selectedCount={selectedInvoiceIds.size}
                      onBulkDownload={() => bulkActions.handleBulkDownload(Array.from(selectedInvoiceIds))}
                      onMarkAsPaid={() => bulkActions.handleMarkAsPaid(Array.from(selectedInvoiceIds))}
                      onVoid={() => bulkActions.handleVoid(Array.from(selectedInvoiceIds))}
                      onChangeType={(type) => bulkActions.handleChangeType(Array.from(selectedInvoiceIds), type)}
                      onClearSelection={() => setSelectedInvoiceIds(new Set())}
                    />
                  )}
                  
                  <VirtualizedInvoiceTable
                    invoices={currentInvoices as any}
                    selectedIds={selectedInvoiceIds}
                    focusedRowIndex={focusedRowIndex}
                    isAllSelected={isAllSelected}
                    isSomeSelected={isSomeSelected}
                    onSelectAll={handleSelectAll}
                    onSelectRow={handleSelectRow}
                    onRowClick={handlePreviewOpen}
                    onDownload={handleRowDownload}
                    onPrint={handleRowPrint}
                    formatDate={formatDate}
                    formatCurrency={formatCurrency}
                    emptyMessage={`No pending invoices${filters.search ? ' matching your search' : ''}`}
                    onLoadMore={handleLoadMore}
                    canLoadMore={paginationStatus === 'CanLoadMore'}
                    isLoadingMore={paginationStatus === 'LoadingMore'}
                  />
                </div>
              </div>
            </div>
          )}

          {/* Paid Tab Content */}
          {activeTab === 'paid' && (
            <div className="flex-1 flex flex-col overflow-hidden min-h-0">
              {/* Filter Bar */}
              <InvoiceFilterBar 
                filters={filters}
                onFiltersChange={setFilters}
                availableHCRs={availableHCRs}
                availableTrips={availableTrips}
              />
              
              <div className="flex-1 p-4 overflow-hidden min-h-0 flex flex-col">
                <div className="border rounded-lg flex-1 min-h-0 overflow-hidden flex flex-col">
                  {/* Contextual Header - shown when rows are selected */}
                  {selectedInvoiceIds.size > 0 && (
                    <FloatingActionBar
                      selectedCount={selectedInvoiceIds.size}
                      onBulkDownload={() => bulkActions.handleBulkDownload(Array.from(selectedInvoiceIds))}
                      onMarkAsPaid={() => bulkActions.handleMarkAsPaid(Array.from(selectedInvoiceIds))}
                      onVoid={() => bulkActions.handleVoid(Array.from(selectedInvoiceIds))}
                      onChangeType={(type) => bulkActions.handleChangeType(Array.from(selectedInvoiceIds), type)}
                      onClearSelection={() => setSelectedInvoiceIds(new Set())}
                    />
                  )}
                  
                  <VirtualizedInvoiceTable
                    invoices={currentInvoices as any}
                    selectedIds={selectedInvoiceIds}
                    focusedRowIndex={focusedRowIndex}
                    isAllSelected={isAllSelected}
                    isSomeSelected={isSomeSelected}
                    onSelectAll={handleSelectAll}
                    onSelectRow={handleSelectRow}
                    onRowClick={handlePreviewOpen}
                    onDownload={handleRowDownload}
                    onPrint={handleRowPrint}
                    formatDate={formatDate}
                    formatCurrency={formatCurrency}
                    emptyMessage={`No paid invoices${filters.search ? ' matching your search' : ''}`}
                    onLoadMore={handleLoadMore}
                    canLoadMore={paginationStatus === 'CanLoadMore'}
                    isLoadingMore={paginationStatus === 'LoadingMore'}
                  />
                </div>
              </div>
            </div>
          )}

          {/* Void Tab Content */}
          {activeTab === 'void' && (
            <div className="flex-1 flex flex-col overflow-hidden min-h-0">
              {/* Filter Bar */}
              <InvoiceFilterBar 
                filters={filters}
                onFiltersChange={setFilters}
                availableHCRs={availableHCRs}
                availableTrips={availableTrips}
              />
              
              <div className="flex-1 p-4 overflow-hidden min-h-0 flex flex-col">
                <div className="border rounded-lg flex-1 min-h-0 overflow-hidden flex flex-col">
                  {/* Contextual Header - shown when rows are selected */}
                  {selectedInvoiceIds.size > 0 && (
                    <FloatingActionBar
                      selectedCount={selectedInvoiceIds.size}
                      onBulkDownload={() => bulkActions.handleBulkDownload(Array.from(selectedInvoiceIds))}
                      onMarkAsPaid={() => bulkActions.handleMarkAsPaid(Array.from(selectedInvoiceIds))}
                      onVoid={() => bulkActions.handleVoid(Array.from(selectedInvoiceIds))}
                      onChangeType={(type) => bulkActions.handleChangeType(Array.from(selectedInvoiceIds), type)}
                      onClearSelection={() => setSelectedInvoiceIds(new Set())}
                    />
                  )}
                  
                  <VirtualizedInvoiceTable
                    invoices={currentInvoices as any}
                    selectedIds={selectedInvoiceIds}
                    focusedRowIndex={focusedRowIndex}
                    isAllSelected={isAllSelected}
                    isSomeSelected={isSomeSelected}
                    onSelectAll={handleSelectAll}
                    onSelectRow={handleSelectRow}
                    onRowClick={handlePreviewOpen}
                    onDownload={handleRowDownload}
                    onPrint={handleRowPrint}
                    formatDate={formatDate}
                    formatCurrency={formatCurrency}
                    emptyMessage={`No voided invoices${filters.search ? ' matching your search' : ''}`}
                    onLoadMore={handleLoadMore}
                    canLoadMore={paginationStatus === 'CanLoadMore'}
                    isLoadingMore={paginationStatus === 'LoadingMore'}
                  />
                </div>
              </div>
            </div>
          )}
        </Tabs>
      </Card>

      {/* Invoice Preview Sheet */}
      <InvoicePreviewSheet 
        invoiceId={previewInvoiceId}
        isOpen={isPreviewOpen}
        onClose={handlePreviewClose}
        allInvoiceIds={currentInvoices.map(inv => inv._id)}
        onNavigate={handlePreviewOpen}
        autoAction={pendingPreviewAction}
        onAutoActionHandled={handleAutoActionHandled}
      />

      {/* Fix Lane Modal */}
      {selectedGroup && (
        <FixLaneModal
          group={selectedGroup}
          organizationId={organizationId}
          userId={userId}
          onClose={() => setSelectedGroup(null)}
        />
      )}
      
      {/* Keyboard Shortcuts Dialog */}
      <KeyboardShortcutsDialog />

      {/* Payment CSV Import Dialog */}
      <PaymentCsvImportDialog
        open={isPaymentImportOpen}
        onOpenChange={setIsPaymentImportOpen}
        workosOrgId={organizationId}
        userId={userId}
      />
    </div>
  );
}
