'use client';

import { useMemo, useEffect, useState, useCallback, useRef } from 'react';
import { useAction } from 'convex/react';
import { useAuthQuery } from '@/hooks/use-auth-query';
import { api } from '@/convex/_generated/api';
import { Id } from '@/convex/_generated/dataModel';
import {
  APIProvider,
  Map,
  useMap,
  useMapsLibrary,
  AdvancedMarker,
} from '@vis.gl/react-google-maps';
import { useGoogleMapsKey } from '@/contexts/google-maps-context';
import { Card } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import {
  ArrowLeft,
  Download,
  RefreshCw,
  MapPin,
  Clock,
  Gauge,
  Wifi,
  WifiOff,
  Target,
  AlertTriangle,
  CheckCircle2,
  XCircle,
  Radar,
  Zap,
} from 'lucide-react';
import Link from 'next/link';
import { cn } from '@/lib/utils';
import { format } from 'date-fns';

// ============================================
// TYPES
// ============================================

interface DiagnosticPoint {
  index: number;
  id: string;
  latitude: number;
  longitude: number;
  accuracy: number | null;
  speedMph: number | null;
  heading: number | null;
  recordedAt: number;
  createdAt: number;
  // Computed
  timeGapMs: number | null;
  syncDelayMs: number;
  impliedSpeedMph: number | null;
  distFromPrevMeters: number | null;
  // From tracepoints
  matched: boolean | null;
  snappedLat: number | null;
  snappedLng: number | null;
  roadName: string | null;
  driftMeters: number | null;
  batchIndex: number | null;
}

interface GpsLogsViewProps {
  loadId: string;
  organizationId: string;
}

// ============================================
// HAVERSINE DISTANCE (meters)
// ============================================

function haversineMeters(
  lat1: number, lon1: number,
  lat2: number, lon2: number
): number {
  const R = 6371000;
  const dLat = ((lat2 - lat1) * Math.PI) / 180;
  const dLon = ((lon2 - lon1) * Math.PI) / 180;
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos((lat1 * Math.PI) / 180) *
    Math.cos((lat2 * Math.PI) / 180) *
    Math.sin(dLon / 2) ** 2;
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

// ============================================
// POLYLINE DECODER (Mapbox polyline6)
// ============================================

function decodePolyline6(encoded: string): Array<{ lat: number; lng: number }> {
  const points: Array<{ lat: number; lng: number }> = [];
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
    lat += result & 1 ? ~(result >> 1) : result >> 1;

    shift = 0;
    result = 0;
    do {
      byte = encoded.charCodeAt(index++) - 63;
      result |= (byte & 0x1f) << shift;
      shift += 5;
    } while (byte >= 0x20);
    lng += result & 1 ? ~(result >> 1) : result >> 1;

    points.push({ lat: lat / 1e6, lng: lng / 1e6 });
  }
  return points;
}

// ============================================
// CSV EXPORT
// ============================================

