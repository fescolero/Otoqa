'use client';

import { useState } from 'react';
import { useQuery, useMutation, useAction } from 'convex/react';
import { api } from '@/convex/_generated/api';
import { Id } from '@/convex/_generated/dataModel';
import { Card } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Badge } from '@/components/ui/badge';
import { Separator } from '@/components/ui/separator';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
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
import { toast } from 'sonner';
import {
  Key,
  Plus,
  Copy,
  Trash2,
  Webhook,
  Activity,
  Shield,
  Eye,
  EyeOff,
  CheckCircle2,
  XCircle,
  Clock,
  Loader2,
  AlertTriangle,
  Globe,
  Pause,
  Play,
} from 'lucide-react';

interface PartnerApiSettingsProps {
  organizationId: string;
}

// ============================================
// API KEYS PANEL
// ============================================

function ApiKeysPanel({ organizationId }: { organizationId: string }) {
  const keys = useQuery(api.externalTrackingPartnerKeys.listKeys, { workosOrgId: organizationId });
  const createKey = useAction(api.externalTrackingPartnerKeys.createKey);
  const revokeKey = useMutation(api.externalTrackingPartnerKeys.revokeKey);

  const [createOpen, setCreateOpen] = useState(false);
  const [revokeOpen, setRevokeOpen] = useState(false);
  const [revokeTarget, setRevokeTarget] = useState<Id<'partnerApiKeys'> | null>(null);
  const [creating, setCreating] = useState(false);
  const [newKeyResult, setNewKeyResult] = useState<{ rawKey: string; keyId: string } | null>(null);

  // Create form state
  const [partnerName, setPartnerName] = useState('');
  const [environment, setEnvironment] = useState<'sandbox' | 'production'>('sandbox');
  const [rateLimitTier, setRateLimitTier] = useState<'low' | 'medium' | 'high'>('medium');
  const [permissions, setPermissions] = useState<string[]>(['tracking:read', 'tracking:events', 'tracking:subscribe']);

  const handleCreate = async () => {
    if (!partnerName.trim()) {
      toast.error('Partner name is required');
      return;
    }

    setCreating(true);
    try {
      const result = await createKey({
        workosOrgId: organizationId,
        partnerName: partnerName.trim(),
        environment,
        rateLimitTier,
        permissions,
      });
      setNewKeyResult({ rawKey: result.rawKey, keyId: result.keyId as string });
      toast.success('API key created');
    } catch (error: any) {
      toast.error(error.message || 'Failed to create API key');
    } finally {
      setCreating(false);
    }
  };

  const handleRevoke = async () => {
    if (!revokeTarget) return;
    try {
      await revokeKey({ workosOrgId: organizationId, keyId: revokeTarget });
      toast.success('API key revoked');
      setRevokeOpen(false);
      setRevokeTarget(null);
    } catch (error: any) {
      toast.error(error.message || 'Failed to revoke key');
    }
  };

  const handleCopyKey = () => {
    if (newKeyResult?.rawKey) {
      navigator.clipboard.writeText(newKeyResult.rawKey);
      toast.success('API key copied to clipboard');
    }
  };

  const resetCreateForm = () => {
    setPartnerName('');
    setEnvironment('sandbox');
    setRateLimitTier('medium');
    setPermissions(['tracking:read', 'tracking:events', 'tracking:subscribe']);
    setNewKeyResult(null);
    setCreateOpen(false);
  };

  return (
    <Card className="p-6">
      <div className="flex items-center justify-between mb-4">
        <div className="flex items-center gap-2">
          <Key className="h-5 w-5" />
          <h2 className="text-xl font-semibold">API Keys</h2>
        </div>
        <Button onClick={() => setCreateOpen(true)} size="sm">
          <Plus className="h-4 w-4 mr-1" />
          Create Key
        </Button>
      </div>

      <p className="text-sm text-muted-foreground mb-4">
        API keys allow external partners to access your tracking data. Each key is scoped to your organization.
      </p>

      {/* Key List */}
      {!keys || keys.length === 0 ? (
        <div className="text-center py-8 text-muted-foreground">
          <Shield className="h-12 w-12 mx-auto mb-3 opacity-50" />
          <p className="font-medium">No API keys yet</p>
          <p className="text-sm mt-1">Create your first API key to get started</p>
        </div>
      ) : (
        <div className="space-y-3">
          {keys.map((key) => (
            <div
              key={key._id}
              className="border rounded-lg p-4 flex items-center justify-between"
            >
              <div className="flex-1">
                <div className="flex items-center gap-2">
                  <span className="font-medium">{key.partnerName}</span>
                  <Badge variant={key.status === 'ACTIVE' ? 'default' : 'destructive'}>
                    {key.status}
                  </Badge>
                  <Badge variant="outline">
                    {key.environment}
                  </Badge>
                </div>
                <div className="flex items-center gap-4 mt-1 text-sm text-muted-foreground">
                  <span className="font-mono">{key.keyPrefix}...****</span>
                  <span>Rate: {key.rateLimitTier}</span>
                  {key.lastUsedAt && (
                    <span>
                      Last used: {new Date(key.lastUsedAt).toLocaleDateString()}
                    </span>
                  )}
                </div>
              </div>
              {key.status === 'ACTIVE' && (
                <Button
                  variant="ghost"
                  size="sm"
                  className="text-red-600 hover:text-red-700 hover:bg-red-50"
                  onClick={() => {
                    setRevokeTarget(key._id);
                    setRevokeOpen(true);
                  }}
                >
                  <Trash2 className="h-4 w-4" />
                </Button>
              )}
            </div>
          ))}
        </div>
      )}

      {/* Create Key Dialog */}
      <Dialog open={createOpen} onOpenChange={(open) => { if (!open) resetCreateForm(); }}>
        <DialogContent className="sm:max-w-lg">
          <DialogHeader>
            <DialogTitle>
              {newKeyResult ? 'API Key Created' : 'Create API Key'}
            </DialogTitle>
            <DialogDescription>
              {newKeyResult
                ? 'Copy this key now. You will not be able to see it again.'
                : 'Create a new API key for a partner to access your tracking data.'}
            </DialogDescription>
          </DialogHeader>

          {newKeyResult ? (
            <div className="space-y-4">
              <div className="bg-amber-50 border border-amber-200 rounded-lg p-4">
                <div className="flex items-start gap-2">
                  <AlertTriangle className="h-5 w-5 text-amber-600 mt-0.5" />
                  <div>
                    <p className="text-sm font-medium text-amber-800">
                      Save this key now - it won't be shown again
                    </p>
                    <div className="mt-2 flex items-center gap-2">
                      <code className="text-xs bg-white px-2 py-1 rounded border font-mono break-all">
                        {newKeyResult.rawKey}
                      </code>
                      <Button variant="outline" size="sm" onClick={handleCopyKey}>
                        <Copy className="h-3 w-3" />
                      </Button>
                    </div>
                  </div>
                </div>
              </div>
              <DialogFooter>
                <Button onClick={resetCreateForm}>Done</Button>
              </DialogFooter>
            </div>
          ) : (
            <div className="space-y-4">
              <div className="grid gap-2">
                <Label htmlFor="partnerName">Partner Name *</Label>
                <Input
                  id="partnerName"
                  value={partnerName}
                  onChange={(e) => setPartnerName(e.target.value)}
                  placeholder="e.g., FourKites, Project44"
                />
              </div>

              <div className="grid gap-2">
                <Label>Environment</Label>
                <Select value={environment} onValueChange={(v) => setEnvironment(v as any)}>
                  <SelectTrigger>
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="sandbox">Sandbox (test data)</SelectItem>
                    <SelectItem value="production">Production (live data)</SelectItem>
                  </SelectContent>
                </Select>
              </div>

              <div className="grid gap-2">
                <Label>Rate Limit Tier</Label>
                <Select value={rateLimitTier} onValueChange={(v) => setRateLimitTier(v as any)}>
                  <SelectTrigger>
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="low">Low (60 req/min)</SelectItem>
                    <SelectItem value="medium">Medium (300 req/min)</SelectItem>
                    <SelectItem value="high">High (1000 req/min)</SelectItem>
                  </SelectContent>
                </Select>
              </div>

              <div className="grid gap-2">
                <Label>Permissions</Label>
                <div className="space-y-2">
                  {[
                    { value: 'tracking:read', label: 'Read positions & stops' },
                    { value: 'tracking:events', label: 'Read status events' },
                    { value: 'tracking:subscribe', label: 'Manage webhooks' },
                  ].map((perm) => (
                    <label key={perm.value} className="flex items-center gap-2">
                      <input
                        type="checkbox"
                        checked={permissions.includes(perm.value)}
                        onChange={(e) => {
                          setPermissions((prev) =>
                            e.target.checked
                              ? [...prev, perm.value]
                              : prev.filter((p) => p !== perm.value)
                          );
                        }}
                        className="rounded"
                      />
                      <span className="text-sm">{perm.label}</span>
                      <code className="text-xs text-muted-foreground">{perm.value}</code>
                    </label>
                  ))}
                </div>
              </div>

              <DialogFooter>
                <Button variant="outline" onClick={resetCreateForm}>
                  Cancel
                </Button>
                <Button onClick={handleCreate} disabled={creating}>
                  {creating ? (
                    <>
                      <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                      Creating...
                    </>
                  ) : (
                    'Create Key'
                  )}
                </Button>
              </DialogFooter>
            </div>
          )}
        </DialogContent>
      </Dialog>

      {/* Revoke Confirmation */}
      <AlertDialog open={revokeOpen} onOpenChange={setRevokeOpen}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Revoke API Key?</AlertDialogTitle>
            <AlertDialogDescription>
              This will immediately revoke the API key and disable any associated webhook subscriptions.
              Partners using this key will lose access. This cannot be undone.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction
              onClick={handleRevoke}
              className="bg-red-600 hover:bg-red-700"
            >
              Revoke Key
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </Card>
  );
}

