'use client';

import { useMemo, useEffect, useState, useRef, useCallback } from 'react';
import {
  APIProvider,
  Map,
  AdvancedMarker,
  useMap,
  useMapsLibrary,
} from '@vis.gl/react-google-maps';
import { useGoogleMapsKey } from '@/contexts/google-maps-context';

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

function RouteRenderer({ stops }: { stops: Stop[] }) {
  const map = useMap();
  const routesLibrary = useMapsLibrary('routes');
  const polylinesRef = useRef<google.maps.Polyline[]>([]);

  const clearPolylines = useCallback(() => {
    polylinesRef.current.forEach((p) => p.setMap(null));
    polylinesRef.current = [];
  }, []);

  useEffect(() => {
    return () => clearPolylines();
  }, [clearPolylines]);

  useEffect(() => {
    if (!routesLibrary || !map || stops.length < 2) return;

    clearPolylines();

    const Route = (routesLibrary as any).Route;
    if (!Route?.computeRoutes) return;

    const intermediates = stops.slice(1, -1).map((stop) => ({
      location: { lat: stop.lat, lng: stop.lng },
    }));

    const request: Record<string, unknown> = {
      origin: { lat: stops[0].lat, lng: stops[0].lng },
      destination: { lat: stops[stops.length - 1].lat, lng: stops[stops.length - 1].lng },
      travelMode: 'DRIVE',
      fields: ['path'],
      ...(intermediates.length > 0 && { intermediates }),
    };

    let cancelled = false;

    Route.computeRoutes(request)
      .then((response: { routes?: Array<{ createPolylines?: () => google.maps.Polyline[] }> }) => {
        if (cancelled) return;
        const route = response?.routes?.[0];
        if (!route?.createPolylines) return;

        const polylines = route.createPolylines();
        polylines.forEach((polyline) => {
          polyline.setOptions({
            strokeColor: '#3b82f6',
            strokeWeight: 4,
            strokeOpacity: 0.8,
          });
          polyline.setMap(map);
        });
        polylinesRef.current = polylines;
      })
      .catch(() => {
        // Silently handle route computation failures
      });

    return () => {
      cancelled = true;
    };
  }, [routesLibrary, map, stops, clearPolylines]);

  useEffect(() => {
    if (!map || stops.length === 0) return;

    const bounds = new google.maps.LatLngBounds();
    stops.forEach((stop) => {
      bounds.extend({ lat: stop.lat, lng: stop.lng });
    });

    map.fitBounds(bounds, { top: 25, right: 25, bottom: 25, left: 25 });
  }, [map, stops]);

  return null;
}

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
  const apiKey = useGoogleMapsKey();

  const validStops = useMemo(
    () => stops.filter((s) => s.lat && s.lng && !isNaN(s.lat) && !isNaN(s.lng)),
    [stops]
  );

  const center = useMemo(() => {
    if (validStops.length === 0) {
      return { lat: 39.8283, lng: -98.5795 };
    }
    const sumLat = validStops.reduce((sum, s) => sum + s.lat, 0);
    const sumLng = validStops.reduce((sum, s) => sum + s.lng, 0);
    return {
      lat: sumLat / validStops.length,
      lng: sumLng / validStops.length,
    };
  }, [validStops]);

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
          {validStops.length >= 2 && <RouteRenderer stops={validStops} />}

          {validStops.map((stop, index) => (
            <StopMarker key={`${stop.lat}-${stop.lng}-${index}`} stop={stop} />
          ))}
        </Map>
      </APIProvider>
    </div>
  );
}
