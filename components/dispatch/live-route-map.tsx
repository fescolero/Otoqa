'use client';

import { useMemo, useEffect, useState, useCallback, useRef } from 'react';
import { useQuery, useAction } from 'convex/react';
import { api } from '@/convex/_generated/api';
import { Id } from '@/convex/_generated/dataModel';
import {
  APIProvider,
  Map,
  useMap,
  useMapsLibrary,
  AdvancedMarker,
} from '@vis.gl/react-google-maps';
import { cn } from '@/lib/utils';
import { MapPin, Clock, Route, Navigation, CheckCircle2 } from 'lucide-react';
import { format } from 'date-fns';

// ============================================
// POLYLINE DECODERS
// ============================================

// Decode Google's polyline5 format (precision 1e5)
function decodePolyline(encoded: string): Array<{ latitude: number; longitude: number }> {
  return decodePolylineWithPrecision(encoded, 1e5);
}

// Decode Mapbox's polyline6 format (precision 1e6)
function decodePolyline6(encoded: string): Array<{ latitude: number; longitude: number }> {
  return decodePolylineWithPrecision(encoded, 1e6);
}

// Generic polyline decoder with configurable precision
function decodePolylineWithPrecision(
  encoded: string, 
  precision: number
): Array<{ latitude: number; longitude: number }> {
  const points: Array<{ latitude: number; longitude: number }> = [];
  let index = 0;
  let lat = 0;
  let lng = 0;

  while (index < encoded.length) {
    let shift = 0;
    let result = 0;
    let byte: number;

    do {
      byte = encoded.charCodeAt(index++) - 63;
      result |= (byte & 0x1f) << shift;
      shift += 5;
    } while (byte >= 0x20);

    const dlat = result & 1 ? ~(result >> 1) : result >> 1;
    lat += dlat;

    shift = 0;
    result = 0;

    do {
      byte = encoded.charCodeAt(index++) - 63;
      result |= (byte & 0x1f) << shift;
      shift += 5;
    } while (byte >= 0x20);

    const dlng = result & 1 ? ~(result >> 1) : result >> 1;
    lng += dlng;

    points.push({
      latitude: lat / precision,
      longitude: lng / precision,
    });
  }

  return points;
}

// ============================================
// LIVE ROUTE MAP - REFINED
// Mission-control style route tracking:
// - Clean navigation map style
// - GPS trail following actual path
// - Status-based stop markers
// - Directional driver arrow
// - Geofence visualization
// - Manifest-map sync
// ============================================

// Note: Map styling is controlled via Google Cloud Console when using mapId
// To customize styles, go to: https://console.cloud.google.com/google/maps-platform/styling
// Create a Map Style and associate it with mapId "live-route-map"

// Geofence radius in meters (for visualization)
const GEOFENCE_RADIUS_METERS = 150;

interface StopData {
  id?: string;
  lat: number;
  lng: number;
  type: 'pickup' | 'delivery';
  sequenceNumber: number;
  status?: 'Pending' | 'In Transit' | 'Completed';
  city?: string;
  state?: string;
  scheduledTime?: string;
}

interface LiveRouteMapProps {
  loadId: Id<'loadInformation'>;
  organizationId: string;
  driverId?: Id<'drivers'> | null;
  height?: string;
  stops?: StopData[];
  selectedStopId?: string | null;
  onStopSelect?: (stopId: string | null) => void;
}

interface LocationPoint {
  latitude: number;
  longitude: number;
  speed?: number;
  heading?: number;
  recordedAt: number;
}

