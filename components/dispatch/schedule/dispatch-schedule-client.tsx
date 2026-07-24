'use client';

/**
 * Schedule Gantt — drivers/carriers timeline with day & week zooms.
 * Visual contract lifted from the design package's schedule-screen.jsx;
 * data wired to dispatchLegs + drivers + carrierPartnerships in Convex.
 */

import * as React from 'react';
import { useRouter } from 'next/navigation';
import { useAuthQuery } from '@/hooks/use-auth-query';
import { ReassignDriverDialog } from '@/components/sessions/reassign-driver-dialog';
import { api } from '@/convex/_generated/api';
import type { Id } from '@/convex/_generated/dataModel';
import { PageHeader } from '@/components/web/page-header';
import { WBtn } from '@/components/web/btn';
import { WIcon } from '@/components/web/icons';
import { Avatar } from '@/components/web/avatar';

// ── Layout constants ─────────────────────────────────────────────────────
const ROW_RAIL_W = 240;
const ROW_H_DAY = 56;
const HEADER_H = 36;
const TRACK_H = 36;
const TRACK_GAP = 4;
const ROW_VPAD = 10;

type Zoom = 'day' | 'week';
type Entity = 'drivers' | 'carriers';

type RowStatus = 'on-duty' | 'available' | 'off-duty';

interface ScheduleRow {
  id: string;
  name: string;
  status: RowStatus;
  loc: string;
  initials?: string;
}

interface TripBar {
  id: string;
  rowId: string;
  startMs: number;
  endMs: number;
  status: 'completed' | 'in-transit' | 'assigned' | 'open';
  orderNumber: string;
  hcr: string | null;
  tripNumber: string | null;
  from: string;
  to: string;
  // Actual stop arrival / departure (ISO 8601, populated by the driver app's
  // check-in flow). Surfaced in the drawer when a leg is delivered.
  startCheckedInAt: string | null;
  startCheckedOutAt: string | null;
  endCheckedInAt: string | null;
  endCheckedOutAt: string | null;
  loadId: Id<'loadInformation'> | null;
  conflict?: boolean;
}

const ROW_STATUS_DOT: Record<RowStatus, string> = {
  'on-duty': '#10B981',
  available: '#3B82F6',
  'off-duty': '#9BA3B4',
};
const ROW_STATUS_LABEL: Record<RowStatus, string> = {
  'on-duty': 'On duty',
  available: 'Available',
  'off-duty': 'Off duty',
};

const TRIP_STATUS = {
  completed: { bg: 'var(--bar-completed-bg)', bd: 'var(--bar-completed-bd)', fg: 'var(--bar-completed-fg)', label: 'Completed' },
  'in-transit': { bg: 'var(--bar-intransit-bg)', bd: 'var(--bar-intransit-bd)', fg: 'var(--bar-intransit-fg)', label: 'In transit' },
  assigned: { bg: 'var(--bar-assigned-bg)', bd: 'var(--bar-assigned-bd)', fg: 'var(--bar-assigned-fg)', label: 'Assigned' },
  open: { bg: 'var(--bar-open-bg)', bd: 'var(--bar-open-bd)', fg: 'var(--bar-open-fg)', label: 'Open' },
} as const;

const cityState = (city: string | null, state: string | null) => {
  if (!city && !state) return '—';
  if (!state) return city ?? '—';
  if (!city) return state;
  return `${city}, ${state}`;
};

const mapLegStatus = (s: string): TripBar['status'] => {
  if (s === 'COMPLETED') return 'completed';
  if (s === 'ACTIVE') return 'in-transit';
  if (s === 'PENDING') return 'assigned';
  return 'assigned';
};

// Start-of-day in local time, in ms.
const startOfDay = (d: Date) => {
  const x = new Date(d);
  x.setHours(0, 0, 0, 0);
  return x.getTime();
};
// Monday at 00:00 of the week containing d.
const startOfWeek = (d: Date) => {
  const x = new Date(d);
  x.setHours(0, 0, 0, 0);
  const day = x.getDay(); // 0=Sun … 6=Sat
  const offset = day === 0 ? -6 : 1 - day;
  x.setDate(x.getDate() + offset);
  return x.getTime();
};

const DAY_MS = 24 * 60 * 60 * 1000;
const HOUR_MS = 60 * 60 * 1000;

const DOW_LABELS = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

const formatDayLabel = (ms: number) => {
  const d = new Date(ms);
  return `${DOW_LABELS[(d.getDay() + 6) % 7]}, ${MONTHS[d.getMonth()]} ${d.getDate()}`;
};
const formatWeekLabel = (startMs: number) => {
  const a = new Date(startMs);
  const b = new Date(startMs + 6 * DAY_MS);
  return `${MONTHS[a.getMonth()]} ${a.getDate()} – ${MONTHS[b.getMonth()]} ${b.getDate()}, ${b.getFullYear()}`;
};
const formatHHMM = (ms: number) => {
  const d = new Date(ms);
  const hh = d.getHours().toString().padStart(2, '0');
  const mm = d.getMinutes().toString().padStart(2, '0');
  return `${hh}:${mm}`;
};

// Greedy interval packing — overlap-tolerant rows get stacked.
const packTracks = (bars: TripBar[]) => {
  const sorted = [...bars].sort((a, b) => a.startMs - b.startMs);
  const trackEnds: number[] = [];
  const trackByBar = new Map<string, number>();
  for (const b of sorted) {
    let placed = false;
    for (let i = 0; i < trackEnds.length; i++) {
      if (trackEnds[i] <= b.startMs) {
        trackEnds[i] = b.endMs;
        trackByBar.set(b.id, i);
        placed = true;
        break;
      }
    }
    if (!placed) {
      trackEnds.push(b.endMs);
      trackByBar.set(b.id, trackEnds.length - 1);
    }
  }
  return { trackByBar, trackCount: Math.max(1, trackEnds.length) };
};

const rowHeight = (trackCount: number) =>
  trackCount <= 1 ? ROW_H_DAY : ROW_VPAD * 2 + trackCount * TRACK_H + (trackCount - 1) * TRACK_GAP;

