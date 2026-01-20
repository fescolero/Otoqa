'use client';

import { useMemo, useEffect, useState } from 'react';
import { useQuery } from 'convex/react';
import { api } from '@/convex/_generated/api';
import { Id } from '@/convex/_generated/dataModel';
import {
  APIProvider,
  Map,
  useMap,
  useMapsLibrary,
  AdvancedMarker,
} from '@vis.gl/react-google-maps';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Skeleton } from '@/components/ui/skeleton';
import { MapPin, Clock, Route, Truck, Flag } from 'lucide-react';
import { formatDistanceToNow, format } from 'date-fns';

// ============================================
// ROUTE HISTORY MAP
// Shows historical GPS trail for a completed load
// ============================================

interface RouteHistoryMapProps {
  loadId: Id<'loadInformation'>;
  height?: string;
  showTimestamps?: boolean;
  stops?: Array<{
    lat: number;
    lng: number;
    type: 'pickup' | 'delivery';
    sequenceNumber: number;
    city?: string;
    state?: string;
  }>;
}

interface LocationPoint {
  latitude: number;
  longitude: number;
  speed?: number;
  heading?: number;
  recordedAt: number;
}

// Polyline renderer component
function RoutePolylineRenderer({ points }: { points: LocationPoint[] }) {
  const map = useMap();
  const mapsLibrary = useMapsLibrary('maps');
  const [polyline, setPolyline] = useState<google.maps.Polyline | null>(null);

  useEffect(() => {
    if (!map || !mapsLibrary || points.length < 2) return;

    // Create path from points
    const path = points.map((p) => ({
      lat: p.latitude,
      lng: p.longitude,
    }));

    // Create gradient polyline effect by using multiple polylines
    // This creates a nice visual effect showing the route traveled
    const newPolyline = new mapsLibrary.Polyline({
      path,
      geodesic: true,
      strokeColor: '#3b82f6', // Blue
      strokeOpacity: 0.8,
      strokeWeight: 4,
      map,
    });

    setPolyline(newPolyline);

    // Fit bounds to show entire route
    const bounds = new google.maps.LatLngBounds();
    path.forEach((p) => bounds.extend(p));
    map.fitBounds(bounds, { top: 50, right: 50, bottom: 50, left: 50 });

    return () => {
      newPolyline.setMap(null);
    };
  }, [map, mapsLibrary, points]);

  return null;
}

// Start/End markers
function RouteEndpointMarkers({ points }: { points: LocationPoint[] }) {
  if (points.length === 0) return null;

  const startPoint = points[0];
  const endPoint = points[points.length - 1];

  return (
    <>
      {/* Start marker */}
      <AdvancedMarker
        position={{ lat: startPoint.latitude, lng: startPoint.longitude }}
      >
        <div className="flex items-center justify-center w-8 h-8 rounded-full bg-green-500 border-2 border-white shadow-lg">
          <Truck className="w-4 h-4 text-white" />
        </div>
      </AdvancedMarker>

      {/* End marker (if different from start) */}
      {(endPoint.latitude !== startPoint.latitude ||
        endPoint.longitude !== startPoint.longitude) && (
        <AdvancedMarker
          position={{ lat: endPoint.latitude, lng: endPoint.longitude }}
        >
          <div className="flex items-center justify-center w-8 h-8 rounded-full bg-red-500 border-2 border-white shadow-lg">
            <Flag className="w-4 h-4 text-white" />
          </div>
        </AdvancedMarker>
      )}
    </>
  );
}

// Stop markers from load data
function StopMarkers({
  stops,
}: {
  stops: RouteHistoryMapProps['stops'];
}) {
  if (!stops || stops.length === 0) return null;

  return (
    <>
      {stops.map((stop, index) => (
        <AdvancedMarker
          key={`stop-${index}`}
          position={{ lat: stop.lat, lng: stop.lng }}
        >
          <div
            className={`
              flex items-center justify-center w-6 h-6 rounded-full text-xs font-bold shadow-md border-2 border-white
              ${stop.type === 'pickup' ? 'bg-green-500 text-white' : 'bg-blue-500 text-white'}
            `}
          >
            {stop.sequenceNumber}
          </div>
        </AdvancedMarker>
      ))}
    </>
  );
}

