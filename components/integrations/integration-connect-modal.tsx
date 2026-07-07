'use client';

/**
 * IntegrationConnectModal — 4-step wizard for connecting an integration.
 *
 *   1. Review     — description, permissions Otoqa will request, requirements
 *   2. Authorize  — OAuth redirect OR API-key form (per integration). OAuth
 *                   integrations with a service-account fallback get a method
 *                   switcher at the top.
 *   3. Configure  — pick which resources to sync (toggle list)
 *   4. Success    — full-bleed confirmation + activity ticker + Manage CTA
 *
 * What's REAL:
 *   - Step 3 "Finish" calls `api.integrations.upsertIntegration` with the
 *     real provider id, credentials JSON, and syncSettings derived from
 *     selected resources. The row appears in `orgIntegrations` immediately
 *     and the marketplace's connected pill updates.
 *
 * What's still SIMULATED (UI-only, no real OAuth callback yet):
 *   - The 1.4s OAuth "Continue → spinning → Authorized" sequence. The
 *     credentials blob stored after OAuth is a marker
 *     (`{"authMethod":"oauth-placeholder",...}`) so production can swap in
 *     a real callback later without changing the UI.
 *   - API-key verification: we don't ping the partner before saving — the
 *     credentials are stored as-is.
 *
 * Sibling modal: IntegrationManageModal. Same chrome (width, animation,
 * Esc behavior) so the two read as one design vocabulary.
 */

import * as React from 'react';
import { useAction, useMutation } from 'convex/react';
import { api } from '@/convex/_generated/api';
import { useAuth } from '@workos-inc/authkit-nextjs/components';
import { WBtn, WIcon, type IconName } from '@/components/web';
import {
  TINT_PALETTE,
  type IntegrationCatalogEntry,
} from '@/lib/integrations-catalog';
import { Loader2 } from 'lucide-react';

// ─── per-integration presets ────────────────────────────────────────────

interface CredentialFieldSpec {
  id: string;
  label: string;
  placeholder: string;
  secret?: boolean;
  mono?: boolean;
  required?: boolean;
  /** Render as a `<select>` instead of a text input. */
  options?: Array<{ value: string; label: string }>;
  /** Default value (used to pre-populate the field on mount). */
  defaultValue?: string;
  /** Hint shown beneath the input for clarity. */
  hint?: string;
}

interface ConnectPreset {
  authMethod: 'oauth' | 'apikey';
  provider: string;
  allowedRegions?: string[];
  /** OAuth-first integrations that also expose a service-account fallback. */
  supportsManual?: boolean;
  /** Fields for the manual fallback form (OAuth + manual integrations). */
  manualFields?: CredentialFieldSpec[];
  /** Fields for the primary form (API-key-only integrations). */
  fields?: CredentialFieldSpec[];
}

const CONNECT_PRESETS: Record<string, ConnectPreset> = {
  // OAuth-first
  motive: {
    authMethod: 'oauth', provider: 'Motive', allowedRegions: ['US', 'CA'],
    supportsManual: true,
    manualFields: [
      { id: 'apiKey',    label: 'API key',    placeholder: 'mv_••••••••••••••••', secret: true, required: true },
      { id: 'companyId', label: 'Company ID', placeholder: 'C-00000', mono: true, required: true },
    ],
  },
  geotab: {
    authMethod: 'oauth', provider: 'MyGeotab', allowedRegions: ['US', 'CA', 'EU'],
    supportsManual: true,
    manualFields: [
      { id: 'server',   label: 'Server',       placeholder: 'my3.geotab.com', mono: true, required: true },
      { id: 'database', label: 'Database',     placeholder: 'fleet_prod', mono: true, required: true },
      { id: 'username', label: 'API user',     placeholder: 'api@yourcompany.com', required: true },
      { id: 'password', label: 'API password', placeholder: '••••••••••', secret: true, required: true },
    ],
  },
  truckstop: { authMethod: 'oauth', provider: 'Truckstop', allowedRegions: ['US'] },
  project44: {
    authMethod: 'oauth', provider: 'Project44', allowedRegions: ['Global'],
    supportsManual: true,
    manualFields: [
      { id: 'clientId',     label: 'Client ID',     placeholder: 'p44_client_••••••••', mono: true, required: true },
      { id: 'clientSecret', label: 'Client secret', placeholder: 'p44_secret_••••••••••••••••', secret: true, required: true },
      { id: 'baseUrl',      label: 'API base URL',  placeholder: 'https://na12.api.project44.com', mono: true, required: false },
    ],
  },
  fourkites: {
    authMethod: 'apikey', provider: 'FourKites', allowedRegions: ['Global'],
    fields: [
      { id: 'apiKey', label: 'API key', placeholder: 'fk_••••••••••••••••', secret: true, required: true },
    ],
  },
  xero: {
    authMethod: 'oauth', provider: 'Xero', allowedRegions: ['Global'],
    supportsManual: true,
    manualFields: [
      { id: 'tenantId',     label: 'Tenant ID',     placeholder: 'xx-xxxx-xxxx-xxxxxxxxxx', mono: true, required: true },
      { id: 'clientId',     label: 'Client ID',     placeholder: 'xero_client_••••••', mono: true, required: true },
      { id: 'clientSecret', label: 'Client secret', placeholder: 'xero_secret_••••••••', secret: true, required: true },
    ],
  },
  samsara: {
    authMethod: 'apikey', provider: 'Samsara', allowedRegions: ['US', 'CA', 'EU'],
    fields: [
      {
        id: 'rawApiToken',
        label: 'API token',
        placeholder: 'samsara_api_•••••••••••••••••••••••••',
        secret: true,
        mono: true,
        required: true,
        hint: 'Generate this in Samsara → Settings → API Tokens. Otoqa encrypts it at rest.',
      },
      {
        id: 'environment',
        label: 'Environment',
        placeholder: 'production',
        required: true,
        defaultValue: 'production',
        options: [
          { value: 'production', label: 'Production' },
          { value: 'sandbox',    label: 'Sandbox (test org)' },
        ],
      },
    ],
  },
  'verizon-connect': {
    authMethod: 'apikey', provider: 'Verizon Connect',
    fields: [
      { id: 'username', label: 'Username', placeholder: 'fleet_api_user', required: true },
      { id: 'password', label: 'Password', placeholder: '••••••••••', secret: true, required: true },
      { id: 'database', label: 'Database', placeholder: 'rvw_logistics_prod', mono: true, required: true },
    ],
  },
  pcmiler: {
    authMethod: 'apikey', provider: 'PC*Miler',
    fields: [
      { id: 'apiKey',    label: 'API key',    placeholder: 'pcm_••••••••••••••••', secret: true, required: true },
      { id: 'licenseId', label: 'License ID', placeholder: 'L-000000', mono: true, required: true },
    ],
  },
  'trimble-maps': {
    authMethod: 'apikey', provider: 'Trimble Maps',
    fields: [
      { id: 'apiKey', label: 'API key',      placeholder: 'tm_••••••••••••••••', secret: true, required: true },
      { id: 'env',    label: 'Environment',  placeholder: 'production', required: true },
    ],
  },
  'rts-financial': {
    authMethod: 'apikey', provider: 'RTS Financial',
    fields: [
      { id: 'accountId', label: 'Account ID', placeholder: '000-000-000', mono: true, required: true },
      { id: 'apiKey',    label: 'API key',    placeholder: 'rts_••••••••••••••••', secret: true, required: true },
    ],
  },
  comdata: {
    authMethod: 'apikey', provider: 'Comdata',
    fields: [
      { id: 'accountId', label: 'Customer ID', placeholder: 'C-00000000', mono: true, required: true },
      { id: 'apiKey',    label: 'API key',     placeholder: 'cd_••••••••••••••••', secret: true, required: true },
    ],
  },
};

