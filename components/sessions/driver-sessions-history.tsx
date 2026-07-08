'use client';

import { Fragment, useState } from 'react';
import { useQuery } from 'convex/react';
import { ChevronDown, ChevronRight, MapPin } from 'lucide-react';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { api } from '@/convex/_generated/api';
import type { Id } from '@/convex/_generated/dataModel';

// Industry-standard free time before detention billing starts; dwell at or
// beyond this gets the warning treatment in the timeline.
const DETENTION_FREE_MINUTES = 120;

function formatTime(ms: number | null): string {
  if (ms === null) return '—';
  return new Date(ms).toLocaleString('en-US', {
    month: 'short',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
  });
}

function formatDwell(minutes: number): string {
  const h = Math.floor(minutes / 60);
  const m = minutes % 60;
  return h > 0 ? `${h}h ${m}m` : `${m}m`;
}

/**
 * Per-stop geofence + manual timestamp timeline for one expanded session.
 * "GPS" columns are the immutable geofence-detected times; check-in/out are
 * the driver's manual taps. Both are shown so dispatchers can compare
 * detected vs reported — the record detention conversations need.
 */
function SessionStopTimeline({ sessionId }: { sessionId: Id<'driverSessions'> }) {
  const timeline = useQuery(api.driverSessions.getSessionStopTimeline, { sessionId });

  if (timeline === undefined) {
    return <div className="py-4 text-center text-sm text-muted-foreground">Loading…</div>;
  }
  if (timeline.length === 0) {
    return (
      <div className="py-4 text-center text-sm text-muted-foreground">No stop activity recorded for this session.</div>
    );
  }

  return (
    <Table>
      <TableHeader>
        <TableRow className="hover:bg-transparent">
          <TableHead>Stop</TableHead>
          <TableHead>Arrived (GPS)</TableHead>
          <TableHead>Checked in</TableHead>
          <TableHead>Checked out</TableHead>
          <TableHead>Departed (GPS)</TableHead>
          <TableHead>Dwell</TableHead>
        </TableRow>
      </TableHeader>
      <TableBody>
        {timeline.map((stop) => (
          <TableRow key={`${stop.loadId}-${stop.sequenceNumber}`} className="hover:bg-transparent">
            <TableCell>
              <div className="flex items-center gap-2">
                <MapPin className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
                <div className="min-w-0">
                  <div className="flex items-center gap-1.5 text-sm">
                    {stop.stopType && (
                      <Badge variant="outline" className="text-xs">
                        {stop.stopType === 'PICKUP' ? 'Pickup' : stop.stopType === 'DELIVERY' ? 'Delivery' : 'Detour'}
                      </Badge>
                    )}
                    <span className="truncate">
                      {stop.city && stop.state ? `${stop.city}, ${stop.state}` : (stop.address ?? '—')}
                    </span>
                  </div>
                  {stop.loadInternalId && (
                    <div className="text-xs text-muted-foreground">
                      Load {stop.loadInternalId} · Stop {stop.sequenceNumber}
                    </div>
                  )}
                </div>
              </div>
            </TableCell>
            <TableCell className="text-sm">{formatTime(stop.arrivedAt)}</TableCell>
            <TableCell className="text-sm text-muted-foreground">{formatTime(stop.checkedInAt)}</TableCell>
            <TableCell className="text-sm text-muted-foreground">{formatTime(stop.checkedOutAt)}</TableCell>
            <TableCell className="text-sm">{formatTime(stop.departedAt)}</TableCell>
            <TableCell>
              {stop.dwellMinutes === null ? (
                <span className="text-sm text-muted-foreground">—</span>
              ) : stop.dwellMinutes >= DETENTION_FREE_MINUTES ? (
                <Badge variant="warning" className="text-xs">
                  {formatDwell(stop.dwellMinutes)}
                </Badge>
              ) : (
                <Badge variant="secondary" className="text-xs">
                  {formatDwell(stop.dwellMinutes)}
                </Badge>
              )}
            </TableCell>
          </TableRow>
        ))}
      </TableBody>
    </Table>
  );
}

/**
 * Per-driver session history. Read-only — listing is meant for ops to spot
 * patterns (frequent dispatch overrides, drivers regularly hitting the 14h
 * soft cap, etc.). Rows expand to a per-stop timeline of geofence-detected
 * arrival/departure times next to the driver's manual check-in/out taps.
 * Active sessions are included with status='active' and empty endedAt; the
 * active-sessions dashboard at /dispatch/sessions is the better surface for
 * live monitoring of those.
 */
