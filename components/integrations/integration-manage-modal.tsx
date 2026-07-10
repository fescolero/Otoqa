'use client';

/**
 * IntegrationManageModal — diagnostics surface for a connected integration.
 *
 * Four tabs:
 *   1. Overview      — what's flowing right now + recent issues + rate limit
 *   2. Sync rules    — toggle / direction / frequency derived from real
 *                      `syncSettings` (loadsEnabled, gpsTrackingEnabled,
 *                      driverAssignmentsEnabled, intervalMinutes)
 *   3. Credentials   — account meta from real `createdBy`/`createdAt`/
 *                      `hasCredentials`, plus placeholder rows for OAuth /
 *                      webhook details we don't store yet
 *   4. Activity log  — derived from real `lastSyncStats.lastSyncTime` +
 *                      `lastSyncStatus` + `errorMessage` + `recordsProcessed`
 *
 * What's REAL (driven by Convex `orgIntegrations`):
 *   - Health status (success → Healthy, partial → Degraded, failed → Error)
 *   - Connected at / Connected by (Convex `createdAt` / `createdBy`)
 *   - Last sync time + status + records processed + error message
 *   - Sync setting toggles (loads / GPS / driver assignments) + interval
 *   - hasCredentials boolean
 *   - Test connection — runs 5 real checks against the Convex row
 *   - Disconnect — calls `api.integrations.deleteIntegration`
 *
 * What's still PLACEHOLDER (no backend yet — clearly marked "—" or "Not
 * tracked yet" in the UI):
 *   - Uptime %, API calls/24h, rate limit headroom
 *   - OAuth tokens / token expiry / granted scopes
 *   - Webhook URL + secret
 *   - Per-resource 24h volume counts
 *
 * Rotate / Pause / Reauthorize / Save changes are no-op until the backend
 * grows the corresponding mutations.
 */

import * as React from 'react';
import { useMutation, useAction, useQuery } from 'convex/react';
import { api } from '@/convex/_generated/api';
import { Avatar, Kbd, WBtn, WIcon, type IconName } from '@/components/web';
import {
  TINT_PALETTE,
  type IntegrationCatalogEntry,
} from '@/lib/integrations-catalog';
import { Loader2 } from 'lucide-react';

// ─── connection types ───────────────────────────────────────────────────

/**
 * Shape of one row from `api.integrations.getIntegrations`. We re-declare
 * it locally to avoid importing Convex types into a client-only file and
 * to drop fields the modal doesn't use.
 */
export interface OrgIntegrationConnection {
  _id: string;
  _creationTime: number;
  workosOrgId: string;
  provider: string;
  hasCredentials?: boolean;
  syncSettings: {
    isEnabled: boolean;
    pull?: {
      loadsEnabled: boolean;
      intervalMinutes: number;
      lookbackWindowHours: number;
    };
    push?: {
      gpsTrackingEnabled: boolean;
      driverAssignmentsEnabled: boolean;
    };
  };
  lastSyncStats: {
    lastSyncTime?: number;
    lastSyncStatus?: string;
    recordsProcessed?: number;
    errorMessage?: string;
  };
  createdBy: string;
  createdAt: number;
  updatedAt: number;
}

/** UI preset — fields backed by real Convex data, plus placeholders. */
interface ConnectionPreset {
  // ── REAL when connected ──
  health: 'healthy' | 'degraded' | 'error';
  lastSync: string;
  lastSyncStatus?: string;
  recordsProcessed?: number;
  errorMessage?: string;
  isEnabled: boolean;
  connectedAt: string;
  connectedBy: string;
  hasCredentials: boolean;
  intervalMinutes?: number;
  // ── PLACEHOLDER (backend doesn't store these yet) ──
  uptime: string | null;
  calls24h: string | null;
  errorRate: string | null;
  errors24h: number | null;
  rateLimit: { used: number; total: number; window: string } | null;
  tokenExpiry: string | null;
  webhookUrl: string | null;
  webhookSecret: string | null;
  accountId: string | null;
  region: string | null;
  plan: string | null;
}

function formatRelative(ts: number | undefined): string {
  if (!ts) return 'Never';
  const diffMs = Date.now() - ts;
  if (diffMs < 0) return 'Just now';
  const sec = Math.floor(diffMs / 1000);
  if (sec < 60) return `${sec}s ago`;
  const min = Math.floor(sec / 60);
  if (min < 60) return `${min}m ago`;
  const hr = Math.floor(min / 60);
  if (hr < 24) return `${hr}h ago`;
  const day = Math.floor(hr / 24);
  if (day < 30) return `${day}d ago`;
  return new Date(ts).toLocaleDateString();
}

function formatDateTime(ts: number | undefined): string {
  if (!ts) return '—';
  return new Date(ts).toLocaleString(undefined, {
    month: 'short',
    day: 'numeric',
    year: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
  });
}

/** Build the preset from a real Convex connection row. */
function derivePreset(connection: OrgIntegrationConnection | null): ConnectionPreset {
  if (!connection) {
    // Preview mode — no connection, blank everything
    return {
      health: 'healthy',
      lastSync: 'Not connected',
      isEnabled: false,
      connectedAt: '—',
      connectedBy: '—',
      hasCredentials: false,
      uptime: null,
      calls24h: null,
      errorRate: null,
      errors24h: null,
      rateLimit: null,
      tokenExpiry: null,
      webhookUrl: null,
      webhookSecret: null,
      accountId: null,
      region: null,
      plan: null,
    };
  }

  const status = connection.lastSyncStats.lastSyncStatus;
  const health: 'healthy' | 'degraded' | 'error' =
    status === 'failed' ? 'error' : status === 'partial' ? 'degraded' : 'healthy';

  return {
    health,
    lastSync: formatRelative(connection.lastSyncStats.lastSyncTime),
    lastSyncStatus: status,
    recordsProcessed: connection.lastSyncStats.recordsProcessed,
    errorMessage: connection.lastSyncStats.errorMessage,
    isEnabled: connection.syncSettings.isEnabled,
    connectedAt: formatDateTime(connection.createdAt),
    connectedBy: connection.createdBy,
    hasCredentials: !!connection.hasCredentials,
    intervalMinutes: connection.syncSettings.pull?.intervalMinutes,
    // Placeholders — backend doesn't track these yet
    uptime: null,
    calls24h: null,
    errorRate: null,
    errors24h: null,
    rateLimit: null,
    tokenExpiry: null,
    webhookUrl: null,
    webhookSecret: null,
    accountId: connection._id,
    region: null,
    plan: null,
  };
}

/** Derive the Sync rules list from the real `syncSettings`. */
interface Resource {
  id: string;
  name: string;
  direction: 'pull' | 'push';
  freq: string;
  last: string;
  count: string;
  enabled: boolean;
  scope: string;
}

function deriveResources(connection: OrgIntegrationConnection | null): Resource[] {
  if (!connection) return [];
  const out: Resource[] = [];
  const { syncSettings, lastSyncStats } = connection;
  const lastSync = formatRelative(lastSyncStats.lastSyncTime);
  const recordsLabel = lastSyncStats.recordsProcessed != null
    ? `${lastSyncStats.recordsProcessed.toLocaleString()} records`
    : '—';

  if (syncSettings.pull) {
    const intervalLabel = `every ${syncSettings.pull.intervalMinutes} min`;
    out.push({
      id: 'pull-loads',
      name: 'Load imports',
      direction: 'pull',
      freq: intervalLabel,
      last: syncSettings.pull.loadsEnabled ? lastSync : 'Disabled',
      count: syncSettings.pull.loadsEnabled ? recordsLabel : '—',
      enabled: syncSettings.pull.loadsEnabled,
      scope: `${syncSettings.pull.lookbackWindowHours}h lookback window`,
    });
  }
  if (syncSettings.push) {
    out.push({
      id: 'push-gps',
      name: 'GPS tracking',
      direction: 'push',
      freq: 'continuous',
      last: syncSettings.push.gpsTrackingEnabled ? lastSync : 'Disabled',
      count: syncSettings.push.gpsTrackingEnabled ? recordsLabel : '—',
      enabled: syncSettings.push.gpsTrackingEnabled,
      scope: 'Active trucks',
    });
    out.push({
      id: 'push-assignments',
      name: 'Driver assignments',
      direction: 'push',
      freq: 'on save',
      last: syncSettings.push.driverAssignmentsEnabled ? lastSync : 'Disabled',
      count: syncSettings.push.driverAssignmentsEnabled ? recordsLabel : '—',
      enabled: syncSettings.push.driverAssignmentsEnabled,
      scope: 'Newly assigned loads',
    });
  }
  return out;
}

