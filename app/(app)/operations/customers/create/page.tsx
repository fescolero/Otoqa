'use client';

/**
 * Customer create page.
 *
 * Thin wrapper around `<CreateForm>` + the customer schema. Replaces
 * ~355 lines of hand-rolled form code.
 *
 * Org arg is `workosOrgId` (not `organizationId`) — see the rollout
 * doc for the per-mutation naming map.
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
  buildCustomerSchema,
  mapValsToCustomerArgs,
} from '@/lib/forms/schemas/customer';
import { useCreateDraft } from '@/lib/forms/use-create-draft';

export default function CreateCustomerPage() {
  const router = useRouter();
  const { user } = useAuth();
  const organizationId = useOrganizationId();
  const createCustomer = useMutation(api.customers.create);

  const schema = React.useMemo(() => buildCustomerSchema(), []);

  // Phase 4 — see lib/forms/use-create-draft.ts.
  const draftProps = useCreateDraft({
    entity: 'customer',
    draftKey: 'customer-create-v1',
  });

  return (
    <CreateForm
      schema={schema}
      {...draftProps}
      onCancel={() => router.push('/operations/customers')}
      onSaved={async (vals, andNew) => {
        if (!organizationId || !user) {
          toast.error('Not signed in — please refresh and try again.');
          return;
        }
        try {
          const args = mapValsToCustomerArgs(vals);
          const id = await createCustomer({
            ...args,
            workosOrgId: organizationId,
            createdBy: user.id,
          });
          toast.success(
            andNew
              ? 'Customer saved. Ready for the next one.'
              : 'Customer saved.',
          );
          if (!andNew) router.push(`/operations/customers/${id}`);
        } catch (err) {
          console.error('Failed to create customer:', err);
          toast.error('Failed to create customer. Please try again.');
        }
      }}
    />
  );
}
