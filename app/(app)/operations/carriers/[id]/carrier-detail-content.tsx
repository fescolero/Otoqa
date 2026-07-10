/**
 * CarrierDetailContent — full-page carrier record on the Otoqa Web chassis.
 *
 * Mirrors the layout in design v2's details-carrier.jsx (variant A,
 * "Compliance-first"):
 *   - DetailsFullPage shell with sub-toolbar (back / prev-next / actions)
 *   - Hero: avatar + title + identity subtitle + 4-up KPI grid
 *   - Sections: Overview · Authority & Insurance · Driver (owner-op) ·
 *     Loads · Pay profile · Documents · Activity
 *   - Right rail: action-needed / compliance / network cards
 *
 * Data comes from api.carrierPartnerships.get; assigned loads from
 * api.loads.getByCarrierPartnership; carrier pay editor reused as-is.
 */

'use client';

import * as React from 'react';
import { useRouter } from 'next/navigation';
import { useQuery, useMutation } from 'convex/react';
import { Loader2 } from 'lucide-react';
import { toast } from 'sonner';

import {
  Avatar,
  Chip,
  type ChipStatus,
  DSActivity,
  DSCard,
  DSMiniTable,
  type DSMiniColumn,
  DSPropsEditable,
  type DSPropsEditableItem,
  DetailsFullPage,
  type FPKpi,
  type FPSection,
  WBtn,
  WIcon,
} from '@/components/web';
import { CarrierPaySettingsSection } from '@/components/carrier-pay';
import {
  AssignedLoadsTable,
  type AssignedLoad,
  type AssignedLoadStatus,
} from '@/components/loads/assigned-loads-table';
import { api } from '@/convex/_generated/api';
import type { Id } from '@/convex/_generated/dataModel';
import { useAuth } from '@workos-inc/authkit-nextjs/components';
import { useOrganizationId } from '@/contexts/organization-context';

// ─── Helpers ────────────────────────────────────────────────────────────

function parseYmd(s?: string): { y: number; m: number; d: number } | null {
  if (!s) return null;
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(s);
  if (!m) return null;
  return { y: Number(m[1]), m: Number(m[2]), d: Number(m[3]) };
}

function formatDate(s?: string | number): string {
  if (s === undefined || s === null || s === '') return '—';
  if (typeof s === 'number') {
    const d = new Date(s);
    if (Number.isNaN(d.getTime())) return '—';
    return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
  }
  const parsed = parseYmd(s);
  if (parsed) {
    const d = new Date(Date.UTC(parsed.y, parsed.m - 1, parsed.d));
    return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric', timeZone: 'UTC' });
  }
  const d = new Date(s);
  return Number.isNaN(d.getTime()) ? '—' : d.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
}

function expirationStatus(exp?: string | number): 'valid' | 'expiring' | 'expired' | 'na' {
  if (exp === undefined || exp === null || exp === '') return 'na';
  let ms: number;
  if (typeof exp === 'number') {
    ms = exp;
  } else {
    const p = parseYmd(exp);
    ms = p ? Date.UTC(p.y, p.m - 1, p.d) : new Date(exp).getTime();
  }
  if (!Number.isFinite(ms)) return 'na';
  const now = new Date();
  const today = Date.UTC(now.getFullYear(), now.getMonth(), now.getDate());
  const days = Math.ceil((ms - today) / 86_400_000);
  if (days < 0) return 'expired';
  if (days <= 30) return 'expiring';
  return 'valid';
}

function partnershipChip(status: string): { status: ChipStatus; label: string } {
  switch ((status || '').toUpperCase()) {
    case 'ACTIVE':     return { status: 'active',    label: 'Active' };
    case 'INVITED':    return { status: 'pending',   label: 'Invited' };
    case 'PENDING':    return { status: 'pending',   label: 'Pending' };
    case 'SUSPENDED':  return { status: 'danger',    label: 'Suspended' };
    case 'TERMINATED': return { status: 'cancelled', label: 'Terminated' };
    default:           return { status: 'draft',     label: status || 'Unknown' };
  }
}

