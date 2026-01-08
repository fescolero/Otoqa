'use client';

import { useMemo, useEffect, useState } from 'react';
import {
  APIProvider,
  Map,
  AdvancedMarker,
  useMap,
  useMapsLibrary,
} from '@vis.gl/react-google-maps';

interface Stop {
  lat: number;
  lng: number;
  city?: string;
  state?: string;
  type: 'pickup' | 'delivery';
  sequenceNumber: number;
}

interface RouteMapProps {
  stops: Stop[];
  height?: string;
}

// Inner component that has access to the map instance
function RouteRenderer({ stops }: { stops: Stop[] }) {
  const map = useMap();
  const routesLibrary = useMapsLibrary('routes');
  const [directionsRenderer, setDirectionsRenderer] =
    useState<google.maps.DirectionsRenderer | null>(null);

  // Initialize DirectionsRenderer
  useEffect(() => {
    if (!routesLibrary || !map) return;

    const renderer = new routesLibrary.DirectionsRenderer({
      map,
      suppressMarkers: true, // We'll use custom markers
      polylineOptions: {
        strokeColor: '#3b82f6', // Blue route line
        strokeWeight: 4,
        strokeOpacity: 0.8,
      },
    });

    setDirectionsRenderer(renderer);

    return () => {
      renderer.setMap(null);
    };
  }, [routesLibrary, map]);

  // Calculate and render route when stops change
  useEffect(() => {
    if (!directionsRenderer || !routesLibrary || stops.length < 2) return;

    const directionsService = new routesLibrary.DirectionsService();

    // Build waypoints from intermediate stops
    const waypoints = stops.slice(1, -1).map((stop) => ({
      location: { lat: stop.lat, lng: stop.lng },
      stopover: true,
    }));

    directionsService.route(
      {
        origin: { lat: stops[0].lat, lng: stops[0].lng },
        destination: { lat: stops[stops.length - 1].lat, lng: stops[stops.length - 1].lng },
        waypoints,
        travelMode: google.maps.TravelMode.DRIVING,
        optimizeWaypoints: false, // Keep original sequence
      },
      (result, status) => {
        if (status === google.maps.DirectionsStatus.OK && result) {
          directionsRenderer.setDirections(result);
        }
      }
    );
  }, [directionsRenderer, routesLibrary, stops]);

  // Fit bounds to show all stops - simple, no animation tricks
  useEffect(() => {
    if (!map || stops.length === 0) return;

    const bounds = new google.maps.LatLngBounds();
    stops.forEach((stop) => {
      bounds.extend({ lat: stop.lat, lng: stop.lng });
    });

    // Use smaller padding to naturally zoom in more
    map.fitBounds(bounds, { top: 25, right: 25, bottom: 25, left: 25 });
  }, [map, stops]);

  return null;
}

// Custom marker component with sequence number
function StopMarker({ stop }: { stop: Stop }) {
  const isPickup = stop.type === 'pickup';

  return (
    <AdvancedMarker position={{ lat: stop.lat, lng: stop.lng }}>
      <div
        className={`flex items-center justify-center w-5 h-5 rounded-full text-[10px] font-bold shadow-md ${
          isPickup
            ? 'bg-green-500 text-white'
            : 'bg-red-500 text-white'
        }`}
      >
        {stop.sequenceNumber}
      </div>
    </AdvancedMarker>
  );
}

export function RouteMap({ stops, height = '140px' }: RouteMapProps) {
  const apiKey = process.env.NEXT_PUBLIC_GOOGLE_MAPS_API_KEY;

  // Filter valid stops (with coordinates)
  const validStops = useMemo(
    () => stops.filter((s) => s.lat && s.lng && !isNaN(s.lat) && !isNaN(s.lng)),
    [stops]
  );

  // Calculate center point
  const center = useMemo(() => {
    if (validStops.length === 0) {
      // Default to US center
      return { lat: 39.8283, lng: -98.5795 };
    }
    const sumLat = validStops.reduce((sum, s) => sum + s.lat, 0);
    const sumLng = validStops.reduce((sum, s) => sum + s.lng, 0);
    return {
      lat: sumLat / validStops.length,
      lng: sumLng / validStops.length,
    };
  }, [validStops]);

  // Show placeholder if no API key
  if (!apiKey) {
    return (
      <div
        className="flex items-center justify-center bg-slate-100 rounded-md border border-dashed"
        style={{ height }}
      >
        <p className="text-xs text-muted-foreground">Maps API not configured</p>
      </div>
    );
  }

  // Show placeholder if no valid stops
  if (validStops.length === 0) {
    return (
      <div
        className="flex items-center justify-center bg-slate-100 rounded-md border border-dashed"
        style={{ height }}
      >
        <p className="text-xs text-muted-foreground">No stop coordinates</p>
      </div>
    );
  }

  return (
    <div className="rounded-md overflow-hidden border" style={{ height }}>
      <APIProvider apiKey={apiKey}>
        <Map
          defaultCenter={center}
          defaultZoom={validStops.length === 1 ? 12 : 6}
          mapId="dispatch-route-map"
          gestureHandling="cooperative"
          disableDefaultUI={true}
          clickableIcons={false}
          className="w-full h-full [&_.gm-style-cc]:!hidden [&_.gmnoprint]:!hidden [&_a[href*='google']]:!hidden"
        >
          {/* Render route line if 2+ stops */}
          {validStops.length >= 2 && <RouteRenderer stops={validStops} />}

          {/* Render stop markers */}
          {validStops.map((stop, index) => (
            <StopMarker key={`${stop.lat}-${stop.lng}-${index}`} stop={stop} />
          ))}
        </Map>
      </APIProvider>
    </div>
  );
}
