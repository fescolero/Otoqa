/**
 * FacilitiesSection — the customer detail page's Locations tab.
 *
 * Manual-only registry of the customer's physical stop locations
 * (facilities). Imports link load stops to these rows; a VERIFIED
 * facility's pin overrides import-feed coordinates and anchors the
 * driver check-in geofence, so the pin quality here directly decides
 * whether drivers get blocked at real stops.
 */
'use client';

import * as React from 'react';
import { useMutation } from 'convex/react';
import { toast } from 'sonner';

import { api } from '@/convex/_generated/api';
import type { Doc, Id } from '@/convex/_generated/dataModel';
import { useAuthQuery } from '@/hooks/use-auth-query';
import { Chip, DSCard, DSMiniTable, WBtn } from '@/components/web';
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { AddressAutocomplete, type AddressData } from '@/components/ui/address-autocomplete';

type Facility = Doc<'facilities'>;
// DSMiniTable rows need an `id` field.
type FacilityRow = Facility & { id: string };

interface FacilityForm {
  name: string;
  externalCode: string;
  addressLine1: string;
  city: string;
  state: string;
  postalCode: string;
  latitude: string;
  longitude: string;
  radiusMeters: string;
  notes: string;
}

const EMPTY_FORM: FacilityForm = {
  name: '',
  externalCode: '',
  addressLine1: '',
  city: '',
  state: '',
  postalCode: '',
  latitude: '',
  longitude: '',
  radiusMeters: '',
  notes: '',
};

function formFromFacility(f: Facility): FacilityForm {
  return {
    name: f.name,
    externalCode: f.externalCode ?? '',
    addressLine1: f.addressLine1 ?? '',
    city: f.city,
    state: f.state,
    postalCode: f.postalCode ?? '',
    latitude: String(f.latitude),
    longitude: String(f.longitude),
    radiusMeters: f.radiusMeters != null ? String(f.radiusMeters) : '',
    notes: f.notes ?? '',
  };
}

