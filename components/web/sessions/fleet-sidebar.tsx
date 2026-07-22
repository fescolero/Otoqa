/**
 * FleetSidebar — left rail for the Active Sessions live ops page.
 *
 * Mirrors the `FleetSidebar` from `web/screens/sessions-fleet.jsx`:
 *   • Search input (60+ drivers expected; design tunes for 50–500)
 *   • Status filter chips (All / Driving / On break / Idle / Off-duty)
 *   • "Exceptions only" toggle — narrows to drivers with incidents or idle
 *   • Status-grouped accordion of compact driver rows (avatar, status dot,
 *     name, truck unit, status line, alert badge)
 *   • Footer count "Showing X of Y · 14:23 now"
 */

'use client';

import * as React from 'react';
import { WIcon } from '@/components/web';
import {
  STATUS_TONE,
  avatarColorForId,
  initialsForName,
  type DerivedStatus,
  type LiveSessionRow,
  type PastSessionRow,
} from './types';

interface LiveSidebarProps {
  mode: 'live';
  sessions: LiveSessionRow[];
  totalCount: number;
  counts: Record<DerivedStatus | 'all' | 'alerts', number>;

  search: string;
  onSearch: (v: string) => void;

  statusFilter: DerivedStatus | 'all';
  onStatusFilter: (v: DerivedStatus | 'all') => void;

  exceptionsOnly: boolean;
  onExceptionsOnly: (v: boolean) => void;

  selectedId: string | null;
  onSelect: (id: string) => void;

  nowLabel: string;
}

interface PastSidebarProps {
  mode: 'past';
  sessions: PastSessionRow[];
  totalCount: number;

  search: string;
  onSearch: (v: string) => void;

  selectedId: string | null;
  onSelect: (id: string) => void;

  /** "Mon, May 19" — shown in the footer instead of "14:23 now" */
  dateLabel: string;
}

type Props = LiveSidebarProps | PastSidebarProps;

export function FleetSidebar(props: Props) {
  if (props.mode === 'live') return <LiveFleetSidebar {...props} />;
  return <PastFleetSidebar {...props} />;
}

