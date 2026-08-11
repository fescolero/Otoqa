'use client';

/**
 * Fuel / DEF entry edit page.
 *
 * Same shell as the create flow, just seeded with the existing record
 * and pointed at the `update` mutation. The shell's `mode: 'edit'`
 * schema flag adjusts the title + breadcrumb; no other UI changes.
 *
 * Replaces the legacy `<FuelEntryForm initialData={...}/>` invocation.
 * Drafts are deliberately NOT enabled for edit — the form is loaded
 * from a real record, not an in-flight draft. Autosave indicator
 * runs visually only.
 */

import * as React from 'react';
import { useRouter, useSearchParams } from 'next/navigation';
import { useAuth } from '@workos-inc/authkit-nextjs/components';
import { useMutation } from 'convex/react';
import { toast } from 'sonner';
import { Loader2 } from 'lucide-react';
import { api } from '@/convex/_generated/api';
import type { Id } from '@/convex/_generated/dataModel';
import { useOrganizationId } from '@/contexts/organization-context';
import { useAuthQuery } from '@/hooks/use-auth-query';
import { Button } from '@/components/ui/button';
import { CreateForm, bindUploaders } from '@/components/web/create-form';
import {
  buildFuelEntrySchema,
  mapRecordToFuelEntryVals,
  mapValsToFuelEntryUpdateArgs,
  FUEL_ENTRY_FIELD_IDS,
  type CarrierRow,
  type FuelEntryRecord,
} from '@/lib/forms/schemas/fuel-entry';

