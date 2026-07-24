'use client';

/**
 * Contract-lane edit page.
 *
 * Same shell as the create flow, seeded from the existing record and
 * pointed at `api.contractLanes.update` — the `mode: 'edit'` schema
 * flag adjusts the title/breadcrumb. Replaces the legacy hand-rolled
 * edit form. Drafts are deliberately NOT enabled for edit.
 */

import * as React from 'react';
import { useRouter, useParams } from 'next/navigation';
import { useMutation, useQuery } from 'convex/react';
import { toast } from 'sonner';
import { Loader2 } from 'lucide-react';
import { api } from '@/convex/_generated/api';
import type { Id } from '@/convex/_generated/dataModel';
import { useAuthQuery } from '@/hooks/use-auth-query';
import { Button } from '@/components/ui/button';
import { CreateForm } from '@/components/web/create-form';
import {
  buildContractLaneSchema,
  mapContractLaneRecordToVals,
  mapValsToContractLaneArgs,
  mapFacilitiesToOptions,
  type ContractLaneRecord,
} from '@/lib/forms/schemas/contract-lane';

export default function EditContractLanePage() {
  const router = useRouter();
  const params = useParams();
  const customerId = params.id as Id<'customers'>;
  const laneId = params.laneId as Id<'contractLanes'>;

  const lane = useQuery(api.contractLanes.get, { id: laneId });
  const updateContractLane = useMutation(api.contractLanes.update);

  const facilitiesQ = useAuthQuery(
    api.facilities.listByCustomer,
    customerId ? { customerId } : 'skip',
  );

  const schema = React.useMemo(
    () =>
      buildContractLaneSchema({
        mode: 'edit',
        facilities: mapFacilitiesToOptions(facilitiesQ ?? []),
      }),
    [facilitiesQ],
  );

  const initialValues = React.useMemo(() => {
    if (!lane) return undefined;
    return mapContractLaneRecordToVals(lane as unknown as ContractLaneRecord);
  }, [lane]);

  const lanePath = `/operations/customers/${customerId}/contract-lanes/${laneId}`;

  if (lane === undefined) {
    return (
      <div className="flex items-center justify-center h-screen">
        <Loader2 className="h-8 w-8 animate-spin text-muted-foreground" />
      </div>
    );
  }
  if (lane === null) {
    return (
      <div className="flex items-center justify-center h-screen">
        <div className="text-center">
          <p className="text-muted-foreground mb-4">Contract lane not found</p>
          <Button onClick={() => router.push(`/operations/customers/${customerId}`)}>
            Back to customer
          </Button>
        </div>
      </div>
    );
  }

  return (
    <CreateForm
      // Re-mount the shell when a different record loads — the shell's
      // useFormState seeds vals once on mount.
      key={lane._id}
      schema={schema}
      initialValues={initialValues}
      onCancel={() => router.push(lanePath)}
      onSaved={async (vals) => {
        try {
          const args = mapValsToContractLaneArgs(vals, {
            customExclusions: lane.scheduleRule?.customExclusions ?? [],
          });
          await updateContractLane({ id: laneId, ...args });
          toast.success('Contract lane updated.');
          router.push(lanePath);
        } catch (err) {
          console.error('Failed to update contract lane:', err);
          toast.error('Failed to update contract lane. Please try again.');
        }
      }}
    />
  );
}
