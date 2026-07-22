'use client';

/**
 * Settings → Team & roles — Roles tab + role editor.
 *
 * Role cards (permission fingerprint, member count) and the capability
 * matrix editor. Preset roles are WorkOS ENVIRONMENT roles — shared across
 * orgs and read-only here ("System"); editing happens on org-scoped custom
 * roles (created blank or duplicated from any role). Matrix changes
 * auto-save through PATCH /api/team/roles/[slug].
 *
 * Visual reference: Otoqa Web design — settings-team.jsx (Roles tab +
 * RoleEditor). Deliberate deltas: no Driver pseudo-role card (drivers are
 * a mobile-app concept managed under Fleet, not a WorkOS role) and no
 * Constraints card yet (needs the enforcement phase's sidecar).
 */

import * as React from 'react';
import { useEffect, useState } from 'react';
import { toast } from 'sonner';

import { Avatar, DSCard, SettingsHeader, WBtn, WIcon, type IconName } from '@/components/web';
import type { TeamMemberDTO, TeamRoleDTO } from '@/lib/team-types';
import {
  PERM_AREAS,
  PERM_LEVELS,
  PERM_LEVEL_RANK,
  matrixFromPermissions,
  type PermLevel,
  type PermMatrix,
} from '@/lib/team-rbac';

// Role tone/icon mapping is shared with the members tab via the page.
export interface RoleVisual {
  tone: string;
  icon: IconName;
}

function SectionTitle({ children, sub }: { children: React.ReactNode; sub?: React.ReactNode }) {
  return (
    <div>
      <div className="text-[14px] font-semibold leading-tight" style={{ letterSpacing: -0.005 }}>
        {children}
      </div>
      {sub && <div className="mt-0.5 text-[11.5px] text-[var(--text-tertiary)]">{sub}</div>}
    </div>
  );
}

function SystemBadge({ large }: { large?: boolean }) {
  return (
    <span
      className="uppercase font-semibold text-[var(--text-tertiary)] bg-[var(--bg-surface-2)] border border-[var(--border-hairline)]"
      style={{
        fontSize: large ? 10.5 : 10,
        letterSpacing: 0.03,
        padding: large ? '2px 7px' : '1px 6px',
        borderRadius: large ? 6 : 5,
      }}
    >
      System{large ? ' role' : ''}
    </span>
  );
}

/** One 16px dot per area, filled by level — the role card fingerprint. */
function PermFingerprint({ permissions, tone }: { permissions: string[]; tone: string }) {
  const matrix = matrixFromPermissions(permissions);
  return (
    <div className="flex items-center gap-[5px]">
      {PERM_AREAS.map((a) => {
        const lvl = matrix[a.id];
        const rank = PERM_LEVEL_RANK[lvl];
        const on = rank > 0;
        const bg = on ? tone + (rank >= 3 ? '' : rank === 2 ? 'D9' : '73') : 'var(--bg-surface-2)';
        return (
          <span
            key={a.id}
            title={`${a.label}: ${PERM_LEVELS.find((l) => l.value === lvl)?.label}`}
            className="inline-flex h-4 w-4 items-center justify-center rounded-[5px]"
            style={{
              background: bg,
              border: on ? 'none' : '1px solid var(--border-hairline)',
            }}
          >
            <WIcon name={a.icon as IconName} size={9} color={on ? '#fff' : 'var(--text-tertiary)'} />
          </span>
        );
      })}
    </div>
  );
}

// ─── Role cards grid ──────────────────────────────────────────────────────

