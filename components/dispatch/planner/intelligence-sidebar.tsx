'use client';

import { Id } from '@/convex/_generated/dataModel';
import { Card } from '@/components/ui/card';
import {
  Package,
  AlertTriangle,
  Users,
  Map,
  TrendingUp,
} from 'lucide-react';
import { DecisionSupportView } from './decision-support-view';
import { ExecutionMonitoringView } from './execution-monitoring-view';

// Types for basic load data (used in Fleet Intelligence mode)
interface LoadWithRange {
  _id: Id<'loadInformation'>;
  orderNumber?: string;
  internalId?: string;
  customerName?: string;
  equipmentType?: string;
  effectiveMiles?: number;
  status?: string;
  startTime: number | null;
  endTime: number | null;
  origin?: {
    city?: string;
    state?: string;
    address?: string;
    lat?: number;
    lng?: number;
  } | null;
  destination?: {
    city?: string;
    state?: string;
    address?: string;
    lat?: number;
    lng?: number;
  } | null;
  // Enriched data for post-assignment view
  stops?: StopType[];
  legs?: LegType[];
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

interface StopType {
  _id: Id<'loadStops'>;
  sequenceNumber: number;
  stopType: 'PICKUP' | 'DELIVERY';
  status?: 'Pending' | 'In Transit' | 'Completed' | 'Delayed' | 'Canceled';
  city?: string;
  state?: string;
  address?: string;
  windowBeginDate?: string;
  windowBeginTime?: string;
  windowEndTime?: string;
  checkedInAt?: string;
  checkedOutAt?: string;
}

interface LegType {
  _id: Id<'dispatchLegs'>;
  sequence: number;
  truckId?: Id<'trucks'>;
  trailerId?: Id<'trailers'>;
}

interface DriverWithTruck {
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
    lastLocationLat?: number;
    lastLocationLng?: number;
  } | null;
}

// Carrier partnership type (from carrierPartnerships.getActiveForDispatch)
interface CarrierPartnership {
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

interface DriverLeg {
  _id: Id<'dispatchLegs'>;
  loadId: Id<'loadInformation'>;
  startTime: number | null;
  load?: {
    orderNumber?: string;
  } | null;
  startStop?: {
    city?: string;
    state?: string;
  } | null;
}

interface IntelligenceSidebarProps {
  loadDetails: LoadWithRange | null;
  selectedDriver: DriverWithTruck | null;
  selectedCarrier: CarrierPartnership | null;
  assetType: 'driver' | 'carrier';
  driverSchedule: DriverLeg[] | null;
  onAssign: () => void;
  onUnassign: () => void;
  isAssigning: boolean;
  // KPI data placeholders (to be implemented)
  totalDrivers?: number;
  openLoadsCount?: number;
  // For truck selector
  organizationId: string;
  userId: string;
  userName?: string;
}

export function IntelligenceSidebar({
  loadDetails,
  selectedDriver,
  selectedCarrier,
  assetType,
  driverSchedule,
  onAssign,
  onUnassign,
  isAssigning,
  totalDrivers = 0,
  openLoadsCount = 0,
  organizationId,
  userId,
  userName,
}: IntelligenceSidebarProps) {
  // ============================================
  // MODE 1: Fleet Intelligence (No load selected)
  // ============================================
  if (!loadDetails) {
    return (
      <div className="h-full flex flex-col overflow-hidden">
        {/* Header */}
        <div className="p-4 border-b shrink-0">
          <div className="flex items-center gap-2">
            <TrendingUp className="h-5 w-5 text-primary" />
            <h2 className="font-semibold">Fleet Intelligence</h2>
          </div>
          <p className="text-sm text-muted-foreground mt-1">
            Select a trip to start planning
          </p>
        </div>

        {/* Scrollable Content */}
        <div className="flex-1 min-h-0 overflow-y-auto p-4 space-y-3">
          {/* Map Placeholder */}
          <Card className="h-[140px] flex items-center justify-center bg-slate-100 border-dashed">
            <div className="text-center text-muted-foreground">
              <Map className="h-8 w-8 mx-auto mb-2 opacity-50" />
              <p className="text-sm">Fleet Map</p>
              <p className="text-xs">(Coming Soon)</p>
            </div>
          </Card>

          {/* KPI Cards */}
          <Card className="p-3">
            <div className="flex items-center justify-between">
              <div className="flex items-center gap-2">
                <Users className="h-4 w-4 text-blue-600" />
                <span className="text-sm font-medium">Active Drivers</span>
              </div>
              <span className="text-2xl font-bold text-blue-600">
                {totalDrivers || '—'}
              </span>
            </div>
          </Card>

          <Card className="p-3">
            <div className="flex items-center justify-between">
              <div className="flex items-center gap-2">
                <Package className="h-4 w-4 text-yellow-600" />
                <span className="text-sm font-medium">Open Loads</span>
              </div>
              <span className="text-2xl font-bold text-yellow-600">
                {openLoadsCount || '—'}
              </span>
            </div>
          </Card>

          <Card className="p-3 bg-slate-50">
            <div className="flex items-center gap-2 mb-1">
              <AlertTriangle className="h-4 w-4 text-orange-500" />
              <span className="text-sm font-medium">Attention Needed</span>
            </div>
            <p className="text-xs text-muted-foreground">
              KPIs for expiring documents, HOS limits, and high deadhead alerts coming soon.
            </p>
          </Card>
        </div>
      </div>
    );
  }

  // ============================================
  // MODE 2: Decision Support (Open loads - pre-assignment)
  // ============================================
  if (loadDetails.status === 'Open') {
    return (
      <DecisionSupportView
        loadDetails={loadDetails}
        selectedDriver={selectedDriver}
        selectedCarrier={selectedCarrier}
        assetType={assetType}
        driverSchedule={driverSchedule}
        onAssign={onAssign}
        isAssigning={isAssigning}
        organizationId={organizationId}
        userId={userId}
        userName={userName}
      />
    );
  }

  // ============================================
  // MODE 3: Execution Monitoring (Assigned loads - post-assignment)
  // ============================================
  if (loadDetails.status === 'Assigned' && loadDetails.stops && loadDetails.legs) {
    return (
      <ExecutionMonitoringView
        loadDetails={{
          ...loadDetails,
          stops: loadDetails.stops,
          legs: loadDetails.legs,
          assignedDriver: loadDetails.assignedDriver || null,
          assignedCarrier: loadDetails.assignedCarrier || null,
          assignedTruck: loadDetails.assignedTruck || null,
          assignedTrailer: loadDetails.assignedTrailer || null,
        }}
        onUnassign={onUnassign}
      />
    );
  }

  // ============================================
  // FALLBACK: Assigned load without enriched data (use DecisionSupportView as fallback)
  // This handles edge cases where the enriched data hasn't loaded yet
  // ============================================
  return (
    <DecisionSupportView
      loadDetails={loadDetails}
      selectedDriver={selectedDriver}
      selectedCarrier={selectedCarrier}
      assetType={assetType}
      driverSchedule={driverSchedule}
      onAssign={onAssign}
      isAssigning={isAssigning}
      organizationId={organizationId}
      userId={userId}
      userName={userName}
    />
  );
}
