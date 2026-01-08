'use client';

import { useState, useMemo } from 'react';
import { useQuery, useMutation } from 'convex/react';
import { api } from '@/convex/_generated/api';
import { Id } from '@/convex/_generated/dataModel';
import { Card } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Tabs, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { 
  Plus, 
  FileText,
  FileEdit,
  Clock,
  CheckCircle2,
  Wallet,
  Download,
  Trash2,
  AlertTriangle,
  Calendar,
  ChevronDown,
  Ban,
} from 'lucide-react';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { VirtualizedSettlementTable } from './virtualized-settlement-table';
import { SettlementWorksheetSheet } from './settlement-worksheet-sheet';
import { SettlementFilterBar, SettlementFilterState } from './settlement-filter-bar';
import { GenerateStatementsModal } from './generate-statements-modal';
import { FloatingActionBar } from '@/app/(app)/invoices/_components/floating-action-bar';
import { toast } from 'sonner';
import { cn } from '@/lib/utils';
import { useDebounce } from '@/hooks/use-debounce';

interface SettlementsDashboardProps {
  organizationId: string;
  userId: string;
}

export function SettlementsDashboard({ organizationId, userId }: SettlementsDashboardProps) {
  const [activeTab, setActiveTab] = useState<string>('all');
  const [previewSettlementId, setPreviewSettlementId] = useState<Id<'driverSettlements'> | null>(null);
  const [selectedSettlementIds, setSelectedSettlementIds] = useState<Set<Id<'driverSettlements'>>>(new Set());
  const [focusedRowIndex, setFocusedRowIndex] = useState<number | null>(null);
  const [generateModalOpen, setGenerateModalOpen] = useState(false);
  const [filters, setFilters] = useState<SettlementFilterState>({
    search: '',
    payPlanId: undefined,
  });

  // Debounce search for performance
  const debouncedSearch = useDebounce(filters.search, 300);

  // Fetch all settlements for the organization (with optional Pay Plan filter)
  const allSettlements = useQuery(api.driverSettlements.listForOrganization, {
    workosOrgId: organizationId,
    payPlanId: filters.payPlanId as Id<'payPlans'> | undefined,
  });

  // Fetch all drivers for the org
  const drivers = useQuery(api.drivers.list, {
    organizationId,
  });

  // Fetch all pay plans for the org
  const payPlans = useQuery(api.payPlans.list, {
    workosOrgId: organizationId,
  });

  // Group settlements by status for tabs
  const settlementsByStatus = useMemo(() => {
    if (!allSettlements) return { all: [], draft: [], pending: [], approved: [], paid: [], void: [] };

    const grouped = {
      all: allSettlements,
      draft: allSettlements.filter((s) => s.status === 'DRAFT'),
      pending: allSettlements.filter((s) => s.status === 'PENDING'),
      approved: allSettlements.filter((s) => s.status === 'APPROVED'),
      paid: allSettlements.filter((s) => s.status === 'PAID'),
      void: allSettlements.filter((s) => s.status === 'VOID'),
    };

    return grouped;
  }, [allSettlements]);

  // Get current tab settlements
  const currentTabSettlements = settlementsByStatus[activeTab as keyof typeof settlementsByStatus] || [];

  // Apply filters to settlements
  const filteredSettlements = useMemo(() => {
    let filtered = [...currentTabSettlements];

    // Search filter
    if (debouncedSearch) {
      const search = debouncedSearch.toLowerCase();
      filtered = filtered.filter((s) => {
        const driver = drivers?.find((d) => d._id === s.driverId);
        const driverName = driver ? `${driver.firstName} ${driver.lastName}`.toLowerCase() : '';
        return (
          s.statementNumber?.toLowerCase().includes(search) ||
          driverName.includes(search)
        );
      });
    }

    // Driver filter
    if (filters.driverId) {
      filtered = filtered.filter((s) => s.driverId === filters.driverId);
    }

    // Status filter (if not on 'all' tab)
    if (filters.status && activeTab === 'all') {
      filtered = filtered.filter((s) => s.status === filters.status);
    }

    // Date range filter
    if (filters.dateRange) {
      filtered = filtered.filter((s) => {
        return s.periodStart >= filters.dateRange!.start && s.periodEnd <= filters.dateRange!.end;
      });
    }

    return filtered;
  }, [currentTabSettlements, debouncedSearch, filters, drivers, activeTab]);

  // Enrich settlements with display fields - backend now provides driverName, periodLabel, hasAuditWarnings
  const enrichedSettlements = useMemo(() => {
    return filteredSettlements.map((settlement) => {
      return {
        _id: settlement._id,
        statementNumber: settlement.statementNumber,
        driverId: settlement.driverId,
        driverName: settlement.driverName || 'Unknown Driver',
        periodStart: settlement.periodStart,
        periodEnd: settlement.periodEnd,
        periodLabel: settlement.periodLabel || '',
        payPlanName: settlement.payPlanName,
        status: settlement.status,
        grossTotal: settlement.grossTotal,
        totalLoads: settlement.totalLoads,
        hasWarnings: settlement.hasAuditWarnings || false,
        warningCount: settlement.hasAuditWarnings ? 1 : 0, // Simplified for dashboard
      };
    });
  }, [filteredSettlements]);

  // Clear selection when changing tabs
  const handleTabChange = (value: string) => {
    setActiveTab(value);
    setSelectedSettlementIds(new Set());
    setFocusedRowIndex(null);
  };

  // Selection handlers
  const handleSelectAll = (checked: boolean) => {
    if (checked) {
      setSelectedSettlementIds(new Set(enrichedSettlements.map((s) => s._id)));
    } else {
      setSelectedSettlementIds(new Set());
    }
  };

  const handleSelectRow = (id: Id<'driverSettlements'>, checked: boolean) => {
    const newSelected = new Set(selectedSettlementIds);
    if (checked) {
      newSelected.add(id);
    } else {
      newSelected.delete(id);
    }
    setSelectedSettlementIds(newSelected);
  };

  // Format helpers
  const formatDateRange = (start: number, end: number) => {
    const startDate = new Date(start);
    const endDate = new Date(end);
    const format = (d: Date) => d.toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
    return `${format(startDate)} - ${format(endDate)}`;
  };

  const formatCurrency = (amount: number) => {
    return new Intl.NumberFormat('en-US', {
      style: 'currency',
      currency: 'USD',
      minimumFractionDigits: 2,
    }).format(amount);
  };

  // Generate statements mutations
  const generateStatement = useMutation(api.driverSettlements.generateStatement);
  const bulkGenerateByPlan = useMutation(api.driverSettlements.bulkGenerateByPlan);
  const updateSettlementStatus = useMutation(api.driverSettlements.updateSettlementStatus);
  const deleteSettlement = useMutation(api.driverSettlements.deleteSettlement);

  // Handle generate statements for all drivers
  const handleGenerateStatements = async () => {
    if (!drivers || drivers.length === 0) {
      toast.error('No drivers found in organization');
      return;
    }

    try {
      toast.info('Generating statements for all drivers...');
      
      const now = Date.now();
      const oneWeekAgo = now - 7 * 24 * 60 * 60 * 1000;

      // Generate statements for each driver
      const results = await Promise.all(
        drivers.map((driver) =>
          generateStatement({
            driverId: driver._id,
            periodStart: oneWeekAgo,
            periodEnd: now,
            workosOrgId: organizationId,
            userId: userId,
          }).catch((err) => ({
            error: true,
            driverId: driver._id,
            message: err.message,
          }))
        )
      );

      const successful = results.filter((r: any) => !r.error).length;
      const failed = results.filter((r: any) => r.error).length;

      if (successful > 0) {
        toast.success(`Generated ${successful} statement${successful > 1 ? 's' : ''}`);
      }
      if (failed > 0) {
        toast.error(`Failed to generate ${failed} statement${failed > 1 ? 's' : ''}`);
      }
    } catch (error: any) {
      toast.error(`Error generating statements: ${error.message}`);
    }
  };

  // Handle generate statements by Pay Plan (bulk)
  const handleGenerateByPlan = async (planId: string, planName: string) => {
    try {
      toast.info(`Generating statements for "${planName}" plan...`);
      
      const result = await bulkGenerateByPlan({
        planId: planId as any,
        workosOrgId: organizationId,
        userId,
      });

      if (result.success > 0) {
        toast.success(`Generated ${result.success} statement${result.success > 1 ? 's' : ''} for "${planName}"`);
      }
      if (result.failed > 0) {
        toast.error(`Failed to generate ${result.failed} statement${result.failed > 1 ? 's' : ''}`);
      }
    } catch (error: any) {
      toast.error(`Error: ${error.message}`);
    }
  };

  // Bulk actions
  const handleBulkApprove = async () => {
    if (selectedSettlementIds.size === 0) return;
    
    toast.info(`Approving ${selectedSettlementIds.size} settlements...`);
    
    let success = 0;
    let failed = 0;
    
    for (const settlementId of selectedSettlementIds) {
      try {
        await updateSettlementStatus({
          settlementId,
          newStatus: 'APPROVED',
          userId,
        });
        success++;
      } catch (error) {
        failed++;
      }
    }
    
    if (success > 0) {
      toast.success(`Approved ${success} settlement${success > 1 ? 's' : ''}`);
    }
    if (failed > 0) {
      toast.error(`Failed to approve ${failed} settlement${failed > 1 ? 's' : ''}`);
    }
    
    setSelectedSettlementIds(new Set());
  };

  const handleBulkVoid = async () => {
    if (selectedSettlementIds.size === 0) return;
    
    // Confirm before voiding
    const confirmed = window.confirm(
      `Are you sure you want to void ${selectedSettlementIds.size} settlement${selectedSettlementIds.size > 1 ? 's' : ''}? This action cannot be undone.`
    );
    
    if (!confirmed) return;
    
    toast.info(`Voiding ${selectedSettlementIds.size} settlements...`);
    
    let success = 0;
    let failed = 0;
    
    for (const settlementId of selectedSettlementIds) {
      try {
        await updateSettlementStatus({
          settlementId,
          newStatus: 'VOID',
          userId,
          voidReason: 'Bulk void action',
        });
        success++;
      } catch (error) {
        failed++;
      }
    }
    
    if (success > 0) {
      toast.success(`Voided ${success} settlement${success > 1 ? 's' : ''}`);
    }
    if (failed > 0) {
      toast.error(`Failed to void ${failed} settlement${failed > 1 ? 's' : ''}`);
    }
    
    setSelectedSettlementIds(new Set());
  };

  const handleBulkDownload = async () => {
    toast.info(`Downloading ${selectedSettlementIds.size} settlements...`);
    // TODO: Implement bulk download - will need PDF generation
  };

  const handleBulkDelete = async () => {
    if (selectedSettlementIds.size === 0) return;
    
    // Confirm before deleting
    const confirmed = window.confirm(
      `Are you sure you want to permanently delete ${selectedSettlementIds.size} voided settlement${selectedSettlementIds.size > 1 ? 's' : ''}? This action cannot be undone and will unassign all payables.`
    );
    
    if (!confirmed) return;
    
    toast.info(`Deleting ${selectedSettlementIds.size} settlements...`);
    
    let success = 0;
    let failed = 0;
    
    for (const settlementId of selectedSettlementIds) {
      try {
        await deleteSettlement({ settlementId });
        success++;
      } catch (error) {
        failed++;
      }
    }
    
    if (success > 0) {
      toast.success(`Deleted ${success} settlement${success > 1 ? 's' : ''}`);
    }
    if (failed > 0) {
      toast.error(`Failed to delete ${failed} settlement${failed > 1 ? 's' : ''}`);
    }
    
    setSelectedSettlementIds(new Set());
  };

  return (
    <div className="h-full flex flex-col gap-4 p-6">
      {/* Header */}
      <div className="flex-shrink-0 flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold tracking-tight">Driver Settlements</h1>
          <p className="text-sm text-muted-foreground">Manage and audit driver pay statements</p>
        </div>
        <Button onClick={() => setGenerateModalOpen(true)}>
          <Plus className="mr-2 h-4 w-4" />
          Generate Statements
        </Button>

        {/* Generate Statements Modal */}
        <GenerateStatementsModal
          open={generateModalOpen}
          onOpenChange={setGenerateModalOpen}
          organizationId={organizationId}
          userId={userId}
        />
      </div>

      {/* Main Card with Tabs */}
      <Card className="flex-1 flex flex-col p-0 gap-0 overflow-hidden min-h-0">
        <Tabs value={activeTab} onValueChange={handleTabChange} className="w-full flex-1 flex flex-col gap-0 min-h-0">
          {/* Pill-Style Tabs */}
          <div className="flex-shrink-0 px-4">
            <TabsList className="h-auto p-0 bg-transparent border-0">
              <TabsTrigger 
                value="all" 
                className="data-[state=active]:border-b-2 data-[state=active]:border-primary data-[state=active]:!bg-transparent data-[state=active]:!shadow-none data-[state=active]:border-l-0 data-[state=active]:border-r-0 data-[state=active]:border-t-0 rounded-none px-4 py-3 !bg-transparent !shadow-none border-0"
              >
                <FileText className="mr-2 h-4 w-4" />
                All
                {settlementsByStatus.all.length > 0 && (
                  <Badge variant="secondary" className="ml-2">
                    {settlementsByStatus.all.length}
                  </Badge>
                )}
              </TabsTrigger>
              <TabsTrigger 
                value="draft" 
                className="data-[state=active]:border-b-2 data-[state=active]:border-primary data-[state=active]:!bg-transparent data-[state=active]:!shadow-none data-[state=active]:border-l-0 data-[state=active]:border-r-0 data-[state=active]:border-t-0 rounded-none px-4 py-3 !bg-transparent !shadow-none border-0"
              >
                <FileEdit className="mr-2 h-4 w-4" />
                Draft
                {settlementsByStatus.draft.length > 0 && (
                  <Badge variant="secondary" className="ml-2 bg-slate-100 text-slate-800">
                    {settlementsByStatus.draft.length}
                  </Badge>
                )}
              </TabsTrigger>
              <TabsTrigger 
                value="pending" 
                className="data-[state=active]:border-b-2 data-[state=active]:border-primary data-[state=active]:!bg-transparent data-[state=active]:!shadow-none data-[state=active]:border-l-0 data-[state=active]:border-r-0 data-[state=active]:border-t-0 rounded-none px-4 py-3 !bg-transparent !shadow-none border-0"
              >
                <Clock className="mr-2 h-4 w-4" />
                Pending
                {settlementsByStatus.pending.length > 0 && (
                  <Badge variant="secondary" className="ml-2 bg-amber-100 text-amber-800">
                    {settlementsByStatus.pending.length}
                  </Badge>
                )}
              </TabsTrigger>
              <TabsTrigger 
                value="approved" 
                className="data-[state=active]:border-b-2 data-[state=active]:border-primary data-[state=active]:!bg-transparent data-[state=active]:!shadow-none data-[state=active]:border-l-0 data-[state=active]:border-r-0 data-[state=active]:border-t-0 rounded-none px-4 py-3 !bg-transparent !shadow-none border-0"
              >
                <CheckCircle2 className="mr-2 h-4 w-4" />
                Approved
                {settlementsByStatus.approved.length > 0 && (
                  <Badge variant="secondary" className="ml-2 bg-blue-100 text-blue-800">
                    {settlementsByStatus.approved.length}
                  </Badge>
                )}
              </TabsTrigger>
              <TabsTrigger 
                value="paid" 
                className="data-[state=active]:border-b-2 data-[state=active]:border-primary data-[state=active]:!bg-transparent data-[state=active]:!shadow-none data-[state=active]:border-l-0 data-[state=active]:border-r-0 data-[state=active]:border-t-0 rounded-none px-4 py-3 !bg-transparent !shadow-none border-0"
              >
                <Wallet className="mr-2 h-4 w-4" />
                Paid
                {settlementsByStatus.paid.length > 0 && (
                  <Badge variant="secondary" className="ml-2 bg-green-100 text-green-800">
                    {settlementsByStatus.paid.length}
                  </Badge>
                )}
              </TabsTrigger>
              <TabsTrigger 
                value="void" 
                className="data-[state=active]:border-b-2 data-[state=active]:border-primary data-[state=active]:!bg-transparent data-[state=active]:!shadow-none data-[state=active]:border-l-0 data-[state=active]:border-r-0 data-[state=active]:border-t-0 rounded-none px-4 py-3 !bg-transparent !shadow-none border-0"
              >
                <Ban className="mr-2 h-4 w-4" />
                Void
                {settlementsByStatus.void.length > 0 && (
                  <Badge variant="secondary" className="ml-2 bg-red-100 text-red-800">
                    {settlementsByStatus.void.length}
                  </Badge>
                )}
              </TabsTrigger>
            </TabsList>
          </div>

          {/* Tab Content */}
          <div className="flex-1 flex flex-col overflow-hidden min-h-0">
            {/* Pro-Filter Bar */}
            <SettlementFilterBar 
              filters={filters}
              onFiltersChange={setFilters}
              drivers={drivers?.map(d => ({ 
                _id: d._id, 
                firstName: d.firstName, 
                lastName: d.lastName 
              })) || []}
              payPlans={payPlans?.map(p => ({
                _id: p._id,
                name: p.name,
              })) || []}
            />
            
            <div className="flex-1 p-4 overflow-hidden min-h-0 flex flex-col">
              <div className="border rounded-lg flex-1 min-h-0 overflow-hidden flex flex-col">
                {/* Floating Action Bar */}
                {selectedSettlementIds.size > 0 && (
                  <FloatingActionBar
                    selectedCount={selectedSettlementIds.size}
                    onBulkDownload={handleBulkDownload}
                    onMarkAsPaid={handleBulkApprove}
                    onVoid={handleBulkVoid}
                    onChangeType={() => {}}
                    onClearSelection={() => setSelectedSettlementIds(new Set())}
                    itemType="Settlement"
                    customActions={
                      <>
                        <Button
                          size="sm"
                          variant="ghost"
                          onClick={handleBulkDownload}
                          className="h-8 text-slate-700 hover:bg-slate-50 hover:text-blue-600 transition-colors font-medium"
                        >
                          <Download className="w-4 h-4 mr-2" strokeWidth={2} />
                          Download
                        </Button>

                        <div className="w-[1px] h-4 bg-slate-200 mx-2" />

                        <Button
                          size="sm"
                          variant="ghost"
                          onClick={handleBulkApprove}
                          className="h-8 text-slate-700 hover:bg-slate-50 hover:text-blue-600 transition-colors font-medium"
                        >
                          <CheckCircle2 className="w-4 h-4 mr-2" strokeWidth={2} />
                          Approve
                        </Button>

                        <div className="w-[1px] h-6 bg-slate-200 mx-2" />

                        <Button
                          size="sm"
                          variant="ghost"
                          onClick={handleBulkVoid}
                          className="h-8 text-slate-700 hover:bg-slate-50 hover:text-red-600 transition-colors font-medium"
                        >
                          <Ban className="w-4 h-4 mr-2" strokeWidth={2} />
                          Void
                        </Button>

                        {/* Delete button - only show on Void tab */}
                        {activeTab === 'void' && (
                          <>
                            <div className="w-[1px] h-6 bg-slate-200 mx-2" />
                            <Button
                              size="sm"
                              variant="ghost"
                              onClick={handleBulkDelete}
                              className="h-8 text-red-600 hover:bg-red-50 hover:text-red-700 transition-colors font-medium"
                            >
                              <Trash2 className="w-4 h-4 mr-2" strokeWidth={2} />
                              Delete Permanently
                            </Button>
                          </>
                        )}
                      </>
                    }
                  />
                )}
                
                {/* Virtualized Table */}
                <VirtualizedSettlementTable
                  settlements={enrichedSettlements}
                  selectedIds={selectedSettlementIds}
                  focusedRowIndex={focusedRowIndex}
                  isAllSelected={enrichedSettlements.length > 0 && selectedSettlementIds.size === enrichedSettlements.length}
                  onSelectAll={handleSelectAll}
                  onSelectRow={handleSelectRow}
                  onRowClick={(id) => setPreviewSettlementId(id)}
                  formatDateRange={formatDateRange}
                  formatCurrency={formatCurrency}
                  emptyMessage={`No ${activeTab === 'all' ? '' : activeTab + ' '}settlements${filters.search ? ' matching your search' : ''}`}
                />
              </div>
            </div>
          </div>
        </Tabs>
      </Card>

      {/* Interactive Worksheet Drawer */}
      <SettlementWorksheetSheet
        settlementId={previewSettlementId}
        isOpen={!!previewSettlementId}
        onClose={() => setPreviewSettlementId(null)}
        organizationId={organizationId}
        userId={userId}
      />
    </div>
  );
}