/** Build a single activity-log entry from the most recent sync stats. */
function deriveLogEntries(connection: OrgIntegrationConnection | null): LogEntry[] {
  if (!connection || !connection.lastSyncStats.lastSyncTime) return [];
  const stats = connection.lastSyncStats;
  const ts = stats.lastSyncTime!;
  const d = new Date(ts);
  const t = d.toTimeString().slice(0, 8);
  const isToday =
    d.toDateString() === new Date().toDateString();
  const date: 'Today' | 'Yesterday' = isToday ? 'Today' : 'Yesterday';

  const level: 'success' | 'warn' | 'error' =
    stats.lastSyncStatus === 'failed'
      ? 'error'
      : stats.lastSyncStatus === 'partial'
        ? 'warn'
        : 'success';
  const recordsLabel = stats.recordsProcessed != null
    ? `${stats.recordsProcessed.toLocaleString()} records`
    : 'records';
  const message =
    level === 'error'
      ? `Last sync failed — ${stats.errorMessage ?? 'see error message'}`
      : level === 'warn'
        ? `Partial sync (${recordsLabel})`
        : `Synced ${recordsLabel}`;

  return [
    {
      t,
      date,
      level,
      message,
      resource: 'sync',
      duration: '—',
      code: level === 'error' ? 500 : 200,
      detail: stats.errorMessage,
    },
  ];
}

interface LogEntry {
  t: string;
  date: 'Today' | 'Yesterday';
  level: 'success' | 'warn' | 'error';
  message: string;
  resource: string;
  duration: string;
  code: number;
  detail?: string;
}

// ─── health + level tones ───────────────────────────────────────────────

const HEALTH_TONES = {
  healthy:  { dot: '#0F8C5F', bg: 'rgba(16,185,129,0.10)', fg: '#0F8C5F', label: 'Healthy' },
  degraded: { dot: '#A66800', bg: 'rgba(245,158,11,0.12)', fg: '#A66800', label: 'Degraded' },
  error:    { dot: '#B43030', bg: 'rgba(220,38,38,0.10)',  fg: '#B43030', label: 'Error' },
} as const;

const LEVEL_TONES = {
  success: { fg: '#0F8C5F', bg: 'rgba(16,185,129,0.10)', label: 'OK',    icon: 'check' as IconName },
  warn:    { fg: '#A66800', bg: 'rgba(245,158,11,0.12)', label: 'Warn',  icon: 'alert' as IconName },
  error:   { fg: '#B43030', bg: 'rgba(220,38,38,0.10)',  label: 'Error', icon: 'alert' as IconName },
};

// ─── primitives ─────────────────────────────────────────────────────────

function ModalCard({
  title,
  action,
  children,
  padded = true,
  danger,
}: {
  title?: React.ReactNode;
  action?: React.ReactNode;
  children: React.ReactNode;
  padded?: boolean;
  danger?: boolean;
}) {
  return (
    <div
      className="rounded-[10px] overflow-hidden"
      style={{
        background: 'var(--bg-surface)',
        border: '1px solid ' + (danger ? 'rgba(220,38,38,0.30)' : 'var(--border-hairline)'),
      }}
    >
      {(title || action) && (
        <div
          className="flex items-center justify-between px-3.5 py-2.5"
          style={{
            borderBottom: '1px solid var(--border-hairline)',
            background: danger ? 'rgba(220,38,38,0.04)' : 'var(--bg-surface-2)',
          }}
        >
          <div
            className="text-[12px] font-semibold tracking-[0.02em]"
            style={{ color: danger ? '#B43030' : 'var(--text-primary)' }}
          >
            {title}
          </div>
          {action}
        </div>
      )}
      <div style={{ padding: padded ? '12px 14px' : 0 }}>{children}</div>
    </div>
  );
}

function HealthStat({
  label,
  value,
  sub,
  tone,
  sparkline,
}: {
  label: string;
  value: React.ReactNode;
  sub?: React.ReactNode;
  tone?: 'good' | 'warn' | 'bad';
  sparkline?: React.ReactNode;
}) {
  const valueColor =
    tone === 'good' ? '#0F8C5F' : tone === 'warn' ? '#A66800' : tone === 'bad' ? '#B43030' : 'var(--text-primary)';
  return (
    <div
      className="min-w-0 px-4 py-3.5"
      style={{ borderRight: '1px solid var(--border-hairline)' }}
    >
      <div className="tw-label text-[10px] mb-1">{label}</div>
      <div className="flex items-baseline gap-1">
        <span
          className="num"
          style={{
            fontSize: 22,
            fontWeight: 700,
            letterSpacing: -0.015,
            lineHeight: '26px',
            color: valueColor,
          }}
        >
          {value}
        </span>
      </div>
      {sub && <div className="text-[11px] text-[var(--text-tertiary)] mt-0.5">{sub}</div>}
      {sparkline}
    </div>
  );
}

/** 24-bar deterministic sparkline (no flicker on re-render). */
function UptimeSparkline() {
  const bars = React.useMemo(() => {
    const out: Array<{ h: number; color: string }> = [];
    for (let i = 0; i < 48; i++) {
      const r = (Math.sin(i * 12.9898) * 43758.5453) % 1;
      const v = Math.abs(r);
      let color = 'rgba(16,185,129,0.55)';
      let h = 8 + Math.round(v * 6);
      if (i === 18) { color = 'rgba(245,158,11,0.8)'; h = 12; }
      if (i === 31) { color = 'rgba(220,38,38,0.8)'; h = 14; }
      if (i === 40) { color = 'rgba(245,158,11,0.8)'; h = 10; }
      out.push({ h, color });
    }
    return out;
  }, []);
  return (
    <div className="flex items-end gap-[2px] mt-2" style={{ height: 18 }}>
      {bars.map((b, i) => (
        <div key={i} style={{ width: 3, height: b.h, background: b.color, borderRadius: 1 }} />
      ))}
    </div>
  );
}

function KV({
  label,
  value,
  mono,
  action,
}: {
  label: React.ReactNode;
  value: React.ReactNode;
  mono?: boolean;
  action?: React.ReactNode;
}) {
  return (
    <div
      className="grid items-center py-1.5"
      style={{
        gridTemplateColumns: '140px 1fr auto',
        columnGap: 12,
        borderTop: '1px solid var(--border-hairline)',
      }}
    >
      <span className="text-[12px] text-[var(--text-tertiary)]">{label}</span>
      <span
        className={'text-[12.5px] font-medium text-foreground min-w-0 truncate ' + (mono ? 'num' : '')}
      >
        {value}
      </span>
      {action && <span style={{ justifySelf: 'end' }}>{action}</span>}
    </div>
  );
}

function InlineLink({
  children,
  danger,
  onClick,
}: {
  children: React.ReactNode;
  danger?: boolean;
  onClick?: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className="focus-ring inline-flex items-center gap-1 bg-transparent border-0 cursor-pointer rounded-[5px] px-1.5 py-0.5 font-sans text-[11.5px] font-medium"
      style={{ color: danger ? '#B43030' : 'var(--accent)' }}
    >
      {children}
    </button>
  );
}

function MonoTile({
  mono,
  tint,
  size = 44,
}: {
  mono: string;
  tint: keyof typeof TINT_PALETTE;
  size?: number;
}) {
  const t = TINT_PALETTE[tint] || TINT_PALETTE.slate;
  const len = mono.length;
  const fs = len >= 3 ? 13 : len === 2 ? 15 : 17;
  return (
    <div
      className="inline-flex items-center justify-center rounded-lg shrink-0 font-bold"
      style={{
        width: size,
        height: size,
        background: t.bg,
        color: t.fg,
        border: '1px solid var(--border-hairline)',
        fontSize: fs,
        letterSpacing: -0.02,
      }}
    >
      {mono}
    </div>
  );
}

// ─── Test connection ────────────────────────────────────────────────────
//
// Steps reflect what we ACTUALLY know about a connection from `orgIntegrations`.
// Each check is synchronous against the Convex row — no fake outcomes. The
// 200ms cadence is purely visual so the user can follow which step ran.

const TEST_PLAN = [
  { id: 'auth',     label: 'Credentials stored',      hint: 'orgIntegrations.credentials' },
  { id: 'enabled',  label: 'Sync enabled',            hint: 'syncSettings.isEnabled' },
  { id: 'recent',   label: 'Recent successful sync',  hint: 'lastSyncStats.lastSyncTime < 24h' },
  { id: 'status',   label: 'Last sync status',        hint: 'lastSyncStats.lastSyncStatus' },
  { id: 'errors',   label: 'No active errors',        hint: 'lastSyncStats.errorMessage' },
];

type TestOutcome = { ok: true | false | 'warn'; latency: string; note: string };

