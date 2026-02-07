'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { useMutation, useQuery, useAction } from 'convex/react';
import { api } from '@/convex/_generated/api';
import { Card } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { Loader2, Plus, Trash2, Calculator, User, Building2, RefreshCw, Info, ChevronDown, ChevronRight } from 'lucide-react';
import { Id } from '@/convex/_generated/dataModel';
import { RadioGroup, RadioGroupItem } from '@/components/ui/radio-group';
import { Checkbox } from '@/components/ui/checkbox';
import { Badge } from '@/components/ui/badge';
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '@/components/ui/tooltip';
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from '@/components/ui/collapsible';
import { AddressAutocomplete, AddressData } from '@/components/ui/address-autocomplete';
import { toast } from 'sonner';
import { createISOStringWithTimezone } from '@/lib/googlePlaces';

interface Stop {
  sequenceNumber: number;
  stopType: 'PICKUP' | 'DELIVERY';
  loadingType: 'APPT' | 'FCFS' | 'Live';
  address: string;
  city: string;
  state: string;
  postalCode: string;
  latitude?: number;
  longitude?: number;
  formattedAddress?: string;
  timeZone?: string; // IANA timezone (e.g., "America/Los_Angeles")
  windowBeginDate: string;
  windowBeginTime: string;
  windowEndDate: string;
  windowEndTime: string;
  commodityDescription: string;
  commodityUnits: 'Pallets' | 'Boxes' | 'Pieces' | 'Lbs' | 'Kg';
  pieces: string;
  weight: string;
  instructions: string;
}

interface CreateLoadFormProps {
  organizationId: string;
  userId: string;
}

