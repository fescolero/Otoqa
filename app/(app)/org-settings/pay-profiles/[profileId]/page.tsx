'use client';

/**
 * Pay profile — editor page.
 *
 * Single profile editor with:
 *   - Header (breadcrumb back, name + status chip, edit metadata, actions)
 *   - Tab strip: Rates & accessorials / Bonuses / Deductions / Tax / History
 *   - Two-column body: form (left) + "Using this profile" + Audit (right rail)
 *
 * Visual reference: settings-screen.jsx > PayProfileEditor.
 */

import * as React from 'react';
import Link from 'next/link';
import { notFound, useParams } from 'next/navigation';
import { useQuery, useMutation } from 'convex/react';
import { api } from '@/convex/_generated/api';
import type { Id, Doc } from '@/convex/_generated/dataModel';
import { SettingsHeader } from '@/components/web/settings-header';
import {
  WBtn,
  WIcon,
  Chip,
  DSCard,
  DSPropsEditable,
  Avatar,
  type DSPropsEditableItem,
} from '@/components/web';
import { RatesTable } from '@/components/web/pay-profiles/rates-table';
import { ModelTag } from '@/components/web/pay-profiles/model-tag';
import { AddLineItemModal } from '@/components/web/pay-profiles/add-line-item-modal';
import { useOrganizationId } from '@/contexts/organization-context';

type TabId = 'rates' | 'bonus' | 'deductions' | 'tax' | 'history';

const TABS: Array<{ id: TabId; label: string }> = [
  { id: 'rates',      label: 'Rates & accessorials' },
  { id: 'bonus',      label: 'Bonuses & adjustments' },
  { id: 'deductions', label: 'Deductions' },
  { id: 'tax',        label: 'Tax & reporting' },
  { id: 'history',    label: 'History' },
];

