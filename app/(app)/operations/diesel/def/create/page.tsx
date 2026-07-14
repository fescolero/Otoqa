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

export default function CreateDefEntryPage() {
  const router = useRouter();
  const { user } = useAuth();
  const organizationId = useOrganizationId();

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
          return;
        }
        try {
          // fuelType is a fuelEntries-only field — the DEF schema never
          // renders it, but strip defensively since the defEntries
          // validator rejects unknown keys.
          const { fuelType: _fuelType, ...args } = mapValsToFuelEntryArgs(vals);
          const id = await createDefEntry({
            ...args,
            organizationId,
            createdBy: user.id,
          });
          toast.success(
            andNew
              ? 'DEF entry saved. Ready for the next one.'
              : 'DEF entry saved.',
          );
          if (!andNew) router.push(`/operations/diesel/${id}`);
        } catch (err) {
          console.error('Failed to create DEF entry:', err);
          toast.error('Failed to create DEF entry. Please try again.');
        }
      }}
    />
  );
}
