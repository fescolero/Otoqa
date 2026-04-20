'use client';

import { useMemo, useState } from 'react';
import { useMutation, useQuery } from 'convex/react';
import { toast } from 'sonner';
import { ArrowRightLeft } from 'lucide-react';

import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Label } from '@/components/ui/label';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { api } from '@/convex/_generated/api';
import type { Id } from '@/convex/_generated/dataModel';

/**
 * Mid-load handoff dialog. Picks an eligible target driver (one with no
 * conflicting PENDING/ACTIVE legs in the handoff window) and atomically:
 *   - Completes the from-driver's leg with endReason='handoff'
 *   - Creates a new PENDING leg for the to-driver with role='relay'
 *   - Transfers loadTrackingState (frontier preserved at the relay point)
 *   - Updates loadInformation.primaryDriverId if leg 1 swapped
 *   - Ends the from-driver's session if they have no other active legs
 *
 * All inside a single Convex mutation — see handoffLoad in dispatchLegs.ts.
 */
export function ReassignDriverDialog({
  open,
  onOpenChange,
  loadId,
  fromDriverId,
  fromDriverName,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  loadId: Id<'loadInformation'>;
  fromDriverId: Id<'drivers'>;
  fromDriverName: string;
}) {
  const eligible = useQuery(
    api.dispatchLegs.getEligibleDriversForHandoff,
    open ? { loadId } : 'skip',
  );
  const handoffLoad = useMutation(api.dispatchLegs.handoffLoad);

  const [toDriverId, setToDriverId] = useState<Id<'drivers'> | undefined>(undefined);
  const [isSubmitting, setIsSubmitting] = useState(false);

  // Filter the from-driver out of the picker — handing off to yourself is a no-op.
  const candidateDrivers = useMemo(() => {
    if (!eligible) return [];
    return eligible.filter((d) => d._id !== fromDriverId);
  }, [eligible, fromDriverId]);

  const handleConfirm = async () => {
    if (!toDriverId) return;
    setIsSubmitting(true);
    try {
      await handoffLoad({ loadId, fromDriverId, toDriverId });
      const name =
        candidateDrivers.find((d) => d._id === toDriverId)?.firstName ?? 'driver';
      toast.success(`Load reassigned to ${name}`);
      onOpenChange(false);
      setToDriverId(undefined);
    } catch (err) {
      const msg = err instanceof Error ? err.message : 'Failed to reassign';
      toast.error(msg);
    } finally {
      setIsSubmitting(false);
    }
  };

  const isLoading = eligible === undefined;

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (isSubmitting) return;
        onOpenChange(next);
        if (!next) setToDriverId(undefined);
      }}
    >
      <DialogContent className="sm:max-w-[480px]">
        <DialogHeader>
          <div className="flex items-center gap-3">
            <div className="flex h-10 w-10 items-center justify-center rounded-full bg-blue-100 dark:bg-blue-950">
              <ArrowRightLeft className="h-5 w-5 text-blue-600" />
            </div>
            <DialogTitle>Reassign Driver</DialogTitle>
          </div>
        </DialogHeader>

        <div className="space-y-4 py-2">
          <div className="rounded-lg bg-muted p-3 text-sm">
            <div className="text-muted-foreground">Currently assigned to</div>
            <div className="font-medium">{fromDriverName}</div>
          </div>

          <div className="space-y-2">
            <Label htmlFor="reassign-to">Reassign to</Label>
            <Select
              value={toDriverId}
              onValueChange={(v) => setToDriverId(v as Id<'drivers'>)}
              disabled={isSubmitting || isLoading}
            >
              <SelectTrigger id="reassign-to">
                <SelectValue
                  placeholder={
                    isLoading
                      ? 'Loading eligible drivers…'
                      : candidateDrivers.length === 0
                        ? 'No eligible drivers'
                        : 'Select a driver…'
                  }
                />
              </SelectTrigger>
              <SelectContent>
                {candidateDrivers.map((driver) => (
                  <SelectItem key={driver._id} value={driver._id}>
                    {`${driver.firstName} ${driver.lastName}`}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            <p className="text-xs text-muted-foreground">
              Only drivers with no overlapping legs between now and this load&apos;s
              scheduled completion are eligible.
            </p>
          </div>
        </div>

        <DialogFooter>
          <Button
            variant="outline"
            onClick={() => onOpenChange(false)}
            disabled={isSubmitting}
          >
            Cancel
          </Button>
          <Button
            onClick={handleConfirm}
            disabled={!toDriverId || isSubmitting || isLoading}
          >
            {isSubmitting ? 'Reassigning…' : 'Reassign'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
