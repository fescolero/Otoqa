'use client';

/**
 * Carrier (partnership) create page.
 *
 * Thin wrapper around `<CreateForm>` + the carrier schema. Replaces
 * ~310 lines of hand-rolled form code.
 *
 * Two unusual bits for this entity:
 *  - The mutation lives at `api.carrierPartnerships.create` (carriers
 *    are modeled as broker↔carrier partnerships in this codebase).
 *  - The org arg is `brokerOrgId`, not `organizationId` /
 *    `workosOrgId`. See `docs/create-form-rollout.md` for the
 *    per-mutation naming map.
 *
 * Server-side, the mutation does extra work on save:
 *   - Checks for an existing partnership at (broker, MC#) and rejects
 *     duplicates.
 *   - Auto-provisions a carrier org + Otoqa Driver login when the
 *     carrier doesn't already have an account (requires
 *     `contactPhone`).
 *
 * Those server checks surface to us as thrown errors — the toast on
 * failure shows the error message verbatim.
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
  buildCarrierSchema,
  mapValsToCarrierArgs,
} from '@/lib/forms/schemas/carrier';
import { useCreateDraft } from '@/lib/forms/use-create-draft';

export default function CreateCarrierPage() {
  const router = useRouter();
  const { user } = useAuth();
  const organizationId = useOrganizationId();
  const createPartnership = useMutation(api.carrierPartnerships.create);

  const schema = React.useMemo(() => buildCarrierSchema(), []);

  // Phase 4 — server-side draft persistence. The `draftKey` here MUST
  // match the schema's draftKey. Bumping one without the other forks
  // the draft (old key orphans, new key starts empty).
  const draftProps = useCreateDraft({
    entity: 'carrier',
    draftKey: 'carrier-create-v1',
  });

  return (
    <CreateForm
      schema={schema}
      {...draftProps}
      onCancel={() => router.push('/operations/carriers')}
      onSaved={async (vals, andNew) => {
        if (!organizationId || !user) {
          toast.error('Not signed in — please refresh and try again.');
          return;
        }
        try {
          const args = mapValsToCarrierArgs(vals);
          // `carrierPartnerships.create` returns a result object —
          // not just the id like every other create mutation in this
          // codebase. We need `.partnershipId` for the redirect; other
          // fields (`isLinked`, `carrierOrgCreated`, `clerkUserCreated`)
          // could power a richer success toast in a follow-up.
          const { partnershipId } = await createPartnership({
            ...args,
            brokerOrgId: organizationId,
            createdBy: user.id,
          });
          toast.success(
            andNew
              ? 'Carrier saved. Ready for the next one.'
              : 'Carrier saved.',
          );
          if (!andNew) router.push(`/operations/carriers/${partnershipId}`);
        } catch (err) {
          console.error('Failed to create carrier:', err);
          const msg =
            err instanceof Error ? err.message : 'Please try again.';
          toast.error(`Failed to create carrier — ${msg}`);
        }
      }}
    />
  );
}
