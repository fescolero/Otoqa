'use client';

import { useState } from 'react';
import { useQuery, useMutation } from 'convex/react';
import { api } from '@/convex/_generated/api';
import { Id } from '@/convex/_generated/dataModel';
import { Button } from '@/components/ui/button';
import { Label } from '@/components/ui/label';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { AlertTriangle, MapPin, ArrowRight, User, Truck } from 'lucide-react';

interface SplitLoadModalProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  loadId: Id<'loadInformation'>;
  organizationId: string;
  userId: string;
}

interface Stop {
  _id: Id<'loadStops'>;
  sequenceNumber: number;
  stopType: string;
  city?: string;
  state?: string;
}

export function SplitLoadModal({
  open,
  onOpenChange,
  loadId,
  organizationId,
  userId,
}: SplitLoadModalProps) {
  const [selectedStopId, setSelectedStopId] = useState<string>('');
  const [newDriverId, setNewDriverId] = useState<string>('');
  const [newTruckId, setNewTruckId] = useState<string>('');
  const [newTrailerId, setNewTrailerId] = useState<string>('');
  const [isSubmitting, setIsSubmitting] = useState(false);

  // Fetch load data
  const loadData = useQuery(api.loads.getLoad, { loadId });

  // Fetch available drivers, trucks, trailers
  const drivers = useQuery(api.drivers.list, { organizationId });
  const trucks = useQuery(api.trucks.list, { organizationId });
  const trailers = useQuery(api.trailers.list, { organizationId });

  // Mutation
  const splitAtStop = useMutation(api.dispatchLegs.splitAtStop);

  // Get stops that can be split at (not first or last)
  const eligibleStops = loadData?.stops
    .sort((a: Stop, b: Stop) => a.sequenceNumber - b.sequenceNumber)
    .filter((_: Stop, index: number, arr: Stop[]) => index > 0 && index < arr.length - 1);

  const resetForm = () => {
    setSelectedStopId('');
    setNewDriverId('');
    setNewTruckId('');
    setNewTrailerId('');
  };

  const handleSubmit = async () => {
    if (!selectedStopId) {
      alert('Please select a stop to split at');
      return;
    }

    if (!newDriverId) {
      alert('Please select a driver for the second leg');
      return;
    }

    setIsSubmitting(true);

    try {
      await splitAtStop({
        loadId,
        splitStopId: selectedStopId as Id<'loadStops'>,
        newDriverId: newDriverId as Id<'drivers'>,
        newTruckId: newTruckId ? (newTruckId as Id<'trucks'>) : undefined,
        newTrailerId: newTrailerId ? (newTrailerId as Id<'trailers'>) : undefined,
        userId,
      });
      resetForm();
      onOpenChange(false);
    } catch (error) {
      console.error('Failed to split load:', error);
      alert('Failed to split load');
    } finally {
      setIsSubmitting(false);
    }
  };

  // Filter active drivers/trucks/trailers
  const activeDrivers = drivers?.filter(
    (d) => d.employmentStatus === 'Active' && !d.isDeleted
  );
  const activeTrucks = trucks?.filter((t) => t.status === 'Active' && !t.isDeleted);
  const activeTrailers = trailers?.filter((t) => t.status === 'Active' && !t.isDeleted);

  // Get selected stop details
  const selectedStop = loadData?.stops.find(
    (s: Stop) => s._id === selectedStopId
  );

  // Find stops before and after split point
  const sortedStops = loadData?.stops.sort(
    (a: Stop, b: Stop) => a.sequenceNumber - b.sequenceNumber
  );
  const splitIndex = sortedStops?.findIndex((s: Stop) => s._id === selectedStopId);
  const stopsBefore = splitIndex !== undefined && splitIndex >= 0 
    ? sortedStops?.slice(0, splitIndex + 1) 
    : [];
  const stopsAfter = splitIndex !== undefined && splitIndex >= 0 
    ? sortedStops?.slice(splitIndex) 
    : [];

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-[550px]">
        <DialogHeader>
          <DialogTitle>Split Load</DialogTitle>
          <DialogDescription>
            Split this load into two legs at a specific stop. Each leg can have
            a different driver assigned.
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-6 py-4">
          {/* Warning */}
          <div className="flex items-start gap-3 p-3 bg-yellow-50 border border-yellow-200 rounded-lg">
            <AlertTriangle className="h-5 w-5 text-yellow-600 flex-shrink-0 mt-0.5" />
            <div className="text-sm text-yellow-800">
              <p className="font-medium">This action will:</p>
              <ul className="list-disc list-inside mt-1 space-y-1">
                <li>Create a second dispatch leg starting at the split stop</li>
                <li>Recalculate pay for both legs</li>
                <li>Cannot be easily undone</li>
              </ul>
            </div>
          </div>

          {/* Split Stop Selection */}
          <div className="space-y-2">
            <Label>Split at Stop</Label>
            {!eligibleStops || eligibleStops.length === 0 ? (
              <p className="text-sm text-muted-foreground">
                Load must have at least 3 stops to split (first, split point, last)
              </p>
            ) : (
              <Select value={selectedStopId} onValueChange={setSelectedStopId}>
                <SelectTrigger>
                  <SelectValue placeholder="Select stop to split at..." />
                </SelectTrigger>
                <SelectContent>
                  {eligibleStops?.map((stop: Stop) => (
                    <SelectItem key={stop._id} value={stop._id}>
                      <div className="flex items-center gap-2">
                        <MapPin className="h-4 w-4" />
                        <span>
                          Stop #{stop.sequenceNumber} - {stop.city}, {stop.state}
                        </span>
                        <span className="text-xs text-muted-foreground">
                          ({stop.stopType})
                        </span>
                      </div>
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            )}
          </div>

          {/* Split Preview */}
          {selectedStopId && selectedStop && (
            <div className="border rounded-lg p-4 bg-muted/30">
              <h4 className="font-medium mb-3">Split Preview</h4>
              <div className="grid grid-cols-2 gap-4">
                <div>
                  <p className="text-sm font-medium text-muted-foreground mb-2">
                    Leg 1 (Current Driver)
                  </p>
                  <div className="space-y-1 text-sm">
                    {stopsBefore?.map((stop: Stop) => (
                      <div key={stop._id} className="flex items-center gap-1">
                        <MapPin className="h-3 w-3" />
                        <span>
                          {stop.city}, {stop.state}
                        </span>
                      </div>
                    ))}
                  </div>
                </div>
                <div>
                  <p className="text-sm font-medium text-muted-foreground mb-2">
                    Leg 2 (New Driver)
                  </p>
                  <div className="space-y-1 text-sm">
                    {stopsAfter?.map((stop: Stop) => (
                      <div key={stop._id} className="flex items-center gap-1">
                        <MapPin className="h-3 w-3" />
                        <span>
                          {stop.city}, {stop.state}
                        </span>
                      </div>
                    ))}
                  </div>
                </div>
              </div>
            </div>
          )}

          {/* New Driver Selection */}
          <div className="space-y-2">
            <Label className="flex items-center gap-2">
              <User className="h-4 w-4" />
              Driver for Leg 2
            </Label>
            <Select value={newDriverId} onValueChange={setNewDriverId}>
              <SelectTrigger>
                <SelectValue placeholder="Select driver..." />
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

          {/* Optional: Truck and Trailer */}
          <div className="grid grid-cols-2 gap-4">
            <div className="space-y-2">
              <Label className="flex items-center gap-2">
                <Truck className="h-4 w-4" />
                Truck (optional)
              </Label>
              <Select value={newTruckId} onValueChange={setNewTruckId}>
                <SelectTrigger>
                  <SelectValue placeholder="Select truck..." />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="">
                    <span className="text-muted-foreground">None</span>
                  </SelectItem>
                  {activeTrucks?.map((truck) => (
                    <SelectItem key={truck._id} value={truck._id}>
                      {truck.unitId} - {truck.make} {truck.model}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>

            <div className="space-y-2">
              <Label className="flex items-center gap-2">
                <Truck className="h-4 w-4" />
                Trailer (optional)
              </Label>
              <Select value={newTrailerId} onValueChange={setNewTrailerId}>
                <SelectTrigger>
                  <SelectValue placeholder="Select trailer..." />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="">
                    <span className="text-muted-foreground">None</span>
                  </SelectItem>
                  {activeTrailers?.map((trailer) => (
                    <SelectItem key={trailer._id} value={trailer._id}>
                      {trailer.unitId} - {trailer.size} {trailer.bodyType}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
          </div>
        </div>

        <DialogFooter>
          <Button
            variant="outline"
            onClick={() => {
              resetForm();
              onOpenChange(false);
            }}
          >
            Cancel
          </Button>
          <Button
            onClick={handleSubmit}
            disabled={isSubmitting || !selectedStopId || !newDriverId}
          >
            {isSubmitting ? 'Splitting...' : 'Split Load'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