// ============================================
// ROUTE POLYLINE - Premium styling with snap-to-road
// Features:
// - Shadow/glow layer for depth
// - Round joins and caps for smooth curves
// - Directional arrows along path
// - History fade (older = more transparent)
// ============================================
function RoutePolylineRenderer({ 
  points,
  snappedPoints,
  liveLocation,
}: { 
  points: LocationPoint[];
  snappedPoints?: Array<{ latitude: number; longitude: number }>;
  liveLocation?: { latitude: number; longitude: number } | null;
}) {
  const map = useMap();
  const mapsLibrary = useMapsLibrary('maps');

  useEffect(() => {
    if (!map || !mapsLibrary) return;
    
    // Use snapped points if available, otherwise use raw points
    const pathSource = snappedPoints && snappedPoints.length > 0 ? snappedPoints : points;
    if (pathSource.length < 2) return;

    const path = pathSource.map((p) => ({
      lat: p.latitude,
      lng: p.longitude,
    }));

    // Extend path to live driver location if available and different from last point
    if (liveLocation) {
      const lastPoint = path[path.length - 1];
      const distToLive = Math.abs(lastPoint.lat - liveLocation.latitude) + 
                         Math.abs(lastPoint.lng - liveLocation.longitude);
      // Only add if significantly different (more than ~100m)
      if (distToLive > 0.001) {
        path.push({ lat: liveLocation.latitude, lng: liveLocation.longitude });
      }
    }

    const polylines: google.maps.Polyline[] = [];

    // Layer 1: Outer glow/shadow (widest, most transparent)
    const glowOuter = new mapsLibrary.Polyline({
      path,
      geodesic: true,
      strokeColor: '#0052FF',
      strokeOpacity: 0.15,
      strokeWeight: 14,
      map,
      zIndex: 1,
    });
    polylines.push(glowOuter);

    // Layer 2: Inner glow
    const glowInner = new mapsLibrary.Polyline({
      path,
      geodesic: true,
      strokeColor: '#0052FF',
      strokeOpacity: 0.3,
      strokeWeight: 10,
      map,
      zIndex: 2,
    });
    polylines.push(glowInner);

    // Layer 3: Main route line with round joins
    const mainLine = new mapsLibrary.Polyline({
      path,
      geodesic: true,
      strokeColor: '#0052FF',
      strokeOpacity: 0.9,
      strokeWeight: 5,
      map,
      zIndex: 3,
    });
    polylines.push(mainLine);

    // Layer 4: Directional arrows along the path
    const arrowSymbol = {
      path: google.maps.SymbolPath.FORWARD_CLOSED_ARROW,
      scale: 2.5,
      strokeColor: '#ffffff',
      strokeWeight: 1,
      fillColor: '#0052FF',
      fillOpacity: 1,
    };

    const arrowLine = new mapsLibrary.Polyline({
      path,
      geodesic: true,
      strokeOpacity: 0, // Invisible line, just for arrows
      icons: [
        {
          icon: arrowSymbol,
          offset: '0',
          repeat: '80px', // Arrow every 80 pixels
        },
      ],
      map,
      zIndex: 4,
    });
    polylines.push(arrowLine);

    // Layer 5: History fade - older segments more transparent
    // Only apply if we have timestamps in original points
    if (points.length > 10 && points[0].recordedAt) {
      const now = Date.now();
      const fadeThreshold = 15 * 60 * 1000; // 15 minutes
      
      // Find where the "old" section ends
      let fadeEndIndex = 0;
      for (let i = 0; i < points.length; i++) {
        if (now - points[i].recordedAt < fadeThreshold) {
          fadeEndIndex = i;
          break;
        }
      }

      if (fadeEndIndex > 2) {
        // Draw faded overlay on old section
        const oldPath = path.slice(0, fadeEndIndex + 1);
        const fadeOverlay = new mapsLibrary.Polyline({
          path: oldPath,
          geodesic: true,
          strokeColor: '#94a3b8', // Slate-400
          strokeOpacity: 0.5,
          strokeWeight: 5,
          map,
          zIndex: 5,
        });
        polylines.push(fadeOverlay);
      }
    }

    return () => {
      polylines.forEach((p) => p.setMap(null));
    };
  }, [map, mapsLibrary, points, snappedPoints, liveLocation]);

  return null;
}

// ============================================
// GPS BREADCRUMB DOTS - Show capture points at 5-min intervals
// Small grey dots to show where GPS data was recorded
// ============================================
const BREADCRUMB_INTERVAL_MS = 5 * 60 * 1000; // Show dots every 5 minutes

