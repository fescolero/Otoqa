/**
 * LiveTrackingModal — full-screen tracking view for a load.
 *
 * Layout matches the design's "Live tracking" mock:
 *   ┌─ header: "Live tracking · route" ········· × ──┐
 *   │                                                 │
 *   │  ┌─[Live · updates every 30s] ────────┐        │
 *   │  │                                     │ ─────┐ │
 *   │  │           map (LiveRouteMap)        │ rail │ │
 *   │  │                                     │ 380  │ │
 *   │  └─[From … To …] ─────────────────────┘ ─────┘ │
 *   └────────────────────────────────────────────────┘
 *
 * Right rail (380px): ASSIGNED block · DISTANCE/DURATION strip ·
 * "Trip activity" ↔ "GPS pings" tabs · scrollable event timeline ·
 * Export + Share ETA footer.
 *
 * Real data: driver/truck/trailer pulled from loadData; distance from
 * `effectiveMiles`; activity events derived from stop check-ins. Anything
 * the schema doesn't yet expose (geofence pings, traffic events, fuel
 * stops) is left out — when telematics events land they slot into the
 * same TimelineEvent shape.
 */

'use client';

import * as React from 'react';
import { Dialog, DialogContent, DialogTitle } from '@/components/ui/dialog';
import { LiveRouteMap, type RouteSummary } from '@/components/dispatch/live-route-map';
import { Avatar, Chip, type ChipStatus, WBtn, WIcon, type IconName } from '@/components/web';
import { cn } from '@/lib/utils';
import type { Id } from '@/convex/_generated/dataModel';

type EventTone = 'info' | 'ok' | 'warn' | 'crit' | 'neutral';

interface TimelineEvent {
  id: string;
  title: string;
  detail?: string;
  /** Time in HH:MM format. */
  time: string;
  /** Mile marker (e.g. 480 for "mi 480"). */
  mile?: number;
  icon: IconName;
  tone: EventTone;
  /** Marks the most recent / current event for the highlighted ring. */
  current?: boolean;
}

const TONE_HEX: Record<EventTone, { fg: string; bg: string }> = {
  info: { fg: '#1A47E6', bg: 'rgba(46,92,255,0.10)' },
  ok:   { fg: '#0F8C5F', bg: 'rgba(16,185,129,0.12)' },
  warn: { fg: '#A66800', bg: 'rgba(245,158,11,0.14)' },
  crit: { fg: '#B43030', bg: 'rgba(239,68,68,0.12)' },
  neutral: { fg: 'var(--text-secondary)', bg: 'var(--bg-row-hover)' },
};

/**
 * One row from `driverLocations` for a load. Matches what
 * `api.driverLocations.getDetailedRouteHistoryForLoad` returns. The list
 * view in the GPS pings tab assumes the array is already sorted (the
 * Convex query orders ascending — the modal flips to newest-first for
 * display).
 *
 * `recordedAt` is the device timestamp (when the GPS was captured);
 * `createdAt` is the server timestamp (when the ping synced). The delta
 * between the two surfaces offline-driving gaps and is rendered when
 * notable (>= 2 min).
 */
export interface GpsPing {
  recordedAt: number;
  createdAt?: number;
  latitude: number;
  longitude: number;
  speed?: number;
  heading?: number;
  accuracy?: number;
}

interface AssignedDriver {
  _id?: string;
  name: string;
  shortcode?: string;
}
interface AssignedCarrier {
  name: string;
  mcNumber?: string;
}
interface AssignedEquipment {
  truck?: string;
  trailer?: string;
  equipmentType?: string;
}

/**
 * Trip lifecycle state used to swap the DURATION cell's label and source:
 *  - `pre-trip` → `EST. DURATION` (Google planned)
 *  - `in-transit` → `EST. REMAINING` (Google planned − elapsed since pickup)
 *  - `delivered` → `TRIP DURATION` (actual: last delivery check-in − first pickup check-in)
 */
export type TripState = 'pre-trip' | 'in-transit' | 'delivered';

