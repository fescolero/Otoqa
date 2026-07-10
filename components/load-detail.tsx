'use client';

import * as React from 'react';
import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { useMutation } from 'convex/react';
import { useAuthQuery } from '@/hooks/use-auth-query';
import { api } from '@/convex/_generated/api';
import { Button } from '@/components/ui/button';
import {
  Download,
  X,
  ChevronLeft,
  ChevronRight,
  ZoomIn,
  ZoomOut,
} from 'lucide-react';
import { Id } from '@/convex/_generated/dataModel';
import Link from 'next/link';
import { LoadPayPlanCard } from '@/components/web/pay-plan/load-pay-plan-card';
import { LiveTrackingModal, type TimelineEvent } from '@/components/loads/live-tracking-modal';
import { DocPreviewModal, type DocRecord } from '@/components/loads/doc-preview-modal';
import {
  CancellationReasonModal,
  type CancellationReasonCode,
} from '@/components/loads/cancellation-reason-modal';
import { ReassignDriverDialog } from '@/components/sessions/reassign-driver-dialog';
import { formatTimeWindow } from '@/lib/format-date-timezone';
import { cn } from '@/lib/utils';
import {
  AttentionBand,
  type AttentionItem,
  Avatar,
  Chip,
  type ChipStatus,
  DetailsFullPage,
  type FPSection,
  DSActivity,
  DSCard,
  DSMiniTable,
  type DSMiniColumn,
  DSProps,
  type DSPropItem,
  FPCommentsPeek,
  QuickStats,
  type QuickStat,
  RecordActionsMenu,
  type RecordActionGroup,
  RouteProgressBar,
  type ProgressMarker,
  StatusPicker,
  type StatusChangePayload,
  WBtn,
  WIcon,
  resolveStatusId,
} from '@/components/web';
import { toast } from 'sonner';
import { EntityAuditTimeline } from '@/components/audit/entity-audit-timeline';

interface LoadDetailProps {
  loadId: string;
  organizationId: string;
  userId: string;
}

// Types for stop data with evidence
interface StopWithEvidence {
  _id: string;
  sequenceNumber: number;
  stopType: 'PICKUP' | 'DELIVERY' | 'DETOUR';
  status?: string;
  city?: string;
  state?: string;
  address?: string;
  windowBeginDate?: string;
  windowBeginTime?: string;
  windowEndTime?: string;
  pieces?: number;
  checkedInAt?: string;
  checkedOutAt?: string;
  deliveryPhotos?: string[];
  signatureImage?: string;
  driverNotes?: string;
}