// Flag overlapping bars on the same row (driver HOS conflicts).
const markConflicts = (bars: TripBar[]): TripBar[] => {
  const sorted = [...bars].sort((a, b) => a.startMs - b.startMs);
  for (let i = 0; i < sorted.length; i++) {
    for (let j = i + 1; j < sorted.length; j++) {
      if (sorted[j].startMs >= sorted[i].endMs) break;
      sorted[i].conflict = true;
      sorted[j].conflict = true;
    }
  }
  return bars;
};

export function DispatchScheduleClient({ organizationId }: { organizationId: string }) {
  const [entity, setEntity] = React.useState<Entity>('drivers');
  const [zoom, setZoom] = React.useState<Zoom>('day');
  const [search, setSearch] = React.useState('');
  const [picked, setPicked] = React.useState<TripBar | null>(null);
  const [anchor, setAnchor] = React.useState<number>(() => startOfDay(new Date()));

  const windowStartMs = zoom === 'day' ? anchor : startOfWeek(new Date(anchor));
  const windowEndMs = windowStartMs + (zoom === 'day' ? DAY_MS : 7 * DAY_MS);

  // Close the detail drawer whenever the picked trip would fall outside
  // the visible rows (entity switch) or the visible window (date change).
  React.useEffect(() => {
    setPicked(null);
  }, [entity, anchor, zoom]);

  // "Now" tick — re-render every 60s so the now-indicator advances and the
  // render itself stays pure (no Date.now() in the render body).
  const [now, setNow] = React.useState<number>(() => Date.now());
  React.useEffect(() => {
    const id = window.setInterval(() => setNow(Date.now()), 60_000);
    return () => window.clearInterval(id);
  }, []);

  const drivers = useAuthQuery(api.drivers.list, { organizationId });
  const carriers = useAuthQuery(api.carrierPartnerships.getActiveForDispatch, {
    brokerOrgId: organizationId,
  });
  const activeSessions = useAuthQuery(api.driverSessions.listActiveForOrg, {});
  const schedule = useAuthQuery(api.dispatchLegs.getOrgSchedule, {
    workosOrgId: organizationId,
    startMs: windowStartMs,
    endMs: windowEndMs,
  });

  const onShiftDriverIds = React.useMemo(() => {
    const s = new Set<string>();
    (activeSessions ?? []).forEach((sess) => s.add(sess.driverId));
    return s;
  }, [activeSessions]);

  const driverRows: ScheduleRow[] = React.useMemo(() => {
    if (!drivers) return [];
    return drivers
      .filter((d) => !d.isDeleted)
      .map((d) => {
        const name = `${d.firstName ?? ''} ${d.lastName ?? ''}`.trim() || d.email || 'Unnamed';
        const isOnShift = onShiftDriverIds.has(d._id);
        const isActive = d.employmentStatus === 'Active';
        const status: RowStatus = isOnShift ? 'on-duty' : isActive ? 'available' : 'off-duty';
        return {
          id: d._id,
          name,
          status,
          loc: cityState(d.city ?? null, d.state ?? null),
        };
      })
      .sort((a, b) => a.name.localeCompare(b.name));
  }, [drivers, onShiftDriverIds]);

  const carrierRows: ScheduleRow[] = React.useMemo(() => {
    if (!carriers) return [];
    return carriers
      .map((c) => ({
        id: c._id,
        name: c.carrierName,
        status: 'available' as RowStatus,
        loc: cityState(c.city ?? null, c.state ?? null),
      }))
      .sort((a, b) => a.name.localeCompare(b.name));
  }, [carriers]);

  const allRows = entity === 'drivers' ? driverRows : carrierRows;
  const filteredRows = search.trim()
    ? allRows.filter((r) => r.name.toLowerCase().includes(search.toLowerCase()))
    : allRows;

  // Bucket the schedule legs onto rows. We mark conflicts only for drivers
  // (HOS prevents legitimate overlap); carriers track-pack overlapping bars.
  const barsByRow = React.useMemo(() => {
    const m = new Map<string, TripBar[]>();
    if (!schedule) return m;
    for (const leg of schedule) {
      const rowId = entity === 'drivers' ? leg.driverId : leg.carrierPartnershipId;
      if (!rowId) continue;
      const list = m.get(rowId) ?? [];
      list.push({
        id: leg._id,
        rowId,
        startMs: leg.startMs,
        endMs: leg.endMs,
        status: mapLegStatus(leg.status),
        orderNumber: leg.load?.orderNumber ?? leg.load?.internalId ?? '—',
        hcr: leg.hcr,
        tripNumber: leg.tripNumber,
        from: cityState(leg.startCity, leg.startState),
        to: cityState(leg.endCity, leg.endState),
        startCheckedInAt: leg.startCheckedInAt,
        startCheckedOutAt: leg.startCheckedOutAt,
        endCheckedInAt: leg.endCheckedInAt,
        endCheckedOutAt: leg.endCheckedOutAt,
        loadId: leg.load?._id ?? null,
      });
      m.set(rowId, list);
    }
    if (entity === 'drivers') {
      for (const [rowId, bars] of m) m.set(rowId, markConflicts(bars));
    }
    return m;
  }, [schedule, entity]);

  const layouts = React.useMemo(() => {
    const m = new Map<string, { trackByBar: Map<string, number>; trackCount: number; height: number }>();
    for (const r of filteredRows) {
      const bars = barsByRow.get(r.id) ?? [];
      const packed = packTracks(bars);
      m.set(r.id, { ...packed, height: rowHeight(packed.trackCount) });
    }
    return m;
  }, [filteredRows, barsByRow]);

  const totalH = filteredRows.reduce((sum, r) => sum + (layouts.get(r.id)?.height ?? ROW_H_DAY), 0);

  // Synchronize vertical scroll between the left rail and the timeline body.
  const railRef = React.useRef<HTMLDivElement | null>(null);
  const bodyRef = React.useRef<HTMLDivElement | null>(null);
  const onBodyScroll = React.useCallback(() => {
    if (railRef.current && bodyRef.current) railRef.current.scrollTop = bodyRef.current.scrollTop;
  }, []);
  const onRailScroll = React.useCallback(() => {
    if (railRef.current && bodyRef.current) bodyRef.current.scrollTop = railRef.current.scrollTop;
  }, []);

  // Timeline width is whatever the body is given by flexbox. We measure it
  // and derive px-per-ms so bars / now-line scale to the available width
  // instead of being pinned to a fixed 1344px grid.
  const [gridW, setGridW] = React.useState<number>(0);
  React.useLayoutEffect(() => {
    const el = bodyRef.current;
    if (!el) return;
    const measure = () => setGridW(el.clientWidth);
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => ro.disconnect();
  }, []);
  const cellCount = zoom === 'day' ? 24 : 7;
  const windowDurMs = windowEndMs - windowStartMs;
  const pxPerMs = gridW > 0 && windowDurMs > 0 ? gridW / windowDurMs : 0;

  // Stats
  const driversOnDuty = onShiftDriverIds.size;
  const tripsInWindow = schedule?.length ?? 0;
  const conflictsCount = React.useMemo(() => {
    if (entity !== 'drivers') return 0;
    let n = 0;
    for (const bars of barsByRow.values()) for (const b of bars) if (b.conflict) n++;
    return n;
  }, [barsByRow, entity]);

  const stats = [
    { label: 'Drivers on duty', value: driversOnDuty },
    { label: zoom === 'day' ? 'Trips today' : 'Trips this week', value: tripsInWindow },
    { label: 'Conflicts', value: conflictsCount },
  ];

  const showNowLine = now >= windowStartMs && now <= windowEndMs;
  const nowX = (now - windowStartMs) * pxPerMs;

  // Find the row object that owns the picked trip (used by detail drawer).
  const pickedOwner = picked ? filteredRows.find((r) => r.id === picked.rowId) : null;

  const shiftAnchor = (delta: number) => {
    const step = zoom === 'day' ? DAY_MS : 7 * DAY_MS;
    setAnchor((a) => (zoom === 'day' ? a + delta * step : startOfWeek(new Date(a + delta * step))));
  };
  const goToday = () => setAnchor(startOfDay(new Date()));

  const loading = drivers === undefined || carriers === undefined || schedule === undefined;

  return (
    <div className="flex h-full min-h-0 flex-col relative min-w-0">
      <PageHeader
        title="Schedule"
        stats={stats}
        actions={
          <div className="flex items-center gap-2">
            <WBtn size="sm" leading="export">
              Export
            </WBtn>
            <WBtn size="sm" variant="primary" leading="plus">
              New trip
            </WBtn>
          </div>
        }
      />

      {/* Sub-toolbar: entity • date • search • zoom */}
      <div
        className="flex items-center gap-3 px-6 shrink-0"
        style={{
          height: 56,
          background: 'var(--bg-surface)',
          borderBottom: '1px solid var(--border-hairline)',
        }}
      >
        <Segmented
          value={entity}
          onChange={(v) => setEntity(v as Entity)}
          options={[
            { id: 'drivers', label: 'Drivers' },
            { id: 'carriers', label: 'Carriers' },
          ]}
        />

        <div style={{ width: 1, height: 20, background: 'var(--border-hairline)', margin: '0 4px' }} />

        <div className="flex items-center gap-1">
          <IconBtn icon="chevron-left" title="Previous" onClick={() => shiftAnchor(-1)} />
          <button
            className="focus-ring inline-flex items-center gap-1.5"
            style={{
              height: 32,
              padding: '0 12px',
              borderRadius: 8,
              background: 'var(--bg-surface)',
              border: '1px solid var(--border-hairline-strong)',
              color: 'var(--text-primary)',
              fontFamily: 'inherit',
              fontSize: 12.5,
              fontWeight: 500,
              cursor: 'pointer',
            }}
          >
            <WIcon name="calendar" size={14} className="text-[var(--text-tertiary)]" />
            {zoom === 'day' ? formatDayLabel(anchor) : formatWeekLabel(startOfWeek(new Date(anchor)))}
          </button>
          <IconBtn icon="chevron-right" title="Next" onClick={() => shiftAnchor(1)} />
          <button
            className="focus-ring"
            onClick={goToday}
            style={{
              height: 32,
              padding: '0 10px',
              marginLeft: 4,
              borderRadius: 8,
              background: 'transparent',
              border: '1px solid transparent',
              color: 'var(--text-secondary)',
              fontFamily: 'inherit',
              fontSize: 12,
              fontWeight: 500,
              cursor: 'pointer',
            }}
            onMouseEnter={(e) => {
              e.currentTarget.style.background = 'var(--bg-row-hover)';
              e.currentTarget.style.color = 'var(--text-primary)';
            }}
            onMouseLeave={(e) => {
              e.currentTarget.style.background = 'transparent';
              e.currentTarget.style.color = 'var(--text-secondary)';
            }}
          >
            Today
          </button>
        </div>

        <div className="flex-1" />

        <div
          className="flex items-center gap-2"
          style={{
            width: 240,
            height: 32,
            padding: '0 10px',
            borderRadius: 8,
            background: 'var(--bg-surface-2)',
            border: '1px solid var(--border-hairline)',
          }}
        >
          <WIcon name="search" size={14} className="text-[var(--text-tertiary)]" />
          <input
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder={`Search ${entity}…`}
            className="flex-1 border-0 outline-none bg-transparent"
            style={{ fontSize: 12.5, color: 'var(--text-primary)', fontFamily: 'inherit', height: 32 }}
          />
        </div>

        <Segmented
          value={zoom}
          onChange={(v) => setZoom(v as Zoom)}
          options={[
            { id: 'day', label: 'Day' },
            { id: 'week', label: 'Week' },
          ]}
        />
      </div>

      {/* Gantt grid */}
      <div className="flex flex-1 min-h-0 relative" style={{ background: 'var(--bg-canvas)' }}>
        {/* Left rail */}
        <div
          className="flex flex-col shrink-0"
          style={{
            width: ROW_RAIL_W,
            background: 'var(--bg-surface)',
            borderRight: '1px solid var(--border-hairline)',
            zIndex: 2,
          }}
        >
          <div
            className="flex items-center px-4"
            style={{
              height: HEADER_H,
              borderBottom: '1px solid var(--border-hairline)',
              background: 'var(--bg-surface-2)',
              fontSize: 11,
              fontWeight: 600,
              color: 'var(--text-tertiary)',
              textTransform: 'uppercase',
              letterSpacing: 0.04,
            }}
          >
            {entity === 'drivers' ? 'Driver' : 'Carrier'}
            <span className="ml-auto" style={{ textTransform: 'none', letterSpacing: 0, color: 'var(--text-tertiary)', fontWeight: 500, fontSize: 11 }}>
              {filteredRows.length}
            </span>
          </div>
          <div
            ref={railRef}
            onScroll={onRailScroll}
            className="scroll-thin flex-1 overflow-y-auto overflow-x-hidden"
          >
            {filteredRows.map((r) => (
              <RowRail key={r.id} row={r} height={layouts.get(r.id)?.height ?? ROW_H_DAY} />
            ))}
            {!loading && filteredRows.length === 0 && (
              <div className="px-6 py-6 text-center" style={{ fontSize: 12.5, color: 'var(--text-tertiary)' }}>
                {search.trim() ? 'No matches.' : entity === 'drivers' ? 'No drivers in this org yet.' : 'No carriers in this org yet.'}
              </div>
            )}
            {loading && (
              <div className="px-6 py-6 text-center" style={{ fontSize: 12.5, color: 'var(--text-tertiary)' }}>
                Loading…
              </div>
            )}
          </div>
        </div>

        {/* Timeline body */}
        <div
          ref={bodyRef}
          onScroll={onBodyScroll}
          className="scroll-thin flex-1 min-w-0 relative overflow-y-auto overflow-x-hidden"
        >
          {/* Sticky time header */}
          <div
            className="sticky top-0 flex"
            style={{
              zIndex: 3,
              width: '100%',
              height: HEADER_H,
              background: 'var(--bg-surface-2)',
              borderBottom: '1px solid var(--border-hairline)',
            }}
          >
            {zoom === 'day'
              ? Array.from({ length: 24 }, (_, h) => (
                  <div
                    key={h}
                    className="flex items-center justify-center"
                    style={{
                      flex: 1,
                      minWidth: 0,
                      height: '100%',
                      borderRight: '1px solid var(--border-hairline)',
                      fontSize: 11,
                      fontWeight: 500,
                      color: 'var(--text-tertiary)',
                      fontVariantNumeric: 'tabular-nums',
                    }}
                  >
                    {h.toString().padStart(2, '0')}:00
                  </div>
                ))
              : Array.from({ length: 7 }, (_, i) => {
                  const dayMs = startOfWeek(new Date(anchor)) + i * DAY_MS;
                  const d = new Date(dayMs);
                  const isToday = startOfDay(d) === startOfDay(new Date());
                  return (
                    <div
                      key={i}
                      className="flex items-center px-4 gap-2"
                      style={{
                        flex: 1,
                        minWidth: 0,
                        height: '100%',
                        borderRight: '1px solid var(--border-hairline)',
                      }}
                    >
                      <span style={{ fontSize: 12, fontWeight: 600, color: isToday ? 'var(--accent)' : 'var(--text-primary)' }}>
                        {DOW_LABELS[(d.getDay() + 6) % 7]}
                      </span>
                      <span style={{ fontSize: 11.5, color: 'var(--text-tertiary)' }}>
                        {MONTHS[d.getMonth()]} {d.getDate()}
                      </span>
                      {isToday && (
                        <span
                          className="ml-auto"
                          style={{
                            fontSize: 10,
                            fontWeight: 600,
                            color: 'var(--accent)',
                            padding: '1px 6px',
                            borderRadius: 4,
                            background: 'rgba(46,92,255,0.10)',
                          }}
                        >
                          TODAY
                        </span>
                      )}
                    </div>
                  );
                })}
          </div>

          {/* Rows + bars */}
          <div style={{ width: '100%', position: 'relative' }}>
            {filteredRows.map((r) => {
              const lay = layouts.get(r.id) ?? { trackByBar: new Map<string, number>(), trackCount: 1, height: ROW_H_DAY };
              const bars = barsByRow.get(r.id) ?? [];
              return (
                <RowBars
                  key={r.id}
                  cellCount={cellCount}
                  pxPerMs={pxPerMs}
                  windowStartMs={windowStartMs}
                  windowEndMs={windowEndMs}
                  bars={bars}
                  layout={lay}
                  onPick={setPicked}
                  pickedId={picked?.id ?? null}
                />
              );
            })}

            {showNowLine && filteredRows.length > 0 && (
              <NowIndicator x={nowX} totalH={totalH} label={formatHHMM(now)} />
            )}
          </div>
        </div>

        {picked && (
          <DetailDrawer
            trip={picked}
            ownerName={pickedOwner?.name ?? '—'}
            driverId={entity === 'drivers' ? (picked.rowId as Id<'drivers'>) : null}
            onClose={() => setPicked(null)}
          />
        )}
      </div>

      {/* Legend strip */}
      <div
        className="flex items-center gap-5 px-6 shrink-0"
        style={{
          height: 36,
          borderTop: '1px solid var(--border-hairline)',
          background: 'var(--bg-surface)',
          fontSize: 11.5,
          color: 'var(--text-tertiary)',
        }}
      >
        <LegendDot color={TRIP_STATUS['in-transit'].bg} bd={TRIP_STATUS['in-transit'].bd} label="In transit" />
        <LegendDot color={TRIP_STATUS['assigned'].bg} bd={TRIP_STATUS['assigned'].bd} label="Assigned" />
        <LegendDot color={TRIP_STATUS['completed'].bg} bd={TRIP_STATUS['completed'].bd} label="Completed" />
        <span className="inline-flex items-center gap-1.5">
          <span style={{ width: 14, height: 10, borderRadius: 3, background: '#FCE7E7', border: '1.5px solid #DC2626' }} />
          Conflict
        </span>
        <div className="flex-1" />
        <span>Click any bar for trip detail</span>
      </div>
    </div>
  );
}

