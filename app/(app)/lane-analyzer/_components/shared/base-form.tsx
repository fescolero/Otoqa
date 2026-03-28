'use client';

import { useState } from 'react';
import { useMutation } from 'convex/react';
import { api } from '@/convex/_generated/api';
import { Id } from '@/convex/_generated/dataModel';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { toast } from 'sonner';

interface BaseFormProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  sessionId?: Id<'laneAnalysisSessions'>;
  organizationId: string;
  userId: string;
}

export function BaseForm({ open, onOpenChange, sessionId, organizationId, userId }: BaseFormProps) {
  const createBase = useMutation(api.laneAnalyzer.createBase);

  const [name, setName] = useState('');
  const [address, setAddress] = useState('');
  const [city, setCity] = useState('');
  const [state, setState] = useState('');
  const [zip, setZip] = useState('');
  const [baseType, setBaseType] = useState<'YARD' | 'RELAY_POINT' | 'PARKING'>('YARD');
  const [capacity, setCapacity] = useState('');
  const [parkingCost, setParkingCost] = useState('');

  const resetForm = () => {
    setName('');
    setAddress('');
    setCity('');
    setState('');
    setZip('');
    setBaseType('YARD');
    setCapacity('');
    setParkingCost('');
  };

  const handleSubmit = async () => {
    if (!name || !city || !state) {
      toast.error('Name, city, and state are required');
      return;
    }

    try {
      await createBase({
        workosOrgId: organizationId,
        sessionId,
        name,
        address: address || `${city}, ${state}`,
        city,
        state,
        zip,
        baseType,
        capacity: capacity ? parseInt(capacity) : undefined,
        monthlyParkingCost: parkingCost ? parseFloat(parkingCost) : undefined,
        createdBy: userId,
      });

      toast.success('Base location added');
      resetForm();
      onOpenChange(false);
    } catch (error) {
      toast.error('Failed to add base');
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle>Add Base Location</DialogTitle>
          <DialogDescription>
            Add a yard, relay point, or parking location for deadhead analysis.
          </DialogDescription>
        </DialogHeader>

        <div className="grid gap-4 py-4">
          <div className="grid gap-2">
            <Label>Name</Label>
            <Input
              placeholder="e.g. Chicago Yard"
              value={name}
              onChange={(e) => setName(e.target.value)}
            />
          </div>

          <div className="grid gap-2">
            <Label>Type</Label>
            <Select value={baseType} onValueChange={(v) => setBaseType(v as typeof baseType)}>
              <SelectTrigger>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="YARD">Yard (home base)</SelectItem>
                <SelectItem value="RELAY_POINT">Relay Point</SelectItem>
                <SelectItem value="PARKING">Truck Parking</SelectItem>
              </SelectContent>
            </Select>
          </div>

          <div className="grid gap-2">
            <Label>Address</Label>
            <Input placeholder="Street address" value={address} onChange={(e) => setAddress(e.target.value)} />
          </div>

          <div className="grid grid-cols-3 gap-2">
            <div>
              <Label>City *</Label>
              <Input value={city} onChange={(e) => setCity(e.target.value)} />
            </div>
            <div>
              <Label>State *</Label>
              <Input value={state} onChange={(e) => setState(e.target.value)} className="w-full" />
            </div>
            <div>
              <Label>Zip</Label>
              <Input value={zip} onChange={(e) => setZip(e.target.value)} />
            </div>
          </div>

          <div className="grid grid-cols-2 gap-4">
            <div className="grid gap-2">
              <Label>Capacity (trucks)</Label>
              <Input
                type="number"
                placeholder="Unlimited"
                value={capacity}
                onChange={(e) => setCapacity(e.target.value)}
              />
            </div>
            <div className="grid gap-2">
              <Label>Monthly Parking ($)</Label>
              <Input
                type="number"
                step="0.01"
                placeholder="0.00"
                value={parkingCost}
                onChange={(e) => setParkingCost(e.target.value)}
              />
            </div>
          </div>
        </div>

        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>Cancel</Button>
          <Button onClick={handleSubmit} disabled={!name || !city || !state}>Add Base</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
