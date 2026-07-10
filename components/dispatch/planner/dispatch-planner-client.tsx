/**
 * DispatchPlannerClient — full design-fidelity rebuild of the planner.
 *
 * Layout (matches planner-screen.jsx in the Otoqa Web design):
 *   Row 1: search + Open/Assigned tabs + Next-{24,48,72}-hrs range chips + Auto-assign
 *   Row 2: FilterBar + "Filters apply to both panes" hint
 *   Left column (flex 1):
 *     - Top: trips table (compact grid rows, design styling)
 *     - Bottom: assets sub-pane (Drivers / Carriers tabs, driver pinning)
 *   Right pane (360px): TripDetailPanel when a trip is selected, otherwise
 *     an empty-state with a package icon and a "select a trip" message
 *
 * Preserved from the previous implementation:
 *   - assignDriver mutation + overlap detection + OverlapNoticeModal
 *   - CarrierAssignmentModal (opened from the trip detail panel)
 *   - MobileDispatchPlanner for narrow viewports
 *
 * AI affordances ("Suggest driver", "Auto-assign…") are intentionally stubbed
 * — they toast "Coming soon" and don't yet exercise a recommender, which
 * doesn't exist in the backend.
 *
 * The intelligence sidebar (overlap timeline, deadhead detail) was retired
 * from this view per the new design. Per-row deadhead is still surfaced in
 * the Assets sub-pane; overlap detection at assignment time still fires.
 */

'use client';

import * as React from 'react';
import { useRouter } from 'next/navigation';
import { useQuery, useMutation, usePaginatedQuery, useConvexAuth } from 'convex/react';
import { useVirtualizer } from '@tanstack/react-virtual';
import { useAuthQuery } from '@/hooks/use-auth-query';
import { api } from '@/convex/_generated/api';
import type { Id } from '@/convex/_generated/dataModel';
import { toast } from 'sonner';

import {
  Avatar,
  Chip,
  type ChipStatus,
  FilterBar,
  type FilterChipValue,
  type FilterProperty,
  Kbd,
  parseDateRangeValue,
  WBtn,
  WIcon,
} from '@/components/web';
import { OverlapNoticeModal, type OverlapDetail } from './conflict-modal';
import {
  CarrierAssignmentModal,
} from './carrier-assignment-modal';
import { MobileDispatchPlanner } from './mobile-dispatch-planner';
import { useIsMobile } from '@/hooks/use-mobile';
import { formatDateOnly } from '@/lib/format-date-timezone';
import { format } from 'date-fns';

// ============================================================================
// Props
// ============================================================================

interface DispatchPlannerClientProps {
  organizationId: string;
  userId: string;
  userName: string;
  initialSearch?: string;
}

// ============================================================================
// Component
// ============================================================================

export function DispatchPlannerClient({
  organizationId,
  userId,
  userName,
  initialSearch,
}: DispatchPlannerClientProps) {
  const isMobile = useIsMobile();
  if (isMobile) {
    return (
      <MobileDispatchPlanner
        organizationId={organizationId}
        userId={userId}
        userName={userName}
        initialSearch={initialSearch}
      />
    );
  }
  return (
    <PlannerScreen
      organizationId={organizationId}
      userId={userId}
      userName={userName}
      initialSearch={initialSearch}
    />
  );
}

