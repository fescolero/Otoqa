'use client';

import { useState, useMemo } from 'react';
import { useQuery, useMutation } from 'convex/react';
import { api } from '@/convex/_generated/api';
import { useAuthQuery } from '@/hooks/use-auth-query';
import { Id } from '@/convex/_generated/dataModel';
import { toast } from 'sonner';
import { format } from 'date-fns';

import { FilterToolbar, TripFiltersState } from './trip-filters';
import { OverlapNoticeModal, OverlapDetail } from './conflict-modal';
import { CarrierPartnership } from './assets-table';
import { CarrierAssignmentModal } from './carrier-assignment-modal';

import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Skeleton } from '@/components/ui/skeleton';
import { Tabs, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { Sheet, SheetContent, SheetTitle } from '@/components/ui/sheet';
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
import { ScrollArea } from '@/components/ui/scroll-area';
import { Separator } from '@/components/ui/separator';

import {
  Package,
  MapPin,
  Search,
  ArrowRight,
  Truck,
  Users,
  Building2,
  Clock,
  CheckCircle2,
  ChevronRight,
  ChevronLeft,
  X,
  AlertCircle,
  DollarSign,
} from 'lucide-react';
import { cn } from '@/lib/utils';
import { formatDateOnly } from '@/lib/format-date-timezone';

// ─── Types ───────────────────────────────────────────────────────────────────

interface MobileDispatchPlannerProps {
  organizationId: string;
  userId: string;
  userName: string;
  initialSearch?: string;
}

type SheetView = 'load-detail' | 'asset-select';
type AssetType = 'driver' | 'carrier';

interface DriverWithTruck {
  _id: Id<'drivers'>;
  firstName: string;
  lastName: string;
  email: string;
  phone: string;
  licenseState: string;
  city?: string;
  state?: string;
  assignedTruck: {
    _id: Id<'trucks'>;
    unitId: string;
    bodyType?: string;
    lastLocationLat?: number;
    lastLocationLng?: number;
    lastLocationUpdatedAt?: number;
  } | null;
  overlap?: {
    overlapMinutes: number;
    orderNumber?: string;
    loadId: string;
  } | null;
}

// ─── Status helpers ───────────────────────────────────────────────────────────

function getStatusColor(status: string) {
  switch (status) {
    case 'Completed':
    case 'Delivered':
      return 'bg-green-100 text-green-800 border-green-200';
    case 'Assigned':
      return 'bg-blue-100 text-blue-800 border-blue-200';
    case 'Open':
      return 'bg-yellow-100 text-yellow-800 border-yellow-200';
    case 'Expired':
      return 'bg-orange-100 text-orange-800 border-orange-200';
    case 'Canceled':
      return 'bg-gray-100 text-gray-800 border-gray-200';
    default:
      return 'bg-gray-100 text-gray-800 border-gray-200';
  }
}

// ─── Main Component ───────────────────────────────────────────────────────────

export function MobileDispatchPlanner({
  organizationId,
  userId,
  userName,
  initialSearch,
}: MobileDispatchPlannerProps) {
  // Filter state
  const [filters, setFilters] = useState<TripFiltersState>({
    search: initialSearch ?? '',
    hcr: '',
    tripNumber: '',
    startDate: '',
    endDate: '',
  });
  const [localSearch, setLocalSearch] = useState(initialSearch ?? '');
  const [statusFilter, setStatusFilter] = useState<string>('Open');

  // Sheet state
  const [sheetOpen, setSheetOpen] = useState(false);
  const [sheetView, setSheetView] = useState<SheetView>('load-detail');
  const [selectedLoadId, setSelectedLoadId] = useState<Id<'loadInformation'> | null>(null);

  // Asset type (driver vs carrier)
  const [assetType, setAssetType] = useState<AssetType>('driver');

  // Driver selection & confirmation
  const [pendingDriverId, setPendingDriverId] = useState<Id<'drivers'> | null>(null);
  const [confirmOpen, setConfirmOpen] = useState(false);
  const [isAssigning, setIsAssigning] = useState(false);

  // Carrier assignment modal
  const [pendingCarrierId, setPendingCarrierId] = useState<Id<'carrierPartnerships'> | null>(null);
  const [carrierModalOpen, setCarrierModalOpen] = useState(false);

  // Overlap state
  const [showOverlapNotice, setShowOverlapNotice] = useState(false);
  const [overlapData, setOverlapData] = useState<OverlapDetail[]>([]);
  const [overlapDriverName, setOverlapDriverName] = useState('');

  // ── Queries ────────────────────────────────────────────────────────────────

  const filterValues = useAuthQuery(api.loads.getDistinctFilterValues, {
    workosOrgId: organizationId,
  });

  const loadCounts = useAuthQuery(api.loads.countLoadsByStatus, {
    workosOrgId: organizationId,
  });

  const loadsData = useAuthQuery(api.loads.getLoads, {
    workosOrgId: organizationId,
    status: statusFilter as 'Open' | 'Assigned' | 'Completed' | 'Canceled',
    search: filters.search || undefined,
    hcr: filters.hcr || undefined,
    tripNumber: filters.tripNumber || undefined,
    startDate: filters.startDate || undefined,
    endDate: filters.endDate || undefined,
    paginationOpts: { numItems: 100, cursor: null },
  });

  const loadDetails = useQuery(
    api.loads.getByIdWithRange,
    selectedLoadId ? { loadId: selectedLoadId } : 'skip'
  );

  const availableDrivers = useQuery(
    api.dispatchLegs.getAvailableDrivers,
    loadDetails?.startTime
      ? {
          workosOrgId: organizationId,
          startTime: loadDetails.startTime,
          endTime: loadDetails.endTime!,
          excludeLoadId: selectedLoadId ?? undefined,
        }
      : 'skip'
  );

  const allDrivers = useAuthQuery(api.dispatchLegs.getAllActiveDrivers, {
    workosOrgId: organizationId,
  });

  const activeCarriers = useAuthQuery(api.carrierPartnerships.getActiveForDispatch, {
    brokerOrgId: organizationId,
  });

  // ── Derived data ────────────────────────────────────────────────────────────

  const loads = loadsData?.page ?? [];
  const isLoadingLoads = loadsData === undefined;
  const driversToShow: DriverWithTruck[] =
    loadDetails?.startTime != null ? (availableDrivers ?? []) : (allDrivers ?? []);

  const pendingDriver = useMemo(() => {
    if (!pendingDriverId) return null;
    return driversToShow.find((d) => d._id === pendingDriverId) ?? null;
  }, [pendingDriverId, driversToShow]);

  const pendingCarrier = useMemo((): CarrierPartnership | null => {
    if (!pendingCarrierId || !activeCarriers) return null;
    return activeCarriers.find((c) => c._id === pendingCarrierId) ?? null;
  }, [pendingCarrierId, activeCarriers]);

  // ── Mutations ───────────────────────────────────────────────────────────────

  const assignDriverMutation = useMutation(api.dispatchLegs.assignDriver);

  // ── Handlers ────────────────────────────────────────────────────────────────

  const handleLoadTap = (loadId: Id<'loadInformation'>) => {
    setSelectedLoadId(loadId);
    setSheetView('load-detail');
    setSheetOpen(true);
  };

  const handleOpenAssetSelect = () => {
    setSheetView('asset-select');
  };

  const handleBackToDetail = () => {
    setSheetView('load-detail');
    setPendingDriverId(null);
    setPendingCarrierId(null);
  };

  const handleSheetClose = () => {
    setSheetOpen(false);
    setSheetView('load-detail');
    setPendingDriverId(null);
    setPendingCarrierId(null);
  };

  const handleDriverTap = (driverId: Id<'drivers'>) => {
    setPendingDriverId(driverId);
    setConfirmOpen(true);
  };

  const handleCarrierTap = (carrierId: Id<'carrierPartnerships'>) => {
    setPendingCarrierId(carrierId);
    // Close the sheet first, then open carrier modal
    setSheetOpen(false);
    setCarrierModalOpen(true);
  };

  const handleConfirmAssign = async () => {
    if (!selectedLoadId || !pendingDriverId) return;
    setIsAssigning(true);

    try {
      const result = await assignDriverMutation({
        loadId: selectedLoadId,
        driverId: pendingDriverId,
        truckId: pendingDriver?.assignedTruck?._id,
        userId,
        userName,
        workosOrgId: organizationId,
      });

      if (result.status === 'ERROR') {
        toast.error(result.message);
        return;
      }

      const driverName = pendingDriver
        ? `${pendingDriver.firstName} ${pendingDriver.lastName}`
        : '';

      if (result.overlaps && result.overlaps.length > 0) {
        setOverlapData(result.overlaps);
        setOverlapDriverName(driverName);
        setShowOverlapNotice(true);
        toast.success(`Assigned to ${driverName} (schedule overlap detected)`);
      } else {
        toast.success(`Assigned to ${driverName}`);
      }

      handleSheetClose();
    } catch (error) {
      console.error('Assignment error:', error);
      toast.error('Failed to assign. Please try again.');
    } finally {
      setIsAssigning(false);
      setConfirmOpen(false);
      setPendingDriverId(null);
    }
  };

  const handleCarrierAssignSuccess = () => {
    setPendingCarrierId(null);
    setCarrierModalOpen(false);
  };

  const handleStatusChange = (value: string) => {
    setStatusFilter(value);
    setSelectedLoadId(null);
  };

  const handleSearchChange = (value: string) => {
    setLocalSearch(value);
    setFilters((f) => ({ ...f, search: value }));
  };

  const handleQuickFilter = (hours: 24 | 48 | 72) => {
    const now = new Date();
    const endDate = new Date(now.getTime() + hours * 60 * 60 * 1000);
    setFilters((f) => ({
      ...f,
      startDate: format(now, 'yyyy-MM-dd'),
      endDate: format(endDate, 'yyyy-MM-dd'),
    }));
  };

  // ── Render ──────────────────────────────────────────────────────────────────

  return (
    <div className="flex flex-col h-[calc(100dvh-64px)] overflow-hidden bg-background">
      {/* Filter toolbar — scrolls horizontally on mobile */}
      <FilterToolbar
        filters={filters}
        onFiltersChange={setFilters}
        availableHCRs={filterValues?.hcrs ?? []}
        availableTrips={filterValues?.trips ?? []}
      />

      {/* Search + quick filters */}
      <div className="flex flex-col gap-2 px-3 pt-3 pb-2 shrink-0">
        <div className="relative">
          <Search className="absolute left-2.5 top-2.5 h-4 w-4 text-muted-foreground" />
          <Input
            placeholder="Search by order #..."
            className="pl-9 h-9"
            value={localSearch}
            onChange={(e) => handleSearchChange(e.target.value)}
          />
          {localSearch && (
            <button
              className="absolute right-2.5 top-2.5 text-muted-foreground"
              onClick={() => handleSearchChange('')}
            >
              <X className="h-4 w-4" />
            </button>
          )}
        </div>

        {/* Quick date filters */}
        <div className="flex gap-2">
          {([24, 48, 72] as const).map((h) => (
            <Button
              key={h}
              variant="outline"
              size="sm"
              className="flex-1 h-8 text-xs"
              onClick={() => handleQuickFilter(h)}
            >
              Next {h}h
            </Button>
          ))}
        </div>
      </div>

      {/* Status tabs */}
      <div className="px-3 pb-2 shrink-0">
        <Tabs value={statusFilter} onValueChange={handleStatusChange}>
          <TabsList className="w-full">
            <TabsTrigger
              value="Open"
              className="flex-1 data-[state=active]:bg-primary data-[state=active]:text-primary-foreground"
            >
              Open {loadCounts?.Open !== undefined ? `(${loadCounts.Open})` : ''}
            </TabsTrigger>
            <TabsTrigger
              value="Assigned"
              className="flex-1 data-[state=active]:bg-primary data-[state=active]:text-primary-foreground"
            >
              Assigned {loadCounts?.Assigned !== undefined ? `(${loadCounts.Assigned})` : ''}
            </TabsTrigger>
          </TabsList>
        </Tabs>
      </div>

      {/* Load list */}
      <div className="flex-1 min-h-0 overflow-y-auto px-3 pb-4 space-y-2">
        {isLoadingLoads && (
          <div className="space-y-2 pt-1">
            {[...Array(6)].map((_, i) => (
              <Skeleton key={i} className="h-20 w-full rounded-lg" />
            ))}
          </div>
        )}

        {!isLoadingLoads && loads.length === 0 && (
          <div className="flex flex-col items-center justify-center py-16 text-muted-foreground">
            <Package className="h-12 w-12 mb-3 opacity-40" />
            <p className="text-sm">No {statusFilter.toLowerCase()} loads found</p>
          </div>
        )}

        {!isLoadingLoads &&
          loads.map((load) => (
            <button
              key={load._id}
              onClick={() => handleLoadTap(load._id)}
              className="w-full text-left rounded-lg border bg-card p-3 shadow-sm active:bg-muted/60 transition-colors"
            >
              <div className="flex items-start justify-between gap-2 mb-1.5">
                <div className="flex items-center gap-2 min-w-0">
                  <span className="font-semibold text-sm truncate">
                    {load.orderNumber || load.internalId}
                  </span>
                  {load.equipmentType && (
                    <Badge variant="outline" className="text-xs shrink-0">
                      {load.equipmentType}
                    </Badge>
                  )}
                </div>
                <div className="flex items-center gap-1.5 shrink-0">
                  <Badge className={cn('text-xs border', getStatusColor(load.status))}>
                    {load.status}
                  </Badge>
                  <ChevronRight className="h-4 w-4 text-muted-foreground" />
                </div>
              </div>

              {load.customerName && (
                <p className="text-xs text-muted-foreground mb-1.5 truncate">{load.customerName}</p>
              )}

              <div className="flex items-center gap-1.5 text-sm text-muted-foreground">
                <MapPin className="h-3.5 w-3.5 shrink-0" />
                <span className="truncate">
                  {load.origin?.city || '—'}, {load.origin?.state || ''}
                </span>
                <ArrowRight className="h-3.5 w-3.5 shrink-0" />
                <span className="truncate">
                  {load.destination?.city || '—'}, {load.destination?.state || ''}
                </span>
              </div>

              <div className="flex items-center gap-3 mt-1.5 text-xs text-muted-foreground">
                {load.effectiveMiles != null && <span>{load.effectiveMiles} mi</span>}
                {load.firstStopDate && (
                  <span>Pickup: {formatDateOnly(load.firstStopDate).display}</span>
                )}
              </div>
            </button>
          ))}
      </div>

      {/* ── Load Detail / Asset Select Sheet ──────────────────────────────── */}
      <Sheet open={sheetOpen} onOpenChange={(open) => { if (!open) handleSheetClose(); }}>
        <SheetContent side="bottom" className="h-[85dvh] flex flex-col p-0 rounded-t-2xl">
          {sheetView === 'load-detail' ? (
            <LoadDetailView
              loadDetails={loadDetails ?? null}
              onAssignAsset={handleOpenAssetSelect}
              onClose={handleSheetClose}
            />
          ) : (
            <AssetSelectView
              drivers={driversToShow}
              carriers={activeCarriers ?? []}
              loadDetails={loadDetails ?? null}
              assetType={assetType}
              onAssetTypeChange={setAssetType}
              onDriverTap={handleDriverTap}
              onCarrierTap={handleCarrierTap}
              onBack={handleBackToDetail}
            />
          )}
        </SheetContent>
      </Sheet>

      {/* ── Confirm Driver Assignment Dialog ──────────────────────────────── */}
      <AlertDialog open={confirmOpen} onOpenChange={setConfirmOpen}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Confirm Assignment</AlertDialogTitle>
            <AlertDialogDescription>
              Assign{' '}
              <strong>
                {pendingDriver
                  ? `${pendingDriver.firstName} ${pendingDriver.lastName}`
                  : 'this driver'}
              </strong>{' '}
              to load{' '}
              <strong>{loadDetails?.orderNumber ?? loadDetails?.internalId ?? '—'}</strong>?
              {pendingDriver?.overlap && (
                <span className="block mt-2 text-amber-600">
                  <AlertCircle className="inline h-4 w-4 mr-1" />
                  This driver has a {pendingDriver.overlap.overlapMinutes}m schedule overlap.
                </span>
              )}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={isAssigning}>Cancel</AlertDialogCancel>
            <AlertDialogAction onClick={handleConfirmAssign} disabled={isAssigning}>
              {isAssigning ? 'Assigning…' : 'Assign'}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      {/* ── Carrier Assignment Modal ───────────────────────────────────────── */}
      <CarrierAssignmentModal
        open={carrierModalOpen}
        onOpenChange={setCarrierModalOpen}
        carrier={pendingCarrier}
        load={
          loadDetails
            ? {
                _id: loadDetails._id,
                orderNumber: loadDetails.orderNumber,
                effectiveMiles: loadDetails.effectiveMiles,
                customerName: loadDetails.customerName,
              }
            : null
        }
        organizationId={organizationId}
        userId={userId}
        onSuccess={handleCarrierAssignSuccess}
      />

      {/* ── Overlap Notice ─────────────────────────────────────────────────── */}
      <OverlapNoticeModal
        open={showOverlapNotice}
        onOpenChange={setShowOverlapNotice}
        overlaps={overlapData}
        driverName={overlapDriverName}
        onDismiss={() => {
          setShowOverlapNotice(false);
          setOverlapData([]);
          setOverlapDriverName('');
        }}
      />
    </div>
  );
}

// ─── Load Detail View ─────────────────────────────────────────────────────────

interface LoadDetailViewProps {
  loadDetails: {
    _id: Id<'loadInformation'>;
    orderNumber: string;
    internalId: string;
    customerName?: string;
    status?: string;
    equipmentType?: string;
    effectiveMiles?: number;
    startTime: number | null;
    endTime: number | null;
    origin?: { city?: string; state?: string; address?: string } | null;
    destination?: { city?: string; state?: string; address?: string } | null;
    assignedDriver?: { _id: Id<'drivers'>; name: string; phone?: string } | null;
  } | null;
  onAssignAsset: () => void;
  onClose: () => void;
}

function LoadDetailView({ loadDetails, onAssignAsset, onClose }: LoadDetailViewProps) {
  if (!loadDetails) {
    return (
      <div className="flex-1 flex flex-col">
        <div className="flex items-center justify-between px-4 py-3 border-b">
          <SheetTitle className="text-base">Load Details</SheetTitle>
          <button onClick={onClose} className="text-muted-foreground">
            <X className="h-5 w-5" />
          </button>
        </div>
        <div className="flex-1 flex items-center justify-center">
          <div className="space-y-3 w-full px-4">
            <Skeleton className="h-6 w-1/2" />
            <Skeleton className="h-4 w-3/4" />
            <Skeleton className="h-4 w-2/3" />
          </div>
        </div>
      </div>
    );
  }

  const isAssigned = loadDetails.assignedDriver != null || loadDetails.status === 'Assigned';
  const pickupTime = loadDetails.startTime
    ? format(new Date(loadDetails.startTime), 'MMM d, yyyy')
    : null;

  return (
    <div className="flex flex-col h-full">
      {/* Header */}
      <div className="flex items-center justify-between px-4 py-3 border-b shrink-0">
        <SheetTitle className="text-base font-semibold">
          {loadDetails.orderNumber || loadDetails.internalId}
        </SheetTitle>
        <div className="flex items-center gap-2">
          {loadDetails.status && (
            <Badge className={cn('text-xs border', getStatusColor(loadDetails.status))}>
              {loadDetails.status}
            </Badge>
          )}
          <button onClick={onClose} className="text-muted-foreground ml-1">
            <X className="h-5 w-5" />
          </button>
        </div>
      </div>

      {/* Scrollable details */}
      <ScrollArea className="flex-1">
        <div className="px-4 py-4 space-y-4">
          {loadDetails.customerName && (
            <div>
              <p className="text-xs text-muted-foreground uppercase tracking-wide mb-0.5">Customer</p>
              <p className="text-sm font-medium">{loadDetails.customerName}</p>
            </div>
          )}

          <Separator />

          {/* Route */}
          <div>
            <p className="text-xs text-muted-foreground uppercase tracking-wide mb-2">Route</p>
            <div className="flex items-start gap-3">
              <div className="flex flex-col items-center mt-1">
                <div className="h-2.5 w-2.5 rounded-full bg-green-500" />
                <div className="w-px flex-1 min-h-[2rem] bg-border mx-auto" />
                <div className="h-2.5 w-2.5 rounded-full bg-red-500" />
              </div>
              <div className="flex-1 space-y-3">
                <div>
                  <p className="text-sm font-medium">
                    {loadDetails.origin?.city}, {loadDetails.origin?.state}
                  </p>
                  {loadDetails.origin?.address && (
                    <p className="text-xs text-muted-foreground">{loadDetails.origin.address}</p>
                  )}
                </div>
                <div>
                  <p className="text-sm font-medium">
                    {loadDetails.destination?.city}, {loadDetails.destination?.state}
                  </p>
                  {loadDetails.destination?.address && (
                    <p className="text-xs text-muted-foreground">{loadDetails.destination.address}</p>
                  )}
                </div>
              </div>
            </div>
          </div>

          <Separator />

          {/* Details grid */}
          <div className="grid grid-cols-2 gap-3">
            {loadDetails.effectiveMiles != null && (
              <div>
                <p className="text-xs text-muted-foreground uppercase tracking-wide mb-0.5">Miles</p>
                <p className="text-sm font-medium">{loadDetails.effectiveMiles} mi</p>
              </div>
            )}
            {loadDetails.equipmentType && (
              <div>
                <p className="text-xs text-muted-foreground uppercase tracking-wide mb-0.5">Equipment</p>
                <Badge variant="outline" className="text-xs">{loadDetails.equipmentType}</Badge>
              </div>
            )}
            {pickupTime && (
              <div>
                <p className="text-xs text-muted-foreground uppercase tracking-wide mb-0.5">Pickup</p>
                <p className="text-sm font-medium">{pickupTime}</p>
              </div>
            )}
          </div>

          {/* Current assignment */}
          {loadDetails.assignedDriver && (
            <>
              <Separator />
              <div>
                <p className="text-xs text-muted-foreground uppercase tracking-wide mb-2">Assigned Driver</p>
                <div className="flex items-center gap-2 p-3 rounded-lg bg-blue-50 border border-blue-200">
                  <CheckCircle2 className="h-4 w-4 text-blue-600 shrink-0" />
                  <div className="min-w-0">
                    <p className="text-sm font-medium text-blue-900">{loadDetails.assignedDriver.name}</p>
                    {loadDetails.assignedDriver.phone && (
                      <p className="text-xs text-blue-600">{loadDetails.assignedDriver.phone}</p>
                    )}
                  </div>
                </div>
              </div>
            </>
          )}
        </div>
      </ScrollArea>

      {/* Action button */}
      <div className="px-4 py-4 border-t shrink-0">
        <Button className="w-full" size="lg" onClick={onAssignAsset}>
          <Users className="h-4 w-4 mr-2" />
          {isAssigned ? 'Reassign' : 'Assign Driver or Carrier'}
        </Button>
      </div>
    </div>
  );
}

// ─── Asset Select View (Driver + Carrier tabs) ────────────────────────────────

interface AssetSelectViewProps {
  drivers: DriverWithTruck[];
  carriers: CarrierPartnership[];
  loadDetails: { equipmentType?: string } | null;
  assetType: AssetType;
  onAssetTypeChange: (type: AssetType) => void;
  onDriverTap: (driverId: Id<'drivers'>) => void;
  onCarrierTap: (carrierId: Id<'carrierPartnerships'>) => void;
  onBack: () => void;
}

function AssetSelectView({
  drivers,
  carriers,
  loadDetails,
  assetType,
  onAssetTypeChange,
  onDriverTap,
  onCarrierTap,
  onBack,
}: AssetSelectViewProps) {
  const [search, setSearch] = useState('');

  const filteredDrivers = useMemo(() => {
    if (!search.trim()) return drivers;
    const q = search.toLowerCase();
    return drivers.filter(
      (d) =>
        d.firstName.toLowerCase().includes(q) ||
        d.lastName.toLowerCase().includes(q) ||
        d.assignedTruck?.unitId?.toLowerCase().includes(q)
    );
  }, [drivers, search]);

  const filteredCarriers = useMemo(() => {
    if (!search.trim()) return carriers;
    const q = search.toLowerCase();
    return carriers.filter(
      (c) =>
        c.carrierName.toLowerCase().includes(q) ||
        c.mcNumber.toLowerCase().includes(q) ||
        c.contactFirstName?.toLowerCase().includes(q) ||
        c.contactLastName?.toLowerCase().includes(q)
    );
  }, [carriers, search]);

  const isEquipmentMatch = (bodyType?: string) => {
    if (!loadDetails?.equipmentType || !bodyType) return false;
    return bodyType.toLowerCase() === loadDetails.equipmentType.toLowerCase();
  };

  return (
    <div className="flex flex-col h-full">
      {/* Header */}
      <div className="flex items-center gap-3 px-4 py-3 border-b shrink-0">
        <button onClick={onBack} className="text-muted-foreground shrink-0">
          <ChevronLeft className="h-5 w-5" />
        </button>
        <SheetTitle className="text-base font-semibold flex-1">Assign To</SheetTitle>
      </div>

      {/* Driver / Carrier tabs */}
      <div className="px-4 pt-3 pb-2 shrink-0">
        <Tabs value={assetType} onValueChange={(v) => { onAssetTypeChange(v as AssetType); setSearch(''); }}>
          <TabsList className="w-full">
            <TabsTrigger value="driver" className="flex-1">
              <Users className="h-4 w-4 mr-1.5" />
              Drivers ({drivers.length})
            </TabsTrigger>
            <TabsTrigger value="carrier" className="flex-1">
              <Building2 className="h-4 w-4 mr-1.5" />
              Carriers ({carriers.length})
            </TabsTrigger>
          </TabsList>
        </Tabs>
      </div>

      {/* Search */}
      <div className="px-4 pb-2 shrink-0">
        <div className="relative">
          <Search className="absolute left-2.5 top-2.5 h-4 w-4 text-muted-foreground" />
          <Input
            placeholder={assetType === 'driver' ? 'Search drivers...' : 'Search carriers...'}
            className="pl-9 h-9"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
          />
        </div>
      </div>

      {/* List */}
      <ScrollArea className="flex-1">
        <div className="py-1">
          {assetType === 'driver' ? (
            <>
              {filteredDrivers.length === 0 && (
                <div className="flex flex-col items-center justify-center py-12 text-muted-foreground">
                  <Users className="h-10 w-10 mb-2 opacity-40" />
                  <p className="text-sm">No drivers found</p>
                </div>
              )}
              {filteredDrivers.map((driver) => {
                const hasOverlap = !!driver.overlap;
                const equipMatch = isEquipmentMatch(driver.assignedTruck?.bodyType);

                return (
                  <button
                    key={driver._id}
                    onClick={() => onDriverTap(driver._id)}
                    className={cn(
                      'w-full text-left px-4 py-3 border-b flex items-center gap-3 active:bg-muted/60 transition-colors',
                      hasOverlap && 'bg-amber-50/60'
                    )}
                  >
                    <div className="h-9 w-9 rounded-full bg-muted flex items-center justify-center shrink-0 text-sm font-semibold text-muted-foreground">
                      {driver.firstName[0]}{driver.lastName[0]}
                    </div>
                    <div className="flex-1 min-w-0">
                      <div className="flex items-center gap-1.5 flex-wrap">
                        <span className="text-sm font-medium">
                          {driver.firstName} {driver.lastName}
                        </span>
                        {hasOverlap && (
                          <Badge
                            variant="outline"
                            className="text-[10px] px-1 h-4 bg-amber-100 text-amber-700 border-amber-200"
                          >
                            <Clock className="h-2.5 w-2.5 mr-0.5" />
                            {driver.overlap!.overlapMinutes}m overlap
                          </Badge>
                        )}
                      </div>
                      <div className="flex items-center gap-2 mt-0.5 text-xs text-muted-foreground flex-wrap">
                        {driver.assignedTruck?.unitId && (
                          <span className="flex items-center gap-0.5">
                            <Truck className="h-3 w-3" />
                            {driver.assignedTruck.unitId}
                          </span>
                        )}
                        {driver.assignedTruck?.bodyType && (
                          <Badge
                            variant={equipMatch ? 'default' : 'secondary'}
                            className={cn(
                              'text-[10px] px-1 h-4',
                              equipMatch && 'bg-green-100 text-green-800 border-green-200'
                            )}
                          >
                            {equipMatch && <CheckCircle2 className="h-2.5 w-2.5 mr-0.5" />}
                            {driver.assignedTruck.bodyType}
                          </Badge>
                        )}
                        {(driver.city || driver.state) && (
                          <span className="flex items-center gap-0.5">
                            <MapPin className="h-3 w-3" />
                            {driver.city}, {driver.state}
                          </span>
                        )}
                      </div>
                    </div>
                    <ChevronRight className="h-4 w-4 text-muted-foreground shrink-0" />
                  </button>
                );
              })}
            </>
          ) : (
            <>
              {filteredCarriers.length === 0 && (
                <div className="flex flex-col items-center justify-center py-12 text-muted-foreground">
                  <Building2 className="h-10 w-10 mb-2 opacity-40" />
                  <p className="text-sm">No carriers found</p>
                </div>
              )}
              {filteredCarriers.map((carrier) => (
                <button
                  key={carrier._id}
                  onClick={() => onCarrierTap(carrier._id)}
                  className="w-full text-left px-4 py-3 border-b flex items-center gap-3 active:bg-muted/60 transition-colors"
                >
                  <div className="h-9 w-9 rounded-full bg-muted flex items-center justify-center shrink-0">
                    <Building2 className="h-4 w-4 text-muted-foreground" />
                  </div>
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-1.5 flex-wrap">
                      <span className="text-sm font-medium truncate">{carrier.carrierName}</span>
                      {carrier.isOwnerOperator && (
                        <Badge variant="outline" className="text-[10px] px-1 h-4 shrink-0">
                          Owner-Op
                        </Badge>
                      )}
                      {carrier.hasDefaultRate && (
                        <Badge
                          variant="outline"
                          className="text-[10px] px-1 h-4 bg-green-50 text-green-700 border-green-200 shrink-0"
                        >
                          <DollarSign className="h-2.5 w-2.5" />
                        </Badge>
                      )}
                    </div>
                    <div className="flex items-center gap-2 mt-0.5 text-xs text-muted-foreground flex-wrap">
                      <span>MC# {carrier.mcNumber}</span>
                      {(carrier.city || carrier.state) && (
                        <span className="flex items-center gap-0.5">
                          <MapPin className="h-3 w-3" />
                          {carrier.city}, {carrier.state}
                        </span>
                      )}
                      {carrier.contactFirstName && (
                        <span>{carrier.contactFirstName} {carrier.contactLastName}</span>
                      )}
                    </div>
                  </div>
                  <ChevronRight className="h-4 w-4 text-muted-foreground shrink-0" />
                </button>
              ))}
            </>
          )}
        </div>
      </ScrollArea>
    </div>
  );
}