// Stats overlay
function RouteStats({ points }: { points: LocationPoint[] }) {
  if (points.length === 0) return null;

  const startTime = points[0].recordedAt;
  const endTime = points[points.length - 1].recordedAt;
  const durationMs = endTime - startTime;
  const durationHours = Math.round(durationMs / (1000 * 60 * 60) * 10) / 10;

  // Calculate approximate distance using Haversine formula
  let totalDistance = 0;
  for (let i = 1; i < points.length; i++) {
    const prev = points[i - 1];
    const curr = points[i];
    totalDistance += haversineDistance(
      prev.latitude,
      prev.longitude,
      curr.latitude,
      curr.longitude
    );
  }
  const distanceMiles = Math.round(totalDistance * 0.621371 * 10) / 10;

  return (
    <div className="absolute top-4 left-4 z-10 flex gap-2">
      <div className="bg-background/95 backdrop-blur border rounded-lg px-3 py-2 shadow-lg">
        <div className="flex items-center gap-2 text-sm">
          <Route className="w-4 h-4 text-muted-foreground" />
          <span className="font-medium">{distanceMiles}</span>
          <span className="text-muted-foreground">miles tracked</span>
        </div>
      </div>
      <div className="bg-background/95 backdrop-blur border rounded-lg px-3 py-2 shadow-lg">
        <div className="flex items-center gap-2 text-sm">
          <Clock className="w-4 h-4 text-muted-foreground" />
          <span className="font-medium">{durationHours}</span>
          <span className="text-muted-foreground">hours</span>
        </div>
      </div>
      <div className="bg-background/95 backdrop-blur border rounded-lg px-3 py-2 shadow-lg">
        <div className="flex items-center gap-2 text-sm">
          <MapPin className="w-4 h-4 text-muted-foreground" />
          <span className="font-medium">{points.length}</span>
          <span className="text-muted-foreground">points</span>
        </div>
      </div>
    </div>
  );
}

