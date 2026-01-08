'use client';

import { useState, useEffect, useMemo } from 'react';
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
  CollapsibleTrigger 
} from '@/components/ui/collapsible';
import { ScrollArea } from '@/components/ui/scroll-area';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
import { Command, CommandEmpty, CommandGroup, CommandInput, CommandItem } from '@/components/ui/command';
import { Loader2, Trash2, DollarSign, Users, ArrowRight, ChevronDown, AlertCircle, Check, ChevronsUpDown, Plus } from 'lucide-react';
import { useMutation, useQuery } from 'convex/react';
import { api } from '@/convex/_generated/api';
import { Badge } from '@/components/ui/badge';
import { Separator } from '@/components/ui/separator';
import { Textarea } from '@/components/ui/textarea';
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
      setContractStartDate(startDate.toISOString().split('T')[0]);
      
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

  return (
    <>
      <Dialog open={!showVoidDialog} onOpenChange={onClose}>
        <DialogContent className="!w-[90vw] !max-w-[90vw] h-[90vh] p-0 gap-0 flex flex-col overflow-hidden">
          
          {/* HEADER: Context & Wildcard Toggle */}
          <div className="pl-6 pr-16 py-4 border-b flex justify-between items-center bg-slate-50/50 shrink-0">
            <div>
              <div className="flex items-center gap-3">
                <DialogTitle className="text-xl font-semibold text-slate-900">
                  Fix Unmapped Lane
                </DialogTitle>
                <Badge variant="outline" className="font-mono text-slate-500 bg-white">
                  HCR: {group.hcr}
                </Badge>
                <ArrowRight className="w-4 h-4 text-slate-300" />
                <Badge variant="outline" className={`font-mono ${isWildcard ? 'bg-amber-100 text-amber-700 border-amber-200' : 'bg-white text-slate-500'}`}>
                  {isWildcard ? "Wildcard (All Trips)" : `Trip: ${group.tripNumber}`}
                </Badge>
              </div>
              <p className="text-sm text-slate-500 mt-1">
                Define the contract to auto-generate invoices for these loads.
              </p>
            </div>
            
            {/* Wildcard Toggle */}
            <div className="flex items-center space-x-2 bg-white px-3 py-2 rounded-md border shadow-sm">
              <Switch id="spot-mode" checked={isWildcard} onCheckedChange={setIsWildcard} />
              <Label htmlFor="spot-mode" className="cursor-pointer text-sm font-medium">
                Treat as Spot Market
              </Label>
            </div>
          </div>

          <div className="flex-1 flex overflow-hidden">
            
            {/* LEFT COLUMN: The Form */}
            <div className="w-[500px] flex-shrink-0 border-r bg-white flex flex-col">
              <ScrollArea className="flex-1 px-6 py-6">
                <div className="space-y-6">
                  
                  {/* Customer Section */}
                  <div className="space-y-3">
                    <h3 className="text-sm font-semibold text-slate-900 flex items-center gap-2">
                      <Users className="w-4 h-4 text-blue-600" /> Customer
                    </h3>
                    <div className="space-y-3">
                      <div className="grid gap-1.5">
                        <Label className="text-xs text-slate-500">Assign to Customer</Label>
                        <Popover open={customerComboOpen} onOpenChange={setCustomerComboOpen}>
                          <PopoverTrigger asChild>
                            <Button
                              variant="outline"
                              role="combobox"
                              aria-expanded={customerComboOpen}
                              className="justify-between font-normal h-10"
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
                                customerName || "Search or create customer..."
                              )}
                              <ChevronsUpDown className="ml-2 h-4 w-4 shrink-0 opacity-50" />
                            </Button>
                          </PopoverTrigger>
                          <PopoverContent className="w-[400px] p-0" align="start">
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
                        {showNewCustomerInput && (
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
                        )}
                      </div>
                      <div className="grid gap-1.5">
                        <Label className="text-xs text-slate-500">Contract Name</Label>
                        <Input
                          value={contractName}
                          onChange={(e) => setContractName(e.target.value)}
                          className="bg-slate-50 font-mono text-sm"
                        />
                      </div>
                    </div>
                  </div>

                  <Separator />

                  {/* Rates & Terms Section */}
                  <div className="space-y-3">
                    <h3 className="text-sm font-semibold text-slate-900 flex items-center gap-2">
                      <DollarSign className="w-4 h-4 text-green-600" /> Rates & Terms
                    </h3>
                    
                    <div className="grid grid-cols-2 gap-3">
                      <div className="grid gap-1.5">
                        <Label className="text-xs text-slate-500">Validity Start</Label>
                        <Input
                          type="date"
                          className="text-sm"
                          value={contractStartDate}
                          onChange={(e) => setContractStartDate(e.target.value)}
                        />
                      </div>
                      <div className="grid gap-1.5">
                        <Label className="text-xs text-slate-500">Validity End</Label>
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
                        <Label className="text-xs text-slate-500">Base Rate</Label>
                        <div className="relative">
                          <span className="absolute left-3 top-2.5 text-slate-500">$</span>
                          <Input
                            className="pl-7 text-lg font-semibold"
                            placeholder="0.00"
                            type="number"
                            step="0.01"
                            value={rate}
                            onChange={(e) => setRate(e.target.value)}
                          />
                        </div>
                      </div>
                      <div className="grid gap-1.5">
                        <Label className="text-xs text-slate-500">Unit</Label>
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
                      <Label className="text-xs text-slate-500">Currency</Label>
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
                  <Collapsible open={showAdvanced} onOpenChange={setShowAdvanced} className="border rounded-md bg-slate-50/50">
                    <CollapsibleTrigger className="flex w-full items-center justify-between p-3 text-sm font-medium hover:bg-slate-100 transition-colors rounded-md">
                      <span>Advanced Pricing (Fuel, Stops)</span>
                      <ChevronDown className={`w-4 h-4 transition-transform ${showAdvanced ? 'rotate-180' : ''}`} />
                    </CollapsibleTrigger>
                    <CollapsibleContent className="px-3 pb-3 space-y-3">
                      <Separator className="mb-3" />
                      <div className="grid gap-1.5">
                        <Label className="text-xs text-slate-500">Fuel Surcharge</Label>
                        <Select
                          value={fuelSurchargeType || 'none'}
                          onValueChange={(value) =>
                            setFuelSurchargeType(value === 'none' ? undefined : (value as 'PERCENTAGE' | 'FLAT' | 'DOE_INDEX'))
                          }
                        >
                          <SelectTrigger className="h-9 bg-white">
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
                            className="h-9 text-xs bg-white mt-2"
                          />
                        )}
                      </div>
                      <div className="grid grid-cols-2 gap-3">
                        <div className="grid gap-1.5">
                          <Label className="text-xs text-slate-500">Stop-off Rate</Label>
                          <Input
                            type="number"
                            step="0.01"
                            placeholder="50.00"
                            value={stopOffRate}
                            onChange={(e) => setStopOffRate(e.target.value)}
                            className="h-9 text-xs bg-white"
                          />
                        </div>
                        <div className="grid gap-1.5">
                          <Label className="text-xs text-slate-500">Included Stops</Label>
                          <Input
                            type="number"
                            value={includedStops}
                            onChange={(e) => setIncludedStops(e.target.value)}
                            className="h-9 text-xs bg-white"
                          />
                        </div>
                      </div>
                    </CollapsibleContent>
                  </Collapsible>

                </div>
              </ScrollArea>

              {/* Void Button (Bottom) */}
              <div className="p-4 border-t bg-slate-50 text-center shrink-0">
                <Button
                  variant="ghost"
                  className="text-red-600 hover:text-red-700 hover:bg-red-50 text-xs h-8"
                  onClick={() => setShowVoidDialog(true)}
                >
                  <Trash2 className="w-3 h-3 mr-2" />
                  These loads are invalid (Void Group)
                </Button>
              </div>
            </div>

            {/* RIGHT COLUMN: The Receipt/Preview */}
            <div className="flex-1 bg-slate-50/30 flex flex-col relative">
              
              {/* Sticky Revenue Header */}
              <div className="p-6 bg-white border-b shadow-sm z-10 grid grid-cols-2 gap-6 items-center shrink-0">
                <div>
                  <h4 className="text-sm font-medium text-slate-500 uppercase tracking-wider">Total Impact</h4>
                  <div className="flex items-baseline gap-2">
                    <span className="text-4xl font-bold text-slate-900 tracking-tight">{selectedLoadIds.length}</span>
                    <span className="text-slate-500">Loads</span>
                  </div>
                </div>
                <div className="text-right">
                  <h4 className="text-sm font-medium text-slate-500 uppercase tracking-wider">Est. Revenue</h4>
                  <div className="flex items-baseline justify-end gap-2 text-green-600">
                    <span className="text-4xl font-bold tracking-tight">
                      {formatCurrency(estimatedRevenue).split('.')[0]}
                    </span>
                    <span className="text-lg font-medium opacity-60">
                      .{formatCurrency(estimatedRevenue).split('.')[1]}
                    </span>
                  </div>
                </div>
              </div>

              {!contractStartDate || !contractEndDate ? (
                <div className="flex-1 flex items-center justify-center text-center p-8">
                  <div>
                    <AlertCircle className="w-12 h-12 mx-auto mb-3 text-slate-300" />
                    <p className="text-sm text-slate-500">Enter contract dates to see preview</p>
                  </div>
                </div>
              ) : !preview ? (
                <div className="flex-1 flex items-center justify-center">
                  <Loader2 className="w-8 h-8 animate-spin text-slate-400" />
                </div>
              ) : preview.count === 0 ? (
                <div className="flex-1 flex items-center justify-center text-center p-8">
                  <div>
                    <AlertCircle className="w-12 h-12 mx-auto mb-3 text-amber-400" />
                    <p className="text-sm font-medium text-slate-700">No loads found in this date range</p>
                    <p className="text-xs text-slate-500 mt-1">Try adjusting the contract dates</p>
                  </div>
                </div>
              ) : (
                <>
                  {/* Table Header */}
                  <div className="flex items-center px-6 py-2 bg-slate-100 border-b text-xs font-medium text-slate-500 shrink-0">
                    <div className="w-8">
                      <Checkbox
                        checked={selectedLoadIds.length === preview.affectedLoadIds.length}
                        onCheckedChange={toggleAllLoads}
                      />
                    </div>
                    <div className="w-24">Date</div>
                    <div className="flex-1">Order #</div>
                    <div className="w-24">Status</div>
                    <div className="w-24 text-right">Preview</div>
                  </div>

                  {/* Table Rows */}
                  <div className="flex-1 overflow-y-auto">
                    <div className="divide-y divide-slate-100">
                      {preview.affectedLoads.map((load) => {
                        const loadRevenue = rateType === 'Flat Rate' ? parseFloat(rate || '0') : 0;
                        return (
                          <div
                            key={load._id}
                            className="flex items-center px-6 py-2.5 hover:bg-blue-50/50 transition-colors group"
                          >
                            <div className="w-8">
                              <Checkbox
                                checked={selectedLoadIds.includes(load._id)}
                                onCheckedChange={() => toggleLoadSelection(load._id)}
                              />
                            </div>
                            <div className="w-24 text-sm text-slate-600">{formatDate(load.createdAt)}</div>
                            <div className="flex-1 text-sm font-medium text-slate-900 font-mono">{load.orderNumber}</div>
                            <div className="w-24">
                              <Badge variant="secondary" className="text-[10px] h-5 px-1.5 font-normal bg-slate-100 text-slate-600">
                                {load.status}
                              </Badge>
                            </div>
                            <div className="w-24 text-right text-sm font-mono text-slate-400 group-hover:text-green-600 transition-colors">
                              {selectedLoadIds.includes(load._id) ? formatCurrency(loadRevenue) : '-'}
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
          <DialogFooter className="px-6 py-4 border-t bg-white shrink-0">
            <Button variant="outline" onClick={onClose} disabled={isSubmitting}>
              Cancel
            </Button>
            <Button
              className="bg-slate-900 hover:bg-slate-800 text-white px-8"
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
              {isSubmitting && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
              {isWildcard ? 'Process as Spot Load' : 'Create Contract & Backfill'}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Void Dialog (Separate) */}
      <Dialog open={showVoidDialog} onOpenChange={setShowVoidDialog}>
        <DialogContent className="max-w-md">
          <DialogHeader>
            <DialogTitle>Void This Cluster?</DialogTitle>
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
              <Popover open={customerComboOpen} onOpenChange={setCustomerComboOpen}>
                <PopoverTrigger asChild>
                  <Button
                    variant="outline"
                    role="combobox"
                    aria-expanded={customerComboOpen}
                    className="w-full justify-between font-normal h-10"
                  >
                    {customerId
                      ? customers?.find((c) => c._id === customerId)?.name + 
                        (customers?.find((c) => c._id === customerId)?.office ? ` (${customers?.find((c) => c._id === customerId)?.office})` : '')
                      : customerName || "Select customer (optional)..."}
                    <ChevronsUpDown className="ml-2 h-4 w-4 shrink-0 opacity-50" />
                  </Button>
                </PopoverTrigger>
                <PopoverContent className="w-[420px] p-0" align="start">
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
