'use client';

import { useState, useEffect } from 'react';
import { useQuery, useMutation } from 'convex/react';
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
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Loader2, Calendar, Users, DollarSign, AlertCircle } from 'lucide-react';
import { toast } from 'sonner';

interface GenerateStatementsModalProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  organizationId: string;
  userId: string;
}

export function GenerateStatementsModal({
  open,
  onOpenChange,
  organizationId,
  userId,
}: GenerateStatementsModalProps) {
  const [selectedPlanId, setSelectedPlanId] = useState<string>('');
  const [isGenerating, setIsGenerating] = useState(false);

  // Fetch pay plans
  const payPlans = useQuery(api.payPlans.list, {
    workosOrgId: organizationId,
  });

  // Fetch current period for selected plan
  const currentPeriod = useQuery(
    api.payPlans.getCurrentPeriodForPlan,
    selectedPlanId ? { planId: selectedPlanId as Id<'payPlans'> } : 'skip'
  );

  // Fetch drivers for selected plan
  const driversForPlan = useQuery(
    api.payPlans.getDriversForPlan,
    selectedPlanId
      ? { planId: selectedPlanId as Id<'payPlans'>, workosOrgId: organizationId }
      : 'skip'
  );

  // Bulk generate mutation
  const bulkGenerateByPlan = useMutation(api.driverSettlements.bulkGenerateByPlan);

  // Reset state when modal closes
  useEffect(() => {
    if (!open) {
      setSelectedPlanId('');
    }
  }, [open]);

  const handleGenerate = async () => {
    if (!selectedPlanId || !currentPeriod) {
      toast.error('Please select a pay plan');
      return;
    }

    setIsGenerating(true);
    try {
      const result = await bulkGenerateByPlan({
        planId: selectedPlanId as Id<'payPlans'>,
        workosOrgId: organizationId,
        userId,
      });

      if (result.success > 0) {
        toast.success(
          `Generated ${result.success} statement${result.success > 1 ? 's' : ''} for "${currentPeriod.planName}"`
        );
      }
      if (result.failed > 0) {
        const skippedExisting = result.settlements.filter(
          (s) => s.error === 'Settlement already exists for this period'
        ).length;
        const otherErrors = result.failed - skippedExisting;

        if (skippedExisting > 0) {
          toast.info(`${skippedExisting} driver${skippedExisting > 1 ? 's' : ''} already had statements for this period`);
        }
        if (otherErrors > 0) {
          toast.error(`Failed to generate ${otherErrors} statement${otherErrors > 1 ? 's' : ''}`);
        }
      }

      onOpenChange(false);
    } catch (error: any) {
      toast.error(`Error: ${error.message}`);
    } finally {
      setIsGenerating(false);
    }
  };

  const activePayPlans = payPlans?.filter((p) => p.isActive) || [];

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-[500px]">
        <DialogHeader>
          <DialogTitle>Generate Settlement Statements</DialogTitle>
          <DialogDescription>
            Select a Pay Plan to auto-generate statements for all assigned drivers.
          </DialogDescription>
        </DialogHeader>

        <div className="py-4 space-y-6">
          {/* Step 1: Select Pay Plan */}
          <div className="space-y-2">
            <label className="text-sm font-medium">Pay Plan</label>
            <Select value={selectedPlanId} onValueChange={setSelectedPlanId}>
              <SelectTrigger>
                <SelectValue placeholder="Select a pay plan..." />
              </SelectTrigger>
              <SelectContent>
                {activePayPlans.length === 0 ? (
                  <div className="p-3 text-sm text-muted-foreground text-center">
                    No active pay plans found.
                    <br />
                    Create one in Organization Settings.
                  </div>
                ) : (
                  activePayPlans.map((plan) => (
                    <SelectItem key={plan._id} value={plan._id}>
                      <div className="flex items-center gap-2">
                        <span>{plan.name}</span>
                        <Badge variant="outline" className="text-[10px]">
                          {plan.frequency}
                        </Badge>
                        <span className="text-xs text-muted-foreground">
                          ({plan.driverCount} driver{plan.driverCount !== 1 ? 's' : ''})
                        </span>
                      </div>
                    </SelectItem>
                  ))
                )}
              </SelectContent>
            </Select>
          </div>

          {/* Step 2: Period Preview */}
          {selectedPlanId && currentPeriod && (
            <div className="rounded-lg border bg-slate-50 dark:bg-slate-900 p-4 space-y-3">
              <div className="flex items-center gap-2 text-sm font-medium">
                <Calendar className="h-4 w-4 text-indigo-500" />
                Current Pay Period
              </div>
              <div className="grid grid-cols-2 gap-4">
                <div>
                  <p className="text-xs text-muted-foreground">Period</p>
                  <p className="text-sm font-semibold">{currentPeriod.periodLabel}</p>
                </div>
                <div>
                  <p className="text-xs text-muted-foreground">Pay Date</p>
                  <p className="text-sm font-semibold">
                    {new Date(currentPeriod.payDate).toLocaleDateString('en-US', {
                      month: 'short',
                      day: 'numeric',
                      year: 'numeric',
                    })}
                  </p>
                </div>
              </div>
            </div>
          )}

          {/* Step 3: Driver Count */}
          {selectedPlanId && driversForPlan && (
            <div className="flex items-center gap-3 p-3 rounded-lg border">
              <div className="p-2 rounded-full bg-blue-100 dark:bg-blue-900">
                <Users className="h-4 w-4 text-blue-600 dark:text-blue-400" />
              </div>
              <div>
                <p className="text-sm font-medium">
                  {driversForPlan.length} Active Driver{driversForPlan.length !== 1 ? 's' : ''}
                </p>
                <p className="text-xs text-muted-foreground">
                  Will receive draft statements for this period
                </p>
              </div>
            </div>
          )}

          {/* Warning if no drivers */}
          {selectedPlanId && driversForPlan && driversForPlan.length === 0 && (
            <div className="flex items-start gap-3 p-3 rounded-lg border border-amber-200 bg-amber-50 dark:bg-amber-950 dark:border-amber-800">
              <AlertCircle className="h-4 w-4 text-amber-600 mt-0.5" />
              <div className="text-sm">
                <p className="font-medium text-amber-800 dark:text-amber-200">No drivers assigned</p>
                <p className="text-amber-700 dark:text-amber-300 text-xs">
                  Assign drivers to this Pay Plan in their profile settings.
                </p>
              </div>
            </div>
          )}
        </div>

        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)} disabled={isGenerating}>
            Cancel
          </Button>
          <Button
            onClick={handleGenerate}
            disabled={!selectedPlanId || !currentPeriod || isGenerating || (driversForPlan?.length === 0)}
          >
            {isGenerating ? (
              <>
                <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                Generating...
              </>
            ) : (
              <>
                <DollarSign className="mr-2 h-4 w-4" />
                Generate {driversForPlan?.length || 0} Statement{(driversForPlan?.length || 0) !== 1 ? 's' : ''}
              </>
            )}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

