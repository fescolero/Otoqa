'use client';

/**
 * Trailer create page.
 *
 * Thin wrapper around `<CreateForm>` + the trailer schema. The page
 * owns:
 *   1. Ambient context (`organizationId`, `createdBy`) for the
 *      mutation — never form fields.
 *   2. Translating shell `vals` → typed mutation args via
 *      `mapValsToTrailerArgs`.
 *   3. Toast + redirect on success.
 *
 * Replaces ~381 lines of hand-rolled form code. The VIN decoder
 * action (`api.vinDecoder.decodeVIN`) that the previous page used is
 * deferred — schema-level VIN dup-check + auto-decode can land as a
 * follow-up once the create-form shell grows a `dupCheck`-style hook
 * that also writes back into sibling fields (Phase 3 enhancement).
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
  buildTrailerSchema,
  mapValsToTrailerArgs,
} from '@/lib/forms/schemas/trailer';

export default function CreateTrailerPage() {
  const router = useRouter();
  const { user } = useAuth();
  const organizationId = useOrganizationId();
  const createTrailer = useMutation(api.trailers.create);

  // Schema is a pure factory — no queries, no live data. `useMemo` for
  // referential stability so `<CreateForm>` doesn't rebuild its state
  // on every render.
  const schema = React.useMemo(() => buildTrailerSchema(), []);

  return (
    <CreateForm
      schema={schema}
      onCancel={() => router.push('/fleet/trailers')}
      onSaved={async (vals, andNew) => {
        if (!organizationId || !user) {
          toast.error('Not signed in — please refresh and try again.');
          return;
        }
        try {
          const args = mapValsToTrailerArgs(vals);
          const id = await createTrailer({
            ...args,
            organizationId,
            createdBy: user.id,
          });
          toast.success(
            andNew
              ? 'Trailer saved. Ready for the next one.'
              : 'Trailer saved.',
          );
          if (!andNew) router.push(`/fleet/trailers/${id}`);
        } catch (err) {
          console.error('Failed to create trailer:', err);
          toast.error('Failed to create trailer. Please try again.');
        }
      }}
    />
  );
}
