/**
 * SessionActivityPanel — right rail for the Active Sessions live ops page.
 *
 * Mirrors `web/screens/sessions-activity.jsx` from the design bundle:
 *   • Back-to-list button
 *   • Header — avatar, name, live status dot + label, truck/plate, last
 *     known location/activity line, message button
 *   • Summary stats — Shift / Distance / Idle / Alerts
 *   • Tabs — Trips · GPS pings
 *   • Tab body — single in-progress load card (no multi-trip rollup yet;
 *     backend only tracks the currently-active leg) OR newest-first ping
 *     list with speed badges
 *
 * Notes on scope:
 *   - "Trips" in the design = multiple legs in a shift. Today's backend
 *     gives us one in-progress leg per active session. Past legs from this
 *     shift will appear once we wire `getByDriver` filtered to today.
 *   - "Distance" is computed from ping pairs client-side (Haversine); when
 *     no pings exist yet, we show "—".
 */

'use client';

import * as React from 'react';
import { Chip, WBtn, WIcon } from '@/components/web';
import {
  STATUS_TONE,
  TRIP_PALETTE,
  toneForTrip,
  avatarColorForId,
  initialsForName,
  type DerivedStatus,
  type LiveSessionRow,
  type PastSessionRow,
  type RecentPing,
  type TripInfo,
  type TripLegStatus,
} from './types';

type Tab = 'trips' | 'pings';

/**
 * Trip-focus mode: when an index is set, only that trip's polyline is
 * fully visible on the map; others dim. `null` = show all. Each trip
 * card renders a pin button that toggles this state for its index.
 */
interface FocusProps {
  focusedTripIndex: number | null;
  onFocusTrip: (next: number | null) => void;
}

type LivePanelProps = FocusProps & {
  mode: 'live';
  session: LiveSessionRow;
  pings: RecentPing[];
  pingsLoading: boolean;
  tab: Tab;
  onTabChange: (t: Tab) => void;
  onBack: () => void;
  onForceEndShift: () => void;
  onHoverPing?: (ping: RecentPing | null) => void;
};

type PastPanelProps = FocusProps & {
  mode: 'past';
  session: PastSessionRow;
  pings: RecentPing[];
  pingsLoading: boolean;
  tab: Tab;
  onTabChange: (t: Tab) => void;
  onBack: () => void;
  onHoverPing?: (ping: RecentPing | null) => void;
};

type Props = LivePanelProps | PastPanelProps;

