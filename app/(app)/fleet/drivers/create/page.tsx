'use client';

/**
 * Driver create page.
 *
 * Thin wrapper around `<CreateForm>` + the driver schema. Replaces
 * ~446 lines of hand-rolled form code.
 *
 * The schema's `address` composite field maps to the driver's home
 * address (street/city/state/zipCode). The Convex mutation splits
 * sensitive fields (SSN, DOB, license #) into the
 * `drivers_sensitive_info` table; the schema author treats them
 * uniformly — server-side persistence handles the split.
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
  buildDriverSchema,
  mapValsToDriverArgs,
} from '@/lib/forms/schemas/driver';
import { useCreateDraft } from '@/lib/forms/use-create-draft';

export default function CreateDriverPage() {
  const router = useRouter();
  const { user } = useAuth();
  const organizationId = useOrganizationId();
  const createDriver = useMutation(api.drivers.create);

  const schema = React.useMemo(() => buildDriverSchema(), []);

  // Phase 4 — see lib/forms/use-create-draft.ts.
  const draftProps = useCreateDraft({
    entity: 'driver',
    draftKey: 'driver-create-v1',
  });

  return (
    <CreateForm
      schema={schema}
      {...draftProps}
      onCancel={() => router.push('/fleet/drivers')}
      onSaved={async (vals, andNew) => {
        if (!organizationId || !user) {
          toast.error('Not signed in — please refresh and try again.');
          return;
        }
        try {
          const args = mapValsToDriverArgs(vals);
          const id = await createDriver({
            ...args,
            organizationId,
            createdBy: user.id,
          });
          toast.success(
            andNew ? 'Driver saved. Ready for the next one.' : 'Driver saved.',
          );
          if (!andNew) router.push(`/fleet/drivers/${id}`);
        } catch (err) {
          console.error('Failed to create driver:', err);
          toast.error('Failed to create driver. Please try again.');
        }
      }}
    />
  );
}