export interface LiveTrackingModalProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  loadId: string;
  organizationId: string;
  orderNumber: string;
  statusLabel?: string;
  statusChip?: ChipStatus;
  /**
   * True iff the load is actively in transit. Drives "live unit" affordances
   * on the map (live driver pin, polyline extension to current position,
   * geofence-proximity highlight). Decoupled from `statusLabel` because
   * that string is display-formatted and shouldn't drive logic.
   */
  isInTransit?: boolean;
  origin: string;
  destination: string;
  driver?: AssignedDriver | null;
  carrier?: AssignedCarrier | null;
  equipment?: AssignedEquipment | null;
  /** Total route miles (fallback before Google Directions resolves). */
  distanceMi?: number | null;
  /** Estimated duration label (fallback before Directions resolves). */
  durationLabel?: string | null;
  /** Trip lifecycle state — drives the DURATION cell's label + source. */
  tripState?: TripState;
  /** Epoch-ms timestamp the driver checked in at the first pickup. */
  tripStartedAtMs?: number | null;
  /** Epoch-ms timestamp the driver checked in at the final delivery. */
  tripEndedAtMs?: number | null;
  /** Time pulled when the modal opened (used for the live freshness pill). */
  refreshLabel?: string | null;
  events: TimelineEvent[];
  /** GPS pings for this load (ascending by recordedAt). The modal flips to
   *  newest-first when rendering. Omit for `Loading…` empty state. */
  gpsPings?: GpsPing[];
  /** Stop coords for the underlying LiveRouteMap. */
  stops: Array<{
    id: string;
    lat: number;
    lng: number;
    type: 'pickup' | 'delivery';
    sequenceNumber: number;
    status?: 'Pending' | 'In Transit' | 'Completed';
    city?: string;
    state?: string;
  }>;
  selectedStopId?: string | null;
  onStopSelect?: (stopId: string | null) => void;
  onExport?: () => void;
  onShareEta?: () => void;
}

