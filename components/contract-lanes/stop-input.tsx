'use client';

import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Card } from '@/components/ui/card';
import { Plus, Trash2 } from 'lucide-react';
import { AddressAutocomplete, AddressData } from '@/components/ui/address-autocomplete';
import { useState } from 'react';

type Stop = {
  address: string;
  city: string;
  state: string;
  zip: string;
  stopOrder: number;
  stopType: 'Pickup' | 'Delivery';
  type: 'APPT' | 'FCFS' | 'Live';
  arrivalTime: string;
};

interface StopInputProps {
  stops: Stop[];
  onChange: (stops: Stop[]) => void;
}

export function StopInput({ stops, onChange }: StopInputProps) {
  const [addressStates, setAddressStates] = useState<(AddressData | null)[]>(new Array(stops.length).fill(null));

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
            <div className="space-y-2 lg:col-span-4">
              <Label>
                Address <span className="text-destructive">*</span>
              </Label>
              <AddressAutocomplete
                value={stop.address}
                onChange={(value) => updateStop(index, 'address', value)}
                onSelect={(data) => handleAddressSelect(index, data)}
                placeholder="Start typing address..."
              />
              <p className="text-xs text-muted-foreground">Type to search or enter manually</p>
            </div>
            <div className="space-y-2">
              <Label>
                City <span className="text-destructive">*</span>
              </Label>
              <Input
                value={stop.city}
                onChange={(e) => updateStop(index, 'city', e.target.value)}
                required
              />
            </div>
            <div className="space-y-2">
              <Label>
                State <span className="text-destructive">*</span>
              </Label>
              <Input
                value={stop.state}
                onChange={(e) => updateStop(index, 'state', e.target.value)}
                placeholder="CA"
                required
              />
            </div>
            <div className="space-y-2">
              <Label>
                ZIP <span className="text-destructive">*</span>
              </Label>
              <Input
                value={stop.zip}
                onChange={(e) => updateStop(index, 'zip', e.target.value)}
                required
              />
            </div>

            <div className="space-y-2">
              <Label>
                Stop Type <span className="text-destructive">*</span>
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
              <Label>
                Type <span className="text-destructive">*</span>
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

            <div className="space-y-2">
              <Label>
                Arrival Time <span className="text-destructive">*</span>
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