function GpsBreadcrumbs({ points }: { points: LocationPoint[] }) {
  const map = useMap();

  // Filter points to ~5 minute intervals for display
  const displayPoints = useMemo(() => {
    if (points.length === 0) return [];
    
    const filtered: LocationPoint[] = [points[0]]; // Always include first
    let lastShownTime = points[0].recordedAt;
    
    for (let i = 1; i < points.length - 1; i++) {
      const timeSinceLast = points[i].recordedAt - lastShownTime;
      if (timeSinceLast >= BREADCRUMB_INTERVAL_MS) {
        filtered.push(points[i]);
        lastShownTime = points[i].recordedAt;
      }
    }
    
    // Always include last point
    if (points.length > 1) {
      filtered.push(points[points.length - 1]);
    }
    
    return filtered;
  }, [points]);

  useEffect(() => {
    if (!map || displayPoints.length === 0 || !google?.maps?.Marker) return;

    const markers: google.maps.Marker[] = [];

    // Create a small dot for each display point
    displayPoints.forEach((point, index) => {
      const marker = new google.maps.Marker({
        position: { lat: point.latitude, lng: point.longitude },
        map,
        icon: {
          path: google.maps.SymbolPath.CIRCLE,
          scale: 5,
          fillColor: '#64748b', // Slate-500
          fillOpacity: 0.8,
          strokeColor: '#ffffff',
          strokeWeight: 1.5,
          strokeOpacity: 1,
        },
        title: `${new Date(point.recordedAt).toLocaleTimeString()}`,
        zIndex: 10,
      });
      markers.push(marker);
    });

    return () => {
      markers.forEach((m) => m.setMap(null));
    };
  }, [map, displayPoints]);

  return null;
}

// ============================================
// GEOFENCE CIRCLES - Around stops
// ============================================
function GeofenceCircles({ 
  stops, 
  driverLocation 
}: { 
  stops: StopData[];
  driverLocation?: { latitude: number; longitude: number } | null;
}) {
  const map = useMap();
  const mapsLibrary = useMapsLibrary('maps');

  useEffect(() => {
    if (!map || !mapsLibrary || !stops.length) return;

    const circles: google.maps.Circle[] = [];

    stops.forEach((stop) => {
      // Check if driver is within geofence
      const isDriverInside = driverLocation 
        ? haversineDistance(stop.lat, stop.lng, driverLocation.latitude, driverLocation.longitude) * 1000 < GEOFENCE_RADIUS_METERS
        : false;

      const circle = new mapsLibrary.Circle({
        center: { lat: stop.lat, lng: stop.lng },
        radius: GEOFENCE_RADIUS_METERS,
        strokeColor: isDriverInside ? '#22c55e' : stop.status === 'Completed' ? '#22c55e' : '#94a3b8',
        strokeOpacity: 0.6,
        strokeWeight: 2,
        fillColor: isDriverInside ? '#22c55e' : stop.status === 'Completed' ? '#22c55e' : '#e2e8f0',
        fillOpacity: isDriverInside ? 0.25 : 0.15,
        map,
      });

      circles.push(circle);
    });

    return () => {
      circles.forEach((c) => c.setMap(null));
    };
  }, [map, mapsLibrary, stops, driverLocation]);

  return null;
}

// ============================================
// BOUNDS FITTER - Fits map to show all data
// ============================================
function MapBoundsFitter({
  routePoints,
  liveLocation,
  stops,
  selectedStopId,
}: {
  routePoints: LocationPoint[];
  liveLocation: { latitude: number; longitude: number } | null;
  stops?: StopData[];
  selectedStopId?: string | null;
}) {
  const map = useMap();

  useEffect(() => {
    if (!map) return;

    // If a stop is selected, zoom to it
    if (selectedStopId && stops) {
      const selectedStop = stops.find((s) => s.id === selectedStopId);
      if (selectedStop) {
        map.panTo({ lat: selectedStop.lat, lng: selectedStop.lng });
        map.setZoom(15);
        return;
      }
    }

    const bounds = new google.maps.LatLngBounds();
    let hasPoints = false;

    routePoints.forEach((p) => {
      bounds.extend({ lat: p.latitude, lng: p.longitude });
      hasPoints = true;
    });

    if (liveLocation) {
      bounds.extend({ lat: liveLocation.latitude, lng: liveLocation.longitude });
      hasPoints = true;
    }

    stops?.forEach((s) => {
      bounds.extend({ lat: s.lat, lng: s.lng });
      hasPoints = true;
    });

    if (hasPoints) {
      map.fitBounds(bounds, { top: 60, right: 40, bottom: 80, left: 40 });
    }
  }, [map, routePoints, liveLocation, stops, selectedStopId]);

  return null;
}