// ============================================================================
// PHOTO LIGHTBOX COMPONENT
// ============================================================================
function PhotoLightbox({
  photos,
  initialIndex = 0,
  isOpen,
  onClose,
  stopLabel,
}: {
  photos: string[];
  initialIndex?: number;
  isOpen: boolean;
  onClose: () => void;
  stopLabel?: string;
}) {
  const [currentIndex, setCurrentIndex] = useState(initialIndex);
  const [zoom, setZoom] = useState(1);

  if (!isOpen || photos.length === 0) return null;

  const currentPhoto = photos[currentIndex];

  return (
    <div className="fixed inset-0 z-[100] bg-black/95 backdrop-blur-sm">
      {/* Header */}
      <div className="absolute top-0 left-0 right-0 z-10 flex items-center justify-between px-4 py-3 bg-gradient-to-b from-black/80 to-transparent">
        <div className="flex items-center gap-3">
          {stopLabel && (
            <span className="text-white/80 text-sm font-medium">{stopLabel}</span>
          )}
          <span className="text-white/60 text-xs">
            {currentIndex + 1} of {photos.length}
          </span>
        </div>

        <div className="flex items-center gap-2">
          <Button
            variant="ghost"
            size="icon"
            onClick={() => setZoom((prev) => Math.max(prev - 0.25, 0.5))}
            className="h-8 w-8 text-white/80 hover:text-white hover:bg-white/10"
          >
            <ZoomOut className="h-4 w-4" />
          </Button>
          <span className="text-white/60 text-xs w-12 text-center">
            {Math.round(zoom * 100)}%
          </span>
          <Button
            variant="ghost"
            size="icon"
            onClick={() => setZoom((prev) => Math.min(prev + 0.25, 3))}
            className="h-8 w-8 text-white/80 hover:text-white hover:bg-white/10"
          >
            <ZoomIn className="h-4 w-4" />
          </Button>
          <a href={currentPhoto} download target="_blank" rel="noopener noreferrer">
            <Button
              variant="ghost"
              size="icon"
              className="h-8 w-8 text-white/80 hover:text-white hover:bg-white/10"
            >
              <Download className="h-4 w-4" />
            </Button>
          </a>
          <Button
            variant="ghost"
            size="icon"
            onClick={onClose}
            className="h-8 w-8 text-white/80 hover:text-white hover:bg-white/10"
          >
            <X className="h-4 w-4" />
          </Button>
        </div>
      </div>

      {/* Main image */}
      <div
        className="absolute inset-0 flex items-center justify-center p-16 cursor-zoom-in"
        onClick={(e) => {
          if (e.target === e.currentTarget) onClose();
        }}
      >
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img
          src={currentPhoto}
          alt={`Photo ${currentIndex + 1}`}
          className="max-w-full max-h-full object-contain transition-transform duration-200"
          style={{ transform: `scale(${zoom})` }}
          draggable={false}
          onError={(e) => {
            console.error('Failed to load image:', currentPhoto);
          }}
        />
      </div>

      {/* Navigation arrows */}
      {photos.length > 1 && (
        <>
          <Button
            variant="ghost"
            size="icon"
            onClick={() => setCurrentIndex((prev) => (prev > 0 ? prev - 1 : photos.length - 1))}
            className="absolute left-4 top-1/2 -translate-y-1/2 h-12 w-12 rounded-full bg-black/40 text-white hover:bg-black/60 hover:text-white"
          >
            <ChevronLeft className="h-6 w-6" />
          </Button>
          <Button
            variant="ghost"
            size="icon"
            onClick={() => setCurrentIndex((prev) => (prev < photos.length - 1 ? prev + 1 : 0))}
            className="absolute right-4 top-1/2 -translate-y-1/2 h-12 w-12 rounded-full bg-black/40 text-white hover:bg-black/60 hover:text-white"
          >
            <ChevronRight className="h-6 w-6" />
          </Button>
        </>
      )}

      {/* Thumbnail strip */}
      {photos.length > 1 && (
        <div className="absolute bottom-0 left-0 right-0 z-10 flex items-center justify-center gap-2 p-4 bg-gradient-to-t from-black/80 to-transparent">
          {photos.map((photo, index) => (
            <button
              key={index}
              onClick={() => setCurrentIndex(index)}
              className={cn(
                'h-12 w-12 rounded border-2 overflow-hidden transition-all bg-slate-800',
                currentIndex === index
                  ? 'border-white opacity-100 scale-110'
                  : 'border-transparent opacity-50 hover:opacity-80'
              )}
            >
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img
                src={photo}
                alt={`Thumbnail ${index + 1}`}
                className="h-full w-full object-cover"
                loading="lazy"
              />
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

// ============================================================================
// MAIN COMPONENT
// ============================================================================
export function LoadDetail({ loadId, organizationId, userId }: LoadDetailProps) {
  const router = useRouter();
  const [reassignDialogOpen, setReassignDialogOpen] = useState(false);
  const [selectedStop, setSelectedStop] = useState<StopWithEvidence | null>(null);
  const [lightboxOpen, setLightboxOpen] = useState(false);
  const [lightboxPhotos, setLightboxPhotos] = useState<string[]>([]);
  const [lightboxLabel, setLightboxLabel] = useState('');
  const [activeSection, setActiveSection] = useState('overview');
  const [mapOpen, setMapOpen] = useState(false);
  const [previewDoc, setPreviewDoc] = useState<DocRecord | null>(null);
  const [cancellationOpen, setCancellationOpen] = useState(false);

  // Fetch load data
  const loadData = useAuthQuery(api.loads.getLoad, { loadId: loadId as Id<'loadInformation'> });
  // Pay plan totals — sourced from the new pay engine's unified payItems
  // ledger. Covers driver + carrier payees in one query. The top-of-page
  // KPI/margin calc and the LoadPayPlanCard both subscribe, so the figure
  // stays in lockstep with the card through every recalc.
  const payPlanData = useAuthQuery(api.payItems.listForLoad, { loadId: loadId as Id<'loadInformation'> });
  const invoiceData = useAuthQuery(api.invoices.getInvoiceByLoad, { loadId: loadId as Id<'loadInformation'> });
  // GPS pings powering the modal's "GPS pings" tab. Uses the detailed
  // query so each row can surface accuracy + the sync-delay between
  // device-recorded and server-received timestamps. Only fetch while the
  // modal is open so closed cards don't keep a live subscription open.
  const gpsPings = useAuthQuery(
    api.driverLocations.getDetailedRouteHistoryForLoad,
    mapOpen ? { loadId: loadId as Id<'loadInformation'> } : 'skip',
  );
  // Suggested drivers — only fetched while the load is awaiting assignment.
  const suggestedDrivers = useAuthQuery(
    api.loads.getSuggestedDriversForLoad,
    loadData && loadData.status === 'Open'
      ? { loadId: loadId as Id<'loadInformation'>, limit: 4 }
      : 'skip',
  );

  const updateStatus = useMutation(api.loads.updateLoadStatus);
  const deleteLoad = useMutation(api.loads.deleteLoad);

  if (!loadData) {
    return (
      <div className="flex items-center justify-center py-12">
        <p className="text-muted-foreground">Loading load details...</p>
      </div>
    );
  }

  // Translate StatusPicker state-machine IDs back to the DB enum on commit.
  const STATUS_ID_TO_DB: Record<string, 'Open' | 'Assigned' | 'Canceled' | 'Completed' | 'Expired'> = {
    open: 'Open',
    assigned: 'Assigned',
    completed: 'Completed',
    canceled: 'Canceled',
    expired: 'Expired',
  };

  const handleStatusChange = async (payload: StatusChangePayload) => {
    const dbStatus = STATUS_ID_TO_DB[payload.to.id];
    if (!dbStatus) return;
    // Canceled transitions need a reason code per existing audit policy —
    // delegate to CancellationReasonModal instead of writing directly.
    if (dbStatus === 'Canceled') {
      setCancellationOpen(true);
      return;
    }
    try {
      await updateStatus({ loadId: loadId as Id<'loadInformation'>, status: dbStatus });
    } catch (error) {
      console.error('Failed to update status:', error);
      toast.error('Failed to update status');
    }
  };

  const handleCancellationConfirm = async (
    reasonCode: CancellationReasonCode,
    notes?: string,
  ) => {
    try {
      await updateStatus({
        loadId: loadId as Id<'loadInformation'>,
        status: 'Canceled',
        cancellationReason: reasonCode,
        cancellationNotes: notes,
        canceledBy: userId,
      });
      toast.success('Load canceled');
      setCancellationOpen(false);
    } catch (error) {
      console.error('Failed to cancel load:', error);
      toast.error('Failed to cancel load');
    }
  };

  const handleDelete = async () => {
    try {
      await deleteLoad({ loadId: loadId as Id<'loadInformation'> });
      router.push('/loads');
    } catch (error) {
      console.error('Failed to delete load:', error);
      alert('Failed to delete load');
    }
  };

  const formatDateShort = (timestamp: number) => {
    return new Date(timestamp).toLocaleDateString('en-US', {
      year: 'numeric',
      month: 'short',
      day: 'numeric',
    });
  };

  const formatTime = (isoString?: string): string => {
    if (!isoString) return '—';
    try {
      const date = new Date(isoString);
      return date.toLocaleTimeString('en-US', {
        hour: 'numeric',
        minute: '2-digit',
        hour12: true,
      });
    } catch {
      return '—';
    }
  };

  // Calculate time variance
  // windowBeginTime is stored as full ISO string (e.g., "2025-01-08T12:25:00-08:00") or "TBD"
  const getTimeVariance = (
    scheduledTimeISO?: string,
    actualTimeISO?: string
  ): { label: string; isLate: boolean } | null => {
    // Skip if missing or TBD
    if (!scheduledTimeISO || !actualTimeISO) return null;
    if (scheduledTimeISO === 'TBD' || actualTimeISO === 'TBD') return null;

    try {
      const scheduled = new Date(scheduledTimeISO).getTime();
      const actual = new Date(actualTimeISO).getTime();

      // Validate parsed dates
      if (isNaN(scheduled) || isNaN(actual)) {
        return null;
      }

      const diffMs = actual - scheduled;
      const minutesDiff = Math.round(diffMs / 60000);

      if (Math.abs(minutesDiff) < 2) {
        return { label: 'On Time', isLate: false };
      } else if (minutesDiff > 0) {
        // Format large differences as hours
        if (minutesDiff >= 60) {
          const hours = Math.floor(minutesDiff / 60);
          const mins = minutesDiff % 60;
          return { label: mins > 0 ? `${hours}h ${mins}m late` : `${hours}h late`, isLate: true };
        }
        return { label: `${minutesDiff}m late`, isLate: true };
      } else {
        // Format large differences as hours
        const absMins = Math.abs(minutesDiff);
        if (absMins >= 60) {
          const hours = Math.floor(absMins / 60);
          const mins = absMins % 60;
          return { label: mins > 0 ? `${hours}h ${mins}m early` : `${hours}h early`, isLate: false };
        }
        return { label: `${absMins}m early`, isLate: false };
      }
    } catch {
      return null;
    }
  };

  // ── Derived data ──────────────────────────────────────────────────────
  const customerRate = invoiceData?.totalAmount ?? 0;
  // Pay plan total — unified across driver + carrier payees. Sourced from
  // the new pay engine's payItems ledger (which the LoadPayPlanCard also
  // renders), so KPI and card stay in lockstep through every recalc.
  const driverPay = (payPlanData?.totalCents ?? 0) / 100;
  const margin = customerRate - driverPay;
  const marginPct = customerRate > 0 ? (margin / customerRate) * 100 : 0;
  const totalPieces = loadData.stops.reduce((sum, stop) => sum + (stop.pieces || 0), 0);
  const origin = loadData.stops.find((s) => s.stopType === 'PICKUP') as StopWithEvidence | undefined;
  const finalDeliveryStop = loadData.stops
    .filter((s) => s.stopType === 'DELIVERY')
    .pop() as StopWithEvidence | undefined;
  const hasPOD = !!(
    finalDeliveryStop &&
    ((finalDeliveryStop.deliveryPhotos?.length ?? 0) > 0 || finalDeliveryStop.signatureImage)
  );
  const statusId = resolveStatusId('load', loadData.status);

  // Friendlier chip label per design v3 — combines the DB status with
  // tracking state so the eyebrow reads "In transit" while the truck is
  // moving (DB status stays `Assigned`). Picker menu is unaffected.
  const trackingLower = (loadData.trackingStatus || '').toLowerCase();
  const isInTransitChip = trackingLower === 'in transit';
  const isDelayedChip = trackingLower === 'delayed';
  const statusChipLabel = (() => {
    switch (loadData.status) {
      case 'Open':
        return 'Open · waiting for assignment';
      case 'Assigned':
        if (isInTransitChip) return 'In transit';
        if (isDelayedChip) return 'Assigned · delayed';
        return 'Assigned · pickup pending';
      case 'Completed':
        return 'Delivered';
      case 'Canceled':
        return 'Cancelled';
      case 'Expired':
        return 'Expired';
      default:
        return undefined;
    }
  })();

  // ── Progress (% of stops checked in, used by Live tracking + last QuickStat) ─
  const stopsCheckedIn = loadData.stops.filter((s) => !!(s as StopWithEvidence).checkedInAt).length;
  const transitProgressPct =
    loadData.stops.length > 0 ? Math.round((stopsCheckedIn / loadData.stops.length) * 100) : 0;

  // ── QuickStats (per-status 5-cell strip the v2 Overview owns) ─────────
  // Replaces the hero's cold 4-up KPI grid. The first four cells are stable
  // across statuses; the fifth swaps to the most relevant signal for the
  // current state (countdown / progress / on-time).
  const fmtMoney = (n: number) =>
    `$${n.toLocaleString('en-US', { minimumFractionDigits: 0, maximumFractionDigits: 0 })}`;
  const baseQuickStats: QuickStat[] = [
    { label: 'Miles', value: loadData.effectiveMiles ? loadData.effectiveMiles.toLocaleString() : '—' },
    { label: 'Stops', value: loadData.stops.length },
    { label: 'Line haul', value: customerRate ? fmtMoney(customerRate) : '—' },
    {
      label: 'Margin',
      value: customerRate > 0 ? fmtMoney(margin) : '—',
      delta: customerRate > 0 ? `${marginPct.toFixed(0)}%` : undefined,
      deltaTone: customerRate > 0 ? (margin >= 0 ? 'up' : 'down') : 'neutral',
    },
  ];
  const quickStats: QuickStat[] = (() => {
    if (loadData.status === 'Open') {
      return [...baseQuickStats, { label: 'Pickup', value: '—', delta: 'unscheduled', deltaTone: 'neutral' }];
    }
    if (loadData.status === 'Assigned' && !isInTransitChip) {
      return [...baseQuickStats, { label: 'Pickup', value: 'pre-trip', delta: 'awaiting', deltaTone: 'neutral' }];
    }
    if (loadData.status === 'Completed') {
      return [...baseQuickStats, { label: 'Status', value: 'Delivered', deltaTone: 'up' }];
    }
    return [
      ...baseQuickStats,
      { label: 'Status', value: `${transitProgressPct}%`, delta: 'in transit', deltaTone: 'up' },
    ];
  })();

  // ── Section content ───────────────────────────────────────────────────

  const shipmentItems: DSPropItem[] = [
    { label: 'Order #', value: <span className="num font-medium">{loadData.orderNumber}</span> },
    { label: 'Customer', value: loadData.customerName ?? '—' },
    {
      label: 'PO Number',
      value: loadData.poNumber ? <span className="num">{loadData.poNumber}</span> : '—',
    },
    { label: 'Commodity', value: loadData.commodityDescription ?? '—' },
    { label: 'Equipment', value: loadData.equipmentType ?? '—' },
    {
      label: 'Weight',
      value: loadData.weight ? (
        <span className="num">{`${loadData.weight} ${loadData.units ?? 'lbs'}`}</span>
      ) : (
        '—'
      ),
    },
    { label: 'Pieces', value: <span className="num">{totalPieces}</span> },
  ];

  const assignedItems: DSPropItem[] = [];
  if (loadData.assignedDriver) {
    const driverId = loadData.assignedDriver._id;
    const driverName = loadData.assignedDriver.name;
    assignedItems.push({
      label: 'Driver',
      value: (
        <span className="inline-flex items-center gap-2">
          <Avatar name={driverName} size={20} />
          <button
            type="button"
            onClick={() => router.push(`/fleet/drivers/${driverId}`)}
            className="bg-transparent border-0 p-0 cursor-pointer focus-ring rounded-sm hover:underline text-foreground"
          >
            {driverName}
          </button>
        </span>
      ),
    });
  }
  if (loadData.assignedCarrier) {
    assignedItems.push({ label: 'Carrier', value: loadData.assignedCarrier.companyName });
  }
  if (loadData.assignedTruck) {
    const truckId = loadData.assignedTruck._id;
    const truckUnitId = loadData.assignedTruck.unitId;
    assignedItems.push({
      label: 'Truck',
      value: (
        <button
          type="button"
          onClick={() => router.push(`/fleet/trucks/${truckId}`)}
          className="num bg-transparent border-0 p-0 cursor-pointer focus-ring rounded-sm hover:underline text-foreground"
        >
          {truckUnitId}
        </button>
      ),
    });
  }
  if (loadData.assignedTrailer) {
    assignedItems.push({
      label: 'Trailer',
      value: <span className="num">{loadData.assignedTrailer.unitId}</span>,
    });
  }
  if (assignedItems.length === 0) {
    assignedItems.push({
      label: 'Status',
      value: <span className="text-[var(--text-tertiary)] italic">Not assigned</span>,
    });
  }

  // Note: financial KPIs (customer rate / driver pay / margin) used to live
  // in a "Financials" DSCard with DSProps. They're now rendered inside the
  // pay-plan card's margin footer instead. `customerRate`, `driverPay`,
  // `margin`, `marginPct` above are still computed because they feed the
  // attention-band "Settlement preview" tile.

  const pickupCheckedIn = !!origin?.checkedInAt;
  const isCompleted = loadData.status === 'Completed';
  const isCanceled = loadData.status === 'Canceled';

  // ── Live tracking primitives (driven by stop state) ────────────────────
  const originLabel = [origin?.city, origin?.state].filter(Boolean).join(', ') || 'Origin';
  const destLabel = [finalDeliveryStop?.city, finalDeliveryStop?.state].filter(Boolean).join(', ') || 'Destination';
  const finalEtaWindow = finalDeliveryStop
    ? formatTimeWindow(
        finalDeliveryStop.windowBeginDate || '',
        finalDeliveryStop.windowBeginTime,
        finalDeliveryStop.windowEndTime,
      )
    : null;
  const etaLabel = finalEtaWindow?.display ?? '—';
  // Idle-event detection isn't wired yet — surface a warn chip only when we
  // can prove an idle from data. Until then this stays empty so we don't ship
  // a fake number to dispatchers.
  const idleEventDetected = false;

  // ── AttentionBand (per-status headline + items) ────────────────────────
  const orderToken = (
    <span className="num text-foreground font-semibold">{loadData.orderNumber}</span>
  );
  let attentionHeadline: React.ReactNode = null;
  const attentionItems: AttentionItem[] = [];
  if (isCanceled) {
    attentionHeadline = <>Load {orderToken} was cancelled.</>;
    attentionItems.push({ tone: 'crit', icon: 'close', title: 'Cancelled', detail: 'No further activity expected.' });
  } else if (loadData.status === 'Open') {
    attentionHeadline = <>Load {orderToken} is waiting for assignment.</>;
    attentionItems.push({
      tone: 'warn',
      icon: 'alert',
      tab: 'overview',
      title: 'No driver assigned',
      detail: finalEtaWindow ? `Pickup ${finalEtaWindow.display}` : 'Pickup window unscheduled',
    });
    if (suggestedDrivers && suggestedDrivers.length > 0) {
      attentionItems.push({
        tone: 'info',
        icon: 'users',
        tab: 'overview',
        title: `${suggestedDrivers.length} driver${suggestedDrivers.length === 1 ? '' : 's'} eligible`,
        detail: 'Based on HOS + location',
      });
    }
  } else if (loadData.status === 'Assigned' && !isInTransitChip) {
    attentionHeadline = <>Load {orderToken} is assigned and waiting for pickup.</>;
    attentionItems.push({
      tone: 'ok',
      icon: 'check',
      tab: 'overview',
      title: 'Driver, truck, trailer assigned',
      detail: loadData.assignedDriver?.name ?? 'Carrier assigned',
    });
    if (origin?.windowBeginTime) {
      const win = formatTimeWindow(origin.windowBeginDate || '', origin.windowBeginTime, origin.windowEndTime);
      attentionItems.push({
        tone: 'info',
        icon: 'clock',
        tab: 'stops',
        title: `Pickup ${win.display}`,
        detail: 'Driver heading to origin',
      });
    }
  } else if (isCompleted) {
    attentionHeadline = <>Load {orderToken} delivered. Ready to invoice.</>;
    attentionItems.push({
      tone: 'ok',
      icon: 'check',
      tab: 'docs',
      title: hasPOD ? 'POD on file' : 'POD pending',
      detail: finalDeliveryStop?.checkedInAt ? `Arrived ${formatTime(finalDeliveryStop.checkedInAt)}` : '',
    });
    attentionItems.push({
      tone: 'info',
      icon: 'doc-dollar',
      tab: 'overview',
      title: 'Settlement preview',
      detail: customerRate > 0 ? `Margin ${fmtMoney(margin)} · ${marginPct.toFixed(0)}%` : 'Awaiting rate',
    });
  } else {
    // In transit (default for Assigned + tracking active, or Delayed).
    attentionHeadline = (
      <>
        Load {orderToken} is in transit, currently{' '}
        <span style={{ color: isDelayedChip ? '#A66800' : '#0F8C5F', fontWeight: 500 }}>
          {isDelayedChip ? 'delayed' : 'on time'}
        </span>
        {idleEventDetected ? '. One idle event flagged for review.' : '.'}
      </>
    );
    attentionItems.push({
      tone: isDelayedChip ? 'warn' : 'info',
      icon: 'pulse',
      tab: 'overview',
      title: `In transit · ${transitProgressPct}% complete`,
      detail: etaLabel !== '—' ? `ETA ${etaLabel}` : 'ETA pending',
    });
    if (idleEventDetected) {
      attentionItems.push({
        tone: 'warn',
        icon: 'alert',
        tab: 'activity',
        title: 'Idle event flagged',
        detail: 'Auto-flagged from telematics',
      });
    }
    attentionItems.push({
      tone: pickupCheckedIn ? 'ok' : 'warn',
      icon: pickupCheckedIn ? 'check' : 'alert',
      tab: 'docs',
      title: pickupCheckedIn ? 'BOL — pickup signed' : 'BOL — pickup pending',
      detail: origin?.checkedInAt ? formatTime(origin.checkedInAt) : 'Awaiting check-in',
    });
  }

  // ── Two-column body card (left card varies by status) ──────────────────
  const liveTrackingMarkers: ProgressMarker[] = [
    ...(transitProgressPct > 0
      ? [{ at: transitProgressPct, tone: 'info' as const, label: 'Now', detail: `${transitProgressPct}% complete` }]
      : []),
    { at: 100, tone: 'ok' as const, label: 'Arrival', detail: etaLabel !== '—' ? `ETA ${etaLabel}` : 'On schedule' },
  ];

  const assignedCard = (
    <DSCard
      title="Assigned"
      action={
        loadData.assignedDriver?._id &&
        loadData.status !== 'Completed' &&
        loadData.status !== 'Canceled' ? (
          <WBtn size="sm" leading="users" onClick={() => setReassignDialogOpen(true)}>
            Reassign
          </WBtn>
        ) : undefined
      }
    >
      <DSProps items={assignedItems} />
    </DSCard>
  );

  let leftHeroCard: React.ReactNode;
  if (loadData.status === 'Open') {
    leftHeroCard = (
      <DSCard
        title="Awaiting assignment"
        action={
          <Link href={`/dispatch/planner?order=${encodeURIComponent(loadData.orderNumber)}`}>
            <WBtn size="sm" leading="users">Assign driver</WBtn>
          </Link>
        }
      >
        <div
          className="flex items-center gap-2.5 px-3 py-2.5 rounded-lg mb-2"
          style={{ background: 'rgba(245,158,11,0.06)', border: '1px solid rgba(245,158,11,0.22)' }}
        >
          <WIcon name="clock" size={16} color="#A66800" />
          <div className="flex-1 min-w-0">
            <div className="text-[12.5px] font-semibold text-foreground">
              {finalEtaWindow ? finalEtaWindow.display : 'Pickup window unscheduled'}
            </div>
            <div className="text-[11px] text-[var(--text-tertiary)]">
              {finalEtaWindow?.tooltip ?? 'Schedule pickup to begin tracking'}
            </div>
          </div>
        </div>
        <DSProps items={shipmentItems.slice(0, 4)} />
      </DSCard>
    );
  } else if (isCanceled) {
    leftHeroCard = (
      <DSCard title="Cancelled">
        <p className="m-0 text-[12.5px] text-[var(--text-secondary)]">
          This load was cancelled. See the activity log for the cancellation reason.
        </p>
      </DSCard>
    );
  } else {
    // Assigned / In transit / Delivered all show Live tracking.
    leftHeroCard = (
      <DSCard
        title="Live tracking"
        action={
          <div className="flex gap-1.5">
            <WBtn size="sm" leading="map" onClick={() => setMapOpen(true)}>
              Open map
            </WBtn>
          </div>
        }
      >
        <div className="text-[12.5px] text-[var(--text-secondary)] leading-[17px] mb-2.5">
          {originLabel} → {destLabel}
          {etaLabel !== '—' && (
            <>
              {' · '}
              <span className="num">ETA {etaLabel}</span>
            </>
          )}
        </div>
        <RouteProgressBar
          percent={transitProgressPct}
          from={originLabel}
          to={destLabel}
          markers={liveTrackingMarkers}
        />
      </DSCard>
    );
  }

  // ── Stops (rows + chip maps used by both overview teaser and Stops tab) ─
  type StopRow = StopWithEvidence & { id: string };
  const stopRows: StopRow[] = loadData.stops.map((s) => ({
    ...(s as StopWithEvidence),
    id: s._id,
  }));
  const STOP_TYPE_TO_CHIP: Record<string, ChipStatus> = {
    PICKUP: 'expiring',
    DELIVERY: 'valid',
    DETOUR: 'pending',
  };
  const STOP_STATUS_TO_CHIP: Record<string, ChipStatus> = {
    Pending: 'pending',
    'In Transit': 'active',
    Completed: 'delivered',
    Canceled: 'cancelled',
  };

  // Inline Stops mini-card on the overview (the dedicated "Stops" tab keeps
  // the full card with all the columns; this is a curated subset to scan).
  const overviewStopsCard = (
    <DSCard
      title="Stops"
      bodyClassName="p-0"
      action={
        <WBtn size="sm" leading="arrow-up-right" onClick={() => setActiveSection('stops')}>
          Open stops
        </WBtn>
      }
    >
      <DSMiniTable<StopRow>
        columns={[
          {
            key: 'kind',
            label: '',
            width: '24px',
            render: (r) => (
              <span
                className="inline-block rounded-full"
                style={{
                  width: 10,
                  height: 10,
                  background: r.stopType === 'PICKUP' ? '#10B981' : r.stopType === 'DETOUR' ? '#F59E0B' : '#2E5CFF',
                }}
              />
            ),
          },
          {
            key: 'where',
            label: 'Location',
            width: '1.4fr',
            render: (r) => (
              <span className="font-medium text-foreground truncate">
                {[r.city, r.state].filter(Boolean).join(', ') || '—'}
              </span>
            ),
          },
          {
            key: 'addr',
            label: 'Address',
            width: '1.6fr',
            render: (r) => (
              <span className="text-[var(--text-tertiary)] truncate">{r.address || '—'}</span>
            ),
          },
          {
            key: 'when',
            // 240px fits the full "Fri, May 8 · 1:45 PM - 1:45 PM PDT" string
            // formatTimeWindow returns. 120px clipped it mid-time.
            label: 'When',
            width: '240px',
            render: (r) => {
              const win = formatTimeWindow(r.windowBeginDate || '', r.windowBeginTime, r.windowEndTime);
              return <span className="num text-[var(--text-tertiary)]">{win.display}</span>;
            },
          },
          {
            key: 'st',
            label: 'Status',
            width: '100px',
            render: (r) => (
              <Chip status={STOP_STATUS_TO_CHIP[r.status ?? 'Pending'] ?? 'inactive'} />
            ),
          },
        ]}
        rows={stopRows}
        total={stopRows.length}
        className="rounded-t-none border-0 border-t"
      />
    </DSCard>
  );

  const overviewContent = (
    <div className="flex flex-col gap-3.5">
      <AttentionBand
        headline={attentionHeadline}
        items={attentionItems}
        onJump={(tab) => setActiveSection(tab)}
      />
      <QuickStats stats={quickStats} />
      <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
        {leftHeroCard}
        {assignedCard}
      </div>
      {!isCanceled && overviewStopsCard}
      <DSCard title="Shipment">
        <DSProps items={shipmentItems} />
      </DSCard>
      {/* Pay plan card — inline per design (was previously a separate tab).
          Subsumes the old "Financials" card (revenue / pay / margin are
          rendered inside the pay plan's margin footer). */}
      <LoadPayPlanCard
        loadId={loadId as Id<'loadInformation'>}
        organizationId={organizationId}
        userId={userId}
      />
    </div>
  );

  // ── Stops (full table for the Stops tab) ──────────────────────────────
  const stopCols: DSMiniColumn<StopRow>[] = [
    {
      key: 'seq',
      label: '#',
      width: '36px',
      render: (r) => <span className="num">{r.sequenceNumber}</span>,
    },
    {
      key: 'type',
      label: 'Type',
      width: '90px',
      render: (r) => (
        <Chip
          status={STOP_TYPE_TO_CHIP[r.stopType] ?? 'inactive'}
          label={r.stopType.toLowerCase()}
        />
      ),
    },
    {
      key: 'place',
      label: 'Location',
      width: '1.6fr',
      render: (r) => (
        <span className="truncate">
          <span className="font-medium text-foreground">{r.address || r.city || '—'}</span>
          {r.address && (r.city || r.state) && (
            <span className="text-[var(--text-tertiary)]">
              {`, ${r.city ?? ''}${r.city && r.state ? ', ' : ''}${r.state ?? ''}`}
            </span>
          )}
        </span>
      ),
    },
    {
      key: 'plan',
      // 240px fits the full "Fri, May 22 · 12:10 AM - 12:10 AM PDT" string
      // formatTimeWindow returns. 160px clipped it to "Fri, May 22 · 12:1…".
      label: 'Plan',
      width: '240px',
      render: (r) => {
        const win = formatTimeWindow(r.windowBeginDate || '', r.windowBeginTime, r.windowEndTime);
        return <span className="num text-[var(--text-tertiary)]">{win.display}</span>;
      },
    },
    {
      key: 'actual',
      label: 'Actual',
      width: '90px',
      render: (r) =>
        r.checkedInAt ? (
          <span className="num">{formatTime(r.checkedInAt)}</span>
        ) : (
          <span className="text-[var(--text-tertiary)]">—</span>
        ),
    },
    {
      key: 'perf',
      label: 'Perf',
      width: '90px',
      align: 'right',
      render: (r) => {
        let scheduled = r.windowBeginTime;
        if (scheduled && !scheduled.includes('T') && r.windowBeginDate) {
          scheduled = `${r.windowBeginDate}T${scheduled}:00`;
        }
        const v = r.checkedInAt ? getTimeVariance(scheduled, r.checkedInAt) : null;
        if (!v) return <span className="text-[var(--text-tertiary)]">—</span>;
        return (
          <span
            className="num text-[10.5px] font-bold px-1.5 py-0.5 rounded"
            style={{
              background: v.isLate ? 'rgba(239,68,68,0.10)' : 'rgba(16,185,129,0.10)',
              color: v.isLate ? '#B43030' : '#0F8C5F',
            }}
          >
            {v.label}
          </span>
        );
      },
    },
    {
      key: 'st',
      label: 'Status',
      width: '110px',
      render: (r) => <Chip status={STOP_STATUS_TO_CHIP[r.status ?? 'Pending'] ?? 'inactive'} />,
    },
  ];

  const stopsContent = (
    <DSCard
      title={`Stops (${loadData.stops.length})`}
      bodyClassName="p-0"
      action={
        <WBtn size="sm" leading="map" onClick={() => setMapOpen(true)}>
          Open map
        </WBtn>
      }
    >
      <DSMiniTable
        columns={stopCols}
        rows={stopRows}
        total={stopRows.length}
        className="rounded-t-none border-0 border-t"
        onRowClick={(row) => {
          const stop = row as StopRow;
          setSelectedStop(stop);
          // Pass 1: clicking a stop row opens its photos in the lightbox
          // when any are on file. Map-modal-centred behavior lands in
          // Pass 2 alongside the per-stop side panel.
          const photos: string[] = [
            ...(stop.deliveryPhotos ?? []),
            ...(stop.signatureImage ? [stop.signatureImage] : []),
          ];
          if (photos.length > 0) {
            setLightboxPhotos(photos);
            setLightboxLabel(`Stop ${stop.sequenceNumber} — ${stop.city ?? ''}`);
            setLightboxOpen(true);
          }
        }}
      />
    </DSCard>
  );

  // ── Documents ────────────────────────────────────────────────────────
  // Combines load-level placeholders (Rate confirmation, BOL pickup/
  // delivery — wired once a real doc store lands) with per-stop POD
  // evidence (photos + signatures + driver notes) so everything tied to
  // this load shows up in one place. Click a row to open DocPreviewModal.
  const docRows: DocRecord[] = [];

  // Per-stop POD photos and signatures.
  loadData.stops.forEach((s) => {
    const sw = s as StopWithEvidence;
    const stopLabel = `Stop ${sw.sequenceNumber} ${sw.stopType === 'PICKUP' ? 'pickup' : 'delivery'}`;
    const when = sw.checkedInAt ? formatTime(sw.checkedInAt) : '—';
    sw.deliveryPhotos?.forEach((url, i) => {
      docRows.push({
        id: `${sw._id}-photo-${i}`,
        name: `${stopLabel} — Photo ${i + 1}`,
        src: 'Driver',
        when,
        status: 'valid',
        preview: { kind: 'image', url },
        downloadUrl: url,
        openUrl: url,
        activity: sw.checkedInAt
          ? [{ id: 'check', text: <>Captured at check-in · <span className="num">{when}</span></> }]
          : undefined,
      });
    });
    if (sw.signatureImage) {
      docRows.push({
        id: `${sw._id}-sig`,
        name: `${stopLabel} — Signature`,
        src: 'Driver',
        when,
        status: 'valid',
        preview: { kind: 'image', url: sw.signatureImage },
        downloadUrl: sw.signatureImage,
        openUrl: sw.signatureImage,
      });
    }
    if (sw.driverNotes) {
      docRows.push({
        id: `${sw._id}-note`,
        name: `${stopLabel} — Driver note`,
        src: 'Driver',
        when,
        status: 'valid',
        preview: { kind: 'text', body: sw.driverNotes },
      });
    }
  });

  // Load-level documents (placeholders until file store lands).
  docRows.push({
    id: 'rate',
    name: 'Rate confirmation',
    src: 'Customer',
    when: '—',
    status: 'expiring',
    preview: { kind: 'placeholder' },
  });
  if (!docRows.some((r) => r.id.includes('photo') && r.id.startsWith(origin?._id ?? '___'))) {
    docRows.push({
      id: 'bol-pickup',
      name: 'BOL — pickup',
      src: 'Driver',
      when: origin?.checkedInAt ? formatTime(origin.checkedInAt) : '—',
      status: 'expiring',
      preview: { kind: 'placeholder' },
    });
  }
  if (!hasPOD) {
    docRows.push({
      id: 'bol-delivery',
      name: 'BOL — delivery',
      src: 'Driver',
      when: '—',
      status: 'expiring',
      preview: { kind: 'placeholder' },
    });
  }

  const documentsContent = (
    <DSCard
      title={`Documents (${docRows.length})`}
      bodyClassName="p-0"
      action={<WBtn size="sm" leading="plus">Upload</WBtn>}
    >
      <DSMiniTable<DocRecord>
        columns={[
          { key: 'name', label: 'Document', width: '1.4fr' },
          { key: 'src', label: 'Source', width: '110px' },
          {
            key: 'when',
            label: 'Received',
            width: '110px',
            render: (r) => <span className="num">{r.when}</span>,
          },
          {
            key: 'status',
            label: 'Status',
            width: '90px',
            render: (r) => <Chip status={r.status} />,
          },
        ]}
        rows={docRows}
        total={docRows.length}
        className="rounded-t-none border-0 border-t"
        onRowClick={(row) => setPreviewDoc(row)}
      />
    </DSCard>
  );

  // ── Communications (stub) ─────────────────────────────────────────────
  const commsContent = (
    <DSCard title="Communications">
      <div className="flex flex-col items-center justify-center py-10 text-center">
        <WIcon name="chat" size={20} color="var(--text-tertiary)" />
        <p className="m-0 mt-2 text-[12.5px] text-[var(--text-tertiary)]">
          Messaging on loads is coming soon.
        </p>
      </div>
    </DSCard>
  );

  // ── Activity ──────────────────────────────────────────────────────────
  type ActIcon = 'truck' | 'check' | 'pulse' | 'circle-dot';
  const activityItems: Array<{
    id: string;
    icon: ActIcon;
    text: string;
    when: string;
    tone?: 'warn';
  }> = [];
  loadData.stops.forEach((s) => {
    const sw = s as StopWithEvidence;
    if (sw.checkedInAt) {
      activityItems.push({
        id: `in-${sw._id}`,
        icon: 'truck',
        text: `${sw.stopType === 'PICKUP' ? 'Picked up' : 'Arrived'} at stop ${sw.sequenceNumber} — ${sw.city ?? ''}`,
        when: formatTime(sw.checkedInAt),
      });
    }
    if (sw.checkedOutAt) {
      activityItems.push({
        id: `out-${sw._id}`,
        icon: 'check',
        text: `Departed stop ${sw.sequenceNumber}`,
        when: formatTime(sw.checkedOutAt),
      });
    }
  });
  if (activityItems.length === 0) {
    activityItems.push({
      id: 'created',
      icon: 'circle-dot',
      text: 'Load created',
      when: formatDateShort(loadData.createdAt),
    });
  }

  const activityContent = (
    <div className="flex flex-col gap-3.5">
      <DSCard title="Trip activity">
        <DSActivity items={activityItems} emptyText="No activity yet." />
      </DSCard>
      {/* Audit trail — status changes, holds, assignments, POD uploads. */}
      <DSCard title="History">
        <EntityAuditTimeline entityType="load" entityId={loadId} limit={25} />
      </DSCard>
    </div>
  );

  // Pay-plan card now lives inline in the Overview tab — no dedicated Pay
  // tab. See `LoadPayPlanCard` inside `overviewContent` above.

  // ── Status-aware right rail ──────────────────────────────────────────
  const trackingStatus = (loadData.trackingStatus || '').toLowerCase();
  const isInTransit = trackingStatus === 'in transit';
  let railCard: React.ReactNode = null;
  if (loadData.status === 'Open') {
    const win = origin
      ? formatTimeWindow(origin.windowBeginDate || '', origin.windowBeginTime, origin.windowEndTime)
      : null;
    railCard = (
      <DSCard
        title="Awaiting assignment"
        action={
          <Link href={`/dispatch/planner?order=${encodeURIComponent(loadData.orderNumber)}`}>
            <WBtn size="xs" variant="ghost">See all</WBtn>
          </Link>
        }
        bodyClassName="flex flex-col gap-3"
      >
        <DSActivity
          items={[
            {
              icon: 'clock',
              tone: 'warn',
              text: win ? `Pickup window ${win.display}` : 'Pickup window unset',
              when: win?.tooltip ?? '',
            },
          ]}
        />
        <div className="flex flex-col gap-1">
          <div className="text-[10.5px] font-semibold uppercase tracking-[0.04em] text-[var(--text-tertiary)]">
            Suggested drivers
          </div>
          {suggestedDrivers === undefined ? (
            <p className="m-0 text-[12px] text-[var(--text-tertiary)]">Loading…</p>
          ) : suggestedDrivers.length === 0 ? (
            <p className="m-0 text-[12px] text-[var(--text-tertiary)]">No eligible drivers found.</p>
          ) : (
            <div className="flex flex-col gap-1.5">
              {suggestedDrivers.map((d) => {
                const fullName = [d.firstName, d.middleName, d.lastName].filter(Boolean).join(' ');
                return (
                  <Link
                    key={d._id}
                    href={`/fleet/drivers/${d._id}`}
                    className="flex items-center gap-2 px-1.5 py-1.5 rounded-md hover:bg-[var(--bg-row-hover)]"
                  >
                    <Avatar name={fullName} size={24} />
                    <span className="flex-1 min-w-0">
                      <span className="block text-[12.5px] font-medium text-foreground truncate">
                        {fullName}
                      </span>
                      <span className="block text-[11px] text-[var(--text-tertiary)] truncate">
                        {d.reasons.length > 0
                          ? d.reasons.join(' · ')
                          : `Class ${d.licenseClass}${d.state ? ` · ${d.state}` : ''}`}
                      </span>
                    </span>
                    <WIcon name="chevron-right" size={11} color="var(--text-tertiary)" />
                  </Link>
                );
              })}
            </div>
          )}
        </div>
      </DSCard>
    );
  } else if (loadData.status === 'Assigned' && !isInTransit) {
    railCard = (
      <DSCard title="Pre-pickup">
        <DSActivity
          items={[
            { icon: 'check', tone: 'ok', text: 'Driver acknowledged dispatch', when: '' },
          ]}
        />
      </DSCard>
    );
  } else if (isInTransit) {
    const last = activityItems[activityItems.length - 1];
    railCard = (
      <DSCard title="Trip in progress">
        <DSActivity
          items={[
            { icon: 'truck', text: last?.text ?? 'In transit', when: last?.when ?? 'now' },
          ]}
        />
      </DSCard>
    );
  } else if (loadData.status === 'Completed') {
    railCard = (
      <DSCard title="Delivered">
        <DSActivity
          items={[
            {
              icon: 'check',
              tone: 'ok',
              text: hasPOD ? 'POD on file' : 'POD pending',
              when: finalDeliveryStop?.checkedInAt ? formatTime(finalDeliveryStop.checkedInAt) : '',
            },
          ]}
        />
      </DSCard>
    );
  } else if (loadData.status === 'Canceled') {
    railCard = (
      <DSCard title="Cancelled">
        <p className="m-0 text-[12.5px] text-[var(--text-secondary)]">This load was canceled.</p>
      </DSCard>
    );
  }
  // Risk signals — derives from the same attentionItems that drive the
  // band, but presents them as a compact rail card so dispatchers see the
  // running list of things to watch even after they scroll the headline
  // out of view. Only emits when there's at least one non-ok signal.
  const riskSignals = attentionItems.filter((it) => it.tone === 'warn' || it.tone === 'crit' || it.tone === 'info');
  const riskCard =
    riskSignals.length > 0 ? (
      <DSCard title="Risk signals">
        <div className="flex flex-col gap-2">
          {riskSignals.map((it, i) => {
            const tone = it.tone ?? 'info';
            const fg =
              tone === 'crit' ? '#B43030' : tone === 'warn' ? '#A66800' : tone === 'ok' ? '#0F8C5F' : '#1A47E6';
            const bg =
              tone === 'crit'
                ? 'rgba(239,68,68,0.10)'
                : tone === 'warn'
                  ? 'rgba(245,158,11,0.10)'
                  : tone === 'ok'
                    ? 'rgba(16,185,129,0.10)'
                    : 'rgba(46,92,255,0.08)';
            return (
              <div key={i} className="flex items-start gap-2.5">
                <span
                  aria-hidden
                  className="inline-flex items-center justify-center rounded-md shrink-0 mt-0.5"
                  style={{ width: 22, height: 22, background: bg, color: fg }}
                >
                  <WIcon name={it.icon ?? 'circle-dot'} size={11} />
                </span>
                <div className="min-w-0 flex-1 leading-[16px]">
                  <div className="text-[12px] font-medium text-foreground truncate">{it.title}</div>
                  {it.detail && (
                    <div className="num text-[10.5px] mt-0.5 truncate" style={{ color: fg }}>
                      {it.detail}
                    </div>
                  )}
                </div>
              </div>
            );
          })}
        </div>
      </DSCard>
    ) : null;

  // FPCommentsPeek tops the rail — always present so dispatchers can see
  // chatter without expanding the thread. Wired to the `comm` tab until
  // the inline thread lands.
  const commentsPeek = (
    <FPCommentsPeek
      count={0}
      latest={undefined}
      onOpen={() => setActiveSection('comm')}
    />
  );

  const rightRail = (
    <div className="flex flex-col gap-3">
      {commentsPeek}
      {riskCard}
      {railCard}
    </div>
  );

  // ── Sections ─────────────────────────────────────────────────────────
  const sections: FPSection[] = [
    { id: 'overview', label: 'Overview', icon: 'home', content: overviewContent },
    {
      id: 'stops',
      label: 'Stops',
      icon: 'pin',
      count: loadData.stops.length,
      content: stopsContent,
    },
    {
      id: 'docs',
      label: 'Documents',
      icon: 'file-text',
      count: docRows.length,
      content: documentsContent,
    },
    { id: 'comm', label: 'Communications', icon: 'chat', content: commsContent },
    { id: 'activity', label: 'Activity', icon: 'pulse', content: activityContent },
  ];

  // ── Toolbar More menu ────────────────────────────────────────────────
  // Mirrors design v3 ENTITY_ACTIONS.load. Stub items (Duplicate / Print /
  // Export) toast for now; Cancel routes through the existing reason-code
  // modal; Delete uses the hard-confirm "type the order number" pattern.
  const loadActionGroups: RecordActionGroup[] = [
    {
      items: [
        { id: 'duplicate', label: 'Duplicate load', icon: 'copy' },
        { id: 'print', label: 'Print rate confirmation', icon: 'file-text' },
        { id: 'export', label: 'Export to CSV', icon: 'download' },
      ],
    },
    {
      items: [
        {
          id: 'cancel',
          label: 'Cancel load',
          icon: 'close',
          // The reason-code modal does its own confirmation, so we skip the
          // generic confirm here and hand off directly.
        },
        {
          id: 'archive',
          label: 'Archive load',
          icon: 'archive',
          confirm: 'soft',
          confirmTitle: 'Archive this load?',
          confirmBody:
            'Archived loads are hidden from default views but kept for records and reporting.',
          confirmCta: 'Archive',
        },
      ],
    },
    {
      items: [
        {
          id: 'delete',
          label: 'Delete load',
          icon: 'trash',
          danger: true,
          confirm: 'hard',
          confirmTitle: 'Delete load permanently?',
          confirmBody: (
            <>
              This permanently removes the load record. Trip history, documents, and audit log
              entries remain. <strong>This action cannot be undone.</strong>
            </>
          ),
          confirmCta: 'Delete permanently',
        },
      ],
    },
  ];

  const handleMenuAction = async (itemId: string) => {
    switch (itemId) {
      case 'duplicate':
        toast.message('Duplicate load — coming soon.');
        return;
      case 'print':
        toast.message('Print rate confirmation — coming soon.');
        return;
      case 'export':
        toast.message('Export to CSV — coming soon.');
        return;
      case 'cancel':
        setCancellationOpen(true);
        return;
      case 'archive':
        toast.message('Archive support is on the way.');
        return;
      case 'delete':
        await handleDelete();
        return;
    }
  };

  // ── Header subtitle ──────────────────────────────────────────────────
  const subtitleParts: string[] = [];
  if (origin?.city || origin?.state) {
    subtitleParts.push([origin?.city, origin?.state].filter(Boolean).join(', '));
  }
  if (finalDeliveryStop?.city || finalDeliveryStop?.state) {
    subtitleParts.push(
      [finalDeliveryStop?.city, finalDeliveryStop?.state].filter(Boolean).join(', '),
    );
  }
  const subtitle = (
    <span className="inline-flex items-center gap-2">
      <span>{subtitleParts.join(' → ') || '—'}</span>
      {loadData.equipmentType && (
        <>
          <span className="text-[var(--text-tertiary)]">·</span>
          <span>{loadData.equipmentType}</span>
        </>
      )}
    </span>
  );

  return (
    <>
      <DetailsFullPage
        breadcrumb={
          <span className="inline-flex items-center gap-1.5 text-[var(--text-secondary)]">
            <button
              type="button"
              onClick={() => router.push('/loads')}
              className="hover:text-foreground"
            >
              Loads
            </button>
            <span className="text-[var(--text-tertiary)]">/</span>
            <span className="text-foreground font-medium">Load #{loadData.orderNumber}</span>
          </span>
        }
        onBack={() => router.push('/loads')}
        toolbarActions={
          <>
            <WBtn size="sm" variant="ghost" leading="export">
              Export
            </WBtn>
            <WBtn size="sm" variant="ghost" leading="map" onClick={() => setMapOpen(true)}>
              Track
            </WBtn>
            <RecordActionsMenu
              recordLabel={loadData.orderNumber}
              groups={loadActionGroups}
              onAction={handleMenuAction}
            />
          </>
        }
        title={
          <span className="inline-flex items-center gap-3">
            <span>{`Load #${loadData.orderNumber}`}</span>
            <StatusPicker
              entity="load"
              currentId={statusId}
              onChange={handleStatusChange}
              label={statusChipLabel}
            />
          </span>
        }
        subtitle={subtitle}
        sections={sections}
        activeId={activeSection}
        onActiveChange={setActiveSection}
        rightRail={rightRail}
      />

      <LiveTrackingModal
        open={mapOpen}
        onOpenChange={(next) => {
          setMapOpen(next);
          // Drop any stop selection when the modal closes so the next open
          // fits the whole route instead of pin-zooming to a stale stop.
          if (!next) setSelectedStop(null);
        }}
        loadId={loadId}
        organizationId={organizationId}
        orderNumber={loadData.orderNumber}
        statusLabel={statusChipLabel}
        isInTransit={isInTransitChip}
        statusChip={
          isInTransitChip
            ? 'active'
            : loadData.status === 'Completed'
              ? 'delivered'
              : loadData.status === 'Canceled'
                ? 'cancelled'
                : 'pending'
        }
        tripState={
          loadData.status === 'Completed'
            ? 'delivered'
            : isInTransitChip
              ? 'in-transit'
              : 'pre-trip'
        }
        tripStartedAtMs={origin?.checkedInAt ? new Date(origin.checkedInAt).getTime() : null}
        tripEndedAtMs={
          finalDeliveryStop?.checkedInAt
            ? new Date(finalDeliveryStop.checkedInAt).getTime()
            : null
        }
        origin={originLabel}
        destination={destLabel}
        driver={
          loadData.assignedDriver
            ? {
                _id: loadData.assignedDriver._id,
                name: loadData.assignedDriver.name,
                // Synthetic shortcode until the driver record exposes a stable
                // human-readable ID — last 4 of the Convex id is good enough
                // to disambiguate between drivers in the rail.
                shortcode: `DRV-${loadData.assignedDriver._id.slice(-4).toUpperCase()}`,
              }
            : null
        }
        carrier={
          !loadData.assignedDriver && loadData.assignedCarrier?.companyName
            ? {
                name: loadData.assignedCarrier.companyName,
                mcNumber: loadData.assignedCarrier.mcNumber ?? undefined,
              }
            : null
        }
        equipment={{
          truck: loadData.assignedTruck?.unitId,
          trailer: loadData.assignedTrailer?.unitId,
          equipmentType: loadData.equipmentType,
        }}
        distanceMi={loadData.effectiveMiles ?? null}
        // Estimated duration: lean on a flat 60 mph average until route legs
        // surface a real ETA. Round to the nearest 5 minutes.
        durationLabel={(() => {
          if (!loadData.effectiveMiles) return null;
          const totalMin = Math.round((loadData.effectiveMiles / 60) * 60);
          const h = Math.floor(totalMin / 60);
          const m = Math.round((totalMin % 60) / 5) * 5;
          if (h === 0) return `${m}m`;
          return m === 0 ? `${h}h` : `${h}h ${m}m`;
        })()}
        events={(() => {
          const out: TimelineEvent[] = [];
          // Reverse chronological — the design shows newest at the top.
          // Each stop check-in / check-out becomes a timeline event.
          [...loadData.stops]
            .sort((a, b) => a.sequenceNumber - b.sequenceNumber)
            .forEach((s) => {
              const sw = s as StopWithEvidence;
              if (sw.checkedOutAt) {
                out.push({
                  id: `out-${sw._id}`,
                  title: sw.stopType === 'PICKUP' ? 'Departed pickup' : 'Departed stop',
                  detail: [sw.city, sw.state].filter(Boolean).join(', '),
                  time: formatTime(sw.checkedOutAt),
                  icon: 'arrow-up-right',
                  tone: 'neutral',
                });
              }
              if (sw.checkedInAt) {
                out.push({
                  id: `in-${sw._id}`,
                  title:
                    sw.stopType === 'PICKUP'
                      ? `Arrived at pickup #${sw.sequenceNumber}`
                      : `Arrived at delivery #${sw.sequenceNumber}`,
                  detail: [sw.city, sw.state].filter(Boolean).join(', '),
                  time: formatTime(sw.checkedInAt),
                  icon: 'check',
                  tone: 'ok',
                });
              }
            });
          if (isInTransitChip) {
            out.unshift({
              id: 'now',
              title: 'Now',
              detail: `In transit · ${transitProgressPct}% complete`,
              time: 'now',
              icon: 'pulse',
              tone: 'info',
              current: true,
            });
          }
          return out.reverse();
        })()}
        gpsPings={gpsPings}
        stops={loadData.stops
          .filter((s) => s.latitude && s.longitude)
          .map((s) => ({
            id: s._id,
            lat: s.latitude!,
            lng: s.longitude!,
            type: s.stopType === 'PICKUP' ? 'pickup' : 'delivery',
            sequenceNumber: s.sequenceNumber,
            status: s.status as 'Pending' | 'In Transit' | 'Completed' | undefined,
            city: s.city,
            state: s.state,
          }))}
        selectedStopId={selectedStop?._id}
        onStopSelect={(stopId) => {
          if (stopId) {
            const stop = loadData.stops.find((s) => s._id === stopId);
            if (stop) setSelectedStop(stop as StopWithEvidence);
          } else {
            setSelectedStop(null);
          }
        }}
        onExport={() => toast.message('Export tracking — coming soon.')}
        onShareEta={() => toast.message('Share ETA — coming soon.')}
      />

      <DocPreviewModal doc={previewDoc} onClose={() => setPreviewDoc(null)} />

      <PhotoLightbox
        photos={lightboxPhotos}
        isOpen={lightboxOpen}
        onClose={() => setLightboxOpen(false)}
        stopLabel={lightboxLabel}
      />

      <CancellationReasonModal
        open={cancellationOpen}
        onOpenChange={setCancellationOpen}
        loadCount={1}
        loads={[{ id: loadId, orderNumber: loadData.orderNumber }]}
        onConfirm={handleCancellationConfirm}
      />

      {reassignDialogOpen && loadData.assignedDriver?._id && (
        <ReassignDriverDialog
          open={reassignDialogOpen}
          onOpenChange={setReassignDialogOpen}
          loadId={loadId as Id<'loadInformation'>}
          fromDriverId={loadData.assignedDriver._id as Id<'drivers'>}
          fromDriverName={loadData.assignedDriver.name}
        />
      )}
    </>
  );
}

