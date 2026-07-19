'use client';

/**
 * Pay profiles — list page.
 *
 * Settings landing for the new pay engine. Lists every payProfile in the
 * org with model chip, base rate, summary, in-use counts, and last edit.
 * Clicking a row → /org-settings/pay-profiles/{id}.
 *
 * Visual reference: Otoqa Web design — settings-screen.jsx > PayProfilesList.
 */

import * as React from 'react';
import Link from 'next/link';
import { useSearchParams } from 'next/navigation';
import { useQuery } from 'convex/react';
import { api } from '@/convex/_generated/api';
import { useOrganizationId } from '@/contexts/organization-context';
import { SettingsHeader } from '@/components/web/settings-header';
import { WBtn, WIcon, Avatar, CountBadge } from '@/components/web';
import { ModelTag } from '@/components/web/pay-profiles/model-tag';
import { PayPlansModal } from '@/components/web/pay-profiles/pay-plans-modal';
import {
  composeProfileSummary,
  formatPrimaryRate,
  type PayBasis,
  type RuleForSummary,
} from '@/lib/payProfileDisplay';

type FilterTab = 'active' | 'archived' | 'all';

export default function PayProfilesListPage() {
  const workosOrgId = useOrganizationId();
  const [filter, setFilter] = React.useState<FilterTab>('active');
  const [plansOpen, setPlansOpen] = React.useState(false);

  // The sidebar's "Pay plans" entry (and the old /org-settings/pay-plans
  // route) land here with ?pay-plans=open — the manager is a modal over this
  // page, not its own destination. Keyed on searchParams so the sidebar entry
  // also works while already on this page; the param is stripped afterward so
  // refresh/back is clean.
  const searchParams = useSearchParams();
  React.useEffect(() => {
    if (searchParams.get('pay-plans') === 'open') {
      setPlansOpen(true);
      const params = new URLSearchParams(searchParams.toString());
      params.delete('pay-plans');
      const qs = params.toString();
      window.history.replaceState(null, '', window.location.pathname + (qs ? `?${qs}` : ''));
    }
  }, [searchParams]);

  const data = useQuery(
    api.payProfiles.listForOrg,
    workosOrgId
      ? { workosOrgId, includeInactive: true }
      : 'skip',
  );

  if (data === undefined) {
    return <ListSkeleton />;
  }

  const profiles = data;
  const counts = {
    active: profiles.filter(p => p.isActive).length,
    archived: profiles.filter(p => !p.isActive).length,
    all: profiles.length,
  };
  const filtered =
    filter === 'all' ? profiles
    : filter === 'archived' ? profiles.filter(p => !p.isActive)
    : profiles.filter(p => p.isActive);

  return (
    <div className="flex-1 flex flex-col min-h-0 overflow-auto bg-[var(--bg-canvas)]">
      <SettingsHeader
        eyebrow="Payroll & money"
        title="Pay profiles"
        subtitle="Pre-defined compensation templates. Assign one as a driver or carrier's default. Changes here apply to every payee using the profile."
        actions={
          <>
            <WBtn
              size="sm"
              leading="calendar"
              title="Settlement cadences — how often each driver gets paid"
              onClick={() => setPlansOpen(true)}
            >
              Pay plans
            </WBtn>
            <WBtn size="sm" leading="import" disabled title="Import is coming soon">Import</WBtn>
            <Link href="/org-settings/pay-profiles/new">
              <WBtn size="sm" accent leading="plus">New profile</WBtn>
            </Link>
          </>
        }
      />

      <FilterTabs filter={filter} setFilter={setFilter} counts={counts} />

      <ProfilesTable rows={filtered} />

      <FooterHint />

      {plansOpen && <PayPlansModal onClose={() => setPlansOpen(false)} />}
    </div>
  );
}

// ============================================================================
// Filter tabs + toolbar (Active / Archived / All)
// ============================================================================