function computeRealOutcomes(connection: OrgIntegrationConnection | null): Record<string, TestOutcome> {
  if (!connection) {
    const note = 'No connection — preview only';
    return {
      auth:    { ok: false, latency: '—', note },
      enabled: { ok: false, latency: '—', note },
      recent:  { ok: false, latency: '—', note },
      status:  { ok: false, latency: '—', note },
      errors:  { ok: false, latency: '—', note },
    };
  }
  const stats = connection.lastSyncStats;
  const now = Date.now();
  const within24h = stats.lastSyncTime != null && now - stats.lastSyncTime < 24 * 60 * 60 * 1000;

  return {
    auth: connection.hasCredentials
      ? { ok: true, latency: '—', note: 'Credentials attached to this integration' }
      : { ok: false, latency: '—', note: 'No credentials on record' },
    enabled: connection.syncSettings.isEnabled
      ? { ok: true, latency: '—', note: 'Sync is enabled' }
      : { ok: 'warn', latency: '—', note: 'Sync is paused — toggle in syncSettings to resume' },
    recent: stats.lastSyncTime
      ? within24h
        ? { ok: true, latency: '—', note: `Last sync ${formatRelative(stats.lastSyncTime)}` }
        : { ok: 'warn', latency: '—', note: `Last sync ${formatRelative(stats.lastSyncTime)} — older than 24h` }
      : { ok: 'warn', latency: '—', note: 'No sync recorded yet' },
    status: stats.lastSyncStatus
      ? stats.lastSyncStatus === 'success'
        ? { ok: true, latency: '—', note: 'Last run completed successfully' }
        : stats.lastSyncStatus === 'partial'
          ? { ok: 'warn', latency: '—', note: 'Last run completed with warnings' }
          : { ok: false, latency: '—', note: 'Last run failed' }
      : { ok: 'warn', latency: '—', note: 'Unknown — no sync has run' },
    errors: stats.errorMessage
      ? { ok: false, latency: '—', note: stats.errorMessage }
      : { ok: true, latency: '—', note: 'No active errors' },
  };
}

type TestCheckStatus = 'pending' | 'running' | 'pass' | 'warn' | 'fail';
interface TestCheck {
  id: string;
  label: string;
  hint: string;
  status: TestCheckStatus;
  latency?: string;
  note?: string;
}

function TestResultsPanel({
  state,
  onClose,
  onRetest,
}: {
  state: { checks: TestCheck[]; complete: boolean } | null;
  onClose: () => void;
  onRetest: () => void;
}) {
  if (!state) return null;
  const done = state.complete;
  const counts = state.checks.reduce(
    (m, c) => {
      if (c.status === 'pass') m.pass++;
      else if (c.status === 'warn') m.warn++;
      else if (c.status === 'fail') m.fail++;
      return m;
    },
    { pass: 0, warn: 0, fail: 0 },
  );
  const totalMs = state.checks.reduce((s, c) => {
    const m = c.latency && c.latency.endsWith('ms') ? parseInt(c.latency) : 0;
    return s + m;
  }, 0);

  let headerTone: { bg: string; fg: string };
  let headerLabel: string;
  let headerSub: string;
  if (!done) {
    headerTone = { bg: 'rgba(46,92,255,0.10)', fg: 'var(--accent)' };
    const running = state.checks.find((c) => c.status === 'running');
    headerLabel = 'Running connection test…';
    headerSub = running ? running.label : 'Initializing…';
  } else if (counts.fail > 0) {
    headerTone = { bg: 'rgba(220,38,38,0.08)', fg: '#B43030' };
    headerLabel = `Connection test failed · ${counts.fail} of 5 checks`;
    headerSub = `${counts.pass} passed · ${counts.warn} warnings · ${counts.fail} failed · ${totalMs}ms total`;
  } else if (counts.warn > 0) {
    headerTone = { bg: 'rgba(245,158,11,0.10)', fg: '#A66800' };
    headerLabel = 'Connection healthy — with warnings';
    headerSub = `${counts.pass} passed · ${counts.warn} warnings · ${totalMs}ms total`;
  } else {
    headerTone = { bg: 'rgba(16,185,129,0.10)', fg: '#0F8C5F' };
    headerLabel = 'All connection checks passed';
    headerSub = `${counts.pass}/5 healthy · ${totalMs}ms total · No issues found`;
  }

  return (
    <div
      className="overflow-hidden rounded-[10px] mb-3.5"
      style={{
        background: 'var(--bg-surface)',
        border: '1px solid var(--border-hairline)',
        borderLeft: `3px solid ${headerTone.fg}`,
      }}
    >
      <div
        className="flex items-center justify-between px-3.5 py-2.5"
        style={{ background: headerTone.bg }}
      >
        <div className="flex items-center gap-2.5 min-w-0">
          {!done ? (
            <Loader2
              className="animate-spin shrink-0"
              size={14}
              style={{ color: headerTone.fg }}
            />
          ) : (
            <span
              className="inline-flex items-center justify-center rounded-full shrink-0"
              style={{
                width: 18,
                height: 18,
                background: headerTone.fg,
                color: '#fff',
              }}
            >
              <WIcon
                name={counts.fail > 0 ? 'close' : counts.warn > 0 ? 'alert' : 'check'}
                size={11}
              />
            </span>
          )}
          <div className="min-w-0">
            <div
              className="text-[13px] font-semibold"
              style={{ color: headerTone.fg, letterSpacing: 0.005 }}
            >
              {headerLabel}
            </div>
            <div className="text-[11.5px] text-[var(--text-tertiary)] mt-px">{headerSub}</div>
          </div>
        </div>
        <div className="flex items-center gap-1.5 shrink-0">
          {done && <InlineLink onClick={onRetest}>↻ Re-test</InlineLink>}
          <button
            type="button"
            onClick={onClose}
            className="focus-ring inline-flex items-center justify-center bg-transparent border-0 cursor-pointer rounded-[5px]"
            style={{ width: 22, height: 22, color: 'var(--text-tertiary)' }}
          >
            <WIcon name="close" size={11} />
          </button>
        </div>
      </div>
      <div>
        {state.checks.map((c, i) => {
          const isPending = c.status === 'pending';
          const isRunning = c.status === 'running';
          const isPass = c.status === 'pass';
          const isWarn = c.status === 'warn';
          const isFail = c.status === 'fail';
          const fg = isPass ? '#0F8C5F' : isWarn ? '#A66800' : isFail ? '#B43030' : 'var(--text-tertiary)';
          return (
            <div
              key={c.id}
              className="grid items-center gap-2.5 px-3.5 py-2"
              style={{
                gridTemplateColumns: '20px 180px 1fr 80px',
                borderTop: i === 0 ? 'none' : '1px solid var(--border-hairline)',
                opacity: isPending ? 0.45 : 1,
                transition: 'opacity 200ms var(--ease-out)',
              }}
            >
              {isPending && (
                <span
                  className="inline-block rounded-full"
                  style={{ width: 8, height: 8, background: 'var(--border-hairline-strong)' }}
                />
              )}
              {isRunning && (
                <Loader2 size={12} className="animate-spin" style={{ color: 'var(--accent)' }} />
              )}
              {(isPass || isWarn || isFail) && (
                <span
                  className="inline-flex items-center justify-center rounded-full"
                  style={{
                    width: 14,
                    height: 14,
                    background: isPass ? 'rgba(16,185,129,0.14)' : isWarn ? 'rgba(245,158,11,0.16)' : 'rgba(220,38,38,0.14)',
                    color: fg,
                  }}
                >
                  <WIcon name={isPass ? 'check' : 'alert'} size={9} />
                </span>
              )}
              <div className="flex flex-col min-w-0">
                <span
                  className="text-[12.5px] font-semibold"
                  style={{ color: isPending ? 'var(--text-tertiary)' : 'var(--text-primary)' }}
                >
                  {c.label}
                </span>
                <span className="num text-[10.5px] text-[var(--text-tertiary)]">{c.hint}</span>
              </div>
              <div
                className="text-[12px] min-w-0 truncate"
                style={{ color: fg }}
              >
                {isPending && '—'}
                {isRunning && 'Running…'}
                {(isPass || isWarn || isFail) && c.note}
              </div>
              <span
                className="num text-[11.5px] text-[var(--text-tertiary)] text-right"
              >
                {(isPass || isWarn || isFail) ? c.latency : ''}
              </span>
            </div>
          );
        })}
      </div>
    </div>
  );
}

// ─── Log row ────────────────────────────────────────────────────────────