export function CarrierDetailContent({ carrierId }: { carrierId: string }) {
  const router = useRouter();
  const { user } = useAuth();
  const organizationId = useOrganizationId();
  const partnershipId = carrierId as Id<'carrierPartnerships'>;

  const partnership = useQuery(api.carrierPartnerships.get, { partnershipId });

  const [loadStatusFilter, setLoadStatusFilter] = React.useState<AssignedLoadStatus>('Assigned');
  const carrierLoads = useQuery(
    api.loads.getByCarrierPartnership,
    partnershipId ? { partnershipId, status: loadStatusFilter } : 'skip',
  );

  // Prev / next across the broker's active partnerships, so the sub-toolbar
  // navigation chevrons feel correct.
  const allPartnerships = useQuery(
    api.carrierPartnerships.listForBroker,
    organizationId ? { brokerOrgId: organizationId } : 'skip',
  );

  const bulkTerminate = useMutation(api.carrierPartnerships.bulkTerminate);
  const bulkReactivate = useMutation(api.carrierPartnerships.bulkReactivate);
  const updatePartnership = useMutation(api.carrierPartnerships.update);

  // Inline-edit commit. Each Overview / Authority field commits a single-arg
  // patch to api.carrierPartnerships.update. Field keys map straight to
  // mutation args; unknown keys are dropped so adding a new editable row
  // doesn't accidentally write to fields the backend doesn't accept.
  const ALLOWED_FIELDS = new Set([
    'mcNumber', 'usdotNumber',
    'carrierName', 'carrierDba',
    'contactFirstName', 'contactLastName', 'contactEmail', 'contactPhone',
    'insuranceProvider', 'insuranceExpiration',
    'addressLine', 'addressLine2', 'city', 'state', 'zip', 'country',
    'defaultPaymentTerms', 'internalNotes', 'preferredLanes', 'rating',
    'ownerDriverFirstName', 'ownerDriverLastName',
    'ownerDriverPhone', 'ownerDriverEmail',
    'ownerDriverLicenseNumber', 'ownerDriverLicenseState',
    'ownerDriverLicenseClass', 'ownerDriverLicenseExpiration',
  ]);

  const commitField = async (key: string, next: string | string[]) => {
    if (!ALLOWED_FIELDS.has(key)) return;
    const patch: Record<string, unknown> = {};
    if (key === 'preferredLanes') {
      patch[key] = Array.isArray(next)
        ? next
        : next.split(',').map((s) => s.trim()).filter(Boolean);
    } else if (key === 'rating') {
      const n = parseFloat(Array.isArray(next) ? next[0] ?? '' : next);
      patch[key] = Number.isFinite(n) ? n : undefined;
    } else {
      patch[key] = Array.isArray(next) ? next.join(', ') : next;
    }
    try {
      await updatePartnership({ partnershipId, ...patch });
      toast.success('Saved');
    } catch (e) {
      console.error(e);
      toast.error('Failed to save change');
    }
  };

  if (partnership === undefined) {
    return (
      <div className="flex-1 flex items-center justify-center">
        <Loader2 className="h-5 w-5 animate-spin text-[var(--text-tertiary)]" />
      </div>
    );
  }
  if (partnership === null) {
    return (
      <div className="flex-1 flex items-center justify-center text-[12.5px] text-[var(--text-tertiary)]">
        Carrier not found.
      </div>
    );
  }

  const name = partnership.carrierName ?? 'Unknown carrier';
  const dba = partnership.carrierDba;
  const isLinked = !!partnership.carrierOrgId;
  const isOwnerOperator = partnership.isOwnerOperator ?? partnership.carrierOrg?.isOwnerOperator ?? false;
  const insStatus = expirationStatus(partnership.insuranceExpiration);

  const contactName =
    [partnership.contactFirstName, partnership.contactLastName].filter(Boolean).join(' ').trim() || '—';
  const contactEmail = partnership.contactEmail ?? '—';
  const contactPhone = partnership.contactPhone ?? '—';

  const addressLine =
    [
      partnership.addressLine,
      partnership.addressLine2,
      [partnership.city, partnership.state].filter(Boolean).join(', '),
      partnership.zip,
    ]
      .filter(Boolean)
      .join(' · ') || '—';

  const partnershipStatusChip = partnershipChip(partnership.status);
  const sinceLabel = partnership._creationTime ? formatDate(partnership._creationTime) : '—';

  // Eyebrow = the dominant attention signal. Insurance trumps suspension.
  const eyebrow = (() => {
    if (insStatus === 'expired') return <Chip status="danger" label="Insurance expired" />;
    if (insStatus === 'expiring') return <Chip status="pending" label="Insurance expiring" />;
    return <Chip status={partnershipStatusChip.status} label={partnershipStatusChip.label} />;
  })();

  const titleNode = (
    <span className="inline-flex items-center gap-3">
      <span>{name}</span>
      {isLinked && (
        <span className="inline-flex items-center gap-1 h-5 px-1.5 rounded-md border text-[10.5px] font-medium tracking-[0.02em] leading-none"
          style={{
            color: 'var(--accent)',
            background: 'rgba(46,92,255,0.10)',
            borderColor: 'rgba(46,92,255,0.30)',
          }}
        >
          <WIcon name="badge-check" size={11} /> Linked
        </span>
      )}
      {isOwnerOperator && (
        <span className="inline-flex items-center gap-1 h-5 px-1.5 rounded-md border text-[10.5px] font-medium tracking-[0.02em] leading-none"
          style={{
            color: 'var(--bar-open-fg)',
            background: 'var(--bar-open-bg)',
            borderColor: 'var(--bar-open-bd)',
          }}
        >
          <WIcon name="id-card" size={11} /> Owner-Op
        </span>
      )}
    </span>
  );

  const subtitle = (
    <span className="flex flex-wrap items-center gap-x-4 gap-y-1 text-[13px] text-[var(--text-secondary)]">
      {partnership.mcNumber && (
        <span className="num inline-flex items-center gap-1.5">
          <WIcon name="shield" size={12} /> MC #{partnership.mcNumber}
        </span>
      )}
      {partnership.usdotNumber && (
        <span className="num inline-flex items-center gap-1.5">
          <WIcon name="shield" size={12} /> DOT #{partnership.usdotNumber}
        </span>
      )}
      {dba && <span className="inline-flex items-center gap-1.5">DBA: {dba}</span>}
      <span className="inline-flex items-center gap-1.5">
        <WIcon name="calendar" size={12} /> Since {sinceLabel}
      </span>
    </span>
  );

  const kpis: FPKpi[] = [
    {
      label: 'Insurance',
      value: insStatus === 'valid' ? 'Valid' : insStatus === 'expiring' ? 'Expiring' : insStatus === 'expired' ? 'Expired' : 'N/A',
      delta:
        partnership.insuranceExpiration
          ? { value: `exp ${formatDate(partnership.insuranceExpiration)}`, tone: insStatus === 'expired' ? 'down' : insStatus === 'expiring' ? 'neutral' : 'up' }
          : undefined,
    },
    {
      label: 'Authority',
      value: partnership.mcNumber || partnership.usdotNumber ? 'On file' : '—',
      delta: { value: [partnership.mcNumber ? 'MC' : null, partnership.usdotNumber ? 'DOT' : null].filter(Boolean).join(' + ') || 'unverified', tone: 'neutral' },
    },
    {
      label: 'Status',
      value: partnershipStatusChip.label,
    },
    {
      label: 'Rating',
      value: typeof partnership.rating === 'number' ? `${partnership.rating.toFixed(1)} / 5` : '—',
    },
  ];

  // ─── Section: Overview ────────────────────────────────────────────────
  const overviewContent = (
    <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
      <DSCard
        title="Authority"
        action={
          insStatus !== 'valid' ? <Chip status={insStatus === 'na' ? 'na' : insStatus} /> : null
        }
      >
        <DSPropsEditable
          onCommit={commitField}
          items={[
            {
              key: 'mcNumber',
              label: 'MC #',
              value: partnership.mcNumber ?? '',
              display: partnership.mcNumber
                ? <span className="num" style={{ fontWeight: 500 }}>{partnership.mcNumber}</span>
                : undefined,
              editor: { type: 'text' },
              placeholder: 'Add MC #',
            },
            {
              key: 'usdotNumber',
              label: 'DOT #',
              value: partnership.usdotNumber ?? '',
              display: partnership.usdotNumber
                ? <span className="num">{partnership.usdotNumber}</span>
                : undefined,
              editor: { type: 'text' },
              placeholder: 'Add DOT #',
            },
            {
              key: 'type',
              label: 'Type',
              value: isOwnerOperator ? 'Owner Operator' : 'Carrier',
              readOnly: true,
            },
            {
              key: 'authority',
              label: 'Authority',
              value: '',
              display: partnership.mcNumber || partnership.usdotNumber
                ? <Chip status="valid" label="On file" />
                : <Chip status="na" />,
              readOnly: true,
            },
          ]}
        />
      </DSCard>

      <DSCard title="Insurance">
        <DSPropsEditable
          onCommit={commitField}
          items={[
            {
              key: 'insuranceProvider',
              label: 'Insurer',
              value: partnership.insuranceProvider ?? '',
              editor: { type: 'text' },
              placeholder: 'Add insurer',
            },
            {
              key: 'insuranceExpiration',
              label: 'Expires',
              value: partnership.insuranceExpiration ?? '',
              // Date sits inside the editor button (clickable to open the
              // calendar); the status chip lives in `trailing` so the
              // editor's hover/focus background doesn't extend over it —
              // otherwise the chip reads as if it were selectable too.
              display: <span className="num">{formatDate(partnership.insuranceExpiration)}</span>,
              trailing: <Chip status={insStatus === 'na' ? 'na' : insStatus} />,
              editor: { type: 'date' },
              placeholder: 'Pick expiration date',
            },
            {
              key: 'coverage',
              label: 'Coverage',
              value: '',
              display: (
                <span className="num">{partnership.insuranceCoverageVerified ? 'Verified' : 'Pending verification'}</span>
              ),
              readOnly: true,
            },
          ]}
        />
      </DSCard>

      <DSCard title="Contact">
        <DSPropsEditable
          onCommit={commitField}
          items={[
            {
              key: 'contactFirstName',
              label: 'First name',
              value: partnership.contactFirstName ?? '',
              editor: { type: 'text' },
              placeholder: 'Add first name',
            },
            {
              key: 'contactLastName',
              label: 'Last name',
              value: partnership.contactLastName ?? '',
              editor: { type: 'text' },
              placeholder: 'Add last name',
            },
            {
              key: 'contactPhone',
              label: 'Phone',
              value: partnership.contactPhone ?? '',
              display: partnership.contactPhone
                ? <span className="num">{partnership.contactPhone}</span>
                : undefined,
              editor: { type: 'phone' },
              placeholder: 'Add phone',
            },
            {
              key: 'contactEmail',
              label: 'Email',
              value: partnership.contactEmail ?? '',
              editor: { type: 'email' },
              placeholder: 'Add email',
            },
            {
              key: 'addressLine',
              label: 'Address',
              value: partnership.addressLine ?? '',
              editor: { type: 'text' },
              placeholder: 'Street address',
            },
            {
              key: 'city',
              label: 'City',
              value: partnership.city ?? '',
              editor: { type: 'text' },
              placeholder: 'City',
            },
            {
              key: 'state',
              label: 'State',
              value: partnership.state ?? '',
              editor: { type: 'text' },
              placeholder: 'CA',
            },
            {
              key: 'zip',
              label: 'Zip',
              value: partnership.zip ?? '',
              editor: { type: 'text' },
              placeholder: '95823',
            },
          ]}
        />
      </DSCard>

      <DSCard title="Preferences">
        <DSPropsEditable
          onCommit={commitField}
          items={[
            {
              key: 'defaultPaymentTerms',
              label: 'Payment terms',
              value: partnership.defaultPaymentTerms ?? '',
              editor: {
                type: 'select',
                options: [
                  { value: 'Net 7',  label: 'Net 7' },
                  { value: 'Net 15', label: 'Net 15' },
                  { value: 'Net 30', label: 'Net 30' },
                  { value: 'Net 45', label: 'Net 45' },
                  { value: 'Net 60', label: 'Net 60' },
                  { value: 'Quick-pay', label: 'Quick-pay' },
                ],
              },
              placeholder: 'Pick terms',
            },
            {
              key: 'preferredLanes',
              label: 'Preferred lanes',
              value: partnership.preferredLanes ?? [],
              display: partnership.preferredLanes && partnership.preferredLanes.length > 0
                ? <span>{partnership.preferredLanes.join(' · ')}</span>
                : undefined,
              editor: { type: 'text' },
              placeholder: 'Comma-separated lanes',
            },
            {
              key: 'internalNotes',
              label: 'Internal notes',
              value: partnership.internalNotes ?? '',
              editor: { type: 'textarea', rows: 3 },
              placeholder: 'Add notes',
            },
          ]}
        />
      </DSCard>

      {isOwnerOperator && (
        <div className="md:col-span-2">
          <OwnerOperatorCard
            partnership={partnership}
            commitField={commitField}
            onOpenProfile={partnership.ownerDriver
              ? () => router.push(`/fleet/drivers/${partnership.ownerDriver!._id}`)
              : null}
          />
        </div>
      )}
    </div>
  );

  // ─── Section: Authority & Insurance ──────────────────────────────────
  const authorityContent = (
    <div className="flex flex-col gap-3">
      <DSCard title="Operating authority">
        <DSPropsEditable
          onCommit={commitField}
          items={[
            {
              key: 'mcNumber',
              label: 'MC #',
              value: partnership.mcNumber ?? '',
              display: partnership.mcNumber
                ? <span className="num" style={{ fontWeight: 500 }}>{partnership.mcNumber}</span>
                : undefined,
              editor: { type: 'text' },
              placeholder: 'Add MC #',
            },
            {
              key: 'usdotNumber',
              label: 'DOT #',
              value: partnership.usdotNumber ?? '',
              display: partnership.usdotNumber
                ? <span className="num">{partnership.usdotNumber}</span>
                : undefined,
              editor: { type: 'text' },
              placeholder: 'Add DOT #',
            },
            {
              key: 'authority-status',
              label: 'Authority status',
              value: '',
              display: partnership.mcNumber || partnership.usdotNumber
                ? <Chip status="valid" label="On file" />
                : <Chip status="na" />,
              readOnly: true,
            },
          ]}
        />
      </DSCard>
      <DSCard title="Current insurance">
        <DSPropsEditable
          onCommit={commitField}
          items={[
            {
              key: 'insuranceProvider',
              label: 'Insurer',
              value: partnership.insuranceProvider ?? '',
              editor: { type: 'text' },
              placeholder: 'Add insurer',
            },
            {
              key: 'insuranceExpiration',
              label: 'Expires',
              value: partnership.insuranceExpiration ?? '',
              display: <span className="num">{formatDate(partnership.insuranceExpiration)}</span>,
              editor: { type: 'date' },
              placeholder: 'Pick expiration date',
            },
            {
              key: 'status',
              label: 'Status',
              value: '',
              display: <Chip status={insStatus === 'na' ? 'na' : insStatus} />,
              readOnly: true,
            },
            {
              key: 'verified',
              label: 'Verified',
              value: '',
              display: partnership.insuranceCoverageVerified
                ? <Chip status="valid" />
                : <Chip status="pending" label="Pending" />,
              readOnly: true,
            },
          ]}
        />
      </DSCard>
    </div>
  );

  // ─── Section: Driver (owner-op only) ─────────────────────────────────
  const driverContent = isOwnerOperator ? (
    <OwnerOperatorCard
      partnership={partnership}
      detail
      commitField={commitField}
      onOpenProfile={partnership.ownerDriver
        ? () => router.push(`/fleet/drivers/${partnership.ownerDriver!._id}`)
        : null}
    />
  ) : null;

  // ─── Section: Loads ──────────────────────────────────────────────────
  const loadsContent = (
    <DSCard title="Loads" bodyClassName="p-0">
      <AssignedLoadsTable
        loads={(carrierLoads ?? []) as AssignedLoad[]}
        isLoading={carrierLoads === undefined}
        statusFilter={loadStatusFilter}
        onStatusFilterChange={setLoadStatusFilter}
        showCarrierRate
      />
    </DSCard>
  );

  // ─── Section: Pay ────────────────────────────────────────────────────
  const payContent = (
    <DSCard title="Carrier compensation">
      {organizationId && user ? (
        <CarrierPaySettingsSection
          carrierPartnershipId={partnershipId}
          organizationId={organizationId}
          userId={user.id}
        />
      ) : (
        <p className="m-0 text-[12.5px] text-[var(--text-tertiary)]">Sign in to manage carrier pay profiles.</p>
      )}
    </DSCard>
  );

  // ─── Section: Documents ──────────────────────────────────────────────
  // Real document storage isn't wired for carriers yet — placeholder card.
  const documentsContent = (
    <DSCard
      title="Documents"
      action={<WBtn size="sm" leading="plus">Upload</WBtn>}
    >
      <DSActivity
        emptyText="No documents uploaded yet."
        items={[]}
      />
    </DSCard>
  );

  // ─── Section: Activity ───────────────────────────────────────────────
  const activityItems = [
    { icon: 'plus' as const, text: 'Partnership created', when: sinceLabel },
    partnership.insuranceCoverageVerified
      ? { icon: 'check' as const, text: 'Insurance verified', when: '' }
      : { icon: 'alert' as const, text: 'Insurance pending verification', when: '' },
    isLinked
      ? { icon: 'badge-check' as const, text: 'Carrier account linked', when: '' }
      : { icon: 'pulse' as const, text: 'Operating as managed carrier', when: '' },
  ];
  const activityContent = (
    <DSCard title="Recent activity">
      <DSActivity items={activityItems} />
    </DSCard>
  );

  const sections: FPSection[] = [
    { id: 'overview',  label: 'Overview',  icon: 'home',        content: overviewContent },
    { id: 'authority', label: 'Authority & Insurance', icon: 'shield',
      attention: insStatus === 'expired' || insStatus === 'expiring' ? 1 : 0,
      content: authorityContent },
    ...(driverContent
      ? [{ id: 'driver', label: 'Driver', icon: 'id-card' as const, content: driverContent } satisfies FPSection]
      : []),
    { id: 'loads',     label: 'Loads',     icon: 'package',     count: carrierLoads?.length, content: loadsContent },
    { id: 'pay',       label: 'Pay profile', icon: 'doc-dollar', content: payContent },
    { id: 'documents', label: 'Documents', icon: 'file-text',   content: documentsContent },
    { id: 'activity',  label: 'Activity',  icon: 'pulse',       content: activityContent },
  ];

  // Right rail — action needed, compliance summary, network at a glance.
  const rightRail = (
    <div className="flex flex-col gap-3">
      {(insStatus === 'expired' || insStatus === 'expiring') && (
        <DSCard title="Action needed">
          <DSActivity
            items={[
              {
                icon: 'alert',
                text: `Insurance ${insStatus === 'expired' ? 'expired' : 'expiring'} on ${formatDate(partnership.insuranceExpiration)}`,
                when: 'needs renewal',
              },
            ]}
          />
        </DSCard>
      )}
      <DSCard title="Compliance">
        <DSActivity
          items={[
            partnership.mcNumber || partnership.usdotNumber
              ? { icon: 'check', text: 'Operating authority on file', when: '' }
              : { icon: 'alert', text: 'Operating authority missing', when: '' },
            insStatus === 'valid'
              ? { icon: 'check', text: 'Insurance current', when: formatDate(partnership.insuranceExpiration) }
              : insStatus === 'na'
                ? { icon: 'alert', text: 'No insurance on file', when: '' }
                : { icon: 'alert', text: `Insurance ${insStatus}`, when: formatDate(partnership.insuranceExpiration) },
            partnership.insuranceCoverageVerified
              ? { icon: 'check', text: 'Coverage verified', when: '' }
              : { icon: 'circle-dot', text: 'Coverage pending verification', when: '' },
          ]}
        />
      </DSCard>
      <DSCard title="Network">
        <DSActivity
          items={[
            { icon: 'users', text: `${carrierLoads?.length ?? '—'} active load${carrierLoads?.length === 1 ? '' : 's'}`, when: '' },
            { icon: 'pulse', text: partnership.status === 'ACTIVE' ? 'Active partner' : `Status: ${partnershipStatusChip.label}`, when: '' },
            { icon: 'handshake', text: isLinked ? 'Linked carrier account' : 'Managed carrier', when: '' },
          ]}
        />
      </DSCard>
    </div>
  );

  // ─── Sub-toolbar actions ──────────────────────────────────────────────
  const isTerminated = partnership.status === 'TERMINATED';
  const userName = user?.firstName && user?.lastName ? `${user.firstName} ${user.lastName}` : user?.email ?? '';

  const onTerminate = async () => {
    if (!user) return;
    if (!window.confirm(`Terminate partnership with ${name}?`)) return;
    try {
      await bulkTerminate({
        partnershipIds: [partnershipId],
        userId: user.id,
        userName,
      });
      toast.success('Partnership terminated');
    } catch (e) {
      console.error(e);
      toast.error('Failed to terminate partnership');
    }
  };
  const onReactivate = async () => {
    if (!user) return;
    try {
      await bulkReactivate({
        partnershipIds: [partnershipId],
        userId: user.id,
        userName,
      });
      toast.success('Partnership reactivated');
    } catch (e) {
      console.error(e);
      toast.error('Failed to reactivate partnership');
    }
  };

  // Prev / next traversal across the active partnerships list.
  const list = (allPartnerships ?? []).filter((p) => p.status !== 'TERMINATED');
  const idx = list.findIndex((p) => p._id === partnership._id);
  const prev = idx > 0 ? list[idx - 1] : null;
  const next = idx >= 0 && idx < list.length - 1 ? list[idx + 1] : null;

  return (
    <DetailsFullPage
      breadcrumb={
        <span className="inline-flex items-center gap-1.5 text-[var(--text-secondary)]">
          <button
            type="button"
            onClick={() => router.push('/operations/carriers')}
            className="hover:text-foreground"
          >
            Carriers
          </button>
          <span className="text-[var(--text-tertiary)]">/</span>
          <span className="text-foreground font-medium truncate max-w-[280px]">{name}</span>
        </span>
      }
      onBack={() => router.push('/operations/carriers')}
      prevLabel={prev?.carrierName ?? undefined}
      onPrev={prev ? () => router.push(`/operations/carriers/${prev._id}`) : null}
      nextLabel={next?.carrierName ?? undefined}
      onNext={next ? () => router.push(`/operations/carriers/${next._id}`) : null}
      toolbarActions={
        <>
          <WBtn size="sm" variant="ghost" leading="chat">Message</WBtn>
          <WBtn size="sm" variant="ghost" leading="package">Assign load</WBtn>
          {isTerminated ? (
            <WBtn size="sm" variant="secondary" leading="restore" onClick={onReactivate}>Reactivate</WBtn>
          ) : (
            <WBtn size="sm" danger leading="alert" onClick={onTerminate}>Terminate</WBtn>
          )}
        </>
      }
      title={titleNode}
      eyebrow={eyebrow}
      subtitle={subtitle}
      kpis={kpis}
      sections={sections}
      rightRail={rightRail}
    />
  );
}