function PlannerScreen({
  organizationId,
  userId,
  userName,
  initialSearch,
}: DispatchPlannerClientProps) {
  const router = useRouter();

  // Selection
  const [selectedLoadId, setSelectedLoadId] = React.useState<Id<'loadInformation'> | null>(null);
  const [selectedDriverId, setSelectedDriverId] = React.useState<Id<'drivers'> | null>(null);
  const [selectedCarrierId, setSelectedCarrierId] = React.useState<Id<'carrierPartnerships'> | null>(null);
  const [assetTab, setAssetTab] = React.useState<'driver' | 'carrier'>('driver');

  // Filters — header tabs + FilterBar + search
  const [statusTab, setStatusTab] = React.useState<'Open' | 'Assigned'>('Open');
  const [search, setSearch] = React.useState(initialSearch ?? '');
  const [filterChips, setFilterChips] = React.useState<FilterChipValue[]>([]);

  // Driver pinning (client-side only; persistence is a follow-up)
  const [pinnedDriverIds, setPinnedDriverIds] = React.useState<Set<string>>(new Set());

  // Assignment / overlap state
  const [isAssigning, setIsAssigning] = React.useState(false);
  const [overlapModalOpen, setOverlapModalOpen] = React.useState(false);
  const [overlapDetails, setOverlapDetails] = React.useState<OverlapDetail[]>([]);
  const [overlapDriverName, setOverlapDriverName] = React.useState('');

  // Carrier assignment modal state
  const [carrierModalOpen, setCarrierModalOpen] = React.useState(false);

  // ── Queries ────────────────────────────────────────────────────────────
  const filterValues = useAuthQuery(api.loads.getDistinctFilterValues, {
    workosOrgId: organizationId,
  });

  // Resolve filter chips → backend filter args
  const hcrFilter = chipValuesFor(filterChips, 'hcr')[0] ?? '';
  const tripFilter = chipValuesFor(filterChips, 'trip')[0] ?? '';

  // Date range — derived from the FilterBar `date` chip. The Row-1
  // Next-{24,48,72}-hrs pills (defined below as applyHoursRange) write
  // into the same chip list, so both UIs stay in sync; the resolved
  // YYYY-MM-DD pair travels into the loads query.
  const dateRange = React.useMemo<{ start?: string; end?: string }>(() => {
    const chip = filterChips.find(c => c.propId === 'date');
    const raw = chip?.values?.[0];
    if (!raw) return {};
    return resolveDatePreset(raw);
  }, [filterChips]);

  // Infinite-scroll the trips list. usePaginatedQuery injects `paginationOpts`
  // itself and accumulates pages into `loads`, so the planner is no longer
  // capped at the first 100 trips. Gated on auth the same way useAuthQuery is.
  const { isAuthenticated } = useConvexAuth();
  const {
    results: loads,
    status: loadsStatus,
    loadMore: loadMoreLoads,
  } = usePaginatedQuery(
    api.loads.getLoads,
    isAuthenticated
      ? {
          workosOrgId: organizationId,
          status: statusTab,
          search: search || undefined,
          hcr: hcrFilter || undefined,
          tripNumber: tripFilter || undefined,
          startDate: dateRange.start,
          endDate: dateRange.end,
        }
      : 'skip',
    { initialNumItems: 100 },
  );

  // Tab badges (Open / Assigned) reflect the active FilterBar scope.
  // Without this, picking HCR=95632 (which has 0 Open + ~17 Assigned)
  // shows "Open 1345" next to an empty trips list — hiding the fact
  // that the matches all live in the Assigned tab. The query has a
  // fast path for the no-filter case (denormalized org stats), so
  // this stays cheap on first paint.
  const loadCounts = useAuthQuery(api.loads.countLoadsByStatusFiltered, {
    workosOrgId: organizationId,
    hcr: hcrFilter || undefined,
    tripNumber: tripFilter || undefined,
    startDate: dateRange.start,
    endDate: dateRange.end,
  });

  const loadDetails = useQuery(
    api.loads.getByIdWithRange,
    selectedLoadId ? { loadId: selectedLoadId } : 'skip',
  );

  const allDrivers = useAuthQuery(api.dispatchLegs.getAllActiveDrivers, {
    workosOrgId: organizationId,
  });

  const availableDrivers = useQuery(
    api.dispatchLegs.getAvailableDrivers,
    loadDetails?.startTime
      ? {
          workosOrgId: organizationId,
          startTime: loadDetails.startTime,
          endTime: loadDetails.endTime!,
          excludeLoadId: selectedLoadId ?? undefined,
        }
      : 'skip',
  );

  const activeCarriers = useAuthQuery(api.carrierPartnerships.getActiveForDispatch, {
    brokerOrgId: organizationId,
  });

  // Use available drivers when a trip is picked (so overlap/deadhead reflects
  // the trip's time window); else show all active drivers.
  const driversList = selectedLoadId ? availableDrivers ?? [] : allDrivers ?? [];
  const carriersList = activeCarriers ?? [];

  // Quick lookup maps for the trips table's "Assignment" column. We use
  // `allDrivers` (every active driver in the org) rather than `driversList`
  // — driversList may be the filtered "available drivers for this trip"
  // shape which excludes drivers already booked on the trip we're viewing.
  const driverNameById = React.useMemo(() => {
    const m = new Map<string, string>();
    for (const d of allDrivers ?? []) {
      m.set(d._id, `${d.firstName} ${d.lastName}`);
    }
    return m;
  }, [allDrivers]);
  const carrierNameById = React.useMemo(() => {
    const m = new Map<string, string>();
    for (const c of activeCarriers ?? []) {
      m.set(c._id, c.carrierName);
    }
    return m;
  }, [activeCarriers]);

  // ── Mutations ──────────────────────────────────────────────────────────
  const assignDriverMutation = useMutation(api.dispatchLegs.assignDriver);

  // ── Filter properties (for FilterBar) ──────────────────────────────────
  const filterProps: FilterProperty[] = React.useMemo(
    () => [
      {
        id: 'hcr',
        label: 'HCR',
        icon: 'doc-dollar',
        kind: 'enum',
        operator: 'is',
        options: (filterValues?.hcrs ?? []).map(h => ({ value: h, label: h })),
      },
      {
        id: 'trip',
        label: 'Trip',
        icon: 'route',
        kind: 'enum',
        operator: 'is',
        options: (filterValues?.trips ?? []).map(t => ({ value: t, label: t })),
      },
      {
        id: 'date',
        label: 'Date range',
        icon: 'calendar',
        kind: 'date',
        presets: ['Today', 'Tomorrow', 'Next 24 hrs', 'Next 48 hrs', 'Next 72 hrs', 'This week', 'Custom range'],
      },
    ],
    [filterValues],
  );

  // ── Range chip handlers — write into filterChips so the FilterBar
  // (single source of truth) and the Row-1 pills stay in sync.
  const applyHoursRange = (hours: number) => {
    const preset = `Next ${hours} hrs`;
    setFilterChips(prev => upsertDateChip(prev, preset));
  };
  const clearRange = () => {
    setFilterChips(prev => prev.filter(c => c.propId !== 'date'));
  };
  const isRangeActive = (hours: number): boolean => {
    const chip = filterChips.find(c => c.propId === 'date');
    return chip?.values?.[0] === `Next ${hours} hrs`;
  };

  // ── Selection handlers ─────────────────────────────────────────────────
  const handleSelectTrip = (loadId: Id<'loadInformation'>) => {
    if (selectedLoadId === loadId) {
      setSelectedLoadId(null);
      setSelectedDriverId(null);
      setSelectedCarrierId(null);
      return;
    }
    setSelectedLoadId(loadId);
    setSelectedDriverId(null);
    setSelectedCarrierId(null);
  };

  const togglePinDriver = (driverId: string) => {
    setPinnedDriverIds(prev => {
      const next = new Set(prev);
      if (next.has(driverId)) next.delete(driverId);
      else next.add(driverId);
      return next;
    });
  };

  // ── Auto-assign: navigate to rules manager ─────────────────────────────
  const handleAutoAssign = () => {
    router.push('/route-assignments');
  };

  // ── Open: navigate to load detail ──────────────────────────────────────
  const handleOpenLoad = () => {
    if (!selectedLoadId) return;
    router.push(`/loads/${selectedLoadId}`);
  };

  // ── Drag & drop driver onto trip = quick assign ────────────────────────
  // Keep this for power users — drag handle is the row's pointer:grab style.
  const handleAssignSelectedDriver = async () => {
    if (!selectedLoadId || !selectedDriverId) return;
    const driver = driversList.find(d => d._id === selectedDriverId);
    setIsAssigning(true);
    try {
      const result = await assignDriverMutation({
        loadId: selectedLoadId,
        driverId: selectedDriverId,
        truckId: driver?.assignedTruck?._id,
        userId,
        userName,
        workosOrgId: organizationId,
      });
      if (result.status === 'ERROR') {
        toast.error(result.message);
        return;
      }
      const driverName = driver ? `${driver.firstName} ${driver.lastName}` : '';
      if (result.overlaps && result.overlaps.length > 0) {
        setOverlapDetails(result.overlaps);
        setOverlapDriverName(driverName);
        setOverlapModalOpen(true);
        toast.success(`Assigned to ${driverName} (schedule overlap detected)`);
      } else {
        toast.success(`Assigned to ${driverName}`);
      }
      setSelectedDriverId(null);
    } catch (e) {
      console.error(e);
      toast.error('Failed to assign. Please try again.');
    } finally {
      setIsAssigning(false);
    }
  };

  const handleOpenCarrierAssignment = () => {
    if (!selectedLoadId || !selectedCarrierId) return;
    setCarrierModalOpen(true);
  };

  // ── Selected trip data for the right pane ──────────────────────────────
  const selectedTrip = selectedLoadId ? loadDetails ?? null : null;
  const selectedCarrier =
    selectedCarrierId ? carriersList.find(c => c._id === selectedCarrierId) ?? null : null;

  // ── Render ─────────────────────────────────────────────────────────────
  // h-full + min-h-0 so we fill exactly what the parent (`flex-1
  // overflow-hidden` on the page) gives us. The previous hardcoded
  // `calc(100vh - 64px)` assumed the breadcrumb header is always 64px,
  // but it collapses to 48px when the sidebar is collapsed — and missing
  // a few px makes the pinned trip-detail footer sit below the fold.
  return (
    <div className="flex flex-col h-full min-h-0 overflow-hidden min-w-0">
      {/* Row 1 — global controls */}
      <PlannerHeaderRow1
        search={search}
        onSearchChange={setSearch}
        statusTab={statusTab}
        onStatusTabChange={setStatusTab}
        openCount={loadCounts?.Open ?? 0}
        assignedCount={loadCounts?.Assigned ?? 0}
        isRangeActive={isRangeActive}
        onPickRange={applyHoursRange}
        onClearRange={clearRange}
        onAutoAssign={handleAutoAssign}
      />

      {/* Row 2 — FilterBar + hint */}
      <PlannerHeaderRow2
        filterProps={filterProps}
        filterChips={filterChips}
        onFilterChipsChange={setFilterChips}
      />

      {/* Main split */}
      <div className="flex-1 flex min-h-0 min-w-0">
        {/* Left column */}
        <div
          className="flex-1 flex flex-col min-w-0"
          style={{ borderRight: '1px solid var(--border-hairline)' }}
        >
          {/* Trips table */}
          <PlannerTripsTable
            loads={loads}
            isLoading={loadsStatus === 'LoadingFirstPage'}
            canLoadMore={loadsStatus === 'CanLoadMore'}
            onEndReached={() => loadMoreLoads(100)}
            selectedLoadId={selectedLoadId}
            onSelect={handleSelectTrip}
            driverNameById={driverNameById}
            carrierNameById={carrierNameById}
          />

          {/* Assets sub-pane */}
          <PlannerAssetsPane
            assetTab={assetTab}
            onAssetTabChange={t => {
              setAssetTab(t);
              if (t === 'driver') setSelectedCarrierId(null);
              else setSelectedDriverId(null);
            }}
            drivers={driversList}
            carriers={carriersList}
            selectedDriverId={selectedDriverId}
            selectedCarrierId={selectedCarrierId}
            onSelectDriver={id => {
              setSelectedDriverId(prev => (prev === id ? null : id));
            }}
            onSelectCarrier={id => {
              setSelectedCarrierId(prev => (prev === id ? null : id));
            }}
            pinnedDriverIds={pinnedDriverIds}
            onTogglePinDriver={togglePinDriver}
          />
        </div>

        {/* Right pane */}
        <aside
          style={{
            width: 360,
            flexShrink: 0,
            background: 'var(--bg-surface)',
            display: 'flex',
            flexDirection: 'column',
            minHeight: 0,
          }}
        >
          {!selectedTrip ? (
            <EmptyTripPane />
          ) : (
            <TripDetailPanel
              trip={selectedTrip}
              assignment={{
                // The footer Assign button reads from whichever asset tab is
                // active. Selection lives in the assets pane (or eventually
                // the suggestions UI elsewhere); this panel just dispatches.
                assetTab,
                hasSelection:
                  assetTab === 'driver' ? !!selectedDriverId : !!selectedCarrierId,
                isAssigning,
                onAssign:
                  assetTab === 'driver'
                    ? handleAssignSelectedDriver
                    : handleOpenCarrierAssignment,
              }}
              onOpenLoad={handleOpenLoad}
            />
          )}
        </aside>
      </div>

      {/* Overlap notice modal */}
      <OverlapNoticeModal
        open={overlapModalOpen}
        onOpenChange={setOverlapModalOpen}
        overlaps={overlapDetails}
        driverName={overlapDriverName}
        onDismiss={() => {
          setOverlapModalOpen(false);
          setOverlapDetails([]);
          setOverlapDriverName('');
        }}
      />

      {/* Carrier assignment modal */}
      <CarrierAssignmentModal
        open={carrierModalOpen}
        onOpenChange={setCarrierModalOpen}
        carrier={selectedCarrier}
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
        onSuccess={() => setSelectedCarrierId(null)}
      />
    </div>
  );
}