export default function PayProfileEditorPage() {
  const params = useParams<{ profileId: string }>();
  const profileId = params.profileId as Id<'payProfiles'>;
  const workosOrgId = useOrganizationId();
  const [activeTab, setActiveTab] = React.useState<TabId>('rates');
  const [addLineOpen, setAddLineOpen] = React.useState(false);

  const profile = useQuery(api.payProfiles.get, profileId ? { profileId } : 'skip');
  const updateProfile = useMutation(api.payProfiles.update);
  const archive = useMutation(api.payProfiles.archive);
  const restore = useMutation(api.payProfiles.restore);
  const duplicate = useMutation(api.payProfiles.duplicate);

  if (profile === undefined) return <EditorSkeleton />;
  if (profile === null) {
    // Not found OR not authorized
    return notFound();
  }

  return (
    <div className="flex-1 flex flex-col min-h-0 overflow-auto bg-[var(--bg-canvas)]">
      <SettingsHeader
        breadcrumb={
          <>
            <Link
              href="/org-settings/pay-profiles"
              className="focus-ring inline-flex items-center gap-1 px-0 border-0 bg-transparent cursor-pointer text-[12px] text-[var(--text-tertiary)] hover:text-[var(--text-primary)]"
            >
              <WIcon name="chevron-left" size={12} /> Pay profiles
            </Link>
            <WIcon name="breadcrumb-sep" size={10} />
            <span style={{ color: 'var(--text-secondary)' }}>{profile.name}</span>
          </>
        }
        title={
          <span className="inline-flex items-center gap-3 flex-wrap">
            <span>{profile.name}</span>
            <Chip status={profile.isActive ? 'active' : 'inactive'} />
            <ModelTag payBasis={profile.payBasis} />
          </span>
        }
        subtitle={
          <span>
            Used by {profile.inUseDrivers} driver{profile.inUseDrivers === 1 ? '' : 's'}
            {profile.inUseCarriers > 0 && (
              <>
                {' '}and {profile.inUseCarriers} carrier{profile.inUseCarriers === 1 ? '' : 's'}
              </>
            )}
            . Last edited {new Date(profile.updatedAt).toLocaleString('en-US', {
              month: 'short', day: '2-digit', year: 'numeric',
            })}.
          </span>
        }
        actions={
          <>
            <WBtn size="sm" leading="copy" onClick={async () => { await duplicate({ profileId }); }}>
              Duplicate
            </WBtn>
            {profile.isActive ? (
              <WBtn size="sm" leading="archive" onClick={async () => { await archive({ profileId }); }}>
                Archive
              </WBtn>
            ) : (
              <WBtn size="sm" leading="restore" onClick={async () => { await restore({ profileId }); }}>
                Restore
              </WBtn>
            )}
          </>
        }
      />

      {/* Tabs */}
      <div className="flex px-7 bg-card border-b border-[var(--border-hairline)]">
        {TABS.map(t => {
          const active = activeTab === t.id;
          return (
            <button
              key={t.id}
              onClick={() => setActiveTab(t.id)}
              className="focus-ring relative h-[38px] px-3.5 border-0 bg-transparent cursor-pointer"
              style={{
                fontSize: 12.5,
                fontWeight: active ? 600 : 500,
                color: active ? 'var(--text-primary)' : 'var(--text-tertiary)',
              }}
            >
              {t.label}
              {active && (
                <span
                  aria-hidden
                  style={{
                    position: 'absolute',
                    left: 8,
                    right: 8,
                    bottom: -1,
                    height: 2,
                    background: 'var(--accent)',
                    borderRadius: 2,
                  }}
                />
              )}
            </button>
          );
        })}
      </div>

      {/* Body — two columns */}
      <div
        className="flex-1 grid gap-6 p-6"
        style={{ gridTemplateColumns: 'minmax(0, 1fr) 340px', alignItems: 'start' }}
      >
        <div className="flex flex-col gap-4 min-w-0">
          <IdentityCard profile={profile} onCommit={async (patch) => {
            await updateProfile({ profileId, patch });
          }} />

          {activeTab === 'rates' && (
            <DSCard
              title={
                <span className="inline-flex items-center gap-2">
                  <span>Rates & accessorials</span>
                  <span className="text-[11px] font-normal" style={{ color: 'var(--text-tertiary)' }}>
                    · {profile.rules.length} rate line{profile.rules.length === 1 ? '' : 's'}
                  </span>
                </span>
              }
              bodyClassName="p-0"
            >
              <RatesTable
                rules={profile.rules}
                onAddLineItem={() => setAddLineOpen(true)}
              />
            </DSCard>
          )}

          {activeTab === 'history' && (
            <DSCard title="History">
              <HistoryTab profileId={profileId} />
            </DSCard>
          )}

          {activeTab !== 'rates' && activeTab !== 'history' && (
            <DSCard title={TABS.find(t => t.id === activeTab)!.label}>
              <ComingSoonTab tab={activeTab} />
            </DSCard>
          )}
        </div>

        {/* Right rail */}
        <div className="flex flex-col gap-4" style={{ position: 'sticky', top: 0 }}>
          <UsingProfileCard profileId={profileId} totals={profile} />
        </div>
      </div>

      {addLineOpen && workosOrgId && (
        <AddLineItemModal
          profileId={profileId}
          workosOrgId={workosOrgId}
          onClose={() => setAddLineOpen(false)}
        />
      )}
    </div>
  );
}

// ============================================================================
// Identity card (Name, Description, Currency)
// ============================================================================

function IdentityCard({
  profile,
  onCommit,
}: {
  profile: Doc<'payProfiles'>;
  onCommit: (patch: Partial<Doc<'payProfiles'>>) => Promise<void>;
}) {
  const items: DSPropsEditableItem[] = [
    {
      key: 'name',
      label: 'Name',
      value: profile.name,
      editor: { type: 'text' },
    },
    {
      key: 'description',
      label: 'Description',
      value: profile.description ?? '',
      editor: { type: 'textarea' },
    },
    {
      key: 'currency',
      label: 'Currency',
      value: profile.currency,
      editor: {
        type: 'select',
        options: [
          { value: 'USD', label: 'USD' },
          { value: 'CAD', label: 'CAD' },
          { value: 'MXN', label: 'MXN' },
        ],
      },
    },
  ];

  return (
    <DSCard title="Profile identity">
      <DSPropsEditable
        items={items}
        onCommit={async (key, value) => {
          if (key === 'name') await onCommit({ name: String(value) });
          else if (key === 'description') await onCommit({ description: String(value) });
          else if (key === 'currency') await onCommit({ currency: value as 'USD' | 'CAD' | 'MXN' });
        }}
      />
    </DSCard>
  );
}

