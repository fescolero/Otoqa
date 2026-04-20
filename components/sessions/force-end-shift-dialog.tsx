'use client';

import { useState } from 'react';
import { useMutation } from 'convex/react';
import { toast } from 'sonner';
import { AlertTriangle } from 'lucide-react';

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

// Server enum (mirror of `adminEndReasonValidator` in convex/driverSessions.ts).
// Kept as a const tuple so values never drift; if the enum grows we update
// both at the same time.
const FORCE_END_REASONS = [
  {
    value: 'emergency' as const,
    label: 'Emergency',
    helper: 'Driver is in a medical or safety situation.',
  },
  {
    value: 'unreachable_driver' as const,
    label: 'Unreachable Driver',
    helper: "Driver isn't responding to dispatch contact attempts.",
  },
  {
    value: 'phone_issues' as const,
    label: 'Phone Issues',
    helper: 'Phone is dead, lost, or non-functional.',
  },
];

type ForceEndReason = (typeof FORCE_END_REASONS)[number]['value'];

export function ForceEndShiftDialog({
  open,
  onOpenChange,
  sessionId,
  driverName,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  sessionId: Id<'driverSessions'>;
  driverName: string;
}) {
  const adminEndSession = useMutation(api.driverSessions.adminEndSession);
  const [reason, setReason] = useState<ForceEndReason | undefined>(undefined);
  const [isSubmitting, setIsSubmitting] = useState(false);

  const handleConfirm = async () => {
    if (!reason) return;
    setIsSubmitting(true);
    try {
      await adminEndSession({ sessionId, reason });
      toast.success(`Ended ${driverName}'s shift`);
      onOpenChange(false);
      setReason(undefined);
    } catch (err) {
      const msg = err instanceof Error ? err.message : 'Failed to end shift';
      toast.error(msg);
    } finally {
      setIsSubmitting(false);
    }
  };

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (isSubmitting) return; // don't allow dismissal while in flight
        onOpenChange(next);
        if (!next) setReason(undefined);
      }}
    >
      <DialogContent className="sm:max-w-[480px]">
        <DialogHeader>
          <div className="flex items-center gap-3">
            <div className="flex h-10 w-10 items-center justify-center rounded-full bg-red-100 dark:bg-red-950">
              <AlertTriangle className="h-5 w-5 text-red-600" />
            </div>
            <DialogTitle>Force End {driverName}&apos;s Shift?</DialogTitle>
          </div>
        </DialogHeader>

        <div className="space-y-4 py-2">
          <div className="rounded-lg bg-muted p-3 text-sm text-muted-foreground">
            GPS tracking will stop on this driver&apos;s next mobile sync. Any active
            legs will be marked <span className="font-mono">session_ended</span> and
            surfaced in the session-ended-with-active-load audit queue for follow-up.
          </div>

          <div className="space-y-2">
            <Label htmlFor="end-reason">Reason</Label>
            <Select
              value={reason}
              onValueChange={(v) => setReason(v as ForceEndReason)}
              disabled={isSubmitting}
            >
              <SelectTrigger id="end-reason">
                <SelectValue placeholder="Select a reason…" />
              </SelectTrigger>
              <SelectContent>
                {FORCE_END_REASONS.map((r) => (
                  <SelectItem key={r.value} value={r.value}>
                    {r.label}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            {reason && (
              <p className="text-xs text-muted-foreground">
                {FORCE_END_REASONS.find((r) => r.value === reason)?.helper}
              </p>
            )}
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
            variant="destructive"
            onClick={handleConfirm}
            disabled={!reason || isSubmitting}
          >
            {isSubmitting ? 'Ending…' : 'Force End Shift'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
