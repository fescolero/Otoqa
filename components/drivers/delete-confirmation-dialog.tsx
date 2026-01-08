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
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { AlertTriangle } from 'lucide-react';

interface DeleteConfirmationDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  driverName: string;
  onConfirm: () => void;
  isDeleting?: boolean;
}

export function DeleteConfirmationDialog({
  open,
  onOpenChange,
  driverName,
  onConfirm,
  isDeleting = false,
}: DeleteConfirmationDialogProps) {
  const [confirmText, setConfirmText] = useState('');

  const handleConfirm = () => {
    if (confirmText.toLowerCase() === 'delete') {
      onConfirm();
      setConfirmText('');
    }
  };

  const handleCancel = () => {
    setConfirmText('');
    onOpenChange(false);
  };

  const isValid = confirmText.toLowerCase() === 'delete';

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-[500px]">
        <DialogHeader>
          <div className="flex items-center gap-3">
            <div className="flex h-10 w-10 items-center justify-center rounded-full bg-red-100 dark:bg-red-900">
              <AlertTriangle className="h-5 w-5 text-red-600 dark:text-red-400" />
            </div>
            <DialogTitle>Permanently Delete Driver?</DialogTitle>
          </div>
          <DialogDescription className="pt-3">
            You are about to <span className="font-semibold text-red-600">permanently delete</span>{' '}
            <span className="font-semibold">{driverName}</span>. This action cannot be undone and will remove all
            associated data.
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-4 py-4">
          <div className="rounded-lg bg-red-50 dark:bg-red-950/20 p-4 border border-red-200 dark:border-red-800">
            <p className="text-sm text-red-800 dark:text-red-200 mb-3">
              <strong>Warning:</strong> This will permanently delete:
            </p>
            <ul className="text-sm text-red-700 dark:text-red-300 space-y-1 ml-4 list-disc">
              <li>All driver information and personal data</li>
              <li>License and compliance records</li>
              <li>Employment history</li>
            </ul>
          </div>

          <div className="space-y-2">
            <Label htmlFor="confirm-text">
              Type <span className="font-mono font-semibold text-red-600">DELETE</span> to confirm
            </Label>
            <Input
              id="confirm-text"
              value={confirmText}
              onChange={(e) => setConfirmText(e.target.value)}
              placeholder="Type DELETE to confirm"
              className="font-mono"
              autoComplete="off"
              disabled={isDeleting}
            />
          </div>
        </div>

        <DialogFooter>
          <Button variant="outline" onClick={handleCancel} disabled={isDeleting}>
            Cancel
          </Button>
          <Button variant="destructive" onClick={handleConfirm} disabled={!isValid || isDeleting}>
            {isDeleting ? 'Deleting...' : 'Permanently Delete'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