// ============================================================================
// "Using this profile" right rail card
// ============================================================================

function UsingProfileCard({
  profileId,
  totals,
}: {
  profileId: Id<'payProfiles'>;
  totals: { inUseDrivers: number; inUseCarriers: number };
}) {
  const assignees = useQuery(api.payProfiles.listAssignedPayees, { profileId });

  return (
    <DSCard
      title={
        <span className="inline-flex items-center gap-2">
          <span>Using this profile</span>
          <span className="text-[11px] font-normal" style={{ color: 'var(--text-tertiary)' }}>
            · {totals.inUseDrivers} driver{totals.inUseDrivers === 1 ? '' : 's'} · {totals.inUseCarriers} carrier{totals.inUseCarriers === 1 ? '' : 's'}
          </span>
        </span>
      }
      bodyClassName="p-0"
    >
      {assignees === undefined ? (
        <div className="px-3.5 py-3 text-[12px]" style={{ color: 'var(--text-tertiary)' }}>
          Loading…
        </div>
      ) : assignees.drivers.length + assignees.carriers.length === 0 ? (
        <div className="px-3.5 py-4 text-[12px] italic" style={{ color: 'var(--text-tertiary)' }}>
          No payees assigned yet.
        </div>
      ) : (
        <div>
          {assignees.drivers.slice(0, 5).map((d, i) => (
            <div
              key={d.assignmentId}
              className="flex items-center gap-2.5 py-2 px-3.5"
              style={{ borderTop: i === 0 ? 'none' : '1px solid var(--border-hairline)' }}
            >
              <Avatar name={`${d.firstName} ${d.lastName}`} size={24} />
              <div className="min-w-0 flex-1">
                <div className="text-[12.5px] font-medium truncate">{d.firstName} {d.lastName}</div>
                <div className="text-[11px]" style={{ color: 'var(--text-tertiary)' }}>
                  {d.isDefault ? 'Default' : 'Override'}
                </div>
              </div>
              <WIcon name="arrow-right" size={12} />
            </div>
          ))}
          {assignees.carriers.slice(0, 3).map((c, i) => (
            <div
              key={c.assignmentId}
              className="flex items-center gap-2.5 py-2 px-3.5"
              style={{
                borderTop:
                  assignees.drivers.length === 0 && i === 0
                    ? 'none'
                    : '1px solid var(--border-hairline)',
              }}
            >
              <div
                className="inline-flex items-center justify-center w-6 h-6 rounded shrink-0"
                style={{
                  background: 'var(--bg-surface-2)',
                  border: '1px solid var(--border-hairline)',
                  color: 'var(--text-secondary)',
                }}
              >
                <WIcon name="handshake" size={13} />
              </div>
              <div className="min-w-0 flex-1">
                <div className="text-[12.5px] font-medium truncate">{c.carrierName}</div>
                <div className="num text-[11px]" style={{ color: 'var(--text-tertiary)' }}>
                  {c.mcNumber ?? '—'}
                </div>
              </div>
              <WIcon name="arrow-right" size={12} />
            </div>
          ))}
        </div>
      )}
    </DSCard>
  );
}

// ============================================================================
// History tab — chronological audit log for the profile + its rules
// ============================================================================