export function DriverSessionsHistory({ driverId }: { driverId: Id<'drivers'> }) {
  const sessions = useQuery(api.driverSessions.listForDriver, { driverId, limit: 50 });
  const isLoading = sessions === undefined;
  const [expandedId, setExpandedId] = useState<Id<'driverSessions'> | null>(null);

  return (
    <div className="rounded-md border">
      <Table>
        <TableHeader>
          <TableRow>
            <TableHead className="w-8" />
            <TableHead>Started</TableHead>
            <TableHead>Ended</TableHead>
            <TableHead>Duration</TableHead>
            <TableHead>Truck</TableHead>
            <TableHead>Loads</TableHead>
            <TableHead>End Reason</TableHead>
            <TableHead>Soft Caps</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {isLoading ? (
            <TableRow>
              <TableCell colSpan={8} className="text-center py-6 text-muted-foreground">
                Loading…
              </TableCell>
            </TableRow>
          ) : sessions.length === 0 ? (
            <TableRow>
              <TableCell colSpan={8} className="text-center py-6 text-muted-foreground">
                This driver has no sessions on record.
              </TableCell>
            </TableRow>
          ) : (
            sessions.map((s) => {
              const durationMinutes =
                s.totalActiveMinutes ??
                (s.endedAt
                  ? Math.round((s.endedAt - s.startedAt) / 60_000)
                  : Math.round((Date.now() - s.startedAt) / 60_000));
              const isExpanded = expandedId === s._id;
              return (
                <Fragment key={s._id}>
                  <TableRow className="cursor-pointer" onClick={() => setExpandedId(isExpanded ? null : s._id)}>
                    <TableCell className="py-0">
                      <Button
                        variant="ghost"
                        size="icon"
                        className="h-6 w-6"
                        aria-label={isExpanded ? 'Collapse stop timeline' : 'Expand stop timeline'}
                      >
                        {isExpanded ? <ChevronDown className="h-4 w-4" /> : <ChevronRight className="h-4 w-4" />}
                      </Button>
                    </TableCell>
                    <TableCell className="text-sm">
                      {new Date(s.startedAt).toLocaleString('en-US', {
                        month: 'short',
                        day: 'numeric',
                        year: 'numeric',
                        hour: 'numeric',
                        minute: '2-digit',
                      })}
                    </TableCell>
                    <TableCell className="text-sm text-muted-foreground">
                      {s.endedAt
                        ? new Date(s.endedAt).toLocaleString('en-US', {
                            month: 'short',
                            day: 'numeric',
                            hour: 'numeric',
                            minute: '2-digit',
                          })
                        : '—'}
                    </TableCell>
                    <TableCell>{`${Math.floor(durationMinutes / 60)}h ${durationMinutes % 60}m`}</TableCell>
                    <TableCell>{s.truckUnitId ? `Unit ${s.truckUnitId}` : '—'}</TableCell>
                    <TableCell>{s.legCount}</TableCell>
                    <TableCell>
                      {s.status === 'active' ? (
                        <Badge variant="success">Active</Badge>
                      ) : s.endReason === 'dispatch_override' ? (
                        <span className="text-sm">
                          <Badge variant="destructive" className="mr-1">
                            Dispatch
                          </Badge>
                          {s.endedByReasonCode ?? '—'}
                        </span>
                      ) : s.endReason === 'auto_timeout' ? (
                        <Badge variant="warning">Auto-timeout</Badge>
                      ) : s.endReason === 'handoff_complete' ? (
                        <Badge variant="secondary">Handoff</Badge>
                      ) : s.endReason === 'next_session_opened' ? (
                        <Badge variant="secondary">New shift</Badge>
                      ) : s.endReason === 'driver_manual' ? (
                        <Badge variant="outline">Driver ended</Badge>
                      ) : (
                        <span className="text-sm text-muted-foreground">—</span>
                      )}
                    </TableCell>
                    <TableCell>
                      <div className="flex gap-1">
                        {s.softCap14hAt ? (
                          <Badge variant="destructive" className="text-xs">
                            14h
                          </Badge>
                        ) : s.softCap10hAt ? (
                          <Badge variant="warning" className="text-xs">
                            10h
                          </Badge>
                        ) : (
                          <span className="text-sm text-muted-foreground">—</span>
                        )}
                      </div>
                    </TableCell>
                  </TableRow>
                  {isExpanded && (
                    <TableRow className="hover:bg-transparent">
                      <TableCell colSpan={8} className="bg-muted/30 p-0">
                        <div className="px-4 py-2">
                          <SessionStopTimeline sessionId={s._id} />
                        </div>
                      </TableCell>
                    </TableRow>
                  )}
                </Fragment>
              );
            })
          )}
        </TableBody>
      </Table>
    </div>
  );
}