// ── Row rail (left) ──────────────────────────────────────────────────────
function RowRail({ row, height }: { row: ScheduleRow; height: number }) {
  return (
    <div
      className="flex items-center px-4 gap-2.5"
      style={{
        height,
        borderBottom: '1px solid var(--border-hairline)',
        background: 'var(--bg-surface)',
      }}
    >
      <div className="relative">
        <Avatar name={row.name} size={32} />
        <span
          style={{
            position: 'absolute',
            right: -1,
            bottom: -1,
            width: 10,
            height: 10,
            borderRadius: 999,
            background: ROW_STATUS_DOT[row.status],
            border: '2px solid var(--bg-surface)',
          }}
        />
      </div>
      <div className="min-w-0 flex-1">
        <div
          className="truncate"
          style={{ fontSize: 12.5, fontWeight: 500, color: 'var(--text-primary)' }}
        >
          {row.name}
        </div>
        <div
          className="truncate"
          style={{ fontSize: 11, color: 'var(--text-tertiary)' }}
        >
          <span style={{ color: ROW_STATUS_DOT[row.status], fontWeight: 500 }}>
            {ROW_STATUS_LABEL[row.status]}
          </span>
          <span style={{ margin: '0 6px', color: 'var(--border-default)' }}>·</span>
          {row.loc}
        </div>
      </div>
    </div>
  );
}

