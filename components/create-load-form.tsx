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
import { Loader2, Plus, Trash2, Calculator } from 'lucide-react';
import { Id } from '@/convex/_generated/dataModel';
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

  const createLoad = useMutation(api.loads.createLoad);
  const calculateDistance = useAction(api.googleMaps.calculateRouteDistance);

  // Load Information State
  const [internalId, setInternalId] = useState('');
  const [orderNumber, setOrderNumber] = useState('');
  const [poNumber, setPoNumber] = useState('');
  const [customerId, setCustomerId] = useState<Id<'customers'> | ''>('');
  const [fleet, setFleet] = useState('');
  const [equipmentType, setEquipmentType] = useState('');
  const [weight, setWeight] = useState('');
  const [units, setUnits] = useState<'Pallets' | 'Boxes' | 'Pieces' | 'Lbs' | 'Kg'>('Pallets');
  const [billingRate, setBillingRate] = useState('');
  const [billingRateType, setBillingRateType] = useState<'Per Mile' | 'Flat Rate' | 'Per Stop'>('Per Mile');
  const [generalInstructions, setGeneralInstructions] = useState('');

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

      await createLoad({
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
        stops: formattedStops,
      });

      router.push('/loads');
    } catch (error) {
      console.error('Error creating load:', error);
      alert('Failed to create load. Please try again.');
      setIsSubmitting(false);
    }
  };

  return (
    <form onSubmit={handleSubmit} className="space-y-6">
      {/* Header */}
      <div>
        <h1 className="text-3xl font-bold tracking-tight">Create Load</h1>
        <p className="text-muted-foreground">Fill in the load details and stops</p>
      </div>

      {/* Load Information */}
      <Card className="p-6">
        <h2 className="text-xl font-semibold mb-4">Load Information</h2>
        <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
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

          <div className="space-y-2 md:col-span-2">
            <Label htmlFor="generalInstructions">General Instructions</Label>
            <Textarea
              id="generalInstructions"
              value={generalInstructions}
              onChange={(e) => setGeneralInstructions(e.target.value)}
              placeholder="Any special instructions for this load..."
              rows={3}
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
          <Card key={index} className="p-6">
            <div className="flex items-center justify-between mb-4">
              <h3 className="text-lg font-medium">
                Stop {stop.sequenceNumber} - {stop.stopType}
              </h3>
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

      {/* Submit */}
      <div className="flex gap-4">
        <Button type="button" variant="outline" onClick={() => router.back()}>
          Cancel
        </Button>
        <Button type="submit" disabled={isSubmitting || !customers}>
          {isSubmitting ? (
            <>
              <Loader2 className="mr-2 h-4 w-4 animate-spin" />
              Creating Load...
            </>
          ) : (
            'Create Load'
          )}
        </Button>
      </div>
    </form>
  );
}
