'use client';

import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '@/components/ui/alert-dialog';
import { Info } from 'lucide-react';

export interface OverlapDetail {
  loadId: string;
  orderNumber?: string;
  overlapMinutes: number;
}

interface OverlapNoticeModalProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  overlaps: OverlapDetail[];
  driverName: string;
  onDismiss: () => void;
}

function formatOverlapDuration(minutes: number): string {
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  const remaining = minutes % 60;
  return remaining > 0 ? `${hours}h ${remaining}m` : `${hours}h`;
}

export function OverlapNoticeModal({
  open,
  onOpenChange,
  overlaps,
  driverName,
  onDismiss,
}: OverlapNoticeModalProps) {
  if (overlaps.length === 0) return null;

  return (
    <AlertDialog open={open} onOpenChange={onOpenChange}>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle className="flex items-center gap-2">
            <Info className="h-5 w-5 text-amber-500" />
            Schedule Overlap Notice
          </AlertDialogTitle>
          <AlertDialogDescription asChild>
            <div className="space-y-3">
              <p>
                <strong>{driverName}</strong> was assigned successfully. The following schedule
                overlaps were detected:
              </p>
              <ul className="space-y-1.5">
                {overlaps.map((overlap) => (
                  <li
                    key={overlap.loadId}
                    className="flex items-center justify-between rounded-md border px-3 py-2 text-sm"
                  >
                    <span className="font-medium">
                      Load #{overlap.orderNumber || 'Unknown'}
                    </span>
                    <span className="text-amber-600 dark:text-amber-400 font-mono text-xs">
                      {formatOverlapDuration(overlap.overlapMinutes)} overlap
                    </span>
                  </li>
                ))}
              </ul>
              <p className="text-xs text-muted-foreground">
                This is informational only — the assignment has been completed. Review the
                driver&apos;s schedule if needed.
              </p>
            </div>
          </AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogAction onClick={onDismiss}>
            Got it
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}