function FilterTabs({
  filter,
  setFilter,
  counts,
}: {
  filter: FilterTab;
  setFilter: (f: FilterTab) => void;
  counts: { active: number; archived: number; all: number };
}) {
  const tabs: Array<{ id: FilterTab; label: string; n: number }> = [
    { id: 'active',   label: 'Active',   n: counts.active },
    { id: 'archived', label: 'Archived', n: counts.archived },
    { id: 'all',      label: 'All',      n: counts.all },
  ];
  return (
    <div className="flex items-stretch px-7 bg-card border-b border-[var(--border-hairline)]">
      {tabs.map(t => {
        const active = filter === t.id;
        return (
          <button
            key={t.id}
            onClick={() => setFilter(t.id)}
            className="focus-ring relative inline-flex items-center gap-2 h-11 px-3.5 border-0 bg-transparent cursor-pointer"
            style={{
              color: active ? 'var(--text-primary)' : 'var(--text-secondary)',
              fontWeight: active ? 500 : 400,
              fontSize: 13,
            }}
          >
            <span>{t.label}</span>
            <CountBadge n={t.n} tone={active ? 'accent' : 'neutral'} />
            <span
              aria-hidden
              style={{
                position: 'absolute',
                bottom: -1,
                left: 8,
                right: 8,
                height: 2,
                background: active ? 'var(--accent)' : 'transparent',
                borderRadius: 2,
              }}
            />
          </button>
        );
      })}
      <div className="flex-1" />
      <div className="inline-flex items-center gap-2">
        <div
          className="inline-flex items-center gap-1.5 h-7 px-2.5 rounded-md"
          style={{
            background: 'var(--bg-surface-2)',
            border: '1px solid var(--border-hairline)',
            color: 'var(--text-tertiary)',
            fontSize: 12.5,
            width: 260,
          }}
        >
          <WIcon name="search" size={13} />
          <span>Search profiles…</span>
        </div>
        <WBtn size="sm" leading="filter">Filter</WBtn>
        <WBtn size="sm" leading="columns">Columns</WBtn>
      </div>
    </div>
  );
}

// ============================================================================
// Profiles table
// ============================================================================

const COLS = [
  { key: 'name',    label: 'Profile',    width: '1.6fr' },
  { key: 'model',   label: 'Model',      width: '110px' },
  { key: 'rate',    label: 'Base rate',  width: '160px' },
  { key: 'summary', label: 'Summary',    width: '1.8fr' },
  { key: 'inUse',   label: 'In use',     width: '180px' },
  { key: 'updated', label: 'Updated',    width: '170px' },
  { key: 'kebab',   label: '',           width: '36px' },
];
const GRID = COLS.map(c => c.width).join(' ');

type ProfileRow = {
  _id: string;
  name: string;
  payBasis: PayBasis;
  isActive: boolean;
  rules: RuleForSummary[];
  inUseDrivers: number;
  inUseCarriers: number;
  updatedAt: number;
  updatedByName: string;
};

function ProfilesTable({ rows }: { rows: ProfileRow[] }) {
  if (rows.length === 0) {
    return (
      <div className="flex-1 flex items-center justify-center bg-card py-24">
        <div className="text-center" style={{ color: 'var(--text-tertiary)' }}>
          <WIcon name="doc-dollar" size={32} />
          <div className="mt-2 text-[14px]">No pay profiles yet</div>
          <div className="text-[12px] mt-1">Create a profile to start configuring pay.</div>
        </div>
      </div>
    );
  }

  return (
    <div className="bg-card flex-1">
      <div
        className="grid border-b border-[var(--border-hairline)]"
        style={{ gridTemplateColumns: GRID, background: 'var(--bg-surface-2)' }}
      >
        {COLS.map((c, i) => (
          <div
            key={c.key}
            className="tw-label py-2.5"
            style={{
              paddingLeft: i === 0 ? 28 : 16,
              paddingRight: i === COLS.length - 1 ? 28 : 16,
              fontSize: 10.5,
              fontWeight: 600,
              letterSpacing: 0.04,
              textTransform: 'uppercase',
              color: 'var(--text-tertiary)',
            }}
          >
            {c.label}
          </div>
        ))}
      </div>
      {rows.map(p => (
        <ProfileRowCells key={p._id} row={p} />
      ))}
    </div>
  );
}