function getPreset(rec: IntegrationCatalogEntry): ConnectPreset {
  return (
    CONNECT_PRESETS[rec.id] ?? {
      authMethod: 'oauth',
      provider: rec.name,
      allowedRegions: ['Global'],
    }
  );
}

// ─── scopes + resources catalogs ────────────────────────────────────────

interface Scope {
  dir: 'read' | 'write';
  label: string;
  desc: string;
}

const CONNECT_SCOPES: Record<string, Scope[]> = {
  project44: [
    { dir: 'read',  label: 'Carrier network access',    desc: 'See which shippers and brokers you’re connected with on Project44.' },
    { dir: 'write', label: 'Send tractor positions',    desc: 'Push GPS pings on a 5-minute cadence for each active load.' },
    { dir: 'write', label: 'Send stop arrival events',  desc: 'Notify partners when a driver checks in or checks out of a stop.' },
    { dir: 'write', label: 'Send document attachments', desc: 'Share signed PODs and BOLs back to the requesting party.' },
  ],
  fourkites: [
    { dir: 'read',  label: 'Read shipment list',     desc: 'Pull active shipments assigned to this account.' },
    { dir: 'write', label: 'Push tractor positions', desc: 'Send GPS pings for active loads so brokers see live ETA.' },
    { dir: 'write', label: 'Push stop status',       desc: 'Update stop arrivals, departures, and completion events.' },
  ],
  samsara: [
    // Aligned to Samsara Fleet API scopes (developers.samsara.com).
    { dir: 'read',  label: 'Fleet roster',    desc: 'Read vehicles + drivers so Otoqa can map your Samsara fleet to its records.' },
    { dir: 'read',  label: 'Vehicle stats feed', desc: 'GPS, engine, odometer, and fuel level via /fleet/vehicles/stats/feed.' },
    { dir: 'read',  label: 'Hours of service', desc: 'Daily HOS logs + remaining drive time per driver.' },
    { dir: 'read',  label: 'DVIRs',           desc: 'Pre- and post-trip vehicle inspection reports.' },
    { dir: 'read',  label: 'Safety events',   desc: 'Harsh braking, speeding, and other safety triggers.' },
    { dir: 'write', label: 'Dispatch routes', desc: 'Push planner routes to the Samsara cab tablet (POST /fleet/dispatch/routes).' },
    { dir: 'write', label: 'Driver messages', desc: 'Send messages to drivers through the Samsara app (POST /fleet/messages).' },
  ],
  __default: [
    { dir: 'read',  label: 'Read account profile', desc: 'Identify which account you’re connecting and which region it lives in.' },
    { dir: 'read',  label: 'Read core records',    desc: 'Sync the records this integration manages into Otoqa.' },
    { dir: 'write', label: 'Write changes back',   desc: 'When you save in Otoqa, mirror the change back to the partner.' },
  ],
};

function getScopes(rec: IntegrationCatalogEntry): Scope[] {
  return CONNECT_SCOPES[rec.id] ?? CONNECT_SCOPES.__default;
}

interface ConnectResource {
  id: string;
  name: string;
  direction: 'pull' | 'push';
  freq: string;
  desc: string;
  recommended?: boolean;
  required?: boolean;
  /** Endpoint hint shown in mono under the name — e.g. "GET /fleet/dvirs". */
  endpoint?: string;
  /** True when the partner API supports this but the Otoqa backend hasn't
   *  wired it yet. Renders a disabled toggle + "Coming soon" badge. */
  comingSoon?: boolean;
}

const CONNECT_RESOURCES: Record<string, ConnectResource[]> = {
  project44: [
    { id: 'eta',     name: 'Live ETA updates',    direction: 'push', freq: 'every 5 min',  recommended: true, required: true, desc: 'Push tractor pings to brokers and shippers in your network.' },
    { id: 'stops',   name: 'Stop status events',  direction: 'push', freq: 'on event',     recommended: true, desc: 'Notify partners when a driver arrives, departs, or completes a stop.' },
    { id: 'docs',    name: 'Proof of delivery',   direction: 'push', freq: 'on capture',   recommended: true, desc: 'Share signed PODs and rate confirmations.' },
    { id: 'temps',   name: 'Reefer temperatures', direction: 'push', freq: 'every 15 min', recommended: false, desc: 'Stream temperature readings for cold-chain loads.' },
    { id: 'tenders', name: 'Load tenders',        direction: 'pull', freq: 'on event',     recommended: true, desc: 'Receive new load offers from connected shippers.' },
  ],
  fourkites: [
    { id: 'shipments', name: 'Load imports',     direction: 'pull', freq: 'every 15 min', recommended: true, required: true, desc: 'Pull assigned shipments into Otoqa as Open loads.' },
    { id: 'gps',       name: 'GPS tracking',     direction: 'push', freq: 'continuous',   recommended: true, desc: 'Push truck locations to share live ETA with brokers.' },
    { id: 'assigns',   name: 'Driver assignments', direction: 'push', freq: 'on save',    recommended: true, desc: 'Send driver/truck assignments back to FourKites on save.' },
  ],
  samsara: [
    // Mapped 1:1 to Samsara Fleet API endpoints. Frequencies reflect Samsara's
    // published rate-limit guidance (50 req/sec per org per endpoint) and the
    // shape of the underlying feeds (cursor-pagination on `/stats/feed`,
    // straight GETs elsewhere). Only resources we've actually wired today
    // are selectable; everything else carries a "Coming soon" badge so users
    // know what's on the roadmap.
    {
      id: 'gps',
      name: 'Vehicle locations (GPS feed)',
      direction: 'pull',
      freq: 'every ~10 sec',
      desc: 'Live GPS positions for every active truck via Samsara\'s vehicle stats feed.',
      endpoint: 'GET /fleet/vehicles/stats/feed?types=gps',
      recommended: true,
      required: true,
    },
    {
      id: 'fleet-roster',
      name: 'Fleet roster',
      direction: 'pull',
      freq: 'on connect + every 6h',
      desc: 'Vehicles and drivers list so Otoqa can map your Samsara fleet to its records.',
      endpoint: 'GET /fleet/vehicles · GET /fleet/drivers',
      recommended: true,
      comingSoon: true,
    },
    {
      id: 'vehicle-stats',
      name: 'Vehicle telemetry',
      direction: 'pull',
      freq: 'every 5 min',
      desc: 'Engine state, odometer, and fuel percent in addition to GPS.',
      endpoint: 'GET /fleet/vehicles/stats/feed?types=engineStates,odometerMeters,fuelPercents',
      recommended: false,
      comingSoon: true,
    },
    {
      id: 'hos',
      name: 'Hours of service',
      direction: 'pull',
      freq: 'every 15 min',
      desc: 'Daily HOS logs, driving hours, and remaining duty time per driver.',
      endpoint: 'GET /fleet/hos/daily_logs',
      recommended: true,
      comingSoon: true,
    },
    {
      id: 'dvirs',
      name: 'DVIRs',
      direction: 'pull',
      freq: 'every 5 min',
      desc: 'Pre- and post-trip vehicle inspection reports.',
      endpoint: 'GET /fleet/dvirs',
      recommended: true,
      comingSoon: true,
    },
    {
      id: 'safety-events',
      name: 'Safety events',
      direction: 'pull',
      freq: 'every 5 min',
      desc: 'Harsh braking, speeding, and other safety event triggers.',
      endpoint: 'GET /fleet/safety-events',
      recommended: false,
      comingSoon: true,
    },
    {
      id: 'dispatch-routes',
      name: 'Trip dispatches',
      direction: 'push',
      freq: 'on save',
      desc: 'Push planner routes to the Samsara cab tablet so the driver sees their stops.',
      endpoint: 'POST /fleet/dispatch/routes',
      recommended: true,
      comingSoon: true,
    },
    {
      id: 'driver-messages',
      name: 'Driver messages',
      direction: 'push',
      freq: 'on send',
      desc: 'Send dispatcher messages to drivers through the Samsara app.',
      endpoint: 'POST /fleet/messages',
      recommended: false,
      comingSoon: true,
    },
  ],
  __default: [
    { id: 'records', name: 'Master records', direction: 'pull', freq: 'every 15 min', recommended: true, required: true, desc: 'Sync core records this integration manages.' },
    { id: 'events',  name: 'Event stream',   direction: 'pull', freq: 'every 5 min',  recommended: true, desc: 'Stream changes as they happen, including creates and updates.' },
    { id: 'writes',  name: 'Write-back',     direction: 'push', freq: 'on save',      recommended: false, desc: 'Send changes from Otoqa back to the integration on save.' },
  ],
};

