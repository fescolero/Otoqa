/**
 * Settings → Yards & parking — org-owned locations (yardLocations table).
 *
 * These are the carrier's OWN places, distinct from customer facilities:
 * each yard/parking pin anchors a session-level geofence, so shifts get
 * "left the yard / back at the yard" triggers on the Active Sessions map.
 */
'use client';

import * as React from 'react';
import { useMutation } from 'convex/react';
import { toast } from 'sonner';

import { api } from '@/convex/_generated/api';
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

type Yard = NonNullable<ReturnType<typeof useYards>>[number];
function useYards() {
  return useAuthQuery(api.yardLocations.list, {});
}

interface YardForm {
  name: string;
  locationType: 'YARD' | 'PARKING';
  addressLine1: string;
  city: string;
  state: string;
  latitude: string;
  longitude: string;
  radiusMeters: string;
  notes: string;
}

const EMPTY_FORM: YardForm = {
  name: '',
  locationType: 'YARD',
  addressLine1: '',
  city: '',
  state: '',
  latitude: '',
  longitude: '',
  radiusMeters: '',
  notes: '',
};

export default function YardsSettingsPage() {
  const yards = useYards();
  const createYard = useMutation(api.yardLocations.create);
  const updateYard = useMutation(api.yardLocations.update);
  const deleteYard = useMutation(api.yardLocations.softDelete);

  const [dialogOpen, setDialogOpen] = React.useState(false);
  const [editing, setEditing] = React.useState<Yard | null>(null);
  const [form, setForm] = React.useState<YardForm>(EMPTY_FORM);
  const [saving, setSaving] = React.useState(false);

  const openCreate = () => {
    setEditing(null);
    setForm(EMPTY_FORM);
    setDialogOpen(true);
  };
  const openEdit = (y: Yard) => {
    setEditing(y);
    setForm({
      name: y.name,
      locationType: y.locationType,
      addressLine1: y.addressLine1 ?? '',
      city: y.city ?? '',
      state: y.state ?? '',
      latitude: String(y.latitude),
      longitude: String(y.longitude),
      radiusMeters: String(y.radiusMeters),
      notes: y.notes ?? '',
    });
    setDialogOpen(true);
  };

  const set = (key: keyof YardForm) => (value: string) =>
    setForm((prev) => ({ ...prev, [key]: value }));

  const onAddressSelect = (data: AddressData) => {
    setForm((prev) => ({
      ...prev,
      addressLine1: data.address || prev.addressLine1,
      city: data.city || prev.city,
      state: data.state || prev.state,
      latitude: data.latitude != null ? String(data.latitude) : prev.latitude,
      longitude: data.longitude != null ? String(data.longitude) : prev.longitude,
    }));
  };

  const save = async () => {
    const latitude = Number(form.latitude);
    const longitude = Number(form.longitude);
    if (!form.name.trim()) return toast.error('Name is required');
    if (!Number.isFinite(latitude) || !Number.isFinite(longitude)) {
      return toast.error('Pin coordinates are required — pick an address or enter lat/lng');
    }
    const radiusMeters = form.radiusMeters.trim() ? Number(form.radiusMeters) : undefined;
    if (
      radiusMeters !== undefined &&
      (!Number.isFinite(radiusMeters) || radiusMeters < 50 || radiusMeters > 5000)
    ) {
      return toast.error('Fence radius must be between 50 and 5000 meters');
    }

    setSaving(true);
    try {
      const shared = {
        name: form.name.trim(),
        locationType: form.locationType,
        addressLine1: form.addressLine1.trim() || undefined,
        city: form.city.trim() || undefined,
        state: form.state.trim() || undefined,
        latitude,
        longitude,
        radiusMeters,
        notes: form.notes.trim() || undefined,
      };
      if (editing) {
        await updateYard({ yardId: editing._id, ...shared });
        toast.success('Location updated');
      } else {
        await createYard(shared);
        toast.success('Location added — session geofence active');
      }
      setDialogOpen(false);
    } catch (err) {
      console.error(err);
      toast.error(editing ? 'Failed to update location' : 'Failed to add location');
    } finally {
      setSaving(false);
    }
  };

  const remove = async (y: Yard) => {
    if (!window.confirm(`Remove "${y.name}"? Its geofence stops firing for future shifts.`)) return;
    try {
      await deleteYard({ yardId: y._id });
      toast.success('Location removed');
    } catch (err) {
      console.error(err);
      toast.error('Failed to remove location');
    }
  };

  const rows = (yards ?? []).map((y) => ({ ...y, id: y._id as string }));

  return (
    <div className="mx-auto flex w-full max-w-4xl flex-col gap-4 p-6">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-lg font-semibold text-foreground">Yards &amp; parking</h1>
          <p className="mt-0.5 text-[12.5px] text-[var(--text-secondary)]">
            Your company&apos;s own locations. Each pin gets a geofence — driver shifts record
            arriving and departing these places on the Active Sessions map.
          </p>
        </div>
        <WBtn onClick={openCreate}>Add location</WBtn>
      </div>

      <DSCard>
        <DSMiniTable
          columns={[
            {
              key: 'name',
              label: 'Name',
              render: (y: (typeof rows)[number]) => (
                <span className="font-medium text-foreground">{y.name}</span>
              ),
            },
            {
              key: 'type',
              label: 'Type',
              render: (y: (typeof rows)[number]) => (
                <Chip
                  status={y.locationType === 'PARKING' ? 'pending' : 'active'}
                  label={y.locationType === 'PARKING' ? 'Parking' : 'Yard'}
                />
              ),
            },
            {
              key: 'place',
              label: 'Location',
              render: (y: (typeof rows)[number]) => (
                <span className="text-[var(--text-secondary)]">
                  {[y.addressLine1, y.city, y.state].filter(Boolean).join(', ') ||
                    `${y.latitude.toFixed(5)}, ${y.longitude.toFixed(5)}`}
                </span>
              ),
            },
            {
              key: 'fence',
              label: 'Fence',
              render: (y: (typeof rows)[number]) => (
                <span className="tabular-nums text-[var(--text-secondary)]">
                  {y.radiusMeters} m in · {y.exitRadiusMeters} m out
                </span>
              ),
            },
            {
              key: 'actions',
              label: '',
              render: (y: (typeof rows)[number]) => (
                <div className="flex justify-end gap-2">
                  <WBtn variant="ghost" size="sm" onClick={() => openEdit(y)}>
                    Edit
                  </WBtn>
                  <WBtn variant="ghost" size="sm" onClick={() => remove(y)}>
                    Remove
                  </WBtn>
                </div>
              ),
            },
          ]}
          rows={rows}
        />
        {rows.length === 0 && (
          <p className="px-4 py-6 text-center text-[12px] italic text-[var(--text-tertiary)]">
            No yards or parking locations yet — add your first to turn on session geofencing.
          </p>
        )}
      </DSCard>

      <Dialog open={dialogOpen} onOpenChange={setDialogOpen}>
        <DialogContent className="max-w-lg">
          <DialogHeader>
            <DialogTitle>{editing ? 'Edit location' : 'Add yard or parking'}</DialogTitle>
          </DialogHeader>
          <div className="flex flex-col gap-3">
            <div className="grid grid-cols-2 gap-3">
              <div className="flex flex-col gap-1.5">
                <Label htmlFor="yard-name">Name</Label>
                <Input
                  id="yard-name"
                  value={form.name}
                  onChange={(e) => set('name')(e.target.value)}
                  placeholder="Fontana Yard"
                />
              </div>
              <div className="flex flex-col gap-1.5">
                <Label>Type</Label>
                <div className="flex gap-2">
                  {(['YARD', 'PARKING'] as const).map((t) => (
                    <WBtn
                      key={t}
                      variant={form.locationType === t ? 'primary' : 'secondary'}
                      size="sm"
                      onClick={() => setForm((p) => ({ ...p, locationType: t }))}
                    >
                      {t === 'YARD' ? 'Yard' : 'Parking'}
                    </WBtn>
                  ))}
                </div>
              </div>
            </div>
            <div className="flex flex-col gap-1.5">
              <Label>Address (sets the pin)</Label>
              <AddressAutocomplete
                value={form.addressLine1}
                onChange={set('addressLine1')}
                onSelect={onAddressSelect}
                placeholder="Search address…"
              />
            </div>
            <div className="grid grid-cols-3 gap-3">
              <div className="flex flex-col gap-1.5">
                <Label htmlFor="yard-lat">Latitude</Label>
                <Input
                  id="yard-lat"
                  value={form.latitude}
                  onChange={(e) => set('latitude')(e.target.value)}
                  placeholder="34.0522"
                />
              </div>
              <div className="flex flex-col gap-1.5">
                <Label htmlFor="yard-lng">Longitude</Label>
                <Input
                  id="yard-lng"
                  value={form.longitude}
                  onChange={(e) => set('longitude')(e.target.value)}
                  placeholder="-117.4350"
                />
              </div>
              <div className="flex flex-col gap-1.5">
                <Label htmlFor="yard-radius">Fence radius (m)</Label>
                <Input
                  id="yard-radius"
                  value={form.radiusMeters}
                  onChange={(e) => set('radiusMeters')(e.target.value)}
                  placeholder="250"
                />
              </div>
            </div>
            <div className="flex flex-col gap-1.5">
              <Label htmlFor="yard-notes">Notes</Label>
              <Input
                id="yard-notes"
                value={form.notes}
                onChange={(e) => set('notes')(e.target.value)}
                placeholder="Gate code, entrance side…"
              />
            </div>
          </div>
          <DialogFooter>
            <WBtn variant="secondary" onClick={() => setDialogOpen(false)}>
              Cancel
            </WBtn>
            <WBtn onClick={save} disabled={saving}>
              {saving ? 'Saving…' : editing ? 'Save changes' : 'Add location'}
            </WBtn>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
