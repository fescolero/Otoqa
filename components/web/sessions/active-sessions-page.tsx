/**
 * ActiveSessionsPage — Live ops view of every driver currently on shift,
 * with a past-day replay mode (read-only) when the date picker is rolled
 * back.
 *
 * Replaces the old table-only `/dispatch/sessions` page. Mirrors the
 * `s-sessions` artboard from `Otoqa Web.html` (`web/screens/sessions-fleet.jsx`).
 *
 * Data lanes:
 *   - LIVE: `sessionsLiveOps.listLiveSessions` (reactive). Bound by
 *     `listRecentPings({ fullHistory: false })` once a driver is selected.
 *   - PAST: `sessionsLiveOps.listSessionsForDay({ ymdKey })` (one-shot per
 *     day). Same `listRecentPings` query, but with `fullHistory: true`,
 *     pulls the entire shift's pings for the polyline.
 *   - The date picker reads `listDaysWithData` so days with no shifts are
 *     visually disabled.
 */

'use client';

import * as React from 'react';
import { useQuery, usePaginatedQuery } from 'convex/react';
import { api } from '@/convex/_generated/api';
import type { Id } from '@/convex/_generated/dataModel';
import { PageHeader, WBtn } from '@/components/web';
import { ForceEndShiftDialog } from '@/components/sessions/force-end-shift-dialog';
import { FleetSidebar } from './fleet-sidebar';
import { SessionMap } from './session-map';
import { SessionActivityPanel } from './session-activity-panel';
import { SessionDatePicker } from './date-picker';
import type {
  DerivedStatus,
  LiveSessionRow,
  PastSessionRow,
  RecentPing,
} from './types';

type StatusFilter = DerivedStatus | 'all';

