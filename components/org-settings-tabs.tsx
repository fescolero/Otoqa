'use client';

import { Card } from '@/components/ui/card';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import {
  Users,
  Plug,
  Truck,
  Route,
  Key,
  Loader2,
  Copy,
  ChevronDown,
  ChevronUp,
} from 'lucide-react';
import { AutoAssignmentSettings } from '@/components/auto-assignment-settings';
import { PartnerApiSettings } from '@/components/partner-api-settings';
import { WidgetsProvider } from '@/components/widgets-provider';
import { UsersManagement, WorkOsWidgets } from '@workos-inc/widgets';
import { useEffect, useState } from 'react';
import { useQuery, useMutation } from 'convex/react';
import { api } from '@/convex/_generated/api';
import { FourKitesConnectModal } from '@/components/fourkites-connect-modal';
import { FourKitesConfigureModal } from '@/components/fourkites-configure-modal';
import { Button } from '@/components/ui/button';
import { toast } from 'sonner';
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '@/components/ui/alert-dialog';
import '@workos-inc/widgets/styles.css';

interface Organization {
  id: string;
  name: string;
  domains?: Array<{ id: string; domain: string }>;
  createdAt?: string;
  updatedAt?: string;
}

interface User {
  id: string;
  firstName?: string;
  lastName?: string;
  email: string;
  profilePictureUrl?: string;
}

interface OrgSettingsTabsProps {
  organization: Organization | null;
  user: User;
}

