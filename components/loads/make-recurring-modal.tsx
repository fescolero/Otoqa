'use client';

import * as React from 'react';
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
import { Checkbox } from '@/components/ui/checkbox';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { useMutation, useQuery } from 'convex/react';
import { api } from '@/convex/_generated/api';
import { Id } from '@/convex/_generated/dataModel';
import { Loader2, CalendarDays, Info } from 'lucide-react';
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from '@/components/ui/tooltip';
import { Badge } from '@/components/ui/badge';

interface MakeRecurringModalProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  loadId: Id<'loadInformation'>;
  organizationId: string;
  userId: string;
}

const DAYS_OF_WEEK = [
  { value: 0, label: 'Sun' },
  { value: 1, label: 'Mon' },
  { value: 2, label: 'Tue' },
  { value: 3, label: 'Wed' },
  { value: 4, label: 'Thu' },
  { value: 5, label: 'Fri' },
  { value: 6, label: 'Sat' },
];

export function MakeRecurringModal({
  open,
  onOpenChange,
  loadId,
  organizationId,
  userId,
}: MakeRecurringModalProps) {
  const [isSubmitting, setIsSubmitting] = React.useState(false);

  // Form state
  const [name, setName] = React.useState('');
  const [activeDays, setActiveDays] = React.useState<number[]>([1, 2, 3, 4, 5]); // Mon-Fri default
  const [excludeFederalHolidays, setExcludeFederalHolidays] = React.useState(true);
  const [generationTime, setGenerationTime] = React.useState('06:00');
  const [advanceDays, setAdvanceDays] = React.useState('0');
  const [deliveryDayOffset, setDeliveryDayOffset] = React.useState('0');
  const [endDate, setEndDate] = React.useState('');
  const [routeAssignmentId, setRouteAssignmentId] = React.useState<string>('');
  const [customExclusions, setCustomExclusions] = React.useState('');

  // Query route assignments for linking
  const routeAssignments = useQuery(
    api.routeAssignments.list,
    { workosOrgId: organizationId, isActive: true }
  );

  // Get the source load to show info
  const load = useQuery(api.loads.getLoad, { loadId });

  const createTemplate = useMutation(api.recurringLoads.createFromLoad);

  // Toggle day selection
  const toggleDay = (day: number) => {
    setActiveDays((prev) =>
      prev.includes(day) ? prev.filter((d) => d !== day) : [...prev, day].sort()
    );
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();

    if (!name) {
      alert('Template name is required');
      return;
    }

    if (activeDays.length === 0) {
      alert('Please select at least one day of the week');
      return;
    }

    setIsSubmitting(true);

    try {
      // Parse custom exclusions
      const exclusionDates = customExclusions
        .split(',')
        .map((d) => d.trim())
        .filter((d) => /^\d{4}-\d{2}-\d{2}$/.test(d));

      await createTemplate({
        sourceLoadId: loadId,
        name,
        activeDays,
        excludeFederalHolidays,
        customExclusions: exclusionDates,
        generationTime,
        advanceDays: parseInt(advanceDays) || 0,
        deliveryDayOffset: parseInt(deliveryDayOffset) || 0,
        endDate: endDate || undefined,
        routeAssignmentId: routeAssignmentId
          ? (routeAssignmentId as Id<'routeAssignments'>)
          : undefined,
        createdBy: userId,
      });

      // Reset form and close
      resetForm();
      onOpenChange(false);
    } catch (error) {
      console.error('Failed to create recurring template:', error);
      alert(error instanceof Error ? error.message : 'Failed to create recurring template');
    } finally {
      setIsSubmitting(false);
    }
  };

  const resetForm = () => {
    setName('');
    setActiveDays([1, 2, 3, 4, 5]);
    setExcludeFederalHolidays(true);
    setGenerationTime('06:00');
    setAdvanceDays('0');
    setDeliveryDayOffset('0');
    setEndDate('');
    setRouteAssignmentId('');
    setCustomExclusions('');
  };

  // Pre-populate name from load
  React.useEffect(() => {
    if (load && !name) {
      setName(`${load.parsedHcr || 'Load'} - Recurring`);
    }
  }, [load, name]);

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-[550px] max-h-[90vh] overflow-y-auto">
        <form onSubmit={handleSubmit}>
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              <CalendarDays className="h-5 w-5" />
              Make This Load Recurring
            </DialogTitle>
            <DialogDescription>
              Create a template to automatically generate this load on a schedule.
            </DialogDescription>
          </DialogHeader>

          <div className="grid gap-4 py-4">
            {/* Source Load Info */}
            {load && (
              <div className="bg-muted p-3 rounded-lg text-sm">
                <div className="font-medium mb-1">Source Load</div>
                <div className="flex flex-wrap gap-2">
                  <Badge variant="outline">{load.internalId}</Badge>
                  {load.parsedHcr && <Badge variant="secondary">HCR: {load.parsedHcr}</Badge>}
                  {load.parsedTripNumber && (
                    <Badge variant="secondary">Trip: {load.parsedTripNumber}</Badge>
                  )}
                </div>
              </div>
            )}

            {/* Template Name */}
            <div className="space-y-2">
              <Label htmlFor="name">Template Name *</Label>
              <Input
                id="name"
                placeholder="e.g., Daily Amazon Route"
                value={name}
                onChange={(e) => setName(e.target.value)}
                required
              />
            </div>

            {/* Route Assignment Link */}
            <div className="space-y-2">
              <div className="flex items-center gap-2">
                <Label htmlFor="routeAssignment">Link to Route Assignment</Label>
                <TooltipProvider>
                  <Tooltip>
                    <TooltipTrigger asChild>
                      <Info className="h-4 w-4 text-muted-foreground cursor-help" />
                    </TooltipTrigger>
                    <TooltipContent className="max-w-xs">
                      <p>
                        If linked, generated loads will be auto-assigned to the configured
                        driver/carrier.
                      </p>
                    </TooltipContent>
                  </Tooltip>
                </TooltipProvider>
              </div>
              <Select value={routeAssignmentId || 'none'} onValueChange={(value) => setRouteAssignmentId(value === 'none' ? '' : value)}>
                <SelectTrigger>
                  <SelectValue placeholder="None (generate as Open)" />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="none">None (generate as Open)</SelectItem>
                  {routeAssignments?.map((ra) => (
                    <SelectItem key={ra._id} value={ra._id}>
                      {ra.name || ra.hcr} {ra.tripNumber ? `(Trip ${ra.tripNumber})` : ''}
                      {ra.driverName ? ` → ${ra.driverName}` : ''}
                      {ra.carrierName ? ` → ${ra.carrierName}` : ''}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>

            {/* Days of Week */}
            <div className="space-y-2">
              <Label>Generate On *</Label>
              <div className="flex gap-2">
                {DAYS_OF_WEEK.map((day) => (
                  <Button
                    key={day.value}
                    type="button"
                    variant={activeDays.includes(day.value) ? 'default' : 'outline'}
                    size="sm"
                    className="w-10"
                    onClick={() => toggleDay(day.value)}
                  >
                    {day.label}
                  </Button>
                ))}
              </div>
            </div>

            {/* Holiday Exclusions */}
            <div className="space-y-3">
              <div className="flex items-center space-x-2">
                <Checkbox
                  id="excludeHolidays"
                  checked={excludeFederalHolidays}
                  onCheckedChange={(checked) => setExcludeFederalHolidays(checked === true)}
                />
                <Label htmlFor="excludeHolidays" className="cursor-pointer">
                  Skip Federal Holidays
                </Label>
              </div>

              <div className="space-y-2">
                <Label htmlFor="customExclusions">Custom Exclusion Dates</Label>
                <Input
                  id="customExclusions"
                  placeholder="e.g., 2026-12-25, 2026-12-26"
                  value={customExclusions}
                  onChange={(e) => setCustomExclusions(e.target.value)}
                />
                <p className="text-xs text-muted-foreground">
                  Comma-separated dates in YYYY-MM-DD format
                </p>
              </div>
            </div>

            {/* Timing */}
            <div className="grid grid-cols-2 gap-4">
              <div className="space-y-2">
                <Label htmlFor="generationTime">Generation Time (UTC)</Label>
                <Input
                  id="generationTime"
                  type="time"
                  value={generationTime}
                  onChange={(e) => setGenerationTime(e.target.value)}
                />
              </div>
              <div className="space-y-2">
                <div className="flex items-center gap-2">
                  <Label htmlFor="advanceDays">Advance Days</Label>
                  <TooltipProvider>
                    <Tooltip>
                      <TooltipTrigger asChild>
                        <Info className="h-4 w-4 text-muted-foreground cursor-help" />
                      </TooltipTrigger>
                      <TooltipContent className="max-w-xs">
                        <p>
                          Create load N days before pickup. 0 = same day, 1 = day before.
                        </p>
                      </TooltipContent>
                    </Tooltip>
                  </TooltipProvider>
                </div>
                <Input
                  id="advanceDays"
                  type="number"
                  min="0"
                  max="7"
                  value={advanceDays}
                  onChange={(e) => setAdvanceDays(e.target.value)}
                />
              </div>
            </div>

            {/* Multi-day Load */}
            <div className="space-y-2">
              <div className="flex items-center gap-2">
                <Label htmlFor="deliveryDayOffset">Delivery Day Offset</Label>
                <TooltipProvider>
                  <Tooltip>
                    <TooltipTrigger asChild>
                      <Info className="h-4 w-4 text-muted-foreground cursor-help" />
                    </TooltipTrigger>
                    <TooltipContent className="max-w-xs">
                      <p>
                        For multi-day loads: 0 = same day delivery, 1 = next day delivery.
                      </p>
                    </TooltipContent>
                  </Tooltip>
                </TooltipProvider>
              </div>
              <Select value={deliveryDayOffset} onValueChange={setDeliveryDayOffset}>
                <SelectTrigger>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="0">Same Day (0)</SelectItem>
                  <SelectItem value="1">Next Day (+1)</SelectItem>
                  <SelectItem value="2">Day After (+2)</SelectItem>
                  <SelectItem value="3">Three Days (+3)</SelectItem>
                </SelectContent>
              </Select>
            </div>

            {/* End Date */}
            <div className="space-y-2">
              <div className="flex items-center gap-2">
                <Label htmlFor="endDate">End Date (Optional)</Label>
                <TooltipProvider>
                  <Tooltip>
                    <TooltipTrigger asChild>
                      <Info className="h-4 w-4 text-muted-foreground cursor-help" />
                    </TooltipTrigger>
                    <TooltipContent className="max-w-xs">
                      <p>
                        Stop generating loads after this date. Leave empty for no end date.
                      </p>
                    </TooltipContent>
                  </Tooltip>
                </TooltipProvider>
              </div>
              <Input
                id="endDate"
                type="date"
                value={endDate}
                onChange={(e) => setEndDate(e.target.value)}
              />
            </div>
          </div>

          <DialogFooter>
            <Button type="button" variant="outline" onClick={() => onOpenChange(false)}>
              Cancel
            </Button>
            <Button type="submit" disabled={isSubmitting}>
              {isSubmitting && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
              Create Recurring Template
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
