'use client';

import { useMemo } from 'react';
import { Id } from '@/convex/_generated/dataModel';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import {
  Package,
  Truck,
  Phone,
  Check,
  Building2,
  Clock,
  AlertTriangle,
  Container,
  MoreHorizontal,
  User,
  Loader2,
} from 'lucide-react';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { cn } from '@/lib/utils';
import { RouteMap } from './route-map';
import { TruckSelector } from './truck-selector';
import { formatTimeWindow } from '@/lib/format-date-timezone';
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from '@/components/ui/tooltip';

// ============================================================================
// TYPES
// ============================================================================

interface StopType {
  _id: string;
  sequenceNumber: number;
  stopType: 'PICKUP' | 'DELIVERY';
  status?: 'Pending' | 'In Transit' | 'Completed' | 'Delayed' | 'Canceled';
  city?: string;
  state?: string;
  address?: string;
  latitude?: number;
  longitude?: number;
  windowBeginDate?: string;
  windowBeginTime?: string;
  windowEndTime?: string;
  checkedInAt?: string;
  checkedOutAt?: string;
}

interface LoadDetails {
  _id: Id<'loadInformation'>;
  orderNumber?: string;
  internalId?: string;
  customerName?: string;
  equipmentType?: string;
  effectiveMiles?: number;
  status?: string;
  stops?: StopType[];
  // Enriched data (only present when assigned)
  assignedDriver?: {
    _id: Id<'drivers'>;
    name: string;
    phone: string;
    city?: string;
    state?: string;
  } | null;
  assignedCarrier?: {
    _id: string;
    companyName?: string;
    phone?: string;
    mcNumber?: string;
    // From loadCarrierAssignments
    carrierRate?: number;
    driverName?: string;
    driverPhone?: string;
  } | null;
  assignedTruck?: {
    _id: Id<'trucks'>;
    unitId: string;
    bodyType?: string;
  } | null;
  assignedTrailer?: {
    _id: Id<'trailers'>;
    unitId: string;
    trailerType?: string;
  } | null;
}

interface SelectedDriver {
  _id: Id<'drivers'>;
  firstName: string;
  lastName: string;
  phone: string;
  city?: string;
  state?: string;
  assignedTruck: {
    _id: Id<'trucks'>;
    unitId: string;
    bodyType?: string;
  } | null;
}

// Carrier partnership type (from carrierPartnerships.getActiveForDispatch)
interface SelectedCarrier {
  _id: Id<'carrierPartnerships'>;
  carrierOrgId?: string;
  carrierName: string;
  mcNumber: string;
  contactFirstName?: string;
  contactLastName?: string;
  contactPhone?: string;
  contactEmail?: string;
  city?: string;
  state?: string;
  hasDefaultRate: boolean;
  defaultRate?: number;
  defaultRateType?: 'FLAT' | 'PER_MILE' | 'PERCENTAGE';
  defaultCurrency?: 'USD' | 'CAD' | 'MXN';
  isOwnerOperator?: boolean;
}

interface TripDetailsSidebarProps {
  loadDetails: LoadDetails;
  // For Open loads - preview selection
  selectedDriver?: SelectedDriver | null;
  selectedCarrier?: SelectedCarrier | null;
  assetType?: 'driver' | 'carrier';
  // Actions
  onAssign?: () => void;
  onUnassign?: () => void;
  isAssigning?: boolean;
  // For truck selector
  organizationId?: string;
  userId?: string;
  userName?: string;
}

// ============================================================================
// HELPERS
// ============================================================================

type StopStatus = 'completed' | 'active' | 'next' | 'pending';

function getStopStatus(stop: StopType, index: number, allStops: StopType[]): StopStatus {
  if (stop.status === 'Completed' || stop.checkedOutAt) {
    return 'completed';
  }
  if (stop.checkedInAt && !stop.checkedOutAt) {
    return 'active';
  }
  const firstPendingIdx = allStops.findIndex(
    (s) => s.status !== 'Completed' && !s.checkedOutAt
  );
  if (firstPendingIdx === index) {
    return 'next';
  }
  return 'pending';
}

