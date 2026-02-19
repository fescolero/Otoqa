'use client';

import { Card } from '@/components/ui/card';
import { Separator } from '@/components/ui/separator';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import {
  Building2,
  Users,
  Plug,
  Truck,
  Route,
  Key,
  Upload,
  Loader2,
  Globe,
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
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { AddressAutocomplete } from '@/components/ui/address-autocomplete';
import { toast } from 'sonner';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
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
  const [uploadingLogo, setUploadingLogo] = useState(false);
  const [initializing, setInitializing] = useState(false);
  const [savingBilling, setSavingBilling] = useState(false);
  const [runningManualSync, setRunningManualSync] = useState(false);
  const [manualSyncRequestedAt, setManualSyncRequestedAt] = useState<number | null>(null);
  const [isSyncIssueExpanded, setIsSyncIssueExpanded] = useState(false);

  // Billing form state
  const [billingEmail, setBillingEmail] = useState('');
  const [billingPhone, setBillingPhone] = useState('');
  const [addressLine1, setAddressLine1] = useState('');
  const [addressLine2, setAddressLine2] = useState('');
  const [city, setCity] = useState('');
  const [state, setState] = useState('');
  const [zip, setZip] = useState('');
  const [country, setCountry] = useState('USA');

  // Organization settings state
  const [defaultTimezone, setDefaultTimezone] = useState('America/New_York');
  const [savingTimezone, setSavingTimezone] = useState(false);

  // Fetch organization settings from backend
  const orgSettings = useQuery(
    api.settings.getOrgSettings,
    organization?.id ? { workosOrgId: organization.id } : 'skip',
  );

  // Fetch integrations for this organization
  const integrations = useQuery(
    api.integrations.getIntegrations,
    organization?.id ? { workosOrgId: organization.id } : 'skip',
  );

  // Check if FourKites is already connected
  const fourKitesIntegration = integrations?.find((int) => int.provider === 'fourkites');

  // Mutations
  const deleteIntegration = useMutation(api.integrations.deleteIntegration);
  const generateUploadUrl = useMutation(api.settings.generateUploadUrl);
  const updateOrgSettings = useMutation(api.settings.updateOrgSettings);
  const triggerManualSync = useMutation(api.fourKitesTest.triggerManualSync);

  // Initialize organization with default settings
  const handleInitializeOrg = async () => {
    if (!organization?.id) return;

    setInitializing(true);
    try {
      // Extract first domain if available
      const domain = organization.domains && organization.domains.length > 0 
        ? organization.domains[0].domain 
        : undefined;

      // Wait for Convex mutation to complete
      await updateOrgSettings({
        workosOrgId: organization.id,
        updates: {
          name: organization.name,
          domain,
          industry: 'Transportation & Logistics',
          billingEmail: user.email,
          billingAddress: {
            addressLine1: '',
            city: '',
            state: '',
            zip: '',
            country: 'USA',
          },
          subscriptionPlan: 'Enterprise',
          subscriptionStatus: 'Active',
          billingCycle: 'Annual',
          nextBillingDate: new Date(Date.now() + 365 * 24 * 60 * 60 * 1000).toISOString(),
        },
      });

      // Only show success after Convex confirms
      toast.success('Organization settings initialized successfully');
    } catch (error) {
      console.error('Failed to initialize organization:', error);
      toast.error('Failed to initialize organization settings. Please try again.');
    } finally {
      setInitializing(false);
    }
  };

  // Logo upload handler (3-step Convex pattern)
  const handleLogoUpload = async (event: React.ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    if (!file || !organization?.id) return;

    setUploadingLogo(true);
    try {
      // Step 1: Get upload URL
      const uploadUrl = await generateUploadUrl();

      // Step 2: Upload file to Convex storage
      const result = await fetch(uploadUrl, {
        method: 'POST',
        headers: { 'Content-Type': file.type },
        body: file,
      });

      const { storageId } = await result.json();

      // Step 3: Save storageId to organization and wait for confirmation
      await updateOrgSettings({
        workosOrgId: organization.id,
        updates: { logoStorageId: storageId },
      });

      // Only show success after Convex confirms save
      toast.success('Logo uploaded successfully');
    } catch (error) {
      console.error('Logo upload failed:', error);
      toast.error('Failed to upload logo. Please try again.');
    } finally {
      setUploadingLogo(false);
    }
  };

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

  // Sync billing form with backend data
  useEffect(() => {
    if (orgSettings) {
      setBillingEmail(orgSettings.billingEmail || '');
      // Format phone number when loading from backend
      const phone = orgSettings.billingPhone || '';
      setBillingPhone(phone ? formatPhoneNumber(phone) : '');
      setAddressLine1(orgSettings.billingAddress?.addressLine1 || '');
      setAddressLine2(orgSettings.billingAddress?.addressLine2 || '');
      setCity(orgSettings.billingAddress?.city || '');
      setState(orgSettings.billingAddress?.state || '');
      setZip(orgSettings.billingAddress?.zip || '');
      setCountry(orgSettings.billingAddress?.country || 'USA');
      // Sync timezone
      setDefaultTimezone(orgSettings.defaultTimezone || 'America/New_York');
    }
  }, [orgSettings]);

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

  // Format phone number as user types: (123) 456-7890
  const formatPhoneNumber = (value: string): string => {
    // Remove all non-digit characters
    const digits = value.replace(/\D/g, '');
    
    // Limit to 10 digits
    const limitedDigits = digits.slice(0, 10);
    
    // Format based on length
    if (limitedDigits.length === 0) return '';
    if (limitedDigits.length <= 3) return `(${limitedDigits}`;
    if (limitedDigits.length <= 6) {
      return `(${limitedDigits.slice(0, 3)}) ${limitedDigits.slice(3)}`;
    }
    return `(${limitedDigits.slice(0, 3)}) ${limitedDigits.slice(3, 6)}-${limitedDigits.slice(6)}`;
  };

  // Handle phone input with formatting
  const handlePhoneChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const formatted = formatPhoneNumber(e.target.value);
    setBillingPhone(formatted);
  };

  // Handle address autocomplete selection
  const handleAddressSelect = (addressData: {
    address: string;
    city: string;
    state: string;
    postalCode: string;
    country: string;
  }) => {
    setAddressLine1(addressData.address);
    setCity(addressData.city);
    setState(addressData.state);
    setZip(addressData.postalCode);
    setCountry(addressData.country);
  };

  // Save billing information
  const handleSaveBilling = async () => {
    if (!organization?.id) return;

    setSavingBilling(true);
    try {
      // Strip formatting from phone number before saving (only digits)
      const phoneDigits = billingPhone.replace(/\D/g, '');

      // Wait for Convex mutation to complete
      await updateOrgSettings({
        workosOrgId: organization.id,
        updates: {
          billingEmail,
          billingPhone: phoneDigits,
          billingAddress: {
            addressLine1,
            addressLine2,
            city,
            state,
            zip,
            country,
          },
        },
      });

      // Only show success after Convex confirms save
      toast.success('Billing information saved successfully');
    } catch (error) {
      console.error('Failed to save billing info:', error);
      toast.error('Failed to save billing information. Please try again.');
    } finally {
      setSavingBilling(false);
    }
  };

  // Save timezone setting
  const handleSaveTimezone = async (newTimezone: string) => {
    if (!organization?.id) return;

    setSavingTimezone(true);
    setDefaultTimezone(newTimezone);
    try {
      await updateOrgSettings({
        workosOrgId: organization.id,
        updates: {
          defaultTimezone: newTimezone,
        },
      });
      toast.success('Timezone updated successfully');
    } catch (error) {
      console.error('Failed to save timezone:', error);
      toast.error('Failed to update timezone. Please try again.');
      // Revert on error
      setDefaultTimezone(orgSettings?.defaultTimezone || 'America/New_York');
    } finally {
      setSavingTimezone(false);
    }
  };

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
    <Tabs defaultValue="overview" className="w-full">
      <TabsList className="grid w-full md:w-[625px] grid-cols-5">
        <TabsTrigger value="overview" className="flex items-center gap-2">
          <Building2 className="h-4 w-4" />
          <span className="hidden sm:inline">Overview</span>
        </TabsTrigger>
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

      {/* Overview Tab */}
      <TabsContent value="overview" className="space-y-6 mt-6">
        {/* Show initialization button if no org settings exist */}
        {!orgSettings && organization && (
          <Card className="p-6 border-dashed">
            <div className="flex flex-col items-center justify-center py-8 text-center">
              <Building2 className="h-12 w-12 text-muted-foreground mb-4" />
              <h3 className="text-lg font-semibold mb-2">Initialize Organization Settings</h3>
              <p className="text-sm text-muted-foreground mb-4 max-w-md">
                Set up your organization profile with default settings. You can customize these later.
              </p>
              <Button onClick={handleInitializeOrg} disabled={initializing}>
                {initializing ? (
                  <>
                    <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                    Initializing...
                  </>
                ) : (
                  'Initialize Settings'
                )}
              </Button>
            </div>
          </Card>
        )}

        {/* Company Logo Card */}
        {orgSettings && (
          <>
          <Card className="p-6">
          <h2 className="text-xl font-semibold mb-4">Company Logo</h2>
          <div className="flex items-center gap-6">
            {/* Logo Preview */}
            <div className="h-24 w-24 rounded-lg border-2 border-dashed border-muted-foreground/25 flex items-center justify-center bg-muted/20 overflow-hidden">
              {orgSettings?.logoUrl ? (
                // eslint-disable-next-line @next/next/no-img-element
                <img src={orgSettings.logoUrl} alt="Company Logo" className="h-full w-full object-contain" />
              ) : (
                <Building2 className="h-10 w-10 text-muted-foreground/50" />
              )}
            </div>
            {/* Upload Button */}
            <div className="flex flex-col gap-2">
              <div className="relative">
                <Input
                  id="logo-upload"
                  type="file"
                  accept="image/*"
                  className="hidden"
                  onChange={handleLogoUpload}
                  disabled={uploadingLogo}
                />
                <Button
                  onClick={() => document.getElementById('logo-upload')?.click()}
                  disabled={uploadingLogo}
                  variant="outline"
                >
                  {uploadingLogo ? (
                    <>
                      <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                      Uploading...
                    </>
                  ) : (
                    <>
                      <Upload className="mr-2 h-4 w-4" />
                      Upload Logo
                    </>
                  )}
                </Button>
              </div>
              <p className="text-xs text-muted-foreground">PNG, JPG, SVG up to 2MB</p>
            </div>
          </div>
        </Card>

        <Card className="p-6">
          <h2 className="text-xl font-semibold mb-4">Organization Information</h2>
          <div className="grid gap-4">
            <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
              <div>
                <label className="text-sm font-medium text-muted-foreground">Organization Name</label>
                <p className="text-base font-medium mt-1">{organization?.name || 'Not available'}</p>
              </div>
              <div>
                <label className="text-sm font-medium text-muted-foreground">Industry</label>
                <p className="text-base font-medium mt-1">{orgSettings?.industry || 'Transportation & Logistics'}</p>
              </div>
            </div>
            <Separator />
            <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
              <div>
                <label className="text-sm font-medium text-muted-foreground">Organization ID</label>
                <p className="text-base font-mono text-sm mt-1">{organization?.id || 'Not available'}</p>
              </div>
              <div>
                <label className="text-sm font-medium text-muted-foreground">Created</label>
                <p className="text-base font-medium mt-1">
                  {organization?.createdAt
                    ? new Date(organization.createdAt).toLocaleDateString('en-US', {
                        year: 'numeric',
                        month: 'long',
                        day: 'numeric',
                      })
                    : 'Not available'}
                </p>
              </div>
            </div>
            <Separator />
            <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
              <div>
                <label className="text-sm font-medium text-muted-foreground">Domains</label>
                <p className="text-base font-medium mt-1">
                  {organization?.domains && organization.domains.length > 0
                    ? organization.domains.map((d) => d.domain).join(', ')
                    : '123 Fleet Street, New York, NY 10001'}
                </p>
              </div>
              <div className="grid gap-2">
                <Label htmlFor="defaultTimezone" className="flex items-center gap-1.5 text-sm font-medium text-muted-foreground">
                  <Globe className="h-3.5 w-3.5" />
                  Default Timezone
                </Label>
                <Select
                  value={defaultTimezone}
                  onValueChange={handleSaveTimezone}
                  disabled={savingTimezone}
                >
                  <SelectTrigger id="defaultTimezone" className="w-full">
                    <SelectValue placeholder="Select timezone..." />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="America/New_York">Eastern Time (ET)</SelectItem>
                    <SelectItem value="America/Chicago">Central Time (CT)</SelectItem>
                    <SelectItem value="America/Denver">Mountain Time (MT)</SelectItem>
                    <SelectItem value="America/Los_Angeles">Pacific Time (PT)</SelectItem>
                    <SelectItem value="America/Phoenix">Arizona (AZ)</SelectItem>
                    <SelectItem value="America/Anchorage">Alaska (AK)</SelectItem>
                    <SelectItem value="Pacific/Honolulu">Hawaii (HI)</SelectItem>
                  </SelectContent>
                </Select>
                <p className="text-xs text-muted-foreground">
                  Used as default for Pay Plans and payroll calculations
                </p>
              </div>
            </div>
          </div>
        </Card>

        <Card className="p-6">
          <div className="flex items-center justify-between mb-4">
            <h2 className="text-xl font-semibold">Billing Information</h2>
            <Button onClick={handleSaveBilling} disabled={savingBilling}>
              {savingBilling ? (
                <>
                  <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                  Saving...
                </>
              ) : (
                'Save Billing Info'
              )}
            </Button>
          </div>
          <div className="grid gap-6">
            {/* Contact Information */}
            <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
              <div className="grid gap-2">
                <Label htmlFor="billingEmail">Billing Email *</Label>
                <Input
                  id="billingEmail"
                  type="email"
                  value={billingEmail}
                  onChange={(e) => setBillingEmail(e.target.value)}
                  placeholder="billing@company.com"
                />
              </div>
              <div className="grid gap-2">
                <Label htmlFor="billingPhone">Billing Phone</Label>
                <Input
                  id="billingPhone"
                  type="tel"
                  value={billingPhone}
                  onChange={handlePhoneChange}
                  placeholder="(555) 123-4567"
                  maxLength={14}
                />
              </div>
            </div>

            <Separator />

            {/* Address */}
            <div className="grid gap-4">
              <div className="grid gap-2">
                <Label htmlFor="addressLine1">Address Line 1 *</Label>
                <AddressAutocomplete
                  value={addressLine1}
                  onSelect={handleAddressSelect}
                  onChange={(value) => setAddressLine1(value)}
                  placeholder="Start typing an address or enter manually..."
                />
              </div>
              <div className="grid gap-2">
                <Label htmlFor="addressLine2">Address Line 2</Label>
                <Input
                  id="addressLine2"
                  value={addressLine2}
                  onChange={(e) => setAddressLine2(e.target.value)}
                  placeholder="Suite 100"
                />
              </div>
              <div className="grid grid-cols-1 md:grid-cols-4 gap-4">
                <div className="md:col-span-2 grid gap-2">
                  <Label htmlFor="city">City *</Label>
                  <Input
                    id="city"
                    value={city}
                    onChange={(e) => setCity(e.target.value)}
                    placeholder="New York"
                  />
                </div>
                <div className="grid gap-2">
                  <Label htmlFor="state">State *</Label>
                  <Input
                    id="state"
                    value={state}
                    onChange={(e) => setState(e.target.value)}
                    placeholder="NY"
                  />
                </div>
                <div className="grid gap-2">
                  <Label htmlFor="zip">ZIP *</Label>
                  <Input
                    id="zip"
                    value={zip}
                    onChange={(e) => setZip(e.target.value)}
                    placeholder="10001"
                  />
                </div>
              </div>
              <div className="grid gap-2">
                <Label htmlFor="country">Country *</Label>
                <Input
                  id="country"
                  value={country}
                  onChange={(e) => setCountry(e.target.value)}
                  placeholder="USA"
                />
              </div>
            </div>
          </div>
        </Card>

        <Card className="p-6">
          <h2 className="text-xl font-semibold mb-4">Subscription</h2>
          <div className="grid gap-4">
            <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
              <div>
                <label className="text-sm font-medium text-muted-foreground">Plan</label>
                <p className="text-base font-medium mt-1">{orgSettings?.subscriptionPlan || 'Enterprise'}</p>
              </div>
              <div>
                <label className="text-sm font-medium text-muted-foreground">Billing Cycle</label>
                <p className="text-base font-medium mt-1">{orgSettings?.billingCycle || 'Annual'}</p>
              </div>
            </div>
            <Separator />
            <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
              <div>
                <label className="text-sm font-medium text-muted-foreground">Status</label>
                <p className="text-base font-medium mt-1">
                  <span
                    className={`inline-flex items-center rounded-full px-2.5 py-0.5 text-xs font-medium ${
                      orgSettings?.subscriptionStatus === 'Active'
                        ? 'bg-green-100 text-green-800'
                        : 'bg-gray-100 text-gray-800'
                    }`}
                  >
                    {orgSettings?.subscriptionStatus || 'Active'}
                  </span>
                </p>
              </div>
              <div>
                <label className="text-sm font-medium text-muted-foreground">Next Billing Date</label>
                <p className="text-base font-medium mt-1">
                  {orgSettings?.nextBillingDate
                    ? new Date(orgSettings.nextBillingDate).toLocaleDateString('en-US', {
                        year: 'numeric',
                        month: 'long',
                        day: 'numeric',
                      })
                    : 'January 15, 2025'}
                </p>
              </div>
            </div>
          </div>
        </Card>
          </>
        )}
      </TabsContent>

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
