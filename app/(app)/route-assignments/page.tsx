'use client';

import {
  Breadcrumb,
  BreadcrumbItem,
  BreadcrumbLink,
  BreadcrumbList,
  BreadcrumbPage,
  BreadcrumbSeparator,
} from '@/components/ui/breadcrumb';
import { Separator } from '@/components/ui/separator';
import { SidebarTrigger } from '@/components/ui/sidebar';
import { useAuth } from '@workos-inc/authkit-nextjs/components';
import { useQuery } from 'convex/react';
import { api } from '@/convex/_generated/api';
import { useState, useMemo } from 'react';
import { useOrganizationId } from '@/contexts/organization-context';
import { Button } from '@/components/ui/button';
import { Plus, Search, RefreshCw } from 'lucide-react';
import { Input } from '@/components/ui/input';
import { RouteAssignmentsTable, CombinedAssignment } from '@/components/route-assignments/route-assignments-table';
import { CreateRouteAssignmentModal } from '@/components/route-assignments/create-route-assignment-modal';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';

export default function RouteAssignmentsPage() {
  const { user } = useAuth();
  const organizationId = useOrganizationId();
  const [showCreateModal, setShowCreateModal] = useState(false);
  const [searchQuery, setSearchQuery] = useState('');
  const [activeTab, setActiveTab] = useState('active');
  const [typeFilter, setTypeFilter] = useState<'all' | 'external' | 'internal'>('all');

  // Query route assignments (External - FourKites auto-assignment rules)
  const routeAssignments = useQuery(
    api.routeAssignments.list,
    organizationId
      ? {
          workosOrgId: organizationId,
          isActive: activeTab === 'active' ? true : activeTab === 'inactive' ? false : undefined,
          search: searchQuery || undefined,
        }
      : 'skip'
  );

  // Query recurring templates (Internal - manually created recurring loads)
  const recurringTemplates = useQuery(
    api.recurringLoads.list,
    organizationId
      ? {
          workosOrgId: organizationId,
          isActive: activeTab === 'active' ? true : activeTab === 'inactive' ? false : undefined,
        }
      : 'skip'
  );

  // Query auto-assignment settings
  const settings = useQuery(
    api.routeAssignments.getSettings,
    organizationId ? { workosOrgId: organizationId } : 'skip'
  );

  // Combine both data sources into a unified list
  const combinedData = useMemo((): CombinedAssignment[] => {
    const items: CombinedAssignment[] = [];

    // Add external route assignments
    if (routeAssignments) {
      routeAssignments.forEach((assignment) => {
        items.push({
          id: assignment._id,
          type: 'external',
          name: assignment.name || `${assignment.hcr} - ${assignment.tripNumber || 'All'}`,
          hcr: assignment.hcr,
          tripNumber: assignment.tripNumber,
          driverName: assignment.driverName,
          carrierName: assignment.carrierName,
          isActive: assignment.isActive,
          createdAt: assignment.createdAt,
          // Route assignment specific
          routeAssignmentData: assignment,
        });
      });
    }

    // Add internal recurring templates
    if (recurringTemplates) {
      recurringTemplates.forEach((template) => {
        // Apply search filter for templates
        if (searchQuery) {
          const searchLower = searchQuery.toLowerCase();
          const matches =
            template.name.toLowerCase().includes(searchLower) ||
            (template.hcr?.toLowerCase().includes(searchLower)) ||
            (template.tripNumber?.toLowerCase().includes(searchLower));
          if (!matches) return;
        }

        items.push({
          id: template._id,
          type: 'internal',
          name: template.name,
          hcr: template.hcr,
          tripNumber: template.tripNumber,
          driverName: template.driverName,
          carrierName: template.carrierName,
          isActive: template.isActive,
          createdAt: template._creationTime,
          // Recurring template specific
          recurringTemplateData: template,
          schedule: template.activeDays,
          lastGenerated: template.lastGeneratedAt,
        });
      });
    }

    // Sort by creation time descending
    items.sort((a, b) => b.createdAt - a.createdAt);

    return items;
  }, [routeAssignments, recurringTemplates, searchQuery]);

  // Filter by type
  const filteredData = useMemo(() => {
    if (typeFilter === 'all') return combinedData;
    return combinedData.filter((item) => item.type === typeFilter);
  }, [combinedData, typeFilter]);

  // Apply active/inactive filter
  const displayData = useMemo(() => {
    if (activeTab === 'all') return filteredData;
    return filteredData.filter((item) =>
      activeTab === 'active' ? item.isActive : !item.isActive
    );
  }, [filteredData, activeTab]);

  // Counts
  const totalCount = filteredData.length;
  const activeCount = filteredData.filter((a) => a.isActive).length;
  const inactiveCount = filteredData.filter((a) => !a.isActive).length;
  const externalCount = combinedData.filter((a) => a.type === 'external').length;
  const internalCount = combinedData.filter((a) => a.type === 'internal').length;

  const isLoading = routeAssignments === undefined || recurringTemplates === undefined;

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
                <BreadcrumbPage>Route Assignments</BreadcrumbPage>
              </BreadcrumbItem>
            </BreadcrumbList>
          </Breadcrumb>
        </div>
      </header>

      <div className="flex-1 overflow-hidden">
        <div className="h-full flex flex-col p-6">
          {/* Page Header */}
          <div className="flex-shrink-0 flex items-center justify-between mb-4">
            <div>
              <h1 className="text-2xl font-bold tracking-tight">Route Assignments</h1>
              <p className="text-sm text-muted-foreground">
                Manage auto-assignment rules and recurring load schedules
              </p>
            </div>
            <div className="flex items-center gap-2">
              {/* Auto-Assignment Status */}
              {settings && (
                <div className="flex items-center gap-2 mr-4">
                  <div
                    className={`h-2 w-2 rounded-full ${settings.enabled ? 'bg-green-500' : 'bg-gray-300'}`}
                  />
                  <span className="text-sm text-muted-foreground">
                    Auto-Assignment: {settings.enabled ? 'Enabled' : 'Disabled'}
                  </span>
                </div>
              )}
              <Button size="sm" onClick={() => setShowCreateModal(true)}>
                <Plus className="mr-2 h-4 w-4" />
                Create Assignment
              </Button>
            </div>
          </div>

          {/* Search and Type Filters */}
          <div className="flex items-center gap-4 mb-4">
            <div className="relative flex-1 max-w-md">
              <Search className="absolute left-3 top-1/2 transform -translate-y-1/2 h-4 w-4 text-muted-foreground" />
              <Input
                placeholder="Search by HCR, Trip, or Name..."
                value={searchQuery}
                onChange={(e) => setSearchQuery(e.target.value)}
                className="pl-10"
              />
            </div>
            <div className="flex items-center gap-2">
              <span className="text-sm text-muted-foreground">Type:</span>
              <Tabs value={typeFilter} onValueChange={(v) => setTypeFilter(v as 'all' | 'external' | 'internal')}>
                <TabsList className="h-9">
                  <TabsTrigger value="all" className="text-xs px-3">
                    All ({combinedData.length})
                  </TabsTrigger>
                  <TabsTrigger value="external" className="text-xs px-3">
                    External ({externalCount})
                  </TabsTrigger>
                  <TabsTrigger value="internal" className="text-xs px-3">
                    Internal ({internalCount})
                  </TabsTrigger>
                </TabsList>
              </Tabs>
            </div>
          </div>

          {/* Status Tabs */}
          <Tabs value={activeTab} onValueChange={setActiveTab} className="flex-1 flex flex-col">
            <TabsList className="w-fit">
              <TabsTrigger value="all">All ({totalCount})</TabsTrigger>
              <TabsTrigger value="active">Active ({activeCount})</TabsTrigger>
              <TabsTrigger value="inactive">Inactive ({inactiveCount})</TabsTrigger>
            </TabsList>

            <TabsContent value={activeTab} className="flex-1 mt-4">
              {!isLoading && organizationId ? (
                <RouteAssignmentsTable
                  data={displayData}
                  organizationId={organizationId}
                />
              ) : (
                <div className="flex items-center justify-center h-64">
                  <RefreshCw className="mr-2 h-4 w-4 animate-spin" />
                  <p className="text-muted-foreground">Loading assignments...</p>
                </div>
              )}
            </TabsContent>
          </Tabs>
        </div>
      </div>

      {/* Create Modal */}
      {organizationId && user && (
        <CreateRouteAssignmentModal
          open={showCreateModal}
          onOpenChange={setShowCreateModal}
          organizationId={organizationId}
          userId={user.id}
        />
      )}
    </>
  );
}