export function LiveTrackingModal({
  open,
  onOpenChange,
  loadId,
  organizationId,
  orderNumber,
  statusLabel,
  statusChip,
  isInTransit = false,
  origin,
  destination,
  driver,
  carrier,
  equipment,
  distanceMi,
  durationLabel,
  tripState = 'pre-trip',
  tripStartedAtMs,
  tripEndedAtMs,
  refreshLabel,
  events,
  gpsPings,
  stops,
  selectedStopId,
  onStopSelect,
  onExport,
  onShareEta,
}: LiveTrackingModalProps) {
  const [tab, setTab] = React.useState<'activity' | 'pings'>('activity');

  // Authoritative route summary from Google Directions, populated by
  // LiveRouteMap's onRouteResolved hook. The map already fires this call to
  // draw the polyline — we just sip from the same response. While Directions
  // is in-flight (or the call is impossible because <2 geocoded stops),
  // `resolved` stays null and we fall back to the props the caller supplied.
  const [resolved, setResolved] = React.useState<RouteSummary | null>(null);

  // Reset whenever the modal closes so the next open re-fetches against the
  // live route — a closed modal has no point holding stale numbers.
  React.useEffect(() => {
    if (!open) setResolved(null);
  }, [open]);

  const liveDistanceMi = resolved ? resolved.totalMeters / 1609.344 : null;
  const liveDurationSec = resolved ? resolved.totalSeconds : null;

  const displayedDistance = liveDistanceMi != null ? liveDistanceMi : distanceMi ?? null;

  // Tick `now` once a minute while the modal is open and the trip is in
  // transit, so EST. REMAINING counts down without needing a Convex round-trip.
  const [now, setNow] = React.useState(() => Date.now());
  React.useEffect(() => {
    if (!open || tripState !== 'in-transit') return;
    const t = setInterval(() => setNow(Date.now()), 60 * 1000);
    return () => clearInterval(t);
  }, [open, tripState]);

  // Status-aware duration: label + value swap based on where the trip is.
  // Falls back gracefully when the prerequisite data isn't there yet —
  // the modal can open before Directions resolves.
  const { durationCellLabel, durationCellValue } = (() => {
    // Delivered: actual elapsed wins, no Directions dependency.
    if (tripState === 'delivered' && tripStartedAtMs && tripEndedAtMs && tripEndedAtMs > tripStartedAtMs) {
      return {
        durationCellLabel: 'TRIP DURATION',
        durationCellValue: formatDurationFromSec((tripEndedAtMs - tripStartedAtMs) / 1000),
      };
    }
    // In transit with a pickup check-in and a resolved Google ETA → remaining.
    if (tripState === 'in-transit' && tripStartedAtMs && liveDurationSec != null) {
      const elapsedSec = (now - tripStartedAtMs) / 1000;
      const remainingSec = liveDurationSec - elapsedSec;
      if (remainingSec <= 60) {
        return { durationCellLabel: 'EST. REMAINING', durationCellValue: 'arriving' };
      }
      return {
        durationCellLabel: 'EST. REMAINING',
        durationCellValue: formatDurationFromSec(remainingSec),
      };
    }
    // Pre-trip (or in-transit before Directions resolves) → planned total.
    return {
      durationCellLabel: 'EST. DURATION',
      durationCellValue:
        liveDurationSec != null ? formatDurationFromSec(liveDurationSec) : durationLabel ?? null,
    };
  })();

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        className="max-w-[96vw] sm:max-w-[1340px] h-[92vh] p-0 overflow-hidden border-0"
        style={{ background: 'var(--bg-canvas)' }}
      >
        <DialogTitle className="sr-only">{`Live tracking — load ${orderNumber}`}</DialogTitle>

        {/* DialogContent uses CSS grid with auto-sized rows, which made
            `h-full` here resolve to the grid track's content size — and
            since our right rail can render 100+ GPS pings, that track grew
            to thousands of px and stretched the map alongside it. Pinning
            this wrapper to an explicit 92vh + overflow-hidden defeats the
            grid auto-sizing so the map stays bounded to one viewport. */}
        <div className="h-[92vh] flex flex-col overflow-hidden">
          {/* Header */}
          <div
            className="shrink-0 flex items-center gap-3 px-5 h-14"
            style={{
              background: 'var(--bg-canvas)',
              borderBottom: '1px solid var(--border-hairline)',
            }}
          >
            <span
              aria-hidden
              className="inline-block rounded-full shrink-0"
              style={{
                width: 8,
                height: 8,
                background: '#2E5CFF',
                boxShadow: '0 0 0 4px rgba(46,92,255,0.18)',
              }}
            />
            <div className="text-[14.5px] font-semibold text-foreground">Live tracking</div>
            <span className="text-[var(--text-tertiary)]">·</span>
            <div className="text-[12.5px] text-[var(--text-secondary)] truncate">
              {origin} <span className="text-[var(--text-tertiary)]">→</span> {destination}
            </div>
            {statusLabel && (
              <Chip status={statusChip ?? 'active'} label={statusLabel} />
            )}
            <div className="flex-1" />
          </div>

          {/* Body: map + right rail */}
          <div className="flex-1 min-h-0 flex">
            {/* Map area */}
            <div className="flex-1 min-w-0 relative">
              {/* No "Live · updates every 30s" pill here — the header's
                  pulsing blue dot + "Live tracking" label already conveys
                  liveness, and TimeRangeIndicator owns the top-right corner. */}

              {/* From/To pill */}
              <div
                className="absolute bottom-3 left-3 z-10 inline-flex items-center gap-2.5 px-3 h-8 rounded-md text-[11.5px]"
                style={{
                  background: 'var(--bg-surface)',
                  border: '1px solid var(--border-hairline)',
                  boxShadow: '0 4px 14px -8px rgba(15,22,36,0.18)',
                }}
              >
                <span className="text-[var(--text-tertiary)]">From</span>
                <span className="text-foreground font-medium truncate max-w-[160px]">{origin}</span>
                <span className="text-[var(--text-tertiary)]">To</span>
                <span className="text-foreground font-medium truncate max-w-[160px]">{destination}</span>
              </div>

              <LiveRouteMap
                loadId={loadId as Id<'loadInformation'>}
                organizationId={organizationId}
                driverId={driver?._id as Id<'drivers'> | undefined}
                height="100%"
                stops={stops}
                selectedStopId={selectedStopId ?? undefined}
                onStopSelect={onStopSelect}
                onRouteResolved={setResolved}
                pingsMode={tab === 'pings'}
                // Lines / pin to the live truck only when this load is
                // actively in transit. Historical pings stay visible for
                // completed loads via getRouteHistoryForLoad.
                isInTransit={isInTransit}
              />
            </div>

            {/* Right rail. min-h-0 + min-w-0 are load-bearing: without them
                a tall GpsPingsList (95+ rows) makes this rail expand to its
                intrinsic content height, which then drags the entire body
                row taller than the dialog viewport, leaving the map's
                gm-style div at ~5000px (most of it below the visible area)
                so the map appears blank when GPS pings is selected. */}
            <div
              className="w-[380px] min-w-0 min-h-0 shrink-0 flex flex-col"
              style={{
                background: 'var(--bg-canvas)',
                borderLeft: '1px solid var(--border-hairline)',
              }}
            >
              {/* ASSIGNED */}
              <div className="shrink-0 px-4 pt-4 pb-3 flex flex-col gap-3" style={{ borderBottom: '1px solid var(--border-hairline)' }}>
                <div className="tw-label text-[10.5px] text-[var(--text-tertiary)] tracking-[0.06em]">ASSIGNED</div>
                {driver ? (
                  <div className="flex items-center gap-2.5">
                    <Avatar name={driver.name} size={28} />
                    <div className="min-w-0">
                      <div className="text-[13px] font-semibold text-foreground truncate">{driver.name}</div>
                      <div className="num text-[11px] text-[var(--text-tertiary)] mt-0.5">
                        CDL{driver.shortcode ? ` · ${driver.shortcode}` : ''}
                      </div>
                    </div>
                  </div>
                ) : carrier ? (
                  <div className="flex items-center gap-2.5">
                    <span
                      className="inline-flex items-center justify-center rounded-md shrink-0"
                      style={{
                        width: 28,
                        height: 28,
                        background: 'var(--bg-row-hover)',
                        color: 'var(--text-secondary)',
                      }}
                    >
                      <WIcon name="building" size={14} />
                    </span>
                    <div className="min-w-0">
                      <div className="text-[13px] font-semibold text-foreground truncate">{carrier.name}</div>
                      <div className="num text-[11px] text-[var(--text-tertiary)] mt-0.5">
                        Carrier{carrier.mcNumber ? ` · MC ${carrier.mcNumber}` : ''}
                      </div>
                    </div>
                  </div>
                ) : (
                  <div className="text-[12px] text-[var(--text-tertiary)] italic">No driver assigned</div>
                )}
                {equipment && (equipment.truck || equipment.trailer) && (
                  <div className="flex items-center gap-2.5">
                    <span
                      className="inline-flex items-center justify-center rounded-md shrink-0"
                      style={{
                        width: 28,
                        height: 28,
                        background: 'var(--bg-row-hover)',
                        color: 'var(--text-secondary)',
                      }}
                    >
                      <WIcon name="truck" size={14} />
                    </span>
                    <div className="min-w-0">
                      <div className="num text-[13px] font-semibold text-foreground truncate">
                        {[equipment.truck, equipment.trailer].filter(Boolean).join(' · ')}
                      </div>
                      {equipment.equipmentType && (
                        <div className="text-[11px] text-[var(--text-tertiary)] mt-0.5">{equipment.equipmentType}</div>
                      )}
                    </div>
                  </div>
                )}
              </div>

              {/* DISTANCE / EST. DURATION — values are sourced from Google
                  Directions (via LiveRouteMap's onRouteResolved) when the
                  route is available, otherwise we fall back to the values
                  the caller passed (effectiveMiles + a 60mph derivative). */}
              <div
                className="shrink-0 grid grid-cols-2"
                style={{ borderBottom: '1px solid var(--border-hairline)' }}
              >
                <div className="px-4 py-3">
                  <div className="tw-label text-[10.5px] text-[var(--text-tertiary)] tracking-[0.06em]">DISTANCE</div>
                  <div className="num text-[18px] font-semibold text-foreground tabular-nums mt-0.5">
                    {displayedDistance != null
                      ? `${displayedDistance.toLocaleString(undefined, { maximumFractionDigits: 1 })} mi`
                      : '—'}
                  </div>
                </div>
                <div className="px-4 py-3" style={{ borderLeft: '1px solid var(--border-hairline)' }}>
                  <div className="tw-label text-[10.5px] text-[var(--text-tertiary)] tracking-[0.06em]">{durationCellLabel}</div>
                  <div className="num text-[18px] font-semibold text-foreground tabular-nums mt-0.5">
                    {durationCellValue ?? '—'}
                  </div>
                </div>
              </div>

              {/* Tab bar */}
              <div className="shrink-0 px-3 pt-3">
                <div
                  className="grid grid-cols-2 rounded-lg p-1"
                  style={{ background: 'var(--bg-row-hover)' }}
                >
                  <button
                    type="button"
                    onClick={() => setTab('activity')}
                    className={cn(
                      'focus-ring h-7 rounded-md text-[12px] font-medium transition-colors',
                      tab === 'activity'
                        ? 'bg-[var(--bg-surface)] text-foreground shadow-sm'
                        : 'text-[var(--text-secondary)] hover:text-foreground',
                    )}
                  >
                    Trip activity
                  </button>
                  <button
                    type="button"
                    onClick={() => setTab('pings')}
                    className={cn(
                      'focus-ring h-7 rounded-md text-[12px] font-medium transition-colors inline-flex items-center justify-center gap-1.5',
                      tab === 'pings'
                        ? 'bg-[var(--bg-surface)] text-foreground shadow-sm'
                        : 'text-[var(--text-secondary)] hover:text-foreground',
                    )}
                  >
                    <span>GPS pings</span>
                    {gpsPings && gpsPings.length > 0 && (
                      <span className="num text-[10.5px] text-[var(--text-tertiary)]">
                        {gpsPings.length.toLocaleString()}
                      </span>
                    )}
                  </button>
                </div>
              </div>

              {/* Timeline */}
              <div className="flex-1 min-h-0 overflow-auto scroll-thin px-4 py-3">
                {tab === 'activity' ? (
                  events.length === 0 ? (
                    <p className="m-0 text-[12px] text-[var(--text-tertiary)] italic">
                      No activity yet — events will appear here as the trip progresses.
                    </p>
                  ) : (
                    <div className="flex flex-col">
                      {events.map((ev, idx) => (
                        <TimelineRow key={ev.id} ev={ev} isLast={idx === events.length - 1} />
                      ))}
                    </div>
                  )
                ) : (
                  <GpsPingsList pings={gpsPings} />
                )}
              </div>

              {/* Footer actions */}
              <div
                className="shrink-0 flex gap-2 px-3 py-3"
                style={{ borderTop: '1px solid var(--border-hairline)' }}
              >
                <WBtn size="sm" leading="export" onClick={onExport} className="flex-1">
                  Export
                </WBtn>
                <WBtn size="sm" leading="upload" variant="primary" onClick={onShareEta} className="flex-1">
                  Share ETA
                </WBtn>
              </div>
            </div>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}

