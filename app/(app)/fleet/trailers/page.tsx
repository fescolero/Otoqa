'use client';

import * as React from 'react';
import { useAuth } from '@workos-inc/authkit-nextjs/components';
import { useMutation, useQuery } from 'convex/react';
import { useRouter } from 'next/navigation';
import { api } from '@/convex/_generated/api';
import type { Id } from '@/convex/_generated/dataModel';
import { useOrganizationId } from '@/contexts/organization-context';
import { runChunkedBulk } from '@/lib/chunked-bulk';
import { TrailersList, type TrailerRow } from '@/components/web/trailers/trailers-list';

export default function TrailersPage() {
  const { user } = useAuth();
  const router = useRouter();
  const organizationId = useOrganizationId();

  const trailers = useQuery(
    api.trailers.list,
    organizationId ? { organizationId, includeDeleted: true } : 'skip',
  );
  const bulkDeactivate = useMutation(api.trailers.bulkDeactivate);

  const handleBulkDeactivate = async (trailerIds: string[]) => {
    if (!user) return;
    const userName =
      user.firstName && user.lastName ? `${user.firstName} ${user.lastName}` : user.email;
    try {
      await runChunkedBulk(
        trailerIds as Id<'trailers'>[],
        async (chunk) => {
          await bulkDeactivate({ ids: chunk, userId: user.id, userName });
        },
      );
    } catch (error) {
      console.error('Failed to deactivate trailers:', error);
      alert('Failed to deactivate some trailers. Please try again.');
    }
  };

  return (
    <>
      <TrailersList
        trailers={(trailers ?? []) as TrailerRow[]}
        loading={trailers === undefined}
        onCreate={() => router.push('/fleet/trailers/create')}
        onImport={() => console.log('CSV import for trailers: not implemented yet')}
        onExport={() => console.log('CSV export for trailers: not implemented yet')}
        onBulkDeactivate={handleBulkDeactivate}
      />
    </>
  );
}
