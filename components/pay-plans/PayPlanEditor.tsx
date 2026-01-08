'use client';

import { useState, useEffect } from 'react';
import { useQuery, useMutation } from 'convex/react';
import { api } from '@/convex/_generated/api';
import { Id } from '@/convex/_generated/dataModel';
import {
  Sheet,
  SheetContent,
  SheetHeader,
  SheetTitle,
} from '@/components/ui/sheet';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';
import { Switch } from '@/components/ui/switch';
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from '@/components/ui/card';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { Calendar, Clock, Settings, Timer, Loader2 } from 'lucide-react';
import { PayCyclePreview } from './PayCyclePreview';

interface PayPlanEditorProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  planId?: Id<'payPlans'>;
  organizationId: string;
  userId: string;
}

type Frequency = 'WEEKLY' | 'BIWEEKLY' | 'SEMIMONTHLY' | 'MONTHLY';
type DayOfWeek = 'SUNDAY' | 'MONDAY' | 'TUESDAY' | 'WEDNESDAY' | 'THURSDAY' | 'FRIDAY' | 'SATURDAY';
type PayableTrigger = 'DELIVERY_DATE' | 'COMPLETION_DATE' | 'APPROVAL_DATE';

const DAYS_OF_WEEK: { value: DayOfWeek; label: string }[] = [
  { value: 'SUNDAY', label: 'Sunday' },
  { value: 'MONDAY', label: 'Monday' },
  { value: 'TUESDAY', label: 'Tuesday' },
  { value: 'WEDNESDAY', label: 'Wednesday' },
  { value: 'THURSDAY', label: 'Thursday' },
  { value: 'FRIDAY', label: 'Friday' },
  { value: 'SATURDAY', label: 'Saturday' },
];

const FREQUENCIES: { value: Frequency; label: string; description: string }[] = [
  { value: 'WEEKLY', label: 'Weekly', description: 'Every 7 days' },
  { value: 'BIWEEKLY', label: 'Bi-Weekly', description: 'Every 14 days' },
  { value: 'SEMIMONTHLY', label: 'Semi-Monthly', description: '1st-15th, 16th-end' },
  { value: 'MONTHLY', label: 'Monthly', description: 'Once per month' },
];

const TRIGGERS: { value: PayableTrigger; label: string; description: string }[] = [
  { value: 'DELIVERY_DATE', label: 'Delivery Date', description: 'When the load is physically delivered' },
  { value: 'COMPLETION_DATE', label: 'Completion Date', description: 'When the load status is marked complete' },
  { value: 'APPROVAL_DATE', label: 'Approval Date', description: 'When the settlement is approved' },
];

const TIMEZONES = [
  { value: 'America/New_York', label: 'Eastern (ET)' },
  { value: 'America/Chicago', label: 'Central (CT)' },
  { value: 'America/Denver', label: 'Mountain (MT)' },
  { value: 'America/Los_Angeles', label: 'Pacific (PT)' },
  { value: 'America/Phoenix', label: 'Arizona (AZ)' },
];

