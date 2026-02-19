'use client';

import { useState, useEffect } from 'react';
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Switch } from '@/components/ui/switch';
import { Loader2, CheckCircle2, XCircle } from 'lucide-react';
import { useMutation, useQuery } from 'convex/react';
import { api } from '@/convex/_generated/api';
import { toast } from 'sonner';

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
  userId: string;
  currentSettings: SyncSettings;
}

type FourKitesCredentialValues = {
  apiKey?: string;
  username?: string;
  password?: string;
  clientSecret?: string;
  accessToken?: string;
};

export function FourKitesConfigureModal({
  open,
  onOpenChange,
  organizationId,
  userId,
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
  const [apiKey, setApiKey] = useState('');
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [clientSecret, setClientSecret] = useState('');
  const [accessToken, setAccessToken] = useState('');
  const [testingApiKey, setTestingApiKey] = useState(false);
  const [apiKeyTestStatus, setApiKeyTestStatus] = useState<'idle' | 'success' | 'error'>('idle');
  const [apiKeyTestMessage, setApiKeyTestMessage] = useState('');
  const [isSubmitting, setIsSubmitting] = useState(false);

  const updateSyncSettings = useMutation(api.integrations.updateSyncSettings);
  const upsertIntegration = useMutation(api.integrations.upsertIntegration);
  const existingCredentialsRaw = useQuery(
    api.integrations.getCredentials,
    open ? { workosOrgId: organizationId, provider: 'fourkites' } : 'skip',
  );

  // Reset form when currentSettings change
  useEffect(() => {
    setIsEnabled(currentSettings.isEnabled);
    setLoadsEnabled(currentSettings.pull?.loadsEnabled ?? true);
    setIntervalMinutes(currentSettings.pull?.intervalMinutes?.toString() ?? '300');
    setLookbackWindowHours(currentSettings.pull?.lookbackWindowHours?.toString() ?? '24');
    setGpsTrackingEnabled(currentSettings.push?.gpsTrackingEnabled ?? false);
    setDriverAssignmentsEnabled(currentSettings.push?.driverAssignmentsEnabled ?? false);
    setApiKey('');
    setUsername('');
    setPassword('');
    setClientSecret('');
    setAccessToken('');
    setApiKeyTestStatus('idle');
    setApiKeyTestMessage('');
  }, [currentSettings, open]);

  const parseStoredCredentials = (): FourKitesCredentialValues => {
    if (!existingCredentialsRaw || typeof existingCredentialsRaw !== 'string') {
      return {};
    }
    try {
      const parsed = JSON.parse(existingCredentialsRaw);
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
        return parsed as FourKitesCredentialValues;
      }
    } catch {
      return {};
    }
    return {};
  };

  const buildMergedCredentials = (): FourKitesCredentialValues => {
    const merged = { ...parseStoredCredentials() };
    if (apiKey.trim()) merged.apiKey = apiKey.trim();
    if (username.trim()) merged.username = username.trim();
    if (password.trim()) merged.password = password.trim();
    if (clientSecret.trim()) merged.clientSecret = clientSecret.trim();
    if (accessToken.trim()) merged.accessToken = accessToken.trim();
    return merged;
  };

  const testCredentialsConnection = async (credentials: FourKitesCredentialValues): Promise<boolean> => {
    if (
      !credentials.apiKey?.trim() &&
      !(credentials.username?.trim() && credentials.password?.trim()) &&
      !(credentials.apiKey?.trim() && credentials.clientSecret?.trim()) &&
      !credentials.accessToken?.trim()
    ) {
      setApiKeyTestStatus('error');
      setApiKeyTestMessage('Enter credentials to test.');
      return false;
    }

    setTestingApiKey(true);
    setApiKeyTestStatus('idle');
    setApiKeyTestMessage('');

    try {
      const response = await fetch('/api/integrations/fourkites/test', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(credentials),
      });

      const data = await response.json();
      if (data.success) {
        setApiKeyTestStatus('success');
        setApiKeyTestMessage(data.message || 'Credentials are valid.');
        return true;
      }

      setApiKeyTestStatus('error');
      setApiKeyTestMessage(data.message || 'Credentials test failed.');
      return false;
    } catch (error) {
      console.error('Failed to test FourKites credentials:', error);
      setApiKeyTestStatus('error');
      setApiKeyTestMessage('Unable to test credentials. Please try again.');
      return false;
    } finally {
      setTestingApiKey(false);
    }
  };

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

      const hasCredentialUpdate =
        !!apiKey.trim() ||
        !!username.trim() ||
        !!password.trim() ||
        !!clientSecret.trim() ||
        !!accessToken.trim();

      if (hasCredentialUpdate) {
        const mergedCredentials = buildMergedCredentials();
        const valid = await testCredentialsConnection(mergedCredentials);
        if (!valid) {
          toast.error('Credentials test failed. Update credentials and try again.');
          return;
        }

        await upsertIntegration({
          workosOrgId: organizationId,
          provider: 'fourkites',
          credentials: JSON.stringify(mergedCredentials),
          syncSettings,
          createdBy: userId,
        });
        toast.success('Configuration and credentials updated');
      } else {
        await updateSyncSettings({
          workosOrgId: organizationId,
          provider: 'fourkites',
          syncSettings,
        });
        toast.success('Configuration updated');
      }

      onOpenChange(false);
    } catch (error) {
      console.error('Failed to update sync settings:', error);
      toast.error('Failed to update FourKites settings');
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
          {/* Credentials Section */}
          <div className="space-y-3">
            <h3 className="text-sm font-semibold">Credentials</h3>
            <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
              <div className="space-y-2">
              <Label htmlFor="fourkitesApiKey">API Key</Label>
              <Input
                id="fourkitesApiKey"
                type="password"
                autoComplete="new-password"
                value={apiKey}
                onChange={(e) => {
                  setApiKey(e.target.value);
                  setApiKeyTestStatus('idle');
                  setApiKeyTestMessage('');
                }}
                placeholder="Optional: set/update API key"
                disabled={isSubmitting}
              />
              </div>
              <div className="space-y-2">
                <Label htmlFor="fourkitesClientSecret">OAuth Client Secret</Label>
                <Input
                  id="fourkitesClientSecret"
                  type="password"
                  autoComplete="new-password"
                  value={clientSecret}
                  onChange={(e) => {
                    setClientSecret(e.target.value);
                    setApiKeyTestStatus('idle');
                    setApiKeyTestMessage('');
                  }}
                  placeholder="Optional: for OAuth2 flow"
                  disabled={isSubmitting}
                />
              </div>
              <div className="space-y-2">
                <Label htmlFor="fourkitesUsername">Basic Auth Username</Label>
                <Input
                  id="fourkitesUsername"
                  value={username}
                  onChange={(e) => {
                    setUsername(e.target.value);
                    setApiKeyTestStatus('idle');
                    setApiKeyTestMessage('');
                  }}
                  placeholder="Optional: for tracking-api endpoints"
                  disabled={isSubmitting}
                />
              </div>
              <div className="space-y-2">
                <Label htmlFor="fourkitesPassword">Basic Auth Password</Label>
                <Input
                  id="fourkitesPassword"
                  type="password"
                  autoComplete="new-password"
                  value={password}
                  onChange={(e) => {
                    setPassword(e.target.value);
                    setApiKeyTestStatus('idle');
                    setApiKeyTestMessage('');
                  }}
                  placeholder="Optional: for tracking-api endpoints"
                  disabled={isSubmitting}
                />
              </div>
              <div className="space-y-2 md:col-span-2">
                <Label htmlFor="fourkitesAccessToken">OAuth Access Token</Label>
                <Input
                  id="fourkitesAccessToken"
                  type="password"
                  autoComplete="new-password"
                  value={accessToken}
                  onChange={(e) => {
                    setAccessToken(e.target.value);
                    setApiKeyTestStatus('idle');
                    setApiKeyTestMessage('');
                  }}
                  placeholder="Optional: bearer token (short-lived)"
                  disabled={isSubmitting}
                />
              </div>
            </div>
            <div className="space-y-2">
              <p className="text-xs text-muted-foreground">
                API key is used for `api.fourkites.com`. Some `tracking-api.fourkites.com` endpoints require
                username/password. OAuth-enabled tenants may require client secret or access token.
              </p>
              <Button
                type="button"
                variant="outline"
                size="sm"
                className="h-8"
                disabled={testingApiKey || isSubmitting}
                onClick={() => {
                  void testCredentialsConnection(buildMergedCredentials());
                }}
              >
                {testingApiKey ? (
                  <>
                    <Loader2 className="h-3.5 w-3.5 animate-spin" />
                    Testing credentials...
                  </>
                ) : (
                  'Test credentials'
                )}
              </Button>
              {apiKeyTestMessage && (
                <div
                  className={`flex items-start gap-2 rounded-md p-3 text-sm ${
                    apiKeyTestStatus === 'success' ? 'bg-green-50 text-green-900' : 'bg-red-50 text-red-900'
                  }`}
                >
                  {apiKeyTestStatus === 'success' ? (
                    <CheckCircle2 className="h-4 w-4 mt-0.5 flex-shrink-0" />
                  ) : (
                    <XCircle className="h-4 w-4 mt-0.5 flex-shrink-0" />
                  )}
                  <span>{apiKeyTestMessage}</span>
                </div>
              )}
            </div>
          </div>

          {/* Master Switch */}
          <div className="flex items-center justify-between pt-4 border-t">
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
