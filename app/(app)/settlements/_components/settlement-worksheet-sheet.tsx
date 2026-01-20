'use client';

import { useState, useEffect, useRef, useMemo } from 'react';
import { useQuery, useMutation } from 'convex/react';
import { api } from '@/convex/_generated/api';
import { Id } from '@/convex/_generated/dataModel';
import { Sheet, SheetContent, SheetTitle } from '@/components/ui/sheet';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { 
  X, 
  CheckCircle2, 
  Printer, 
  Download, 
  DollarSign, 
  Truck, 
  Package, 
  Clock,
  RefreshCw 
} from 'lucide-react';
import { PayablesList } from './payables-list';
import { AuditAlertBar } from './audit-alert-bar';
import { QuickAddMenu } from './quick-add-menu';
import { EvidencePanel } from './evidence-panel';
import { SettlementStatusBadge } from './settlement-status-badge';
import { toast } from 'sonner';
import { cn } from '@/lib/utils';

interface SettlementWorksheetSheetProps {
  settlementId: Id<'driverSettlements'> | null;
  isOpen: boolean;
  onClose: () => void;
  organizationId: string;
  userId: string;
}

interface InsightCardProps {
  label: string;
  value: string | number;
  icon: React.ReactNode;
  valueClassName?: string;
}

function InsightCard({ label, value, icon, valueClassName }: InsightCardProps) {
  return (
    <Card className="p-4 border">
      <div className="flex items-start justify-between">
        <div className="flex-1">
          <p className="text-xs text-muted-foreground mb-1">{label}</p>
          <p className={cn("text-2xl font-semibold", valueClassName)}>{value}</p>
        </div>
        <div className="text-muted-foreground">{icon}</div>
      </div>
    </Card>
  );
}