export function SessionActivityPanel(props: Props) {
  const isLive = props.mode === 'live';
  const session = props.session;
  const avatar = avatarColorForId(session.driverId);
  const initials = initialsForName(session.driverName);
  const tone = isLive
    ? STATUS_TONE[(session as LiveSessionRow).status]
    : // Past sessions: neutral "completed" tone. Uses the design system
      // token instead of a literal so it stays legible in dark mode.
      { color: 'var(--text-secondary)', label: 'Completed' };
  // Distance: live → Haversine from pings (gives live updates); past → use
  // the server's pre-computed `distanceKm` directly (cheaper, authoritative).
  const distanceKm = React.useMemo(
    () =>
      isLive
        ? computeDistanceKm(props.pings)
        : (session as PastSessionRow).distanceKm,
    [isLive, props.pings, session]
  );
  const idleMs = React.useMemo(() => computeIdleMs(props.pings), [props.pings]);
  const elapsedMs = isLive
    ? Date.now() - session.startedAt
    : (session as PastSessionRow).activeMs;

  return (
    <div
      className="flex h-full w-full min-w-0 flex-col"
      style={{ background: 'var(--bg-surface)' }}
    >
      {/* Back-to-list */}
      <button
        type="button"
        onClick={props.onBack}
        className="focus-ring flex shrink-0 items-center gap-2 px-[14px] py-[10px] text-left text-[12.5px] font-medium"
        style={{
          background: 'var(--bg-canvas)',
          border: 'none',
          borderBottom: '1px solid var(--border-hairline)',
          cursor: 'pointer',
          fontFamily: 'inherit',
          color: 'var(--text-secondary)',
        }}
        onMouseEnter={(e) => {
          e.currentTarget.style.color = 'var(--text-primary)';
          e.currentTarget.style.background = 'var(--bg-row-hover)';
        }}
        onMouseLeave={(e) => {
          e.currentTarget.style.color = 'var(--text-secondary)';
          e.currentTarget.style.background = 'var(--bg-canvas)';
        }}
      >
        <span
          className="inline-flex h-[22px] w-[22px] items-center justify-center rounded-md"
          style={{
            background: 'var(--bg-surface)',
            border: '1px solid var(--border-hairline)',
            color: 'var(--text-secondary)',
          }}
        >
          <WIcon name="chevron-left" size={13} />
        </span>
        <span>All drivers</span>
      </button>

      {/* Header */}
      <div
        className="flex shrink-0 items-start gap-3 px-4 py-[14px]"
        style={{ borderBottom: '1px solid var(--border-hairline)' }}
      >
        <div
          className="flex h-[38px] w-[38px] shrink-0 items-center justify-center rounded-full text-[14px] font-semibold text-white"
          style={{ background: avatar }}
        >
          {initials}
        </div>
        <div className="min-w-0 flex-1">
          <div className="mb-px flex items-center gap-2">
            <div
              className="text-[14.5px] font-semibold"
              style={{ color: 'var(--text-primary)' }}
            >
              {session.driverName}
            </div>
            {isLive ? <LiveDot tone={tone.color} /> : <CompletedDot />}
            <span
              className="text-[11px] font-medium"
              style={{ color: tone.color }}
            >
              {tone.label}
            </span>
          </div>
          <div className="text-[11.5px]" style={{ color: 'var(--text-tertiary)' }}>
            {[session.truckMakeModel, session.truckUnitId && `#${session.truckUnitId}`, session.truckPlate]
              .filter(Boolean)
              .join(' · ') || 'Truck info unavailable'}
          </div>
          <div
            className="mt-0.5 text-[11px]"
            style={{ color: 'var(--text-tertiary)' }}
          >
            {isLive
              ? (session as LiveSessionRow).statusLoc
              : `Shift ${formatHHMM((session as PastSessionRow).startedAt)} → ${(session as PastSessionRow).endedAt ? formatHHMM((session as PastSessionRow).endedAt!) : '…'}`}
          </div>
        </div>
        <button
          type="button"
          title="Message driver (coming soon)"
          className="focus-ring flex h-[28px] w-[28px] items-center justify-center rounded-md"
          style={{
            background: 'transparent',
            border: '1px solid var(--border-hairline-strong)',
            color: 'var(--text-secondary)',
            cursor: 'not-allowed',
            opacity: 0.55,
            fontFamily: 'inherit',
          }}
          disabled
        >
          <WIcon name="bell" size={14} />
        </button>
      </div>

      {/* Summary stats */}
      <div
        className="flex shrink-0 gap-4 px-4 py-[14px]"
        style={{ borderBottom: '1px solid var(--border-hairline)' }}
      >
        <SummaryStat
          label="Shift"
          value={formatDuration(elapsedMs)}
          sub={`Started ${formatHHMM(session.startedAt)}`}
        />
        <SummaryStat
          label="Distance"
          value={distanceKm == null ? '—' : `${Math.round(distanceKm)} km`}
          sub={props.pings.length > 0 ? `${props.pings.length} pings` : 'no pings yet'}
        />
        <SummaryStat
          label="Idle time"
          value={idleMs == null ? '—' : formatDuration(idleMs)}
          sub="stop ≤ 5 mph"
        />
        <SummaryStat
          label="Alerts"
          value={session.incidents}
          tone={session.incidents > 0 ? 'warn' : undefined}
          sub={
            session.incidents === 0
              ? 'all clear'
              : session.incidents === 1
                ? '1 today'
                : `${session.incidents} today`
          }
        />
      </div>

      {/* Tabs */}
      <div
        className="flex shrink-0 px-2"
        style={{
          background: 'var(--bg-surface)',
          borderBottom: '1px solid var(--border-hairline)',
        }}
      >
        <PanelTab
          label="Trips"
          count={session.trips.length}
          active={props.tab === 'trips'}
          onClick={() => props.onTabChange('trips')}
        />
        <PanelTab
          label="GPS pings"
          count={props.pings.length}
          active={props.tab === 'pings'}
          onClick={() => props.onTabChange('pings')}
        />
      </div>

      {/* Tab body */}
      <div className="min-h-0 flex-1 overflow-auto">
        {props.tab === 'trips' ? (
          <TripsBody
            trips={session.trips}
            isLive={isLive}
            focusedTripIndex={props.focusedTripIndex}
            onFocusTrip={props.onFocusTrip}
          />
        ) : (
          <PingsList
            pings={props.pings}
            loading={props.pingsLoading}
            onHover={props.onHoverPing}
          />
        )}
      </div>

      {/* Footer — live mode keeps the Force End Shift affordance; past
          mode just shows the shift summary line. */}
      <div
        className="flex shrink-0 items-center justify-between gap-2 px-4 py-2"
        style={{ borderTop: '1px solid var(--border-hairline)' }}
      >
        <span className="text-[11px]" style={{ color: 'var(--text-tertiary)' }}>
          Started {formatHHMM(session.startedAt)} · {formatDuration(elapsedMs)}{' '}
          {isLive ? 'elapsed' : 'shift'}
        </span>
        {props.mode === 'live' && (
          <WBtn
            size="sm"
            variant="ghost"
            leading="alert"
            onClick={props.onForceEndShift}
          >
            Force end shift
          </WBtn>
        )}
      </div>
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────────────
// Trips body — one TripCard per dispatch leg in the shift
// ─────────────────────────────────────────────────────────────────────────

function TripsBody({
  trips,
  isLive,
  focusedTripIndex,
  onFocusTrip,
}: {
  trips: TripInfo[];
  isLive: boolean;
  focusedTripIndex: number | null;
  onFocusTrip: (next: number | null) => void;
}) {
  if (trips.length === 0) {
    return (
      <div
        className="px-4 py-6 text-center text-[12px]"
        style={{ color: 'var(--text-tertiary)' }}
      >
        {isLive
          ? 'Driver is on shift but no loads are dispatched right now.'
          : 'No loads were dispatched during this shift.'}
      </div>
    );
  }
  return (
    <div>
      {trips.map((trip, i) => (
        <TripCard
          key={trip.legId}
          trip={trip}
          index={i}
          tone={toneForTrip(trip, i)}
          // Auto-expand the active leg in live mode so dispatchers see the
          // most-relevant card without an extra click. Past mode keeps
          // everything collapsed by default to avoid scroll bloat.
          defaultOpen={isLive && trip.status === 'ACTIVE'}
          focused={focusedTripIndex === i}
          dimmed={focusedTripIndex != null && focusedTripIndex !== i}
          onToggleFocus={() =>
            onFocusTrip(focusedTripIndex === i ? null : i)
          }
        />
      ))}
    </div>
  );
}

function TripCard({
  trip,
  index,
  tone,
  defaultOpen,
  focused,
  dimmed,
  onToggleFocus,
}: {
  trip: TripInfo;
  index: number;
  tone: string;
  defaultOpen: boolean;
  focused: boolean;
  dimmed: boolean;
  onToggleFocus: () => void;
}) {
  const [open, setOpen] = React.useState(defaultOpen);
  return (
    <div
      style={{
        borderBottom: '1px solid var(--border-hairline)',
        background: focused ? 'rgba(46,92,255,0.06)' : 'transparent',
        opacity: dimmed ? 0.6 : 1,
        transition: 'opacity .12s, background .12s',
      }}
    >
      {/* Header — clickable area (expand) + dedicated focus button */}
      <div className="flex items-center pr-2">
        <button
          type="button"
          onClick={() => setOpen((o) => !o)}
          className="focus-ring flex flex-1 items-center gap-[10px] px-4 py-3 text-left"
          style={{
            background: 'transparent',
            border: 'none',
            cursor: 'pointer',
            fontFamily: 'inherit',
          }}
        >
          <WIcon
            name="chevron-right"
            size={12}
            color="var(--text-tertiary)"
            style={{
              transform: open ? 'rotate(90deg)' : 'rotate(0)',
              transition: 'transform .12s',
            }}
          />
          <span
            className="h-2 w-2 shrink-0 rounded-sm"
            style={{ background: tone }}
          />
          <div className="min-w-0 flex-1">
          <div
            className="flex items-center gap-2 text-[12.5px] font-semibold"
            style={{ color: 'var(--text-primary)' }}
          >
            Trip {index + 1}
            <TripStatusChip status={trip.status} />
          </div>
          <div
            className="mt-0.5 truncate text-[11px]"
            style={{ color: 'var(--text-tertiary)' }}
          >
            #{trip.loadInternalId}
            {trip.startedAt && (
              <>
                <span className="mx-1">·</span>
                Started {formatHHMM(trip.startedAt)}
                {trip.endedAt && (
                  <>
                    <span style={{ margin: '0 4px', opacity: 0.55 }}>→</span>
                    {formatHHMM(trip.endedAt)}
                  </>
                )}
              </>
            )}
            {!trip.startedAt && trip.plannedStartAt && (
              <>
                <span className="mx-1">·</span>
                Scheduled {formatHHMM(trip.plannedStartAt)}
              </>
            )}
          </div>
        </div>
        </button>
        {/* Focus pin — isolates this trip's polyline on the map. Click
            again (or click another trip's pin) to clear. Sits OUTSIDE
            the header button so taps don't accidentally also toggle the
            expand/collapse. */}
        <button
          type="button"
          onClick={onToggleFocus}
          title={
            focused
              ? `Showing all trips · click to clear`
              : `Show only Trip ${index + 1} on the map`
          }
          aria-pressed={focused}
          aria-label={
            focused
              ? `Clear map focus`
              : `Focus map on Trip ${index + 1}`
          }
          className="focus-ring flex h-7 w-7 shrink-0 items-center justify-center rounded-md"
          style={{
            background: focused ? tone : 'transparent',
            color: focused ? '#FFFFFF' : 'var(--text-tertiary)',
            border:
              '1px solid ' +
              (focused ? tone : 'var(--border-hairline)'),
            cursor: 'pointer',
            fontFamily: 'inherit',
            transition: 'background .12s, color .12s, border-color .12s',
          }}
        >
          <WIcon name="pin" size={12} />
        </button>
      </div>

      {/* Expanded body — stop labels */}
      {open && (
        <div className="px-4 pb-3 pl-[42px]">
          {trip.startStop && (
            <TripStopRow kind="pickup" stop={trip.startStop} />
          )}
          {trip.endStop && (
            <TripStopRow kind="delivery" stop={trip.endStop} />
          )}
        </div>
      )}
    </div>
  );
}

function TripStopRow({
  kind,
  stop,
}: {
  kind: 'pickup' | 'delivery';
  stop: NonNullable<TripInfo['startStop']>;
}) {
  const label =
    kind === 'pickup'
      ? stop.type === 'PICKUP'
        ? 'Pickup'
        : stop.type === 'DELIVERY'
          ? 'Drop'
          : 'Detour'
      : stop.type === 'DELIVERY'
        ? 'Drop'
        : stop.type === 'PICKUP'
          ? 'Pickup'
          : 'Detour';
  const cityState = [stop.city, stop.state].filter(Boolean).join(', ');
  return (
    <div className="flex items-baseline gap-2 py-1 text-[11.5px]">
      <span
        className="shrink-0 text-[10.5px] uppercase tracking-[0.4px]"
        style={{ color: 'var(--text-tertiary)' }}
      >
        {label}
      </span>
      <span
        className="min-w-0 flex-1 truncate"
        style={{ color: 'var(--text-secondary)' }}
      >
        {stop.referenceName ?? cityState ?? 'Unnamed stop'}
        {stop.referenceName && cityState && (
          <span
            className="ml-1"
            style={{ color: 'var(--text-tertiary)' }}
          >
            · {cityState}
          </span>
        )}
      </span>
    </div>
  );
}

function TripStatusChip({ status }: { status: TripLegStatus }) {
  switch (status) {
    case 'ACTIVE':
      return <Chip status="active" label="Active" />;
    case 'COMPLETED':
      return <Chip status="delivered" label="Completed" />;
    case 'CANCELED':
      return <Chip status="cancelled" label="Canceled" />;
    case 'PENDING':
    default:
      return <Chip status="pending" label="Pending" />;
  }
}

// ─────────────────────────────────────────────────────────────────────────
// GPS pings list — newest first
// ─────────────────────────────────────────────────────────────────────────

function PingsList({
  pings,
  loading,
  onHover,
}: {
  pings: RecentPing[];
  loading: boolean;
  onHover?: (p: RecentPing | null) => void;
}) {
  if (loading) {
    return (
      <div
        className="px-4 py-6 text-center text-[12px]"
        style={{ color: 'var(--text-tertiary)' }}
      >
        Loading pings…
      </div>
    );
  }
  if (pings.length === 0) {
    return (
      <div
        className="px-4 py-6 text-center text-[12px]"
        style={{ color: 'var(--text-tertiary)' }}
      >
        No GPS pings recorded yet.
      </div>
    );
  }
  return (
    <div>
      <div
        className="flex items-center justify-between px-4 pb-[6px] pt-[10px] text-[10.5px] font-medium uppercase tracking-[0.4px]"
        style={{ color: 'var(--text-tertiary)' }}
      >
        <span>GPS pings ({pings.length})</span>
        <span className="font-normal normal-case tracking-normal">newest first</span>
      </div>
      {pings.map((p) => (
        <PingRow key={p.id} ping={p} onHover={onHover} />
      ))}
    </div>
  );
}

function PingRow({
  ping,
  onHover,
}: {
  ping: RecentPing;
  onHover?: (p: RecentPing | null) => void;
}) {
  const stopped = ping.speed === 0;
  const speedColor = stopped
    ? '#9BA3B4'
    : ping.speed >= 50
      ? '#2E5CFF'
      : ping.speed >= 25
        ? '#22B07D'
        : '#F59E0B';
  const date = new Date(ping.recordedAt);
  const hhmm = `${String(date.getHours()).padStart(2, '0')}:${String(date.getMinutes()).padStart(2, '0')}`;
  const ss = String(date.getSeconds()).padStart(2, '0');

  return (
    <div
      onMouseEnter={() => onHover?.(ping)}
      onMouseLeave={() => onHover?.(null)}
      className="flex items-center gap-[10px] px-4 py-2 text-[12px]"
      style={{
        borderBottom: '1px solid var(--border-hairline)',
        cursor: onHover ? 'default' : 'default',
      }}
    >
      <span
        className="h-2 w-2 shrink-0 rounded-full"
        style={{ background: '#2E5CFF' }}
      />
      <span
        className="num shrink-0 text-[11.5px]"
        style={{ color: 'var(--text-secondary)', minWidth: 56 }}
      >
        {hhmm}
        <span style={{ color: 'var(--text-tertiary)' }}>:{ss}</span>
      </span>
      <span
        className="min-w-0 flex-1 truncate text-[12px]"
        style={{ color: 'var(--text-primary)' }}
      >
        {formatCoord(ping.latitude, ping.longitude)}
      </span>
      <span
        className="num shrink-0 rounded text-[10.5px] font-semibold"
        style={{
          color: speedColor,
          background: `${speedColor}15`,
          padding: '2px 7px',
          minWidth: 54,
          textAlign: 'center',
        }}
      >
        {stopped ? 'Stopped' : `${Math.round(ping.speed)} mph`}
      </span>
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────────────
// Tab strip + summary stat + live dot
// ─────────────────────────────────────────────────────────────────────────

function PanelTab({
  label,
  count,
  active,
  onClick,
}: {
  label: string;
  count: number;
  active: boolean;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className="focus-ring relative inline-flex h-9 items-center gap-[6px] px-[10px] text-[12.5px]"
      style={{
        background: 'transparent',
        border: 'none',
        cursor: 'pointer',
        fontFamily: 'inherit',
        fontWeight: active ? 500 : 400,
        color: active ? 'var(--text-primary)' : 'var(--text-secondary)',
      }}
    >
      {label}
      <span
        className="num rounded-lg border px-[6px] py-px text-[10.5px] font-medium"
        style={{
          color: 'var(--text-tertiary)',
          background: 'var(--bg-canvas)',
          borderColor: 'var(--border-hairline)',
        }}
      >
        {count}
      </span>
      <span
        className="absolute bottom-px left-1 right-1 h-[2px] rounded"
        style={{ background: active ? 'var(--accent)' : 'transparent' }}
      />
    </button>
  );
}

function SummaryStat({
  label,
  value,
  sub,
  tone,
}: {
  label: string;
  value: React.ReactNode;
  sub?: string;
  tone?: 'warn' | 'danger';
}) {
  return (
    <div className="min-w-0 flex-1">
      <div
        className="text-[10.5px] font-medium uppercase tracking-[0.4px]"
        style={{ color: 'var(--text-tertiary)' }}
      >
        {label}
      </div>
      <div
        className="num mt-px text-[17px] font-semibold"
        style={{
          color:
            tone === 'warn'
              ? '#A66800'
              : tone === 'danger'
                ? '#B43030'
                : 'var(--text-primary)',
        }}
      >
        {value}
      </div>
      {sub && (
        <div
          className="mt-px text-[10.5px]"
          style={{ color: 'var(--text-tertiary)' }}
        >
          {sub}
        </div>
      )}
    </div>
  );
}

function CompletedDot() {
  return (
    <span
      className="inline-flex h-[14px] w-[14px] items-center justify-center rounded-full"
      style={{
        background: 'var(--bg-canvas)',
        border: '1px solid var(--border-hairline-strong)',
        color: 'var(--text-secondary)',
      }}
    >
      <WIcon name="check" size={9} />
    </span>
  );
}

function LiveDot({ tone }: { tone: string }) {
  return (
    <span
      className="relative inline-block"
      style={{ width: 8, height: 8 }}
    >
      <span
        className="absolute"
        style={{
          inset: 0,
          borderRadius: '50%',
          background: tone,
          opacity: 0.35,
          animation: 'sessionPulse 2.2s ease-out infinite',
        }}
      />
      <span
        className="absolute"
        style={{
          inset: 1,
          borderRadius: '50%',
          background: tone,
        }}
      />
    </span>
  );
}

// ─────────────────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────────────────

function formatHHMM(ms: number): string {
  const d = new Date(ms);
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
}

function formatDuration(ms: number): string {
  if (!Number.isFinite(ms) || ms < 0) return '—';
  const totalMin = Math.floor(ms / 60_000);
  const h = Math.floor(totalMin / 60);
  const m = totalMin % 60;
  return `${h}h ${String(m).padStart(2, '0')}m`;
}

function formatCoord(lat: number, lng: number): string {
  return `${lat.toFixed(4)}, ${lng.toFixed(4)}`;
}

/** Compute distance between consecutive pings (newest-first input) via
 *  Haversine. Returns null when fewer than 2 pings. */
function computeDistanceKm(pings: RecentPing[]): number | null {
  if (pings.length < 2) return null;
  // Reverse to chronological order before summing
  const chrono = [...pings].reverse();
  let km = 0;
  for (let i = 1; i < chrono.length; i++) {
    km += haversineKm(
      chrono[i - 1].latitude,
      chrono[i - 1].longitude,
      chrono[i].latitude,
      chrono[i].longitude
    );
  }
  return km;
}

/** Sum gaps between consecutive pings where the speed was below
 *  the "driving" threshold (5 mph). Returns null when no pings. */
function computeIdleMs(pings: RecentPing[]): number | null {
  if (pings.length < 2) return null;
  const chrono = [...pings].reverse();
  let idleMs = 0;
  for (let i = 1; i < chrono.length; i++) {
    const prev = chrono[i - 1];
    const curr = chrono[i];
    if (prev.speed < 5) idleMs += curr.recordedAt - prev.recordedAt;
  }
  return idleMs;
}

function haversineKm(
  lat1: number,
  lon1: number,
  lat2: number,
  lon2: number
): number {
  const R = 6371;
  const toRad = (d: number) => (d * Math.PI) / 180;
  const dLat = toRad(lat2 - lat1);
  const dLon = toRad(lon2 - lon1);
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLon / 2) ** 2;
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}