// ============================================
// DRIVER MARKER - Premium directional arrow with halo
// Features:
// - Rotating arrow based on heading
// - Multi-layer pulsing halo when live
// - Speed badge
// - Stale state indicator
// ============================================
function LiveDriverMarker({
  location,
  driverName,
  heading,
  speed,
  recordedAt,
}: {
  location: { latitude: number; longitude: number };
  driverName?: string;
  heading?: number;
  speed?: number;
  recordedAt?: number;
}) {
  const isStale = recordedAt ? Date.now() - recordedAt > 10 * 60 * 1000 : false;
  const isRecent = recordedAt ? Date.now() - recordedAt < 5 * 60 * 1000 : false;
  const speedMph = speed ? Math.round(speed * 2.237) : 0;

  return (
    <AdvancedMarker position={{ lat: location.latitude, lng: location.longitude }}>
      <div className="relative">
        {/* Multi-layer pulsing halo for live tracking */}
        {isRecent && (
          <>
            {/* Outer pulse - slowest, largest */}
            <span 
              className="absolute rounded-full bg-green-400/20"
              style={{
                inset: '-20px',
                animation: 'ping 2s cubic-bezier(0, 0, 0.2, 1) infinite',
              }}
            />
            {/* Middle pulse */}
            <span 
              className="absolute rounded-full bg-green-400/30"
              style={{
                inset: '-12px',
                animation: 'ping 2s cubic-bezier(0, 0, 0.2, 1) infinite 0.5s',
              }}
            />
            {/* Inner pulse - fastest, smallest */}
            <span 
              className="absolute rounded-full bg-green-400/40"
              style={{
                inset: '-6px',
                animation: 'ping 1.5s cubic-bezier(0, 0, 0.2, 1) infinite',
              }}
            />
          </>
        )}

        {/* Static glow ring when not stale */}
        {!isStale && !isRecent && (
          <span className="absolute inset-[-8px] rounded-full bg-green-500/30 animate-pulse" />
        )}

        {/* Directional arrow container */}
        <div
          className="relative w-12 h-12 flex items-center justify-center transition-transform duration-500 ease-out"
          style={{
            transform: heading !== undefined ? `rotate(${heading}deg)` : undefined,
          }}
        >
          {/* Shadow layer */}
          <svg
            width="48"
            height="48"
            viewBox="0 0 48 48"
            className="absolute opacity-30 blur-[2px]"
            style={{ transform: 'translate(2px, 2px)' }}
          >
            <path
              d="M24 6 L38 38 L24 32 L10 38 Z"
              fill="#000"
            />
          </svg>
          
          {/* Main arrow */}
          <svg
            width="48"
            height="48"
            viewBox="0 0 48 48"
            className="relative drop-shadow-lg"
          >
            {/* Outer stroke */}
            <path
              d="M24 6 L38 38 L24 32 L10 38 Z"
              fill="none"
              stroke="white"
              strokeWidth="4"
              strokeLinejoin="round"
            />
            {/* Inner fill */}
            <path
              d="M24 6 L38 38 L24 32 L10 38 Z"
              fill={isStale ? '#94a3b8' : '#22c55e'}
              stroke={isStale ? '#64748b' : '#16a34a'}
              strokeWidth="2"
              strokeLinejoin="round"
            />
            {/* Highlight */}
            <path
              d="M24 10 L22 30 L24 28 L26 30 Z"
              fill={isStale ? '#cbd5e1' : '#86efac'}
              opacity="0.5"
            />
          </svg>
        </div>

        {/* Speed badge */}
        {!isStale && speedMph > 0 && (
          <div className="absolute -bottom-7 left-1/2 -translate-x-1/2 bg-slate-900/90 text-white text-[11px] font-bold px-2 py-0.5 rounded-full shadow-lg border border-white/20">
            {speedMph} mph
          </div>
        )}

        {/* Stale indicator */}
        {isStale && (
          <div className="absolute -bottom-7 left-1/2 -translate-x-1/2 bg-slate-500/90 text-white text-[10px] px-2 py-0.5 rounded-full">
            Stale
          </div>
        )}
      </div>
    </AdvancedMarker>
  );
}