function TimelineRow({ ev, isLast }: { ev: TimelineEvent; isLast: boolean }) {
  const tone = TONE_HEX[ev.tone];
  return (
    <div className="flex gap-3 pb-3">
      {/* Gutter */}
      <div className="flex flex-col items-center shrink-0" style={{ width: 26 }}>
        <span
          className="inline-flex items-center justify-center rounded-full shrink-0"
          style={{
            width: 26,
            height: 26,
            background: tone.bg,
            color: tone.fg,
            boxShadow: ev.current ? `0 0 0 4px ${tone.bg}` : 'none',
          }}
        >
          <WIcon name={ev.icon} size={12} />
        </span>
        {!isLast && (
          <div
            className="flex-1 mt-1"
            style={{
              width: 1.5,
              background: 'var(--border-hairline-strong)',
              opacity: 0.5,
              minHeight: 12,
            }}
          />
        )}
      </div>
      {/* Body */}
      <div className="min-w-0 flex-1">
        <div className="flex items-baseline justify-between gap-2">
          <div className={cn('text-[12.5px] truncate', ev.current ? 'font-semibold text-foreground' : 'font-medium text-foreground')}>
            {ev.title}
          </div>
          <div className="num text-[11px] text-[var(--text-tertiary)] tabular-nums shrink-0">{ev.time}</div>
        </div>
        {ev.detail && (
          <div className="text-[11.5px] text-[var(--text-secondary)] mt-0.5 leading-[16px]">{ev.detail}</div>
        )}
        {ev.mile != null && (
          <div className="num text-[10.5px] text-[var(--text-tertiary)] mt-0.5">mi {ev.mile.toLocaleString()}</div>
        )}
      </div>
    </div>
  );
}

