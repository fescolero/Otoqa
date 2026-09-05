'use client';

import * as React from 'react';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Label } from '@/components/ui/label';
import { Input } from '@/components/ui/input';
import { Switch } from '@/components/ui/switch';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { Button } from '@/components/ui/button';
import { Separator } from '@/components/ui/separator';
import { useMutation } from 'convex/react';
import { useAuthQuery } from '@/hooks/use-auth-query';
import { api } from '@/convex/_generated/api';
import { Loader2, Info, Route, Calendar } from 'lucide-react';
import { toast } from 'sonner';
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from '@/components/ui/tooltip';
import Link from 'next/link';

interface AutoAssignmentSettingsProps {
  organizationId: string;
  userId: string;
}

/**
 * Human labels for the outcome codes autoAssignPendingLoads reports.
 * Unknown codes fall through to the raw string rather than being hidden —
 * a new decline reason showing up as "OVERLAP_CONFLICT" is still far more
 * useful than it silently vanishing from the breakdown.
 */
const ACTION_LABELS: Record<string, string> = {
  ASSIGNED_DRIVER: 'Assigned to a driver',
  ASSIGNED_CARRIER: 'Assigned to a carrier',
  NO_MATCH: 'No route rule for that HCR',
  ALREADY_ASSIGNED: 'Already assigned',
  OPTED_OUT: 'Excluded after a manual unassignment',
  DAY_RESTRICTED: "Route doesn't run on that day",
  NO_SERVICE_DATE: 'No pickup date yet',
  BEYOND_HORIZON: 'Not due yet (beyond the assignment horizon)',
  OVERLAP_CONFLICT: 'Driver already booked',
  DRIVER_INACTIVE: 'Driver inactive',
  CARRIER_INACTIVE: 'Carrier inactive',
  ERROR: 'Error',
};

function formatRunTime(ms: number): string {
  const mins = Math.round((Date.now() - ms) / 60000);
  if (mins < 1) return 'just now';
  if (mins < 60) return `${mins} min ago`;
  const hours = Math.round(mins / 60);
  if (hours < 24) return `${hours}h ago`;
  return new Date(ms).toLocaleDateString();
}

