/**
 * Settings → Documents — the org's documents catalog.
 *
 * Lists the effective catalog (system defaults merged with this org's
 * overrides and custom types) per entity, and lets settings:manage users
 * edit the flags that drive status: does it expire, is an issue date
 * required, is a file required, and (organization types) whether it is
 * shared with linked brokers by default. Types can be hidden, never
 * deleted, once documents reference them.
 *
 * docs/documents-storage-spec.md §2. Layout mirrors the yards page:
 * SettingsHeader → entity tab strip → full-width table → dialog.
 */
'use client';

import * as React from 'react';
import { useMutation } from 'convex/react';
import { toast } from 'sonner';

import { api } from '@/convex/_generated/api';
import { useAuthQuery } from '@/hooks/use-auth-query';
import { usePermissions } from '@/lib/use-permissions';
import { convexErrorMessage } from '@/lib/convex-error';
import type { EffectiveDocumentType } from '@/convex/_helpers/documentStatus';
import type { DocumentEntity } from '@/convex/lib/documentTypeDefaults';
import { Chip, CountBadge, SettingsHeader, WBtn, WIcon } from '@/components/web';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Checkbox } from '@/components/ui/checkbox';

const ENTITY_TABS: Array<{ id: DocumentEntity; label: string; hint: string }> = [
  { id: 'driver', label: 'Drivers', hint: 'Driver qualification file — CDL, medical, endorsements, screenings.' },
  { id: 'carrier', label: 'Carriers', hint: 'What you keep on file per carrier partnership.' },
  { id: 'organization', label: 'Company', hint: 'Your own compliance file. Shared types are visible to linked brokers.' },
];

interface TypeForm {
  name: string;
  key: string;
  expires: boolean;
  issueDateRequired: boolean;
  uploadRequired: boolean;
  singleton: boolean;
  sharedByDefault: boolean;
}

const EMPTY_FORM: TypeForm = {
  name: '',
  key: '',
  expires: true,
  issueDateRequired: false,
  uploadRequired: true,
  singleton: true,
  sharedByDefault: false,
};

function slugify(name: string): string {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .slice(0, 40);
}

