'use client';

import * as React from 'react';
import { useRouter, useParams } from 'next/navigation';
import { useAuth } from '@workos-inc/authkit-nextjs/components';
// eslint-disable-next-line no-restricted-imports -- pre-existing raw Convex query; migrate to useAuthQuery/useAuthPaginatedQuery
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
  type ChipStatus,
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
  type DriverNextLoad,
  QuickStats,
  StatusHistoryCard,
  type StatusHistoryEntry,
  StatusPicker,
  type StatusChangePayload,
  WBtn,
  resolveStatusId,
} from '@/components/web';
import { PayeeProfilesCard } from '@/components/web/pay-profiles/payee-profiles-card';
import { OnTimeChip } from '@/components/web/on-time-chip';
import { EntityDocumentsTab } from '@/components/web/documents/entity-documents-tab';
import { useDriverDocuments } from '@/components/web/documents/use-entity-documents';
import {
  complianceChipForStatus,
  formatYmd as formatDocDate,
  type DocumentRowModel,
} from '@/components/web/documents/entity-documents-model';
import {
  dateExpiryStatus,
  needsAttention as docNeedsAttention,
  type DocumentStatus,
} from '@/convex/_helpers/documentStatus';
import { DRIVER_MIRROR_FIELDS, type DriverMirrorField } from '@/convex/lib/documentTypeDefaults';

import { DeleteConfirmationDialog } from '@/components/drivers/delete-confirmation-dialog';
import {
  type AssignedLoad,
  type AssignedLoadStatus,
} from '@/components/loads/assigned-loads-table';
import { DriverSessionsHistory } from '@/components/sessions/driver-sessions-history';

