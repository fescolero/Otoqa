'use client';

import { useState, useEffect } from 'react';
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogFooter,
  DialogDescription,
} from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Switch } from '@/components/ui/switch';
import { Checkbox } from '@/components/ui/checkbox';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { 
  Collapsible, 
  CollapsibleContent, 
  CollapsibleTrigger 
} from '@/components/ui/collapsible';
import { ScrollArea } from '@/components/ui/scroll-area';
import { Loader2, AlertCircle, CheckCircle2, Trash2, DollarSign, Users, ArrowRight, ChevronDown } from 'lucide-react';
import { useMutation, useQuery } from 'convex/react';
import { api } from '@/convex/_generated/api';
import { Badge } from '@/components/ui/badge';
import { Separator } from '@/components/ui/separator';
import { Textarea } from '@/components/ui/textarea';
import { Id } from '@/convex/_generated/dataModel';

interface FixLaneModalProps {
  group: any;
  organizationId: string;
  userId: string;
  onClose: () => void;
}

export function FixLaneModal({ group, organizationId, userId, onClose }: FixLaneModalProps) {
  // Form state
  const [customerName, setCustomerName] = useState('');
  const [customerId, setCustomerId] = useState<Id<'customers'> | undefined>(undefined);
  const [contractName, setContractName] = useState('');
  const [contractStartDate, setContractStartDate] = useState('');
  const [contractEndDate, setContractEndDate] = useState('');
  const [rate, setRate] = useState('');
  const [rateType, setRateType] = useState<'Per Mile' | 'Flat Rate' | 'Per Stop'>('Flat Rate');
  const [currency, setCurrency] = useState<'USD' | 'CAD' | 'MXN'>('USD');
  const [fuelSurchargeType, setFuelSurchargeType] = useState<'PERCENTAGE' | 'FLAT' | 'DOE_INDEX' | undefined>(undefined);
  const [fuelSurchargeValue, setFuelSurchargeValue] = useState('');
  const [stopOffRate, setStopOffRate] = useState('');
  const [includedStops, setIncludedStops] = useState('2');
  const [isWildcard, setIsWildcard] = useState(false);
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [showVoidDialog, setShowVoidDialog] = useState(false);
  const [voidReason, setVoidReason] = useState('');
  const [showAdvanced, setShowAdvanced] = useState(false);

  // Selected loads for granular control
  const [selectedLoadIds, setSelectedLoadIds] = useState<Id<'loadInformation'>[]>([]);

  // Fetch customers
  const customers = useQuery(api.customers.getCustomers, {
    workosOrgId: organizationId,
  });

  // Fetch preview
  const preview = useQuery(
    api.lanes.previewBackfillImpact,
    contractStartDate && contractEndDate
      ? {
          workosOrgId: organizationId,
          hcr: group.hcr,
          tripNumber: group.tripNumber,
          contractStartDate,
          contractEndDate,
        }
      : 'skip'
  );

  // Mutations
  const createLaneAndBackfill = useMutation(api.lanes.createLaneAndBackfill);
  const voidUnmappedGroup = useMutation(api.lanes.voidUnmappedGroup);

  // Set default contract name
  useEffect(() => {
    if (group) {
      setContractName(`${group.hcr}-${group.tripNumber}`);
      
      // Default to date range from group
      const startDate = new Date(group.firstLoadDate);
      const endDate = new Date(group.lastLoadDate);
      
      // Set start date to first day of month
      startDate.setDate(1);
      setContractStartDate(startDate.toISOString().split('T')[0]);
      
      // Set end date to last day of current month + 1 year
      endDate.setFullYear(endDate.getFullYear() + 1);
      endDate.setMonth(endDate.getMonth() + 1, 0);
      setContractEndDate(endDate.toISOString().split('T')[0]);
    }
  }, [group]);

  // Select all loads by default when preview loads
  useEffect(() => {
    if (preview?.affectedLoadIds) {
      setSelectedLoadIds(preview.affectedLoadIds);
    }
  }, [preview?.affectedLoadIds]);

  const handleVoid = async () => {
    if (!voidReason.trim()) {
      alert('Please provide a reason for voiding these invoices');
      return;
    }

    setIsSubmitting(true);
    try {
      await voidUnmappedGroup({
        workosOrgId: organizationId,
        hcr: group.hcr,
        tripNumber: group.tripNumber,
        voidReason,
        createdBy: userId,
      });
      onClose();
    } catch (error) {
      console.error('Failed to void group:', error);
      alert('Failed to void invoices. Please try again.');
    } finally {
      setIsSubmitting(false);
    }
  };

  const handleSubmit = async () => {
    if (!customerName || !contractName || !contractStartDate || !contractEndDate || !rate) {
      alert('Please fill in all required fields');
      return;
    }

    if (selectedLoadIds.length === 0) {
      alert('Please select at least one load to backfill');
      return;
    }

    setIsSubmitting(true);
    try {
      await createLaneAndBackfill({
        workosOrgId: organizationId,
        hcr: group.hcr,
        tripNumber: group.tripNumber,
        customerName,
        customerId,
        contractName,
        contractStartDate,
        contractEndDate,
        rate: parseFloat(rate),
        rateType,
        currency,
        fuelSurchargeType,
        fuelSurchargeValue: fuelSurchargeValue ? parseFloat(fuelSurchargeValue) : undefined,
        stopOffRate: stopOffRate ? parseFloat(stopOffRate) : undefined,
        includedStops: parseInt(includedStops),
        isWildcard,
        selectedLoadIds: selectedLoadIds.length === preview?.affectedLoadIds.length ? undefined : selectedLoadIds,
        createdBy: userId,
      });
      onClose();
    } catch (error) {
      console.error('Failed to create lane and backfill:', error);
      alert('Failed to create contract lane. Please try again.');
    } finally {
      setIsSubmitting(false);
    }
  };

  const toggleLoadSelection = (loadId: Id<'loadInformation'>) => {
    setSelectedLoadIds((prev) =>
      prev.includes(loadId) ? prev.filter((id) => id !== loadId) : [...prev, loadId]
    );
  };

  const toggleAllLoads = () => {
    if (selectedLoadIds.length === preview?.affectedLoadIds.length) {
      setSelectedLoadIds([]);
    } else {
      setSelectedLoadIds(preview?.affectedLoadIds || []);
    }
  };

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
    <Dialog open={true} onOpenChange={onClose}>
      <DialogContent className="w-[95vw] max-w-7xl max-h-[90vh] overflow-hidden flex flex-col p-0">
        <DialogHeader className="px-6 pt-6 pb-4 shrink-0">
          <DialogTitle>Fix Unmapped Load Cluster</DialogTitle>
          <DialogDescription>
            HCR: {group.hcr} | Trip: {group.tripNumber} | {group.count} loads affected
          </DialogDescription>
        </DialogHeader>

        {/* Mode Toggle */}
        <div className="flex gap-2 px-6 pb-4 border-b shrink-0">
          <Button
            variant={mode === 'create' ? 'default' : 'outline'}
            onClick={() => setMode('create')}
            className="flex-1"
          >
            <CheckCircle2 className="mr-2 h-4 w-4" />
            Define Contract
          </Button>
          <Button
            variant={mode === 'void' ? 'destructive' : 'outline'}
            onClick={() => setMode('void')}
            className="flex-1"
          >
            <Trash2 className="mr-2 h-4 w-4" />
            Void as Trash
          </Button>
        </div>

        <div className="flex-1 overflow-y-auto px-6 py-4">
          {mode === 'create' ? (
            <div className="grid grid-cols-2 gap-8">
              {/* Left Panel: Contract Form */}
              <div className="space-y-5">
                <h3 className="text-sm font-semibold text-muted-foreground uppercase tracking-wide">Contract Details</h3>

                {/* Customer */}
                <div className="space-y-2">
                  <Label htmlFor="customer">Customer *</Label>
                  <Select
                    value={customerId}
                    onValueChange={(value) => {
                      setCustomerId(value as Id<'customers'>);
                      const selectedCustomer = customers?.find((c) => c._id === value);
                      if (selectedCustomer) {
                        setCustomerName(selectedCustomer.name);
                      }
                    }}
                  >
                    <SelectTrigger>
                      <SelectValue placeholder="Select customer" />
                    </SelectTrigger>
                    <SelectContent>
                      {customers?.map((customer) => (
                        <SelectItem key={customer._id} value={customer._id}>
                          {customer.name}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                  {!customerId && (
                    <Input
                      placeholder="Or enter new customer name"
                      value={customerName}
                      onChange={(e) => setCustomerName(e.target.value)}
                    />
                  )}
                </div>

                {/* Contract Name */}
                <div className="space-y-2">
                  <Label htmlFor="contractName">Contract Name *</Label>
                  <Input
                    id="contractName"
                    value={contractName}
                    onChange={(e) => setContractName(e.target.value)}
                  />
                </div>

                {/* Date Range */}
                <div className="grid grid-cols-2 gap-2">
                  <div className="space-y-2">
                    <Label htmlFor="startDate">Start Date *</Label>
                    <Input
                      id="startDate"
                      type="date"
                      value={contractStartDate}
                      onChange={(e) => setContractStartDate(e.target.value)}
                    />
                  </div>
                  <div className="space-y-2">
                    <Label htmlFor="endDate">End Date *</Label>
                    <Input
                      id="endDate"
                      type="date"
                      value={contractEndDate}
                      onChange={(e) => setContractEndDate(e.target.value)}
                    />
                  </div>
                </div>

                {/* Rate */}
                <div className="grid grid-cols-2 gap-2">
                  <div className="space-y-2">
                    <Label htmlFor="rate">Rate *</Label>
                    <Input
                      id="rate"
                      type="number"
                      step="0.01"
                      value={rate}
                      onChange={(e) => setRate(e.target.value)}
                    />
                  </div>
                  <div className="space-y-2">
                    <Label htmlFor="rateType">Rate Type *</Label>
                    <Select value={rateType} onValueChange={(value: any) => setRateType(value)}>
                      <SelectTrigger>
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent>
                        <SelectItem value="Flat Rate">Flat Rate</SelectItem>
                        <SelectItem value="Per Mile">Per Mile</SelectItem>
                        <SelectItem value="Per Stop">Per Stop</SelectItem>
                      </SelectContent>
                    </Select>
                  </div>
                </div>

                {/* Currency */}
                <div className="space-y-2">
                  <Label htmlFor="currency">Currency *</Label>
                  <Select value={currency} onValueChange={(value: any) => setCurrency(value)}>
                    <SelectTrigger>
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="USD">USD</SelectItem>
                      <SelectItem value="CAD">CAD</SelectItem>
                      <SelectItem value="MXN">MXN</SelectItem>
                    </SelectContent>
                  </Select>
                </div>

                <Separator />

                {/* Fuel Surcharge */}
                <div className="space-y-2">
                  <Label htmlFor="fuelSurchargeType">Fuel Surcharge</Label>
                  <Select
                    value={fuelSurchargeType || 'none'}
                    onValueChange={(value) =>
                      setFuelSurchargeType(value === 'none' ? undefined : (value as any))
                    }
                  >
                    <SelectTrigger>
                      <SelectValue placeholder="None" />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="none">None</SelectItem>
                      <SelectItem value="PERCENTAGE">Percentage</SelectItem>
                      <SelectItem value="FLAT">Flat Amount</SelectItem>
                      <SelectItem value="DOE_INDEX">DOE Index</SelectItem>
                    </SelectContent>
                  </Select>
                  {fuelSurchargeType && fuelSurchargeType !== 'DOE_INDEX' && (
                    <Input
                      type="number"
                      step="0.01"
                      placeholder={fuelSurchargeType === 'PERCENTAGE' ? '22 (for 22%)' : '150 (for $150)'}
                      value={fuelSurchargeValue}
                      onChange={(e) => setFuelSurchargeValue(e.target.value)}
                    />
                  )}
                </div>

                {/* Stop-off Charges */}
                <div className="grid grid-cols-2 gap-2">
                  <div className="space-y-2">
                    <Label htmlFor="stopOffRate">Stop-off Rate</Label>
                    <Input
                      id="stopOffRate"
                      type="number"
                      step="0.01"
                      placeholder="50.00"
                      value={stopOffRate}
                      onChange={(e) => setStopOffRate(e.target.value)}
                    />
                  </div>
                  <div className="space-y-2">
                    <Label htmlFor="includedStops">Included Stops</Label>
                    <Input
                      id="includedStops"
                      type="number"
                      value={includedStops}
                      onChange={(e) => setIncludedStops(e.target.value)}
                    />
                  </div>
                </div>

                <Separator />

                {/* Wildcard Checkbox */}
                <div className="flex items-center space-x-2">
                  <Checkbox id="isWildcard" checked={isWildcard} onCheckedChange={(checked) => setIsWildcard(checked as boolean)} />
                  <label
                    htmlFor="isWildcard"
                    className="text-sm font-medium leading-none peer-disabled:cursor-not-allowed peer-disabled:opacity-70"
                  >
                    Wildcard match (mark as SPOT rate)
                  </label>
                </div>
              </div>

              {/* Right Panel: Preview */}
              <div className="space-y-5 border-l pl-8">
                <div className="flex items-center justify-between">
                  <h3 className="text-sm font-semibold text-muted-foreground uppercase tracking-wide">Impact Preview</h3>
                  {preview && (
                    <Badge variant="outline" className="text-xs">
                      {selectedLoadIds.length} of {preview.count} selected
                    </Badge>
                  )}
                </div>

                {!contractStartDate || !contractEndDate ? (
                  <div className="text-center py-8 text-muted-foreground">
                    <AlertCircle className="h-8 w-8 mx-auto mb-2" />
                    <p className="text-sm">Enter date range to see preview</p>
                  </div>
                ) : !preview ? (
                  <div className="text-center py-8">
                    <Loader2 className="h-8 w-8 mx-auto animate-spin text-muted-foreground" />
                  </div>
                ) : preview.count === 0 ? (
                  <div className="text-center py-8 text-muted-foreground">
                    <AlertCircle className="h-8 w-8 mx-auto mb-2" />
                    <p className="text-sm">No loads found in this date range</p>
                    <p className="text-xs">Try adjusting the contract dates</p>
                  </div>
                ) : (
                  <>
                    {/* Summary */}
                    <div className="grid grid-cols-2 gap-4 p-5 bg-muted/50 rounded-lg border">
                      <div>
                        <p className="text-xs text-muted-foreground font-medium mb-1">Loads Affected</p>
                        <p className="text-2xl font-bold">{selectedLoadIds.length}</p>
                      </div>
                      <div>
                        <p className="text-xs text-muted-foreground font-medium mb-1">Est. Revenue</p>
                        <p className="text-2xl font-bold">{formatCurrency(preview.estimatedRevenue)}</p>
                      </div>
                    </div>

                    {/* Load Selection */}
                    <div className="space-y-3">
                      <div className="flex items-center space-x-3 py-2 border-b">
                        <Checkbox
                          id="selectAll"
                          checked={selectedLoadIds.length === preview.affectedLoadIds.length}
                          onCheckedChange={toggleAllLoads}
                        />
                        <label htmlFor="selectAll" className="text-sm font-medium cursor-pointer">
                          Select All
                        </label>
                      </div>

                      <div className="max-h-[420px] overflow-y-auto space-y-1 pr-2">
                        {preview.affectedLoads.map((load) => (
                          <div
                            key={load._id}
                            className="flex items-center space-x-3 p-3 hover:bg-muted/50 rounded-md border border-transparent hover:border-border transition-colors"
                          >
                            <Checkbox
                              checked={selectedLoadIds.includes(load._id)}
                              onCheckedChange={() => toggleLoadSelection(load._id)}
                            />
                            <div className="flex-1 min-w-0">
                              <div className="font-mono font-semibold text-sm">{load.orderNumber}</div>
                              <div className="text-xs text-muted-foreground">
                                {formatDate(load.createdAt)}
                              </div>
                            </div>
                            <Badge variant="outline" className="text-xs shrink-0">
                              {load.status}
                            </Badge>
                          </div>
                        ))}
                      </div>
                    </div>
                  </>
                )}
              </div>
            </div>
          ) : (
            <div className="space-y-4">
              <div className="p-4 bg-destructive/10 border border-destructive/20 rounded-lg">
                <h3 className="text-sm font-semibold text-destructive mb-2">Void as Trash Data</h3>
                <p className="text-sm text-muted-foreground">
                  This will mark all {group.count} invoices in this cluster as VOID without affecting operational data.
                  Use this for test loads, cancelled bookings, or invalid data.
                </p>
              </div>

              <div className="space-y-2">
                <Label htmlFor="voidReason">Void Reason *</Label>
                <Textarea
                  id="voidReason"
                  placeholder="e.g., Test loads, Cancelled shipments, Invalid data..."
                  value={voidReason}
                  onChange={(e) => setVoidReason(e.target.value)}
                  rows={4}
                />
              </div>
            </div>
          )}
        </div>

        {/* Footer Actions */}
        <div className="flex justify-end gap-3 px-6 py-4 border-t bg-muted/30 shrink-0">
          <Button variant="outline" onClick={onClose} disabled={isSubmitting}>
            Cancel
          </Button>
          <Button
            onClick={handleSubmit}
            disabled={isSubmitting}
            variant={mode === 'void' ? 'destructive' : 'default'}
          >
            {isSubmitting && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
            {mode === 'create' ? 'Create & Backfill' : 'Void Invoices'}
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}