// ============================================
// STOP MARKERS - Status-based styling
// ============================================
function StopMarker({
  stop,
  isSelected,
  onClick,
}: {
  stop: StopData;
  isSelected: boolean;
  onClick?: () => void;
}) {
  const isCompleted = stop.status === 'Completed';
  const isActive = stop.status === 'In Transit';
  const isPickup = stop.type === 'pickup';

  return (
    <AdvancedMarker
      position={{ lat: stop.lat, lng: stop.lng }}
      onClick={onClick}
    >
      <div
        className={cn(
          'relative cursor-pointer transition-all duration-200',
          isSelected && 'scale-125 z-10'
        )}
      >
        {/* Active stop pulsing ring */}
        {isActive && (
          <span className="absolute inset-[-4px] rounded-full animate-pulse bg-blue-500/40" />
        )}

        {/* Marker */}
        <div
          className={cn(
            'flex items-center justify-center rounded-full border-2 border-white shadow-lg',
            'transition-all duration-200',
            isCompleted
              ? 'w-8 h-8 bg-green-500'
              : isActive
                ? 'w-9 h-9 bg-blue-500'
                : 'w-7 h-7 bg-slate-400',
            isPickup ? '' : '', // Could differentiate pickup/delivery colors
            isSelected && 'ring-2 ring-offset-2 ring-blue-500'
          )}
        >
          {isCompleted ? (
            <CheckCircle2 className="w-4 h-4 text-white" />
          ) : (
            <span className="text-xs font-bold text-white">
              {stop.sequenceNumber}
            </span>
          )}
        </div>

        {/* Label */}
        <div
          className={cn(
            'absolute left-1/2 -translate-x-1/2 top-full mt-1',
            'px-1.5 py-0.5 rounded text-[10px] font-medium whitespace-nowrap',
            'bg-white/95 border shadow-sm',
            isSelected && 'bg-blue-50 border-blue-200'
          )}
        >
          {isPickup ? 'P' : 'D'}{stop.sequenceNumber}
          {stop.city && <span className="text-muted-foreground ml-1">{stop.city}</span>}
        </div>
      </div>
    </AdvancedMarker>
  );
}

// ============================================
// METRICS PILL - Bottom center overlay
// ============================================
function MetricsPill({
  routePoints,
  isLive,
  driverName,
}: {
  routePoints: LocationPoint[];
  isLive: boolean;
  driverName?: string;
}) {
  if (routePoints.length === 0 && !isLive) return null;

  // Calculate metrics
  let distanceMiles = 0;
  let durationHours = 0;

  if (routePoints.length > 1) {
    for (let i = 1; i < routePoints.length; i++) {
      const prev = routePoints[i - 1];
      const curr = routePoints[i];
      distanceMiles += haversineDistance(
        prev.latitude,
        prev.longitude,
        curr.latitude,
        curr.longitude
      ) * 0.621371;
    }
    const startTime = routePoints[0].recordedAt;
    const endTime = routePoints[routePoints.length - 1].recordedAt;
    durationHours = (endTime - startTime) / (1000 * 60 * 60);
  }

  return (
    <div className="absolute bottom-4 left-1/2 -translate-x-1/2 z-10">
      <div className="flex items-center gap-3 bg-white/95 backdrop-blur border rounded-full px-4 py-2 shadow-lg">
        {/* Live indicator */}
        {isLive && (
          <div className="flex items-center gap-1.5 pr-3 border-r">
            <span className="w-2 h-2 rounded-full bg-green-500 animate-pulse" />
            <span className="text-xs font-medium text-green-700">Live</span>
          </div>
        )}

        {/* Driver name */}
        {driverName && (
          <div className="flex items-center gap-1.5 text-sm">
            <Navigation className="w-3.5 h-3.5 text-muted-foreground" />
            <span className="font-medium">{driverName.split(' ')[0]}</span>
          </div>
        )}

        {/* Distance */}
        {distanceMiles > 0 && (
          <div className="flex items-center gap-1 text-sm">
            <Route className="w-3.5 h-3.5 text-muted-foreground" />
            <span className="font-medium">{distanceMiles.toFixed(1)}</span>
            <span className="text-muted-foreground text-xs">mi</span>
          </div>
        )}

        {/* Duration */}
        {durationHours > 0 && (
          <div className="flex items-center gap-1 text-sm">
            <Clock className="w-3.5 h-3.5 text-muted-foreground" />
            <span className="font-medium">
              {durationHours < 1
                ? `${Math.round(durationHours * 60)}m`
                : `${durationHours.toFixed(1)}h`}
            </span>
          </div>
        )}
      </div>
    </div>
  );
}

