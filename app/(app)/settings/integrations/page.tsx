'use client';

/**
 * Settings → Integrations marketplace.
 *
 * Single-screen marketplace surfacing 200+ partner integrations grouped by
 * category, searchable, sortable. The activation lever is "tools your fleet
 * already uses" — ELDs, load boards, fuel cards, factoring, accounting —
 * surfaced on day one so a dispatcher can plug in their existing stack.
 *
 * Data shape:
 *   - Catalog is a TypeScript constant (`lib/integrations-catalog`). Edits
 *     ship as PRs, no DB migration needed.
 *   - Per-org connection state comes from `api.integrations.getIntegrations`
 *     keyed by `provider`. A catalog card is `connected: true` if a row exists.
 *   - Manage modal opens for connected cards; Connect button is wired for
 *     unconnected cards (placeholder for now).
 */

import * as React from 'react';
import { useState, useMemo } from 'react';
import { useQuery } from 'convex/react';
import { api } from '@/convex/_generated/api';
import { useOrganizationId } from '@/contexts/organization-context';

import {
  CountBadge,
  Kbd,
  SettingsHeader,
  WBtn,
  WIcon,
  type IconName,
} from '@/components/web';

import {
  INTEGRATIONS_CATALOG,
  INTEGRATION_CATEGORIES,
  TIER_TONES,
  TINT_PALETTE,
  type IntegrationCatalogEntry,
  type IntegrationTint,
} from '@/lib/integrations-catalog';

import {
  IntegrationManageModal,
  type OrgIntegrationConnection,
} from '@/components/integrations/integration-manage-modal';
import { IntegrationConnectModal } from '@/components/integrations/integration-connect-modal';

// ─── primitives ─────────────────────────────────────────────────────────

