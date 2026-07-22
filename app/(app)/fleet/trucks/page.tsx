'use client';

import * as React from 'react';
import { useAuth } from '@workos-inc/authkit-nextjs/components';
import { useMutation, useQuery } from 'convex/react';
import { useRouter } from 'next/navigation';
import { api } from '@/convex/_generated/api';
import type { Id } from '@/convex/_generated/dataModel';
import { useOrganizationId } from '@/contexts/organization-context';
import { runChunkedBulk } from '@/lib/chunked-bulk';
import { TrucksList, type TruckRow } from '@/components/web/trucks/trucks-list';

export default function TrucksPage() {
  const { user } = useAuth();
  const router = useRouter();
  const organizationId = useOrganizationId();

  const trucks = useQuery(
    api.trucks.list,
    organizationId ? { organizationId, includeDeleted: true } : 'skip',
  );
  const bulkDeactivate = useMutation(api.trucks.bulkDeactivate);

  const handleBulkDeactivate = async (truckIds: string[]) => {
    if (!user) return;
    const userName =
      user.firstName && user.lastName ? `${user.firstName} ${user.lastName}` : user.email;
    try {
      await runChunkedBulk(
        truckIds as Id<'trucks'>[],
        async (chunk) => {
          await bulkDeactivate({ ids: chunk, userId: user.id, userName });
        },
      );
    } catch (error) {
      console.error('Failed to deactivate trucks:', error);
      alert('Failed to deactivate some trucks. Please try again.');
    }
  };

  return (
    <>
      <TrucksList
        trucks={(trucks ?? []) as TruckRow[]}
        loading={trucks === undefined}
        onCreate={() => router.push('/fleet/trucks/create')}
        onImport={() => console.log('CSV import for trucks: not implemented yet')}
        onExport={() => console.log('CSV export for trucks: not implemented yet')}
        onBulkDeactivate={handleBulkDeactivate}
      />
    </>
  );
}
