/**
 * SessionMap — Google Maps surface for Active Sessions live ops.
 *
 * Built on the project's existing `@vis.gl/react-google-maps` + AdvancedMarker
 * stack (same as `components/dispatch/live-route-map.tsx`) plus
 * `@googlemaps/markerclusterer` for spatial clustering at fleet scale.
 *
 * Modes:
 *   - LIVE  (props.mode = 'live')  — driver dots from `latestLocation`.
 *                                    Pulsing halo + bigger pin for the
 *                                    selected driver. Route polyline drawn
 *                                    from `routeHistory`.
 *   - PAST  (props.mode = 'past')  — bookend pins (green start, red end)
 *                                    per driver. Route polyline + planned
 *                                    legend chrome on the right.
 *
 * Markers are HTML `<div>`s wrapped in `AdvancedMarker.content` so we can
 * compose the avatar + status dot in plain JSX — no SVG data URIs.
 */

'use client';

import * as React from 'react';
import {
  APIProvider,
  Map as GMap,
  AdvancedMarker,
  useMap,
} from '@vis.gl/react-google-maps';
import { MarkerClusterer, type Marker } from '@googlemaps/markerclusterer';
import { useGoogleMapsKey } from '@/contexts/google-maps-context';
import { useThemedMapId, useMapColorScheme } from '@/lib/google-map-id';
import { snapPathToRoads } from '@/lib/googleRoads';
import {
  STATUS_TONE,
  TRIP_PALETTE,
  avatarColorForId,
  initialsForName,
  type LiveSessionRow,
  type PastSessionRow,
  type TripInfo,
} from './types';

/** One GPS ping the map needs to draw a polyline segment. */
export interface MapPing {
  latitude: number;
  longitude: number;
  loadId: string | null;
  recordedAt: number;
  /** Optional — exposed so the ping-dot debug overlay can show speed in
   *  its hover tooltip. Defaults to undefined when the page doesn't
   *  pass it through. */
  speed?: number;
}

const US_CENTER = { lat: 39.5, lng: -98.35 } as const;
const DEFAULT_ZOOM = 5;

// A ping implying a faster-than-this jump from its predecessor is a GPS
// outlier. One shared threshold so the polyline, the outlier badge, and
// the camera all agree on which pings are real.
const MAX_PLAUSIBLE_MPH = 150;
const MAX_PLAUSIBLE_KMH = MAX_PLAUSIBLE_MPH * 1.60934;

type LiveProps = {
  mode: 'live';
  sessions: LiveSessionRow[];
  selectedId: string | null;
  onSelectDriver: (id: string) => void;
  /** Pings in chronological order for the selected driver. The map groups
   *  consecutive pings by `loadId` and draws a separate polyline per group,
   *  colored from `TRIP_PALETTE` (or neutral for `SESSION_ROUTE` pings).
   *  The trips order on the selected driver decides which palette index
   *  each load gets — same color as the trip card in the panel. */
  routeHistory?: MapPing[];
  selectedTrips?: TripInfo[];
  /** When set, dim every polyline segment / ping dot whose legIndex
   *  doesn't match this. null = show all at full opacity. Driven by
   *  the focus pin button on each trip card in the activity panel. */
  focusedTripIndex?: number | null;
  /** Ping row the dispatcher is hovering in the activity panel's GPS
   *  list — highlighted on the map so a list row can be eye-matched to
   *  its spot on the route. null = nothing hovered. */
  hoveredPing?: { latitude: number; longitude: number } | null;
};

type PastProps = {
  mode: 'past';
  sessions: PastSessionRow[];
  selectedId: string | null;
  onSelectDriver: (id: string) => void;
  routeHistory?: MapPing[];
  selectedTrips?: TripInfo[];
  focusedTripIndex?: number | null;
  hoveredPing?: { latitude: number; longitude: number } | null;
};

type Props = LiveProps | PastProps;

export function SessionMap(props: Props) {
  const apiKey = useGoogleMapsKey();
  const [isSnapping, setIsSnapping] = React.useState(false);
  const [outlierCount, setOutlierCount] = React.useState(0);
  // Debug overlay — when on, every GPS ping in routeHistory renders as a
  // small colored dot on the map. Useful for diagnosing data drift
  // (driver app tracking from home off-shift, mistagged loadIds, etc.).
  const [showPings, setShowPings] = React.useState(false);
  const mapId = useThemedMapId();
  const colorScheme = useMapColorScheme();
  if (!apiKey) {
    return (
      <MapError message="Google Maps API key is missing. Set GOOGLE_MAPS_API_KEY." />
    );
  }
  return (
    <div className="relative h-full w-full">
      <APIProvider apiKey={apiKey}>
        <GMap
          // Single Cloud-styled Map ID with both color schemes attached
          // in GCP. We pass colorScheme at runtime so the palette swap
          // happens without remounting the map (markers / pan-zoom /
          // polyline state are preserved across light↔dark).
          mapId={mapId}
          colorScheme={colorScheme}
          defaultCenter={US_CENTER}
          defaultZoom={DEFAULT_ZOOM}
          gestureHandling="greedy"
          disableDefaultUI={false}
          mapTypeControl={false}
          fullscreenControl={false}
          streetViewControl={false}
          zoomControl
          className="absolute inset-0"
        >
          <MapInner
            {...props}
            onSnappingChange={setIsSnapping}
            onOutlierCountChange={setOutlierCount}
            showPings={showPings}
          />
        </GMap>
      </APIProvider>
      {/* Stack the badges so they don't collide. Snapping has priority
          since it's a transient state; outlier hint sits below if both
          are visible. */}
      {(isSnapping || outlierCount > 0) && (
        <div
          className="pointer-events-none absolute right-3 top-3 z-[2] flex flex-col items-end gap-2"
        >
          {isSnapping && <SnappingBadge />}
          {outlierCount > 0 && <OutlierBadge count={outlierCount} />}
        </div>
      )}
      {/* Ping debug toggle — only meaningful when a driver is selected
          (no routeHistory otherwise). */}
      {props.selectedId &&
        props.routeHistory &&
        props.routeHistory.length > 0 && (
          <PingDebugToggle
            on={showPings}
            onChange={setShowPings}
            count={props.routeHistory.length}
          />
        )}
    </div>
  );
}

/**
 * Toggle pill — sits bottom-left of the map next to the attribution row.
 * Flips ping dots on/off. Shows the count of pings currently loaded so a
 * dispatcher can sanity-check "did pagination finish?"
 */
function PingDebugToggle({
  on,
  onChange,
  count,
}: {
  on: boolean;
  onChange: (next: boolean) => void;
  count: number;
}) {
  return (
    <button
      type="button"
      onClick={() => onChange(!on)}
      className="focus-ring absolute bottom-3 left-3 z-[2] inline-flex items-center gap-2 rounded-md px-3 py-1.5 text-[11.5px] font-medium"
      style={{
        background: 'var(--bg-surface)',
        backdropFilter: 'blur(6px)',
        boxShadow:
          '0 6px 16px -8px rgba(15,22,36,0.18), 0 1px 2px rgba(15,22,36,0.06)',
        border: '1px solid ' + (on ? 'var(--accent)' : 'var(--border-hairline)'),
        color: on ? 'var(--accent)' : 'var(--text-secondary)',
        cursor: 'pointer',
        fontFamily: 'inherit',
      }}
    >
      <span
        className="inline-block h-2 w-2 rounded-full"
        style={{ background: on ? 'var(--accent)' : 'var(--text-tertiary)' }}
      />
      {on ? 'Hide pings' : 'Show pings'}
      <span
        className="num rounded-full px-1.5 text-[10.5px]"
        style={{
          background: 'var(--bg-canvas)',
          color: 'var(--text-tertiary)',
        }}
      >
        {count}
      </span>
    </button>
  );
}

// Overlay badges use the app's theme tokens so they read correctly in
// both light and dark mode. Status colors (blue spinner dot, amber
// outlier dot) keep their brand hues — they encode meaning, not chrome.

