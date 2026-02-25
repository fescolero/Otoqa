'use client';

import { useState, useMemo, useCallback } from 'react';
import { useQuery } from 'convex/react';
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
  Info
} from 'lucide-react';
import { FixLaneModal } from './fix-lane-modal';
import { InvoicePreviewSheet } from './invoice-preview-sheet';
import { FloatingActionBar } from './floating-action-bar';
import { InvoiceFilterBar, FilterState } from './invoice-filter-bar';
import { useKeyboardNavigation } from './use-keyboard-navigation';
import { useBulkActions } from './use-bulk-actions';
import { KeyboardShortcutsDialog } from './keyboard-shortcuts-dialog';
import { VirtualizedInvoiceTable } from './virtualized-invoice-table';
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

  const draftInvoices = useQuery(
    api.invoices.listInvoices,
    activeTab === 'draft' ? {
      workosOrgId: organizationId,
      status: 'DRAFT',
      limit: 50, // ✅ Reduced from 1000 to 50 (95% read reduction)
      search: debouncedSearch || undefined, // ✅ Use debounced search
      hcr: filters.hcr,
      trip: filters.trip,
      loadType: filters.loadType,
      dateRangeStart: filters.dateRange?.start,
      dateRangeEnd: filters.dateRange?.end,
    } : 'skip'
  );

  const pendingInvoices = useQuery(
    api.invoices.listInvoices,
    activeTab === 'pending' ? {
      workosOrgId: organizationId,
      status: 'PENDING_PAYMENT',
      limit: 50, // ✅ Reduced from 1000 to 50 (95% read reduction)
      search: debouncedSearch || undefined, // ✅ Use debounced search
      hcr: filters.hcr,
      trip: filters.trip,
      loadType: filters.loadType,
      dateRangeStart: filters.dateRange?.start,
      dateRangeEnd: filters.dateRange?.end,
    } : 'skip'
  );

  const paidInvoices = useQuery(
    api.invoices.listInvoices,
    activeTab === 'paid' ? {
      workosOrgId: organizationId,
      status: 'PAID',
      limit: 50, // ✅ Reduced from 1000 to 50 (95% read reduction)
      search: debouncedSearch || undefined, // ✅ Use debounced search
      hcr: filters.hcr,
      trip: filters.trip,
      loadType: filters.loadType,
      dateRangeStart: filters.dateRange?.start,
      dateRangeEnd: filters.dateRange?.end,
    } : 'skip'
  );

  const voidInvoices = useQuery(
    api.invoices.listInvoices,
    activeTab === 'void' ? {
      workosOrgId: organizationId,
      status: 'VOID',
      limit: 50, // ✅ Reduced from 1000 to 50 (95% read reduction)
      search: debouncedSearch || undefined, // ✅ Use debounced search
      hcr: filters.hcr,
      trip: filters.trip,
      loadType: filters.loadType,
      dateRangeStart: filters.dateRange?.start,
      dateRangeEnd: filters.dateRange?.end,
    } : 'skip'
  );
  
  // Get current tab's invoices with client-side filtering as fallback
  const currentInvoices = useMemo(() => {
    let invoices: any[] = [];
    switch (activeTab) {
      case 'draft': invoices = draftInvoices || []; break;
      case 'pending': invoices = pendingInvoices || []; break;
      case 'paid': invoices = paidInvoices || []; break;
      case 'void': invoices = voidInvoices || []; break;
      default: invoices = [];
    }
    
    // Client-side filtering as fallback for any filters not handled by backend
    return invoices.filter(inv => {
      // Search filter (case-insensitive)
      if (filters.search) {
        const searchLower = filters.search.toLowerCase();
        const matchesSearch = 
          inv.invoiceNumber?.toLowerCase().includes(searchLower) ||
          inv.load?.orderNumber?.toLowerCase().includes(searchLower) ||
          inv.customer?.name?.toLowerCase().includes(searchLower);
        if (!matchesSearch) return false;
      }
      
      // HCR filter
      if (filters.hcr && inv.load?.parsedHcr !== filters.hcr) {
        return false;
      }
      
      // Trip filter
      if (filters.trip && inv.load?.parsedTripNumber !== filters.trip) {
        return false;
      }
      
      // Load type filter
      if (filters.loadType) {
        const invoiceLoadType = inv.load?.loadType || 'UNMAPPED';
        if (invoiceLoadType !== filters.loadType) return false;
      }
      
      // Date range filter
      if (filters.dateRange) {
        const invoiceDate = inv._creationTime;
        if (invoiceDate < filters.dateRange.start || invoiceDate > filters.dateRange.end) {
          return false;
        }
      }
      
      return true;
    });
  }, [activeTab, draftInvoices, pendingInvoices, paidInvoices, voidInvoices, filters]);
  
  // Extract unique HCRs and Trips from current invoices
  const availableHCRs = useMemo(() => {
    const hcrs = new Set<string>();
    currentInvoices.forEach(inv => {
      if (inv.load?.parsedHcr) hcrs.add(inv.load.parsedHcr);
    });
    return Array.from(hcrs).sort();
  }, [currentInvoices]);
  
  const availableTrips = useMemo(() => {
    const trips = new Set<string>();
    currentInvoices.forEach(inv => {
      if (inv.load?.parsedTripNumber) trips.add(inv.load.parsedTripNumber);
    });
    return Array.from(trips).sort();
  }, [currentInvoices]);
  
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
                  {/* Alert banner for instructions */}
                  <div className="flex-shrink-0 p-4 border-b">
                    <Alert>
                      <Info className="h-4 w-4" />
                      <AlertDescription>
                        These loads need contract lanes. Define a contract to backfill invoices or void to discard.
                      </AlertDescription>
                    </Alert>
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
    </div>
  );
}
