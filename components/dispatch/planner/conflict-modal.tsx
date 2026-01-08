'use client';

import { Id } from '@/convex/_generated/dataModel';
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '@/components/ui/alert-dialog';
import { AlertTriangle, Loader2 } from 'lucide-react';

interface ConflictModalProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  conflictingLoad: {
    orderNumber?: string;
    loadId: Id<'loadInformation'>;
  } | null;
  driverName: string;
  onCancel: () => void;
  onForceAssign: () => void;
  isLoading: boolean;
}

export function ConflictModal({
  open,
  onOpenChange,
  conflictingLoad,
  driverName,
  onCancel,
  onForceAssign,
  isLoading,
}: ConflictModalProps) {
  return (
    <AlertDialog open={open} onOpenChange={onOpenChange}>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle className="flex items-center gap-2">
            <AlertTriangle className="h-5 w-5 text-yellow-500" />
            Schedule Conflict Detected
          </AlertDialogTitle>
          <AlertDialogDescription className="space-y-2">
            <p>
              <strong>{driverName}</strong> is already assigned to{' '}
              <strong>Load #{conflictingLoad?.orderNumber || 'Unknown'}</strong> during this
              time window.
            </p>
            <p className="text-yellow-600 dark:text-yellow-500">
              Force assigning will leave Load #{conflictingLoad?.orderNumber || 'Unknown'}{' '}
              unassigned.
            </p>
          </AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel onClick={onCancel} disabled={isLoading}>
            Cancel
          </AlertDialogCancel>
          <AlertDialogAction
            onClick={onForceAssign}
            className="bg-yellow-600 hover:bg-yellow-700 text-white"
            disabled={isLoading}
          >
            {isLoading && <Loader2 className="h-4 w-4 mr-2 animate-spin" />}
            Force Assign
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}