function SnappingBadge() {
  return (
    <div
      className="pointer-events-none flex items-center gap-2 rounded-md px-3 py-1.5 text-[11.5px]"
      style={{
        background: 'var(--bg-surface)',
        backdropFilter: 'blur(6px)',
        boxShadow:
          '0 6px 16px -8px rgba(15,22,36,0.18), 0 1px 2px rgba(15,22,36,0.06)',
        border: '1px solid var(--border-hairline)',
        color: 'var(--text-secondary)',
      }}
    >
      <span
        className="inline-block h-2 w-2 rounded-full"
        style={{
          background: '#2E5CFF',
          animation: 'sessionPulse 1.2s ease-out infinite',
        }}
      />
      Snapping route to roads…
    </div>
  );
}

function OutlierBadge({ count }: { count: number }) {
  return (
    <div
      className="pointer-events-auto flex items-center gap-2 rounded-md px-3 py-1.5 text-[11.5px]"
      title={
        `${count} GPS ping${count === 1 ? '' : 's'} implied an impossible jump` +
        ` (>150 mph from the previous point) and were hidden so the polyline` +
        ` doesn't draw straight lines through outliers.`
      }
      style={{
        background: 'var(--bg-surface)',
        backdropFilter: 'blur(6px)',
        boxShadow:
          '0 6px 16px -8px rgba(15,22,36,0.18), 0 1px 2px rgba(15,22,36,0.06)',
        border: '1px solid var(--border-hairline)',
        // Amber accent reads on both themes; the badge has its own surface.
        color: '#C68B00',
      }}
    >
      <span
        className="inline-block h-2 w-2 rounded-full"
        style={{ background: '#F59E0B' }}
      />
      {count} suspicious ping{count === 1 ? '' : 's'} hidden
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────────────
// Inner — uses useMap() so all the imperative work (clusterer, polyline,
// fitBounds) can talk to the actual map instance.
// ─────────────────────────────────────────────────────────────────────────

function MapInner(
  props: Props & {
    onSnappingChange?: (snapping: boolean) => void;
    onOutlierCountChange?: (count: number) => void;
    showPings?: boolean;
  },
) {
  const map = useMap();
  const apiKey = useGoogleMapsKey();
  // One polyline per LEG segment; SESSION_ROUTE ("between loads", or a
  // ping that arrived after its leg ended) gets a neutral-gray polyline.
  // Cleared and rebuilt whenever the selected driver / route history
  // changes.
  //
  // The "leg" is the unit of trip-card-on-the-panel. Pings are stamped
  // with loadId only (no legId), so we time-bracket each ping into a
  // specific leg via the leg's [startedAt, endedAt] window. This keeps
  // every trip card visually distinct on the map even when multiple
  // legs share a single loadId (multi-stop loads).
  //
  // We also keep richer per-segment metadata for incremental live
  // updates: when a new ping arrives, we want to know which polyline
  // to append to (matched by legIndex) without re-snapping the entire
  // route.
  const segmentsRef = React.useRef<
    Array<{ legIndex: number | null; polyline: google.maps.Polyline; color: string }>
  >([]);
  const polylinesRef = React.useRef<google.maps.Polyline[]>([]);
  // Previous routeHistory snapshot — used to decide between a full
  // rebuild (selection change, pagination prepended older pings) and
  // an incremental append (live mode, new pings landed at the tail).
  const prevRouteRef = React.useRef<MapPing[] | null>(null);
  // Signature of the trips array the polylines were last built against —
  // lets the polyline effect skip rebuilds when a reactive fleet update
  // handed us fresh-but-identical trips.
  const prevTripsSigRef = React.useRef<string | null>(null);
  const clustererRef = React.useRef<MarkerClusterer | null>(null);
  const markerNodesRef = React.useRef<Map<string, Marker>>(new Map());
  // Live mirror of `props.focusedTripIndex`. The polyline effect uses
  // this ref inside its async snap-to-roads completion callback so the
  // callback always sees the CURRENT focus state, not the stale one
  // from when the effect fired. Without this, pinning a trip while
  // snap is in flight would have the snap callback overwrite our
  // opacity=0 hide with a closure-captured opacity=0.92.
  const focusedTripIndexRef = React.useRef<number | null>(
    props.focusedTripIndex ?? null,
  );
  React.useEffect(() => {
    focusedTripIndexRef.current = props.focusedTripIndex ?? null;
  }, [props.focusedTripIndex]);
  // Notify the outer SessionMap so it can render a "Snapping to roads…"
  // badge while the Roads API call is in flight, or an outlier-pings
  // hint when sanitizePings flagged jumps. Wrap with useRef so the
  // polyline effect doesn't re-run just because the prop's identity
  // shifted.
  const onSnappingChangeRef = React.useRef(props.onSnappingChange);
  const onOutlierCountChangeRef = React.useRef(props.onOutlierCountChange);
  React.useEffect(() => {
    onSnappingChangeRef.current = props.onSnappingChange;
    onOutlierCountChangeRef.current = props.onOutlierCountChange;
  }, [props.onSnappingChange, props.onOutlierCountChange]);
  const setIsSnapping = React.useCallback((s: boolean) => {
    onSnappingChangeRef.current?.(s);
  }, []);
  // Running total of outliers dropped since the most recent full
  // rebuild. Full rebuilds reset to the rebuilt-state count; incremental
  // updates add their new breaks. Always emit the absolute value so the
  // badge in the parent can render `n` directly.
  const outlierTotalRef = React.useRef(0);
  const emitOutlierCount = React.useCallback((absoluteOrDelta: number, mode: 'reset' | 'add') => {
    if (mode === 'reset') outlierTotalRef.current = absoluteOrDelta;
    else outlierTotalRef.current += absoluteOrDelta;
    onOutlierCountChangeRef.current?.(outlierTotalRef.current);
  }, []);

  // Track AdvancedMarker DOM nodes that `<AdvancedMarker>` mounts. We pass
  // them through a ref-callback below; that's our handle for the clusterer.
  const registerMarker = React.useCallback(
    (id: string, marker: Marker | null) => {
      if (marker) {
        markerNodesRef.current.set(id, marker);
      } else {
        markerNodesRef.current.delete(id);
      }
      // Sync the clusterer's marker set
      if (clustererRef.current) {
        clustererRef.current.clearMarkers();
        clustererRef.current.addMarkers(
          Array.from(markerNodesRef.current.values())
        );
      }
    },
    []
  );

  // Mount the clusterer once we have a map
  React.useEffect(() => {
    if (!map) return;
    clustererRef.current = new MarkerClusterer({
      map,
      renderer: {
        render: ({ count, position }) => {
          // Cluster pin — neutral surface, count label
          const el = document.createElement('div');
          el.style.cssText = `
            display: flex; align-items: center; justify-content: center;
            min-width: 32px; height: 32px; padding: 0 10px;
            border-radius: 99px;
            background: #FFFFFF;
            color: #0F1624;
            font-family: Saira, system-ui, sans-serif;
            font-size: 12px; font-weight: 600;
            box-shadow: 0 6px 16px -6px rgba(15,22,36,0.28), 0 1px 2px rgba(15,22,36,0.10);
            border: 1px solid rgba(15,22,36,0.08);
          `;
          el.textContent = String(count);
          return new google.maps.marker.AdvancedMarkerElement({
            position,
            content: el,
            zIndex: 1500,
          });
        },
      },
    });
    return () => {
      clustererRef.current?.clearMarkers();
      clustererRef.current = null;
    };
  }, [map]);

  // ───── Auto-fit to drivers on first render of a non-empty set ─────
  // One-shot per roster: live queries emit a new `sessions` array every
  // time any driver pings, and re-fitting on each of those yanks the
  // camera away from wherever the dispatcher panned. We only re-fit when
  // the SET of sessions changes (day switch, driver on/off duty) or when
  // coming back from a driver selection — not when positions move.
  const overviewFitKeyRef = React.useRef<string | null>(null);
  React.useEffect(() => {
    if (!map) return;
    if (props.selectedId) {
      // Reset so deselecting re-frames the fleet overview once.
      overviewFitKeyRef.current = null;
      return;
    }
    const positions: google.maps.LatLngLiteral[] = [];
    for (const s of props.sessions) {
      const xy = positionForSession(s, props.mode);
      if (xy) positions.push(xy);
    }
    if (positions.length === 0) return;
    const rosterKey =
      props.mode +
      ':' +
      props.sessions
        .map((s) => s.sessionId)
        .sort()
        .join(',');
    if (overviewFitKeyRef.current === rosterKey) return;
    overviewFitKeyRef.current = rosterKey;
    if (positions.length === 1) {
      map.setCenter(positions[0]);
      const z = map.getZoom() ?? DEFAULT_ZOOM;
      if (z < 11) map.setZoom(12);
      return;
    }
    const bounds = new google.maps.LatLngBounds();
    positions.forEach((p) => bounds.extend(p));
    map.fitBounds(bounds, 80);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [map, props.sessions, props.selectedId, props.mode]);

  // ───── Frame the selected driver — one-shot per selection ─────
  // We auto-frame the map TWICE per selection, then leave the camera
  // alone:
  //
  //   1. The instant a driver is selected, we fit to whatever we have
  //      (just `latestLocation` if pings haven't loaded yet, or current
  //      + route if they already had).
  //   2. Once routeHistory becomes non-empty for the first time for
  //      this selection (the paginated query's first page lands),
  //      we re-fit to include the polyline so Trip 1's path doesn't
  //      end up off-screen.
  //
  // After that we stop. Live pings extending the polyline, loadMore()
  // pulling older pings, the polyline effect doing its incremental
  // rebuild — none of those re-fire the camera. The dispatcher pans
  // and zooms freely; we don't fight them.
  //
  // Selecting a different driver resets the two-shot fit.
  const lastFittedIdRef = React.useRef<string | null>(null);
  const lastFittedHadRouteRef = React.useRef(false);

  React.useEffect(() => {
    if (!map || !props.selectedId) return;
    const s = props.sessions.find((x) => x.sessionId === props.selectedId);
    if (!s) return;

    const routeSize = props.routeHistory?.length ?? 0;
    const selectionChanged = props.selectedId !== lastFittedIdRef.current;
    const routeJustAppeared =
      !selectionChanged &&
      routeSize > 1 &&
      !lastFittedHadRouteRef.current;

    if (!selectionChanged && !routeJustAppeared) {
      // Same driver, same data-availability state — don't touch the
      // user's pan/zoom.
      return;
    }

    const here = positionForSession(s, props.mode);
    const bounds = new google.maps.LatLngBounds();
    let added = 0;
    // Fit to the same outlier-filtered pings the polyline draws. Raw
    // routeHistory can contain GPS jumps that the polyline hides (and the
    // outlier badge counts) — letting those into the bounds drags the
    // camera to a different region than the pins.
    const cameraPoints = cameraPointsFor(props.routeHistory ?? []);
    for (const xy of cameraPoints) {
      bounds.extend(xy);
      added++;
    }
    // Include the driver's latest position only when it agrees with the
    // framed route. When a session carries a second GPS stream (device
    // pinging from a yard while the load tracks hundreds of km away),
    // the NEWEST ping — and therefore latestLocation — may be the
    // phantom; extending bounds to it would center the camera on the
    // empty land between the two and push every pin off-screen. With no
    // route yet, `here` is all we have and always wins.
    if (here) {
      const agreesWithRoute =
        cameraPoints.length < 2 ||
        cameraPoints.some(
          (p) =>
            haversineKm(p.lat, p.lng, here.lat, here.lng) <
            CLUSTER_RADIUS_KM,
        );
      if (agreesWithRoute) {
        bounds.extend(here);
        added++;
      }
    }

    if (added === 0) return;

    if (added === 1 && here) {
      map.setCenter(here);
      const z = map.getZoom() ?? DEFAULT_ZOOM;
      if (z < 11) map.setZoom(13);
    } else {
      map.fitBounds(bounds, 80);
      // Clamp on both ends after fitBounds:
      //   - If an outlier ping pulled us to country-level (zoom < 9), bump
      //     back to a reasonable city/region zoom (10).
      //   - If the route is tiny (a few hundred meters of yard pings) and
      //     fitBounds dropped us at building zoom (> 16), back off to 15.
      const after = map.getZoom();
      if (after != null) {
        if (after < 9) map.setZoom(10);
        else if (after > 16) map.setZoom(15);
      }
    }

    lastFittedIdRef.current = props.selectedId;
    lastFittedHadRouteRef.current = routeSize > 1;
  }, [
    map,
    props.selectedId,
    props.sessions,
    props.mode,
    props.routeHistory,
  ]);

  // ───── Focus-triggered re-fit ─────
  // Distinct from the auto-fit above: this fires when the dispatcher
  // explicitly clicks a trip's focus pin (or unfocuses). That's an
  // intentional user action, so reframing the camera is welcome —
  // unlike live-data updates where it would yank them around. When
  // focus is set: fit to that trip's pings. When focus clears: fit to
  // the whole route again.
  //
  // `routeHistory` and `selectedTrips` have to be in the dep array (the
  // fit reads them), but live queries hand back fresh arrays on every
  // fleet update — so the effect body must distinguish "focus changed"
  // from "data changed" itself. We track the last (selection, focus)
  // pair we fitted for and bail when the focus value is unchanged;
  // otherwise every live ping re-runs fitBounds and the camera keeps
  // snapping away from the pins the dispatcher is looking at.
  const lastFocusFitRef = React.useRef<{
    sel: string;
    focus: number | null;
  } | null>(null);
  React.useEffect(() => {
    if (!map || !props.selectedId) return;
    const focused = props.focusedTripIndex ?? null;
    const last = lastFocusFitRef.current;
    if (!last || last.sel !== props.selectedId) {
      // New selection — record the baseline without moving the camera.
      // The auto-fit-on-selection effect owns the first framing.
      lastFocusFitRef.current = { sel: props.selectedId, focus: focused };
      return;
    }
    if (last.focus === focused) return; // data update, not a focus click

    const route = props.routeHistory ?? [];
    const trips = props.selectedTrips ?? [];
    if (route.length < 2 || trips.length === 0) return;

    // Build the point set for the fit. Focused → only that leg's pings;
    // unfocused → all pings for the session. Either way, outlier pings
    // are dropped so the frame matches the drawn polyline + pins.
    let pool: MapPing[];
    if (focused == null) {
      pool = route;
    } else {
      const t = trips[focused];
      if (!t) return;
      const startMs = t.startedAt;
      if (startMs == null) return;
      const endMs = t.endedAt ?? Date.now();
      pool = route.filter(
        (p) =>
          p.loadId === t.loadId &&
          p.recordedAt >= startMs &&
          p.recordedAt <= endMs,
      );
      if (pool.length < 2) return; // no fit if the trip has < 2 valid pings
    }
    const points = cameraPointsFor(pool);
    if (points.length < 2) return;

    const bounds = new google.maps.LatLngBounds();
    points.forEach((p) => bounds.extend(p));
    map.fitBounds(bounds, 80);
    const after = map.getZoom();
    if (after != null) {
      if (after < 9) map.setZoom(10);
      else if (after > 16) map.setZoom(15);
    }
    // Record only after a successful fit — if the route hadn't loaded
    // yet when the focus pin was clicked, the next data update retries.
    lastFocusFitRef.current = { sel: props.selectedId, focus: focused };
    // Intentionally skip the lastFittedIdRef bookkeeping here — the
    // auto-fit-on-selection effect owns that flag. Focus fit is an
    // independent affordance triggered only by explicit user clicks.
  }, [
    map,
    props.focusedTripIndex,
    props.selectedId,
    props.selectedTrips,
    props.routeHistory,
  ]);

  // ───── Polyline for selected — segmented by LEG ─────
  // Walk the chronological ping stream, opening a new segment every time
  // the leg-index changes. A ping's leg-index is computed by time-
  // bracketing — we find the trip card whose [startedAt, endedAt] window
  // contains the ping's recordedAt (and whose loadId matches as a
  // sanity check).
  //
  // This is the fix for the "multi-leg load all looks like one color"
  // problem: a load with 3 legs (3 trip cards) would previously collapse
  // to whichever leg-index won the loadId→color map race. Now each leg
  // card lights up a different segment of the polyline, even when legs
  // share a loadId.
  //
  // Pings tagged with a loadId but recorded *after* that leg's endedAt
  // (driver forgot to check out, or a stale ping fired post-completion)
  // get treated as SESSION_ROUTE (gray) so the visual surfaces the
  // drift instead of silently misattributing it to the leg.
  //
  // Two paths:
  //   • FULL REBUILD — on selection change, pagination prepending older
  //     pings, sanitizer dropping previously-clean pings. Tears down all
  //     polylines + re-snaps every segment via the Roads API.
  //   • INCREMENTAL APPEND — when only new live pings landed at the end
  //     of routeHistory (DESC pagination + reverse → tail = newest), we
  //     just extend the matching polyline. No Roads API call. Visual
  //     cost: a small raw-line tail that doesn't snap to roads until
  //     the next full rebuild. Worth it: a 4h shift might add 100+
  //     pings live; snapping each time costs an API call.
  React.useEffect(() => {
    if (!map) return;

    if (
      !props.selectedId ||
      !props.routeHistory ||
      props.routeHistory.length < 2
    ) {
      // Tear down everything — no selection.
      for (const pl of polylinesRef.current) pl.setMap(null);
      polylinesRef.current = [];
      segmentsRef.current = [];
      prevRouteRef.current = null;
      prevTripsSigRef.current = null;
      setIsSnapping(false);
      emitOutlierCount(0, 'reset');
      return;
    }

    const trips = props.selectedTrips ?? [];

    // Live fleet queries emit a brand-new trips array on every reactive
    // update even when nothing about the selected driver changed. A full
    // teardown + re-snap on each of those makes the route (and the
    // snapping badge) flicker constantly. Skip when the inputs that
    // actually shape the polyline are unchanged.
    const tripsSig = trips
      .map((t) => `${t.loadId}:${t.startedAt}:${t.endedAt}:${t.status}`)
      .join('|');
    if (
      prevRouteRef.current === props.routeHistory &&
      prevTripsSigRef.current === tripsSig &&
      segmentsRef.current.length > 0
    ) {
      return;
    }
    prevTripsSigRef.current = tripsSig;

    const focusedLegIndex = props.focusedTripIndex ?? null;
    const SESSION_ROUTE_TONE = '#9BA3B4';

    // Opacity rule for the polyline + ping dots:
    //   • No focus (focusedLegIndex == null) → fully visible
    //   • Focus set, this leg matches         → fully visible
    //   • Focus set, this leg differs         → HIDDEN (opacity 0).
    //     The polyline / dots stay attached to the map so toggling
    //     focus off re-reveals them without a rebuild — but they're
    //     visually absent so the focused trip stands alone.
    // SESSION_ROUTE pings (legIndex === null) follow the same rule as
    // any non-matching leg — they're hidden in focus mode.
    const dimOpacity = 0; // hide non-focused entirely
    const fullOpacity = 0.92;
    const opacityForLeg = (legIndex: number | null): number => {
      if (focusedLegIndex == null) return fullOpacity;
      return legIndex === focusedLegIndex ? fullOpacity : dimOpacity;
    };

    // Map ping → leg index (or null for SESSION_ROUTE pings outside any
    // active leg window). Iterates trips in panel order so the first
    // matching leg wins; in practice each ping falls into at most one
    // leg's window so order doesn't matter.
    const nowMs = Date.now();
    const findLegIndex = (ping: MapPing): number | null => {
      if (!ping.loadId) return null;
      for (let i = 0; i < trips.length; i++) {
        const t = trips[i];
        // Leg must have actually gone ACTIVE — PENDING/CANCELED legs
        // have no startedAt and can't claim any pings.
        if (t.startedAt == null) continue;
        if (ping.loadId !== t.loadId) continue;
        const endMs = t.endedAt ?? nowMs;
        if (ping.recordedAt < t.startedAt) continue;
        if (ping.recordedAt > endMs) continue;
        return i;
      }
      return null;
    };

    const colorForLeg = (legIndex: number | null): string => {
      if (legIndex == null) return SESSION_ROUTE_TONE;
      const t = trips[legIndex];
      if (!t) return SESSION_ROUTE_TONE;
      if (t.status === 'CANCELED') return '#9BA3B4';
      return TRIP_PALETTE[legIndex % TRIP_PALETTE.length];
    };

    // ── INCREMENTAL APPEND path ──────────────────────────────────────
    // Detect "the prefix of routeHistory is unchanged and only the
    // tail is new". This is exactly the shape live-ping inflow takes:
    // existing pings stay in place, new pings appended at the end of
    // the chronological list.
    const prev = prevRouteRef.current;
    const incremental =
      prev !== null &&
      prev.length >= 2 &&
      props.routeHistory.length > prev.length &&
      props.routeHistory[prev.length - 1]?.recordedAt ===
        prev[prev.length - 1]?.recordedAt &&
      segmentsRef.current.length > 0;

    if (incremental) {
      const newTail = props.routeHistory.slice(prev!.length);
      // Sanitize the tail using the previous-last ping as the anchor
      // so a "first" tail ping that jumped from the prior known
      // location still gets flagged.
      const sanitizedTail = sanitizePings(
        [prev![prev!.length - 1], ...newTail],
        MAX_PLAUSIBLE_KMH,
      ).slice(1); // drop the anchor we prepended

      let lastSegment = segmentsRef.current[segmentsRef.current.length - 1];

      for (const ping of sanitizedTail) {
        const xy = new google.maps.LatLng(ping.latitude, ping.longitude);
        const pingLegIndex = findLegIndex(ping);
        const sameLeg = pingLegIndex === lastSegment.legIndex;
        const startNewSegment = !sameLeg || ping.breakBefore;
        if (startNewSegment) {
          const color = colorForLeg(pingLegIndex);
          const polyline = new google.maps.Polyline({
            map,
            // For leg handoffs (sameLeg === false, no break), seed the
            // new segment with the previous endpoint so the visual line
            // doesn't show a gap. For outlier breaks, deliberately don't.
            path:
              !ping.breakBefore && lastSegment.polyline.getPath().getLength() > 0
                ? [
                    lastSegment.polyline
                      .getPath()
                      .getAt(
                        lastSegment.polyline.getPath().getLength() - 1,
                      )!,
                    xy,
                  ]
                : [xy],
            strokeColor: color,
            strokeOpacity: opacityForLeg(pingLegIndex),
            strokeWeight: 4.5,
          });
          const newSeg = { legIndex: pingLegIndex, polyline, color };
          segmentsRef.current.push(newSeg);
          polylinesRef.current.push(polyline);
          lastSegment = newSeg;
        } else {
          // Push directly onto the existing polyline's path. Mutates
          // the MVCArray Google Maps redraws automatically.
          lastSegment.polyline.getPath().push(xy);
        }
      }

      // Update the outlier counter to include any new breaks
      const newBreaks = sanitizedTail.filter((p) => p.breakBefore).length;
      if (newBreaks > 0) emitOutlierCount(newBreaks, 'add');
      prevRouteRef.current = props.routeHistory;
      return;
    }

    // ── FULL REBUILD path ────────────────────────────────────────────
    for (const pl of polylinesRef.current) pl.setMap(null);
    polylinesRef.current = [];
    segmentsRef.current = [];
    setIsSnapping(false);

    // Filter out outlier pings before drawing. A ping that implies > 150
    // mph from the previous ping is almost certainly a GPS error (sub-3m
    // accuracy spike) or stale test data — drawing a line through it
    // produces the spoke-pattern we used to see fanning out across the
    // map. We don't drop the ping outright; we just start a fresh segment
    // at it so the chord through nothing is never drawn.
    const cleanedPings = sanitizePings(props.routeHistory, MAX_PLAUSIBLE_KMH);

    // Slice the ping stream into runs of equal leg-index. Pings that
    // don't fall inside any leg's [startedAt, endedAt] window get
    // legIndex=null and color into the neutral SESSION_ROUTE polyline.
    type Segment = {
      color: string;
      legIndex: number | null;
      path: google.maps.LatLngLiteral[];
    };
    const segments: Segment[] = [];
    let current: Segment | null = null;
    let prevLegIndex: number | null | undefined = undefined; // start sentinel

    for (const ping of cleanedPings) {
      const xy = { lat: ping.latitude, lng: ping.longitude };
      const legIndex = findLegIndex(ping);
      // A `break` flag from the sanitizer means "don't connect to the
      // previous point" — treat it like a leg handoff and start a new
      // segment with the same color (the leg-index didn't change).
      if (legIndex !== prevLegIndex || ping.breakBefore) {
        // Flush prior segment + start a new one. For genuine leg
        // handoffs (not jump breaks), push the new segment's first point
        // as the previous segment's last so they visually connect.
        if (current && current.path.length > 0 && !ping.breakBefore) {
          current.path.push(xy);
        }
        current = {
          color: colorForLeg(legIndex),
          legIndex,
          path: [xy],
        };
        segments.push(current);
        prevLegIndex = legIndex;
      } else {
        current!.path.push(xy);
      }
    }

    // Reset & emit the outlier count for the new full state.
    const outlierBreaks = cleanedPings.filter((p) => p.breakBefore).length;
    emitOutlierCount(outlierBreaks, 'reset');

    // Dev-only diagnostics: tells you why a trip might be missing from
    // the map (no pings fell inside its time window, segment too short
    // to draw, outlier filter shredded the path, etc.).
    if (process.env.NODE_ENV === 'development') {
      const byLeg: Record<string, number> = {};
      for (const p of cleanedPings) {
        const idx = findLegIndex(p);
        const key = idx == null ? 'SESSION_ROUTE' : `leg[${idx}]`;
        byLeg[key] = (byLeg[key] ?? 0) + 1;
      }
      const drops = cleanedPings.filter((p) => p.breakBefore).length;
      const segCounts = segments.map((s) => ({
        legIndex: s.legIndex,
        pings: s.path.length,
      }));
      // eslint-disable-next-line no-console
      console.debug(
        '[SessionMap] polyline render',
        {
          totalPings: props.routeHistory?.length ?? 0,
          afterSanitize: cleanedPings.length,
          outlierBreaks: drops,
          pingsByLegIndex: byLeg,
          tripsInPanel: trips.map((t, i) => ({
            legIndex: i,
            loadId: t.loadId,
            loadInternalId: t.loadInternalId,
            status: t.status,
            window: [t.startedAt, t.endedAt],
          })),
          segmentCount: segments.length,
          segmentPathLengths: segCounts,
        }
      );
    }

    // Two-pass rendering: draw the raw segments immediately (so the map
    // is never empty), then kick off snapToRoads in the background. When
    // each chunk resolves, swap its raw polyline for the snapped one. If
    // the API errors / returns the input verbatim, the raw polyline
    // stays — same visual result, no flicker.
    const drawables: Array<{
      seg: Segment;
      raw: google.maps.Polyline;
    }> = [];
    for (const seg of segments) {
      if (seg.path.length < 2) continue;
      // Pre-snap opacity: focused segment slightly muted (0.55) to
      // signal "snapping in progress", non-focused segments dim (0.18).
      // Once snap completes (or fails) the post-snap setOptions below
      // bumps focused segments to full opacity.
      const preSnap = opacityForLeg(seg.legIndex);
      const initial =
        focusedLegIndex == null
          ? 0.55
          : seg.legIndex === focusedLegIndex
            ? 0.55
            : preSnap; // dim non-focused stays dim
      const raw = new google.maps.Polyline({
        map,
        path: seg.path,
        strokeColor: seg.color,
        strokeOpacity: initial,
        strokeWeight: 4.5,
      });
      drawables.push({ seg, raw });
      polylinesRef.current.push(raw);
      // Track per-segment metadata for incremental updates: next time a
      // live ping arrives we look up the segment by legIndex and push
      // to its path directly.
      segmentsRef.current.push({
        legIndex: seg.legIndex,
        polyline: raw,
        color: seg.color,
      });
    }

    // Snapshot the routeHistory we just fully drew — future re-runs
    // compare against this to decide if they qualify as incremental.
    prevRouteRef.current = props.routeHistory;

    // Snap asynchronously. Effect cleanup cancels stale snaps so a
    // rapid selection change doesn't draw last-driver's lines on top of
    // current-driver's map.
    let cancelled = false;
    if (drawables.length > 0) {
      setIsSnapping(true);
      Promise.all(
        drawables.map(async ({ seg, raw }) => {
          const snapped = await snapPathToRoads(
            seg.path.map((p) => ({ latitude: p.lat, longitude: p.lng })),
            apiKey,
          );
          if (cancelled) return;
          // Roads API returns the raw input on error → no swap needed.
          if (snapped.length >= 2) {
            raw.setPath(
              snapped.map((p) => ({ lat: p.latitude, lng: p.longitude })),
            );
          }
          // Bump to final opacity. Read focus through the LIVE ref so a
          // pin toggled while snap was in flight isn't clobbered by the
          // stale closure value from when this effect first ran.
          const currentFocus = focusedTripIndexRef.current;
          const finalOp =
            currentFocus == null
              ? 0.92
              : seg.legIndex === currentFocus
                ? 0.92
                : 0;
          raw.setOptions({ strokeOpacity: finalOp });
        }),
      ).finally(() => {
        if (!cancelled) setIsSnapping(false);
      });
    }

    return () => {
      cancelled = true;
    };
  }, [
    map,
    props.selectedId,
    props.routeHistory,
    props.selectedTrips,
    apiKey,
    setIsSnapping,
    emitOutlierCount,
    // NOTE: props.focusedTripIndex is intentionally NOT in this dep
    // array. Focus changes shouldn't tear down + re-snap every polyline
    // — that would burn Roads API calls just to dim a line. The
    // separate effect below mutates opacity in place instead.
    // props.sessions / props.mode are likewise absent: the effect never
    // reads them, and props.sessions changes identity on every reactive
    // fleet update.
  ]);

  // ───── Focus-mode opacity update ─────
  // When the user toggles a trip's focus pin, walk segmentsRef and
  // adjust each polyline's strokeOpacity to match. Non-focused segments
  // go to opacity 0 — fully hidden — so only the chosen trip shows on
  // the map. Cheap mutation, no rebuild, no re-snap.
  React.useEffect(() => {
    const focused = props.focusedTripIndex ?? null;
    for (const seg of segmentsRef.current) {
      const op =
        focused == null
          ? 0.92
          : seg.legIndex === focused
            ? 0.92
            : 0; // hide non-focused
      seg.polyline.setOptions({ strokeOpacity: op });
    }
  }, [props.focusedTripIndex]);

  // ───── Render markers ─────
  // Reusable leg-attribution helper for the ping-dot overlay. Same
  // rules as the polyline coloring above — keeps the visual story
  // consistent (a dot's color matches the polyline segment it sits on).
  const trips = props.selectedTrips ?? [];
  const nowMsForDots = Date.now();
  const findLegIndexForDot = (ping: MapPing): number | null => {
    if (!ping.loadId) return null;
    for (let i = 0; i < trips.length; i++) {
      const t = trips[i];
      if (t.startedAt == null) continue;
      if (ping.loadId !== t.loadId) continue;
      const endMs = t.endedAt ?? nowMsForDots;
      if (ping.recordedAt < t.startedAt) continue;
      if (ping.recordedAt > endMs) continue;
      return i;
    }
    return null;
  };

  // Per-trip polyline endpoints. For each leg we walk the chronological
  // ping stream and capture the FIRST ping that falls inside the leg's
  // window (green start pin) and the LAST one (red end pin). PENDING
  // legs (no startedAt yet) get null endpoints. Active legs get a
  // start but no end (the live driver avatar takes the "current
  // position" role). The map renders these instead of session-level
  // yard pins so each trip card maps clearly to its own bookends.
  const tripEndpoints = React.useMemo(() => {
    const route = props.routeHistory ?? [];
    const nowMs = Date.now();
    return trips.map((trip) => {
      let start: { latitude: number; longitude: number } | null = null;
      let end: { latitude: number; longitude: number } | null = null;
      if (trip.startedAt == null) return { start, end };
      const endMs = trip.endedAt ?? nowMs;
      for (const ping of route) {
        if (ping.loadId !== trip.loadId) continue;
        if (ping.recordedAt < trip.startedAt) continue;
        if (ping.recordedAt > endMs) continue;
        if (!start) start = { latitude: ping.latitude, longitude: ping.longitude };
        end = { latitude: ping.latitude, longitude: ping.longitude };
      }
      return { start, end };
    });
  }, [trips, props.routeHistory]);

  // Render one trip's bookends. Hidden when focus is set on a different
  // trip. End pin is only rendered for completed trips — for ACTIVE
  // ones the driver pin (avatar) is the natural "current" anchor and
  // adding a red pin would suggest the trip is done.
  const renderTripEndpoints = (sessionId: string, driverName: string) => {
    const focused = props.focusedTripIndex ?? null;
    return trips.flatMap((trip, i) => {
      if (focused != null && focused !== i) return [];
      const ep = tripEndpoints[i];
      if (!ep) return [];
      const nodes: React.ReactNode[] = [];
      if (ep.start) {
        nodes.push(
          <AdvancedMarker
            key={`${sessionId}-trip-${i}-start`}
            position={{ lat: ep.start.latitude, lng: ep.start.longitude }}
            zIndex={500}
          >
            <YardPin
              kind="start"
              label={`${driverName} · Trip ${i + 1}`}
              timeLabel={hhmm(trip.startedAt ?? 0)}
            />
          </AdvancedMarker>,
        );
      }
      // End pin only when the trip has actually completed. Active legs
      // (no endedAt) intentionally omit it — the live avatar marker
      // serves that visual role.
      if (ep.end && trip.endedAt != null && trip.status !== 'ACTIVE') {
        nodes.push(
          <AdvancedMarker
            key={`${sessionId}-trip-${i}-end`}
            position={{ lat: ep.end.latitude, lng: ep.end.longitude }}
            zIndex={500}
          >
            <YardPin
              kind="end"
              label={`${driverName} · Trip ${i + 1}`}
              timeLabel={hhmm(trip.endedAt)}
            />
          </AdvancedMarker>,
        );
      }
      return nodes;
    });
  };

  if (props.mode === 'live') {
    const selectedSession = props.selectedId
      ? props.sessions.find((s) => s.sessionId === props.selectedId)
      : null;

    return (
      <>
        {props.sessions.map((s) => {
          const xy = positionForSession(s, 'live');
          if (!xy) return null;
          return (
            <AdvancedMarker
              key={s.sessionId}
              position={xy}
              ref={(m) => registerMarker(s.sessionId, m)}
              onClick={() => props.onSelectDriver(s.sessionId)}
              zIndex={s.sessionId === props.selectedId ? 1000 : 100}
            >
              <LiveDriverPin
                session={s}
                selected={s.sessionId === props.selectedId}
              />
            </AdvancedMarker>
          );
        })}
        {props.selectedId && <SelectedDriverPulse {...props} />}
        {selectedSession &&
          renderTripEndpoints(
            selectedSession.sessionId,
            selectedSession.driverName,
          )}
        {props.showPings && props.routeHistory && selectedSession && (
          <PingDotsLayer
            pings={props.routeHistory}
            trips={trips}
            findLegIndex={findLegIndexForDot}
            sessionStartedAt={selectedSession.startedAt}
            sessionEndedAt={null /* live = no endedAt yet */}
            focusedTripIndex={props.focusedTripIndex ?? null}
          />
        )}
        {props.hoveredPing && selectedSession && (
          <HoveredPingHighlight
            latitude={props.hoveredPing.latitude}
            longitude={props.hoveredPing.longitude}
          />
        )}
      </>
    );
  }

  // Past mode:
  //   • No driver selected → render session-level bookend pins for
  //     EVERY past session in the day. That's the overview map — at a
  //     glance the dispatcher sees where each shift began and ended.
  //   • Driver selected → drop the overview, render PER-TRIP bookend
  //     pins for the selected driver. Each trip's polyline gets its
  //     own green start + red end pin (matching the focus rules).
  const selectedPast = props.selectedId
    ? props.sessions.find((s) => s.sessionId === props.selectedId)
    : null;

  return (
    <>
      {!selectedPast &&
        props.sessions.flatMap((s) => {
          const pins: React.ReactNode[] = [];
          if (s.startLocation) {
            pins.push(
              <AdvancedMarker
                key={`${s.sessionId}-start`}
                position={{
                  lat: s.startLocation.latitude,
                  lng: s.startLocation.longitude,
                }}
                ref={(m) => registerMarker(`${s.sessionId}-start`, m)}
                onClick={() => props.onSelectDriver(s.sessionId)}
              >
                <YardPin
                  kind="start"
                  label={s.driverName}
                  timeLabel={hhmm(s.startedAt)}
                />
              </AdvancedMarker>,
            );
          }
          if (s.endLocation) {
            pins.push(
              <AdvancedMarker
                key={`${s.sessionId}-end`}
                position={{
                  lat: s.endLocation.latitude,
                  lng: s.endLocation.longitude,
                }}
                ref={(m) => registerMarker(`${s.sessionId}-end`, m)}
                onClick={() => props.onSelectDriver(s.sessionId)}
              >
                <YardPin
                  kind="end"
                  label={s.driverName}
                  timeLabel={s.endedAt ? hhmm(s.endedAt) : '…'}
                />
              </AdvancedMarker>,
            );
          }
          return pins;
        })}
      {selectedPast &&
        renderTripEndpoints(selectedPast.sessionId, selectedPast.driverName)}
      {props.showPings && props.routeHistory && selectedPast && (
        <PingDotsLayer
          pings={props.routeHistory}
          trips={trips}
          findLegIndex={findLegIndexForDot}
          sessionStartedAt={selectedPast.startedAt}
          sessionEndedAt={selectedPast.endedAt}
          focusedTripIndex={props.focusedTripIndex ?? null}
        />
      )}
      {props.hoveredPing && selectedPast && (
        <HoveredPingHighlight
          latitude={props.hoveredPing.latitude}
          longitude={props.hoveredPing.longitude}
        />
      )}
    </>
  );
}

// ─────────────────────────────────────────────────────────────────────────
// PingDotsLayer — debug overlay rendering each ping as a small dot.
//
// Color matches the polyline coloring: per-leg palette index, gray for
// pings outside any leg's window (SESSION_ROUTE). Pings that fall OUTSIDE
// the session's shift window (before startedAt, after endedAt) get a
// hollow ring instead of a filled dot so off-shift drift is visually
// unmistakable.
//
// Hover tooltip is the native HTML `title` attribute — keeps the
// component cheap to render at 1000+ dots. Click also routes through to
// the title so dispatchers can read the data quickly.
// ─────────────────────────────────────────────────────────────────────────

interface PingDotsLayerProps {
  pings: MapPing[];
  trips: TripInfo[];
  findLegIndex: (ping: MapPing) => number | null;
  sessionStartedAt: number;
  sessionEndedAt: number | null;
  /** When set, dots whose legIndex !== this dim out. null = show all. */
  focusedTripIndex: number | null;
}

function PingDotsLayer({
  pings,
  trips,
  findLegIndex,
  sessionStartedAt,
  sessionEndedAt,
  focusedTripIndex,
}: PingDotsLayerProps) {
  // Cap to a reasonable number of dots for performance. AdvancedMarker
  // is fine at ~1000; past that the map starts hitching during pan.
  const MAX_DOTS = 1500;
  const stride = Math.max(1, Math.ceil(pings.length / MAX_DOTS));

  const effEnd = sessionEndedAt ?? Date.now();

  return (
    <>
      {pings.map((ping, idx) => {
        if (idx % stride !== 0) return null; // decimate
        const legIndex = findLegIndex(ping);
        const offShift =
          ping.recordedAt < sessionStartedAt || ping.recordedAt > effEnd;
        const color =
          legIndex == null
            ? '#9BA3B4'
            : trips[legIndex]?.status === 'CANCELED'
              ? '#9BA3B4'
              : TRIP_PALETTE[legIndex % TRIP_PALETTE.length];
        const hiddenByFocus =
          focusedTripIndex != null && legIndex !== focusedTripIndex;
        // Skip marker entirely instead of rendering a hidden one —
        // saves AdvancedMarker DOM nodes when focus is set on a fleet
        // with many trips and lots of pings.
        if (hiddenByFocus) return null;
        const label = describePing(
          ping,
          legIndex,
          trips,
          sessionStartedAt,
          effEnd,
        );
        return (
          <AdvancedMarker
            key={`ping-${ping.recordedAt}-${idx}`}
            position={{ lat: ping.latitude, lng: ping.longitude }}
            zIndex={50}
          >
            <PingDot color={color} hollow={offShift} title={label} />
          </AdvancedMarker>
        );
      })}
    </>
  );
}

function PingDot({
  color,
  hollow,
  title,
}: {
  color: string;
  hollow: boolean;
  title: string;
}) {
  return (
    <div
      title={title}
      style={{
        width: 9,
        height: 9,
        borderRadius: '50%',
        background: hollow ? 'transparent' : color,
        border: `2px solid ${color}`,
        boxShadow: '0 0 0 1px rgba(255,255,255,0.7)',
        cursor: 'help',
      }}
    />
  );
}

/**
 * Build a hover-tooltip string for a ping. Includes the calendar time,
 * leg attribution (or "SESSION_ROUTE"), pre/in/post-shift bucket, and
 * speed if available. The dispatcher reads this to verify whether a
 * suspicious dot belongs where it is.
 */
function describePing(
  ping: MapPing,
  legIndex: number | null,
  trips: TripInfo[],
  sessionStartedAt: number,
  sessionEndedAt: number,
): string {
  const t = new Date(ping.recordedAt);
  const hh = String(t.getHours()).padStart(2, '0');
  const mm = String(t.getMinutes()).padStart(2, '0');
  const ss = String(t.getSeconds()).padStart(2, '0');
  const time = `${hh}:${mm}:${ss}`;

  let where: string;
  if (legIndex != null) {
    const t = trips[legIndex];
    where = `Trip ${legIndex + 1}${t ? ` · #${t.loadInternalId}` : ''}`;
  } else if (ping.loadId) {
    where = `Off-leg (loadId stamped, but recorded outside any leg window)`;
  } else {
    where = 'Session route (between loads)';
  }

  let bucket: string;
  if (ping.recordedAt < sessionStartedAt) {
    const minutesEarly = Math.round(
      (sessionStartedAt - ping.recordedAt) / 60_000,
    );
    bucket = `BEFORE shift start (${minutesEarly} min early)`;
  } else if (ping.recordedAt > sessionEndedAt) {
    const minutesLate = Math.round(
      (ping.recordedAt - sessionEndedAt) / 60_000,
    );
    bucket = `AFTER shift end (${minutesLate} min late)`;
  } else {
    bucket = 'During shift';
  }

  const speedLabel =
    ping.speed != null
      ? ping.speed > 0
        ? `${Math.round(ping.speed)} mph`
        : 'stopped'
      : 'unknown';
  return `${time}\n${where}\n${bucket}\nSpeed: ${speedLabel}`;
}

// ─────────────────────────────────────────────────────────────────────────
// HoveredPingHighlight — marks the ping whose row the dispatcher is
// hovering in the activity panel. A solid dot on the exact coordinate
// plus a pulsing halo so it stands out over the polyline even at fleet
// zoom. Non-clickable — it's a transient echo of the list hover, not an
// interaction target.
// ─────────────────────────────────────────────────────────────────────────

function HoveredPingHighlight({
  latitude,
  longitude,
}: {
  latitude: number;
  longitude: number;
}) {
  return (
    <AdvancedMarker
      position={{ lat: latitude, lng: longitude }}
      zIndex={1300}
      clickable={false}
    >
      {/* Zero-size wrapper so the marker anchor IS the coordinate;
          halo + dot center themselves on it via translate. */}
      <div style={{ position: 'relative', width: 0, height: 0 }}>
        <span
          style={{
            position: 'absolute',
            left: 0,
            top: 0,
            width: 34,
            height: 34,
            borderRadius: '50%',
            background: '#2E5CFF',
            opacity: 0.2,
            transform: 'translate(-50%, -50%)',
            animation: 'sessionPulse 1.6s ease-out infinite',
          }}
        />
        <span
          style={{
            position: 'absolute',
            left: 0,
            top: 0,
            width: 12,
            height: 12,
            borderRadius: '50%',
            background: '#2E5CFF',
            border: '2px solid #FFFFFF',
            transform: 'translate(-50%, -50%)',
            boxShadow: '0 1px 4px rgba(15,22,36,0.35)',
          }}
        />
      </div>
    </AdvancedMarker>
  );
}

// ─────────────────────────────────────────────────────────────────────────
// SelectedDriverPulse — pulsing halo behind the live driver's pin. Rendered
// as a separate AdvancedMarker so it can sit one z-index below the avatar.
// ─────────────────────────────────────────────────────────────────────────

function SelectedDriverPulse({ sessions, selectedId, mode }: LiveProps) {
  if (mode !== 'live' || !selectedId) return null;
  const s = sessions.find((x) => x.sessionId === selectedId);
  if (!s || !s.latestLocation) return null;
  const color = avatarColorForId(s.driverId);
  return (
    <AdvancedMarker
      position={{
        lat: s.latestLocation.latitude,
        lng: s.latestLocation.longitude,
      }}
      zIndex={900}
      clickable={false}
    >
      <span
        style={{
          display: 'block',
          width: 56,
          height: 56,
          borderRadius: '50%',
          background: color,
          opacity: 0.18,
          transform: 'translate(-50%, -50%)',
          animation: 'sessionPulse 2.4s ease-out infinite',
        }}
      />
    </AdvancedMarker>
  );
}

// ─────────────────────────────────────────────────────────────────────────
// Pin nodes — plain JSX (rendered into AdvancedMarker.content via portal)
// ─────────────────────────────────────────────────────────────────────────

function LiveDriverPin({
  session,
  selected,
}: {
  session: LiveSessionRow;
  selected: boolean;
}) {
  const avatar = avatarColorForId(session.driverId);
  const tone = STATUS_TONE[session.status].color;
  const initials = initialsForName(session.driverName);
  const size = selected ? 40 : 34;
  return (
    <div
      style={{
        position: 'relative',
        width: size,
        height: size,
        filter:
          'drop-shadow(0 3px 6px rgba(15,22,36,0.25)) drop-shadow(0 1px 2px rgba(15,22,36,0.10))',
      }}
    >
      <div
        style={{
          width: size,
          height: size,
          borderRadius: '50%',
          background: avatar,
          border: '2.5px solid #FFFFFF',
          color: '#FFFFFF',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          fontFamily: 'Saira, system-ui, sans-serif',
          fontSize: selected ? 13 : 11,
          fontWeight: 600,
        }}
      >
        {initials}
      </div>
      {/* Status dot */}
      <span
        style={{
          position: 'absolute',
          right: -1,
          top: -1,
          width: 11,
          height: 11,
          borderRadius: '50%',
          background: tone,
          border: '2px solid #FFFFFF',
        }}
      />
      {/* Alert dot */}
      {session.incidents > 0 && (
        <span
          style={{
            position: 'absolute',
            left: -2,
            top: -2,
            width: 11,
            height: 11,
            borderRadius: '50%',
            background: '#EF4444',
            border: '2px solid #FFFFFF',
            color: '#FFFFFF',
            fontFamily: 'Saira, system-ui, sans-serif',
            fontSize: 9,
            fontWeight: 700,
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
          }}
        >
          {session.incidents}
        </span>
      )}
    </div>
  );
}

function YardPin({
  kind,
  label,
  timeLabel,
}: {
  kind: 'start' | 'end';
  label: string;
  timeLabel: string;
}) {
  const color = kind === 'start' ? '#22B07D' : '#EF4444';
  return (
    <div
      title={`${label} · ${kind === 'start' ? 'shift start' : 'shift end'} ${timeLabel}`}
      style={{
        position: 'relative',
        width: 22,
        height: 22,
        filter: 'drop-shadow(0 2px 4px rgba(15,22,36,0.22))',
      }}
    >
      <div
        style={{
          width: 22,
          height: 22,
          borderRadius: '50%',
          background: '#FFFFFF',
          border: `3px solid ${color}`,
        }}
      />
      <div
        style={{
          position: 'absolute',
          top: 6,
          left: 6,
          width: 10,
          height: 10,
          borderRadius: '50%',
          background: color,
        }}
      />
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────────────
// helpers
// ─────────────────────────────────────────────────────────────────────────

/**
 * Drop GPS outliers from the ping stream and return them annotated with
 * `breakBefore` where the polyline should NOT connect to the previous
 * point. A ping implying >`maxKmh` from its predecessor is treated as
 * suspicious; we keep the ping itself but flag it so the polyline starts
 * a fresh segment there. This stops the "fan of straight lines through
 * mountains" look caused by ping coords that briefly jump to bogus
 * locations (GPS lock noise, simulator pings, etc.).
 *
 * The implied-speed check uses the elapsed time between consecutive
 * pings — if a driver sat still 4h and then a single ping landed 1000km
 * away, that's `1000 / 4` = 250 km/h, which trips the guard even though
 * the ping is "recent".
 */
function sanitizePings(
  pings: MapPing[],
  maxKmh: number
): Array<MapPing & { breakBefore?: boolean }> {
  if (pings.length === 0) return [];
  const out: Array<MapPing & { breakBefore?: boolean }> = [pings[0]];
  for (let i = 1; i < pings.length; i++) {
    const prev = pings[i - 1];
    const curr = pings[i];
    const distKm = haversineKm(
      prev.latitude,
      prev.longitude,
      curr.latitude,
      curr.longitude
    );
    const hours = Math.max((curr.recordedAt - prev.recordedAt) / 3600_000, 1 / 3600); // 1s floor
    const speedKmh = distKm / hours;
    if (speedKmh > maxKmh) {
      out.push({ ...curr, breakBefore: true });
    } else {
      out.push(curr);
    }
  }
  return out;
}

/**
 * Points the camera is allowed to fit to. Three filters, all aimed at
 * one rule: the camera frames what the map actually shows, nothing else.
 *
 *   1. Same outlier flagging as the polyline (>150 mph jumps).
 *   2. Group pings into the runs the polyline draws (a `breakBefore`
 *      flag starts a new run) and drop single-ping runs — a 1-point
 *      path never renders. This also covers a bogus FIRST ping: the
 *      sanitizer can't flag it (no predecessor), but it strands itself
 *      in a singleton run and gets dropped here all the same.
 *   3. Cluster the surviving runs spatially and keep only the DOMINANT
 *      cluster. This is the defense against a sustained second GPS
 *      stream on one session — e.g. the load tracking down I-5 while a
 *      second device pings from a yard 400 km away. Those phantom pings
 *      arrive in groups, so they survive the singleton filter as "real"
 *      runs; fitting bounds across both regions centers the camera on
 *      the empty land between them and puts every pin off-screen.
 *      Majority of pings wins; the minority cluster still shows in the
 *      outlier badge + ping-dots debug overlay, it just can't steal
 *      the frame.
 *
 * Falls back to the raw list when filtering would leave fewer than 2
 * points — better a shaky frame than no frame.
 */
function cameraPointsFor(pings: MapPing[]): google.maps.LatLngLiteral[] {
  if (pings.length === 0) return [];
  const flagged = sanitizePings(pings, MAX_PLAUSIBLE_KMH);

  type Run = Array<MapPing & { breakBefore?: boolean }>;
  const runs: Run[] = [];
  let run: Run = [];
  for (const p of flagged) {
    if (p.breakBefore && run.length > 0) {
      runs.push(run);
      run = [];
    }
    run.push(p);
  }
  if (run.length > 0) runs.push(run);

  const drawn = runs.filter((r) => r.length >= 2);
  if (drawn.length === 0) {
    return flagged.map((p) => ({ lat: p.latitude, lng: p.longitude }));
  }

  const kept = dominantCluster(drawn).flat();
  const source = kept.length >= 2 ? kept : flagged;
  return source.map((p) => ({ lat: p.latitude, lng: p.longitude }));
}

/**
 * Union runs that pass within CLUSTER_RADIUS_KM of each other (compared
 * via run endpoints — runs are split only at implausible jumps, so a
 * genuine long-haul route stays one run and never gets carved up) and
 * return the cluster holding the most pings. A tie or a single cluster
 * degrades gracefully to "everything".
 */
const CLUSTER_RADIUS_KM = 100;
function dominantCluster<T extends MapPing>(runs: T[][]): T[][] {
  const n = runs.length;
  if (n <= 1) return runs;
  const endpoints = (r: T[]): T[] => [r[0], r[r.length - 1]];
  const near = (a: T[], b: T[]): boolean => {
    for (const p of endpoints(a))
      for (const q of endpoints(b))
        if (
          haversineKm(p.latitude, p.longitude, q.latitude, q.longitude) <
          CLUSTER_RADIUS_KM
        )
          return true;
    return false;
  };
  // Tiny union-find — run counts are dozens at most.
  const parent = Array.from({ length: n }, (_, i) => i);
  const find = (i: number): number => {
    while (parent[i] !== i) {
      parent[i] = parent[parent[i]];
      i = parent[i];
    }
    return i;
  };
  for (let i = 0; i < n; i++)
    for (let j = i + 1; j < n; j++)
      if (near(runs[i], runs[j])) parent[find(i)] = find(j);

  const byRoot = new Map<number, T[][]>();
  runs.forEach((r, i) => {
    const root = find(i);
    const list = byRoot.get(root) ?? [];
    list.push(r);
    byRoot.set(root, list);
  });
  let best: T[][] = [];
  let bestCount = -1;
  for (const cluster of byRoot.values()) {
    const count = cluster.reduce((sum, r) => sum + r.length, 0);
    if (count > bestCount) {
      bestCount = count;
      best = cluster;
    }
  }
  return best;
}

function haversineKm(
  lat1: number,
  lon1: number,
  lat2: number,
  lon2: number
): number {
  const R = 6371;
  const toRad = (d: number) => (d * Math.PI) / 180;
  const dLat = toRad(lat2 - lat1);
  const dLon = toRad(lon2 - lon1);
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLon / 2) ** 2;
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

function positionForSession(
  s: LiveSessionRow | PastSessionRow,
  mode: 'live' | 'past'
): google.maps.LatLngLiteral | null {
  if (mode === 'live') {
    const live = s as LiveSessionRow;
    if (!live.latestLocation) return null;
    return {
      lat: live.latestLocation.latitude,
      lng: live.latestLocation.longitude,
    };
  }
  const past = s as PastSessionRow;
  // Past mode: prefer end yard, fall back to start
  const loc = past.endLocation ?? past.startLocation;
  if (!loc) return null;
  return { lat: loc.latitude, lng: loc.longitude };
}

function hhmm(ms: number): string {
  const d = new Date(ms);
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
}

function MapError({ message }: { message: string }) {
  return (
    <div
      className="flex h-full w-full items-center justify-center"
      style={{ background: 'var(--bg-canvas)' }}
    >
      <div className="max-w-xs text-center">
        <div
          className="mx-auto mb-3 flex h-12 w-12 items-center justify-center rounded-xl"
          style={{
            background: 'var(--bg-surface)',
            color: 'var(--text-tertiary)',
            boxShadow: '0 2px 8px -4px rgba(15,22,36,0.18)',
            border: '1px solid var(--border-hairline)',
          }}
        >
          <span className="text-[20px]">⚠</span>
        </div>
        <div
          className="text-[14px] font-semibold"
          style={{ color: 'var(--text-primary)' }}
        >
          Map couldn't load
        </div>
        <div
          className="mt-1 text-[12px]"
          style={{ color: 'var(--text-secondary)' }}
        >
          {message}
        </div>
      </div>
    </div>
  );
}