export function RolesTab({
  roles,
  rbacAvailable,
  seeding,
  canManage,
  visual,
  memberCountFor,
  onOpenRole,
  onCreateRole,
}: {
  roles: TeamRoleDTO[];
  rbacAvailable: boolean;
  seeding: boolean;
  /** team:manage — without it the tab is read-only (server enforces too). */
  canManage: boolean;
  visual: (slug: string) => RoleVisual;
  memberCountFor: (slug: string) => number;
  onOpenRole: (slug: string) => void;
  onCreateRole: () => void;
}) {
  if (!rbacAvailable) {
    return (
      <div className="flex-1 p-6" style={{ background: 'var(--bg-canvas)' }}>
        <div className="mx-auto max-w-[560px] rounded-xl border border-[var(--border-hairline)] bg-[var(--bg-surface)] p-8 text-center">
          <div className="mb-3 inline-flex h-10 w-10 items-center justify-center rounded-[10px] bg-[var(--bg-surface-2)] text-[var(--text-tertiary)]">
            <WIcon name="shield" size={18} />
          </div>
          <div className="mb-1 text-[14px] font-semibold">Role management unavailable</div>
          <div className="text-[12.5px] leading-[18px] text-[var(--text-tertiary)]">
            The WorkOS authorization API couldn&rsquo;t be reached for this environment. Members can
            still be assigned the roles that already exist; the permission editor needs RBAC
            enabled on your WorkOS account.
          </div>
        </div>
      </div>
    );
  }

  if (seeding) {
    return (
      <div className="flex-1 p-6" style={{ background: 'var(--bg-canvas)' }}>
        <div className="grid gap-3.5" style={{ gridTemplateColumns: 'repeat(3, minmax(0, 1fr))' }}>
          {[0, 1, 2, 3, 4].map((i) => (
            <div
              key={i}
              className="animate-pulse h-[132px] rounded-xl border border-[var(--border-hairline)] bg-[var(--bg-surface)]"
            />
          ))}
        </div>
        <div className="mt-4 text-center text-[12px] text-[var(--text-tertiary)]">
          Setting up the permission catalog and preset roles…
        </div>
      </div>
    );
  }

  return (
    <div className="flex-1 p-6" style={{ background: 'var(--bg-canvas)' }}>
      <div className="grid gap-3.5" style={{ gridTemplateColumns: 'repeat(auto-fill, minmax(300px, 1fr))' }}>
      {roles.map((role) => {
        const v = visual(role.slug);
        const count = memberCountFor(role.slug);
        const matrix = matrixFromPermissions(role.permissions);
        const manageAreas = PERM_AREAS.filter((a) => matrix[a.id] === 'manage').length;
        return (
          <button
            key={role.slug}
            type="button"
            onClick={() => onOpenRole(role.slug)}
            className="focus-ring group flex flex-col gap-3 rounded-xl border border-[var(--border-hairline)] bg-[var(--bg-surface)] p-4 text-left transition-transform hover:-translate-y-px hover:border-[var(--border-hairline-strong)]"
          >
            <div className="flex items-start gap-3">
              <span
                className="inline-flex h-[38px] w-[38px] shrink-0 items-center justify-center rounded-[10px]"
                style={{ background: v.tone + '14', color: v.tone }}
              >
                <WIcon name={v.icon} size={19} color={v.tone} />
              </span>
              <div className="min-w-0 flex-1">
                <div className="flex items-center gap-2">
                  <span className="text-[14.5px] font-semibold" style={{ letterSpacing: -0.005 }}>
                    {role.name}
                  </span>
                  {role.type === 'environment' && <SystemBadge />}
                </div>
                <div className="mt-0.5 text-[12px] leading-[17px] text-[var(--text-tertiary)] line-clamp-2">
                  {role.description ?? 'No description yet.'}
                </div>
              </div>
            </div>

            <PermFingerprint permissions={role.permissions} tone={v.tone} />

            <div className="mt-px flex items-center justify-between border-t border-[var(--border-hairline)] pt-[11px]">
              <span className="inline-flex items-baseline gap-1.5">
                <span className="num text-[15px] font-semibold">{count}</span>
                <span className="text-[11.5px] text-[var(--text-tertiary)]">
                  member{count === 1 ? '' : 's'}
                </span>
              </span>
              <span className="inline-flex items-center gap-1.5 text-[12px] font-medium text-[var(--text-secondary)] group-hover:text-[var(--accent)]">
                {manageAreas >= PERM_AREAS.length
                  ? 'Full access'
                  : `${manageAreas} area${manageAreas === 1 ? '' : 's'} manage`}
                <WIcon name="arrow-right" size={12} />
              </span>
            </div>
          </button>
        );
      })}

      {canManage && (
      <button
        type="button"
        onClick={onCreateRole}
        className="focus-ring flex min-h-[116px] items-center gap-3 rounded-xl border border-dashed border-[var(--border-hairline-strong)] p-4 text-left text-[var(--text-secondary)] hover:bg-[var(--bg-surface)] hover:text-[var(--text-primary)]"
      >
        <span className="inline-flex h-[38px] w-[38px] shrink-0 items-center justify-center rounded-[10px] bg-[var(--bg-surface-2)] text-[var(--text-tertiary)]">
          <WIcon name="plus" size={18} />
        </span>
        <span>
          <span className="block text-[13.5px] font-semibold">Create custom role</span>
          <span className="mt-0.5 block text-[12px] text-[var(--text-tertiary)]">
            Start from an existing role&rsquo;s permissions.
          </span>
        </span>
      </button>
      )}
      </div>
    </div>
  );
}