// ── Row bars (right) ─────────────────────────────────────────────────────
function RowBars({
  cellCount,
  pxPerMs,
  windowStartMs,
  windowEndMs,
  bars,
  layout,
  onPick,
  pickedId,
}: {
  cellCount: number;
  pxPerMs: number;
  windowStartMs: number;
  windowEndMs: number;
  bars: TripBar[];
  layout: { trackByBar: Map<string, number>; trackCount: number; height: number };
  onPick: (b: TripBar) => void;
  pickedId: string | null;
}) {
  const { trackByBar, trackCount, height } = layout;
  const stacked = trackCount > 1;

  return (
    <div
      style={{
        height,
        position: 'relative',
        borderBottom: '1px solid var(--border-hairline)',
        background: 'var(--bg-surface)',
      }}
    >
      {Array.from({ length: cellCount }, (_, i) => (
        <div
          key={i}
          style={{
            position: 'absolute',
            left: `${(i / cellCount) * 100}%`,
            top: 0,
            bottom: 0,
            width: 1,
            background: 'var(--border-hairline)',
            opacity: 0.6,
          }}
        />
      ))}

      {bars.map((b) => {
        // Clip to the visible window so very long legs still render proportionally.
        const start = Math.max(b.startMs, windowStartMs);
        const end = Math.min(b.endMs, windowEndMs);
        const left = (start - windowStartMs) * pxPerMs;
        const width = Math.max(2, (end - start) * pxPerMs);
        const trackIdx = trackByBar.get(b.id) ?? 0;
        const top = stacked ? ROW_VPAD + trackIdx * (TRACK_H + TRACK_GAP) : 8;
        const barH = stacked ? TRACK_H : ROW_H_DAY - 16;
        return (
          <Bar
            key={b.id}
            t={b}
            left={left}
            width={width}
            top={top}
            barH={barH}
            stacked={stacked}
            picked={pickedId === b.id}
            onClick={() => onPick(b)}
          />
        );
      })}
    </div>
  );
}

