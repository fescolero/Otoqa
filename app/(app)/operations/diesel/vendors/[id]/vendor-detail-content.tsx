/**
 * VendorDetailContent — full-page fuel vendor record on the Otoqa Web
 * chassis. Mirrors design v5's details-vendor.jsx:
 *
 *   Sub-toolbar → hero (brand badge + name + network + KPIs)
 *   Sections: Overview · Pricing · Purchases · Locations · Activity
 *   Right rail: Savings — 30 day · Top sites · Account contact
 *
 * Inline-edit on Overview rows commits via api.fuelVendors.update.
 */

'use client';

import * as React from 'react';
import { useRouter } from 'next/navigation';
import { useMutation } from 'convex/react';
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
import { useAuth } from '@workos-inc/authkit-nextjs/components';
import { useOrganizationId } from '@/contexts/organization-context';
import { VendorBrandBadge } from '@/components/diesel/vendor-brand-badge';
import { FLEET_AVG_PPG } from '@/components/diesel/vendors-list';

const THIRTY_DAYS_MS = 30 * 24 * 60 * 60 * 1000;

interface FuelEntryRecord {
  _id: string;
  entryDate: number;
  vendorId: string;
  vendorName?: string;
  driverName?: string;
  carrierName?: string;
  truckUnitId?: string;
  gallons: number;
  pricePerGallon: number;
  totalCost: number;
  location?: { city: string; state: string };
  loadReference?: string;
  loadId?: string;
}

interface SiteRow {
  id: string;
  site: string;
  state: string;
  visits: number;
  ppg: number;
}

interface PurchaseRow {
  id: string;
  date: string;
  site: string;
  driver: string;
  gallons: number;
  ppg: number;
  total: string;
  truck: string;
}

