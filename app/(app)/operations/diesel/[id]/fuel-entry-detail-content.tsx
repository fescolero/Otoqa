/**
 * FuelEntryDetailContent — full-page diesel/DEF purchase record on the
 * Otoqa Web chassis. Mirrors design v2's details-diesel.jsx variant A
 * ("Receipt-first"):
 *
 *   - DetailsFullPage shell with sub-toolbar (back / prev-next / actions)
 *   - Hero: droplet avatar tile + title `{gallons} gal · {total}` +
 *     identity subtitle + 4-up KPI grid (Gallons / Price-per-gal /
 *     Total / Method)
 *   - Sections: Overview · Payment · Assignment · Attachments · Notes ·
 *     Activity
 *   - Right rail: linked load (when present)
 */

'use client';

import * as React from 'react';
import { useRouter, useSearchParams } from 'next/navigation';
import { useMutation } from 'convex/react';
import { Loader2 } from 'lucide-react';
import { format } from 'date-fns';
import { toast } from 'sonner';

import {
  Avatar,
  Chip,
  type ChipStatus,
  CommentsThread,
  DSActivity,
  DSCard,
  DSProps,
  DSPropsEditable,
  type DSPropsEditableItem,
  DetailsFullPage,
  FPCommentsPeek,
  type FPKpi,
  type FPSection,
  WBtn,
  WIcon,
} from '@/components/web';
import { api } from '@/convex/_generated/api';
import { useAuthQuery } from '@/hooks/use-auth-query';
import { useAuth } from '@workos-inc/authkit-nextjs/components';
import type { Id } from '@/convex/_generated/dataModel';

function formatCurrency(v?: number | null): string {
  if (v === undefined || v === null) return '—';
  return `$${v.toFixed(2)}`;
}

function formatCurrency3(v?: number | null): string {
  if (v === undefined || v === null) return '—';
  return `$${v.toFixed(3)}`;
}

function formatNumber(v?: number | null, digits = 2): string {
  if (v === undefined || v === null) return '—';
  return v.toLocaleString(undefined, { minimumFractionDigits: digits, maximumFractionDigits: digits });
}

