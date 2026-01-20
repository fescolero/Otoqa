'use client';

import { useMemo, useEffect, useState, useCallback } from 'react';
import { useQuery } from 'convex/react';
import { api } from '@/convex/_generated/api';
import { Id } from '@/convex/_generated/dataModel';
import {
  APIProvider,
  Map,
  AdvancedMarker,
  useMap,
  InfoWindow,
} from '@vis.gl/react-google-maps';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Skeleton } from '@/components/ui/skeleton';
import {
  Truck,
  RefreshCw,
  MapPin,
  Clock,
  Package,
  Navigation,
  Users,
  Signal,
  SignalZero,
} from 'lucide-react';
import { formatDistanceToNow } from 'date-fns';

// ============================================
// HELICOPTER VIEW
// Real-time driver location tracking map
// ============================================

interface HelicopterViewProps {
  organizationId: string;
  height?: string;
  showStats?: boolean;
  onDriverSelect?: (driverId: Id<'drivers'>) => void;
}

interface DriverLocation {
  driverId: Id<'drivers'>;
  driverName: string;
  latitude: number;
  longitude: number;
  accuracy?: number;
  speed?: number;
  heading?: number;
  loadId: Id<'loadInformation'>;
  loadInternalId: string;
  trackingType: string;
  recordedAt: number;
  truckUnitId?: string;
}

// Driver marker component with truck icon
function DriverMarker({
  driver,
  isSelected,
  onClick,
}: {
  driver: DriverLocation;
  isSelected: boolean;
  onClick: () => void;
}) {
  const timeSinceUpdate = formatDistanceToNow(new Date(driver.recordedAt), {
    addSuffix: true,
  });

  // Determine if location is stale (> 10 minutes old)
  const isStale = Date.now() - driver.recordedAt > 10 * 60 * 1000;

  return (
    <AdvancedMarker
      position={{ lat: driver.latitude, lng: driver.longitude }}
      onClick={onClick}
    >
      <div className="relative group cursor-pointer">
        {/* Truck icon with pulsing ring for active drivers */}
        <div
          className={`
            relative flex items-center justify-center w-10 h-10 rounded-full
            shadow-lg border-2 transition-all duration-200
            ${isSelected ? 'scale-125 z-10' : 'hover:scale-110'}
            ${isStale ? 'bg-muted border-muted-foreground/50' : 'bg-primary border-primary'}
          `}
        >
          <Truck
            className={`w-5 h-5 ${isStale ? 'text-muted-foreground' : 'text-primary-foreground'}`}
          />

          {/* Pulsing ring for active (non-stale) drivers */}
          {!isStale && (
            <span className="absolute inset-0 rounded-full animate-ping bg-primary/30" />
          )}

          {/* Heading indicator */}
          {driver.heading !== undefined && driver.heading !== null && (
            <div
              className="absolute -top-1 w-0 h-0 border-l-[4px] border-r-[4px] border-b-[8px] border-l-transparent border-r-transparent border-b-primary"
              style={{
                transform: `rotate(${driver.heading}deg)`,
                transformOrigin: 'center bottom',
              }}
            />
          )}
        </div>

        {/* Driver name label */}
        <div
          className={`
            absolute left-1/2 -translate-x-1/2 top-full mt-1
            px-2 py-0.5 rounded-md text-xs font-medium whitespace-nowrap
            shadow-md border
            ${isStale ? 'bg-muted text-muted-foreground border-border' : 'bg-background text-foreground border-border'}
          `}
        >
          {driver.driverName.split(' ')[0]}
          {driver.truckUnitId && (
            <span className="ml-1 text-muted-foreground">#{driver.truckUnitId}</span>
          )}
        </div>

        {/* Tooltip on hover */}
        <div
          className="absolute left-1/2 -translate-x-1/2 bottom-full mb-2 
          opacity-0 group-hover:opacity-100 transition-opacity
          pointer-events-none z-20"
        >
          <div className="bg-popover text-popover-foreground border rounded-lg shadow-lg p-3 text-xs min-w-[180px]">
            <p className="font-semibold">{driver.driverName}</p>
            <p className="text-muted-foreground mt-1">
              Load: #{driver.loadInternalId}
            </p>
            {driver.speed !== undefined && driver.speed !== null && (
              <p className="text-muted-foreground">
                Speed: {Math.round(driver.speed * 2.237)} mph
              </p>
            )}
            <p className="text-muted-foreground mt-1">
              Updated {timeSinceUpdate}
            </p>
          </div>
        </div>
      </div>
    </AdvancedMarker>
  );
}

// Map bounds fitter component
function MapBoundsFitter({ locations }: { locations: DriverLocation[] }) {
  const map = useMap();

  useEffect(() => {
    if (!map || locations.length === 0) return;

    const bounds = new google.maps.LatLngBounds();
    locations.forEach((loc) => {
      bounds.extend({ lat: loc.latitude, lng: loc.longitude });
    });

    // Add padding so markers aren't at the edge
    map.fitBounds(bounds, { top: 50, right: 50, bottom: 50, left: 50 });
  }, [map, locations]);

  return null;
}