export function AutoAssignmentSettings({ organizationId, userId }: AutoAssignmentSettingsProps) {
  const [isSaving, setIsSaving] = React.useState(false);

  // Query current settings
  const settings = useAuthQuery(api.routeAssignments.getSettings, { workosOrgId: organizationId });
  const routeAssignments = useAuthQuery(api.routeAssignments.list, {
    workosOrgId: organizationId,
    isActive: true,
  });
  const recurringTemplates = useAuthQuery(api.recurringLoads.list, {
    workosOrgId: organizationId,
    isActive: true,
  });

  // Local state for form
  const [enabled, setEnabled] = React.useState(false);
  const [triggerOnCreate, setTriggerOnCreate] = React.useState(false);
  const [scheduledEnabled, setScheduledEnabled] = React.useState(false);
  const [scheduleInterval, setScheduleInterval] = React.useState('60');
  // Assignment horizon in days. Empty string = no limit (the stored field
  // is absent). Kept as text so the input can be cleared mid-edit.
  const [assignAhead, setAssignAhead] = React.useState('');

  // Update local state when settings load
  React.useEffect(() => {
    if (settings) {
      setEnabled(settings.enabled);
      setTriggerOnCreate(settings.triggerOnCreate);
      setScheduledEnabled(settings.scheduledEnabled);
      setScheduleInterval(settings.scheduleIntervalMinutes?.toString() || '60');
      setAssignAhead(settings.assignAheadDays === undefined ? '' : String(settings.assignAheadDays));
    }
  }, [settings]);

  const parsedAssignAhead = assignAhead.trim() === '' ? null : parseInt(assignAhead, 10);
  const assignAheadInvalid =
    parsedAssignAhead !== null &&
    (!Number.isInteger(parsedAssignAhead) || parsedAssignAhead < 0 || parsedAssignAhead > 365);

  const updateSettings = useMutation(api.routeAssignments.updateSettings);

  const handleSave = async () => {
    setIsSaving(true);
    try {
      await updateSettings({
        workosOrgId: organizationId,
        enabled,
        triggerOnCreate,
        scheduledEnabled,
        scheduleIntervalMinutes: parseInt(scheduleInterval) || 60,
        // null clears the horizon; a number sets it.
        assignAheadDays: parsedAssignAhead,
        updatedBy: userId,
      });
      toast.success('Auto-assignment settings saved');
    } catch (error) {
      console.error('Failed to save settings:', error);
      const message =
        error instanceof Error && 'data' in error && typeof (error as { data?: unknown }).data === 'string'
          ? ((error as { data: string }).data)
          : 'Failed to save settings';
      toast.error(message);
    } finally {
      setIsSaving(false);
    }
  };

  const hasChanges = settings
    ? enabled !== settings.enabled ||
      triggerOnCreate !== settings.triggerOnCreate ||
      scheduledEnabled !== settings.scheduledEnabled ||
      parseInt(scheduleInterval) !== (settings.scheduleIntervalMinutes || 60) ||
      (parsedAssignAhead ?? undefined) !== settings.assignAheadDays
    : true;

  return (
    <div className="space-y-6">
      {/* Main Settings Card */}
      <Card>
        <CardHeader>
          <CardTitle>Auto-Assignment</CardTitle>
          <CardDescription>
            Automatically assign loads to drivers or carriers based on route assignments (HCR +
            Trip).
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-6">
          {/* Master Toggle */}
          <div className="flex items-center justify-between">
            <div className="space-y-0.5">
              <Label htmlFor="enabled" className="text-base">
                Enable Auto-Assignment
              </Label>
              <p className="text-sm text-muted-foreground">
                When enabled, loads will be automatically assigned based on route rules.
              </p>
            </div>
            <Switch
              id="enabled"
              checked={enabled}
              onCheckedChange={setEnabled}
            />
          </div>

          <Separator />

          {/* Trigger Options */}
          <div className="space-y-4">
            <h4 className="text-sm font-medium">Trigger Options</h4>

            <div className="flex items-center justify-between">
              <div className="space-y-0.5">
                <div className="flex items-center gap-2">
                  <Label htmlFor="triggerOnCreate">On Load Creation</Label>
                  <TooltipProvider>
                    <Tooltip>
                      <TooltipTrigger asChild>
                        <Info className="h-4 w-4 text-muted-foreground cursor-help" />
                      </TooltipTrigger>
                      <TooltipContent className="max-w-xs">
                        <p>
                          Immediately attempt auto-assignment when a new load is created (manual or
                          from FourKites).
                        </p>
                      </TooltipContent>
                    </Tooltip>
                  </TooltipProvider>
                </div>
                <p className="text-sm text-muted-foreground">
                  Assign as soon as loads are created
                </p>
              </div>
              <Switch
                id="triggerOnCreate"
                checked={triggerOnCreate}
                onCheckedChange={setTriggerOnCreate}
                disabled={!enabled}
              />
            </div>

            <div className="flex items-center justify-between">
              <div className="space-y-0.5">
                <div className="flex items-center gap-2">
                  <Label htmlFor="scheduledEnabled">Scheduled Processing</Label>
                  <TooltipProvider>
                    <Tooltip>
                      <TooltipTrigger asChild>
                        <Info className="h-4 w-4 text-muted-foreground cursor-help" />
                      </TooltipTrigger>
                      <TooltipContent className="max-w-xs">
                        <p>
                          Periodically process all Open loads to catch any that weren't
                          auto-assigned on creation.
                        </p>
                      </TooltipContent>
                    </Tooltip>
                  </TooltipProvider>
                </div>
                <p className="text-sm text-muted-foreground">
                  Run hourly to process pending loads
                </p>
              </div>
              <Switch
                id="scheduledEnabled"
                checked={scheduledEnabled}
                onCheckedChange={setScheduledEnabled}
                disabled={!enabled}
              />
            </div>

            {/* Recommended shape: no assignment on import, the scheduled
                run assigns each load the day before it runs. Each rule then
                holds at most a day's worth of loads, so a rotation is a
                one-load change instead of a month to unwind. */}
            <div
              className="flex items-center justify-between gap-6 rounded-lg px-3 py-2.5"
              style={{ background: 'var(--bg-sidebar-active)' }}
            >
              <div className="space-y-0.5">
                <div className="text-sm font-medium">Recommended: assign 24 hours before pickup</div>
                <p className="text-sm text-muted-foreground">
                  Off on import, scheduled run on, horizon of 1 day (24 hours before the scheduled
                  pickup time). Rule changes then affect at most a day&apos;s loads per rule.
                </p>
              </div>
              <Button
                type="button"
                variant="outline"
                size="sm"
                disabled={!enabled}
                onClick={() => {
                  setTriggerOnCreate(false);
                  setScheduledEnabled(true);
                  setAssignAhead('1');
                }}
              >
                Use this
              </Button>
            </div>

            {/* Assignment horizon. Without one, an import carrying next
                month's schedule commits drivers to all of it on the spot,
                and a driver rotation then has to unwind every load. */}
            <div className="flex items-center justify-between gap-6">
              <div className="space-y-0.5">
                <div className="flex items-center gap-2">
                  <Label htmlFor="assignAheadDays">Assignment Horizon</Label>
                  <TooltipProvider>
                    <Tooltip>
                      <TooltipTrigger asChild>
                        <Info className="h-4 w-4 text-muted-foreground cursor-help" />
                      </TooltipTrigger>
                      <TooltipContent className="max-w-xs">
                        <p>
                          Only assign a load within this many days (× 24 hours) of its scheduled
                          pickup time. Loads further out stay Open and are picked up by the
                          scheduled run once they come due. Leave blank for no limit.
                        </p>
                      </TooltipContent>
                    </Tooltip>
                  </TooltipProvider>
                </div>
                <p className="text-sm text-muted-foreground">
                  {scheduledEnabled
                    ? 'Assign each load this many × 24 hours before its scheduled pickup'
                    : 'Requires Scheduled Processing — the scheduled run assigns deferred loads'}
                </p>
              </div>
              <div className="flex items-center gap-2">
                <Input
                  id="assignAheadDays"
                  type="number"
                  inputMode="numeric"
                  min={0}
                  max={365}
                  placeholder="No limit"
                  className="w-24 text-right"
                  value={assignAhead}
                  onChange={(e) => setAssignAhead(e.target.value)}
                  disabled={!enabled || !scheduledEnabled}
                  aria-invalid={assignAheadInvalid}
                />
                <span className="text-sm text-muted-foreground">days</span>
              </div>
            </div>
          </div>

          {/* Last run — without this, a rule that silently matches nothing
              looks exactly like one that is working. */}
          {settings?.lastRun && (
            <>
              <Separator />
              <div className="space-y-2">
                <div className="flex items-baseline justify-between">
                  <h4 className="text-sm font-medium">Last scheduled run</h4>
                  <span className="text-xs text-muted-foreground">
                    {formatRunTime(settings.lastRun.at)}
                  </span>
                </div>
                <p className="text-sm text-muted-foreground">
                  {settings.lastRun.processed} load
                  {settings.lastRun.processed === 1 ? '' : 's'} checked ·{' '}
                  <span className="text-foreground font-medium">
                    {settings.lastRun.assigned} assigned
                  </span>{' '}
                  · {settings.lastRun.skipped} skipped
                  {settings.lastRun.errors > 0 && ` · ${settings.lastRun.errors} errors`}
                </p>
                {settings.lastRun.byAction.length > 0 && (
                  <ul className="space-y-1 pt-1">
                    {settings.lastRun.byAction.map((entry) => (
                      <li
                        key={entry.action}
                        className="flex items-center justify-between text-xs text-muted-foreground"
                      >
                        <span>{ACTION_LABELS[entry.action] ?? entry.action}</span>
                        <span className="tabular-nums">{entry.count}</span>
                      </li>
                    ))}
                  </ul>
                )}
              </div>
            </>
          )}

          {/* Save Button */}
          <div className="flex justify-end pt-4">
            <Button onClick={handleSave} disabled={isSaving || !hasChanges || assignAheadInvalid}>
              {isSaving && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
              Save Settings
            </Button>
          </div>
        </CardContent>
      </Card>

      {/* Quick Stats */}
      <div className="grid gap-4 md:grid-cols-2">
        <Card>
          <CardHeader className="pb-2">
            <div className="flex items-center justify-between">
              <CardTitle className="text-sm font-medium">Route Assignments</CardTitle>
              <Route className="h-4 w-4 text-muted-foreground" />
            </div>
          </CardHeader>
          <CardContent>
            <div className="text-2xl font-bold">{routeAssignments?.length ?? '-'}</div>
            <p className="text-xs text-muted-foreground">Active route assignments</p>
            <Button variant="link" size="sm" className="px-0 mt-2" asChild>
              <Link href="/route-assignments">Manage Routes →</Link>
            </Button>
          </CardContent>
        </Card>

        <Card>
          <CardHeader className="pb-2">
            <div className="flex items-center justify-between">
              <CardTitle className="text-sm font-medium">Recurring Templates</CardTitle>
              <Calendar className="h-4 w-4 text-muted-foreground" />
            </div>
          </CardHeader>
          <CardContent>
            <div className="text-2xl font-bold">{recurringTemplates?.length ?? '-'}</div>
            <p className="text-xs text-muted-foreground">Active recurring load templates</p>
          </CardContent>
        </Card>
      </div>
    </div>
  );
}