function LiveFleetSidebar({
  sessions,
  totalCount,
  counts,
  search,
  onSearch,
  statusFilter,
  onStatusFilter,
  exceptionsOnly,
  onExceptionsOnly,
  selectedId,
  onSelect,
  nowLabel,
}: LiveSidebarProps) {
  const driving = sessions.filter((s) => s.status === 'driving');
  const idle = sessions.filter((s) => s.status === 'idle');
  const onBreak = sessions.filter((s) => s.status === 'break');
  const offDuty = sessions.filter((s) => s.status === 'off-duty');

  return (
    <aside
      className="flex h-full w-[340px] shrink-0 flex-col min-w-0"
      style={{
        background: 'var(--bg-surface)',
        borderRight: '1px solid var(--border-hairline)',
      }}
    >
      {/* Search */}
      <div
        className="shrink-0 px-3 pb-2 pt-3"
        style={{ borderBottom: '1px solid var(--border-hairline)' }}
      >
        <div className="relative">
          <span
            className="pointer-events-none absolute left-[9px] top-1/2 -translate-y-1/2 flex items-center"
            style={{ color: 'var(--text-tertiary)' }}
          >
            <WIcon name="search" size={13} />
          </span>
          <input
            value={search}
            onChange={(e) => onSearch(e.target.value)}
            placeholder={`Search ${totalCount} ${totalCount === 1 ? 'driver' : 'drivers'}, trucks, locations…`}
            className="focus-ring h-8 w-full rounded-md text-[12.5px] outline-none"
            style={{
              padding: '0 10px 0 28px',
              background: 'var(--bg-canvas)',
              border: '1px solid var(--border-hairline)',
              color: 'var(--text-primary)',
              fontFamily: 'inherit',
            }}
          />
        </div>
      </div>

      {/* Filter chips */}
      <div
        className="shrink-0 flex flex-wrap gap-1 px-3 py-2"
        style={{ borderBottom: '1px solid var(--border-hairline)' }}
      >
        <FleetFilterChip
          label="All"
          count={counts.all}
          active={statusFilter === 'all'}
          onClick={() => onStatusFilter('all')}
        />
        <FleetFilterChip
          label="Driving"
          count={counts.driving}
          tone={STATUS_TONE.driving.color}
          active={statusFilter === 'driving'}
          onClick={() => onStatusFilter('driving')}
        />
        <FleetFilterChip
          label="On break"
          count={counts.break}
          tone={STATUS_TONE.break.color}
          active={statusFilter === 'break'}
          onClick={() => onStatusFilter('break')}
        />
        <FleetFilterChip
          label="Idle"
          count={counts.idle}
          tone={STATUS_TONE.idle.color}
          active={statusFilter === 'idle'}
          onClick={() => onStatusFilter('idle')}
        />
        <FleetFilterChip
          label="Off-duty"
          count={counts['off-duty']}
          tone={STATUS_TONE['off-duty'].color}
          active={statusFilter === 'off-duty'}
          onClick={() => onStatusFilter('off-duty')}
        />
      </div>

      {/* Exceptions toggle */}
      <div
        className="shrink-0 flex items-center justify-between px-[14px] py-2"
        style={{ borderBottom: '1px solid var(--border-hairline)' }}
      >
        <div className="flex items-center gap-2">
          <WIcon
            name="alert"
            size={13}
            color={exceptionsOnly ? '#A66800' : 'var(--text-tertiary)'}
          />
          <span
            className="text-[12px] font-medium"
            style={{
              color: exceptionsOnly
                ? 'var(--text-primary)'
                : 'var(--text-secondary)',
            }}
          >
            Exceptions only
          </span>
          <span
            className="text-[11px] num"
            style={{ color: 'var(--text-tertiary)' }}
          >
            · {counts.alerts + counts.idle} drivers
          </span>
        </div>
        <Switch on={exceptionsOnly} onChange={onExceptionsOnly} />
      </div>

      {/* Driver list — grouped accordion */}
      <div className="min-h-0 flex-1 overflow-auto">
        {sessions.length === 0 && (
          <div
            className="px-4 py-6 text-center text-[12px]"
            style={{ color: 'var(--text-tertiary)' }}
          >
            No drivers match these filters.
          </div>
        )}
        <StatusGroup
          label="Driving"
          tone={STATUS_TONE.driving.color}
          drivers={driving}
          defaultOpen
          selectedId={selectedId}
          onSelect={onSelect}
        />
        <StatusGroup
          label="Idle"
          tone={STATUS_TONE.idle.color}
          drivers={idle}
          defaultOpen
          selectedId={selectedId}
          onSelect={onSelect}
        />
        <StatusGroup
          label="On break"
          tone={STATUS_TONE.break.color}
          drivers={onBreak}
          selectedId={selectedId}
          onSelect={onSelect}
        />
        <StatusGroup
          label="Off-duty"
          tone={STATUS_TONE['off-duty'].color}
          drivers={offDuty}
          selectedId={selectedId}
          onSelect={onSelect}
        />
      </div>

      {/* Footer count */}
      <div
        className="shrink-0 flex justify-between px-4 py-2 text-[11px]"
        style={{
          borderTop: '1px solid var(--border-hairline)',
          color: 'var(--text-tertiary)',
        }}
      >
        <span>
          Showing{' '}
          <b style={{ color: 'var(--text-secondary)' }}>{sessions.length}</b>{' '}
          of {totalCount}
        </span>
        <span className="num">{nowLabel}</span>
      </div>
    </aside>
  );
}

// ─────────────────────────────────────────────────────────────────────────
// Filter chip — pill button, fills when active
// ─────────────────────────────────────────────────────────────────────────

function FleetFilterChip({
  label,
  count,
  tone,
  active,
  onClick,
}: {
  label: string;
  count: number;
  tone?: string;
  active: boolean;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className="focus-ring inline-flex items-center gap-[5px] rounded-full px-2 py-[3px] text-[11px] font-medium transition-all"
      style={{
        border: '1px solid ' + (active ? 'var(--text-primary)' : 'var(--border-hairline)'),
        background: active ? 'var(--text-primary)' : 'transparent',
        color: active ? 'var(--bg-surface)' : 'var(--text-secondary)',
        fontFamily: 'inherit',
      }}
    >
      {tone && !active && (
        <span
          className="inline-block h-[6px] w-[6px] rounded-full"
          style={{ background: tone }}
        />
      )}
      <span>{label}</span>
      <span
        className="num text-[10.5px]"
        style={{ opacity: active ? 0.85 : 0.7 }}
      >
        {count}
      </span>
    </button>
  );
}