export type { TimelineEvent };

/**
 * Format a duration in seconds as "11h 20m" (or just "45m" for sub-hour
 * routes). Rounds to the nearest 5 minutes — matches the design's display
 * granularity and avoids the value flickering as Directions re-quotes.
 */
function formatDurationFromSec(totalSeconds: number): string {
  if (!Number.isFinite(totalSeconds) || totalSeconds <= 0) return '—';
  const totalMin = Math.max(5, Math.round(totalSeconds / 60 / 5) * 5);
  const h = Math.floor(totalMin / 60);
  const m = totalMin % 60;
  if (h === 0) return `${m}m`;
  return m === 0 ? `${h}h` : `${h}h ${m}m`;
}

/**
 * GPS pings list — newest first, with time, speed, heading, and a compact
 * lat/lng. The Convex query orders ascending; we reverse for display so
 * the freshest ping is at the top of the rail.
 *
 * Volume: a long trip can produce hundreds of pings. We slice to the most
 * recent 200 with a footer count when there are more — virtualization can
 * come later if dispatchers actually scroll past 200.
 */
const PING_PAGE = 200;

function GpsPingsList({ pings }: { pings?: GpsPing[] }) {
  if (pings === undefined) {
    return <p className="m-0 text-[12px] text-[var(--text-tertiary)] italic">Loading GPS pings…</p>;
  }
  if (pings.length === 0) {
    return (
      <p className="m-0 text-[12px] text-[var(--text-tertiary)] italic">
        No GPS pings recorded for this load yet.
      </p>
    );
  }
  // Reverse for display without mutating the caller's array.
  const newestFirst = [...pings].reverse();
  const visible = newestFirst.slice(0, PING_PAGE);
  return (
    <div className="flex flex-col">
      {visible.map((p, idx) => (
        <PingRow key={`${p.recordedAt}-${idx}`} ping={p} isFirst={idx === 0} />
      ))}
      {newestFirst.length > PING_PAGE && (
        <div className="num text-[10.5px] text-[var(--text-tertiary)] mt-2 pb-1">
          Showing latest {PING_PAGE.toLocaleString()} of {newestFirst.length.toLocaleString()} pings.
        </div>
      )}
    </div>
  );
}

