'use client';

import { Id } from '@/convex/_generated/dataModel';
import { Card } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Separator } from '@/components/ui/separator';
import {
  Package,
  MapPin,
  ArrowRight,
  Calendar,
  Truck,
  User,
  Building2,
  CheckCircle2,
  AlertTriangle,
  Loader2,
  Clock,
} from 'lucide-react';

// Types
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

interface Carrier {
  _id: string;
  companyName: string;
  mcNumber: string;
  firstName: string;
  lastName: string;
  phoneNumber: string;
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

interface AssignmentSidebarProps {
  loadDetails: LoadWithRange | null;
  selectedDriver: DriverWithTruck | null;
  selectedCarrier: Carrier | null;
  assetType: 'driver' | 'carrier';
  driverSchedule: DriverLeg[] | null;
  onAssign: () => void;
  onUnassign: () => void;
  isAssigning: boolean;
}

export function AssignmentSidebar({
  loadDetails,
  selectedDriver,
  selectedCarrier,
  assetType,
  driverSchedule,
  onAssign,
  onUnassign,
  isAssigning,
}: AssignmentSidebarProps) {
  // Format timestamp to readable date
  const formatDate = (timestamp: number | null) => {
    if (!timestamp) return '--';
    const date = new Date(timestamp);
    return date.toLocaleDateString('en-US', {
      weekday: 'short',
      month: 'short',
      day: 'numeric',
      hour: 'numeric',
      minute: '2-digit',
    });
  };

  // Check equipment compatibility
  const isEquipmentMatch =
    loadDetails?.equipmentType &&
    selectedDriver?.assignedTruck?.bodyType &&
    loadDetails.equipmentType.toLowerCase() ===
      selectedDriver.assignedTruck.bodyType.toLowerCase();

  // Determine if we can assign
  const canAssign =
    loadDetails &&
    loadDetails.status === 'Open' &&
    ((assetType === 'driver' && selectedDriver) ||
      (assetType === 'carrier' && selectedCarrier));

  // Determine if we can unassign
  const canUnassign = loadDetails && loadDetails.status === 'Assigned';

  return (
    <div className="h-full flex flex-col p-4 space-y-4">
      {/* Header */}
      <div className="flex items-center gap-2">
        <Package className="h-5 w-5 text-muted-foreground" />
        <h2 className="font-semibold">Assignment Details</h2>
      </div>

      {/* No load selected state */}
      {!loadDetails && (
        <div className="flex-1 flex items-center justify-center">
          <div className="text-center text-muted-foreground">
            <Package className="h-12 w-12 mx-auto mb-3 opacity-50" />
            <p>Select a trip to see details</p>
          </div>
        </div>
      )}

      {/* Load Details */}
      {loadDetails && (
        <>
          <Card className="p-4">
            <div className="flex items-center justify-between mb-3">
              <h3 className="font-semibold text-sm">Load Details</h3>
              <Badge
                variant="outline"
                className={
                  loadDetails.status === 'Open'
                    ? 'bg-yellow-100 text-yellow-800 border-yellow-200'
                    : loadDetails.status === 'Assigned'
                      ? 'bg-blue-100 text-blue-800 border-blue-200'
                      : ''
                }
              >
                {loadDetails.status}
              </Badge>
            </div>

            <div className="space-y-3 text-sm">
              {/* Order Number */}
              <div className="flex items-center justify-between">
                <span className="text-muted-foreground">Order #</span>
                <span className="font-medium">
                  {loadDetails.orderNumber || loadDetails.internalId || '--'}
                </span>
              </div>

              {/* Customer */}
              <div className="flex items-center justify-between">
                <span className="text-muted-foreground">Customer</span>
                <span className="truncate ml-2">{loadDetails.customerName || '--'}</span>
              </div>

              <Separator />

              {/* Route */}
              <div>
                <span className="text-muted-foreground block mb-2">Route</span>
                <div className="flex items-center gap-2 text-sm">
                  <MapPin className="h-4 w-4 text-green-600 shrink-0" />
                  <span className="truncate">
                    {loadDetails.origin?.city || '--'}, {loadDetails.origin?.state || ''}
                  </span>
                </div>
                <div className="flex items-center gap-2 text-sm mt-1">
                  <MapPin className="h-4 w-4 text-red-600 shrink-0" />
                  <span className="truncate">
                    {loadDetails.destination?.city || '--'},{' '}
                    {loadDetails.destination?.state || ''}
                  </span>
                </div>
              </div>

              <Separator />

              {/* Miles & Equipment */}
              <div className="grid grid-cols-2 gap-4">
                <div>
                  <span className="text-muted-foreground block">Miles</span>
                  <span className="font-medium">{loadDetails.effectiveMiles ?? '--'}</span>
                </div>
                <div>
                  <span className="text-muted-foreground block">Equipment</span>
                  <Badge variant="outline" className="mt-1">
                    {loadDetails.equipmentType || 'N/A'}
                  </Badge>
                </div>
              </div>

              {/* Dates */}
              <div className="grid grid-cols-1 gap-2">
                <div className="flex items-center gap-2">
                  <Calendar className="h-4 w-4 text-muted-foreground" />
                  <span className="text-muted-foreground">Pickup:</span>
                  <span className="text-sm">{formatDate(loadDetails.startTime)}</span>
                </div>
                <div className="flex items-center gap-2">
                  <Calendar className="h-4 w-4 text-muted-foreground" />
                  <span className="text-muted-foreground">Delivery:</span>
                  <span className="text-sm">{formatDate(loadDetails.endTime)}</span>
                </div>
              </div>
            </div>
          </Card>

          {/* Selected Driver Info */}
          {assetType === 'driver' && selectedDriver && (
            <Card className="p-4">
              <div className="flex items-center gap-2 mb-3">
                <User className="h-4 w-4 text-muted-foreground" />
                <h3 className="font-semibold text-sm">Selected Driver</h3>
              </div>

              <div className="space-y-3">
                <div>
                  <p className="font-medium">
                    {selectedDriver.firstName} {selectedDriver.lastName}
                  </p>
                  <p className="text-sm text-muted-foreground">{selectedDriver.phone}</p>
                </div>

                {/* Equipment info */}
                {selectedDriver.assignedTruck && (
                  <div className="flex items-center gap-2">
                    <Truck className="h-4 w-4 text-muted-foreground" />
                    <span className="text-sm">
                      Truck #{selectedDriver.assignedTruck.unitId}
                    </span>
                    {selectedDriver.assignedTruck.bodyType && (
                      <Badge variant="outline" className="text-xs">
                        {selectedDriver.assignedTruck.bodyType}
                      </Badge>
                    )}
                  </div>
                )}

                {/* Equipment match indicator */}
                <div>
                  {isEquipmentMatch ? (
                    <Badge className="bg-green-100 text-green-800 border-green-200">
                      <CheckCircle2 className="h-3 w-3 mr-1" />
                      Equipment Match
                    </Badge>
                  ) : selectedDriver.assignedTruck?.bodyType ? (
                    <Badge variant="destructive" className="bg-red-100 text-red-800 border-red-200">
                      <AlertTriangle className="h-3 w-3 mr-1" />
                      Equipment Mismatch
                    </Badge>
                  ) : (
                    <Badge variant="outline" className="text-muted-foreground">
                      No truck assigned
                    </Badge>
                  )}
                </div>
              </div>
            </Card>
          )}

          {/* Selected Carrier Info */}
          {assetType === 'carrier' && selectedCarrier && (
            <Card className="p-4">
              <div className="flex items-center gap-2 mb-3">
                <Building2 className="h-4 w-4 text-muted-foreground" />
                <h3 className="font-semibold text-sm">Selected Carrier</h3>
              </div>

              <div className="space-y-2">
                <p className="font-medium">{selectedCarrier.companyName}</p>
                <p className="text-sm text-muted-foreground">MC# {selectedCarrier.mcNumber}</p>
                <Separator />
                <div className="text-sm">
                  <p>
                    {selectedCarrier.firstName} {selectedCarrier.lastName}
                  </p>
                  <p className="text-muted-foreground">{selectedCarrier.phoneNumber}</p>
                </div>
              </div>
            </Card>
          )}

          {/* Driver Schedule Preview */}
          {assetType === 'driver' &&
            selectedDriver &&
            driverSchedule &&
            driverSchedule.length > 0 && (
              <Card className="p-4">
                <div className="flex items-center gap-2 mb-3">
                  <Clock className="h-4 w-4 text-muted-foreground" />
                  <h3 className="font-semibold text-sm">Upcoming Assignments</h3>
                </div>

                <div className="space-y-2">
                  {driverSchedule.slice(0, 3).map((leg) => (
                    <div
                      key={leg._id}
                      className="text-sm border-l-2 border-blue-500 pl-3 py-1"
                    >
                      <p className="font-medium">{leg.load?.orderNumber || 'Load'}</p>
                      <p className="text-muted-foreground text-xs">
                        {leg.startTime ? formatDate(leg.startTime) : '--'} •{' '}
                        {leg.startStop?.city || '--'}, {leg.startStop?.state || ''}
                      </p>
                    </div>
                  ))}
                </div>
              </Card>
            )}

          {/* Action Buttons */}
          <div className="mt-auto space-y-2">
            {canAssign && (
              <Button className="w-full" onClick={onAssign} disabled={isAssigning}>
                {isAssigning && <Loader2 className="h-4 w-4 mr-2 animate-spin" />}
                {assetType === 'driver' && selectedDriver
                  ? `Assign to ${selectedDriver.firstName} ${selectedDriver.lastName}`
                  : assetType === 'carrier' && selectedCarrier
                    ? `Assign to ${selectedCarrier.companyName}`
                    : 'Select an asset to assign'}
              </Button>
            )}

            {canUnassign && (
              <Button variant="outline" className="w-full" onClick={onUnassign}>
                Remove Assignment
              </Button>
            )}

            {!canAssign && !canUnassign && loadDetails && (
              <div className="text-center text-sm text-muted-foreground py-2">
                {loadDetails.status === 'Open'
                  ? 'Select a driver or carrier to assign'
                  : loadDetails.status === 'Assigned'
                    ? 'This load is already assigned'
                    : `Cannot modify ${loadDetails.status?.toLowerCase()} loads`}
              </div>
            )}
          </div>
        </>
      )}
    </div>
  );
}