export default function SettingsDocumentsPage() {
  const catalog = useAuthQuery(api.documentTypes.effectiveCatalog, {});
  const upsertOverride = useMutation(api.documentTypes.upsertSystemOverride);
  const createCustom = useMutation(api.documentTypes.createCustomType);
  const updateCustom = useMutation(api.documentTypes.updateCustomType);
  const setHidden = useMutation(api.documentTypes.setHidden);
  const deleteCustom = useMutation(api.documentTypes.deleteCustomType);

  // Soft client guard — every mutation enforces settings:manage again.
  const { can } = usePermissions();
  const canManage = can('settings', 'manage');

  const [entity, setEntity] = React.useState<DocumentEntity>('driver');
  const [showHidden, setShowHidden] = React.useState(false);
  const [dialog, setDialog] = React.useState<{ mode: 'create' } | { mode: 'edit'; type: EffectiveDocumentType } | null>(null);
  const [form, setForm] = React.useState<TypeForm>(EMPTY_FORM);
  const [saving, setSaving] = React.useState(false);

  const rows = React.useMemo(
    () => (catalog ?? []).filter((t) => t.entity === entity && (showHidden || !t.hidden)),
    [catalog, entity, showHidden],
  );
  const hiddenCount = React.useMemo(
    () => (catalog ?? []).filter((t) => t.entity === entity && t.hidden).length,
    [catalog, entity],
  );

  const openCreate = () => {
    setForm({ ...EMPTY_FORM, sharedByDefault: entity === 'organization' });
    setDialog({ mode: 'create' });
  };
  const openEdit = (t: EffectiveDocumentType) => {
    setForm({
      name: t.name,
      key: t.key,
      expires: t.expires,
      issueDateRequired: t.issueDateRequired,
      uploadRequired: t.uploadRequired,
      singleton: t.singleton,
      sharedByDefault: t.sharedByDefault,
    });
    setDialog({ mode: 'edit', type: t });
  };

  const save = async () => {
    if (!dialog) return;
    if (!form.name.trim()) {
      toast.error('Name is required');
      return;
    }
    setSaving(true);
    try {
      if (dialog.mode === 'create') {
        await createCustom({
          entity,
          key: form.key || slugify(form.name),
          name: form.name,
          expires: form.expires,
          issueDateRequired: form.issueDateRequired,
          uploadRequired: form.uploadRequired,
          singleton: form.singleton,
          sharedByDefault: entity === 'organization' ? form.sharedByDefault : undefined,
        });
        toast.success(`Added "${form.name.trim()}"`);
      } else if (dialog.type.isSystem) {
        await upsertOverride({
          key: dialog.type.key,
          name: form.name,
          expires: form.expires,
          issueDateRequired: form.issueDateRequired,
          uploadRequired: form.uploadRequired,
          sharedByDefault: entity === 'organization' ? form.sharedByDefault : undefined,
        });
        toast.success(`Updated "${form.name.trim()}"`);
      } else {
        await updateCustom({
          key: dialog.type.key,
          name: form.name,
          expires: form.expires,
          issueDateRequired: form.issueDateRequired,
          uploadRequired: form.uploadRequired,
          singleton: form.singleton,
          sharedByDefault: entity === 'organization' ? form.sharedByDefault : undefined,
        });
        toast.success(`Updated "${form.name.trim()}"`);
      }
      setDialog(null);
    } catch (e) {
      toast.error(convexErrorMessage(e) ?? 'Could not save document type');
    } finally {
      setSaving(false);
    }
  };

  const toggleHidden = async (t: EffectiveDocumentType) => {
    try {
      await setHidden({ key: t.key, hidden: !t.hidden });
      toast.success(t.hidden ? `"${t.name}" is visible again` : `"${t.name}" hidden`);
    } catch (e) {
      toast.error(convexErrorMessage(e) ?? 'Could not update');
    }
  };

  const remove = async (t: EffectiveDocumentType) => {
    if (!window.confirm(`Delete "${t.name}"? Only possible while no documents use it.`)) return;
    try {
      await deleteCustom({ key: t.key });
      toast.success(`Deleted "${t.name}"`);
    } catch (e) {
      toast.error(convexErrorMessage(e) ?? 'Could not delete');
    }
  };

  const tab = ENTITY_TABS.find((t) => t.id === entity)!;

  return (
    <div className="flex flex-col gap-4">
      <SettingsHeader
        eyebrow="Settings"
        title="Documents"
        subtitle="Which documents you track per driver, carrier, and for your company — and what each one requires to count as on file."
        actions={
          canManage ? (
            <WBtn size="sm" variant="primary" leading="plus" onClick={openCreate}>
              Add type
            </WBtn>
          ) : null
        }
      />

      {/* Entity tab strip */}
      <div className="flex items-center gap-1 border-b border-[var(--border-hairline)]">
        {ENTITY_TABS.map((t) => {
          const count = (catalog ?? []).filter((c) => c.entity === t.id && !c.hidden).length;
          const active = t.id === entity;
          return (
            <button
              key={t.id}
              type="button"
              onClick={() => setEntity(t.id)}
              className={
                'focus-ring -mb-px inline-flex items-center gap-2 border-b-2 px-3 py-2 text-[13px] ' +
                (active
                  ? 'border-[var(--accent)] text-foreground font-medium'
                  : 'border-transparent text-[var(--text-secondary)] hover:text-foreground')
              }
            >
              {t.label}
              <CountBadge n={count} tone={active ? 'accent' : 'neutral'} />
            </button>
          );
        })}
        <div className="flex-1" />
        {hiddenCount > 0 && (
          <label className="flex items-center gap-2 pr-1 text-[12px] text-[var(--text-secondary)]">
            <Checkbox checked={showHidden} onCheckedChange={(v) => setShowHidden(v === true)} />
            Show {hiddenCount} hidden
          </label>
        )}
      </div>

      <p className="m-0 text-[12.5px] text-[var(--text-tertiary)]">{tab.hint}</p>

      {/* Table */}
      <div className="overflow-hidden rounded-xl border border-[var(--border-hairline)] bg-card">
        <div
          className="grid items-center gap-3 border-b border-[var(--border-hairline)] bg-[var(--bg-surface-2)] px-4 py-2 text-[11px] uppercase tracking-[0.04em] text-[var(--text-tertiary)]"
          style={{ gridTemplateColumns: `1.6fr 110px 130px 120px ${entity === 'organization' ? '120px ' : ''}100px 40px` }}
        >
          <div>Document</div>
          <div>Expires</div>
          <div>Issue date</div>
          <div>Upload</div>
          {entity === 'organization' && <div>Shared</div>}
          <div>Source</div>
          <div />
        </div>
        {catalog === undefined ? (
          <div className="px-4 py-8 text-center text-[12.5px] text-[var(--text-tertiary)]">Loading…</div>
        ) : rows.length === 0 ? (
          <div className="px-4 py-8 text-center text-[12.5px] text-[var(--text-tertiary)]">
            No document types for this entity{hiddenCount > 0 ? ' — some are hidden' : ''}.
          </div>
        ) : (
          rows.map((t) => (
            <div
              key={t.key}
              className={
                'grid items-center gap-3 border-b border-[var(--border-hairline)] px-4 py-2.5 text-[13px] last:border-b-0 ' +
                (t.hidden ? 'opacity-60' : '')
              }
              style={{ gridTemplateColumns: `1.6fr 110px 130px 120px ${entity === 'organization' ? '120px ' : ''}100px 40px` }}
            >
              <div className="min-w-0">
                <div className="truncate font-medium">
                  {t.name}
                  {t.hidden && <span className="ml-2 text-[11px] font-normal text-[var(--text-tertiary)]">hidden</span>}
                </div>
                <div className="truncate text-[11px] text-[var(--text-tertiary)]">
                  <span className="num">{t.key}</span>
                  {t.singleton ? ' · one active' : ' · many'}
                  {t.mirrorField ? ` · mirrors ${t.mirrorField}` : ''}
                </div>
              </div>
              <YesNo value={t.expires} />
              <YesNo value={t.issueDateRequired} label={t.issueDateRequired ? 'Required' : 'Optional'} />
              <YesNo value={t.uploadRequired} label={t.uploadRequired ? 'Required' : 'Optional'} />
              {entity === 'organization' && <YesNo value={t.sharedByDefault} />}
              <div>
                <Chip status={t.isSystem ? 'assigned' : 'active'} label={t.isSystem ? 'System' : 'Custom'} />
              </div>
              <div className="flex justify-end">
                {canManage && (
                  <RowMenu
                    type={t}
                    onEdit={() => openEdit(t)}
                    onToggleHidden={() => void toggleHidden(t)}
                    onDelete={t.isSystem ? undefined : () => void remove(t)}
                  />
                )}
              </div>
            </div>
          ))
        )}
      </div>

      <p className="m-0 text-[12px] text-[var(--text-tertiary)]">
        A document counts as on file only when everything it requires is present. Changing a
        requirement re-evaluates every {tab.label.toLowerCase().replace(/s$/, '')} immediately.
        System types can be hidden but not deleted; what they mirror onto records is fixed.
      </p>

      {/* Dialog */}
      <Dialog open={dialog !== null} onOpenChange={(o) => !saving && !o && setDialog(null)}>
        <DialogContent className="max-w-md">
          <DialogHeader>
            <DialogTitle>
              {dialog?.mode === 'create' ? `Add ${tab.label.toLowerCase().replace(/s$/, '')} document type` : `Edit ${dialog?.type.name ?? ''}`}
            </DialogTitle>
            <DialogDescription>
              {dialog?.mode === 'edit' && dialog.type.isSystem
                ? 'Overrides the default for your workspace. Leave unchanged to follow future defaults.'
                : 'Define what a document of this type needs before it counts as on file.'}
            </DialogDescription>
          </DialogHeader>

          <div className="flex flex-col gap-4">
            <div className="grid gap-1.5">
              <Label htmlFor="dt-name">Name</Label>
              <Input
                id="dt-name"
                value={form.name}
                onChange={(e) => setForm((f) => ({ ...f, name: e.target.value, key: dialog?.mode === 'create' ? slugify(e.target.value) : f.key }))}
                placeholder="e.g. Clearinghouse query"
                maxLength={60}
              />
            </div>
            {dialog?.mode === 'create' && (
              <div className="grid gap-1.5">
                <Label htmlFor="dt-key">Key</Label>
                <Input
                  id="dt-key"
                  value={form.key}
                  onChange={(e) => setForm((f) => ({ ...f, key: e.target.value }))}
                  placeholder="clearinghouse_query"
                  className="num"
                />
                <span className="text-[11px] text-[var(--text-tertiary)]">
                  Lowercase letters, digits, _ or -. Used in file storage paths; cannot change later.
                </span>
              </div>
            )}

            <FlagRow
              label="Expires"
              hint="Has an expiration date the user enters from the document."
              checked={form.expires}
              onChange={(v) => setForm((f) => ({ ...f, expires: v }))}
            />
            <FlagRow
              label="Issue date required"
              hint="Non-expiring documents usually need this instead."
              checked={form.issueDateRequired}
              onChange={(v) => setForm((f) => ({ ...f, issueDateRequired: v }))}
            />
            <FlagRow
              label="Upload required"
              hint="Off allows a dated entry with no file."
              checked={form.uploadRequired}
              onChange={(v) => setForm((f) => ({ ...f, uploadRequired: v }))}
            />
            {(dialog?.mode === 'create' || (dialog?.mode === 'edit' && !dialog.type.isSystem)) && (
              <FlagRow
                label="One active at a time"
                hint="A new upload replaces and archives the current one (CDL). Off keeps every entry active (drug screens)."
                checked={form.singleton}
                onChange={(v) => setForm((f) => ({ ...f, singleton: v }))}
              />
            )}
            {entity === 'organization' && (
              <FlagRow
                label="Shared with linked brokers by default"
                hint="Each document can still be withheld individually."
                checked={form.sharedByDefault}
                onChange={(v) => setForm((f) => ({ ...f, sharedByDefault: v }))}
              />
            )}
          </div>

          <DialogFooter>
            <WBtn variant="ghost" size="sm" onClick={() => setDialog(null)} disabled={saving}>
              Cancel
            </WBtn>
            <WBtn variant="primary" size="sm" onClick={save} disabled={saving}>
              {saving ? 'Saving…' : dialog?.mode === 'create' ? 'Add type' : 'Save'}
            </WBtn>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}

function YesNo({ value, label }: { value: boolean; label?: string }) {
  return (
    <div className="flex items-center gap-1.5 text-[12.5px]">
      <WIcon name={value ? 'check' : 'close'} size={13} style={{ color: value ? '#0F8C5F' : 'var(--text-tertiary)' }} />
      <span className={value ? '' : 'text-[var(--text-tertiary)]'}>{label ?? (value ? 'Yes' : 'No')}</span>
    </div>
  );
}

function FlagRow({
  label,
  hint,
  checked,
  onChange,
}: {
  label: string;
  hint: string;
  checked: boolean;
  onChange: (v: boolean) => void;
}) {
  return (
    <label className="flex cursor-pointer items-start gap-3">
      <Checkbox checked={checked} onCheckedChange={(v) => onChange(v === true)} className="mt-0.5" />
      <span className="flex flex-col">
        <span className="text-[13px]">{label}</span>
        <span className="text-[11.5px] text-[var(--text-tertiary)]">{hint}</span>
      </span>
    </label>
  );
}

function RowMenu({
  type,
  onEdit,
  onToggleHidden,
  onDelete,
}: {
  type: EffectiveDocumentType;
  onEdit: () => void;
  onToggleHidden: () => void;
  onDelete?: () => void;
}) {
  const [open, setOpen] = React.useState(false);
  const ref = React.useRef<HTMLDivElement>(null);
  React.useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener('mousedown', onDown);
    return () => document.removeEventListener('mousedown', onDown);
  }, [open]);
  return (
    <div ref={ref} className="relative">
      <button
        type="button"
        aria-label={`Actions for ${type.name}`}
        onClick={() => setOpen((o) => !o)}
        className="focus-ring rounded-md p-1 text-[var(--text-tertiary)] hover:bg-[var(--bg-surface-2)] hover:text-foreground"
      >
        <WIcon name="kebab-h" size={14} />
      </button>
      {open && (
        <div className="absolute right-0 z-20 mt-1 min-w-[150px] overflow-hidden rounded-lg border border-[var(--border-hairline)] bg-card py-1 shadow-md">
          <MenuItem onClick={() => { setOpen(false); onEdit(); }}>Edit</MenuItem>
          <MenuItem onClick={() => { setOpen(false); onToggleHidden(); }}>{type.hidden ? 'Unhide' : 'Hide'}</MenuItem>
          {onDelete && (
            <MenuItem danger onClick={() => { setOpen(false); onDelete(); }}>Delete</MenuItem>
          )}
        </div>
      )}
    </div>
  );
}

function MenuItem({ children, onClick, danger }: { children: React.ReactNode; onClick: () => void; danger?: boolean }) {
  return (
    <button
      type="button"
      onClick={onClick}
      className="block w-full px-3 py-1.5 text-left text-[12.5px] hover:bg-[var(--bg-surface-2)]"
      style={danger ? { color: '#B43030' } : undefined}
    >
      {children}
    </button>
  );
}
