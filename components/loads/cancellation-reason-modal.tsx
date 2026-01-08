'use client';

import { useState } from 'react';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { Textarea } from '@/components/ui/textarea';
import { Label } from '@/components/ui/label';
import { AlertTriangle, XCircle } from 'lucide-react';
import { cn } from '@/lib/utils';

// Standard cancellation reason codes
const CANCELLATION_REASONS = [
  { code: 'DRIVER_BREAKDOWN', label: 'Driver Breakdown', description: 'Driver had mechanical issues or became unavailable' },
  { code: 'CUSTOMER_CANCELLED', label: 'Customer Cancelled', description: 'Customer cancelled the shipment' },
  { code: 'EQUIPMENT_ISSUE', label: 'Equipment Issue', description: 'Truck or trailer problems prevented dispatch' },
  { code: 'RATE_DISPUTE', label: 'Rate Dispute', description: 'Rate negotiation failed' },
  { code: 'WEATHER_CONDITIONS', label: 'Weather Conditions', description: 'Unsafe driving conditions' },
  { code: 'CAPACITY_ISSUE', label: 'Capacity Issue', description: 'Unable to accommodate load requirements' },
  { code: 'SCHEDULING_CONFLICT', label: 'Scheduling Conflict', description: 'Pickup/delivery windows could not be met' },
  { code: 'OTHER', label: 'Other', description: 'Other reason (please specify)' },
] as const;

export type CancellationReasonCode = (typeof CANCELLATION_REASONS)[number]['code'];

interface CancellationReasonModalProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  loadCount: number;
  loads: { id: string; orderNumber?: string }[];
  onConfirm: (reasonCode: CancellationReasonCode, notes?: string) => void;
}

export function CancellationReasonModal({
  open,
  onOpenChange,
  loadCount,
  loads,
  onConfirm,
}: CancellationReasonModalProps) {
  const [selectedReason, setSelectedReason] = useState<CancellationReasonCode | ''>('');
  const [notes, setNotes] = useState('');

  const handleConfirm = () => {
    if (!selectedReason) return;
    onConfirm(selectedReason, notes || undefined);
    // Reset state
    setSelectedReason('');
    setNotes('');
  };

  const handleClose = () => {
    setSelectedReason('');
    setNotes('');
    onOpenChange(false);
  };

  const selectedReasonData = CANCELLATION_REASONS.find((r) => r.code === selectedReason);
  const requiresNotes = selectedReason === 'OTHER';
  const canConfirm = selectedReason && (!requiresNotes || notes.trim());

  return (
    <Dialog open={open} onOpenChange={handleClose}>
      <DialogContent className="sm:max-w-[500px]">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <XCircle className="h-5 w-5 text-red-500" />
            Cancel Assigned Load{loadCount > 1 ? 's' : ''}
          </DialogTitle>
          <DialogDescription>
            {loadCount === 1 ? (
              <>
                You are about to cancel{' '}
                <span className="font-semibold text-foreground">
                  {loads[0]?.orderNumber || 'this load'}
                </span>
                . This load has been assigned and dispatcher work will be lost.
              </>
            ) : (
              <>
                You are about to cancel{' '}
                <span className="font-semibold text-foreground">{loadCount} assigned loads</span>.
                All dispatcher work on these loads will be lost.
              </>
            )}
          </DialogDescription>
        </DialogHeader>

        {/* Warning Banner */}
        <div className="flex items-start gap-3 rounded-md border border-amber-200 bg-amber-50 p-3 dark:border-amber-900 dark:bg-amber-950/50">
          <AlertTriangle className="h-5 w-5 flex-shrink-0 text-amber-600 dark:text-amber-500" />
          <div className="text-sm text-amber-800 dark:text-amber-200">
            <p className="font-medium">Cancellation requires a reason</p>
            <p className="mt-1 text-amber-700 dark:text-amber-300">
              Assigned loads must have a documented reason for cancellation. This helps track
              operational issues and improves future planning.
            </p>
          </div>
        </div>

        {/* Affected Loads (if multiple) */}
        {loadCount > 1 && loadCount <= 10 && (
          <div className="space-y-2">
            <Label className="text-sm text-muted-foreground">Affected Loads:</Label>
            <div className="flex flex-wrap gap-2">
              {loads.map((load) => (
                <span
                  key={load.id}
                  className="rounded bg-muted px-2 py-1 text-xs font-mono"
                >
                  {load.orderNumber || load.id.slice(-6)}
                </span>
              ))}
            </div>
          </div>
        )}

        {/* Reason Code Selection */}
        <div className="space-y-3">
          <Label htmlFor="cancellation-reason">
            Reason Code <span className="text-red-500">*</span>
          </Label>
          <Select
            value={selectedReason}
            onValueChange={(value) => setSelectedReason(value as CancellationReasonCode)}
          >
            <SelectTrigger id="cancellation-reason" className="w-full">
              <SelectValue placeholder="Select a reason for cancellation..." />
            </SelectTrigger>
            <SelectContent>
              {CANCELLATION_REASONS.map((reason) => (
                <SelectItem key={reason.code} value={reason.code}>
                  <div className="flex flex-col">
                    <span>{reason.label}</span>
                  </div>
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          {selectedReasonData && (
            <p className="text-xs text-muted-foreground">{selectedReasonData.description}</p>
          )}
        </div>

        {/* Notes (optional, required for "Other") */}
        <div className="space-y-2">
          <Label htmlFor="cancellation-notes">
            Additional Notes {requiresNotes && <span className="text-red-500">*</span>}
          </Label>
          <Textarea
            id="cancellation-notes"
            placeholder={
              requiresNotes
                ? 'Please provide details about the cancellation reason...'
                : 'Optional: Add any additional context...'
            }
            value={notes}
            onChange={(e) => setNotes(e.target.value)}
            className={cn('min-h-[80px]', requiresNotes && !notes.trim() && 'border-amber-400')}
          />
        </div>

        <DialogFooter className="gap-2 sm:gap-0">
          <Button variant="outline" onClick={handleClose}>
            Keep Assigned
          </Button>
          <Button
            variant="destructive"
            onClick={handleConfirm}
            disabled={!canConfirm}
          >
            Cancel Load{loadCount > 1 ? 's' : ''}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
