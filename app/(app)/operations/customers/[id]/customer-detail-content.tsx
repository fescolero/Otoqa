/**
 * CustomerDetailContent — full-page customer record on the Otoqa Web chassis.
 *
 * Mirrors design v2's details-customer.jsx (variant A, "Account-first"):
 *   - DetailsFullPage shell with sub-toolbar
 *   - Hero: avatar (initials) + title + identity subtitle + 4-up KPI grid
 *   - Sections: Overview · Contracts · Loads · Contacts · Locations ·
 *     Invoices · Activity
 *   - Right rail: renewals due / health / top lanes
 *
 * Real data: api.customers.get. Sub-collection cards (contracts, loads,
 * invoices, etc.) start as empty / placeholder rows — wired in once their
 * backend queries exist.
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
import { api } from '@/convex/_generated/api';
import type { Id } from '@/convex/_generated/dataModel';
import { useAuthQuery } from '@/hooks/use-auth-query';
import { FacilitiesSection } from '@/components/customers/facilities-section';

function chipStatusFor(status: string): ChipStatus {
  switch (status) {
    case 'Active':   return 'active';
    case 'Prospect': return 'pending';
    case 'Inactive': return 'inactive';
    default:         return 'draft';
  }
}

function formatDate(s?: string | number | null): string {
  if (s === undefined || s === null || s === '') return '—';
  // YYYY-MM-DD strings should render as UTC dates to avoid local-tz drift
  // (the Convex schema stores contract dates as YYYY-MM-DD).
  if (typeof s === 'string') {
    const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(s);
    if (m) {
      const d = new Date(Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3])));
      return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric', timeZone: 'UTC' });
    }
  }
  const d = typeof s === 'number' ? new Date(s) : new Date(s);
  if (Number.isNaN(d.getTime())) return String(s);
  return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
}

// Map an end-date (string OR timestamp) to a chip status. <30 days = expiring,
// past = expired, otherwise active. Mirrors the convention used on the
// carrier insurance card. We accept both shapes because older Convex
// records sometimes stored dates as epoch ms even though the current
// schema types `contractPeriodEnd` as YYYY-MM-DD.
function laneStatus(end?: string | number | null): ChipStatus {
  if (end === undefined || end === null || end === '') return 'na';
  let ms: number;
  if (typeof end === 'number') {
    ms = end;
  } else {
    const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(end);
    if (m) {
      ms = Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
    } else {
      const d = new Date(end);
      if (Number.isNaN(d.getTime())) return 'na';
      ms = d.getTime();
    }
  }
  const now = new Date();
  const today = Date.UTC(now.getFullYear(), now.getMonth(), now.getDate());
  const days = Math.ceil((ms - today) / 86_400_000);
  if (days < 0) return 'expired';
  if (days <= 30) return 'expiring';
  return 'active';
}

interface LaneRow {
  id: string;
  laneId: string;
  contract: string;
  hcr?: string;
  trip?: string;
  laneLabel: string;
  start: string | number;
  end: string | number;
  rate: number;
  rateType: 'Per Mile' | 'Flat Rate' | 'Per Stop';
  currency: 'USD' | 'CAD' | 'MXN';
  miles?: number;
  priority?: 'Primary' | 'Secondary';
  isActive: boolean;
  isDeleted: boolean;
  status: ChipStatus;
}

function formatRate(rate: number, rateType: 'Per Mile' | 'Flat Rate' | 'Per Stop', currency: 'USD' | 'CAD' | 'MXN'): string {
  const symbol = currency === 'CAD' ? 'C$' : currency === 'MXN' ? 'MX$' : '$';
  const unit = rateType === 'Per Mile' ? '/mi' : rateType === 'Per Stop' ? '/stop' : '';
  // Per-mile / per-stop typically render with 2 decimals; flat rate gets
  // thousand-separators with no decimals beyond cents.
  if (rateType === 'Flat Rate') {
    return `${symbol}${rate.toLocaleString(undefined, { minimumFractionDigits: 0, maximumFractionDigits: 2 })}`;
  }
  return `${symbol}${rate.toFixed(2)}${unit}`;
}

export function CustomerDetailContent({ customerId }: { customerId: string }) {
  const router = useRouter();
  const customerIdTyped = customerId as Id<'customers'>;
  const customer = useQuery(api.customers.get, { id: customerIdTyped });
  const updateCustomer = useMutation(api.customers.update);
  const contractLanes = useQuery(api.contractLanes.listByCustomer, { customerCompanyId: customerIdTyped });

  // Prev / next traversal across the customers list.
  const all = useAuthQuery(api.customers.list, {});

  // Inline-edit commit. Field keys map straight to api.customers.update args;
  // keys outside the allowlist are dropped so a new editable row can't write
  // to a field the backend rejects.
  const ALLOWED_FIELDS = new Set<string>([
    'name', 'companyType', 'status', 'office',
    'addressLine1', 'addressLine2', 'city', 'state', 'zip', 'country',
    'primaryContactName', 'primaryContactTitle', 'primaryContactEmail', 'primaryContactPhone',
    'secondaryContactName', 'secondaryContactEmail', 'secondaryContactPhone',
    'loadingType', 'locationScheduleType', 'instructions',
    'internalNotes',
  ]);
  const commitField = async (key: string, next: string | string[]) => {
    if (!ALLOWED_FIELDS.has(key)) return;
    const value = Array.isArray(next) ? next.join(', ') : next;
    try {
      await updateCustomer({ id: customerIdTyped, [key]: value } as never);
      toast.success('Saved');
    } catch (e) {
      console.error(e);
      toast.error('Failed to save change');
    }
  };

  // ─── Contract-lane aggregates ──────────────────────────────────────────
  // Computed up-front because KPIs, the section tab badge, and the right
  // rail all depend on the same counts. MUST run before any early-return
  // so React's hooks order stays stable across renders.
  const laneRows: LaneRow[] = React.useMemo(() => {
    if (!contractLanes) return [];
    return (contractLanes as Array<Record<string, unknown>>)
      .filter((l) => !l.isDeleted)
      .map((l) => {
        const stops = (l.stops as Array<{ city: string; state: string; stopOrder: number }>) ?? [];
        const sorted = [...stops].sort((a, b) => a.stopOrder - b.stopOrder);
        const origin = sorted[0];
        const dest = sorted[sorted.length - 1];
        const laneLabel = origin && dest && origin !== dest
          ? `${origin.city}, ${origin.state} → ${dest.city}, ${dest.state}`
          : origin
            ? `${origin.city}, ${origin.state}`
            : '—';
        const start = l.contractPeriodStart as string | number;
        const end = l.contractPeriodEnd as string | number;
        const isActive = l.isActive !== false;
        const status: ChipStatus = !isActive ? 'inactive' : laneStatus(end);
        return {
          id: l._id as string,
          laneId: l._id as string,
          contract: (l.contractName as string) ?? '—',
          hcr: l.hcr as string | undefined,
          trip: l.tripNumber as string | undefined,
          laneLabel,
          start,
          end,
          rate: l.rate as number,
          rateType: (l.rateType as LaneRow['rateType']) ?? 'Per Mile',
          currency: (l.currency as LaneRow['currency']) ?? 'USD',
          miles: l.miles as number | undefined,
          priority: l.lanePriority as LaneRow['priority'],
          isActive,
          isDeleted: !!l.isDeleted,
          status,
        };
      });
  }, [contractLanes]);
  const contractsActiveCount = laneRows.filter((r) => r.status === 'active' || r.status === 'valid').length;
  const contractsExpiringCount = laneRows.filter((r) => r.status === 'expiring').length;
  const contractsExpiredCount = laneRows.filter((r) => r.status === 'expired').length;

  if (customer === undefined) {
    return (
      <div className="flex-1 flex items-center justify-center">
        <Loader2 className="h-5 w-5 animate-spin text-[var(--text-tertiary)]" />
      </div>
    );
  }
  if (customer === null) {
    return (
      <div className="flex-1 flex items-center justify-center text-[12.5px] text-[var(--text-tertiary)]">
        Customer not found.
      </div>
    );
  }

  const name = customer.name ?? 'Unknown customer';
  const created = customer._creationTime ? formatDate(customer._creationTime) : '—';
  const status = customer.status ?? 'Active';

  const addressLine = [
    customer.addressLine1,
    customer.addressLine2,
    [customer.city, customer.state].filter(Boolean).join(', '),
    customer.zip,
    customer.country,
  ].filter(Boolean).join(' · ');

  // Active-contracts KPI is wired to the real contractLanes count; the
  // remaining cells stay fact-based (status / type / loading) so the strip
  // doesn't claim spend or load metrics that aren't backed by data.
  const kpis: FPKpi[] = [
    { label: 'Status',           value: <Chip status={chipStatusFor(status)} label={status} /> },
    { label: 'Company type',     value: customer.companyType ?? '—' },
    { label: 'Loading',          value: customer.loadingType ?? '—' },
    {
      label: 'Active contracts',
      value: <span className="num">{contractsActiveCount}</span>,
      delta: contractsExpiringCount > 0
        ? { value: `${contractsExpiringCount} expiring`, tone: 'down' }
        : undefined,
    },
  ];

  const eyebrow = status === 'Active'
    ? <Chip status="active" label="Active" />
    : status === 'Prospect'
      ? <Chip status="pending" label="Prospect" />
      : <Chip status="inactive" label={status} />;

  const titleNode = (
    <span className="inline-flex items-center gap-3">
      <Avatar name={name} size={36} />
      <span>{name}</span>
    </span>
  );

  const subtitle = (
    <span className="flex flex-wrap items-center gap-x-4 gap-y-1 text-[13px] text-[var(--text-secondary)]">
      <span className="inline-flex items-center gap-1.5">
        <WIcon name="building" size={12} /> {customer.companyType ?? '—'}
      </span>
      {customer.office && (
        <span className="inline-flex items-center gap-1.5">
          <WIcon name="users" size={12} /> {customer.office}
        </span>
      )}
      {(customer.city || customer.state) && (
        <span className="inline-flex items-center gap-1.5">
          <WIcon name="map" size={12} /> {[customer.city, customer.state].filter(Boolean).join(', ')}
        </span>
      )}
      <span className="inline-flex items-center gap-1.5">
        <WIcon name="calendar" size={12} /> Since {created}
      </span>
    </span>
  );

  const accountItems: DSPropsEditableItem[] = [
    {
      key: 'name',
      label: 'Name',
      value: customer.name ?? '',
      display: <span style={{ fontWeight: 500 }}>{customer.name ?? '—'}</span>,
      editor: { type: 'text' },
      placeholder: 'Customer name',
    },
    {
      key: 'companyType',
      label: 'Type',
      value: customer.companyType ?? '',
      editor: {
        type: 'select',
        options: [
          { value: 'Shipper',      label: 'Shipper' },
          { value: 'Broker',       label: 'Broker' },
          { value: 'Manufacturer', label: 'Manufacturer' },
          { value: 'Distributor',  label: 'Distributor' },
        ],
      },
      placeholder: 'Pick type',
    },
    {
      key: 'status',
      label: 'Status',
      value: customer.status ?? '',
      display: <Chip status={chipStatusFor(status)} label={status} />,
      editor: {
        type: 'select',
        options: [
          { value: 'Active',   label: 'Active' },
          { value: 'Prospect', label: 'Prospect' },
          { value: 'Inactive', label: 'Inactive' },
        ],
      },
      placeholder: 'Pick status',
    },
    {
      key: 'office',
      label: 'Office',
      value: customer.office ?? '',
      editor: { type: 'text' },
      placeholder: 'Office name',
    },
  ];

  const primaryContactItems: DSPropsEditableItem[] = [
    {
      key: 'primaryContactName',
      label: 'Name',
      value: customer.primaryContactName ?? '',
      display: customer.primaryContactName
        ? <span style={{ fontWeight: 500 }}>{customer.primaryContactName}</span>
        : undefined,
      editor: { type: 'text' },
      placeholder: 'Add contact name',
    },
    {
      key: 'primaryContactTitle',
      label: 'Title',
      value: customer.primaryContactTitle ?? '',
      editor: { type: 'text' },
      placeholder: 'Title',
    },
    {
      key: 'primaryContactPhone',
      label: 'Phone',
      value: customer.primaryContactPhone ?? '',
      display: customer.primaryContactPhone
        ? <span className="num">{customer.primaryContactPhone}</span>
        : undefined,
      editor: { type: 'phone' },
      placeholder: 'Add phone',
    },
    {
      key: 'primaryContactEmail',
      label: 'Email',
      value: customer.primaryContactEmail ?? '',
      editor: { type: 'email' },
      placeholder: 'Add email',
    },
  ];

  const addressItems: DSPropsEditableItem[] = [
    {
      key: 'addressLine1',
      label: 'Address 1',
      value: customer.addressLine1 ?? '',
      editor: { type: 'text' },
      placeholder: 'Street address',
    },
    {
      key: 'addressLine2',
      label: 'Address 2',
      value: customer.addressLine2 ?? '',
      editor: { type: 'text' },
      placeholder: 'Apt, suite, unit',
    },
    {
      key: 'city',
      label: 'City',
      value: customer.city ?? '',
      editor: { type: 'text' },
      placeholder: 'City',
    },
    {
      key: 'state',
      label: 'State',
      value: customer.state ?? '',
      editor: { type: 'text' },
      placeholder: 'CA',
    },
    {
      key: 'zip',
      label: 'Zip',
      value: customer.zip ?? '',
      editor: { type: 'text' },
      placeholder: '95823',
    },
    {
      key: 'country',
      label: 'Country',
      value: customer.country ?? '',
      editor: { type: 'text' },
      placeholder: 'Country',
    },
  ];

  const operationsItems: DSPropsEditableItem[] = [
    {
      key: 'loadingType',
      label: 'Loading type',
      value: customer.loadingType ?? '',
      editor: {
        type: 'select',
        options: [
          { value: 'Live Load',   label: 'Live Load' },
          { value: 'Drop & Hook', label: 'Drop & Hook' },
          { value: 'Appointment', label: 'Appointment' },
        ],
      },
      placeholder: 'Pick loading type',
    },
    {
      key: 'locationScheduleType',
      label: 'Schedule',
      value: customer.locationScheduleType ?? '',
      editor: {
        type: 'select',
        options: [
          { value: '24/7',             label: '24/7' },
          { value: 'Business Hours',   label: 'Business Hours' },
          { value: 'Appointment Only', label: 'Appointment Only' },
          { value: 'Specific Hours',   label: 'Specific Hours' },
        ],
      },
      placeholder: 'Pick schedule',
    },
    {
      key: 'instructions',
      label: 'Instructions',
      value: customer.instructions ?? '',
      editor: { type: 'textarea', rows: 3 },
      placeholder: 'Add instructions',
    },
  ];

  const secondaryContactItems: DSPropsEditableItem[] = [
    {
      key: 'secondaryContactName',
      label: 'Name',
      value: customer.secondaryContactName ?? '',
      editor: { type: 'text' },
      placeholder: 'Add contact name',
    },
    {
      key: 'secondaryContactPhone',
      label: 'Phone',
      value: customer.secondaryContactPhone ?? '',
      display: customer.secondaryContactPhone
        ? <span className="num">{customer.secondaryContactPhone}</span>
        : undefined,
      editor: { type: 'phone' },
      placeholder: 'Add phone',
    },
    {
      key: 'secondaryContactEmail',
      label: 'Email',
      value: customer.secondaryContactEmail ?? '',
      editor: { type: 'email' },
      placeholder: 'Add email',
    },
  ];

  // ─── Section: Overview ────────────────────────────────────────────────
  const overviewContent = (
    <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
      <DSCard title="Account">
        <DSPropsEditable items={accountItems} onCommit={commitField} />
      </DSCard>

      <DSCard title="Primary contact">
        <DSPropsEditable items={primaryContactItems} onCommit={commitField} />
      </DSCard>

      <DSCard title="Addresses">
        <DSPropsEditable items={addressItems} onCommit={commitField} />
      </DSCard>

      <DSCard title="Operations">
        <DSPropsEditable items={operationsItems} onCommit={commitField} />
      </DSCard>

      <DSCard title="Secondary contact">
        <DSPropsEditable items={secondaryContactItems} onCommit={commitField} />
      </DSCard>

      <DSCard title="Internal notes">
        <DSPropsEditable
          onCommit={commitField}
          items={[
            {
              key: 'internalNotes',
              label: 'Notes',
              value: customer.internalNotes ?? '',
              editor: { type: 'textarea', rows: 3 },
              placeholder: 'Add internal notes',
            },
          ]}
        />
      </DSCard>
    </div>
  );

  // ─── Section: Contracts ───────────────────────────────────────────────
  // The lane data + counts are computed earlier (above the KPI strip) so
  // both surfaces stay in sync.
  const laneColumns: DSMiniColumn<LaneRow>[] = [
    {
      key: 'contract',
      label: 'Contract',
      width: '1.1fr',
      render: (r) => (
        <span className="min-w-0 flex flex-col leading-tight">
          <span className="num text-[12.5px] font-medium" style={{ color: 'var(--accent)' }}>
            {r.hcr ?? r.contract}
          </span>
          {r.hcr && r.contract !== r.hcr && (
            <span className="text-[11.5px] text-[var(--text-tertiary)] truncate">{r.contract}</span>
          )}
        </span>
      ),
    },
    {
      key: 'lane',
      label: 'Lane',
      width: '1.8fr',
      render: (r) => <span className="text-[12.5px] text-foreground truncate">{r.laneLabel}</span>,
    },
    {
      key: 'term',
      label: 'Term',
      width: '1.4fr',
      render: (r) => (
        <span className="num text-[11.5px] text-[var(--text-secondary)]">
          {formatDate(r.start)} — {formatDate(r.end)}
        </span>
      ),
    },
    {
      key: 'rate',
      label: 'Rate',
      width: '110px',
      align: 'right',
      tnum: true,
      render: (r) => (
        <span className="num text-[12.5px] text-foreground">
          {formatRate(r.rate, r.rateType, r.currency)}
        </span>
      ),
    },
    {
      key: 'priority',
      label: 'Priority',
      width: '90px',
      render: (r) => (r.priority
        ? <Chip status={r.priority === 'Primary' ? 'active' : 'draft'} label={r.priority} />
        : <span className="text-[11.5px] text-[var(--text-tertiary)]">—</span>
      ),
    },
    {
      key: 'status',
      label: 'Status',
      width: '110px',
      render: (r) => <Chip status={r.status} />,
    },
  ];

  const contractsContent = (
    <DSCard
      title={`Contracts (${laneRows.length})`}
      // Cap the card to the remaining viewport so the table's body scrolls
      // internally instead of bleeding past the bottom of the page. Measured
      // empirically: in practice the card's top sits at y≈433 once the
      // global topbar, sub-toolbar, hero w/ KPIs, section tabs and outer
      // page padding are stacked — so an offset of 460 leaves a small
      // breathing gap above the floating tweaks pill / user-badge.
      className="flex flex-col max-h-[calc(100vh-460px)]"
      bodyClassName="p-0 flex-1 min-h-0 flex flex-col"
      action={
        <span className="flex items-center gap-2">
          <WBtn
            size="sm"
            leading="plus"
            onClick={() => router.push(`/operations/customers/${customerIdTyped}/contract-lanes/create`)}
          >
            New lane
          </WBtn>
          <WBtn
            size="sm"
            leading="arrow-up-right"
            onClick={() => router.push(`/operations/customers/${customerIdTyped}/contract-lanes`)}
          >
            View all
          </WBtn>
        </span>
      }
    >
      {contractLanes === undefined ? (
        <p className="m-0 px-4 py-3 text-[12.5px] text-[var(--text-tertiary)]">Loading contracts…</p>
      ) : laneRows.length === 0 ? (
        <div className="px-4 py-6 text-center">
          <p className="m-0 text-[13px] text-foreground font-medium">No contract lanes yet</p>
          <p className="m-0 mt-1 text-[12px] text-[var(--text-tertiary)]">
            Add a contract lane to set rates, accessorials, and frequency for this customer.
          </p>
          <span className="inline-block mt-3">
            <WBtn
              size="sm"
              variant="primary"
              leading="plus"
              onClick={() => router.push(`/operations/customers/${customerIdTyped}/contract-lanes/create`)}
            >
              New contract lane
            </WBtn>
          </span>
        </div>
      ) : (
        <DSMiniTable
          columns={laneColumns}
          rows={laneRows}
          total={laneRows.length}
          onRowClick={(r) => router.push(`/operations/customers/${customerIdTyped}/contract-lanes/${r.laneId}`)}
          className="rounded-t-none border-0 border-t flex-1 min-h-0"
          fillHeight
        />
      )}
    </DSCard>
  );

  // ─── Section: Loads ──────────────────────────────────────────────────
  const loadsContent = (
    <DSCard title="Loads">
      <DSActivity emptyText="Customer loads will appear here once routed." items={[]} />
    </DSCard>
  );

  // ─── Section: Contacts ───────────────────────────────────────────────
  const contactsContent = (
    <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
      <DSCard title="Primary contact">
        <DSPropsEditable items={primaryContactItems} onCommit={commitField} />
      </DSCard>
      <DSCard title="Secondary contact">
        <DSPropsEditable items={secondaryContactItems} onCommit={commitField} />
      </DSCard>
    </div>
  );

  // ─── Section: Locations ──────────────────────────────────────────────
  // Billing address (editable props) + the facility registry. Facilities
  // are the customer's physical stop locations — imported loads link
  // stops to them, and verified pins anchor driver check-in geofencing.
  const locationsContent = (
    <div className="grid gap-4">
      <DSCard title="Billing address">
        <DSPropsEditable items={addressItems} onCommit={commitField} />
      </DSCard>
      <FacilitiesSection customerId={customerIdTyped} />
    </div>
  );

  // ─── Section: Invoices ───────────────────────────────────────────────
  const invoicesContent = (
    <DSCard title="Invoices">
      <DSActivity emptyText="Invoices will appear here once billing is configured." items={[]} />
    </DSCard>
  );

  // ─── Section: Activity ───────────────────────────────────────────────
  const activityContent = (
    <DSCard title="Recent activity">
      <DSActivity
        items={[
          { icon: 'plus', text: 'Customer created', when: created },
          customer.status === 'Active'
            ? { icon: 'check', text: 'Status: Active', when: '' }
            : { icon: 'pulse', text: `Status: ${customer.status}`, when: '' },
          customer.primaryContactName
            ? { icon: 'users', text: `Primary contact: ${customer.primaryContactName}`, when: '' }
            : { icon: 'circle-dot', text: 'No primary contact yet', when: '' },
        ]}
      />
    </DSCard>
  );

  const sections: FPSection[] = [
    { id: 'overview',  label: 'Overview',  icon: 'home',       content: overviewContent },
    {
      id: 'contracts',
      label: 'Contracts',
      icon: 'doc-dollar',
      count: laneRows.length,
      attention: contractsExpiredCount + contractsExpiringCount > 0
        ? contractsExpiredCount + contractsExpiringCount
        : undefined,
      content: contractsContent,
    },
    { id: 'loads',     label: 'Loads',     icon: 'package',    content: loadsContent },
    { id: 'contacts',  label: 'Contacts',  icon: 'users',      content: contactsContent },
    { id: 'locations', label: 'Locations', icon: 'map',        content: locationsContent },
    { id: 'invoices',  label: 'Invoices',  icon: 'receipt',    content: invoicesContent },
    { id: 'activity',  label: 'Activity',  icon: 'pulse',      content: activityContent },
  ];

  const rightRail = (
    <div className="flex flex-col gap-3">
      {(contractsExpiringCount > 0 || contractsExpiredCount > 0) && (
        <DSCard title="Renewals due">
          <DSActivity
            items={[
              contractsExpiredCount > 0
                ? { icon: 'alert', text: `${contractsExpiredCount} contract lane${contractsExpiredCount !== 1 ? 's' : ''} expired`, when: 'needs renewal' }
                : null,
              contractsExpiringCount > 0
                ? { icon: 'alert', text: `${contractsExpiringCount} contract lane${contractsExpiringCount !== 1 ? 's' : ''} expiring within 30 days`, when: '' }
                : null,
            ].filter(Boolean) as { icon: 'alert'; text: string; when: string }[]}
          />
        </DSCard>
      )}
      <DSCard title="Health">
        <DSActivity
          items={[
            status === 'Active'
              ? { icon: 'check', text: 'Active account', when: '' }
              : status === 'Prospect'
                ? { icon: 'pulse', text: 'Prospect — not yet active', when: '' }
                : { icon: 'circle-dot', text: `Status: ${status}`, when: '' },
            laneRows.length === 0
              ? { icon: 'circle-dot', text: 'No contract lanes yet', when: '' }
              : { icon: 'check', text: `${contractsActiveCount} active lane${contractsActiveCount !== 1 ? 's' : ''}`, when: laneRows.length > contractsActiveCount ? `${laneRows.length - contractsActiveCount} other` : '' },
            customer.primaryContactName
              ? { icon: 'check', text: 'Primary contact on file', when: '' }
              : { icon: 'alert', text: 'No primary contact', when: '' },
            addressLine
              ? { icon: 'check', text: 'Address on file', when: '' }
              : { icon: 'alert', text: 'No address on file', when: '' },
          ]}
        />
      </DSCard>
      <DSCard title="Quick links">
        <DSActivity
          items={[
            { icon: 'doc-dollar', text: 'Open contract lanes', when: '' },
            { icon: 'edit',       text: 'Edit customer details', when: '' },
          ]}
        />
      </DSCard>
    </div>
  );

  // Prev / next across the customer list.
  const list = (all ?? []).filter((c) => !c.isDeleted);
  const idx = list.findIndex((c) => c._id === customer._id);
  const prev = idx > 0 ? list[idx - 1] : null;
  const next = idx >= 0 && idx < list.length - 1 ? list[idx + 1] : null;

  return (
    <DetailsFullPage
      breadcrumb={
        <span className="inline-flex items-center gap-1.5 text-[var(--text-secondary)]">
          <button type="button" onClick={() => router.push('/operations/customers')} className="hover:text-foreground">
            Customers
          </button>
          <span className="text-[var(--text-tertiary)]">/</span>
          <span className="text-foreground font-medium truncate max-w-[280px]">{name}</span>
        </span>
      }
      onBack={() => router.push('/operations/customers')}
      prevLabel={prev?.name ?? undefined}
      onPrev={prev ? () => router.push(`/operations/customers/${prev._id}`) : null}
      nextLabel={next?.name ?? undefined}
      onNext={next ? () => router.push(`/operations/customers/${next._id}`) : null}
      toolbarActions={
        <>
          <WBtn size="sm" variant="ghost" leading="chat">Message</WBtn>
          <WBtn size="sm" variant="ghost" leading="package">New quote</WBtn>
          <WBtn size="sm" variant="ghost" leading="doc-dollar" onClick={() => router.push(`/operations/customers/${customerIdTyped}/contract-lanes`)}>
            Contract lanes
          </WBtn>
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