export function PayPlanEditor({
  open,
  onOpenChange,
  planId,
  organizationId,
  userId,
}: PayPlanEditorProps) {
  // Fetch existing plan if editing
  const existingPlan = useQuery(
    api.payPlans.get,
    planId ? { planId } : 'skip'
  );

  // Mutations
  const createPlan = useMutation(api.payPlans.create);
  const updatePlan = useMutation(api.payPlans.update);

  // Form state
  const [name, setName] = useState('');
  const [description, setDescription] = useState('');
  const [frequency, setFrequency] = useState<Frequency>('WEEKLY');
  const [periodStartDayOfWeek, setPeriodStartDayOfWeek] = useState<DayOfWeek>('MONDAY');
  const [periodStartDayOfMonth, setPeriodStartDayOfMonth] = useState(1);
  const [timezone, setTimezone] = useState<string | undefined>(undefined);
  const [cutoffTime, setCutoffTime] = useState('17:00');
  const [paymentLagDays, setPaymentLagDays] = useState(3);
  const [payableTrigger, setPayableTrigger] = useState<PayableTrigger>('DELIVERY_DATE');
  const [autoCarryover, setAutoCarryover] = useState(true);
  const [includeStandaloneAdjustments, setIncludeStandaloneAdjustments] = useState(true);

  const [isSaving, setIsSaving] = useState(false);

  // Populate form when editing
  useEffect(() => {
    if (existingPlan) {
      setName(existingPlan.name);
      setDescription(existingPlan.description || '');
      setFrequency(existingPlan.frequency);
      setPeriodStartDayOfWeek(existingPlan.periodStartDayOfWeek || 'MONDAY');
      setPeriodStartDayOfMonth(existingPlan.periodStartDayOfMonth || 1);
      setTimezone(existingPlan.timezone);
      setCutoffTime(existingPlan.cutoffTime);
      setPaymentLagDays(existingPlan.paymentLagDays);
      setPayableTrigger(existingPlan.payableTrigger);
      setAutoCarryover(existingPlan.autoCarryover);
      setIncludeStandaloneAdjustments(existingPlan.includeStandaloneAdjustments);
    } else if (!planId) {
      // Reset form for new plan
      setName('');
      setDescription('');
      setFrequency('WEEKLY');
      setPeriodStartDayOfWeek('MONDAY');
      setPeriodStartDayOfMonth(1);
      setTimezone(undefined);
      setCutoffTime('17:00');
      setPaymentLagDays(3);
      setPayableTrigger('DELIVERY_DATE');
      setAutoCarryover(true);
      setIncludeStandaloneAdjustments(true);
    }
  }, [existingPlan, planId, open]);

  const handleSave = async () => {
    if (!name.trim()) return;

    setIsSaving(true);
    try {
      if (planId) {
        await updatePlan({
          planId,
          name: name.trim(),
          description: description.trim() || undefined,
          frequency,
          periodStartDayOfWeek: frequency === 'WEEKLY' || frequency === 'BIWEEKLY' ? periodStartDayOfWeek : undefined,
          periodStartDayOfMonth: frequency === 'MONTHLY' ? periodStartDayOfMonth : undefined,
          timezone: timezone || undefined,
          cutoffTime,
          paymentLagDays,
          payableTrigger,
          autoCarryover,
          includeStandaloneAdjustments,
        });
      } else {
        await createPlan({
          workosOrgId: organizationId,
          name: name.trim(),
          description: description.trim() || undefined,
          frequency,
          periodStartDayOfWeek: frequency === 'WEEKLY' || frequency === 'BIWEEKLY' ? periodStartDayOfWeek : undefined,
          periodStartDayOfMonth: frequency === 'MONTHLY' ? periodStartDayOfMonth : undefined,
          timezone: timezone || undefined,
          cutoffTime,
          paymentLagDays,
          payableTrigger,
          autoCarryover,
          includeStandaloneAdjustments,
          userId,
        });
      }
      onOpenChange(false);
    } catch (error) {
      console.error('Failed to save pay plan:', error);
    } finally {
      setIsSaving(false);
    }
  };

  const isFormValid = name.trim().length > 0;

  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent
        side="right"
        className="w-full sm:max-w-4xl overflow-y-auto p-0"
        onOpenAutoFocus={(e) => e.preventDefault()}
      >
        <SheetHeader className="px-6 py-4 border-b sticky top-0 bg-background z-10">
          <SheetTitle className="text-xl">
            {planId ? 'Edit Pay Plan' : 'Create Pay Plan'}
          </SheetTitle>
        </SheetHeader>

        <div className="flex gap-6 p-6">
          {/* Left Side: Configuration (70%) */}
          <div className="flex-1 space-y-6">
            {/* Basic Info */}
            <Card>
              <CardHeader className="pb-4">
                <CardTitle className="text-base flex items-center gap-2">
                  <Settings className="h-4 w-4" />
                  Plan Details
                </CardTitle>
              </CardHeader>
              <CardContent className="space-y-4">
                <div className="space-y-2">
                  <Label htmlFor="name">Plan Name</Label>
                  <Input
                    id="name"
                    placeholder="e.g., Weekly - Monday Start"
                    value={name}
                    onChange={(e) => setName(e.target.value)}
                  />
                </div>
                <div className="space-y-2">
                  <Label htmlFor="description">Description (Optional)</Label>
                  <Textarea
                    id="description"
                    placeholder="Brief description of this pay plan..."
                    value={description}
                    onChange={(e) => setDescription(e.target.value)}
                    rows={2}
                  />
                </div>
              </CardContent>
            </Card>

            {/* Schedule Settings */}
            <Card>
              <CardHeader className="pb-4">
                <CardTitle className="text-base flex items-center gap-2">
                  <Calendar className="h-4 w-4" />
                  Schedule Settings
                </CardTitle>
                <CardDescription>Define when pay periods start and end</CardDescription>
              </CardHeader>
              <CardContent className="space-y-4">
                <div className="grid grid-cols-2 gap-4">
                  <div className="space-y-2">
                    <Label>Frequency</Label>
                    <Select value={frequency} onValueChange={(v) => setFrequency(v as Frequency)}>
                      <SelectTrigger>
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent>
                        {FREQUENCIES.map((f) => (
                          <SelectItem key={f.value} value={f.value}>
                            <div className="flex flex-col">
                              <span>{f.label}</span>
                              <span className="text-xs text-muted-foreground">{f.description}</span>
                            </div>
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                  </div>

                  {/* Conditional: Day of Week for WEEKLY/BIWEEKLY */}
                  {(frequency === 'WEEKLY' || frequency === 'BIWEEKLY') && (
                    <div className="space-y-2">
                      <Label>Period Start Day</Label>
                      <Select
                        value={periodStartDayOfWeek}
                        onValueChange={(v) => setPeriodStartDayOfWeek(v as DayOfWeek)}
                      >
                        <SelectTrigger>
                          <SelectValue />
                        </SelectTrigger>
                        <SelectContent>
                          {DAYS_OF_WEEK.map((day) => (
                            <SelectItem key={day.value} value={day.value}>
                              {day.label}
                            </SelectItem>
                          ))}
                        </SelectContent>
                      </Select>
                    </div>
                  )}

                  {/* Conditional: Day of Month for MONTHLY */}
                  {frequency === 'MONTHLY' && (
                    <div className="space-y-2">
                      <Label>Period Start Day</Label>
                      <Select
                        value={periodStartDayOfMonth.toString()}
                        onValueChange={(v) => setPeriodStartDayOfMonth(parseInt(v, 10))}
                      >
                        <SelectTrigger>
                          <SelectValue />
                        </SelectTrigger>
                        <SelectContent>
                          {Array.from({ length: 28 }, (_, i) => i + 1).map((day) => (
                            <SelectItem key={day} value={day.toString()}>
                              Day {day}
                            </SelectItem>
                          ))}
                        </SelectContent>
                      </Select>
                    </div>
                  )}

                  {/* SEMIMONTHLY shows fixed info */}
                  {frequency === 'SEMIMONTHLY' && (
                    <div className="space-y-2">
                      <Label>Period Start Days</Label>
                      <div className="h-10 px-3 py-2 border rounded-md bg-muted/50 flex items-center text-sm text-muted-foreground">
                        1st & 16th (Fixed)
                      </div>
                    </div>
                  )}
                </div>

                <div className="grid grid-cols-2 gap-4">
                  <div className="space-y-2">
                    <Label>Cutoff Time</Label>
                    <Input
                      type="time"
                      value={cutoffTime}
                      onChange={(e) => setCutoffTime(e.target.value)}
                    />
                    <p className="text-xs text-muted-foreground">
                      Payables after this time roll to next period
                    </p>
                  </div>
                  <div className="space-y-2">
                    <Label>Timezone (Optional)</Label>
                    <Select
                      value={timezone || 'inherit'}
                      onValueChange={(v) => setTimezone(v === 'inherit' ? undefined : v)}
                    >
                      <SelectTrigger>
                        <SelectValue placeholder="Inherit from org" />
                      </SelectTrigger>
                      <SelectContent>
                        <SelectItem value="inherit">
                          <span className="text-muted-foreground">Inherit from organization</span>
                        </SelectItem>
                        {TIMEZONES.map((tz) => (
                          <SelectItem key={tz.value} value={tz.value}>
                            {tz.label}
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                  </div>
                </div>

                <div className="space-y-2">
                  <Label>Payment Lag (Days)</Label>
                  <Input
                    type="number"
                    min={0}
                    max={30}
                    value={paymentLagDays}
                    onChange={(e) => setPaymentLagDays(parseInt(e.target.value, 10) || 0)}
                    className="w-24"
                  />
                  <p className="text-xs text-muted-foreground">
                    Days after period ends until expected pay date
                  </p>
                </div>
              </CardContent>
            </Card>

            {/* Processing Rules */}
            <Card>
              <CardHeader className="pb-4">
                <CardTitle className="text-base flex items-center gap-2">
                  <Timer className="h-4 w-4" />
                  Processing Rules
                </CardTitle>
                <CardDescription>Define how payables are assigned to periods</CardDescription>
              </CardHeader>
              <CardContent className="space-y-4">
                <div className="space-y-2">
                  <Label>Payable Trigger</Label>
                  <Select
                    value={payableTrigger}
                    onValueChange={(v) => setPayableTrigger(v as PayableTrigger)}
                  >
                    <SelectTrigger>
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      {TRIGGERS.map((t) => (
                        <SelectItem key={t.value} value={t.value}>
                          <div className="flex flex-col">
                            <span>{t.label}</span>
                            <span className="text-xs text-muted-foreground">{t.description}</span>
                          </div>
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>

                <div className="flex items-center justify-between py-2">
                  <div className="space-y-0.5">
                    <Label>Auto-Carryover Held Items</Label>
                    <p className="text-xs text-muted-foreground">
                      Automatically move held payables to the next period
                    </p>
                  </div>
                  <Switch
                    checked={autoCarryover}
                    onCheckedChange={setAutoCarryover}
                  />
                </div>

                <div className="flex items-center justify-between py-2">
                  <div className="space-y-0.5">
                    <Label>Include Standalone Adjustments</Label>
                    <p className="text-xs text-muted-foreground">
                      Pull in unassigned bonuses and deductions
                    </p>
                  </div>
                  <Switch
                    checked={includeStandaloneAdjustments}
                    onCheckedChange={setIncludeStandaloneAdjustments}
                  />
                </div>
              </CardContent>
            </Card>
          </div>

          {/* Right Side: Preview (30%) */}
          <div className="w-80 shrink-0">
            <PayCyclePreview
              frequency={frequency}
              periodStartDayOfWeek={frequency === 'WEEKLY' || frequency === 'BIWEEKLY' ? periodStartDayOfWeek : undefined}
              periodStartDayOfMonth={frequency === 'MONTHLY' ? periodStartDayOfMonth : undefined}
              paymentLagDays={paymentLagDays}
            />
          </div>
        </div>

        {/* Footer Actions */}
        <div className="sticky bottom-0 px-6 py-4 border-t bg-background flex justify-end gap-3">
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button onClick={handleSave} disabled={!isFormValid || isSaving}>
            {isSaving && <Loader2 className="h-4 w-4 mr-2 animate-spin" />}
            {planId ? 'Save Changes' : 'Create Plan'}
          </Button>
        </div>
      </SheetContent>
    </Sheet>
  );
}

