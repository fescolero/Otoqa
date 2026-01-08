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
import { Checkbox } from '@/components/ui/checkbox';
import { Badge } from '@/components/ui/badge';
import { ScrollArea } from '@/components/ui/scroll-area';
import {
  CheckCircle2,
  AlertTriangle,
  XCircle,
  Clock,
  Truck,
  Ban,
} from 'lucide-react';
import { cn } from '@/lib/utils';

interface ValidationResult {
  safe: { id: string; orderNumber?: string }[];
  imminent: { id: string; orderNumber?: string; pickupTime: string; hoursUntilPickup: number }[];
  active: { id: string; orderNumber?: string }[];
  finalized: { id: string; orderNumber?: string; status: string }[];
  summary: {
    total: number;
    safeCount: number;
    imminentCount: number;
    activeCount: number;
    finalizedCount: number;
    canProceedSafely: boolean;
  };
}

interface BulkActionResolutionModalProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  validationResult: ValidationResult | null;
  targetStatus: string;
  onProceedSafe: () => void;
  onProceedAll: () => void;
  onCancel: () => void;
  isProcessing?: boolean;
}

export function BulkActionResolutionModal({
  open,
  onOpenChange,
  validationResult,
  targetStatus,
  onProceedSafe,
  onProceedAll,
  onCancel,
  isProcessing = false,
}: BulkActionResolutionModalProps) {
  const [forceConfirmed, setForceConfirmed] = useState(false);

  if (!validationResult) return null;

  const { safe, imminent, active, finalized, summary } = validationResult;
  const hasImminent = imminent.length > 0;
  const hasActive = active.length > 0;
  const hasFinalized = finalized.length > 0;
  const hasSafe = safe.length > 0;

  // Determine action text based on target status
  const actionVerb = targetStatus === 'Open' ? 'Unassign' : `Mark as ${targetStatus}`;

  const handleClose = () => {
    setForceConfirmed(false);
    onOpenChange(false);
  };

  return (
    <Dialog open={open} onOpenChange={handleClose}>
      <DialogContent className="max-w-lg">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <AlertTriangle className="h-5 w-5 text-amber-500" />
            Bulk Action Impact Analysis
          </DialogTitle>
          <DialogDescription>
            Review the impact of {actionVerb.toLowerCase()}ing {summary.total} load
            {summary.total !== 1 ? 's' : ''} before proceeding.
          </DialogDescription>
        </DialogHeader>

        <ScrollArea className="max-h-[400px] pr-4">
          <div className="space-y-4">
            {/* Safe Section */}
            {hasSafe && (
              <div className="rounded-lg border border-green-200 bg-green-50 p-3">
                <div className="flex items-center gap-2 mb-2">
                  <CheckCircle2 className="h-4 w-4 text-green-600" />
                  <span className="font-semibold text-green-800">
                    {safe.length} Load{safe.length !== 1 ? 's' : ''} Safe to {actionVerb}
                  </span>
                </div>
                <div className="flex flex-wrap gap-1">
                  {safe.slice(0, 8).map((load) => (
                    <Badge key={load.id} variant="outline" className="text-xs bg-white">
                      {load.orderNumber || load.id.slice(-6)}
                    </Badge>
                  ))}
                  {safe.length > 8 && (
                    <Badge variant="outline" className="text-xs bg-white">
                      +{safe.length - 8} more
                    </Badge>
                  )}
                </div>
              </div>
            )}

            {/* Imminent Section */}
            {hasImminent && (
              <div className="rounded-lg border border-amber-200 bg-amber-50 p-3">
                <div className="flex items-center gap-2 mb-2">
                  <Clock className="h-4 w-4 text-amber-600" />
                  <span className="font-semibold text-amber-800">
                    {imminent.length} Load{imminent.length !== 1 ? 's' : ''} Starting Within 4 Hours
                  </span>
                </div>
                <p className="text-xs text-amber-700 mb-2">
                  {actionVerb}ing these loads may cause service failures.
                </p>
                <div className="space-y-1">
                  {imminent.map((load) => (
                    <div
                      key={load.id}
                      className="flex items-center justify-between bg-white rounded px-2 py-1 text-xs"
                    >
                      <span className="font-medium">
                        {load.orderNumber || load.id.slice(-6)}
                      </span>
                      <span className="text-amber-600 font-semibold">
                        {load.hoursUntilPickup}h until pickup
                      </span>
                    </div>
                  ))}
                </div>
              </div>
            )}

            {/* Active Section */}
            {hasActive && (
              <div className="rounded-lg border border-red-200 bg-red-50 p-3">
                <div className="flex items-center gap-2 mb-2">
                  <Truck className="h-4 w-4 text-red-600" />
                  <span className="font-semibold text-red-800">
                    {active.length} Load{active.length !== 1 ? 's' : ''} Currently In Transit
                  </span>
                </div>
                <p className="text-xs text-red-700 mb-2">
                  These loads cannot be modified while in transit.
                </p>
                <div className="flex flex-wrap gap-1">
                  {active.map((load) => (
                    <Badge
                      key={load.id}
                      variant="outline"
                      className="text-xs bg-white text-red-700 border-red-300"
                    >
                      <XCircle className="h-3 w-3 mr-1" />
                      {load.orderNumber || load.id.slice(-6)}
                    </Badge>
                  ))}
                </div>
              </div>
            )}

            {/* Finalized Section */}
            {hasFinalized && (
              <div className="rounded-lg border border-slate-200 bg-slate-50 p-3">
                <div className="flex items-center gap-2 mb-2">
                  <Ban className="h-4 w-4 text-slate-500" />
                  <span className="font-semibold text-slate-700">
                    {finalized.length} Load{finalized.length !== 1 ? 's' : ''} Already Finalized
                  </span>
                </div>
                <p className="text-xs text-slate-600 mb-2">
                  These loads are already {finalized[0]?.status?.toLowerCase() || 'completed'} and will be skipped.
                </p>
                <div className="flex flex-wrap gap-1">
                  {finalized.slice(0, 5).map((load) => (
                    <Badge key={load.id} variant="outline" className="text-xs bg-white">
                      {load.orderNumber || load.id.slice(-6)} ({load.status})
                    </Badge>
                  ))}
                  {finalized.length > 5 && (
                    <Badge variant="outline" className="text-xs bg-white">
                      +{finalized.length - 5} more
                    </Badge>
                  )}
                </div>
              </div>
            )}

            {/* Force Confirm Checkbox (only if imminent loads exist) */}
            {hasImminent && hasSafe && (
              <div className="flex items-start gap-2 pt-2 border-t">
                <Checkbox
                  id="force-confirm"
                  checked={forceConfirmed}
                  onCheckedChange={(checked) => setForceConfirmed(checked === true)}
                />
                <label
                  htmlFor="force-confirm"
                  className="text-xs text-slate-600 cursor-pointer leading-tight"
                >
                  I understand that {actionVerb.toLowerCase()}ing imminent loads may cause
                  service failures and want to proceed anyway.
                </label>
              </div>
            )}
          </div>
        </ScrollArea>

        <DialogFooter className="flex-col sm:flex-row gap-2">
          <Button variant="ghost" onClick={onCancel} disabled={isProcessing}>
            Cancel
          </Button>

          {hasSafe && (
            <Button
              variant="outline"
              onClick={() => {
                onProceedSafe();
                handleClose();
              }}
              disabled={isProcessing}
            >
              {actionVerb} Safe Only ({safe.length})
            </Button>
          )}

          {hasImminent && hasSafe && (
            <Button
              variant="destructive"
              onClick={() => {
                onProceedAll();
                handleClose();
              }}
              disabled={isProcessing || !forceConfirmed}
            >
              {actionVerb} All ({safe.length + imminent.length})
            </Button>
          )}

          {/* If only safe loads, show simple proceed button */}
          {!hasImminent && !hasActive && hasSafe && (
            <Button
              onClick={() => {
                onProceedSafe();
                handleClose();
              }}
              disabled={isProcessing}
            >
              {actionVerb} ({safe.length})
            </Button>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