// Haversine distance calculation (returns km)
function haversineDistance(
  lat1: number,
  lon1: number,
  lat2: number,
  lon2: number
): number {
  const R = 6371; // Earth's radius in km
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

export function RouteHistoryMap({
  loadId,
  height = '400px',
  showTimestamps = true,
  stops,
}: RouteHistoryMapProps) {
  const apiKey = process.env.NEXT_PUBLIC_GOOGLE_MAPS_API_KEY;

  // Fetch route history from Convex
  const routeHistory = useQuery(api.driverLocations.getRouteHistoryForLoad, {
    loadId,
  });

  // Default center (US)
  const defaultCenter = useMemo(() => ({ lat: 39.8283, lng: -98.5795 }), []);

  // Calculate center based on route points or stops
  const center = useMemo(() => {
    if (routeHistory && routeHistory.length > 0) {
      const sumLat = routeHistory.reduce((sum, p) => sum + p.latitude, 0);
      const sumLng = routeHistory.reduce((sum, p) => sum + p.longitude, 0);
      return {
        lat: sumLat / routeHistory.length,
        lng: sumLng / routeHistory.length,
      };
    }
    if (stops && stops.length > 0) {
      const sumLat = stops.reduce((sum, s) => sum + s.lat, 0);
      const sumLng = stops.reduce((sum, s) => sum + s.lng, 0);
      return {
        lat: sumLat / stops.length,
        lng: sumLng / stops.length,
      };
    }
    return defaultCenter;
  }, [routeHistory, stops, defaultCenter]);

  // Loading state
  if (routeHistory === undefined) {
    return (
      <div className="rounded-lg border overflow-hidden" style={{ height }}>
        <div className="flex items-center justify-center h-full bg-muted/50">
          <div className="flex flex-col items-center gap-3">
            <Skeleton className="w-8 h-8 rounded-full" />
            <p className="text-sm text-muted-foreground">Loading route history...</p>
          </div>
        </div>
      </div>
    );
  }

  // No API key
  if (!apiKey) {
    return (
      <div className="rounded-lg border overflow-hidden" style={{ height }}>
        <div className="flex items-center justify-center h-full bg-muted/50">
          <div className="flex flex-col items-center gap-2">
            <MapPin className="w-8 h-8 text-muted-foreground" />
            <p className="text-sm text-muted-foreground">Google Maps API not configured</p>
          </div>
        </div>
      </div>
    );
  }

  // No route data - show stops if available
  if (routeHistory.length === 0) {
    if (!stops || stops.length === 0) {
      return (
        <div className="rounded-lg border overflow-hidden" style={{ height }}>
          <div className="flex items-center justify-center h-full bg-muted/50">
            <div className="flex flex-col items-center gap-3">
              <div className="w-16 h-16 rounded-full bg-muted flex items-center justify-center">
                <Route className="w-8 h-8 text-muted-foreground" />
              </div>
              <div className="text-center">
                <p className="font-medium">No Route Data</p>
                <p className="text-sm text-muted-foreground mt-1">
                  GPS tracking data will appear once the driver starts the route
                </p>
              </div>
            </div>
          </div>
        </div>
      );
    }

    // Show just stops without route
    return (
      <div className="rounded-lg border overflow-hidden relative" style={{ height }}>
        <APIProvider apiKey={apiKey}>
          <Map
            defaultCenter={center}
            defaultZoom={6}
            mapId="route-history-map"
            gestureHandling="cooperative"
            disableDefaultUI={false}
            zoomControl={true}
            mapTypeControl={false}
            streetViewControl={false}
            fullscreenControl={true}
            className="w-full h-full"
          >
            <StopMarkers stops={stops} />
          </Map>
        </APIProvider>
        <div className="absolute bottom-4 right-4 z-10">
          <div className="bg-background/95 backdrop-blur border rounded-lg px-3 py-2 shadow-lg">
            <div className="flex items-center gap-2 text-xs text-muted-foreground">
              Stops only - no GPS trail
            </div>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="rounded-lg border overflow-hidden relative" style={{ height }}>
      <APIProvider apiKey={apiKey}>
        <Map
          defaultCenter={center}
          defaultZoom={6}
          mapId="route-history-map"
          gestureHandling="cooperative"
          disableDefaultUI={false}
          zoomControl={true}
          mapTypeControl={false}
          streetViewControl={false}
          fullscreenControl={true}
          className="w-full h-full"
        >
          {/* Draw route polyline */}
          <RoutePolylineRenderer points={routeHistory} />

          {/* Show start/end markers */}
          <RouteEndpointMarkers points={routeHistory} />

          {/* Show stop markers if provided */}
          <StopMarkers stops={stops} />
        </Map>
      </APIProvider>

      {/* Stats overlay */}
      {showTimestamps && <RouteStats points={routeHistory} />}

      {/* Time range indicator */}
      {routeHistory.length > 0 && (
        <div className="absolute bottom-4 right-4 z-10">
          <div className="bg-background/95 backdrop-blur border rounded-lg px-3 py-2 shadow-lg">
            <div className="text-xs text-muted-foreground">
              <span>
                {format(new Date(routeHistory[0].recordedAt), 'MMM d, h:mm a')}
              </span>
              <span className="mx-2">→</span>
              <span>
                {format(
                  new Date(routeHistory[routeHistory.length - 1].recordedAt),
                  'MMM d, h:mm a'
                )}
              </span>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

// Card wrapper for easy integration
export function RouteHistoryCard({
  loadId,
  stops,
  className,
}: {
  loadId: Id<'loadInformation'>;
  stops?: RouteHistoryMapProps['stops'];
  className?: string;
}) {
  return (
    <Card className={className}>
      <CardHeader className="pb-2">
        <div className="flex items-center justify-between">
          <CardTitle className="text-lg flex items-center gap-2">
            <Route className="w-5 h-5" />
            Route History
          </CardTitle>
          <Badge variant="secondary" className="text-xs">
            GPS Trail
          </Badge>
        </div>
      </CardHeader>
      <CardContent className="p-0">
        <RouteHistoryMap loadId={loadId} stops={stops} height="350px" />
      </CardContent>
    </Card>
  );
}
