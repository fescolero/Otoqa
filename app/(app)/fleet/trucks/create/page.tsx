'use client';

/**
 * Truck create page.
 *
 * Thin wrapper around `<CreateForm>` + the truck schema. Replaces
 * ~459 lines of hand-rolled form code.
 *
 * The VIN auto-decode action (`api.vinDecoder.decodeVIN`) the
 * previous page wired up is deferred until the create-form shell
 * grows a `dupCheck`-style hook that can write back into sibling
 * fields. Schema-level VIN validation (17-char check) already lives
 * in the schema.
 */

import * as React from 'react';
import { useRouter } from 'next/navigation';
import { useAuth } from '@workos-inc/authkit-nextjs/components';
import { useMutation } from 'convex/react';
import { toast } from 'sonner';
import { api } from '@/convex/_generated/api';
import { useOrganizationId } from '@/contexts/organization-context';
import { CreateForm } from '@/components/web/create-form';
import {
  buildTruckSchema,
  mapValsToTruckArgs,
} from '@/lib/forms/schemas/truck';

export default function CreateTruckPage() {
  const router = useRouter();
  const { user } = useAuth();
  const organizationId = useOrganizationId();
  const createTruck = useMutation(api.trucks.create);

  const schema = React.useMemo(() => buildTruckSchema(), []);

  return (
    <CreateForm
      schema={schema}
      onCancel={() => router.push('/fleet/trucks')}
      onSaved={async (vals, andNew) => {
        if (!organizationId || !user) {
          toast.error('Not signed in — please refresh and try again.');
          return;
        }
        try {
          const args = mapValsToTruckArgs(vals);
          const id = await createTruck({
            ...args,
            organizationId,
            createdBy: user.id,
          });
          toast.success(
            andNew ? 'Truck saved. Ready for the next one.' : 'Truck saved.',
          );
          if (!andNew) router.push(`/fleet/trucks/${id}`);
        } catch (err) {
          console.error('Failed to create truck:', err);
          toast.error('Failed to create truck. Please try again.');
        }
      }}
    />
  );
}
