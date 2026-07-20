'use client';

/**
 * Settings → General.
 *
 * The company profile for the workspace: who the carrier legally is, the
 * authority numbers that make them a carrier, where they sit, who to reach,
 * and how the app formats data for them. Inline auto-save everywhere — click
 * a field, it swaps to an editor, ↵ saves ("All changes saved" in the header).
 *
 * Replaces the Overview tab of the legacy /org-settings page. Everything that
 * tab did is preserved here:
 *   - initialize-org CTA (creates the org row + seeds the pay-engine catalog)
 *   - logo upload (3-step Convex storage pattern) — plus remove
 *   - org name / industry / workspace ID / created / domain
 *   - default timezone
 *   - billing contact + address editing (billingEmail / billingPhone /
 *     billingAddress) — the pinned "Billing / AP" contact row and the
 *     Business address card write to the same fields the old form did.
 *
 * Data shape:
 *   - `api.settings.getOrgSettings` / `updateOrgSettings` — the org profile.
 *   - `api.settings.getWorkspaceSummary` — rail counts, metered rate, and the
 *     real next invoice number (INV-YYYY-NNNN sequence in convex/invoices.ts).
 *   - Authority "Verified" badges reflect `operatingAuthorityActive`; there is
 *     no FMCSA nightly check yet (design shows one — see PR notes).
 *
 * Visual reference: Otoqa Web design — settings-general.jsx, wrapped in the
 * shared settings shell pattern (SettingsHeader + content/rail grid).
 */

import * as React from 'react';
import { useEffect, useRef, useState } from 'react';
import { useMutation, useQuery } from 'convex/react';
import type { FunctionArgs, FunctionReturnType } from 'convex/server';
import { toast } from 'sonner';
import { useAuth } from '@workos-inc/authkit-nextjs/components';
import { api } from '@/convex/_generated/api';
import { useOrganizationId } from '@/contexts/organization-context';

import {
  Avatar,
  Chip,
  DSCard,
  DSProps,
  DSPropsEditable,
  EditableAddress,
  EditableField,
  OrgMark,
  SettingsHeader,
  WBtn,
  WIcon,
  type AddressData,
  type DSPropsEditableItem,
  type EditableSelectOption,
} from '@/components/web';
import { Switch } from '@/components/ui/switch';
import { formatDate } from '@/lib/utils/format';

type OrgSettings = NonNullable<FunctionReturnType<typeof api.settings.getOrgSettings>>;
type OrgUpdates = FunctionArgs<typeof api.settings.updateOrgSettings>['updates'];
type OrgContact = NonNullable<OrgSettings['contacts']>[number];
type OrgAddress = OrgSettings['billingAddress'];

const RAIL_W = 320;

// ─── Option lists for the select editors ─────────────────────────────────

const TZ_OPTS: EditableSelectOption[] = [
  { value: 'America/New_York', label: 'America/New_York — Eastern' },
  { value: 'America/Chicago', label: 'America/Chicago — Central' },
  { value: 'America/Denver', label: 'America/Denver — Mountain' },
  { value: 'America/Phoenix', label: 'America/Phoenix — Arizona' },
  { value: 'America/Los_Angeles', label: 'America/Los_Angeles — Pacific' },
  { value: 'America/Anchorage', label: 'America/Anchorage — Alaska' },
  { value: 'Pacific/Honolulu', label: 'Pacific/Honolulu — Hawaii' },
];

const DATEFMT_OPTS: EditableSelectOption[] = ['MM/DD/YYYY', 'DD/MM/YYYY', 'YYYY-MM-DD'].map(
  (o) => ({ value: o, label: o }),
);

const DIST_OPTS: EditableSelectOption[] = [
  { value: 'mi', label: 'Miles (mi)' },
  { value: 'km', label: 'Kilometers (km)' },
];

const CURR_OPTS: EditableSelectOption[] = [
  { value: 'USD', label: 'USD — US Dollar ($)' },
  { value: 'CAD', label: 'CAD — Canadian Dollar ($)' },
  { value: 'MXN', label: 'MXN — Mexican Peso ($)' },
];

const WEEK_OPTS: EditableSelectOption[] = [
  { value: 'sunday', label: 'Sunday' },
  { value: 'monday', label: 'Monday' },
];

const NUMFMT_OPTS: EditableSelectOption[] = ['1,234.56', '1.234,56', '1 234.56'].map((o) => ({
  value: o,
  label: o,
}));

const ENTITY_OPTS: EditableSelectOption[] = [
  'LLC',
  'C-Corp',
  'S-Corp',
  'Sole proprietor',
  'Partnership',
].map((o) => ({ value: o, label: o }));

// Suggested contact roles. The billing contact is pinned separately and
// writes to org.billingEmail / billingPhone (platform invoicing reads them).
const CONTACT_ROLES: EditableSelectOption[] = [
  'Dispatch',
  'Safety / compliance',
  'After-hours',
  'Claims',
  'Factoring',
  'Operations',
  'Owner',
].map((o) => ({ value: o, label: o }));