function LogRow({ entry, compact }: { entry: LogEntry; compact?: boolean }) {
  const [open, setOpen] = React.useState(false);
  const tone = LEVEL_TONES[entry.level];
  const hasDetail = !!entry.detail;
  return (
    <div style={{ borderTop: '1px solid var(--border-hairline)' }}>
      <button
        type="button"
        onClick={() => hasDetail && setOpen((o) => !o)}
        className="focus-ring w-full grid items-center gap-2.5 bg-transparent border-0 font-sans text-left"
        style={{
          gridTemplateColumns: compact
            ? '20px 90px 1fr 60px'
            : '20px 110px 1fr 110px 60px 16px',
          padding: compact ? '8px 14px' : '10px 14px',
          cursor: hasDetail ? 'pointer' : 'default',
        }}
        onMouseEnter={(e) => {
          if (hasDetail) e.currentTarget.style.background = 'var(--bg-row-hover)';
        }}
        onMouseLeave={(e) => {
          e.currentTarget.style.background = 'transparent';
        }}
      >
        <span
          className="inline-flex items-center justify-center rounded-full shrink-0"
          style={{ width: 14, height: 14, background: tone.bg, color: tone.fg }}
        >
          <WIcon name={tone.icon} size={9} />
        </span>
        <span className="num text-[11.5px] text-[var(--text-tertiary)]">
          {entry.date === 'Today' ? entry.t : `${entry.date} ${entry.t}`}
        </span>
        <span className="text-[12.5px] text-foreground truncate min-w-0">{entry.message}</span>
        {!compact && (
          <span className="inline-flex items-center text-[var(--text-tertiary)] uppercase font-semibold" style={{ letterSpacing: 0.04, fontSize: 11 }}>
            <span
              className="num"
              style={{
                padding: '1px 6px',
                borderRadius: 4,
                background: 'var(--bg-surface-2)',
                border: '1px solid var(--border-hairline)',
                fontFamily: 'var(--font-mono)',
                fontSize: 10,
              }}
            >
              {entry.resource}
            </span>
          </span>
        )}
        {!compact && (
          <span className="num text-[11.5px] text-[var(--text-tertiary)] text-right">{entry.duration}</span>
        )}
        {!compact &&
          (hasDetail ? (
            <WIcon
              name="chevron-down"
              size={11}
              color="var(--text-tertiary)"
              style={{
                transform: open ? 'rotate(180deg)' : 'rotate(0)',
                transition: 'transform var(--dur-fast) var(--ease-out)',
              }}
            />
          ) : (
            <span />
          ))}
      </button>
      {open && hasDetail && (
        <div
          className="text-[12px] leading-[17px]"
          style={{
            padding: '10px 14px 12px 44px',
            background: 'var(--bg-surface-2)',
            borderTop: '1px solid var(--border-hairline)',
            color: 'var(--text-secondary)',
          }}
        >
          <div className="mb-1.5">{entry.detail}</div>
          <div
            className="num"
            style={{
              fontFamily: 'var(--font-mono)',
              fontSize: 11,
              padding: '8px 10px',
              background: 'var(--bg-surface)',
              border: '1px solid var(--border-hairline)',
              borderRadius: 6,
              color: 'var(--text-secondary)',
            }}
          >
            HTTP {entry.code} · request_id=req_8s4k{Math.abs((entry.t.charCodeAt(0) * 991) % 99999)}
          </div>
        </div>
      )}
    </div>
  );
}

// ─── Tabs ───────────────────────────────────────────────────────────────

function TabOverview({
  preset,
  resources,
  logEntries,
  onTab,
  rec,
  workosOrgId,
}: {
  preset: ConnectionPreset;
  resources: Resource[];
  logEntries: LogEntry[];
  onTab: (id: string) => void;
  rec: IntegrationCatalogEntry;
  workosOrgId: string | null;
}) {
  const enabled = resources.filter((r) => r.enabled);
  const recent = logEntries.filter((l) => l.level !== 'success').slice(0, 3);

  return (
    <div className="flex flex-col gap-3.5">
      <ModalCard
        padded={false}
        title="Data flowing right now"
        action={<InlineLink onClick={() => onTab('rules')}>Open sync rules →</InlineLink>}
      >
        <div className="grid" style={{ gridTemplateColumns: 'repeat(4, minmax(0, 1fr))' }}>
          {enabled.slice(0, 4).map((r, i) => (
            <div
              key={r.id}
              className="px-3.5 py-3"
              style={{
                borderRight: i === 3 ? 'none' : '1px solid var(--border-hairline)',
              }}
            >
              <div className="flex items-center gap-1.5 mb-1">
                <span
                  className="inline-flex items-center uppercase font-bold"
                  style={{
                    height: 15,
                    padding: '0 5px',
                    borderRadius: 7,
                    background:
                      r.direction === 'pull'
                        ? 'rgba(46,92,255,0.10)'
                        : 'rgba(124,58,237,0.10)',
                    color: r.direction === 'pull' ? '#1A47E6' : '#7C3AED',
                    fontSize: 9.5,
                    letterSpacing: 0.06,
                  }}
                >
                  {r.direction === 'pull' ? '↓ PULL' : '↑ PUSH'}
                </span>
              </div>
              <div className="text-[13px] font-semibold mb-0.5">{r.name}</div>
              <div className="num text-[11.5px] text-[var(--text-tertiary)]">
                {r.count} · {r.last}
              </div>
            </div>
          ))}
        </div>
      </ModalCard>

      <ModalCard
        title="Recent issues (last sync)"
        action={<InlineLink onClick={() => onTab('logs')}>View activity log →</InlineLink>}
        padded={false}
      >
        {recent.length === 0 ? (
          <div className="text-center text-[12px] text-[var(--text-tertiary)] py-4">
            No issues. Everything is syncing cleanly.
          </div>
        ) : (
          recent.map((l, i) => <LogRow key={i} entry={l} compact />)
        )}
      </ModalCard>

      <div className="grid gap-3.5" style={{ gridTemplateColumns: '1fr 1fr' }}>
        <ModalCard title="API rate limit">
          <div className="flex items-baseline gap-1.5 mb-2">
            <span className="num text-[18px] font-bold text-[var(--text-tertiary)]">—</span>
          </div>
          <div
            className="overflow-hidden rounded"
            style={{ height: 6, background: 'var(--bg-surface-2)' }}
          />
          <div className="text-[11.5px] text-[var(--text-tertiary)] mt-2">
            Not tracked yet — rate-limit telemetry coming with the next backend update.
          </div>
        </ModalCard>

        <ModalCard title="Connection">
          <KV label="Provider" value={preset.connectedAt === '—' ? '—' : 'Live'} />
          <KV
            label="Connected"
            value={
              preset.connectedAt === '—'
                ? '—'
                : `${preset.connectedAt}`
            }
          />
          <KV label="Connected by" value={preset.connectedBy} mono />
          <KV
            label="Last sync"
            value={preset.lastSync}
            action={
              preset.lastSyncStatus ? (
                <span
                  className="text-[11px] font-semibold uppercase tracking-wide"
                  style={{
                    color:
                      preset.lastSyncStatus === 'success'
                        ? '#0F8C5F'
                        : preset.lastSyncStatus === 'failed'
                          ? '#B43030'
                          : '#A66800',
                  }}
                >
                  {preset.lastSyncStatus}
                </span>
              ) : undefined
            }
          />
        </ModalCard>
      </div>

      {rec.id === 'samsara' && workosOrgId && preset.connectedAt !== '—' && (
        <SamsaraFleetMappingCard workosOrgId={workosOrgId} />
      )}
    </div>
  );
}

// ─── Samsara-specific: one-click VIN-based truck mapping ────────────────