export function CreateLoadForm({ organizationId, userId }: CreateLoadFormProps) {
  const router = useRouter();
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [isCalculatingMiles, setIsCalculatingMiles] = useState(false);
  const [googleMiles, setGoogleMiles] = useState<number | undefined>(undefined);

  // Fetch customers for dropdown
  const customers = useQuery(api.customers.getCustomers, { workosOrgId: organizationId });

  // Fetch drivers for assignment dropdown
  const drivers = useQuery(api.drivers.list, { organizationId });
  const activeDrivers = drivers?.filter(
    (d) => d.employmentStatus === 'Active' && !d.isDeleted
  );

  // Fetch carriers for assignment dropdown
  const carriers = useQuery(api.carrierPartnerships.listForBroker, { brokerOrgId: organizationId });
  const activeCarriers = carriers?.filter((c) => c.status === 'ACTIVE');

  const createLoad = useMutation(api.loads.createLoad);
  const createRecurringTemplate = useMutation(api.recurringLoads.createFromLoad);
  const calculateDistance = useAction(api.googleMaps.calculateRouteDistance);

  // Load Information State
  const [internalId, setInternalId] = useState('');
  const [orderNumber, setOrderNumber] = useState('');
  const [poNumber, setPoNumber] = useState('');

  // Assignment State
  const [assignmentOpen, setAssignmentOpen] = useState(false);
  const [assigneeType, setAssigneeType] = useState<'none' | 'driver' | 'carrier'>('none');
  const [driverId, setDriverId] = useState<Id<'drivers'> | ''>('');
  const [carrierId, setCarrierId] = useState<Id<'carrierPartnerships'> | ''>('');
  const [customerId, setCustomerId] = useState<Id<'customers'> | ''>('');
  const [fleet, setFleet] = useState('');
  const [equipmentType, setEquipmentType] = useState('');
  const [weight, setWeight] = useState('');
  const [units, setUnits] = useState<'Pallets' | 'Boxes' | 'Pieces' | 'Lbs' | 'Kg'>('Pallets');
  const [billingRate, setBillingRate] = useState('');
  const [billingRateType, setBillingRateType] = useState<'Per Mile' | 'Flat Rate' | 'Per Stop'>('Per Mile');
  const [generalInstructions, setGeneralInstructions] = useState('');

  // Recurring Schedule State
  const [isRecurring, setIsRecurring] = useState(false);
  const [recurringName, setRecurringName] = useState('');
  const [activeDays, setActiveDays] = useState<number[]>([]);
  const [excludeFederalHolidays, setExcludeFederalHolidays] = useState(true);
  const [customExclusions, setCustomExclusions] = useState('');
  const [advanceDays, setAdvanceDays] = useState('1');
  const [generationTime, setGenerationTime] = useState('06:00');
  const [deliveryDayOffset, setDeliveryDayOffset] = useState('0');
  const [recurringEndDate, setRecurringEndDate] = useState('');

  const DAYS_OF_WEEK = [
    { value: 0, label: 'Su' },
    { value: 1, label: 'M' },
    { value: 2, label: 'T' },
    { value: 3, label: 'W' },
    { value: 4, label: 'Th' },
    { value: 5, label: 'F' },
    { value: 6, label: 'Sa' },
  ];

  const toggleDay = (day: number) => {
    setActiveDays((prev) =>
      prev.includes(day) ? prev.filter((d) => d !== day) : [...prev, day]
    );
  };

  // Get assignment summary text
  const getAssignmentSummary = () => {
    if (assigneeType === 'driver' && driverId) {
      const driver = activeDrivers?.find((d) => d._id === driverId);
      return driver ? `Driver: ${driver.firstName} ${driver.lastName}` : 'Driver selected';
    }
    if (assigneeType === 'carrier' && carrierId) {
      const carrier = activeCarriers?.find((c) => c._id === carrierId);
      return carrier ? `Carrier: ${carrier.carrierName}` : 'Carrier selected';
    }
    return 'Unassigned';
  };

  // Get recurring summary text
  const getRecurringSummary = () => {
    if (!isRecurring) return 'One-time load';
    const dayNames = ['Su', 'M', 'T', 'W', 'Th', 'F', 'Sa'];
    const selectedDays = activeDays.sort().map((d) => dayNames[d]).join(', ');
    return selectedDays ? `Recurring: ${selectedDays}` : 'Recurring (configure days)';
  };

  // Stops State
  const [stops, setStops] = useState<Stop[]>([
    {
      sequenceNumber: 1,
      stopType: 'PICKUP',
      loadingType: 'APPT',
      address: '',
      city: '',
      state: '',
      postalCode: '',
      windowBeginDate: '',
      windowBeginTime: '',
      windowEndDate: '',
      windowEndTime: '',
      commodityDescription: '',
      commodityUnits: 'Pallets',
      pieces: '',
      weight: '',
      instructions: '',
    },
  ]);

  const addStop = () => {
    setStops([
      ...stops,
      {
        sequenceNumber: stops.length + 1,
        stopType: 'DELIVERY',
        loadingType: 'APPT',
        address: '',
        city: '',
        state: '',
        postalCode: '',
        windowBeginDate: '',
        windowBeginTime: '',
        windowEndDate: '',
        windowEndTime: '',
        commodityDescription: '',
        commodityUnits: 'Pallets',
        pieces: '',
        weight: '',
        instructions: '',
      },
    ]);
  };

  const removeStop = (index: number) => {
    if (stops.length > 1) {
      const newStops = stops.filter((_, i) => i !== index);
      // Re-sequence
      newStops.forEach((stop, i) => {
        stop.sequenceNumber = i + 1;
      });
      setStops(newStops);
    }
  };

  const updateStop = (index: number, field: keyof Stop, value: any) => {
    const newStops = [...stops];
    newStops[index] = { ...newStops[index], [field]: value };
    setStops(newStops);
  };

  const handleAddressSelect = (index: number, data: AddressData) => {
    const newStops = [...stops];
    newStops[index] = {
      ...newStops[index],
      address: data.address,
      city: data.city,
      state: data.state,
      postalCode: data.postalCode,
      latitude: data.latitude,
      longitude: data.longitude,
      formattedAddress: data.formattedAddress || `${data.address}, ${data.city}, ${data.state} ${data.postalCode}`,
      timeZone: data.timeZone, // Store the stop's timezone
    };
    setStops(newStops);
  };

  const handleCalculateDistance = async () => {
    // Check if all stops have coordinates
    const stopsWithCoordinates = stops.filter(stop => stop.latitude && stop.longitude);
    
    if (stopsWithCoordinates.length < 2) {
      toast.error('At least 2 stops with addresses are required to calculate distance');
      return;
    }

    if (stopsWithCoordinates.length !== stops.length) {
      toast.error('Please ensure all stops have valid addresses selected from autocomplete');
      return;
    }

    setIsCalculatingMiles(true);
    try {
      const result = await calculateDistance({
        stops: stops.map(stop => ({
          latitude: stop.latitude!,
          longitude: stop.longitude!,
        })),
      });
      
      setGoogleMiles(result.miles);
      toast.success(`Distance calculated: ${result.miles} miles (${result.durationHours} hours)`);
    } catch (error) {
      console.error('Error calculating distance:', error);
      toast.error('Failed to calculate distance. Please try again.');
    } finally {
      setIsCalculatingMiles(false);
    }
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setIsSubmitting(true);

    try {
      // Validate
      if (!customerId) {
        alert('Please select a customer');
        setIsSubmitting(false);
        return;
      }

      // Format stops data with timezone-aware ISO timestamps
      const formattedStops = stops.map((stop) => {
        // Convert date+time to full ISO string if timezone is available
        let windowBeginTime = stop.windowBeginTime;
        let windowEndTime = stop.windowEndTime;
        
        if (stop.timeZone && stop.windowBeginDate && stop.windowBeginTime) {
          windowBeginTime = createISOStringWithTimezone(
            stop.windowBeginDate,
            stop.windowBeginTime,
            stop.timeZone
          );
        }
        
        if (stop.timeZone && stop.windowEndDate && stop.windowEndTime) {
          windowEndTime = createISOStringWithTimezone(
            stop.windowEndDate,
            stop.windowEndTime,
            stop.timeZone
          );
        }

        return {
          sequenceNumber: stop.sequenceNumber,
          stopType: stop.stopType,
          loadingType: stop.loadingType,
          address: stop.address,
          city: stop.city || undefined,
          state: stop.state || undefined,
          postalCode: stop.postalCode || undefined,
          latitude: stop.latitude,
          longitude: stop.longitude,
          timeZone: stop.timeZone, // Store timezone on the stop
          windowBeginDate: stop.windowBeginDate,
          windowBeginTime, // Now a full ISO string with timezone
          windowEndDate: stop.windowEndDate,
          windowEndTime, // Now a full ISO string with timezone
          commodityDescription: stop.commodityDescription,
          commodityUnits: stop.commodityUnits,
          pieces: parseFloat(stop.pieces) || 0,
          weight: parseFloat(stop.weight) || undefined,
          instructions: stop.instructions || undefined,
        };
      });

      // Validate recurring settings
      if (isRecurring) {
        if (!recurringName.trim()) {
          alert('Please enter a template name for recurring loads');
          setIsSubmitting(false);
          return;
        }
        if (activeDays.length === 0) {
          alert('Please select at least one day for recurring loads');
          setIsSubmitting(false);
          return;
        }
      }

      const loadId = await createLoad({
        workosOrgId: organizationId,
        createdBy: userId,
        internalId,
        orderNumber,
        poNumber: poNumber || undefined,
        customerId: customerId as Id<'customers'>,
        fleet,
        equipmentType: equipmentType || undefined,
        weight: parseFloat(weight) || undefined,
        units,
        googleMiles,
        generalInstructions: generalInstructions || undefined,
        // Direct assignment
        assignDriverId: assigneeType === 'driver' && driverId ? driverId : undefined,
        assignCarrierId: assigneeType === 'carrier' && carrierId ? carrierId : undefined,
        stops: formattedStops,
      });

      // Create recurring template if enabled
      if (isRecurring && loadId) {
        try {
          await createRecurringTemplate({
            sourceLoadId: loadId as Id<'loadInformation'>,
            name: recurringName,
            activeDays,
            excludeFederalHolidays,
            customExclusions: customExclusions
              .split(',')
              .map((d) => d.trim())
              .filter((d) => d && /^\d{4}-\d{2}-\d{2}$/.test(d)),
            generationTime,
            advanceDays: parseInt(advanceDays) || 1,
            deliveryDayOffset: parseInt(deliveryDayOffset) || 0,
            endDate: recurringEndDate || undefined,
            // Pass direct driver/carrier assignment for recurring loads
            driverId: assigneeType === 'driver' && driverId ? driverId : undefined,
            carrierPartnershipId: assigneeType === 'carrier' && carrierId ? carrierId : undefined,
            createdBy: userId,
          });
          toast.success('Recurring template created');
        } catch (error) {
          console.error('Failed to create recurring template:', error);
          toast.error('Load created but recurring template failed');
        }
      }

      router.push('/loads');
    } catch (error) {
      console.error('Error creating load:', error);
      alert('Failed to create load. Please try again.');
      setIsSubmitting(false);
    }
  };

  return (
    <form onSubmit={handleSubmit} className="space-y-6 pb-24">
      {/* Header */}
      <div>
        <h1 className="text-3xl font-bold tracking-tight">Create Load</h1>
        <p className="text-muted-foreground">Fill in the load details and stops</p>
      </div>

      {/* Primary Load Details */}
      <Card className="p-6 shadow-sm">
        <h2 className="text-xl font-semibold mb-4">Load Details</h2>
        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-4">
          <div className="space-y-2">
            <Label htmlFor="internalId">Internal ID *</Label>
            <Input
              id="internalId"
              value={internalId}
              onChange={(e) => setInternalId(e.target.value)}
              required
              placeholder="e.g., LOAD-001"
            />
          </div>

          <div className="space-y-2">
            <Label htmlFor="orderNumber">Order Number *</Label>
            <Input
              id="orderNumber"
              value={orderNumber}
              onChange={(e) => setOrderNumber(e.target.value)}
              required
              placeholder="e.g., ORD-2024-001"
            />
          </div>

          <div className="space-y-2">
            <Label htmlFor="poNumber">PO Number</Label>
            <Input
              id="poNumber"
              value={poNumber}
              onChange={(e) => setPoNumber(e.target.value)}
              placeholder="Purchase Order #"
            />
          </div>

          <div className="space-y-2">
            <Label htmlFor="customer">Customer *</Label>
            <Select value={customerId} onValueChange={(value) => setCustomerId(value as Id<'customers'>)}>
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
          </div>

          <div className="space-y-2">
            <Label htmlFor="fleet">Fleet *</Label>
            <Input
              id="fleet"
              value={fleet}
              onChange={(e) => setFleet(e.target.value)}
              required
              placeholder="e.g., Fleet A"
            />
          </div>

          <div className="space-y-2">
            <Label htmlFor="equipmentType">Equipment Type</Label>
            <Input
              id="equipmentType"
              value={equipmentType}
              onChange={(e) => setEquipmentType(e.target.value)}
              placeholder="e.g., Dry Van"
            />
          </div>
        </div>
      </Card>

      {/* Collapsible Assignment Section */}
      <Card className="shadow-sm overflow-hidden">
        <Collapsible open={assignmentOpen} onOpenChange={setAssignmentOpen}>
          <CollapsibleTrigger asChild>
            <button
              type="button"
              className="w-full flex items-center justify-between p-4 hover:bg-muted/50 transition-colors"
            >
              <div className="flex items-center gap-3">
                {assignmentOpen ? (
                  <ChevronDown className="h-5 w-5 text-muted-foreground" />
                ) : (
                  <ChevronRight className="h-5 w-5 text-muted-foreground" />
                )}
                <div className="text-left">
                  <h3 className="font-semibold">Assignment</h3>
                  <p className="text-sm text-muted-foreground">{getAssignmentSummary()}</p>
                </div>
              </div>
              <Badge variant={assigneeType === 'none' ? 'secondary' : 'default'}>
                {assigneeType === 'none' ? 'Open' : assigneeType === 'driver' ? 'Driver' : 'Carrier'}
              </Badge>
            </button>
          </CollapsibleTrigger>
          <CollapsibleContent>
            <div className="px-6 pb-6 pt-2 border-t space-y-4">
              <RadioGroup
                value={assigneeType}
                onValueChange={(v) => {
                  setAssigneeType(v as 'none' | 'driver' | 'carrier');
                  if (v === 'none') {
                    setDriverId('');
                    setCarrierId('');
                  } else if (v === 'driver') {
                    setCarrierId('');
                  } else {
                    setDriverId('');
                  }
                }}
                className="flex gap-4"
              >
                <div className="flex items-center space-x-2">
                  <RadioGroupItem value="none" id="assign-none" />
                  <Label htmlFor="assign-none" className="cursor-pointer">
                    None (Open)
                  </Label>
                </div>
                <div className="flex items-center space-x-2">
                  <RadioGroupItem value="driver" id="assign-driver" />
                  <Label htmlFor="assign-driver" className="flex items-center gap-2 cursor-pointer">
                    <User className="h-4 w-4" />
                    Driver
                  </Label>
                </div>
                <div className="flex items-center space-x-2">
                  <RadioGroupItem value="carrier" id="assign-carrier" />
                  <Label htmlFor="assign-carrier" className="flex items-center gap-2 cursor-pointer">
                    <Building2 className="h-4 w-4" />
                    Carrier
                  </Label>
                </div>
              </RadioGroup>

              {/* Driver Selection */}
              {assigneeType === 'driver' && (
                <Select value={driverId} onValueChange={(v) => setDriverId(v as Id<'drivers'>)}>
                  <SelectTrigger>
                    <SelectValue placeholder="Select a driver..." />
                  </SelectTrigger>
                  <SelectContent>
                    {activeDrivers?.map((driver) => (
                      <SelectItem key={driver._id} value={driver._id}>
                        {driver.firstName} {driver.lastName}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              )}

              {/* Carrier Selection */}
              {assigneeType === 'carrier' && (
                <Select value={carrierId} onValueChange={(v) => setCarrierId(v as Id<'carrierPartnerships'>)}>
                  <SelectTrigger>
                    <SelectValue placeholder="Select a carrier..." />
                  </SelectTrigger>
                  <SelectContent>
                    {activeCarriers?.map((carrier) => (
                      <SelectItem key={carrier._id} value={carrier._id}>
                        {carrier.carrierName} ({carrier.mcNumber})
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              )}
            </div>
          </CollapsibleContent>
        </Collapsible>
      </Card>

      {/* Collapsible Recurring Schedule Section */}
      <Card className="shadow-sm overflow-hidden">
        <Collapsible open={isRecurring} onOpenChange={setIsRecurring}>
          <CollapsibleTrigger asChild>
            <button
              type="button"
              className="w-full flex items-center justify-between p-4 hover:bg-muted/50 transition-colors"
            >
              <div className="flex items-center gap-3">
                {isRecurring ? (
                  <ChevronDown className="h-5 w-5 text-muted-foreground" />
                ) : (
                  <ChevronRight className="h-5 w-5 text-muted-foreground" />
                )}
                <div className="text-left">
                  <h3 className="font-semibold flex items-center gap-2">
                    <RefreshCw className="h-4 w-4" />
                    Recurring Schedule
                  </h3>
                  <p className="text-sm text-muted-foreground">{getRecurringSummary()}</p>
                </div>
              </div>
              <Badge variant={isRecurring ? 'default' : 'secondary'}>
                {isRecurring ? 'Recurring' : 'One-time'}
              </Badge>
            </button>
          </CollapsibleTrigger>
          <CollapsibleContent>
            <div className="px-6 pb-6 pt-2 border-t space-y-4">
              {/* Template Name */}
              <div className="space-y-2">
                <Label htmlFor="recurringName">Template Name *</Label>
                <Input
                  id="recurringName"
                  value={recurringName}
                  onChange={(e) => setRecurringName(e.target.value)}
                  placeholder="e.g., Sunday Amazon Route"
                  required={isRecurring}
                />
              </div>

              {/* Days of Week */}
              <div className="space-y-2">
                <Label>Generate On *</Label>
                <div className="flex flex-wrap gap-2">
                  {DAYS_OF_WEEK.map((day) => (
                    <Button
                      key={day.value}
                      type="button"
                      variant={activeDays.includes(day.value) ? 'default' : 'outline'}
                      size="sm"
                      className="w-10"
                      onClick={() => toggleDay(day.value)}
                    >
                      {day.label}
                    </Button>
                  ))}
                </div>
              </div>

              {/* Holiday Exclusions */}
              <div className="space-y-3">
                <div className="flex items-center space-x-2">
                  <Checkbox
                    id="excludeHolidays"
                    checked={excludeFederalHolidays}
                    onCheckedChange={(checked) => setExcludeFederalHolidays(checked === true)}
                  />
                  <Label htmlFor="excludeHolidays" className="cursor-pointer">
                    Skip Federal Holidays
                  </Label>
                </div>

                <div className="space-y-2">
                  <Label htmlFor="customExclusions">Custom Exclusion Dates</Label>
                  <Input
                    id="customExclusions"
                    placeholder="e.g., 2026-12-25, 2026-12-26"
                    value={customExclusions}
                    onChange={(e) => setCustomExclusions(e.target.value)}
                  />
                  <p className="text-xs text-muted-foreground">
                    Comma-separated dates in YYYY-MM-DD format
                  </p>
                </div>
              </div>

              {/* Timing */}
              <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
                <div className="space-y-2">
                  <div className="flex items-center gap-2">
                    <Label htmlFor="generationTime">Generation Time</Label>
                    <TooltipProvider>
                      <Tooltip>
                        <TooltipTrigger asChild>
                          <Info className="h-4 w-4 text-muted-foreground cursor-help" />
                        </TooltipTrigger>
                        <TooltipContent className="max-w-xs">
                          <p>Time of day when recurring loads are generated by the system.</p>
                        </TooltipContent>
                      </Tooltip>
                    </TooltipProvider>
                  </div>
                  <Input
                    id="generationTime"
                    type="time"
                    value={generationTime}
                    onChange={(e) => setGenerationTime(e.target.value)}
                  />
                </div>
                <div className="space-y-2">
                  <div className="flex items-center gap-2">
                    <Label htmlFor="advanceDays">Advance Days</Label>
                    <TooltipProvider>
                      <Tooltip>
                        <TooltipTrigger asChild>
                          <Info className="h-4 w-4 text-muted-foreground cursor-help" />
                        </TooltipTrigger>
                        <TooltipContent className="max-w-xs">
                          <p>Create load N days before pickup. 0 = same day, 1 = day before.</p>
                        </TooltipContent>
                      </Tooltip>
                    </TooltipProvider>
                  </div>
                  <Input
                    id="advanceDays"
                    type="number"
                    min="0"
                    max="7"
                    value={advanceDays}
                    onChange={(e) => setAdvanceDays(e.target.value)}
                  />
                </div>
                <div className="space-y-2">
                  <div className="flex items-center gap-2">
                    <Label htmlFor="deliveryDayOffset">Delivery Day Offset</Label>
                    <TooltipProvider>
                      <Tooltip>
                        <TooltipTrigger asChild>
                          <Info className="h-4 w-4 text-muted-foreground cursor-help" />
                        </TooltipTrigger>
                        <TooltipContent className="max-w-xs">
                          <p>For multi-day loads: 0 = same day, 1 = next day delivery.</p>
                        </TooltipContent>
                      </Tooltip>
                    </TooltipProvider>
                  </div>
                  <Select value={deliveryDayOffset} onValueChange={setDeliveryDayOffset}>
                    <SelectTrigger>
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="0">Same Day (0)</SelectItem>
                      <SelectItem value="1">Next Day (+1)</SelectItem>
                      <SelectItem value="2">Day After (+2)</SelectItem>
                      <SelectItem value="3">Three Days (+3)</SelectItem>
                    </SelectContent>
                  </Select>
                </div>
              </div>

              {/* End Date */}
              <div className="space-y-2">
                <Label htmlFor="recurringEndDate">End Date (Optional)</Label>
                <Input
                  id="recurringEndDate"
                  type="date"
                  value={recurringEndDate}
                  onChange={(e) => setRecurringEndDate(e.target.value)}
                />
                <p className="text-xs text-muted-foreground">
                  Leave empty for no expiration
                </p>
              </div>
            </div>
          </CollapsibleContent>
        </Collapsible>
      </Card>

      {/* Cargo & Billing */}
      <Card className="p-6 shadow-sm">
        <h2 className="text-xl font-semibold mb-4">Cargo & Billing</h2>
        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-4">
          <div className="space-y-2">
            <Label htmlFor="weight">Weight</Label>
            <Input
              id="weight"
              type="number"
              step="0.01"
              value={weight}
              onChange={(e) => setWeight(e.target.value)}
              placeholder="0.00"
            />
          </div>

          <div className="space-y-2">
            <Label htmlFor="units">Units *</Label>
            <Select value={units} onValueChange={(value: any) => setUnits(value)}>
              <SelectTrigger>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="Pallets">Pallets</SelectItem>
                <SelectItem value="Boxes">Boxes</SelectItem>
                <SelectItem value="Pieces">Pieces</SelectItem>
                <SelectItem value="Lbs">Lbs</SelectItem>
                <SelectItem value="Kg">Kg</SelectItem>
              </SelectContent>
            </Select>
          </div>

          <div className="space-y-2">
            <Label htmlFor="billingRate">Billing Rate</Label>
            <Input
              id="billingRate"
              type="number"
              step="0.01"
              value={billingRate}
              onChange={(e) => setBillingRate(e.target.value)}
              placeholder="0.00"
            />
          </div>

          <div className="space-y-2">
            <Label htmlFor="billingRateType">Billing Rate Type *</Label>
            <Select value={billingRateType} onValueChange={(value: any) => setBillingRateType(value)}>
              <SelectTrigger>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="Per Mile">Per Mile</SelectItem>
                <SelectItem value="Flat Rate">Flat Rate</SelectItem>
                <SelectItem value="Per Stop">Per Stop</SelectItem>
              </SelectContent>
            </Select>
          </div>

          <div className="space-y-2 lg:col-span-4">
            <Label htmlFor="generalInstructions">General Instructions</Label>
            <Textarea
              id="generalInstructions"
              value={generalInstructions}
              onChange={(e) => setGeneralInstructions(e.target.value)}
              placeholder="Any special instructions for this load..."
              rows={2}
            />
          </div>
        </div>
      </Card>

      {/* Stops */}
      <div className="space-y-4">
        <div className="flex items-center justify-between">
          <div>
            <h2 className="text-xl font-semibold">Stops ({stops.length})</h2>
            {googleMiles && (
              <p className="text-sm text-muted-foreground mt-1">
                Calculated Distance: <span className="font-semibold">{googleMiles} miles</span>
              </p>
            )}
          </div>
          <div className="flex gap-2">
            <Button 
              type="button" 
              onClick={handleCalculateDistance} 
              variant="secondary"
              disabled={isCalculatingMiles || stops.length < 2}
            >
              {isCalculatingMiles ? (
                <>
                  <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                  Calculating...
                </>
              ) : (
                <>
                  <Calculator className="mr-2 h-4 w-4" />
                  Calculate Miles
                </>
              )}
            </Button>
            <Button type="button" onClick={addStop} variant="outline">
              <Plus className="mr-2 h-4 w-4" />
              Add Stop
            </Button>
          </div>
        </div>

        {stops.map((stop, index) => (
          <Card key={index} className="p-6 shadow-sm">
            <div className="flex items-center justify-between mb-4">
              <div className="flex items-center gap-3">
                <span className="text-lg font-medium">Stop {stop.sequenceNumber}</span>
                <Badge 
                  variant={stop.stopType === 'PICKUP' ? 'default' : 'secondary'}
                  className={stop.stopType === 'PICKUP' 
                    ? 'bg-blue-600 hover:bg-blue-700' 
                    : 'bg-green-600 hover:bg-green-700 text-white'}
                >
                  {stop.stopType === 'PICKUP' ? '↑ PICKUP' : '↓ DELIVERY'}
                </Badge>
              </div>
              {stops.length > 1 && (
                <Button type="button" variant="ghost" size="sm" onClick={() => removeStop(index)}>
                  <Trash2 className="h-4 w-4" />
                </Button>
              )}
            </div>

            <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
              <div className="space-y-2">
                <Label>Stop Type *</Label>
                <Select
                  value={stop.stopType}
                  onValueChange={(value: any) => updateStop(index, 'stopType', value)}
                >
                  <SelectTrigger>
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="PICKUP">Pickup</SelectItem>
                    <SelectItem value="DELIVERY">Delivery</SelectItem>
                  </SelectContent>
                </Select>
              </div>

              <div className="space-y-2">
                <Label>Loading Type *</Label>
                <Select
                  value={stop.loadingType}
                  onValueChange={(value: any) => updateStop(index, 'loadingType', value)}
                >
                  <SelectTrigger>
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="APPT">Appointment</SelectItem>
                    <SelectItem value="FCFS">First Come First Served</SelectItem>
                    <SelectItem value="Live">Live</SelectItem>
                  </SelectContent>
                </Select>
              </div>

              <div className="space-y-2 md:col-span-3">
                <Label>Address *</Label>
                <AddressAutocomplete
                  value={stop.formattedAddress || ''}
                  onSelect={(data) => handleAddressSelect(index, data)}
                />
              </div>

              {stop.latitude && stop.longitude && (
                <div className="space-y-2 md:col-span-3">
                  <p className="text-xs text-muted-foreground">
                    📍 Coordinates: {stop.latitude.toFixed(6)}, {stop.longitude.toFixed(6)}
                  </p>
                </div>
              )}

              <div className="space-y-2">
                <Label>Window Begin Date *</Label>
                <Input
                  type="date"
                  value={stop.windowBeginDate}
                  onChange={(e) => updateStop(index, 'windowBeginDate', e.target.value)}
                  required
                />
              </div>

              <div className="space-y-2">
                <Label>Window Begin Time *</Label>
                <Input
                  type="time"
                  value={stop.windowBeginTime}
                  onChange={(e) => updateStop(index, 'windowBeginTime', e.target.value)}
                  required
                />
              </div>

              <div className="space-y-2">
                <Label>Window End Date *</Label>
                <Input
                  type="date"
                  value={stop.windowEndDate}
                  onChange={(e) => updateStop(index, 'windowEndDate', e.target.value)}
                  required
                />
              </div>

              <div className="space-y-2">
                <Label>Window End Time *</Label>
                <Input
                  type="time"
                  value={stop.windowEndTime}
                  onChange={(e) => updateStop(index, 'windowEndTime', e.target.value)}
                  required
                />
              </div>

              <div className="space-y-2">
                <Label>Commodity *</Label>
                <Input
                  value={stop.commodityDescription}
                  onChange={(e) => updateStop(index, 'commodityDescription', e.target.value)}
                  required
                  placeholder="e.g., Electronics"
                />
              </div>

              <div className="space-y-2">
                <Label>Commodity Units *</Label>
                <Select
                  value={stop.commodityUnits}
                  onValueChange={(value: any) => updateStop(index, 'commodityUnits', value)}
                >
                  <SelectTrigger>
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="Pallets">Pallets</SelectItem>
                    <SelectItem value="Boxes">Boxes</SelectItem>
                    <SelectItem value="Pieces">Pieces</SelectItem>
                    <SelectItem value="Lbs">Lbs</SelectItem>
                    <SelectItem value="Kg">Kg</SelectItem>
                  </SelectContent>
                </Select>
              </div>

              <div className="space-y-2">
                <Label>Pieces *</Label>
                <Input
                  type="number"
                  value={stop.pieces}
                  onChange={(e) => updateStop(index, 'pieces', e.target.value)}
                  required
                  placeholder="0"
                />
              </div>

              <div className="space-y-2">
                <Label>Weight</Label>
                <Input
                  type="number"
                  step="0.01"
                  value={stop.weight}
                  onChange={(e) => updateStop(index, 'weight', e.target.value)}
                  placeholder="0.00"
                />
              </div>

              <div className="space-y-2 md:col-span-2">
                <Label>Instructions</Label>
                <Textarea
                  value={stop.instructions}
                  onChange={(e) => updateStop(index, 'instructions', e.target.value)}
                  placeholder="Special instructions for this stop..."
                  rows={2}
                />
              </div>
            </div>
          </Card>
        ))}
      </div>

      {/* Sticky Footer */}
      <div className="fixed bottom-0 left-0 right-0 bg-background/95 backdrop-blur supports-[backdrop-filter]:bg-background/80 border-t z-50">
        <div className="container mx-auto px-4 py-4 flex items-center justify-between">
          <p className="text-sm text-muted-foreground hidden sm:block">
            {stops.length} stop{stops.length !== 1 ? 's' : ''} • {getAssignmentSummary()} • {getRecurringSummary()}
          </p>
          <div className="flex gap-3 ml-auto">
            <Button type="button" variant="outline" onClick={() => router.back()}>
              Cancel
            </Button>
            <Button type="submit" disabled={isSubmitting || !customers}>
              {isSubmitting ? (
                <>
                  <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                  Creating...
                </>
              ) : (
                'Create Load'
              )}
            </Button>
          </div>
        </div>
      </div>
    </form>
  );
}