const optLabel = (opts: EditableSelectOption[], value: string | undefined) =>
  opts.find((o) => o.value === value)?.label;

// ─── formatters ──────────────────────────────────────────────────────────

/** Digits → "(559) 555-0142" for display; commit strips back to digits. */
const formatPhone = (value: string): string => {
  const digits = value.replace(/\D/g, '').slice(0, 10);
  if (digits.length === 0) return value.trim();
  if (digits.length <= 3) return `(${digits}`;
  if (digits.length <= 6) return `(${digits.slice(0, 3)}) ${digits.slice(3)}`;
  return `(${digits.slice(0, 3)}) ${digits.slice(3, 6)}-${digits.slice(6)}`;
};


// ═══════════════════════════════════════════════════════════════════════════
// Saved indicator — header "Saving… / All changes saved" dot
// ═══════════════════════════════════════════════════════════════════════════

function SavedIndicator({ saving }: { saving: boolean }) {
  return (
    <span className="inline-flex items-center gap-1.5 text-[11.5px] text-[var(--text-tertiary)]">
      <span
        className="inline-block h-1.5 w-1.5 rounded-full"
        style={{ background: saving ? '#F59E0B' : '#10B981' }}
      />
      {saving ? 'Saving…' : 'All changes saved'}
    </span>
  );
}

// ═══════════════════════════════════════════════════════════════════════════
// Verification badge for authority numbers
// ═══════════════════════════════════════════════════════════════════════════

function VerifyBadge({
  state,
  label,
  title,
}: {
  state: 'verified' | 'pending' | 'attention';
  label?: string;
  title?: string;
}) {
  const PRESETS = {
    verified: { bg: 'rgba(16,185,129,0.10)', fg: '#0F8C5F', icon: 'badge-check' as const, label: 'Verified' },
    pending: { bg: 'rgba(245,158,11,0.12)', fg: '#A66800', icon: 'clock' as const, label: 'Pending' },
    attention: { bg: 'rgba(239,68,68,0.10)', fg: '#B43030', icon: 'warn-tri' as const, label: 'Attention' },
  };
  const p = { ...PRESETS[state], ...(label ? { label } : {}) };
  return (
    <span
      className="inline-flex items-center gap-1 whitespace-nowrap font-semibold"
      title={title}
      style={{
        height: 18,
        padding: '0 8px 0 6px',
        borderRadius: 9,
        background: p.bg,
        color: p.fg,
        fontSize: 10.5,
        letterSpacing: 0.02,
      }}
    >
      <WIcon name={p.icon} size={11} color={p.fg} />
      {p.label}
    </span>
  );
}

// ═══════════════════════════════════════════════════════════════════════════
// Section title — settings-page card vocabulary (same as billing page)
// ═══════════════════════════════════════════════════════════════════════════

function SectionTitle({ children, sub }: { children: React.ReactNode; sub?: React.ReactNode }) {
  return (
    <div>
      <div
        style={{
          fontSize: 14,
          fontWeight: 600,
          color: 'var(--text-primary)',
          letterSpacing: -0.005,
          lineHeight: 1.2,
        }}
      >
        {children}
      </div>
      {sub && (
        <div
          style={{
            fontSize: 11.5,
            fontWeight: 400,
            color: 'var(--text-tertiary)',
            marginTop: 2,
            letterSpacing: 0,
          }}
        >
          {sub}
        </div>
      )}
    </div>
  );
}

// ═══════════════════════════════════════════════════════════════════════════
// Logo slot — current mark + replace/remove
// ═══════════════════════════════════════════════════════════════════════════

function LogoSlot({
  logoUrl,
  name,
  uploading,
  onPick,
  onRemove,
}: {
  logoUrl: string | null;
  name: string;
  uploading: boolean;
  onPick: () => void;
  onRemove: () => void;
}) {
  return (
    <div className="flex items-center gap-3.5">
      <OrgMark name={name} logoUrl={logoUrl} size={56} />
      <div className="min-w-0">
        <div className="flex gap-2 mb-1.5">
          <WBtn size="sm" leading="upload" onClick={onPick} disabled={uploading}>
            {uploading ? 'Uploading…' : logoUrl ? 'Replace' : 'Upload logo'}
          </WBtn>
          {logoUrl && (
            <WBtn size="sm" variant="ghost" onClick={onRemove} disabled={uploading}>
              Remove
            </WBtn>
          )}
        </div>
        <div style={{ fontSize: 11, color: 'var(--text-tertiary)', lineHeight: '15px' }}>
          Square PNG or SVG, at least 256×256. Shows on invoices and the driver app.
        </div>
      </div>
    </div>
  );
}

// ═══════════════════════════════════════════════════════════════════════════
// Contacts — responsive table. Flat 4-column when wide; stacks when the card
// is narrow. Container query keyed to the card, not the viewport.
// ═══════════════════════════════════════════════════════════════════════════

