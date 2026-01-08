'use client';

import {
  Breadcrumb,
  BreadcrumbItem,
  BreadcrumbLink,
  BreadcrumbList,
  BreadcrumbPage,
  BreadcrumbSeparator,
} from '@/components/ui/breadcrumb';
import { Card } from '@/components/ui/card';
import { Label } from '@/components/ui/label';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Separator } from '@/components/ui/separator';
import { SidebarTrigger } from '@/components/ui/sidebar';
import { useAuth } from '@workos-inc/authkit-nextjs/components';
import { Globe, Palette, Ruler, Clock } from 'lucide-react';
import { WidgetsProvider } from '@/components/widgets-provider';
import { WorkOsWidgets, UserProfile } from '@workos-inc/widgets';
import { useEffect, useState } from 'react';
import { useQuery, useMutation } from 'convex/react';
import { api } from '@/convex/_generated/api';
import { toast } from 'sonner';

export default function AccountPage() {
  const { user } = useAuth();
  const [widgetToken, setWidgetToken] = useState<string | null>(null);
  const [workosOrgId, setWorkosOrgId] = useState<string | null>(null);

  // Local state for preferences (for optimistic updates)
  const [language, setLanguage] = useState('English');
  const [unitSystem, setUnitSystem] = useState<'Imperial' | 'Metric'>('Imperial');
  const [theme, setTheme] = useState<'light' | 'dark' | 'system'>('system');
  const [timezone, setTimezone] = useState('America/New_York');

  // Fetch user preferences from backend
  const preferences = useQuery(
    api.settings.getUserPreferences,
    workosOrgId ? { workosOrgId } : 'skip',
  );

  // Mutation to update preferences
  const updatePreferences = useMutation(api.settings.updateUserPreferences);

  // Fetch widget token and organization ID
  useEffect(() => {
    async function fetchData() {
      try {
        const response = await fetch('/api/widgets/token');
        const data = await response.json();
        setWidgetToken(data.token);

        // Fetch organization ID from WorkOS
        if (user?.id) {
          const orgResponse = await fetch(`/api/organization`);
          const orgData = await orgResponse.json();
          if (orgData.organizationId) {
            setWorkosOrgId(orgData.organizationId);
          }
        }
      } catch (error) {
        console.error('Failed to fetch data:', error);
      }
    }
    fetchData();
  }, [user]);

  // Sync preferences from backend when loaded, or initialize defaults
  useEffect(() => {
    if (preferences) {
      // Load existing preferences
      setLanguage(preferences.language);
      setUnitSystem(preferences.unitSystem);
      setTheme(preferences.theme);
      setTimezone(preferences.timezone);
    } else if (preferences === null && workosOrgId) {
      // No preferences exist yet - keep defaults
      // They will be created on first change
    }
  }, [preferences, workosOrgId]);

  // Handler to save preferences
  const handleSavePreferences = async (
    field: 'language' | 'unitSystem' | 'theme' | 'timezone',
    value: string,
  ) => {
    if (!workosOrgId) return;

    try {
      await updatePreferences({
        workosOrgId,
        language,
        unitSystem,
        theme,
        timezone,
        // Override the changed field
        [field]: value,
      });
      toast.success('Preferences saved successfully');
    } catch (error) {
      console.error('Failed to save preferences:', error);
      toast.error('Failed to save preferences');
    }
  };

  return (
    <>
        <header className="flex h-16 shrink-0 items-center gap-2 transition-[width,height] ease-linear group-has-data-[collapsible=icon]/sidebar-wrapper:h-12 border-b">
          <div className="flex items-center gap-2 px-4">
            <SidebarTrigger className="-ml-1" />
            <Separator orientation="vertical" className="mr-2 data-[orientation=vertical]:h-4" />
            <Breadcrumb>
              <BreadcrumbList>
                <BreadcrumbItem className="hidden md:block">
                  <BreadcrumbLink href="/dashboard">Dashboard</BreadcrumbLink>
                </BreadcrumbItem>
                <BreadcrumbSeparator className="hidden md:block" />
                <BreadcrumbItem>
                  <BreadcrumbPage>Account</BreadcrumbPage>
                </BreadcrumbItem>
              </BreadcrumbList>
            </Breadcrumb>
          </div>
        </header>

        <div className="flex flex-1 flex-col gap-6 p-6">
          {/* Page Header */}
          <div>
            <h1 className="text-3xl font-bold tracking-tight">Account Settings</h1>
            <p className="text-muted-foreground">Manage your account information and preferences</p>
          </div>

          {/* User Profile Section - WorkOS Widget */}
          <Card className="p-6">
            <h2 className="text-xl font-semibold mb-2">Profile Information</h2>
            {widgetToken ? (
              <div className="workos-userprofile-container">
                <WidgetsProvider>
                  <WorkOsWidgets>
                    <UserProfile authToken={widgetToken} />
                  </WorkOsWidgets>
                </WidgetsProvider>
              </div>
            ) : (
              <div className="flex items-center justify-center py-8">
                <p className="text-muted-foreground">Loading profile...</p>
              </div>
            )}
          </Card>

          {/* Preferences Section */}
          <Card className="p-6">
            <div className="flex items-center justify-between mb-6">
              <div>
                <h2 className="text-xl font-semibold">Preferences</h2>
                <p className="text-sm text-muted-foreground mt-1">
                  Changes are saved automatically
                </p>
              </div>
            </div>
            <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-6">
              {/* Preferred Language */}
              <div className="grid gap-2">
                <Label htmlFor="language" className="flex items-center gap-2">
                  <Globe className="h-4 w-4" />
                  Preferred Language
                </Label>
                <Select
                  value={language}
                  onValueChange={(value) => {
                    setLanguage(value);
                    handleSavePreferences('language', value);
                  }}
                >
                  <SelectTrigger id="language" className="w-full">
                    <SelectValue placeholder="Select language" />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="English">English</SelectItem>
                    <SelectItem value="Spanish">Spanish</SelectItem>
                    <SelectItem value="French">French</SelectItem>
                    <SelectItem value="German">German</SelectItem>
                    <SelectItem value="Portuguese">Portuguese</SelectItem>
                  </SelectContent>
                </Select>
              </div>

              {/* Unit System */}
              <div className="grid gap-2">
                <Label htmlFor="units" className="flex items-center gap-2">
                  <Ruler className="h-4 w-4" />
                  Unit System
                </Label>
                <Select
                  value={unitSystem}
                  onValueChange={(value) => {
                    const newValue = value as 'Imperial' | 'Metric';
                    setUnitSystem(newValue);
                    handleSavePreferences('unitSystem', newValue);
                  }}
                >
                  <SelectTrigger id="units" className="w-full">
                    <SelectValue placeholder="Select unit system" />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="Imperial">Imperial (miles, gallons, lbs)</SelectItem>
                    <SelectItem value="Metric">Metric (km, liters, kg)</SelectItem>
                  </SelectContent>
                </Select>
              </div>

              {/* Theme */}
              <div className="grid gap-2">
                <Label htmlFor="theme" className="flex items-center gap-2">
                  <Palette className="h-4 w-4" />
                  Theme
                </Label>
                <Select
                  value={theme}
                  onValueChange={(value) => {
                    const newValue = value as 'light' | 'dark' | 'system';
                    setTheme(newValue);
                    handleSavePreferences('theme', newValue);
                  }}
                >
                  <SelectTrigger id="theme" className="w-full">
                    <SelectValue placeholder="Select theme" />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="light">Light</SelectItem>
                    <SelectItem value="dark">Dark</SelectItem>
                    <SelectItem value="system">System</SelectItem>
                  </SelectContent>
                </Select>
              </div>

              {/* Timezone */}
              <div className="grid gap-2">
                <Label htmlFor="timezone" className="flex items-center gap-2">
                  <Clock className="h-4 w-4" />
                  Timezone
                </Label>
                <Select
                  value={timezone}
                  onValueChange={(value) => {
                    setTimezone(value);
                    handleSavePreferences('timezone', value);
                  }}
                >
                  <SelectTrigger id="timezone" className="w-full">
                    <SelectValue placeholder="Select timezone" />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="America/New_York">Eastern Time (ET)</SelectItem>
                    <SelectItem value="America/Chicago">Central Time (CT)</SelectItem>
                    <SelectItem value="America/Denver">Mountain Time (MT)</SelectItem>
                    <SelectItem value="America/Los_Angeles">Pacific Time (PT)</SelectItem>
                    <SelectItem value="UTC">UTC</SelectItem>
                  </SelectContent>
                </Select>
              </div>
            </div>
          </Card>
        </div>
    </>
  );
}
