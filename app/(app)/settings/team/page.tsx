'use client';

/**
 * Settings → Team & roles — Members tab.
 *
 * Native replacement for the WorkOS UsersManagement widget (retired from
 * the legacy /org-settings page): everyone who can sign in to the web
 * workspace, pending invites inline, and per-member actions — all through
 * the /api/team/* routes wrapping the WorkOS SDK.
 *
 * Data shape:
 *   - GET /api/team/members — memberships ⋈ profiles, pending invitations,
 *     role catalog, per-user 2FA. Refetched after every action.
 *   - "Last active" — latest audit-log action per member (Convex,
 *     api.orgMembers.getLastActionTimes), falling back to WorkOS
 *     lastSignInAt for members with no audited actions yet.
 *   - Driver count in the footer — api.settings.getWorkspaceSummary.
 *     Drivers hold the mobile role and are managed under Fleet → Drivers.
 *
 * Deliberate deltas from the design (see PR notes): invite rows carry no
 *   role tag (WorkOS doesn't return the invited role), no per-invite note
 *   (unsupported by the invitation API), no Owner badge yet (owner marker
 *   lands with the Roles phase), and "Send password reset" copies the
 *   reset link (WorkOS doesn't email API-created resets).
 *
 * Visual reference: Otoqa Web design — settings-team.jsx. The Roles tab
 * (role cards + capability-matrix editor) lives in ./roles-tab.tsx; role
 * data comes from /api/team/roles, with the permission catalog and preset
 * roles auto-seeded into WorkOS on first visit.
 */

import * as React from 'react';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import Link from 'next/link';
import * as PopoverPrimitive from '@radix-ui/react-popover';
import { useQuery } from 'convex/react';
import { toast } from 'sonner';
import { useAuth } from '@workos-inc/authkit-nextjs/components';
import { api } from '@/convex/_generated/api';
import { useOrganizationId } from '@/contexts/organization-context';
import { usePermissions } from '@/lib/use-permissions';

import { Avatar, Chip, CountBadge, Kbd, SettingsHeader, WBtn, WIcon, type IconName } from '@/components/web';
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '@/components/ui/alert-dialog';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogTitle,
} from '@/components/ui/dialog';

import type { PendingInviteDTO, TeamMemberDTO, TeamPayload, TeamRoleDTO } from '@/lib/team-types';
import { humanizeRoleSlug, relativeActivity } from '@/lib/team-utils';
import { PERM_AREAS, PERM_LEVELS, matrixFromPermissions } from '@/lib/team-rbac';
import { RoleEditorView, RolesTab } from './roles-tab';

// ─── Role visuals — known slugs get the design's tones; custom slugs get a
// stable palette pick so every role reads distinctly. ─────────────────────

const ROLE_STYLES: Record<string, { tone: string; icon: IconName }> = {
  admin: { tone: '#1A47E6', icon: 'shield' },
  dispatcher: { tone: '#0F8C5F', icon: 'route' },
  dispatch: { tone: '#0F8C5F', icon: 'route' },
  billing: { tone: '#A66800', icon: 'doc-dollar' },
  accountant: { tone: '#A66800', icon: 'doc-dollar' },
  safety: { tone: '#7C3AED', icon: 'badge-check' },
  member: { tone: '#5A6172', icon: 'users' },
};
const ROLE_PALETTE = ['#1A47E6', '#0F8C5F', '#A66800', '#7C3AED', '#0D9488', '#B43030'];

function roleStyle(slug: string): { tone: string; icon: IconName } {
  const known = ROLE_STYLES[slug.replace(/^org-/, '')];
  if (known) return known;
  let hash = 0;
  for (const ch of slug) hash = (hash * 31 + ch.charCodeAt(0)) >>> 0;
  return { tone: ROLE_PALETTE[hash % ROLE_PALETTE.length], icon: 'users' };
}

function RoleTag({ slug, name }: { slug: string; name?: string }) {
  const s = roleStyle(slug);
  return (
    <span
      className="inline-flex items-center gap-1.5 whitespace-nowrap font-semibold"
      style={{
        height: 20,
        padding: '0 9px 0 7px',
        borderRadius: 10,
        background: s.tone + '14',
        color: s.tone,
        fontSize: 11.5,
        letterSpacing: 0.01,
      }}
    >
      <WIcon name={s.icon} size={12} color={s.tone} />
      {name ?? humanizeRoleSlug(slug)}
    </span>
  );
}

// ─── API plumbing ─────────────────────────────────────────────────────────

async function callTeamApi(path: string, init?: RequestInit): Promise<Record<string, unknown>> {
  const res = await fetch(path, {
    ...init,
    headers: { 'Content-Type': 'application/json', ...(init?.headers ?? {}) },
  });
  const body = (await res.json().catch(() => ({}))) as Record<string, unknown>;
  if (!res.ok) throw new Error(typeof body.error === 'string' ? body.error : 'Request failed');
  return body;
}

// ─── Kebab menu — contextual per row status, with a change-role submenu ──

interface KebabItem {
  icon: IconName;
  label: string;
  danger?: boolean;
  cta?: boolean;
  onSelect: () => void;
}

