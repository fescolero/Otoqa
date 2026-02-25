'use client';

import * as React from 'react';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
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
import { RadioGroup, RadioGroupItem } from '@/components/ui/radio-group';
import { useMutation } from 'convex/react';
import { useAuthQuery } from '@/hooks/use-auth-query';
import { api } from '@/convex/_generated/api';
import { Id } from '@/convex/_generated/dataModel';
import { Loader2, User, Building2 } from 'lucide-react';

interface CreateRouteAssignmentModalProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  organizationId: string;
  userId: string;
}

export function CreateRouteAssignmentModal({
  open,
  onOpenChange,
  organizationId,
  userId,
}: CreateRouteAssignmentModalProps) {
  const [isSubmitting, setIsSubmitting] = React.useState(false);
  const [assigneeType, setAssigneeType] = React.useState<'driver' | 'carrier'>('driver');

  // Form state
  const [hcr, setHcr] = React.useState('');
  const [tripNumber, setTripNumber] = React.useState('');
  const [name, setName] = React.useState('');
  const [notes, setNotes] = React.useState('');
  const [driverId, setDriverId] = React.useState<string>('');
  const [carrierId, setCarrierId] = React.useState<string>('');

  // Queries for dropdowns
  const routes = useAuthQuery(api.contractLanes.listUniqueRoutes, { workosOrgId: organizationId });
  const availableTripNumbers = React.useMemo(() => {
    if (!hcr || !routes) return [];
    const route = routes.find((r) => r.hcr === hcr);
    // Filter out empty strings to avoid Select.Item error
    return (route?.tripNumbers ?? []).filter((t) => t && t.trim() !== '');
  }, [hcr, routes]);

  const drivers = useAuthQuery(api.drivers.list, { organizationId });
  const activeDrivers = drivers?.filter(
    (d) => d.employmentStatus === 'Active' && !d.isDeleted
  );

  const carriers = useAuthQuery(api.carrierPartnerships.listForBroker, { brokerOrgId: organizationId });
  const activeCarriers = carriers?.filter((c) => c.status === 'ACTIVE');

  const createAssignment = useMutation(api.routeAssignments.create);

  // Reset trip number when HCR changes
  React.useEffect(() => {
    setTripNumber('');
  }, [hcr]);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();

    if (!hcr) {
      alert('HCR is required');
      return;
    }

    if (assigneeType === 'driver' && !driverId) {
      alert('Please select a driver');
      return;
    }

    if (assigneeType === 'carrier' && !carrierId) {
      alert('Please select a carrier');
      return;
    }

    setIsSubmitting(true);

    try {
      await createAssignment({
        workosOrgId: organizationId,
        hcr,
        tripNumber: tripNumber || undefined,
        driverId: assigneeType === 'driver' ? (driverId as Id<'drivers'>) : undefined,
        carrierPartnershipId:
          assigneeType === 'carrier' ? (carrierId as Id<'carrierPartnerships'>) : undefined,
        name: name || undefined,
        notes: notes || undefined,
        createdBy: userId,
      });

      // Reset form and close
      resetForm();
      onOpenChange(false);
    } catch (error) {
      console.error('Failed to create route assignment:', error);
      alert(error instanceof Error ? error.message : 'Failed to create route assignment');
    } finally {
      setIsSubmitting(false);
    }
  };

  const resetForm = () => {
    setHcr('');
    setTripNumber('');
    setName('');
    setNotes('');
    setDriverId('');
    setCarrierId('');
    setAssigneeType('driver');
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-[500px]">
        <form onSubmit={handleSubmit}>
          <DialogHeader>
            <DialogTitle>Create Route Assignment</DialogTitle>
            <DialogDescription>
              Configure automatic assignment for a recurring route. Loads matching this HCR + Trip
              will be auto-assigned.
            </DialogDescription>
          </DialogHeader>

          <div className="grid gap-4 py-4">
            {/* Route Identification */}
            <div className="grid grid-cols-2 gap-4">
              <div className="space-y-2">
                <Label htmlFor="hcr">HCR *</Label>
                <Select value={hcr} onValueChange={setHcr}>
                  <SelectTrigger>
                    <SelectValue placeholder="Select HCR..." />
                  </SelectTrigger>
                  <SelectContent>
                    {routes?.filter((route) => route.hcr && route.hcr.trim() !== '').map((route) => (
                      <SelectItem key={route.hcr} value={route.hcr}>
                        {route.hcr}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
              <div className="space-y-2">
                <Label htmlFor="tripNumber">Trip Number</Label>
                <Select 
                  value={tripNumber} 
                  onValueChange={setTripNumber}
                  disabled={!hcr || availableTripNumbers.length === 0}
                >
                  <SelectTrigger>
                    <SelectValue placeholder={!hcr ? "Select HCR first" : availableTripNumbers.length === 0 ? "No trips" : "Select Trip..."} />
                  </SelectTrigger>
                  <SelectContent>
                    {availableTripNumbers.map((trip) => (
                      <SelectItem key={trip} value={trip}>
                        {trip}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
            </div>

            {/* Name */}
            <div className="space-y-2">
              <Label htmlFor="name">Assignment Name</Label>
              <Input
                id="name"
                placeholder="e.g., John's Amazon Route"
                value={name}
                onChange={(e) => setName(e.target.value)}
              />
            </div>

            {/* Assignee Type */}
            <div className="space-y-2">
              <Label>Assign To</Label>
              <RadioGroup
                value={assigneeType}
                onValueChange={(v) => setAssigneeType(v as 'driver' | 'carrier')}
                className="flex gap-4"
              >
                <div className="flex items-center space-x-2">
                  <RadioGroupItem value="driver" id="driver" />
                  <Label htmlFor="driver" className="flex items-center gap-2 cursor-pointer">
                    <User className="h-4 w-4" />
                    Driver
                  </Label>
                </div>
                <div className="flex items-center space-x-2">
                  <RadioGroupItem value="carrier" id="carrier" />
                  <Label htmlFor="carrier" className="flex items-center gap-2 cursor-pointer">
                    <Building2 className="h-4 w-4" />
                    Carrier
                  </Label>
                </div>
              </RadioGroup>
            </div>

            {/* Driver/Carrier Selection */}
            {assigneeType === 'driver' ? (
              <div className="space-y-2">
                <Label htmlFor="driverId">Select Driver *</Label>
                <Select value={driverId} onValueChange={setDriverId}>
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
              </div>
            ) : (
              <div className="space-y-2">
                <Label htmlFor="carrierId">Select Carrier *</Label>
                <Select value={carrierId} onValueChange={setCarrierId}>
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
              </div>
            )}

            {/* Notes */}
            <div className="space-y-2">
              <Label htmlFor="notes">Notes</Label>
              <Textarea
                id="notes"
                placeholder="Additional notes about this assignment..."
                value={notes}
                onChange={(e) => setNotes(e.target.value)}
                rows={2}
              />
            </div>
          </div>

          <DialogFooter>
            <Button type="button" variant="outline" onClick={() => onOpenChange(false)}>
              Cancel
            </Button>
            <Button type="submit" disabled={isSubmitting}>
              {isSubmitting && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
              Create Assignment
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