import {
} from '@/components/web/drivers/build-driver-details';
import { toCountryCode } from '@/lib/format-country';

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
  // The Overview "Now" card and the Active-loads stat read the driver's
  // Assigned loads regardless of the Loads tab's filter, so flipping the
  // tab to Completed can't blank the card.
  const assignedLoadsData = useQuery(api.loads.getByDriver, { driverId, status: 'Assigned' });
  // Calendar-year bounds in the viewer's local time, fixed for the
  // component's life (a stale bound only matters across New Year's).
  const yearBounds = React.useMemo(() => {
    const y = new Date().getFullYear();
    return { yearStartMs: new Date(y, 0, 1).getTime(), yearEndMs: new Date(y + 1, 0, 1).getTime() };
  }, []);
  const yearStats = useQuery(api.loads.getDriverYearStats, { driverId, ...yearBounds });
  // Completed only — an Assigned load isn't a trip yet, and showing it
  // under "Recent trips" read as if it had already run.
  const recentDriverLoads = useQuery(api.loads.getRecentByDriver, { driverId, limit: 4, status: 'Completed' });
  // Documents summary — same rows/status as the Documents tab (one source).
  // Held at 'skip' until the driver row is confirmed: listForEntity throws
  // for a cross-org id, which must not pre-empt the "not found" state.
  const driverDocs = useDriverDocuments(driver ? driverId : undefined);

  const deactivateDriver = useMutation(api.drivers.deactivate);
  const restoreDriver = useMutation(api.drivers.restore);
  const permanentDeleteDriver = useMutation(api.drivers.permanentDelete);
  const updateDriver = useMutation(api.drivers.update);
  const resyncDriverToClerk = useMutation(api.drivers.resyncToClerk);

  const [showDeleteDialog, setShowDeleteDialog] = React.useState(false);
  const [isDeleting, setIsDeleting] = React.useState(false);
  const [isResyncing, setIsResyncing] = React.useState(false);
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
  // Re-run Clerk mobile-auth provisioning. The button lives on the Profile
  // tab's "Mobile app access" card; the sync runs async, so the status chip
  // flips from Pending once the scheduled action reports back.
  const onResyncClerk = async () => {
    if (!user) return;
    setIsResyncing(true);
    try {
      await resyncDriverToClerk({ id: driverId, userId: user.id, userName });
      toast.success('Clerk resync started — status updates shortly');
    } catch (e) {
      console.error(e);
      toast.error('Failed to start Clerk resync');
    } finally {
      setIsResyncing(false);
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
        country: toCountryCode(data.country),
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
  const assignedLoads = (assignedLoadsData ?? []) as AssignedLoad[];
  const isInProgress = (l: AssignedLoad): boolean => {
    const t = (l.trackingStatus || '').toLowerCase();
    return t === 'in transit' || t === 'picked up' || t === 'en route';
  };
  const inProgressLoads = assignedLoads.filter(isInProgress);
  const inTransitLoad = inProgressLoads[0];
  const onLoad = Boolean(inTransitLoad);
  const firstName = driver.firstName || fullName.split(' ')[0];

  // Next load: the earliest-scheduled Assigned load that isn't the one in
  // progress. Prefer the leg's scheduled start, else the first-stop date.
  const startKeyOf = (l: AssignedLoad): number =>
    l.scheduledStartMs ??
    (l.firstStopDate ? Date.parse(`${l.firstStopDate}T00:00:00`) : Number.POSITIVE_INFINITY);
  const nextLoad = assignedLoads
    .filter((l) => l._id !== inTransitLoad?._id)
    .sort((a, b) => startKeyOf(a) - startKeyOf(b))[0];
  const lastCompletedLoad = ((recentDriverLoads ?? []) as AssignedLoad[]).find(
    (l) => l.status === 'Completed',
  );

  const routeOf = (l: AssignedLoad): string =>
    [l.origin?.city, l.destination?.city].filter(Boolean).join(' → ') || '—';
  const placeOf = (p?: { city?: string; state?: string } | null): string =>
    [p?.city, p?.state].filter(Boolean).join(', ') || '—';
  const formatMs = (ms?: number): string | undefined =>
    ms
      ? new Date(ms).toLocaleString('en-US', { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' })
      : undefined;
  const truckLabel = (t?: AssignedLoad['truck']): string | undefined => {
    if (!t) return undefined;
    const spec = [t.make, t.model].filter(Boolean).join(' ');
    return spec ? `${t.unitId} · ${spec}` : t.unitId;
  };
  const trailerLabel = (t?: AssignedLoad['trailer']): string | undefined => {
    if (!t) return undefined;
    const spec = [t.size, t.bodyType].filter(Boolean).join(' ');
    return spec ? `${t.unitId} · ${spec}` : t.unitId;
  };
  const nextLoadRow: DriverNextLoad | undefined = nextLoad
    ? {
        id: nextLoad.orderNumber,
        route: routeOf(nextLoad),
        pickupWhen:
          formatMs(nextLoad.scheduledStartMs) ??
          (nextLoad.firstStopDate ? formatDate(nextLoad.firstStopDate) : undefined),
        onOpen: () => router.push(`/loads/${nextLoad._id}`),
      }
    : undefined;

  // Driver-record "mirror" dates (licenseExpiration, medicalExpiration, …)
  // are written by the document workflow, but day-one drivers imported
  // with dates and no files still carry them. For a Missing row that date
  // is the only context we have, so surface it (spec §5.3).
  const mirrorRawFor = (r: DocumentRowModel): string | undefined => {
    const f = r.type.mirrorField;
    if (!f || !(DRIVER_MIRROR_FIELDS as readonly string[]).includes(f)) return undefined;
    return driver[f as DriverMirrorField] || undefined;
  };
  // Imported records can carry junk like "202710-01-01". Only a strict
  // YYYY-MM-DD counts as a date; anything else is flagged, not displayed.
  const isYmd = (v: string): boolean => /^\d{4}-\d{2}-\d{2}$/.test(v);
  const mirrorDateFor = (r: DocumentRowModel): string | undefined => {
    const raw = mirrorRawFor(r);
    return raw && isYmd(raw) ? raw : undefined;
  };
  const mirrorDateInvalid = (r: DocumentRowModel): boolean => {
    const raw = mirrorRawFor(r);
    return Boolean(raw) && !isYmd(raw!);
  };
  /** Effective expiry for a row: the document's own date, else the
   *  archived predecessor's, else the driver-record mirror. */
  const effectiveExpiry = (r: DocumentRowModel): string | undefined =>
    r.doc?.expirationDate ?? r.lastArchived?.expirationDate ?? mirrorDateFor(r);

  // Compliance items — one per visible document type, status from the
  // shared status module (Missing renders as expired-tone).
  const complianceItems: ComplianceItem[] = driverDocs.rows.map((r) => {
    const exp = effectiveExpiry(r);
    return {
      label: r.type.name,
      number:
        r.type.key === 'cdl'
          ? driver.licenseNumber ?? '—'
          : r.doc ? (r.doc.fileName ?? '—') : 'Not on file',
      expires: r.type.expires
        ? exp ? formatDocDate(exp) : '—'
        : r.doc?.issueDate ? `Issued ${formatDocDate(r.doc.issueDate)}` : '—',
      status: complianceChipForStatus(r.status),
    };
  });

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
  if (driver.clerkSyncStatus === 'failed')
    attentionItems.push({
      tone: 'crit',
      icon: 'alert',
      tab: 'profile',
      title: 'Mobile sign-in not provisioned',
      detail: 'Clerk sync failed — driver will see "Not Registered". Resync from Profile.',
    });

  // Documents: the WORST few get their own chip, everything else rolls
  // into the summary chip. Capped so the band never wraps to a second
  // row (design: load · alert · alert · summary).
  const MAX_DOC_ALERT_CHIPS = 2;
  const DOC_SEVERITY: Partial<Record<DocumentStatus, number>> = {
    expired: 4,
    missing: 3,
    needs_date: 2,
    expiring: 1,
  };
  const docAlerts = driverDocs.rows
    .filter((r) => docNeedsAttention(r.status))
    .sort(
      (a, b) =>
        (DOC_SEVERITY[b.status] ?? 0) - (DOC_SEVERITY[a.status] ?? 0) ||
        a.type.sortOrder - b.type.sortOrder,
    );
  for (const r of docAlerts.slice(0, MAX_DOC_ALERT_CHIPS)) {
    const exp = effectiveExpiry(r);
    const expLabel = exp ? formatDocDate(exp) : undefined;
    const expExpired = exp ? dateExpiryStatus(exp, driverDocs.today) === 'expired' : false;
    let title: string;
    let detail: string;
    switch (r.status) {
      case 'expired':
        title = `${r.type.name} expired`;
        detail = expLabel ? `Expired ${expLabel} · renewal required` : 'Renewal required';
        break;
      case 'expiring':
        title = `${r.type.name} expiring`;
        detail = expLabel ? `Expires ${expLabel} · renew soon` : 'Renew soon';
        break;
      case 'needs_date':
        title = `${r.type.name} needs a date`;
        detail = 'Enter the expiration date on the document';
        break;
      default: // missing
        title = `${r.type.name} missing`;
        detail = r.lastArchived?.expirationDate
          ? `Last on file ${r.lastArchivedStatus === 'expired' ? 'expired' : 'expires'} ${expLabel}`
          : expLabel
            ? `${expExpired ? 'Expired' : 'Expires'} ${expLabel} · no file uploaded`
            : mirrorDateInvalid(r)
              ? 'Date on record is invalid · upload the document'
              : 'Upload the document and enter its date';
    }
    attentionItems.push({
      tone: r.status === 'expired' || r.status === 'missing' ? 'crit' : 'warn',
      icon: r.type.key === 'cdl' ? 'shield' : 'alert',
      tab: 'documents',
      title,
      detail,
    });
  }

  // Summary chip — always last, always dynamic: "N of M on file" from the
  // same view-model as the Documents tab, and how many still need work
  // (including the ones that didn't get their own chip above).
  const docsAttention = driverDocs.attention;
  const docsCritical = docAlerts.some((r) => r.status === 'expired' || r.status === 'missing');
  // Nothing to assert until the documents query resolves — an empty model
  // must not read as "0 of 0 on file · All current".
  if (!driverDocs.loading) {
    attentionItems.push({
      tone: docsAttention === 0 ? 'ok' : docsCritical ? 'crit' : 'warn',
      icon: docsAttention === 0 ? 'check' : 'file-text',
      tab: 'documents',
      title: `${driverDocs.counts.onFile} of ${driverDocs.counts.total} documents on file`,
      detail:
        docsAttention === 0
          ? 'All current'
          : `${docsAttention} need${docsAttention === 1 ? 's' : ''} attention`,
    });
  }

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
      {driverDocs.loading
        ? <>.</>
        : driverDocs.attention === 0
          ? <>, all compliance current.</>
          : <>, with compliance items needing attention before next dispatch.</>}
    </span>
  ) : (
    <span>
      <strong className="text-foreground">{firstName}</strong> is{' '}
      <span style={{ color: '#0F8C5F', fontWeight: 500 }}>available</span> and ready to dispatch
      {driverDocs.loading
        ? <>.</>
        : driverDocs.attention === 0
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
  // Load status → chip preset. Completed/Delivered share the green the
  // rest of the app uses for finished work; Canceled/Expired go grey.
  const LOAD_STATUS_TO_CHIP: Record<string, ChipStatus> = {
    'Open': 'open',
    'Assigned': 'assigned',
    'In Transit': 'active',
    'Delivered': 'delivered',
    'Completed': 'delivered',
    'Canceled': 'cancelled',
    'Expired': 'cancelled',
  };
  const recentTripsCols: DSMiniColumn<RecentTripRow>[] = [
    { key: 'orderNumber', label: 'Trip', width: '1fr',
      render: (r) => <span className="num text-[var(--accent)] font-medium">{r.orderNumber}</span> },
    { key: 'route', label: 'Route', width: '1.6fr',
      render: (r) =>
        [r.origin?.city, r.destination?.city].filter(Boolean).join(' → ') || '—' },
    { key: 'firstStopDate', label: 'Date', width: '110px',
      render: (r) => <span className="num">{r.firstStopDate ?? '—'}</span> },
    { key: 'status', label: 'Status', width: '110px',
      render: (r) => <Chip status={LOAD_STATUS_TO_CHIP[r.status] ?? 'assigned'} label={r.status} /> },
    { key: 'onTime', label: 'On-time', width: '110px',
      render: (r) => <OnTimeChip onTime={r.onTime} /> },
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
          { label: 'Loads YTD',    value: yearStats ? yearStats.loads.toLocaleString('en-US') : '—' },
          { label: 'Miles YTD',    value: yearStats ? yearStats.miles.toLocaleString('en-US') : '—' },
          { label: 'Score',        value: '—' },
          { label: 'On-time',      value: yearStats?.onTimePct != null ? `${yearStats.onTimePct}%` : '—' },
        ]}
      />

      {/* Default grid alignment (stretch) so Now and Compliance share a
          row height; each card fills its cell. */}
      <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
        {onLoad && inTransitLoad ? (
          <DSCard
            title="Now"
            className="h-full"
            action={<WBtn size="sm" leading="arrow-up-right" onClick={() => router.push(`/loads/${inTransitLoad._id}`)}>Open trip</WBtn>}
          >
            <NowDriverInTransit
              load={{
                id: inTransitLoad.orderNumber,
                from: placeOf(inTransitLoad.origin),
                to: placeOf(inTransitLoad.destination),
                truck: truckLabel(inTransitLoad.truck),
                trailer: trailerLabel(inTransitLoad.trailer),
                pickup: inTransitLoad.firstStopDate ? formatDate(inTransitLoad.firstStopDate) : undefined,
                eta: formatMs(inTransitLoad.scheduledEndMs),
                miles:
                  inTransitLoad.legLoadedMiles > 0
                    ? `${Math.round(inTransitLoad.legLoadedMiles).toLocaleString('en-US')} mi`
                    : undefined,
                nextLoad: nextLoadRow,
              } satisfies DriverActiveLoad}
            />
          </DSCard>
        ) : (
          <DSCard
            title="Now"
            className="h-full"
            action={<WBtn size="sm" leading="plus" onClick={() => setActiveSection('loads')}>Assign load</WBtn>}
          >
            <NowDriverAvailable
              location={[driver.city, driver.state].filter(Boolean).join(', ') || undefined}
              hosAvailable="—"
              equipment={driver.licenseClass ?? undefined}
              lastLoad={
                lastCompletedLoad
                  ? {
                      id: lastCompletedLoad.orderNumber,
                      deliveredOn: lastCompletedLoad.deliveredAt
                        ? new Date(lastCompletedLoad.deliveredAt).toLocaleDateString('en-US', { month: 'short', day: 'numeric' })
                        : formatDate(lastCompletedLoad.firstStopDate),
                    }
                  : undefined
              }
              nextLoad={nextLoadRow}
            />
          </DSCard>
        )}

        <DSCard
          title={<>Compliance <span className="num text-[var(--text-tertiary)] font-medium">· {complianceItems.length}</span></>}
          className="h-full"
        >
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

  // Mobile app access — surfaces whether the driver's phone is actually
  // registered in Clerk (the mobile app's auth provider). A driver whose
  // sync failed sees "Not Registered" at mobile sign-in; the Resync button
  // re-runs provisioning for exactly that case.
  const clerkStatus = driver.clerkSyncStatus;
  const clerkChip =
    clerkStatus === 'synced' ? (
      <Chip status="valid" label="Registered" />
    ) : clerkStatus === 'pending' ? (
      <Chip status="pending" label="Sync pending" />
    ) : clerkStatus === 'failed' ? (
      <Chip status="danger" label="Sync failed" />
    ) : (
      <Chip status="na" label="Not tracked" />
    );
  const mobileAccessRow = (label: string, value: React.ReactNode) => (
    <div className="flex items-center justify-between gap-3 py-1.5">
      <span className="text-[12px] text-[var(--text-tertiary)] shrink-0">{label}</span>
      <span className="text-[12.5px] text-foreground text-right min-w-0 truncate">{value}</span>
    </div>
  );
  const mobileAccessContent = (
    <div className="flex flex-col">
      {mobileAccessRow('Sign-in status', clerkChip)}
      {mobileAccessRow('Phone', driver.phone ? formatPhoneNumber(driver.phone) : '—')}
      {mobileAccessRow(
        'Clerk user',
        driver.clerkUserId ? <span className="num">{driver.clerkUserId}</span> : '—',
      )}
      {mobileAccessRow(
        'Last synced',
        driver.clerkSyncedAt ? (
          <span className="num">{new Date(driver.clerkSyncedAt).toLocaleString()}</span>
        ) : (
          '—'
        ),
      )}
      {clerkStatus === 'failed' && driver.clerkSyncError && (
        <p className="m-0 mt-1.5 text-[12px] leading-[17px] text-[#B43030]">
          {driver.clerkSyncError}
        </p>
      )}
      {(clerkStatus === 'failed' || clerkStatus === undefined) && (
        <p className="m-0 mt-1.5 text-[12px] leading-[17px] text-[var(--text-tertiary)]">
          If the driver sees &ldquo;Not Registered&rdquo; when signing in to the mobile app,
          run Resync to re-provision their phone number.
        </p>
      )}
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
      <DSCard
        title="Mobile app access"
        action={
          <WBtn size="sm" onClick={onResyncClerk} disabled={isResyncing || driver.isDeleted}>
            {isResyncing ? 'Resyncing…' : 'Resync to Clerk'}
          </WBtn>
        }
      >
        {mobileAccessContent}
      </DSCard>
    </div>
  );

  // Documents tab — full-page layout backed by entityDocuments (upload,
  // replace, archive, Missing status). See documents-storage-spec.md.
  const documentsContent = <EntityDocumentsTab entity="driver" entityId={driverId} entityName={fullName} />;

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
    { id: 'documents', label: 'Documents', icon: 'file-text',  count: driverDocs.counts.total || undefined, content: documentsContent },
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