// ============================================================================
// Header rows
// ============================================================================

function PlannerHeaderRow1({
  search,
  onSearchChange,
  statusTab,
  onStatusTabChange,
  openCount,
  assignedCount,
  isRangeActive,
  onPickRange,
  onClearRange,
  onAutoAssign,
}: {
  search: string;
  onSearchChange: (v: string) => void;
  statusTab: 'Open' | 'Assigned';
  onStatusTabChange: (t: 'Open' | 'Assigned') => void;
  openCount: number;
  assignedCount: number;
  isRangeActive: (hours: number) => boolean;
  onPickRange: (hours: number) => void;
  onClearRange: () => void;
  onAutoAssign: () => void;
}) {
  return (
    <div
      className="flex items-center gap-3 flex-shrink-0"
      style={{
        height: 56,
        padding: '0 24px',
        borderBottom: '1px solid var(--border-hairline)',
        background: 'var(--bg-surface)',
      }}
    >
      {/* Search */}
      <div
        className="flex items-center gap-2 flex-shrink-0"
        style={{
          width: 280,
          height: 32,
          padding: '0 10px',
          borderRadius: 8,
          background: 'var(--bg-surface-2)',
          border: '1px solid var(--border-hairline)',
        }}
      >
        <WIcon name="search" size={14} />
        <input
          placeholder="Search order #, customer…"
          value={search}
          onChange={e => onSearchChange(e.target.value)}
          style={{
            flex: 1,
            border: 0,
            outline: 0,
            background: 'transparent',
            fontSize: 12.5,
            color: 'var(--text-primary)',
            fontFamily: 'inherit',
            height: 32,
          }}
        />
        <Kbd>/</Kbd>
      </div>

      {/* Open / Assigned tab toggle */}
      <div
        className="inline-flex"
        style={{
          height: 32,
          borderRadius: 8,
          border: '1px solid var(--border-hairline)',
          background: 'var(--bg-surface)',
          overflow: 'hidden',
        }}
      >
        {(
          [
            { id: 'Open' as const, label: 'Open', count: openCount },
            { id: 'Assigned' as const, label: 'Assigned', count: assignedCount },
          ]
        ).map((t, i) => {
          const active = statusTab === t.id;
          return (
            <button
              key={t.id}
              onClick={() => onStatusTabChange(t.id)}
              className="focus-ring"
              style={{
                height: '100%',
                padding: '0 14px',
                cursor: 'pointer',
                fontFamily: 'inherit',
                background: active ? 'var(--bg-surface-2)' : 'var(--bg-surface)',
                color: active ? 'var(--text-primary)' : 'var(--text-secondary)',
                fontSize: 12.5,
                fontWeight: active ? 500 : 400,
                border: 'none',
                borderLeft: i > 0 ? '1px solid var(--border-hairline)' : 'none',
              }}
              onMouseEnter={e => {
                if (!active) e.currentTarget.style.background = 'var(--bg-row-hover)';
              }}
              onMouseLeave={e => {
                if (!active) e.currentTarget.style.background = 'var(--bg-surface)';
              }}
            >
              {t.label}{' '}
              <span className="num" style={{ marginLeft: 4, color: 'var(--text-tertiary)' }}>
                {t.count}
              </span>
            </button>
          );
        })}
      </div>

      {/* Range chips */}
      <div className="flex items-center gap-1.5">
        {[24, 48, 72].map(h => {
          const active = isRangeActive(h);
          return (
            <button
              key={h}
              onClick={() => (active ? onClearRange() : onPickRange(h))}
              className="focus-ring"
              style={{
                height: 28,
                padding: '0 10px',
                borderRadius: 6,
                background: active ? 'rgba(46,92,255,0.10)' : 'var(--bg-surface)',
                border: '1px solid ' + (active ? 'var(--accent)' : 'var(--border-hairline)'),
                color: active ? 'var(--accent)' : 'var(--text-secondary)',
                fontSize: 12,
                fontFamily: 'inherit',
                cursor: 'pointer',
                fontWeight: active ? 600 : 400,
              }}
            >
              Next {h} hrs
            </button>
          );
        })}
      </div>

      <div style={{ flex: 1 }} />

      <WBtn size="sm" leading="sparkle" onClick={onAutoAssign}>
        Auto-assign…
      </WBtn>
    </div>
  );
}

function PlannerHeaderRow2({
  filterProps,
  filterChips,
  onFilterChipsChange,
}: {
  filterProps: FilterProperty[];
  filterChips: FilterChipValue[];
  onFilterChipsChange: (next: FilterChipValue[]) => void;
}) {
  return (
    <div
      className="flex items-center gap-2 flex-shrink-0"
      style={{
        minHeight: 48,
        padding: '8px 24px',
        borderBottom: '1px solid var(--border-hairline)',
        background: 'var(--bg-surface)',
      }}
    >
      <FilterBar
        properties={filterProps}
        value={filterChips}
        onChange={onFilterChipsChange}
      />
      <div style={{ flex: 1 }} />
      <span style={{ fontSize: 11.5, color: 'var(--text-tertiary)' }}>
        Filters apply to both panes
      </span>
    </div>
  );
}

// ============================================================================
// Trips table (left top)
// ============================================================================

type LoadRow = {
  _id: Id<'loadInformation'>;
  orderNumber?: string;
  internalId?: string;
  customerName?: string;
  origin?: { city?: string; state?: string } | null;
  destination?: { city?: string; state?: string } | null;
  equipmentType?: string;
  effectiveMiles?: number;
  firstStopDate?: string;
  status?: string;
  // HCR + Trip identifiers — getLoads already enriches these via
  // getLoadFacets (the columns were dropped in Phase 5b of the schema
  // migration; values now live in loadTags).
  parsedHcr?: string;
  parsedTripNumber?: string;
  // Used to resolve the "Assignment" column — looked up against the
  // planner's already-loaded driver/carrier maps so we don't add a backend
  // round-trip.
  primaryDriverId?: Id<'drivers'>;
  primaryCarrierPartnershipId?: Id<'carrierPartnerships'>;
};

// Grid columns: Order # | Customer | HCR | Trip | Route | Assignment | Miles | Pickup
const TRIPS_GRID = '110px 90px 75px 85px 1fr 110px 70px 80px';