function exportCsv(points: DiagnosticPoint[], loadId: string) {
  const headers = [
    '#', 'Time', 'Latitude', 'Longitude', 'Accuracy (m)', 'Speed (mph)',
    'Heading', 'Match Status', 'Snapped Lat', 'Snapped Lng', 'Drift (m)',
    'Road Name', 'Time Gap (s)', 'Sync Delay (s)', 'Implied Speed (mph)',
    'Batch',
  ];

  const rows = points.map((p) => [
    p.index + 1,
    new Date(p.recordedAt).toISOString(),
    p.latitude.toFixed(6),
    p.longitude.toFixed(6),
    p.accuracy?.toFixed(1) ?? '',
    p.speedMph?.toFixed(1) ?? '',
    p.heading?.toFixed(0) ?? '',
    p.matched === null ? 'pending' : p.matched ? 'matched' : 'unmatched',
    p.snappedLat?.toFixed(6) ?? '',
    p.snappedLng?.toFixed(6) ?? '',
    p.driftMeters?.toFixed(1) ?? '',
    p.roadName ?? '',
    p.timeGapMs !== null ? (p.timeGapMs / 1000).toFixed(0) : '',
    (p.syncDelayMs / 1000).toFixed(0),
    p.impliedSpeedMph?.toFixed(1) ?? '',
    p.batchIndex ?? '',
  ]);

  const csv = [headers.join(','), ...rows.map((r) => r.join(','))].join('\n');
  const blob = new Blob([csv], { type: 'text/csv' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `gps-logs-${loadId}-${format(new Date(), 'yyyy-MM-dd-HHmm')}.csv`;
  a.click();
  URL.revokeObjectURL(url);
}

// ============================================
// DIAGNOSTIC MAP OVERLAY
// ============================================

function DiagnosticMapOverlay({
  points,
  encodedPolyline,
  selectedIndex,
  onPointClick,
}: {
  points: DiagnosticPoint[];
  encodedPolyline?: string;
  selectedIndex: number | null;
  onPointClick: (index: number) => void;
}) {
  const map = useMap();
  const mapsLib = useMapsLibrary('maps');

  // Draw matched polyline
  useEffect(() => {
    if (!map || !mapsLib || !encodedPolyline) return;
    const path = decodePolyline6(encodedPolyline);
    const polyline = new mapsLib.Polyline({
      path,
      geodesic: true,
      strokeColor: '#3b82f6',
      strokeOpacity: 0.6,
      strokeWeight: 4,
      map,
      zIndex: 1,
    });
    return () => { polyline.setMap(null); };
  }, [map, mapsLib, encodedPolyline]);

  // Draw gap lines (dashed orange for gaps > 3 min)
  useEffect(() => {
    if (!map || !mapsLib || points.length < 2) return;
    const lines: google.maps.Polyline[] = [];
    for (let i = 1; i < points.length; i++) {
      if (points[i].timeGapMs && points[i].timeGapMs! > 3 * 60 * 1000) {
        const prev = points[i - 1];
        const curr = points[i];
        const line = new mapsLib.Polyline({
          path: [
            { lat: prev.latitude, lng: prev.longitude },
            { lat: curr.latitude, lng: curr.longitude },
          ],
          geodesic: true,
          strokeOpacity: 0,
          icons: [{
            icon: {
              path: 'M 0,-1 0,1',
              strokeOpacity: 0.8,
              strokeColor: '#f97316',
              scale: 3,
            },
            offset: '0',
            repeat: '12px',
          }],
          map,
          zIndex: 2,
        });
        lines.push(line);
      }
    }
    return () => { lines.forEach((l) => l.setMap(null)); };
  }, [map, mapsLib, points]);

  // Draw GPS point markers
  useEffect(() => {
    if (!map || points.length === 0 || !google?.maps?.Marker) return;
    const markers: google.maps.Marker[] = [];

    points.forEach((p) => {
      let color = '#94a3b8'; // default gray (pending)
      if (p.matched === true) {
        if (p.accuracy !== null && p.accuracy > 30) {
          color = '#eab308'; // yellow - borderline accuracy
        } else {
          color = '#22c55e'; // green - good match
        }
      } else if (p.matched === false) {
        color = '#ef4444'; // red - unmatched
      }

      if (p.timeGapMs && p.timeGapMs > 3 * 60 * 1000) {
        color = '#f97316'; // orange - gap point
      }

      const isSelected = selectedIndex === p.index;

      const marker = new google.maps.Marker({
        position: { lat: p.latitude, lng: p.longitude },
        map,
        icon: {
          path: google.maps.SymbolPath.CIRCLE,
          scale: isSelected ? 8 : 5,
          fillColor: color,
          fillOpacity: isSelected ? 1 : 0.85,
          strokeColor: isSelected ? '#1e293b' : '#ffffff',
          strokeWeight: isSelected ? 2.5 : 1.5,
        },
        title: `#${p.index + 1} — ${new Date(p.recordedAt).toLocaleTimeString()}`,
        zIndex: isSelected ? 100 : 10 + p.index,
      });

      marker.addListener('click', () => onPointClick(p.index));
      markers.push(marker);
    });

    return () => { markers.forEach((m) => m.setMap(null)); };
  }, [map, points, selectedIndex, onPointClick]);

  return null;
}

// Fits map bounds to all points
function DiagnosticBoundsFitter({ points }: { points: DiagnosticPoint[] }) {
  const map = useMap();
  useEffect(() => {
    if (!map || points.length === 0) return;
    const bounds = new google.maps.LatLngBounds();
    points.forEach((p) => bounds.extend({ lat: p.latitude, lng: p.longitude }));
    map.fitBounds(bounds, { top: 40, right: 40, bottom: 40, left: 40 });
  }, [map, points]);
  return null;
}

// ============================================
// SUMMARY STATS BAR
// ============================================

function SummaryStats({ points }: { points: DiagnosticPoint[] }) {
  const stats = useMemo(() => {
    if (points.length === 0) return null;

    const matchedCount = points.filter((p) => p.matched === true).length;
    const unmatchedCount = points.filter((p) => p.matched === false).length;
    const matchRate = points.length > 0 ? (matchedCount / points.length) * 100 : 0;

    const accuracies = points.filter((p) => p.accuracy !== null).map((p) => p.accuracy!);
    const avgAccuracy = accuracies.length > 0 ? accuracies.reduce((a, b) => a + b, 0) / accuracies.length : null;

    const gaps = points.filter((p) => p.timeGapMs !== null).map((p) => p.timeGapMs!);
    const maxGap = gaps.length > 0 ? Math.max(...gaps) : 0;

    const syncDelays = points.filter((p) => p.syncDelayMs > 5 * 60 * 1000);

    const speedAnomalies = points.filter(
      (p) => (p.speedMph !== null && p.speedMph > 80) || (p.impliedSpeedMph !== null && p.impliedSpeedMph > 120)
    );

    return {
      total: points.length,
      matchedCount,
      unmatchedCount,
      matchRate,
      avgAccuracy,
      maxGap,
      syncDelayCount: syncDelays.length,
      speedAnomalyCount: speedAnomalies.length,
    };
  }, [points]);

  if (!stats) return null;

  const statItems = [
    { label: 'Total Points', value: stats.total.toString(), icon: MapPin, color: 'text-slate-600' },
    {
      label: 'Match Rate',
      value: `${stats.matchRate.toFixed(0)}%`,
      icon: stats.matchRate > 80 ? CheckCircle2 : AlertTriangle,
      color: stats.matchRate > 80 ? 'text-green-600' : stats.matchRate > 50 ? 'text-yellow-600' : 'text-red-600',
    },
    {
      label: 'Avg Accuracy',
      value: stats.avgAccuracy !== null ? `${stats.avgAccuracy.toFixed(0)}m` : '—',
      icon: Target,
      color: stats.avgAccuracy !== null && stats.avgAccuracy < 15 ? 'text-green-600' : 'text-yellow-600',
    },
    {
      label: 'Max Gap',
      value: stats.maxGap > 0 ? formatDuration(stats.maxGap) : '—',
      icon: Clock,
      color: stats.maxGap > 3 * 60 * 1000 ? 'text-red-600' : 'text-slate-600',
    },
    {
      label: 'Sync Delays',
      value: stats.syncDelayCount.toString(),
      icon: stats.syncDelayCount > 0 ? WifiOff : Wifi,
      color: stats.syncDelayCount > 0 ? 'text-amber-600' : 'text-green-600',
    },
    {
      label: 'Speed Anomalies',
      value: stats.speedAnomalyCount.toString(),
      icon: Zap,
      color: stats.speedAnomalyCount > 0 ? 'text-red-600' : 'text-green-600',
    },
  ];

  return (
    <div className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-6 gap-3">
      {statItems.map((item) => (
        <div key={item.label} className="flex items-center gap-2.5 rounded-lg border bg-white p-3">
          <item.icon className={cn('h-4 w-4 shrink-0', item.color)} />
          <div className="min-w-0">
            <p className="text-xs text-muted-foreground truncate">{item.label}</p>
            <p className="text-sm font-semibold">{item.value}</p>
          </div>
        </div>
      ))}
    </div>
  );
}

function formatDuration(ms: number): string {
  const totalSec = Math.round(ms / 1000);
  if (totalSec < 60) return `${totalSec}s`;
  const min = Math.floor(totalSec / 60);
  const sec = totalSec % 60;
  if (min < 60) return sec > 0 ? `${min}m ${sec}s` : `${min}m`;
  const hr = Math.floor(min / 60);
  const remMin = min % 60;
  return remMin > 0 ? `${hr}h ${remMin}m` : `${hr}h`;
}

// ============================================
// DATA TABLE
// ============================================

function DiagnosticTable({
  points,
  selectedIndex,
  onRowClick,
  tableRef,
}: {
  points: DiagnosticPoint[];
  selectedIndex: number | null;
  onRowClick: (index: number) => void;
  tableRef: React.RefObject<HTMLDivElement | null>;
}) {
  return (
    <div ref={tableRef} className="overflow-auto max-h-[420px] border rounded-lg bg-white">
      <table className="w-full text-xs">
        <thead className="sticky top-0 z-10 bg-slate-50 border-b">
          <tr>
            <th className="px-2 py-2 text-left font-medium text-muted-foreground w-10">#</th>
            <th className="px-2 py-2 text-left font-medium text-muted-foreground w-20">Time</th>
            <th className="px-2 py-2 text-left font-medium text-muted-foreground">Lat / Lng</th>
            <th className="px-2 py-2 text-center font-medium text-muted-foreground w-16">Acc (m)</th>
            <th className="px-2 py-2 text-center font-medium text-muted-foreground w-16">Speed</th>
            <th className="px-2 py-2 text-center font-medium text-muted-foreground w-14">Hdg</th>
            <th className="px-2 py-2 text-center font-medium text-muted-foreground w-16">Match</th>
            <th className="px-2 py-2 text-center font-medium text-muted-foreground w-16">Drift</th>
            <th className="px-2 py-2 text-left font-medium text-muted-foreground w-28">Road</th>
            <th className="px-2 py-2 text-center font-medium text-muted-foreground w-16">Gap</th>
            <th className="px-2 py-2 text-center font-medium text-muted-foreground w-16">Sync</th>
            <th className="px-2 py-2 text-center font-medium text-muted-foreground w-10">Bat</th>
          </tr>
        </thead>
        <tbody className="divide-y divide-slate-100">
          {points.map((p) => {
            const isSelected = selectedIndex === p.index;
            const batchEven = (p.batchIndex ?? 0) % 2 === 0;

            return (
              <tr
                key={p.id}
                data-index={p.index}
                onClick={() => onRowClick(p.index)}
                className={cn(
                  'cursor-pointer transition-colors',
                  isSelected
                    ? 'bg-blue-50 ring-1 ring-inset ring-blue-300'
                    : batchEven
                      ? 'hover:bg-slate-50'
                      : 'bg-slate-50/40 hover:bg-slate-100/60'
                )}
              >
                <td className="px-2 py-1.5 font-mono text-muted-foreground">{p.index + 1}</td>
                <td className="px-2 py-1.5 font-mono whitespace-nowrap">
                  {format(new Date(p.recordedAt), 'HH:mm:ss')}
                </td>
                <td className="px-2 py-1.5 font-mono">
                  {p.latitude.toFixed(5)}, {p.longitude.toFixed(5)}
                </td>
                <td className="px-2 py-1.5 text-center">
                  {p.accuracy !== null ? (
                    <span className={cn(
                      'font-mono',
                      p.accuracy < 15 ? 'text-green-600' : p.accuracy < 40 ? 'text-yellow-600' : 'text-red-600'
                    )}>
                      {p.accuracy.toFixed(0)}
                    </span>
                  ) : <span className="text-slate-300">—</span>}
                </td>
                <td className="px-2 py-1.5 text-center">
                  {p.speedMph !== null ? (
                    <span className={cn('font-mono', p.speedMph > 80 ? 'text-red-600 font-bold' : '')}>
                      {p.speedMph.toFixed(0)}
                    </span>
                  ) : <span className="text-slate-300">—</span>}
                  {p.impliedSpeedMph !== null && p.impliedSpeedMph > 120 && (
                    <span className="ml-0.5 text-red-500" title={`Implied: ${p.impliedSpeedMph.toFixed(0)} mph`}>!</span>
                  )}
                </td>
                <td className="px-2 py-1.5 text-center font-mono text-muted-foreground">
                  {p.heading !== null ? p.heading.toFixed(0) + '°' : '—'}
                </td>
                <td className="px-2 py-1.5 text-center">
                  {p.matched === null ? (
                    <Badge variant="outline" className="text-[10px] px-1.5 py-0 bg-slate-50">...</Badge>
                  ) : p.matched ? (
                    <Badge variant="outline" className="text-[10px] px-1.5 py-0 bg-green-50 text-green-700 border-green-200">OK</Badge>
                  ) : (
                    <Badge variant="outline" className="text-[10px] px-1.5 py-0 bg-red-50 text-red-700 border-red-200">Miss</Badge>
                  )}
                </td>
                <td className="px-2 py-1.5 text-center font-mono">
                  {p.driftMeters !== null ? (
                    <span className={cn(p.driftMeters > 30 ? 'text-amber-600' : 'text-muted-foreground')}>
                      {p.driftMeters.toFixed(0)}
                    </span>
                  ) : <span className="text-slate-300">—</span>}
                </td>
                <td className="px-2 py-1.5 text-muted-foreground truncate max-w-[120px]" title={p.roadName ?? ''}>
                  {p.roadName || '—'}
                </td>
                <td className="px-2 py-1.5 text-center">
                  {p.timeGapMs !== null ? (
                    <span className={cn(
                      'font-mono',
                      p.timeGapMs > 3 * 60 * 1000 ? 'text-red-600 font-bold' : p.timeGapMs > 2 * 60 * 1000 ? 'text-yellow-600' : 'text-muted-foreground'
                    )}>
                      {formatDuration(p.timeGapMs)}
                    </span>
                  ) : <span className="text-slate-300">—</span>}
                </td>
                <td className="px-2 py-1.5 text-center">
                  <span className={cn(
                    'font-mono',
                    p.syncDelayMs > 10 * 60 * 1000 ? 'text-red-600 font-bold' : p.syncDelayMs > 5 * 60 * 1000 ? 'text-amber-600' : 'text-muted-foreground'
                  )}>
                    {formatDuration(p.syncDelayMs)}
                  </span>
                </td>
                <td className="px-2 py-1.5 text-center font-mono text-muted-foreground">
                  {p.batchIndex !== null ? p.batchIndex : '—'}
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

// ============================================
// MAIN COMPONENT
// ============================================

export function GpsLogsView({ loadId, organizationId }: GpsLogsViewProps) {
  const apiKey = useGoogleMapsKey();
  const tableRef = useRef<HTMLDivElement>(null);
  const [selectedIndex, setSelectedIndex] = useState<number | null>(null);
  const [diagnosticsResult, setDiagnosticsResult] = useState<{
    encodedPolyline?: string;
    confidence: number;
    tracepoints: Array<{
      originalIndex: number;
      matched: boolean;
      snappedLat?: number;
      snappedLng?: number;
      roadName?: string;
      driftMeters?: number;
      batchIndex: number;
    }>;
  } | null>(null);
  const [isLoadingDiag, setIsLoadingDiag] = useState(false);
  const [diagError, setDiagError] = useState<string | null>(null);

  const rawPoints = useAuthQuery(
    api.driverLocations.getDetailedRouteHistoryForLoad,
    { loadId: loadId as Id<'loadInformation'> }
  );

  const mapMatchDiag = useAction(api.googleRoads.mapMatchRouteWithDiagnostics);

  // Run diagnostics when raw points load
  const rawPointsFingerprint = rawPoints
    ? `${rawPoints.length}:${rawPoints[0]?.recordedAt}:${rawPoints[rawPoints.length - 1]?.recordedAt}`
    : '__loading__';

  const fetchDiagnostics = useCallback(async () => {
    if (!rawPoints || rawPoints.length < 2) return;
    setIsLoadingDiag(true);
    setDiagError(null);
    try {
      const coordinates = rawPoints.map((p) => ({
        latitude: p.latitude,
        longitude: p.longitude,
        timestamp: p.recordedAt,
      }));
      const result = await mapMatchDiag({ coordinates });
      setDiagnosticsResult({
        encodedPolyline: result.encodedPolyline,
        confidence: result.confidence,
        tracepoints: result.tracepoints,
      });
    } catch (err) {
      console.error('[GpsLogs] Diagnostics failed:', err);
      setDiagError(err instanceof Error ? err.message : 'Map matching failed');
    } finally {
      setIsLoadingDiag(false);
    }
  }, [rawPoints, mapMatchDiag]);

  useEffect(() => {
    if (rawPoints && rawPoints.length >= 2 && !diagnosticsResult && !isLoadingDiag) {
      fetchDiagnostics();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [rawPointsFingerprint]);

  // Build unified diagnostic points
  const diagnosticPoints: DiagnosticPoint[] = useMemo(() => {
    if (!rawPoints) return [];

    return rawPoints.map((p, i) => {
      const prev = i > 0 ? rawPoints[i - 1] : null;
      const timeGapMs = prev ? p.recordedAt - prev.recordedAt : null;
      const syncDelayMs = p.createdAt - p.recordedAt;

      let distFromPrevMeters: number | null = null;
      let impliedSpeedMph: number | null = null;
      if (prev) {
        distFromPrevMeters = haversineMeters(prev.latitude, prev.longitude, p.latitude, p.longitude);
        if (timeGapMs && timeGapMs > 0) {
          const mps = distFromPrevMeters / (timeGapMs / 1000);
          impliedSpeedMph = mps * 2.23694;
        }
      }

      const tp = diagnosticsResult?.tracepoints.find((t) => t.originalIndex === i);

      return {
        index: i,
        id: p._id,
        latitude: p.latitude,
        longitude: p.longitude,
        accuracy: p.accuracy ?? null,
        speedMph: p.speed !== undefined && p.speed !== null ? p.speed * 2.23694 : null,
        heading: p.heading ?? null,
        recordedAt: p.recordedAt,
        createdAt: p.createdAt,
        timeGapMs,
        syncDelayMs: Math.max(0, syncDelayMs),
        impliedSpeedMph,
        distFromPrevMeters,
        matched: tp ? tp.matched : null,
        snappedLat: tp?.snappedLat ?? null,
        snappedLng: tp?.snappedLng ?? null,
        roadName: tp?.roadName ?? null,
        driftMeters: tp?.driftMeters ?? null,
        batchIndex: tp?.batchIndex ?? null,
      };
    });
  }, [rawPoints, diagnosticsResult]);

  // Pan map to selected point
  const handlePointSelect = useCallback((index: number) => {
    setSelectedIndex((prev) => (prev === index ? null : index));

    // Scroll table row into view
    if (tableRef.current) {
      const row = tableRef.current.querySelector(`[data-index="${index}"]`);
      if (row) {
        row.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
      }
    }
  }, []);

  // Loading state
  if (rawPoints === undefined) {
    return (
      <div className="space-y-4">
        <Header loadId={loadId} onExport={() => {}} onRefresh={() => {}} isLoading />
        <div className="flex items-center justify-center py-20">
          <div className="flex flex-col items-center gap-3">
            <div className="w-8 h-8 border-2 border-blue-500 border-t-transparent rounded-full animate-spin" />
            <p className="text-sm text-muted-foreground">Loading GPS data...</p>
          </div>
        </div>
      </div>
    );
  }

  // Empty state
  if (rawPoints.length === 0) {
    return (
      <div className="space-y-4">
        <Header loadId={loadId} onExport={() => {}} onRefresh={() => {}} />
        <Card className="flex flex-col items-center justify-center py-20">
          <Radar className="h-12 w-12 text-slate-300 mb-3" />
          <p className="font-medium text-sm">No GPS Data</p>
          <p className="text-xs text-muted-foreground mt-1">
            GPS tracking will appear when the driver starts the route
          </p>
        </Card>
      </div>
    );
  }

  const selectedPoint = selectedIndex !== null ? diagnosticPoints[selectedIndex] : null;

  return (
    <div className="space-y-4">
      <Header
        loadId={loadId}
        onExport={() => exportCsv(diagnosticPoints, loadId)}
        onRefresh={fetchDiagnostics}
        isLoading={isLoadingDiag}
        pointCount={rawPoints.length}
        confidence={diagnosticsResult?.confidence}
      />

      <SummaryStats points={diagnosticPoints} />

      {diagError && (
        <div className="flex items-center gap-2 p-3 rounded-lg border border-red-200 bg-red-50 text-sm text-red-700">
          <XCircle className="h-4 w-4 shrink-0" />
          <span>Map matching failed: {diagError}</span>
          <Button variant="outline" size="sm" className="ml-auto h-7 text-xs" onClick={fetchDiagnostics}>
            Retry
          </Button>
        </div>
      )}

      {/* Map */}
      {apiKey ? (
        <Card className="overflow-hidden !p-0">
          <div className="relative" style={{ height: '420px' }}>
            <APIProvider apiKey={apiKey}>
              <Map
                defaultCenter={{ lat: diagnosticPoints[0].latitude, lng: diagnosticPoints[0].longitude }}
                defaultZoom={12}
                mapId={process.env.NEXT_PUBLIC_GOOGLE_MAP_ID || 'gps-diag-map'}
                gestureHandling="cooperative"
                disableDefaultUI
                zoomControl
                fullscreenControl
                className="w-full h-full"
              >
                <DiagnosticBoundsFitter points={diagnosticPoints} />
                <DiagnosticMapOverlay
                  points={diagnosticPoints}
                  encodedPolyline={diagnosticsResult?.encodedPolyline}
                  selectedIndex={selectedIndex}
                  onPointClick={handlePointSelect}
                />
                {selectedPoint && selectedPoint.snappedLat && selectedPoint.snappedLng && (
                  <AdvancedMarker position={{ lat: selectedPoint.snappedLat, lng: selectedPoint.snappedLng }}>
                    <div className="w-3 h-3 rounded-full bg-blue-500 border-2 border-white shadow-lg" />
                  </AdvancedMarker>
                )}
              </Map>
            </APIProvider>

            {/* Loading overlay */}
            {isLoadingDiag && (
              <div className="absolute top-3 left-3 z-10 bg-white/95 backdrop-blur border rounded-lg px-3 py-1.5 shadow-sm">
                <div className="flex items-center gap-2 text-xs text-muted-foreground">
                  <div className="w-3 h-3 border-2 border-blue-500 border-t-transparent rounded-full animate-spin" />
                  Running map matching...
                </div>
              </div>
            )}

            {/* Selected point info */}
            {selectedPoint && (
              <div className="absolute bottom-3 left-3 z-10 bg-white/95 backdrop-blur border rounded-lg px-3 py-2 shadow-lg max-w-xs">
                <div className="text-xs space-y-1">
                  <div className="font-semibold">Point #{selectedPoint.index + 1}</div>
                  <div className="text-muted-foreground">
                    {format(new Date(selectedPoint.recordedAt), 'MMM d, h:mm:ss a')}
                  </div>
                  {selectedPoint.roadName && (
                    <div className="text-muted-foreground">{selectedPoint.roadName}</div>
                  )}
                  <div className="flex gap-3 text-muted-foreground">
                    {selectedPoint.accuracy !== null && <span>Acc: {selectedPoint.accuracy.toFixed(0)}m</span>}
                    {selectedPoint.driftMeters !== null && <span>Drift: {selectedPoint.driftMeters.toFixed(0)}m</span>}
                    {selectedPoint.speedMph !== null && <span>{selectedPoint.speedMph.toFixed(0)} mph</span>}
                  </div>
                </div>
              </div>
            )}

            {/* Legend */}
            <div className="absolute top-3 right-3 z-10 bg-white/95 backdrop-blur border rounded-lg px-3 py-2 shadow-sm">
              <div className="text-[10px] font-medium text-muted-foreground mb-1.5 uppercase tracking-wider">Legend</div>
              <div className="space-y-1 text-[11px]">
                <div className="flex items-center gap-1.5"><span className="w-2.5 h-2.5 rounded-full bg-green-500" /> Matched</div>
                <div className="flex items-center gap-1.5"><span className="w-2.5 h-2.5 rounded-full bg-red-500" /> Unmatched</div>
                <div className="flex items-center gap-1.5"><span className="w-2.5 h-2.5 rounded-full bg-yellow-500" /> Low accuracy</div>
                <div className="flex items-center gap-1.5"><span className="w-2.5 h-2.5 rounded-full bg-orange-500" /> Time gap</div>
              </div>
            </div>
          </div>
        </Card>
      ) : (
        <Card className="flex items-center justify-center py-16">
          <div className="text-center">
            <MapPin className="h-8 w-8 text-muted-foreground mx-auto mb-2" />
            <p className="text-sm text-muted-foreground">Maps API not configured</p>
          </div>
        </Card>
      )}

      {/* Data Table */}
      <DiagnosticTable
        points={diagnosticPoints}
        selectedIndex={selectedIndex}
        onRowClick={handlePointSelect}
        tableRef={tableRef}
      />
    </div>
  );
}

// ============================================
// HEADER
// ============================================

function Header({
  loadId,
  onExport,
  onRefresh,
  isLoading,
  pointCount,
  confidence,
}: {
  loadId: string;
  onExport: () => void;
  onRefresh: () => void;
  isLoading?: boolean;
  pointCount?: number;
  confidence?: number;
}) {
  return (
    <div className="flex items-center justify-between">
      <div className="flex items-center gap-3">
        <Link href={`/loads/${loadId}`}>
          <Button variant="ghost" size="icon" className="h-9 w-9">
            <ArrowLeft className="h-4 w-4" />
          </Button>
        </Link>
        <div>
          <h1 className="text-lg font-bold tracking-tight flex items-center gap-2">
            <Radar className="h-5 w-5 text-muted-foreground" />
            GPS Diagnostics
          </h1>
          <div className="flex items-center gap-3 text-xs text-muted-foreground mt-0.5">
            {pointCount !== undefined && <span>{pointCount} points</span>}
            {confidence !== undefined && confidence > 0 && (
              <>
                <span className="text-muted-foreground/40">|</span>
                <span>{(confidence * 100).toFixed(0)}% match confidence</span>
              </>
            )}
          </div>
        </div>
      </div>
      <div className="flex items-center gap-2">
        <Button variant="outline" size="sm" onClick={onRefresh} disabled={isLoading}>
          <RefreshCw className={cn('mr-2 h-3.5 w-3.5', isLoading && 'animate-spin')} />
          {isLoading ? 'Matching...' : 'Re-match'}
        </Button>
        <Button variant="outline" size="sm" onClick={onExport}>
          <Download className="mr-2 h-3.5 w-3.5" />
          Export CSV
        </Button>
      </div>
    </div>
  );
}
