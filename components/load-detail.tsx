'use client';

import { useState, useRef } from 'react';
import { useRouter } from 'next/navigation';
import { useMutation } from 'convex/react';
import { useAuthQuery } from '@/hooks/use-auth-query';
import { api } from '@/convex/_generated/api';
import { Card } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
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
import {
  ArrowLeft,
  Edit2,
  Trash2,
  FileText,
  Package,
  DollarSign,
  MapPin,
  Ruler,
  Clock,
  Check,
  Truck,
  Share2,
  Download,
  Camera,
  Paperclip,
  CheckCircle2,
  FileCheck,
  X,
  ChevronLeft,
  ChevronRight,
  ZoomIn,
  ZoomOut,
  Image as ImageIcon,
  Route,
} from 'lucide-react';
import Link from 'next/link';
import { Id } from '@/convex/_generated/dataModel';
import { DriverPaySection, CarrierPaySection } from '@/components/driver-pay';
import { LiveRouteMap } from '@/components/dispatch/live-route-map';
import { formatTimeWindow } from '@/lib/format-date-timezone';
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from '@/components/ui/tooltip';
import { cn } from '@/lib/utils';

interface LoadDetailProps {
  loadId: string;
  organizationId: string;
  userId: string;
}

// Types for stop data with evidence
interface StopWithEvidence {
  _id: string;
  sequenceNumber: number;
  stopType: 'PICKUP' | 'DELIVERY';
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
  const [isEditingStatus, setIsEditingStatus] = useState(false);
  const [selectedStatus, setSelectedStatus] = useState<'Open' | 'Assigned' | 'Canceled' | 'Completed'>('Open');
  const [deleteDialogOpen, setDeleteDialogOpen] = useState(false);
  const [selectedStop, setSelectedStop] = useState<StopWithEvidence | null>(null);
  const [lightboxOpen, setLightboxOpen] = useState(false);
  const [lightboxPhotos, setLightboxPhotos] = useState<string[]>([]);
  const [lightboxLabel, setLightboxLabel] = useState('');

  // Section refs for scroll-to navigation
  const manifestSectionRef = useRef<HTMLDivElement>(null);
  const paySectionRef = useRef<HTMLDivElement>(null);

  // Fetch load data
  const loadData = useAuthQuery(api.loads.getLoad, { loadId: loadId as Id<'loadInformation'> });
  const payablesData = useAuthQuery(api.loadPayables.getByLoad, { loadId: loadId as Id<'loadInformation'> });
  const invoiceData = useAuthQuery(api.invoices.getInvoiceByLoad, { loadId: loadId as Id<'loadInformation'> });
  
  const updateStatus = useMutation(api.loads.updateLoadStatus);
  const deleteLoad = useMutation(api.loads.deleteLoad);

  if (!loadData) {
    return (
      <div className="flex items-center justify-center py-12">
        <p className="text-muted-foreground">Loading load details...</p>
      </div>
    );
  }

  // Scroll to section handler
  const scrollToSection = (ref: React.RefObject<HTMLDivElement | null>) => {
    ref.current?.scrollIntoView({ behavior: 'smooth', block: 'start' });
  };

