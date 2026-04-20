'use client';

import { useQuery } from 'convex/react';
import { Badge } from '@/components/ui/badge';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import { api } from '@/convex/_generated/api';
import type { Id } from '@/convex/_generated/dataModel';

/**
 * Per-driver session history. Read-only — listing is meant for ops to spot
 * patterns (frequent dispatch overrides, drivers regularly hitting the 14h
 * soft cap, etc.). Active sessions are included with status='active' and
 * empty endedAt; the active-sessions dashboard at /dispatch/sessions is the
 * better surface for live monitoring of those.
 */
export function DriverSessionsHistory({ driverId }: { driverId: Id<'drivers'> }) {
  const sessions = useQuery(api.driverSessions.listForDriver, { driverId, limit: 50 });
  const isLoading = sessions === undefined;

  return (
    <div className="rounded-md border">
      <Table>
        <TableHeader>
          <TableRow>
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
              <TableCell colSpan={7} className="text-center py-6 text-muted-foreground">
                Loading…
              </TableCell>
            </TableRow>
          ) : sessions.length === 0 ? (
            <TableRow>
              <TableCell colSpan={7} className="text-center py-6 text-muted-foreground">
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
              return (
                <TableRow key={s._id}>
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
                  <TableCell>
                    {`${Math.floor(durationMinutes / 60)}h ${durationMinutes % 60}m`}
                  </TableCell>
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
                        <Badge variant="destructive" className="text-xs">14h</Badge>
                      ) : s.softCap10hAt ? (
                        <Badge variant="warning" className="text-xs">10h</Badge>
                      ) : (
                        <span className="text-sm text-muted-foreground">—</span>
                      )}
                    </div>
                  </TableCell>
                </TableRow>
              );
            })
          )}
        </TableBody>
      </Table>
    </div>
  );
}