// ============================================
// WEBHOOKS PANEL
// ============================================

function WebhooksPanel({ organizationId }: { organizationId: string }) {
  const subscriptions = useQuery(api.externalTrackingWebhooks.listSubscriptions, { workosOrgId: organizationId });
  const keys = useQuery(api.externalTrackingPartnerKeys.listKeys, { workosOrgId: organizationId });
  const createSubscription = useAction(api.externalTrackingWebhooks.createSubscription);
  const updateStatus = useMutation(api.externalTrackingWebhooks.updateSubscriptionStatus);

  const [createOpen, setCreateOpen] = useState(false);
  const [creating, setCreating] = useState(false);
  const [newSecretResult, setNewSecretResult] = useState<string | null>(null);

  // Create form state
  const [selectedKeyId, setSelectedKeyId] = useState('');
  const [webhookUrl, setWebhookUrl] = useState('');
  const [selectedEvents, setSelectedEvents] = useState<string[]>([
    'position.update',
    'status.changed',
    'tracking.started',
    'tracking.ended',
  ]);

  const activeKeys = keys?.filter((k) => k.status === 'ACTIVE') ?? [];

  const handleCreate = async () => {
    if (!selectedKeyId || !webhookUrl.trim()) {
      toast.error('API key and URL are required');
      return;
    }

    setCreating(true);
    try {
      const result = await createSubscription({
        workosOrgId: organizationId,
        partnerKeyId: selectedKeyId as Id<'partnerApiKeys'>,
        url: webhookUrl.trim(),
        events: selectedEvents,
      });
      setNewSecretResult(result.rawSecret);
      toast.success('Webhook subscription created');
    } catch (error: any) {
      toast.error(error.message || 'Failed to create webhook');
    } finally {
      setCreating(false);
    }
  };

  const handleToggleStatus = async (subId: Id<'webhookSubscriptions'>, currentStatus: string) => {
    try {
      await updateStatus({
        workosOrgId: organizationId,
        subscriptionId: subId,
        status: currentStatus === 'ACTIVE' ? 'PAUSED' : 'ACTIVE',
      });
      toast.success(`Webhook ${currentStatus === 'ACTIVE' ? 'paused' : 'resumed'}`);
    } catch (error: any) {
      toast.error(error.message || 'Failed to update webhook');
    }
  };

  const resetCreateForm = () => {
    setSelectedKeyId('');
    setWebhookUrl('');
    setSelectedEvents(['position.update', 'status.changed', 'tracking.started', 'tracking.ended']);
    setNewSecretResult(null);
    setCreateOpen(false);
  };

  return (
    <Card className="p-6">
      <div className="flex items-center justify-between mb-4">
        <div className="flex items-center gap-2">
          <Webhook className="h-5 w-5" />
          <h2 className="text-xl font-semibold">Webhook Subscriptions</h2>
        </div>
        <Button onClick={() => setCreateOpen(true)} size="sm" disabled={activeKeys.length === 0}>
          <Plus className="h-4 w-4 mr-1" />
          Add Webhook
        </Button>
      </div>

      <p className="text-sm text-muted-foreground mb-4">
        Webhooks push real-time tracking updates to partner endpoints. Each webhook is signed with HMAC-SHA256.
      </p>

      {activeKeys.length === 0 && (
        <div className="bg-amber-50 border border-amber-200 rounded-lg p-4 mb-4">
          <p className="text-sm text-amber-800">
            Create an API key first before setting up webhooks.
          </p>
        </div>
      )}

      {/* Subscription List */}
      {!subscriptions || subscriptions.length === 0 ? (
        <div className="text-center py-8 text-muted-foreground">
          <Webhook className="h-12 w-12 mx-auto mb-3 opacity-50" />
          <p className="font-medium">No webhooks configured</p>
          <p className="text-sm mt-1">Add a webhook to receive real-time tracking updates</p>
        </div>
      ) : (
        <div className="space-y-3">
          {subscriptions.map((sub) => {
            const keyInfo = keys?.find((k) => k._id === sub.partnerKeyId);
            return (
              <div key={sub._id} className="border rounded-lg p-4">
                <div className="flex items-center justify-between">
                  <div>
                    <div className="flex items-center gap-2">
                      <span className="font-mono text-sm">{sub.url}</span>
                      <Badge
                        variant={
                          sub.status === 'ACTIVE'
                            ? 'default'
                            : sub.status === 'PAUSED'
                            ? 'secondary'
                            : 'destructive'
                        }
                      >
                        {sub.status}
                      </Badge>
                    </div>
                    <div className="flex items-center gap-3 mt-1 text-xs text-muted-foreground">
                      <span>Key: {keyInfo?.partnerName || 'Unknown'}</span>
                      <span>Events: {sub.events.join(', ')}</span>
                      <span>Every {sub.intervalMinutes}min</span>
                      {sub.consecutiveFailures > 0 && (
                        <span className="text-red-600">
                          Failures: {sub.consecutiveFailures}
                        </span>
                      )}
                    </div>
                    {sub.lastFailureReason && (
                      <p className="text-xs text-red-600 mt-1">{sub.lastFailureReason}</p>
                    )}
                  </div>
                  <div className="flex items-center gap-2">
                    {sub.status !== 'DISABLED' && (
                      <Button
                        variant="ghost"
                        size="sm"
                        onClick={() => handleToggleStatus(sub._id, sub.status)}
                      >
                        {sub.status === 'ACTIVE' ? (
                          <Pause className="h-4 w-4" />
                        ) : (
                          <Play className="h-4 w-4" />
                        )}
                      </Button>
                    )}
                  </div>
                </div>
              </div>
            );
          })}
        </div>
      )}

      {/* Create Webhook Dialog */}
      <Dialog open={createOpen} onOpenChange={(open) => { if (!open) resetCreateForm(); }}>
        <DialogContent className="sm:max-w-lg">
          <DialogHeader>
            <DialogTitle>
              {newSecretResult ? 'Webhook Created' : 'Add Webhook Subscription'}
            </DialogTitle>
            <DialogDescription>
              {newSecretResult
                ? 'Save the signing secret. It will not be shown again.'
                : 'Configure a webhook endpoint to receive tracking updates.'}
            </DialogDescription>
          </DialogHeader>

          {newSecretResult ? (
            <div className="space-y-4">
              <div className="bg-amber-50 border border-amber-200 rounded-lg p-4">
                <div className="flex items-start gap-2">
                  <AlertTriangle className="h-5 w-5 text-amber-600 mt-0.5" />
                  <div>
                    <p className="text-sm font-medium text-amber-800">
                      Save your signing secret
                    </p>
                    <p className="text-xs text-amber-700 mt-1">
                      Use this to verify webhook signatures. See our docs for verification code.
                    </p>
                    <div className="mt-2 flex items-center gap-2">
                      <code className="text-xs bg-white px-2 py-1 rounded border font-mono break-all">
                        {newSecretResult}
                      </code>
                      <Button
                        variant="outline"
                        size="sm"
                        onClick={() => {
                          navigator.clipboard.writeText(newSecretResult);
                          toast.success('Secret copied');
                        }}
                      >
                        <Copy className="h-3 w-3" />
                      </Button>
                    </div>
                  </div>
                </div>
              </div>
              <DialogFooter>
                <Button onClick={resetCreateForm}>Done</Button>
              </DialogFooter>
            </div>
          ) : (
            <div className="space-y-4">
              <div className="grid gap-2">
                <Label>API Key *</Label>
                <Select value={selectedKeyId} onValueChange={setSelectedKeyId}>
                  <SelectTrigger>
                    <SelectValue placeholder="Select an API key..." />
                  </SelectTrigger>
                  <SelectContent>
                    {activeKeys.map((k) => (
                      <SelectItem key={k._id} value={k._id}>
                        {k.partnerName} ({k.environment})
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>

              <div className="grid gap-2">
                <Label htmlFor="webhookUrl">Endpoint URL * (HTTPS only)</Label>
                <Input
                  id="webhookUrl"
                  value={webhookUrl}
                  onChange={(e) => setWebhookUrl(e.target.value)}
                  placeholder="https://partner.example.com/webhooks/tracking"
                />
              </div>

              <div className="grid gap-2">
                <Label>Events</Label>
                <div className="space-y-2">
                  {[
                    { value: 'position.update', label: 'Position updates' },
                    { value: 'status.changed', label: 'Status changes' },
                    { value: 'tracking.started', label: 'Tracking started' },
                    { value: 'tracking.ended', label: 'Tracking ended' },
                  ].map((event) => (
                    <label key={event.value} className="flex items-center gap-2">
                      <input
                        type="checkbox"
                        checked={selectedEvents.includes(event.value)}
                        onChange={(e) => {
                          setSelectedEvents((prev) =>
                            e.target.checked
                              ? [...prev, event.value]
                              : prev.filter((ev) => ev !== event.value)
                          );
                        }}
                        className="rounded"
                      />
                      <span className="text-sm">{event.label}</span>
                    </label>
                  ))}
                </div>
              </div>

              <DialogFooter>
                <Button variant="outline" onClick={resetCreateForm}>
                  Cancel
                </Button>
                <Button onClick={handleCreate} disabled={creating}>
                  {creating ? (
                    <>
                      <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                      Creating...
                    </>
                  ) : (
                    'Create Webhook'
                  )}
                </Button>
              </DialogFooter>
            </div>
          )}
        </DialogContent>
      </Dialog>
    </Card>
  );
}

// ============================================
// AUDIT LOG PANEL
// ============================================

function AuditLogPanel({ organizationId }: { organizationId: string }) {
  const logs = useQuery(api.externalTrackingPartnerKeys.getAuditLogs, { workosOrgId: organizationId, limit: 50 });
  const keys = useQuery(api.externalTrackingPartnerKeys.listKeys, { workosOrgId: organizationId });

  return (
    <Card className="p-6">
      <div className="flex items-center gap-2 mb-4">
        <Activity className="h-5 w-5" />
        <h2 className="text-xl font-semibold">API Audit Log</h2>
      </div>

      <p className="text-sm text-muted-foreground mb-4">
        Recent API requests from all partners. Logs are retained for 30 days.
      </p>

      {!logs || logs.length === 0 ? (
        <div className="text-center py-8 text-muted-foreground">
          <Activity className="h-12 w-12 mx-auto mb-3 opacity-50" />
          <p className="font-medium">No API activity yet</p>
          <p className="text-sm mt-1">Requests will appear here once partners start using your API</p>
        </div>
      ) : (
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b text-left text-muted-foreground">
                <th className="pb-2 pr-4">Time</th>
                <th className="pb-2 pr-4">Partner</th>
                <th className="pb-2 pr-4">Method</th>
                <th className="pb-2 pr-4">Endpoint</th>
                <th className="pb-2 pr-4">Status</th>
                <th className="pb-2 pr-4">Latency</th>
                <th className="pb-2">Request ID</th>
              </tr>
            </thead>
            <tbody>
              {logs.map((log) => {
                const keyInfo = keys?.find((k) => k._id === log.partnerKeyId);
                return (
                  <tr key={log._id} className="border-b last:border-0">
                    <td className="py-2 pr-4 text-xs text-muted-foreground whitespace-nowrap">
                      {new Date(log.timestamp).toLocaleString()}
                    </td>
                    <td className="py-2 pr-4 text-xs">
                      {keyInfo?.partnerName || 'Unknown'}
                    </td>
                    <td className="py-2 pr-4">
                      <Badge variant="outline" className="text-xs">
                        {log.method}
                      </Badge>
                    </td>
                    <td className="py-2 pr-4 text-xs font-mono max-w-[200px] truncate">
                      {log.endpoint}
                    </td>
                    <td className="py-2 pr-4">
                      <Badge
                        variant={log.statusCode >= 200 && log.statusCode < 300 ? 'default' : 'destructive'}
                        className="text-xs"
                      >
                        {log.statusCode}
                      </Badge>
                    </td>
                    <td className="py-2 pr-4 text-xs text-muted-foreground">
                      {log.responseTimeMs ? `${log.responseTimeMs}ms` : '-'}
                    </td>
                    <td className="py-2 text-xs font-mono text-muted-foreground">
                      {log.requestId}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </Card>
  );
}

// ============================================
// INTEGRATION HEALTH DASHBOARD
// ============================================

function HealthDashboard({ organizationId }: { organizationId: string }) {
  const keys = useQuery(api.externalTrackingPartnerKeys.listKeys, { workosOrgId: organizationId });
  const subscriptions = useQuery(api.externalTrackingWebhooks.listSubscriptions, { workosOrgId: organizationId });
  const logs = useQuery(api.externalTrackingPartnerKeys.getAuditLogs, { workosOrgId: organizationId, limit: 100 });

  const activeKeys = keys?.filter((k) => k.status === 'ACTIVE').length ?? 0;
  const revokedKeys = keys?.filter((k) => k.status === 'REVOKED').length ?? 0;
  const activeWebhooks = subscriptions?.filter((s) => s.status === 'ACTIVE').length ?? 0;
  const failingWebhooks = subscriptions?.filter((s) => s.consecutiveFailures > 0).length ?? 0;
  const disabledWebhooks = subscriptions?.filter((s) => s.status === 'DISABLED').length ?? 0;

  // Calculate success rate from last 100 requests
  const totalRequests = logs?.length ?? 0;
  const successRequests = logs?.filter((l) => l.statusCode >= 200 && l.statusCode < 300).length ?? 0;
  const successRate = totalRequests > 0 ? Math.round((successRequests / totalRequests) * 100) : 0;

  // Calculate average latency
  const latencies = logs?.filter((l) => l.responseTimeMs).map((l) => l.responseTimeMs!) ?? [];
  const avgLatency = latencies.length > 0
    ? Math.round(latencies.reduce((sum, l) => sum + l, 0) / latencies.length)
    : 0;

  return (
    <Card className="p-6">
      <div className="flex items-center gap-2 mb-4">
        <Globe className="h-5 w-5" />
        <h2 className="text-xl font-semibold">Integration Health</h2>
      </div>

      <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
        <div className="border rounded-lg p-4">
          <p className="text-xs text-muted-foreground mb-1">Active Keys</p>
          <p className="text-2xl font-bold">{activeKeys}</p>
          {revokedKeys > 0 && (
            <p className="text-xs text-muted-foreground mt-1">{revokedKeys} revoked</p>
          )}
        </div>
        <div className="border rounded-lg p-4">
          <p className="text-xs text-muted-foreground mb-1">Active Webhooks</p>
          <p className="text-2xl font-bold">{activeWebhooks}</p>
          {failingWebhooks > 0 && (
            <p className="text-xs text-amber-600 mt-1">{failingWebhooks} with failures</p>
          )}
          {disabledWebhooks > 0 && (
            <p className="text-xs text-red-600 mt-1">{disabledWebhooks} disabled</p>
          )}
        </div>
        <div className="border rounded-lg p-4">
          <p className="text-xs text-muted-foreground mb-1">Success Rate</p>
          <p className="text-2xl font-bold">
            {totalRequests > 0 ? `${successRate}%` : '-'}
          </p>
          <p className="text-xs text-muted-foreground mt-1">Last 100 requests</p>
        </div>
        <div className="border rounded-lg p-4">
          <p className="text-xs text-muted-foreground mb-1">Avg Latency</p>
          <p className="text-2xl font-bold">
            {avgLatency > 0 ? `${avgLatency}ms` : '-'}
          </p>
          <p className="text-xs text-muted-foreground mt-1">Last 100 requests</p>
        </div>
      </div>
    </Card>
  );
}

// ============================================
// MAIN COMPONENT
// ============================================

export function PartnerApiSettings({ organizationId }: PartnerApiSettingsProps) {
  return (
    <div className="space-y-6">
      <HealthDashboard organizationId={organizationId} />
      <ApiKeysPanel organizationId={organizationId} />
      <WebhooksPanel organizationId={organizationId} />
      <AuditLogPanel organizationId={organizationId} />
    </div>
  );
}