// ── Bar ──────────────────────────────────────────────────────────────────
function Bar({
  t,
  left,
  width,
  top,
  barH,
  stacked,
  picked,
  onClick,
}: {
  t: TripBar;
  left: number;
  width: number;
  top: number;
  barH: number;
  stacked: boolean;
  picked: boolean;
  onClick: () => void;
}) {
  const s = TRIP_STATUS[t.status] ?? TRIP_STATUS.assigned;
  const minWidth = 56;
  const w = Math.max(width - 4, minWidth);
  const tight = w < 110 || (stacked && w < 140);
  const dense = stacked;
  return (
    <button
      onClick={onClick}
      className="focus-ring"
      style={{
        position: 'absolute',
        left: left + 2,
        top,
        height: barH,
        width: w,
        borderRadius: 6,
        background: s.bg,
        border: `1px solid ${t.conflict ? '#DC2626' : s.bd}`,
        borderLeft: `3px solid ${t.conflict ? '#DC2626' : s.fg}`,
        padding: '0 8px',
        display: 'flex',
        alignItems: 'center',
        gap: 6,
        cursor: 'pointer',
        overflow: 'hidden',
        boxShadow: picked
          ? '0 0 0 2px var(--accent), 0 4px 14px -4px rgba(0,0,0,0.15)'
          : t.conflict
            ? '0 0 0 1px rgba(220,38,38,0.20)'
            : 'none',
        transition: 'transform var(--dur-fast) var(--ease-out), box-shadow var(--dur-fast) var(--ease-out)',
        fontFamily: 'inherit',
        textAlign: 'left',
      }}
      onMouseEnter={(e) => {
        e.currentTarget.style.transform = 'translateY(-1px)';
        if (!picked) e.currentTarget.style.boxShadow = '0 4px 10px -2px rgba(0,0,0,0.10)';
      }}
      onMouseLeave={(e) => {
        e.currentTarget.style.transform = '';
        if (!picked) e.currentTarget.style.boxShadow = t.conflict ? '0 0 0 1px rgba(220,38,38,0.20)' : 'none';
      }}
    >
      {t.conflict && <WIcon name="alert" size={12} className="shrink-0" style={{ color: '#DC2626' }} />}
      <div
        style={{
          minWidth: 0,
          flex: 1,
          lineHeight: 1.2,
          display: dense ? 'flex' : 'block',
          alignItems: 'center',
          gap: 8,
        }}
      >
        <div
          className="truncate shrink-0"
          style={{
            fontSize: 11.5,
            fontWeight: 600,
            color: s.fg,
            fontVariantNumeric: 'tabular-nums',
          }}
        >
          {tight ? shortOrder(t.orderNumber) : t.orderNumber}
        </div>
        {!tight && (
          <div
            className="truncate"
            style={{
              fontSize: 10.5,
              color: s.fg,
              opacity: 0.75,
              marginTop: dense ? 0 : 1,
              minWidth: 0,
            }}
          >
            {t.from} → {t.to}
          </div>
        )}
      </div>
    </button>
  );
}