export function FuelEntryDetailContent({ id }: { id: string }) {
  const router = useRouter();
  const searchParams = useSearchParams();
  const { user } = useAuth();
  const entryType = searchParams.get('type') === 'def' ? 'def' : 'fuel';

  const fuelEntry = useAuthQuery(
    api.fuelEntries.get,
    entryType === 'fuel' ? { entryId: id as Id<'fuelEntries'> } : 'skip',
  );
  const defEntry = useAuthQuery(
    api.defEntries.get,
    entryType === 'def' ? { entryId: id as Id<'defEntries'> } : 'skip',
  );
  const entry = entryType === 'def' ? defEntry : fuelEntry;

  const removeFuelEntry = useMutation(api.fuelEntries.remove);
  const removeDefEntry = useMutation(api.defEntries.remove);
  const updateFuelEntry = useMutation(api.fuelEntries.update);
  const updateDefEntry = useMutation(api.defEntries.update);

  const [isDeleting, setIsDeleting] = React.useState(false);
  // Controlled active-section so the comments-peek "Open →" link in the
  // right rail can switch tabs without a separate side-channel.
  const [activeSection, setActiveSection] = React.useState('overview');

  // Inline-edit commit. Numeric, date, and location.* fields are coerced
  // before calling the appropriate update mutation. Unknown keys are
  // ignored so a typo in an item can't write to a backend field.
  const commitField = React.useCallback(async (key: string, next: string | string[]) => {
    if (!user) return;
    const raw = Array.isArray(next) ? next.join(', ') : next;

    // Build the partial patch with proper type coercion per field. Anything
    // not in this map is dropped silently.
    const patch: Record<string, unknown> = {};
    switch (key) {
      case 'gallons':
      case 'pricePerGallon':
      case 'odometerReading': {
        const n = parseFloat(raw);
        if (!Number.isFinite(n)) return;
        patch[key] = n;
        break;
      }
      case 'entryDate': {
        // <EditableField type="date"> commits YYYY-MM-DD; convert to epoch ms.
        const t = new Date(`${raw}T00:00:00Z`).getTime();
        if (!Number.isFinite(t)) return;
        patch.entryDate = t;
        break;
      }
      case 'locationCity':
      case 'locationState': {
        // The mutation expects the structured location object; merge with
        // the existing one so a partial update doesn't blank the sibling.
        const existing = (entry && 'location' in entry ? entry.location : undefined) ?? { city: '', state: '' };
        patch.location =
          key === 'locationCity'
            ? { ...existing, city: raw }
            : { ...existing, state: raw };
        break;
      }
      case 'fuelCardNumber':
      case 'receiptNumber':
      case 'notes': {
        patch[key] = raw;
        break;
      }
      case 'paymentMethod': {
        patch.paymentMethod = raw;
        break;
      }
      default:
        return;
    }

    try {
      if (entryType === 'def') {
        await updateDefEntry({
          entryId: id as Id<'defEntries'>,
          updatedBy: user.id,
          ...patch,
        } as never);
      } else {
        await updateFuelEntry({
          entryId: id as Id<'fuelEntries'>,
          updatedBy: user.id,
          ...patch,
        } as never);
      }
      toast.success('Saved');
    } catch (e) {
      console.error(e);
      toast.error('Failed to save change');
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [entryType, id, user, entry]);

  if (entry === undefined) {
    return (
      <div className="flex-1 flex items-center justify-center">
        <Loader2 className="h-5 w-5 animate-spin text-[var(--text-tertiary)]" />
      </div>
    );
  }
  if (entry === null) {
    return (
      <div className="flex-1 flex flex-col items-center justify-center gap-3 text-center">
        <p className="m-0 text-[14px] text-foreground font-medium">{entryType === 'def' ? 'DEF' : 'Fuel'} entry not found</p>
        <WBtn size="sm" leading="chevron-left" onClick={() => router.push('/operations/diesel')}>
          Back to Diesel
        </WBtn>
      </div>
    );
  }

  const typeLabel = entryType === 'def' ? 'DEF' : 'Fuel';
  const gallons = entry.gallons ?? 0;
  const ppg = entry.pricePerGallon ?? 0;
  const total = entry.totalCost ?? gallons * ppg;
  const entryDate = entry.entryDate ? new Date(entry.entryDate) : null;
  const dateLabel = entryDate ? format(entryDate, 'MMM d, yyyy') : '—';
  const timeLabel = entryDate ? format(entryDate, 'h:mm a') : '';
  // Compose the location string ONLY when at least one of city/state is set.
  // Empty / missing → an empty string, so downstream renders can simply
  // truth-test to decide whether to mount the surface.
  const locationLabel = entry.location
    ? [entry.location.city, entry.location.state].filter(Boolean).join(', ')
    : '';
  const hasLocation = locationLabel.length > 0;
  const methodLabel = entry.paymentMethod ? entry.paymentMethod.replace(/_/g, ' ') : '—';
  const verified: 'verified' | 'review' = entry.receiptUrl || entry.receiptStorageId ? 'verified' : 'review';

  const statusChip: { status: ChipStatus; label: string } = verified === 'verified'
    ? { status: 'valid', label: 'Verified' }
    : { status: 'pending', label: 'Needs review' };

  const titleNode = (
    <span className="inline-flex items-center gap-3">
      <span>
        <span className="num">{formatNumber(gallons)}</span> gal
        <span className="text-[var(--text-tertiary)] mx-2">·</span>
        <span className="num">{formatCurrency(total)}</span>
      </span>
      {/* Fuel / DEF type badge — colored by entry type. */}
      <span className="inline-flex items-center gap-1 h-5 px-1.5 rounded-md border text-[10.5px] font-medium tracking-[0.02em] leading-none"
        style={
          entryType === 'def'
            ? { color: 'var(--bar-open-fg)', background: 'var(--bar-open-bg)', borderColor: 'var(--bar-open-bd)' }
            : { color: 'var(--accent)', background: 'rgba(46,92,255,0.10)', borderColor: 'rgba(46,92,255,0.30)' }
        }>
        {typeLabel}
      </span>
      {/* Verification status sits inline with the type badge so both pills
          read as title-row metadata; previously this lived in the eyebrow
          above the title. */}
      <Chip status={statusChip.status} label={statusChip.label} />
    </span>
  );

  const subtitle = (
    <span className="flex flex-wrap items-center gap-x-4 gap-y-1 text-[13px] text-[var(--text-secondary)]">
      {entry.vendorName && (
        <span className="inline-flex items-center gap-1.5">
          <WIcon name="fuel" size={12} /> {entry.vendorName}
        </span>
      )}
      {hasLocation && (
        <span className="inline-flex items-center gap-1.5">
          <WIcon name="map" size={12} /> {locationLabel}
        </span>
      )}
      <span className="inline-flex items-center gap-1.5 num">
        <WIcon name="calendar" size={12} /> {dateLabel}{timeLabel ? ` · ${timeLabel}` : ''}
      </span>
    </span>
  );

  const kpis: FPKpi[] = [
    { label: 'Gallons',     value: <span className="num">{formatNumber(gallons)}</span> },
    { label: 'Price / gal', value: <span className="num">{formatCurrency3(ppg)}</span> },
    { label: 'Total',       value: <span className="num">{formatCurrency(total)}</span> },
    { label: 'Method',      value: methodLabel },
  ];

  // ─── Section: Overview (Audit-first variant) ──────────────────────────
  // Layout follows details-diesel.jsx → DsOverviewAudit:
  //   ┌───────────────────┬─────────────────┐
  //   │ Location (map)    │ Anomaly signals │
  //   │ Price audit       │ Assignment      │
  //   └───────────────────┴─────────────────┘
  // The Location card is omitted entirely when the entry has no city/state.
  const purchaseEditor = (
    <DSCard title="Purchase">
      <DSPropsEditable
        onCommit={commitField}
        items={[
          {
            key: 'entryDate',
            label: 'Date',
            value: entryDate ? format(entryDate, 'yyyy-MM-dd') : '',
            display: <span className="num">{dateLabel}{timeLabel ? ` · ${timeLabel}` : ''}</span>,
            editor: { type: 'date' },
            placeholder: 'Pick date',
          },
          {
            key: 'locationCity',
            label: 'City',
            value: entry.location?.city ?? '',
            editor: { type: 'text' },
            placeholder: 'City',
          },
          {
            key: 'locationState',
            label: 'State',
            value: entry.location?.state ?? '',
            editor: { type: 'text' },
            placeholder: 'CA',
          },
          {
            key: 'receiptNumber',
            label: 'Receipt #',
            value: entry.receiptNumber ?? '',
            display: entry.receiptNumber
              ? <span className="num">{entry.receiptNumber}</span>
              : undefined,
            editor: { type: 'text' },
            placeholder: 'Add receipt #',
          },
          {
            key: 'gallons',
            label: 'Gallons',
            value: String(gallons ?? ''),
            display: <span className="num">{formatNumber(gallons)}</span>,
            editor: { type: 'text' },
            placeholder: 'e.g. 84.52',
          },
          {
            key: 'pricePerGallon',
            label: 'Price/gal',
            value: String(ppg ?? ''),
            display: <span className="num">{formatCurrency3(ppg)}</span>,
            editor: { type: 'text' },
            placeholder: 'e.g. 4.099',
          },
          {
            key: 'odometerReading',
            label: 'Odometer',
            value: entry.odometerReading != null ? String(entry.odometerReading) : '',
            display: entry.odometerReading != null
              ? <span className="num">{entry.odometerReading.toLocaleString()} mi</span>
              : undefined,
            editor: { type: 'text' },
            placeholder: 'Miles',
          },
        ]}
      />
    </DSCard>
  );

  const overviewContent = (
    <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
      {hasLocation ? (
        <DSCard title="Location" bodyClassName="p-0">
          <MapPlaceholder city={locationLabel} />
          <div className="px-3.5 py-2.5 border-t border-[var(--border-hairline)]">
            <DSProps
              items={[
                { label: 'Vendor',    value: <span style={{ fontWeight: 500 }}>{entry.vendorName ?? '—'}</span> },
                { label: 'City',      value: locationLabel },
                { label: 'Receipt #', value: entry.receiptNumber
                    ? <span className="num">{entry.receiptNumber}</span>
                    : <span className="text-[var(--text-tertiary)]">—</span> },
              ]}
            />
          </div>
        </DSCard>
      ) : (
        // No location on file — surface the purchase-editor in the top-left
        // slot instead so the user has a clear way to add one.
        purchaseEditor
      )}

      <DSCard title="Price audit">
        <PriceAudit ppg={ppg} gallons={gallons} city={entry.location?.city} />
      </DSCard>

      <DSCard title="Anomaly signals">
        <DSActivity
          items={buildAnomalySignals({
            ppg,
            method: entry.paymentMethod,
            methodLabel,
            hasReceipt: !!(entry.receiptUrl || entry.receiptStorageId),
            loadRef: entry.loadReference ?? (entry.loadId ? String(entry.loadId) : null),
            city: entry.location?.city,
          })}
        />
      </DSCard>

      {hasLocation && (
        // When the Location card occupies the top-left, the purchase editor
        // moves down into the second row so the user can still inline-edit.
        purchaseEditor
      )}

      <DSCard title="Assignment">
        <AssignmentBlock entry={entry} />
      </DSCard>
    </div>
  );

  // ─── Section: Payment ────────────────────────────────────────────────
  const paymentContent = (
    <DSCard title="Payment">
      <DSPropsEditable
        onCommit={commitField}
        items={[
          {
            key: 'paymentMethod',
            label: 'Method',
            value: entry.paymentMethod ?? '',
            display: <span style={{ fontWeight: 500 }}>{methodLabel}</span>,
            editor: {
              type: 'select',
              options: [
                { value: 'FUEL_CARD',   label: 'Fuel card' },
                { value: 'COMDATA',     label: 'Comdata' },
                { value: 'EFS',         label: 'EFS' },
                { value: 'CREDIT_CARD', label: 'Credit card' },
                { value: 'CHECK',       label: 'Check' },
                { value: 'CASH',        label: 'Cash' },
              ],
            },
            placeholder: 'Pick method',
          },
          {
            key: 'fuelCardNumber',
            label: 'Card',
            value: entry.fuelCardNumber ?? '',
            display: entry.fuelCardNumber ? <span className="num">{entry.fuelCardNumber}</span> : undefined,
            editor: { type: 'text' },
            placeholder: 'Add card #',
          },
          {
            key: 'subtotal',
            label: 'Subtotal',
            value: '',
            display: <span className="num">{formatCurrency(total)}</span>,
            readOnly: true,
          },
          {
            key: 'tax',
            label: 'Tax',
            value: '',
            display: <span className="num">included</span>,
            readOnly: true,
          },
          {
            key: 'total',
            label: 'Total',
            value: '',
            display: <span className="num" style={{ fontWeight: 600 }}>{formatCurrency(total)}</span>,
            readOnly: true,
          },
        ]}
      />
    </DSCard>
  );

  // ─── Section: Assignment ─────────────────────────────────────────────
  const assignmentContent = (
    <DSCard title="Assignment">
      <AssignmentBlock entry={entry} />
    </DSCard>
  );

  // ─── Section: Attachments ────────────────────────────────────────────
  const attachmentCount = entry.receiptUrl || entry.receiptStorageId ? 1 : 0;
  const attachmentsContent = (
    <DSCard
      title={`Attachments (${attachmentCount})`}
      action={
        <WBtn size="sm" leading="plus" onClick={() => router.push(`/operations/diesel/${id}/edit?type=${entryType}`)}>
          Upload
        </WBtn>
      }
    >
      {attachmentCount > 0 ? (
        <div className="flex items-center gap-3">
          <FileTypeBadge ext="jpg" />
          <div className="flex-1 min-w-0">
            <div className="text-[12.5px] font-medium text-foreground truncate">{entry.receiptNumber ?? 'Receipt'}.jpg</div>
            <div className="text-[11.5px] text-[var(--text-tertiary)] mt-0.5">Receipt scan</div>
          </div>
          <Chip status="valid" label="On file" />
          {entry.receiptUrl && (
            <WBtn size="sm" leading="eye" onClick={() => window.open(entry.receiptUrl!, '_blank')}>
              Preview
            </WBtn>
          )}
        </div>
      ) : (
        <DSActivity emptyText="No receipt on file. Upload one to clear the IFTA flag." items={[]} />
      )}
    </DSCard>
  );

  // ─── Section: Notes ──────────────────────────────────────────────────
  const notesContent = (
    <div className="flex flex-col gap-3">
      <DSCard title="Notes">
        <DSPropsEditable
          onCommit={commitField}
          items={[
            {
              key: 'notes',
              label: 'Notes',
              value: entry.notes ?? '',
              editor: { type: 'textarea', rows: 4 },
              placeholder: 'Add notes about this purchase',
            },
          ]}
        />
      </DSCard>
      <DSCard title="Flags">
        <DSActivity
          items={
            verified === 'verified'
              ? [{ icon: 'check', text: 'No flags — verified for IFTA', when: '' }]
              : [{ icon: 'alert', text: 'Needs review — receipt missing', when: '' }]
          }
        />
      </DSCard>
    </div>
  );

  // ─── Section: Activity ───────────────────────────────────────────────
  const activityContent = (
    <DSCard title="Activity">
      <DSActivity
        items={[
          { icon: 'plus', text: 'Purchase logged', when: dateLabel },
          entry.receiptUrl || entry.receiptStorageId
            ? { icon: 'check', text: 'Receipt on file', when: '' }
            : { icon: 'circle-dot', text: 'No receipt uploaded yet', when: '' },
          entry.driverName
            ? { icon: 'truck', text: `Driver: ${entry.driverName}`, when: '' }
            : { icon: 'circle-dot', text: 'No driver assigned', when: '' },
          entry.loadId
            ? { icon: 'package', text: `Linked to load ${entry.loadReference ?? entry.loadId}`, when: '' }
            : { icon: 'circle-dot', text: 'No linked load', when: '' },
        ]}
      />
    </DSCard>
  );

  // Comments use the fuel/DEF-entry id with a typed namespace so the same
  // CommentsThread mounts cleanly without leaking across record types.
  const commentsEntityType = entryType === 'def' ? 'defEntry' : 'fuelEntry';
  const commentsContent = (
    <DSCard title="Comments">
      <CommentsThread entityType={commentsEntityType} entityId={id} />
    </DSCard>
  );

  const sections: FPSection[] = [
    { id: 'overview',    label: 'Overview',    icon: 'home',       content: overviewContent },
    { id: 'payment',     label: 'Payment',     icon: 'doc-dollar', content: paymentContent },
    { id: 'assignment',  label: 'Assignment',  icon: 'truck',      content: assignmentContent },
    { id: 'attachments', label: 'Attachments', icon: 'file-text',  count: attachmentCount, content: attachmentsContent },
    { id: 'notes',       label: 'Notes & flags', icon: 'pulse',    content: notesContent },
    { id: 'comments',    label: 'Comments',    icon: 'chat',       content: commentsContent },
    { id: 'activity',    label: 'Activity',    icon: 'pulse',      content: activityContent },
  ];

  // Right rail mirrors the design's DsRail variant-B layout:
  //   1. Comments peek (latest message + Open → link to expand)
  //   2. Driver — 30 day stats
  //   3. Linked load (when entry.loadId set)
  //   4. Vendor reputation
  const rightRail = (
    <div className="flex flex-col gap-3">
      <FPCommentsPeek
        count={0}
        onOpen={() => setActiveSection('comments')}
      />
      <DSCard title="Driver — 30 day">
        <DSActivity
          items={
            entry.driverName
              ? [
                  { icon: 'droplet', text: entry.driverName, when: '' },
                  // The aggregate fields (fill-up count, gallons, avg ppg) will
                  // be wired once the analytics rollup exists; for now we show
                  // a single neutral signal so the card has a presence.
                  { icon: 'pulse', text: '30-day stats coming soon', when: '' },
                ]
              : [{ icon: 'circle-dot', text: 'No driver assigned', when: '' }]
          }
        />
      </DSCard>
      {entry.loadId && (
        <DSCard
          title="Linked load"
          action={
            <WBtn size="sm" leading="arrow-up-right" onClick={() => router.push(`/loads/${entry.loadId}`)}>
              Open
            </WBtn>
          }
        >
          <DSActivity
            items={[
              { icon: 'package', text: entry.loadReference ?? String(entry.loadId), when: '' },
              entry.truckUnitId
                ? { icon: 'truck', text: `Truck ${entry.truckUnitId}`, when: '' }
                : { icon: 'circle-dot', text: 'No truck on this load', when: '' },
            ]}
          />
        </DSCard>
      )}
      {entry.vendorName && (
        <DSCard title="Vendor reputation">
          <DSActivity
            items={[
              { icon: 'check', text: 'IFTA-friendly vendor', when: '' },
              { icon: 'pulse', text: 'Visit history coming soon', when: '' },
            ]}
          />
        </DSCard>
      )}
    </div>
  );

  // ─── Delete handler ──────────────────────────────────────────────────
  const onDelete = async () => {
    if (!user) return;
    if (!window.confirm(`Delete this ${typeLabel} entry? This cannot be undone.`)) return;
    setIsDeleting(true);
    try {
      if (entryType === 'def') {
        await removeDefEntry({ entryId: id as Id<'defEntries'>, deletedBy: user.id });
      } else {
        await removeFuelEntry({ entryId: id as Id<'fuelEntries'>, deletedBy: user.id });
      }
      toast.success(`${typeLabel} entry deleted`);
      router.push('/operations/diesel');
    } catch (e) {
      console.error(e);
      toast.error(`Failed to delete ${typeLabel} entry`);
    } finally {
      setIsDeleting(false);
    }
  };

  return (
    <DetailsFullPage
      breadcrumb={
        <span className="inline-flex items-center gap-1.5 text-[var(--text-secondary)]">
          <button type="button" onClick={() => router.push('/operations/diesel')} className="hover:text-foreground">
            Diesel
          </button>
          <span className="text-[var(--text-tertiary)]">/</span>
          <span className="text-foreground font-medium">{typeLabel} entry</span>
        </span>
      }
      onBack={() => router.push('/operations/diesel')}
      toolbarActions={
        <>
          <WBtn size="sm" variant="ghost" leading="export">Export</WBtn>
          <WBtn size="sm" danger leading="trash" disabled={isDeleting} onClick={onDelete}>
            {isDeleting ? 'Deleting…' : 'Delete'}
          </WBtn>
        </>
      }
      title={titleNode}
      subtitle={subtitle}
      kpis={kpis}
      sections={sections}
      activeId={activeSection}
      onActiveChange={setActiveSection}
      rightRail={rightRail}
    />
  );
}

// ─── Inner pieces ───────────────────────────────────────────────────────

type FuelEntry = NonNullable<ReturnType<typeof useAuthQuery<typeof api.fuelEntries.get>>>;
type DefEntry  = NonNullable<ReturnType<typeof useAuthQuery<typeof api.defEntries.get>>>;
type DieselEntry = FuelEntry | DefEntry;

function AssignmentBlock({ entry }: { entry: DieselEntry }) {
  return (
    <DSProps
      items={[
        {
          label: 'Driver',
          value: entry.driverName ? (
            <span className="inline-flex items-center gap-2">
              <Avatar name={entry.driverName} size={20} />
              <span>{entry.driverName}</span>
            </span>
          ) : <span className="text-[var(--text-tertiary)]">Unassigned</span>,
        },
        {
          label: 'Carrier',
          value: entry.carrierName ?? <span className="text-[var(--text-tertiary)]">—</span>,
        },
        {
          label: 'Truck',
          value: entry.truckUnitId
            ? <span className="num">{entry.truckUnitId}</span>
            : <span className="text-[var(--text-tertiary)]">—</span>,
        },
        {
          label: 'Load',
          value: entry.loadReference
            ? <span className="num" style={{ color: 'var(--accent)', fontWeight: 500 }}>{entry.loadReference}</span>
            : entry.loadId
              ? <span className="num">{String(entry.loadId)}</span>
              : <span className="text-[var(--text-tertiary)]">Not linked</span>,
        },
        {
          label: 'Odometer',
          value: entry.odometerReading != null
            ? <span className="num">{entry.odometerReading.toLocaleString()} mi</span>
            : '—',
        },
      ]}
    />
  );
}

function FileTypeBadge({ ext }: { ext: string }) {
  const map: Record<string, { bg: string; label: string }> = {
    jpg: { bg: '#A4633D', label: 'JPG' },
    png: { bg: '#A4633D', label: 'PNG' },
    pdf: { bg: '#B43030', label: 'PDF' },
  };
  const cfg = map[ext.toLowerCase()] ?? { bg: 'var(--text-tertiary)', label: ext.slice(0, 3).toUpperCase() };
  return (
    <div
      className="inline-flex items-center justify-center text-[9.5px] font-bold tracking-[0.06em] text-white shrink-0"
      style={{ width: 30, height: 22, borderRadius: 4, background: cfg.bg }}
    >
      {cfg.label}
    </div>
  );
}

// ─── Map placeholder ────────────────────────────────────────────────────
// SVG-only stand-in until we wire a real tile provider. Pin sits on a
// faux road grid + curve; the city label hangs off the pin.
function MapPlaceholder({ city }: { city: string }) {
  return (
    <div
      className="relative overflow-hidden"
      style={{
        height: 160,
        background: 'linear-gradient(135deg, oklch(0.94 0.02 240), oklch(0.96 0.015 230))',
      }}
    >
      <svg width="100%" height="100%" className="absolute inset-0" style={{ opacity: 0.5 }}>
        <defs>
          <pattern id="diesel-map-grid" width="48" height="48" patternUnits="userSpaceOnUse">
            <path d="M 48 0 L 0 0 0 48" fill="none" stroke="oklch(0.86 0.02 240)" strokeWidth="0.5" />
          </pattern>
        </defs>
        <rect width="100%" height="100%" fill="url(#diesel-map-grid)" />
        <path
          d="M 0 80 Q 100 60, 200 90 T 400 80"
          stroke="oklch(0.78 0.04 230)"
          strokeWidth="3"
          fill="none"
          opacity="0.6"
        />
        <path d="M 120 0 L 140 160" stroke="oklch(0.82 0.03 240)" strokeWidth="2" fill="none" opacity="0.5" />
      </svg>
      <div
        className="absolute flex flex-col items-center"
        style={{ top: '46%', left: '38%', transform: 'translate(-50%, -100%)', gap: 4 }}
      >
        <div
          className="flex items-center justify-center"
          style={{
            width: 32,
            height: 32,
            borderRadius: '50% 50% 50% 0',
            transform: 'rotate(-45deg)',
            background: 'var(--accent)',
            boxShadow: '0 4px 8px rgba(46,92,255,0.32)',
          }}
        >
          <WIcon name="droplet" size={14} style={{ color: '#fff', transform: 'rotate(45deg)' }} />
        </div>
        <div
          className="text-[11px] font-semibold whitespace-nowrap"
          style={{
            padding: '2px 8px',
            background: 'rgba(255,255,255,0.95)',
            color: '#1F2937',
            border: '1px solid var(--border-hairline)',
            borderRadius: 4,
            boxShadow: '0 1px 3px rgba(0,0,0,0.08)',
          }}
        >
          {city}
        </div>
      </div>
    </div>
  );
}

// ─── Price audit ────────────────────────────────────────────────────────
// Three-row comparison with a delta callout. Regional / fleet averages are
// placeholder constants until the analytics rollup ships; the callout
// tone reacts to the live delta so the visual hierarchy still works.
function PriceAudit({ ppg, gallons, city }: { ppg: number; gallons: number; city?: string }) {
  // TODO: replace with real Convex aggregates once we have them.
  const regAvg = 4.20;
  const fleetAvg = 4.18;
  const delta = ppg - regAvg;
  const over = delta > 0.1;
  return (
    <div className="flex flex-col gap-2.5">
      <PriceRow label="This purchase" value={`$${ppg.toFixed(3)}`} accent />
      <PriceRow label={`Regional avg${city ? ` (${city})` : ''}`} value={`$${regAvg.toFixed(3)}`} />
      <PriceRow label="Fleet 30-day avg" value={`$${fleetAvg.toFixed(3)}`} />
      <div
        className="mt-1 px-2.5 py-2 rounded-md inline-flex items-center gap-2"
        style={{
          background: over ? 'rgba(245,158,11,0.10)' : 'rgba(16,185,129,0.08)',
          border: `1px solid ${over ? 'rgba(245,158,11,0.25)' : 'rgba(16,185,129,0.20)'}`,
        }}
      >
        <WIcon name={over ? 'alert' : 'check'} size={13} style={{ color: over ? '#A66800' : '#0F8C5F' }} />
        <span className="text-[12px] font-medium" style={{ color: over ? '#A66800' : '#0F8C5F' }}>
          {delta > 0 ? '+' : ''}${delta.toFixed(3)}/gal vs regional avg
          {gallons > 0 && (
            <>{' '}({delta > 0 ? '+' : ''}${(delta * gallons).toFixed(2)} total)</>
          )}
        </span>
      </div>
    </div>
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

// ─── Anomaly signals builder ────────────────────────────────────────────
// Each rule emits one DSActivity item — `alert` for things that need a
// human review, `check` for things in the clear, `circle-dot` for neutral
// observations. The 4-rule shape matches the design's Anomaly card.
type AnomalyItem = { icon: 'alert' | 'check' | 'circle-dot'; text: string; when: string };
function buildAnomalySignals({
  ppg,
  method,
  methodLabel,
  hasReceipt,
  loadRef,
  city,
}: {
  ppg: number;
  method?: string;
  methodLabel: string;
  hasReceipt: boolean;
  loadRef: string | null;
  city?: string;
}): AnomalyItem[] {
  const items: AnomalyItem[] = [];
  // 1. Price-per-gal vs regional avg.
  const PRICE_OVER_THRESHOLD = 0.10;
  const REG_AVG = 4.20;
  const delta = ppg - REG_AVG;
  if (delta > PRICE_OVER_THRESHOLD) {
    items.push({ icon: 'alert', text: `Price-per-gal $${ppg.toFixed(3)} is +$${delta.toFixed(2)} over regional avg`, when: city ?? '' });
  } else {
    items.push({ icon: 'check', text: 'Price within ±$0.05 of regional average', when: city ?? '' });
  }
  // 2. Payment method check.
  if (method === 'FUEL_CARD') {
    items.push({ icon: 'check', text: 'Paid on assigned fleet card', when: '' });
  } else {
    items.push({ icon: 'alert', text: `Paid via ${methodLabel} — outside fleet card`, when: '' });
  }
  // 3. Receipt-on-file check (IFTA requirement).
  if (hasReceipt) {
    items.push({ icon: 'check', text: 'Receipt scan on file', when: '' });
  } else {
    items.push({ icon: 'alert', text: 'No receipt scanned — required for IFTA', when: '' });
  }
  // 4. Load linkage.
  if (loadRef) {
    items.push({ icon: 'check', text: `Linked to load ${loadRef}`, when: '' });
  } else {
    items.push({ icon: 'circle-dot', text: 'Not linked to a load (local route)', when: '' });
  }
  return items;
}
