'use client';

import React, { useState, useMemo, useEffect } from 'react';
import { useQuery, useMutation } from 'convex/react';
import { api } from '@/convex/_generated/api';
import { Card } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Tabs, TabsList, TabsTrigger } from '@/components/ui/tabs';
import Link from 'next/link';
import { Id } from '@/convex/_generated/dataModel';
import { 
  Plus, 
  Package,
  Clock,
  Truck,
  CheckCircle2,
  Ban,
} from 'lucide-react';
import { LoadFilterBar, LoadFilterState } from './loads/load-filter-bar';
import { VirtualizedLoadsTable } from './loads/virtualized-loads-table';
import { FloatingActionBar } from './loads/floating-action-bar';
import { BulkActionResolutionModal } from './loads/bulk-action-resolution-modal';
import { CancellationReasonModal, CancellationReasonCode } from './loads/cancellation-reason-modal';
import { toast } from 'sonner';
import { formatDateOnly } from '@/lib/format-date-timezone';
import { useDebounce } from '@/hooks/use-debounce';

interface LoadsTableProps {
  organizationId: string;
  userId: string;
}

export function LoadsTable({ organizationId, userId }: LoadsTableProps) {
  const [activeTab, setActiveTab] = useState<string>('all');
  const [selectedLoadIds, setSelectedLoadIds] = useState<Set<Id<'loadInformation'>>>(new Set());
  const [focusedRowIndex, setFocusedRowIndex] = useState<number | null>(null);
  const [filters, setFilters] = useState<LoadFilterState>({
    search: '',
  });

  // Bulk action modal state
  const [showResolutionModal, setShowResolutionModal] = useState(false);
  const [showCancellationModal, setShowCancellationModal] = useState(false);
  const [pendingTargetStatus, setPendingTargetStatus] = useState<'Open' | 'Assigned' | 'Delivered' | 'Canceled' | null>(null);
  const [validationResult, setValidationResult] = useState<any>(null);
  const [isValidating, setIsValidating] = useState(false);
  const [cancellationLoads, setCancellationLoads] = useState<{ id: string; orderNumber?: string }[]>([]);

  // Fetch load counts for tab badges
  const loadCounts = useQuery(api.loads.countLoadsByStatus, {
    workosOrgId: organizationId,
  });

  // Determine status filter from tab (map UI 'Delivered' back to DB 'Completed')
  const statusFilter = activeTab === 'all' ? undefined : 
    activeTab === 'Delivered' ? 'Completed' : activeTab;

  // ✅ Debounce search input to prevent excessive queries (300ms delay)
  const debouncedSearch = useDebounce(filters.search, 300);

  // Track pagination cursor state for reactivity
  const [paginationCursor, setPaginationCursor] = useState<string | null>(null);
  
  // Force query refresh by temporarily skipping query
  const [skipQuery, setSkipQuery] = useState(false);

  // Helper to convert timestamp to YYYY-MM-DD string for Convex query
  const formatDateForQuery = (timestamp: number | undefined): string | undefined => {
    if (!timestamp) return undefined;
    const date = new Date(timestamp);
    return date.toISOString().split('T')[0]; // Returns YYYY-MM-DD
  };

  // Fetch loads with filters for active tab
  const loadsData = useQuery(
    api.loads.getLoads,
    skipQuery ? "skip" : {
      workosOrgId: organizationId,
      status: statusFilter as any,
      hcr: filters.hcr,
      tripNumber: filters.trip,
      search: debouncedSearch || undefined, // ✅ Use debounced search
      mileRange: filters.mileRange,
      startDate: formatDateForQuery(filters.dateRange?.start),
      endDate: formatDateForQuery(filters.dateRange?.end),
      paginationOpts: {
        numItems: 50, // ✅ Reduced from 1000 to 50 (95% read reduction)
        cursor: paginationCursor,
      },
    },
  );

  // Reset pagination cursor when filters change
  useEffect(() => {
    setPaginationCursor(null);
  }, [activeTab, debouncedSearch, filters.hcr, filters.trip, filters.mileRange, filters.dateRange]);

  // Mutations
  const updateLoadStatus = useMutation(api.loads.updateLoadStatus);
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
      : 'skip'
  );

  // Get current loads
  const currentLoads = loadsData?.page || [];

  // Extract unique HCRs and Trips from current loads
  const availableHCRs = useMemo(() => {
    const hcrs = new Set<string>();
    currentLoads.forEach(load => {
      if (load.parsedHcr) hcrs.add(load.parsedHcr);
    });
    return Array.from(hcrs).sort();
  }, [currentLoads]);

  const availableTrips = useMemo(() => {
    const trips = new Set<string>();
    currentLoads.forEach(load => {
      if (load.parsedTripNumber) trips.add(load.parsedTripNumber);
    });
    return Array.from(trips).sort();
  }, [currentLoads]);

  // Clear selection when changing tabs
  const handleTabChange = (value: string) => {
    setActiveTab(value);
    setSelectedLoadIds(new Set());
    setFocusedRowIndex(null);
  };

  // Selection handlers
  const handleSelectAll = (checked: boolean) => {
    if (checked) {
      setSelectedLoadIds(new Set(currentLoads.map(load => load._id)));
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
    // Map 'Completed' to 'Delivered' for display
    const displayStatus = status === 'Completed' ? 'Delivered' : status;
    switch (displayStatus) {
      case 'Delivered':
        return 'bg-green-100 text-green-800 border-green-200';
      case 'Assigned':
        return 'bg-blue-100 text-blue-800 border-blue-200';
      case 'Open':
        return 'bg-yellow-100 text-yellow-800 border-yellow-200';
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
      
      // Check for blocked transitions first
      if (validateBulkChange.blocked && validateBulkChange.blocked.length > 0) {
        const blockedReasons = validateBulkChange.blocked.map((l: any) => l.orderNumber || l.id.slice(-6)).join(', ');
        toast.error(`Cannot change status: ${validateBulkChange.blocked[0].reason}`, {
          description: `Affected loads: ${blockedReasons}`,
          duration: 5000,
        });
        // Still show modal for any safe/imminent loads
        if (validateBulkChange.safe.length > 0 || validateBulkChange.imminent.length > 0) {
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
      } else if (validateBulkChange.safe.length > 0 || validateBulkChange.imminent.length > 0) {
        // Show resolution modal
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
        status: dbStatus as any 
      });
      
      if (result.failed > 0) {
        toast.warning(`Updated ${result.success} load${result.success !== 1 ? 's' : ''} to ${pendingTargetStatus}. ${result.failed} failed.`);
      } else {
        toast.success(`Updated ${result.success} load${result.success !== 1 ? 's' : ''} to ${pendingTargetStatus}`);
      }
      setSelectedLoadIds(new Set());
      
      // ✅ Force table refresh by skipping query briefly, then re-enabling
      setPaginationCursor(null);
      setSkipQuery(true);
      setTimeout(() => setSkipQuery(false), 0);
    } catch (error) {
      console.error('Error updating status:', error);
      toast.error('Failed to update load status');
    } finally {
      setPendingTargetStatus(null);
      setValidationResult(null);
    }
  };

  // Initiate bulk status update with validation
  const handleUpdateStatus = async (status: 'Open' | 'Assigned' | 'Delivered' | 'Canceled') => {
    // Transitions that require validation:
    // - Any -> Open (unassign protection)
    // - Any -> Delivered (must have completed legs)
    // - Assigned -> Canceled (requires reason code)
    const needsValidation = 
      status === 'Open' || 
      status === 'Delivered' || 
      status === 'Canceled';

    if (needsValidation) {
      setPendingTargetStatus(status);
      setIsValidating(true);
    } else {
      // For non-destructive actions (e.g., Open -> Assigned), proceed directly
      setPendingTargetStatus(status);
      const dbStatus = status;
      try {
        const result = await bulkUpdateLoadStatus({
          loadIds: Array.from(selectedLoadIds),
          status: dbStatus as any,
        });
        
        if (result.failed > 0) {
          toast.warning(`Updated ${result.success} load${result.success !== 1 ? 's' : ''} to ${status}. ${result.failed} failed.`);
        } else {
          toast.success(`Updated ${result.success} load${result.success !== 1 ? 's' : ''} to ${status}`);
        }
        setSelectedLoadIds(new Set());
        
        // ✅ Force table refresh by skipping query briefly, then re-enabling
        setPaginationCursor(null);
        setSkipQuery(true);
        setTimeout(() => setSkipQuery(false), 0);
      } catch (error) {
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
      
      // ✅ Force table refresh by skipping query briefly, then re-enabling
      setPaginationCursor(null);
      setSkipQuery(true);
      setTimeout(() => setSkipQuery(false), 0);
    } catch (error) {
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
    const selectedLoads = currentLoads.filter(load => selectedLoadIds.has(load._id));
    console.log('Export loads:', selectedLoads);
    toast.info('Export feature coming soon!');
  };

  const handleDelete = async () => {
    if (!confirm(`Are you sure you want to delete ${selectedLoadIds.size} load(s)?`)) {
      return;
    }
    try {
      await Promise.all(
        Array.from(selectedLoadIds).map(loadId => deleteLoad({ loadId }))
      );
      toast.success(`Deleted ${selectedLoadIds.size} load${selectedLoadIds.size !== 1 ? 's' : ''}`);
      setSelectedLoadIds(new Set());
    } catch (error) {
      console.error('Error deleting loads:', error);
      toast.error('Failed to delete loads');
    }
  };

  // Map load status for display in table
  const loadsWithMappedStatus = currentLoads.map(load => ({
    ...load,
    status: load.status === 'Completed' ? 'Delivered' : load.status,
  }));

  return (
    <div className="h-full flex flex-col gap-4 p-6">
      {/* Header */}
      <div className="flex-shrink-0 flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold tracking-tight">Loads</h1>
          <p className="text-sm text-muted-foreground">Track and manage freight shipments</p>
        </div>
        <Link href="/loads/new">
          <Button size="sm">
            <Plus className="mr-2 h-4 w-4" />
            Create Load
          </Button>
        </Link>
      </div>

      {/* Tabs */}
      <Card className="flex-1 flex flex-col p-0 gap-0 overflow-hidden min-h-0">
        <Tabs value={activeTab} onValueChange={handleTabChange} className="w-full flex-1 flex flex-col gap-0 min-h-0">
          <div className="flex-shrink-0 px-4">
            <TabsList className="h-auto p-0 bg-transparent border-0">
              <TabsTrigger 
                value="all" 
                className="data-[state=active]:border-b-2 data-[state=active]:border-primary data-[state=active]:!bg-transparent data-[state=active]:!shadow-none data-[state=active]:border-l-0 data-[state=active]:border-r-0 data-[state=active]:border-t-0 rounded-none px-4 py-3 !bg-transparent !shadow-none border-0"
              >
                <Package className="mr-2 h-4 w-4" />
                All
              </TabsTrigger>
              <TabsTrigger 
                value="Open" 
                className="data-[state=active]:border-b-2 data-[state=active]:border-primary data-[state=active]:!bg-transparent data-[state=active]:!shadow-none data-[state=active]:border-l-0 data-[state=active]:border-r-0 data-[state=active]:border-t-0 rounded-none px-4 py-3 !bg-transparent !shadow-none border-0"
              >
                <Clock className="mr-2 h-4 w-4" />
                Open
                {(loadCounts?.Open || 0) > 0 && (
                  <Badge variant="secondary" className="ml-2 bg-yellow-100 text-yellow-800">
                    {loadCounts?.Open}
                  </Badge>
                )}
              </TabsTrigger>
              <TabsTrigger 
                value="Assigned" 
                className="data-[state=active]:border-b-2 data-[state=active]:border-primary data-[state=active]:!bg-transparent data-[state=active]:!shadow-none data-[state=active]:border-l-0 data-[state=active]:border-r-0 data-[state=active]:border-t-0 rounded-none px-4 py-3 !bg-transparent !shadow-none border-0"
              >
                <Truck className="mr-2 h-4 w-4" />
                Assigned
                {(loadCounts?.Assigned || 0) > 0 && (
                  <Badge variant="secondary" className="ml-2 bg-blue-100 text-blue-800">
                    {loadCounts?.Assigned}
                  </Badge>
                )}
              </TabsTrigger>
              <TabsTrigger 
                value="Delivered" 
                className="data-[state=active]:border-b-2 data-[state=active]:border-primary data-[state=active]:!bg-transparent data-[state=active]:!shadow-none data-[state=active]:border-l-0 data-[state=active]:border-r-0 data-[state=active]:border-t-0 rounded-none px-4 py-3 !bg-transparent !shadow-none border-0"
              >
                <CheckCircle2 className="mr-2 h-4 w-4" />
                Delivered
                {(loadCounts?.Delivered || 0) > 0 && (
                  <Badge variant="secondary" className="ml-2 bg-green-100 text-green-800">
                    {loadCounts?.Delivered}
                  </Badge>
                )}
              </TabsTrigger>
              <TabsTrigger 
                value="Canceled" 
                className="data-[state=active]:border-b-2 data-[state=active]:border-primary data-[state=active]:!bg-transparent data-[state=active]:!shadow-none data-[state=active]:border-l-0 data-[state=active]:border-r-0 data-[state=active]:border-t-0 rounded-none px-4 py-3 !bg-transparent !shadow-none border-0"
              >
                <Ban className="mr-2 h-4 w-4" />
                Cancelled
                {(loadCounts?.Canceled || 0) > 0 && (
                  <Badge variant="secondary" className="ml-2">
                    {loadCounts?.Canceled}
                  </Badge>
                )}
              </TabsTrigger>
            </TabsList>
          </div>

          {/* Tab Content */}
          <div className="flex-1 flex flex-col overflow-hidden min-h-0">
            {/* Filter Bar */}
            <LoadFilterBar 
              filters={filters}
              onFiltersChange={setFilters}
              availableHCRs={availableHCRs}
              availableTrips={availableTrips}
            />
            
            <div className="flex-1 p-4 overflow-hidden min-h-0 flex flex-col">
              <div className="border rounded-lg flex-1 min-h-0 overflow-hidden flex flex-col">
                {/* Floating Action Bar */}
                {selectedLoadIds.size > 0 && (
                  <FloatingActionBar
                    selectedCount={selectedLoadIds.size}
                    onBulkDownload={handleBulkDownload}
                    onUpdateStatus={handleUpdateStatus}
                    onExport={handleExport}
                    onDelete={handleDelete}
                    onClearSelection={() => setSelectedLoadIds(new Set())}
                  />
                )}
                
                {/* Virtualized Table */}
                <VirtualizedLoadsTable
                  loads={loadsWithMappedStatus as any}
                  selectedIds={selectedLoadIds}
                  focusedRowIndex={focusedRowIndex}
                  isAllSelected={isAllSelected}
                  onSelectAll={handleSelectAll}
                  onSelectRow={handleSelectRow}
                  onRowClick={(loadId) => {
                    // TODO: Open load detail modal or navigate
                    console.log('Open load:', loadId);
                  }}
                  formatDate={formatDate}
                  getStatusColor={getStatusColor}
                  getTrackingColor={getTrackingColor}
                  emptyMessage={`No ${activeTab === 'all' ? '' : activeTab.toLowerCase() + ' '}loads${filters.search ? ' matching your search' : ''}`}
                />
              </div>
            </div>
          </div>
        </Tabs>
      </Card>

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