// ============================================
// TIME RANGE INDICATOR - Top right
// ============================================
function TimeRangeIndicator({
  routePoints,
  isLive,
}: {
  routePoints: LocationPoint[];
  isLive: boolean;
}) {
  if (routePoints.length === 0) return null;

  return (
    <div className="absolute top-3 right-3 z-10">
      <div className="bg-white/95 backdrop-blur border rounded-lg px-2.5 py-1.5 shadow-sm">
        <div className="text-[10px] text-muted-foreground flex items-center gap-1.5">
          <span>{format(new Date(routePoints[0].recordedAt), 'h:mm a')}</span>
          <span>→</span>
          {isLive ? (
            <span className="text-green-600 font-medium">Now</span>
          ) : (
            <span>{format(new Date(routePoints[routePoints.length - 1].recordedAt), 'h:mm a')}</span>
          )}
        </div>
      </div>
    </div>
  );
}

// ============================================
// HAVERSINE DISTANCE (km)
// ============================================
function haversineDistance(
  lat1: number,
  lon1: number,
  lat2: number,
  lon2: number
): number {
  const R = 6371;
  const dLat = ((lat2 - lat1) * Math.PI) / 180;
  const dLon = ((lon2 - lon1) * Math.PI) / 180;
  const a =
    Math.sin(dLat / 2) * Math.sin(dLat / 2) +
    Math.cos((lat1 * Math.PI) / 180) *
      Math.cos((lat2 * Math.PI) / 180) *
      Math.sin(dLon / 2) *
      Math.sin(dLon / 2);
  const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
  return R * c;
}