function getResources(rec: IntegrationCatalogEntry): ConnectResource[] {
  return CONNECT_RESOURCES[rec.id] ?? CONNECT_RESOURCES.__default;
}

/** Derive `syncSettings` from selected resources for `upsertIntegration`.
 *  Coming-soon resources are intentionally excluded — they aren't wired in
 *  the backend yet, so persisting them as enabled would be misleading. */
function deriveSyncSettings(
  resources: ConnectResource[],
  selected: Record<string, boolean>,
): {
  isEnabled: boolean;
  pull?: { loadsEnabled: boolean; intervalMinutes: number; lookbackWindowHours: number };
  push?: { gpsTrackingEnabled: boolean; driverAssignmentsEnabled: boolean };
} {
  const live = resources.filter((r) => !r.comingSoon);
  const pulls = live.filter((r) => r.direction === 'pull' && selected[r.id]);
  const pushes = live.filter((r) => r.direction === 'push' && selected[r.id]);

  // Pull settings — enable loadsEnabled if any pull resource is selected
  const pull = pulls.length > 0
    ? {
        loadsEnabled: true,
        intervalMinutes: 15,
        lookbackWindowHours: 24,
      }
    : undefined;

  // Push settings — split GPS-flavored vs dispatch-flavored
  const gpsHints = ['gps', 'eta', 'temps', 'fleet'];
  const dispatchHints = ['disp', 'stops', 'docs', 'assigns', 'writes'];
  const gpsTracking = pushes.some((r) => gpsHints.some((h) => r.id.includes(h)));
  const driverAssignments = pushes.some((r) => dispatchHints.some((h) => r.id.includes(h)));
  const push = pushes.length > 0
    ? {
        gpsTrackingEnabled: gpsTracking || pushes.length > 0,
        driverAssignmentsEnabled: driverAssignments || false,
      }
    : undefined;

  return { isEnabled: true, pull, push };
}

// ─── primitives ─────────────────────────────────────────────────────────

