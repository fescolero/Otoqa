'use client';

import { useState } from 'react';
import { useMutation } from 'convex/react';
import { useAuthQuery } from '@/hooks/use-auth-query';
import { api } from '@/convex/_generated/api';
import { Id } from '@/convex/_generated/dataModel';
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
  AlertTriangle,
  RefreshCw,
  Plus,
  DollarSign,
  Truck,
  User,
  Split,
} from 'lucide-react';
import { PayLineItemsTable } from './PayLineItemsTable';
import { AddManualRateModal } from './AddManualRateModal';
import { SplitLoadModal } from './SplitLoadModal';

interface DriverPaySectionProps {
  loadId: Id<'loadInformation'>;
  organizationId: string;
  userId: string;
}

export function DriverPaySection({
  loadId,
  organizationId,
  userId,
}: DriverPaySectionProps) {
  const [isAddRateModalOpen, setIsAddRateModalOpen] = useState(false);
  const [isSplitModalOpen, setIsSplitModalOpen] = useState(false);
  const [isRecalculating, setIsRecalculating] = useState(false);

  // Fetch legs for this load
  const legs = useAuthQuery(api.dispatchLegs.getByLoad, { loadId });

  // Fetch payables for this load
  const payablesData = useAuthQuery(api.loadPayables.getByLoad, { loadId });

  // Fetch available drivers, trucks, and trailers
  const drivers = useAuthQuery(api.drivers.list, { organizationId });
  const trucks = useAuthQuery(api.trucks.list, { organizationId });
  const trailers = useAuthQuery(api.trailers.list, { organizationId });

  // Mutations
  const assignDriverMutation = useMutation(api.dispatchLegs.assignDriver);
  const updateLeg = useMutation(api.dispatchLegs.update);
  const recalculatePay = useMutation(api.loadPayables.recalculate);

  // Loading state
  if (!legs || !payablesData || !drivers || !trucks || !trailers) {
    return (
      <Card className="p-6">
        <div className="flex items-center justify-center py-8">
          <p className="text-muted-foreground">Loading driver pay...</p>
        </div>
      </Card>
    );
  }

  // Get the first leg (most loads have a single leg)
  const primaryLeg = legs[0];

  // Extract payables array from the response
  const payables = payablesData.payables;
  const totalPay = payablesData.total;

  // Check for warnings
  const warnings = payables.filter((p: { warningMessage?: string }) => p.warningMessage);
  const hasWarnings = warnings.length > 0;

  // Get assigned driver/truck/trailer info
  const assignedDriver = primaryLeg?.driverId
    ? drivers.find((d) => d._id === primaryLeg.driverId)
    : null;
  const assignedTruck = primaryLeg?.truckId
    ? trucks.find((t) => t._id === primaryLeg.truckId)
    : null;
  const assignedTrailer = primaryLeg?.trailerId
    ? trailers.find((t) => t._id === primaryLeg.trailerId)
    : null;

  const handleDriverChange = async (driverId: string) => {
    if (driverId === 'unassigned') {
      // To unassign a driver, we'd need to update the leg
      if (primaryLeg) {
        try {
          await updateLeg({
            legId: primaryLeg._id,
            driverId: undefined,
            userId,
          });
        } catch (error) {
          console.error('Failed to unassign driver:', error);
        }
      }
      return;
    }

    try {
      // assignDriver creates a leg if none exists, or updates existing
      await assignDriverMutation({
        loadId,
        driverId: driverId as Id<'drivers'>,
        truckId: primaryLeg?.truckId ?? undefined,
        trailerId: primaryLeg?.trailerId ?? undefined,
        userId,
        workosOrgId: organizationId,
      });
    } catch (error) {
      console.error('Failed to assign driver:', error);
    }
  };

  const handleTruckChange = async (truckId: string) => {
    if (!primaryLeg) return;

    try {
      await updateLeg({
        legId: primaryLeg._id,
        truckId: truckId === 'unassigned' ? undefined : (truckId as Id<'trucks'>),
        userId,
      });
    } catch (error) {
      console.error('Failed to assign truck:', error);
    }
  };

  const handleTrailerChange = async (trailerId: string) => {
    if (!primaryLeg) return;

    try {
      await updateLeg({
        legId: primaryLeg._id,
        trailerId: trailerId === 'unassigned' ? undefined : (trailerId as Id<'trailers'>),
        userId,
      });
    } catch (error) {
      console.error('Failed to assign trailer:', error);
    }
  };

  const handleRecalculate = async () => {
    if (!primaryLeg) return;

    setIsRecalculating(true);
    try {
      await recalculatePay({
        legId: primaryLeg._id,
        userId,
      });
    } catch (error) {
      console.error('Failed to recalculate:', error);
    } finally {
      setIsRecalculating(false);
    }
  };

  // Filter active drivers/trucks/trailers
  const activeDrivers = drivers.filter(
    (d) => d.employmentStatus === 'Active' && !d.isDeleted
  );
  const activeTrucks = trucks.filter(
    (t) => t.status === 'Active' && !t.isDeleted
  );
  const activeTrailers = trailers.filter(
    (t) => t.status === 'Active' && !t.isDeleted
  );

  return (
    <Card className="p-6">
      <div className="space-y-6">
        {/* Header with Total */}
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-2">
            <DollarSign className="h-5 w-5 text-muted-foreground" />
            <h2 className="text-xl font-semibold">Driver Pay</h2>
          </div>
          <div className="flex items-center gap-4">
            <div className="text-right">
              <p className="text-sm text-muted-foreground">Total Pay</p>
              <p className="text-2xl font-bold text-green-600">
                ${totalPay.toFixed(2)}
              </p>
            </div>
          </div>
        </div>

        {/* Warning Banner */}
        {hasWarnings && (
          <div className="flex items-start gap-3 p-4 bg-yellow-50 border border-yellow-200 rounded-lg">
            <AlertTriangle className="h-5 w-5 text-yellow-600 flex-shrink-0 mt-0.5" />
            <div>
              <p className="font-medium text-yellow-800">
                Pay calculation warnings
              </p>
              <ul className="mt-1 text-sm text-yellow-700 list-disc list-inside">
                {warnings.map((w: { _id: Id<'loadPayables'>; warningMessage?: string }) => (
                  <li key={w._id}>{w.warningMessage}</li>
                ))}
              </ul>
            </div>
          </div>
        )}

        {/* No Leg Warning */}
        {!primaryLeg && (
          <div className="flex items-start gap-3 p-4 bg-red-50 border border-red-200 rounded-lg">
            <AlertTriangle className="h-5 w-5 text-red-600 flex-shrink-0 mt-0.5" />
            <div>
              <p className="font-medium text-red-800">No dispatch leg found</p>
              <p className="text-sm text-red-700">
                This load does not have a dispatch leg. Pay cannot be calculated
                without one.
              </p>
            </div>
          </div>
        )}

        {/* Assignment Dropdowns */}
        {primaryLeg && (
          <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
            {/* Driver Dropdown */}
            <div>
              <label className="text-sm font-medium text-muted-foreground flex items-center gap-1 mb-2">
                <User className="h-3 w-3" />
                Driver
              </label>
              <Select
                value={assignedDriver?._id ?? 'unassigned'}
                onValueChange={handleDriverChange}
              >
                <SelectTrigger className="w-full">
                  <SelectValue placeholder="Select driver" />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="unassigned">
                    <span className="text-muted-foreground">Unassigned</span>
                  </SelectItem>
                  {activeDrivers.map((driver) => (
                    <SelectItem key={driver._id} value={driver._id}>
                      {driver.firstName} {driver.lastName}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
              {assignedDriver && (
                <p className="text-xs text-muted-foreground mt-1">
                  {assignedDriver.email}
                </p>
              )}
            </div>

            {/* Truck Dropdown */}
            <div>
              <label className="text-sm font-medium text-muted-foreground flex items-center gap-1 mb-2">
                <Truck className="h-3 w-3" />
                Truck
              </label>
              <Select
                value={assignedTruck?._id ?? 'unassigned'}
                onValueChange={handleTruckChange}
              >
                <SelectTrigger className="w-full">
                  <SelectValue placeholder="Select truck" />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="unassigned">
                    <span className="text-muted-foreground">Unassigned</span>
                  </SelectItem>
                  {activeTrucks.map((truck) => (
                    <SelectItem key={truck._id} value={truck._id}>
                      {truck.unitId} - {truck.make} {truck.model}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>

            {/* Trailer Dropdown */}
            <div>
              <label className="text-sm font-medium text-muted-foreground flex items-center gap-1 mb-2">
                <Truck className="h-3 w-3" />
                Trailer
              </label>
              <Select
                value={assignedTrailer?._id ?? 'unassigned'}
                onValueChange={handleTrailerChange}
              >
                <SelectTrigger className="w-full">
                  <SelectValue placeholder="Select trailer" />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="unassigned">
                    <span className="text-muted-foreground">Unassigned</span>
                  </SelectItem>
                  {activeTrailers.map((trailer) => (
                    <SelectItem key={trailer._id} value={trailer._id}>
                      {trailer.unitId} - {trailer.size} {trailer.bodyType}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
          </div>
        )}

        {/* Pay Line Items Table */}
        {primaryLeg && assignedDriver && (
          <PayLineItemsTable
            payables={payables}
            loadId={loadId}
            userId={userId}
          />
        )}

        {/* No Driver Assigned Info */}
        {primaryLeg && !assignedDriver && (
          <div className="text-center py-8 text-muted-foreground">
            <User className="h-12 w-12 mx-auto mb-3 opacity-50" />
            <p>Assign a driver to calculate pay</p>
          </div>
        )}

        {/* Action Buttons */}
        {primaryLeg && assignedDriver && (
          <div className="flex justify-between items-center pt-4 border-t">
            <div className="flex items-center gap-2">
              <Button
                variant="outline"
                onClick={() => setIsAddRateModalOpen(true)}
              >
                <Plus className="h-4 w-4 mr-2" />
                Add Rate
              </Button>
              <Button
                variant="outline"
                onClick={() => setIsSplitModalOpen(true)}
              >
                <Split className="h-4 w-4 mr-2" />
                Split Load
              </Button>
            </div>

            <Button
              variant="secondary"
              onClick={handleRecalculate}
              disabled={isRecalculating}
            >
              <RefreshCw
                className={`h-4 w-4 mr-2 ${isRecalculating ? 'animate-spin' : ''}`}
              />
              {isRecalculating ? 'Recalculating...' : 'Recalculate'}
            </Button>
          </div>
        )}
      </div>

      {/* Add Manual Rate Modal */}
      <AddManualRateModal
        open={isAddRateModalOpen}
        onOpenChange={setIsAddRateModalOpen}
        loadId={loadId}
        legId={primaryLeg?._id}
        driverId={assignedDriver?._id}
        userId={userId}
      />

      {/* Split Load Modal */}
      <SplitLoadModal
        open={isSplitModalOpen}
        onOpenChange={setIsSplitModalOpen}
        loadId={loadId}
        organizationId={organizationId}
        userId={userId}
      />
    </Card>
  );
}
