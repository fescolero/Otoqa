'use client';

import * as React from 'react';
import { useRouter, useParams } from 'next/navigation';
import { useAuth } from '@workos-inc/authkit-nextjs/components';
import { useMutation, useQuery } from 'convex/react';
import { Loader2, MapPin, Phone, Mail, Briefcase } from 'lucide-react';
import { toast } from 'sonner';

import { api } from '@/convex/_generated/api';
import type { Id } from '@/convex/_generated/dataModel';
import { useOrganizationId } from '@/contexts/organization-context';
import { formatPhoneNumber, getPhoneLink } from '@/lib/format-phone';

import {
  AttentionBand,
  type AttentionItem,
  Avatar,
  Chip,
  CommentsThread,
  ComplianceMicroBars,
  type ComplianceItem,
  DSCard,
  DSMiniTable,
  type DSMiniColumn,
  DSPropsEditable,
  type DSPropsEditableItem,
  DetailsFullPage,
  type FPSection,
  NowDriverAvailable,
  NowDriverInTransit,
  type DriverActiveLoad,
  QuickStats,
  StatusHistoryCard,
  type StatusHistoryEntry,
  StatusPicker,
  type StatusChangePayload,
  WBtn,
  resolveStatusId,
} from '@/components/web';
import {
  buildDriverDetails,
  type DriverRow,
} from '@/components/web/drivers/build-driver-details';

import { DeleteConfirmationDialog } from '@/components/drivers/delete-confirmation-dialog';
import { DriverPaySettingsSection } from '@/components/driver-pay';
import {
  AssignedLoadsTable,
  type AssignedLoad,
  type AssignedLoadStatus,
} from '@/components/loads/assigned-loads-table';
import { DriverSessionsHistory } from '@/components/sessions/driver-sessions-history';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';

import {
  countAttention,
  getDocStatus,
  type DocStatus,
} from '@/components/web/drivers/build-driver-details';

const formatDate = (s?: string): string => {
  if (!s) return '—';
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(s);
  if (!m) return s;
  const months = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  return `${months[parseInt(m[2], 10) - 1]} ${parseInt(m[3], 10)}, ${m[1]}`;
};


