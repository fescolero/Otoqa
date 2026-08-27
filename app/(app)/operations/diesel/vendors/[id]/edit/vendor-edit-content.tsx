'use client';

/**
 * Fuel vendor edit page.
 *
 * Same shell as the vendor create flow, seeded with the existing
 * record and pointed at `fuelVendors.update`. The schema's
 * `mode: 'edit'` flag adjusts the title + breadcrumb; the field layout
 * is identical because `update` accepts exactly the fields `create`
 * does, all optional.
 *
 * Replaces ~280 lines of hand-rolled Card/Input markup. Two behaviors
 * carried over from that version deserve a note:
 *
 *   - Discount program was a free-text input there and is a six-option
 *     select here, so a row can hold a value outside the list. The
 *     schema factory appends the stored value as an option rather than
 *     showing a placeholder over data the user never chose.
 *   - Country seeds from the record, not from the field's 'US' default,
 *     so a row that never had one stays blank instead of being
 *     backfilled on the next save.
 *
 * Drafts are deliberately NOT enabled — the form loads from a real
 * record, not an in-flight draft.
 */

import * as React from 'react';
import { useRouter } from 'next/navigation';
import { useAuth } from '@workos-inc/authkit-nextjs/components';
import { useMutation } from 'convex/react';
import { toast } from 'sonner';
import { Loader2 } from 'lucide-react';
import { api } from '@/convex/_generated/api';
import type { Id } from '@/convex/_generated/dataModel';
import { useAuthQuery } from '@/hooks/use-auth-query';
import { convexErrorMessage } from '@/lib/convex-error';
import { useSeededRevision } from '@/lib/forms/use-seeded-revision';
import { Button } from '@/components/ui/button';
import { CreateForm, SaveAborted } from '@/components/web/create-form';
import {
  buildFuelVendorSchema,
  mapRecordToFuelVendorVals,
  mapValsToFuelVendorUpdateArgs,
} from '@/lib/forms/schemas/fuel-vendor';

export function VendorEditContent({ vendorId }: { vendorId: string }) {
  const router = useRouter();
  const { user } = useAuth();
  const typedVendorId = vendorId as Id<'fuelVendors'>;

  const vendor = useAuthQuery(api.fuelVendors.get, { vendorId: typedVendorId });
  const updateVendor = useMutation(api.fuelVendors.update);

  const schema = React.useMemo(
    () =>
      buildFuelVendorSchema({
        mode: 'edit',
        currentDiscountProgram: vendor?.discountProgram,
      }),
    [vendor?.discountProgram],
  );

  // `useFormState` seeds `vals` once on mount and ignores later changes
  // to `initialValues`, so the <CreateForm> below is keyed on the
  // record id — see the comment at the key itself.
  // The revision the form was SEEDED from, latched per record id for the
  // same reason that key exists: this component is NOT remounted when the
  // user moves between two vendors' edit pages. See use-seeded-revision.
  const seededUpdatedAt = useSeededRevision(vendor);

  const initialValues = React.useMemo(() => {
    if (!vendor) return undefined;
    return mapRecordToFuelVendorVals(vendor);
  }, [vendor]);

  // ── Render gates — same loading / not-found fallbacks the diesel
  // entry edit page uses, so the two flows behave alike.
  if (vendor === undefined) {
    return (
      <div className="flex items-center justify-center h-screen">
        <Loader2 className="h-8 w-8 animate-spin text-muted-foreground" />
      </div>
    );
  }
  if (vendor === null) {
    return (
      <div className="flex items-center justify-center h-screen">
        <div className="text-center">
          <p className="text-muted-foreground mb-4">Fuel vendor not found</p>
          <Button onClick={() => router.push('/operations/diesel/vendors')}>
            Back to Fuel Vendors
          </Button>
        </div>
      </div>
    );
  }

  return (
    <CreateForm
      // Re-mount the shell when a different record loads (e.g. the user
      // navigates between two edit pages in the same SPA session).
      // Without the key the form would keep the previous vendor's
      // values when the underlying id changes.
      key={vendor._id}
      schema={schema}
      initialValues={initialValues}
      onCancel={() => router.push(`/operations/diesel/vendors/${vendorId}`)}
      onSaved={async (vals) => {
        if (!user) {
          toast.error('Not signed in — please refresh and try again.');
          throw new SaveAborted();
        }
        try {
          const args = mapValsToFuelVendorUpdateArgs(vals);
          await updateVendor({
            vendorId: typedVendorId,
            ...args,
            // Refuse to overwrite a revision we never showed the user
            // — the translator sends every field, so a blind save
            // would revert whoever wrote in between.
            expectedUpdatedAt: seededUpdatedAt,
            updatedBy: user.id,
          });
          toast.success('Fuel vendor updated.');
          router.push(`/operations/diesel/vendors/${vendorId}`);
        } catch (err) {
          console.error('Failed to update fuel vendor:', err);
          // A stale-write rejection needs its own copy — "please try
          // again" is wrong advice when a retry re-sends the same
          // stale revision.
          toast.error(
            convexErrorMessage(err) ??
              'Failed to update fuel vendor. Please try again.',
          );
          // Already explained — abort so the shell neither re-toasts
          // nor treats the failed save as a success.
          throw new SaveAborted();
        }
      }}
    />
  );
}
