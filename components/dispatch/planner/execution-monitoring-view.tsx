'use client';

import { Id } from '@/convex/_generated/dataModel';
import { TripDetailsSidebar } from './trip-details-sidebar';

// Types for enriched load data
interface EnrichedLoadDetails {
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
  stops: StopType[];
  legs: LegType[];
  assignedDriver: {
    _id: Id<'drivers'>;
    name: string;
    phone: string;
    city?: string;
    state?: string;
  } | null;
  assignedCarrier: {
    _id: Id<'carriers'>;
    companyName: string;
    phone?: string;
  } | null;
  assignedTruck: {
    _id: Id<'trucks'>;
    unitId: string;
    bodyType?: string;
  } | null;
  assignedTrailer: {
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
  latitude?: number;
  longitude?: number;
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

interface ExecutionMonitoringViewProps {
  loadDetails: EnrichedLoadDetails;
  onUnassign: () => void;
}

export function ExecutionMonitoringView({
  loadDetails,
  onUnassign,
}: ExecutionMonitoringViewProps) {
  // Transform stops to ensure string _id for unified component
  const stopsWithStringIds = loadDetails.stops.map(stop => ({
    ...stop,
    _id: stop._id as unknown as string,
  }));

  // Transform loadDetails to match unified component format
  const unifiedLoadDetails = {
    _id: loadDetails._id,
    orderNumber: loadDetails.orderNumber,
    internalId: loadDetails.internalId,
    customerName: loadDetails.customerName,
    equipmentType: loadDetails.equipmentType,
    effectiveMiles: loadDetails.effectiveMiles,
    status: loadDetails.status,
    stops: stopsWithStringIds,
    assignedDriver: loadDetails.assignedDriver,
    assignedCarrier: loadDetails.assignedCarrier,
    assignedTruck: loadDetails.assignedTruck,
    assignedTrailer: loadDetails.assignedTrailer,
  };

  return (
    <TripDetailsSidebar
      loadDetails={unifiedLoadDetails}
      onUnassign={onUnassign}
    />
  );
}