const CONTACT_STYLES = `
  .gen-contacts { container-type: inline-size; }
  .gen-contact-head, .gen-contact-row {
    display: grid; gap: 16px; align-items: center;
    grid-template-columns: 150px minmax(0,1fr) minmax(0,1.2fr) 130px 28px;
    grid-template-areas: "role contact email phone trash";
  }
  @container (max-width: 560px) {
    .gen-contact-head { display: none; }
    .gen-contact-row {
      grid-template-columns: minmax(0,1fr) minmax(0,1fr) 28px;
      grid-template-areas:
        "role role trash"
        "contact contact contact"
        "email phone phone";
      gap: 7px 12px;
      padding-top: 12px; padding-bottom: 12px;
    }
  }
`;

interface ContactRowProps {
  role: string;
  name: string;
  email: string;
  phone: string;
  first: boolean;
  /** Pinned rows (the billing contact) keep their role and can't be removed. */
  pinned?: boolean;
  onCommit: (field: 'role' | 'name' | 'email' | 'phone', value: string) => void;
  onRemove?: () => void;
}

function ContactRow({ role, name, email, phone, first, pinned, onCommit, onRemove }: ContactRowProps) {
  const [hover, setHover] = useState(false);
  return (
    <div
      className="gen-contact-row"
      onMouseEnter={() => setHover(true)}
      onMouseLeave={() => setHover(false)}
      style={{
        padding: '8px 14px',
        borderTop: first ? 'none' : '1px solid var(--border-hairline)',
      }}
    >
      <div style={{ gridArea: 'role', minWidth: 0 }}>
        <EditableField
          type="select"
          value={role}
          options={CONTACT_ROLES}
          placeholder="Set role"
          readOnly={pinned}
          display={
            pinned ? (
              <span className="inline-flex items-center gap-1.5">
                {role}
                <span
                  title="Used for platform invoices"
                  className="inline-flex items-center"
                  style={{ color: 'var(--text-tertiary)' }}
                >
                  <WIcon name="receipt" size={11} />
                </span>
              </span>
            ) : undefined
          }
          onCommit={(v) => onCommit('role', v)}
          ariaLabel="Contact role"
        />
      </div>
      <div style={{ gridArea: 'contact', display: 'flex', alignItems: 'center', gap: 10, minWidth: 0 }}>
        <Avatar name={name || '—'} size={28} />
        <div style={{ minWidth: 0, flex: 1 }}>
          <EditableField
            value={name}
            placeholder="Add name"
            onCommit={(v) => onCommit('name', v)}
            ariaLabel="Contact name"
          />
        </div>
      </div>
      <div style={{ gridArea: 'email', minWidth: 0 }}>
        <EditableField
          type="email"
          value={email}
          placeholder="email@company.com"
          onCommit={(v) => onCommit('email', v)}
          ariaLabel="Contact email"
        />
      </div>
      <div style={{ gridArea: 'phone', minWidth: 0 }}>
        <EditableField
          type="phone"
          value={formatPhone(phone)}
          placeholder="Add phone"
          onCommit={(v) => onCommit('phone', v.replace(/\D/g, ''))}
          ariaLabel="Contact phone"
        />
      </div>
      {pinned ? (
        <div style={{ gridArea: 'trash' }} />
      ) : (
        <button
          onClick={onRemove}
          title="Remove contact"
          className="focus-ring inline-flex items-center justify-center cursor-pointer border-0"
          style={{
            gridArea: 'trash',
            width: 26,
            height: 26,
            borderRadius: 6,
            background: 'transparent',
            color: 'var(--text-tertiary)',
            opacity: hover ? 1 : 0,
            transition: 'opacity 120ms ease-out, background 120ms ease-out, color 120ms ease-out',
          }}
          onMouseEnter={(e) => {
            e.currentTarget.style.background = 'rgba(239,68,68,0.08)';
            e.currentTarget.style.color = '#B43030';
          }}
          onMouseLeave={(e) => {
            e.currentTarget.style.background = 'transparent';
            e.currentTarget.style.color = 'var(--text-tertiary)';
          }}
        >
          <WIcon name="trash" size={13} />
        </button>
      )}
    </div>
  );
}

// ═══════════════════════════════════════════════════════════════════════════
// Address card — street row is a Google Places autocomplete that fills the
// whole block; the remaining rows stay individually editable for manual fixes.
// ═══════════════════════════════════════════════════════════════════════════