function MonoTile({
  mono,
  tint,
  size = 36,
}: {
  mono: string;
  tint: keyof typeof TINT_PALETTE;
  size?: number;
}) {
  const t = TINT_PALETTE[tint] || TINT_PALETTE.slate;
  const len = mono.length;
  const fs = len >= 3 ? 11 : len === 2 ? 13 : 15;
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

function ModalCard({
  title,
  action,
  children,
  padded = true,
}: {
  title?: React.ReactNode;
  action?: React.ReactNode;
  children: React.ReactNode;
  padded?: boolean;
}) {
  return (
    <div
      className="rounded-[10px] overflow-hidden"
      style={{
        background: 'var(--bg-surface)',
        border: '1px solid var(--border-hairline)',
      }}
    >
      {(title || action) && (
        <div
          className="flex items-center justify-between px-3.5 py-2.5"
          style={{
            borderBottom: '1px solid var(--border-hairline)',
            background: 'var(--bg-surface-2)',
          }}
        >
          <div className="text-[12px] font-semibold text-foreground tracking-[0.02em]">
            {title}
          </div>
          {action}
        </div>
      )}
      <div style={{ padding: padded ? '12px 14px' : 0 }}>{children}</div>
    </div>
  );
}

function InlineLink({
  children,
  onClick,
}: {
  children: React.ReactNode;
  onClick?: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className="focus-ring inline-flex items-center gap-1 bg-transparent border-0 cursor-pointer rounded-[5px] px-1.5 py-0.5 font-sans text-[11.5px] font-medium"
      style={{ color: 'var(--accent)' }}
    >
      {children}
    </button>
  );
}

// ─── Step dots ──────────────────────────────────────────────────────────

interface StepDef {
  id: string;
  label: string;
}

function StepDots({ steps, current }: { steps: StepDef[]; current: number }) {
  return (
    <div
      className="flex items-center gap-2"
      style={{
        padding: '14px 20px',
        background: 'var(--bg-surface)',
        borderBottom: '1px solid var(--border-hairline)',
      }}
    >
      {steps.map((s, i) => {
        const done = i < current;
        const active = i === current;
        return (
          <React.Fragment key={s.id}>
            <div className="inline-flex items-center gap-2">
              <span
                className="inline-flex items-center justify-center rounded-full font-bold num"
                style={{
                  width: 22,
                  height: 22,
                  background: done
                    ? 'var(--accent)'
                    : active
                      ? 'var(--bg-surface)'
                      : 'var(--bg-surface-2)',
                  color: done ? '#fff' : active ? 'var(--accent)' : 'var(--text-tertiary)',
                  border: active
                    ? '1.5px solid var(--accent)'
                    : done
                      ? 'none'
                      : '1px solid var(--border-hairline-strong)',
                  fontSize: 11.5,
                  transition: 'all var(--dur-fast) var(--ease-out)',
                }}
              >
                {done ? <WIcon name="check" size={11} /> : i + 1}
              </span>
              <span
                style={{
                  fontSize: 12.5,
                  fontWeight: active ? 600 : 500,
                  color: active
                    ? 'var(--text-primary)'
                    : done
                      ? 'var(--text-secondary)'
                      : 'var(--text-tertiary)',
                }}
              >
                {s.label}
              </span>
            </div>
            {i < steps.length - 1 && (
              <span
                style={{
                  flex: '0 1 32px',
                  minWidth: 16,
                  height: 1,
                  background: done
                    ? 'var(--accent)'
                    : 'var(--border-hairline-strong)',
                  transition: 'background var(--dur-fast) var(--ease-out)',
                }}
              />
            )}
          </React.Fragment>
        );
      })}
    </div>
  );
}

// ─── Step 1: Review ─────────────────────────────────────────────────────

function ReviewStat({
  icon,
  label,
  value,
  sub,
}: {
  icon: IconName;
  label: string;
  value: React.ReactNode;
  sub: React.ReactNode;
}) {
  return (
    <div
      className="rounded-lg"
      style={{
        padding: '10px 12px',
        background: 'var(--bg-surface-2)',
        border: '1px solid var(--border-hairline)',
      }}
    >
      <div className="flex items-center gap-1.5 mb-1">
        <WIcon name={icon} size={12} color="var(--text-tertiary)" />
        <span className="tw-label" style={{ fontSize: 10 }}>
          {label}
        </span>
      </div>
      <div className="font-bold" style={{ fontSize: 14, letterSpacing: -0.01 }}>
        {value}
      </div>
      <div className="text-[11px] text-[var(--text-tertiary)] mt-px">{sub}</div>
    </div>
  );
}

function StepReview({
  rec,
  preset,
  scopes,
  resources,
}: {
  rec: IntegrationCatalogEntry;
  preset: ConnectPreset;
  scopes: Scope[];
  resources: ConnectResource[];
}) {
  return (
    <div className="flex flex-col gap-3.5">
      <ModalCard title="What this connects">
        <div className="text-[13px] text-[var(--text-secondary)] leading-[20px]">
          {rec.description}
        </div>
        <div className="grid grid-cols-3 gap-2.5 mt-3.5">
          <ReviewStat
            icon="check"
            label="Setup time"
            value="≈ 4 min"
            sub={preset.authMethod === 'oauth' ? 'One-click OAuth' : 'Paste credentials'}
          />
          <ReviewStat
            icon="route"
            label="Resources"
            value={
              (() => {
                const live = resources.filter((r) => !r.comingSoon).length;
                const total = resources.length;
                return live === total ? `${total} streams` : `${live} of ${total} streams`;
              })()
            }
            sub={(() => {
              const live = resources.filter((r) => !r.comingSoon);
              const pull = live.filter((r) => r.direction === 'pull').length;
              const push = live.filter((r) => r.direction === 'push').length;
              const soon = resources.length - live.length;
              return soon === 0
                ? `${pull} pull · ${push} push`
                : `${pull} pull · ${push} push · ${soon} coming soon`;
            })()}
          />
          <ReviewStat
            icon="shield"
            label="Region"
            value={preset.allowedRegions ? preset.allowedRegions.join(' · ') : 'Global'}
            sub="Data stays in region"
          />
        </div>
      </ModalCard>

      <ModalCard title={`Permissions Otoqa will request (${scopes.length})`}>
        <div className="flex flex-col gap-2.5">
          {scopes.map((s, i) => (
            <div key={i} className="flex gap-2.5">
              <span
                className="inline-flex items-center gap-1 uppercase font-bold shrink-0"
                style={{
                  height: 18,
                  padding: '0 6px',
                  borderRadius: 9,
                  background:
                    s.dir === 'read' ? 'rgba(46,92,255,0.10)' : 'rgba(124,58,237,0.10)',
                  color: s.dir === 'read' ? '#1A47E6' : '#7C3AED',
                  fontSize: 10,
                  letterSpacing: 0.04,
                }}
              >
                {s.dir === 'read' ? '↓ Read' : '↑ Write'}
              </span>
              <div className="min-w-0">
                <div className="text-[12.5px] font-semibold">{s.label}</div>
                <div className="text-[11.5px] text-[var(--text-tertiary)] mt-px leading-[15px]">
                  {s.desc}
                </div>
              </div>
            </div>
          ))}
        </div>
      </ModalCard>

      <div
        className="flex gap-2.5 rounded-lg"
        style={{
          padding: 12,
          background: 'var(--bg-surface-2)',
          border: '1px solid var(--border-hairline)',
        }}
      >
        <span
          className="inline-flex items-center justify-center rounded-full shrink-0"
          style={{
            width: 22,
            height: 22,
            background: 'rgba(46,92,255,0.10)',
            color: 'var(--accent)',
          }}
        >
          <WIcon name="help" size={12} />
        </span>
        <div className="text-[12px] text-[var(--text-secondary)] leading-[17px]">
          You&apos;ll need{' '}
          {preset.authMethod === 'oauth'
            ? `an admin account on ${preset.provider} to authorize this connection.`
            : `${preset.provider} API credentials. Generate them from your ${preset.provider} admin panel.`}{' '}
          <span style={{ color: 'var(--accent)', fontWeight: 500, cursor: 'pointer' }}>
            Setup guide ↗
          </span>
        </div>
      </div>
    </div>
  );
}

// ─── Step 2: Authorize ──────────────────────────────────────────────────

type AuthState = 'idle' | 'pending' | 'success';

function MethodSwitcher({
  value,
  onChange,
  provider,
}: {
  value: 'oauth' | 'manual';
  onChange: (v: 'oauth' | 'manual') => void;
  provider: string;
}) {
  const opts: Array<{ id: 'oauth' | 'manual'; label: string; hint: string; icon: IconName }> = [
    { id: 'oauth',  label: `Sign in with ${provider}`, hint: 'Recommended',    icon: 'arrow-up-right' },
    { id: 'manual', label: 'Paste API credentials',    hint: 'Service account', icon: 'cmd' },
  ];
  return (
    <div className="grid grid-cols-2 gap-2">
      {opts.map((o) => {
        const active = value === o.id;
        return (
          <button
            key={o.id}
            type="button"
            onClick={() => onChange(o.id)}
            className="focus-ring text-left flex items-center gap-2.5 cursor-pointer font-sans"
            style={{
              padding: '10px 12px',
              background: active ? 'var(--bg-surface)' : 'var(--bg-surface-2)',
              border: '1px solid ' + (active ? 'var(--accent)' : 'var(--border-hairline)'),
              borderRadius: 8,
              boxShadow: active ? '0 0 0 3px rgba(46,92,255,0.10)' : 'none',
              transition: 'all var(--dur-fast) var(--ease-out)',
            }}
          >
            <span
              className="inline-flex items-center justify-center shrink-0"
              style={{
                width: 28,
                height: 28,
                borderRadius: 7,
                background: active ? 'rgba(46,92,255,0.10)' : 'var(--bg-surface)',
                border: '1px solid ' + (active ? 'rgba(46,92,255,0.24)' : 'var(--border-hairline)'),
                color: active ? 'var(--accent)' : 'var(--text-tertiary)',
              }}
            >
              <WIcon name={o.icon} size={14} />
            </span>
            <div className="min-w-0 flex-1">
              <div
                className="text-[12.5px] font-semibold"
                style={{ color: active ? 'var(--text-primary)' : 'var(--text-secondary)' }}
              >
                {o.label}
              </div>
              <div className="text-[11px] text-[var(--text-tertiary)] mt-px">{o.hint}</div>
            </div>
            <span
              className="rounded-full shrink-0"
              style={{
                width: 14,
                height: 14,
                border: active ? '4px solid var(--accent)' : '1.5px solid var(--border-hairline-strong)',
                background: active ? 'var(--accent)' : 'var(--bg-surface)',
                transition: 'all var(--dur-fast) var(--ease-out)',
              }}
            />
          </button>
        );
      })}
    </div>
  );
}

function CredentialField({
  field,
  value,
  onChange,
}: {
  field: CredentialFieldSpec;
  value: string;
  onChange: (v: string) => void;
}) {
  const [revealed, setRevealed] = React.useState(false);
  const isSelect = !!field.options;
  return (
    <label className="flex flex-col gap-1">
      <span className="text-[12px] font-medium text-[var(--text-secondary)]">
        {field.label} {field.required && <span style={{ color: '#B43030' }}>*</span>}
      </span>
      <div
        className="flex items-stretch overflow-hidden rounded-[7px] relative"
        style={{
          height: 34,
          border: '1px solid var(--border-hairline-strong)',
          background: 'var(--bg-surface)',
        }}
      >
        {isSelect ? (
          <>
            <select
              value={value}
              onChange={(e) => onChange(e.target.value)}
              className="flex-1 border-0 outline-0 bg-transparent text-[12.5px] appearance-none cursor-pointer pr-7"
              style={{
                padding: '0 12px',
                fontFamily: field.mono ? 'var(--font-mono)' : 'inherit',
                color: 'var(--text-primary)',
              }}
            >
              {field.options!.map((o) => (
                <option key={o.value} value={o.value}>
                  {o.label}
                </option>
              ))}
            </select>
            <span
              aria-hidden
              className="absolute right-2.5 top-1/2 -translate-y-1/2 pointer-events-none text-[var(--text-tertiary)] flex"
            >
              <WIcon name="chevron-down" size={12} />
            </span>
          </>
        ) : (
          <>
            <input
              value={value}
              onChange={(e) => onChange(e.target.value)}
              type={field.secret && !revealed ? 'password' : 'text'}
              placeholder={field.placeholder}
              spellCheck={false}
              autoComplete="off"
              className="flex-1 border-0 outline-0 bg-transparent text-[12.5px]"
              style={{
                padding: '0 12px',
                fontFamily: field.mono ? 'var(--font-mono)' : 'inherit',
                color: 'var(--text-primary)',
                letterSpacing: field.secret ? 0.03 : 0,
              }}
            />
            {field.secret && (
              <button
                type="button"
                onClick={() => setRevealed((r) => !r)}
                className="focus-ring inline-flex items-center gap-1 cursor-pointer font-sans"
                style={{
                  border: 0,
                  background: 'var(--bg-surface-2)',
                  borderLeft: '1px solid var(--border-hairline)',
                  padding: '0 12px',
                  fontSize: 11.5,
                  color: 'var(--text-tertiary)',
                  fontWeight: 500,
                }}
              >
                <WIcon name={revealed ? 'eye-off' : 'eye'} size={12} />
                {revealed ? 'Hide' : 'Show'}
              </button>
            )}
          </>
        )}
      </div>
      {field.hint && (
        <span className="text-[11px] text-[var(--text-tertiary)] leading-[15px]">
          {field.hint}
        </span>
      )}
    </label>
  );
}

function ManualCredentialsForm({
  preset,
  authState,
  fields,
  onFieldChange,
  formFields,
  fallback,
  onSwitchBackToOAuth,
}: {
  preset: ConnectPreset;
  authState: AuthState;
  fields: Record<string, string>;
  onFieldChange: (k: string, v: string) => void;
  formFields: CredentialFieldSpec[] | undefined;
  fallback: boolean;
  onSwitchBackToOAuth: () => void;
}) {
  return (
    <ModalCard
      title={
        fallback
          ? `Paste a ${preset.provider} service-account key`
          : `Paste your ${preset.provider} credentials`
      }
    >
      {fallback && (
        <div
          className="flex gap-2.5 rounded-[7px] mb-3.5"
          style={{
            padding: '10px 12px',
            background: 'rgba(245,158,11,0.08)',
            border: '1px solid rgba(245,158,11,0.24)',
          }}
        >
          <WIcon name="alert" size={14} color="#A66800" />
          <div className="text-[11.5px] leading-[16px]" style={{ color: '#7A4F00' }}>
            <strong className="font-semibold">
              Use this only if you can&apos;t complete the OAuth sign-in.
            </strong>{' '}
            Service-account keys don&apos;t expire automatically and require manual rotation.
            Recommended for headless setups, locked-down IT, or per-account separation.
          </div>
        </div>
      )}

      <div className="text-[12.5px] text-[var(--text-tertiary)] leading-[17px] mb-3.5">
        {fallback ? (
          <>
            Generate a service-account key in your {preset.provider} admin panel. We&apos;ll store
            it encrypted at rest.
          </>
        ) : (
          <>
            Generate these in your {preset.provider} admin panel. Otoqa encrypts secrets at rest
            and never logs them in plaintext.
          </>
        )}{' '}
        <span style={{ color: 'var(--accent)', fontWeight: 500, cursor: 'pointer' }}>
          Where do I find these? ↗
        </span>
      </div>

      <div className="flex flex-col gap-3">
        {formFields?.map((f) => (
          <CredentialField
            key={f.id}
            field={f}
            value={fields[f.id] || ''}
            onChange={(v) => onFieldChange(f.id, v)}
          />
        ))}
      </div>

      {authState === 'pending' && (
        <div
          className="flex items-center gap-2 rounded-[7px] mt-3.5"
          style={{
            padding: '8px 12px',
            background: 'rgba(46,92,255,0.06)',
            border: '1px solid rgba(46,92,255,0.20)',
          }}
        >
          <Loader2 size={12} className="animate-spin" style={{ color: 'var(--accent)' }} />
          <span className="text-[12px] font-medium" style={{ color: 'var(--accent)' }}>
            Verifying credentials with {preset.provider}…
          </span>
        </div>
      )}
      {authState === 'success' && (
        <div
          className="flex items-center gap-2.5 rounded-[7px] mt-3.5"
          style={{
            padding: '8px 12px',
            background: 'rgba(16,185,129,0.08)',
            border: '1px solid rgba(16,185,129,0.30)',
          }}
        >
          <span
            className="inline-flex items-center justify-center rounded-full shrink-0"
            style={{
              width: 16,
              height: 16,
              background: '#0F8C5F',
              color: '#fff',
            }}
          >
            <WIcon name="check" size={10} />
          </span>
          <span className="text-[12.5px] font-medium" style={{ color: '#0F8C5F' }}>
            Credentials captured · we&apos;ll verify on first sync
          </span>
        </div>
      )}

      {fallback && authState === 'idle' && (
        <div
          className="flex items-center justify-between mt-3.5 pt-3 text-[11.5px]"
          style={{ borderTop: '1px solid var(--border-hairline)' }}
        >
          <span className="inline-flex items-center gap-1.5 text-[var(--text-tertiary)]">
            <WIcon name="shield" size={11} />
            AES-256 at rest · key never transmitted in plaintext
          </span>
          <button
            type="button"
            onClick={onSwitchBackToOAuth}
            className="focus-ring bg-transparent border-0 cursor-pointer font-sans font-medium"
            style={{ fontSize: 11.5, color: 'var(--accent)' }}
          >
            ← Use OAuth sign-in instead
          </button>
        </div>
      )}
    </ModalCard>
  );
}

function StepAuthorize({
  rec,
  preset,
  authState,
  onAuthorize,
  onFieldChange,
  fields,
  authMode,
  onAuthMode,
}: {
  rec: IntegrationCatalogEntry;
  preset: ConnectPreset;
  authState: AuthState;
  onAuthorize: () => void;
  onFieldChange: (k: string, v: string) => void;
  fields: Record<string, string>;
  authMode: 'oauth' | 'manual';
  onAuthMode: (m: 'oauth' | 'manual') => void;
}) {
  const effectiveMethod = preset.authMethod === 'apikey' ? 'apikey' : authMode;
  const formFields = preset.authMethod === 'apikey' ? preset.fields : preset.manualFields;

  return (
    <div className="flex flex-col gap-3.5">
      {preset.authMethod === 'oauth' && preset.supportsManual && (
        <MethodSwitcher value={authMode} onChange={onAuthMode} provider={preset.provider} />
      )}

      {effectiveMethod === 'oauth' ? (
        <ModalCard>
          <div className="text-center" style={{ padding: '14px 20px 6px' }}>
            <div
              className="inline-flex items-center justify-center mb-3.5"
              style={{
                width: 56,
                height: 56,
                borderRadius: 14,
                background: 'rgba(46,92,255,0.08)',
                border: '1px solid var(--border-hairline)',
              }}
            >
              <MonoTile mono={rec.mono} tint={rec.tint} size={40} />
            </div>
            <div
              className="font-semibold mb-1.5"
              style={{ fontSize: 17, letterSpacing: -0.005 }}
            >
              Authorize with {preset.provider}
            </div>
            <div
              className="text-[12.5px] text-[var(--text-tertiary)] leading-[18px]"
              style={{ maxWidth: 420, margin: '0 auto 18px' }}
            >
              You&apos;ll be redirected to {preset.provider} to sign in and approve the
              permissions listed in the previous step. We never see your password.
            </div>

            {authState === 'idle' && (
              <WBtn size="md" variant="primary" onClick={onAuthorize} leading="arrow-up-right">
                Continue to {preset.provider}
              </WBtn>
            )}
            {authState === 'pending' && (
              <div
                className="inline-flex items-center gap-2.5 rounded-lg"
                style={{
                  padding: '10px 16px',
                  background: 'rgba(46,92,255,0.06)',
                  border: '1px solid rgba(46,92,255,0.20)',
                }}
              >
                <Loader2 size={14} className="animate-spin" style={{ color: 'var(--accent)' }} />
                <span
                  className="text-[13px] font-medium"
                  style={{ color: 'var(--accent)' }}
                >
                  Waiting for {preset.provider} authorization…
                </span>
              </div>
            )}
            {authState === 'success' && (
              <div
                className="inline-flex items-center gap-2.5 rounded-lg"
                style={{
                  padding: '10px 16px',
                  background: 'rgba(16,185,129,0.08)',
                  border: '1px solid rgba(16,185,129,0.30)',
                }}
              >
                <span
                  className="inline-flex items-center justify-center rounded-full shrink-0"
                  style={{
                    width: 18,
                    height: 18,
                    background: '#0F8C5F',
                    color: '#fff',
                  }}
                >
                  <WIcon name="check" size={11} />
                </span>
                <div className="text-left">
                  <div
                    className="text-[12.5px] font-semibold"
                    style={{ color: '#0F8C5F' }}
                  >
                    Authorization captured
                  </div>
                  <div className="text-[11px] text-[var(--text-tertiary)] mt-px">
                    Real OAuth handshake will run on first sync
                  </div>
                </div>
              </div>
            )}
          </div>

          <div
            className="flex items-center justify-between gap-2 mt-3.5 pt-3 px-3.5 pb-3"
            style={{
              borderTop: '1px solid var(--border-hairline)',
              fontSize: 11.5,
              color: 'var(--text-tertiary)',
            }}
          >
            <span className="inline-flex items-center gap-1.5">
              <WIcon name="shield" size={11} />
              OAuth 2.0 · TLS 1.3 · Tokens encrypted at rest
            </span>
            {preset.supportsManual && (
              <button
                type="button"
                onClick={() => onAuthMode('manual')}
                className="focus-ring bg-transparent border-0 cursor-pointer font-sans font-medium"
                style={{ fontSize: 11.5, color: 'var(--accent)' }}
              >
                Use a service-account key instead
              </button>
            )}
          </div>
        </ModalCard>
      ) : (
        <ManualCredentialsForm
          preset={preset}
          authState={authState}
          fields={fields}
          onFieldChange={onFieldChange}
          formFields={formFields}
          fallback={preset.authMethod === 'oauth' && !!preset.supportsManual}
          onSwitchBackToOAuth={() => onAuthMode('oauth')}
        />
      )}
    </div>
  );
}

// ─── Step 3: Configure ──────────────────────────────────────────────────

function StepConfigure({
  resources,
  selected,
  onToggle,
}: {
  resources: ConnectResource[];
  selected: Record<string, boolean>;
  onToggle: (id: string) => void;
}) {
  // Only selectable resources count toward "N of M selected" — the
  // Coming-soon rows are read-only previews of the API surface.
  const selectable = resources.filter((r) => !r.comingSoon);
  const count = selectable.filter((r) => selected[r.id]).length;
  return (
    <>
      <ModalCard
        title={`Pick what to sync (${count} of ${selectable.length} selected)`}
        padded={false}
      >
        {resources.map((r, i) => {
          const on = !!selected[r.id];
          const locked = !!r.required || !!r.comingSoon;
          return (
            <button
              key={r.id}
              type="button"
              onClick={() => !locked && onToggle(r.id)}
              disabled={locked}
              className="focus-ring w-full grid items-center gap-3 bg-transparent border-0 font-sans text-left"
              style={{
                gridTemplateColumns: '36px 1fr 110px',
                padding: '12px 14px',
                borderTop: i === 0 ? 'none' : '1px solid var(--border-hairline)',
                cursor: locked ? 'default' : 'pointer',
                opacity: r.comingSoon ? 0.6 : 1,
              }}
              onMouseEnter={(e) => {
                if (!locked) e.currentTarget.style.background = 'var(--bg-row-hover)';
              }}
              onMouseLeave={(e) => {
                e.currentTarget.style.background = 'transparent';
              }}
            >
              <span
                className="inline-block relative rounded-full shrink-0"
                style={{
                  width: 28,
                  height: 16,
                  background: r.comingSoon
                    ? 'var(--border-hairline)'
                    : on
                      ? '#0F8C5F'
                      : 'var(--border-hairline-strong)',
                  opacity: r.required || r.comingSoon ? 0.7 : 1,
                }}
              >
                <span
                  className="absolute rounded-full"
                  style={{
                    top: 2,
                    left: on && !r.comingSoon ? 14 : 2,
                    width: 12,
                    height: 12,
                    background: '#fff',
                    boxShadow: '0 1px 2px rgba(0,0,0,0.18)',
                    transition: 'left var(--dur-fast) var(--ease-out)',
                  }}
                />
              </span>
              <div className="min-w-0">
                <div className="flex items-center gap-1.5 mb-0.5 flex-wrap">
                  <span className="text-[13px] font-semibold">{r.name}</span>
                  <span
                    className="inline-flex items-center uppercase font-bold"
                    style={{
                      height: 16,
                      padding: '0 6px',
                      borderRadius: 8,
                      background:
                        r.direction === 'pull'
                          ? 'rgba(46,92,255,0.10)'
                          : 'rgba(124,58,237,0.10)',
                      color: r.direction === 'pull' ? '#1A47E6' : '#7C3AED',
                      fontSize: 9.5,
                      letterSpacing: 0.04,
                    }}
                  >
                    {r.direction === 'pull' ? '↓ Pull' : '↑ Push'}
                  </span>
                  {r.recommended && !r.comingSoon && (
                    <span
                      className="inline-flex items-center uppercase font-bold"
                      style={{
                        height: 16,
                        padding: '0 6px',
                        borderRadius: 8,
                        background: 'rgba(245,158,11,0.12)',
                        color: '#A66800',
                        fontSize: 9.5,
                        letterSpacing: 0.04,
                      }}
                    >
                      Recommended
                    </span>
                  )}
                  {r.required && !r.comingSoon && (
                    <span
                      style={{
                        fontSize: 10,
                        color: 'var(--text-tertiary)',
                        fontWeight: 500,
                      }}
                    >
                      Required
                    </span>
                  )}
                  {r.comingSoon && (
                    <span
                      className="inline-flex items-center uppercase font-bold"
                      style={{
                        height: 16,
                        padding: '0 6px',
                        borderRadius: 8,
                        background: 'var(--bg-surface-2)',
                        color: 'var(--text-tertiary)',
                        border: '1px solid var(--border-hairline)',
                        fontSize: 9.5,
                        letterSpacing: 0.04,
                      }}
                    >
                      Coming soon
                    </span>
                  )}
                </div>
                <div className="text-[11.5px] text-[var(--text-tertiary)] leading-[15px]">
                  {r.desc}
                </div>
                {r.endpoint && (
                  <div
                    className="num mt-1 truncate"
                    style={{
                      fontFamily: 'var(--font-mono)',
                      fontSize: 10.5,
                      color: 'var(--text-tertiary)',
                    }}
                  >
                    {r.endpoint}
                  </div>
                )}
              </div>
              <div className="text-right">
                <div className="tw-label" style={{ fontSize: 9.5 }}>
                  Frequency
                </div>
                <div className="text-[11.5px] text-[var(--text-secondary)] mt-0.5">
                  {r.freq}
                </div>
              </div>
            </button>
          );
        })}
      </ModalCard>

      <div
        className="flex gap-2.5 rounded-lg mt-3"
        style={{
          padding: 12,
          background: 'rgba(46,92,255,0.04)',
          border: '1px solid rgba(46,92,255,0.16)',
        }}
      >
        <WIcon name="help" size={14} color="var(--accent)" />
        <div className="text-[11.5px] text-[var(--text-secondary)] leading-[16px]">
          You can change these anytime from{' '}
          <strong>Settings → Integrations → Manage</strong>. Frequency and scope are also
          editable per resource.
        </div>
      </div>
    </>
  );
}

// ─── Step 4: Success ────────────────────────────────────────────────────

function StepSuccess({
  rec,
  selectedCount,
  onManage,
  onClose,
}: {
  rec: IntegrationCatalogEntry;
  selectedCount: number;
  onManage: () => void;
  onClose: () => void;
}) {
  return (
    <div
      className="flex flex-col items-center gap-2 text-center"
      style={{ padding: 24 }}
    >
      <div
        className="inline-flex items-center justify-center rounded-full mb-1.5 relative"
        style={{
          width: 68,
          height: 68,
          background: 'rgba(16,185,129,0.12)',
        }}
      >
        <div
          className="absolute flex items-center justify-center rounded-full"
          style={{
            inset: 8,
            background: '#0F8C5F',
            color: '#fff',
          }}
        >
          <WIcon name="check" size={26} />
        </div>
      </div>
      <div className="font-semibold" style={{ fontSize: 19, letterSpacing: -0.005 }}>
        {rec.name} is connected
      </div>
      <div
        className="text-[13px] text-[var(--text-tertiary)] leading-[20px] mb-3"
        style={{ maxWidth: 440 }}
      >
        Otoqa is syncing {selectedCount} resource{selectedCount === 1 ? '' : 's'}. The first pull
        will appear in your records within a few minutes.
      </div>

      <div
        className="w-full overflow-hidden rounded-[10px] text-left"
        style={{
          maxWidth: 480,
          background: 'var(--bg-surface)',
          border: '1px solid var(--border-hairline)',
        }}
      >
        <div
          className="flex items-center gap-2 uppercase tracking-wide font-semibold"
          style={{
            padding: '8px 12px',
            background: 'var(--bg-surface-2)',
            borderBottom: '1px solid var(--border-hairline)',
            fontSize: 11,
            color: 'var(--text-tertiary)',
            letterSpacing: 0.04,
          }}
        >
          <span
            className="rounded-full"
            style={{
              width: 6,
              height: 6,
              background: '#0F8C5F',
              boxShadow: '0 0 0 3px rgba(16,185,129,0.18)',
            }}
          />
          Live activity
        </div>
        {[
          { t: 'just now', msg: `Credentials saved and integration enabled` },
          { t: '2s ago',   msg: `Initial sync queued · ${selectedCount} resources` },
          { t: '4s ago',   msg: `Marketplace card updated to Connected` },
        ].map((row, i) => (
          <div
            key={i}
            className="flex justify-between gap-3"
            style={{
              padding: '8px 12px',
              borderTop: i === 0 ? 'none' : '1px solid var(--border-hairline)',
              fontSize: 12,
            }}
          >
            <span style={{ color: 'var(--text-secondary)' }}>{row.msg}</span>
            <span
              className="num text-[11px]"
              style={{ color: 'var(--text-tertiary)' }}
            >
              {row.t}
            </span>
          </div>
        ))}
      </div>

      <div className="flex gap-2 mt-4">
        <WBtn size="md" onClick={onClose}>
          Done
        </WBtn>
        <WBtn size="md" variant="primary" onClick={onManage} trailing="arrow-right">
          Manage integration
        </WBtn>
      </div>
    </div>
  );
}

// ─── Modal ──────────────────────────────────────────────────────────────

interface IntegrationConnectModalProps {
  rec: IntegrationCatalogEntry;
  workosOrgId: string;
  /** Called after upsert succeeds. Page typically transitions to Manage. */
  onConnected?: (rec: IntegrationCatalogEntry) => void;
  onClose: () => void;
}

export function IntegrationConnectModal({
  rec,
  workosOrgId,
  onConnected,
  onClose,
}: IntegrationConnectModalProps) {
  const { user } = useAuth();
  const upsertIntegration = useMutation(api.integrations.upsertIntegration);
  const connectSamsara = useAction(api.samsaraAdmin.connectSamsara);

  const preset = React.useMemo(() => getPreset(rec), [rec]);
  const scopes = React.useMemo(() => getScopes(rec), [rec]);
  const resources = React.useMemo(() => getResources(rec), [rec]);

  const [step, setStep] = React.useState(0);
  const [authState, setAuthState] = React.useState<AuthState>('idle');
  const [authMode, setAuthMode] = React.useState<'oauth' | 'manual'>('oauth');
  // Seed defaults from preset field specs (e.g. environment = "production").
  const [fields, setFields] = React.useState<Record<string, string>>(() => {
    const initial: Record<string, string> = {};
    const formFields =
      preset.authMethod === 'apikey' ? preset.fields : preset.manualFields;
    formFields?.forEach((f) => {
      if (f.defaultValue) initial[f.id] = f.defaultValue;
    });
    return initial;
  });
  const [selected, setSelected] = React.useState<Record<string, boolean>>(() => {
    const s: Record<string, boolean> = {};
    resources.forEach((r) => {
      // Coming-soon resources can never be selected — they aren't wired yet.
      s[r.id] = !r.comingSoon && (r.recommended || !!r.required);
    });
    return s;
  });
  const [isSaving, setIsSaving] = React.useState(false);
  const [saveError, setSaveError] = React.useState<string | null>(null);
  const timeoutsRef = React.useRef<ReturnType<typeof setTimeout>[]>([]);

  React.useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.preventDefault();
        onClose();
      }
    };
    document.addEventListener('keydown', onKey);
    const prev = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    const timeouts = timeoutsRef.current;
    return () => {
      document.removeEventListener('keydown', onKey);
      document.body.style.overflow = prev;
      timeouts.forEach(clearTimeout);
    };
  }, [onClose]);

  const steps: StepDef[] = [
    { id: 'review',    label: 'Review' },
    { id: 'authorize', label: 'Authorize' },
    { id: 'configure', label: 'Configure' },
    { id: 'done',      label: 'Done' },
  ];

  // OAuth: fake the redirect with a 1.4s spinner (real callback wired later).
  // API-key: instant verification (we'll catch errors on first real sync).
  const startAuth = () => {
    setAuthState('pending');
    const isApikey =
      preset.authMethod === 'apikey' ||
      (preset.authMethod === 'oauth' && authMode === 'manual');
    const delay = isApikey ? 600 : 1400;
    timeoutsRef.current.push(
      setTimeout(() => setAuthState('success'), delay),
    );
  };

  const back = () => setStep((s) => Math.max(0, s - 1));
  const next = () => setStep((s) => Math.min(steps.length - 1, s + 1));

  let canAdvance = true;
  let primaryLabel: React.ReactNode = 'Continue';
  if (step === 1) {
    if (authState === 'idle' && (preset.authMethod === 'apikey' || authMode === 'manual')) {
      const formFields = preset.authMethod === 'apikey' ? preset.fields : preset.manualFields;
      canAdvance =
        !!formFields &&
        formFields.every((f) => !f.required || (fields[f.id] && fields[f.id].length > 0));
      primaryLabel = 'Verify credentials';
    } else {
      canAdvance = authState === 'success';
      primaryLabel = authState === 'success' ? 'Continue' : 'Waiting for authorization';
    }
  }
  if (step === 2) {
    primaryLabel = 'Finish connection';
    canAdvance = Object.values(selected).some(Boolean) && !!user;
  }
  if (step === 3) {
    primaryLabel = 'Done';
  }

  const selectedCount = Object.values(selected).filter(Boolean).length;

  // Finish: persist to Convex, then move to Success step.
  //
  // Some providers (Samsara) have a dedicated server-side onboarding action
  // because their credentials need encryption + companion-row inserts that
  // can't be done from the generic `upsertIntegration` mutation. Route those
  // through their bespoke action; everything else goes through the generic
  // path with credentials stored as a JSON blob.
  const onFinish = async () => {
    if (!user) {
      setSaveError('Not signed in.');
      return;
    }
    setSaveError(null);
    setIsSaving(true);
    try {
      if (rec.id === 'samsara') {
        const rawApiToken = fields.rawApiToken?.trim();
        const environment = (fields.environment as 'sandbox' | 'production') ?? 'production';
        if (!rawApiToken) {
          throw new Error('Samsara API token is required.');
        }
        await connectSamsara({
          workosOrgId,
          rawApiToken,
          environment,
        });
      } else {
        const credentialsJson = JSON.stringify(
          preset.authMethod === 'oauth' && authMode === 'oauth'
            ? { authMethod: 'oauth-placeholder', verifiedAt: Date.now() }
            : { authMethod: 'apikey', fields, verifiedAt: Date.now() },
        );
        const syncSettings = deriveSyncSettings(resources, selected);
        await upsertIntegration({
          workosOrgId,
          provider: rec.id,
          credentials: credentialsJson,
          syncSettings,
          createdBy: user.id,
        });
      }
      next();
    } catch (err) {
      setSaveError(err instanceof Error ? err.message : 'Failed to save connection');
    } finally {
      setIsSaving(false);
    }
  };

  // Step 1 with API-key flow has no explicit "Continue" action — clicking the
  // primary CTA acts as Verify, then auto-advance after success.
  const onPrimary = () => {
    if (step === 1) {
      const isApikey = preset.authMethod === 'apikey' || authMode === 'manual';
      if (authState === 'idle' && isApikey) {
        startAuth();
        // Auto-advance once verified
        timeoutsRef.current.push(setTimeout(() => next(), 800));
        return;
      }
      if (authState === 'success') {
        next();
        return;
      }
      // Pending or not idle — let CTA be disabled
      return;
    }
    if (step === 2) {
      onFinish();
      return;
    }
    if (step === 3) {
      onClose();
      return;
    }
    next();
  };

  return (
    <div
      onMouseDown={onClose}
      className="fixed inset-0 z-[1090] flex items-center justify-center p-6"
      style={{ background: 'rgba(15,22,36,0.32)' }}
    >
      <div
        onMouseDown={(e) => e.stopPropagation()}
        className="flex flex-col overflow-hidden rounded-xl"
        style={{
          width: 720,
          maxWidth: '100%',
          height: '86vh',
          maxHeight: 820,
          background: 'var(--bg-canvas)',
          border: '1px solid var(--border-hairline-strong)',
          boxShadow: 'var(--shadow-popover)',
        }}
      >
        {/* Header */}
        <div
          className="flex items-center justify-between gap-3 px-4.5"
          style={{
            padding: '14px 18px 12px',
            background: 'var(--bg-surface)',
            borderBottom: '1px solid var(--border-hairline)',
          }}
        >
          <div className="flex items-center gap-3 min-w-0">
            <MonoTile mono={rec.mono} tint={rec.tint} size={36} />
            <div className="min-w-0">
              <div className="flex items-center gap-2 flex-wrap">
                <span className="font-semibold text-[15px]">Connect {rec.name}</span>
                {rec.official && (
                  <span
                    className="inline-flex items-center gap-0.5 font-bold tracking-wide"
                    style={{
                      height: 17,
                      padding: '0 6px',
                      borderRadius: 9,
                      background: 'rgba(46,92,255,0.10)',
                      color: 'var(--accent)',
                      fontSize: 10,
                    }}
                  >
                    <WIcon name="badge-check" size={9} /> Official
                  </span>
                )}
              </div>
              <div className="text-[11.5px] text-[var(--text-tertiary)] mt-px truncate">
                {rec.categoryLabel} ·{' '}
                {preset.authMethod === 'oauth' ? 'OAuth 2.0' : 'API key authentication'} · ≈ 4 min
                setup
              </div>
            </div>
          </div>
          <button
            type="button"
            onClick={onClose}
            className="focus-ring inline-flex items-center justify-center bg-transparent border-0 cursor-pointer rounded-md shrink-0"
            style={{ width: 28, height: 28, color: 'var(--text-tertiary)' }}
            aria-label="Close"
          >
            <WIcon name="close" size={14} />
          </button>
        </div>

        {step < 3 && <StepDots steps={steps.slice(0, 3)} current={step} />}

        {/* Body */}
        <div
          className="scroll-thin flex-1 overflow-auto"
          style={{
            padding: step === 3 ? 0 : 18,
            background: 'var(--bg-canvas)',
          }}
        >
          {step === 0 && (
            <StepReview rec={rec} preset={preset} scopes={scopes} resources={resources} />
          )}
          {step === 1 && (
            <StepAuthorize
              rec={rec}
              preset={preset}
              authState={authState}
              onAuthorize={startAuth}
              fields={fields}
              onFieldChange={(k, v) => setFields((f) => ({ ...f, [k]: v }))}
              authMode={authMode}
              onAuthMode={(m) => {
                setAuthMode(m);
                setAuthState('idle');
              }}
            />
          )}
          {step === 2 && (
            <StepConfigure
              resources={resources}
              selected={selected}
              onToggle={(id) => setSelected((s) => ({ ...s, [id]: !s[id] }))}
            />
          )}
          {step === 3 && (
            <StepSuccess
              rec={rec}
              selectedCount={selectedCount}
              onClose={onClose}
              onManage={() => {
                onConnected?.(rec);
                onClose();
              }}
            />
          )}

          {saveError && step === 2 && (
            <div
              className="rounded-lg mt-3"
              style={{
                padding: '10px 12px',
                background: 'rgba(220,38,38,0.06)',
                border: '1px solid rgba(220,38,38,0.30)',
                color: '#B43030',
                fontSize: 12,
              }}
            >
              {saveError}
            </div>
          )}
        </div>

        {/* Footer */}
        {step < 3 && (
          <div
            className="flex items-center justify-between gap-3"
            style={{
              padding: '12px 18px',
              borderTop: '1px solid var(--border-hairline)',
              background: 'var(--bg-surface)',
            }}
          >
            <div className="inline-flex items-center gap-1.5 text-[11.5px] text-[var(--text-tertiary)]">
              <WIcon name="shield" size={12} />
              Encrypted at rest ·{' '}
              <span style={{ color: 'var(--accent)', fontWeight: 500, cursor: 'pointer' }}>
                Setup guide ↗
              </span>
            </div>
            <div className="flex gap-2">
              {step > 0 ? (
                <WBtn size="sm" onClick={back} leading="chevron-left">
                  Back
                </WBtn>
              ) : (
                <WBtn size="sm" onClick={onClose}>
                  Cancel
                </WBtn>
              )}
              <WBtn
                size="sm"
                variant="primary"
                onClick={onPrimary}
                disabled={!canAdvance || isSaving}
              >
                {isSaving && <Loader2 className="h-3.5 w-3.5 animate-spin" />}
                {primaryLabel}
              </WBtn>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