function SamsaraFleetMappingCard({ workosOrgId }: { workosOrgId: string }) {
  const autoMap = useAction(api.samsaraVehicleMapping.autoMapSamsaraTrucksByVin);
  // Reactive DB-only read — no Samsara API hit. Refreshes automatically when
  // a Map Fleet run writes new samsaraVehicleId values onto trucks.
  const currentMappings = useQuery(
    api.samsaraVehicleMappingMutations.listSamsaraMappedTrucks,
    { workosOrgId },
  );
  const [isMapping, setIsMapping] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);
  const [result, setResult] = React.useState<{
    matched: number;
    matchedByVin: number;
    matchedByName: number;
    alreadyMapped: number;
    ambiguousCount: number;
    unmatchedCount: number;
    skippedCollisions: number;
    matchedDetails: Array<{
      truckId: string;
      unitId: string;
      otoqaVin: string;
      samsaraVehicleId: string;
      samsaraName: string;
      samsaraVin?: string;
      strategy: 'VIN' | 'NAME';
    }>;
    ambiguous: Array<{
      key: string;
      keyKind: 'VIN' | 'NAME';
      samsaraVehicleIds: string[];
      otoqaTruckIds: string[];
    }>;
    unmatched: Array<{ truckId: string; unitId: string; vin: string }>;
  } | null>(null);

  const handleClick = async () => {
    setError(null);
    setIsMapping(true);
    try {
      const res = await autoMap({ workosOrgId });
      setResult(res);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to map fleet.');
    } finally {
      setIsMapping(false);
    }
  };

  return (
    <ModalCard
      title="Fleet mapping"
      action={
        <button
          type="button"
          onClick={handleClick}
          disabled={isMapping}
          className="text-[11.5px] font-semibold tracking-[0.02em]"
          style={{
            color: isMapping ? 'var(--text-tertiary)' : '#1A47E6',
            background: 'transparent',
            border: 'none',
            cursor: isMapping ? 'wait' : 'pointer',
          }}
        >
          {isMapping ? (
            <span className="inline-flex items-center gap-1.5">
              <Loader2 size={12} className="animate-spin" />
              Mapping…
            </span>
          ) : (
            'Map fleet by VIN →'
          )}
        </button>
      }
    >
      <div className="text-[12px] text-[var(--text-secondary)] mb-2">
        Match each Otoqa truck to its Samsara vehicle by VIN, falling back
        to Samsara vehicle name ↔ Otoqa unit ID when VINs aren't populated.
        Trucks already mapped are left alone. Safe to run multiple times.
      </div>

      {/* Always-on read-only view — no Samsara API call. */}
      {currentMappings !== undefined && currentMappings.length > 0 && (
        <details className="mb-2">
          <summary className="text-[11.5px] font-semibold cursor-pointer mb-1.5">
            Current mappings ({currentMappings.length})
          </summary>
          <SamsaraMatchTable
            rows={currentMappings.map((m) => ({
              truckId: m.truckId,
              unitId: m.unitId,
              otoqaVin: m.otoqaVin,
              samsaraVehicleId: m.samsaraVehicleId,
            }))}
            showStrategy={false}
          />
          <div className="text-[10.5px] text-[var(--text-tertiary)] mt-1.5">
            Samsara names + VINs aren't shown here — they'd require an API
            call. Click <span className="font-semibold">Map fleet by VIN</span>{' '}
            above to pull the full details.
          </div>
        </details>
      )}
      {currentMappings !== undefined && currentMappings.length === 0 && (
        <div className="text-[11.5px] text-[var(--text-tertiary)] mb-2 italic">
          No trucks mapped yet. Click Map fleet by VIN to begin.
        </div>
      )}

      {error && (
        <div
          className="rounded p-2 mt-2 text-[11.5px]"
          style={{
            background: 'rgba(220,38,38,0.06)',
            border: '1px solid rgba(220,38,38,0.20)',
            color: '#B43030',
          }}
        >
          {error}
        </div>
      )}

      {result && !error && (
        <div className="mt-2 flex flex-col gap-2">
          <div className="grid gap-2" style={{ gridTemplateColumns: 'repeat(4, 1fr)' }}>
            <SamsaraMapStat label="Newly matched" value={result.matched} tone="success" />
            <SamsaraMapStat label="Already mapped" value={result.alreadyMapped} tone="neutral" />
            <SamsaraMapStat
              label="Ambiguous"
              value={result.ambiguousCount}
              tone={result.ambiguousCount > 0 ? 'warn' : 'neutral'}
            />
            <SamsaraMapStat
              label="No match"
              value={result.unmatchedCount}
              tone={result.unmatchedCount > 0 ? 'warn' : 'neutral'}
            />
          </div>

          {result.matched > 0 && (result.matchedByVin > 0 || result.matchedByName > 0) && (
            <div className="text-[11.5px] text-[var(--text-tertiary)]">
              Matched by VIN: <span className="font-semibold text-[var(--text-secondary)]">{result.matchedByVin}</span>
              {'  ·  '}
              By name fallback: <span className="font-semibold text-[var(--text-secondary)]">{result.matchedByName}</span>
            </div>
          )}

          {result.matchedDetails.length > 0 && (
            <details open className="mt-1">
              <summary className="text-[11.5px] font-semibold cursor-pointer mb-1.5">
                Review mappings ({result.matchedDetails.length})
              </summary>
              <SamsaraMatchTable rows={result.matchedDetails} showStrategy />
            </details>
          )}

          {result.skippedCollisions > 0 && (
            <div
              className="text-[11.5px] rounded p-2"
              style={{
                background: 'rgba(166,104,0,0.06)',
                border: '1px solid rgba(166,104,0,0.20)',
                color: '#A66800',
              }}
            >
              {result.skippedCollisions} mapping{result.skippedCollisions === 1 ? '' : 's'}{' '}
              skipped because the Samsara vehicle was already claimed by another truck.
            </div>
          )}

          {result.ambiguous.length > 0 && (
            <details>
              <summary className="text-[11.5px] font-semibold cursor-pointer">
                Ambiguous matches ({result.ambiguous.length})
              </summary>
              <ul
                className="mt-1.5 text-[11.5px] font-mono text-[var(--text-secondary)]"
                style={{ listStyle: 'none', paddingLeft: 0 }}
              >
                {result.ambiguous.slice(0, 10).map((a) => (
                  <li key={`${a.keyKind}-${a.key}`} className="py-0.5">
                    [{a.keyKind}] {a.key} → {a.samsaraVehicleIds.length} Samsara,{' '}
                    {a.otoqaTruckIds.length} Otoqa
                  </li>
                ))}
              </ul>
            </details>
          )}

          {result.unmatched.length > 0 && (
            <details>
              <summary className="text-[11.5px] font-semibold cursor-pointer">
                Unmatched trucks ({result.unmatched.length})
              </summary>
              <ul
                className="mt-1.5 text-[11.5px] font-mono text-[var(--text-secondary)]"
                style={{ listStyle: 'none', paddingLeft: 0 }}
              >
                {result.unmatched.slice(0, 10).map((u) => (
                  <li key={u.truckId} className="py-0.5">
                    {u.unitId} · {u.vin || '<no VIN>'}
                  </li>
                ))}
              </ul>
            </details>
          )}
        </div>
      )}
    </ModalCard>
  );
}