function PingRow({ ping, isFirst }: { ping: GpsPing; isFirst: boolean }) {
  const syncDelaySec =
    ping.createdAt != null && ping.createdAt > ping.recordedAt
      ? Math.round((ping.createdAt - ping.recordedAt) / 1000)
      : null;
  // Only surface the delay when it's notable: < 2 min is normal latency
  // (cellular round-trip + Convex push) and would just clutter the row.
  // 2-15 min = `info` (interesting). >= 15 min = `warn` (likely an
  // offline-driving gap that synced when the device reconnected).
  const syncTone: 'info' | 'warn' | null =
    syncDelaySec != null && syncDelaySec >= 120
      ? syncDelaySec >= 900
        ? 'warn'
        : 'info'
      : null;
  const syncColor =
    syncTone === 'warn' ? '#A66800' : syncTone === 'info' ? 'var(--accent)' : null;

  return (
    <div
      className={cn(
        'flex items-center gap-2.5 py-1.5',
        !isFirst && 'border-t border-[var(--border-hairline)]',
      )}
    >
      {/* Compact dot — matches the activity-timeline gutter visually but no
          line-connector since pings are dense and uniform. */}
      <span
        aria-hidden
        className="inline-block rounded-full shrink-0"
        style={{
          width: 6,
          height: 6,
          background: isFirst ? '#2E5CFF' : 'var(--text-tertiary)',
          boxShadow: isFirst ? '0 0 0 3px rgba(46,92,255,0.22)' : 'none',
          marginLeft: 4,
          marginRight: 4,
        }}
      />
      <div className="min-w-0 flex-1">
        <div className="flex items-baseline gap-2 flex-wrap">
          <div className="num text-[11.5px] font-medium text-foreground tabular-nums">
            {formatPingTime(ping.recordedAt)}
          </div>
          {ping.speed != null && (
            <div className="num text-[11px] text-[var(--text-secondary)]">
              {formatSpeedMph(ping.speed)}
            </div>
          )}
          {ping.heading != null && (
            <div className="text-[10.5px] text-[var(--text-tertiary)] uppercase tracking-[0.04em]">
              {headingToCompass(ping.heading)}
            </div>
          )}
          {syncTone && syncColor && syncDelaySec != null && (
            <div
              className="num text-[10px] font-medium px-1.5 py-px rounded tabular-nums"
              title={`Device captured at ${formatPingTime(ping.recordedAt)}; server synced at ${formatPingTime(ping.createdAt!)}`}
              style={{
                background: syncTone === 'warn' ? 'rgba(245,158,11,0.12)' : 'rgba(46,92,255,0.10)',
                color: syncColor,
              }}
            >
              +{formatSyncDelay(syncDelaySec)} sync
            </div>
          )}
        </div>
        <div className="num text-[10.5px] text-[var(--text-tertiary)] mt-px flex items-center gap-2">
          <span>
            {ping.latitude.toFixed(4)}, {ping.longitude.toFixed(4)}
          </span>
          {ping.accuracy != null && ping.accuracy > 0 && (
            <span title="GPS accuracy radius">±{Math.round(ping.accuracy)}m</span>
          )}
        </div>
      </div>
    </div>
  );
}

