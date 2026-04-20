'use client';

import { useEffect, useMemo, useState } from 'react';
import { useConvex, useQuery } from 'convex/react';
import {
  Breadcrumb,
  BreadcrumbItem,
  BreadcrumbLink,
  BreadcrumbList,
  BreadcrumbPage,
  BreadcrumbSeparator,
} from '@/components/ui/breadcrumb';
import { Separator } from '@/components/ui/separator';
import { SidebarTrigger } from '@/components/ui/sidebar';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Input } from '@/components/ui/input';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import { AlertTriangle, Search, Clock } from 'lucide-react';
import { api } from '@/convex/_generated/api';
import type { Id } from '@/convex/_generated/dataModel';
import { ForceEndShiftDialog } from '@/components/sessions/force-end-shift-dialog';

// ============================================================================
// ACTIVE DRIVER SESSIONS DASHBOARD
//
// Two-lane data fetch (per Phase 6 design):
//   1. Reactive query — `listActiveForOrg` — subscribes to driverSessions
//      writes only. Per-ping GPS writes don't invalidate this subscription
//      because they go to driverLocations (a different table / read set).
//   2. Polled query — `getSessionFreshness` — invoked one-shot via the
//      Convex client every 60 seconds. Returns `{ sessionId → latestRecordedAt }`
//      so we can render "last ping N min ago" without registering a reactive
//      subscription on driverLocations.
//
// 60-second polling is a deliberate choice: dispatcher UI cannot meaningfully
// distinguish 2m vs 2m 15s freshness, and a 60s cadence is 4× cheaper than
// 15s while feeling responsive.
// ============================================================================

const FRESHNESS_POLL_INTERVAL_MS = 60_000;
const SOFT_CAP_10H_MS = 10 * 60 * 60 * 1000;
const SOFT_CAP_14H_MS = 14 * 60 * 60 * 1000;

function formatElapsed(ms: number): string {
  if (ms < 0) return '—';
  const hours = Math.floor(ms / (60 * 60 * 1000));
  const minutes = Math.floor((ms % (60 * 60 * 1000)) / 60_000);
  return `${hours}h ${minutes}m`;
}

function formatPingAge(latestRecordedAt: number | null, now: number): string {
  if (latestRecordedAt === null) return 'no pings';
  const ageMs = now - latestRecordedAt;
  if (ageMs < 60_000) return 'just now';
  const minutes = Math.floor(ageMs / 60_000);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  return `${hours}h ${minutes % 60}m ago`;
}

function pingAgeBadgeVariant(
  latestRecordedAt: number | null,
  now: number,
): 'success' | 'warning' | 'destructive' | 'secondary' {
  if (latestRecordedAt === null) return 'secondary';
  const ageMs = now - latestRecordedAt;
  if (ageMs < 5 * 60_000) return 'success';
  if (ageMs < 15 * 60_000) return 'warning';
  return 'destructive';
}

