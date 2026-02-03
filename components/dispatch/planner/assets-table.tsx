'use client';

import { Id } from '@/convex/_generated/dataModel';
import { Card } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Tabs, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { Skeleton } from '@/components/ui/skeleton';
import { Users, Building2, Truck, MapPin, CheckCircle2, DollarSign } from 'lucide-react';
import { cn } from '@/lib/utils';

// Types for the data we receive
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
}

// Carrier partnership type (from carrierPartnerships.getActiveForDispatch)
export interface CarrierPartnership {
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
  ownerDriverFirstName?: string;
  ownerDriverLastName?: string;
  ownerDriverPhone?: string;
}

interface LoadWithRange {
  _id: Id<'loadInformation'>;
  equipmentType?: string;
  startTime: number | null;
  endTime: number | null;
  origin?: {
    city?: string;
    state?: string;
    lat?: number;
    lng?: number;
  } | null;
}

interface AssetsTableProps {
  organizationId: string;
  loadDetails: LoadWithRange | null;
  allDrivers: DriverWithTruck[]; // All active drivers (shown before trip selection)
  availableDrivers: DriverWithTruck[]; // Filtered by time window (shown when trip selected)
  activeCarriers: CarrierPartnership[];
  assetType: 'driver' | 'carrier';
  onAssetTypeChange: (type: 'driver' | 'carrier') => void;
  selectedDriverId: Id<'drivers'> | null;
  selectedCarrierId: Id<'carrierPartnerships'> | null;
  onSelectDriver: (id: Id<'drivers'> | null) => void;
  onSelectCarrier: (id: Id<'carrierPartnerships'> | null) => void;
}

