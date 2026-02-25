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
import { useQuery, useMutation, useConvexAuth } from 'convex/react';
import { api } from '@/convex/_generated/api';
import { DriverList } from '@/components/drivers/driver-list';
import { CSVImportWizard } from '@/components/drivers/csv-import-wizard';
import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { useOrganizationId } from '@/contexts/organization-context';
import { Button } from '@/components/ui/button';
import { Download, Upload, Plus } from 'lucide-react';

export default function DriversPage() {
  const { user } = useAuth();
  const { isAuthenticated } = useConvexAuth();
  const router = useRouter();
  const organizationId = useOrganizationId();
  const [showImportWizard, setShowImportWizard] = useState(false);

  // Query drivers from Convex (include deleted for the deleted tab)
  const drivers = useQuery(
    api.drivers.list,
    isAuthenticated ? { organizationId, includeDeleted: true } : 'skip',
  );
  const deactivateDriver = useMutation(api.drivers.deactivate);

  const handleCreateDriver = () => {
    router.push('/fleet/drivers/create');
  };

  const handleExportCSV = () => {
    // TODO: Implement CSV export
    console.log('Export CSV clicked');
  };

  const handleImportCSV = () => {
    setShowImportWizard(true);
  };

  const handleImportComplete = () => {
    // Refresh the drivers list after import
    window.location.reload();
  };

  const handleBulkDeactivate = async (driverIds: string[]) => {
    if (!user) return;

    const userName = user.firstName && user.lastName ? `${user.firstName} ${user.lastName}` : user.email;

    try {
      // Deactivate all selected drivers
      await Promise.all(
        driverIds.map((id) =>
          deactivateDriver({
            id: id as any,
            userId: user.id,
            userName,
          }),
        ),
      );
      alert(`Successfully deactivated ${driverIds.length} driver(s)`);
    } catch (error) {
      console.error('Failed to deactivate drivers:', error);
      alert('Failed to deactivate some drivers. Please try again.');
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
                <BreadcrumbItem className="hidden md:block">
                  <BreadcrumbLink href="#">Fleet Management</BreadcrumbLink>
                </BreadcrumbItem>
                <BreadcrumbSeparator className="hidden md:block" />
                <BreadcrumbItem>
                  <BreadcrumbPage>Drivers</BreadcrumbPage>
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
                <h1 className="text-2xl font-bold tracking-tight">Drivers</h1>
                <p className="text-sm text-muted-foreground">Manage your fleet drivers and their information</p>
              </div>
              <div className="flex items-center gap-2">
                <Button variant="outline" size="sm" onClick={handleExportCSV}>
                  <Download className="mr-2 h-4 w-4" />
                  Export CSV
                </Button>
                <Button variant="outline" size="sm" onClick={handleImportCSV}>
                  <Upload className="mr-2 h-4 w-4" />
                  Import CSV
                </Button>
                <Button size="sm" onClick={handleCreateDriver}>
                  <Plus className="mr-2 h-4 w-4" />
                  Create Driver
                </Button>
              </div>
            </div>

            {/* Driver List */}
            {drivers !== undefined && organizationId ? (
              <DriverList
                data={drivers}
                organizationId={organizationId}
                onDeactivateDrivers={handleBulkDeactivate}
              />
            ) : (
              <div className="flex items-center justify-center h-64">
                <p className="text-muted-foreground">Loading drivers...</p>
              </div>
            )}
          </div>
        </div>

        {/* CSV Import Wizard */}
        <CSVImportWizard
          open={showImportWizard}
          onOpenChange={setShowImportWizard}
          onImportComplete={handleImportComplete}
        />
    </>
  );
}