// ============================================
// MAIN COMPONENT
// ============================================
export function LiveRouteMap({
  loadId,
  organizationId,
  driverId,
  height = '350px',
  stops,
  selectedStopId,
  onStopSelect,
}: LiveRouteMapProps) {
  const apiKey = process.env.NEXT_PUBLIC_GOOGLE_MAPS_API_KEY;

  // Route path state (road-following path from Map Matching API)
  const [routePath, setRoutePath] = useState<Array<{ latitude: number; longitude: number }>>([]);
  const [isLoadingPath, setIsLoadingPath] = useState(false);
  const [matchConfidence, setMatchConfidence] = useState<number>(0);
  const pathStateRef = useRef({ lastCount: 0, isLoading: false });

  // Map matching action (uses Mapbox for accurate route reconstruction)
  const mapMatchRoute = useAction(api.googleRoads.mapMatchRoute);

  // Fetch route history for this load
  const routeHistory = useQuery(api.driverLocations.getRouteHistoryForLoad, {
    loadId,
  });

  // Fetch live driver location if we have a driver
  const liveLocations = useQuery(api.driverLocations.getActiveDriverLocations, {
    organizationId,
  });

  // Find the specific driver's live location
  const driverLiveLocation = useMemo(() => {
    if (!driverId || !liveLocations) return null;
    return liveLocations.find((loc) => loc.driverId === driverId) ?? null;
  }, [driverId, liveLocations]);

  const isLiveTracking = !!driverLiveLocation;

  // Get road-following path using Mapbox Map Matching when route history changes
  useEffect(() => {
    const currentCount = routeHistory?.length ?? 0;
    
    // Skip if no data or too few points
    if (!routeHistory || currentCount < 2) {
      setRoutePath([]);
      setMatchConfidence(0);
      pathStateRef.current.lastCount = currentCount;
      return;
    }

    // Skip if already loading or not enough new points
    const newPointsCount = currentCount - pathStateRef.current.lastCount;
    if (pathStateRef.current.isLoading) {
      return;
    }
    
    // Only re-fetch if we have 2+ new points (or first time)
    if (pathStateRef.current.lastCount > 0 && newPointsCount < 2) {
      return;
    }

    async function fetchMatchedRoute() {
      pathStateRef.current.isLoading = true;
      setIsLoadingPath(true);
      
      try {
        const coordinates = routeHistory!.map((p) => ({
          latitude: p.latitude,
          longitude: p.longitude,
          timestamp: p.recordedAt,
        }));

        const result = await mapMatchRoute({ coordinates });
        
        // Decode the matched polyline (Mapbox uses polyline6 format)
        if (result.encodedPolyline) {
          const decoded = decodePolyline6(result.encodedPolyline);
          console.log(`[LiveRouteMap] Mapbox matched ${result.matchedPoints} points → ${decoded.length} path points (${(result.confidence * 100).toFixed(1)}% confidence)`);
          setRoutePath(decoded);
          setMatchConfidence(result.confidence);
        } else if (result.fallbackPoints && result.fallbackPoints.length > 0) {
          // Use fallback (raw GPS points)
          console.warn('[LiveRouteMap] Using fallback points (no Mapbox match)');
          setRoutePath(result.fallbackPoints);
          setMatchConfidence(0);
        } else {
          console.warn('[LiveRouteMap] No route data available');
          setRoutePath([]);
          setMatchConfidence(0);
        }
        
        pathStateRef.current.lastCount = currentCount;
      } catch (error) {
        console.error('[LiveRouteMap] Map matching failed:', error);
        // Keep existing path on error
      } finally {
        pathStateRef.current.isLoading = false;
        setIsLoadingPath(false);
      }
    }

    fetchMatchedRoute();
  }, [routeHistory, mapMatchRoute]);

  // Default center (US)
  const defaultCenter = useMemo(() => ({ lat: 39.8283, lng: -98.5795 }), []);

  // Calculate center
  const center = useMemo(() => {
    if (driverLiveLocation) {
      return { lat: driverLiveLocation.latitude, lng: driverLiveLocation.longitude };
    }
    if (routeHistory && routeHistory.length > 0) {
      const last = routeHistory[routeHistory.length - 1];
      return { lat: last.latitude, lng: last.longitude };
    }
    if (stops && stops.length > 0) {
      const sumLat = stops.reduce((sum, s) => sum + s.lat, 0);
      const sumLng = stops.reduce((sum, s) => sum + s.lng, 0);
      return { lat: sumLat / stops.length, lng: sumLng / stops.length };
    }
    return defaultCenter;
  }, [driverLiveLocation, routeHistory, stops, defaultCenter]);

  // Handle stop click
  const handleStopClick = useCallback(
    (stopId: string) => {
      onStopSelect?.(selectedStopId === stopId ? null : stopId);
    },
    [onStopSelect, selectedStopId]
  );

  // Loading state
  if (routeHistory === undefined) {
    return (
      <div className="rounded-lg overflow-hidden bg-slate-100" style={{ height }}>
        <div className="flex items-center justify-center h-full">
          <div className="flex flex-col items-center gap-2">
            <div className="w-6 h-6 border-2 border-blue-500 border-t-transparent rounded-full animate-spin" />
            <p className="text-sm text-muted-foreground">Loading route...</p>
          </div>
        </div>
      </div>
    );
  }

  // No API key
  if (!apiKey) {
    return (
      <div className="rounded-lg overflow-hidden bg-slate-100" style={{ height }}>
        <div className="flex items-center justify-center h-full">
          <div className="flex flex-col items-center gap-2">
            <MapPin className="w-8 h-8 text-muted-foreground" />
            <p className="text-sm text-muted-foreground">Maps API not configured</p>
          </div>
        </div>
      </div>
    );
  }

  // Check for data
  const hasRouteData = routeHistory.length > 0;
  const hasLiveData = !!driverLiveLocation;
  const hasStops = stops && stops.length > 0;

  // Empty state
  if (!hasRouteData && !hasLiveData && !hasStops) {
    return (
      <div className="rounded-lg overflow-hidden bg-slate-100" style={{ height }}>
        <div className="flex items-center justify-center h-full">
          <div className="flex flex-col items-center gap-3">
            <div className="w-14 h-14 rounded-full bg-slate-200 flex items-center justify-center">
              <Route className="w-7 h-7 text-slate-400" />
            </div>
            <div className="text-center">
              <p className="font-medium text-sm">No Route Data Yet</p>
              <p className="text-xs text-muted-foreground mt-1">
                GPS tracking will appear when the driver starts
              </p>
            </div>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="rounded-lg overflow-hidden relative" style={{ height }}>
      <APIProvider apiKey={apiKey}>
        <Map
          defaultCenter={center}
          defaultZoom={hasRouteData || hasLiveData ? 12 : 6}
          mapId={process.env.NEXT_PUBLIC_GOOGLE_MAP_ID || 'live-route-map'}
          gestureHandling="cooperative"
          disableDefaultUI
          zoomControl
          mapTypeControl={false}
          streetViewControl={false}
          fullscreenControl
          className="w-full h-full"
        >
          {/* Fit bounds */}
          <MapBoundsFitter
            routePoints={routeHistory}
            liveLocation={driverLiveLocation}
            stops={stops}
            selectedStopId={selectedStopId}
          />

          {/* Geofence circles around stops */}
          {hasStops && (
            <GeofenceCircles
              stops={stops!}
              driverLocation={driverLiveLocation}
            />
          )}

          {/* GPS trail polyline - uses snapped points when available */}
          {hasRouteData && (
            <RoutePolylineRenderer 
              key={`route-${routeHistory.length}-${routePath.length}`}
              points={routeHistory} 
              snappedPoints={routePath.length > 0 ? routePath : undefined}
              liveLocation={driverLiveLocation ? {
                latitude: driverLiveLocation.latitude,
                longitude: driverLiveLocation.longitude,
              } : null}
            />
          )}

          {/* GPS breadcrumb dots - shows actual data capture points */}
          {/* Hidden by default - raw GPS has natural drift from roads */}
          {/* Uncomment to show: {hasRouteData && <GpsBreadcrumbs points={routeHistory} />} */}

          {/* Stop markers */}
          {stops?.map((stop) => (
            <StopMarker
              key={stop.id || `${stop.lat}-${stop.lng}`}
              stop={stop}
              isSelected={selectedStopId === stop.id}
              onClick={() => stop.id && handleStopClick(stop.id)}
            />
          ))}

          {/* Live driver location */}
          {driverLiveLocation && (
            <LiveDriverMarker
              location={{
                latitude: driverLiveLocation.latitude,
                longitude: driverLiveLocation.longitude,
              }}
              driverName={driverLiveLocation.driverName}
              heading={driverLiveLocation.heading}
              speed={driverLiveLocation.speed}
              recordedAt={driverLiveLocation.recordedAt}
            />
          )}
        </Map>
      </APIProvider>

      {/* Snapping indicator */}
      {isLoadingPath && (
        <div className="absolute top-3 left-3 z-10">
          <div className="bg-white/95 backdrop-blur border rounded-lg px-2.5 py-1.5 shadow-sm">
            <div className="flex items-center gap-2 text-xs text-muted-foreground">
              <div className="w-3 h-3 border-2 border-blue-500 border-t-transparent rounded-full animate-spin" />
              Loading route...
            </div>
          </div>
        </div>
      )}

      {/* Time range indicator */}
      <TimeRangeIndicator routePoints={routeHistory} isLive={isLiveTracking} />

      {/* Bottom metrics pill */}
      <MetricsPill
        routePoints={routeHistory}
        isLive={isLiveTracking}
        driverName={driverLiveLocation?.driverName}
      />
    </div>
  );
}
