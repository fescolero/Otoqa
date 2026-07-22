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
  type AddressData,
  AttentionBand,
  type AttentionItem,
  Avatar,
  Chip,
  ColumnsButton,
  type ColumnDef,
  CommentsThread,
  ComplianceMicroBars,
  type ComplianceItem,
  DSCard,
  DSMiniTable,
  type DSMiniColumn,
  DSPropsEditable,
  type DSPropsEditableItem,
  DetailsFullPage,
  EditableAddress,
  EditableSSN,
  FilterBar,
  type FilterChipValue,
  type FilterProperty,
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
import { PayeeProfilesCard } from '@/components/web/pay-profiles/payee-profiles-card';
import { DriverDocumentsTab } from '@/components/web/drivers/driver-documents-tab';

import { DeleteConfirmationDialog } from '@/components/drivers/delete-confirmation-dialog';
import {
  type AssignedLoad,
  type AssignedLoadStatus,
} from '@/components/loads/assigned-loads-table';
import { DriverSessionsHistory } from '@/components/sessions/driver-sessions-history';

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

// Translate FilterBar date presets to inclusive YYYY-MM-DD ranges. The
// filter compares against `firstStopDate` (also a YYYY-MM-DD string), so
// lexicographic compare is correct.
function toYmd(d: Date): string {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const dd = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${dd}`;
}
function addDays(d: Date, n: number): Date {
  const out = new Date(d);
  out.setDate(out.getDate() + n);
  return out;
}
function datePresetToRange(preset: string | undefined): { start: string; end: string } | null {
  if (!preset) return null;
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  const ymd = toYmd(today);
  switch (preset) {
    case 'Today':         return { start: ymd, end: ymd };
    case 'Tomorrow':      { const t = toYmd(addDays(today, 1)); return { start: t, end: t }; }
    case 'Yesterday':     { const y = toYmd(addDays(today, -1)); return { start: y, end: y }; }
    case 'Next 7 days':   return { start: ymd, end: toYmd(addDays(today, 6)) };
    case 'Last 7 days':   return { start: toYmd(addDays(today, -6)), end: ymd };
    case 'Last 30 days':  return { start: toYmd(addDays(today, -29)), end: ymd };
    case 'This month':    {
      const first = new Date(today.getFullYear(), today.getMonth(), 1);
      const last  = new Date(today.getFullYear(), today.getMonth() + 1, 0);
      return { start: toYmd(first), end: toYmd(last) };
    }
    case 'Last month':    {
      const first = new Date(today.getFullYear(), today.getMonth() - 1, 1);
      const last  = new Date(today.getFullYear(), today.getMonth(), 0);
      return { start: toYmd(first), end: toYmd(last) };
    }
    default: return null;
  }
}


export default function DriverDetailPage() {
  const router = useRouter();
  const params = useParams();
  const { user } = useAuth();
  const organizationId = useOrganizationId();
  const driverId = params.id as Id<'drivers'>;

  const driver = useQuery(api.drivers.get, { id: driverId, includeSensitive: true });
  const allDrivers = useQuery(api.drivers.list, organizationId ? { organizationId, includeDeleted: true } : 'skip');
  const [loadStatusFilter, setLoadStatusFilter] = React.useState<AssignedLoadStatus>('Assigned');
  const driverLoadsData = useQuery(api.loads.getByDriver, { driverId, status: loadStatusFilter });
  const recentDriverLoads = useQuery(api.loads.getRecentByDriver, { driverId, limit: 4 });

  const deactivateDriver = useMutation(api.drivers.deactivate);
  const restoreDriver = useMutation(api.drivers.restore);
  const permanentDeleteDriver = useMutation(api.drivers.permanentDelete);
  const updateDriver = useMutation(api.drivers.update);

  const [showDeleteDialog, setShowDeleteDialog] = React.useState(false);
  const [isDeleting, setIsDeleting] = React.useState(false);
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

  const eyebrow = driver.terminationDate && new Date(driver.terminationDate) > new Date() ? (
    <span className="flex items-center gap-2 text-[12px] text-[var(--text-tertiary)]">
      <Chip status="warning" label="Pending Termination" />
    </span>
  ) : undefined;

  const titleNode = (
    <span className="inline-flex items-center gap-3">
      <span>{fullName}</span>
      <StatusPicker entity="driver" currentId={statusId} onChange={onChangeStatus} />
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
    | 'email' | 'phone' | 'ssn' | 'citizenship'
    | 'licenseClass' | 'licenseState' | 'licenseExpiration' | 'licenseNumber' | 'gender'
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

  // Multi-field commit for the address autocomplete — writes street /
  // city / state / zip / country in a single mutation so the audit log
  // shows one entry instead of five.
  const commitAddress = async (data: AddressData) => {
    if (!user) return;
    try {
      await updateDriver({
        id: driverId,
        userId: user.id,
        userName,
        address: data.address,
        city: data.city,
        state: data.state,
        zipCode: data.postalCode,
        country: data.country,
      });
      toast.success('Address saved');
    } catch (e) {
      console.error(e);
      toast.error('Failed to save address');
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
      display: driver.licenseNumber
        ? <span className="num">{driver.licenseNumber}</span>
        : undefined,
      // Convex update routes licenseNumber through drivers_sensitive_info
      // and audit-logs the change, so inline edit is safe.
      editor: { type: 'text' },
      placeholder: 'Add license number',
    },
    {
      key: 'gender',
      label: 'Gender',
      value: driver.gender ?? '',
      editor: {
        type: 'select',
        options: [
          { value: 'M', label: 'Male' },
          { value: 'F', label: 'Female' },
          { value: 'X', label: 'Non-binary' },
        ],
      },
      placeholder: 'Pick gender',
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
    {
      key: 'terminationDate',
      label: 'Termination',
      value: driver.terminationDate ?? '',
      display: driver.terminationDate
        ? <span className="num">{formatDate(driver.terminationDate)}</span>
        : <span className="text-[var(--text-tertiary)]">N/A</span>,
      editor: { type: 'date' },
      placeholder: 'Pick date',
    },
  ];

  const personalItems: Array<DSPropsEditableItem | null> = [
    {
      key: 'firstName',
      label: 'First name',
      value: driver.firstName ?? '',
      editor: { type: 'text' },
      placeholder: 'Add first name',
    },
    {
      key: 'middleName',
      label: 'Middle',
      value: driver.middleName ?? '',
      editor: { type: 'text' },
      placeholder: 'Add middle name',
    },
    {
      key: 'lastName',
      label: 'Last name',
      value: driver.lastName ?? '',
      editor: { type: 'text' },
      placeholder: 'Add last name',
    },
    {
      key: 'phone',
      label: 'Phone',
      value: driver.phone ?? '',
      display: driver.phone ? formatPhoneNumber(driver.phone) : undefined,
      editor: { type: 'phone' },
      placeholder: 'Add phone',
    },
    {
      key: 'email',
      label: 'Email',
      value: driver.email ?? '',
      editor: { type: 'email' },
      placeholder: 'Add email',
    },
    {
      key: 'dateOfBirth',
      label: 'DOB',
      value: driver.dateOfBirth ?? '',
      display: driver.dateOfBirth
        ? <span className="num">{formatDate(driver.dateOfBirth)}</span>
        : undefined,
      // The Convex update mutation already routes dateOfBirth through the
      // sensitive-info table — inline edit is safe; the audit log captures
      // the change.
      editor: { type: 'date' },
      placeholder: 'Pick date of birth',
    },
    {
      key: 'ssn',
      label: 'SSN',
      // Sensitive: <EditableSSN> keeps the value masked (***-**-XXXX) at
      // rest and inside the edit input (type="password"); an eye toggle
      // beside the pencil reveals it on demand. Convex routes ssn through
      // drivers_sensitive_info with audit logging.
      custom: (
        <EditableSSN
          value={driver.ssn ?? ''}
          onCommit={(next) => commitField('ssn', next)}
          placeholder="Add SSN"
        />
      ),
    },
    {
      key: 'citizenship',
      label: 'Citizenship',
      value: driver.citizenship ?? '',
      editor: {
        type: 'select',
        options: [
          { value: 'US Citizen', label: 'US Citizen' },
          { value: 'Non-Citizen National', label: 'Non-Citizen National' },
          { value: 'Permanent Resident', label: 'Permanent Resident' },
          { value: 'Work Authorized', label: 'Work Authorized' },
          { value: 'Other', label: 'Other' },
        ],
      },
      placeholder: 'Pick citizenship',
    },
    // Address row uses <EditableAddress> via the `custom` slot —
    // Google Places autocomplete fills street/city/state/zip/country in
    // one mutation (commitAddress). The remaining rows below are
    // individually inline-editable so users can override any single
    // field manually without re-running the autocomplete.
    {
      key: 'address',
      label: 'Address',
      custom: (
        <EditableAddress
          value={{
            address: driver.address,
            city: driver.city,
            state: driver.state,
            postalCode: driver.zipCode,
            country: driver.country,
          }}
          display={
            driver.address || (
              <span className="text-[var(--text-tertiary)]">Add address</span>
            )
          }
          onCommit={commitAddress}
          placeholder="Add address"
        />
      ),
    },
    {
      key: 'address2',
      label: 'Address 2',
      value: driver.address2 ?? '',
      editor: { type: 'text' },
      placeholder: 'Apt, suite, unit',
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
      editor: {
        type: 'select',
        options: [
          { value: 'Spouse', label: 'Spouse' },
          { value: 'Parent', label: 'Parent' },
          { value: 'Sibling', label: 'Sibling' },
          { value: 'Child', label: 'Child' },
          { value: 'Partner', label: 'Partner' },
          { value: 'Friend', label: 'Friend' },
          { value: 'Other', label: 'Other' },
        ],
      },
      placeholder: 'Pick relationship',
    },
    {
      key: 'emergencyContactPhone',
      label: 'Phone',
      value: driver.emergencyContactPhone ?? '',
      display: driver.emergencyContactPhone ? formatPhoneNumber(driver.emergencyContactPhone) : undefined,
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
      onClick: () => router.push(`/loads/${inTransitLoad._id}`),
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
      <button
        type="button"
        onClick={() => inTransitLoad && router.push(`/loads/${inTransitLoad._id}`)}
        className="num text-[var(--accent)] font-medium hover:underline focus-ring rounded-sm cursor-pointer bg-transparent border-0 p-0"
      >
        {inTransitLoad?.orderNumber}
      </button>
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

  // Recent expenses placeholder — design wants a 3-col mini-table on the
  // Pay & expenses tab. Real data will come from payItems where
  // kind='TRIP_EXPENSE' once trip-expense entry/approval flows exist.
  type RecentExpenseRow = {
    id: string;
    date: string;
    category: string;
    description: string;
    amount: string;
  };
  const recentExpenseCols: DSMiniColumn<RecentExpenseRow>[] = [
    {
      key: 'date',
      label: 'Date',
      width: '90px',
      render: (r) => <span className="num">{r.date}</span>,
    },
    { key: 'category', label: 'Category', width: '120px' },
    { key: 'description', label: 'Description', width: '1.4fr' },
    {
      key: 'amount',
      label: 'Amount',
      width: '90px',
      align: 'right',
      render: (r) => <span className="num">{r.amount}</span>,
    },
  ];
  const recentExpensePlaceholderRows: RecentExpenseRow[] = [
    { id: 'p1', date: '—', category: '—', description: 'No expenses recorded yet', amount: '—' },
  ];

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
  const recentTrips: RecentTripRow[] = ((recentDriverLoads ?? []) as AssignedLoad[])
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
            action={<WBtn size="sm" leading="arrow-up-right" onClick={() => router.push(`/loads/${inTransitLoad._id}`)}>Open trip</WBtn>}
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
          <DSMiniTable
            columns={recentTripsCols}
            rows={recentTrips}
            onRowClick={(r) => router.push(`/loads/${r._id}`)}
            className="rounded-t-none border-0 border-t"
          />
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

  // Documents tab — full-page layout: 4-stat strip + Active card with
  // FilterBar + DSMiniTable. Editable Expires cells write back via
  // api.drivers.update.
  const documentsContent = (
    <DriverDocumentsTab
      driver={{
        _id: driver._id,
        licenseExpiration: driver.licenseExpiration,
        medicalExpiration: driver.medicalExpiration,
        badgeExpiration: driver.badgeExpiration,
        twicExpiration: driver.twicExpiration,
      }}
    />
  );

  // Pay & expenses tab — new pay engine. Reads from payeeProfileAssignments
  // → payProfiles → payRules. "Manage pay profiles" opens an assignment
  // editor modal. The Recent expenses card below is a placeholder until
  // the payItems-backed trip-expense ledger UI lands.
  const payrollContent = (
    <div className="flex flex-col gap-3">
      <PayeeProfilesCard payeeType="DRIVER" payeeId={driverId} />
      <DSCard title="Recent expenses" bodyClassName="p-0">
        <DSMiniTable<RecentExpenseRow>
          columns={recentExpenseCols}
          rows={recentExpensePlaceholderRows}
          total={recentExpensePlaceholderRows.length}
        />
      </DSCard>
    </div>
  );

  // Loads tab — design v4 "DvTrips" pattern: DSCard with FilterBar in the
  // action slot, switching to a chip header when filters are present, and a
  // DSMiniTable underneath. Status drives the Convex query; Distance and
  // Origin filter the returned set client-side.
  const loadsContent = (
    <DriverLoadsTab
      loads={(driverLoadsData ?? []) as AssignedLoad[]}
      statusFilter={loadStatusFilter}
      onStatusFilterChange={setLoadStatusFilter}
    />
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
    { id: 'pay-expenses', label: 'Pay & expenses', icon: 'calculator', content: payrollContent },
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
            <WBtn size="sm" variant="ghost" leading="export">
              Export
            </WBtn>
            {driver.isDeleted && (
              <>
                <WBtn size="sm" variant="secondary" onClick={onRestore}>Restore</WBtn>
                <WBtn size="sm" danger onClick={() => setShowDeleteDialog(true)}>Delete</WBtn>
              </>
            )}
          </>
        }
        title={titleNode}
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


/**
 * Loads tab — Driver-detail v4 design.
 * - DSCard wraps a DSMiniTable of trips (Trip · Route · Distance · Date · Status).
 * - FilterBar lives in the action slot when no filters are applied; once a
 *   filter chip is added, it moves into a chip header bar above the table.
 * - The Status filter drives the Convex query (single-value, fetched
 *   server-side). Distance and Origin are pure client-side reductions over
 *   the returned rows.
 */
type DriverLoadRow = AssignedLoad & { id: string };

function DriverLoadsTab({
  loads,
  statusFilter,
  onStatusFilterChange,
}: {
  loads: AssignedLoad[];
  statusFilter: AssignedLoadStatus;
  onStatusFilterChange: (s: AssignedLoadStatus) => void;
}) {
  const router = useRouter();
  const properties: FilterProperty[] = [
    {
      id: 'status',
      label: 'Status',
      icon: 'shield',
      kind: 'enum',
      operator: 'is',
      options: [
        { value: 'Assigned', label: 'Assigned' },
        { value: 'Completed', label: 'Completed' },
        { value: 'Canceled', label: 'Canceled' },
        { value: 'Expired', label: 'Expired' },
      ],
    },
    {
      id: 'distance',
      label: 'Distance',
      icon: 'truck',
      kind: 'enum',
      operator: 'is',
      options: [
        { value: 'short', label: '< 500 mi' },
        { value: 'medium', label: '500–700 mi' },
        { value: 'long', label: '> 700 mi' },
      ],
    },
    {
      id: 'origin',
      label: 'Origin',
      icon: 'pin',
      kind: 'enum',
      operator: 'is any of',
      options: Array.from(
        new Set(loads.map((l) => l.origin?.city).filter((c): c is string => !!c)),
      )
        .sort()
        .map((city) => ({ value: city.toLowerCase(), label: city })),
    },
    {
      id: 'date',
      label: 'Date',
      icon: 'calendar',
      kind: 'date',
      operator: 'is',
      presets: ['Today', 'Tomorrow', 'Yesterday', 'Next 7 days', 'Last 7 days', 'This month', 'Last month'],
    },
  ];

  // Status defaults to whatever drives the Convex query so it shows up as a
  // chip immediately — keeps the user oriented about which slice they're
  // viewing.
  const [filters, setFilters] = React.useState<FilterChipValue[]>([
    { propId: 'status', op: 'is', values: [statusFilter] },
  ]);

  // When the FilterBar's status chip changes, push it into the parent so
  // the Convex query refetches the right slice. Distance / origin filters
  // reduce client-side.
  const handleFiltersChange = (next: FilterChipValue[]) => {
    setFilters(next);
    const statusChip = next.find((c) => c.propId === 'status');
    const nextStatus = (statusChip?.values[0] as AssignedLoadStatus | undefined) ?? 'Assigned';
    if (nextStatus !== statusFilter) onStatusFilterChange(nextStatus);
  };

  const rows: DriverLoadRow[] = React.useMemo(() => {
    return loads
      .filter((l) => {
        for (const f of filters) {
          if (!f.values || f.values.length === 0) continue;
          if (f.propId === 'distance') {
            const v = f.values[0];
            const miles = l.legLoadedMiles ?? 0;
            if (v === 'short' && !(miles < 500)) return false;
            if (v === 'medium' && !(miles >= 500 && miles <= 700)) return false;
            if (v === 'long' && !(miles > 700)) return false;
          }
          if (f.propId === 'origin') {
            const city = (l.origin?.city ?? '').toLowerCase();
            if (!f.values.includes(city)) return false;
          }
          if (f.propId === 'date') {
            const range = datePresetToRange(f.values[0]);
            if (range) {
              const d = l.firstStopDate;
              if (!d || d < range.start || d > range.end) return false;
            }
          }
        }
        return true;
      })
      .map((l) => ({ ...l, id: l._id as unknown as string }));
  }, [loads, filters]);

  const allCols: DSMiniColumn<DriverLoadRow>[] = [
    {
      key: 'orderNumber',
      label: 'Order #',
      width: '1fr',
      render: (r) => <span className="num text-[var(--accent)] font-medium">{r.orderNumber}</span>,
    },
    {
      key: 'hcr',
      label: 'HCR',
      width: '90px',
      render: (r) => <span className="num">{r.parsedHcr ?? '—'}</span>,
    },
    {
      key: 'tripNumber',
      label: 'Trip',
      width: '90px',
      render: (r) => <span className="num">{r.parsedTripNumber ?? '—'}</span>,
    },
    {
      key: 'route',
      label: 'Route',
      width: '1.6fr',
      render: (r) =>
        [r.origin?.city, r.destination?.city].filter(Boolean).join(' → ') || '—',
    },
    {
      key: 'distance',
      label: 'Distance',
      width: '90px',
      align: 'right',
      render: (r) =>
        r.legLoadedMiles ? <span className="num">{r.legLoadedMiles} mi</span> : '—',
    },
    {
      key: 'firstStopDate',
      label: 'Date',
      width: '110px',
      render: (r) => <span className="num">{r.firstStopDate ?? '—'}</span>,
    },
    {
      key: 'status',
      label: 'Status',
      width: '110px',
      render: (r) => (
        <Chip
          status={
            r.status === 'In Transit'
              ? 'active'
              : r.status === 'Delivered' || r.status === 'Completed'
                ? 'delivered'
                : r.status === 'Canceled' || r.status === 'Expired'
                  ? 'expired'
                  : 'assigned'
          }
          label={r.status}
        />
      ),
    },
  ];

  // Column-visibility state. Defaults: all columns visible — HCR + Trip
  // start checked per the design ask.
  const [visibleCols, setVisibleCols] = React.useState<Set<string>>(
    () => new Set(allCols.map((c) => c.key)),
  );
  const cols = allCols.filter((c) => visibleCols.has(c.key));
  const columnDefs: ColumnDef[] = allCols.map((c) => ({
    key: c.key,
    label: typeof c.label === 'string' ? c.label : c.key,
  }));

  const hasNonStatusFilter = filters.some((f) => f.propId !== 'status');
  const showChipBar = filters.length > 0;

  return (
    <DSCard
      title={`All loads (${rows.length})`}
      bodyClassName="p-0 flex-1 min-h-0 flex flex-col"
      className="flex flex-col max-h-[calc(100vh-320px)]"
      action={
        !hasNonStatusFilter ? (
          <FilterBar properties={properties} value={filters} onChange={handleFiltersChange} slot="trigger" />
        ) : null
      }
    >
      {showChipBar && (
        <div className="shrink-0 flex items-center gap-2 flex-wrap px-3.5 py-2 border-b border-[var(--border-hairline)] bg-[var(--bg-surface-2)]">
          <FilterBar properties={properties} value={filters} onChange={handleFiltersChange} slot="chips" />
          <div className="flex-1" />
          <FilterBar properties={properties} value={filters} onChange={handleFiltersChange} slot="trigger" />
          <ColumnsButton columns={columnDefs} visible={visibleCols} onChange={setVisibleCols} />
        </div>
      )}
      <DSMiniTable
        columns={cols}
        rows={rows}
        total={rows.length}
        onRowClick={(r) => router.push(`/loads/${r._id}`)}
        className="rounded-t-none border-0 border-t flex-1 min-h-0"
        fillHeight
      />
    </DSCard>
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