function addressItems(
  value: OrgAddress | undefined,
  onPatch: (patch: Partial<OrgAddress>) => void,
  keyPrefix: string,
): DSPropsEditableItem[] {
  return [
    {
      key: `${keyPrefix}-street`,
      label: 'Street',
      custom: (
        <EditableAddress
          value={{
            address: value?.addressLine1,
            city: value?.city,
            state: value?.state,
            postalCode: value?.zip,
            country: value?.country,
          }}
          display={value?.addressLine1 || undefined}
          placeholder="Search address"
          onCommit={(data: AddressData) =>
            onPatch({
              addressLine1: data.address,
              city: data.city,
              state: data.state,
              zip: data.postalCode,
              country: data.country,
            })
          }
          ariaLabel="Street address"
        />
      ),
    },
    {
      key: `${keyPrefix}-line2`,
      label: 'Suite / unit',
      value: value?.addressLine2 ?? '',
      placeholder: 'Suite 100',
    },
    { key: `${keyPrefix}-city`, label: 'City', value: value?.city ?? '', placeholder: 'Add city' },
    {
      key: `${keyPrefix}-state`,
      label: 'State',
      value: value?.state ?? '',
      placeholder: 'CA',
      display: value?.state ? <span className="num">{value.state}</span> : undefined,
    },
    {
      key: `${keyPrefix}-zip`,
      label: 'ZIP',
      value: value?.zip ?? '',
      placeholder: '93725',
      display: value?.zip ? <span className="num">{value.zip}</span> : undefined,
    },
    {
      key: `${keyPrefix}-country`,
      label: 'Country',
      value: value?.country ?? '',
      placeholder: 'United States',
    },
  ];
}

const ADDRESS_FIELD_BY_SUFFIX: Record<string, keyof OrgAddress> = {
  line2: 'addressLine2',
  city: 'city',
  state: 'state',
  zip: 'zip',
  country: 'country',
};

// ═══════════════════════════════════════════════════════════════════════════
// Rail: workspace-at-a-glance summary
// ═══════════════════════════════════════════════════════════════════════════

function WorkspaceRail({
  org,
  workosOrgId,
  domains,
  summary,
}: {
  org: OrgSettings;
  workosOrgId: string;
  domains: string[];
  summary: FunctionReturnType<typeof api.settings.getWorkspaceSummary> | undefined;
}) {
  const domain = org.domain || domains.join(', ');
  return (
    <div className="flex flex-col gap-4" style={{ position: 'sticky', top: 0 }}>
      <DSCard title={<SectionTitle sub="Read-only account facts.">Workspace</SectionTitle>}>
        <div className="flex items-center gap-3 mb-3.5">
          <OrgMark name={org.name} logoUrl={org.logoUrl} size={40} />
          <div className="min-w-0">
            <div className="text-[13.5px] font-semibold truncate">{org.name}</div>
            {org.dba && (
              <div className="text-[11.5px] text-[var(--text-tertiary)] truncate">dba {org.dba}</div>
            )}
          </div>
        </div>
        <DSProps
          items={[
            {
              label: 'Plan',
              value: (
                <span className="inline-flex items-center gap-2">
                  <Chip status="active" label="Metered" />
                  {summary && (
                    <span className="num text-[12px] text-[var(--text-tertiary)]">
                      ${summary.ratePerLoad.toFixed(2)} / load
                    </span>
                  )}
                </span>
              ),
            },
            {
              label: 'Workspace ID',
              value: (
                <span className="num text-[12px] truncate" title={workosOrgId}>
                  {workosOrgId}
                </span>
              ),
            },
            { label: 'Created', value: formatDate(org.createdAt) },
            domain ? { label: 'Domain', value: domain } : null,
          ]}
        />
      </DSCard>

      <DSCard title={<SectionTitle>At a glance</SectionTitle>}>
        <div className="grid grid-cols-3 gap-1">
          {[
            { k: 'Drivers', v: summary?.driverCount },
            { k: 'Trucks', v: summary?.truckCount },
            { k: 'Loads / mo', v: summary?.loadsThisCycle },
          ].map((s) => (
            <div key={s.k}>
              <div className="num text-[20px] font-semibold" style={{ letterSpacing: -0.01 }}>
                {s.v ?? '—'}
              </div>
              <div className="tw-label text-[10px] mt-0.5">{s.k}</div>
            </div>
          ))}
        </div>
      </DSCard>
    </div>
  );
}

// ─── Loading skeleton ─────────────────────────────────────────────────────

function GeneralSkeleton() {
  return (
    <div
      style={{
        display: 'grid',
        gridTemplateColumns: `minmax(0, 1fr) ${RAIL_W}px`,
        gap: 24,
        padding: 24,
        alignItems: 'start',
      }}
    >
      <div className="flex flex-col gap-4 min-w-0">
        {[200, 240, 320, 220].map((h, i) => (
          <div
            key={i}
            className="animate-pulse"
            style={{
              height: h,
              borderRadius: 10,
              background: 'var(--bg-surface)',
              border: '1px solid var(--border-hairline)',
            }}
          />
        ))}
      </div>
      <div className="flex flex-col gap-4">
        {[220, 120].map((h, i) => (
          <div
            key={i}
            className="animate-pulse"
            style={{
              height: h,
              borderRadius: 10,
              background: 'var(--bg-surface)',
              border: '1px solid var(--border-hairline)',
            }}
          />
        ))}
      </div>
    </div>
  );
}

// ─── Initialize CTA — shown until the org row exists ──────────────────────