function KebabMenu({
  title,
  items,
  roleSubmenu,
}: {
  title: string;
  items: KebabItem[];
  /** When set, a "Change role" entry opens this list as a second panel. */
  roleSubmenu?: { roles: TeamRoleDTO[]; currentSlug: string; onPick: (slug: string) => void };
}) {
  const [open, setOpen] = useState(false);
  const [panel, setPanel] = useState<'root' | 'roles'>('root');

  const close = () => {
    setOpen(false);
    setPanel('root');
  };

  const itemButton = (it: KebabItem) => (
    <button
      key={it.label}
      type="button"
      onClick={() => {
        close();
        it.onSelect();
      }}
      className="focus-ring w-full h-8 px-2 rounded-[5px] flex items-center gap-2 text-left text-[12.5px] hover:bg-[var(--bg-row-hover)]"
      style={{
        fontWeight: it.cta ? 600 : 500,
        color: it.danger ? '#B43030' : it.cta ? 'var(--accent)' : 'var(--text-primary)',
      }}
    >
      <WIcon
        name={it.icon}
        size={14}
        color={it.danger ? '#B43030' : it.cta ? 'var(--accent)' : 'var(--text-tertiary)'}
      />
      {it.label}
    </button>
  );

  return (
    <PopoverPrimitive.Root open={open} onOpenChange={(o) => (o ? setOpen(true) : close())}>
      <PopoverPrimitive.Trigger asChild>
        <button
          type="button"
          title={title}
          className="focus-ring inline-flex h-7 w-7 items-center justify-center rounded-md text-[var(--text-secondary)] hover:bg-[var(--bg-row-hover)] hover:text-[var(--accent)] data-[state=open]:bg-[var(--bg-row-hover)]"
        >
          <WIcon name="kebab-h" size={15} />
        </button>
      </PopoverPrimitive.Trigger>
      <PopoverPrimitive.Portal>
        <PopoverPrimitive.Content
          align="end"
          sideOffset={6}
          className="z-50 min-w-[200px] rounded-lg border border-[var(--border-hairline-strong)] bg-[var(--bg-surface)] p-1 shadow-[var(--shadow-popover)]"
        >
          {panel === 'root' ? (
            <>
              {roleSubmenu && (
                <button
                  type="button"
                  onClick={() => setPanel('roles')}
                  className="focus-ring w-full h-8 px-2 rounded-[5px] flex items-center gap-2 text-left text-[12.5px] font-medium text-[var(--text-primary)] hover:bg-[var(--bg-row-hover)]"
                >
                  <WIcon name="edit" size={14} color="var(--text-tertiary)" />
                  <span className="flex-1">Change role</span>
                  <WIcon name="chevron-right" size={12} color="var(--text-tertiary)" />
                </button>
              )}
              {items.map(itemButton)}
            </>
          ) : (
            <>
              <button
                type="button"
                onClick={() => setPanel('root')}
                className="focus-ring w-full h-7 px-2 rounded-[5px] flex items-center gap-2 text-left text-[11.5px] text-[var(--text-tertiary)] hover:bg-[var(--bg-row-hover)]"
              >
                <WIcon name="chevron-left" size={12} /> Back
              </button>
              <div className="my-1 border-t border-[var(--border-hairline)]" />
              {roleSubmenu?.roles.map((r) => {
                const selected = r.slug === roleSubmenu.currentSlug;
                return (
                  <button
                    key={r.slug}
                    type="button"
                    onClick={() => {
                      close();
                      if (!selected) roleSubmenu.onPick(r.slug);
                    }}
                    className="focus-ring w-full h-8 px-2 rounded-[5px] flex items-center gap-2 text-left text-[12.5px] hover:bg-[var(--bg-row-hover)]"
                    style={{
                      color: selected ? 'var(--accent)' : 'var(--text-primary)',
                      fontWeight: selected ? 600 : 500,
                    }}
                  >
                    <WIcon name={roleStyle(r.slug).icon} size={13} color={roleStyle(r.slug).tone} />
                    <span className="flex-1 truncate">{r.name}</span>
                    {selected && <WIcon name="check" size={12} color="var(--accent)" />}
                  </button>
                );
              })}
            </>
          )}
        </PopoverPrimitive.Content>
      </PopoverPrimitive.Portal>
    </PopoverPrimitive.Root>
  );
}

// ─── Invite modal ─────────────────────────────────────────────────────────

