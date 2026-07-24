'use client';

/**
 * Contract-lane create page.
 *
 * Thin wrapper around `<CreateForm>` + the contract-lane schema
 * (design's CONTRACT_SCHEMA). Replaces the legacy hand-rolled form.
 * The customer's facility registry feeds the per-stop facility
 * binding dropdown.
 */

import * as React from 'react';
import { useRouter, useParams } from 'next/navigation';
import { useAuth } from '@workos-inc/authkit-nextjs/components';
import { useMutation } from 'convex/react';
import { toast } from 'sonner';
import { api } from '@/convex/_generated/api';
import type { Id } from '@/convex/_generated/dataModel';
import { useOrganizationId } from '@/contexts/organization-context';
import { useAuthQuery } from '@/hooks/use-auth-query';
import { CreateForm } from '@/components/web/create-form';
import {
  buildContractLaneSchema,
  mapValsToContractLaneArgs,
  mapFacilitiesToOptions,
} from '@/lib/forms/schemas/contract-lane';

export default function CreateContractLanePage() {
  const router = useRouter();
  const params = useParams();
  const customerId = params.id as Id<'customers'>;
  const { user } = useAuth();
  const workosOrgId = useOrganizationId();
  const createContractLane = useMutation(api.contractLanes.create);

  const facilitiesQ = useAuthQuery(
    api.facilities.listByCustomer,
    customerId ? { customerId } : 'skip',
  );

  const schema = React.useMemo(
    () =>
      buildContractLaneSchema({
        mode: 'create',
        facilities: mapFacilitiesToOptions(facilitiesQ ?? []),
      }),
    [facilitiesQ],
  );

  const customerPath = `/operations/customers/${customerId}`;

  return (
    <CreateForm
      schema={schema}
      onCancel={() => router.push(customerPath)}
      onSaved={async (vals, andNew) => {
        if (!workosOrgId || !user) {
          toast.error('Not signed in — please refresh and try again.');
          return;
        }
        try {
          const args = mapValsToContractLaneArgs(vals);
          const laneId = await createContractLane({
            ...args,
            customerCompanyId: customerId,
            workosOrgId,
            createdBy: user.id,
          });
          toast.success(
            andNew
              ? 'Contract lane saved. Ready for the next one.'
              : 'Contract lane saved.',
          );
          if (!andNew) router.push(`${customerPath}/contract-lanes/${laneId}`);
        } catch (err) {
          console.error('Failed to create contract lane:', err);
          toast.error('Failed to create contract lane. Please try again.');
        }
      }}
    />
  );
}