export function FuelEntryEditContent({ id }: { id: string }) {
  const router = useRouter();
  const searchParams = useSearchParams();
  const { user } = useAuth();
  const organizationId = useOrganizationId();

  // ── Record load ─────────────────────────────────────────────────
  // `?type=` partitions the record: fuel from `fuelEntries`, DEF from
  // `defEntries`. The param is only a hint though — a pasted or
  // bookmarked edit URL carries no `type`, and defaulting to 'fuel'
  // would send a `defEntries` id into `v.id('fuelEntries')`, failing
  // Convex argument validation before the handler runs. Resolve the
  // owning table from the id itself whenever the hint is absent.
  const typeParam = searchParams.get('type');
  const hintedType: 'fuel' | 'def' | null =
    typeParam === 'def' ? 'def' : typeParam === 'fuel' ? 'fuel' : null;

  const resolvedType = useAuthQuery(
    api.fuelEntries.resolveEntryType,
    hintedType ? 'skip' : { entryId: id },
  );
  const isResolvingType = !hintedType && resolvedType === undefined;
  const type: 'fuel' | 'def' | null = hintedType ?? resolvedType ?? null;

  // Only one record query is active at a time via the `'skip'` sentinel;
  // both skip until the type is known.
  const fuelEntry = useAuthQuery(
    api.fuelEntries.get,
    type === 'fuel' ? { entryId: id as Id<'fuelEntries'> } : 'skip',
  );
  const defEntry = useAuthQuery(
    api.defEntries.get,
    type === 'def' ? { entryId: id as Id<'defEntries'> } : 'skip',
  );
  const entry = type === 'def' ? defEntry : type === 'fuel' ? fuelEntry : undefined;

  // ── Option-source queries (same shape as the create page) ────────
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

  // ── Mutations ────────────────────────────────────────────────────
  const updateFuelEntry = useMutation(api.fuelEntries.update);
  const updateDefEntry = useMutation(api.defEntries.update);
  const generateUploadUrl = useMutation(
    type === 'def'
      ? api.defEntries.generateUploadUrl
      : api.fuelEntries.generateUploadUrl,
  );

  // ── Schema (factory with mode='edit') + uploader binding ─────────
  const schema = React.useMemo(
    () =>
      bindUploaders(
        buildFuelEntrySchema({
          // `type` is still null while the resolver is in flight. The
          // render gates below keep the form unmounted until it settles,
          // so this placeholder kind is never shown to the user.
          kind: type ?? 'fuel',
          mode: 'edit',
          vendors: vendorsQ ?? [],
          drivers: driversQ ?? [],
          trucks: trucksQ ?? [],
          carriers,
        }),
        { [FUEL_ENTRY_FIELD_IDS.attachment]: generateUploadUrl },
      ),
    [type, vendorsQ, driversQ, trucksQ, carriers, generateUploadUrl],
  );

  // ── Seed values from the existing record (only after it loads).
  // `useFormState` ignores changes to `initialValues` after mount, so
  // we KEY the <CreateForm> on the entry's id+updatedAt to remount the
  // form when the record changes — usually only happens once on first
  // load, but covers the edge case where the record updates server-side
  // mid-session.
  const initialValues = React.useMemo(() => {
    if (!entry) return undefined;
    return mapRecordToFuelEntryVals(entry as FuelEntryRecord);
  }, [entry]);

  const typeLabel = type === 'def' ? 'DEF' : type === 'fuel' ? 'Fuel' : 'Diesel';

  // ── Render gates — match the legacy edit page's loading and
  // not-found states so dispatchers see consistent fallbacks. These run
  // as separate sequential checks (rather than one combined condition) so
  // TypeScript can narrow `type` and `entry` for the render body below.
  if (isResolvingType) return <EditSpinner />;
  // `type === null` means no fuel OR DEF entry with this id exists in the
  // caller's org — same user-facing outcome as a null record. `typeLabel`
  // reads 'Diesel' in that case since we never learned the record type.
  if (type === null) {
    return <EditNotFound label={typeLabel} onBack={() => router.push('/operations/diesel')} />;
  }
  if (entry === undefined) return <EditSpinner />;
  if (entry === null) {
    return <EditNotFound label={typeLabel} onBack={() => router.push('/operations/diesel')} />;
  }

  return (
    <CreateForm
      // Re-mount the shell when a different record loads (e.g. user
      // navigates between two edit pages within the same SPA session).
      // The shell's useFormState seeds vals once on mount; without the
      // key it would keep the old record's values when the underlying
      // id changes.
      key={entry._id}
      schema={schema}
      initialValues={initialValues}
      onCancel={() => router.push(`/operations/diesel/${id}?type=${type}`)}
      onSaved={async (vals) => {
        if (!user) {
          toast.error('Not signed in — please refresh and try again.');
          return;
        }
        try {
          const args = mapValsToFuelEntryUpdateArgs(vals);
          if (type === 'def') {
            // fuelType is a fuelEntries-only field — the defEntries
            // validator rejects it, so drop it before the update call.
            const { fuelType: _fuelType, ...defArgs } = args;
            await updateDefEntry({
              entryId: id as Id<'defEntries'>,
              ...defArgs,
              updatedBy: user.id,
            });
          } else {
            await updateFuelEntry({
              entryId: id as Id<'fuelEntries'>,
              ...args,
              updatedBy: user.id,
            });
          }
          toast.success(`${typeLabel} entry updated.`);
          router.push(`/operations/diesel/${id}?type=${type}`);
        } catch (err) {
          console.error(`Failed to update ${typeLabel} entry:`, err);
          toast.error(`Failed to update ${typeLabel} entry. Please try again.`);
        }
      }}
    />
  );
}

/** Full-height spinner for the record-loading and type-resolving gates. */
function EditSpinner() {
  return (
    <div className="flex items-center justify-center h-screen">
      <Loader2 className="h-8 w-8 animate-spin text-muted-foreground" />
    </div>
  );
}

/** Shown when the id matches no entry the caller can read. */
function EditNotFound({ label, onBack }: { label: string; onBack: () => void }) {
  return (
    <div className="flex items-center justify-center h-screen">
      <div className="text-center">
        <p className="text-muted-foreground mb-4">{label} entry not found</p>
        <Button onClick={onBack}>Back to Diesel</Button>
      </div>
    </div>
  );
}