// ─── Segmented level picker ───────────────────────────────────────────────

function PermSeg({
  value,
  disabled,
  onChange,
}: {
  value: PermLevel;
  disabled?: boolean;
  onChange: (level: PermLevel) => void;
}) {
  return (
    <div
      className="inline-flex h-[30px] items-stretch overflow-hidden rounded-lg border border-[var(--border-hairline-strong)] bg-[var(--bg-surface)]"
      style={{ opacity: disabled ? 0.5 : 1, pointerEvents: disabled ? 'none' : 'auto' }}
    >
      {PERM_LEVELS.map((lvl, i) => {
        const active = value === lvl.value;
        return (
          <button
            key={lvl.value}
            type="button"
            onClick={() => onChange(lvl.value)}
            className="focus-ring min-w-[46px] px-2.5 text-[12px]"
            style={{
              borderLeft: i === 0 ? 'none' : '1px solid var(--border-hairline-strong)',
              background: active ? 'var(--accent)' : 'transparent',
              color: active ? '#fff' : 'var(--text-secondary)',
              fontWeight: active ? 600 : 500,
            }}
          >
            {lvl.label}
          </button>
        );
      })}
    </div>
  );
}

// ─── Role editor ──────────────────────────────────────────────────────────

export function RoleEditorView({
  role,
  roles,
  holders,
  canManage,
  visual,
  onBack,
  onOpenRole,
  onDuplicate,
  onDelete,
  onChanged,
}: {
  role: TeamRoleDTO;
  roles: TeamRoleDTO[];
  holders: TeamMemberDTO[];
  /** team:manage — without it the matrix and actions are read-only. */
  canManage: boolean;
  visual: (slug: string) => RoleVisual;
  onBack: () => void;
  onOpenRole: (slug: string) => void;
  onDuplicate: (role: TeamRoleDTO) => void;
  onDelete: (role: TeamRoleDTO) => void;
  onChanged: () => Promise<void>;
}) {
  const v = visual(role.slug);
  const system = role.type === 'environment';
  const readOnly = system || !canManage;
  const [matrix, setMatrix] = useState<PermMatrix>(() => matrixFromPermissions(role.permissions));
  const [saving, setSaving] = useState(0);
  useEffect(() => setMatrix(matrixFromPermissions(role.permissions)), [role.slug, role.permissions]);

  const setArea = async (areaId: string, level: PermLevel) => {
    const next = { ...matrix, [areaId]: level };
    setMatrix(next);
    setSaving((n) => n + 1);
    try {
      const res = await fetch(`/api/team/roles/${encodeURIComponent(role.slug)}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ matrix: next }),
      });
      if (!res.ok) {
        const body = (await res.json().catch(() => ({}))) as { error?: string };
        throw new Error(body.error ?? 'Failed to save');
      }
      await onChanged();
    } catch (error) {
      toast.error(error instanceof Error ? error.message : 'Failed to save');
      setMatrix(matrixFromPermissions(role.permissions));
    } finally {
      setSaving((n) => n - 1);
    }
  };

  return (
    <>
      <SettingsHeader
        breadcrumb={
          <>
            <button
              type="button"
              onClick={onBack}
              className="focus-ring inline-flex items-center gap-1 text-[12px] text-[var(--text-tertiary)] hover:text-[var(--text-primary)]"
            >
              <WIcon name="chevron-left" size={12} /> Roles
            </button>
            <WIcon name="breadcrumb-sep" size={10} />
            <span className="text-[var(--text-secondary)]">{role.name}</span>
          </>
        }
        title={
          <span className="inline-flex flex-wrap items-center gap-3">
            <span className="inline-flex items-center gap-2.5">
              <span
                className="inline-flex h-[30px] w-[30px] items-center justify-center rounded-lg"
                style={{ background: v.tone + '14', color: v.tone }}
              >
                <WIcon name={v.icon} size={16} color={v.tone} />
              </span>
              {role.name}
            </span>
            {system && <SystemBadge large />}
          </span>
        }
        subtitle={role.description ?? undefined}
        actions={
          <>
            <span className="inline-flex items-center gap-1.5 text-[11.5px] text-[var(--text-tertiary)]">
              <span
                className="inline-block h-1.5 w-1.5 rounded-full"
                style={{ background: saving > 0 ? '#F59E0B' : '#10B981' }}
              />
              {saving > 0 ? 'Saving…' : 'All changes saved'}
            </span>
            {canManage && (
              <WBtn size="sm" leading="copy" onClick={() => onDuplicate(role)}>
                Duplicate
              </WBtn>
            )}
            {!system && canManage && (
              <WBtn
                size="sm"
                danger
                leading="trash"
                onClick={() => onDelete(role)}
                disabled={holders.length > 0}
                title={holders.length > 0 ? 'Reassign its members first' : undefined}
              >
                Delete
              </WBtn>
            )}
          </>
        }
      />

      <div
        className="scroll-thin grid flex-1 items-start gap-6 overflow-auto p-6"
        style={{ gridTemplateColumns: 'minmax(0, 1fr) 320px', background: 'var(--bg-canvas)' }}
      >
        {/* Matrix */}
        <div className="flex min-w-0 flex-col gap-4">
          <DSCard
            title={
              <SectionTitle sub="Set what this role can do in each area. Manage includes create, edit, and delete plus area-level settings.">
                Permissions by area
              </SectionTitle>
            }
            bodyClassName="p-0"
          >
            {system && (
              <div
                className="flex items-center gap-2 border-b border-[var(--border-hairline)] px-4 py-2.5 text-[12px] text-[var(--text-secondary)]"
                style={{ background: 'rgba(46,92,255,0.05)' }}
              >
                <WIcon name="shield" size={13} color="var(--accent)" />
                System roles are fixed and shared by every workspace. Duplicate this role to make
                an editable copy.
              </div>
            )}
            {PERM_AREAS.map((a, i) => (
              <div
                key={a.id}
                className="flex items-center gap-3 px-4 py-3"
                style={{ borderTop: i === 0 ? 'none' : '1px solid var(--border-hairline)' }}
              >
                <span className="inline-flex h-[30px] w-[30px] shrink-0 items-center justify-center rounded-lg border border-[var(--border-hairline)] bg-[var(--bg-surface-2)] text-[var(--text-secondary)]">
                  <WIcon name={a.icon as IconName} size={15} />
                </span>
                <div className="min-w-0 flex-1">
                  <div className="truncate text-[13px] font-semibold">{a.label}</div>
                  <div className="mt-px truncate text-[11.5px] text-[var(--text-tertiary)]">{a.hint}</div>
                </div>
                <div className="shrink-0">
                  <PermSeg value={matrix[a.id]} disabled={readOnly} onChange={(lvl) => void setArea(a.id, lvl)} />
                </div>
              </div>
            ))}
          </DSCard>
        </div>

        {/* Rail */}
        <div className="sticky top-0 flex flex-col gap-4">
          <DSCard
            title={<SectionTitle sub="People currently assigned this role.">{`Members (${holders.length})`}</SectionTitle>}
            bodyClassName="p-0"
          >
            {holders.length === 0 ? (
              <div className="px-3.5 py-4 text-center text-[12.5px] text-[var(--text-tertiary)]">
                No one holds this role yet.
              </div>
            ) : (
              holders.map((m, i) => (
                <div
                  key={m.membershipId}
                  className="flex items-center gap-2.5 px-3.5 py-[9px]"
                  style={{ borderTop: i === 0 ? 'none' : '1px solid var(--border-hairline)' }}
                >
                  <Avatar name={m.name} size={26} />
                  <div className="min-w-0 flex-1">
                    <div className="truncate text-[12.5px] font-medium">{m.name}</div>
                    <div className="truncate text-[11px] text-[var(--text-tertiary)]">{m.email}</div>
                  </div>
                </div>
              ))
            )}
          </DSCard>

          <DSCard title={<SectionTitle>Other roles</SectionTitle>} bodyClassName="p-0">
            {roles
              .filter((r) => r.slug !== role.slug)
              .map((r, i) => {
                const rv = visual(r.slug);
                return (
                  <button
                    key={r.slug}
                    type="button"
                    onClick={() => onOpenRole(r.slug)}
                    className="focus-ring flex w-full items-center gap-2.5 px-3.5 py-[9px] text-left hover:bg-[var(--bg-row-hover)]"
                    style={{ borderTop: i === 0 ? 'none' : '1px solid var(--border-hairline)' }}
                  >
                    <span
                      className="inline-flex h-[26px] w-[26px] shrink-0 items-center justify-center rounded-[7px]"
                      style={{ background: rv.tone + '14', color: rv.tone }}
                    >
                      <WIcon name={rv.icon} size={13} color={rv.tone} />
                    </span>
                    <span className="flex-1 truncate text-[12.5px] font-medium">{r.name}</span>
                    <WIcon name="arrow-right" size={12} color="var(--text-tertiary)" />
                  </button>
                );
              })}
          </DSCard>
        </div>
      </div>
    </>
  );
}