function PlannerTripsTable({
  loads,
  isLoading,
  canLoadMore,
  onEndReached,
  selectedLoadId,
  onSelect,
  driverNameById,
  carrierNameById,
}: {
  loads: LoadRow[];
  isLoading: boolean;
  canLoadMore: boolean;
  onEndReached: () => void;
  selectedLoadId: Id<'loadInformation'> | null;
  onSelect: (id: Id<'loadInformation'>) => void;
  /** Resolves load.primaryDriverId → "Christian Lozano Trejo". Built from the
   *  planner's `allDrivers` query, so it's always fresh. */
  driverNameById: Map<string, string>;
  /** Same idea for load.primaryCarrierPartnershipId. */
  carrierNameById: Map<string, string>;
}) {
  const scrollRef = React.useRef<HTMLDivElement>(null);

  // Virtualize rows so the list stays smooth across thousands of trips.
  // Row heights are fixed (36px), so a constant estimateSize is exact.
  const rowVirtualizer = useVirtualizer({
    count: loads.length,
    getScrollElement: () => scrollRef.current,
    estimateSize: () => 36,
    overscan: 16,
  });

  // Infinite-scroll trigger — fires `onEndReached` once per scroll-into-zone
  // crossing; re-arms when the user scrolls back up or new rows extend the
  // scroll height. Mirrors the web Table's loader.
  const firedRef = React.useRef(false);
  React.useEffect(() => {
    const el = scrollRef.current;
    if (!el || !canLoadMore) return;
    const onScroll = () => {
      const remaining = el.scrollHeight - el.scrollTop - el.clientHeight;
      if (remaining <= 320) {
        if (!firedRef.current) {
          firedRef.current = true;
          onEndReached();
        }
      } else {
        firedRef.current = false;
      }
    };
    el.addEventListener('scroll', onScroll, { passive: true });
    onScroll();
    return () => el.removeEventListener('scroll', onScroll);
  }, [canLoadMore, onEndReached, loads.length]);

  return (
    <div
      ref={scrollRef}
      className="scroll-thin"
      style={{
        flex: 1,
        minHeight: 0,
        overflow: 'auto',
        background: 'var(--bg-surface)',
      }}
    >
      {/* Sticky header */}
      <div
        className="grid uppercase"
        style={{
          gridTemplateColumns: TRIPS_GRID,
          padding: '8px 24px',
          fontSize: 10.5,
          fontWeight: 600,
          color: 'var(--text-tertiary)',
          letterSpacing: 0.05,
          position: 'sticky',
          top: 0,
          background: 'var(--bg-surface-2)',
          borderBottom: '1px solid var(--border-hairline)',
          zIndex: 1,
        }}
      >
        <span>Order #</span>
        <span>Customer</span>
        <span>HCR</span>
        <span>Trip</span>
        <span>Route</span>
        <span>Assignment</span>
        <span style={{ textAlign: 'right' }}>Miles</span>
        <span style={{ textAlign: 'right' }}>Pickup</span>
      </div>

      {isLoading && (
        <div
          style={{
            padding: 24,
            textAlign: 'center',
            fontSize: 12,
            color: 'var(--text-tertiary)',
          }}
        >
          Loading…
        </div>
      )}
      {!isLoading && loads.length === 0 && (
        <div
          className="flex flex-col items-center gap-2"
          style={{ padding: 32, textAlign: 'center', color: 'var(--text-tertiary)' }}
        >
          <WIcon name="package" size={20} />
          <span style={{ fontSize: 12.5 }}>No matching trips</span>
        </div>
      )}
      {!isLoading && loads.length > 0 && (
        <div style={{ height: rowVirtualizer.getTotalSize(), position: 'relative' }}>
          {rowVirtualizer.getVirtualItems().map(vi => {
          const t = loads[vi.index];
          const selected = t._id === selectedLoadId;
          const from = [t.origin?.city, t.origin?.state].filter(Boolean).join(', ') || '—';
          const to = [t.destination?.city, t.destination?.state].filter(Boolean).join(', ') || '—';
          return (
            <div
              key={t._id}
              onClick={() => onSelect(t._id)}
              className="grid items-center"
              style={{
                gridTemplateColumns: TRIPS_GRID,
                padding: '8px 24px',
                minHeight: 36,
                borderBottom: '1px solid var(--border-hairline)',
                fontSize: 12.5,
                cursor: 'pointer',
                background: selected ? 'var(--bg-sidebar-active)' : 'transparent',
                position: 'absolute',
                top: 0,
                left: 0,
                width: '100%',
                height: vi.size,
                transform: `translateY(${vi.start}px)`,
              }}
              onMouseEnter={e => {
                if (!selected) e.currentTarget.style.background = 'var(--bg-row-hover)';
              }}
              onMouseLeave={e => {
                if (!selected) e.currentTarget.style.background = '';
              }}
            >
              <span
                className="num truncate"
                style={{ color: 'var(--accent)', fontWeight: 500 }}
              >
                {t.orderNumber || t.internalId}
              </span>
              <span className="truncate">{t.customerName || '—'}</span>
              {/* HCR + Trip identifiers — pulled from the loadTags facet
                  store and enriched onto the load row by getLoads. */}
              <span
                className="num truncate"
                style={{
                  color: t.parsedHcr ? 'var(--text-primary)' : 'var(--text-tertiary)',
                }}
                title={t.parsedHcr ?? undefined}
              >
                {t.parsedHcr ?? '—'}
              </span>
              <span
                className="num truncate"
                style={{
                  color: t.parsedTripNumber
                    ? 'var(--text-primary)'
                    : 'var(--text-tertiary)',
                }}
                title={t.parsedTripNumber ?? undefined}
              >
                {t.parsedTripNumber ?? '—'}
              </span>
              <span
                className="flex items-center gap-1.5"
                style={{ minWidth: 0 }}
              >
                <span className="truncate">{from}</span>
                <WIcon name="arrow-right" size={10} />
                <span className="truncate">{to}</span>
              </span>
              {/* Assignment — resolves the load's primaryDriverId or
                  primaryCarrierPartnershipId to a name via the maps built
                  from the planner's already-loaded driver/carrier queries.
                  Unassigned loads show "—" in tertiary text. */}
              {(() => {
                const driverName = t.primaryDriverId
                  ? driverNameById.get(t.primaryDriverId)
                  : null;
                const carrierName = t.primaryCarrierPartnershipId
                  ? carrierNameById.get(t.primaryCarrierPartnershipId)
                  : null;
                const label = driverName ?? carrierName ?? null;
                return (
                  <span
                    style={{ color: label ? 'var(--text-primary)' : 'var(--text-tertiary)' }}
                    className="truncate"
                    title={label ?? undefined}
                  >
                    {label ?? '—'}
                  </span>
                );
              })()}
              <span className="num" style={{ textAlign: 'right' }}>
                {t.effectiveMiles?.toFixed(0) ?? '—'}
              </span>
              <span className="num" style={{ textAlign: 'right' }}>
                {t.firstStopDate ? formatDateOnly(t.firstStopDate).display : '—'}
              </span>
            </div>
          );
          })}
        </div>
      )}
    </div>
  );
}

// ============================================================================
// Assets pane (left bottom)
// ============================================================================

type DriverRow = {
  _id: Id<'drivers'>;
  firstName: string;
  lastName: string;
  city?: string;
  state?: string;
  assignedTruck?: {
    _id: Id<'trucks'>;
    unitId: string;
    bodyType?: string;
  } | null;
  overlap?: { conflictCount?: number } | null;
};

type CarrierRow = {
  _id: Id<'carrierPartnerships'>;
  carrierName: string;
  mcNumber: string;
  city?: string;
  state?: string;
  hasDefaultRate: boolean;
  defaultRate?: number;
  defaultRateType?: 'FLAT' | 'PER_MILE' | 'PERCENTAGE';
};

// Grid columns — driver rows keep one trailing 28px column for the pin
// toggle. The quick-assign column was removed when assignment was moved to
// the trip detail panel's footer. Carrier rows have no trailing action.
const DRIVERS_GRID = '1fr 100px 100px 130px 1fr 28px';
const CARRIERS_GRID = '1fr 110px 1fr 1fr';

