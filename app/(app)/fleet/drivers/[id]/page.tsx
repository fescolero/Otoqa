'use client';

import * as React from 'react';
import { useRouter, useParams } from 'next/navigation';
import { useAuth } from '@workos-inc/authkit-nextjs/components';
import { useMutation, useQuery } from 'convex/react';
import { Loader2, MapPin, Phone, Mail, Briefcase, User } from 'lucide-react';
import { toast } from 'sonner';

import { api } from '@/convex/_generated/api';
import type { Id } from '@/convex/_generated/dataModel';
import { useOrganizationId } from '@/contexts/organization-context';
import { formatPhoneNumber, getPhoneLink } from '@/lib/format-phone';

import {
  Avatar,
  Chip,
  CommentsThread,
  DSCard,
  DSProps,
  DSStat,
  DetailsFullPage,
  type FPSection,
  type FPKpi,
  WBtn,
} from '@/components/web';

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

const docKpiLabel = (status: DocStatus): string =>
  status === 'expired' ? 'Expired'
    : status === 'expiring' ? 'Expiring'
    : status === 'warning'  ? 'Warning'
    : status === 'na'       ? 'Not Set'
    : 'Valid';

const docKpiTone = (status: DocStatus): 'up' | 'down' | 'neutral' =>
  status === 'expired' || status === 'expiring' ? 'down'
    : status === 'valid' ? 'up'
    : 'neutral';

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

  const [showDeleteDialog, setShowDeleteDialog] = React.useState(false);
  const [isDeleting, setIsDeleting] = React.useState(false);
  const [isAssigningPayPlan, setIsAssigningPayPlan] = React.useState(false);

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

  // ─── Hero ────────────────────────────────────────────────────────────
  const status = (driver.employmentStatus ?? '').toLowerCase();
  const eyebrow = (
    <span className="flex items-center gap-2 text-[12px] text-[var(--text-tertiary)]">
      <Avatar name={fullName} size={28} />
      <Chip
        status={
          status === 'active' ? 'active'
            : status === 'on leave' ? 'pending'
            : driver.isDeleted ? 'cancelled'
            : 'inactive'
        }
        label={driver.employmentStatus ?? 'Inactive'}
      />
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

  const kpis: FPKpi[] = [
    { label: 'CDL',     value: docKpiLabel(cdlStatus),     delta: { value: formatDate(driver.licenseExpiration), tone: docKpiTone(cdlStatus) } },
    { label: 'Medical', value: docKpiLabel(medicalStatus), delta: { value: formatDate(driver.medicalExpiration), tone: docKpiTone(medicalStatus) } },
    { label: 'Badge',   value: docKpiLabel(badgeStatus),   delta: { value: formatDate(driver.badgeExpiration), tone: docKpiTone(badgeStatus) } },
    { label: 'TWIC',    value: docKpiLabel(twicStatus),    delta: { value: formatDate(driver.twicExpiration), tone: docKpiTone(twicStatus) } },
  ];

  // ─── Sections ───────────────────────────────────────────────────────
  const overviewContent = (
    <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
      <DSCard title="License">
        <DSProps
          items={[
            { label: 'Number',     value: <span className="num">{driver.licenseNumber || '—'}</span> },
            { label: 'Class',      value: driver.licenseClass || '—' },
            { label: 'State',      value: driver.licenseState || '—' },
            { label: 'Expiration', value: formatDate(driver.licenseExpiration) },
          ]}
        />
      </DSCard>
      <DSCard title="Employment">
        <DSProps
          items={[
            { label: 'Type',       value: driver.employmentType ?? '—' },
            { label: 'Hire date',  value: formatDate(driver.hireDate) },
            driver.preEmploymentCheckDate ? { label: 'Pre-emp check', value: formatDate(driver.preEmploymentCheckDate) } : null,
            driver.terminationDate ? { label: 'Termination', value: formatDate(driver.terminationDate) } : null,
          ]}
        />
      </DSCard>
      <DSCard title="Personal">
        <DSProps
          items={[
            driver.dateOfBirth ? { label: 'DOB', value: formatDate(driver.dateOfBirth) } : null,
            driver.ssn ? { label: 'SSN', value: <span className="num">***-**-{driver.ssn.slice(-4)}</span> } : null,
            (driver.city || driver.state) ? {
              label: 'Address',
              value: (
                <span className="flex flex-col gap-0.5 leading-tight">
                  {driver.address && <span>{driver.address}</span>}
                  {driver.address2 && <span>{driver.address2}</span>}
                  <span>
                    {driver.city && `${driver.city}, `}
                    {driver.state} {driver.zipCode}
                  </span>
                </span>
              ),
            } : null,
          ]}
        />
      </DSCard>
      {(driver.emergencyContactName || driver.emergencyContactPhone) && (
        <DSCard title="Emergency contact">
          <DSProps
            items={[
              driver.emergencyContactName ? { label: 'Name', value: driver.emergencyContactName } : null,
              driver.emergencyContactRelationship ? { label: 'Relationship', value: driver.emergencyContactRelationship } : null,
              driver.emergencyContactPhone ? {
                label: 'Phone',
                value: (
                  <a href={`tel:${getPhoneLink(driver.emergencyContactPhone)}`} className="text-[var(--accent)] hover:underline">
                    {formatPhoneNumber(driver.emergencyContactPhone)}
                  </a>
                ),
              } : null,
            ]}
          />
        </DSCard>
      )}
    </div>
  );

  const payrollContent = (
    <div className="flex flex-col gap-3">
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
        <DSCard title="Pay profiles">
          <p className="m-0 text-[12.5px] text-[var(--text-tertiary)]">Loading payroll settings…</p>
        </DSCard>
      )}
    </div>
  );

  const sections: FPSection[] = [
    { id: 'overview', label: 'Overview',  icon: 'id-card',     content: overviewContent },
    { id: 'payroll',  label: 'Payroll',   icon: 'doc-dollar',  content: payrollContent },
    {
      id: 'loads',
      label: 'Loads',
      icon: 'package',
      count: driverLoadsData?.length,
      content: (
        <AssignedLoadsTable
          loads={(driverLoadsData ?? []) as AssignedLoad[]}
          isLoading={driverLoadsData === undefined}
          statusFilter={loadStatusFilter}
          onStatusFilterChange={setLoadStatusFilter}
        />
      ),
    },
    {
      id: 'sessions',
      label: 'Sessions',
      icon: 'pulse',
      content: <DriverSessionsHistory driverId={driverId as Id<'drivers'>} />,
    },
  ];

  const attentionTotal = countAttention({
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
  if (attentionTotal > 0) {
    sections[0] = { ...sections[0], attention: attentionTotal };
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
        kpis={kpis}
        sections={sections}
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