export function VendorDetailContent({ vendorId }: { vendorId: string }) {
  const router = useRouter();
  const { user } = useAuth();
  const organizationId = useOrganizationId();
  const vid = vendorId as Id<'fuelVendors'>;

  const vendor = useAuthQuery(api.fuelVendors.get, { vendorId: vid });
  const allVendors = useAuthQuery(
    api.fuelVendors.list,
    organizationId ? { organizationId } : 'skip',
  );

  // Recent fuel entries — large enough to support 30-day analytics + the
  // Purchases / Locations tabs without paginating.
  const recentEntries = useAuthQuery(
    api.fuelEntries.list,
    organizationId
      ? ({
          organizationId,
          vendorId: vid,
          paginationOpts: { numItems: 200, cursor: null },
        } as never)
      : 'skip',
  );

  const updateVendor = useMutation(api.fuelVendors.update);
  const toggleActive = useMutation(api.fuelVendors.toggleActive);

  // ─── Inline-edit ──────────────────────────────────────────────────────
  const ALLOWED_FIELDS = React.useMemo(
    () => new Set<string>([
      'name', 'code', 'accountNumber', 'discountProgram',
      'contactName', 'contactEmail', 'contactPhone',
      'addressLine', 'city', 'state', 'zip', 'country',
      'notes',
    ]),
    [],
  );
  const commitField = React.useCallback(async (key: string, next: string | string[]) => {
    if (!ALLOWED_FIELDS.has(key) || !user) return;
    const value = Array.isArray(next) ? next.join(', ') : next;
    try {
      await updateVendor({ vendorId: vid, updatedBy: user.id, [key]: value } as never);
      toast.success('Saved');
    } catch (e) {
      console.error(e);
      toast.error('Failed to save change');
    }
  }, [ALLOWED_FIELDS, user, updateVendor, vid]);

  // ─── Derive analytics + table rows from real fuel entries ─────────────
  const entries: FuelEntryRecord[] = React.useMemo(() => {
    if (!recentEntries) return [];
    return ((recentEntries as { page: Array<Record<string, unknown>> }).page ?? [])
      .map((e) => ({
        _id: e._id as string,
        entryDate: e.entryDate as number,
        vendorId: e.vendorId as string,
        vendorName: e.vendorName as string | undefined,
        driverName: e.driverName as string | undefined,
        carrierName: e.carrierName as string | undefined,
        truckUnitId: e.truckUnitId as string | undefined,
        gallons: e.gallons as number,
        pricePerGallon: e.pricePerGallon as number,
        totalCost: e.totalCost as number,
        location: e.location as { city: string; state: string } | undefined,
        loadReference: e.loadReference as string | undefined,
        loadId: e.loadId as string | undefined,
      }));
  }, [recentEntries]);

  const cutoff = Date.now() - THIRTY_DAYS_MS;
  const recent30 = entries.filter((e) => e.entryDate >= cutoff);

  const totalGallons30 = recent30.reduce((acc, e) => acc + (e.gallons ?? 0), 0);
  const totalSpend30 = recent30.reduce((acc, e) => acc + (e.totalCost ?? 0), 0);
  const ppgSum30 = recent30.reduce((acc, e) => acc + (e.pricePerGallon ?? 0), 0);
  const avgPpg = recent30.length > 0 ? ppgSum30 / recent30.length : 0;
  const txns30 = recent30.length;
  const delta = avgPpg - FLEET_AVG_PPG;

  const lastBuy = entries.length > 0
    ? new Date(Math.max(...entries.map((e) => e.entryDate)))
    : null;

  // Sites = grouped by location.city (state-aware). Used in the Locations
  // tab and the "Top sites" right-rail card.
  const sites: SiteRow[] = React.useMemo(() => {
    const m = new Map<string, { city: string; state: string; visits: number; ppgSum: number }>();
    for (const e of entries) {
      const city = e.location?.city ?? '';
      const state = e.location?.state ?? '';
      const key = `${city}|${state}`;
      if (!city) continue;
      const acc = m.get(key) ?? { city, state, visits: 0, ppgSum: 0 };
      acc.visits += 1;
      acc.ppgSum += e.pricePerGallon ?? 0;
      m.set(key, acc);
    }
    return [...m.entries()]
      .map(([key, s]) => ({
        id: key,
        site: s.city,
        state: s.state || '—',
        visits: s.visits,
        ppg: s.visits > 0 ? s.ppgSum / s.visits : 0,
      }))
      .sort((a, b) => b.visits - a.visits);
  }, [entries]);

  const purchases: PurchaseRow[] = React.useMemo(() => {
    return [...entries]
      .sort((a, b) => b.entryDate - a.entryDate)
      .slice(0, 25)
      .map((e) => ({
        id: e._id,
        date: new Date(e.entryDate).toLocaleDateString('en-US', { month: 'short', day: 'numeric' }),
        site: e.location ? `${e.location.city}, ${e.location.state}` : '—',
        driver: e.driverName ?? 'Unassigned',
        gallons: e.gallons ?? 0,
        ppg: e.pricePerGallon ?? 0,
        total: `$${(e.totalCost ?? 0).toFixed(2)}`,
        truck: e.truckUnitId ?? '—',
      }));
  }, [entries]);

  if (vendor === undefined) {
    return (
      <div className="flex-1 flex items-center justify-center">
        <Loader2 className="h-5 w-5 animate-spin text-[var(--text-tertiary)]" />
      </div>
    );
  }
  if (vendor === null) {
    return (
      <div className="flex-1 flex items-center justify-center text-[12.5px] text-[var(--text-tertiary)]">
        Vendor not found.
      </div>
    );
  }

  const name = vendor.name ?? 'Unknown vendor';
  const code = vendor.code ?? '';
  const isContracted = !!(vendor.discountProgram && vendor.discountProgram.trim());
  const sinceLabel = vendor._creationTime
    ? new Date(vendor._creationTime).getFullYear().toString()
    : '—';

  const statusChip: { status: ChipStatus; label: string } = !vendor.isActive
    ? { status: 'inactive', label: 'Inactive' }
    : isContracted
      ? { status: 'assigned', label: 'Preferred' }
      : { status: 'active', label: 'Active' };

  // ─── Hero ────────────────────────────────────────────────────────────
  const titleNode = (
    <span className="inline-flex items-center gap-3">
      <VendorBrandBadge name={name} code={code || undefined} size={36} />
      <span>{name}</span>
      <Chip status={statusChip.status} label={statusChip.label} />
    </span>
  );

  const subtitle = (
    <span className="flex flex-wrap items-center gap-x-4 gap-y-1 text-[13px] text-[var(--text-secondary)]">
      {isContracted ? (
        <span className="inline-flex items-center gap-1.5">
          <WIcon name="doc-dollar" size={12} /> {vendor.discountProgram}
        </span>
      ) : (
        <span className="inline-flex items-center gap-1.5 text-[var(--text-tertiary)]">
          <WIcon name="doc-dollar" size={12} /> Retail · no fleet contract
        </span>
      )}
      <span className="inline-flex items-center gap-1.5 num">
        <WIcon name="pulse" size={12} /> {sites.length} {sites.length === 1 ? 'site' : 'sites'} on file
      </span>
      <span className="inline-flex items-center gap-1.5">
        <WIcon name="calendar" size={12} /> Member since {sinceLabel}
      </span>
    </span>
  );

  const kpis: FPKpi[] = [
    {
      label: 'Avg $/gal',
      value: avgPpg > 0 ? <span className="num">${avgPpg.toFixed(3)}</span> : '—',
      delta: avgPpg > 0
        ? {
            value: `${delta <= 0 ? '−' : '+'}$${Math.abs(delta).toFixed(2)} vs fleet`,
            tone: delta <= 0 ? 'up' : 'down',
          }
        : undefined,
    },
    {
      label: 'Gallons · 30d',
      value: txns30 > 0 ? <span className="num">{Math.round(totalGallons30).toLocaleString()}</span> : '—',
    },
    {
      label: 'Spend · 30d',
      value: txns30 > 0 ? <span className="num">${Math.round(totalSpend30).toLocaleString()}</span> : '—',
    },
    {
      label: 'Sites used',
      value: <span className="num">{sites.length}</span>,
    },
  ];

  // ─── Section: Overview ────────────────────────────────────────────────
  const contractItems: DSPropsEditableItem[] = [
    {
      key: 'name',
      label: 'Name',
      value: vendor.name ?? '',
      display: <span style={{ fontWeight: 500 }}>{vendor.name}</span>,
      editor: { type: 'text' },
      placeholder: 'Vendor name',
    },
    {
      key: 'code',
      label: 'Code',
      value: vendor.code ?? '',
      display: vendor.code
        ? <span className="num">{vendor.code}</span>
        : undefined,
      editor: { type: 'text' },
      placeholder: 'e.g. PFJ',
    },
    {
      key: 'discountProgram',
      label: 'Program',
      value: vendor.discountProgram ?? '',
      display: isContracted
        ? <span style={{ fontWeight: 500 }}>{vendor.discountProgram}</span>
        : <span className="text-[var(--text-tertiary)]">Retail · no fleet contract</span>,
      editor: { type: 'text' },
      placeholder: 'e.g. Comdata network',
    },
    {
      key: 'accountNumber',
      label: 'Account #',
      value: vendor.accountNumber ?? '',
      display: vendor.accountNumber
        ? <span className="num">{vendor.accountNumber}</span>
        : <span className="text-[var(--text-tertiary)]">—</span>,
      editor: { type: 'text' },
      placeholder: 'Account number',
    },
    {
      key: 'since',
      label: 'Member since',
      value: '',
      display: <span className="num">{sinceLabel}</span>,
      readOnly: true,
    },
  ];

  const contactItems: DSPropsEditableItem[] = [
    {
      key: 'contactName',
      label: 'Contact',
      value: vendor.contactName ?? '',
      editor: { type: 'text' },
      placeholder: 'Account manager name',
    },
    {
      key: 'contactPhone',
      label: 'Phone',
      value: vendor.contactPhone ?? '',
      display: vendor.contactPhone
        ? <span className="num">{vendor.contactPhone}</span>
        : undefined,
      editor: { type: 'phone' },
      placeholder: 'Phone',
    },
    {
      key: 'contactEmail',
      label: 'Email',
      value: vendor.contactEmail ?? '',
      editor: { type: 'email' },
      placeholder: 'Email',
    },
  ];

  const addressItems: DSPropsEditableItem[] = [
    {
      key: 'addressLine',
      label: 'Address',
      value: vendor.addressLine ?? '',
      editor: { type: 'text' },
      placeholder: 'Street address',
    },
    {
      key: 'city',
      label: 'City',
      value: vendor.city ?? '',
      editor: { type: 'text' },
      placeholder: 'City',
    },
    {
      key: 'state',
      label: 'State',
      value: vendor.state ?? '',
      editor: { type: 'text' },
      placeholder: 'CA',
    },
    {
      key: 'zip',
      label: 'Zip',
      value: vendor.zip ?? '',
      editor: { type: 'text' },
      placeholder: '95823',
    },
  ];

  const overviewContent = (
    <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
      <DSCard title="Contract & terms">
        <DSPropsEditable items={contractItems} onCommit={commitField} />
      </DSCard>
      <DSCard title="Coverage">
        <CoverageBlock
          sitesUsed={sites.length}
          stateList={vendor.state ?? sites.map((s) => s.state).filter((s) => s !== '—').join(' · ')}
          lastBuy={lastBuy}
          statusChip={statusChip}
        />
      </DSCard>
      <DSCard title="Contact">
        <DSPropsEditable items={contactItems} onCommit={commitField} />
      </DSCard>
      <DSCard title="Address">
        <DSPropsEditable items={addressItems} onCommit={commitField} />
      </DSCard>
      {vendor.notes && (
        <div className="md:col-span-2">
          <DSCard title="Notes">
            <DSPropsEditable
              onCommit={commitField}
              items={[
                {
                  key: 'notes',
                  label: 'Notes',
                  value: vendor.notes,
                  editor: { type: 'textarea', rows: 3 },
                  placeholder: 'Internal notes',
                },
              ]}
            />
          </DSCard>
        </div>
      )}
      {!vendor.notes && (
        <div className="md:col-span-2">
          <DSCard title="Notes">
            <DSPropsEditable
              onCommit={commitField}
              items={[
                {
                  key: 'notes',
                  label: 'Notes',
                  value: '',
                  editor: { type: 'textarea', rows: 3 },
                  placeholder: 'Add internal notes about this vendor',
                },
              ]}
            />
          </DSCard>
        </div>
      )}
    </div>
  );

  // ─── Section: Pricing ────────────────────────────────────────────────
  const pricingContent = (
    <div className="flex flex-col gap-3">
      <DSCard title="Price position">
        <div className="flex flex-col gap-2.5">
          <PriceRow
            label="This vendor — 30-day avg"
            value={avgPpg > 0 ? `$${avgPpg.toFixed(3)}` : '—'}
            accent
          />
          <PriceRow label="Fleet 30-day avg" value={`$${FLEET_AVG_PPG.toFixed(3)}`} />
          <PriceRow label="Regional retail benchmark" value="$4.200" />
          {avgPpg > 0 && (
            <div
              className="mt-1 px-2.5 py-2 rounded-md inline-flex items-center gap-2"
              style={{
                background: delta <= 0 ? 'rgba(16,185,129,0.08)' : 'rgba(245,158,11,0.10)',
                border: `1px solid ${delta <= 0 ? 'rgba(16,185,129,0.20)' : 'rgba(245,158,11,0.25)'}`,
              }}
            >
              <WIcon
                name={delta <= 0 ? 'check' : 'alert'}
                size={13}
                style={{ color: delta <= 0 ? '#0F8C5F' : '#A66800' }}
              />
              <span
                className="text-[12px] font-medium"
                style={{ color: delta <= 0 ? '#0F8C5F' : '#A66800' }}
              >
                {delta <= 0
                  ? `$${Math.abs(delta).toFixed(3)}/gal below fleet average`
                  : `$${delta.toFixed(3)}/gal above fleet average — review routing`}
              </span>
            </div>
          )}
        </div>
      </DSCard>
      <DSCard title="Negotiated savings — 30 day">
        {isContracted && txns30 > 0 ? (
          <DSActivity
            items={[
              { icon: 'badge-check', text: 'Discount program in place', when: vendor.discountProgram ?? '' },
              { icon: 'droplet', text: `${Math.round(totalGallons30).toLocaleString()} gal purchased`, when: '30d' },
              { icon: 'doc-dollar', text: `$${Math.round(totalSpend30).toLocaleString()} spend recorded`, when: '30d' },
            ]}
          />
        ) : (
          <div
            className="p-3 text-center text-[12.5px] text-[var(--text-tertiary)] rounded-md border border-dashed"
            style={{ borderColor: 'var(--border-hairline-strong)' }}
          >
            {isContracted
              ? 'No purchases recorded in the last 30 days.'
              : 'Retail vendor — no negotiated discount. Set up a fleet account to capture savings.'}
          </div>
        )}
      </DSCard>
    </div>
  );

  // ─── Section: Purchases ──────────────────────────────────────────────
  const purchasesContent = (
    <DSCard
      title={`Recent purchases (${purchases.length})`}
      bodyClassName="p-0"
      action={<WBtn size="sm" leading="export">Export</WBtn>}
    >
      {purchases.length === 0 ? (
        <p className="m-0 px-4 py-6 text-center text-[12.5px] text-[var(--text-tertiary)]">
          No purchases recorded at this vendor yet.
        </p>
      ) : (
        <DSMiniTable
          columns={purchaseColumns}
          rows={purchases}
          total={purchases.length}
          onRowClick={(r) => router.push(`/operations/diesel/${r.id}?type=fuel`)}
          className="rounded-t-none border-0 border-t"
        />
      )}
    </DSCard>
  );

  // ─── Section: Locations ──────────────────────────────────────────────
  const locationsContent = (
    <DSCard
      title={`Locations (${sites.length})`}
      bodyClassName="p-0"
      action={<WBtn size="sm" leading="plus">Add site</WBtn>}
    >
      {sites.length === 0 ? (
        <p className="m-0 px-4 py-6 text-center text-[12.5px] text-[var(--text-tertiary)]">
          No sites on file yet — sites appear here once you log purchases with a city.
        </p>
      ) : (
        <DSMiniTable
          columns={siteColumns}
          rows={sites}
          total={sites.length}
          className="rounded-t-none border-0 border-t"
        />
      )}
    </DSCard>
  );

  // ─── Section: Activity ───────────────────────────────────────────────
  const activityContent = (
    <DSCard title="Activity">
      <DSActivity
        items={[
          lastBuy
            ? { icon: 'droplet', text: `Last fill-up at ${name}`, when: lastBuy.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' }) }
            : { icon: 'circle-dot', text: 'No purchases recorded yet', when: '' },
          isContracted
            ? { icon: 'badge-check', text: `Discount applied — ${vendor.discountProgram}`, when: 'ongoing' }
            : { icon: 'circle-dot', text: 'Retail pricing — no contract on file', when: '' },
          txns30 > 0
            ? { icon: 'doc-dollar', text: `${txns30} fill-up${txns30 !== 1 ? 's' : ''} in the last 30 days`, when: '30d' }
            : { icon: 'pulse', text: 'No 30-day activity', when: '' },
          {
            icon: 'plus',
            text: 'Vendor added to the network',
            when: vendor._creationTime
              ? new Date(vendor._creationTime).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' })
              : '',
          },
        ]}
      />
    </DSCard>
  );

  const sections: FPSection[] = [
    { id: 'overview',  label: 'Overview',  icon: 'home',        content: overviewContent },
    { id: 'pricing',   label: 'Pricing',   icon: 'doc-dollar',  content: pricingContent },
    { id: 'purchases', label: 'Purchases', icon: 'droplet',     count: purchases.length, content: purchasesContent },
    { id: 'locations', label: 'Locations', icon: 'map',         count: sites.length,     content: locationsContent },
    { id: 'activity',  label: 'Activity',  icon: 'pulse',       content: activityContent },
  ];

  // ─── Right rail ──────────────────────────────────────────────────────
  const rightRail = (
    <div className="flex flex-col gap-3">
      <DSCard title="Savings — 30 day">
        {isContracted && txns30 > 0 ? (
          <DSActivity
            items={[
              { icon: 'badge-check', text: vendor.discountProgram ?? 'Negotiated discount', when: '' },
              { icon: 'droplet', text: `${Math.round(totalGallons30).toLocaleString()} gal on contract`, when: '' },
              { icon: 'doc-dollar', text: `$${Math.round(totalSpend30).toLocaleString()} 30-day spend`, when: '' },
            ]}
          />
        ) : (
          <DSActivity
            items={[
              { icon: 'circle-dot', text: 'Retail pricing', when: '' },
              { icon: 'alert', text: 'No negotiated discount in place', when: '' },
            ]}
          />
        )}
      </DSCard>
      <DSCard title="Top sites">
        {sites.length === 0 ? (
          <DSActivity emptyText="No site activity yet." items={[]} />
        ) : (
          <DSActivity
            items={sites.slice(0, 3).map((s) => ({
              icon: 'map',
              text: `${s.site}, ${s.state}`,
              when: `${s.visits} visit${s.visits === 1 ? '' : 's'}`,
            }))}
          />
        )}
      </DSCard>
      <DSCard title="Account contact">
        {vendor.contactName || vendor.contactPhone || vendor.contactEmail ? (
          <DSActivity
            items={[
              vendor.contactName
                ? { icon: 'users', text: vendor.contactName, when: '' }
                : null,
              vendor.contactPhone
                ? { icon: 'pulse', text: vendor.contactPhone, when: '' }
                : null,
              vendor.contactEmail
                ? { icon: 'chat', text: vendor.contactEmail, when: '' }
                : null,
            ].filter(Boolean) as { icon: 'users' | 'pulse' | 'chat'; text: string; when: string }[]}
          />
        ) : (
          <p className="m-0 text-[12.5px] text-[var(--text-tertiary)]">
            No account contact — this is a retail / ad-hoc vendor.
          </p>
        )}
      </DSCard>
    </div>
  );

  // Prev / next traversal across the org's vendor list.
  const list = (allVendors ?? []).filter(Boolean);
  const idx = list.findIndex((v) => v._id === vendor._id);
  const prev = idx > 0 ? list[idx - 1] : null;
  const next = idx >= 0 && idx < list.length - 1 ? list[idx + 1] : null;

  const onToggleActive = async () => {
    if (!user) return;
    try {
      await toggleActive({ vendorId: vid, updatedBy: user.id });
      toast.success(vendor.isActive ? 'Vendor deactivated' : 'Vendor reactivated');
    } catch (e) {
      console.error(e);
      toast.error('Failed to toggle vendor status');
    }
  };

  return (
    <DetailsFullPage
      breadcrumb={
        <span className="inline-flex items-center gap-1.5 text-[var(--text-secondary)]">
          <button
            type="button"
            onClick={() => router.push('/operations/diesel/vendors')}
            className="hover:text-foreground"
          >
            Fuel Vendors
          </button>
          <span className="text-[var(--text-tertiary)]">/</span>
          <span className="text-foreground font-medium truncate max-w-[280px]">{name}</span>
        </span>
      }
      onBack={() => router.push('/operations/diesel/vendors')}
      prevLabel={prev?.name ?? undefined}
      onPrev={prev ? () => router.push(`/operations/diesel/vendors/${prev._id}`) : null}
      nextLabel={next?.name ?? undefined}
      onNext={next ? () => router.push(`/operations/diesel/vendors/${next._id}`) : null}
      toolbarActions={
        <>
          <WBtn size="sm" variant="ghost" leading="plus">Log fill-up</WBtn>
          {vendor.isActive ? (
            <WBtn size="sm" variant="secondary" leading="alert" onClick={onToggleActive}>
              Deactivate
            </WBtn>
          ) : (
            <WBtn size="sm" variant="secondary" leading="restore" onClick={onToggleActive}>
              Reactivate
            </WBtn>
          )}
        </>
      }
      title={titleNode}
      subtitle={subtitle}
      kpis={kpis}
      sections={sections}
      rightRail={rightRail}
    />
  );
}

// ─── Inner pieces ───────────────────────────────────────────────────────

function CoverageBlock({
  sitesUsed,
  stateList,
  lastBuy,
  statusChip,
}: {
  sitesUsed: number;
  stateList: string;
  lastBuy: Date | null;
  statusChip: { status: ChipStatus; label: string };
}) {
  return (
    <dl className="grid gap-0" style={{ gridTemplateColumns: `120px 1fr` }}>
      <CoverageRow
        label="Sites used"
        value={
          <>
            <span className="num font-medium">{sitesUsed}</span>{' '}
            {sitesUsed === 1 ? 'location' : 'locations'}
          </>
        }
        first
      />
      <CoverageRow
        label="States"
        value={stateList || <span className="text-[var(--text-tertiary)]">—</span>}
      />
      <CoverageRow
        label="Last purchase"
        value={
          lastBuy ? (
            <span className="num">
              {lastBuy.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' })}
            </span>
          ) : (
            <span className="text-[var(--text-tertiary)]">—</span>
          )
        }
      />
      <CoverageRow
        label="Status"
        value={<Chip status={statusChip.status} label={statusChip.label} />}
      />
    </dl>
  );
}

function CoverageRow({
  label,
  value,
  first,
}: {
  label: React.ReactNode;
  value: React.ReactNode;
  first?: boolean;
}) {
  const border = first ? '' : 'border-t border-[var(--border-hairline)]';
  return (
    <>
      <dt className={`py-2.5 pr-3 text-[12.5px] text-[var(--text-tertiary)] ${border}`}>{label}</dt>
      <dd className={`py-2.5 m-0 text-[13px] text-foreground inline-flex items-center gap-2 min-w-0 ${border}`}>
        {value}
      </dd>
    </>
  );
}

function PriceRow({ label, value, accent }: { label: string; value: string; accent?: boolean }) {
  return (
    <div className="flex items-center justify-between">
      <span
        className="text-[12.5px]"
        style={{ color: accent ? 'var(--text-primary)' : 'var(--text-secondary)', fontWeight: accent ? 500 : 400 }}
      >
        {label}
      </span>
      <span
        className="num text-[13px]"
        style={{ color: accent ? 'var(--accent)' : 'var(--text-primary)', fontWeight: accent ? 600 : 500 }}
      >
        {value}
      </span>
    </div>
  );
}

const purchaseColumns: DSMiniColumn<PurchaseRow>[] = [
  {
    key: 'date',
    label: 'Date',
    width: '80px',
    render: (r) => <span className="num text-[12px]">{r.date}</span>,
  },
  {
    key: 'site',
    label: 'Site',
    width: '1.6fr',
    render: (r) => (
      <span className="flex items-center gap-2 min-w-0">
        <span
          className="shrink-0 inline-flex items-center justify-center"
          style={{
            width: 22,
            height: 22,
            borderRadius: 6,
            background: 'rgba(46,92,255,0.10)',
            color: 'var(--accent)',
          }}
        >
          <WIcon name="droplet" size={11} />
        </span>
        <span className="text-[12.5px] truncate">{r.site}</span>
      </span>
    ),
  },
  {
    key: 'driver',
    label: 'Driver',
    width: '1.3fr',
    render: (r) => (
      <span className="flex items-center gap-2 min-w-0">
        {r.driver === 'Unassigned'
          ? <span className="text-[12.5px] text-[var(--text-tertiary)]">Unassigned</span>
          : (
            <>
              <Avatar name={r.driver} size={20} />
              <span className="text-[12.5px] truncate">{r.driver}</span>
            </>
          )}
      </span>
    ),
  },
  {
    key: 'truck',
    label: 'Truck',
    width: '80px',
    render: (r) => <span className="num text-[12.5px]">{r.truck}</span>,
  },
  {
    key: 'gallons',
    label: 'Gallons',
    width: '80px',
    align: 'right',
    render: (r) => <span className="num text-[12.5px]">{r.gallons.toFixed(1)}</span>,
  },
  {
    key: 'ppg',
    label: '$/gal',
    width: '80px',
    align: 'right',
    render: (r) => <span className="num text-[12.5px] text-[var(--text-secondary)]">${r.ppg.toFixed(3)}</span>,
  },
  {
    key: 'total',
    label: 'Total',
    width: '90px',
    align: 'right',
    render: (r) => <span className="num text-[12.5px] font-semibold">{r.total}</span>,
  },
];

const siteColumns: DSMiniColumn<SiteRow>[] = [
  {
    key: 'site',
    label: 'Site',
    width: '1.6fr',
    render: (r) => (
      <span className="flex items-center gap-2 min-w-0">
        <span
          className="shrink-0 inline-flex items-center justify-center"
          style={{
            width: 22,
            height: 22,
            borderRadius: 6,
            background: 'var(--bg-surface-2)',
            color: 'var(--text-tertiary)',
          }}
        >
          <WIcon name="map" size={12} />
        </span>
        <span className="text-[12.5px] font-medium truncate">{r.site}</span>
      </span>
    ),
  },
  {
    key: 'state',
    label: 'State',
    width: '80px',
    render: (r) => <span className="num text-[12.5px]">{r.state}</span>,
  },
  {
    key: 'visits',
    label: 'Visits',
    width: '100px',
    align: 'right',
    render: (r) =>
      r.visits > 0
        ? <span className="num text-[12.5px] font-medium">{r.visits}</span>
        : <span className="text-[11.5px] text-[var(--text-tertiary)]">—</span>,
  },
  {
    key: 'ppg',
    label: 'Avg $/gal',
    width: '110px',
    align: 'right',
    render: (r) =>
      r.ppg > 0
        ? <span className="num text-[12.5px] text-[var(--text-secondary)]">${r.ppg.toFixed(3)}</span>
        : <span className="text-[11.5px] text-[var(--text-tertiary)]">—</span>,
  },
];