function HistoryTab({ profileId }: { profileId: Id<'payProfiles'> }) {
  const entries = useQuery(api.payProfiles.getProfileHistory, { profileId });

  if (entries === undefined) {
    return (
      <div className="py-6 text-[12.5px]" style={{ color: 'var(--text-tertiary)' }}>
        Loading history…
      </div>
    );
  }
  if (entries.length === 0) {
    return (
      <div className="py-6 text-[12.5px]" style={{ color: 'var(--text-tertiary)' }}>
        No history yet. Every edit to this profile or its rules will appear here.
      </div>
    );
  }

  // Group entries by calendar day for visual scanning.
  const groups: Array<{ label: string; rows: typeof entries }> = [];
  for (const e of entries) {
    const label = new Date(e.timestamp).toLocaleDateString('en-US', {
      month: 'short', day: '2-digit', year: 'numeric',
    });
    const last = groups[groups.length - 1];
    if (last && last.label === label) last.rows.push(e);
    else groups.push({ label, rows: [e] });
  }

  return (
    <div className="flex flex-col gap-4">
      {groups.map(g => (
        <div key={g.label}>
          <div
            className="tw-label mb-2 text-[10.5px]"
            style={{
              fontWeight: 600,
              letterSpacing: 0.04,
              textTransform: 'uppercase',
              color: 'var(--text-tertiary)',
            }}
          >
            {g.label}
          </div>
          <div className="flex flex-col">
            {g.rows.map(e => (
              <AuditEntry key={e._id} entry={e} />
            ))}
          </div>
        </div>
      ))}
    </div>
  );
}

function AuditEntry({
  entry,
}: {
  entry: {
    _id: string;
    entityType: 'payProfile' | 'payRule';
    action: string;
    description?: string;
    performedBy: string;
    performedByName?: string;
    performedByEmail?: string;
    timestamp: number;
  };
}) {
  const time = new Date(entry.timestamp).toLocaleTimeString('en-US', {
    hour: 'numeric', minute: '2-digit',
  });
  const who = entry.performedByName ?? entry.performedByEmail ?? entry.performedBy;
  const dotColor = entry.entityType === 'payProfile' ? 'var(--accent)' : '#7C3AED';

  return (
    <div className="flex gap-2.5 py-1.5 items-start">
      <span
        style={{
          width: 8,
          height: 8,
          borderRadius: 999,
          marginTop: 6,
          background: dotColor,
          opacity: 0.7,
          flexShrink: 0,
        }}
      />
      <div className="min-w-0">
        <div className="text-[12.5px]" style={{ color: 'var(--text-primary)', lineHeight: '17px' }}>
          {entry.description ?? entry.action}
        </div>
        <div className="text-[11px] mt-px" style={{ color: 'var(--text-tertiary)' }}>
          {who} · <span className="num">{time}</span>
        </div>
      </div>
    </div>
  );
}

// ============================================================================
// Coming-soon panel for tabs not yet wired
// ============================================================================

function ComingSoonTab({ tab }: { tab: TabId }) {
  const messages: Record<TabId, string> = {
    rates: '',
    history: '',
    bonus:
      'Bonuses, sign-on payments, and one-off adjustments will be configured here. Today these can be added per-settlement as manual line items.',
    deductions:
      'Truck lease, insurance, advances, and other deductions will be configured here. The new ledger supports per-rule deduction priority and CCPA limits.',
    tax:
      'Where each component shows up on quarterly + year-end reports (W-2 boxes, 1099 boxes, certified payroll columns).',
  };
  return (
    <div className="py-6 px-2 text-[12.5px]" style={{ color: 'var(--text-tertiary)' }}>
      <div className="flex items-center gap-2 mb-2" style={{ color: 'var(--text-secondary)' }}>
        <WIcon name="info" size={14} />
        <span className="font-medium">Coming soon</span>
      </div>
      <p className="leading-relaxed">{messages[tab]}</p>
    </div>
  );
}

function EditorSkeleton() {
  return (
    <div className="flex-1 flex flex-col bg-[var(--bg-canvas)]">
      <SettingsHeader title="Pay profile" subtitle="Loading…" />
      <div className="p-6 grid gap-6" style={{ gridTemplateColumns: 'minmax(0, 1fr) 340px' }}>
        <div className="flex flex-col gap-4">
          {Array.from({ length: 3 }).map((_, i) => (
            <div
              key={i}
              className="h-32 rounded animate-pulse"
              style={{ background: 'var(--bg-surface-2)' }}
            />
          ))}
        </div>
        <div
          className="h-64 rounded animate-pulse"
          style={{ background: 'var(--bg-surface-2)' }}
        />
      </div>
    </div>
  );
}