function shortOrder(s: string) {
  // 109166715 → …66715 — keep tight bars readable without losing the suffix.
  if (s.length <= 6) return s;
  return '…' + s.slice(-5);
}

// ── Now indicator ────────────────────────────────────────────────────────
function NowIndicator({ x, totalH, label }: { x: number; totalH: number; label: string }) {
  return (
    <>
      <div
        style={{
          position: 'absolute',
          left: x - 0.5,
          top: 0,
          width: 1.5,
          height: totalH,
          background: 'var(--accent)',
          zIndex: 4,
          pointerEvents: 'none',
          boxShadow: '0 0 0 1px rgba(46,92,255,0.10)',
        }}
      />
      <div
        style={{
          position: 'absolute',
          left: x - 28,
          top: -28,
          width: 56,
          height: 22,
          borderRadius: 4,
          background: 'var(--accent)',
          color: '#fff',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          fontSize: 11,
          fontWeight: 600,
          letterSpacing: 0.02,
          zIndex: 5,
          pointerEvents: 'none',
          fontVariantNumeric: 'tabular-nums',
          boxShadow: '0 2px 6px rgba(46,92,255,0.30)',
        }}
      >
        {label}
      </div>
    </>
  );
}

// ── Detail drawer ────────────────────────────────────────────────────────
function DetailDrawer({
  trip,
  ownerName,
  driverId,
  onClose,
}: {
  trip: TripBar;
  ownerName: string;
  /** Set when the schedule is in drivers view — rowId is the driver's _id. */
  driverId: Id<'drivers'> | null;
  onClose: () => void;
}) {
  const router = useRouter();
  const [reassignOpen, setReassignOpen] = React.useState(false);
  const s = TRIP_STATUS[trip.status] ?? TRIP_STATUS.assigned;
  const durHrs = (trip.endMs - trip.startMs) / HOUR_MS;

  // The schedule leg only carries start/end city, so multi-stop loads
  // rendered as a 2-stop route (and a hard-coded stop count). Fetch the
  // load's real stop list for the drawer; fall back to leg start/end
  // while loading or when no load is linked.
  const loadStops = useAuthQuery(
    api.loads.getLoadStops,
    trip.loadId ? { loadId: trip.loadId } : 'skip',
  );
  const routeStops = loadStops && loadStops.length >= 2 ? loadStops : null;
  const showActuals = trip.status === 'completed';
  // Reassign is a driver-to-driver handoff, so it needs a driver row and a
  // load that isn't already delivered. Carrier bars and completed legs keep
  // the button visible but disabled.
  const canReassign = Boolean(trip.loadId && driverId && trip.status !== 'completed');
  return (
    <div
      // Flex sibling (not absolute) so the schedule body's flex-1 width
      // shrinks when the drawer opens — the ResizeObserver on the body
      // fires, pxPerMs recomputes, and all bars + the time header reflow
      // into the new width instead of being hidden behind a 380px overlay.
      className="shrink-0 flex flex-col self-stretch"
      style={{
        width: 380,
        background: 'var(--bg-surface)',
        borderLeft: '1px solid var(--border-hairline)',
        boxShadow: '-8px 0 24px -8px rgba(0,0,0,0.10)',
        animation: 'slideInRight var(--dur) var(--ease-out)',
      }}
    >
      <div
        className="flex items-center gap-2.5"
        style={{ padding: '14px 18px', borderBottom: '1px solid var(--border-hairline)' }}
      >
        <span
          style={{
            fontFamily: 'var(--font-mono)',
            fontSize: 13,
            fontWeight: 600,
            color: 'var(--text-primary)',
          }}
        >
          {trip.orderNumber}
        </span>
        <span
          style={{
            padding: '2px 8px',
            borderRadius: 4,
            background: s.bg,
            color: s.fg,
            border: `1px solid ${s.bd}`,
            fontSize: 11,
            fontWeight: 600,
          }}
        >
          {s.label}
        </span>
        {trip.conflict && (
          <span
            className="inline-flex items-center gap-1"
            style={{
              padding: '2px 8px',
              borderRadius: 4,
              background: '#FEE2E2',
              color: '#B91C1C',
              border: '1px solid #F5BBBB',
              fontSize: 11,
              fontWeight: 600,
            }}
          >
            <WIcon name="alert" size={11} />
            Conflict
          </span>
        )}
        <div className="flex-1" />
        <button
          onClick={onClose}
          className="focus-ring inline-flex items-center justify-center"
          style={{
            width: 28,
            height: 28,
            borderRadius: 6,
            border: 'none',
            background: 'transparent',
            cursor: 'pointer',
            color: 'var(--text-tertiary)',
          }}
          onMouseEnter={(e) => {
            e.currentTarget.style.background = 'var(--bg-row-hover)';
            e.currentTarget.style.color = 'var(--text-primary)';
          }}
          onMouseLeave={(e) => {
            e.currentTarget.style.background = 'transparent';
            e.currentTarget.style.color = 'var(--text-tertiary)';
          }}
        >
          <WIcon name="close" size={14} />
        </button>
      </div>

      <div className="scroll-thin flex-1 overflow-auto" style={{ padding: 18 }}>
        <DetailField label="Order">
          <span style={{ fontFamily: 'var(--font-mono)', fontWeight: 500 }}>{trip.orderNumber}</span>
        </DetailField>
        <DetailField label="HCR">
          {trip.hcr ? (
            <span style={{ fontFamily: 'var(--font-mono)', fontWeight: 500 }}>{trip.hcr}</span>
          ) : (
            <span style={{ color: 'var(--text-tertiary)' }}>—</span>
          )}
        </DetailField>
        <DetailField label="Trip">
          {trip.tripNumber ? (
            <span style={{ fontFamily: 'var(--font-mono)', fontWeight: 500 }}>{trip.tripNumber}</span>
          ) : (
            <span style={{ color: 'var(--text-tertiary)' }}>—</span>
          )}
        </DetailField>
        <DetailField label="Assigned to">
          <span>{ownerName}</span>
        </DetailField>
        <DetailField label="Start">
          <span style={{ fontVariantNumeric: 'tabular-nums' }}>{new Date(trip.startMs).toLocaleString()}</span>
        </DetailField>
        <DetailField label="End">
          <span style={{ fontVariantNumeric: 'tabular-nums' }}>{new Date(trip.endMs).toLocaleString()}</span>
        </DetailField>

        <div style={{ height: 16 }} />

        <div
          style={{
            fontSize: 11,
            fontWeight: 600,
            color: 'var(--text-tertiary)',
            textTransform: 'uppercase',
            letterSpacing: 0.06,
            marginBottom: 10,
          }}
        >
          Route
        </div>
        {routeStops ? (
          routeStops.map((stop, i) => {
            const isFirst = i === 0;
            const isLast = i === routeStops.length - 1;
            return (
              <React.Fragment key={stop._id}>
                {i > 0 && (
                  // Segment durations are unknown for intermediate hops —
                  // only a plain 2-stop route can label the connector with
                  // the leg's total drive time.
                  <RouteConn duration={routeStops.length === 2 ? durHrs : undefined} />
                )}
                <RouteStop
                  time={
                    isFirst
                      ? formatHHMM(trip.startMs)
                      : isLast
                        ? formatHHMM(trip.endMs)
                        : (formatISOHHMM(stop.windowBeginTime) ?? '—')
                  }
                  city={cityState(stop.city, stop.state)}
                  kind={
                    stop.stopType === 'PICKUP'
                      ? 'pickup'
                      : stop.stopType === 'DELIVERY'
                        ? 'delivery'
                        : 'detour'
                  }
                  last={isLast}
                  arrivedAt={showActuals ? stop.checkedInAt : null}
                  departedAt={showActuals ? stop.checkedOutAt : null}
                />
              </React.Fragment>
            );
          })
        ) : (
          <>
            <RouteStop
              time={formatHHMM(trip.startMs)}
              city={trip.from}
              kind="pickup"
              arrivedAt={showActuals ? trip.startCheckedInAt : null}
              departedAt={showActuals ? trip.startCheckedOutAt : null}
            />
            <RouteConn duration={durHrs} />
            <RouteStop
              time={formatHHMM(trip.endMs)}
              city={trip.to}
              kind="delivery"
              last
              arrivedAt={showActuals ? trip.endCheckedInAt : null}
              departedAt={showActuals ? trip.endCheckedOutAt : null}
            />
          </>
        )}

        <div style={{ height: 16 }} />

        <div
          className="grid grid-cols-2 gap-3 p-3"
          style={{
            borderRadius: 8,
            background: 'var(--bg-surface-2)',
            border: '1px solid var(--border-hairline)',
          }}
        >
          <Stat label="Duration" value={`${durHrs.toFixed(1)} hrs`} />
          <Stat label="Stops" value={String(routeStops ? routeStops.length : 2)} />
        </div>

        {trip.conflict && (
          <>
            <div style={{ height: 16 }} />
            <div
              className="flex gap-2.5 p-3"
              style={{ borderRadius: 8, background: '#FEF2F2', border: '1px solid #F5BBBB' }}
            >
              <WIcon name="alert" size={16} style={{ color: '#B91C1C', flexShrink: 0, marginTop: 1 }} />
              <div style={{ fontSize: 12, lineHeight: 1.5, color: '#7F1D1D' }}>
                <div style={{ fontWeight: 600, marginBottom: 2 }}>Schedule conflict</div>
                This trip overlaps with another assignment on the same driver. Move one of the trips or reassign to another driver.
              </div>
            </div>
          </>
        )}
      </div>

      <div
        className="flex items-center justify-end gap-2"
        style={{
          padding: '12px 18px',
          borderTop: '1px solid var(--border-hairline)',
          background: 'var(--bg-surface-2)',
        }}
      >
        <WBtn
          size="sm"
          disabled={!canReassign}
          title={
            canReassign
              ? undefined
              : !trip.loadId
                ? 'No load linked to this trip'
                : !driverId
                  ? 'Reassign is only available for driver trips'
                  : 'Completed trips cannot be reassigned'
          }
          onClick={() => setReassignOpen(true)}
        >
          Reassign
        </WBtn>
        <WBtn
          size="sm"
          variant="primary"
          disabled={!trip.loadId}
          title={trip.loadId ? undefined : 'No load linked to this trip'}
          onClick={() => trip.loadId && router.push(`/loads/${trip.loadId}`)}
        >
          Open trip
        </WBtn>
      </div>

      {trip.loadId && driverId && (
        <ReassignDriverDialog
          open={reassignOpen}
          onOpenChange={setReassignOpen}
          loadId={trip.loadId}
          fromDriverId={driverId}
          fromDriverName={ownerName}
        />
      )}
    </div>
  );
}