function formatPingTime(ms: number): string {
  if (!Number.isFinite(ms)) return '—';
  return new Date(ms).toLocaleTimeString('en-US', {
    hour: 'numeric',
    minute: '2-digit',
    second: '2-digit',
    hour12: true,
  });
}

/** GPS schemas vary on units. Otoqa stores speed as m/s in `driverLocations`
 *  (tracked workers report m/s natively); we convert to mph for display.
 *  If a value comes through clearly already in mph (>200 → assume mph and
 *  pass through; vehicles topping 200 m/s = 447 mph, which is impossible),
 *  we trust it. */
function formatSpeedMph(speed: number): string {
  if (!Number.isFinite(speed) || speed < 0) return '—';
  const mph = speed > 200 ? speed : speed * 2.23694;
  return `${Math.round(mph)} mph`;
}

function headingToCompass(deg: number): string {
  if (!Number.isFinite(deg)) return '';
  const norm = ((deg % 360) + 360) % 360;
  const sectors = ['N', 'NE', 'E', 'SE', 'S', 'SW', 'W', 'NW'];
  return sectors[Math.round(norm / 45) % 8];
}

/** Compact sync-delay label: "3m", "47m", "2h 14m". */
function formatSyncDelay(totalSeconds: number): string {
  if (totalSeconds < 60) return `${totalSeconds}s`;
  const totalMin = Math.round(totalSeconds / 60);
  if (totalMin < 60) return `${totalMin}m`;
  const h = Math.floor(totalMin / 60);
  const m = totalMin % 60;
  return m === 0 ? `${h}h` : `${h}h ${m}m`;
}
