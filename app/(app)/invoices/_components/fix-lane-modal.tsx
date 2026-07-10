'use client';

import { useState, useEffect, useMemo } from 'react';
import { Sheet, SheetContent, SheetTitle, SheetDescription } from '@/components/ui/sheet';
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter } from '@/components/ui/dialog';
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
  CollapsibleTrigger,
} from '@/components/ui/collapsible';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
import { Command, CommandEmpty, CommandGroup, CommandInput, CommandItem } from '@/components/ui/command';
import { Badge } from '@/components/ui/badge';
import { Separator } from '@/components/ui/separator';
import { Textarea } from '@/components/ui/textarea';
import { Loader2, ChevronDown, AlertCircle, Check, ChevronsUpDown, Plus } from 'lucide-react';
import { WBtn, WIcon, Chip } from '@/components/web';
import { useMutation, useQuery } from 'convex/react';
import { api } from '@/convex/_generated/api';
import { Id } from '@/convex/_generated/dataModel';
import { toast } from 'sonner';

interface FixLaneModalProps {
  group: {
    hcr: string;
    tripNumber: string;
    count: number;
    firstLoadDate: number;
    lastLoadDate: number;
  };
  organizationId: string;
  userId: string;
  onClose: () => void;
}

export function FixLaneModal({ group, organizationId, userId, onClose }: FixLaneModalProps) {
  // Form state
  const [customerName, setCustomerName] = useState('');
  const [customerOffice, setCustomerOffice] = useState('');
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
  const [customerComboOpen, setCustomerComboOpen] = useState(false);
  const [showNewCustomerInput, setShowNewCustomerInput] = useState(false);

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

  // Set default contract name and dates
  useEffect(() => {
    if (group) {
      setContractName(`${group.hcr}-${group.tripNumber}`);

      const startDate = new Date(group.firstLoadDate);
      const endDate = new Date(group.lastLoadDate);

      startDate.setDate(1);
      setContractStartDate(`${startDate.getFullYear()}-${String(startDate.getMonth()+1).padStart(2,'0')}-${String(startDate.getDate()).padStart(2,'0')}`);

      endDate.setFullYear(endDate.getFullYear() + 1);
      endDate.setMonth(endDate.getMonth() + 1, 0);
      setContractEndDate(`${endDate.getFullYear()}-${String(endDate.getMonth()+1).padStart(2,'0')}-${String(endDate.getDate()).padStart(2,'0')}`);
    }
  }, [group]);

  // Select all loads by default when preview loads
  useEffect(() => {
    if (preview?.affectedLoadIds) {
      setSelectedLoadIds(preview.affectedLoadIds);
    }
  }, [preview?.affectedLoadIds]);

  // Calculate estimated revenue based on rate
  const estimatedRevenue = useMemo(() => {
    if (!rate || !preview) return 0;

    const baseRate = parseFloat(rate) || 0;
    const loadCount = selectedLoadIds.length;

    if (rateType === 'Flat Rate') {
      return baseRate * loadCount;
    } else if (rateType === 'Per Stop') {
      return baseRate * 2 * loadCount; // Assume 2 stops average
    } else {
      return 0; // Would need miles data
    }
  }, [rate, rateType, selectedLoadIds.length, preview]);

  const handleVoid = async () => {
    if (!voidReason.trim()) {
      toast.error('Void reason is required', {
        description: 'Please provide a reason for voiding these invoices',
      });
      return;
    }

    setIsSubmitting(true);
    const toastId = toast.loading('Voiding invoices...', {
      description: `Processing ${group.count} invoices`,
    });

    try {
      const result = await voidUnmappedGroup({
        workosOrgId: organizationId,
        hcr: group.hcr,
        tripNumber: group.tripNumber,
        voidReason,
        createdBy: userId,
        // Pass customer info if user selected one
        customerName: customerName || undefined,
        customerOffice: customerOffice || undefined,
        customerId: customerId || undefined,
      });

      toast.success('Invoices voided successfully', {
        id: toastId,
        description: `${result.voidedCount} invoices marked as VOID`,
      });
      onClose();
    } catch (error) {
      console.error('Failed to void group:', error);
      toast.error('Failed to void invoices', {
        id: toastId,
        description: error instanceof Error ? error.message : 'An unexpected error occurred. Please try again.',
      });
    } finally {
      setIsSubmitting(false);
    }
  };

  const handleSubmit = async () => {
    // Validation
    if (!customerName || !contractName || !contractStartDate || !contractEndDate || !rate) {
      const missing = [];
      if (!customerName) missing.push('Customer');
      if (!contractName) missing.push('Contract Name');
      if (!contractStartDate) missing.push('Start Date');
      if (!contractEndDate) missing.push('End Date');
      if (!rate) missing.push('Base Rate');

      toast.error('Missing required fields', {
        description: `Please fill in: ${missing.join(', ')}`,
      });
      return;
    }

    if (selectedLoadIds.length === 0) {
      toast.error('No loads selected', {
        description: 'Please select at least one load to process',
      });
      return;
    }

    // Validate rate is a positive number
    const parsedRate = parseFloat(rate);
    if (isNaN(parsedRate) || parsedRate <= 0) {
      toast.error('Invalid rate', {
        description: 'Base rate must be a positive number',
      });
      return;
    }

    setIsSubmitting(true);
    const toastId = toast.loading(
      isWildcard ? 'Processing spot loads...' : 'Creating contract lane...',
      {
        description: `Processing ${selectedLoadIds.length} loads`,
      }
    );

    try {
      const result = await createLaneAndBackfill({
        workosOrgId: organizationId,
        hcr: group.hcr,
        tripNumber: group.tripNumber,
        customerName,
        customerOffice,
        customerId,
        contractName,
        contractStartDate,
        contractEndDate,
        rate: parsedRate,
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

      toast.success(
        isWildcard ? 'Spot loads processed' : 'Contract lane created',
        {
          id: toastId,
          description: `${result.loadsUpdated} loads updated • ${formatCurrency(result.totalRevenue)} revenue`,
        }
      );
      onClose();
    } catch (error) {
      console.error('Failed to create lane and backfill:', error);
      toast.error('Failed to process loads', {
        id: toastId,
        description: error instanceof Error ? error.message : 'An unexpected error occurred. Please check the console for details.',
      });
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

  // Shared customer combobox (used by the main form and the void dialog).
  const customerCombobox = (triggerClassName: string, popoverWidth: string) => (
    <Popover open={customerComboOpen} onOpenChange={setCustomerComboOpen}>
      <PopoverTrigger asChild>
        <Button
          variant="outline"
          role="combobox"
          aria-expanded={customerComboOpen}
          className={triggerClassName}
          disabled={customers === undefined}
        >
          {customers === undefined ? (
            <span className="flex items-center gap-2 text-muted-foreground">
              <Loader2 className="w-3 h-3 animate-spin" />
              Loading customers...
            </span>
          ) : customerId ? (
            customers?.find((c) => c._id === customerId)?.name +
            (customers?.find((c) => c._id === customerId)?.office ? ` (${customers?.find((c) => c._id === customerId)?.office})` : '')
          ) : (
            customerName || 'Search or create customer...'
          )}
          <ChevronsUpDown className="ml-2 h-4 w-4 shrink-0 opacity-50" />
        </Button>
      </PopoverTrigger>
      <PopoverContent className={`${popoverWidth} p-0`} align="start">
        <Command>
          <CommandInput placeholder="Search customers..." />
          <CommandEmpty>
            <div className="py-6 text-center text-sm">
              <p className="text-muted-foreground mb-2">No customer found.</p>
              <Button
                variant="outline"
                size="sm"
                onClick={() => {
                  setShowNewCustomerInput(true);
                  setCustomerId(undefined);
                  setCustomerComboOpen(false);
                }}
              >
                <Plus className="mr-2 h-4 w-4" />
                Create New Customer
              </Button>
            </div>
          </CommandEmpty>
          <CommandGroup className="max-h-64 overflow-y-auto">
            {customers?.map((customer) => (
              <CommandItem
                key={customer._id}
                value={`${customer.name} ${customer.office || ''}`}
                onSelect={() => {
                  setCustomerId(customer._id);
                  setCustomerName(customer.name);
                  setCustomerOffice(customer.office || '');
                  setShowNewCustomerInput(false);
                  setCustomerComboOpen(false);
                }}
              >
                <Check
                  className={`mr-2 h-4 w-4 ${customerId === customer._id ? 'opacity-100' : 'opacity-0'}`}
                />
                <div className="flex flex-col">
                  <span className="font-medium">{customer.name}</span>
                  {customer.office && (
                    <span className="text-xs text-muted-foreground">{customer.office}</span>
                  )}
                </div>
              </CommandItem>
            ))}
          </CommandGroup>
          <div className="border-t p-2">
            <Button
              variant="ghost"
              size="sm"
              className="w-full justify-start text-green-600 hover:text-green-700 hover:bg-green-50"
              onClick={() => {
                setShowNewCustomerInput(true);
                setCustomerId(undefined);
                setCustomerName('');
                setCustomerOffice('');
                setCustomerComboOpen(false);
              }}
            >
              <Plus className="mr-2 h-4 w-4" />
              Create New Customer
            </Button>
          </div>
        </Command>
      </PopoverContent>
    </Popover>
  );

  const newCustomerInputs = (
    <div className="space-y-2 mt-2">
      <Input
        placeholder="Enter customer name (e.g., USPS)"
        value={customerName}
        onChange={(e) => setCustomerName(e.target.value)}
        autoFocus
      />
      <Input
        placeholder="Enter office location (e.g., Chicago, New York)"
        value={customerOffice}
        onChange={(e) => setCustomerOffice(e.target.value)}
      />
    </div>
  );

  return (
    <>
      <Sheet open={!showVoidDialog} onOpenChange={(o) => { if (!o) onClose(); }}>
        <SheetContent side="right" className="w-full sm:max-w-[900px] p-0 gap-0 flex flex-col">
          <SheetTitle className="sr-only">Fix unmapped lane</SheetTitle>
          <SheetDescription className="sr-only">
            Define a contract lane to backfill invoices for these loads, or void the group.
          </SheetDescription>

          {/* HEADER */}
          <div className="shrink-0 border-b border-[var(--border-hairline)] bg-card px-5 py-3.5 flex items-start justify-between gap-3">
            <div className="flex items-start gap-3 min-w-0">
              <span className="inline-flex h-9 w-9 items-center justify-center rounded-[9px] bg-[var(--bg-sidebar-active)] text-[var(--accent)] shrink-0">
                <WIcon name="doc-dollar" size={18} />
              </span>
              <div className="min-w-0">
                <div className="flex items-center gap-2 flex-wrap">
                  <span className="text-[16px] font-semibold text-foreground tracking-[-0.01em]">Fix unmapped lane</span>
                  <Chip status="assigned" label={`HCR ${group.hcr}`} />
                  <WIcon name="arrow-right" size={11} color="var(--text-tertiary)" />
                  <Chip
                    status={isWildcard ? 'warning' : 'assigned'}
                    label={isWildcard ? 'Wildcard · all trips' : `Trip ${group.tripNumber}`}
                  />
                </div>
                <p className="text-[12.5px] text-[var(--text-tertiary)] mt-1">
                  Define the contract to auto-generate invoices for these loads.
                </p>
              </div>
            </div>
            <div className="flex items-center gap-3 shrink-0">
              <label htmlFor="spot-mode" className="flex items-center gap-2 cursor-pointer">
                <Switch id="spot-mode" checked={isWildcard} onCheckedChange={setIsWildcard} />
                <span className="text-[12.5px] font-medium text-[var(--text-secondary)] whitespace-nowrap">Treat as spot</span>
              </label>
              <button
                type="button"
                onClick={onClose}
                title="Close"
                className="focus-ring h-8 w-8 inline-flex items-center justify-center rounded-md text-[var(--text-tertiary)] hover:bg-[var(--bg-row-hover)] hover:text-foreground"
              >
                <WIcon name="close" size={15} />
              </button>
            </div>
          </div>

          {/* BODY — two panes: form + live preview */}
          <div className="flex-1 min-h-0 flex overflow-hidden">
            {/* LEFT: the contract form */}
            <div className="w-[420px] shrink-0 border-r border-[var(--border-hairline)] bg-card flex flex-col min-h-0">
              <div className="flex-1 overflow-y-auto scroll-thin px-5 py-5">
                <div className="space-y-6">
                  {/* Customer */}
                  <div className="space-y-3">
                    <h3 className="text-[11px] font-semibold uppercase tracking-[0.04em] text-[var(--text-tertiary)] flex items-center gap-2">
                      <WIcon name="briefcase" size={13} /> Customer
                    </h3>
                    <div className="space-y-3">
                      <div className="grid gap-1.5">
                        <Label className="text-xs text-[var(--text-tertiary)]">Assign to customer</Label>
                        {customerCombobox('justify-between font-normal h-10', 'w-[360px]')}
                        {showNewCustomerInput && newCustomerInputs}
                      </div>
                      <div className="grid gap-1.5">
                        <Label className="text-xs text-[var(--text-tertiary)]">Contract name</Label>
                        <Input
                          value={contractName}
                          onChange={(e) => setContractName(e.target.value)}
                          className="num bg-[var(--bg-surface-2)] font-mono text-sm"
                        />
                      </div>
                    </div>
                  </div>

                  <Separator />

                  {/* Rates & Terms */}
                  <div className="space-y-3">
                    <h3 className="text-[11px] font-semibold uppercase tracking-[0.04em] text-[var(--text-tertiary)] flex items-center gap-2">
                      <WIcon name="doc-dollar" size={13} /> Rates &amp; terms
                    </h3>

                    <div className="grid grid-cols-2 gap-3">
                      <div className="grid gap-1.5">
                        <Label className="text-xs text-[var(--text-tertiary)]">Validity start</Label>
                        <Input
                          type="date"
                          className="text-sm"
                          value={contractStartDate}
                          onChange={(e) => setContractStartDate(e.target.value)}
                        />
                      </div>
                      <div className="grid gap-1.5">
                        <Label className="text-xs text-[var(--text-tertiary)]">Validity end</Label>
                        <Input
                          type="date"
                          className="text-sm"
                          value={contractEndDate}
                          onChange={(e) => setContractEndDate(e.target.value)}
                        />
                      </div>
                    </div>

                    <div className="grid grid-cols-3 gap-3">
                      <div className="col-span-2 grid gap-1.5">
                        <Label className="text-xs text-[var(--text-tertiary)]">Base rate</Label>
                        <div className="relative">
                          <span className="absolute left-3 top-2.5 text-[var(--text-tertiary)]">$</span>
                          <Input
                            className="num pl-7 text-lg font-semibold"
                            placeholder="0.00"
                            type="number"
                            step="0.01"
                            value={rate}
                            onChange={(e) => setRate(e.target.value)}
                          />
                        </div>
                      </div>
                      <div className="grid gap-1.5">
                        <Label className="text-xs text-[var(--text-tertiary)]">Unit</Label>
                        <Select value={rateType} onValueChange={(value: 'Per Mile' | 'Flat Rate' | 'Per Stop') => setRateType(value)}>
                          <SelectTrigger className="h-11">
                            <SelectValue />
                          </SelectTrigger>
                          <SelectContent>
                            <SelectItem value="Flat Rate">Flat</SelectItem>
                            <SelectItem value="Per Mile">/ Mile</SelectItem>
                            <SelectItem value="Per Stop">/ Stop</SelectItem>
                          </SelectContent>
                        </Select>
                      </div>
                    </div>

                    <div className="grid gap-1.5">
                      <Label className="text-xs text-[var(--text-tertiary)]">Currency</Label>
                      <Select value={currency} onValueChange={(value: 'USD' | 'CAD' | 'MXN') => setCurrency(value)}>
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
                  </div>

                  {/* Advanced Pricing (Collapsible) */}
                  <Collapsible open={showAdvanced} onOpenChange={setShowAdvanced} className="border border-[var(--border-hairline)] rounded-lg bg-[var(--bg-surface-2)]">
                    <CollapsibleTrigger className="flex w-full items-center justify-between p-3 text-sm font-medium hover:bg-[var(--bg-row-hover)] transition-colors rounded-lg">
                      <span>Advanced pricing (fuel, stops)</span>
                      <ChevronDown className={`w-4 h-4 transition-transform ${showAdvanced ? 'rotate-180' : ''}`} />
                    </CollapsibleTrigger>
                    <CollapsibleContent className="px-3 pb-3 space-y-3">
                      <Separator className="mb-3" />
                      <div className="grid gap-1.5">
                        <Label className="text-xs text-[var(--text-tertiary)]">Fuel surcharge</Label>
                        <Select
                          value={fuelSurchargeType || 'none'}
                          onValueChange={(value) =>
                            setFuelSurchargeType(value === 'none' ? undefined : (value as 'PERCENTAGE' | 'FLAT' | 'DOE_INDEX'))
                          }
                        >
                          <SelectTrigger className="h-9 bg-card">
                            <SelectValue placeholder="None" />
                          </SelectTrigger>
                          <SelectContent>
                            <SelectItem value="none">None</SelectItem>
                            <SelectItem value="PERCENTAGE">Percentage</SelectItem>
                            <SelectItem value="FLAT">Flat Amount</SelectItem>
                          </SelectContent>
                        </Select>
                        {fuelSurchargeType && fuelSurchargeType !== 'DOE_INDEX' && (
                          <Input
                            type="number"
                            step="0.01"
                            placeholder={fuelSurchargeType === 'PERCENTAGE' ? '22 (for 22%)' : '150'}
                            value={fuelSurchargeValue}
                            onChange={(e) => setFuelSurchargeValue(e.target.value)}
                            className="h-9 text-xs bg-card mt-2"
                          />
                        )}
                      </div>
                      <div className="grid grid-cols-2 gap-3">
                        <div className="grid gap-1.5">
                          <Label className="text-xs text-[var(--text-tertiary)]">Stop-off rate</Label>
                          <Input
                            type="number"
                            step="0.01"
                            placeholder="50.00"
                            value={stopOffRate}
                            onChange={(e) => setStopOffRate(e.target.value)}
                            className="h-9 text-xs bg-card"
                          />
                        </div>
                        <div className="grid gap-1.5">
                          <Label className="text-xs text-[var(--text-tertiary)]">Included stops</Label>
                          <Input
                            type="number"
                            value={includedStops}
                            onChange={(e) => setIncludedStops(e.target.value)}
                            className="h-9 text-xs bg-card"
                          />
                        </div>
                      </div>
                    </CollapsibleContent>
                  </Collapsible>
                </div>
              </div>

              {/* Void action */}
              <div className="shrink-0 border-t border-[var(--border-hairline)] bg-[var(--bg-surface-2)] px-5 py-3 text-center">
                <WBtn
                  variant="ghost"
                  size="xs"
                  leading="close"
                  className="text-[#B43030] hover:bg-[rgba(239,68,68,0.06)] hover:text-[#B43030]"
                  onClick={() => setShowVoidDialog(true)}
                >
                  These loads are invalid (void group)
                </WBtn>
              </div>
            </div>

            {/* RIGHT: live preview */}
            <div className="flex-1 min-w-0 bg-card flex flex-col min-h-0">
              {/* Revenue header */}
              <div className="shrink-0 border-b border-[var(--border-hairline)] px-5 py-4 grid grid-cols-2 gap-4 items-center">
                <div>
                  <div className="text-[10.5px] font-semibold uppercase tracking-[0.05em] text-[var(--text-tertiary)]">Total impact</div>
                  <div className="flex items-baseline gap-2 mt-0.5">
                    <span className="num text-[28px] font-bold text-foreground tracking-tight leading-none">{selectedLoadIds.length}</span>
                    <span className="text-[var(--text-tertiary)] text-sm">loads</span>
                  </div>
                </div>
                <div className="text-right">
                  <div className="text-[10.5px] font-semibold uppercase tracking-[0.05em] text-[var(--text-tertiary)]">Est. revenue</div>
                  <div className="num text-[28px] font-bold tracking-tight leading-none text-[#0F8C5F] mt-0.5">
                    {formatCurrency(estimatedRevenue)}
                  </div>
                </div>
              </div>

              {!contractStartDate || !contractEndDate ? (
                <div className="flex-1 flex items-center justify-center text-center p-8">
                  <div>
                    <AlertCircle className="w-10 h-10 mx-auto mb-3 text-[var(--text-tertiary)] opacity-50" />
                    <p className="text-sm text-[var(--text-tertiary)]">Enter contract dates to see preview</p>
                  </div>
                </div>
              ) : !preview ? (
                <div className="flex-1 flex items-center justify-center">
                  <Loader2 className="w-7 h-7 animate-spin text-[var(--text-tertiary)]" />
                </div>
              ) : preview.count === 0 ? (
                <div className="flex-1 flex items-center justify-center text-center p-8">
                  <div>
                    <AlertCircle className="w-10 h-10 mx-auto mb-3 text-[#A66800]" />
                    <p className="text-sm font-medium text-foreground">No loads found in this date range</p>
                    <p className="text-xs text-[var(--text-tertiary)] mt-1">Try adjusting the contract dates</p>
                  </div>
                </div>
              ) : (
                <>
                  {/* Table header */}
                  <div className="flex items-center px-5 py-2 bg-[var(--bg-surface-2)] border-b border-[var(--border-hairline)] text-[11px] font-semibold uppercase tracking-[0.04em] text-[var(--text-tertiary)] shrink-0">
                    <div className="w-8">
                      <Checkbox
                        checked={selectedLoadIds.length === preview.affectedLoadIds.length}
                        onCheckedChange={toggleAllLoads}
                      />
                    </div>
                    <div className="w-20">Date</div>
                    <div className="flex-1">Order #</div>
                    <div className="w-20">Status</div>
                    <div className="w-20 text-right">Revenue</div>
                  </div>

                  {/* Table rows */}
                  <div className="flex-1 overflow-y-auto scroll-thin">
                    <div className="divide-y divide-[var(--border-hairline)]">
                      {preview.affectedLoads.map((load) => {
                        const loadRevenue = rateType === 'Flat Rate' ? parseFloat(rate || '0') : 0;
                        const selected = selectedLoadIds.includes(load._id);
                        return (
                          <div
                            key={load._id}
                            className="flex items-center px-5 py-2.5 hover:bg-[var(--bg-row-hover)] transition-colors group"
                          >
                            <div className="w-8">
                              <Checkbox
                                checked={selected}
                                onCheckedChange={() => toggleLoadSelection(load._id)}
                              />
                            </div>
                            <div className="w-20 num text-[12.5px] text-[var(--text-secondary)]">{formatDate(load.createdAt)}</div>
                            <div className="flex-1 num text-[12.5px] font-medium text-foreground font-mono truncate">{load.orderNumber}</div>
                            <div className="w-20">
                              <Badge variant="secondary" className="text-[10px] h-5 px-1.5 font-normal bg-[var(--bg-surface-2)] text-[var(--text-secondary)]">
                                {load.status}
                              </Badge>
                            </div>
                            <div className={`w-20 text-right num text-[12.5px] font-medium ${selected ? 'text-[#0F8C5F]' : 'text-[var(--text-tertiary)]'}`}>
                              {selected ? formatCurrency(loadRevenue) : '—'}
                            </div>
                          </div>
                        );
                      })}
                    </div>
                  </div>
                </>
              )}
            </div>
          </div>

          {/* FOOTER */}
          <div className="shrink-0 border-t border-[var(--border-hairline)] bg-card px-5 py-3 flex items-center justify-end gap-2">
            <WBtn variant="secondary" onClick={onClose} disabled={isSubmitting}>Cancel</WBtn>
            <WBtn
              accent
              leading={isWildcard ? 'truck' : 'receipt'}
              onClick={handleSubmit}
              disabled={
                isSubmitting ||
                !customerName ||
                !contractName ||
                !rate ||
                !contractStartDate ||
                !contractEndDate ||
                selectedLoadIds.length === 0 ||
                customers === undefined
              }
            >
              {isSubmitting && <Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" />}
              {isWildcard ? 'Process as spot' : 'Create contract & backfill'}
            </WBtn>
          </div>
        </SheetContent>
      </Sheet>

      {/* Void Dialog (separate confirmation) */}
      <Dialog open={showVoidDialog} onOpenChange={setShowVoidDialog}>
        <DialogContent className="max-w-md">
          <DialogHeader>
            <DialogTitle>Void this cluster?</DialogTitle>
          </DialogHeader>
          <div className="space-y-4 py-4">
            <div className="p-4 bg-destructive/10 border border-destructive/20 rounded-lg">
              <p className="text-sm text-muted-foreground">
                This will mark all {group.count} invoices as VOID without affecting operational data.
                Use this for test loads or cancelled bookings.
              </p>
            </div>

            {/* Customer Selection - Same as main modal */}
            <div className="space-y-2">
              <Label className="text-sm font-medium">Assign to Customer (Optional)</Label>
              {customerCombobox('w-full justify-between font-normal h-10', 'w-[420px]')}
              {showNewCustomerInput && (
                <div className="space-y-2">
                  <Input
                    placeholder="Enter customer name (e.g., USPS)"
                    value={customerName}
                    onChange={(e) => setCustomerName(e.target.value)}
                    autoFocus
                  />
                  <Input
                    placeholder="Enter office location (e.g., Chicago, New York)"
                    value={customerOffice}
                    onChange={(e) => setCustomerOffice(e.target.value)}
                  />
                </div>
              )}
              <p className="text-xs text-slate-500">
                Select a customer to assign these loads before voiding, or leave empty to void without assignment.
              </p>
            </div>

            <div className="grid gap-2">
              <Label htmlFor="voidReason">Void Reason *</Label>
              <Textarea
                id="voidReason"
                placeholder="e.g., Test loads, Cancelled shipments..."
                value={voidReason}
                onChange={(e) => setVoidReason(e.target.value)}
                rows={3}
              />
            </div>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setShowVoidDialog(false)} disabled={isSubmitting}>
              Cancel
            </Button>
            <Button variant="destructive" onClick={handleVoid} disabled={isSubmitting || !voidReason.trim()}>
              {isSubmitting && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
              Void Invoices
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}