function DetailField({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex items-baseline gap-3 py-1.5" style={{ fontSize: 12.5 }}>
      <span style={{ width: 90, flexShrink: 0, color: 'var(--text-tertiary)' }}>{label}</span>
      <span style={{ color: 'var(--text-primary)' }}>{children}</span>
    </div>
  );
}

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <div
        style={{
          fontSize: 10.5,
          color: 'var(--text-tertiary)',
          textTransform: 'uppercase',
          letterSpacing: 0.06,
          fontWeight: 600,
        }}
      >
        {label}
      </div>
      <div
        style={{
          fontSize: 14,
          fontWeight: 600,
          color: 'var(--text-primary)',
          fontVariantNumeric: 'tabular-nums',
          marginTop: 2,
        }}
      >
        {value}
      </div>
    </div>
  );
}

// Parse an ISO 8601 timestamp (with timezone offset) and render the
// wall-clock HH:MM in the user's locale. Used for stop arrival timestamps.
function formatISOHHMM(iso: string | null): string | null {
  if (!iso) return null;
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return null;
  return d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', hour12: false });
}

function RouteStop({
  time,
  city,
  kind,
  last,
  arrivedAt,
  departedAt,
}: {
  time: string;
  city: string;
  kind: 'pickup' | 'delivery' | 'detour';
  last?: boolean;
  arrivedAt?: string | null;
  departedAt?: string | null;
}) {
  const arrived = formatISOHHMM(arrivedAt ?? null);
  const departed = formatISOHHMM(departedAt ?? null);
  const kindColor =
    kind === 'pickup' ? '#3B82F6' : kind === 'delivery' ? '#10B981' : '#9BA3B4';
  return (
    <div className="flex gap-3 relative">
      <div style={{ width: 64, fontSize: 11.5, color: 'var(--text-tertiary)', fontVariantNumeric: 'tabular-nums', paddingTop: 1 }}>
        {time}
      </div>
      <div style={{ position: 'relative', width: 12, flexShrink: 0 }}>
        <div
          style={{
            width: 10,
            height: 10,
            borderRadius: 999,
            border: `2px solid ${kindColor}`,
            background: 'var(--bg-surface)',
            marginTop: 4,
          }}
        />
      </div>
      <div style={{ flex: 1, paddingBottom: last ? 0 : 12 }}>
        <div
          style={{
            fontSize: 11,
            fontWeight: 600,
            textTransform: 'uppercase',
            letterSpacing: 0.06,
            color: kindColor,
          }}
        >
          {kind}
        </div>
        <div style={{ fontSize: 12.5, fontWeight: 500, color: 'var(--text-primary)', marginTop: 1 }}>{city}</div>
        {(arrived || departed) && (
          <div
            style={{
              fontSize: 11,
              color: 'var(--text-tertiary)',
              marginTop: 3,
              fontVariantNumeric: 'tabular-nums',
            }}
          >
            {arrived && (
              <span>
                Arrived <span style={{ color: 'var(--text-primary)', fontWeight: 500 }}>{arrived}</span>
              </span>
            )}
            {arrived && departed && <span style={{ margin: '0 6px', color: 'var(--border-default)' }}>·</span>}
            {departed && (
              <span>
                Departed <span style={{ color: 'var(--text-primary)', fontWeight: 500 }}>{departed}</span>
              </span>
            )}
          </div>
        )}
      </div>
    </div>
  );
}

