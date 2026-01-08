'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { useQuery, useMutation } from 'convex/react';
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
  Calendar,
  Share2,
  Download,
  Scale,
  Box,
} from 'lucide-react';
import Link from 'next/link';
import { Id } from '@/convex/_generated/dataModel';
import { DriverPaySection } from '@/components/driver-pay';
import { formatTimeWindow } from '@/lib/format-date-timezone';
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from '@/components/ui/tooltip';

interface LoadDetailProps {
  loadId: string;
  organizationId: string;
  userId: string;
}

export function LoadDetail({ loadId, organizationId, userId }: LoadDetailProps) {
  const router = useRouter();
  const [isEditingStatus, setIsEditingStatus] = useState(false);
  const [selectedStatus, setSelectedStatus] = useState<'Open' | 'Assigned' | 'Canceled' | 'Completed'>('Open');
  const [deleteDialogOpen, setDeleteDialogOpen] = useState(false);

  // Fetch load data
  const loadData = useQuery(api.loads.getLoad, { loadId: loadId as Id<'loadInformation'> });
  
  // Fetch payables (driver pay) for this load
  const payablesData = useQuery(api.loadPayables.getByLoad, { loadId: loadId as Id<'loadInformation'> });
  
  // Fetch invoice (customer rate) for this load
  const invoiceData = useQuery(api.invoices.getInvoiceByLoad, { loadId: loadId as Id<'loadInformation'> });
  
  const updateStatus = useMutation(api.loads.updateLoadStatus);
  const deleteLoad = useMutation(api.loads.deleteLoad);

  if (!loadData) {
    return (
      <div className="flex items-center justify-center py-12">
        <p className="text-muted-foreground">Loading load details...</p>
      </div>
    );
  }

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

  const formatDateTime = (dateStr: string) => {
    if (!dateStr) return '—';
    try {
      const date = new Date(dateStr);
      return date.toLocaleString('en-US', {
        weekday: 'short',
        month: 'short',
        day: 'numeric',
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

  // Tracking status styling
  const getTrackingStyle = (status: string) => {
    switch (status) {
      case 'In Transit':
        return 'text-blue-600 bg-blue-50 border-blue-200';
      case 'Completed':
        return 'text-green-600 bg-green-50 border-green-200';
      case 'Delayed':
        return 'text-red-600 bg-red-50 border-red-200';
      default:
        return 'text-muted-foreground bg-muted border-border';
    }
  };

  // Calculate total pieces from stops
  const totalPieces = loadData.stops.reduce((sum, stop) => sum + (stop.pieces || 0), 0);

  // Get origin and destination
  const origin = loadData.stops.find(s => s.stopType === 'PICKUP');
  const destination = loadData.stops.filter(s => s.stopType === 'DELIVERY').pop();

  return (
    <div className="space-y-6">
      {/* ================================================================
          HEADER: Metadata Style (matches Driver page)
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
            {/* Muted metadata row */}
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
          {/* INSIGHT CARDS (4-card scannable row) */}
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

            {/* Financials Card - Customer Rate & Margin */}
            {(() => {
              const customerRate = invoiceData?.totalAmount ?? 0;
              const driverPay = payablesData?.total ?? 0;
              const margin = customerRate - driverPay;
              const marginPercent = customerRate > 0 ? (margin / customerRate) * 100 : 0;
              const hasData = customerRate > 0 || driverPay > 0;
              const isPositiveMargin = margin >= 0;
              
              return (
                <div className={`p-3 rounded-lg border ${
                  !hasData 
                    ? 'border-slate-200 bg-slate-50 text-slate-600'
                    : isPositiveMargin
                      ? 'border-green-200 bg-green-50 text-green-700'
                      : 'border-red-200 bg-red-50 text-red-700'
                }`}>
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
                        ${customerRate.toFixed(2)} - ${driverPay.toFixed(2)} ({marginPercent.toFixed(0)}%)
                      </p>
                    </>
                  ) : (
                    <>
                      <p className="text-sm font-semibold">$0.00</p>
                      <p className="text-xs mt-0.5 opacity-80">No invoice</p>
                    </>
                  )}
                </div>
              );
            })()}

            {/* Tracking/Location Card */}
            <div className={`p-3 rounded-lg border ${getTrackingStyle(loadData.trackingStatus)}`}>
              <div className="flex items-center gap-2 mb-1">
                <MapPin className="h-4 w-4" />
                <span className="text-xs font-medium uppercase tracking-wide">Location</span>
              </div>
              <p className="text-sm font-semibold truncate">
                {origin?.city || 'Unknown'}, {origin?.state || ''}
              </p>
              <p className="text-xs mt-0.5 opacity-80">
                {loadData.trackingStatus || 'Not started'}
              </p>
            </div>

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

          {/* TRIP ITINERARY (Compact Single-Line Rows) */}
          <Card className="p-4">
            <div className="flex items-center justify-between mb-3">
              <h3 className="text-sm font-semibold flex items-center gap-2">
                <Clock className="h-4 w-4 text-muted-foreground" />
                Trip Itinerary
              </h3>
              <span className="text-xs text-muted-foreground">{loadData.stops.length} stops</span>
            </div>

            {/* Compact Table Header */}
            {loadData.stops.length > 0 && (
              <div className="grid grid-cols-[32px_1fr_200px_80px_80px] gap-3 px-1 py-1.5 text-[10px] font-medium text-muted-foreground uppercase tracking-wider border-b">
                <div>#</div>
                <div>Location</div>
                <div>Window</div>
                <div className="text-center">Qty</div>
                <div>Status</div>
              </div>
            )}

            {/* Compact Stop Rows */}
            <div className="divide-y divide-slate-100">
              {loadData.stops.map((stop) => {
                const isCompleted = stop.status === 'Completed';
                const isActive = stop.status === 'In Transit';

                // Format window time is now handled by formatTimeWindow utility

                return (
                  <div
                    key={stop._id}
                    className="grid grid-cols-[32px_1fr_200px_80px_80px] gap-3 px-1 py-2 items-center text-sm hover:bg-slate-50 transition-colors"
                  >
                    {/* Stop # with status indicator */}
                    <div className="flex items-center justify-center">
                      <span
                        className={`flex h-5 w-5 items-center justify-center rounded-full text-[10px] font-bold ${
                          isCompleted
                            ? 'bg-green-500 text-white'
                            : isActive
                              ? 'bg-blue-600 text-white'
                              : 'bg-slate-100 text-slate-600 border border-slate-200'
                        }`}
                      >
                        {isCompleted ? <Check className="h-3 w-3" /> : stop.sequenceNumber}
                      </span>
                    </div>

                    {/* Location + Type */}
                    <div className="flex items-center gap-2 min-w-0">
                      <span className="font-medium text-slate-900 truncate">
                        {stop.city || 'Unknown'}, {stop.state || ''}
                      </span>
                      <span
                        className={`text-[9px] font-bold uppercase px-1 py-0.5 rounded shrink-0 ${
                          stop.stopType === 'PICKUP'
                            ? 'bg-blue-50 text-blue-600 border border-blue-200'
                            : 'bg-green-50 text-green-600 border border-green-200'
                        }`}
                      >
                        {stop.stopType === 'PICKUP' ? 'Pick' : 'Drop'}
                      </span>
                    </div>

                    {/* Date/Time Window */}
                    <div className="text-[11px] text-slate-500 whitespace-nowrap">
                      {(() => {
                        const formatted = formatTimeWindow(
                          stop.windowBeginDate || '',
                          stop.windowBeginTime,
                          stop.windowEndTime
                        );
                        return (
                          <Tooltip>
                            <TooltipTrigger asChild>
                              <span className="cursor-help">{formatted.display}</span>
                            </TooltipTrigger>
                            <TooltipContent>
                              <p>{formatted.tooltip}</p>
                            </TooltipContent>
                          </Tooltip>
                        );
                      })()}
                    </div>

                    {/* Pieces */}
                    <div className="text-xs text-slate-600 text-center">
                      {stop.pieces ? `${stop.pieces} pcs` : '—'}
                    </div>

                    {/* Status */}
                    <div>
                      {stop.status ? (
                        <Badge
                          variant="outline"
                          className={`text-[9px] py-0 px-1.5 ${
                            stop.status === 'Completed'
                              ? 'bg-green-50 text-green-700 border-green-200'
                              : stop.status === 'In Transit'
                                ? 'bg-blue-50 text-blue-700 border-blue-200'
                                : 'bg-slate-50 text-slate-500 border-slate-200'
                          }`}
                        >
                          {stop.status}
                        </Badge>
                      ) : (
                        <Badge variant="outline" className="text-[9px] py-0 px-1.5 bg-slate-50 text-slate-400 border-slate-200">
                          Pending
                        </Badge>
                      )}
                    </div>
                  </div>
                );
              })}
            </div>

            {loadData.stops.length === 0 && (
              <div className="text-center py-4 text-muted-foreground">
                <Package className="h-6 w-6 mx-auto mb-1.5 opacity-50" />
                <p className="text-xs">No stops defined</p>
              </div>
            )}
          </Card>

          {/* ASSIGNMENT WARNING (Amber - Pending Action) */}
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

          {/* DRIVER PAY SECTION */}
          <DriverPaySection
            loadId={loadId as Id<'loadInformation'>}
            organizationId={organizationId}
            userId={userId}
          />
        </div>

        {/* ----------------------------------------------------------------
            SIDEBAR (30%) - Static Load Information
            ---------------------------------------------------------------- */}
        <div className="w-72 shrink-0 hidden lg:block">
          <div className="sticky top-6 space-y-4">
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
                    <div className="flex justify-between">
                      <span className="text-muted-foreground">Carrier</span>
                      <span className="font-medium truncate max-w-[140px]">
                        {loadData.assignedCarrier.companyName}
                      </span>
                    </div>
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

            {/* Instructions (if any) */}
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

      {/* Delete Confirmation Dialog */}
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