export function ActiveSessionsPage() {
  // ────────────────── Date / mode ──────────────────
  const today = React.useMemo(() => new Date(), []);
  const [date, setDate] = React.useState<Date>(today);
  const isLive = sameDay(date, today);
  const ymdKey = sameDayKey(date);

  // ────────────────── Reactive live data ──────────────────
  const liveSessions = useQuery(
    api.sessionsLiveOps.listLiveSessions,
    isLive ? {} : 'skip'
  ) as LiveSessionRow[] | undefined;
  const pastSessions = useQuery(
    api.sessionsLiveOps.listSessionsForDay,
    isLive ? 'skip' : { ymdKey }
  ) as PastSessionRow[] | undefined;
  const daysWithData = useQuery(
    api.sessionsLiveOps.listDaysWithData,
    {}
  ) as string[] | undefined;

  const loading = isLive
    ? liveSessions === undefined
    : pastSessions === undefined;
  const sessions = React.useMemo(
    () => (isLive ? (liveSessions ?? []) : (pastSessions ?? [])),
    [isLive, liveSessions, pastSessions]
  );

  // ────────────────── Filter / selection state ──────────────────
  const [search, setSearch] = React.useState('');
  const [statusFilter, setStatusFilter] = React.useState<StatusFilter>('all');
  const [exceptionsOnly, setExceptionsOnly] = React.useState(false);
  const [selectedId, setSelectedId] = React.useState<string | null>(null);
  const [tab, setTab] = React.useState<'trips' | 'pings'>('trips');
  const [hoveredPing, setHoveredPing] = React.useState<RecentPing | null>(null);
  const [forceEndOpen, setForceEndOpen] = React.useState(false);
  // Trip-focus mode. When set, the map dims every polyline / ping that
  // doesn't belong to this leg index — useful for isolating a single
  // trip's geography without losing the rest as context. Clicking the
  // same trip's focus icon clears it back to null (show all).
  const [focusedTripIndex, setFocusedTripIndex] = React.useState<
    number | null
  >(null);

  // Reset selection when switching days
  React.useEffect(() => {
    setSelectedId(null);
    setSearch('');
    setStatusFilter('all');
    setExceptionsOnly(false);
    setTab('trips');
    setFocusedTripIndex(null);
  }, [ymdKey]);

  // Reset trip focus when the user switches drivers — focus only makes
  // sense scoped to the currently selected session.
  React.useEffect(() => {
    setFocusedTripIndex(null);
  }, [selectedId]);

  // Ticking "14:23 now" label — refreshed once a minute
  const [nowMs, setNowMs] = React.useState(() => Date.now());
  React.useEffect(() => {
    if (!isLive) return;
    const id = setInterval(() => setNowMs(Date.now()), 30_000);
    return () => clearInterval(id);
  }, [isLive]);
  const nowLabel = `${String(new Date(nowMs).getHours()).padStart(2, '0')}:${String(new Date(nowMs).getMinutes()).padStart(2, '0')} now`;
  const pastDateLabel = date.toLocaleDateString(undefined, {
    weekday: 'short',
    month: 'short',
    day: 'numeric',
  });

  // ────────────────── Filter pipeline ──────────────────
  const filteredLive = React.useMemo(() => {
    if (!isLive) return [] as LiveSessionRow[];
    const q = search.trim().toLowerCase();
    const live = (sessions as LiveSessionRow[]) ?? [];
    return live.filter((s) => {
      if (statusFilter !== 'all' && s.status !== statusFilter) return false;
      if (exceptionsOnly && s.incidents === 0 && s.status !== 'idle') return false;
      if (q) {
        const hay = `${s.driverName} ${s.truckUnitId ?? ''} ${s.truckMakeModel ?? ''} ${s.statusLoc}`.toLowerCase();
        if (!hay.includes(q)) return false;
      }
      return true;
    });
  }, [sessions, statusFilter, exceptionsOnly, search, isLive]);

  const filteredPast = React.useMemo(() => {
    if (isLive) return [] as PastSessionRow[];
    const q = search.trim().toLowerCase();
    const past = (sessions as PastSessionRow[]) ?? [];
    return past.filter((s) => {
      if (q) {
        const hay = `${s.driverName} ${s.truckUnitId ?? ''} ${s.truckMakeModel ?? ''}`.toLowerCase();
        if (!hay.includes(q)) return false;
      }
      return true;
    });
  }, [sessions, search, isLive]);

  // ────────────────── Status counts for chips (live only) ──────────────────
  const counts = React.useMemo(() => {
    const c = {
      all: 0,
      driving: 0,
      idle: 0,
      break: 0,
      'off-duty': 0,
      alerts: 0,
    } as Record<DerivedStatus | 'all' | 'alerts', number>;
    if (isLive) {
      const live = sessions as LiveSessionRow[];
      c.all = live.length;
      for (const s of live) {
        c[s.status]++;
        if (s.incidents > 0) c.alerts++;
      }
    }
    return c;
  }, [sessions, isLive]);

  // ────────────────── Header stats ──────────────────
  const headerStats = React.useMemo(() => {
    if (isLive) {
      return [
        { value: counts.all, label: 'On duty' },
        { value: counts.driving, label: 'Driving' },
        { value: counts.alerts, label: 'Alerts' },
      ];
    }
    const past = sessions as PastSessionRow[];
    const totalTrips = past.reduce((sum, s) => sum + s.trips.length, 0);
    const alerts = past.reduce((sum, s) => sum + s.incidents, 0);
    return [
      { value: past.length, label: past.length === 1 ? 'Driver' : 'Drivers' },
      { value: totalTrips, label: totalTrips === 1 ? 'Trip' : 'Trips' },
      { value: alerts, label: 'Alerts' },
    ];
  }, [isLive, sessions, counts]);

  // ────────────────── Selected session + lazy pings ──────────────────
  const selectedLive = React.useMemo(
    () =>
      isLive
        ? ((sessions as LiveSessionRow[]).find(
            (s) => s.sessionId === selectedId
          ) ?? null)
        : null,
    [isLive, sessions, selectedId]
  );
  const selectedPast = React.useMemo(
    () =>
      !isLive
        ? ((sessions as PastSessionRow[]).find(
            (s) => s.sessionId === selectedId
          ) ?? null)
        : null,
    [isLive, sessions, selectedId]
  );
  const anySelected = !!(selectedLive ?? selectedPast);

  // Paginated reactive ping feed for the selected driver. Loads newest-
  // first in 1000-row pages; we auto-loadMore until exhausted so the
  // polyline covers the whole shift. The first page is reactive — new
  // pings appearing while the page is open flow in without re-query.
  const {
    results: pings,
    status: pingsStatus,
    loadMore: loadMorePings,
  } = usePaginatedQuery(
    api.sessionsLiveOps.listSessionPingsPage,
    anySelected ? { sessionId: selectedId as Id<'driverSessions'> } : 'skip',
    { initialNumItems: 1000 },
  );
  // Auto-load all remaining pages once the user has a driver selected.
  // Long shifts simply take a few extra round-trips to fill in.
  React.useEffect(() => {
    if (pingsStatus === 'CanLoadMore') loadMorePings(1000);
  }, [pingsStatus, loadMorePings]);
  const pingsLoading = anySelected && pingsStatus === 'LoadingFirstPage';

  // Reverse pings into chronological order and keep `loadId` + `speed`
  // per ping so SessionMap can segment the polyline by leg and (when
  // the ping-dots debug overlay is on) annotate each dot's tooltip.
  const routeHistory = React.useMemo(() => {
    if (!pings || pings.length < 2) return [];
    return [...pings].reverse().map((p) => ({
      latitude: p.latitude,
      longitude: p.longitude,
      loadId: p.loadId,
      recordedAt: p.recordedAt,
      speed: p.speed,
    }));
  }, [pings]);

  // Trips for the currently selected driver — drives the polyline palette
  // mapping (load → color) so each segment matches its trip card.
  const selectedTrips = selectedLive?.trips ?? selectedPast?.trips ?? [];

  // Clear selection if it disappears (driver ended shift remotely)
  React.useEffect(() => {
    if (!selectedId) return;
    const stillThere = (sessions as Array<{ sessionId: string }>).some(
      (s) => s.sessionId === selectedId
    );
    if (!stillThere) setSelectedId(null);
  }, [sessions, selectedId]);

  // dataDays Set for the date picker
  const dataDays = React.useMemo(() => {
    const set = new Set<string>([sameDayKey(today)]);
    if (daysWithData) for (const k of daysWithData) set.add(k);
    return set;
  }, [daysWithData, today]);

  // ────────────────── Render ──────────────────
  return (
    <div className="relative flex min-h-0 min-w-0 flex-1 flex-col">
      <style>{`
        @keyframes sessionPulse {
          0%   { transform: translate(-50%, -50%) scale(0.55); opacity: 0.55; }
          100% { transform: translate(-50%, -50%) scale(1.7);  opacity: 0;    }
        }
      `}</style>

      <PageHeader
        title="Active sessions"
        stats={headerStats}
        actions={
          <>
            <SessionDatePicker
              date={date}
              today={today}
              onChange={setDate}
              dataDays={dataDays}
            />
            <WBtn size="sm" leading="export" disabled>
              Export day
            </WBtn>
            {isLive ? (
              <WBtn size="sm" leading="bell" variant="primary" disabled>
                Broadcast
              </WBtn>
            ) : (
              <WBtn size="sm" leading="file-text" variant="primary" disabled>
                Day report
              </WBtn>
            )}
          </>
        }
      />

      {/* Body */}
      <div className="flex min-h-0 min-w-0 flex-1">
        {selectedLive ? (
          <div
            className="w-[380px] min-w-0 shrink-0"
            style={{ borderRight: '1px solid var(--border-hairline)' }}
          >
            <SessionActivityPanel
              mode="live"
              session={selectedLive}
              pings={pings ?? []}
              pingsLoading={pingsLoading}
              tab={tab}
              onTabChange={setTab}
              onBack={() => setSelectedId(null)}
              onForceEndShift={() => setForceEndOpen(true)}
              onHoverPing={setHoveredPing}
              focusedTripIndex={focusedTripIndex}
              onFocusTrip={setFocusedTripIndex}
            />
          </div>
        ) : selectedPast ? (
          <div
            className="w-[380px] min-w-0 shrink-0"
            style={{ borderRight: '1px solid var(--border-hairline)' }}
          >
            <SessionActivityPanel
              mode="past"
              session={selectedPast}
              pings={pings ?? []}
              pingsLoading={pingsLoading}
              tab={tab}
              onTabChange={setTab}
              onBack={() => setSelectedId(null)}
              onHoverPing={setHoveredPing}
              focusedTripIndex={focusedTripIndex}
              onFocusTrip={setFocusedTripIndex}
            />
          </div>
        ) : isLive ? (
          <FleetSidebar
            mode="live"
            sessions={filteredLive}
            totalCount={(sessions as LiveSessionRow[]).length}
            counts={counts}
            search={search}
            onSearch={setSearch}
            statusFilter={statusFilter}
            onStatusFilter={setStatusFilter}
            exceptionsOnly={exceptionsOnly}
            onExceptionsOnly={setExceptionsOnly}
            selectedId={selectedId}
            onSelect={(id) => {
              setSelectedId(id);
              setTab('trips');
            }}
            nowLabel={nowLabel}
          />
        ) : (
          <FleetSidebar
            mode="past"
            sessions={filteredPast}
            totalCount={(sessions as PastSessionRow[]).length}
            search={search}
            onSearch={setSearch}
            selectedId={selectedId}
            onSelect={(id) => {
              setSelectedId(id);
              setTab('trips');
            }}
            dateLabel={pastDateLabel}
          />
        )}

        <div className="relative min-w-0 flex-1">
          {loading ? (
            <MapLoading />
          ) : isLive ? (
            <>
              <SessionMap
                mode="live"
                sessions={filteredLive}
                selectedId={selectedId}
                onSelectDriver={(id) => {
                  setSelectedId(id);
                  setTab('trips');
                }}
                routeHistory={routeHistory}
                selectedTrips={selectedTrips}
                focusedTripIndex={focusedTripIndex}
              />
              {!selectedLive && (
                <PickDriverHint
                  count={filteredLive.length}
                  total={(sessions as LiveSessionRow[]).length}
                  isLive
                />
              )}
              {hoveredPing && null}
            </>
          ) : (sessions as PastSessionRow[]).length === 0 ? (
            <MapPastEmpty date={date} />
          ) : (
            <>
              <SessionMap
                mode="past"
                sessions={filteredPast}
                selectedId={selectedId}
                onSelectDriver={(id) => {
                  setSelectedId(id);
                  setTab('trips');
                }}
                routeHistory={routeHistory}
                selectedTrips={selectedTrips}
                focusedTripIndex={focusedTripIndex}
              />
              <PastLegend />
              {!selectedPast && (
                <PickDriverHint
                  count={filteredPast.length}
                  total={(sessions as PastSessionRow[]).length}
                  isLive={false}
                />
              )}
            </>
          )}
        </div>
      </div>

      {forceEndOpen && selectedLive && (
        <ForceEndShiftDialog
          open
          sessionId={selectedLive.sessionId as Id<'driverSessions'>}
          driverName={selectedLive.driverName}
          onOpenChange={(o) => {
            if (!o) setForceEndOpen(false);
          }}
        />
      )}
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────────────
// Map overlays
// ─────────────────────────────────────────────────────────────────────────

// All overlays read from the app's theme tokens (defined in globals.css)
// so they auto-flip with `[data-theme="dark"]`. Brand-meaning colors
// (green start, red end, blue route) intentionally stay hard-coded —
// they represent the same on-map meaning in both palettes.

function PickDriverHint({
  count,
  total,
  isLive,
}: {
  count: number;
  total: number;
  isLive: boolean;
}) {
  return (
    <div
      className="absolute left-3 top-3 z-[2] flex items-center gap-[10px] rounded-lg px-[14px] py-[10px]"
      style={{
        background: 'var(--bg-surface)',
        backdropFilter: 'blur(6px)',
        boxShadow:
          '0 6px 16px -8px rgba(15,22,36,0.18), 0 1px 2px rgba(15,22,36,0.06)',
        border: '1px solid var(--border-hairline)',
        maxWidth: '70%',
      }}
    >
      <div
        className="flex h-[30px] w-[30px] shrink-0 items-center justify-center rounded-lg"
        style={{ background: 'var(--bg-canvas)', color: 'var(--text-secondary)' }}
      >
        📍
      </div>
      <div>
        <div
          className="text-[13px] font-semibold"
          style={{ color: 'var(--text-primary)' }}
        >
          {count} of {total}{' '}
          {isLive ? (total === 1 ? 'driver' : 'drivers') + ' on duty' : 'shifts shown'}
        </div>
        <div
          className="mt-px text-[11.5px]"
          style={{ color: 'var(--text-secondary)' }}
        >
          {isLive
            ? 'Click a pin or a driver in the list to see their route.'
            : 'Click any shift to replay the route.'}
        </div>
      </div>
    </div>
  );
}

function PastLegend() {
  return (
    <div
      className="absolute right-3 top-3 z-[2] flex items-center gap-3 rounded-lg px-3 py-2 text-[11px]"
      style={{
        background: 'var(--bg-surface)',
        backdropFilter: 'blur(6px)',
        boxShadow:
          '0 6px 16px -8px rgba(15,22,36,0.18), 0 1px 2px rgba(15,22,36,0.06)',
        border: '1px solid var(--border-hairline)',
        color: 'var(--text-secondary)',
      }}
    >
      <span className="inline-flex items-center gap-1.5">
        <span
          className="inline-block h-2 w-2 rounded-full border-2"
          style={{ background: 'var(--bg-surface)', borderColor: '#22B07D' }}
        />
        Start
      </span>
      <span className="inline-flex items-center gap-1.5">
        <span
          className="inline-block h-2 w-2 rounded-full border-2"
          style={{ background: 'var(--bg-surface)', borderColor: '#EF4444' }}
        />
        End
      </span>
      <span
        className="inline-block h-3 w-px"
        style={{ background: 'var(--border-hairline-strong)' }}
      />
      <span className="inline-flex items-center gap-1.5">
        <svg width="22" height="6" style={{ overflow: 'visible' }}>
          <line
            x1="1"
            y1="3"
            x2="21"
            y2="3"
            stroke="#2E5CFF"
            strokeWidth="4"
            strokeLinecap="round"
          />
        </svg>
        Actual route
      </span>
    </div>
  );
}

function MapLoading() {
  return (
    <div
      className="flex h-full w-full items-center justify-center"
      style={{ background: 'var(--bg-canvas)' }}
    >
      <div
        className="text-[12px]"
        style={{ color: 'var(--text-secondary)' }}
      >
        Loading sessions…
      </div>
    </div>
  );
}

function MapPastEmpty({ date }: { date: Date }) {
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
          📅
        </div>
        <div
          className="text-[14px] font-semibold"
          style={{ color: 'var(--text-primary)' }}
        >
          No sessions on{' '}
          {date.toLocaleDateString(undefined, {
            weekday: 'short',
            month: 'short',
            day: 'numeric',
          })}
        </div>
        <div
          className="mt-1 text-[12px]"
          style={{ color: 'var(--text-secondary)' }}
        >
          Pick a different day from the date picker above.
        </div>
      </div>
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────────────
// helpers
// ─────────────────────────────────────────────────────────────────────────

function sameDay(a: Date, b: Date): boolean {
  return (
    a.getFullYear() === b.getFullYear() &&
    a.getMonth() === b.getMonth() &&
    a.getDate() === b.getDate()
  );
}

function sameDayKey(d: Date): string {
  return `${d.getFullYear()}-${d.getMonth()}-${d.getDate()}`;
}