function RouteConn({ duration }: { duration?: number }) {
  return (
    <div className="flex gap-3">
      <div style={{ width: 64 }} />
      <div style={{ width: 12, position: 'relative' }}>
        <div
          style={{
            position: 'absolute',
            left: 5,
            top: 0,
            bottom: 0,
            width: 2,
            borderLeft: '2px dotted var(--border-default)',
          }}
        />
      </div>
      <div style={{ flex: 1, fontSize: 11, color: 'var(--text-tertiary)', padding: '6px 0' }}>
        {duration != null ? `${duration.toFixed(1)} hr drive` : ' '}
      </div>
    </div>
  );
}

// ── Generic helpers ──────────────────────────────────────────────────────
function Segmented({
  value,
  onChange,
  options,
}: {
  value: string;
  onChange: (v: string) => void;
  options: { id: string; label: string }[];
}) {
  return (
    <div
      className="inline-flex shrink-0 overflow-hidden"
      style={{
        height: 32,
        borderRadius: 8,
        border: '1px solid var(--border-hairline)',
        background: 'var(--bg-surface)',
      }}
    >
      {options.map((opt, i) => {
        const active = value === opt.id;
        return (
          <button
            key={opt.id}
            onClick={() => onChange(opt.id)}
            className="focus-ring"
            style={{
              height: '100%',
              padding: '0 14px',
              cursor: 'pointer',
              fontFamily: 'inherit',
              background: active ? 'var(--bg-surface-2)' : 'transparent',
              color: active ? 'var(--text-primary)' : 'var(--text-secondary)',
              fontSize: 12,
              fontWeight: active ? 500 : 400,
              border: 'none',
              borderLeft: i > 0 ? '1px solid var(--border-hairline)' : 'none',
              transition: 'background var(--dur-fast) var(--ease-out), color var(--dur-fast) var(--ease-out)',
            }}
            onMouseEnter={(e) => {
              if (!active) e.currentTarget.style.background = 'var(--bg-row-hover)';
            }}
            onMouseLeave={(e) => {
              if (!active) e.currentTarget.style.background = 'transparent';
            }}
          >
            {opt.label}
          </button>
        );
      })}
    </div>
  );
}

function IconBtn({
  icon,
  title,
  onClick,
}: {
  icon: 'chevron-left' | 'chevron-right';
  title: string;
  onClick?: () => void;
}) {
  return (
    <button
      onClick={onClick}
      title={title}
      className="focus-ring inline-flex items-center justify-center"
      style={{
        width: 32,
        height: 32,
        borderRadius: 8,
        border: 'none',
        background: 'transparent',
        cursor: 'pointer',
        color: 'var(--text-secondary)',
        transition: 'background var(--dur-fast) var(--ease-out), color var(--dur-fast) var(--ease-out)',
      }}
      onMouseEnter={(e) => {
        e.currentTarget.style.background = 'var(--bg-row-hover)';
        e.currentTarget.style.color = 'var(--text-primary)';
      }}
      onMouseLeave={(e) => {
        e.currentTarget.style.background = 'transparent';
        e.currentTarget.style.color = 'var(--text-secondary)';
      }}
    >
      <WIcon name={icon} size={14} />
    </button>
  );
}

function LegendDot({ color, bd, label }: { color: string; bd: string; label: string }) {
  return (
    <span className="inline-flex items-center gap-1.5">
      <span style={{ width: 14, height: 10, borderRadius: 3, background: color, border: `1px solid ${bd}` }} />
      {label}
    </span>
  );
}