function PlannerAssetsPane({
  assetTab,
  onAssetTabChange,
  drivers,
  carriers,
  selectedDriverId,
  selectedCarrierId,
  onSelectDriver,
  onSelectCarrier,
  pinnedDriverIds,
  onTogglePinDriver,
}: {
  assetTab: 'driver' | 'carrier';
  onAssetTabChange: (t: 'driver' | 'carrier') => void;
  drivers: DriverRow[];
  carriers: CarrierRow[];
  selectedDriverId: Id<'drivers'> | null;
  selectedCarrierId: Id<'carrierPartnerships'> | null;
  onSelectDriver: (id: Id<'drivers'>) => void;
  onSelectCarrier: (id: Id<'carrierPartnerships'>) => void;
  pinnedDriverIds: Set<string>;
  onTogglePinDriver: (id: string) => void;
}) {
  const [assetSearch, setAssetSearch] = React.useState('');
  const needle = assetSearch.trim().toLowerCase();

  const filteredDrivers = drivers.filter(d => {
    if (!needle) return true;
    const name = `${d.firstName} ${d.lastName}`.toLowerCase();
    const truck = d.assignedTruck?.unitId?.toLowerCase() ?? '';
    const loc = `${d.city ?? ''} ${d.state ?? ''}`.toLowerCase();
    return name.includes(needle) || truck.includes(needle) || loc.includes(needle);
  });
  const filteredCarriers = carriers.filter(c => {
    if (!needle) return true;
    const name = c.carrierName.toLowerCase();
    return name.includes(needle) || c.mcNumber.toLowerCase().includes(needle);
  });

  const pinnedDrivers = filteredDrivers.filter(d => pinnedDriverIds.has(d._id));
  const restDrivers = filteredDrivers.filter(d => !pinnedDriverIds.has(d._id));

  return (
    <div
      className="flex flex-col"
      style={{
        // Lock the pane to half the column height so the search input + tab
        // toggle + column header stay anchored, and the row LIST below
        // scrolls (or shows empty space when filtered). Without an explicit
        // height the pane would shrink to fit fewer rows and feel jumpy.
        flex: '0 0 50%',
        minHeight: 0,
        borderTop: '1px solid var(--border-hairline)',
      }}
    >
      {/* Header */}
      <div
        className="flex items-center gap-2.5 flex-shrink-0"
        style={{
          height: 40,
          padding: '0 24px',
          background: 'var(--bg-surface)',
          borderBottom: '1px solid var(--border-hairline)',
        }}
      >
        <WIcon name="users" size={14} />
        <span style={{ fontSize: 12.5, fontWeight: 600 }}>Assets</span>

        {/* Search */}
        <div
          className="flex items-center gap-1.5"
          style={{
            marginLeft: 8,
            height: 26,
            padding: '0 8px',
            borderRadius: 6,
            background: 'var(--bg-surface-2)',
            border: '1px solid var(--border-hairline)',
            width: 220,
            flexShrink: 1,
          }}
        >
          <WIcon name="search" size={12} />
          <input
            placeholder={
              assetTab === 'driver'
                ? 'Search drivers, truck #, location…'
                : 'Search carriers…'
            }
            value={assetSearch}
            onChange={e => setAssetSearch(e.target.value)}
            style={{
              flex: 1,
              minWidth: 0,
              border: 0,
              outline: 0,
              background: 'transparent',
              fontSize: 11.5,
              color: 'var(--text-primary)',
              fontFamily: 'inherit',
              height: 26,
            }}
          />
        </div>

        <div style={{ flex: 1 }} />

        {/* Drivers / Carriers tab toggle */}
        <div
          className="inline-flex"
          style={{
            height: 26,
            borderRadius: 6,
            border: '1px solid var(--border-hairline)',
            background: 'var(--bg-surface)',
            overflow: 'hidden',
          }}
        >
          {(
            [
              { id: 'driver' as const, label: 'Drivers', n: drivers.length },
              { id: 'carrier' as const, label: 'Carriers', n: carriers.length },
            ]
          ).map((t, i) => {
            const active = assetTab === t.id;
            return (
              <button
                key={t.id}
                onClick={() => onAssetTabChange(t.id)}
                className="focus-ring"
                style={{
                  height: '100%',
                  padding: '0 10px',
                  cursor: 'pointer',
                  fontFamily: 'inherit',
                  background: active ? 'var(--bg-surface-2)' : 'var(--bg-surface)',
                  color: active ? 'var(--text-primary)' : 'var(--text-secondary)',
                  fontSize: 11.5,
                  fontWeight: active ? 500 : 400,
                  border: 'none',
                  borderLeft: i > 0 ? '1px solid var(--border-hairline)' : 'none',
                }}
                onMouseEnter={e => {
                  if (!active) e.currentTarget.style.background = 'var(--bg-row-hover)';
                }}
                onMouseLeave={e => {
                  if (!active) e.currentTarget.style.background = 'var(--bg-surface)';
                }}
              >
                {t.label}{' '}
                <span className="num" style={{ marginLeft: 3, color: 'var(--text-tertiary)' }}>
                  {t.n}
                </span>
              </button>
            );
          })}
        </div>
      </div>

      {/* List */}
      <div className="scroll-thin" style={{ minHeight: 0, overflow: 'auto' }}>
        {assetTab === 'driver' ? (
          <>
            {/* Column header — sticky so it stays visible as rows scroll. */}
            <div
              className="grid uppercase"
              style={{
                gridTemplateColumns: DRIVERS_GRID,
                padding: '8px 16px 8px 24px',
                fontSize: 10.5,
                fontWeight: 600,
                color: 'var(--text-tertiary)',
                letterSpacing: 0.05,
                background: 'var(--bg-surface-2)',
                borderBottom: '1px solid var(--border-hairline)',
                position: 'sticky',
                top: 0,
                zIndex: 1,
              }}
            >
              <span>Driver</span>
              <span>Equipment</span>
              <span>Truck #</span>
              <span>Schedule</span>
              <span>Location</span>
              {/* trailing column: pin toggle */}
              <span></span>
            </div>

            {pinnedDrivers.length > 0 && (
              <>
                <div
                  className="flex items-center gap-1.5"
                  style={{
                    padding: '6px 24px',
                    fontSize: 10,
                    fontWeight: 600,
                    color: 'var(--accent)',
                    letterSpacing: 0.06,
                    textTransform: 'uppercase',
                    background: 'var(--bg-surface-2)',
                  }}
                >
                  <WIcon name="pin" size={10} />
                  <span>Pinned · {pinnedDrivers.length}</span>
                </div>
                {pinnedDrivers.map(d => (
                  <DriverRow
                    key={d._id}
                    driver={d}
                    isPinned
                    isSelected={selectedDriverId === d._id}
                    onSelect={() => onSelectDriver(d._id)}
                    onTogglePin={() => onTogglePinDriver(d._id)}
                  />
                ))}
              </>
            )}

            {restDrivers.map(d => (
              <DriverRow
                key={d._id}
                driver={d}
                isPinned={false}
                isSelected={selectedDriverId === d._id}
                onSelect={() => onSelectDriver(d._id)}
                onTogglePin={() => onTogglePinDriver(d._id)}
              />
            ))}

            {filteredDrivers.length === 0 && (
              <div
                className="flex flex-col items-center gap-2"
                style={{ padding: 32, textAlign: 'center', color: 'var(--text-tertiary)' }}
              >
                <WIcon name="users" size={20} />
                <span style={{ fontSize: 12.5 }}>No drivers match</span>
              </div>
            )}
          </>
        ) : (
          <>
            <div
              className="grid uppercase"
              style={{
                gridTemplateColumns: CARRIERS_GRID,
                padding: '8px 16px 8px 24px',
                fontSize: 10.5,
                fontWeight: 600,
                color: 'var(--text-tertiary)',
                letterSpacing: 0.05,
                background: 'var(--bg-surface-2)',
                borderBottom: '1px solid var(--border-hairline)',
                position: 'sticky',
                top: 0,
                zIndex: 1,
              }}
            >
              <span>Carrier</span>
              <span>MC #</span>
              <span>Default rate</span>
              <span>Location</span>
            </div>
            {filteredCarriers.map(c => (
              <CarrierRow
                key={c._id}
                carrier={c}
                isSelected={selectedCarrierId === c._id}
                onSelect={() => onSelectCarrier(c._id)}
              />
            ))}
            {filteredCarriers.length === 0 && (
              <div
                className="flex flex-col items-center gap-2"
                style={{ padding: 32, textAlign: 'center', color: 'var(--text-tertiary)' }}
              >
                <WIcon name="handshake" size={20} />
                <span style={{ fontSize: 12.5 }}>No carriers match</span>
              </div>
            )}
          </>
        )}
      </div>
    </div>
  );
}

function DriverRow({
  driver,
  isPinned,
  isSelected,
  onSelect,
  onTogglePin,
}: {
  driver: DriverRow;
  isPinned: boolean;
  isSelected: boolean;
  onSelect: () => void;
  onTogglePin: () => void;
}) {
  const overlapCount = driver.overlap?.conflictCount ?? 0;
  const location = [driver.city, driver.state].filter(Boolean).join(', ');
  const schedule = overlapCount > 0 ? `${overlapCount} overlap${overlapCount === 1 ? '' : 's'}` : 'Available';
  return (
    <div
      onClick={onSelect}
      className="grid items-center"
      style={{
        gridTemplateColumns: DRIVERS_GRID,
        padding: '8px 16px 8px 24px',
        minHeight: 36,
        borderBottom: '1px solid var(--border-hairline)',
        fontSize: 12.5,
        // Selection is the only background-highlight state. Pinned rows are
        // already conveyed by the "Pinned · N" section header above them
        // and by the filled pin icon on the right — we don't double-encode
        // it with a tinted row background.
        background: isSelected ? 'var(--bg-sidebar-active)' : 'var(--bg-surface)',
        cursor: 'pointer',
      }}
      onMouseEnter={e => {
        if (!isSelected) e.currentTarget.style.background = 'var(--bg-row-hover)';
      }}
      onMouseLeave={e => {
        if (!isSelected) e.currentTarget.style.background = 'var(--bg-surface)';
      }}
    >
      <span className="flex items-center gap-2" style={{ minWidth: 0 }}>
        <Avatar name={`${driver.firstName} ${driver.lastName}`} size={20} />
        <span className="truncate" style={{ fontWeight: 500 }}>
          {driver.firstName} {driver.lastName}
        </span>
      </span>
      <span style={{ color: 'var(--text-tertiary)' }} className="truncate">
        {driver.assignedTruck?.bodyType ?? '—'}
      </span>
      <span className="num truncate">{driver.assignedTruck?.unitId ?? '—'}</span>
      <span
        className="num truncate"
        style={{
          color: overlapCount > 0 ? '#A66800' : 'var(--text-tertiary)',
        }}
      >
        {schedule}
      </span>
      <span className="flex items-center gap-1 truncate" style={{ color: 'var(--text-secondary)' }}>
        <WIcon name="circle-dot" size={10} />
        <span className="truncate">{location || '—'}</span>
      </span>
      {/* The quick-assign cell was removed — assignment is now driven by
          the Assign button in the trip detail panel's footer, which
          dispatches based on whichever asset is selected. The final grid
          column is just the pin toggle. */}
      <button
        onClick={e => {
          e.stopPropagation();
          onTogglePin();
        }}
        className="focus-ring inline-flex items-center justify-center"
        style={{
          width: 24,
          height: 24,
          borderRadius: 4,
          background: 'transparent',
          border: 'none',
          cursor: 'pointer',
          color: isPinned ? 'var(--accent)' : 'var(--text-tertiary)',
          opacity: isPinned ? 1 : 0.55,
        }}
        title={isPinned ? 'Unpin driver' : 'Pin driver'}
      >
        <WIcon name="pin" size={13} />
      </button>
    </div>
  );
}

