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
import { APIProvider, Map as GMap, AdvancedMarker, useMap, useMapsLibrary } from '@vis.gl/react-google-maps';

import { api } from '@/convex/_generated/api';
import { useAuthQuery } from '@/hooks/use-auth-query';
import { useGoogleMapsKey } from '@/contexts/google-maps-context';
import { useThemedMapId, useMapColorScheme } from '@/lib/google-map-id';
import { YARD_DEFAULT_RADIUS_METERS, EXIT_RADIUS_RATIO } from '@/convex/lib/geo';
import { Chip, DSCard, DSMiniTable, SettingsHeader, WBtn } from '@/components/web';
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

const MIN_RADIUS = 50;
const MAX_RADIUS = 5000;

/**
 * Interactive fence editor inside the dialog: the entry circle is
 * DRAGGABLE and RESIZABLE (Google Maps editable circle) and stays synced
 * with the lat/lng/radius form fields both ways. The faint outer circle
 * previews the exit boundary (EXIT_RADIUS_RATIO × entry) that the session
 * evaluator will actually use — same hysteresis the load-stop fences get.
 */
function FenceEditor({
  latitude,
  longitude,
  radiusMeters,
  onChange,
}: {
  latitude: number;
  longitude: number;
  radiusMeters: number;
  onChange: (next: { latitude: number; longitude: number; radiusMeters: number }) => void;
}) {
  const map = useMap();
  const mapsLibrary = useMapsLibrary('maps');
  const circleRef = React.useRef<google.maps.Circle | null>(null);
  const exitRef = React.useRef<google.maps.Circle | null>(null);
  // Guards the editable-circle event handlers while WE are the ones moving
  // the circle (form edit → circle sync) so it doesn't echo back.
  const syncing = React.useRef(false);
  const onChangeRef = React.useRef(onChange);
  React.useEffect(() => {
    onChangeRef.current = onChange;
  }, [onChange]);

  React.useEffect(() => {
    if (!map || !mapsLibrary) return;

    const circle = new mapsLibrary.Circle({
      center: { lat: latitude, lng: longitude },
      radius: radiusMeters,
      strokeColor: '#2E5CFF',
      strokeOpacity: 0.8,
      strokeWeight: 2,
      fillColor: '#2E5CFF',
      fillOpacity: 0.12,
      editable: true,
      draggable: true,
      map,
    });
    const exit = new mapsLibrary.Circle({
      center: { lat: latitude, lng: longitude },
      radius: Math.round(radiusMeters * EXIT_RADIUS_RATIO),
      strokeColor: '#94a3b8',
      strokeOpacity: 0.45,
      strokeWeight: 1.5,
      fillOpacity: 0,
      clickable: false,
      map,
    });
    circleRef.current = circle;
    exitRef.current = exit;

    const emit = () => {
      if (syncing.current) return;
      const center = circle.getCenter();
      if (!center) return;
      const radius = Math.round(
        Math.min(MAX_RADIUS, Math.max(MIN_RADIUS, circle.getRadius())),
      );
      exit.setCenter(center);
      exit.setRadius(Math.round(radius * EXIT_RADIUS_RATIO));
      onChangeRef.current({
        latitude: Number(center.lat().toFixed(6)),
        longitude: Number(center.lng().toFixed(6)),
        radiusMeters: radius,
      });
    };
    const listeners = [
      circle.addListener('radius_changed', emit),
      circle.addListener('center_changed', emit),
    ];

    map.fitBounds(circle.getBounds()!, 40);

    return () => {
      listeners.forEach((l) => l.remove());
      circle.setMap(null);
      exit.setMap(null);
      circleRef.current = null;
      exitRef.current = null;
    };
    // Mount-only: field→circle sync happens in the effect below, and
    // circle→field flows through the listeners. Re-creating the circle on
    // every keystroke would fight the user's drag.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [map, mapsLibrary]);

  // Form fields changed (typed, or address picked) → move the circle.
  React.useEffect(() => {
    const circle = circleRef.current;
    const exit = exitRef.current;
    if (!circle || !exit) return;
    const center = circle.getCenter();
    const sameCenter =
      center &&
      Math.abs(center.lat() - latitude) < 1e-6 &&
      Math.abs(center.lng() - longitude) < 1e-6;
    const sameRadius = Math.abs(circle.getRadius() - radiusMeters) < 1;
    if (sameCenter && sameRadius) return;
    syncing.current = true;
    circle.setCenter({ lat: latitude, lng: longitude });
    circle.setRadius(radiusMeters);
    exit.setCenter({ lat: latitude, lng: longitude });
    exit.setRadius(Math.round(radiusMeters * EXIT_RADIUS_RATIO));
    syncing.current = false;
    if (!sameCenter && map) map.panTo({ lat: latitude, lng: longitude });
  }, [latitude, longitude, radiusMeters, map]);

  return null;
}

function FencePreview({
  form,
  onFenceChange,
}: {
  form: YardForm;
  onFenceChange: (next: { latitude: number; longitude: number; radiusMeters: number }) => void;
}) {
  const apiKey = useGoogleMapsKey();
  const mapId = useThemedMapId();
  const colorScheme = useMapColorScheme();
  const lat = Number(form.latitude);
  const lng = Number(form.longitude);
  if (!apiKey || !Number.isFinite(lat) || !Number.isFinite(lng)) return null;
  const radius = form.radiusMeters.trim() ? Number(form.radiusMeters) : YARD_DEFAULT_RADIUS_METERS;
  const effectiveRadius = Number.isFinite(radius)
    ? Math.min(MAX_RADIUS, Math.max(MIN_RADIUS, radius))
    : YARD_DEFAULT_RADIUS_METERS;

  return (
    <div className="overflow-hidden rounded-lg border border-[var(--border-hairline)]" style={{ height: 220 }}>
      <APIProvider apiKey={apiKey}>
        <GMap
          defaultCenter={{ lat, lng }}
          defaultZoom={15}
          mapId={mapId}
          colorScheme={colorScheme}
          gestureHandling="cooperative"
          disableDefaultUI
          zoomControl
          className="h-full w-full"
        >
          <AdvancedMarker position={{ lat, lng }} />
          <FenceEditor
            latitude={lat}
            longitude={lng}
            radiusMeters={effectiveRadius}
            onChange={onFenceChange}
          />
        </GMap>
      </APIProvider>
    </div>
  );
}

// Section title — settings-page card vocabulary (same as general/billing).
function SectionTitle({ children, sub }: { children: React.ReactNode; sub?: React.ReactNode }) {
  return (
    <div>
      <div
        style={{
          fontSize: 14,
          fontWeight: 600,
          color: 'var(--text-primary)',
          letterSpacing: -0.005,
          lineHeight: 1.2,
        }}
      >
        {children}
      </div>
      {sub && (
        <div className="text-[12px] text-[var(--text-tertiary)] mt-1 leading-[16px]">{sub}</div>
      )}
    </div>
  );
}

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
    <div className="flex-1 overflow-hidden flex flex-col min-w-0">
      <SettingsHeader
        eyebrow="Settings"
        title="Yards & parking"
        subtitle="Your company's own locations — distinct from customer facilities. Each pin gets a geofence, so driver shifts record arriving and departing these places on the Active Sessions map."
        actions={
          <WBtn size="sm" variant="primary" leading="plus" onClick={openCreate}>
            Add location
          </WBtn>
        }
      />

      <div className="scroll-thin flex-1 overflow-auto" style={{ background: 'var(--bg-canvas)' }}>
        <div className="flex flex-col gap-4 min-w-0" style={{ padding: 24, maxWidth: 980 }}>
          <DSCard
            title={
              <SectionTitle sub="The entry fence fires ARRIVED; drivers must cross the wider exit boundary (1.5×) before a DEPARTED records.">
                Locations
              </SectionTitle>
            }
          >
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
        </div>
      </div>

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
            <FencePreview
              form={form}
              onFenceChange={({ latitude, longitude, radiusMeters }) =>
                setForm((prev) => ({
                  ...prev,
                  latitude: String(latitude),
                  longitude: String(longitude),
                  radiusMeters: String(radiusMeters),
                }))
              }
            />
            {form.latitude && (
              <p className="m-0 text-[11px] text-[var(--text-tertiary)]">
                Drag the circle to move the fence, drag its edge to resize. The faint outer ring is
                the exit boundary drivers must cross before a departure fires.
              </p>
            )}
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