function MonoTile({
  mono,
  tint,
  size = 36,
}: {
  mono: string;
  tint: IntegrationTint;
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

function Star({ size = 11, color = '#F59E0B' }: { size?: number; color?: string }) {
  return (
    <svg width={size} height={size} viewBox="0 0 12 12" fill={color} aria-hidden>
      <path d="M6 1.2l1.5 3 3.3.5-2.4 2.3.6 3.3L6 8.8l-3 1.5.6-3.3L1.2 4.7l3.3-.5L6 1.2z" />
    </svg>
  );
}

function TierPill({ tier }: { tier: keyof typeof TIER_TONES }) {
  const t = TIER_TONES[tier] || TIER_TONES.Free;
  return (
    <span
      className="inline-flex items-center font-semibold tracking-wide"
      style={{
        height: 16,
        padding: '0 6px',
        borderRadius: 8,
        background: t.bg,
        color: t.fg,
        fontSize: 10.5,
        whiteSpace: 'nowrap',
      }}
    >
      {tier}
    </span>
  );
}

function OfficialBadge() {
  return (
    <span
      title="Built and maintained by Otoqa"
      className="inline-flex items-center gap-0.5 font-semibold tracking-wide"
      style={{
        height: 16,
        padding: '0 6px',
        borderRadius: 8,
        background: 'rgba(46,92,255,0.10)',
        color: 'var(--accent)',
        fontSize: 10.5,
      }}
    >
      <WIcon name="badge-check" size={10} /> Official
    </span>
  );
}

// ─── IntegrationCard ────────────────────────────────────────────────────

interface CardProps {
  rec: IntegrationCatalogEntry;
  connected: boolean;
  onOpen: (rec: IntegrationCatalogEntry) => void;
}

function IntegrationCard({ rec, connected, onOpen }: CardProps) {
  return (
    <div
      onClick={() => onOpen(rec)}
      onMouseEnter={(e) => {
        e.currentTarget.style.borderColor = 'var(--border-hairline-strong)';
        e.currentTarget.style.transform = 'translateY(-1px)';
        e.currentTarget.style.boxShadow = 'var(--shadow-popover)';
      }}
      onMouseLeave={(e) => {
        e.currentTarget.style.borderColor = 'var(--border-hairline)';
        e.currentTarget.style.transform = 'translateY(0)';
        e.currentTarget.style.boxShadow = 'none';
      }}
      className="flex flex-col overflow-hidden cursor-pointer"
      style={{
        background: 'var(--bg-surface)',
        border: '1px solid var(--border-hairline)',
        borderRadius: 10,
        transition:
          'border-color var(--dur-fast) var(--ease-out), transform var(--dur-fast) var(--ease-out), box-shadow var(--dur) var(--ease-out)',
      }}
    >
      {/* Body */}
      <div
        className="flex flex-col gap-2.5"
        style={{ padding: '14px 14px 12px', minHeight: 132 }}
      >
        <div className="flex items-start justify-between gap-2.5">
          <div className="flex items-center gap-2.5 min-w-0">
            <MonoTile mono={rec.mono} tint={rec.tint} />
            <div className="min-w-0">
              <div
                className="flex items-center gap-1.5 font-semibold leading-[18px] whitespace-nowrap"
                style={{ fontSize: 13.5 }}
              >
                <span className="truncate">{rec.name}</span>
              </div>
              <div className="tw-meta text-[11.5px] mt-px">{rec.categoryLabel}</div>
            </div>
          </div>
          {connected && (
            <span
              title="Connected"
              className="inline-flex items-center justify-center rounded-full shrink-0"
              style={{
                width: 16,
                height: 16,
                background: 'rgba(16,185,129,0.16)',
                color: '#0F8C5F',
              }}
            >
              <WIcon name="check" size={10} />
            </span>
          )}
        </div>
        <div
          className="overflow-hidden text-[var(--text-secondary)]"
          style={{
            fontSize: 12.5,
            lineHeight: '17px',
            display: '-webkit-box',
            WebkitLineClamp: 2,
            WebkitBoxOrient: 'vertical',
          }}
        >
          {rec.description}
        </div>
        <div className="flex items-center gap-1.5 flex-wrap mt-auto">
          {rec.official && <OfficialBadge />}
          <TierPill tier={rec.tier} />
          {rec.popular && (
            <span
              className="inline-flex items-center font-semibold tracking-wide"
              style={{
                height: 16,
                padding: '0 6px',
                borderRadius: 8,
                background: 'rgba(245,158,11,0.12)',
                color: '#A66800',
                fontSize: 10.5,
              }}
            >
              Popular
            </span>
          )}
        </div>
      </div>
      {/* Footer */}
      <div
        className="flex items-center justify-between gap-2"
        style={{
          borderTop: '1px solid var(--border-hairline)',
          background: 'var(--bg-surface-2)',
          padding: '8px 12px 8px 14px',
        }}
      >
        <div className="flex items-center gap-1">
          <Star size={11} />
          <span className="num text-[12px] font-semibold text-foreground">
            {rec.rating.toFixed(1)}
          </span>
          <span className="text-[11.5px] text-[var(--text-tertiary)] ml-1">·</span>
          <span className="num text-[11.5px] text-[var(--text-tertiary)]">
            {rec.installs} installs
          </span>
        </div>
        {connected ? (
          <span
            className="inline-flex items-center gap-1.5 font-medium font-sans"
            style={{
              height: 24,
              padding: '0 10px',
              borderRadius: 6,
              border: '1px solid var(--border-hairline-strong)',
              background: 'var(--bg-surface)',
              color: 'var(--text-secondary)',
              fontSize: 12,
            }}
          >
            Manage
            <WIcon name="arrow-right" size={11} />
          </span>
        ) : (
          <span
            className="inline-flex items-center gap-1.5 font-semibold font-sans"
            style={{
              height: 24,
              padding: '0 10px',
              borderRadius: 6,
              background: 'var(--accent)',
              color: '#fff',
              fontSize: 12,
            }}
          >
            Connect
          </span>
        )}
      </div>
    </div>
  );
}

// ─── Category dropdown ──────────────────────────────────────────────────

function CategoryDropdown({
  active,
  onPick,
}: {
  active: string;
  onPick: (id: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const ref = React.useRef<HTMLDivElement | null>(null);

  React.useEffect(() => {
    if (!open) return;
    const onDoc = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setOpen(false);
    };
    document.addEventListener('mousedown', onDoc);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onDoc);
      document.removeEventListener('keydown', onKey);
    };
  }, [open]);

  const current = INTEGRATION_CATEGORIES.find((c) => c.id === active) || INTEGRATION_CATEGORIES[0];

  return (
    <div ref={ref} className="relative">
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        className="focus-ring inline-flex items-center gap-2 cursor-pointer font-sans font-medium text-[12.5px]"
        style={{
          height: 32,
          padding: '0 10px 0 12px',
          borderRadius: 7,
          border: '1px solid var(--border-hairline-strong)',
          background: open ? 'var(--bg-surface-2)' : 'var(--bg-surface)',
          color: 'var(--text-primary)',
        }}
      >
        <WIcon name={current.icon} size={13} color="var(--text-tertiary)" />
        <span>{current.label}</span>
        <span
          className="num text-center"
          style={{
            fontSize: 10.5,
            fontWeight: 600,
            padding: '1px 6px',
            borderRadius: 999,
            minWidth: 20,
            background: active === 'all' ? 'var(--bg-surface-2)' : 'rgba(46,92,255,0.10)',
            color: active === 'all' ? 'var(--text-tertiary)' : 'var(--accent)',
            border: active === 'all' ? '1px solid var(--border-hairline)' : 'none',
          }}
        >
          {current.n}
        </span>
        <WIcon name="chevron-down" size={11} color="var(--text-tertiary)" />
      </button>
      {open && (
        <div
          className="scroll-thin overflow-auto absolute z-30"
          style={{
            top: 'calc(100% + 6px)',
            left: 0,
            width: 280,
            maxHeight: 460,
            background: 'var(--bg-surface)',
            border: '1px solid var(--border-hairline-strong)',
            borderRadius: 10,
            boxShadow: 'var(--shadow-popover)',
            padding: 6,
          }}
        >
          <div
            className="tw-label"
            style={{ fontSize: 10.5, padding: '6px 10px 4px' }}
          >
            Browse by category
          </div>
          {INTEGRATION_CATEGORIES.map((c) => {
            const isActive = active === c.id;
            return (
              <button
                key={c.id}
                type="button"
                onClick={() => {
                  onPick(c.id);
                  setOpen(false);
                }}
                onMouseEnter={(e) => {
                  if (!isActive) e.currentTarget.style.background = 'var(--bg-row-hover)';
                }}
                onMouseLeave={(e) => {
                  if (!isActive) e.currentTarget.style.background = 'transparent';
                }}
                className="focus-ring w-full flex items-center gap-2.5 font-sans cursor-pointer text-left"
                style={{
                  padding: '7px 10px',
                  borderRadius: 7,
                  border: 0,
                  background: isActive ? 'var(--bg-sidebar-active)' : 'transparent',
                  color: isActive ? 'var(--accent)' : 'var(--text-secondary)',
                  transition: 'background var(--dur-fast) var(--ease-out)',
                }}
              >
                <WIcon name={c.icon} size={14} />
                <span
                  className="flex-1 truncate"
                  style={{ fontSize: 12.5, fontWeight: isActive ? 600 : 500 }}
                >
                  {c.label}
                </span>
                <span
                  className="num text-center"
                  style={{
                    fontSize: 10.5,
                    fontWeight: 600,
                    color: isActive ? 'var(--accent)' : 'var(--text-tertiary)',
                    background: isActive ? 'rgba(46,92,255,0.10)' : 'var(--bg-surface-2)',
                    padding: '1px 6px',
                    borderRadius: 999,
                    minWidth: 24,
                  }}
                >
                  {c.n}
                </span>
              </button>
            );
          })}
        </div>
      )}
    </div>
  );
}

// ─── Toolbar ────────────────────────────────────────────────────────────

function Toolbar({
  q,
  onQ,
  cat,
  onCat,
  view,
  onView,
}: {
  q: string;
  onQ: (v: string) => void;
  cat: string;
  onCat: (v: string) => void;
  view: 'grid' | 'list';
  onView: (v: 'grid' | 'list') => void;
}) {
  return (
    <div
      className="flex items-center gap-2"
      style={{
        padding: '14px 28px',
        background: 'var(--bg-surface)',
        borderBottom: '1px solid var(--border-hairline)',
      }}
    >
      {/* Search */}
      <div
        className="inline-flex items-center gap-2"
        style={{
          flex: 1,
          maxWidth: 360,
          height: 32,
          padding: '0 10px',
          background: 'var(--bg-surface-2)',
          border: '1px solid var(--border-hairline)',
          borderRadius: 7,
          color: q ? 'var(--text-primary)' : 'var(--text-tertiary)',
        }}
      >
        <WIcon name="search" size={13} />
        <input
          value={q}
          onChange={(e) => onQ(e.target.value)}
          placeholder={`Search ${INTEGRATIONS_CATALOG.length} integrations…`}
          className="flex-1 bg-transparent border-0 outline-0 font-sans text-[12.5px]"
          style={{ color: 'inherit' }}
        />
        <Kbd>/</Kbd>
      </div>
      <CategoryDropdown active={cat} onPick={onCat} />
      <SelectMimic icon="sort-asc" label="Most popular" />
      <WBtn size="sm" leading="filter">
        Filter
      </WBtn>
      <div className="flex-1" />
      <div
        className="inline-flex items-center"
        style={{
          height: 28,
          padding: 2,
          borderRadius: 7,
          background: 'var(--bg-surface-2)',
          border: '1px solid var(--border-hairline)',
        }}
      >
        {(['grid', 'list'] as const).map((v) => {
          const active = view === v;
          return (
            <button
              key={v}
              type="button"
              onClick={() => onView(v)}
              className="focus-ring inline-flex items-center gap-1 font-sans cursor-pointer uppercase"
              style={{
                height: 22,
                padding: '0 8px',
                borderRadius: 5,
                background: active ? 'var(--bg-surface)' : 'transparent',
                color: active ? 'var(--text-primary)' : 'var(--text-tertiary)',
                boxShadow: active ? '0 1px 2px rgba(15,22,36,0.10)' : 'none',
                border: 0,
                fontSize: 11,
                fontWeight: 600,
                letterSpacing: 0.04,
              }}
            >
              <WIcon name={v === 'grid' ? 'columns' : 'menu'} size={11} />
              {v}
            </button>
          );
        })}
      </div>
    </div>
  );
}

function SelectMimic({ icon, label }: { icon: IconName; label: string }) {
  return (
    <button
      type="button"
      className="focus-ring inline-flex items-center gap-1.5 cursor-pointer font-sans font-medium"
      style={{
        height: 30,
        padding: '0 10px',
        borderRadius: 7,
        border: '1px solid var(--border-hairline-strong)',
        background: 'var(--bg-surface)',
        fontSize: 12,
        color: 'var(--text-secondary)',
      }}
    >
      <WIcon name={icon} size={12} color="var(--text-tertiary)" />
      <span>{label}</span>
      <WIcon name="chevron-down" size={11} color="var(--text-tertiary)" />
    </button>
  );
}

// ─── Tab strip ──────────────────────────────────────────────────────────

interface TabDef {
  id: 'marketplace' | 'connected' | 'updates' | 'api';
  label: string;
  n?: number;
  dot?: boolean;
}

function TabStrip({
  tabs,
  active,
  onPick,
  lastSync,
}: {
  tabs: TabDef[];
  active: TabDef['id'];
  onPick: (id: TabDef['id']) => void;
  lastSync: string;
}) {
  return (
    <div
      className="flex items-stretch"
      style={{
        padding: '0 28px',
        background: 'var(--bg-surface)',
        borderBottom: '1px solid var(--border-hairline)',
      }}
    >
      {tabs.map((t) => {
        const isActive = active === t.id;
        return (
          <button
            key={t.id}
            type="button"
            onClick={() => onPick(t.id)}
            className="focus-ring relative inline-flex items-center gap-2 cursor-pointer font-sans bg-transparent border-0"
            style={{
              height: 44,
              padding: '0 14px',
              color: isActive ? 'var(--text-primary)' : 'var(--text-secondary)',
              fontSize: 13,
              fontWeight: isActive ? 500 : 400,
              transition: 'color var(--dur-fast) var(--ease-out)',
            }}
          >
            <span>{t.label}</span>
            {t.n != null && <CountBadge n={t.n} tone={isActive ? 'accent' : 'neutral'} />}
            {t.dot && (
              <span
                className="rounded-full"
                style={{ width: 6, height: 6, background: 'var(--accent)' }}
              />
            )}
            <span
              aria-hidden
              className="absolute rounded-sm"
              style={{
                bottom: -1,
                left: 8,
                right: 8,
                height: 2,
                background: isActive ? 'var(--accent)' : 'transparent',
                transition: 'background var(--dur-fast) var(--ease-out)',
              }}
            />
          </button>
        );
      })}
      <div className="flex-1" />
      <div className="inline-flex items-center gap-2">
        <span className="text-[11.5px] text-[var(--text-tertiary)]">Last sync</span>
        <span className="num text-[12px] font-medium text-[var(--text-secondary)]">{lastSync}</span>
        <WBtn size="sm" leading="check">
          Sync all
        </WBtn>
      </div>
    </div>
  );
}

// ─── Featured strip ─────────────────────────────────────────────────────

function FeaturedStrip({
  recs,
  connectedSet,
  onOpen,
}: {
  recs: IntegrationCatalogEntry[];
  connectedSet: Set<string>;
  onOpen: (r: IntegrationCatalogEntry) => void;
}) {
  return (
    <div className="mb-4">
      <div className="flex items-center justify-between mb-2.5">
        <div>
          <div className="tw-label text-[10.5px] mb-0.5">
            Recommended for fleets like yours
          </div>
          <div className="text-[13.5px] font-semibold">Get connected in under 5 minutes</div>
        </div>
        <button
          type="button"
          className="focus-ring inline-flex items-center gap-1 bg-transparent border-0 cursor-pointer font-sans font-medium"
          style={{ fontSize: 12, color: 'var(--accent)' }}
        >
          See all recommendations <WIcon name="arrow-right" size={11} />
        </button>
      </div>
      <div className="grid gap-3" style={{ gridTemplateColumns: 'repeat(3, 1fr)' }}>
        {recs.slice(0, 3).map((r) => {
          const connected = connectedSet.has(r.id);
          return (
            <div
              key={r.id}
              onClick={() => onOpen(r)}
              className="flex items-center gap-3 cursor-pointer overflow-hidden relative"
              style={{
                background: 'var(--bg-surface)',
                border: '1px solid var(--border-hairline)',
                borderRadius: 10,
                padding: 14,
              }}
            >
              <MonoTile mono={r.mono} tint={r.tint} size={40} />
              <div className="flex-1 min-w-0">
                <div className="flex items-center gap-1.5">
                  <span className="text-[13.5px] font-semibold">{r.name}</span>
                  <Star size={10} />
                  <span className="num text-[11.5px] font-semibold">{r.rating.toFixed(1)}</span>
                </div>
                <div className="tw-meta text-[11.5px] mt-0.5 truncate">
                  {r.categoryLabel} · {r.installs} installs
                </div>
              </div>
              {connected ? (
                <span
                  className="inline-flex items-center gap-1 font-semibold"
                  style={{
                    height: 26,
                    padding: '0 10px',
                    borderRadius: 6,
                    background: 'rgba(16,185,129,0.10)',
                    color: '#0F8C5F',
                    fontSize: 12,
                  }}
                >
                  <WIcon name="check" size={11} />
                  Connected
                </span>
              ) : (
                <WBtn size="sm" variant="primary">
                  Connect
                </WBtn>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}

// ─── Paginator ──────────────────────────────────────────────────────────

function Paginator({
  total,
  showing,
}: {
  total: number;
  showing: number;
}) {
  return (
    <div
      className="flex items-center justify-between"
      style={{
        padding: '14px 28px',
        borderTop: '1px solid var(--border-hairline)',
        background: 'var(--bg-surface)',
      }}
    >
      <div className="text-[12px] text-[var(--text-tertiary)]">
        Showing{' '}
        <span className="num font-semibold" style={{ color: 'var(--text-secondary)' }}>
          {showing}
        </span>{' '}
        of{' '}
        <span className="num font-semibold" style={{ color: 'var(--text-secondary)' }}>
          {total}
        </span>{' '}
        integrations
      </div>
      <div className="inline-flex items-center gap-1">
        <PageBtn icon="chevron-left" disabled />
        <PageBtn label="1" active />
        <PageBtn label="2" />
        <PageBtn label="3" />
        <PageBtn label="…" disabled />
        <PageBtn label="15" />
        <PageBtn icon="chevron-right" />
      </div>
    </div>
  );
}

function PageBtn({
  label,
  icon,
  active,
  disabled,
}: {
  label?: string;
  icon?: IconName;
  active?: boolean;
  disabled?: boolean;
}) {
  return (
    <button
      type="button"
      disabled={disabled}
      className="focus-ring inline-flex items-center justify-center font-sans"
      style={{
        height: 28,
        minWidth: 28,
        padding: icon ? 0 : '0 10px',
        borderRadius: 6,
        border: active ? 0 : '1px solid var(--border-hairline)',
        background: active ? 'var(--accent)' : 'var(--bg-surface)',
        color: active ? '#fff' : disabled ? 'var(--text-tertiary)' : 'var(--text-secondary)',
        fontSize: 12,
        fontWeight: active ? 600 : 500,
        cursor: disabled ? 'not-allowed' : 'pointer',
        opacity: disabled ? 0.5 : 1,
      }}
    >
      {icon ? <WIcon name={icon} size={12} /> : <span className="num">{label}</span>}
    </button>
  );
}

// ─── Page ───────────────────────────────────────────────────────────────

export default function IntegrationsMarketplacePage() {
  const organizationId = useOrganizationId();
  const [tab, setTab] = useState<TabDef['id']>('marketplace');
  const [cat, setCat] = useState('all');
  const [q, setQ] = useState('');
  const [view, setView] = useState<'grid' | 'list'>('grid');
  const [manageRec, setManageRec] = useState<IntegrationCatalogEntry | null>(null);
  const [connectRec, setConnectRec] = useState<IntegrationCatalogEntry | null>(null);

  // Live connection state from Convex
  const connections = useQuery(
    api.integrations.getIntegrations,
    organizationId ? { workosOrgId: organizationId } : 'skip',
  );

  const connectedSet = useMemo(
    () => new Set((connections ?? []).map((c) => c.provider)),
    [connections],
  );

  /** Find the matching `orgIntegrations` row for a catalog entry. */
  const findConnection = (providerId: string): OrgIntegrationConnection | null => {
    const row = (connections ?? []).find((c) => c.provider === providerId);
    if (!row) return null;
    return {
      _id: row._id as unknown as string,
      _creationTime: row._creationTime,
      workosOrgId: row.workosOrgId,
      provider: row.provider,
      hasCredentials: row.hasCredentials,
      syncSettings: row.syncSettings,
      lastSyncStats: row.lastSyncStats,
      createdBy: row.createdBy,
      createdAt: row.createdAt,
      updatedAt: row.updatedAt,
    };
  };

  // Filtered catalog
  const visible = useMemo(() => {
    let list = INTEGRATIONS_CATALOG;
    if (tab === 'connected') list = list.filter((r) => connectedSet.has(r.id));
    if (cat !== 'all') list = list.filter((r) => r.category === cat);
    if (q) {
      const ql = q.toLowerCase();
      list = list.filter(
        (r) => r.name.toLowerCase().includes(ql) || r.description.toLowerCase().includes(ql),
      );
    }
    return list;
  }, [tab, cat, q, connectedSet]);

  const recommended = useMemo(
    () => INTEGRATIONS_CATALOG.filter((r) => r.popular && r.official),
    [],
  );
  const catLabel = INTEGRATION_CATEGORIES.find((c) => c.id === cat) || INTEGRATION_CATEGORIES[0];
  const totalForCat = catLabel.n;

  const tabs: TabDef[] = [
    { id: 'marketplace', label: 'Marketplace', n: INTEGRATIONS_CATALOG.length },
    { id: 'connected',   label: 'Connected',   n: connectedSet.size },
    { id: 'updates',     label: 'Updates' },
    { id: 'api',         label: 'API & webhooks' },
  ];

  const handleOpen = (rec: IntegrationCatalogEntry) => {
    if (connectedSet.has(rec.id)) {
      setManageRec(rec);
    } else {
      setConnectRec(rec);
    }
  };

  return (
    <>
      <div className="flex-1 overflow-hidden flex flex-col min-w-0">
        <SettingsHeader
          eyebrow="Settings · Marketplace"
          title="Integrations"
          subtitle={`Plug Otoqa into the tools your fleet already uses. ELDs, load boards, fuel cards, factoring, accounting — ${INTEGRATIONS_CATALOG.length} integrations across ${INTEGRATION_CATEGORIES.length - 1} categories, most ready in under five minutes.`}
          actions={
            <>
              <WBtn size="sm" leading="help">
                Integration docs
              </WBtn>
              <WBtn size="sm" variant="primary" leading="plus">
                Request integration
              </WBtn>
            </>
          }
        />

        <TabStrip tabs={tabs} active={tab} onPick={setTab} lastSync="2m ago" />

        <Toolbar
          q={q}
          onQ={setQ}
          cat={cat}
          onCat={setCat}
          view={view}
          onView={setView}
        />

        {/* Body */}
        <div
          className="scroll-thin flex-1 overflow-auto"
          style={{
            padding: '20px 28px 24px',
            background: 'var(--bg-canvas)',
          }}
        >
          {tab === 'marketplace' && cat === 'all' && !q && (
            <FeaturedStrip recs={recommended} connectedSet={connectedSet} onOpen={handleOpen} />
          )}

          {/* Section header */}
          <div className="flex items-baseline justify-between mb-3">
            <div>
              <div className="flex items-baseline gap-2 text-[15px] font-semibold">
                <span>
                  {tab === 'connected' ? 'Connected integrations' : catLabel.label}
                </span>
                <span
                  className="num"
                  style={{
                    fontSize: 12,
                    fontWeight: 500,
                    color: 'var(--text-tertiary)',
                  }}
                >
                  {tab === 'connected' ? connectedSet.size : totalForCat}
                </span>
              </div>
              {q && (
                <div className="text-[11.5px] text-[var(--text-tertiary)] mt-0.5">
                  Showing matches for "
                  <span style={{ color: 'var(--text-secondary)' }}>{q}</span>"
                </div>
              )}
            </div>
            {cat !== 'all' && (
              <button
                type="button"
                onClick={() => setCat('all')}
                className="focus-ring inline-flex items-center gap-1 bg-transparent border-0 cursor-pointer font-sans font-medium"
                style={{ fontSize: 12, color: 'var(--accent)' }}
              >
                Clear category <WIcon name="close" size={11} />
              </button>
            )}
          </div>

          {/* Grid */}
          <div
            className="grid gap-3"
            style={{
              gridTemplateColumns:
                view === 'list'
                  ? 'minmax(0, 1fr)'
                  : 'repeat(auto-fill, minmax(280px, 1fr))',
            }}
          >
            {visible.map((r) => (
              <IntegrationCard
                key={r.id}
                rec={r}
                connected={connectedSet.has(r.id)}
                onOpen={handleOpen}
              />
            ))}
          </div>

          {visible.length === 0 && (
            <div
              className="text-center"
              style={{
                padding: 60,
                background: 'var(--bg-surface)',
                border: '1px dashed var(--border-hairline-strong)',
                borderRadius: 10,
              }}
            >
              <div
                className="inline-flex items-center justify-center rounded-lg mb-2.5"
                style={{
                  width: 36,
                  height: 36,
                  background: 'var(--bg-surface-2)',
                  border: '1px solid var(--border-hairline)',
                  color: 'var(--text-tertiary)',
                }}
              >
                <WIcon name="search" size={16} />
              </div>
              <div className="text-[14px] font-semibold mb-1">No matches</div>
              <div
                className="text-[12px] leading-[18px]"
                style={{ color: 'var(--text-tertiary)' }}
              >
                Try a different search term, or{' '}
                <span style={{ color: 'var(--accent)', cursor: 'pointer' }}>
                  request this integration
                </span>
                .
              </div>
            </div>
          )}
        </div>

        <Paginator total={totalForCat} showing={Math.min(visible.length, 16)} />
      </div>

      {connectRec && organizationId && (
        <IntegrationConnectModal
          rec={connectRec}
          workosOrgId={organizationId}
          onClose={() => setConnectRec(null)}
          onConnected={(rec) => {
            // Smooth hand-off from Connect → Manage so the user sees their
            // freshly-connected integration's live state right away.
            setConnectRec(null);
            setManageRec(rec);
          }}
        />
      )}

      {manageRec && (
        <IntegrationManageModal
          rec={manageRec}
          workosOrgId={organizationId ?? null}
          connection={findConnection(manageRec.id)}
          onClose={() => setManageRec(null)}
        />
      )}
    </>
  );
}
