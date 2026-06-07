'use client';

/**
 * Load create page.
 *
 * Thin wrapper around `<CreateForm>` + the load schema. Replaces the
 * ~1,057-line `components/create-load-form.tsx`.
 *
 * Load is the only create flow whose option list (`customers`) comes
 * from a live Convex query, so the schema is a factory. The stops
 * composite handles all per-stop logic; the wrapper only translates
 * scalar values for the mutation.
 */

import * as React from 'react';
import { useRouter } from 'next/navigation';
import { useAuth } from '@workos-inc/authkit-nextjs/components';
import { useMutation } from 'convex/react';
import { toast } from 'sonner';
import { api } from '@/convex/_generated/api';
import { useOrganizationId } from '@/contexts/organization-context';
import { useAuthQuery } from '@/hooks/use-auth-query';
import { CreateForm } from '@/components/web/create-form';
import {
  buildLoadSchema,
  mapValsToLoadArgs,
  type CustomerOptionRow,
} from '@/lib/forms/schemas/load';
import { useCreateDraft } from '@/lib/forms/use-create-draft';

export default function CreateLoadPage() {
  const router = useRouter();
  const { user } = useAuth();
  const organizationId = useOrganizationId();
  const createLoad = useMutation(api.loads.createLoad);

  // Phase 4 — see lib/forms/use-create-draft.ts. Load is the largest
  // draft payload (stops-list + freeform instructions); a single
  // draft can hit ~10KB during heavy editing. Still well within
  // Convex's 1MB doc limit but the biggest of our four entities.
  const draftProps = useCreateDraft({
    entity: 'load',
    draftKey: 'load-create-v1',
  });

  // Customer options — loaded once on mount; the schema rebuilds
  // when the query resolves so the dropdown populates.
  const customersQ = useAuthQuery(
    api.customers.list,
    organizationId ? { workosOrgId: organizationId } : 'skip',
  );

  const customers = React.useMemo<CustomerOptionRow[]>(
    () =>
      (customersQ ?? []).map((c) => ({
        _id: c._id,
        name: c.name,
      })),
    [customersQ],
  );

  const schema = React.useMemo(
    () => buildLoadSchema({ customers }),
    [customers],
  );

  return (
    <CreateForm
      schema={schema}
      {...draftProps}
      onCancel={() => router.push('/loads')}
      onSaved={async (vals, andNew) => {
        if (!organizationId || !user) {
          toast.error('Not signed in — please refresh and try again.');
          return;
        }
        try {
          const args = mapValsToLoadArgs(vals);
          const id = await createLoad({
            ...args,
            workosOrgId: organizationId,
            createdBy: user.id,
          });
          toast.success(
            andNew ? 'Load saved. Ready for the next one.' : 'Load saved.',
          );
          if (!andNew) router.push(`/loads/${id}`);
        } catch (err) {
          console.error('Failed to create load:', err);
          const msg =
            err instanceof Error ? err.message : 'Please try again.';
          toast.error(`Failed to create load — ${msg}`);
        }
      }}
    />
  );
}
