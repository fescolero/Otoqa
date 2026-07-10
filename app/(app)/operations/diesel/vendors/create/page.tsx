'use client';

/**
 * Fuel vendor create page.
 *
 * Thin wrapper around `<CreateForm>` + the fuel-vendor schema.
 * Replaces ~209 lines of hand-rolled form code. Short-form schema,
 * no drafts.
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
  buildFuelVendorSchema,
  mapValsToFuelVendorArgs,
} from '@/lib/forms/schemas/fuel-vendor';

export default function CreateFuelVendorPage() {
  const router = useRouter();
  const { user } = useAuth();
  const organizationId = useOrganizationId();
  const createVendor = useMutation(api.fuelVendors.create);

  const schema = React.useMemo(() => buildFuelVendorSchema(), []);

  return (
    <CreateForm
      schema={schema}
      onCancel={() => router.push('/operations/diesel/vendors')}
      onSaved={async (vals, andNew) => {
        if (!organizationId || !user) {
          toast.error('Not signed in — please refresh and try again.');
          return;
        }
        try {
          const args = mapValsToFuelVendorArgs(vals);
          const id = await createVendor({
            ...args,
            organizationId,
            createdBy: user.id,
          });
          toast.success(
            andNew
              ? 'Vendor saved. Ready for the next one.'
              : 'Vendor saved.',
          );
          if (!andNew) router.push(`/operations/diesel/vendors/${id}`);
        } catch (err) {
          console.error('Failed to create fuel vendor:', err);
          toast.error('Failed to create vendor. Please try again.');
        }
      }}
    />
  );
}