  const handleStatusUpdate = async () => {
    try {
      await updateStatus({
        loadId: loadId as Id<'loadInformation'>,
        status: selectedStatus,
      });
      setIsEditingStatus(false);
    } catch (error) {
      console.error('Failed to update status:', error);
      alert('Failed to update status');
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

  // Status badge styling
  const getStatusStyle = (status: string) => {
    switch (status) {
      case 'Open':
        return 'bg-yellow-50 text-yellow-700 border-yellow-200';
      case 'Assigned':
        return 'bg-blue-50 text-blue-700 border-blue-200';
      case 'Completed':
        return 'bg-green-50 text-green-700 border-green-200';
      case 'Canceled':
        return 'bg-red-50 text-red-700 border-red-200';
      default:
        return 'bg-gray-50 text-gray-700 border-gray-200';
    }
  };

  // Check if stop has evidence
  const hasEvidence = (stop: StopWithEvidence) => {
    return (stop.deliveryPhotos && stop.deliveryPhotos.length > 0) || 
           stop.signatureImage || 
           stop.driverNotes;
  };

  // Count evidence items for a stop
  const getEvidenceCount = (stop: StopWithEvidence) => {
    let count = 0;
    if (stop.deliveryPhotos) count += stop.deliveryPhotos.length;
    if (stop.signatureImage) count += 1;
    return count;
  };

  // Get POD status for completed loads
  const finalDeliveryStop = loadData.stops
    .filter(s => s.stopType === 'DELIVERY')
    .pop() as StopWithEvidence | undefined;

  const hasPOD = finalDeliveryStop && (
    (finalDeliveryStop.deliveryPhotos && finalDeliveryStop.deliveryPhotos.length > 0) ||
    finalDeliveryStop.signatureImage
  );

  // Calculate totals
  const totalPieces = loadData.stops.reduce((sum, stop) => sum + (stop.pieces || 0), 0);
  const origin = loadData.stops.find(s => s.stopType === 'PICKUP');

  // Open lightbox
  const openLightbox = (stop: StopWithEvidence) => {
    const photos: string[] = [];
    if (stop.deliveryPhotos) photos.push(...stop.deliveryPhotos);
    if (stop.signatureImage) photos.push(stop.signatureImage);
    
    if (photos.length > 0) {
      setLightboxPhotos(photos);
      setLightboxLabel(`Stop ${stop.sequenceNumber} - ${stop.city}, ${stop.state}`);
      setLightboxOpen(true);
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

  return (
    <div className="space-y-6">
      {/* ================================================================
          HEADER
          ================================================================ */}
      <div className="flex items-start justify-between">
        <div className="flex items-start gap-4">
          <Link href="/loads">
            <Button variant="ghost" size="icon" className="h-9 w-9 shrink-0">
              <ArrowLeft className="h-4 w-4" />
            </Button>
          </Link>
          <div>
            <div className="flex items-center gap-3">
              <h1 className="text-2xl font-bold tracking-tight">
                Load #{loadData.orderNumber}
              </h1>
              {isEditingStatus ? (
                <div className="flex items-center gap-2">
                  <Select value={selectedStatus} onValueChange={(value: any) => setSelectedStatus(value)}>
                    <SelectTrigger className="h-7 w-[130px] text-xs">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="Open">Open</SelectItem>
                      <SelectItem value="Assigned">Assigned</SelectItem>
                      <SelectItem value="Canceled">Canceled</SelectItem>
                      <SelectItem value="Completed">Completed</SelectItem>
                    </SelectContent>
                  </Select>
                  <Button size="sm" className="h-7 text-xs" onClick={handleStatusUpdate}>Save</Button>
                  <Button size="sm" variant="ghost" className="h-7 text-xs" onClick={() => setIsEditingStatus(false)}>Cancel</Button>
                </div>
              ) : (
                <Badge
                  variant="outline"
                  className={`cursor-pointer ${getStatusStyle(loadData.status)}`}
                  onClick={() => {
                    setSelectedStatus(loadData.status);
                    setIsEditingStatus(true);
                  }}
                >
                  {loadData.status}
                  <Edit2 className="h-2.5 w-2.5 ml-1.5" />
                </Badge>
              )}
            </div>
            <div className="flex items-center gap-4 mt-1 text-sm text-muted-foreground">
              <span>Internal ID: {loadData.internalId}</span>
              <span className="text-muted-foreground/50">•</span>
              <span>Customer: <span className="font-medium text-foreground">{loadData.customerName || 'Unknown'}</span></span>
              <span className="text-muted-foreground/50">•</span>
              <span>Fleet: {loadData.fleet}</span>
            </div>
          </div>
        </div>
        <div className="flex items-center gap-2">
          <Button variant="outline">
            <FileText className="mr-2 h-4 w-4" />
            Export
          </Button>
          <Button variant="destructive" onClick={() => setDeleteDialogOpen(true)}>
            <Trash2 className="mr-2 h-4 w-4" />
            Delete
          </Button>
        </div>
      </div>

      {/* ================================================================
          70/30 SPLIT LAYOUT
          ================================================================ */}
      <div className="flex gap-6">
        {/* ----------------------------------------------------------------
            MAIN CONTENT (70%)
            ---------------------------------------------------------------- */}
        <div className="flex-1 min-w-0 space-y-4">
          {/* ============================================================
              INSIGHT CARDS (Table of Contents)
              ============================================================ */}
          <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
            {/* Status Card */}
            <div className={`p-3 rounded-lg border ${getStatusStyle(loadData.status)}`}>
              <div className="flex items-center gap-2 mb-1">
                <Package className="h-4 w-4" />
                <span className="text-xs font-medium uppercase tracking-wide">Status</span>
              </div>
              <p className="text-sm font-semibold">{loadData.status}</p>
              <p className="text-xs mt-0.5 opacity-80">
                {loadData.trackingStatus || 'Pending'}
              </p>
            </div>

            {/* Financials Card - Click to scroll to Pay */}
            {(() => {
              const customerRate = invoiceData?.totalAmount ?? 0;
              const driverPay = payablesData?.total ?? 0;
              const margin = customerRate - driverPay;
              const marginPercent = customerRate > 0 ? (margin / customerRate) * 100 : 0;
              const hasData = customerRate > 0 || driverPay > 0;
              const isPositiveMargin = margin >= 0;
              
              return (
                <div 
                  className={cn(
                    'p-3 rounded-lg border cursor-pointer transition-all hover:ring-2 hover:ring-offset-1',
                    !hasData 
                      ? 'border-slate-200 bg-slate-50 text-slate-600 hover:ring-slate-300'
                      : isPositiveMargin
                        ? 'border-green-200 bg-green-50 text-green-700 hover:ring-green-300'
                        : 'border-red-200 bg-red-50 text-red-700 hover:ring-red-300'
                  )}
                  onClick={() => scrollToSection(paySectionRef)}
                >
                  <div className="flex items-center gap-2 mb-1">
                    <DollarSign className="h-4 w-4" />
                    <span className="text-xs font-medium uppercase tracking-wide">Financials</span>
                  </div>
                  {hasData ? (
                    <>
                      <p className="text-sm font-semibold">
                        ${margin.toFixed(2)} <span className="text-[10px] font-normal opacity-70">margin</span>
                      </p>
                      <p className="text-xs mt-0.5 opacity-80">
                        Click to view pay
                      </p>
                    </>
                  ) : (
                    <>
                      <p className="text-sm font-semibold">$0.00</p>
                      <p className="text-xs mt-0.5 opacity-80">Click to view pay</p>
                    </>
                  )}
                </div>
              );
            })()}

            {/* POD / Location Card - Click to scroll to Manifest */}
            {loadData.status === 'Completed' ? (
              <div 
                className={cn(
                  'p-3 rounded-lg border cursor-pointer transition-all hover:ring-2 hover:ring-offset-1',
                  hasPOD 
                    ? 'border-green-200 bg-green-50 text-green-700 hover:ring-green-300'
                    : 'border-amber-200 bg-amber-50 text-amber-700 hover:ring-amber-300'
                )}
                onClick={() => scrollToSection(manifestSectionRef)}
              >
                <div className="flex items-center gap-2 mb-1">
                  {hasPOD ? <FileCheck className="h-4 w-4" /> : <Camera className="h-4 w-4" />}
                  <span className="text-xs font-medium uppercase tracking-wide">POD</span>
                </div>
                {hasPOD ? (
                  <>
                    <p className="text-sm font-semibold flex items-center gap-1">
                      <CheckCircle2 className="h-3.5 w-3.5" />
                      Verified
                    </p>
                    <p className="text-xs mt-0.5 opacity-80">Click to view</p>
                  </>
                ) : (
                  <>
                    <p className="text-sm font-semibold">Missing</p>
                    <p className="text-xs mt-0.5 opacity-80">No photos</p>
                  </>
                )}
              </div>
            ) : (
              <div 
                className={cn(
                  'p-3 rounded-lg border cursor-pointer transition-all hover:ring-2 hover:ring-offset-1 hover:ring-blue-300',
                  'text-muted-foreground bg-muted border-border'
                )}
                onClick={() => scrollToSection(manifestSectionRef)}
              >
                <div className="flex items-center gap-2 mb-1">
                  <MapPin className="h-4 w-4" />
                  <span className="text-xs font-medium uppercase tracking-wide">Location</span>
                </div>
                <p className="text-sm font-semibold text-foreground truncate">
                  {origin?.city || 'Unknown'}, {origin?.state || ''}
                </p>
                <p className="text-xs mt-0.5 opacity-80">
                  Click to view manifest
                </p>
              </div>
            )}

            {/* Manifest Card */}
            <div className="p-3 rounded-lg border border-border bg-muted/30 text-muted-foreground">
              <div className="flex items-center gap-2 mb-1">
                <Ruler className="h-4 w-4" />
                <span className="text-xs font-medium uppercase tracking-wide">Manifest</span>
              </div>
              <p className="text-sm font-semibold text-foreground">
                {totalPieces} Pieces
              </p>
              <p className="text-xs mt-0.5">
                {loadData.effectiveMiles || '—'} Miles
              </p>
            </div>
          </div>

          {/* ============================================================
              MASTER JOURNEY (Plan + Reality in One Table)
              ============================================================ */}
          <div ref={manifestSectionRef}>
            <Card className="overflow-hidden !py-0 !gap-0">
              {/* Section Header */}
              <div className="flex items-center justify-between px-4 h-9 border-b bg-slate-50/50">
                <h3 className="text-sm font-semibold flex items-center gap-2">
                  <Clock className="h-4 w-4 text-muted-foreground" />
                  Manifest
                </h3>
                <span className="text-xs text-muted-foreground">{loadData.stops.length} stops</span>
              </div>
              {/* Table Header */}
              {loadData.stops.length > 0 && (
                <div className="grid grid-cols-[90px_1fr_140px_90px_70px_50px] gap-2 px-4 h-8 items-center text-[10px] font-medium text-muted-foreground uppercase tracking-wider border-b bg-slate-50/30">
                  <div>Stop</div>
                  <div>Location</div>
                  <div>Plan</div>
                  <div>Actual</div>
                  <div className="text-center">Perf</div>
                  <div className="text-center">Docs</div>
                </div>
              )}
              {/* Table Rows - 48px height each */}
              <div className="divide-y divide-slate-100">
                {loadData.stops.map((stop) => {
                  const stopWithEvidence = stop as StopWithEvidence;
                  const isCompleted = stop.status === 'Completed';
                  const isActive = stop.status === 'In Transit';
                  const isSelected = selectedStop?._id === stop._id;
                  const evidenceCount = getEvidenceCount(stopWithEvidence);
                  const hasNotes = !!stopWithEvidence.driverNotes;

                  // Time variance for arrival
                  // windowBeginTime can be either:
                  // - Full ISO string: "2025-01-08T12:25:00-08:00" (from FourKites)
                  // - Just time: "12:25" (from manual entry) - needs windowBeginDate
                  let scheduledTime = stop.windowBeginTime;
                  if (scheduledTime && !scheduledTime.includes('T') && stop.windowBeginDate) {
                    // Combine date + time for manual entries (assume local timezone)
                    scheduledTime = `${stop.windowBeginDate}T${scheduledTime}:00`;
                  }
                  const arrivalVariance = stopWithEvidence.checkedInAt
                    ? getTimeVariance(scheduledTime, stopWithEvidence.checkedInAt)
                    : null;

                  // Format planned window
                  const plannedWindow = formatTimeWindow(
                    stop.windowBeginDate || '',
                    stop.windowBeginTime,
                    stop.windowEndTime
                  );

                  return (
                    <div
                      key={stop._id}
                      className={cn(
                        'grid grid-cols-[90px_1fr_140px_90px_70px_50px] gap-2 px-4 items-center h-12 cursor-pointer transition-colors',
                        isSelected 
                          ? 'bg-blue-50/80 border-l-[3px] border-l-blue-500 pl-[13px]' 
                          : 'hover:bg-slate-50 border-l-[3px] border-l-transparent'
                      )}
                      onClick={() => setSelectedStop(stopWithEvidence)}
                    >
                      {/* Stop # & Type */}
                      <div className="flex items-center gap-1.5">
                        <span
                          className={cn(
                            'flex h-5 w-5 items-center justify-center rounded-full text-[10px] font-bold shrink-0',
                            isCompleted
                              ? 'bg-green-500 text-white'
                              : isActive
                                ? 'bg-blue-600 text-white'
                                : 'bg-slate-100 text-slate-600 border border-slate-200'
                          )}
                        >
                          {isCompleted ? <Check className="h-3 w-3" /> : stop.sequenceNumber}
                        </span>
                        <span
                          className={cn(
                            'text-[9px] font-bold uppercase px-1 py-0.5 rounded shrink-0',
                            stop.stopType === 'PICKUP'
                              ? 'bg-blue-50 text-blue-600'
                              : 'bg-green-50 text-green-600'
                          )}
                        >
                          {stop.stopType === 'PICKUP' ? 'Pickup' : 'Delivery'}
                        </span>
                      </div>

                      {/* Location - Full Address with City, State */}
                      <div className="text-sm text-slate-900 truncate">
                        <span className="font-medium">{stop.address}</span>
                        {stop.address && (stop.city || stop.state) && ', '}
                        <span className="text-slate-500">{stop.city}{stop.city && stop.state && ', '}{stop.state}</span>
                      </div>

                      {/* Plan (Muted) */}
                      <Tooltip>
                        <TooltipTrigger asChild>
                          <div className="text-[11px] text-slate-400 truncate cursor-help">
                            {plannedWindow.display}
                          </div>
                        </TooltipTrigger>
                        <TooltipContent>
                          <p>{plannedWindow.tooltip}</p>
                        </TooltipContent>
                      </Tooltip>

                      {/* Actual */}
                      <div className="text-[11px] text-slate-700">
                        {stopWithEvidence.checkedInAt ? (
                          <span>{formatTime(stopWithEvidence.checkedInAt)}</span>
                        ) : (
                          <span className="text-slate-300">—</span>
                        )}
                      </div>

                      {/* Performance Pill */}
                      <div className="flex justify-center">
                        {arrivalVariance ? (
                          <span
                            className={cn(
                              'text-[9px] font-bold px-1.5 py-0.5 rounded whitespace-nowrap',
                              arrivalVariance.isLate
                                ? 'bg-red-50 text-red-600'
                                : 'bg-green-50 text-green-600'
                            )}
                          >
                            {arrivalVariance.label}
                          </span>
                        ) : (
                          <span className="text-slate-300 text-[11px]">—</span>
                        )}
                      </div>

                      {/* Docs Indicator */}
                      <div className="flex items-center justify-center gap-0.5">
                        {evidenceCount > 0 && (
                          <Tooltip>
                            <TooltipTrigger asChild>
                              <span className="flex items-center gap-0.5 text-slate-400">
                                <Camera className="h-3.5 w-3.5" />
                                <span className="text-[10px] font-medium">{evidenceCount}</span>
                              </span>
                            </TooltipTrigger>
                            <TooltipContent>
                              <p>{evidenceCount} photo{evidenceCount > 1 ? 's' : ''}</p>
                            </TooltipContent>
                          </Tooltip>
                        )}
                        {hasNotes && (
                          <Tooltip>
                            <TooltipTrigger asChild>
                              <Paperclip className="h-3.5 w-3.5 text-amber-400" />
                            </TooltipTrigger>
                            <TooltipContent>
                              <p>Has note</p>
                            </TooltipContent>
                          </Tooltip>
                        )}
                        {evidenceCount === 0 && !hasNotes && (
                          <span className="text-slate-200 text-[11px]">—</span>
                        )}
                      </div>
                    </div>
                  );
                })}
              </div>

              {loadData.stops.length === 0 && (
                <div className="text-center py-8 text-muted-foreground">
                  <Package className="h-6 w-6 mx-auto mb-1.5 opacity-50" />
                  <p className="text-xs">No stops defined</p>
                </div>
              )}

              {/* Bottom spacing */}
              <div className="h-[5px]" />
            </Card>
          </div>

          {/* ASSIGNMENT WARNING */}
          {loadData.status === 'Open' && (
            <div className="flex items-center justify-between gap-4 p-3 rounded-lg border border-amber-300 bg-amber-50">
              <div className="flex items-center gap-3">
                <div className="flex h-8 w-8 items-center justify-center rounded-full bg-amber-100">
                  <Truck className="h-4 w-4 text-amber-600" />
                </div>
                <div>
                  <p className="text-sm font-medium text-amber-800">Load not assigned</p>
                  <p className="text-xs text-amber-600">Assign a resource to calculate driver pay</p>
                </div>
              </div>
              <Link href="/dispatch/planner">
                <Button size="sm" className="shrink-0">
                  Assign Resource
                </Button>
              </Link>
            </div>
          )}

          {/* ============================================================
              ROUTE TRACKING MAP
              Unified view showing:
              - Live driver location (green arrow) when tracking is active
              - GPS trail/polyline of the route traveled
              - Stop markers (pickup/delivery)
              ============================================================ */}
          <Card className="overflow-hidden !py-0 !gap-0">
            {/* Section Header */}
            <div className="flex items-center justify-between px-4 h-9 border-b bg-slate-50/50">
              <h3 className="text-sm font-semibold flex items-center gap-2">
                <Route className="h-4 w-4 text-muted-foreground" />
                Route Tracking
              </h3>
              <span className="text-xs text-muted-foreground">Live + History</span>
            </div>
            <div className="p-0">
              <LiveRouteMap
                loadId={loadId as Id<'loadInformation'>}
                organizationId={organizationId}
                driverId={loadData.assignedDriver?._id as Id<'drivers'> | undefined}
                height="350px"
                stops={loadData.stops
                  .filter(s => s.latitude && s.longitude)
                  .map(s => ({
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
                    const stop = loadData.stops.find(s => s._id === stopId);
                    if (stop) setSelectedStop(stop as StopWithEvidence);
                  } else {
                    setSelectedStop(null);
                  }
                }}
              />
            </div>
          </Card>

          {/* ============================================================
              PAY SECTION - Shows Carrier Pay or Driver Pay based on assignment
              ============================================================ */}
          <div ref={paySectionRef}>
            {loadData.assignedCarrier && !loadData.assignedDriver ? (
              <CarrierPaySection
                loadId={loadId as Id<'loadInformation'>}
                organizationId={organizationId}
              />
            ) : (
              <DriverPaySection
                loadId={loadId as Id<'loadInformation'>}
                organizationId={organizationId}
                userId={userId}
              />
            )}
          </div>
        </div>

        {/* ----------------------------------------------------------------
            SIDEBAR (30%) - Stop Inspector + Static Cards
            ---------------------------------------------------------------- */}
        <div className="w-72 shrink-0 hidden lg:block">
          <div className="sticky top-6 space-y-4">
            {/* ============================================================
                STOP INSPECTOR (Dynamic)
                ============================================================ */}
            {selectedStop && (
              <Card className="p-4 border-blue-200 bg-blue-50/30">
                <div className="flex items-center justify-between mb-3">
                  <h3 className="text-sm font-semibold flex items-center gap-2">
                    <Camera className="h-4 w-4 text-blue-600" />
                    Stop Evidence
                  </h3>
                  <Button
                    variant="ghost"
                    size="icon"
                    className="h-6 w-6"
                    onClick={() => setSelectedStop(null)}
                  >
                    <X className="h-3 w-3" />
                  </Button>
                </div>

                {/* Stop Info */}
                <div className="mb-3 pb-3 border-b border-blue-200">
                  <div className="flex items-center gap-2 mb-1">
                    <span className={cn(
                      'text-[10px] font-bold uppercase px-1.5 py-0.5 rounded',
                      selectedStop.stopType === 'PICKUP'
                        ? 'bg-blue-100 text-blue-700'
                        : 'bg-green-100 text-green-700'
                    )}>
                      Stop {selectedStop.sequenceNumber} • {selectedStop.stopType === 'PICKUP' ? 'Pickup' : 'Delivery'}
                    </span>
                  </div>
                  <p className="text-sm font-medium">
                    {selectedStop.city}, {selectedStop.state}
                  </p>

                  {/* Timestamps */}
                  {(selectedStop.checkedInAt || selectedStop.checkedOutAt) && (
                    <div className="mt-2 grid grid-cols-2 gap-2 text-xs">
                      <div>
                        <span className="text-slate-500 block">Arrived</span>
                        <span className="font-medium">{formatTime(selectedStop.checkedInAt)}</span>
                      </div>
                      <div>
                        <span className="text-slate-500 block">Departed</span>
                        <span className="font-medium">{formatTime(selectedStop.checkedOutAt)}</span>
                      </div>
                    </div>
                  )}
                </div>

                {/* Driver Note */}
                {selectedStop.driverNotes && (
                  <div className="mb-3">
                    <p className="text-[10px] font-medium text-slate-500 uppercase tracking-wider mb-1">
                      Driver Note
                    </p>
                    <div className="bg-white border border-slate-200 rounded p-2">
                      <p className="text-xs text-slate-700 leading-relaxed">
                        {selectedStop.driverNotes}
                      </p>
                    </div>
                  </div>
                )}

                {/* Photo Thumbnails */}
                {((selectedStop.deliveryPhotos && selectedStop.deliveryPhotos.length > 0) || selectedStop.signatureImage) && (
                  <div>
                    <p className="text-[10px] font-medium text-slate-500 uppercase tracking-wider mb-2">
                      Photos
                    </p>
                    <div className="grid grid-cols-3 gap-2">
                      {selectedStop.deliveryPhotos?.map((photo, idx) => (
                        <button
                          key={idx}
                          onClick={() => openLightbox(selectedStop)}
                          className="aspect-square rounded-lg overflow-hidden border border-slate-200 hover:border-blue-400 transition-colors bg-slate-100"
                        >
                          {/* eslint-disable-next-line @next/next/no-img-element */}
                          <img
                            src={photo}
                            alt={`Photo ${idx + 1}`}
                            className="h-full w-full object-cover"
                            loading="lazy"
                            onError={(e) => {
                              // Show placeholder on error
                              const target = e.target as HTMLImageElement;
                              target.style.display = 'none';
                              target.parentElement?.classList.add('flex', 'items-center', 'justify-center');
                              const placeholder = document.createElement('div');
                              placeholder.innerHTML = '<svg class="h-6 w-6 text-slate-400" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M4 16l4.586-4.586a2 2 0 012.828 0L16 16m-2-2l1.586-1.586a2 2 0 012.828 0L20 14m-6-6h.01M6 20h12a2 2 0 002-2V6a2 2 0 00-2-2H6a2 2 0 00-2 2v12a2 2 0 002 2z"></path></svg>';
                              target.parentElement?.appendChild(placeholder.firstChild!);
                            }}
                          />
                        </button>
                      ))}
                      {selectedStop.signatureImage && (
                        <button
                          onClick={() => openLightbox(selectedStop)}
                          className="aspect-square rounded-lg overflow-hidden border border-slate-200 hover:border-blue-400 transition-colors bg-white flex items-center justify-center"
                        >
                          {/* eslint-disable-next-line @next/next/no-img-element */}
                          <img
                            src={selectedStop.signatureImage}
                            alt="Signature"
                            className="h-full w-full object-contain p-2"
                            loading="lazy"
                          />
                        </button>
                      )}
                    </div>
                  </div>
                )}

                {/* No evidence */}
                {!hasEvidence(selectedStop) && !selectedStop.checkedInAt && (
                  <div className="text-center py-4 text-muted-foreground">
                    <ImageIcon className="h-6 w-6 mx-auto mb-1.5 opacity-50" />
                    <p className="text-xs">No evidence for this stop</p>
                  </div>
                )}
              </Card>
            )}

            {/* ============================================================
                STATIC CARDS
                ============================================================ */}
            {/* Cargo Details */}
            <Card className="p-4">
              <h3 className="text-sm font-semibold mb-3 flex items-center gap-2">
                <Package className="h-4 w-4 text-muted-foreground" />
                Cargo Details
              </h3>
              <div className="space-y-2.5 text-sm">
                <div className="flex justify-between">
                  <span className="text-muted-foreground">Commodity</span>
                  <span className="font-medium text-right max-w-[140px] truncate">
                    {loadData.commodityDescription || '—'}
                  </span>
                </div>
                <div className="flex justify-between">
                  <span className="text-muted-foreground">Weight</span>
                  <span className="font-medium">
                    {loadData.weight ? `${loadData.weight} ${loadData.units || 'lbs'}` : '—'}
                  </span>
                </div>
                <div className="flex justify-between">
                  <span className="text-muted-foreground">Equipment</span>
                  <span className="font-medium">{loadData.equipmentType || '—'}</span>
                </div>
                <div className="flex justify-between">
                  <span className="text-muted-foreground">PO Number</span>
                  <span className="font-medium">{loadData.poNumber || '—'}</span>
                </div>
                <div className="flex justify-between">
                  <span className="text-muted-foreground">Miles</span>
                  <span className="font-medium">{loadData.effectiveMiles || '—'}</span>
                </div>
              </div>
            </Card>

            {/* Assigned Resource */}
            <Card className="p-4">
              <h3 className="text-sm font-semibold mb-3 flex items-center gap-2">
                <Truck className="h-4 w-4 text-muted-foreground" />
                Assigned Resource
              </h3>
              {(loadData.assignedDriver || loadData.assignedCarrier) ? (
                <div className="space-y-2.5 text-sm">
                  {loadData.assignedDriver && (
                    <div className="flex justify-between">
                      <span className="text-muted-foreground">Driver</span>
                      <span className="font-medium truncate max-w-[140px]">
                        {loadData.assignedDriver.name}
                      </span>
                    </div>
                  )}
                  {loadData.assignedCarrier && (
                    <>
                      <div className="flex justify-between">
                        <span className="text-muted-foreground">Carrier</span>
                        <span className="font-medium truncate max-w-[140px]">
                          {loadData.assignedCarrier.companyName}
                        </span>
                      </div>
                      {(loadData.assignedCarrier as { driverName?: string }).driverName && (
                        <div className="flex justify-between">
                          <span className="text-muted-foreground">Carrier Driver</span>
                          <span className="font-medium truncate max-w-[140px]">
                            {(loadData.assignedCarrier as { driverName?: string }).driverName}
                          </span>
                        </div>
                      )}
                    </>
                  )}
                  <div className="flex justify-between">
                    <span className="text-muted-foreground">Truck</span>
                    <span className="font-medium">
                      {loadData.assignedTruck?.unitId || '—'}
                    </span>
                  </div>
                  <div className="flex justify-between">
                    <span className="text-muted-foreground">Trailer</span>
                    <span className="font-medium">
                      {loadData.assignedTrailer?.unitId || '—'}
                    </span>
                  </div>
                </div>
              ) : (
                <p className="text-sm text-muted-foreground">Not assigned</p>
              )}
            </Card>

            {/* Timestamps */}
            <Card className="p-4">
              <h3 className="text-sm font-semibold mb-3 flex items-center gap-2">
                <Clock className="h-4 w-4 text-muted-foreground" />
                Timestamps
              </h3>
              <div className="space-y-2.5 text-sm">
                <div className="flex justify-between">
                  <span className="text-muted-foreground">Created</span>
                  <span className="font-medium">{formatDateShort(loadData.createdAt)}</span>
                </div>
                <div className="flex justify-between">
                  <span className="text-muted-foreground">Updated</span>
                  <span className="font-medium">{formatDateShort(loadData.updatedAt)}</span>
                </div>
              </div>
            </Card>

            {/* Quick Actions */}
            <Card className="p-4">
              <h3 className="text-sm font-semibold mb-3">Quick Actions</h3>
              <div className="space-y-2">
                <Button variant="outline" size="sm" className="w-full justify-start">
                  <Download className="mr-2 h-3.5 w-3.5" />
                  Download BOL
                </Button>
                <Button variant="outline" size="sm" className="w-full justify-start">
                  <Share2 className="mr-2 h-3.5 w-3.5" />
                  Share Tracking
                </Button>
              </div>
            </Card>

            {/* Instructions */}
            {loadData.generalInstructions && (
              <Card className="p-4">
                <h3 className="text-sm font-semibold mb-2">Instructions</h3>
                <p className="text-xs text-muted-foreground leading-relaxed">
                  {loadData.generalInstructions}
                </p>
              </Card>
            )}
          </div>
        </div>
      </div>

      {/* ================================================================
          PHOTO LIGHTBOX
          ================================================================ */}
      <PhotoLightbox
        photos={lightboxPhotos}
        isOpen={lightboxOpen}
        onClose={() => setLightboxOpen(false)}
        stopLabel={lightboxLabel}
      />

      {/* ================================================================
          DELETE CONFIRMATION DIALOG
          ================================================================ */}
      <AlertDialog open={deleteDialogOpen} onOpenChange={setDeleteDialogOpen}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Delete Load?</AlertDialogTitle>
            <AlertDialogDescription>
              Are you sure you want to delete this load? This action cannot be undone. All associated stops
              will also be deleted.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction onClick={handleDelete} className="bg-red-600 hover:bg-red-700">
              Delete
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}