function ProfileRowCells({ row }: { row: ProfileRow }) {
  const archived = !row.isActive;
  const updatedDate = new Date(row.updatedAt).toLocaleDateString('en-US', {
    month: 'short', day: '2-digit', year: 'numeric',
  });

  return (
    <Link
      href={`/org-settings/pay-profiles/${row._id}`}
      className="grid border-b border-[var(--border-hairline)] bg-card hover:bg-[var(--bg-row-hover)] cursor-pointer transition-colors"
      style={{ gridTemplateColumns: GRID, opacity: archived ? 0.68 : 1 }}
    >
      <Cell first>
        <div className="flex items-center gap-2.5 min-w-0">
          <div
            className="inline-flex items-center justify-center w-7 h-7 rounded-md shrink-0"
            style={{
              background: 'var(--bg-surface-2)',
              border: '1px solid var(--border-hairline)',
              color: 'var(--text-secondary)',
            }}
          >
            <WIcon name="doc-dollar" size={14} />
          </div>
          <div className="min-w-0">
            <div className="text-[13px] font-semibold truncate">{row.name}</div>
            <div className="num text-[11.5px] mt-px" style={{ color: 'var(--text-tertiary)' }}>
              {row._id.slice(0, 12)}
            </div>
          </div>
        </div>
      </Cell>

      <Cell>
        <ModelTag payBasis={row.payBasis} />
      </Cell>

      <Cell>
        <span className="num text-[12.5px] font-medium">
          {formatPrimaryRate(row.rules)}
        </span>
      </Cell>

      <Cell>
        <span className="text-[12.5px]" style={{ color: 'var(--text-secondary)' }}>
          {composeProfileSummary(row.rules)}
        </span>
      </Cell>

      <Cell>
        {row.inUseDrivers > 0 || row.inUseCarriers > 0 ? (
          <span className="inline-flex items-baseline gap-1">
            <span className="num text-[13px] font-semibold">{row.inUseDrivers}</span>
            <span className="text-[11.5px]" style={{ color: 'var(--text-tertiary)' }}>
              driver{row.inUseDrivers === 1 ? '' : 's'}
            </span>
            {row.inUseCarriers > 0 && (
              <>
                <span className="text-[11.5px]" style={{ color: 'var(--text-tertiary)' }}>·</span>
                <span className="num text-[13px] font-semibold">{row.inUseCarriers}</span>
                <span className="text-[11.5px]" style={{ color: 'var(--text-tertiary)' }}>
                  carrier{row.inUseCarriers === 1 ? '' : 's'}
                </span>
              </>
            )}
          </span>
        ) : (
          <span className="text-[12px] italic" style={{ color: 'var(--text-tertiary)' }}>None</span>
        )}
      </Cell>

      <Cell>
        <div className="flex items-center gap-1.5 min-w-0">
          <div className="shrink-0">
            <Avatar name={row.updatedByName} size={20} />
          </div>
          <div className="min-w-0">
            <div className="num text-[12px] whitespace-nowrap" style={{ color: 'var(--text-secondary)' }}>{updatedDate}</div>
            <div className="text-[11px] truncate" style={{ color: 'var(--text-tertiary)' }} title={row.updatedByName}>
              by {row.updatedByName}
            </div>
          </div>
        </div>
      </Cell>

      <Cell align="right" last>
        <button
          onClick={e => { e.preventDefault(); e.stopPropagation(); }}
          className="focus-ring inline-flex items-center justify-center w-6 h-6 rounded border-0 bg-transparent cursor-pointer"
          style={{ color: 'var(--text-tertiary)' }}
        >
          <WIcon name="kebab-h" size={14} />
        </button>
      </Cell>
    </Link>
  );
}

function Cell({
  children,
  align,
  first,
  last,
}: {
  children: React.ReactNode;
  align?: 'right';
  first?: boolean;
  last?: boolean;
}) {
  return (
    <div
      className="flex items-center min-w-0 text-[13px]"
      style={{
        padding: `12px ${last ? 28 : 16}px 12px ${first ? 28 : 16}px`,
        justifyContent: align === 'right' ? 'flex-end' : 'flex-start',
        color: 'var(--text-primary)',
      }}
    >
      {children}
    </div>
  );
}

function FooterHint() {
  return (
    <div
      className="flex items-center gap-2 py-3 px-7 text-[12px] border-t border-[var(--border-hairline)]"
      style={{ background: 'var(--bg-surface-2)', color: 'var(--text-tertiary)' }}
    >
      <WIcon name="help" size={13} />
      <span>
        Edits to a profile retroactively apply to every payee using it. Need a one-off rate?{' '}
        <span style={{ color: 'var(--accent)', fontWeight: 500 }}>Duplicate this profile</span> instead.
      </span>
    </div>
  );
}

function ListSkeleton() {
  return (
    <div className="flex-1 flex flex-col bg-[var(--bg-canvas)]">
      <SettingsHeader
        eyebrow="Payroll & money"
        title="Pay profiles"
        subtitle="Loading…"
      />
      <div className="px-7 py-8">
        {Array.from({ length: 5 }).map((_, i) => (
          <div key={i} className="h-12 mb-2 rounded animate-pulse" style={{ background: 'var(--bg-surface-2)' }} />
        ))}
      </div>
    </div>
  );
}
