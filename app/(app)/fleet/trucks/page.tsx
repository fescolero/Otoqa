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
import { Button } from '@/components/ui/button';
import { Plus, Download, Upload } from 'lucide-react';
import { useAuth } from '@workos-inc/authkit-nextjs/components';
import { useMutation } from 'convex/react';
import { useAuthQuery } from '@/hooks/use-auth-query';
import { api } from '@/convex/_generated/api';
import { TruckList } from '@/components/trucks/truck-list';
import { useRouter } from 'next/navigation';
import { useOrganizationId } from '@/contexts/organization-context';

export default function TrucksPage() {
  const { user } = useAuth();
  const router = useRouter();
  const organizationId = useOrganizationId();

  // Query trucks from Convex
  const trucks = useAuthQuery(api.trucks.list, { organizationId });
  const bulkDeactivateTrucks = useMutation(api.trucks.bulkDeactivate);

  // Get user initials for avatar fallback
  const getUserInitials = (name?: string, email?: string) => {
    if (name) {
      const names = name.split(' ');
      if (names.length >= 2) {
        return `${names[0][0]}${names[1][0]}`.toUpperCase();
      }
      return name.slice(0, 2).toUpperCase();
    }
    if (email) {
      return email.slice(0, 2).toUpperCase();
    }
    return 'U';
  };

  const userData = user
    ? {
        name: user.firstName && user.lastName ? `${user.firstName} ${user.lastName}` : user.email,
        email: user.email,
        avatar: user.profilePictureUrl || '',
        initials: getUserInitials(
          user.firstName && user.lastName ? `${user.firstName} ${user.lastName}` : undefined,
          user.email,
        ),
      }
    : {
        name: 'Guest',
        email: 'guest@example.com',
        avatar: '',
        initials: 'GU',
      };

  const handleCreateTruck = () => {
    router.push('/fleet/trucks/create');
  };

  const handleExportCSV = () => {
    // TODO: Implement CSV export
    console.log('Export CSV clicked');
  };

  const handleImportCSV = () => {
    // TODO: Implement CSV import wizard (similar to drivers)
    console.log('Import CSV clicked');
  };

  const handleBulkDeactivate = async (truckIds: string[]) => {
    if (!user) return;

    const userName = user.firstName && user.lastName ? `${user.firstName} ${user.lastName}` : user.email;

    try {
      await bulkDeactivateTrucks({
        ids: truckIds as any,
        userId: user.id,
        userName,
      });
      alert(`Successfully deactivated ${truckIds.length} truck(s)`);
    } catch (error) {
      console.error('Failed to deactivate trucks:', error);
      alert('Failed to deactivate some trucks. Please try again.');
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
                  <BreadcrumbPage>Trucks</BreadcrumbPage>
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
                <h1 className="text-2xl font-bold tracking-tight">Trucks</h1>
                <p className="text-sm text-muted-foreground">Manage your fleet trucks and equipment</p>
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
                <Button size="sm" onClick={handleCreateTruck}>
                  <Plus className="mr-2 h-4 w-4" />
                  Create Truck
                </Button>
              </div>
            </div>

            {/* Truck List */}
            {trucks !== undefined ? (
              <TruckList
                data={trucks}
                organizationId={organizationId}
                onDeactivateTrucks={handleBulkDeactivate}
              />
            ) : (
              <div className="flex items-center justify-center h-64">
                <p className="text-muted-foreground">Loading trucks...</p>
              </div>
            )}
          </div>
        </div>
      </>
  );
}