export function FacilitiesSection({ customerId }: { customerId: Id<'customers'> }) {
  const facilities = useAuthQuery(api.facilities.listByCustomer, { customerId });
  const evidence = useAuthQuery(api.facilities.evidenceByCustomer, { customerId });
  const createFacility = useMutation(api.facilities.create);
  const updateFacility = useMutation(api.facilities.update);
  const removeFacility = useMutation(api.facilities.remove);
  const applySuggestedPin = useMutation(api.facilities.applySuggestedPin);

  const [dialogOpen, setDialogOpen] = React.useState(false);
  const [editing, setEditing] = React.useState<Facility | null>(null);
  const [form, setForm] = React.useState<FacilityForm>(EMPTY_FORM);
  const [saving, setSaving] = React.useState(false);

  const openCreate = () => {
    setEditing(null);
    setForm(EMPTY_FORM);
    setDialogOpen(true);
  };
  const openEdit = (f: Facility) => {
    setEditing(f);
    setForm(formFromFacility(f));
    setDialogOpen(true);
  };

  const set = (key: keyof FacilityForm) => (value: string) =>
    setForm((prev) => ({ ...prev, [key]: value }));

  const onAddressSelect = (data: AddressData) => {
    setForm((prev) => ({
      ...prev,
      addressLine1: data.address || prev.addressLine1,
      city: data.city || prev.city,
      state: data.state || prev.state,
      postalCode: data.postalCode || prev.postalCode,
      latitude: data.latitude != null ? String(data.latitude) : prev.latitude,
      longitude: data.longitude != null ? String(data.longitude) : prev.longitude,
    }));
  };

  const save = async () => {
    const latitude = Number(form.latitude);
    const longitude = Number(form.longitude);
    if (!form.name.trim()) return toast.error('Name is required');
    if (!form.city.trim() || !form.state.trim()) return toast.error('City and state are required');
    if (!Number.isFinite(latitude) || !Number.isFinite(longitude)) {
      return toast.error('Pin coordinates are required — pick an address or enter lat/lng');
    }
    const radiusMeters = form.radiusMeters.trim() ? Number(form.radiusMeters) : undefined;
    if (radiusMeters !== undefined && (!Number.isFinite(radiusMeters) || radiusMeters <= 0)) {
      return toast.error('Radius must be a positive number of meters');
    }

    setSaving(true);
    try {
      const shared = {
        name: form.name.trim(),
        externalCode: form.externalCode.trim() || undefined,
        addressLine1: form.addressLine1.trim() || undefined,
        city: form.city.trim(),
        state: form.state.trim(),
        postalCode: form.postalCode.trim() || undefined,
        latitude,
        longitude,
        radiusMeters,
        notes: form.notes.trim() || undefined,
      };
      if (editing) {
        const result = await updateFacility({ facilityId: editing._id, ...shared });
        toast.success(
          result.backfilled
            ? `Facility updated — pin pushed to ${result.backfilled} upcoming stop${result.backfilled === 1 ? '' : 's'}`
            : 'Facility updated',
        );
      } else {
        await createFacility({ customerId, ...shared });
        toast.success('Facility added');
      }
      setDialogOpen(false);
    } catch (err) {
      console.error(err);
      toast.error(editing ? 'Failed to update facility' : 'Failed to add facility');
    } finally {
      setSaving(false);
    }
  };

  const toggleVerified = async (f: Facility) => {
    try {
      const next = f.verificationState === 'VERIFIED' ? 'UNVERIFIED' : 'VERIFIED';
      const result = await updateFacility({ facilityId: f._id, verificationState: next });
      toast.success(
        next === 'VERIFIED'
          ? result.backfilled
            ? `Verified — pin pushed to ${result.backfilled} upcoming stop${result.backfilled === 1 ? '' : 's'}`
            : 'Facility verified'
          : 'Verification removed',
      );
    } catch (err) {
      console.error(err);
      toast.error('Failed to update verification');
    }
  };

  const applyEvidence = async (f: Facility) => {
    try {
      const result = await applySuggestedPin({ facilityId: f._id });
      toast.success(
        `Pin verified from ${result.evidence.count} driver fixes${result.backfilled ? ` — pushed to ${result.backfilled} upcoming stop${result.backfilled === 1 ? '' : 's'}` : ''}`,
      );
    } catch (err) {
      console.error(err);
      toast.error('Could not apply the suggested pin');
    }
  };

  const remove = async (f: Facility) => {
    if (!window.confirm(`Remove facility "${f.name}"? Future imports will stop matching it; past loads keep their records.`)) {
      return;
    }
    try {
      await removeFacility({ facilityId: f._id });
      toast.success('Facility removed');
    } catch (err) {
      console.error(err);
      toast.error('Failed to remove facility');
    }
  };

  const rows: FacilityRow[] = (facilities ?? []).map((f) => ({ ...f, id: f._id }));

  return (
    <DSCard
      title="Facilities"
      bodyClassName="p-0"
      action={
        <WBtn size="sm" leading="plus" onClick={openCreate}>
          Add facility
        </WBtn>
      }
    >
      {rows.length === 0 ? (
        <div className="px-4 py-6 text-[12.5px] text-[var(--text-tertiary)] border-t border-[var(--border-hairline)]">
          No facilities yet. Add the customer&apos;s physical stop locations so imported
          loads link to verified pins — verified pins anchor driver check-in geofencing
          and override the import feed&apos;s coordinates.
        </div>
      ) : (
      <DSMiniTable<FacilityRow>
        columns={[
          {
            key: 'name',
            label: 'Name',
            width: '1.4fr',
            render: (f) => (
              <span className="font-medium text-foreground truncate">
                {f.name}
                {f.externalCode ? (
                  <span className="num text-[var(--text-tertiary)]"> · {f.externalCode}</span>
                ) : null}
              </span>
            ),
          },
          {
            key: 'where',
            label: 'Address',
            width: '1.6fr',
            render: (f) => (
              <span className="text-[var(--text-tertiary)] truncate">
                {[f.addressLine1, f.city, f.state].filter(Boolean).join(', ')}
              </span>
            ),
          },
          {
            key: 'pin',
            label: 'Pin',
            width: '170px',
            render: (f) => (
              <span className="num text-[var(--text-tertiary)]">
                {f.latitude.toFixed(4)}, {f.longitude.toFixed(4)}
              </span>
            ),
          },
          {
            key: 'radius',
            label: 'Radius',
            width: '80px',
            render: (f) => (
              <span className="num text-[var(--text-tertiary)]">
                {f.radiusMeters != null ? `${f.radiusMeters}m` : '—'}
              </span>
            ),
          },
          {
            key: 'state',
            label: 'Status',
            width: '120px',
            render: (f) =>
              f.needsReview ? (
                // Auto-demoted: repeated driver overrides say this pin is
                // wrong. Soft geofencing applies until someone re-verifies.
                <Chip status="warning" label="Needs review" />
              ) : (
                <Chip
                  status={f.verificationState === 'VERIFIED' ? 'active' : 'pending'}
                  label={f.verificationState === 'VERIFIED' ? 'Verified' : 'Unverified'}
                />
              ),
          },
          {
            key: 'evidence',
            label: 'Evidence',
            width: '190px',
            render: (f) => {
              const e = evidence?.[f._id];
              if (!e) return <span className="text-[var(--text-tertiary)]">—</span>;
              if (e.qualifies && (f.verificationState !== 'VERIFIED' || f.needsReview || e.distanceFromPinMeters > 50)) {
                return (
                  <WBtn
                    size="xs"
                    variant="soft"
                    onClick={() => applyEvidence(f)}
                    title={`Median of ${e.count} driver fixes across ${e.distinctDays} days, spread ${e.spreadMeters}m, ${e.distanceFromPinMeters}m from the current pin. Applies the pin and verifies.`}
                  >
                    Use {e.count}-fix pin ✓
                  </WBtn>
                );
              }
              return (
                <span
                  className="num text-[var(--text-tertiary)]"
                  title={`${e.count} driver fixes across ${e.distinctDays} days, spread ${e.spreadMeters}m`}
                >
                  {e.count} fixes · {e.distinctDays}d
                </span>
              );
            },
          },
          {
            key: 'actions',
            label: '',
            width: '210px',
            render: (f) => (
              <span className="flex items-center gap-1 justify-end">
                <WBtn size="sm" variant="ghost" onClick={() => toggleVerified(f)}>
                  {f.verificationState === 'VERIFIED' ? 'Unverify' : 'Verify'}
                </WBtn>
                <WBtn size="sm" variant="ghost" onClick={() => openEdit(f)}>
                  Edit
                </WBtn>
                <WBtn size="sm" variant="ghost" onClick={() => remove(f)}>
                  Remove
                </WBtn>
              </span>
            ),
          },
        ]}
        rows={rows}
        total={rows.length}
        className="rounded-t-none border-0 border-t"
      />
      )}

      <Dialog open={dialogOpen} onOpenChange={setDialogOpen}>
        <DialogContent className="sm:max-w-[560px]">
          <DialogHeader>
            <DialogTitle>{editing ? 'Edit facility' : 'Add facility'}</DialogTitle>
          </DialogHeader>

          <div className="grid gap-3 py-1">
            <div className="grid grid-cols-2 gap-3">
              <div className="grid gap-1.5">
                <Label htmlFor="facility-name">Name</Label>
                <Input
                  id="facility-name"
                  value={form.name}
                  onChange={(e) => set('name')(e.target.value)}
                  placeholder="Yreka Post Office"
                />
              </div>
              <div className="grid gap-1.5">
                <Label htmlFor="facility-code">Facility code (NASS)</Label>
                <Input
                  id="facility-code"
                  value={form.externalCode}
                  onChange={(e) => set('externalCode')(e.target.value)}
                  placeholder="Optional"
                />
              </div>
            </div>

            <div className="grid gap-1.5">
              <Label>Address</Label>
              <AddressAutocomplete
                value={form.addressLine1}
                onChange={(v) => set('addressLine1')(v)}
                onSelect={onAddressSelect}
                placeholder="Search the street address…"
              />
            </div>

            <div className="grid grid-cols-3 gap-3">
              <div className="grid gap-1.5">
                <Label htmlFor="facility-city">City</Label>
                <Input id="facility-city" value={form.city} onChange={(e) => set('city')(e.target.value)} />
              </div>
              <div className="grid gap-1.5">
                <Label htmlFor="facility-state">State</Label>
                <Input id="facility-state" value={form.state} onChange={(e) => set('state')(e.target.value)} />
              </div>
              <div className="grid gap-1.5">
                <Label htmlFor="facility-zip">Zip</Label>
                <Input id="facility-zip" value={form.postalCode} onChange={(e) => set('postalCode')(e.target.value)} />
              </div>
            </div>

            <div className="grid grid-cols-3 gap-3">
              <div className="grid gap-1.5">
                <Label htmlFor="facility-lat">Latitude</Label>
                <Input
                  id="facility-lat"
                  value={form.latitude}
                  onChange={(e) => set('latitude')(e.target.value)}
                  placeholder="41.7354"
                />
              </div>
              <div className="grid gap-1.5">
                <Label htmlFor="facility-lng">Longitude</Label>
                <Input
                  id="facility-lng"
                  value={form.longitude}
                  onChange={(e) => set('longitude')(e.target.value)}
                  placeholder="-122.6345"
                />
              </div>
              <div className="grid gap-1.5">
                <Label htmlFor="facility-radius">Radius (m)</Label>
                <Input
                  id="facility-radius"
                  value={form.radiusMeters}
                  onChange={(e) => set('radiusMeters')(e.target.value)}
                  placeholder="804 default"
                />
              </div>
            </div>

            <div className="grid gap-1.5">
              <Label htmlFor="facility-notes">Notes</Label>
              <Input
                id="facility-notes"
                value={form.notes}
                onChange={(e) => set('notes')(e.target.value)}
                placeholder="Gate code, dock details…"
              />
            </div>
          </div>

          <DialogFooter>
            <WBtn variant="ghost" onClick={() => setDialogOpen(false)} disabled={saving}>
              Cancel
            </WBtn>
            <WBtn onClick={save} disabled={saving}>
              {saving ? 'Saving…' : editing ? 'Save changes' : 'Add facility'}
            </WBtn>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </DSCard>
  );
}