function CarrierRow({
  carrier,
  isSelected,
  onSelect,
}: {
  carrier: CarrierRow;
  isSelected: boolean;
  onSelect: () => void;
}) {
  const location = [carrier.city, carrier.state].filter(Boolean).join(', ');
  const rate =
    carrier.hasDefaultRate && carrier.defaultRate != null
      ? formatCarrierRate(carrier.defaultRate, carrier.defaultRateType)
      : '—';
  return (
    <div
      onClick={onSelect}
      className="grid items-center"
      style={{
        gridTemplateColumns: CARRIERS_GRID,
        padding: '8px 16px 8px 24px',
        minHeight: 36,
        borderBottom: '1px solid var(--border-hairline)',
        fontSize: 12.5,
        cursor: 'pointer',
        background: isSelected ? 'var(--bg-sidebar-active)' : 'var(--bg-surface)',
      }}
      onMouseEnter={e => {
        if (!isSelected) e.currentTarget.style.background = 'var(--bg-row-hover)';
      }}
      onMouseLeave={e => {
        if (!isSelected) e.currentTarget.style.background = 'var(--bg-surface)';
      }}
    >
      <span className="flex items-center gap-2 truncate" style={{ fontWeight: 500 }}>
        <WIcon name="handshake" size={13} />
        <span className="truncate">{carrier.carrierName}</span>
      </span>
      <span className="num truncate">{carrier.mcNumber}</span>
      <span className="num truncate">{rate}</span>
      <span className="truncate" style={{ color: 'var(--text-secondary)' }}>
        {location || '—'}
      </span>
    </div>
  );
}

// ============================================================================
// Right pane — TripDetailPanel + empty state
// ============================================================================

function EmptyTripPane() {
  return (
    <div
      className="flex-1 flex flex-col items-center justify-center gap-3 text-center"
      style={{ padding: 32 }}
    >
      <div
        className="inline-flex items-center justify-center"
        style={{
          width: 56,
          height: 56,
          borderRadius: 12,
          background: 'var(--bg-sidebar-active)',
          color: 'var(--accent)',
        }}
      >
        <WIcon name="package" size={22} />
      </div>
      <div style={{ fontSize: 13.5, fontWeight: 600, color: 'var(--text-primary)' }}>
        No order selected
      </div>
      <div
        style={{
          fontSize: 11.5,
          color: 'var(--text-tertiary)',
          maxWidth: 240,
          lineHeight: '17px',
        }}
      >
        Select a trip from the list to see route, stops, and assignment options.
      </div>
    </div>
  );
}

type TripStop = {
  city?: string;
  state?: string;
  address?: string;
  latitude?: number;
  longitude?: number;
  stopType: 'PICKUP' | 'DELIVERY' | 'DETOUR';
  windowBeginDate?: string;
  windowBeginTime?: string;
  sequenceNumber: number;
};