export function SettlementWorksheetSheet({
  settlementId,
  isOpen,
  onClose,
  organizationId,
  userId,
}: SettlementWorksheetSheetProps) {
  const [selectedLoadId, setSelectedLoadId] = useState<string | null>(null);
  const [auditFilter, setAuditFilter] = useState<'all' | 'pods' | 'variances' | 'receipts'>('all');
  const [totalPulse, setTotalPulse] = useState(false);
  const prevTotalRef = useRef<number | undefined>(undefined);

  // Fetch settlement details with audit flags
  const settlement = useQuery(
    api.driverSettlements.getSettlementDetails,
    settlementId ? { settlementId } : 'skip'
  );

  // Fetch selected load details
  const selectedLoad = useQuery(
    api.loads.getLoad,
    selectedLoadId ? { loadId: selectedLoadId as Id<'loadInformation'> } : 'skip'
  );

  // Clear selected load when settlement changes or drawer closes
  useEffect(() => {
    setSelectedLoadId(null);
    setAuditFilter('all');
  }, [settlementId, isOpen]);

  // Pulse animation when total changes
  useEffect(() => {
    if (settlement?.summary.totalGross !== undefined) {
      if (prevTotalRef.current !== undefined && prevTotalRef.current !== settlement.summary.totalGross) {
        setTotalPulse(true);
        setTimeout(() => setTotalPulse(false), 600);
      }
      prevTotalRef.current = settlement.summary.totalGross;
    }
  }, [settlement?.summary.totalGross]);

  // Mutations
  const updateStatus = useMutation(api.driverSettlements.updateSettlementStatus);
  const holdLoad = useMutation(api.loadHoldWorkflow.holdLoad);
  const releaseLoad = useMutation(api.loadHoldWorkflow.releaseLoad);
  const deletePayable = useMutation(api.driverSettlements.deleteManualPayable);
  const updatePayable = useMutation(api.driverSettlements.updateManualPayable);
  const refreshSettlement = useMutation(api.driverSettlements.refreshDraftSettlement);

  // Refresh state
  const [isRefreshing, setIsRefreshing] = useState(false);

  // Format helpers
  const formatCurrency = (amount: number) => {
    return new Intl.NumberFormat('en-US', {
      style: 'currency',
      currency: 'USD',
      minimumFractionDigits: 2,
    }).format(amount);
  };

  const formatDateRange = (start: number, end: number) => {
    const startDate = new Date(start);
    const endDate = new Date(end);
    const formatOptions: Intl.DateTimeFormatOptions = { month: 'short', day: 'numeric' };
    return `${startDate.toLocaleDateString('en-US', formatOptions)} - ${endDate.toLocaleDateString('en-US', formatOptions)}`;
  };

  const formatNumber = (num: number) => {
    return new Intl.NumberFormat('en-US').format(num);
  };

  // Handle approve
  const handleApprove = async () => {
    if (!settlementId) return;

    try {
      await updateStatus({
        settlementId,
        newStatus: 'APPROVED',
        userId,
      });
      toast.success('Settlement approved and locked');
      onClose();
    } catch (error) {
      toast.error('Failed to approve settlement');
      console.error(error);
    }
  };

  // Handle refresh draft
  const handleRefresh = async () => {
    if (!settlementId) return;

    setIsRefreshing(true);
    try {
      const result = await refreshSettlement({ settlementId });
      toast.success(`Statement refreshed: ${result.payablesAdded} items in this period`);
    } catch (error: any) {
      toast.error(error?.message || 'Failed to refresh settlement');
      console.error(error);
    } finally {
      setIsRefreshing(false);
    }
  };

  // Handle hold load
  const handleHoldLoad = async (loadId: string) => {
    try {
      const result = await holdLoad({
        loadId: loadId as Id<'loadInformation'>,
        reason: 'Held from settlement for review',
        userId,
      });
      
      if (result.success) {
        toast.success(result.message);
      } else {
        toast.error(result.message);
      }
    } catch (error) {
      toast.error('Failed to hold load');
      console.error(error);
    }
  };

  // Handle release load
  const handleReleaseLoad = async (loadId: string) => {
    try {
      const result = await releaseLoad({
        loadId: loadId as Id<'loadInformation'>,
        userId,
      });
      
      if (result.success) {
        toast.success(result.message);
      } else {
        toast.error(result.message);
      }
    } catch (error) {
      toast.error('Failed to release load');
      console.error(error);
    }
  };

  // Handle inline edit payable
  const handleEditPayable = async (
    payableId: Id<'loadPayables'>, 
    data: { description: string; quantity: number; rate: number; isRebillable: boolean }
  ) => {
    try {
      await updatePayable({
        payableId,
        description: data.description,
        quantity: data.quantity,
        rate: data.rate,
        isRebillable: data.isRebillable,
      });
      toast.success('Adjustment updated');
    } catch (error: any) {
      toast.error(error?.message || 'Failed to update adjustment');
      console.error(error);
    }
  };

  // Handle delete payable
  const handleDeletePayable = async (payableId: Id<'loadPayables'>) => {
    console.log('handleDeletePayable called with:', payableId);
    
    if (!window.confirm('Are you sure you want to delete this manual adjustment?')) {
      console.log('User cancelled deletion');
      return;
    }

    try {
      console.log('Calling deletePayable mutation...');
      const result = await deletePayable({ payableId });
      console.log('Delete result:', result);
      toast.success('Manual adjustment deleted');
    } catch (error: any) {
      console.error('Delete error:', error);
      toast.error(error?.message || 'Failed to delete adjustment');
    }
  };

  // Handle print
  const handlePrint = () => {
    window.print();
  };

  // Create audit flags sets for efficient lookup
  const auditFlagsSets = useMemo(() => {
    if (!settlement?.auditFlags) {
      return { 
        missingPodLoadIds: new Set<string>(), 
        varianceLoadIds: new Set<string>(),
        missingReceiptPayableIds: new Set<string>(),
      };
    }
    
    const missingPodLoadIds = new Set<string>(
      settlement.auditFlags.missingPods.map((p) => p.loadId)
    );
    const varianceLoadIds = new Set<string>(
      settlement.auditFlags.mileageVariances.map((v) => v.loadId)
    );
    const missingReceiptPayableIds = new Set<string>(
      settlement.auditFlags.missingReceipts.map((r) => r.payableId)
    );
    
    return { missingPodLoadIds, varianceLoadIds, missingReceiptPayableIds };
  }, [settlement?.auditFlags]);

  // Filter payables based on audit filter
  const filteredPayables = settlement?.payables.filter((payable) => {
    if (auditFilter === 'all') return true;
    
    if (auditFilter === 'pods') {
      return settlement.auditFlags.missingPods.some(
        (pod) => pod.loadId === payable.loadId
      );
    }
    
    if (auditFilter === 'variances') {
      return settlement.auditFlags.mileageVariances.some(
        (variance) => variance.loadId === payable.loadId
      );
    }
    
    if (auditFilter === 'receipts') {
      return settlement.auditFlags.missingReceipts.some(
        (receipt) => receipt.payableId === payable._id
      );
    }
    
    return true;
  });

  return (
    <Sheet open={isOpen} onOpenChange={(open) => !open && onClose()}>
      <SheetContent 
        className="w-full sm:max-w-[90vw] lg:max-w-6xl p-0"
        onOpenAutoFocus={(e) => e.preventDefault()}
      >
        <div className="h-full flex flex-col">
          {/* Toolbar */}
          <div className="h-14 border-b bg-background flex items-center justify-between px-6 shrink-0">
            <div className="flex items-center gap-3">
              <SheetTitle className="text-sm font-medium">
                Settlement Worksheet
              </SheetTitle>
              {settlement && (
                <div className="flex items-center gap-2">
                  <span className="text-muted-foreground text-sm font-mono">
                    {settlement.settlement.statementNumber}
                  </span>
                  <SettlementStatusBadge status={settlement.settlement.status} />
                  {/* Pay Plan Badge */}
                  {settlement.settlement.payPlanName && (
                    <Badge variant="outline" className="bg-slate-50 text-slate-600 text-[10px] font-normal border-slate-200">
                      {settlement.settlement.payPlanName}
                    </Badge>
                  )}
                  {/* Period Label */}
                  {settlement.settlement.periodNumber && (
                    <span className="text-xs text-muted-foreground">
                      Period {settlement.settlement.periodNumber} • {formatDateRange(
                        settlement.settlement.periodStart,
                        settlement.settlement.periodEnd
                      )}
                    </span>
                  )}
                </div>
              )}
            </div>

            <div className="flex items-center gap-2">
              <Button variant="outline" size="sm" onClick={handlePrint}>
                <Printer className="w-4 h-4 mr-2" />
                Print
              </Button>

              {settlement?.settlement.status === 'DRAFT' && (
                <>
                  <Button 
                    variant="outline" 
                    size="sm" 
                    onClick={handleRefresh}
                    disabled={isRefreshing}
                  >
                    <RefreshCw className={cn("w-4 h-4 mr-2", isRefreshing && "animate-spin")} />
                    {isRefreshing ? 'Refreshing...' : 'Refresh'}
                  </Button>
                  <Button size="sm" onClick={handleApprove}>
                    <CheckCircle2 className="w-4 h-4 mr-2" />
                    Approve
                  </Button>
                </>
              )}
              
              {settlement?.settlement.status === 'APPROVED' && (
                <Button size="sm" className="bg-green-600 hover:bg-green-700">
                  <DollarSign className="w-4 h-4 mr-2" />
                  Mark as Paid
                </Button>
              )}
              
              {settlement?.settlement.status === 'PAID' && (
                <Button size="sm" variant="outline">
                  <Download className="w-4 h-4 mr-2" />
                  Download Statement
                </Button>
              )}

              <Button variant="ghost" size="icon" onClick={onClose} className="h-8 w-8">
                <X className="h-4 w-4" />
              </Button>
            </div>
          </div>
          
          {/* Payment Metadata Banner - Only for PAID status */}
          {settlement?.settlement.status === 'PAID' && (
            <div className="px-6 py-2 bg-green-50 border-b border-green-100">
              <p className="text-[11px] text-green-700">
                <CheckCircle2 className="w-3.5 h-3.5 inline-block mr-1.5 -mt-0.5" />
                Paid on {settlement.settlement.paidAt 
                  ? new Date(settlement.settlement.paidAt).toLocaleDateString('en-US', { month: 'short', day: '2-digit', year: 'numeric' })
                  : 'Jan 03, 2026'
                } via {settlement.settlement.paidMethod || 'ACH'} 
                {settlement.settlement.paidReference && ` • Ref: #${settlement.settlement.paidReference}`}
              </p>
            </div>
          )}

          {/* Content: 70/30 Split */}
          <div className="flex-1 flex overflow-hidden">
            {/* Left Panel: The Worksheet (70%) */}
            <div className="flex-1 flex flex-col overflow-hidden border-r">
              {settlement ? (
                <>
                  {/* Summary Cards */}
                  <div className="p-6 border-b bg-slate-50/30 shrink-0">
                    <div className="grid grid-cols-4 gap-4">
                      <div className={cn(
                        "transition-all duration-300",
                        totalPulse && "ring-2 ring-green-400 ring-opacity-50 rounded-lg"
                      )}>
                        <InsightCard
                          label="Gross Pay"
                          value={formatCurrency(settlement.summary.totalGross)}
                          icon={<DollarSign className="w-5 h-5" />}
                          valueClassName={cn(
                            "text-green-600 transition-all duration-300",
                            totalPulse && "text-green-700 scale-105"
                          )}
                        />
                      </div>
                      <InsightCard
                        label="Total Miles"
                        value={formatNumber(settlement.summary.totalMiles)}
                        icon={<Truck className="w-5 h-5" />}
                      />
                      <InsightCard
                        label="Load Count"
                        value={settlement.summary.uniqueLoads}
                        icon={<Package className="w-5 h-5" />}
                      />
                      <InsightCard
                        label="Total Hours"
                        value={`${(settlement.summary.totalHours || 0).toFixed(1)} hrs`}
                        icon={<Clock className="w-5 h-5" />}
                      />
                    </div>

                    {/* Driver Info */}
                    <div className="mt-4 flex items-center gap-2">
                      <span className="text-sm font-medium">
                        {settlement.driver.firstName} {settlement.driver.lastName}
                      </span>
                      <span className="text-sm text-muted-foreground">•</span>
                      <span className="text-sm text-muted-foreground">
                        {new Date(settlement.settlement.periodStart).toLocaleDateString()} -{' '}
                        {new Date(settlement.settlement.periodEnd).toLocaleDateString()}
                      </span>
                    </div>
                  </div>

                  {/* Audit Alert Bar */}
                  <AuditAlertBar
                    auditFlags={settlement.auditFlags}
                    onFilterChange={setAuditFilter}
                  />

                  {/* Payables List (Grouped) - Bottom safe area for breathing room */}
                  <div className="flex-1 overflow-auto px-4 pb-32">
                    <PayablesList
                      payables={filteredPayables || settlement.payables}
                      onHoldLoad={handleHoldLoad}
                      onReleaseLoad={handleReleaseLoad}
                      onViewLoad={(loadId) => setSelectedLoadId(loadId)}
                      onEditPayable={handleEditPayable}
                      onDeletePayable={handleDeletePayable}
                      isDraft={settlement.settlement.status === 'DRAFT'}
                      isLocked={settlement.settlement.status === 'APPROVED' || settlement.settlement.status === 'PAID'}
                      selectedLoadId={selectedLoadId}
                      auditFlags={auditFlagsSets}
                    />

                    {/* Held Loads Section - Distinct "Waiting Room" styling */}
                    {settlement.heldPayables && settlement.heldPayables.length > 0 && (
                      <div className="mt-16 -mx-4 px-4 py-6 bg-amber-50/30 border-t-2 border-amber-200/50 rounded-b-lg">
                        <div className="flex items-center justify-between mb-4">
                          <div>
                            <h3 className="text-sm font-semibold text-amber-800">
                              Held for Next Period
                            </h3>
                            <p className="text-[11px] text-amber-600/80 mt-0.5">
                              These loads will be included in the next settlement
                            </p>
                          </div>
                          <Badge className="text-[10px] bg-amber-100 text-amber-700 border-amber-200">
                            {settlement.heldPayables.length} load{settlement.heldPayables.length > 1 ? 's' : ''} on hold
                          </Badge>
                        </div>
                        <PayablesList
                          payables={settlement.heldPayables}
                          onHoldLoad={handleHoldLoad}
                          onReleaseLoad={handleReleaseLoad}
                          onViewLoad={(loadId) => setSelectedLoadId(loadId)}
                          onEditPayable={handleEditPayable}
                          onDeletePayable={handleDeletePayable}
                          isHeldSection={true}
                          isDraft={settlement.settlement.status === 'DRAFT'}
                          isLocked={settlement.settlement.status === 'APPROVED' || settlement.settlement.status === 'PAID'}
                          selectedLoadId={selectedLoadId}
                          auditFlags={auditFlagsSets}
                        />
                      </div>
                    )}
                  </div>

                  {/* Quick Add Section */}
                  {settlement.settlement.status === 'DRAFT' && (
                    <div className="border-t p-4 bg-background shrink-0">
                      <QuickAddMenu
                        settlementId={settlement.settlement._id}
                        driverId={settlement.settlement.driverId}
                        organizationId={organizationId}
                        userId={userId}
                        onSuccess={() => {
                          // Refetch will happen automatically via Convex reactivity
                          toast.success('Adjustment added');
                        }}
                      />
                    </div>
                  )}
                </>
              ) : (
                <div className="flex items-center justify-center h-full">
                  <p className="text-muted-foreground">Loading settlement...</p>
                </div>
              )}
            </div>

            {/* Right Panel: Evidence Panel (30%) */}
            <div className="w-80 flex flex-col overflow-hidden bg-slate-50/30">
              <EvidencePanel
                selectedLoad={selectedLoad || null}
                onUploadPOD={(loadId) => toast.info('POD upload coming soon')}
                onUploadReceipt={(loadId) => toast.info('Receipt upload coming soon')}
                isLocked={settlement?.settlement.status === 'PAID'}
              />
            </div>
          </div>
        </div>
      </SheetContent>
    </Sheet>
  );
}