export default function ActiveSessionsPage() {
  const convex = useConvex();

  // Reactive lane: stable session metadata. Only re-fires on lifecycle
  // events (start, end, truck swap, soft-cap stamp).
  const sessions = useQuery(api.driverSessions.listActiveForOrg, {});

  // Polled lane: freshness map. State holds the latest snapshot returned
  // from the one-shot query.
  const [freshness, setFreshness] = useState<Record<string, number | null>>({});
  const [now, setNow] = useState(() => Date.now());

  useEffect(() => {
    let cancelled = false;
    async function pollOnce() {
      try {
        const result = await convex.query(api.driverSessions.getSessionFreshness, {});
        if (!cancelled) {
          setFreshness(result as Record<string, number | null>);
          setNow(Date.now());
        }
      } catch (err) {
        // Polling failures are non-fatal — keep last snapshot, retry next tick.
        console.warn('[ActiveSessions] freshness poll failed:', err);
      }
    }
    pollOnce();
    const id = setInterval(pollOnce, FRESHNESS_POLL_INTERVAL_MS);
    // Lightweight tick every 30s to advance the elapsed-time + relative-age
    // labels between polls. Doesn't refetch — just re-renders.
    const tickId = setInterval(() => setNow(Date.now()), 30_000);
    return () => {
      cancelled = true;
      clearInterval(id);
      clearInterval(tickId);
    };
  }, [convex]);

  const [search, setSearch] = useState('');
  const [endShiftTarget, setEndShiftTarget] = useState<{
    sessionId: Id<'driverSessions'>;
    driverName: string;
  } | null>(null);

  const filteredSessions = useMemo(() => {
    if (!sessions) return [];
    if (!search.trim()) return sessions;
    const needle = search.trim().toLowerCase();
    return sessions.filter(
      (s) =>
        s.driverName?.toLowerCase().includes(needle) ||
        s.truckUnitId?.toLowerCase().includes(needle),
    );
  }, [sessions, search]);

  const isLoading = sessions === undefined;

  return (
    <>
      <header className="flex h-16 shrink-0 items-center gap-2 transition-[width,height] ease-linear group-has-data-[collapsible=icon]/sidebar-wrapper:h-12 border-b">
        <div className="flex items-center gap-2 px-4">
          <SidebarTrigger className="-ml-1" />
          <Separator
            orientation="vertical"
            className="mr-2 data-[orientation=vertical]:h-4"
          />
          <Breadcrumb>
            <BreadcrumbList>
              <BreadcrumbItem className="hidden md:block">
                <BreadcrumbLink href="/dashboard">Dashboard</BreadcrumbLink>
              </BreadcrumbItem>
              <BreadcrumbSeparator className="hidden md:block" />
              <BreadcrumbItem className="hidden md:block">
                <BreadcrumbLink href="#">Load Operations</BreadcrumbLink>
              </BreadcrumbItem>
              <BreadcrumbSeparator className="hidden md:block" />
              <BreadcrumbItem>
                <BreadcrumbPage>Active Driver Sessions</BreadcrumbPage>
              </BreadcrumbItem>
            </BreadcrumbList>
          </Breadcrumb>
        </div>
      </header>

      <div className="flex-1 overflow-hidden">
        <div className="h-full flex flex-col p-6">
          <div className="flex-shrink-0 flex items-center justify-between mb-4">
            <div>
              <h1 className="text-3xl font-bold tracking-tight">Active Driver Sessions</h1>
              <p className="text-muted-foreground">
                Drivers currently on shift. Updated live; freshness polled every minute.
              </p>
            </div>
            <div className="flex items-center gap-2">
              <div className="relative">
                <Search className="absolute left-2 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
                <Input
                  placeholder="Search driver or truck"
                  value={search}
                  onChange={(e) => setSearch(e.target.value)}
                  className="pl-8 w-64"
                />
              </div>
            </div>
          </div>

          <div className="flex-1 overflow-auto rounded-md border">
            <Table>
              <TableHeader className="sticky top-0 bg-background z-10">
                <TableRow>
                  <TableHead>Driver</TableHead>
                  <TableHead>Truck</TableHead>
                  <TableHead>Started</TableHead>
                  <TableHead>Elapsed</TableHead>
                  <TableHead>Last Ping</TableHead>
                  <TableHead>Status</TableHead>
                  <TableHead className="w-[140px] text-right">Actions</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {isLoading ? (
                  <TableRow>
                    <TableCell colSpan={7} className="text-center py-8 text-muted-foreground">
                      Loading…
                    </TableCell>
                  </TableRow>
                ) : filteredSessions.length === 0 ? (
                  <TableRow>
                    <TableCell colSpan={7} className="text-center py-8 text-muted-foreground">
                      {search.trim()
                        ? 'No drivers match your search.'
                        : 'No drivers are currently on shift.'}
                    </TableCell>
                  </TableRow>
                ) : (
                  filteredSessions.map((session) => {
                    const elapsedMs = now - session.startedAt;
                    const overSoftCap14h =
                      elapsedMs >= SOFT_CAP_14H_MS || session.softCap14hAt !== undefined;
                    const overSoftCap10h =
                      !overSoftCap14h &&
                      (elapsedMs >= SOFT_CAP_10H_MS || session.softCap10hAt !== undefined);
                    const latestRecordedAt = freshness[session._id] ?? null;

                    return (
                      <TableRow
                        key={session._id}
                        className={
                          overSoftCap14h
                            ? 'bg-red-50 dark:bg-red-950/30'
                            : overSoftCap10h
                              ? 'bg-amber-50 dark:bg-amber-950/30'
                              : ''
                        }
                      >
                        <TableCell className="font-medium">
                          {session.driverName ?? '(unknown driver)'}
                        </TableCell>
                        <TableCell>
                          {session.truckUnitId ? `Unit ${session.truckUnitId}` : '—'}
                        </TableCell>
                        <TableCell className="text-muted-foreground">
                          {new Date(session.startedAt).toLocaleString('en-US', {
                            hour: 'numeric',
                            minute: '2-digit',
                            month: 'short',
                            day: 'numeric',
                          })}
                        </TableCell>
                        <TableCell>
                          <div className="flex items-center gap-2">
                            <Clock className="h-3.5 w-3.5 text-muted-foreground" />
                            <span>{formatElapsed(elapsedMs)}</span>
                            {overSoftCap14h && (
                              <Badge variant="destructive" className="text-xs">
                                14h+
                              </Badge>
                            )}
                            {overSoftCap10h && (
                              <Badge variant="warning" className="text-xs">
                                10h+
                              </Badge>
                            )}
                          </div>
                        </TableCell>
                        <TableCell>
                          <Badge variant={pingAgeBadgeVariant(latestRecordedAt, now)}>
                            {formatPingAge(latestRecordedAt, now)}
                          </Badge>
                        </TableCell>
                        <TableCell>
                          <Badge variant="success">Active</Badge>
                        </TableCell>
                        <TableCell className="text-right">
                          <Button
                            variant="outline"
                            size="sm"
                            onClick={() =>
                              setEndShiftTarget({
                                sessionId: session._id,
                                driverName: session.driverName ?? '(unknown driver)',
                              })
                            }
                          >
                            <AlertTriangle className="mr-1 h-3.5 w-3.5" />
                            Force End
                          </Button>
                        </TableCell>
                      </TableRow>
                    );
                  })
                )}
              </TableBody>
            </Table>
          </div>
        </div>
      </div>

      {endShiftTarget && (
        <ForceEndShiftDialog
          open={true}
          sessionId={endShiftTarget.sessionId}
          driverName={endShiftTarget.driverName}
          onOpenChange={(open) => {
            if (!open) setEndShiftTarget(null);
          }}
        />
      )}
    </>
  );
}