export default function DriverDetailPage() {
  const router = useRouter();
  const params = useParams();
  const { user } = useAuth();
  const organizationId = useOrganizationId();
  const driverId = params.id as Id<'drivers'>;

  const driver = useQuery(api.drivers.get, { id: driverId, includeSensitive: true });
  const allDrivers = useQuery(api.drivers.list, organizationId ? { organizationId, includeDeleted: true } : 'skip');
  const payPlans = useQuery(api.payPlans.list, organizationId ? { workosOrgId: organizationId } : 'skip');
  const [loadStatusFilter, setLoadStatusFilter] = React.useState<AssignedLoadStatus>('Assigned');
  const driverLoadsData = useQuery(api.loads.getByDriver, { driverId, status: loadStatusFilter });

  const deactivateDriver = useMutation(api.drivers.deactivate);
  const restoreDriver = useMutation(api.drivers.restore);
  const permanentDeleteDriver = useMutation(api.drivers.permanentDelete);
  const assignPayPlan = useMutation(api.payPlans.assignToDriver);
  const updateDriver = useMutation(api.drivers.update);

  const [showDeleteDialog, setShowDeleteDialog] = React.useState(false);
  const [isDeleting, setIsDeleting] = React.useState(false);
  const [isAssigningPayPlan, setIsAssigningPayPlan] = React.useState(false);
  // Controlled active section id so the AttentionBand can navigate.
  const [activeSection, setActiveSection] = React.useState('overview');

  if (driver === undefined) {
    return (
      <div className="flex-1 flex items-center justify-center">
        <Loader2 className="h-5 w-5 animate-spin text-[var(--text-tertiary)]" />
      </div>
    );
  }
  if (driver === null) {
    return (
      <div className="flex-1 flex items-center justify-center text-[12.5px] text-[var(--text-tertiary)]">
        Driver not found.
      </div>
    );
  }

  // Prev / next navigation across the active driver list (skip deleted).
  const driverList = (allDrivers ?? []).filter((d) => !d.isDeleted);
  const idx = driverList.findIndex((d) => d._id === driverId);
  const prev = idx > 0 ? driverList[idx - 1] : null;
  const next = idx >= 0 && idx < driverList.length - 1 ? driverList[idx + 1] : null;

  const fullName = [driver.firstName, driver.middleName, driver.lastName].filter(Boolean).join(' ');
  const userName = user?.firstName && user?.lastName ? `${user.firstName} ${user.lastName}` : (user?.email ?? '');

  const onDeactivate = async () => {
    if (!user) return;
    if (!window.confirm(`Deactivate ${fullName}?`)) return;
    try {
      await deactivateDriver({ id: driverId, userId: user.id, userName });
      toast.success('Driver deactivated');
    } catch (e) {
      console.error(e);
      toast.error('Failed to deactivate driver');
    }
  };
  const onRestore = async () => {
    if (!user) return;
    try {
      await restoreDriver({ id: driverId, userId: user.id, userName });
      toast.success('Driver restored');
    } catch (e) {
      console.error(e);
      toast.error('Failed to restore driver');
    }
  };
  const onPermanentDelete = async () => {
    if (!user) return;
    setIsDeleting(true);
    try {
      await permanentDeleteDriver({ id: driverId, userId: user.id, userName });
      router.push('/fleet/drivers');
    } catch (e) {
      console.error(e);
      toast.error('Failed to delete driver');
    } finally {
      setIsDeleting(false);
      setShowDeleteDialog(false);
    }
  };

  // ─── Hero status chip (click-to-change) ─────────────────────────────
  // The driver record stores `employmentStatus` as a free-form string. The
  // status-machine ID is resolved from it; on commit, the user-friendly
  // label of the chosen state is written back. The audit log captures the
  // reason/note so the Status history card can re-hydrate.
  const statusId = resolveStatusId('driver', driver.employmentStatus);
  const onChangeStatus = async (payload: StatusChangePayload) => {
    if (!user) return;
    try {
      await updateDriver({
        id: driverId,
        userId: user.id,
        userName,
        employmentStatus: payload.to.label,
        statusReason: payload.reason,
        statusNote: payload.note,
        statusEffectiveDate: payload.effectiveDate,
        ...(payload.to.id === 'terminated' ? { terminationDate: payload.effectiveDate } : {}),
      });
      toast.success(`Status changed to ${payload.to.label}`);
    } catch (e) {
      console.error(e);
      toast.error('Failed to change status');
    }
  };

  const eyebrow = (
    <span className="flex items-center gap-2 text-[12px] text-[var(--text-tertiary)]">
      <Avatar name={fullName} size={28} />
      <StatusPicker entity="driver" currentId={statusId} onChange={onChangeStatus} />
      {driver.terminationDate && new Date(driver.terminationDate) > new Date() && (
        <Chip status="warning" label="Pending Termination" />
      )}
    </span>
  );

  const subtitle = (
    <span className="flex items-center flex-wrap gap-x-4 gap-y-1 text-[13px] text-[var(--text-secondary)]">
      <a href={`tel:${getPhoneLink(driver.phone)}`} className="inline-flex items-center gap-1.5 hover:text-foreground">
        <Phone className="h-3.5 w-3.5" /> {formatPhoneNumber(driver.phone)}
      </a>
      <a href={`mailto:${driver.email}`} className="inline-flex items-center gap-1.5 hover:text-foreground">
        <Mail className="h-3.5 w-3.5" /> {driver.email}
      </a>
      {driver.employmentType && (
        <span className="inline-flex items-center gap-1.5">
          <Briefcase className="h-3.5 w-3.5" /> {driver.employmentType}
        </span>
      )}
      {(driver.city || driver.state) && (
        <span className="inline-flex items-center gap-1.5">
          <MapPin className="h-3.5 w-3.5" />
          {[driver.city, driver.state].filter(Boolean).join(', ')}
        </span>
      )}
    </span>
  );

  const cdlStatus     = getDocStatus(driver.licenseExpiration);
  const medicalStatus = getDocStatus(driver.medicalExpiration);
  const badgeStatus   = getDocStatus(driver.badgeExpiration);
  const twicStatus    = getDocStatus(driver.twicExpiration);

  // Hero KPI grid intentionally removed — the AttentionBand inside the
  // Overview composer now carries "what needs doing now" instead of the
  // cold 4-up CDL/Medical/Badge/TWIC stat block.

  // ─── Inline-edit commit ─────────────────────────────────────────────
  // Each Overview field commits a single-arg patch to api.drivers.update.
  // The mutation handler accepts the same field names as Convex args; we
  // map known field keys here and skip unknown ones.
  type DriverField =
    | 'firstName' | 'middleName' | 'lastName'
    | 'email' | 'phone'
    | 'licenseClass' | 'licenseState' | 'licenseExpiration'
    | 'employmentType' | 'employmentStatus' | 'hireDate'
    | 'preEmploymentCheckDate' | 'terminationDate'
    | 'address' | 'address2' | 'city' | 'state' | 'zipCode'
    | 'emergencyContactName' | 'emergencyContactRelationship' | 'emergencyContactPhone'
    | 'medicalExpiration' | 'badgeExpiration' | 'twicExpiration';

  const commitField = async (key: string, next: string | string[]) => {
    if (!user) return;
    const value = Array.isArray(next) ? next.join(', ') : next;
    const patch: Partial<Record<DriverField, string>> = { [key as DriverField]: value };
    try {
      await updateDriver({ id: driverId, userId: user.id, userName, ...patch });
      toast.success('Saved');
    } catch (e) {
      console.error(e);
      toast.error('Failed to save change');
    }
  };

  // ─── Sections ───────────────────────────────────────────────────────
  const licenseItems: Array<DSPropsEditableItem | null> = [
    {
      key: 'licenseClass',
      label: 'Class',
      value: driver.licenseClass ?? '',
      editor: {
        type: 'select',
        // Stored as the human-readable string (matches the legacy driver
        // form + table chip rendering). Keep this in sync with whatever
        // the create/edit flow writes.
        options: [
          { value: 'Class A', label: 'Class A' },
          { value: 'Class B', label: 'Class B' },
          { value: 'Class C', label: 'Class C' },
        ],
      },
      placeholder: 'Pick class',
    },
    {
      key: 'licenseState',
      label: 'State',
      value: driver.licenseState ?? '',
      editor: { type: 'text' },
      placeholder: 'CA',
    },
    {
      key: 'licenseExpiration',
      label: 'Expiration',
      value: driver.licenseExpiration ?? '',
      display: <span className="num">{formatDate(driver.licenseExpiration)}</span>,
      editor: { type: 'date' },
      placeholder: 'Pick date',
    },
    {
      key: 'licenseNumber',
      label: 'Number',
      value: driver.licenseNumber ?? '',
      display: <span className="num">{driver.licenseNumber || '—'}</span>,
      readOnly: true,
    },
  ];

  const employmentItems: Array<DSPropsEditableItem | null> = [
    {
      key: 'employmentType',
      label: 'Type',
      value: driver.employmentType ?? '',
      editor: {
        type: 'select',
        options: [
          { value: 'Full-time', label: 'Full-time' },
          { value: 'Part-time', label: 'Part-time' },
          { value: 'Contractor', label: 'Contractor' },
        ],
      },
      placeholder: 'Pick type',
    },
    {
      key: 'hireDate',
      label: 'Hire date',
      value: driver.hireDate ?? '',
      display: <span className="num">{formatDate(driver.hireDate)}</span>,
      editor: { type: 'date' },
      placeholder: 'Pick date',
    },
    driver.preEmploymentCheckDate
      ? {
          key: 'preEmploymentCheckDate',
          label: 'Pre-emp check',
          value: driver.preEmploymentCheckDate,
          display: <span className="num">{formatDate(driver.preEmploymentCheckDate)}</span>,
          editor: { type: 'date' },
        }
      : null,
    driver.terminationDate
      ? {
          key: 'terminationDate',
          label: 'Termination',
          value: driver.terminationDate,
          display: <span className="num">{formatDate(driver.terminationDate)}</span>,
          editor: { type: 'date' },
        }
      : null,
  ];

  const personalItems: Array<DSPropsEditableItem | null> = [
    driver.dateOfBirth
      ? {
          key: 'dateOfBirth',
          label: 'DOB',
          value: driver.dateOfBirth,
          display: <span className="num">{formatDate(driver.dateOfBirth)}</span>,
          // DOB is sensitive — the mutation routes it via a separate path,
          // so keep it read-only on the page for now.
          readOnly: true,
        }
      : null,
    driver.ssn
      ? {
          key: 'ssn',
          label: 'SSN',
          value: driver.ssn,
          display: <span className="num">***-**-{driver.ssn.slice(-4)}</span>,
          readOnly: true,
        }
      : null,
    {
      key: 'address',
      label: 'Street',
      value: driver.address ?? '',
      editor: { type: 'text' },
      placeholder: 'Street',
    },
    {
      key: 'city',
      label: 'City',
      value: driver.city ?? '',
      editor: { type: 'text' },
      placeholder: 'City',
    },
    {
      key: 'state',
      label: 'State',
      value: driver.state ?? '',
      editor: { type: 'text' },
      placeholder: 'CA',
    },
    {
      key: 'zipCode',
      label: 'Zip',
      value: driver.zipCode ?? '',
      editor: { type: 'text' },
      placeholder: '95823',
    },
  ];

  const emergencyItems: Array<DSPropsEditableItem | null> = [
    {
      key: 'emergencyContactName',
      label: 'Name',
      value: driver.emergencyContactName ?? '',
      editor: { type: 'text' },
      placeholder: 'Add contact',
    },
    {
      key: 'emergencyContactRelationship',
      label: 'Relationship',
      value: driver.emergencyContactRelationship ?? '',
      editor: { type: 'text' },
      placeholder: 'Spouse, Parent…',
    },
    {
      key: 'emergencyContactPhone',
      label: 'Phone',
      value: driver.emergencyContactPhone ?? '',
      display: driver.emergencyContactPhone
        ? (
          <a
            href={`tel:${getPhoneLink(driver.emergencyContactPhone)}`}
            className="text-[var(--accent)] hover:underline"
          >
            {formatPhoneNumber(driver.emergencyContactPhone)}
          </a>
        )
        : undefined,
      editor: { type: 'phone' },
      placeholder: 'Add phone',
    },
  ];

  // ─── Overview composer ─────────────────────────────────────────────────
  // Driver Overview (design v4 "C+A"):
  //   AttentionBand → QuickStats → 2-col (Now + Compliance) → Recent
  //   trips (mini-preview) → Status history
  // The deep reference data (License / Employment / Personal / Emergency)
  // moved to a dedicated Profile tab; Documents has its own tab too.

  // Active load detection — derive from the Assigned loads query so the
  // Now block flips between in-transit and Available without manual
  // wiring. We treat any 'In Transit' / 'Picked Up' / 'En Route' tracking
  // status as "active"; otherwise fall back to Available.
  const inTransitLoad = ((driverLoadsData ?? []) as AssignedLoad[]).find((l) => {
    const t = (l.trackingStatus || '').toLowerCase();
    return t === 'in transit' || t === 'picked up' || t === 'en route';
  });
  const onLoad = Boolean(inTransitLoad);
  const firstName = driver.firstName || fullName.split(' ')[0];

  type ChipStatusForCompliance = 'valid' | 'expiring' | 'expired' | 'na';

  // Compliance items — License + Medical from real data; Background / MVR /
  // Drug screen as "Not tracked" placeholders until the backend lands them.
  const chipFor = (s: DocStatus): ChipStatusForCompliance => {
    if (s === 'expired') return 'expired';
    if (s === 'expiring' || s === 'warning') return 'expiring';
    if (s === 'na') return 'na';
    return 'valid';
  };
  const complianceItems: ComplianceItem[] = [
    {
      label: 'License',
      number: driver.licenseNumber ?? '—',
      expires: driver.licenseExpiration ? formatDate(driver.licenseExpiration) : '—',
      status: chipFor(cdlStatus),
    },
    {
      label: 'Medical',
      number: driver.medicalExpiration ? '—' : 'Not on file',
      expires: driver.medicalExpiration ? formatDate(driver.medicalExpiration) : '—',
      status: chipFor(medicalStatus),
    },
    {
      label: 'Badge',
      number: driver.badgeExpiration ? '—' : 'Not on file',
      expires: driver.badgeExpiration ? formatDate(driver.badgeExpiration) : '—',
      status: chipFor(badgeStatus),
    },
    {
      label: 'TWIC',
      number: driver.twicExpiration ? '—' : 'Not on file',
      expires: driver.twicExpiration ? formatDate(driver.twicExpiration) : '—',
      status: chipFor(twicStatus),
    },
    { label: 'Background',  untracked: true },
    { label: 'MVR',         untracked: true },
    { label: 'Drug screen', untracked: true },
  ];

  // Attention items — same chips the design source emits, derived from
  // our real data. Each item carries a `tab` so the band navigates.
  const attentionItems: AttentionItem[] = [];
  if (onLoad && inTransitLoad) {
    attentionItems.push({
      tone: 'info',
      icon: 'truck',
      tab: 'loads',
      title: <>On <span className="num text-[var(--accent)] font-medium">{inTransitLoad.orderNumber}</span></>,
      detail: inTransitLoad.firstStopDate ? `Pickup ${inTransitLoad.firstStopDate}` : undefined,
    });
  } else {
    attentionItems.push({
      tone: 'ok',
      icon: 'check',
      tab: 'loads',
      title: 'Available to dispatch',
      detail: driver.city ? `Last seen in ${driver.city}` : 'Ready for next dispatch',
    });
  }
  if (cdlStatus === 'expired')
    attentionItems.push({ tone: 'crit', icon: 'shield', tab: 'documents', title: 'License expired', detail: formatDate(driver.licenseExpiration) });
  else if (cdlStatus === 'expiring')
    attentionItems.push({ tone: 'warn', icon: 'shield', tab: 'documents', title: 'License expiring soon', detail: formatDate(driver.licenseExpiration) });
  if (medicalStatus === 'expired')
    attentionItems.push({ tone: 'crit', icon: 'alert', tab: 'documents', title: 'Medical card expired', detail: formatDate(driver.medicalExpiration) });
  else if (medicalStatus === 'expiring')
    attentionItems.push({ tone: 'warn', icon: 'alert', tab: 'documents', title: 'Medical card expiring soon', detail: formatDate(driver.medicalExpiration) });

  const docsAttention = countAttention({
    _id: driver._id,
    firstName: driver.firstName,
    lastName: driver.lastName,
    email: driver.email,
    phone: driver.phone,
    licenseExpiration: driver.licenseExpiration,
    medicalExpiration: driver.medicalExpiration,
    badgeExpiration: driver.badgeExpiration,
    twicExpiration: driver.twicExpiration,
  });
  attentionItems.push({
    tone: 'info',
    icon: 'file-text',
    tab: 'documents',
    title: '4 documents on file',
    detail: docsAttention > 0 ? `${docsAttention} require renewal` : 'all current',
  });

  const headline = onLoad ? (
    <span>
      <strong className="text-foreground">{firstName}</strong> is in transit on{' '}
      <span className="num text-[var(--accent)] font-medium">{inTransitLoad?.orderNumber}</span>
      {cdlStatus === 'valid' && medicalStatus === 'valid'
        ? <>, all compliance current.</>
        : <>, with compliance items needing attention before next dispatch.</>}
    </span>
  ) : (
    <span>
      <strong className="text-foreground">{firstName}</strong> is{' '}
      <span style={{ color: '#0F8C5F', fontWeight: 500 }}>available</span> and ready to dispatch
      {cdlStatus === 'valid' && medicalStatus === 'valid'
        ? <> — all compliance current.</>
        : <> — compliance items pending review.</>}
    </span>
  );

  type RecentTripRow = AssignedLoad & { id: string };
  const recentTripsCols: DSMiniColumn<RecentTripRow>[] = [
    { key: 'orderNumber', label: 'Trip', width: '1fr',
      render: (r) => <span className="num text-[var(--accent)] font-medium">{r.orderNumber}</span> },
    { key: 'route', label: 'Route', width: '1.6fr',
      render: (r) =>
        [r.origin?.city, r.destination?.city].filter(Boolean).join(' → ') || '—' },
    { key: 'firstStopDate', label: 'Date', width: '110px',
      render: (r) => <span className="num">{r.firstStopDate ?? '—'}</span> },
    { key: 'status', label: 'Status', width: '110px',
      render: (r) => <Chip status={r.status === 'In Transit' ? 'active' : r.status === 'Delivered' ? 'delivered' : 'assigned'} label={r.status} /> },
  ];
  const recentTrips: RecentTripRow[] = ((driverLoadsData ?? []) as AssignedLoad[])
    .slice(0, 4)
    .map((l) => ({ ...l, id: l._id as unknown as string }));

  const overviewContent = (
    <div className="flex flex-col gap-3.5">
      <AttentionBand
        headline={headline}
        items={attentionItems}
        onJump={(tab) => setActiveSection(tab)}
      />

      <QuickStats
        stats={[
          { label: 'Active loads', value: onLoad ? '1' : '0' },
          { label: 'Loads YTD',    value: '—' },
          { label: 'Miles YTD',    value: '—' },
          { label: 'Score',        value: '—' },
          { label: 'On-time',      value: '—' },
        ]}
      />

      <div className="grid grid-cols-1 md:grid-cols-2 gap-3 items-start">
        {onLoad && inTransitLoad ? (
          <DSCard
            title="Now"
            action={<WBtn size="sm" leading="arrow-up-right" onClick={() => setActiveSection('loads')}>Open trip</WBtn>}
          >
            <NowDriverInTransit
              load={{
                id: inTransitLoad.orderNumber,
                from: [inTransitLoad.origin?.city, inTransitLoad.origin?.state].filter(Boolean).join(', ') || '—',
                to: [inTransitLoad.destination?.city, inTransitLoad.destination?.state].filter(Boolean).join(', ') || '—',
                eta: inTransitLoad.firstStopDate,
              } as DriverActiveLoad}
            />
          </DSCard>
        ) : (
          <DSCard
            title="Now"
            action={<WBtn size="sm" leading="plus" onClick={() => setActiveSection('loads')}>Assign load</WBtn>}
          >
            <NowDriverAvailable
              location={[driver.city, driver.state].filter(Boolean).join(', ') || undefined}
              hosAvailable="—"
              equipment={driver.licenseClass ?? undefined}
            />
          </DSCard>
        )}

        <DSCard title="Compliance">
          <ComplianceMicroBars items={complianceItems} />
        </DSCard>
      </div>

      <DSCard title="Recent trips" bodyClassName="p-0"
        action={<WBtn size="sm" leading="arrow-up-right" onClick={() => setActiveSection('loads')}>View all</WBtn>}>
        {recentTrips.length > 0 ? (
          <DSMiniTable columns={recentTripsCols} rows={recentTrips}
            total={driverLoadsData?.length}/>
        ) : (
          <p className="m-0 px-4 py-3 text-[12.5px] text-[var(--text-tertiary)]">No trips on file.</p>
        )}
      </DSCard>

      <DriverStatusHistoryCard driverId={driverId} />
    </div>
  );

  // Profile tab — deep reference data, edited inline. Every previously-
  // Overview field lives here.
  const profileContent = (
    <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
      <DSCard title="License">
        <DSPropsEditable items={licenseItems} onCommit={commitField} />
      </DSCard>
      <DSCard title="Employment">
        <DSPropsEditable items={employmentItems} onCommit={commitField} />
      </DSCard>
      <DSCard title="Personal">
        <DSPropsEditable items={personalItems} onCommit={commitField} />
      </DSCard>
      <DSCard title="Emergency contact">
        <DSPropsEditable items={emergencyItems} onCommit={commitField} />
      </DSCard>
    </div>
  );

  // Documents tab — for now, the same compact view the slide-over uses
  // (a 4-row mini-preview of CDL / Medical / Badge / TWIC). The backend
  // for a real per-doc table lands in a separate phase.
  const driverRow: DriverRow = {
    _id: driver._id,
    firstName: driver.firstName,
    lastName: driver.lastName,
    email: driver.email,
    phone: driver.phone,
    licenseExpiration: driver.licenseExpiration,
    medicalExpiration: driver.medicalExpiration,
    badgeExpiration: driver.badgeExpiration,
    twicExpiration: driver.twicExpiration,
    licenseClass: driver.licenseClass,
    licenseState: driver.licenseState,
    licenseNumber: driver.licenseNumber,
    employmentStatus: driver.employmentStatus,
    employmentType: driver.employmentType,
    hireDate: driver.hireDate,
    city: driver.city,
    state: driver.state,
    emergencyContactName: driver.emergencyContactName,
    emergencyContactRelationship: driver.emergencyContactRelationship,
    emergencyContactPhone: driver.emergencyContactPhone,
    isDeleted: driver.isDeleted,
  };
  const docsSection = buildDriverDetails(driverRow).sections.find((s) => s.id === 'documents');
  const documentsContent = (
    <DSCard title={`Documents (${4})`} bodyClassName="p-4">
      {docsSection?.content}
    </DSCard>
  );

  // Pay tab. The chassis treatment matches the design's "Default profile +
  // template picker" intent: a single card titled "Compensation" wraps the
  // pay-plan picker on top of the assigned-profile list. Templates are
  // edited at /org-settings/pay-plans (link below); this surface stays a
  // picker, never an in-place value editor.
  const payrollContent = (
    <div className="flex flex-col gap-3">
      <DSCard
        title="Compensation"
        action={
          <WBtn size="xs" variant="ghost" leading="arrow-up-right" onClick={() => router.push('/org-settings/pay-plans')}>
            Manage templates
          </WBtn>
        }
        bodyClassName="flex flex-col gap-3"
      >
        <PayPlanBar
          currentPlanId={driver.payPlanId ?? null}
          plans={payPlans ?? []}
          loading={isAssigningPayPlan}
          onChange={async (planId) => {
            if (!user) return;
            setIsAssigningPayPlan(true);
            try {
              await assignPayPlan({
                driverId,
                planId: planId as Id<'payPlans'> | undefined,
              });
              toast.success(planId ? 'Pay plan assigned' : 'Pay plan removed');
            } catch (e) {
              console.error(e);
              toast.error('Failed to update pay plan');
            } finally {
              setIsAssigningPayPlan(false);
            }
          }}
          onManage={() => router.push('/org-settings/pay-plans')}
        />
        {organizationId && user ? (
          <DriverPaySettingsSection
            driverId={driverId}
            organizationId={organizationId}
            userId={user.id}
          />
        ) : (
          <p className="m-0 text-[12.5px] text-[var(--text-tertiary)]">Loading payroll settings…</p>
        )}
      </DSCard>
    </div>
  );

  // Loads tab — wrap the legacy AssignedLoadsTable so it picks up the same
  // card chrome as the Overview cards. The table itself stays on its own
  // chassis until Loads gets its full Phase-4-style migration.
  const loadsContent = (
    <DSCard title="Assigned loads" bodyClassName="p-0">
      <div className="p-4">
        <AssignedLoadsTable
          loads={(driverLoadsData ?? []) as AssignedLoad[]}
          isLoading={driverLoadsData === undefined}
          statusFilter={loadStatusFilter}
          onStatusFilterChange={setLoadStatusFilter}
        />
      </div>
    </DSCard>
  );

  // Sessions tab — same pattern: chassis card chrome around the legacy
  // history table.
  const sessionsContent = (
    <DSCard title="Session history" bodyClassName="p-0">
      <div className="p-4">
        <DriverSessionsHistory driverId={driverId as Id<'drivers'>} />
      </div>
    </DSCard>
  );

  const sections: FPSection[] = [
    { id: 'overview',  label: 'Overview',  icon: 'home',       content: overviewContent },
    { id: 'profile',   label: 'Profile',   icon: 'users',      content: profileContent },
    { id: 'documents', label: 'Documents', icon: 'file-text',  count: 4, content: documentsContent },
    { id: 'payroll',   label: 'Payroll',   icon: 'doc-dollar', content: payrollContent },
    {
      id: 'loads',
      label: 'Loads',
      icon: 'package',
      count: driverLoadsData?.length,
      content: loadsContent,
    },
    {
      id: 'sessions',
      label: 'Sessions',
      icon: 'pulse',
      content: sessionsContent,
    },
  ];

  // Documents tab carries the attention badge (it's where the user goes to
  // resolve expiring docs).
  if (docsAttention > 0) {
    sections[2] = { ...sections[2], attention: docsAttention };
  }

  const rightRail = (
    <DSCard title="Comments">
      <CommentsThread entityType="driver" entityId={driver._id as string} />
    </DSCard>
  );

  return (
    <>
      <DetailsFullPage
        breadcrumb={
          <span className="inline-flex items-center gap-1.5 text-[var(--text-secondary)]">
            <button
              type="button"
              onClick={() => router.push('/fleet/drivers')}
              className="hover:text-foreground"
            >
              Drivers
            </button>
            <span className="text-[var(--text-tertiary)]">/</span>
            <span className="text-foreground font-medium truncate max-w-[280px]">{fullName}</span>
          </span>
        }
        onBack={() => router.push('/fleet/drivers')}
        prevLabel={prev ? `${prev.firstName} ${prev.lastName}` : undefined}
        onPrev={prev ? () => router.push(`/fleet/drivers/${prev._id}`) : null}
        nextLabel={next ? `${next.firstName} ${next.lastName}` : undefined}
        onNext={next ? () => router.push(`/fleet/drivers/${next._id}`) : null}
        toolbarActions={
          <>
            <WBtn size="sm" variant="ghost" leading="edit" onClick={() => router.push(`/fleet/drivers/${driverId}/edit`)}>
              Edit
            </WBtn>
            <WBtn size="sm" variant="ghost" leading="export">
              Export
            </WBtn>
            {driver.isDeleted ? (
              <>
                <WBtn size="sm" variant="secondary" onClick={onRestore}>Restore</WBtn>
                <WBtn size="sm" danger onClick={() => setShowDeleteDialog(true)}>Delete</WBtn>
              </>
            ) : (
              <WBtn size="sm" danger onClick={onDeactivate}>Deactivate</WBtn>
            )}
          </>
        }
        title={fullName}
        eyebrow={eyebrow}
        subtitle={subtitle}
        sections={sections}
        activeId={activeSection}
        onActiveChange={setActiveSection}
        rightRail={rightRail}
      />
      <DeleteConfirmationDialog
        open={showDeleteDialog}
        onOpenChange={setShowDeleteDialog}
        driverName={fullName}
        onConfirm={onPermanentDelete}
        isDeleting={isDeleting}
      />
    </>
  );
}