// Stats panel component
function StatsPanel({ locations }: { locations: DriverLocation[] }) {
  const activeCount = locations.filter(
    (l) => Date.now() - l.recordedAt < 10 * 60 * 1000
  ).length;
  const staleCount = locations.length - activeCount;

  return (
    <div className="absolute top-4 left-4 z-10 flex gap-2">
      <div className="bg-background/95 backdrop-blur border rounded-lg px-3 py-2 shadow-lg">
        <div className="flex items-center gap-2 text-sm">
          <Users className="w-4 h-4 text-muted-foreground" />
          <span className="font-medium">{locations.length}</span>
          <span className="text-muted-foreground">tracking</span>
        </div>
      </div>
      {activeCount > 0 && (
        <div className="bg-background/95 backdrop-blur border rounded-lg px-3 py-2 shadow-lg">
          <div className="flex items-center gap-2 text-sm">
            <Signal className="w-4 h-4 text-green-500" />
            <span className="font-medium text-green-600">{activeCount}</span>
            <span className="text-muted-foreground">active</span>
          </div>
        </div>
      )}
      {staleCount > 0 && (
        <div className="bg-background/95 backdrop-blur border rounded-lg px-3 py-2 shadow-lg">
          <div className="flex items-center gap-2 text-sm">
            <SignalZero className="w-4 h-4 text-muted-foreground" />
            <span className="font-medium text-muted-foreground">{staleCount}</span>
            <span className="text-muted-foreground">stale</span>
          </div>
        </div>
      )}
    </div>
  );
}

export function HelicopterView({
  organizationId,
  height = '500px',
  showStats = true,
  onDriverSelect,
}: HelicopterViewProps) {
  const apiKey = process.env.NEXT_PUBLIC_GOOGLE_MAPS_API_KEY;
  const [selectedDriverId, setSelectedDriverId] = useState<Id<'drivers'> | null>(null);
  const [autoRefresh, setAutoRefresh] = useState(true);

  // Convex reactive query - auto-updates when data changes
  const driverLocations = useQuery(api.driverLocations.getActiveDriverLocations, {
    organizationId,
  });

  // Default center (US)
  const defaultCenter = useMemo(() => ({ lat: 39.8283, lng: -98.5795 }), []);

  // Calculate center based on driver locations
  const center = useMemo(() => {
    if (!driverLocations || driverLocations.length === 0) {
      return defaultCenter;
    }
    const sumLat = driverLocations.reduce((sum, d) => sum + d.latitude, 0);
    const sumLng = driverLocations.reduce((sum, d) => sum + d.longitude, 0);
    return {
      lat: sumLat / driverLocations.length,
      lng: sumLng / driverLocations.length,
    };
  }, [driverLocations, defaultCenter]);

  const handleDriverClick = useCallback(
    (driverId: Id<'drivers'>) => {
      setSelectedDriverId((prev) => (prev === driverId ? null : driverId));
      onDriverSelect?.(driverId);
    },
    [onDriverSelect]
  );

  // Loading state
  if (driverLocations === undefined) {
    return (
      <div className="rounded-lg border overflow-hidden" style={{ height }}>
        <div className="flex items-center justify-center h-full bg-muted/50">
          <div className="flex flex-col items-center gap-3">
            <RefreshCw className="w-8 h-8 animate-spin text-muted-foreground" />
            <p className="text-sm text-muted-foreground">Loading driver locations...</p>
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

  // No drivers tracking
  if (driverLocations.length === 0) {
    return (
      <div className="rounded-lg border overflow-hidden" style={{ height }}>
        <div className="flex items-center justify-center h-full bg-muted/50">
          <div className="flex flex-col items-center gap-3">
            <div className="w-16 h-16 rounded-full bg-muted flex items-center justify-center">
              <Truck className="w-8 h-8 text-muted-foreground" />
            </div>
            <div className="text-center">
              <p className="font-medium">No Active Drivers</p>
              <p className="text-sm text-muted-foreground mt-1">
                Driver locations will appear here when drivers are on active routes
              </p>
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
          defaultZoom={5}
          mapId="helicopter-view-map"
          gestureHandling="greedy"
          disableDefaultUI={false}
          zoomControl={true}
          mapTypeControl={false}
          streetViewControl={false}
          fullscreenControl={true}
          className="w-full h-full"
        >
          {/* Fit bounds to show all drivers */}
          <MapBoundsFitter locations={driverLocations} />

          {/* Driver markers */}
          {driverLocations.map((driver) => (
            <DriverMarker
              key={driver.driverId}
              driver={driver}
              isSelected={selectedDriverId === driver.driverId}
              onClick={() => handleDriverClick(driver.driverId)}
            />
          ))}
        </Map>
      </APIProvider>

      {/* Stats overlay */}
      {showStats && <StatsPanel locations={driverLocations} />}

      {/* Refresh indicator */}
      <div className="absolute bottom-4 right-4 z-10">
        <div className="bg-background/95 backdrop-blur border rounded-lg px-3 py-2 shadow-lg">
          <div className="flex items-center gap-2 text-xs text-muted-foreground">
            <div className="w-2 h-2 rounded-full bg-green-500 animate-pulse" />
            Live updates
          </div>
        </div>
      </div>
    </div>
  );
}

// Card wrapper for dashboard integration
export function HelicopterViewCard({
  organizationId,
  className,
}: {
  organizationId: string;
  className?: string;
}) {
  return (
    <Card className={className}>
      <CardHeader className="pb-2">
        <div className="flex items-center justify-between">
          <CardTitle className="text-lg flex items-center gap-2">
            <Navigation className="w-5 h-5" />
            Live Fleet Tracking
          </CardTitle>
          <Badge variant="secondary" className="text-xs">
            Real-time
          </Badge>
        </div>
      </CardHeader>
      <CardContent className="p-0">
        <HelicopterView organizationId={organizationId} height="400px" />
      </CardContent>
    </Card>
  );
}