function TripDetailPanel({
  trip,
  assignment,
  onOpenLoad,
}: {
  trip: {
    _id: Id<'loadInformation'>;
    orderNumber?: string;
    customerName?: string;
    parsedHcr?: string;
    parsedTripNumber?: string;
    effectiveMiles?: number;
    firstStopDate?: string;
    status?: string;
    stops?: TripStop[];
    // Assignment summary surfaced when the load already has a driver or
    // carrier on it. The convex query returns these in slightly different
    // shapes depending on whether the carrier is a direct partnership or a
    // marketplace loadCarrierAssignment — we only need the display name so
    // the types are kept loose here on purpose.
    assignedDriver?: { name: string } | null;
    assignedCarrier?: { companyName?: string } | null;
    assignedTruck?: { unitId: string } | null;
    assignedTrailer?: { unitId: string } | null;
    legs?: Array<{ updatedAt?: number; createdAt?: number }>;
  };
  /** Footer Assign-button state. The selection itself lives in the assets
   *  pane (or a future suggestion UI elsewhere); this panel just dispatches
   *  whichever assignment action matches the active asset tab. */
  assignment: {
    assetTab: 'driver' | 'carrier';
    hasSelection: boolean;
    isAssigning: boolean;
    onAssign: () => void;
  };
  onOpenLoad: () => void;
}) {
  const stops = (trip.stops ?? []).filter(s => s.stopType !== 'DETOUR');
  // Used by both the AssignedBlock + the footer's Assign/Reassign branch.
  const isAssigned = !!(trip.assignedDriver || trip.assignedCarrier);
  const statusChip = (trip.status ?? 'Open') as ChipStatus | string;
  const statusValue: ChipStatus = ((): ChipStatus => {
    switch (statusChip) {
      case 'Open':
        return 'open';
      case 'Assigned':
        return 'assigned';
      case 'Completed':
        return 'delivered';
      case 'Canceled':
        return 'cancelled';
      default:
        return 'pending';
    }
  })();

  return (
    <div className="flex-1 flex flex-col" style={{ minHeight: 0 }}>
      {/* Header */}
      <div
        className="flex-shrink-0"
        style={{
          padding: '14px 18px 12px',
          borderBottom: '1px solid var(--border-hairline)',
        }}
      >
        <div className="flex items-center gap-2" style={{ marginBottom: 6 }}>
          <span
            style={{
              fontSize: 10.5,
              fontWeight: 600,
              color: 'var(--text-tertiary)',
              letterSpacing: 0.04,
              textTransform: 'uppercase',
            }}
          >
            Order
          </span>
          <Chip status={statusValue} />
        </div>
        <div
          className="num"
          style={{
            fontSize: 18,
            fontWeight: 600,
            color: 'var(--text-primary)',
            letterSpacing: -0.2,
          }}
        >
          {trip.orderNumber ?? '—'}
        </div>
        <div style={{ fontSize: 12, color: 'var(--text-secondary)', marginTop: 2 }}>
          {trip.customerName ?? '—'}
        </div>
      </div>

      {/* Scrollable body */}
      <div className="scroll-thin flex-1" style={{ minHeight: 0, overflow: 'auto' }}>
        {/* Facets */}
        <div
          className="grid"
          style={{
            padding: '14px 18px',
            gridTemplateColumns: '1fr 1fr',
            gap: 14,
            borderBottom: '1px solid var(--border-hairline)',
          }}
        >
          <TripFacet label="HCR #" value={trip.parsedHcr ?? '—'} mono />
          <TripFacet label="Trip #" value={trip.parsedTripNumber ?? '—'} mono />
          <TripFacet
            label="Total miles"
            value={trip.effectiveMiles != null ? `${trip.effectiveMiles.toFixed(1)} mi` : '—'}
            mono
          />
          <TripFacet
            label="Pickup"
            value={trip.firstStopDate ? formatDateOnly(trip.firstStopDate).display : '—'}
          />
        </div>

        {/* Mini-map */}
        <div style={{ padding: '14px 18px 0' }}>
          <div
            style={{
              fontSize: 10.5,
              fontWeight: 600,
              color: 'var(--text-tertiary)',
              letterSpacing: 0.04,
              textTransform: 'uppercase',
              marginBottom: 6,
            }}
          >
            Route
          </div>
          <RouteMiniMap stops={stops} />
        </div>

        {/* Itinerary */}
        <div style={{ padding: '16px 18px 18px' }}>
          <div
            style={{
              fontSize: 10.5,
              fontWeight: 600,
              color: 'var(--text-tertiary)',
              letterSpacing: 0.04,
              textTransform: 'uppercase',
              marginBottom: 10,
            }}
          >
            Itinerary
          </div>
          <div style={{ position: 'relative' }}>
            <div
              style={{
                position: 'absolute',
                left: 9,
                top: 8,
                bottom: 8,
                width: 2,
                background: 'var(--border-hairline-strong)',
              }}
            />
            {stops.map((s, i) => {
              const isPickup = s.stopType === 'PICKUP';
              const dot = isPickup ? '#10B981' : '#EF4444';
              return (
                <div
                  key={i}
                  className="grid"
                  style={{
                    position: 'relative',
                    gridTemplateColumns: '20px 1fr',
                    gap: 10,
                    paddingBottom: i === stops.length - 1 ? 0 : 14,
                  }}
                >
                  <div style={{ position: 'relative', paddingTop: 2 }}>
                    <div
                      className="flex items-center justify-center"
                      style={{
                        width: 20,
                        height: 20,
                        borderRadius: 10,
                        background: 'var(--bg-surface)',
                        border: '2px solid ' + dot,
                        fontSize: 9.5,
                        fontWeight: 700,
                        color: dot,
                        fontFamily: 'var(--font-mono)',
                      }}
                    >
                      {i + 1}
                    </div>
                  </div>
                  <div style={{ minWidth: 0 }}>
                    <div className="flex items-center gap-1.5" style={{ marginBottom: 2 }}>
                      <span
                        style={{
                          fontSize: 10,
                          fontWeight: 600,
                          letterSpacing: 0.04,
                          textTransform: 'uppercase',
                          color: isPickup ? '#0E8C5C' : '#C0392B',
                          padding: '1px 6px',
                          borderRadius: 3,
                          background: isPickup
                            ? 'rgba(16,185,129,0.10)'
                            : 'rgba(239,68,68,0.10)',
                        }}
                      >
                        {isPickup ? 'Pickup' : 'Delivery'}
                      </span>
                      <span
                        className="num"
                        style={{ fontSize: 11, color: 'var(--text-tertiary)' }}
                      >
                        {[
                          s.windowBeginDate ? formatDateOnly(s.windowBeginDate).display : null,
                          s.windowBeginTime
                            ? new Date(s.windowBeginTime).toLocaleTimeString([], {
                                hour: '2-digit',
                                minute: '2-digit',
                              })
                            : null,
                        ]
                          .filter(Boolean)
                          .join(' · ')}
                      </span>
                    </div>
                    <div
                      style={{
                        fontSize: 13,
                        fontWeight: 500,
                        color: 'var(--text-primary)',
                      }}
                    >
                      {[s.city, s.state].filter(Boolean).join(', ') || '—'}
                    </div>
                    {s.address && (
                      <div
                        className="truncate"
                        style={{
                          fontSize: 11.5,
                          color: 'var(--text-tertiary)',
                          marginTop: 1,
                        }}
                      >
                        {s.address}
                      </div>
                    )}
                  </div>
                </div>
              );
            })}
            {stops.length === 0 && (
              <div
                style={{
                  fontSize: 12,
                  color: 'var(--text-tertiary)',
                  fontStyle: 'italic',
                  padding: '8px 0',
                }}
              >
                No stops on this load yet.
              </div>
            )}
          </div>
        </div>
      </div>

      {/* Assigned block — shown only when the load has a driver or carrier
          already on it. Reads from the same getByIdWithRange shape the load
          detail page uses (assignedDriver / assignedCarrier / assignedTruck /
          assignedTrailer). Below this block the footer switches to "Reassign". */}
      <AssignedBlock trip={trip} />

      {/* Pinned footer — Assign or Reassign depending on whether the load
          already has someone on it. Reassign is always clickable (it just
          changes who's assigned via the same flow). Assign is disabled until
          the dispatcher picks a driver/carrier below. */}
      <div
        className="flex flex-col gap-2 flex-shrink-0"
        style={{
          padding: '12px 18px',
          borderTop: '1px solid var(--border-hairline)',
          background: 'var(--bg-surface)',
          boxShadow: '0 -4px 12px -8px rgba(15,23,42,0.10)',
        }}
      >
        {!isAssigned && !assignment.hasSelection && (
          <span
            style={{
              fontSize: 11,
              color: 'var(--text-tertiary)',
              textAlign: 'center',
            }}
          >
            Pick a {assignment.assetTab} below to enable Assign
          </span>
        )}
        <div className="flex gap-2">
          <WBtn
            size="sm"
            accent
            leading={isAssigned ? 'users' : 'check'}
            full
            onClick={assignment.onAssign}
            disabled={!assignment.hasSelection || assignment.isAssigning}
          >
            {assignment.isAssigning
              ? isAssigned ? 'Reassigning…' : 'Assigning…'
              : isAssigned
                ? 'Reassign'
                : `Assign ${assignment.assetTab}`}
          </WBtn>
          <WBtn size="sm" leading="eye" onClick={onOpenLoad}>
            Open
          </WBtn>
        </div>
      </div>
    </div>
  );
}

/**
 * AssignedBlock — green-tinted summary that surfaces who's on the load when
 * it's assigned. Shows the driver or carrier name, the truck + trailer unit
 * IDs (if known), and a relative "when assigned" timestamp pulled from the
 * first leg's updatedAt.
 *
 * Returns null when the load is unassigned, so the trip detail panel falls
 * straight through to its footer in the unassigned case.
 */
function AssignedBlock({
  trip,
}: {
  trip: {
    assignedDriver?: { name: string } | null;
    assignedCarrier?: { companyName?: string } | null;
    assignedTruck?: { unitId: string } | null;
    assignedTrailer?: { unitId: string } | null;
    legs?: Array<{ updatedAt?: number; createdAt?: number }>;
  };
}) {
  const name = trip.assignedDriver?.name ?? trip.assignedCarrier?.companyName ?? null;
  if (!name) return null;

  const truckId = trip.assignedTruck?.unitId;
  const trailerId = trip.assignedTrailer?.unitId;
  const equipParts = [truckId && `T-${truckId}`, trailerId && `TR-${trailerId}`].filter(Boolean);

  // Pull the most recent leg update as the "when assigned" timestamp. Not
  // a perfect proxy (any subsequent edit will bump it) but it's the best
  // local signal until we wire a dedicated audit-log query.
  const lastLegUpdate = trip.legs && trip.legs.length > 0
    ? Math.max(...trip.legs.map(l => l.updatedAt ?? l.createdAt ?? 0))
    : null;

  return (
    <div
      className="flex-shrink-0"
      style={{
        margin: '0 18px 12px',
        padding: '12px 14px',
        borderRadius: 8,
        background: 'rgba(16,185,129,0.08)',
        border: '1px solid rgba(16,185,129,0.18)',
      }}
    >
      <div
        style={{
          fontSize: 10.5,
          fontWeight: 600,
          letterSpacing: 0.04,
          textTransform: 'uppercase',
          color: '#0E8C5C',
          marginBottom: 2,
        }}
      >
        Assigned
      </div>
      <div
        className="truncate"
        style={{ fontSize: 14, fontWeight: 600, color: 'var(--text-primary)' }}
      >
        {name}
      </div>
      {equipParts.length > 0 && (
        <div
          className="num truncate"
          style={{
            fontSize: 11.5,
            color: 'var(--text-secondary)',
            marginTop: 2,
          }}
        >
          {equipParts.join(' · ')}
        </div>
      )}
      {lastLegUpdate && (
        <div
          className="flex items-center gap-1"
          style={{
            fontSize: 10.5,
            color: 'var(--text-tertiary)',
            marginTop: 6,
          }}
        >
          <WIcon name="clock" size={10} />
          <span>{formatAssignmentTimestamp(lastLegUpdate)}</span>
        </div>
      )}
    </div>
  );
}

/** "Today · 10:42 AM", "Yesterday · 3:18 PM", or "May 12 · 09:00" — short
 *  human-readable form for the AssignedBlock timestamp. */