function PayPlanBar({
  currentPlanId,
  plans,
  loading,
  onChange,
  onManage,
}: {
  currentPlanId: string | null;
  plans: Array<{ _id: string; name: string; isActive?: boolean }>;
  loading: boolean;
  onChange: (planId: string | undefined) => void | Promise<void>;
  onManage: () => void;
}) {
  return (
    <div className="flex items-center justify-between rounded-lg border border-[var(--border-hairline)] bg-card px-3 py-2">
      <div className="flex items-center gap-3">
        <span className="text-[12.5px] font-medium text-[var(--text-tertiary)]">Pay plan</span>
        <Select
          value={currentPlanId ?? 'none'}
          onValueChange={(v) => onChange(v === 'none' ? undefined : v)}
          disabled={loading}
        >
          <SelectTrigger className="w-56 h-8 text-[12.5px]">
            {loading ? (
              <span className="inline-flex items-center gap-2">
                <Loader2 className="h-3 w-3 animate-spin" />
                Updating…
              </span>
            ) : (
              <SelectValue placeholder="Select pay plan…" />
            )}
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="none"><span className="text-muted-foreground">No pay plan</span></SelectItem>
            {plans.filter((p) => p.isActive !== false).map((p) => (
              <SelectItem key={p._id} value={p._id}>{p.name}</SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>
      <WBtn size="xs" variant="ghost" onClick={onManage}>
        Manage plans
      </WBtn>
    </div>
  );
}

/**
 * Reads the audit log for this driver and renders the status-change
 * entries as a `<StatusHistoryCard>`. Filters to entries where
 * `employmentStatus` actually changed; the picker writes the structured
 * payload (from / to / reason / note / effectiveDate) into `metadata`.
 */
function DriverStatusHistoryCard({ driverId }: { driverId: Id<'drivers'> }) {
  const log = useQuery(api.auditLog.getEntityAuditLog, {
    entityType: 'driver',
    entityId: driverId as unknown as string,
    limit: 50,
  });
  const entries = React.useMemo<StatusHistoryEntry[]>(() => {
    if (!log) return [];
    return log
      .filter((e) => e.changedFields?.includes('employmentStatus'))
      .map((e) => {
        let from = '';
        let to = '';
        let reason = e.description ?? '';
        let note: string | undefined;
        let effectiveDate: string | undefined;
        if (e.metadata) {
          try {
            const m = JSON.parse(e.metadata) as {
              kind?: string;
              from?: string | null;
              to?: string | null;
              reason?: string;
              note?: string | null;
              effectiveDate?: string | null;
            };
            if (m.kind === 'status_change') {
              from = m.from ?? '';
              to = m.to ?? '';
              reason = m.reason ?? reason;
              note = m.note ?? undefined;
              effectiveDate = m.effectiveDate ?? undefined;
            }
          } catch {
            // metadata wasn't JSON — fall through to changesBefore/After
          }
        }
        if (!to) {
          // Fall back to the changesAfter / changesBefore JSON from older
          // audit entries that don't carry the structured metadata.
          try {
            if (e.changesAfter) {
              const after = JSON.parse(e.changesAfter) as { employmentStatus?: string };
              if (after.employmentStatus) to = after.employmentStatus;
            }
            if (e.changesBefore) {
              const before = JSON.parse(e.changesBefore) as { employmentStatus?: string };
              if (before.employmentStatus) from = before.employmentStatus;
            }
          } catch {
            // ignore
          }
        }
        return {
          date: effectiveDate
            ? formatDate(effectiveDate)
            : new Date(e.timestamp).toLocaleDateString('en-US', {
                month: 'short',
                day: '2-digit',
                year: 'numeric',
              }),
          fromId: resolveStatusId('driver', from),
          toId: resolveStatusId('driver', to),
          reason,
          note,
          by: e.performedByName ?? 'System',
        };
      });
  }, [log]);

  if (log === undefined) {
    return (
      <DSCard title="Status history">
        <p className="m-0 text-[12.5px] text-[var(--text-tertiary)]">Loading status history…</p>
      </DSCard>
    );
  }
  if (entries.length === 0) return null;
  return <StatusHistoryCard entity="driver" entries={entries} />;
}
