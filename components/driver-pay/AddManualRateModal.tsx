'use client';

import { useState } from 'react';
import { useMutation } from 'convex/react';
import { api } from '@/convex/_generated/api';
import { Id } from '@/convex/_generated/dataModel';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';
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

interface AddManualRateModalProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  loadId: Id<'loadInformation'>;
  legId?: Id<'dispatchLegs'>;
  driverId?: Id<'drivers'>;
  userId: string;
}

type RateCategory = 'ACCESSORIAL' | 'DEDUCTION' | 'BASE';

const COMMON_DESCRIPTIONS = [
  { label: 'Detention Pay', category: 'ACCESSORIAL' as RateCategory },
  { label: 'Layover Pay', category: 'ACCESSORIAL' as RateCategory },
  { label: 'Lumper Fee', category: 'ACCESSORIAL' as RateCategory },
  { label: 'Tarp Pay', category: 'ACCESSORIAL' as RateCategory },
  { label: 'Stop Pay', category: 'ACCESSORIAL' as RateCategory },
  { label: 'HazMat Pay', category: 'ACCESSORIAL' as RateCategory },
  { label: 'Empty Miles', category: 'BASE' as RateCategory },
  { label: 'Bonus', category: 'ACCESSORIAL' as RateCategory },
  { label: 'Fuel Advance', category: 'DEDUCTION' as RateCategory },
  { label: 'Cash Advance', category: 'DEDUCTION' as RateCategory },
  { label: 'Other', category: 'ACCESSORIAL' as RateCategory },
];

export function AddManualRateModal({
  open,
  onOpenChange,
  loadId,
  legId,
  driverId,
  userId,
}: AddManualRateModalProps) {
  const [selectedDescription, setSelectedDescription] = useState<string>('');
  const [customDescription, setCustomDescription] = useState<string>('');
  const [quantity, setQuantity] = useState<string>('1');
  const [rate, setRate] = useState<string>('');
  const [notes, setNotes] = useState<string>('');
  const [isSubmitting, setIsSubmitting] = useState(false);

  const addManual = useMutation(api.loadPayables.addManual);

  const resetForm = () => {
    setSelectedDescription('');
    setCustomDescription('');
    setQuantity('1');
    setRate('');
    setNotes('');
  };

  const handleClose = () => {
    resetForm();
    onOpenChange(false);
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();

    if (!driverId) {
      alert('No driver assigned');
      return;
    }

    const description =
      selectedDescription === 'Other' ? customDescription : selectedDescription;

    if (!description) {
      alert('Please select or enter a description');
      return;
    }

    const qty = parseFloat(quantity);
    const rateAmount = parseFloat(rate);

    if (isNaN(qty) || qty <= 0) {
      alert('Please enter a valid quantity');
      return;
    }

    if (isNaN(rateAmount)) {
      alert('Please enter a valid rate');
      return;
    }

    setIsSubmitting(true);

    try {
      await addManual({
        loadId,
        legId,
        driverId,
        description: notes ? `${description} - ${notes}` : description,
        quantity: qty,
        rate: rateAmount,
        userId,
      });
      handleClose();
    } catch (error) {
      console.error('Failed to add manual rate:', error);
      alert('Failed to add rate');
    } finally {
      setIsSubmitting(false);
    }
  };

  const selectedItem = COMMON_DESCRIPTIONS.find(
    (d) => d.label === selectedDescription
  );
  const isDeduction = selectedItem?.category === 'DEDUCTION';
  const computedTotal =
    parseFloat(quantity || '0') * parseFloat(rate || '0') * (isDeduction ? -1 : 1);

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-[425px]">
        <DialogHeader>
          <DialogTitle>Add Manual Pay Rate</DialogTitle>
          <DialogDescription>
            Add a manual pay item for this load. This will be marked as a manual
            entry and won't be overwritten during recalculation.
          </DialogDescription>
        </DialogHeader>

        <form onSubmit={handleSubmit} className="space-y-4 py-4">
          {/* Description Select */}
          <div className="space-y-2">
            <Label htmlFor="description">Description</Label>
            <Select
              value={selectedDescription}
              onValueChange={setSelectedDescription}
            >
              <SelectTrigger>
                <SelectValue placeholder="Select type..." />
              </SelectTrigger>
              <SelectContent>
                {COMMON_DESCRIPTIONS.map((desc) => (
                  <SelectItem key={desc.label} value={desc.label}>
                    <span className="flex items-center gap-2">
                      {desc.label}
                      {desc.category === 'DEDUCTION' && (
                        <span className="text-xs text-red-500">(Deduction)</span>
                      )}
                    </span>
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>

          {/* Custom Description (if Other selected) */}
          {selectedDescription === 'Other' && (
            <div className="space-y-2">
              <Label htmlFor="customDescription">Custom Description</Label>
              <Input
                id="customDescription"
                value={customDescription}
                onChange={(e) => setCustomDescription(e.target.value)}
                placeholder="Enter description..."
              />
            </div>
          )}

          {/* Quantity and Rate */}
          <div className="grid grid-cols-2 gap-4">
            <div className="space-y-2">
              <Label htmlFor="quantity">Quantity</Label>
              <Input
                id="quantity"
                type="number"
                step="0.01"
                min="0"
                value={quantity}
                onChange={(e) => setQuantity(e.target.value)}
                placeholder="1"
              />
              <p className="text-xs text-muted-foreground">
                Hours, miles, or count
              </p>
            </div>

            <div className="space-y-2">
              <Label htmlFor="rate">Rate ($)</Label>
              <Input
                id="rate"
                type="number"
                step="0.01"
                value={rate}
                onChange={(e) => setRate(e.target.value)}
                placeholder="0.00"
              />
              <p className="text-xs text-muted-foreground">Per unit</p>
            </div>
          </div>

          {/* Total Preview */}
          <div className="p-3 bg-muted rounded-lg">
            <div className="flex justify-between items-center">
              <span className="text-sm text-muted-foreground">Total</span>
              <span
                className={`text-lg font-bold ${isDeduction ? 'text-red-600' : 'text-green-600'}`}
              >
                {isDeduction ? '-' : ''}$
                {Math.abs(computedTotal).toFixed(2)}
              </span>
            </div>
          </div>

          {/* Notes */}
          <div className="space-y-2">
            <Label htmlFor="notes">Notes (optional)</Label>
            <Textarea
              id="notes"
              value={notes}
              onChange={(e) => setNotes(e.target.value)}
              placeholder="Additional details..."
              rows={2}
            />
          </div>

          <DialogFooter>
            <Button type="button" variant="outline" onClick={handleClose}>
              Cancel
            </Button>
            <Button type="submit" disabled={isSubmitting}>
              {isSubmitting ? 'Adding...' : 'Add Rate'}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