function SamsaraMatchTable({
  rows,
  showStrategy,
}: {
  rows: Array<{
    truckId: string;
    unitId: string;
    otoqaVin: string;
    samsaraVehicleId: string;
    samsaraName?: string;
    samsaraVin?: string;
    strategy?: 'VIN' | 'NAME';
  }>;
  /** Show the strategy column. False in read-only "current mappings" view. */
  showStrategy: boolean;
}) {
  const MATCH_GRID = showStrategy
    ? '52px minmax(0, 1fr) minmax(0, 1fr)'
    : 'minmax(0, 1fr) minmax(0, 1fr)';
  return (
    <div
      className="rounded overflow-hidden"
      style={{
        border: '1px solid var(--border-hairline)',
        background: 'var(--bg-surface)',
      }}
    >
      <div
        className="grid text-[10.5px] uppercase tracking-wide font-semibold text-[var(--text-tertiary)]"
        style={{
          gridTemplateColumns: MATCH_GRID,
          background: 'var(--bg-surface-2)',
          borderBottom: '1px solid var(--border-hairline)',
        }}
      >
        {showStrategy && <div className="px-2 py-1.5">Via</div>}
        <div
          className="px-2 py-1.5"
          style={
            showStrategy
              ? { borderLeft: '1px solid var(--border-hairline)' }
              : undefined
          }
        >
          Otoqa truck
        </div>
        <div
          className="px-2 py-1.5"
          style={{ borderLeft: '1px solid var(--border-hairline)' }}
        >
          Samsara vehicle
        </div>
      </div>
      <div style={{ maxHeight: 280, overflowY: 'auto' }}>
        {rows.map((r, i) => (
          <div
            key={r.truckId}
            className="grid text-[11.5px]"
            style={{
              gridTemplateColumns: MATCH_GRID,
              borderBottom:
                i === rows.length - 1
                  ? 'none'
                  : '1px solid var(--border-hairline)',
            }}
          >
            {showStrategy && (
              <div className="px-2 py-1.5 flex items-center">
                {r.strategy && (
                  <span
                    className="inline-flex items-center uppercase font-bold"
                    style={{
                      height: 15,
                      padding: '0 5px',
                      borderRadius: 7,
                      background:
                        r.strategy === 'VIN'
                          ? 'rgba(15,140,95,0.10)'
                          : 'rgba(166,104,0,0.10)',
                      color: r.strategy === 'VIN' ? '#0F8C5F' : '#A66800',
                      fontSize: 9.5,
                      letterSpacing: 0.06,
                    }}
                  >
                    {r.strategy}
                  </span>
                )}
              </div>
            )}
            <div
              className="px-2 py-1.5"
              style={
                showStrategy
                  ? { borderLeft: '1px solid var(--border-hairline)' }
                  : undefined
              }
            >
              <div className="font-semibold">{r.unitId}</div>
              <div
                className="font-mono text-[10.5px] text-[var(--text-tertiary)] truncate"
                title={r.otoqaVin}
              >
                {r.otoqaVin || '—'}
              </div>
            </div>
            <div
              className="px-2 py-1.5"
              style={{ borderLeft: '1px solid var(--border-hairline)' }}
            >
              <div className="font-semibold">
                {r.samsaraName ?? `id: ${r.samsaraVehicleId}`}
              </div>
              {r.samsaraName && (
                <div
                  className="font-mono text-[10.5px] text-[var(--text-tertiary)] truncate"
                  title={r.samsaraVin || r.samsaraVehicleId}
                >
                  {r.samsaraVin ? r.samsaraVin : `id: ${r.samsaraVehicleId}`}
                </div>
              )}
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}

function SamsaraMapStat({
  label,
  value,
  tone,
}: {
  label: string;
  value: number;
  tone: 'success' | 'warn' | 'neutral';
}) {
  const color =
    tone === 'success' ? '#0F8C5F' : tone === 'warn' ? '#A66800' : 'var(--text-primary)';
  return (
    <div
      className="rounded p-2"
      style={{
        background: 'var(--bg-surface-2)',
        border: '1px solid var(--border-hairline)',
      }}
    >
      <div className="num text-[16px] font-bold" style={{ color }}>
        {value}
      </div>
      <div className="text-[10.5px] uppercase tracking-wide text-[var(--text-tertiary)] mt-0.5">
        {label}
      </div>
    </div>
  );
}

const SYNC_GRID = '52px minmax(0, 1.7fr) 96px 1fr 1fr 1fr 40px';

function TabSyncRules({ resources }: { resources: Resource[] }) {
  if (resources.length === 0) {
    return (
      <ModalCard title="Sync rules">
        <div className="text-center py-4 text-[12.5px] text-[var(--text-tertiary)]">
          No sync rules configured. Connect this integration to set up which resources to pull or push.
        </div>
      </ModalCard>
    );
  }
  return (
    <ModalCard
      title="Sync rules"
      padded={false}
    >
      <div
        className="grid"
        style={{
          gridTemplateColumns: SYNC_GRID,
          background: 'var(--bg-surface-2)',
          borderBottom: '1px solid var(--border-hairline)',
        }}
      >
        {['', 'Resource', 'Direction', 'Frequency', 'Last sync', 'Volume', ''].map(
          (h, i, arr) => (
            <div
              key={i}
              className="tw-label text-[10px]"
              style={{
                padding: '9px 14px',
                textAlign: i === arr.length - 1 ? 'right' : 'left',
              }}
            >
              {h}
            </div>
          ),
        )}
      </div>
      {resources.map((r) => (
        <div
          key={r.id}
          className="grid items-stretch"
          style={{
            gridTemplateColumns: SYNC_GRID,
            borderBottom: '1px solid var(--border-hairline)',
            opacity: r.enabled ? 1 : 0.55,
            minHeight: 56,
          }}
        >
          <div className="flex items-center px-3.5">
            <span
              className="inline-block relative rounded-full shrink-0"
              style={{
                width: 26,
                height: 14,
                background: r.enabled ? '#0F8C5F' : 'var(--border-hairline-strong)',
              }}
            >
              <span
                className="absolute rounded-full"
                style={{
                  top: 2,
                  left: r.enabled ? 14 : 2,
                  width: 10,
                  height: 10,
                  background: '#fff',
                  boxShadow: '0 1px 2px rgba(0,0,0,0.18)',
                  transition: 'left var(--dur-fast) var(--ease-out)',
                }}
              />
            </span>
          </div>
          <div className="flex flex-col justify-center px-3.5 py-2 min-w-0">
            <div className="text-[13px] font-semibold leading-[18px]">{r.name}</div>
            <div
              className="text-[11.5px] text-[var(--text-tertiary)] mt-px leading-[15px] truncate"
            >
              {r.scope}
            </div>
          </div>
          <div className="flex items-center px-3.5">
            <span
              className="inline-flex items-center uppercase font-bold"
              style={{
                height: 18,
                padding: '0 7px',
                borderRadius: 9,
                background:
                  r.direction === 'pull'
                    ? 'rgba(46,92,255,0.10)'
                    : 'rgba(124,58,237,0.10)',
                color: r.direction === 'pull' ? '#1A47E6' : '#7C3AED',
                fontSize: 10,
                letterSpacing: 0.04,
              }}
            >
              {r.direction === 'pull' ? '↓ Pull' : '↑ Push'}
            </span>
          </div>
          <div className="flex items-center px-3.5 text-[12.5px] text-[var(--text-secondary)]">
            {r.freq}
          </div>
          <div className="flex items-center px-3.5">
            <span className="num text-[12.5px] text-[var(--text-secondary)]">{r.last}</span>
          </div>
          <div className="flex items-center px-3.5">
            <span className="num text-[12.5px] font-semibold">{r.count}</span>
          </div>
          <div className="flex items-center justify-end px-3.5">
            <button
              type="button"
              className="focus-ring inline-flex items-center justify-center bg-transparent border-0 cursor-pointer rounded-[5px]"
              style={{
                width: 22,
                height: 22,
                color: 'var(--text-tertiary)',
              }}
            >
              <WIcon name="kebab-h" size={13} />
            </button>
          </div>
        </div>
      ))}
    </ModalCard>
  );
}

function TabCredentials({
  preset,
  isConnected,
  onTest,
  onDisconnect,
  isDisconnecting,
}: {
  preset: ConnectionPreset;
  isConnected: boolean;
  onTest: () => void;
  onDisconnect: () => void;
  isDisconnecting: boolean;
}) {
  return (
    <div className="flex flex-col gap-3.5">
      <ModalCard title="Account">
        <KV label="Convex record id" value={preset.accountId ?? '—'} mono />
        <KV
          label="Connected by"
          value={
            preset.connectedBy === '—' ? (
              <span className="text-[var(--text-tertiary)]">—</span>
            ) : (
              <span className="inline-flex items-center gap-1.5">
                <Avatar name={preset.connectedBy} size={18} />
                <span className="num">{preset.connectedBy}</span>
              </span>
            )
          }
        />
        <KV label="Connected at" value={preset.connectedAt} />
        <KV
          label="Credentials"
          value={
            preset.hasCredentials ? (
              <span className="inline-flex items-center gap-1.5">
                <span
                  className="inline-block rounded-full"
                  style={{ width: 6, height: 6, background: '#0F8C5F' }}
                />
                Stored
              </span>
            ) : (
              <span className="text-[var(--text-tertiary)]">Not stored</span>
            )
          }
        />
        <KV
          label="Sync enabled"
          value={
            isConnected ? (
              <span className="inline-flex items-center gap-1.5">
                <span
                  className="inline-block rounded-full"
                  style={{ width: 6, height: 6, background: preset.isEnabled ? '#0F8C5F' : '#A66800' }}
                />
                {preset.isEnabled ? 'Enabled' : 'Paused'}
              </span>
            ) : (
              <span className="text-[var(--text-tertiary)]">—</span>
            )
          }
        />
      </ModalCard>

      <ModalCard
        title="Authorization"
        action={
          <WBtn size="sm" leading="check" onClick={onTest}>
            Test connection
          </WBtn>
        }
      >
        <KV
          label="Method"
          value={
            <span className="text-[var(--text-tertiary)]">
              Stored as opaque credentials JSON
            </span>
          }
        />
        <KV
          label="Granted scopes"
          value={<span className="text-[var(--text-tertiary)]">Not tracked yet</span>}
        />
        <KV
          label="Access token"
          value={<span className="text-[var(--text-tertiary)]">Not exposed</span>}
        />
        <KV
          label="Token expires"
          value={<span className="text-[var(--text-tertiary)]">Not tracked yet</span>}
        />
      </ModalCard>

      <ModalCard title="Webhook endpoint">
        <KV
          label="URL"
          value={<span className="text-[var(--text-tertiary)]">Not configured</span>}
        />
        <KV
          label="Secret"
          value={<span className="text-[var(--text-tertiary)]">Not configured</span>}
        />
        <KV
          label="Events"
          value={<span className="text-[var(--text-tertiary)]">Webhook delivery coming soon</span>}
        />
      </ModalCard>

      <ModalCard danger title="Danger zone">
        <div className="grid items-center gap-2.5 py-1.5" style={{ gridTemplateColumns: '1fr auto' }}>
          <div>
            <div className="text-[13px] font-semibold">Pause syncing</div>
            <div className="text-[11.5px] text-[var(--text-tertiary)] mt-px">
              Stops all pulls and pushes. Credentials stay attached.
            </div>
          </div>
          <WBtn size="sm">Pause</WBtn>
        </div>
        <div
          className="grid items-center gap-2.5 py-2"
          style={{
            gridTemplateColumns: '1fr auto',
            borderTop: '1px solid var(--border-hairline)',
          }}
        >
          <div>
            <div className="text-[13px] font-semibold">Reauthorize</div>
            <div className="text-[11.5px] text-[var(--text-tertiary)] mt-px">
              Sign in again to refresh permissions and tokens.
            </div>
          </div>
          <WBtn size="sm">Reauthorize</WBtn>
        </div>
        <div
          className="grid items-center gap-2.5 py-2"
          style={{
            gridTemplateColumns: '1fr auto',
            borderTop: '1px solid var(--border-hairline)',
          }}
        >
          <div>
            <div className="text-[13px] font-semibold" style={{ color: '#B43030' }}>
              Disconnect integration
            </div>
            <div className="text-[11.5px] text-[var(--text-tertiary)] mt-px">
              Removes credentials and stops syncing. Historical data is kept.
            </div>
          </div>
          <button
            type="button"
            onClick={onDisconnect}
            disabled={isDisconnecting}
            className="focus-ring font-sans cursor-pointer disabled:opacity-50 disabled:cursor-not-allowed"
            style={{
              height: 28,
              padding: '0 12px',
              borderRadius: 6,
              border: '1px solid rgba(220,38,38,0.40)',
              background: 'rgba(220,38,38,0.04)',
              color: '#B43030',
              fontSize: 12,
              fontWeight: 600,
            }}
          >
            {isDisconnecting ? 'Disconnecting…' : 'Disconnect'}
          </button>
        </div>
      </ModalCard>
    </div>
  );
}

function TabActivityLog({ entries }: { entries: LogEntry[] }) {
  const [filter, setFilter] = React.useState<'all' | 'error' | 'warn' | 'success'>('all');
  const filtered = filter === 'all' ? entries : entries.filter((l) => l.level === filter);
  const counts = {
    all: entries.length,
    error: entries.filter((l) => l.level === 'error').length,
    warn: entries.filter((l) => l.level === 'warn').length,
    success: entries.filter((l) => l.level === 'success').length,
  };

  const filters: Array<{ id: 'all' | 'error' | 'warn' | 'success'; label: string }> = [
    { id: 'all', label: 'All' },
    { id: 'error', label: 'Errors' },
    { id: 'warn', label: 'Warnings' },
    { id: 'success', label: 'Successful' },
  ];

  return (
    <div className="flex flex-col gap-3">
      <div
        className="flex items-center gap-2 rounded-lg"
        style={{
          padding: '10px 12px',
          background: 'var(--bg-surface)',
          border: '1px solid var(--border-hairline)',
        }}
      >
        <div className="inline-flex gap-1">
          {filters.map((f) => {
            const active = filter === f.id;
            return (
              <button
                key={f.id}
                type="button"
                onClick={() => setFilter(f.id)}
                className="focus-ring inline-flex items-center gap-1.5 font-sans cursor-pointer"
                style={{
                  height: 26,
                  padding: '0 10px',
                  borderRadius: 6,
                  border: '1px solid ' + (active ? 'transparent' : 'var(--border-hairline-strong)'),
                  background: active ? 'var(--accent)' : 'var(--bg-surface)',
                  color: active ? '#fff' : 'var(--text-secondary)',
                  fontSize: 12,
                  fontWeight: active ? 600 : 500,
                }}
              >
                <span>{f.label}</span>
                <span
                  className="num"
                  style={{
                    fontSize: 10.5,
                    fontWeight: 700,
                    padding: '0 6px',
                    borderRadius: 999,
                    minWidth: 18,
                    textAlign: 'center',
                    background: active ? 'rgba(255,255,255,0.20)' : 'var(--bg-surface-2)',
                    color: active ? '#fff' : 'var(--text-tertiary)',
                  }}
                >
                  {counts[f.id]}
                </span>
              </button>
            );
          })}
        </div>
        <div className="flex-1" />
        <div
          className="inline-flex items-center gap-1.5 text-[12px] font-medium"
          style={{
            height: 28,
            padding: '0 10px',
            border: '1px solid var(--border-hairline-strong)',
            borderRadius: 6,
            background: 'var(--bg-surface)',
            color: 'var(--text-secondary)',
          }}
        >
          <WIcon name="filter" size={12} color="var(--text-tertiary)" />
          Last 24 hours
          <WIcon name="chevron-down" size={11} color="var(--text-tertiary)" />
        </div>
        <WBtn size="sm" leading="export">
          Export
        </WBtn>
      </div>
      <div
        className="overflow-hidden rounded-lg"
        style={{
          background: 'var(--bg-surface)',
          border: '1px solid var(--border-hairline)',
        }}
      >
        {filtered.map((l, i) => (
          <LogRow key={i} entry={l} />
        ))}
        {filtered.length === 0 && (
          <div className="py-10 text-center text-[12.5px] text-[var(--text-tertiary)]">
            {entries.length === 0
              ? 'No sync activity recorded yet.'
              : 'No entries match this filter.'}
          </div>
        )}
      </div>
      <div className="text-[11.5px] text-[var(--text-tertiary)] px-1">
        Showing the most recent <span className="num">{entries.length}</span> sync result from{' '}
        <span className="num">lastSyncStats</span>. A detailed per-event log will land when the
        backend grows a dedicated <span className="num">integrationLogs</span> table.
      </div>
    </div>
  );
}

// ─── modal ──────────────────────────────────────────────────────────────

interface IntegrationManageModalProps {
  rec: IntegrationCatalogEntry;
  /** WorkOS org id used by the disconnect mutation (looks up by provider). */
  workosOrgId: string | null;
  /** The real `orgIntegrations` row, or null when the integration isn't
   *  connected yet (modal opens in preview mode). */
  connection: OrgIntegrationConnection | null;
  onClose: () => void;
  autoTest?: boolean;
}

export function IntegrationManageModal({
  rec,
  workosOrgId,
  connection,
  onClose,
  autoTest,
}: IntegrationManageModalProps) {
  const [tab, setTab] = React.useState<'overview' | 'rules' | 'credentials' | 'logs'>('overview');
  const [testState, setTestState] = React.useState<{ checks: TestCheck[]; complete: boolean } | null>(
    null,
  );
  const [isDisconnecting, setIsDisconnecting] = React.useState(false);
  const isConnected = !!connection;
  const preset = React.useMemo(() => derivePreset(connection), [connection]);
  const resources = React.useMemo(() => deriveResources(connection), [connection]);
  const logEntries = React.useMemo(() => deriveLogEntries(connection), [connection]);
  const health = HEALTH_TONES[preset.health];
  const timeoutsRef = React.useRef<ReturnType<typeof setTimeout>[]>([]);

  const deleteIntegration = useMutation(api.integrations.deleteIntegration);

  const runTest = React.useCallback(() => {
    timeoutsRef.current.forEach(clearTimeout);
    timeoutsRef.current = [];

    // Compute the real outcomes ONCE — every check derives from the same
    // Convex row, so there's no risk of inconsistency across steps.
    const outcomes = computeRealOutcomes(connection);
    const initial: TestCheck[] = TEST_PLAN.map((s) => ({ ...s, status: 'pending' }));
    setTestState({ checks: initial, complete: false });

    TEST_PLAN.forEach((step, i) => {
      timeoutsRef.current.push(
        setTimeout(() => {
          setTestState((prev) =>
            prev
              ? {
                  ...prev,
                  checks: prev.checks.map((x, j) => (j === i ? { ...x, status: 'running' } : x)),
                }
              : prev,
          );
        }, 200 + i * 320),
      );
      timeoutsRef.current.push(
        setTimeout(() => {
          const o = outcomes[step.id];
          const status: TestCheckStatus =
            o.ok === true ? 'pass' : o.ok === 'warn' ? 'warn' : 'fail';
          setTestState((prev) =>
            prev
              ? {
                  ...prev,
                  checks: prev.checks.map((x, j) =>
                    j === i ? { ...x, status, latency: o.latency, note: o.note } : x,
                  ),
                  complete: i === TEST_PLAN.length - 1,
                }
              : prev,
          );
        }, 200 + i * 320 + 240),
      );
    });
  }, [connection]);

  React.useEffect(() => {
    if (autoTest) runTest();
    const timeouts = timeoutsRef.current;
    return () => timeouts.forEach(clearTimeout);
  }, [autoTest, runTest]);

  React.useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.preventDefault();
        onClose();
      }
    };
    document.addEventListener('keydown', onKey);
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    return () => {
      document.removeEventListener('keydown', onKey);
      document.body.style.overflow = previousOverflow;
    };
  }, [onClose]);

  const handleDisconnect = async () => {
    if (!workosOrgId || !isConnected) {
      onClose();
      return;
    }
    if (!confirm(`Disconnect ${rec.name}? Credentials will be removed. Historical data is kept.`)) {
      return;
    }
    setIsDisconnecting(true);
    try {
      await deleteIntegration({ workosOrgId, provider: rec.id });
      onClose();
    } catch (err) {
      alert(err instanceof Error ? err.message : 'Failed to disconnect');
    } finally {
      setIsDisconnecting(false);
    }
  };

  const tabs: Array<{ id: typeof tab; label: string; n?: number; dot?: boolean }> = [
    { id: 'overview', label: 'Overview' },
    { id: 'rules', label: 'Sync rules', n: resources.filter((r) => r.enabled).length },
    { id: 'credentials', label: 'Credentials' },
    {
      id: 'logs',
      label: 'Activity log',
      n: logEntries.filter((l) => l.level === 'error').length,
      dot: logEntries.some((l) => l.level === 'error'),
    },
  ];

  return (
    <div
      onMouseDown={onClose}
      className="fixed inset-0 z-[1100] flex items-center justify-center p-6"
      style={{ background: 'rgba(15,22,36,0.32)' }}
    >
      <div
        onMouseDown={(e) => e.stopPropagation()}
        className="flex flex-col overflow-hidden rounded-xl"
        style={{
          width: 980,
          maxWidth: '100%',
          height: '86vh',
          maxHeight: 880,
          background: 'var(--bg-canvas)',
          border: '1px solid var(--border-hairline-strong)',
          boxShadow: 'var(--shadow-popover)',
        }}
      >
        {/* Header */}
        <div
          className="flex items-start justify-between gap-4 px-5 pt-4 pb-3.5"
          style={{
            background: 'var(--bg-surface)',
            borderBottom: '1px solid var(--border-hairline)',
          }}
        >
          <div className="flex items-center gap-3 min-w-0">
            <MonoTile mono={rec.mono} tint={rec.tint} size={44} />
            <div className="min-w-0">
              <div className="flex items-center gap-2">
                <span
                  className="font-semibold"
                  style={{ fontSize: 17, letterSpacing: -0.005 }}
                >
                  {rec.name}
                </span>
                <span
                  className="inline-flex items-center gap-1.5 font-bold tracking-wide"
                  style={{
                    height: 20,
                    padding: '0 8px',
                    borderRadius: 10,
                    background: health.bg,
                    color: health.fg,
                    fontSize: 11,
                  }}
                >
                  <span
                    className="inline-block rounded-full"
                    style={{
                      width: 6,
                      height: 6,
                      background: health.dot,
                      boxShadow: `0 0 0 3px ${health.bg}`,
                    }}
                  />
                  {health.label}
                </span>
                {rec.official && (
                  <span
                    className="inline-flex items-center gap-0.5 font-semibold tracking-wide"
                    style={{
                      height: 18,
                      padding: '0 6px',
                      borderRadius: 9,
                      background: 'rgba(46,92,255,0.10)',
                      color: 'var(--accent)',
                      fontSize: 10.5,
                    }}
                  >
                    <WIcon name="badge-check" size={10} /> Official
                  </span>
                )}
              </div>
              <div className="text-[12px] text-[var(--text-tertiary)] mt-0.5 truncate">
                {rec.categoryLabel}
                {isConnected
                  ? ` · Connected ${preset.connectedAt.split(',').slice(0, 2).join(',')}`
                  : ' · Preview — not connected'}
              </div>
            </div>
          </div>
          <div className="flex items-center gap-2 shrink-0">
            <WBtn size="sm" leading="check" onClick={runTest}>
              Test connection
            </WBtn>
            <button
              type="button"
              onClick={onClose}
              className="focus-ring inline-flex items-center justify-center bg-transparent border-0 cursor-pointer rounded-md"
              style={{ width: 28, height: 28, color: 'var(--text-tertiary)' }}
            >
              <WIcon name="close" size={14} />
            </button>
          </div>
        </div>

        {/* Health hero strip — fields without backend telemetry render as "—" */}
        <div
          className="grid"
          style={{
            gridTemplateColumns: 'repeat(4, 1fr)',
            background: 'var(--bg-surface)',
            borderBottom: '1px solid var(--border-hairline)',
          }}
        >
          <HealthStat
            label="Uptime · 24h"
            value={preset.uptime ?? <span style={{ color: 'var(--text-tertiary)' }}>—</span>}
            sub="Not tracked yet"
          />
          <HealthStat
            label="Last sync"
            value={preset.lastSync}
            tone={
              preset.lastSyncStatus === 'failed'
                ? 'bad'
                : preset.lastSyncStatus === 'partial'
                  ? 'warn'
                  : preset.lastSyncStatus === 'success'
                    ? 'good'
                    : undefined
            }
            sub={preset.lastSyncStatus ?? (isConnected ? 'No sync recorded' : 'Not connected')}
          />
          <HealthStat
            label="Records · last run"
            value={
              preset.recordsProcessed != null
                ? preset.recordsProcessed.toLocaleString()
                : <span style={{ color: 'var(--text-tertiary)' }}>—</span>
            }
            sub={preset.isEnabled ? 'Sync enabled' : 'Sync paused'}
          />
          <HealthStat
            label="Error rate"
            value={preset.errorRate ?? <span style={{ color: 'var(--text-tertiary)' }}>—</span>}
            sub="Not tracked yet"
          />
        </div>

        {/* Tabs */}
        <div
          className="flex items-stretch px-5"
          style={{
            background: 'var(--bg-surface)',
            borderBottom: '1px solid var(--border-hairline)',
          }}
        >
          {tabs.map((t) => {
            const active = tab === t.id;
            return (
              <button
                key={t.id}
                type="button"
                onClick={() => setTab(t.id)}
                className="focus-ring relative inline-flex items-center gap-1.5 bg-transparent border-0 cursor-pointer font-sans text-[13px]"
                style={{
                  height: 40,
                  padding: '0 14px',
                  color: active ? 'var(--text-primary)' : 'var(--text-tertiary)',
                  fontWeight: active ? 600 : 500,
                }}
              >
                <span>{t.label}</span>
                {t.n != null && (
                  <span
                    className="num"
                    style={{
                      fontSize: 10.5,
                      fontWeight: 700,
                      padding: '1px 6px',
                      borderRadius: 999,
                      minWidth: 18,
                      textAlign: 'center',
                      background: t.dot ? 'rgba(220,38,38,0.10)' : 'var(--bg-surface-2)',
                      color: t.dot ? '#B43030' : 'var(--text-tertiary)',
                      border: t.dot ? 'none' : '1px solid var(--border-hairline)',
                    }}
                  >
                    {t.n}
                  </span>
                )}
                {active && (
                  <span
                    aria-hidden
                    className="absolute rounded-sm"
                    style={{
                      bottom: -1,
                      left: 8,
                      right: 8,
                      height: 2,
                      background: 'var(--accent)',
                    }}
                  />
                )}
              </button>
            );
          })}
        </div>

        {/* Body */}
        <div
          className="scroll-thin overflow-auto p-4"
          style={{ flex: 1, background: 'var(--bg-canvas)' }}
        >
          {/* Live-data banner — be honest about what's real vs placeholder */}
          <div
            className="flex items-start gap-2.5 rounded-lg mb-3.5"
            style={{
              padding: '10px 12px',
              background: isConnected
                ? 'rgba(46,92,255,0.06)'
                : 'rgba(245,158,11,0.08)',
              border: '1px solid '
                + (isConnected ? 'rgba(46,92,255,0.18)' : 'rgba(245,158,11,0.20)'),
            }}
          >
            <WIcon
              name={isConnected ? 'info' : 'alert'}
              size={13}
              color={isConnected ? 'var(--accent)' : '#A66800'}
            />
            <div className="text-[12px] leading-[17px]" style={{ color: 'var(--text-secondary)' }}>
              {isConnected ? (
                <>
                  <span className="font-semibold text-foreground">Live data</span> for connection
                  meta, sync status, sync settings, and the last sync result. Uptime, rate-limit,
                  per-resource volume, OAuth token details and webhook config are{' '}
                  <span className="font-medium">placeholders</span> until backend telemetry is
                  added.
                </>
              ) : (
                <>
                  <span className="font-semibold text-foreground">Preview only</span> —{' '}
                  {rec.name} isn&apos;t connected yet. Connect this integration to see live sync
                  status, credentials, and activity here.
                </>
              )}
            </div>
          </div>
          {testState && (
            <TestResultsPanel
              state={testState}
              onClose={() => setTestState(null)}
              onRetest={runTest}
            />
          )}
          {tab === 'overview' && (
            <TabOverview
              preset={preset}
              resources={resources}
              logEntries={logEntries}
              onTab={setTab as (id: string) => void}
              rec={rec}
              workosOrgId={workosOrgId}
            />
          )}
          {tab === 'rules' && <TabSyncRules resources={resources} />}
          {tab === 'credentials' && (
            <TabCredentials
              preset={preset}
              isConnected={isConnected}
              onTest={runTest}
              onDisconnect={handleDisconnect}
              isDisconnecting={isDisconnecting}
            />
          )}
          {tab === 'logs' && <TabActivityLog entries={logEntries} />}
        </div>

        {/* Footer */}
        <div
          className="flex items-center justify-between px-5 py-3"
          style={{
            borderTop: '1px solid var(--border-hairline)',
            background: 'var(--bg-surface)',
          }}
        >
          <div className="inline-flex items-center gap-1.5 text-[11.5px] text-[var(--text-tertiary)]">
            <WIcon name="help" size={12} />
            Need help?{' '}
            <span
              className="font-medium cursor-pointer"
              style={{ color: 'var(--accent)' }}
            >
              {rec.name} setup guide ↗
            </span>
          </div>
          <div className="flex gap-2 items-center">
            <span className="text-[11.5px] text-[var(--text-tertiary)] mr-1">
              Press <Kbd>Esc</Kbd> to close
            </span>
            <WBtn size="sm" onClick={onClose}>
              Close
            </WBtn>
          </div>
        </div>
      </div>
    </div>
  );
}
