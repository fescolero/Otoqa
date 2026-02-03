'use client';

import { Id } from '@/convex/_generated/dataModel';
import { TripDetailsSidebar } from './trip-details-sidebar';

// Types
interface LoadStop {
  _id: string;
  sequenceNumber: number;
  stopType: 'PICKUP' | 'DELIVERY';
  city?: string;
  state?: string;
  address?: string;
  latitude?: number;
  longitude?: number;
  windowBeginDate?: string;
  windowBeginTime?: string;
  windowEndTime?: string;
}

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
  stops?: LoadStop[];
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

interface DecisionSupportViewProps {
  loadDetails: LoadWithRange;
  selectedDriver: DriverWithTruck | null;
  selectedCarrier: CarrierPartnership | null;
  assetType: 'driver' | 'carrier';
  driverSchedule: DriverLeg[] | null;
  onAssign: () => void;
  isAssigning: boolean;
  organizationId: string;
  userId: string;
  userName?: string;
}

export function DecisionSupportView({
  loadDetails,
  selectedDriver,
  selectedCarrier,
  assetType,
  driverSchedule, // kept for API compatibility, not used in unified view
  onAssign,
  isAssigning,
  organizationId,
  userId,
  userName,
}: DecisionSupportViewProps) {
  // Transform loadDetails to match unified component format
  const unifiedLoadDetails = {
    _id: loadDetails._id,
    orderNumber: loadDetails.orderNumber,
    internalId: loadDetails.internalId,
    customerName: loadDetails.customerName,
    equipmentType: loadDetails.equipmentType,
    effectiveMiles: loadDetails.effectiveMiles,
    status: loadDetails.status,
    stops: loadDetails.stops,
  };

  return (
    <TripDetailsSidebar
      loadDetails={unifiedLoadDetails}
      selectedDriver={selectedDriver}
      selectedCarrier={selectedCarrier}
      assetType={assetType}
      onAssign={onAssign}
      isAssigning={isAssigning}
      organizationId={organizationId}
      userId={userId}
      userName={userName}
    />
  );
}
