'use client';

/**
 * Contract-lane detail — read-only view of one contract lane on the
 * Otoqa Web chassis. Mirrors design v2's ContractDetailView
 * (details-customer.jsx): sub-toolbar with back + breadcrumb + explicit
 * Edit button (no inline editing — prevents accidental changes when
 * someone just wants to look), hero with contract name + status chip,
 * and a two-column DSCard grid:
 *
 *   left  — Contract information · Lane details (stop cards) ·
 *           Equipment requirements
 *   right — Rate information · Operating schedule (day circles)
 */

import * as React from 'react';
import { useRouter, useParams } from 'next/navigation';
import { useAuth } from '@workos-inc/authkit-nextjs/components';
import { useQuery, useMutation } from 'convex/react';
import { Loader2 } from 'lucide-react';
import { toast } from 'sonner';

import { Chip, DSCard, DSProps, WBtn, WIcon } from '@/components/web';
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '@/components/ui/alert-dialog';
import { api } from '@/convex/_generated/api';
import type { Id } from '@/convex/_generated/dataModel';

const DAY_ABBR = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const DAY_LETTERS = ['S', 'M', 'T', 'W', 'T', 'F', 'S'];

const APPT_LABELS: Record<string, string> = {
  APPT: 'Appointment',
  FCFS: 'First come, first served',
  Live: 'Live',
};

function formatDate(s?: string | null): string {
  if (!s) return '—';
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(s);
  if (!m) return s;
  const d = new Date(Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3])));
  return d.toLocaleDateString('en-US', {
    month: 'short',
    day: '2-digit',
    year: 'numeric',
    timeZone: 'UTC',
  });
}

/** "07:45" → "07:45 AM"; passes anything unparseable through. */
function formatTime(t?: string): string {
  if (!t) return '—';
  const m = /^(\d{1,2}):(\d{2})$/.exec(t);
  if (!m) return t;
  const h = Number(m[1]);
  const ampm = h >= 12 ? 'PM' : 'AM';
  const h12 = h % 12 === 0 ? 12 : h % 12;
  return `${String(h12).padStart(2, '0')}:${m[2]} ${ampm}`;
}

type LaneStop = {
  address: string;
  city: string;
  state: string;
  zip: string;
  stopOrder: number;
  stopType: 'Pickup' | 'Delivery';
  type: 'APPT' | 'FCFS' | 'Live';
  arrivalTime: string;
  nassCode?: string;
};

function laneSummary(stops: LaneStop[]): string {
  const cities = stops.map((s) => s.city).filter(Boolean);
  if (cities.length === 0) return 'Contract lane';
  return cities.join(' → ');
}

function ContractStopRow({ s }: { s: LaneStop }) {
  const isPickup = s.stopType === 'Pickup';
  const tone = isPickup
    ? { bg: 'rgba(46,92,255,0.10)', fg: 'var(--accent)' }
    : { bg: '#DBEFE3', fg: '#0F8C5F' };
  return (
    <div
      style={{
        border: '1px solid var(--border-hairline)',
        borderRadius: 8,
        background: 'var(--bg-surface-2)',
        padding: 12,
      }}
    >
      <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 10 }}>
        <span
          className="num"
          style={{
            width: 22,
            height: 22,
            borderRadius: '50%',
            flexShrink: 0,
            background: tone.bg,
            color: tone.fg,
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            fontSize: 11,
            fontWeight: 700,
          }}
        >
          {s.stopOrder}
        </span>
        <span style={{ fontSize: 13, fontWeight: 600 }}>
          {s.city ? `${s.city}, ${s.state}` : `Stop ${s.stopOrder}`}
        </span>
        <span style={{ flex: 1 }} />
        <span
          style={{
            display: 'inline-flex',
            alignItems: 'center',
            padding: '2px 8px',
            borderRadius: 6,
            background: tone.bg,
            color: tone.fg,
            fontSize: 10.5,
            fontWeight: 600,
            textTransform: 'uppercase',
            letterSpacing: 0.04,
          }}
        >
          {s.stopType}
        </span>
      </div>
      <div
        style={{
          display: 'grid',
          gridTemplateColumns: '90px 1fr',
          columnGap: 12,
          rowGap: 6,
          fontSize: 12.5,
        }}
      >
        <span style={{ color: 'var(--text-tertiary)' }}>Address</span>
        <span style={{ color: 'var(--text-primary)' }}>
          {[s.address, s.city, s.state, s.zip].filter(Boolean).join(', ') || '—'}
        </span>
        <span style={{ color: 'var(--text-tertiary)' }}>Appointment</span>
        <span style={{ color: 'var(--text-primary)' }}>
          {APPT_LABELS[s.type] ?? s.type}
        </span>
        <span style={{ color: 'var(--text-tertiary)' }}>Time</span>
        <span style={{ color: 'var(--text-primary)' }} className="num">
          {formatTime(s.arrivalTime)}
        </span>
        {s.nassCode ? (
          <>
            <span style={{ color: 'var(--text-tertiary)' }}>NASS code</span>
            <span style={{ color: 'var(--text-primary)' }} className="num">
              {s.nassCode}
            </span>
          </>
        ) : null}
      </div>
    </div>
  );
}