function InviteModal({
  roles,
  onClose,
  onSent,
}: {
  roles: TeamRoleDTO[];
  onClose: () => void;
  onSent: () => void;
}) {
  const [emails, setEmails] = useState('');
  const [roleSlug, setRoleSlug] = useState(roles[0]?.slug ?? '');
  const [sending, setSending] = useState(false);
  const canSend = emails.includes('@') && !sending;
  const selectedRole = roles.find((r) => r.slug === roleSlug);

  const send = useCallback(async () => {
    if (!canSend) return;
    setSending(true);
    try {
      const result = (await callTeamApi('/api/team/invites', {
        method: 'POST',
        body: JSON.stringify({ emails, roleSlug: roleSlug || undefined }),
      })) as { sent?: string[]; failed?: Array<{ email: string; error: string }> };
      const sent = result.sent?.length ?? 0;
      const failed = result.failed ?? [];
      if (sent > 0) toast.success(`Sent ${sent} invite${sent === 1 ? '' : 's'}`);
      for (const f of failed) toast.error(`${f.email}: ${f.error}`);
      if (sent > 0) {
        onSent();
        onClose();
      }
    } catch (error) {
      toast.error(error instanceof Error ? error.message : 'Failed to send invites');
    } finally {
      setSending(false);
    }
  }, [canSend, emails, roleSlug, onClose, onSent]);

  // Escape / overlay-click close come from Radix; ⌘↵ submit stays ours.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
        e.preventDefault();
        void send();
      }
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [send]);

  return (
    <Dialog open onOpenChange={(open) => !open && onClose()}>
      <DialogContent
        showCloseButton={false}
        className="w-[560px] gap-0 overflow-hidden rounded-[10px] border-[var(--border-hairline-strong)] bg-[var(--bg-surface)] p-0 shadow-[var(--shadow-popover)] sm:max-w-[560px]"
      >
        <div className="flex items-start justify-between border-b border-[var(--border-hairline)] px-[18px] py-3.5">
          <div>
            <div className="tw-label text-[10.5px] mb-0.5">Team & roles</div>
            <DialogTitle className="text-[15px] font-semibold">Invite people</DialogTitle>
            <DialogDescription className="mt-0.5 max-w-[420px] text-[12px] text-[var(--text-tertiary)]">
              They&rsquo;ll get an email to set a password and join your workspace.
            </DialogDescription>
          </div>
          <button
            type="button"
            onClick={onClose}
            className="focus-ring inline-flex h-[26px] w-[26px] items-center justify-center rounded-[5px] text-[var(--text-tertiary)]"
          >
            <WIcon name="close" size={13} />
          </button>
        </div>

        <div className="flex flex-col gap-4 p-[18px]">
          <label className="flex flex-col gap-1.5">
            <span className="text-[12.5px] font-semibold">Email addresses</span>
            <input
              autoFocus
              value={emails}
              onChange={(e) => setEmails(e.target.value)}
              placeholder="name@company.com, …"
              className="focus-ring h-9 rounded-[7px] border border-[var(--border-hairline-strong)] bg-[var(--bg-surface)] px-2.5 text-[13px] text-[var(--text-primary)] outline-none"
            />
            <span className="text-[11.5px] text-[var(--text-tertiary)]">
              One or more, separated by commas.
            </span>
          </label>

          <label className="flex flex-col gap-1.5">
            <span className="text-[12.5px] font-semibold">Role</span>
            <Select value={roleSlug} onValueChange={setRoleSlug}>
              <SelectTrigger className="w-full">
                <SelectValue placeholder="Select role…" />
              </SelectTrigger>
              <SelectContent className="z-[100]">
                {roles.map((r) => (
                  <SelectItem key={r.slug} value={r.slug}>
                    {r.name}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            {selectedRole?.description && (
              <span className="text-[11.5px] text-[var(--text-tertiary)]">
                {selectedRole.description}
              </span>
            )}
          </label>

          {/* Permission preview — only once the role catalog carries real
              permissions (post-seeding). */}
          {selectedRole && selectedRole.permissions.length > 0 && (
            <div className="overflow-hidden rounded-lg border border-[var(--border-hairline)]">
              <div className="tw-label flex items-center gap-2 border-b border-[var(--border-hairline)] bg-[var(--bg-surface-2)] px-3 py-2 text-[11px]">
                <RoleTag slug={selectedRole.slug} name={selectedRole.name} /> can access
              </div>
              <div className="grid grid-cols-2 gap-x-4 gap-y-1.5 px-3 py-2.5">
                {(() => {
                  const matrix = matrixFromPermissions(selectedRole.permissions);
                  const tone = roleStyle(selectedRole.slug).tone;
                  return PERM_AREAS.map((a) => {
                    const lvl = matrix[a.id];
                    const on = lvl !== 'none';
                    return (
                      <div
                        key={a.id}
                        className="flex items-center gap-2 text-[12px]"
                        style={{
                          color: on ? 'var(--text-secondary)' : 'var(--text-tertiary)',
                          opacity: on ? 1 : 0.55,
                        }}
                      >
                        <WIcon name={on ? 'check' : 'close'} size={12} color={on ? '#0F8C5F' : 'var(--text-tertiary)'} />
                        <span className="flex-1 truncate">{a.label}</span>
                        <span className="text-[11px] font-semibold" style={{ color: on ? tone : 'var(--text-tertiary)' }}>
                          {PERM_LEVELS.find((l) => l.value === lvl)?.label}
                        </span>
                      </div>
                    );
                  });
                })()}
              </div>
            </div>
          )}
        </div>

        <div className="flex items-center justify-between gap-3 border-t border-[var(--border-hairline)] bg-[var(--bg-surface-2)] px-[18px] py-3">
          <span className="text-[11.5px] text-[var(--text-tertiary)]">
            Press <Kbd>⌘</Kbd> <Kbd>↵</Kbd> to send
          </span>
          <div className="flex gap-2">
            <WBtn size="sm" onClick={onClose}>
              Cancel
            </WBtn>
            <WBtn size="sm" accent leading="inbox" onClick={() => void send()} disabled={!canSend}>
              {sending ? 'Sending…' : 'Send invite'}
            </WBtn>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}

// ─── Create-custom-role modal ─────────────────────────────────────────────

function CreateRoleModal({
  roles,
  onClose,
  onCreated,
}: {
  roles: TeamRoleDTO[];
  onClose: () => void;
  onCreated: (slug: string) => void;
}) {
  const [name, setName] = useState('');
  const [baseSlug, setBaseSlug] = useState(roles[0]?.slug ?? '');
  const [creating, setCreating] = useState(false);
  const base = roles.find((r) => r.slug === baseSlug);
  const canCreate = name.trim().length >= 2 && !creating;

  const create = async () => {
    if (!canCreate) return;
    setCreating(true);
    try {
      const result = (await callTeamApi('/api/team/roles', {
        method: 'POST',
        body: JSON.stringify({
          name: name.trim(),
          ...(base ? { matrix: matrixFromPermissions(base.permissions) } : {}),
        }),
      })) as { slug: string };
      toast.success(`Role "${name.trim()}" created`);
      onCreated(result.slug);
      onClose();
    } catch (error) {
      toast.error(error instanceof Error ? error.message : 'Failed to create role');
    } finally {
      setCreating(false);
    }
  };

  return (
    <Dialog open onOpenChange={(open) => !open && onClose()}>
      <DialogContent
        showCloseButton={false}
        className="w-[440px] gap-0 overflow-hidden rounded-[10px] border-[var(--border-hairline-strong)] bg-[var(--bg-surface)] p-0 shadow-[var(--shadow-popover)] sm:max-w-[440px]"
      >
        <div className="border-b border-[var(--border-hairline)] px-[18px] py-3.5">
          <div className="tw-label text-[10.5px] mb-0.5">Team & roles</div>
          <DialogTitle className="text-[15px] font-semibold">Create custom role</DialogTitle>
          <DialogDescription className="sr-only">
            Name the role and pick which existing role to copy permissions from.
          </DialogDescription>
        </div>
        <div className="flex flex-col gap-4 p-[18px]">
          <label className="flex flex-col gap-1.5">
            <span className="text-[12.5px] font-semibold">Role name</span>
            <input
              autoFocus
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="Night dispatch"
              className="focus-ring h-9 rounded-[7px] border border-[var(--border-hairline-strong)] bg-[var(--bg-surface)] px-2.5 text-[13px] outline-none"
            />
          </label>
          <label className="flex flex-col gap-1.5">
            <span className="text-[12.5px] font-semibold">Start from</span>
            <Select value={baseSlug} onValueChange={setBaseSlug}>
              <SelectTrigger className="w-full">
                <SelectValue placeholder="Copy permissions from…" />
              </SelectTrigger>
              <SelectContent className="z-[100]">
                {roles.map((r) => (
                  <SelectItem key={r.slug} value={r.slug}>
                    {r.name}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            <span className="text-[11.5px] text-[var(--text-tertiary)]">
              The new role starts with this role&rsquo;s permissions — adjust them in the editor.
            </span>
          </label>
        </div>
        <div className="flex items-center justify-end gap-2 border-t border-[var(--border-hairline)] bg-[var(--bg-surface-2)] px-[18px] py-3">
          <WBtn size="sm" onClick={onClose}>
            Cancel
          </WBtn>
          <WBtn size="sm" accent leading="plus" onClick={() => void create()} disabled={!canCreate}>
            {creating ? 'Creating…' : 'Create role'}
          </WBtn>
        </div>
      </DialogContent>
    </Dialog>
  );
}

// ═══════════════════════════════════════════════════════════════════════════
// Page
// ═══════════════════════════════════════════════════════════════════════════

type StatusFilter = 'all' | 'active' | 'invited' | 'deactivated';

interface RolesResponse {
  roles: TeamRoleDTO[];
  seeded: boolean;
  rbacAvailable: boolean;
}

interface ConfirmState {
  title: string;
  description: string;
  confirmLabel: string;
  action: () => Promise<void>;
}

export default function TeamSettingsPage() {
  const organizationId = useOrganizationId();
  const { user } = useAuth();
  // UI gating only — every mutation is enforced again server-side.
  const { can } = usePermissions();
  const canManage = can('team', 'manage');

  const [payload, setPayload] = useState<TeamPayload | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [filter, setFilter] = useState<StatusFilter>('all');
  const [search, setSearch] = useState('');
  const [inviteOpen, setInviteOpen] = useState(false);
  const [confirm, setConfirm] = useState<ConfirmState | null>(null);
  const [busy, setBusy] = useState(false);

  const [tab, setTab] = useState<'members' | 'roles'>('members');
  const [rolesData, setRolesData] = useState<RolesResponse | null>(null);
  const [roleEditSlug, setRoleEditSlug] = useState<string | null>(null);
  const [createRoleOpen, setCreateRoleOpen] = useState(false);
  const seedAttempted = useRef(false);

  const load = useCallback(async () => {
    try {
      setLoadError(null);
      const data = (await callTeamApi('/api/team/members')) as unknown as TeamPayload;
      setPayload(data);
    } catch (error) {
      setLoadError(error instanceof Error ? error.message : 'Failed to load team');
    }
  }, []);

  // Role catalog — auto-seeds the permission catalog + preset roles into
  // WorkOS on first visit (idempotent server-side).
  const loadRoles = useCallback(async () => {
    try {
      let data = (await callTeamApi('/api/team/roles')) as unknown as RolesResponse;
      if (data.rbacAvailable && !data.seeded && !seedAttempted.current) {
        seedAttempted.current = true;
        try {
          await callTeamApi('/api/team/roles/seed', { method: 'POST' });
          data = (await callTeamApi('/api/team/roles')) as unknown as RolesResponse;
        } catch (error) {
          toast.error(error instanceof Error ? error.message : 'Failed to set up roles');
        }
      }
      setRolesData(data);
    } catch {
      setRolesData({ roles: [], seeded: false, rbacAvailable: false });
    }
  }, []);

  useEffect(() => {
    void load();
    void loadRoles();
  }, [load, loadRoles]);

  // Freshest activity signal — latest audited action per member.
  const memberUserIds = useMemo(
    () => payload?.members.map((m) => m.userId) ?? [],
    [payload?.members],
  );
  const lastActions = useQuery(
    api.orgMembers.getLastActionTimes,
    memberUserIds.length > 0 ? { userIds: memberUserIds } : 'skip',
  );

  const summary = useQuery(
    api.settings.getWorkspaceSummary,
    organizationId ? { workosOrgId: organizationId } : 'skip',
  );

  /** Run a mutating call, toast on failure, refresh on success. */
  const act = useCallback(
    async (fn: () => Promise<unknown>, successMessage?: string) => {
      setBusy(true);
      try {
        await fn();
        if (successMessage) toast.success(successMessage);
        await load();
      } catch (error) {
        toast.error(error instanceof Error ? error.message : 'Action failed');
      } finally {
        setBusy(false);
      }
    },
    [load],
  );

  const members = useMemo(() => payload?.members ?? [], [payload?.members]);
  const invitations = useMemo(() => payload?.invitations ?? [], [payload?.invitations]);
  // Prefer the full catalog (carries permissions) over the members payload's
  // basic role list, which only serves as a degraded fallback.
  const roles =
    rolesData?.roles && rolesData.roles.length > 0 ? rolesData.roles : (payload?.roles ?? []);
  const roleName = (slug: string) =>
    roles.find((r) => r.slug === slug)?.name ?? humanizeRoleSlug(slug);

  const memberCountFor = (slug: string) =>
    members.filter((m) => m.roleSlug === slug && m.status === 'active').length;

  const openRole = (slug: string) => {
    setTab('roles');
    setRoleEditSlug(slug);
  };

  const duplicateRole = (role: TeamRoleDTO) =>
    void (async () => {
      try {
        const result = (await callTeamApi('/api/team/roles', {
          method: 'POST',
          body: JSON.stringify({
            name: `${role.name} (copy)`,
            ...(role.description ? { description: role.description } : {}),
            matrix: matrixFromPermissions(role.permissions),
          }),
        })) as { slug: string };
        toast.success(`Duplicated as "${role.name} (copy)"`);
        await loadRoles();
        setRoleEditSlug(result.slug);
      } catch (error) {
        toast.error(error instanceof Error ? error.message : 'Failed to duplicate role');
      }
    })();

  const deleteRole = (role: TeamRoleDTO) =>
    setConfirm({
      title: `Delete the ${role.name} role?`,
      description: 'This removes the role and its permissions. Nobody holds it, so no access changes.',
      confirmLabel: 'Delete role',
      action: async () => {
        setBusy(true);
        try {
          await callTeamApi(`/api/team/roles/${encodeURIComponent(role.slug)}`, {
            method: 'DELETE',
          });
          toast.success(`${role.name} deleted`);
          setRoleEditSlug(null);
          await loadRoles();
        } catch (error) {
          toast.error(error instanceof Error ? error.message : 'Failed to delete role');
        } finally {
          setBusy(false);
        }
      },
    });

  const counts = {
    all: members.length + invitations.length,
    active: members.filter((m) => m.status === 'active').length,
    invited: invitations.length,
    deactivated: members.filter((m) => m.status === 'inactive').length,
  };

  const q = search.trim().toLowerCase();
  const matchesSearch = (name: string, email: string) =>
    !q || name.toLowerCase().includes(q) || email.toLowerCase().includes(q);

  const visibleMembers = members
    .filter((m) =>
      filter === 'all' ? true : filter === 'active' ? m.status === 'active' : filter === 'deactivated' ? m.status === 'inactive' : false,
    )
    .filter((m) => matchesSearch(m.name, m.email))
    .sort((a, b) => (a.status === b.status ? a.name.localeCompare(b.name) : a.status === 'active' ? -1 : 1));
  const visibleInvites =
    filter === 'all' || filter === 'invited'
      ? invitations.filter((i) => matchesSearch('', i.email))
      : [];

  const lastActiveLabel = (m: TeamMemberDTO): string => {
    const audited = lastActions?.[m.userId];
    const signedIn = m.lastSignInAt ? Date.parse(m.lastSignInAt) : NaN;
    const best = Math.max(audited ?? 0, Number.isFinite(signedIn) ? signedIn : 0);
    if (m.status === 'inactive') return 'Deactivated';
    return best > 0 ? relativeActivity(best) : 'Never signed in';
  };

  // ── per-row actions ─────────────────────────────────────────────────────

  const changeRole = (m: TeamMemberDTO, slug: string) =>
    void act(
      () =>
        callTeamApi(`/api/team/members/${m.membershipId}`, {
          method: 'PATCH',
          body: JSON.stringify({ roleSlug: slug }),
        }),
      `${m.name} is now ${roleName(slug)}`,
    );

  const copyPasswordReset = (m: TeamMemberDTO) =>
    void act(async () => {
      const { url } = (await callTeamApi('/api/team/password-reset', {
        method: 'POST',
        body: JSON.stringify({ email: m.email }),
      })) as { url: string };
      await navigator.clipboard.writeText(url);
    }, 'Password-reset link copied — send it to the member');

  const memberKebab = (m: TeamMemberDTO): { items: KebabItem[]; roleSubmenu?: Parameters<typeof KebabMenu>[0]['roleSubmenu'] } => {
    if (m.status === 'inactive') {
      return {
        items: [
          {
            icon: 'refresh',
            label: 'Reactivate member',
            onSelect: () =>
              void act(
                () =>
                  callTeamApi(`/api/team/members/${m.membershipId}`, {
                    method: 'POST',
                    body: JSON.stringify({ action: 'reactivate' }),
                  }),
                `${m.name} reactivated`,
              ),
          },
          {
            icon: 'trash',
            label: 'Remove from workspace',
            danger: true,
            onSelect: () =>
              setConfirm({
                title: `Remove ${m.name}?`,
                description:
                  'They lose access to this workspace entirely. Their historical records (loads, audit trail) are kept.',
                confirmLabel: 'Remove member',
                action: () =>
                  act(
                    () => callTeamApi(`/api/team/members/${m.membershipId}`, { method: 'DELETE' }),
                    `${m.name} removed`,
                  ),
              }),
          },
        ],
      };
    }
    const isSelf = m.userId === user?.id;
    return {
      roleSubmenu: {
        roles,
        currentSlug: m.roleSlug,
        onPick: (slug) => changeRole(m, slug),
      },
      items: [
        { icon: 'inbox', label: 'Copy password-reset link', onSelect: () => copyPasswordReset(m) },
        ...(!isSelf
          ? [
              {
                icon: 'pin-off' as IconName,
                label: 'Deactivate',
                danger: true,
                onSelect: () =>
                  setConfirm({
                    title: `Deactivate ${m.name}?`,
                    description:
                      'They can no longer sign in, but keep their seat and history. You can reactivate them any time.',
                    confirmLabel: 'Deactivate',
                    action: () =>
                      act(
                        () =>
                          callTeamApi(`/api/team/members/${m.membershipId}`, {
                            method: 'POST',
                            body: JSON.stringify({ action: 'deactivate' }),
                          }),
                        `${m.name} deactivated`,
                      ),
                  }),
              },
            ]
          : []),
      ],
    };
  };

  const inviteKebab = (i: PendingInviteDTO): KebabItem[] => [
    {
      icon: 'refresh',
      label: 'Resend invite',
      cta: true,
      onSelect: () =>
        void act(
          () =>
            callTeamApi(`/api/team/invites/${i.invitationId}`, {
              method: 'POST',
              body: JSON.stringify({ action: 'resend' }),
            }),
          `Invite resent to ${i.email}`,
        ),
    },
    {
      icon: 'copy',
      label: 'Copy invite link',
      onSelect: () =>
        void navigator.clipboard
          .writeText(i.acceptUrl)
          .then(() => toast.success('Invite link copied')),
    },
    {
      icon: 'trash',
      label: 'Revoke invite',
      danger: true,
      onSelect: () =>
        setConfirm({
          title: `Revoke invite for ${i.email}?`,
          description: 'The invite link stops working immediately. You can always invite them again.',
          confirmLabel: 'Revoke invite',
          action: () =>
            act(
              () =>
                callTeamApi(`/api/team/invites/${i.invitationId}`, {
                  method: 'POST',
                  body: JSON.stringify({ action: 'revoke' }),
                }),
              `Invite for ${i.email} revoked`,
            ),
        }),
    },
  ];

  // ── render ──────────────────────────────────────────────────────────────

  const GRID = 'minmax(210px, 1.1fr) minmax(190px, 1.3fr) 180px 130px 90px 200px 44px';

  const editingRole = roleEditSlug ? (roles.find((r) => r.slug === roleEditSlug) ?? null) : null;

  return (
    <div className="flex-1 overflow-hidden flex flex-col min-w-0">
      {editingRole ? (
        <RoleEditorView
          role={editingRole}
          roles={roles}
          canManage={canManage}
          holders={members.filter((m) => m.roleSlug === editingRole.slug && m.status === 'active')}
          visual={roleStyle}
          onBack={() => setRoleEditSlug(null)}
          onOpenRole={(slug) => setRoleEditSlug(slug)}
          onDuplicate={duplicateRole}
          onDelete={deleteRole}
          onChanged={loadRoles}
        />
      ) : (
        <>
      <SettingsHeader
        eyebrow="Settings"
        title="Team & roles"
        subtitle="Everyone with access to your Otoqa workspace and what each role can do."
        actions={
          canManage ? (
            <WBtn size="sm" accent leading="plus" onClick={() => setInviteOpen(true)}>
              Invite people
            </WBtn>
          ) : undefined
        }
      />

      {/* Members | Roles tabs */}
      <div className="flex border-b border-[var(--border-hairline)] bg-[var(--bg-surface)] px-7">
        {(
          [
            { id: 'members', label: 'Members', n: counts.active + counts.invited },
            { id: 'roles', label: 'Roles', n: roles.length },
          ] as Array<{ id: 'members' | 'roles'; label: string; n: number }>
        ).map((t) => {
          const active = tab === t.id;
          return (
            <button
              key={t.id}
              type="button"
              onClick={() => setTab(t.id)}
              className="focus-ring relative inline-flex h-10 items-center gap-2 px-3.5 text-[13px]"
              style={{
                color: active ? 'var(--text-primary)' : 'var(--text-tertiary)',
                fontWeight: active ? 600 : 500,
              }}
            >
              {t.label}
              <CountBadge n={t.n} tone={active ? 'accent' : 'neutral'} />
              {active && (
                <span className="absolute inset-x-2 -bottom-px h-0.5 rounded-sm bg-[var(--accent)]" />
              )}
            </button>
          );
        })}
      </div>

      {tab === 'members' ? (
        <>
      {/* Toolbar — status filters + search */}
      <div className="flex items-stretch border-b border-[var(--border-hairline)] bg-[var(--bg-surface)] px-7">
        {(
          [
            { id: 'all', label: 'All' },
            { id: 'active', label: 'Active' },
            { id: 'invited', label: 'Invited' },
            { id: 'deactivated', label: 'Deactivated' },
          ] as Array<{ id: StatusFilter; label: string }>
        ).map((t) => {
          const active = filter === t.id;
          return (
            <button
              key={t.id}
              type="button"
              onClick={() => setFilter(t.id)}
              className="focus-ring relative inline-flex h-11 items-center gap-2 px-3.5 text-[13px]"
              style={{
                color: active ? 'var(--text-primary)' : 'var(--text-secondary)',
                fontWeight: active ? 500 : 400,
              }}
            >
              {t.label}
              <CountBadge n={counts[t.id]} tone={active ? 'accent' : 'neutral'} />
              {active && (
                <span className="absolute inset-x-2 -bottom-px h-0.5 rounded-sm bg-[var(--accent)]" />
              )}
            </button>
          );
        })}
        <div className="flex-1" />
        <div className="flex items-center">
          <div className="flex h-7 w-60 items-center gap-1.5 rounded-[7px] border border-[var(--border-hairline)] bg-[var(--bg-surface-2)] px-2.5">
            <WIcon name="search" size={13} color="var(--text-tertiary)" />
            <input
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder="Search people…"
              className="w-full bg-transparent text-[12.5px] text-[var(--text-primary)] outline-none placeholder:text-[var(--text-tertiary)]"
            />
          </div>
        </div>
      </div>

      {/* Body */}
      <div className="scroll-thin flex-1 overflow-auto" style={{ background: 'var(--bg-canvas)' }}>
        {loadError ? (
          <div className="p-14 text-center">
            <div className="mb-2 text-[13.5px] font-semibold">Couldn&rsquo;t load the team</div>
            <div className="mb-4 text-[12.5px] text-[var(--text-tertiary)]">{loadError}</div>
            <WBtn size="sm" leading="refresh" onClick={() => void load()}>
              Retry
            </WBtn>
          </div>
        ) : payload === null ? (
          <div className="p-6">
            {[0, 1, 2, 3].map((i) => (
              <div
                key={i}
                className="animate-pulse mb-3 h-14 rounded-[10px] border border-[var(--border-hairline)] bg-[var(--bg-surface)]"
              />
            ))}
          </div>
        ) : visibleMembers.length === 0 && visibleInvites.length === 0 ? (
          <div className="p-14 text-center">
            <div className="mb-3 inline-flex h-10 w-10 items-center justify-center rounded-[10px] border border-[var(--border-hairline)] bg-[var(--bg-surface-2)] text-[var(--text-tertiary)]">
              <WIcon name="users" size={18} />
            </div>
            <div className="mb-1 text-[14px] font-semibold">
              No {filter === 'all' ? '' : filter} members
            </div>
            <div className="mb-3.5 text-[12.5px] text-[var(--text-tertiary)]">
              {filter === 'invited'
                ? 'No invites are outstanding right now.'
                : 'Invite a teammate to give them workspace access.'}
            </div>
            {canManage && (
              <WBtn size="sm" accent leading="plus" onClick={() => setInviteOpen(true)}>
                Invite people
              </WBtn>
            )}
          </div>
        ) : (
          <div style={{ background: 'var(--bg-surface)' }}>
            {/* Head */}
            <div
              className="grid border-b border-[var(--border-hairline)] bg-[var(--bg-surface-2)]"
              style={{ gridTemplateColumns: GRID }}
            >
              {['Name', 'Email', 'Role', 'Status', '2FA', 'Last active', ''].map((label, i, arr) => (
                <div
                  key={label || 'kebab'}
                  className="tw-label text-[10.5px]"
                  style={{
                    padding: `10px ${i === arr.length - 1 ? 28 : 16}px 10px ${i === 0 ? 28 : 16}px`,
                  }}
                >
                  {label}
                </div>
              ))}
            </div>

            {/* Member rows */}
            {visibleMembers.map((m) => {
              const deactivated = m.status === 'inactive';
              const kebab = memberKebab(m);
              return (
                <div
                  key={m.membershipId}
                  className="grid items-center border-b border-[var(--border-hairline)] hover:bg-[var(--bg-row-hover)]"
                  style={{ gridTemplateColumns: GRID, opacity: deactivated ? 0.6 : 1 }}
                >
                  <div className="flex min-w-0 items-center gap-3" style={{ padding: '12px 16px 12px 28px' }}>
                    <Avatar name={m.name} size={30} />
                    <span className="truncate text-[13px] font-semibold">{m.name}</span>
                  </div>
                  <div className="min-w-0" style={{ padding: '12px 16px' }}>
                    <span className="block truncate text-[12.5px] text-[var(--text-secondary)]">{m.email}</span>
                  </div>
                  <div style={{ padding: '12px 16px' }}>
                    <button
                      type="button"
                      onClick={() => openRole(m.roleSlug)}
                      className="focus-ring rounded-full"
                      title={`Open ${roleName(m.roleSlug)} role`}
                    >
                      <RoleTag slug={m.roleSlug} name={roleName(m.roleSlug)} />
                    </button>
                  </div>
                  <div style={{ padding: '12px 16px' }}>
                    {deactivated ? <Chip status="inactive" label="Deactivated" /> : <Chip status="active" />}
                  </div>
                  <div style={{ padding: '12px 16px' }}>
                    {m.twoFactorEnabled ? (
                      <span className="inline-flex items-center gap-1 text-[12px] font-medium" style={{ color: '#0F8C5F' }}>
                        <WIcon name="badge-check" size={13} color="#0F8C5F" /> On
                      </span>
                    ) : (
                      <span className="inline-flex items-center gap-1 text-[12px] font-medium" style={{ color: '#A66800' }}>
                        <WIcon name="alert" size={13} color="#A66800" /> Off
                      </span>
                    )}
                  </div>
                  <div style={{ padding: '12px 16px' }}>
                    <span className="text-[12.5px] text-[var(--text-secondary)]">{lastActiveLabel(m)}</span>
                  </div>
                  <div className="flex justify-end" style={{ padding: '12px 28px 12px 16px' }}>
                    {canManage && (
                      <KebabMenu title="Member actions" items={kebab.items} roleSubmenu={kebab.roleSubmenu} />
                    )}
                  </div>
                </div>
              );
            })}

            {/* Invite rows */}
            {visibleInvites.map((i) => (
              <div
                key={i.invitationId}
                className="grid items-center border-b border-[var(--border-hairline)] hover:bg-[var(--bg-row-hover)]"
                style={{ gridTemplateColumns: GRID }}
              >
                <div className="flex min-w-0 items-center gap-3" style={{ padding: '12px 16px 12px 28px' }}>
                  <span className="inline-flex h-[30px] w-[30px] shrink-0 items-center justify-center rounded-full border border-dashed border-[var(--border-hairline-strong)] bg-[var(--bg-surface-2)] text-[var(--text-tertiary)]">
                    <WIcon name="inbox" size={14} />
                  </span>
                  <span className="truncate text-[13px] italic text-[var(--text-tertiary)]">Pending invite</span>
                </div>
                <div className="min-w-0" style={{ padding: '12px 16px' }}>
                  <span className="block truncate text-[12.5px] text-[var(--text-secondary)]">{i.email}</span>
                </div>
                <div style={{ padding: '12px 16px' }}>
                  <span className="text-[12px] text-[var(--text-tertiary)]">—</span>
                </div>
                <div style={{ padding: '12px 16px' }}>
                  <Chip status="pending" label="Invited" />
                </div>
                <div style={{ padding: '12px 16px' }}>
                  <span className="text-[12px] text-[var(--text-tertiary)]">—</span>
                </div>
                <div style={{ padding: '12px 16px' }}>
                  <span className="block truncate text-[12.5px] text-[var(--text-tertiary)]">
                    Invited {relativeActivity(Date.parse(i.createdAt)).toLowerCase()}
                    {i.inviterName ? ` by ${i.inviterName}` : ''}
                  </span>
                </div>
                <div className="flex justify-end" style={{ padding: '12px 28px 12px 16px' }}>
                  {canManage && <KebabMenu title="Invite actions" items={inviteKebab(i)} />}
                </div>
              </div>
            ))}
          </div>
        )}
      </div>

      {/* Footer — drivers live under Fleet */}
      <div className="flex items-center gap-2 border-t border-[var(--border-hairline)] bg-[var(--bg-surface-2)] px-7 py-3 text-[12px] text-[var(--text-tertiary)]">
        <WIcon name="id-card" size={13} />
        <span>
          This lists people who sign in to the web workspace.{' '}
          {summary != null && (
            <>
              <strong className="font-semibold text-[var(--text-secondary)]">
                {summary.driverCount} driver{summary.driverCount === 1 ? '' : 's'}
              </strong>{' '}
              hold the limited mobile role — manage them under{' '}
            </>
          )}
          {summary == null && <>Drivers hold the limited mobile role — manage them under </>}
          <Link href="/fleet/drivers" className="font-medium text-[var(--accent)] hover:underline">
            Fleet → Drivers
          </Link>
          .
        </span>
      </div>
        </>
      ) : (
        <RolesTab
          roles={roles}
          canManage={canManage}
          rbacAvailable={rolesData?.rbacAvailable ?? true}
          seeding={rolesData === null || (rolesData.rbacAvailable && !rolesData.seeded)}
          visual={roleStyle}
          memberCountFor={memberCountFor}
          onOpenRole={openRole}
          onCreateRole={() => setCreateRoleOpen(true)}
        />
      )}
        </>
      )}

      {createRoleOpen && (
        <CreateRoleModal
          roles={roles}
          onClose={() => setCreateRoleOpen(false)}
          onCreated={(slug) => {
            void loadRoles().then(() => {
              setTab('roles');
              setRoleEditSlug(slug);
            });
          }}
        />
      )}

      {inviteOpen && (
        <InviteModal roles={roles} onClose={() => setInviteOpen(false)} onSent={() => void load()} />
      )}

      <AlertDialog open={confirm !== null} onOpenChange={(open) => !open && setConfirm(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>{confirm?.title}</AlertDialogTitle>
            <AlertDialogDescription>{confirm?.description}</AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={busy}>Cancel</AlertDialogCancel>
            <AlertDialogAction
              disabled={busy}
              className="bg-red-600 hover:bg-red-700 focus:ring-red-600"
              onClick={() => {
                const c = confirm;
                setConfirm(null);
                if (c) void c.action();
              }}
            >
              {confirm?.confirmLabel}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}