// ─── Owner-operator driver card ─────────────────────────────────────────

type Partnership = NonNullable<ReturnType<typeof useQuery<typeof api.carrierPartnerships.get>>>;

function OwnerOperatorCard({
  partnership,
  detail = false,
  commitField,
  onOpenProfile,
}: {
  partnership: Partnership;
  detail?: boolean;
  commitField: (key: string, next: string | string[]) => void | Promise<void>;
  onOpenProfile: (() => void) | null;
}) {
  // Prefer linked driver record; fall back to inline partnership fields.
  const linked = partnership.ownerDriver;
  const firstName = linked?.firstName ?? partnership.ownerDriverFirstName ?? '';
  const lastName  = linked?.lastName  ?? partnership.ownerDriverLastName  ?? '';
  const fullName  = `${firstName} ${lastName}`.trim() || '—';
  const phone     = linked?.phone     ?? partnership.ownerDriverPhone     ?? '';
  const licExp    = linked?.licenseExpiration ?? partnership.ownerDriverLicenseExpiration;
  const licStatus = expirationStatus(licExp);

  // Linked driver records are managed via the driver record itself, so
  // inline edits only target the partnership's own owner-driver fields.
  // When linked, the fields render read-only with a hint to open the
  // driver profile.
  const isLinked = !!linked;

  const items: DSPropsEditableItem[] = isLinked
    ? [
        { key: 'phone',  label: 'Phone',  value: phone, display: phone ? <span className="num">{phone}</span> : undefined, readOnly: true },
        { key: 'email',  label: 'Email',  value: linked?.email ?? '', readOnly: true },
        { key: 'class',  label: 'Class',  value: linked?.licenseClass ?? '', readOnly: true },
        { key: 'state',  label: 'State',  value: linked?.licenseState ?? '', readOnly: true },
        {
          key: 'expires',
          label: 'Expires',
          value: licExp ?? '',
          display: <span className="num">{formatDate(licExp)}</span>,
          readOnly: true,
        },
      ]
    : [
        {
          key: 'ownerDriverFirstName',
          label: 'First name',
          value: partnership.ownerDriverFirstName ?? '',
          editor: { type: 'text' },
          placeholder: 'Add first name',
        },
        {
          key: 'ownerDriverLastName',
          label: 'Last name',
          value: partnership.ownerDriverLastName ?? '',
          editor: { type: 'text' },
          placeholder: 'Add last name',
        },
        {
          key: 'ownerDriverPhone',
          label: 'Phone',
          value: partnership.ownerDriverPhone ?? '',
          display: partnership.ownerDriverPhone ? <span className="num">{partnership.ownerDriverPhone}</span> : undefined,
          editor: { type: 'phone' },
          placeholder: 'Add phone',
        },
        {
          key: 'ownerDriverEmail',
          label: 'Email',
          value: partnership.ownerDriverEmail ?? '',
          editor: { type: 'email' },
          placeholder: 'Add email',
        },
        {
          key: 'ownerDriverLicenseClass',
          label: 'Class',
          value: partnership.ownerDriverLicenseClass ?? '',
          editor: {
            type: 'select',
            options: [
              { value: 'Class A', label: 'Class A' },
              { value: 'Class B', label: 'Class B' },
              { value: 'Class C', label: 'Class C' },
            ],
          },
          placeholder: 'Pick class',
        },
        {
          key: 'ownerDriverLicenseState',
          label: 'State',
          value: partnership.ownerDriverLicenseState ?? '',
          editor: { type: 'text' },
          placeholder: 'CA',
        },
        {
          key: 'ownerDriverLicenseExpiration',
          label: 'Expires',
          value: partnership.ownerDriverLicenseExpiration ?? '',
          display: partnership.ownerDriverLicenseExpiration
            ? <span className="num">{formatDate(partnership.ownerDriverLicenseExpiration)}</span>
            : undefined,
          editor: { type: 'date' },
          placeholder: 'Pick date',
        },
      ];

  return (
    <DSCard
      title={detail ? 'Driver — identity' : 'Owner Operator — driver'}
      action={onOpenProfile ? (
        <WBtn size="sm" leading="arrow-up-right" onClick={onOpenProfile}>Open profile</WBtn>
      ) : null}
    >
      <div className="flex items-center gap-3 mb-3">
        <Avatar name={fullName || partnership.carrierName} size={36} />
        <div className="flex-1 min-w-0">
          <div className="text-[13.5px] font-semibold text-foreground">{fullName}</div>
          {phone && <div className="num text-[11.5px] text-[var(--text-tertiary)] mt-0.5">{phone}</div>}
        </div>
        <Chip status={licStatus === 'na' ? 'na' : licStatus} />
      </div>
      <DSPropsEditable items={items} onCommit={commitField} />
      {isLinked && (
        <p className="m-0 mt-3 text-[11.5px] text-[var(--text-tertiary)]">
          Linked driver — edit via the driver profile.
        </p>
      )}
    </DSCard>
  );
}

// Re-export for tests / storybook
export { formatDate as formatDateCarrier };
export type { DSMiniColumn };
