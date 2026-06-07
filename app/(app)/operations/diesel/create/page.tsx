'use client';

/**
 * Diesel (fuel entry) create page.
 *
 * Thin wrapper around `<CreateForm>` + the shared fuel-entry schema.
 * The page is responsible for:
 *   1. Loading option data (vendors / drivers / trucks / carriers).
 *   2. Binding the `generateUploadUrl` mutation to the schema's
 *      `attachment` field.
 *   3. Translating shell `vals` → the typed mutation arg shape via
 *      `mapValsToFuelEntryArgs`.
 *   4. Auth ambient context (`organizationId`, `createdBy`) that the
 *      mutation expects but isn't a form field.
 *
 * Replaces the 562-line `components/diesel/fuel-entry-form.tsx` that
 * was retired in the Phase 4 cleanup. Both create routes (diesel +
 * DEF) and the edit page (operations/diesel/[id]/edit) now run on
 * the schema-driven shell. `git log` has the historical diff if
 * behavior comparison is ever needed.
 */

import * as React from 'react';
import { useRouter } from 'next/navigation';
import { useAuth } from '@workos-inc/authkit-nextjs/components';
import { useMutation } from 'convex/react';
import { toast } from 'sonner';
import { api } from '@/convex/_generated/api';
import { useOrganizationId } from '@/contexts/organization-context';
import { useAuthQuery } from '@/hooks/use-auth-query';
import { CreateForm, bindUploaders } from '@/components/web/create-form';
import {
  buildFuelEntrySchema,
  mapValsToFuelEntryArgs,
  FUEL_ENTRY_FIELD_IDS,
  type CarrierRow,
} from '@/lib/forms/schemas/fuel-entry';

export default function CreateFuelEntryPage() {
  const router = useRouter();
  const { user } = useAuth();
  const organizationId = useOrganizationId();

  const createFuelEntry = useMutation(api.fuelEntries.create);
  const generateUploadUrl = useMutation(api.fuelEntries.generateUploadUrl);

  // Option-source queries. `'skip'` until org id resolves — useAuthQuery
  // returns `undefined` in that state and we fall back to empty arrays.
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

  // Narrow the carrier list to fields the schema needs. The Convex
  // query returns a wider row shape; pick the three keys the dropdown
  // actually consumes so the schema's TS type stays tight.
  const carriers = React.useMemo<CarrierRow[]>(
    () =>
      (carriersQ ?? []).map((c) => ({
        _id: c._id,
        carrierName: c.carrierName,
        trackFuelConsumption: c.trackFuelConsumption ?? false,
      })),
    [carriersQ],
  );

  // Schema is recomputed when any option array changes — `useMemo`
  // gates the rebuild so `<CreateForm>` doesn't see a new schema ref
  // every render and reset its scroll-spy / focus state.
  const schema = React.useMemo(
    () =>
      bindUploaders(
        buildFuelEntrySchema({
          kind: 'fuel',
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
          return;
        }
        try {
          const args = mapValsToFuelEntryArgs(vals);
          const id = await createFuelEntry({
            ...args,
            organizationId,
            createdBy: user.id,
          });
          toast.success(
            andNew
              ? 'Fuel entry saved. Ready for the next one.'
              : 'Fuel entry saved.',
          );
          if (!andNew) router.push(`/operations/diesel/${id}`);
        } catch (err) {
          console.error('Failed to create fuel entry:', err);
          toast.error('Failed to create fuel entry. Please try again.');
        }
      }}
    />
  );
}
