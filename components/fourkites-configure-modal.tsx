'use client';

import { useState, useEffect } from 'react';
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Switch } from '@/components/ui/switch';
import { Loader2 } from 'lucide-react';
import { useMutation } from 'convex/react';
import { api } from '@/convex/_generated/api';

interface SyncSettings {
  isEnabled: boolean;
  pull?: {
    loadsEnabled: boolean;
    intervalMinutes: number;
    lookbackWindowHours: number;
  };
  push?: {
    gpsTrackingEnabled: boolean;
    driverAssignmentsEnabled: boolean;
  };
}

interface FourKitesConfigureModalProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  organizationId: string;
  currentSettings: SyncSettings;
}

export function FourKitesConfigureModal({
  open,
  onOpenChange,
  organizationId,
  currentSettings,
}: FourKitesConfigureModalProps) {
  const [isEnabled, setIsEnabled] = useState(currentSettings.isEnabled);
  const [loadsEnabled, setLoadsEnabled] = useState(currentSettings.pull?.loadsEnabled ?? true);
  const [intervalMinutes, setIntervalMinutes] = useState(
    currentSettings.pull?.intervalMinutes?.toString() ?? '300',
  );
  const [lookbackWindowHours, setLookbackWindowHours] = useState(
    currentSettings.pull?.lookbackWindowHours?.toString() ?? '24',
  );
  const [gpsTrackingEnabled, setGpsTrackingEnabled] = useState(
    currentSettings.push?.gpsTrackingEnabled ?? false,
  );
  const [driverAssignmentsEnabled, setDriverAssignmentsEnabled] = useState(
    currentSettings.push?.driverAssignmentsEnabled ?? false,
  );
  const [isSubmitting, setIsSubmitting] = useState(false);

  const updateSyncSettings = useMutation(api.integrations.updateSyncSettings);

  // Reset form when currentSettings change
  useEffect(() => {
    setIsEnabled(currentSettings.isEnabled);
    setLoadsEnabled(currentSettings.pull?.loadsEnabled ?? true);
    setIntervalMinutes(currentSettings.pull?.intervalMinutes?.toString() ?? '300');
    setLookbackWindowHours(currentSettings.pull?.lookbackWindowHours?.toString() ?? '24');
    setGpsTrackingEnabled(currentSettings.push?.gpsTrackingEnabled ?? false);
    setDriverAssignmentsEnabled(currentSettings.push?.driverAssignmentsEnabled ?? false);
  }, [currentSettings]);

  const handleSave = async () => {
    setIsSubmitting(true);

    try {
      const syncSettings: SyncSettings = {
        isEnabled,
        pull: {
          loadsEnabled,
          intervalMinutes: parseInt(intervalMinutes) || 300,
          lookbackWindowHours: parseInt(lookbackWindowHours) || 24,
        },
        push: {
          gpsTrackingEnabled,
          driverAssignmentsEnabled,
        },
      };

      await updateSyncSettings({
        workosOrgId: organizationId,
        provider: 'fourkites',
        syncSettings,
      });

      onOpenChange(false);
    } catch (error) {
      console.error('Failed to update sync settings:', error);
    } finally {
      setIsSubmitting(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-[600px]">
        <DialogHeader>
          <DialogTitle>Configure FourKites Integration</DialogTitle>
          <DialogDescription>Customize your sync settings and data preferences.</DialogDescription>
        </DialogHeader>

        <div className="space-y-6 py-4">
          {/* Master Switch */}
          <div className="flex items-center justify-between">
            <div className="space-y-0.5">
              <Label htmlFor="isEnabled" className="text-base">
                Enable Integration
              </Label>
              <p className="text-sm text-muted-foreground">Master switch for FourKites integration</p>
            </div>
            <Switch id="isEnabled" checked={isEnabled} onCheckedChange={setIsEnabled} />
          </div>

          {/* Pull Settings Section */}
          <div className="space-y-4 pt-4 border-t">
            <h3 className="text-sm font-semibold">Pull Settings</h3>

            <div className="flex items-center justify-between">
              <div className="space-y-0.5">
                <Label htmlFor="loadsEnabled">Import Loads</Label>
                <p className="text-xs text-muted-foreground">Pull load data from FourKites</p>
              </div>
              <Switch
                id="loadsEnabled"
                checked={loadsEnabled}
                onCheckedChange={setLoadsEnabled}
                disabled={!isEnabled}
              />
            </div>

            <div className="space-y-2">
              <Label htmlFor="intervalMinutes">Sync Interval (minutes)</Label>
              <Input
                id="intervalMinutes"
                type="number"
                min="1"
                value={intervalMinutes}
                onChange={(e) => setIntervalMinutes(e.target.value)}
                disabled={!isEnabled || !loadsEnabled}
              />
              <p className="text-xs text-muted-foreground">How often to check for new data (default: 300)</p>
            </div>

            <div className="space-y-2">
              <Label htmlFor="lookbackWindowHours">Lookback Window (hours)</Label>
              <Input
                id="lookbackWindowHours"
                type="number"
                min="1"
                value={lookbackWindowHours}
                onChange={(e) => setLookbackWindowHours(e.target.value)}
                disabled={!isEnabled || !loadsEnabled}
              />
              <p className="text-xs text-muted-foreground">
                Safety net to catch missed updates (default: 24)
              </p>
            </div>
          </div>

          {/* Push Settings Section */}
          <div className="space-y-4 pt-4 border-t">
            <h3 className="text-sm font-semibold">Push Settings</h3>

            <div className="flex items-center justify-between">
              <div className="space-y-0.5">
                <Label htmlFor="gpsTrackingEnabled">GPS Tracking</Label>
                <p className="text-xs text-muted-foreground">Send truck location data to FourKites</p>
              </div>
              <Switch
                id="gpsTrackingEnabled"
                checked={gpsTrackingEnabled}
                onCheckedChange={setGpsTrackingEnabled}
                disabled={!isEnabled}
              />
            </div>

            <div className="flex items-center justify-between">
              <div className="space-y-0.5">
                <Label htmlFor="driverAssignmentsEnabled">Driver Assignments</Label>
                <p className="text-xs text-muted-foreground">Send driver and truck assignments to FourKites</p>
              </div>
              <Switch
                id="driverAssignmentsEnabled"
                checked={driverAssignmentsEnabled}
                onCheckedChange={setDriverAssignmentsEnabled}
                disabled={!isEnabled}
              />
            </div>
          </div>
        </div>

        <div className="flex justify-end gap-3">
          <Button variant="outline" onClick={() => onOpenChange(false)} disabled={isSubmitting}>
            Cancel
          </Button>
          <Button onClick={handleSave} disabled={isSubmitting}>
            {isSubmitting ? (
              <>
                <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                Saving...
              </>
            ) : (
              'Save Changes'
            )}
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}
