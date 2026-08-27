'use client';

/**
 * DEF (diesel-exhaust-fluid) entry create page.
 *
 * Mirror of `/operations/diesel/create/page.tsx` — same shell, same
 * schema factory, different mutation. The two routes sharing one UI
 * is intentional: the only operational difference is which table
 * (`fuelEntries` vs `defEntries`) the record lands in.
 */

import * as React from 'react';
import { useRouter } from 'next/navigation';
import { useAuth } from '@workos-inc/authkit-nextjs/components';
import { useConvex, useMutation } from 'convex/react';
import { toast } from 'sonner';
import { api } from '@/convex/_generated/api';
import type { Id } from '@/convex/_generated/dataModel';
import { useOrganizationId } from '@/contexts/organization-context';
import { useAuthQuery } from '@/hooks/use-auth-query';
import { CreateForm, SaveAborted, bindUploaders } from '@/components/web/create-form';
import {
  buildFuelEntrySchema,
  mapValsToFuelEntryArgs,
  readLoadReference,
  FUEL_ENTRY_FIELD_IDS,
  type CarrierRow,
} from '@/lib/forms/schemas/fuel-entry';

export default function CreateDefEntryPage() {
  const router = useRouter();
  const { user } = useAuth();
  const organizationId = useOrganizationId();
  const convex = useConvex();

  const createDefEntry = useMutation(api.defEntries.create);
  const generateUploadUrl = useMutation(api.defEntries.generateUploadUrl);

  const driversQ = useAuthQuery(
    api.drivers.list,
    organizationId ? { organizationId } : 'skip',
  );
  const trucksQ = useAuthQuery(
    api.trucks.list,
    organizationId ? { organizationId } : 'skip',
  );
  const vendorsQ = useAuthQuery(
    api.fuelVendors.list,
    organizationId ? { organizationId, activeOnly: true } : 'skip',
  );
  const carriersQ = useAuthQuery(
    api.carrierPartnerships.listForBroker,
    organizationId ? { brokerOrgId: organizationId } : 'skip',
  );

  const carriers = React.useMemo<CarrierRow[]>(
    () =>
      (carriersQ ?? []).map((c) => ({
        _id: c._id,
        carrierName: c.carrierName,
        trackFuelConsumption: c.trackFuelConsumption ?? false,
      })),
    [carriersQ],
  );

  const schema = React.useMemo(
    () =>
      bindUploaders(
        buildFuelEntrySchema({
          kind: 'def',
          vendors: vendorsQ ?? [],
          drivers: driversQ ?? [],
          trucks: trucksQ ?? [],
          carriers,
        }),
        { [FUEL_ENTRY_FIELD_IDS.attachment]: generateUploadUrl },
      ),
    [vendorsQ, driversQ, trucksQ, carriers, generateUploadUrl],
  );

  return (
    <CreateForm
      schema={schema}
      onCancel={() => router.push('/operations/diesel')}
      onSaved={async (vals, andNew) => {
        if (!organizationId || !user) {
          toast.error('Not signed in — please refresh and try again.');
          throw new SaveAborted();
        }
        // "Linked load" is free text — the mutation wants a document
        // id. Resolve it first; a typo shouldn't fail arg validation
        // with a generic "please try again".
        const loadRef = readLoadReference(vals);
        let loadId: Id<'loadInformation'> | undefined;
        if (loadRef) {
          let match;
          try {
            match = await convex.query(api.loads.resolveReference, {
              reference: loadRef,
            });
          } catch (err) {
            console.error('Failed to resolve the linked load:', err);
            toast.error('Could not look up that load number. Please try again.');
            throw new SaveAborted();
          }
          if (match.status === 'ambiguous') {
            toast.error(`“${loadRef}” matches ${match.count} loads. Use the internal load ID instead.`);
            throw new SaveAborted();
          }
          if (match.status === 'not_found') {
            toast.error(`No load found for “${loadRef}”. Check the load number or clear the field.`);
            // Abort rather than return: a bare return reads as a
            // successful save, and "Save & new" would then reset the
            // form and discard everything the user typed.
            throw new SaveAborted();
          }
          loadId = match.loadId;
        }
        try {
          // fuelType is a fuelEntries-only field — the DEF schema never
          // renders it, but strip defensively since the defEntries
          // validator rejects unknown keys.
          const { fuelType: _fuelType, ...args } = mapValsToFuelEntryArgs(vals);
          const id = await createDefEntry({
            ...args,
            ...(loadId ? { loadId } : {}),
            organizationId,
            createdBy: user.id,
          });
          toast.success(
            andNew
              ? 'DEF entry saved. Ready for the next one.'
              : 'DEF entry saved.',
          );
          // `?type=def` is load-bearing: the detail route defaults to
          // `fuel` and would query `fuelEntries.get` with a defEntries
          // id, which fails arg validation.
          if (!andNew) router.push(`/operations/diesel/${id}?type=def`);
        } catch (err) {
          console.error('Failed to create DEF entry:', err);
          toast.error('Failed to create DEF entry. Please try again.');
          // Already explained — abort so the shell neither re-toasts
          // nor treats the failed save as a success.
          throw new SaveAborted();
        }
      }}
    />
  );
}