export function OrgSettingsTabs({ organization, user }: OrgSettingsTabsProps) {
  const [widgetToken, setWidgetToken] = useState<string | null>(null);
  const [fourKitesModalOpen, setFourKitesModalOpen] = useState(false);
  const [fourKitesConfigureOpen, setFourKitesConfigureOpen] = useState(false);
  const [disconnectDialogOpen, setDisconnectDialogOpen] = useState(false);
  const [runningManualSync, setRunningManualSync] = useState(false);
  const [manualSyncRequestedAt, setManualSyncRequestedAt] = useState<number | null>(null);
  const [isSyncIssueExpanded, setIsSyncIssueExpanded] = useState(false);

  // Fetch integrations for this organization
  const integrations = useQuery(
    api.integrations.getIntegrations,
    organization?.id ? { workosOrgId: organization.id } : 'skip',
  );

  // Check if FourKites is already connected
  const fourKitesIntegration = integrations?.find((int) => int.provider === 'fourkites');

  // Mutations
  const deleteIntegration = useMutation(api.integrations.deleteIntegration);
  const triggerManualSync = useMutation(api.fourKitesTest.triggerManualSync);

  const handleDisconnect = async () => {
    if (!organization?.id) return;

    try {
      await deleteIntegration({
        workosOrgId: organization.id,
        provider: 'fourkites',
      });
      setDisconnectDialogOpen(false);
    } catch (error) {
      console.error('Failed to disconnect integration:', error);
    }
  };

  const handleRunManualSync = async () => {
    if (!organization?.id) return;

    setRunningManualSync(true);
    try {
      const requestedAt = Date.now();
      await triggerManualSync({ workosOrgId: organization.id });
      setManualSyncRequestedAt(requestedAt);
      toast.success('Manual sync queued. Check status in a few seconds.');
    } catch (error) {
      console.error('Failed to trigger manual sync:', error);
      toast.error(error instanceof Error ? error.message : 'Failed to trigger manual sync');
    } finally {
      setRunningManualSync(false);
    }
  };

  const handleCopyDiagnostics = async (diagnostics: string) => {
    if (!diagnostics?.trim()) {
      toast.error('No diagnostics available to copy');
      return;
    }

    try {
      await navigator.clipboard.writeText(diagnostics);
      toast.success('Diagnostics copied to clipboard');
    } catch (error) {
      console.error('Failed to copy diagnostics:', error);
      toast.error('Unable to copy diagnostics. Please copy manually.');
    }
  };

  useEffect(() => {
    // Keep diagnostics compact by default when new sync issues appear.
    setIsSyncIssueExpanded(false);
  }, [fourKitesIntegration?.lastSyncStats.errorMessage]);

  useEffect(() => {
    if (!manualSyncRequestedAt) return;
    const lastSyncTime = fourKitesIntegration?.lastSyncStats.lastSyncTime ?? 0;
    if (lastSyncTime >= manualSyncRequestedAt) {
      setManualSyncRequestedAt(null);
    }
  }, [manualSyncRequestedAt, fourKitesIntegration?.lastSyncStats.lastSyncTime]);

  useEffect(() => {
    async function fetchToken() {
      try {
        const response = await fetch('/api/widgets/token');
        if (response.ok) {
          const data = await response.json();
          setWidgetToken(data.token);
        }
      } catch (error) {
        console.error('Failed to fetch widget token:', error);
      }
    }
    fetchToken();
  }, []);


  return (
    <Tabs defaultValue="users" className="w-full">
      <TabsList className="grid w-full md:w-[500px] grid-cols-4">
        <TabsTrigger value="users" className="flex items-center gap-2">
          <Users className="h-4 w-4" />
          <span className="hidden sm:inline">Users</span>
        </TabsTrigger>
        <TabsTrigger value="automation" className="flex items-center gap-2">
          <Route className="h-4 w-4" />
          <span className="hidden sm:inline">Automation</span>
        </TabsTrigger>
        <TabsTrigger value="integrations" className="flex items-center gap-2">
          <Plug className="h-4 w-4" />
          <span className="hidden sm:inline">Integrations</span>
        </TabsTrigger>
        <TabsTrigger value="api-partners" className="flex items-center gap-2">
          <Key className="h-4 w-4" />
          <span className="hidden sm:inline">API Partners</span>
        </TabsTrigger>
      </TabsList>

      {/* Users Tab */}
      <TabsContent value="users" className="space-y-6 mt-6">
        {widgetToken ? (
          <WidgetsProvider>
            <WorkOsWidgets>
              <UsersManagement authToken={widgetToken} />
            </WorkOsWidgets>
          </WidgetsProvider>
        ) : (
          <Card className="p-6">
            <div className="text-center text-muted-foreground">Loading users management...</div>
          </Card>
        )}
      </TabsContent>

      {/* Automation Tab */}
      <TabsContent value="automation" className="mt-6">
        {organization?.id && (
          <AutoAssignmentSettings organizationId={organization.id} userId={user.id} />
        )}
      </TabsContent>

      {/* Integrations Tab */}
      <TabsContent value="integrations" className="space-y-6 mt-6">
        {/* Connected Integrations */}
        {fourKitesIntegration && (
          <Card className="p-6">
            <h2 className="text-xl font-semibold mb-4">Connected Integrations</h2>
            <div className="space-y-4">
              <div className="border rounded-lg p-4 space-y-4">
                {/* Header Row */}
                <div className="flex items-center justify-between">
                  <div className="flex items-center gap-2 flex-wrap justify-end">
                    <div className="h-12 w-12 rounded-lg bg-blue-100 flex items-center justify-center">
                      <Truck className="h-6 w-6 text-blue-600" />
                    </div>
                    <div>
                      <p className="font-medium">FourKites</p>
                      <p className="text-sm text-muted-foreground">Real-time shipment tracking</p>
                    </div>
                  </div>
                  <div className="flex items-center gap-3">
                    <span
                      className={`inline-flex items-center rounded-full px-2.5 py-0.5 text-xs font-medium ${
                        fourKitesIntegration.syncSettings.isEnabled
                          ? 'bg-green-100 text-green-800'
                          : 'bg-gray-100 text-gray-800'
                      }`}
                    >
                      {fourKitesIntegration.syncSettings.isEnabled ? 'Enabled' : 'Disabled'}
                    </span>
                    <Button
                      variant="outline"
                      size="sm"
                      onClick={() => setFourKitesConfigureOpen(true)}
                    >
                      Configure
                    </Button>
                    <Button
                      variant="outline"
                      size="sm"
                      onClick={handleRunManualSync}
                      disabled={runningManualSync}
                    >
                      {runningManualSync ? (
                        <>
                          <Loader2 className="h-3.5 w-3.5 animate-spin" />
                          Testing...
                        </>
                      ) : (
                        'Run test sync'
                      )}
                    </Button>
                    <Button
                      variant="ghost"
                      size="sm"
                      className="text-red-600 hover:text-red-700 hover:bg-red-50"
                      onClick={() => setDisconnectDialogOpen(true)}
                    >
                      Disconnect
                    </Button>
                  </div>
                </div>

                {/* Sync Statistics */}
                <div className="grid grid-cols-2 md:grid-cols-4 gap-4 pt-4 border-t">
                  <div>
                    <p className="text-xs text-muted-foreground">Last Sync</p>
                    <p className="text-sm font-medium">
                      {fourKitesIntegration.lastSyncStats.lastSyncTime
                        ? new Date(fourKitesIntegration.lastSyncStats.lastSyncTime).toLocaleString()
                        : 'Never'}
                    </p>
                  </div>
                  <div>
                    <p className="text-xs text-muted-foreground">Status</p>
                    <p className="text-sm font-medium capitalize">
                      {fourKitesIntegration.lastSyncStats.lastSyncStatus || 'Pending'}
                    </p>
                  </div>
                  <div>
                    <p className="text-xs text-muted-foreground">Records Processed</p>
                    <p className="text-sm font-medium">
                      {fourKitesIntegration.lastSyncStats.recordsProcessed ?? 0}
                    </p>
                  </div>
                  <div>
                    <p className="text-xs text-muted-foreground">Sync Interval</p>
                    <p className="text-sm font-medium">
                      {fourKitesIntegration.syncSettings.pull?.intervalMinutes || 300} min
                    </p>
                  </div>
                </div>

                {/* Error Message */}
                {(() => {
                  const lastSyncStatus = fourKitesIntegration.lastSyncStats.lastSyncStatus;
                  const lastSyncTime = fourKitesIntegration.lastSyncStats.lastSyncTime ?? 0;
                  const isManualSyncPending =
                    manualSyncRequestedAt !== null && (!lastSyncTime || lastSyncTime < manualSyncRequestedAt);
                  const hasSyncError =
                    !!fourKitesIntegration.lastSyncStats.errorMessage && lastSyncStatus !== 'success';
                  const hasSyncSuccess = !hasSyncError && lastSyncStatus === 'success';
                  const isErrorPotentiallyStale =
                    hasSyncError && (fourKitesIntegration.updatedAt ?? 0) > lastSyncTime;

                  if (isManualSyncPending) {
                    return (
                      <div className="p-4 bg-blue-50 text-blue-900 rounded-md border border-blue-200">
                        <p className="font-semibold text-sm">Sync In Progress</p>
                        <p className="mt-2 text-sm leading-6">
                          Manual sync is queued and running. This panel will refresh when the run completes.
                        </p>
                      </div>
                    );
                  }

                  if (hasSyncSuccess) {
                    return (
                      <div className="p-4 bg-green-50 text-green-900 rounded-md border border-green-200">
                        <p className="font-semibold text-sm">Sync Status</p>
                        <p className="mt-2 text-sm leading-6">
                          Last sync completed successfully.
                        </p>
                      </div>
                    );
                  }

                  if (!hasSyncError) {
                    return null;
                  }

                  const errorMessage = fourKitesIntegration.lastSyncStats.errorMessage ?? '';

                  return (
                  <div className="p-4 bg-red-50 text-red-900 rounded-md border border-red-200">
                    <div className="flex items-center justify-between gap-2">
                      <p className="font-semibold text-sm">Sync Issue Details</p>
                      <div className="flex items-center justify-end gap-2 flex-wrap">
                        <Button
                          type="button"
                          variant="outline"
                          size="sm"
                          className="h-7 px-2 text-xs border-red-200 text-red-900 bg-white/70 hover:bg-white"
                          onClick={() => setIsSyncIssueExpanded((current) => !current)}
                        >
                          {isSyncIssueExpanded ? (
                            <ChevronUp className="h-3.5 w-3.5" />
                          ) : (
                            <ChevronDown className="h-3.5 w-3.5" />
                          )}
                          {isSyncIssueExpanded ? 'Compact' : 'Expand'}
                        </Button>
                        <Button
                          type="button"
                          variant="outline"
                          size="sm"
                          className="h-7 px-2 text-xs border-red-200 text-red-900 bg-white/70 hover:bg-white"
                          onClick={() => handleCopyDiagnostics(errorMessage)}
                        >
                          <Copy className="h-3.5 w-3.5" />
                          Copy diagnostics
                        </Button>
                      </div>
                    </div>
                    {isSyncIssueExpanded ? (
                      <div className="mt-2 max-h-56 overflow-y-auto rounded-md border border-red-200 bg-white/70 p-3">
                        <p className="whitespace-pre-line text-sm leading-6">
                          {errorMessage}
                        </p>
                      </div>
                    ) : (
                      <p className="mt-2 text-sm leading-6 truncate">
                        {errorMessage.split('\n')[0]}
                      </p>
                    )}
                    {isErrorPotentiallyStale && (
                      <p className="mt-2 text-xs text-red-800/90">
                        Integration settings were updated after this failed sync. Re-run test sync to refresh status.
                      </p>
                    )}
                    <p className="mt-3 text-xs text-red-800/80">
                      If this continues after updating credentials or lane mappings, contact support and include
                      these diagnostics.
                    </p>
                  </div>
                  );
                })()}
              </div>
            </div>
          </Card>
        )}

        {/* Available Integrations */}
        <Card className="p-6">
          <h2 className="text-xl font-semibold mb-4">Available Integrations</h2>
          <div className="space-y-4">
            {/* FourKites Integration */}
            {!fourKitesIntegration && (
              <div className="border rounded-lg p-4">
                <div className="flex items-center justify-between">
                  <div className="flex items-center gap-3">
                    <div className="h-12 w-12 rounded-lg bg-gray-100 flex items-center justify-center">
                      <Truck className="h-6 w-6 text-gray-600" />
                    </div>
                    <div>
                      <p className="font-medium">FourKites</p>
                      <p className="text-sm text-muted-foreground">Real-time shipment tracking</p>
                    </div>
                  </div>
                  <Button
                    onClick={() => setFourKitesModalOpen(true)}
                    className="bg-foreground text-background hover:opacity-90 transition-opacity"
                  >
                    Connect
                  </Button>
                </div>
              </div>
            )}
          </div>
        </Card>

        {/* FourKites Connect Modal */}
        {organization && (
          <FourKitesConnectModal
            open={fourKitesModalOpen}
            onOpenChange={setFourKitesModalOpen}
            organizationId={organization.id}
            userId={user.id}
          />
        )}

        {/* FourKites Configure Modal */}
        {organization && fourKitesIntegration && (
          <FourKitesConfigureModal
            open={fourKitesConfigureOpen}
            onOpenChange={setFourKitesConfigureOpen}
            organizationId={organization.id}
            userId={user.id}
            currentSettings={fourKitesIntegration.syncSettings}
          />
        )}

        {/* Disconnect Confirmation Dialog */}
        <AlertDialog open={disconnectDialogOpen} onOpenChange={setDisconnectDialogOpen}>
          <AlertDialogContent>
            <AlertDialogHeader>
              <AlertDialogTitle>Disconnect FourKites?</AlertDialogTitle>
              <AlertDialogDescription>
                Are you sure you want to disconnect FourKites? This will stop all data synchronization and
                remove your saved credentials. You can reconnect at any time.
              </AlertDialogDescription>
            </AlertDialogHeader>
            <AlertDialogFooter>
              <AlertDialogCancel>Cancel</AlertDialogCancel>
              <AlertDialogAction
                onClick={handleDisconnect}
                className="bg-red-600 hover:bg-red-700 focus:ring-red-600"
              >
                Disconnect
              </AlertDialogAction>
            </AlertDialogFooter>
          </AlertDialogContent>
        </AlertDialog>
      </TabsContent>

      {/* API Partners Tab */}
      <TabsContent value="api-partners" className="mt-6">
        {organization?.id && (
          <PartnerApiSettings organizationId={organization.id} />
        )}
      </TabsContent>
    </Tabs>
  );
}
