'use client';

import * as React from 'react';
import { useAuth } from '@workos-inc/authkit-nextjs/components';
import { useConvexAuth, useMutation, useQuery } from 'convex/react';
import { useRouter } from 'next/navigation';
import { api } from '@/convex/_generated/api';
import type { Id } from '@/convex/_generated/dataModel';
import { useOrganizationId } from '@/contexts/organization-context';
import { CSVImportWizard } from '@/components/drivers/csv-import-wizard';
import { DriversList } from '@/components/web/drivers/drivers-list';
import type { DriverRow } from '@/components/web/drivers/build-driver-details';

export default function DriversPage() {
  const { user } = useAuth();
  const { isAuthenticated } = useConvexAuth();
  const router = useRouter();
  const organizationId = useOrganizationId();
  const [showImportWizard, setShowImportWizard] = React.useState(false);

  const drivers = useQuery(
    api.drivers.list,
    isAuthenticated ? { organizationId, includeDeleted: true } : 'skip',
  );
  const deactivateDriver = useMutation(api.drivers.deactivate);

  const handleBulkDeactivate = async (driverIds: string[]) => {
    if (!user) return;
    const userName =
      user.firstName && user.lastName ? `${user.firstName} ${user.lastName}` : user.email;
    try {
      await Promise.all(
        driverIds.map((id) =>
          deactivateDriver({ id: id as Id<'drivers'>, userId: user.id, userName }),
        ),
      );
    } catch (error) {
      console.error('Failed to deactivate drivers:', error);
      alert('Failed to deactivate some drivers. Please try again.');
    }
  };

  return (
    <>
      <DriversList
        drivers={(drivers ?? []) as DriverRow[]}
        loading={drivers === undefined}
        onCreate={() => router.push('/fleet/drivers/create')}
        onImport={() => setShowImportWizard(true)}
        onExport={() => console.log('Export CSV: not implemented yet')}
        onBulkDeactivate={handleBulkDeactivate}
      />
      <CSVImportWizard
        open={showImportWizard}
        onOpenChange={setShowImportWizard}
        onImportComplete={() => window.location.reload()}
      />
    </>
  );
}
