'use client';

import * as React from 'react';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Label } from '@/components/ui/label';
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
import { useQuery, useMutation } from 'convex/react';
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

export function AutoAssignmentSettings({ organizationId, userId }: AutoAssignmentSettingsProps) {
  const [isSaving, setIsSaving] = React.useState(false);

  // Query current settings
  const settings = useQuery(api.routeAssignments.getSettings, { workosOrgId: organizationId });
  const routeAssignments = useQuery(api.routeAssignments.list, {
    workosOrgId: organizationId,
    isActive: true,
  });
  const recurringTemplates = useQuery(api.recurringLoads.list, {
    workosOrgId: organizationId,
    isActive: true,
  });

  // Local state for form
  const [enabled, setEnabled] = React.useState(false);
  const [triggerOnCreate, setTriggerOnCreate] = React.useState(false);
  const [scheduledEnabled, setScheduledEnabled] = React.useState(false);
  const [scheduleInterval, setScheduleInterval] = React.useState('60');

  // Update local state when settings load
  React.useEffect(() => {
    if (settings) {
      setEnabled(settings.enabled);
      setTriggerOnCreate(settings.triggerOnCreate);
      setScheduledEnabled(settings.scheduledEnabled);
      setScheduleInterval(settings.scheduleIntervalMinutes?.toString() || '60');
    }
  }, [settings]);

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
        updatedBy: userId,
      });
      toast.success('Auto-assignment settings saved');
    } catch (error) {
      console.error('Failed to save settings:', error);
      toast.error('Failed to save settings');
    } finally {
      setIsSaving(false);
    }
  };

  const hasChanges = settings
    ? enabled !== settings.enabled ||
      triggerOnCreate !== settings.triggerOnCreate ||
      scheduledEnabled !== settings.scheduledEnabled ||
      parseInt(scheduleInterval) !== (settings.scheduleIntervalMinutes || 60)
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
          </div>

          {/* Save Button */}
          <div className="flex justify-end pt-4">
            <Button onClick={handleSave} disabled={isSaving || !hasChanges}>
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