function formatTime(isoString?: string): string {
  if (!isoString) return '';
  try {
    const date = new Date(isoString);
    return date.toLocaleTimeString('en-US', {
      hour: 'numeric',
      minute: '2-digit',
      hour12: true,
    });
  } catch {
    return '';
  }
}

// formatWindowDisplay is now handled by formatTimeWindow utility

function getTimeVariance(
  scheduledTime?: string,
  actualTime?: string
): { label: string; isLate: boolean } | null {
  if (!scheduledTime || !actualTime) return null;
  try {
    const scheduled = new Date(scheduledTime).getTime();
    const actual = new Date(actualTime).getTime();
    const diffMs = actual - scheduled;
    const minutesDiff = Math.round(diffMs / 60000);
    
    if (Math.abs(minutesDiff) < 2) {
      return { label: 'On Time', isLate: false };
    } else if (minutesDiff > 0) {
      return { label: `${minutesDiff}m late`, isLate: true };
    } else {
      return { label: `${Math.abs(minutesDiff)}m early`, isLate: false };
    }
  } catch {
    return null;
  }
}

// ============================================================================
// COMPONENT
// ============================================================================

export function TripDetailsSidebar({
  loadDetails,
  selectedDriver,
  selectedCarrier,
  assetType = 'driver',
  onAssign,
  onUnassign,
  isAssigning = false,
  organizationId,
  userId,
  userName,
}: TripDetailsSidebarProps) {
  const stops = loadDetails.stops ?? [];
  const isAssigned = loadDetails.status === 'Assigned';
  const isOpen = loadDetails.status === 'Open';

  // Determine the "active" resource to display
  const activeDriver = isAssigned ? loadDetails.assignedDriver : selectedDriver;
  const activeCarrier = isAssigned ? loadDetails.assignedCarrier : selectedCarrier;
  const activeTruck = isAssigned ? loadDetails.assignedTruck : selectedDriver?.assignedTruck;
  const activeTrailer = isAssigned ? loadDetails.assignedTrailer : null;

  // Resource display logic
  const hasResource = !!(activeDriver || activeCarrier);

  // Handle different name formats: assignedDriver has `name`, selectedDriver has firstName/lastName
  const resourceName = activeDriver 
    ? (isAssigned 
        ? (loadDetails.assignedDriver as { name: string })?.name 
        : `${selectedDriver?.firstName} ${selectedDriver?.lastName}`)
    : (isAssigned ? loadDetails.assignedCarrier?.companyName : selectedCarrier?.carrierName) || null;
  // Handle phone: assignedCarrier might have phone, selectedCarrier has contactPhone
  const resourcePhone = activeDriver?.phone 
    || (isAssigned ? loadDetails.assignedCarrier?.phone : selectedCarrier?.contactPhone);

  // Equipment checks
  const loadRequiresEquipment = loadDetails.equipmentType && loadDetails.equipmentType.trim() !== '';
  const hasEquipmentMismatch = loadRequiresEquipment && 
    activeTruck?.bodyType && 
    loadDetails.equipmentType?.toLowerCase() !== activeTruck.bodyType.toLowerCase();
  const driverHasTruck = selectedDriver?.assignedTruck !== null;

  // Can assign?
  const canAssign = isOpen && 
    ((assetType === 'driver' && selectedDriver && driverHasTruck) ||
     (assetType === 'carrier' && selectedCarrier));

  // Trip started? (for assigned loads)
  const tripHasStarted = stops.some(s => s.checkedInAt || s.checkedOutAt || s.status === 'Completed');

  // Memoize map stops
  const mapStops = useMemo(
    () =>
      stops.map((stop) => ({
        lat: stop.latitude ?? 0,
        lng: stop.longitude ?? 0,
        city: stop.city,
        state: stop.state,
        type: stop.stopType === 'PICKUP' ? ('pickup' as const) : ('delivery' as const),
        sequenceNumber: stop.sequenceNumber,
      })),
    [stops]
  );

  return (
    <div className="h-full flex flex-col overflow-hidden bg-white">
      {/* ================================================================
          1. GLOBAL HEADER (Same for both views)
          ================================================================ */}
      <div className="p-4 border-b shrink-0">
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-2">
            <Package className="h-5 w-5 text-slate-600" />
            <span className="font-semibold text-sm text-slate-900">Trip Details</span>
          </div>
          
          {/* More Actions Menu */}
          {(isAssigned && onUnassign) && (
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <Button variant="ghost" size="icon" className="h-8 w-8">
                  <MoreHorizontal className="h-4 w-4" />
                </Button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end">
                <DropdownMenuItem 
                  onClick={onUnassign}
                  className="text-red-600 focus:text-red-600 focus:bg-red-50"
                >
                  Remove Assignment
                </DropdownMenuItem>
              </DropdownMenuContent>
            </DropdownMenu>
          )}
        </div>
      </div>

      {/* ================================================================
          2. MAP SECTION (Same for both)
          ================================================================ */}
      <RouteMap stops={mapStops} height="140px" />

      {/* ================================================================
          3. LOAD INFO HEADER
          ================================================================ */}
      <div className="px-4 py-3 border-b shrink-0">
        <div className="flex justify-between items-center">
          <h2 className="text-sm font-bold text-slate-900">
            Order #{loadDetails.orderNumber || loadDetails.internalId || '—'}
          </h2>
          <Badge
            variant="outline"
            className={cn(
              isAssigned 
                ? 'bg-blue-50 text-blue-700 border-blue-200'
                : 'bg-yellow-50 text-yellow-700 border-yellow-200'
            )}
          >
            {loadDetails.status}
          </Badge>
        </div>
        <div className="flex items-center justify-between mt-1">
          <p className="text-xs text-slate-500">
            Customer: <span className="font-medium text-slate-700">{loadDetails.customerName || 'Unknown'}</span>
          </p>
          <div className="flex items-center gap-2 text-xs text-slate-500">
            <span>{loadDetails.effectiveMiles ?? '—'} mi</span>
            {loadDetails.equipmentType && (
              <Badge variant="outline" className="text-[10px] py-0 px-1.5">
                {loadDetails.equipmentType}
              </Badge>
            )}
          </div>
        </div>
      </div>

      {/* ================================================================
          4. SCROLLABLE CONTENT
          ================================================================ */}
      <div className="flex-1 min-h-0 overflow-y-auto p-4 space-y-4">
        {/* ----------------------------------------------------------------
            RESOURCE CARD (Unified - adapts to state)
            ---------------------------------------------------------------- */}
        <div
          className={cn(
            'rounded-lg border p-3 transition-all',
            hasResource
              ? 'border-blue-200 bg-blue-50/30'
              : 'border-dashed border-slate-200 bg-slate-50/50'
          )}
        >
          <div className="flex items-start justify-between">
            <div className="flex-1 min-w-0">
              <p className="text-[10px] font-bold text-slate-400 uppercase tracking-wider">
                {isAssigned ? 'Assigned Resource' : 'Primary Resource'}
              </p>
              
              {hasResource ? (
                <div className="mt-1">
                  <div className="flex items-center gap-2">
                    {activeDriver && <User className="h-4 w-4 text-blue-600 shrink-0" />}
                    {activeCarrier && !activeDriver && <Building2 className="h-4 w-4 text-blue-600 shrink-0" />}
                    <h3 className="text-sm font-bold text-slate-900 truncate">
                      {resourceName}
                    </h3>
                  </div>

                  {/* Equipment Row */}
                  {activeTruck && (
                    <div className="mt-2 flex flex-wrap gap-1.5">
                      <div
                        className={cn(
                          'flex items-center gap-1 rounded bg-white px-1.5 py-0.5 shadow-sm text-[10px]',
                          hasEquipmentMismatch
                            ? 'border border-amber-400'
                            : 'border border-blue-100'
                        )}
                      >
                        <Truck
                          className={cn(
                            'h-3 w-3',
                            hasEquipmentMismatch ? 'text-amber-600' : 'text-blue-600'
                          )}
                        />
                        <span className="font-bold text-slate-700">{activeTruck.unitId}</span>
                        {hasEquipmentMismatch && (
                          <AlertTriangle className="h-2.5 w-2.5 text-amber-600" />
                        )}
                      </div>
                      {activeTrailer && (
                        <div className="flex items-center gap-1 rounded bg-white px-1.5 py-0.5 border border-blue-100 shadow-sm text-[10px]">
                          <Container className="h-3 w-3 text-blue-600" />
                          <span className="font-bold text-slate-700">{activeTrailer.unitId}</span>
                        </div>
                      )}
                      {!activeTrailer && activeTruck && (
                        <div className="rounded bg-slate-100 px-1.5 py-0.5 border border-slate-200 text-[10px] text-slate-500">
                          Bobtail
                        </div>
                      )}
                    </div>
                  )}

                  {/* Equipment mismatch warning */}
                  {hasEquipmentMismatch && (
                    <div className="mt-2 flex items-center gap-1 text-amber-700 text-[10px]">
                      <AlertTriangle className="h-3 w-3" />
                      <span>Needs {loadDetails.equipmentType}</span>
                    </div>
                  )}

                  {/* Carrier Rate Info */}
                  {activeCarrier && !activeDriver && isAssigned && loadDetails.assignedCarrier?.carrierRate && (
                    <div className="mt-2 p-2 bg-green-50 rounded-md border border-green-100">
                      <div className="flex items-center justify-between">
                        <span className="text-[10px] text-green-700">Carrier Rate</span>
                        <span className="text-xs font-bold text-green-700">
                          ${loadDetails.assignedCarrier.carrierRate.toLocaleString(undefined, { 
                            minimumFractionDigits: 2, 
                            maximumFractionDigits: 2 
                          })}
                        </span>
                      </div>
                      {loadDetails.assignedCarrier.driverName && (
                        <div className="mt-1 text-[10px] text-green-600">
                          Driver: {loadDetails.assignedCarrier.driverName}
                          {loadDetails.assignedCarrier.driverPhone && (
                            <span className="ml-1">• {loadDetails.assignedCarrier.driverPhone}</span>
                          )}
                        </div>
                      )}
                    </div>
                  )}

                  {/* Carrier MC Number */}
                  {activeCarrier && !activeDriver && (
                    <div className="mt-1.5 text-[10px] text-slate-500">
                      MC# {isAssigned ? loadDetails.assignedCarrier?.mcNumber : selectedCarrier?.mcNumber}
                    </div>
                  )}
                </div>
              ) : (
                <p className="text-sm text-slate-400 mt-1">
                  {isOpen ? 'Select a driver to assign' : 'Unassigned'}
                </p>
              )}
            </div>

            {/* Phone button */}
            {hasResource && resourcePhone && (
              <a href={`tel:${resourcePhone}`} className="shrink-0">
                <Button
                  variant="ghost"
                  size="icon"
                  className="h-8 w-8 rounded-full bg-white shadow-sm hover:bg-blue-100 text-blue-600"
                >
                  <Phone className="h-4 w-4" />
                </Button>
              </a>
            )}
          </div>
        </div>

        {/* Truck selector for drivers without truck */}
        {isOpen && selectedDriver && !driverHasTruck && organizationId && (
          <div className="space-y-2">
            <div className="flex items-center gap-2 text-amber-600 bg-amber-50 border border-amber-200 rounded-md px-3 py-2">
              <AlertTriangle className="h-4 w-4 shrink-0" />
              <div>
                <p className="text-xs font-medium">No truck assigned</p>
                <p className="text-[10px] text-amber-600/80">Select a truck to enable assignment</p>
              </div>
            </div>
            <TruckSelector
              driverId={selectedDriver._id}
              workosOrgId={organizationId}
              userId={userId ?? ''}
              userName={userName}
            />
          </div>
        )}

        {/* ----------------------------------------------------------------
            TRIP ITINERARY (Unified - same 1-2-3 pins, status adapts)
            ---------------------------------------------------------------- */}
        <div>
          <h4 className="text-[10px] font-bold text-slate-400 uppercase tracking-widest mb-4">
            Trip Itinerary
          </h4>

          <div className="space-y-0 relative">
            {/* Vertical Connection Line */}
            {stops.length > 1 && (
              <div
                className="absolute left-[13px] top-3 w-px bg-slate-200"
                style={{ height: `calc(100% - 48px)` }}
              />
            )}

            {stops.map((stop, index) => {
              const status = isAssigned ? getStopStatus(stop, index, stops) : 'pending';
              const isCompleted = status === 'completed';
              const isActive = status === 'active';
              const isNext = status === 'next';
              
              const arrivalVariance = isActive && stop.checkedInAt
                ? getTimeVariance(stop.windowBeginTime, stop.checkedInAt)
                : null;
              const departureVariance = isCompleted && stop.checkedOutAt
                ? getTimeVariance(stop.windowEndTime, stop.checkedOutAt)
                : null;

              return (
                <div key={stop._id} className="relative flex gap-4 pb-6">
                  {/* Numbered Pin - adapts based on status */}
                  <div
                    className={cn(
                      'flex h-7 w-7 items-center justify-center rounded-full text-[11px] font-bold shadow-sm z-10 shrink-0 transition-all',
                      // Completed: green background with check
                      isCompleted && 'bg-green-500 text-white border-2 border-white',
                      // Active: blue with pulse
                      isActive && 'bg-blue-600 text-white border-2 border-white animate-pulse',
                      // Next stop (assigned) or default: outlined
                      isNext && 'bg-white border-2 border-blue-500 text-blue-600',
                      // Pending/default: neutral
                      !isCompleted && !isActive && !isNext && 'bg-white border border-slate-200 text-slate-600'
                    )}
                  >
                    {isCompleted ? <Check className="h-3.5 w-3.5" /> : stop.sequenceNumber}
                  </div>

                  <div className="flex-1 -mt-0.5 min-w-0">
                    {/* City + Stop Type */}
                    <div className="flex justify-between items-start gap-2">
                      <p
                        className={cn(
                          'text-sm font-bold uppercase truncate',
                          isCompleted || isActive || isNext ? 'text-slate-900' : 'text-slate-600'
                        )}
                      >
                        {stop.city || 'Unknown'}, {stop.state || ''}
                      </p>
                      <span className="text-[9px] font-bold text-slate-400 uppercase tracking-tighter border border-slate-200 px-1 rounded shrink-0">
                        {stop.stopType === 'PICKUP' ? 'Pick' : 'Drop'}
                      </span>
                    </div>

                    {/* Status label (only for assigned loads with progress) */}
                    {isAssigned && (isCompleted || isActive || isNext) && (
                      <p
                        className={cn(
                          'text-[10px] font-medium uppercase mt-0.5',
                          isCompleted && 'text-green-600',
                          isActive && 'text-blue-600',
                          isNext && 'text-blue-500'
                        )}
                      >
                        {isCompleted && 'Departed'}
                        {isActive && 'At Facility'}
                        {isNext && 'Next Stop'}
                      </p>
                    )}

                    {/* Time Window */}
                    <div className="mt-1 flex items-center gap-1.5 text-slate-500">
                      <Clock className="h-3 w-3 shrink-0" />
                      {(() => {
                        const formatted = formatTimeWindow(stop.windowBeginDate || '', stop.windowBeginTime, stop.windowEndTime);
                        return (
                          <Tooltip>
                            <TooltipTrigger asChild>
                              <span className="text-[11px] cursor-help whitespace-nowrap">
                                {formatted.display}
                              </span>
                            </TooltipTrigger>
                            <TooltipContent>
                              <p>{formatted.tooltip}</p>
                            </TooltipContent>
                          </Tooltip>
                        );
                      })()}
                      {/* Variance badge */}
                      {(arrivalVariance || departureVariance) && (
                        <span
                          className={cn(
                            'text-[9px] font-bold ml-1',
                            (arrivalVariance?.isLate || departureVariance?.isLate)
                              ? 'text-red-600'
                              : 'text-green-600'
                          )}
                        >
                          {arrivalVariance?.label || departureVariance?.label}
                        </span>
                      )}
                    </div>

                    {/* Address */}
                    <p className="text-[10px] text-slate-400 mt-1 truncate">
                      {stop.address || 'Address not provided'}
                    </p>

                    {/* Actual times for completed/active stops */}
                    {isAssigned && (isCompleted || isActive) && (stop.checkedInAt || stop.checkedOutAt) && (
                      <div className="flex items-center gap-3 text-[10px] text-slate-500 mt-1">
                        {stop.checkedInAt && (
                          <span>
                            Arrived: <span className="font-medium text-slate-700">{formatTime(stop.checkedInAt)}</span>
                          </span>
                        )}
                        {stop.checkedOutAt && (
                          <span>
                            Departed: <span className="font-medium text-slate-700">{formatTime(stop.checkedOutAt)}</span>
                          </span>
                        )}
                      </div>
                    )}
                  </div>
                </div>
              );
            })}
          </div>

          {stops.length === 0 && (
            <div className="text-center py-6 text-muted-foreground">
              <Package className="h-8 w-8 mx-auto mb-2 opacity-50" />
              <p className="text-sm">No stops defined</p>
            </div>
          )}
        </div>
      </div>

      {/* ================================================================
          5. ACTION FOOTER (Adapts based on state)
          ================================================================ */}
      <div className="shrink-0 border-t p-4 bg-slate-50/50">
        {isOpen ? (
          // OPEN: Show Assign button
          canAssign ? (
            <div className="space-y-2">
              {/* Show contract rate indicator for carriers */}
              {assetType === 'carrier' && selectedCarrier?.hasDefaultRate && (
                <div className="text-xs text-center text-green-600 bg-green-50 rounded py-1">
                  Contract Rate: ${selectedCarrier.defaultRate}
                  {selectedCarrier.defaultRateType === 'PER_MILE' && '/mi'}
                  {selectedCarrier.defaultRateType === 'PERCENTAGE' && '%'}
                </div>
              )}
              <Button
                className="w-full h-11"
                onClick={onAssign}
                disabled={isAssigning}
              >
                {isAssigning && <Loader2 className="h-4 w-4 mr-2 animate-spin" />}
                {assetType === 'driver' 
                  ? 'Assign Driver' 
                  : selectedCarrier?.hasDefaultRate 
                    ? 'Assign Carrier' 
                    : 'Set Rate & Assign'}
              </Button>
            </div>
          ) : selectedDriver && !driverHasTruck ? (
            <Button className="w-full h-11" disabled>
              Assign Driver
            </Button>
          ) : (
            <p className="text-sm text-center text-slate-400 py-2">
              Select a {assetType} from the table to assign
            </p>
          )
        ) : isAssigned ? (
          // ASSIGNED: Show status or empty (unassign is in menu)
          !tripHasStarted ? (
            <div className="flex items-center justify-center gap-2 text-green-600 py-1">
              <div className="h-2 w-2 rounded-full bg-green-500 animate-pulse" />
              <span className="text-sm font-medium">Dispatch Ready</span>
            </div>
          ) : (
            <div className="flex items-center justify-center gap-2 text-blue-600 py-1">
              <div className="h-2 w-2 rounded-full bg-blue-500 animate-pulse" />
              <span className="text-sm font-medium">Trip In Progress</span>
            </div>
          )
        ) : (
          // Other statuses (Completed, Canceled)
          <p className="text-sm text-center text-slate-400 py-2">
            {loadDetails.status} load
          </p>
        )}
      </div>
    </div>
  );
}