function InitializeCard({
  initializing,
  onInitialize,
}: {
  initializing: boolean;
  onInitialize: () => void;
}) {
  return (
    <div className="flex-1 flex items-start justify-center p-6" style={{ background: 'var(--bg-canvas)' }}>
      <div
        className="flex flex-col items-center text-center gap-3 p-10 rounded-xl w-full"
        style={{
          maxWidth: 520,
          background: 'var(--bg-surface)',
          border: '1px dashed var(--border-hairline-strong, var(--border-hairline))',
        }}
      >
        <div
          className="inline-flex items-center justify-center"
          style={{
            width: 44,
            height: 44,
            borderRadius: 12,
            background: 'var(--bg-surface-2)',
            color: 'var(--text-tertiary)',
          }}
        >
          <WIcon name="building" size={22} />
        </div>
        <div className="text-[15px] font-semibold">Set up your workspace</div>
        <div className="text-[12.5px] text-[var(--text-tertiary)] leading-[18px]" style={{ maxWidth: 380 }}>
          Create your organization profile with default settings — you can customize everything on
          this page afterwards.
        </div>
        <WBtn accent size="md" onClick={onInitialize} disabled={initializing}>
          {initializing ? 'Initializing…' : 'Initialize settings'}
        </WBtn>
      </div>
    </div>
  );
}

// ═══════════════════════════════════════════════════════════════════════════
// Page
// ═══════════════════════════════════════════════════════════════════════════

interface WorkosOrg {
  name?: string;
  domains?: Array<{ id: string; domain: string }>;
}

