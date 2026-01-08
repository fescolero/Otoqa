'use client';

import { useState, useEffect } from 'react';
import { useMutation } from 'convex/react';
import { api } from '@/convex/_generated/api';
import { Id } from '@/convex/_generated/dataModel';
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
import { Switch } from '@/components/ui/switch';
import { toast } from 'sonner';

interface Payable {
  _id: Id<'loadPayables'>;
  description: string;
  quantity: number;
  rate: number;
  totalAmount: number;
  isRebillable?: boolean;
}

interface EditPayableDialogProps {
  payable: Payable | null;
  isOpen: boolean;
  onClose: () => void;
}

export function EditPayableDialog({ payable, isOpen, onClose }: EditPayableDialogProps) {
  const [description, setDescription] = useState('');
  const [quantity, setQuantity] = useState('');
  const [rate, setRate] = useState('');
  const [isRebillable, setIsRebillable] = useState(false);

  const updatePayable = useMutation(api.driverSettlements.updateManualPayable);

  // Populate form when payable changes
  useEffect(() => {
    if (payable) {
      setDescription(payable.description);
      setQuantity(payable.quantity.toString());
      setRate(payable.rate.toString());
      setIsRebillable(payable.isRebillable || false);
    }
  }, [payable]);

  const handleSave = async () => {
    if (!payable) return;

    const qty = parseFloat(quantity);
    const rateVal = parseFloat(rate);

    if (isNaN(qty) || qty <= 0) {
      toast.error('Quantity must be a positive number');
      return;
    }

    if (isNaN(rateVal) || rateVal <= 0) {
      toast.error('Rate must be a positive number');
      return;
    }

    if (!description.trim()) {
      toast.error('Description is required');
      return;
    }

    try {
      await updatePayable({
        payableId: payable._id,
        description: description.trim(),
        quantity: qty,
        rate: rateVal,
        isRebillable,
      });
      
      toast.success('Manual adjustment updated');
      onClose();
    } catch (error: any) {
      toast.error(error?.message || 'Failed to update adjustment');
      console.error(error);
    }
  };

  const calculatedTotal = (parseFloat(quantity) || 0) * (parseFloat(rate) || 0);

  return (
    <Dialog open={isOpen} onOpenChange={onClose}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>Edit Manual Adjustment</DialogTitle>
          <DialogDescription>
            Update the details for this manual payable item.
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-4 py-4">
          {/* Description */}
          <div className="space-y-2">
            <Label htmlFor="description">Description</Label>
            <Input
              id="description"
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              placeholder="e.g., Layover, Detention"
            />
          </div>

          {/* Quantity */}
          <div className="space-y-2">
            <Label htmlFor="quantity">Quantity</Label>
            <Input
              id="quantity"
              type="number"
              step="0.01"
              value={quantity}
              onChange={(e) => setQuantity(e.target.value)}
              placeholder="1.00"
            />
          </div>

          {/* Rate */}
          <div className="space-y-2">
            <Label htmlFor="rate">Rate</Label>
            <div className="relative">
              <span className="absolute left-3 top-2.5 text-muted-foreground">$</span>
              <Input
                id="rate"
                type="number"
                step="0.01"
                value={rate}
                onChange={(e) => setRate(e.target.value)}
                placeholder="0.00"
                className="pl-7"
              />
            </div>
          </div>

          {/* Calculated Total */}
          <div className="flex items-center justify-between px-3 py-2 bg-slate-50 rounded-md">
            <span className="text-sm font-medium text-slate-700">Total:</span>
            <span className="text-lg font-semibold text-slate-900 tabular-nums">
              ${calculatedTotal.toFixed(2)}
            </span>
          </div>

          {/* Rebillable Toggle */}
          <div className="flex items-center justify-between">
            <div className="space-y-0.5">
              <Label htmlFor="rebillable">Rebillable to Customer</Label>
              <p className="text-xs text-muted-foreground">
                Add this charge to the customer's invoice
              </p>
            </div>
            <Switch
              id="rebillable"
              checked={isRebillable}
              onCheckedChange={setIsRebillable}
            />
          </div>
        </div>

        <DialogFooter>
          <Button variant="outline" onClick={onClose}>
            Cancel
          </Button>
          <Button onClick={handleSave}>
            Save Changes
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

