'use client';

import { useState, useMemo } from 'react';
import { useQuery, useMutation } from 'convex/react';
import { api } from '@/convex/_generated/api';
import { Id } from '@/convex/_generated/dataModel';
import { toast } from 'sonner';

import { TripsTable } from './trips-table';
import { AssetsTable } from './assets-table';
import { IntelligenceSidebar } from './intelligence-sidebar';
import { ConflictModal } from './conflict-modal';
import { FilterToolbar, TripFiltersState } from './trip-filters';

interface DispatchPlannerClientProps {
  organizationId: string;
  userId: string;
  userName: string;
}

export function DispatchPlannerClient({
  organizationId,
  userId,
  userName,
}: DispatchPlannerClientProps) {
  // Core selection state
  const [selectedLoadId, setSelectedLoadId] = useState<Id<'loadInformation'> | null>(null);
  const [selectedDriverId, setSelectedDriverId] = useState<Id<'drivers'> | null>(null);
  const [selectedCarrierId, setSelectedCarrierId] = useState<Id<'carriers'> | null>(null);
  const [assetType, setAssetType] = useState<'driver' | 'carrier'>('driver');

  // Filter state (lifted up for sub-header toolbar)
  const [filters, setFilters] = useState<TripFiltersState>({
    search: '',
    hcr: '',
    tripNumber: '',
    startDate: '',
    endDate: '',
  });

  // Conflict handling
  const [showConflictModal, setShowConflictModal] = useState(false);
  const [conflictData, setConflictData] = useState<{
    orderNumber?: string;
    loadId: Id<'loadInformation'>;
  } | null>(null);

  // Assignment state
  const [isAssigning, setIsAssigning] = useState(false);

  // Reactive queries
  const loadDetails = useQuery(
    api.loads.getByIdWithRange,
    selectedLoadId ? { loadId: selectedLoadId } : 'skip'
  );

  // Get ALL drivers on mount (for default view before trip selection)
  const allDrivers = useQuery(api.dispatchLegs.getAllActiveDrivers, {
    workosOrgId: organizationId,
  });

  // Get available drivers when a trip is selected (filtered by time window)
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

  const activeCarriers = useQuery(api.carriers.getActiveCarriers, {
    workosOrgId: organizationId,
  });

  const driverSchedule = useQuery(
    api.dispatchLegs.getDriverSchedule,
    selectedDriverId ? { driverId: selectedDriverId } : 'skip'
  );

  // Get load counts for KPIs in sidebar
  const loadCounts = useQuery(api.loads.countLoadsByStatus, {
    workosOrgId: organizationId,
  });

  // Mutations
  const assignDriverMutation = useMutation(api.dispatchLegs.assignDriver);
  const assignCarrierMutation = useMutation(api.dispatchLegs.assignCarrier);
  const unassignResourceMutation = useMutation(api.dispatchLegs.unassignResource);

  // Get selected driver/carrier objects
  // Use availableDrivers when a trip is selected, otherwise use allDrivers
  const driversToUse = selectedLoadId ? availableDrivers : allDrivers;

  const selectedDriver = useMemo(() => {
    if (!selectedDriverId || !driversToUse) return null;
    return driversToUse.find((d) => d._id === selectedDriverId) ?? null;
  }, [selectedDriverId, driversToUse]);

  const selectedCarrier = useMemo(() => {
    if (!selectedCarrierId || !activeCarriers) return null;
    return activeCarriers.find((c) => c._id === selectedCarrierId) ?? null;
  }, [selectedCarrierId, activeCarriers]);

  // Handle load selection - clear asset selection when load changes
  const handleSelectLoad = (loadId: Id<'loadInformation'> | null) => {
    setSelectedLoadId(loadId);
    setSelectedDriverId(null);
    setSelectedCarrierId(null);
  };

  // Handle asset type change - clear selection when switching tabs
  const handleAssetTypeChange = (type: 'driver' | 'carrier') => {
    setAssetType(type);
    if (type === 'driver') {
      setSelectedCarrierId(null);
    } else {
      setSelectedDriverId(null);
    }
  };

  // Assignment handler
  const handleAssign = async (force = false) => {
    if (!selectedLoadId) return;
    setIsAssigning(true);

    try {
      if (assetType === 'driver' && selectedDriverId) {
        const result = await assignDriverMutation({
          loadId: selectedLoadId,
          driverId: selectedDriverId,
          truckId: selectedDriver?.assignedTruck?._id, // Pass truck from driver's current assignment
          userId,
          userName,
          workosOrgId: organizationId,
          force,
        });

        if (result.status === 'CONFLICT') {
          setConflictData(result.conflictingLoad);
          setShowConflictModal(true);
          setIsAssigning(false);
          return;
        }

        if (result.status === 'ERROR') {
          toast.error(result.message);
          setIsAssigning(false);
          return;
        }

        // SUCCESS
        toast.success(`Assigned to ${selectedDriver?.firstName} ${selectedDriver?.lastName}`);
        setSelectedDriverId(null);
        setShowConflictModal(false);
      } else if (assetType === 'carrier' && selectedCarrierId) {
        const result = await assignCarrierMutation({
          loadId: selectedLoadId,
          carrierId: selectedCarrierId,
          userId,
          userName,
          workosOrgId: organizationId,
        });

        if (result.status === 'ERROR') {
          toast.error(result.message);
          setIsAssigning(false);
          return;
        }

        toast.success(`Assigned to ${selectedCarrier?.companyName}`);
        setSelectedCarrierId(null);
      }
    } catch (error) {
      console.error('Assignment error:', error);
      toast.error('Failed to assign. Please try again.');
    } finally {
      setIsAssigning(false);
    }
  };

  // Unassign handler
  const handleUnassign = async () => {
    if (!selectedLoadId) return;

    try {
      const result = await unassignResourceMutation({
        loadId: selectedLoadId,
        userId,
        userName,
        workosOrgId: organizationId,
      });

      if (result.status === 'ERROR') {
        toast.error(result.message);
        return;
      }

      toast.success('Assignment removed');
    } catch (error) {
      console.error('Unassign error:', error);
      toast.error('Failed to remove assignment');
    }
  };

  // Force assign from conflict modal
  const handleForceAssign = () => {
    handleAssign(true);
  };

  // Cancel conflict modal
  const handleCancelConflict = () => {
    setShowConflictModal(false);
    setConflictData(null);
  };

  // Calculate toolbar height (40px) for grid height
  const toolbarHeight = 40;

  return (
    <div className="flex flex-col h-[calc(100vh-64px)] overflow-hidden">
      {/* ROW 2: FILTER TOOLBAR (Sub-header below main app header) */}
      <FilterToolbar filters={filters} onFiltersChange={setFilters} />

      {/* MAIN CONTENT GRID */}
      <div className="grid flex-1 grid-cols-[1fr_400px] gap-0 overflow-hidden">
        {/* MAIN WORKSPACE (Left) */}
        <div className="flex flex-col overflow-hidden border-r bg-slate-50/30">
          {/* Trips Table - Top Half */}
          <div className="h-1/2 min-h-0 border-b">
          <TripsTable
              organizationId={organizationId}
              selectedLoadId={selectedLoadId}
              onSelectLoad={handleSelectLoad}
              filters={filters}
              onSearchChange={(search) => setFilters({ ...filters, search })}
              onFiltersChange={setFilters}
            />
          </div>

        {/* Assets Table - Bottom Half */}
        <div className="h-1/2 min-h-0">
          <AssetsTable
            organizationId={organizationId}
            loadDetails={loadDetails ?? null}
            allDrivers={allDrivers ?? []}
            availableDrivers={availableDrivers ?? []}
            activeCarriers={activeCarriers ?? []}
            assetType={assetType}
            onAssetTypeChange={handleAssetTypeChange}
            selectedDriverId={selectedDriverId}
            selectedCarrierId={selectedCarrierId}
            onSelectDriver={setSelectedDriverId}
            onSelectCarrier={setSelectedCarrierId}
          />
        </div>
      </div>

      {/* INTELLIGENCE ZONE (Right - Fixed 400px) */}
      <aside className="h-full min-h-0 overflow-hidden bg-white">
        <IntelligenceSidebar
          loadDetails={loadDetails ?? null}
          selectedDriver={selectedDriver}
          selectedCarrier={selectedCarrier}
          assetType={assetType}
          driverSchedule={driverSchedule ?? null}
          onAssign={() => handleAssign(false)}
          onUnassign={handleUnassign}
          isAssigning={isAssigning}
          totalDrivers={allDrivers?.length ?? 0}
          openLoadsCount={loadCounts?.Open ?? 0}
          organizationId={organizationId}
          userId={userId}
          userName={userName}
        />
      </aside>

        {/* Conflict Modal */}
        <ConflictModal
          open={showConflictModal}
          onOpenChange={setShowConflictModal}
          conflictingLoad={conflictData}
          driverName={
            selectedDriver
              ? `${selectedDriver.firstName} ${selectedDriver.lastName}`
              : ''
          }
          onCancel={handleCancelConflict}
          onForceAssign={handleForceAssign}
          isLoading={isAssigning}
        />
      </div>
    </div>
  );
}