export default function GeneralSettingsPage() {
  const organizationId = useOrganizationId();
  const { user } = useAuth();

  const org = useQuery(
    api.settings.getOrgSettings,
    organizationId ? { workosOrgId: organizationId } : 'skip',
  );
  const summary = useQuery(
    api.settings.getWorkspaceSummary,
    organizationId ? { workosOrgId: organizationId } : 'skip',
  );
  const updateOrgSettings = useMutation(api.settings.updateOrgSettings);
  const generateUploadUrl = useMutation(api.settings.generateUploadUrl);
  const requestVerification = useMutation(api.fmcsaVerification.requestVerification);

  // WorkOS-side org facts (name for the init CTA, verified domains for the
  // rail) — same endpoint the legacy /org-settings page used.
  const [workosOrg, setWorkosOrg] = useState<WorkosOrg | null>(null);
  useEffect(() => {
    let cancelled = false;
    fetch('/api/organization')
      .then((r) => r.json())
      .then((data) => {
        if (!cancelled) setWorkosOrg({ name: data.name, domains: data.domains ?? [] });
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, []);

  // ── auto-save plumbing ──────────────────────────────────────────────────
  const [pendingSaves, setPendingSaves] = useState(0);
  const [initializing, setInitializing] = useState(false);
  const [uploadingLogo, setUploadingLogo] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);

  const commit = async (updates: OrgUpdates) => {
    if (!organizationId) return;
    setPendingSaves((n) => n + 1);
    try {
      await updateOrgSettings({ workosOrgId: organizationId, updates });
    } catch (error) {
      console.error('Failed to save settings:', error);
      toast.error('Failed to save changes. Please try again.');
    } finally {
      setPendingSaves((n) => n - 1);
    }
  };

  const handleInitialize = async () => {
    if (!organizationId) return;
    setInitializing(true);
    try {
      await updateOrgSettings({
        workosOrgId: organizationId,
        updates: {
          name: workosOrg?.name || 'Organization',
          domain: workosOrg?.domains?.[0]?.domain,
          industry: 'Transportation & Logistics',
          billingEmail: user?.email,
          billingAddress: { addressLine1: '', city: '', state: '', zip: '', country: 'USA' },
          subscriptionPlan: 'Enterprise',
          subscriptionStatus: 'Active',
          billingCycle: 'Annual',
          nextBillingDate: new Date(Date.now() + 365 * 24 * 60 * 60 * 1000).toISOString(),
        },
      });
      toast.success('Organization settings initialized');
    } catch (error) {
      console.error('Failed to initialize organization:', error);
      toast.error('Failed to initialize organization settings. Please try again.');
    } finally {
      setInitializing(false);
    }
  };

  // Logo upload — 3-step Convex storage pattern (same as legacy page).
  const handleLogoFile = async (event: React.ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    event.target.value = '';
    if (!file || !organizationId) return;
    setUploadingLogo(true);
    try {
      const uploadUrl = await generateUploadUrl();
      const result = await fetch(uploadUrl, {
        method: 'POST',
        headers: { 'Content-Type': file.type },
        body: file,
      });
      const { storageId } = await result.json();
      await updateOrgSettings({
        workosOrgId: organizationId,
        updates: { logoStorageId: storageId },
      });
      toast.success('Logo uploaded');
    } catch (error) {
      console.error('Logo upload failed:', error);
      toast.error('Failed to upload logo. Please try again.');
    } finally {
      setUploadingLogo(false);
    }
  };

  // ── loading / empty states ──────────────────────────────────────────────
  if (org === undefined) {
    return (
      <div className="flex-1 overflow-hidden flex flex-col min-w-0">
        <GeneralHeader saving={false} />
        <div className="scroll-thin flex-1 overflow-auto" style={{ background: 'var(--bg-canvas)' }}>
          <GeneralSkeleton />
        </div>
      </div>
    );
  }

  if (org === null) {
    return (
      <div className="flex-1 overflow-hidden flex flex-col min-w-0">
        <GeneralHeader saving={false} />
        <InitializeCard initializing={initializing} onInitialize={handleInitialize} />
      </div>
    );
  }

  // ── derived values ──────────────────────────────────────────────────────
  const contacts = org.contacts ?? [];
  const mailingSame = org.mailingAddress == null;

  // FMCSA verification state → badge props (convex/fmcsaVerification.ts).
  const av = org.authorityVerification;
  const usdotBadge = !av
    ? ({ state: 'pending', title: 'Not verified yet — run Verify now' } as const)
    : av.usdotStatus === 'verified' && av.allowedToOperate
      ? ({ state: 'verified', title: `FMCSA: ${av.legalName ?? 'active authority'}` } as const)
      : av.usdotStatus === 'verified'
        ? ({ state: 'attention', label: 'Inactive', title: 'FMCSA lists this carrier as not allowed to operate' } as const)
        : av.usdotStatus === 'not_found'
          ? ({ state: 'attention', label: 'Not found', title: av.error } as const)
          : ({ state: 'pending', title: av.error } as const);
  const mcBadge =
    av?.mcStatus === 'verified'
      ? ({ state: 'verified', title: 'Docket number on file with FMCSA' } as const)
      : av?.mcStatus === 'mismatch'
        ? ({ state: 'attention', label: 'Not on file', title: 'This docket number is not registered to the USDOT number above' } as const)
        : ({ state: 'pending', title: 'Verified together with the USDOT number' } as const);

  const handleVerifyNow = async () => {
    if (!organizationId) return;
    try {
      await requestVerification({ workosOrgId: organizationId });
      toast.success('Verification started — results update here shortly.');
    } catch (error) {
      console.error('Failed to start verification:', error);
      toast.error(error instanceof Error ? error.message : 'Failed to start verification');
    }
  };

  const patchBusinessAddress = (patch: Partial<OrgAddress>) =>
    commit({ billingAddress: { ...org.billingAddress, ...patch } });

  const patchMailingAddress = (patch: Partial<OrgAddress>) =>
    commit({
      mailingAddress: { ...(org.mailingAddress ?? org.billingAddress), ...patch },
    });

  const patchContact = (id: string, field: keyof Omit<OrgContact, 'id'>, value: string) =>
    commit({
      contacts: contacts.map((c) => (c.id === id ? { ...c, [field]: value } : c)),
    });

  const addContact = () =>
    commit({
      contacts: [
        ...contacts,
        { id: `c${Date.now()}`, role: '', name: '', email: '', phone: '' },
      ],
    });

  const removeContact = (id: string) =>
    commit({ contacts: contacts.filter((c) => c.id !== id) });

  const onAddressCommit =
    (patcher: (patch: Partial<OrgAddress>) => void) => (key: string, next: string | string[]) => {
      const suffix = key.split('-').pop() ?? '';
      const field = ADDRESS_FIELD_BY_SUFFIX[suffix];
      if (field) patcher({ [field]: Array.isArray(next) ? next.join(', ') : next });
    };

  return (
    <div className="flex-1 overflow-hidden flex flex-col min-w-0">
      <style dangerouslySetInnerHTML={{ __html: CONTACT_STYLES }} />
      <input
        ref={fileInputRef}
        type="file"
        accept="image/*"
        className="hidden"
        onChange={handleLogoFile}
      />
      <GeneralHeader saving={pendingSaves > 0 || uploadingLogo} />

      <div className="scroll-thin flex-1 overflow-auto" style={{ background: 'var(--bg-canvas)' }}>
        <div
          style={{
            display: 'grid',
            gridTemplateColumns: `minmax(0, 1fr) ${RAIL_W}px`,
            gap: 24,
            padding: 24,
            alignItems: 'start',
          }}
        >
          {/* Main column */}
          <div className="flex flex-col gap-4 min-w-0">
            {/* Company identity */}
            <DSCard
              title={
                <SectionTitle sub="How the company is named across invoices, the driver app, and public documents.">
                  Company identity
                </SectionTitle>
              }
            >
              <div className="mb-4">
                <LogoSlot
                  logoUrl={org.logoUrl}
                  name={org.name}
                  uploading={uploadingLogo}
                  onPick={() => fileInputRef.current?.click()}
                  onRemove={() => commit({ logoStorageId: null })}
                />
              </div>
              <DSPropsEditable
                onCommit={(k, v) => commit({ [k]: v } as OrgUpdates)}
                items={[
                  { key: 'name', label: 'Legal name', value: org.name },
                  {
                    key: 'dba',
                    label: 'DBA',
                    value: org.dba ?? '',
                    placeholder: 'Doing-business-as name',
                  },
                  {
                    key: 'entityType',
                    label: 'Entity type',
                    value: org.entityType ?? '',
                    placeholder: 'Select entity type',
                    editor: { type: 'select', options: ENTITY_OPTS },
                  },
                  {
                    key: 'industry',
                    label: 'Industry',
                    value: org.industry ?? '',
                    placeholder: 'Transportation & Logistics',
                  },
                ]}
              />
            </DSCard>

            {/* Carrier authority */}
            <DSCard
              title={
                <SectionTitle sub="Federal and NMFTA identifiers. Verified numbers are checked nightly against FMCSA.">
                  Carrier authority
                </SectionTitle>
              }
              action={
                <span className="inline-flex items-center gap-2.5">
                  {av && (
                    <span className="text-[11.5px] text-[var(--text-tertiary)] whitespace-nowrap">
                      Last checked {formatDate(av.checkedAt)}
                    </span>
                  )}
                  <WBtn
                    size="sm"
                    leading="refresh"
                    onClick={handleVerifyNow}
                    disabled={!org.usdotNumber?.trim()}
                    title={org.usdotNumber?.trim() ? undefined : 'Add a USDOT number first'}
                  >
                    Verify now
                  </WBtn>
                </span>
              }
            >
              <DSPropsEditable
                onCommit={(k, v) => commit({ [k]: v } as OrgUpdates)}
                items={[
                  {
                    key: 'usdotNumber',
                    label: 'USDOT #',
                    value: org.usdotNumber ?? '',
                    placeholder: 'Add USDOT number',
                    display: org.usdotNumber ? <span className="num">{org.usdotNumber}</span> : undefined,
                    trailing: org.usdotNumber ? <VerifyBadge {...usdotBadge} /> : undefined,
                  },
                  {
                    key: 'mcNumber',
                    label: 'MC / docket #',
                    value: org.mcNumber ?? '',
                    placeholder: 'MC-000000',
                    display: org.mcNumber ? <span className="num">{org.mcNumber}</span> : undefined,
                    trailing: org.mcNumber ? <VerifyBadge {...mcBadge} /> : undefined,
                  },
                  {
                    key: 'scacCode',
                    label: 'SCAC',
                    value: org.scacCode ?? '',
                    placeholder: 'Add SCAC',
                    display: org.scacCode ? <span className="num">{org.scacCode}</span> : undefined,
                  },
                  org.safetyRating
                    ? {
                        key: 'safetyRating',
                        label: 'Safety rating',
                        readOnly: true,
                        value: org.safetyRating,
                      }
                    : null,
                ]}
              />
            </DSCard>

            {/* Addresses */}
            <DSCard
              title={
                <SectionTitle sub="Physical place of business — also the billing address on platform invoices.">
                  Business address
                </SectionTitle>
              }
            >
              <DSPropsEditable
                onCommit={onAddressCommit(patchBusinessAddress)}
                items={addressItems(org.billingAddress, patchBusinessAddress, 'biz')}
              />
            </DSCard>

            <DSCard
              title={
                <SectionTitle sub="Where paper mail and checks are sent.">Mailing address</SectionTitle>
              }
              action={
                <label className="inline-flex items-center gap-2 cursor-pointer select-none">
                  <span className="text-[11.5px] text-[var(--text-tertiary)]">Same as business</span>
                  <Switch
                    checked={mailingSame}
                    onCheckedChange={(same) =>
                      commit({ mailingAddress: same ? null : { ...org.billingAddress } })
                    }
                    aria-label="Mailing address same as business"
                  />
                </label>
              }
            >
              {mailingSame ? (
                <div className="text-[12.5px] text-[var(--text-tertiary)] leading-[18px]">
                  Mail goes to the business address
                  {org.billingAddress?.addressLine1 ? (
                    <> — {org.billingAddress.addressLine1}, {org.billingAddress.city}</>
                  ) : null}
                  . Toggle off to set a separate PO box or mailing address.
                </div>
              ) : (
                <DSPropsEditable
                  onCommit={onAddressCommit(patchMailingAddress)}
                  items={addressItems(org.mailingAddress ?? undefined, patchMailingAddress, 'mail')}
                />
              )}
            </DSCard>

            {/* Primary contacts */}
            <DSCard
              title={
                <SectionTitle sub="Who partners, brokers, and Otoqa reach for each function. The billing contact receives platform invoices.">
                  Primary contacts
                </SectionTitle>
              }
              bodyClassName="p-0"
              action={
                <WBtn size="sm" leading="plus" onClick={addContact}>
                  Add contact
                </WBtn>
              }
            >
              <div className="gen-contacts">
                <div
                  className="gen-contact-head"
                  style={{
                    padding: '9px 14px',
                    borderBottom: '1px solid var(--border-hairline)',
                    background: 'var(--bg-surface-2)',
                  }}
                >
                  <div className="tw-label text-[10px]" style={{ gridArea: 'role' }}>
                    Role
                  </div>
                  <div className="tw-label text-[10px]" style={{ gridArea: 'contact' }}>
                    Contact
                  </div>
                  <div className="tw-label text-[10px]" style={{ gridArea: 'email' }}>
                    Email
                  </div>
                  <div className="tw-label text-[10px]" style={{ gridArea: 'phone' }}>
                    Phone
                  </div>
                  <div style={{ gridArea: 'trash' }} />
                </div>
                {/* Pinned billing contact — writes the same fields the legacy
                    billing form edited (billingEmail / billingPhone). */}
                <ContactRow
                  first
                  pinned
                  role="Billing / AP"
                  name={org.billingContactName ?? ''}
                  email={org.billingEmail ?? ''}
                  phone={org.billingPhone ?? ''}
                  onCommit={(field, v) => {
                    if (field === 'name') commit({ billingContactName: v });
                    if (field === 'email') commit({ billingEmail: v });
                    if (field === 'phone') commit({ billingPhone: v });
                  }}
                />
                {contacts.map((c) => (
                  <ContactRow
                    key={c.id}
                    first={false}
                    role={c.role}
                    name={c.name}
                    email={c.email}
                    phone={c.phone}
                    onCommit={(field, v) => patchContact(c.id, field, v)}
                    onRemove={() => removeContact(c.id)}
                  />
                ))}
              </div>
            </DSCard>

            {/* Regional & formats */}
            <DSCard
              title={
                <SectionTitle sub="How Otoqa displays time, distance, and money for this workspace.">
                  Regional & formats
                </SectionTitle>
              }
            >
              <DSPropsEditable
                onCommit={(k, v) => commit({ [k]: v } as OrgUpdates)}
                items={[
                  {
                    key: 'defaultTimezone',
                    label: 'Time zone',
                    value: org.defaultTimezone ?? 'America/New_York',
                    display: optLabel(TZ_OPTS, org.defaultTimezone ?? 'America/New_York'),
                    editor: { type: 'select', options: TZ_OPTS },
                  },
                  {
                    key: 'dateFormat',
                    label: 'Date format',
                    value: org.dateFormat ?? 'MM/DD/YYYY',
                    display: <span className="num">{org.dateFormat ?? 'MM/DD/YYYY'}</span>,
                    editor: { type: 'select', options: DATEFMT_OPTS },
                  },
                  {
                    key: 'distanceUnit',
                    label: 'Distance units',
                    value: org.distanceUnit ?? 'mi',
                    display: optLabel(DIST_OPTS, org.distanceUnit ?? 'mi'),
                    editor: { type: 'select', options: DIST_OPTS },
                  },
                  {
                    key: 'defaultCurrency',
                    label: 'Currency',
                    value: org.defaultCurrency ?? 'USD',
                    display: optLabel(CURR_OPTS, org.defaultCurrency ?? 'USD'),
                    editor: { type: 'select', options: CURR_OPTS },
                  },
                  {
                    key: 'weekStart',
                    label: 'Week starts on',
                    value: org.weekStart ?? 'monday',
                    display: optLabel(WEEK_OPTS, org.weekStart ?? 'monday'),
                    editor: { type: 'select', options: WEEK_OPTS },
                  },
                  {
                    key: 'numberFormat',
                    label: 'Number format',
                    value: org.numberFormat ?? '1,234.56',
                    display: <span className="num">{org.numberFormat ?? '1,234.56'}</span>,
                    editor: { type: 'select', options: NUMFMT_OPTS },
                  },
                ]}
              />
            </DSCard>

            {/* Invoice numbering — configurable prefix, real sequence */}
            <DSCard
              title={
                <SectionTitle sub="Numbers are issued automatically — one prefix-YYYY-NNNN sequence per year. Clearing the prefix reverts to INV-.">
                  Invoice numbering
                </SectionTitle>
              }
            >
              <DSPropsEditable
                onCommit={(k, v) => {
                  if (k === 'invoicePrefix') {
                    const next = Array.isArray(v) ? v.join('') : v;
                    commit({ invoicePrefix: next.trim() === '' ? null : next });
                  }
                }}
                items={[
                  {
                    key: 'invoicePrefix',
                    label: 'Invoice prefix',
                    value: org.invoicePrefix ?? 'INV-',
                    placeholder: 'INV-',
                    display: <span className="num">{org.invoicePrefix ?? 'INV-'}</span>,
                  },
                  {
                    key: 'nextInv',
                    label: 'Next invoice #',
                    readOnly: true,
                    value: summary?.nextInvoiceNumber ?? '',
                    display: summary ? (
                      <span className="num">{summary.nextInvoiceNumber}</span>
                    ) : (
                      <span className="text-[var(--text-tertiary)]">—</span>
                    ),
                  },
                ]}
              />
            </DSCard>
          </div>

          {/* Rail */}
          <WorkspaceRail
            org={org}
            workosOrgId={organizationId}
            domains={(workosOrg?.domains ?? []).map((d) => d.domain)}
            summary={summary}
          />
        </div>
      </div>
    </div>
  );
}

function GeneralHeader({ saving }: { saving: boolean }) {
  return (
    <SettingsHeader
      eyebrow="Settings"
      title="General"
      subtitle="Your company profile, carrier authority, and the regional formats Otoqa uses across the workspace."
      actions={<SavedIndicator saving={saving} />}
    />
  );
}