export default function ContractLaneDetailPage() {
  const router = useRouter();
  const params = useParams();
  const customerId = params.id as Id<'customers'>;
  const laneId = params.laneId as Id<'contractLanes'>;

  const { user } = useAuth();
  const customer = useQuery(api.customers.get, { id: customerId });
  const lane = useQuery(api.contractLanes.get, { id: laneId });
  const deactivateLane = useMutation(api.contractLanes.deactivate);

  const [confirmDeleteOpen, setConfirmDeleteOpen] = React.useState(false);
  const [isDeleting, setIsDeleting] = React.useState(false);

  const handleDelete = async () => {
    if (!user) return;
    setIsDeleting(true);
    try {
      await deactivateLane({ id: laneId, userId: user.id });
      toast.success('Contract lane deleted.');
      router.push(`/operations/customers/${customerId}`);
    } catch (err) {
      console.error('Failed to delete contract lane:', err);
      toast.error('Failed to delete contract lane. Please try again.');
      setIsDeleting(false);
    }
  };

  if (customer === undefined || lane === undefined) {
    return (
      <div className="flex items-center justify-center h-screen">
        <Loader2 className="h-8 w-8 animate-spin text-muted-foreground" />
      </div>
    );
  }
  if (!customer || !lane) {
    return (
      <div className="flex items-center justify-center h-screen">
        <div className="text-center">
          <p className="text-muted-foreground mb-4">Contract lane not found</p>
          <WBtn onClick={() => router.push(`/operations/customers/${customerId}`)}>
            Back to customer
          </WBtn>
        </div>
      </div>
    );
  }

  const isActive = lane.isActive ?? true;
  const stops = (lane.stops ?? []) as LaneStop[];
  const days = lane.scheduleRule?.activeDays ?? [];
  const excludeHolidays = lane.scheduleRule?.excludeFederalHolidays ?? true;
  const customerPath = `/operations/customers/${customerId}`;

  return (
    <div
      style={{
        flex: 1,
        minHeight: 0,
        display: 'flex',
        flexDirection: 'column',
        minWidth: 0,
        background: 'var(--bg-canvas)',
      }}
    >
      {/* Sub-toolbar */}
      <div
        style={{
          flexShrink: 0,
          height: 44,
          background: 'var(--bg-surface)',
          borderBottom: '1px solid var(--border-hairline)',
          padding: '0 24px',
          display: 'flex',
          alignItems: 'center',
          gap: 12,
        }}
      >
        <button
          onClick={() => router.push(customerPath)}
          className="focus-ring"
          style={{
            display: 'flex',
            alignItems: 'center',
            gap: 6,
            padding: '0 8px 0 4px',
            height: 26,
            borderRadius: 6,
            border: 0,
            background: 'transparent',
            fontFamily: 'inherit',
            fontSize: 12,
            fontWeight: 500,
            color: 'var(--text-secondary)',
            cursor: 'pointer',
          }}
          onMouseEnter={(e) => {
            e.currentTarget.style.background = 'var(--bg-row-hover)';
          }}
          onMouseLeave={(e) => {
            e.currentTarget.style.background = 'transparent';
          }}
        >
          <WIcon name="chevron-left" size={14} /> Back to {customer.name}
        </button>
        <div style={{ width: 1, height: 16, background: 'var(--border-hairline)' }} />
        <div
          style={{
            display: 'flex',
            alignItems: 'center',
            gap: 6,
            fontSize: 11.5,
            color: 'var(--text-tertiary)',
            minWidth: 0,
          }}
        >
          <span>Customers</span>
          <WIcon name="breadcrumb-sep" size={10} color="var(--text-tertiary)" />
          <span style={{ whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
            {customer.name}
          </span>
          <WIcon name="breadcrumb-sep" size={10} color="var(--text-tertiary)" />
          <span style={{ color: 'var(--text-secondary)', fontWeight: 500, whiteSpace: 'nowrap' }}>
            {lane.contractName}
          </span>
        </div>
        <div style={{ flex: 1 }} />
        <WBtn
          size="sm"
          leading="chart-bar"
          onClick={() => router.push(`/lane-analyzer?importLane=${laneId}`)}
        >
          Analyze
        </WBtn>
        <WBtn
          size="sm"
          danger
          leading="trash"
          onClick={() => setConfirmDeleteOpen(true)}
          disabled={!user || isDeleting}
        >
          {isDeleting ? 'Deleting…' : 'Delete'}
        </WBtn>
        <WBtn
          size="sm"
          variant="primary"
          leading="edit"
          onClick={() => router.push(`${customerPath}/contract-lanes/${laneId}/edit`)}
        >
          Edit contract
        </WBtn>
      </div>

      <AlertDialog open={confirmDeleteOpen} onOpenChange={setConfirmDeleteOpen}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Delete {lane.contractName}?</AlertDialogTitle>
            <AlertDialogDescription>
              The lane is removed from {customer.name}&apos;s contracts and no new
              loads will generate from it. An admin can restore it later — nothing
              is permanently erased.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={isDeleting}>Cancel</AlertDialogCancel>
            <AlertDialogAction
              onClick={handleDelete}
              disabled={isDeleting}
              className="bg-[#B43030] text-white hover:bg-[#9c2828]"
            >
              Delete lane
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      <div className="scroll-thin" style={{ flex: 1, minHeight: 0, overflow: 'auto' }}>
        <div style={{ maxWidth: 1120, margin: '0 auto', padding: '24px 32px 48px' }}>
          {/* Hero */}
          <div style={{ marginBottom: 20 }}>
            <div
              style={{
                fontSize: 10.5,
                color: 'var(--text-tertiary)',
                marginBottom: 6,
                textTransform: 'uppercase',
                letterSpacing: 0.06,
                fontWeight: 600,
              }}
            >
              Contract lane
            </div>
            <div style={{ display: 'flex', alignItems: 'center', gap: 12, flexWrap: 'wrap' }}>
              <div
                className="num"
                style={{
                  fontSize: 30,
                  fontWeight: 600,
                  lineHeight: '36px',
                  letterSpacing: -0.02,
                  color: 'var(--text-primary)',
                }}
              >
                {lane.contractName}
              </div>
              <Chip status={isActive ? 'active' : 'inactive'} />
            </div>
            <div style={{ fontSize: 13.5, color: 'var(--text-secondary)', marginTop: 6 }}>
              {laneSummary(stops)} · {customer.name}
            </div>
          </div>

          <div
            style={{
              display: 'grid',
              gridTemplateColumns: 'minmax(0, 1.3fr) minmax(0, 1fr)',
              gap: 16,
              alignItems: 'start',
            }}
          >
            {/* Left column */}
            <div style={{ minWidth: 0, display: 'flex', flexDirection: 'column', gap: 16 }}>
              <DSCard title="Contract information">
                <DSProps
                  items={[
                    {
                      label: 'Contract name',
                      value: <span style={{ fontWeight: 500 }}>{lane.contractName}</span>,
                    },
                    { label: 'Priority', value: lane.lanePriority ?? '—' },
                    {
                      label: 'Status',
                      value: <Chip status={isActive ? 'active' : 'inactive'} />,
                    },
                    {
                      label: 'Contract start',
                      value: <span className="num">{formatDate(lane.contractPeriodStart)}</span>,
                    },
                    {
                      label: 'Contract end',
                      value: <span className="num">{formatDate(lane.contractPeriodEnd)}</span>,
                    },
                    { label: 'HCR', value: <span className="num">{lane.hcr ?? '—'}</span> },
                    {
                      label: 'Trip number',
                      value: <span className="num">{lane.tripNumber ?? '—'}</span>,
                    },
                    lane.notes ? { label: 'Notes', value: lane.notes } : null,
                  ]}
                />
              </DSCard>

              <DSCard title="Lane details">
                <DSProps
                  items={[
                    { label: 'Lane / scope', value: laneSummary(stops) },
                    {
                      label: 'Miles',
                      value:
                        lane.miles !== undefined ? (
                          <span className="num">{lane.miles} mi</span>
                        ) : (
                          '—'
                        ),
                    },
                    {
                      label: 'Commodity',
                      value: lane.loadCommodity ?? '—',
                    },
                    { label: 'Stops', value: <span className="num">{stops.length}</span> },
                  ]}
                />
                {stops.length > 0 && (
                  <div
                    style={{
                      marginTop: 12,
                      display: 'flex',
                      flexDirection: 'column',
                      gap: 10,
                    }}
                  >
                    {stops.map((s) => (
                      <ContractStopRow key={s.stopOrder} s={s} />
                    ))}
                  </div>
                )}
              </DSCard>

              <DSCard title="Equipment requirements">
                <DSProps
                  items={[
                    { label: 'Equipment class', value: lane.equipmentClass ?? '—' },
                    { label: 'Equipment size', value: lane.equipmentSize ?? '—' },
                  ]}
                />
              </DSCard>
            </div>

            {/* Right column */}
            <div style={{ minWidth: 0, display: 'flex', flexDirection: 'column', gap: 16 }}>
              <DSCard title="Rate information">
                <DSProps
                  items={[
                    {
                      label: 'Rate',
                      value: (
                        <span className="num" style={{ fontWeight: 600 }}>
                          {(lane.currency ?? 'USD') + ' ' + lane.rate.toFixed(2)}
                        </span>
                      ),
                    },
                    { label: 'Rate type', value: lane.rateType },
                    { label: 'Currency', value: lane.currency ?? 'USD' },
                    lane.minimumRate !== undefined
                      ? {
                          label: 'Minimum rate',
                          value: <span className="num">{lane.minimumRate.toFixed(2)}</span>,
                        }
                      : { label: 'Minimum rate', value: '—' },
                    lane.minimumQuantity !== undefined
                      ? {
                          label: 'Minimum quantity',
                          value: <span className="num">{lane.minimumQuantity}</span>,
                        }
                      : { label: 'Minimum quantity', value: '—' },
                    { label: 'Subsidiary', value: lane.subsidiary ?? '—' },
                  ]}
                />
              </DSCard>

              <DSCard title="Operating schedule">
                <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', marginBottom: 12 }}>
                  {DAY_LETTERS.map((letter, i) => {
                    const on = days.includes(i);
                    return (
                      <span
                        key={i}
                        title={DAY_ABBR[i]}
                        style={{
                          width: 30,
                          height: 30,
                          borderRadius: '50%',
                          display: 'inline-flex',
                          alignItems: 'center',
                          justifyContent: 'center',
                          fontSize: 11.5,
                          fontWeight: 600,
                          background: on ? 'var(--accent)' : 'var(--bg-surface-2)',
                          color: on ? '#fff' : 'var(--text-tertiary)',
                          border: on ? 'none' : '1px solid var(--border-hairline)',
                        }}
                      >
                        {letter}
                      </span>
                    );
                  })}
                </div>
                <DSProps
                  items={[
                    {
                      label: 'Runs on',
                      value: days.map((d) => DAY_ABBR[d]).join(', ') || '—',
                    },
                    {
                      label: 'Federal holidays',
                      value: excludeHolidays ? 'Excluded' : 'Included',
                    },
                  ]}
                />
              </DSCard>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
