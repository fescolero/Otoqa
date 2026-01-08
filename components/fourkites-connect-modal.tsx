'use client';

import { useState } from 'react';
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Loader2, CheckCircle2, XCircle } from 'lucide-react';
import { useMutation } from 'convex/react';
import { api } from '@/convex/_generated/api';

interface FourKitesConnectModalProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  organizationId: string;
  userId: string;
}

type TestStatus = 'idle' | 'testing' | 'success' | 'error';

export function FourKitesConnectModal({
  open,
  onOpenChange,
  organizationId,
  userId,
}: FourKitesConnectModalProps) {
  const [apiKey, setApiKey] = useState('');
  const [testStatus, setTestStatus] = useState<TestStatus>('idle');
  const [testMessage, setTestMessage] = useState('');
  const [isSubmitting, setIsSubmitting] = useState(false);

  const upsertIntegration = useMutation(api.integrations.upsertIntegration);

  const handleTest = async () => {
    if (!apiKey.trim()) {
      setTestStatus('error');
      setTestMessage('Please enter an API key');
      return;
    }

    setTestStatus('testing');
    setTestMessage('');

    try {
      const response = await fetch('/api/integrations/fourkites/test', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ apiKey }),
      });

      const data = await response.json();

      if (data.success) {
        setTestStatus('success');
        setTestMessage(data.message);
      } else {
        setTestStatus('error');
        setTestMessage(data.message || 'Connection test failed');
      }
    } catch (error) {
      setTestStatus('error');
      setTestMessage('Failed to test connection. Please try again.');
      console.error('Test error:', error);
    }
  };

  const handleConnect = async () => {
    if (!apiKey.trim()) {
      setTestStatus('error');
      setTestMessage('Please enter an API key');
      return;
    }

    if (testStatus !== 'success') {
      setTestStatus('error');
      setTestMessage('Please test the connection first');
      return;
    }

    setIsSubmitting(true);

    try {
      // Store credentials as JSON string
      const credentials = JSON.stringify({ apiKey });

      // Default sync settings for FourKites
      const syncSettings = {
        isEnabled: true,
        pull: {
          loadsEnabled: true,
          intervalMinutes: 300, // 5 hours
          lookbackWindowHours: 24,
        },
        push: {
          gpsTrackingEnabled: false,
          driverAssignmentsEnabled: false,
        },
      };

      await upsertIntegration({
        workosOrgId: organizationId,
        provider: 'fourkites',
        credentials,
        syncSettings,
        createdBy: userId,
      });

      // Reset form and close modal
      setApiKey('');
      setTestStatus('idle');
      setTestMessage('');
      onOpenChange(false);
    } catch (error) {
      setTestStatus('error');
      setTestMessage('Failed to save integration. Please try again.');
      console.error('Save error:', error);
    } finally {
      setIsSubmitting(false);
    }
  };

  const handleCancel = () => {
    setApiKey('');
    setTestStatus('idle');
    setTestMessage('');
    onOpenChange(false);
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-[500px]">
        <DialogHeader>
          <DialogTitle>Connect FourKites</DialogTitle>
          <DialogDescription>
            Enter your FourKites API credentials to connect your account.
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-6 py-4">
          <div className="space-y-2">
            <Label htmlFor="apiKey">API Key</Label>
            <Input
              id="apiKey"
              type="password"
              placeholder="Enter your FourKites API key"
              value={apiKey}
              onChange={(e) => {
                setApiKey(e.target.value);
                setTestStatus('idle');
                setTestMessage('');
              }}
              disabled={isSubmitting}
            />
            <p className="text-xs text-muted-foreground">
              You can find your API key in your FourKites account settings.
            </p>
          </div>

          {/* Test Connection Button */}
          <div className="space-y-2">
            <Button
              onClick={handleTest}
              disabled={!apiKey.trim() || testStatus === 'testing' || isSubmitting}
              variant="outline"
              className="w-full"
            >
              {testStatus === 'testing' ? (
                <>
                  <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                  Testing Connection...
                </>
              ) : (
                'Test Connection'
              )}
            </Button>

            {/* Test Status Message */}
            {testMessage && (
              <div
                className={`flex items-start gap-2 rounded-md p-3 text-sm ${
                  testStatus === 'success'
                    ? 'bg-green-50 text-green-900'
                    : testStatus === 'error'
                      ? 'bg-red-50 text-red-900'
                      : ''
                }`}
              >
                {testStatus === 'success' ? (
                  <CheckCircle2 className="h-4 w-4 mt-0.5 flex-shrink-0" />
                ) : testStatus === 'error' ? (
                  <XCircle className="h-4 w-4 mt-0.5 flex-shrink-0" />
                ) : null}
                <span>{testMessage}</span>
              </div>
            )}
          </div>
        </div>

        <div className="flex justify-end gap-3">
          <Button variant="outline" onClick={handleCancel} disabled={isSubmitting}>
            Cancel
          </Button>
          <Button
            onClick={handleConnect}
            disabled={testStatus !== 'success' || isSubmitting}
          >
            {isSubmitting ? (
              <>
                <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                Connecting...
              </>
            ) : (
              'Connect'
            )}
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}