export function AssetsTable({
  organizationId,
  loadDetails,
  allDrivers,
  availableDrivers,
  activeCarriers,
  assetType,
  onAssetTypeChange,
  selectedDriverId,
  selectedCarrierId,
  onSelectDriver,
  onSelectCarrier,
}: AssetsTableProps) {
  // Use availableDrivers when trip is selected, otherwise show all drivers
  const driversToShow = loadDetails ? availableDrivers : allDrivers;
  
  // Build set of unavailable driver IDs (for dimming when trip is selected)
  const unavailableDriverIds = new Set<string>();
  if (loadDetails && allDrivers.length > 0) {
    const availableIds = new Set(availableDrivers.map(d => d._id));
    allDrivers.forEach(d => {
      if (!availableIds.has(d._id)) {
        unavailableDriverIds.add(d._id);
      }
    });
  }

  // Check equipment compatibility
  const isEquipmentMatch = (bodyType?: string) => {
    if (!loadDetails?.equipmentType || !bodyType) return false;
    return bodyType.toLowerCase() === loadDetails.equipmentType.toLowerCase();
  };

  const handleDriverClick = (driverId: Id<'drivers'>) => {
    if (selectedDriverId === driverId) {
      onSelectDriver(null);
    } else {
      onSelectDriver(driverId);
    }
  };

  const handleCarrierClick = (carrierId: Id<'carrierPartnerships'>) => {
    if (selectedCarrierId === carrierId) {
      onSelectCarrier(null);
    } else {
      onSelectCarrier(carrierId);
    }
  };

  return (
    <div className="h-full flex flex-col p-3 overflow-hidden">
      {/* Header with tabs */}
      <div className="flex items-center justify-between mb-2 shrink-0">
        <div className="flex items-center gap-2">
          {assetType === 'driver' ? (
            <Users className="h-5 w-5 text-muted-foreground" />
          ) : (
            <Building2 className="h-5 w-5 text-muted-foreground" />
          )}
          <h2 className="font-semibold">Assets</h2>
          {loadDetails && (
            <Badge variant="outline" className="text-xs">
              Filtered by trip
            </Badge>
          )}
        </div>
        <Tabs value={assetType} onValueChange={(v) => onAssetTypeChange(v as 'driver' | 'carrier')}>
          <TabsList>
            <TabsTrigger value="driver">
              <Users className="h-4 w-4 mr-1" />
              Drivers ({driversToShow.length})
            </TabsTrigger>
            <TabsTrigger value="carrier">
              <Building2 className="h-4 w-4 mr-1" />
              Carriers ({activeCarriers.length})
            </TabsTrigger>
          </TabsList>
        </Tabs>
      </div>

      {/* Table */}
      <Card className="flex-1 min-h-0 overflow-hidden py-0">
        <div className="h-full overflow-y-auto">
          {assetType === 'driver' ? (
            <>
              {/* Driver Table Header - Sticky */}
              <div className="grid grid-cols-[1fr_120px_100px_80px_120px] gap-4 px-4 py-2 border-b bg-muted/50 text-sm font-medium text-muted-foreground sticky top-0 z-10">
                <div>Driver</div>
                <div>Equipment</div>
                <div>Truck #</div>
                <div>Deadhead</div>
                <div>Location</div>
              </div>

              {/* Loading state - only show when we expect data but have none */}
              {driversToShow.length === 0 && allDrivers.length === 0 && (
                <div className="p-4 space-y-3">
                  {[...Array(3)].map((_, i) => (
                    <Skeleton key={i} className="h-12 w-full" />
                  ))}
                </div>
              )}

              {/* Empty state */}
              {driversToShow.length === 0 && allDrivers.length > 0 && (
                <div className="p-8 text-center text-muted-foreground">
                  <Users className="h-12 w-12 mx-auto mb-3 opacity-50" />
                  <p>No available drivers for this time window</p>
                </div>
              )}

              {/* Driver Rows - Compact */}
              {driversToShow.map((driver) => {
                  const equipmentMatch = isEquipmentMatch(driver.assignedTruck?.bodyType);
                  const isUnavailable = unavailableDriverIds.has(driver._id);

                  return (
                    <div
                      key={driver._id}
                      onClick={() => handleDriverClick(driver._id)}
                      className={cn(
                        'grid grid-cols-[1fr_120px_100px_80px_120px] gap-4 px-4 py-2 border-b cursor-pointer transition-colors',
                        'hover:bg-muted/50',
                        selectedDriverId === driver._id &&
                          'bg-primary/10 ring-2 ring-primary ring-inset',
                        isUnavailable && 'opacity-50'
                      )}
                    >
                      {/* Driver Name & Phone */}
                      <div>
                        <div className="font-medium text-sm">
                          {driver.firstName} {driver.lastName}
                        </div>
                        <div className="text-xs text-muted-foreground">{driver.phone}</div>
                      </div>

                      {/* Equipment */}
                      <div>
                        {driver.assignedTruck?.bodyType ? (
                          <Badge
                            variant={equipmentMatch ? 'default' : 'secondary'}
                            className={cn(
                              'text-xs',
                              equipmentMatch && 'bg-green-100 text-green-800 border-green-200'
                            )}
                          >
                            {equipmentMatch && <CheckCircle2 className="h-3 w-3 mr-1" />}
                            {driver.assignedTruck.bodyType}
                          </Badge>
                        ) : (
                          <span className="text-muted-foreground">—</span>
                        )}
                      </div>

                      {/* Truck # */}
                      <div className="text-sm">
                        {driver.assignedTruck?.unitId ? (
                          <div className="flex items-center gap-1">
                            <Truck className="h-3 w-3 text-muted-foreground" />
                            {driver.assignedTruck.unitId}
                          </div>
                        ) : (
                          <span className="text-muted-foreground">—</span>
                        )}
                      </div>

                      {/* Deadhead - placeholder until Google Maps integration */}
                      <div className="text-sm">
                        {driver.assignedTruck?.lastLocationLat ? (
                          <span className="text-muted-foreground">—</span>
                        ) : driver.city && driver.state ? (
                          <span className="text-muted-foreground text-xs italic">~— mi (Home)</span>
                        ) : (
                          <span className="text-muted-foreground">—</span>
                        )}
                      </div>

                      {/* Location */}
                      <div className="flex items-center gap-1 text-sm text-muted-foreground">
                        <MapPin className="h-3 w-3" />
                        <span className="truncate">
                          {driver.city && driver.state
                            ? `${driver.city}, ${driver.state}`
                            : '—'}
                        </span>
                      </div>
                    </div>
                  );
                })}
            </>
          ) : (
            <>
              {/* Carrier Table Header - Sticky */}
              <div className="grid grid-cols-[1fr_90px_1fr_100px_60px] gap-4 px-4 py-2 border-b bg-muted/50 text-sm font-medium text-muted-foreground sticky top-0 z-10">
                <div>Company</div>
                <div>MC#</div>
                <div>Contact</div>
                <div>Phone</div>
                <div>Rate</div>
              </div>

              {/* Empty state */}
              {activeCarriers.length === 0 && (
                <div className="p-8 text-center text-muted-foreground">
                  <Building2 className="h-12 w-12 mx-auto mb-3 opacity-50" />
                  <p>No active carrier partnerships</p>
                </div>
              )}

              {/* Carrier Rows - Compact */}
              {activeCarriers.map((carrier) => (
                <div
                  key={carrier._id}
                  onClick={() => handleCarrierClick(carrier._id)}
                  className={cn(
                    'grid grid-cols-[1fr_90px_1fr_100px_60px] gap-4 px-4 py-2 border-b cursor-pointer transition-colors',
                    'hover:bg-muted/50',
                    selectedCarrierId === carrier._id &&
                      'bg-primary/10 ring-2 ring-primary ring-inset'
                  )}
                >
                  {/* Company */}
                  <div>
                    <div className="font-medium text-sm truncate">{carrier.carrierName}</div>
                    {carrier.isOwnerOperator && (
                      <span className="text-xs text-muted-foreground">Owner-Op</span>
                    )}
                  </div>

                  {/* MC# */}
                  <div className="text-sm text-muted-foreground">{carrier.mcNumber}</div>

                  {/* Contact */}
                  <div className="text-sm truncate">
                    {carrier.contactFirstName} {carrier.contactLastName}
                  </div>

                  {/* Phone */}
                  <div className="text-sm text-muted-foreground">{carrier.contactPhone || '—'}</div>

                  {/* Rate Indicator */}
                  <div>
                    {carrier.hasDefaultRate ? (
                      <Badge
                        variant="outline"
                        className="text-xs bg-green-50 text-green-700 border-green-200"
                        title={`Contract rate: $${carrier.defaultRate} ${carrier.defaultRateType === 'PER_MILE' ? '/mi' : carrier.defaultRateType === 'PERCENTAGE' ? '%' : ''}`}
                      >
                        <DollarSign className="h-3 w-3" />
                      </Badge>
                    ) : (
                      <span className="text-muted-foreground text-xs">—</span>
                    )}
                  </div>
                </div>
              ))}
            </>
          )}
        </div>
      </Card>
    </div>
  );
}