function formatAssignmentTimestamp(ms: number): string {
  const d = new Date(ms);
  const today = new Date();
  const yesterday = new Date(today.getTime() - 24 * 60 * 60 * 1000);
  const sameDay = (a: Date, b: Date) =>
    a.getFullYear() === b.getFullYear() &&
    a.getMonth() === b.getMonth() &&
    a.getDate() === b.getDate();
  const time = d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  if (sameDay(d, today)) return `Today · ${time}`;
  if (sameDay(d, yesterday)) return `Yesterday · ${time}`;
  return `${d.toLocaleDateString([], { month: 'short', day: 'numeric' })} · ${time}`;
}

function TripFacet({
  label,
  value,
  mono,
}: {
  label: string;
  value: string;
  mono?: boolean;
}) {
  return (
    <div className="flex flex-col" style={{ gap: 2, minWidth: 0 }}>
      <span
        style={{
          fontSize: 10,
          fontWeight: 600,
          color: 'var(--text-tertiary)',
          letterSpacing: 0.04,
          textTransform: 'uppercase',
        }}
      >
        {label}
      </span>
      <span
        className={(mono ? 'num ' : '') + 'truncate'}
        style={{ fontSize: 12.5, fontWeight: 500, color: 'var(--text-primary)' }}
      >
        {value}
      </span>
    </div>
  );
}

// ============================================================================
// RouteMiniMap — lightweight SVG preview matching the design's pattern
// ============================================================================

function RouteMiniMap({ stops }: { stops: TripStop[] }) {
  const pts = stops
    .map(s =>
      s.latitude != null && s.longitude != null ? { lat: s.latitude, lng: s.longitude } : null,
    )
    .filter((p): p is { lat: number; lng: number } => p != null);

  const W = 320;
  const H = 130;
  const P = 16;

  if (pts.length < 2) {
    return (
      <div
        className="flex items-center justify-center"
        style={{
          height: H,
          borderRadius: 10,
          background: 'var(--bg-surface-2)',
          border: '1px solid var(--border-hairline)',
          color: 'var(--text-tertiary)',
          fontSize: 11.5,
        }}
      >
        Route preview unavailable
      </div>
    );
  }

  const lats = pts.map(p => p.lat);
  const lngs = pts.map(p => p.lng);
  const minLat = Math.min(...lats);
  const maxLat = Math.max(...lats);
  const minLng = Math.min(...lngs);
  const maxLng = Math.max(...lngs);
  const spanLat = Math.max(maxLat - minLat, 0.01);
  const spanLng = Math.max(maxLng - minLng, 0.01);
  const x = (lng: number) => P + ((lng - minLng) / spanLng) * (W - 2 * P);
  const y = (lat: number) => P + ((maxLat - lat) / spanLat) * (H - 2 * P);
  const xy = pts.map(p => [x(p.lng), y(p.lat)] as [number, number]);
  const pathD = xy
    .map((p, i) => (i === 0 ? 'M' : 'L') + p[0].toFixed(1) + ' ' + p[1].toFixed(1))
    .join(' ');
  const r = stops.length >= 7 ? 4.5 : stops.length >= 5 ? 5.5 : 6.5;
  const innerR = stops.length >= 7 ? 1.6 : stops.length >= 5 ? 2 : 2.5;

  return (
    <div
      style={{
        position: 'relative',
        height: H,
        borderRadius: 10,
        overflow: 'hidden',
        border: '1px solid var(--border-hairline)',
        background: 'linear-gradient(180deg, #EFF3F8 0%, #E6ECF3 100%)',
      }}
    >
      <svg
        width="100%"
        height="100%"
        viewBox={`0 0 ${W} ${H}`}
        preserveAspectRatio="none"
        style={{ display: 'block' }}
      >
        <defs>
          <pattern id="rmgrid" width="20" height="20" patternUnits="userSpaceOnUse">
            <path d="M 20 0 L 0 0 0 20" fill="none" stroke="rgba(0,0,0,0.04)" strokeWidth="1" />
          </pattern>
        </defs>
        <rect width={W} height={H} fill="url(#rmgrid)" />
        <path
          d={pathD}
          stroke="rgba(0,0,0,0.06)"
          strokeWidth="6"
          fill="none"
          strokeLinecap="round"
          strokeLinejoin="round"
          transform="translate(0,1)"
        />
        <path
          d={pathD}
          stroke="var(--accent)"
          strokeWidth="2.5"
          fill="none"
          strokeLinecap="round"
          strokeLinejoin="round"
        />
        {xy.map(([cx, cy], i) => {
          const isFirst = i === 0;
          const isLast = i === xy.length - 1;
          return (
            <g key={i}>
              <circle cx={cx} cy={cy} r={r} fill="#fff" stroke="var(--accent)" strokeWidth={2} />
              {(isFirst || isLast) && (
                <circle cx={cx} cy={cy} r={innerR} fill={isFirst ? '#10B981' : '#EF4444'} />
              )}
              {!isFirst && !isLast && (
                <circle cx={cx} cy={cy} r={innerR - 0.5} fill="var(--accent)" />
              )}
            </g>
          );
        })}
      </svg>
      <div
        className="num inline-flex items-center gap-1"
        style={{
          position: 'absolute',
          bottom: 8,
          right: 8,
          height: 22,
          padding: '0 8px',
          borderRadius: 11,
          background: 'rgba(255,255,255,0.95)',
          border: '1px solid var(--border-hairline)',
          fontSize: 11,
          fontWeight: 500,
          color: 'var(--text-primary)',
        }}
      >
        <WIcon name="route" size={10} />
        <span>{stops.length} stops</span>
      </div>
    </div>
  );
}

// ============================================================================
// Helpers
// ============================================================================

function chipValuesFor(chips: FilterChipValue[], propId: string): string[] {
  return chips.find(c => c.propId === propId)?.values ?? [];
}

// Translate a FilterBar date chip value — either a preset name ("Today",
// "Next 24 hrs", "This week") or a custom "YYYY-MM-DD..YYYY-MM-DD" string —
// into the YYYY-MM-DD start/end pair the loads query expects.
function resolveDatePreset(value: string): { start?: string; end?: string } {
  const ymd = (d: Date) => format(d, 'yyyy-MM-dd');
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  const addDays = (d: Date, n: number) => {
    const out = new Date(d);
    out.setDate(out.getDate() + n);
    return out;
  };
  switch (value) {
    case 'Today':       return { start: ymd(today),                 end: ymd(today) };
    case 'Tomorrow':    { const t = addDays(today, 1); return { start: ymd(t), end: ymd(t) }; }
    case 'Yesterday':   { const y = addDays(today, -1); return { start: ymd(y), end: ymd(y) }; }
    case 'Next 24 hrs': return { start: ymd(today), end: ymd(addDays(today, 1)) };
    case 'Next 48 hrs': return { start: ymd(today), end: ymd(addDays(today, 2)) };
    case 'Next 72 hrs': return { start: ymd(today), end: ymd(addDays(today, 3)) };
    case 'Next 7 days': return { start: ymd(today), end: ymd(addDays(today, 6)) };
    case 'Last 7 days': return { start: ymd(addDays(today, -6)), end: ymd(today) };
    case 'This week': {
      // Week starts Monday — matches the schedule view's convention.
      const day = today.getDay();
      const offsetToMon = (day + 6) % 7;
      const first = addDays(today, -offsetToMon);
      const last = addDays(first, 6);
      return { start: ymd(first), end: ymd(last) };
    }
    case 'This month': {
      const first = new Date(today.getFullYear(), today.getMonth(), 1);
      const last  = new Date(today.getFullYear(), today.getMonth() + 1, 0);
      return { start: ymd(first), end: ymd(last) };
    }
    default: {
      // Custom range encoded as YYYY-MM-DD..YYYY-MM-DD.
      const range = parseDateRangeValue(value);
      if (!range) return {};
      return { start: ymd(range.from), end: ymd(range.to) };
    }
  }
}

// Replace (or insert) the `date` chip in the list with a single preset value.
function upsertDateChip(chips: FilterChipValue[], preset: string): FilterChipValue[] {
  const next = chips.filter(c => c.propId !== 'date');
  next.push({ propId: 'date', op: 'is', values: [preset] });
  return next;
}

function formatCarrierRate(
  rate: number,
  type?: 'FLAT' | 'PER_MILE' | 'PERCENTAGE',
): string {
  if (type === 'PERCENTAGE') return `${rate.toFixed(1)}%`;
  if (type === 'PER_MILE') return `$${rate.toFixed(2)}/mi`;
  return `$${rate.toFixed(0)}`;
}
