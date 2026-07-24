'use client';

import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Card } from '@/components/ui/card';
import { Plus, Trash2 } from 'lucide-react';
import { AddressAutocomplete, AddressData } from '@/components/ui/address-autocomplete';
import { useState } from 'react';
import { useAuthQuery } from '@/hooks/use-auth-query';
import { api } from '@/convex/_generated/api';
import type { Id } from '@/convex/_generated/dataModel';

type Stop = {
  address: string;
  city: string;
  state: string;
  zip: string;
  stopOrder: number;
  stopType: 'Pickup' | 'Delivery';
  type: 'APPT' | 'FCFS' | 'Live';
  arrivalTime: string;
  // Facility binding — loads imported on this lane snap this stop to the
  // bound facility's verified pin (see facilities registry).
  facilityId?: Id<'facilities'>;
  nassCode?: string;
};

interface StopInputProps {
  stops: Stop[];
  onChange: (stops: Stop[]) => void;
  /** Enables the facility picker, scoped to this customer's facilities. */
  customerId?: Id<'customers'>;
}

const NO_FACILITY = '__none__';

export function StopInput({ stops, onChange, customerId }: StopInputProps) {
  const [addressStates, setAddressStates] = useState<(AddressData | null)[]>(new Array(stops.length).fill(null));
  const facilities = useAuthQuery(
    api.facilities.listByCustomer,
    customerId ? { customerId } : 'skip',
  );

  const addStop = () => {
    const newStop: Stop = {
      address: '',
      city: '',
      state: '',
      zip: '',
      stopOrder: stops.length + 1,
      stopType: 'Pickup',
      type: 'APPT',
      arrivalTime: '',
    };
    onChange([...stops, newStop]);
    setAddressStates([...addressStates, null]);
  };

  const removeStop = (index: number) => {
    const newStops = stops.filter((_, i) => i !== index);
    // Reorder remaining stops
    const reorderedStops = newStops.map((stop, i) => ({
      ...stop,
      stopOrder: i + 1,
    }));
    onChange(reorderedStops);
    setAddressStates(addressStates.filter((_, i) => i !== index));
  };

  const updateStop = (index: number, field: keyof Stop, value: string | number) => {
    const newStops = [...stops];
    newStops[index] = { ...newStops[index], [field]: value };
    onChange(newStops);
  };

  // Binding a facility fills the address fields from the registry row —
  // one source of truth for where the stop physically is.
  const bindFacility = (index: number, facilityIdValue: string) => {
    const newStops = [...stops];
    if (facilityIdValue === NO_FACILITY) {
      const { facilityId: _dropped, ...rest } = newStops[index];
      newStops[index] = rest;
      onChange(newStops);
      return;
    }
    const facility = facilities?.find((f) => f._id === facilityIdValue);
    newStops[index] = {
      ...newStops[index],
      facilityId: facilityIdValue as Id<'facilities'>,
      ...(facility
        ? {
            address: facility.addressLine1 || newStops[index].address,
            city: facility.city,
            state: facility.state,
            zip: facility.postalCode || newStops[index].zip,
            ...(facility.externalCode ? { nassCode: facility.externalCode } : {}),
          }
        : {}),
    };
    onChange(newStops);
  };

  const handleAddressSelect = (index: number, data: AddressData) => {
    const newStops = [...stops];
    newStops[index] = {
      ...newStops[index],
      address: data.address,
      city: data.city,
      state: data.state,
      zip: data.postalCode,
    };
    onChange(newStops);
    const newAddressStates = [...addressStates];
    newAddressStates[index] = data;
    setAddressStates(newAddressStates);
  };

  return (
    <div className="space-y-4">
      {stops.map((stop, index) => (
        <Card key={index} className="p-4">
          <div className="flex items-center justify-between mb-4">
            <h3 className="text-lg font-semibold">Stop {stop.stopOrder}</h3>
            {stops.length > 1 && (
              <Button type="button" variant="ghost" size="sm" onClick={() => removeStop(index)}>
                <Trash2 className="h-4 w-4" />
              </Button>
            )}
          </div>

          <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-4">
            {customerId && (facilities?.length ?? 0) > 0 && (
              <div className="space-y-2 lg:col-span-4">
                <Label>Facility</Label>
                <Select
                  value={stop.facilityId ?? NO_FACILITY}
                  onValueChange={(value) => bindFacility(index, value)}
                >
                  <SelectTrigger>
                    <SelectValue placeholder="Bind to a facility (optional)" />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value={NO_FACILITY}>No facility binding</SelectItem>
                    {facilities?.map((f) => (
                      <SelectItem key={f._id} value={f._id}>
                        {f.name} — {f.city}, {f.state}
                        {f.verificationState === 'VERIFIED' ? ' ✓' : ''}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
                <p className="text-xs text-muted-foreground">
                  Imported loads snap this stop to the facility&apos;s pin for driver geofencing.
                </p>
              </div>
            )}

            <div className="space-y-2 lg:col-span-4">
              <Label className={stop.address ? 'text-foreground' : 'text-destructive'}>
                Address
              </Label>
              <AddressAutocomplete
                value={stop.address}
                onChange={(value) => updateStop(index, 'address', value)}
                onSelect={(data) => handleAddressSelect(index, data)}
                placeholder="Start typing address..."
              />
              <p className="text-xs text-muted-foreground">Type to search or enter manually</p>
            </div>
            <div className="group/field space-y-2">
              <Label className="text-destructive group-has-[:valid]/field:text-foreground">
                City
              </Label>
              <Input
                value={stop.city}
                onChange={(e) => updateStop(index, 'city', e.target.value)}
                required
              />
            </div>
            <div className="group/field space-y-2">
              <Label className="text-destructive group-has-[:valid]/field:text-foreground">
                State
              </Label>
              <Input
                value={stop.state}
                onChange={(e) => updateStop(index, 'state', e.target.value)}
                placeholder="CA"
                required
              />
            </div>
            <div className="group/field space-y-2">
              <Label className="text-destructive group-has-[:valid]/field:text-foreground">
                ZIP
              </Label>
              <Input
                value={stop.zip}
                onChange={(e) => updateStop(index, 'zip', e.target.value)}
                required
              />
            </div>

            <div className="space-y-2">
              <Label className="text-destructive">
                Stop Type
              </Label>
              <Select
                value={stop.stopType}
                onValueChange={(value) => updateStop(index, 'stopType', value)}
              >
                <SelectTrigger>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="Pickup">Pickup</SelectItem>
                  <SelectItem value="Delivery">Delivery</SelectItem>
                </SelectContent>
              </Select>
            </div>

            <div className="space-y-2">
              <Label className="text-destructive">
                Type
              </Label>
              <Select value={stop.type} onValueChange={(value) => updateStop(index, 'type', value)}>
                <SelectTrigger>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="APPT">Appointment</SelectItem>
                  <SelectItem value="FCFS">FCFS</SelectItem>
                  <SelectItem value="Live">Live</SelectItem>
                </SelectContent>
              </Select>
            </div>

            <div className="group/field space-y-2">
              <Label className="text-destructive group-has-[:valid]/field:text-foreground">
                Arrival Time
              </Label>
              <Input
                type="time"
                value={stop.arrivalTime}
                onChange={(e) => updateStop(index, 'arrivalTime', e.target.value)}
                required
              />
            </div>
          </div>
        </Card>
      ))}

      <Button type="button" variant="outline" onClick={addStop} className="w-full">
        <Plus className="h-4 w-4 mr-2" />
        Add Stop
      </Button>
    </div>
  );
}