// ─────────────────────────────────────────────────────────────────────────
// Toggle switch — same dimensions as the design (30×17)
// ─────────────────────────────────────────────────────────────────────────

function Switch({
  on,
  onChange,
}: {
  on: boolean;
  onChange: (v: boolean) => void;
}) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={on}
      onClick={() => onChange(!on)}
      className="focus-ring relative"
      style={{
        width: 30,
        height: 17,
        borderRadius: 99,
        border: 'none',
        cursor: 'pointer',
        background: on ? 'var(--accent)' : 'var(--border-hairline-strong)',
        transition: 'background .12s',
        padding: 0,
        fontFamily: 'inherit',
      }}
    >
      <span
        className="absolute"
        style={{
          top: 2,
          left: on ? 15 : 2,
          width: 13,
          height: 13,
          borderRadius: '50%',
          background: '#FFFFFF',
          transition: 'left .14s cubic-bezier(0.22, 1, 0.36, 1)',
          boxShadow: '0 1px 3px rgba(0,0,0,0.2)',
        }}
      />
    </button>
  );
}

// ─────────────────────────────────────────────────────────────────────────
// StatusGroup — sticky header row + collapsible body of driver rows
// ─────────────────────────────────────────────────────────────────────────

function StatusGroup({
  label,
  tone,
  drivers,
  defaultOpen,
  selectedId,
  onSelect,
}: {
  label: string;
  tone: string;
  drivers: LiveSessionRow[];
  defaultOpen?: boolean;
  selectedId: string | null;
  onSelect: (id: string) => void;
}) {
  const [open, setOpen] = React.useState(defaultOpen ?? false);
  if (drivers.length === 0) return null;

  return (
    <div>
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        className="focus-ring sticky top-0 z-[1] flex w-full items-center gap-2 px-[14px] py-2 text-left"
        style={{
          border: 'none',
          background: 'var(--bg-surface)',
          borderTop: '1px solid var(--border-hairline)',
          borderBottom: '1px solid var(--border-hairline)',
          cursor: 'pointer',
          fontFamily: 'inherit',
        }}
        onMouseEnter={(e) =>
          (e.currentTarget.style.background = 'var(--bg-row-hover)')
        }
        onMouseLeave={(e) =>
          (e.currentTarget.style.background = 'var(--bg-surface)')
        }
      >
        <WIcon
          name="chevron-down"
          size={12}
          color="var(--text-tertiary)"
          style={{
            transform: open ? 'rotate(0deg)' : 'rotate(-90deg)',
            transition: 'transform .12s',
          }}
        />
        <span
          className="shrink-0 h-2 w-2 rounded-full"
          style={{ background: tone }}
        />
        <span
          className="flex-1 text-[11px] font-semibold uppercase tracking-[0.4px]"
          style={{ color: 'var(--text-primary)' }}
        >
          {label}
        </span>
        <span
          className="num text-[11px]"
          style={{ color: 'var(--text-tertiary)' }}
        >
          {drivers.length}
        </span>
      </button>
      {open && (
        <div>
          {drivers.map((s) => (
            <DriverListRow
              key={s.sessionId}
              session={s}
              selected={s.sessionId === selectedId}
              onClick={() => onSelect(s.sessionId)}
            />
          ))}
        </div>
      )}
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────────────
// DriverListRow — dense driver row with avatar + status dot + alert badge
// ─────────────────────────────────────────────────────────────────────────

function DriverListRow({
  session,
  selected,
  onClick,
}: {
  session: LiveSessionRow;
  selected: boolean;
  onClick: () => void;
}) {
  const tone = STATUS_TONE[session.status].color;
  const avatarColor = avatarColorForId(session.driverId);
  const initials = initialsForName(session.driverName);

  return (
    <button
      type="button"
      onClick={onClick}
      className="focus-ring flex w-full items-center gap-[10px] text-left"
      style={{
        padding: '8px 14px 8px 12px',
        background: selected ? 'rgba(46,92,255,0.06)' : 'transparent',
        border: 'none',
        borderLeft: `3px solid ${selected ? 'var(--accent)' : 'transparent'}`,
        borderBottom: '1px solid var(--border-hairline)',
        cursor: 'pointer',
        fontFamily: 'inherit',
      }}
      onMouseEnter={(e) => {
        if (!selected)
          e.currentTarget.style.background = 'var(--bg-row-hover)';
      }}
      onMouseLeave={(e) => {
        if (!selected) e.currentTarget.style.background = 'transparent';
      }}
    >
      {/* Avatar with status dot */}
      <div
        className="relative shrink-0"
        style={{ width: 26, height: 26 }}
      >
        <div
          className="flex h-[26px] w-[26px] items-center justify-center rounded-full text-[10.5px] font-semibold text-white"
          style={{
            background: avatarColor,
            opacity: session.status === 'off-duty' ? 0.6 : 1,
          }}
        >
          {initials}
        </div>
        <span
          className="absolute"
          style={{
            right: -1,
            bottom: -1,
            width: 9,
            height: 9,
            borderRadius: '50%',
            background: tone,
            border: '2px solid var(--bg-surface)',
          }}
        />
      </div>

      {/* Name + status line */}
      <div className="min-w-0 flex-1">
        <div className="flex items-baseline gap-1.5">
          <span
            className="min-w-0 flex-1 truncate text-[12.5px] font-medium"
            style={{ color: 'var(--text-primary)' }}
          >
            {session.driverName}
          </span>
          {session.truckUnitId && (
            <span
              className="num shrink-0 text-[10.5px]"
              style={{ color: 'var(--text-tertiary)' }}
            >
              #{session.truckUnitId}
            </span>
          )}
        </div>
        <div
          className="mt-px truncate text-[11px]"
          style={{ color: 'var(--text-tertiary)' }}
        >
          {session.statusLoc}
        </div>
      </div>

      {/* Alert badge */}
      {session.incidents > 0 && (
        <span
          className="num shrink-0 rounded-full px-[6px] py-[2px] text-[10px] font-semibold"
          style={{
            background: 'rgba(239,68,68,0.12)',
            color: '#B43030',
          }}
        >
          {session.incidents}
        </span>
      )}
    </button>
  );
}

// ═════════════════════════════════════════════════════════════════════════
// PAST-DAY SIDEBAR — no filter chips, no live freshness, just a simple
// search + scroll list of completed shifts with bookend times + distance.
// ═════════════════════════════════════════════════════════════════════════

function PastFleetSidebar({
  sessions,
  totalCount,
  search,
  onSearch,
  selectedId,
  onSelect,
  dateLabel,
}: PastSidebarProps) {
  return (
    <aside
      className="flex h-full w-[340px] shrink-0 flex-col min-w-0"
      style={{
        background: 'var(--bg-surface)',
        borderRight: '1px solid var(--border-hairline)',
      }}
    >
      {/* Search */}
      <div
        className="shrink-0 px-3 pb-2 pt-3"
        style={{ borderBottom: '1px solid var(--border-hairline)' }}
      >
        <div className="relative">
          <span
            className="pointer-events-none absolute left-[9px] top-1/2 -translate-y-1/2 flex items-center"
            style={{ color: 'var(--text-tertiary)' }}
          >
            <WIcon name="search" size={13} />
          </span>
          <input
            value={search}
            onChange={(e) => onSearch(e.target.value)}
            placeholder={`Search ${totalCount} ${totalCount === 1 ? 'shift' : 'shifts'}…`}
            className="focus-ring h-8 w-full rounded-md text-[12.5px] outline-none"
            style={{
              padding: '0 10px 0 28px',
              background: 'var(--bg-canvas)',
              border: '1px solid var(--border-hairline)',
              color: 'var(--text-primary)',
              fontFamily: 'inherit',
            }}
          />
        </div>
      </div>

      {/* Section label — date + count */}
      <div
        className="shrink-0 flex items-center justify-between px-4 pb-[6px] pt-2 text-[10.5px] font-medium uppercase tracking-[0.4px]"
        style={{
          color: 'var(--text-tertiary)',
          borderBottom: '1px solid var(--border-hairline)',
        }}
      >
        <span>
          {sessions.length} {sessions.length === 1 ? 'shift' : 'shifts'}
        </span>
        <span style={{ fontWeight: 400 }}>{dateLabel}</span>
      </div>

      {/* Driver list */}
      <div className="min-h-0 flex-1 overflow-auto">
        {sessions.length === 0 ? (
          <div
            className="px-4 py-6 text-center text-[12px]"
            style={{ color: 'var(--text-tertiary)' }}
          >
            No shifts recorded on this day.
          </div>
        ) : (
          sessions.map((s) => (
            <PastDriverRow
              key={s.sessionId}
              session={s}
              selected={s.sessionId === selectedId}
              onClick={() => onSelect(s.sessionId)}
            />
          ))
        )}
      </div>
    </aside>
  );
}

function PastDriverRow({
  session,
  selected,
  onClick,
}: {
  session: PastSessionRow;
  selected: boolean;
  onClick: () => void;
}) {
  const avatarColor = avatarColorForId(session.driverId);
  const initials = initialsForName(session.driverName);
  const hhmm = (ms: number | null) =>
    ms
      ? `${String(new Date(ms).getHours()).padStart(2, '0')}:${String(new Date(ms).getMinutes()).padStart(2, '0')}`
      : '—';
  return (
    <button
      type="button"
      onClick={onClick}
      className="focus-ring block w-full text-left"
      style={{
        padding: '12px 16px',
        background: selected ? 'rgba(46,92,255,0.06)' : 'transparent',
        border: 'none',
        borderLeft: `3px solid ${selected ? 'var(--accent)' : 'transparent'}`,
        borderBottom: '1px solid var(--border-hairline)',
        cursor: 'pointer',
        fontFamily: 'inherit',
      }}
      onMouseEnter={(e) => {
        if (!selected)
          e.currentTarget.style.background = 'var(--bg-row-hover)';
      }}
      onMouseLeave={(e) => {
        if (!selected) e.currentTarget.style.background = 'transparent';
      }}
    >
      <div className="flex items-center gap-[10px]">
        <div
          className="flex h-[30px] w-[30px] shrink-0 items-center justify-center rounded-full text-[12px] font-semibold text-white"
          style={{ background: avatarColor, opacity: 0.85 }}
        >
          {initials}
        </div>
        <div className="min-w-0 flex-1">
          <div
            className="truncate text-[13px] font-semibold"
            style={{ color: 'var(--text-primary)' }}
          >
            {session.driverName}
          </div>
          <div
            className="truncate text-[11px]"
            style={{ color: 'var(--text-tertiary)' }}
          >
            {[session.truckMakeModel, session.truckUnitId && `#${session.truckUnitId}`]
              .filter(Boolean)
              .join(' · ') || 'No truck info'}
          </div>
        </div>
        <span
          className="flex h-[18px] w-[18px] shrink-0 items-center justify-center rounded-full"
          style={{
            background: 'var(--bg-canvas)',
            border: '1px solid var(--border-hairline-strong)',
            color: 'var(--text-secondary)',
          }}
        >
          <WIcon name="check" size={11} />
        </span>
      </div>
      <div
        className="mt-2 flex items-center gap-2 text-[11px]"
        style={{ color: 'var(--text-secondary)' }}
      >
        <span className="num font-medium">
          {hhmm(session.startedAt)}
          <span style={{ color: 'var(--text-tertiary)', margin: '0 4px' }}>→</span>
          {hhmm(session.endedAt)}
        </span>
        <span style={{ color: 'var(--text-tertiary)' }}>·</span>
        <span className="num">
          {session.trips.length}{' '}
          {session.trips.length === 1 ? 'trip' : 'trips'}
        </span>
        {session.incidents > 0 && (
          <>
            <span style={{ color: 'var(--text-tertiary)' }}>·</span>
            <span
              className="num font-medium"
              style={{ color: '#A66800' }}
            >
              {session.incidents}{' '}
              {session.incidents === 1 ? 'alert' : 'alerts'}
            </span>
          </>
        )}
      </div>
    </button>
  );
}
