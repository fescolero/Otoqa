'use client';

import {
  Breadcrumb,
  BreadcrumbItem,
  BreadcrumbLink,
  BreadcrumbList,
  BreadcrumbPage,
  BreadcrumbSeparator,
} from '@/components/ui/breadcrumb';
import { Button } from '@/components/ui/button';
import { Separator } from '@/components/ui/separator';
import { SidebarTrigger } from '@/components/ui/sidebar';
import { Tabs, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { Badge } from '@/components/ui/badge';
import { useAuth } from '@workos-inc/authkit-nextjs/components';
import { useMutation } from 'convex/react';
import { api } from '@/convex/_generated/api';
import { useRouter } from 'next/navigation';
import { useState, useMemo, useCallback } from 'react';
import { useOrganizationId } from '@/contexts/organization-context';
import { Plus, Download, Upload, Trash2, X, Droplets } from 'lucide-react';
import { DieselFilterBar, DieselFilterState } from '@/components/diesel/diesel-filter-bar';
import { FuelEntriesTable } from '@/components/diesel/fuel-entries-table';
import { exportToCSV } from '@/lib/csv-export';
import { format } from 'date-fns';
import { useAuthQuery } from '@/hooks/use-auth-query';
import Link from 'next/link';

type TabValue = 'all' | 'fuel' | 'def';

interface EnrichedEntry {
  _id: string;
  entryDate: number;
  vendorName: string;
  driverName?: string;
  carrierName?: string;
  truckUnitId?: string;
  gallons: number;
  pricePerGallon: number;
  totalCost: number;
  type: 'fuel' | 'def';
  paymentMethod?: string;
  location?: { city: string; state: string };
}

export default function DieselPage() {
  const router = useRouter();
  const { user } = useAuth();
  const organizationId = useOrganizationId();

  const [activeTab, setActiveTab] = useState<TabValue>('all');
  const [filters, setFilters] = useState<DieselFilterState>({ search: '' });
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());

  const paginationOpts = { numItems: 100, cursor: null };

  const queryArgs = organizationId
    ? {
        organizationId,
        paginationOpts,
        ...(filters.driverId ? { driverId: filters.driverId as never } : {}),
        ...(filters.carrierId ? { carrierId: filters.carrierId as never } : {}),
        ...(filters.truckId ? { truckId: filters.truckId as never } : {}),
        ...(filters.vendorId ? { vendorId: filters.vendorId as never } : {}),
        ...(filters.dateRange
          ? {
              dateRangeStart: filters.dateRange.start,
              dateRangeEnd: filters.dateRange.end,
            }
          : {}),
        ...(filters.search ? { search: filters.search } : {}),
      }
    : 'skip';

  const fuelResult = useAuthQuery(api.fuelEntries.list, queryArgs as never);
  const defResult = useAuthQuery(api.defEntries.list, queryArgs as never);

  const driversData = useAuthQuery(
    api.drivers.list,
    organizationId ? { organizationId } : 'skip'
  );
  const trucksData = useAuthQuery(
    api.trucks.list,
    organizationId ? { organizationId } : 'skip'
  );
  const vendorsData = useAuthQuery(
    api.fuelVendors.list,
    organizationId ? { organizationId } : 'skip'
  );
  const carriersData = useAuthQuery(
    api.carrierPartnerships.listForBroker,
    organizationId ? { brokerOrgId: organizationId } : 'skip'
  );

  const removeFuelEntry = useMutation(api.fuelEntries.remove);
  const removeDefEntry = useMutation(api.defEntries.remove);

  const fuelCarriers = useMemo(() => {
    if (!carriersData) return [];
    return carriersData.map((c: Record<string, unknown>) => ({
      _id: c._id as string,
      name: (c.carrierName as string) ?? 'Unknown',
    }));
  }, [carriersData]);

  const fuelEntries: Array<EnrichedEntry> = useMemo(() => {
    if (!fuelResult?.page) return [];
    return fuelResult.page.map((e: Record<string, unknown>) => ({
      _id: e._id as string,
      entryDate: e.entryDate as number,
      vendorName: (e.vendorName as string) ?? 'Unknown',
      driverName: e.driverName as string | undefined,
      carrierName: e.carrierName as string | undefined,
      truckUnitId: e.truckUnitId as string | undefined,
      gallons: e.gallons as number,
      pricePerGallon: e.pricePerGallon as number,
      totalCost: e.totalCost as number,
      type: 'fuel' as const,
      paymentMethod: e.paymentMethod as string | undefined,
      location: e.location as { city: string; state: string } | undefined,
    }));
  }, [fuelResult]);

  const defEntries: Array<EnrichedEntry> = useMemo(() => {
    if (!defResult?.page) return [];
    return defResult.page.map((e: Record<string, unknown>) => ({
      _id: e._id as string,
      entryDate: e.entryDate as number,
      vendorName: (e.vendorName as string) ?? 'Unknown',
      driverName: e.driverName as string | undefined,
      carrierName: e.carrierName as string | undefined,
      truckUnitId: e.truckUnitId as string | undefined,
      gallons: e.gallons as number,
      pricePerGallon: e.pricePerGallon as number,
      totalCost: e.totalCost as number,
      type: 'def' as const,
      paymentMethod: e.paymentMethod as string | undefined,
      location: e.location as { city: string; state: string } | undefined,
    }));
  }, [defResult]);

  const displayEntries = useMemo(() => {
    if (activeTab === 'fuel') return fuelEntries;
    if (activeTab === 'def') return defEntries;
    return [...fuelEntries, ...defEntries].sort(
      (a, b) => b.entryDate - a.entryDate
    );
  }, [activeTab, fuelEntries, defEntries]);

  const handleRowClick = useCallback(
    (id: string, type: 'fuel' | 'def') => {
      router.push(`/operations/diesel/${id}?type=${type}`);
    },
    [router]
  );

  const handleSelectRow = useCallback((id: string) => {
    setSelectedIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) {
        next.delete(id);
      } else {
        next.add(id);
      }
      return next;
    });
  }, []);

  const handleSelectAll = useCallback(() => {
    setSelectedIds((prev) => {
      if (prev.size === displayEntries.length) {
        return new Set();
      }
      return new Set(displayEntries.map((e) => e._id));
    });
  }, [displayEntries]);

  const handleClearSelection = useCallback(() => {
    setSelectedIds(new Set());
  }, []);

  const handleBulkDelete = useCallback(async () => {
    if (selectedIds.size === 0 || !user) return;

    const userId = user.id;
    const entriesToDelete = displayEntries.filter((e) =>
      selectedIds.has(e._id)
    );

    await Promise.all(
      entriesToDelete.map((entry) => {
        if (entry.type === 'fuel') {
          return removeFuelEntry({
            entryId: entry._id as never,
            deletedBy: userId,
          });
        }
        return removeDefEntry({
          entryId: entry._id as never,
          deletedBy: userId,
        });
      })
    );

    setSelectedIds(new Set());
  }, [selectedIds, displayEntries, user, removeFuelEntry, removeDefEntry]);

  const handleExportCSV = useCallback(() => {
    if (displayEntries.length === 0) return;

    exportToCSV(
      displayEntries,
      [
        {
          header: 'Date',
          accessor: (row) => format(new Date(row.entryDate), 'yyyy-MM-dd'),
        },
        { header: 'Driver', accessor: (row) => row.driverName ?? '' },
        { header: 'Carrier', accessor: (row) => row.carrierName ?? '' },
        { header: 'Truck', accessor: (row) => row.truckUnitId ?? '' },
        { header: 'Vendor', accessor: (row) => row.vendorName },
        {
          header: 'Location',
          accessor: (row) =>
            row.location
              ? `${row.location.city}, ${row.location.state}`
              : '',
        },
        { header: 'Gallons', accessor: (row) => row.gallons },
        { header: 'Price/Gal', accessor: (row) => row.pricePerGallon },
        { header: 'Total', accessor: (row) => row.totalCost },
        { header: 'Type', accessor: (row) => (row.type === 'def' ? 'DEF' : 'Fuel') },
        { header: 'Payment Method', accessor: (row) => row.paymentMethod ?? '' },
      ],
      `diesel-entries-${format(new Date(), 'yyyy-MM-dd')}`
    );
  }, [displayEntries]);

  const drivers = useMemo(() => {
    if (!driversData) return [];
    return (driversData as Array<Record<string, unknown>>).map((d) => ({
      _id: d._id as string,
      firstName: d.firstName as string,
      lastName: d.lastName as string,
    }));
  }, [driversData]);

  const trucks = useMemo(() => {
    if (!trucksData) return [];
    return (trucksData as Array<Record<string, unknown>>).map((t) => ({
      _id: t._id as string,
      unitId: t.unitId as string,
    }));
  }, [trucksData]);

  const vendors = useMemo(() => {
    if (!vendorsData) return [];
    return (vendorsData as Array<Record<string, unknown>>).map((v) => ({
      _id: v._id as string,
      name: v.name as string,
    }));
  }, [vendorsData]);

  const isLoading = !fuelResult && !defResult;

  return (
    <>
      <header className="flex h-16 shrink-0 items-center gap-2 transition-[width,height] ease-linear group-has-data-[collapsible=icon]/sidebar-wrapper:h-12 border-b">
        <div className="flex items-center gap-2 px-4">
          <SidebarTrigger className="-ml-1" />
          <Separator
            orientation="vertical"
            className="mr-2 data-[orientation=vertical]:h-4"
          />
          <Breadcrumb>
            <BreadcrumbList>
              <BreadcrumbItem className="hidden md:block">
                <BreadcrumbLink href="/dashboard">Home</BreadcrumbLink>
              </BreadcrumbItem>
              <BreadcrumbSeparator className="hidden md:block" />
              <BreadcrumbItem className="hidden md:block">
                <BreadcrumbLink href="#">Company Operations</BreadcrumbLink>
              </BreadcrumbItem>
              <BreadcrumbSeparator className="hidden md:block" />
              <BreadcrumbItem>
                <BreadcrumbPage>Diesel</BreadcrumbPage>
              </BreadcrumbItem>
            </BreadcrumbList>
          </Breadcrumb>
        </div>
      </header>

      <div className="flex-1 overflow-hidden">
        <div className="h-full flex flex-col">
          {/* Title + Actions */}
          <div className="flex-shrink-0 flex items-center justify-between p-6 pb-4">
            <div>
              <h1 className="text-3xl font-bold tracking-tight">
                Diesel / Fuel Tracking
              </h1>
              <p className="text-muted-foreground">
                Track fuel and DEF purchases across your fleet
              </p>
            </div>
            <div className="flex items-center gap-2">
              <Button variant="outline" size="sm" asChild>
                <Link href="/operations/diesel/import">
                  <Upload className="mr-2 h-4 w-4" />
                  Import CSV
                </Link>
              </Button>
              <Button variant="outline" size="sm" onClick={handleExportCSV}>
                <Download className="mr-2 h-4 w-4" />
                Export CSV
              </Button>
              <Button variant="outline" size="sm" asChild>
                <Link href="/operations/diesel/def/create">
                  <Droplets className="mr-2 h-4 w-4" />
                  Create DEF Entry
                </Link>
              </Button>
              <Button size="sm" asChild>
                <Link href="/operations/diesel/create">
                  <Plus className="mr-2 h-4 w-4" />
                  Create Fuel Entry
                </Link>
              </Button>
            </div>
          </div>

          {/* Tabs */}
          <div className="flex-shrink-0 px-6 pb-2">
            <Tabs
              value={activeTab}
              onValueChange={(v) => {
                setActiveTab(v as TabValue);
                setSelectedIds(new Set());
              }}
            >
              <TabsList>
                <TabsTrigger value="all">
                  All
                  <Badge variant="secondary" className="ml-2 text-xs">
                    {fuelEntries.length + defEntries.length}
                  </Badge>
                </TabsTrigger>
                <TabsTrigger value="fuel">
                  Fuel
                  <Badge variant="secondary" className="ml-2 text-xs">
                    {fuelEntries.length}
                  </Badge>
                </TabsTrigger>
                <TabsTrigger value="def">
                  DEF
                  <Badge variant="secondary" className="ml-2 text-xs">
                    {defEntries.length}
                  </Badge>
                </TabsTrigger>
              </TabsList>
            </Tabs>
          </div>

          {/* Filter Bar */}
          <DieselFilterBar
            filters={filters}
            onFiltersChange={setFilters}
            drivers={drivers}
            carriers={fuelCarriers}
            trucks={trucks}
            vendors={vendors}
          />

          {/* Floating Action Bar for Bulk Delete */}
          {selectedIds.size > 0 && (
            <div className="sticky top-0 z-20 flex h-12 w-full items-center justify-between border-b bg-blue-50/30 px-4 animate-in slide-in-from-top-2 duration-200">
              <div className="flex items-center gap-3">
                <Button
                  variant="ghost"
                  size="sm"
                  onClick={handleClearSelection}
                  className="h-8 w-8 p-0 hover:bg-slate-50 transition-colors"
                >
                  <X className="h-4 w-4" strokeWidth={2} />
                </Button>
                <span className="text-sm font-semibold text-slate-900">
                  {selectedIds.size}{' '}
                  {selectedIds.size === 1 ? 'Entry' : 'Entries'} Selected
                </span>
              </div>
              <div className="flex items-center gap-2">
                <Button
                  size="sm"
                  variant="ghost"
                  onClick={handleBulkDelete}
                  className="h-8 text-slate-700 hover:bg-slate-50 hover:text-red-600 transition-colors font-medium"
                >
                  <Trash2 className="w-4 h-4 mr-2" strokeWidth={2} />
                  Delete Selected
                </Button>
              </div>
            </div>
          )}

          {/* Table */}
          <div className="flex-1 min-h-0">
            {isLoading ? (
              <div className="flex items-center justify-center h-40 text-sm text-muted-foreground">
                Loading entries...
              </div>
            ) : (
              <FuelEntriesTable
                entries={displayEntries}
                onRowClick={handleRowClick}
                selectedIds={selectedIds}
                onSelectRow={handleSelectRow}
                onSelectAll={handleSelectAll}
                isAllSelected={
                  selectedIds.size === displayEntries.length &&
                  displayEntries.length > 0
                }
              />
            )}
          </div>
        </div>
      </div>
    </>
  );
}
