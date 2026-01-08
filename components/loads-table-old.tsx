'use client';

import { useState } from 'react';
import { useQuery } from 'convex/react';
import { api } from '@/convex/_generated/api';
import { Card } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Badge } from '@/components/ui/badge';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import { 
  Plus, 
  Search, 
  ChevronLeft, 
  ChevronRight, 
  Filter,
  X,
  TrendingUp,
  Package,
  AlertCircle,
  DollarSign,
  Edit,
  Trash2,
  MoreHorizontal
} from 'lucide-react';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { Tabs, TabsList, TabsTrigger } from '@/components/ui/tabs';
import Link from 'next/link';
import { Id } from '@/convex/_generated/dataModel';

interface LoadsTableProps {
  organizationId: string;
}

export function LoadsTable({ organizationId }: LoadsTableProps) {
  const [searchQuery, setSearchQuery] = useState('');
  const [statusFilter, setStatusFilter] = useState<string>('');
  const [showAdvancedFilters, setShowAdvancedFilters] = useState(false);

  // Pagination state
  const [paginationOpts, setPaginationOpts] = useState({ numItems: 25, cursor: null as string | null });

  // Fetch customers for filter dropdown
  const customers = useQuery(api.customers.getCustomers, { workosOrgId: organizationId });

  // Fetch loads with filters
  const loadsData = useQuery(
    api.loads.getLoads,
    {
      workosOrgId: organizationId,
      status: statusFilter || undefined,
      trackingStatus: trackingStatusFilter || undefined,
      customerId: customerFilter ? (customerFilter as Id<'customers'>) : undefined,
      hcr: hcrFilter || undefined,
      tripNumber: tripFilter || undefined,
      startDate: startDate ? new Date(startDate).getTime() : undefined,
      endDate: endDate ? new Date(endDate).setHours(23, 59, 59, 999) : undefined,
      paginationOpts: {
        numItems: paginationOpts.numItems,
        cursor: paginationOpts.cursor, // Pass null explicitly, not undefined
      },
    },
  );

  const handleNextPage = () => {
    if (loadsData?.continueCursor) {
      setPaginationOpts({
        numItems: 25,
        cursor: loadsData.continueCursor,
      });
    }
  };

  const handlePrevPage = () => {
    // For simplicity, reset to first page
    // In production, you'd maintain a cursor history
    setPaginationOpts({
      numItems: 25,
      cursor: null,
    });
  };

  const handleClearFilters = () => {
    setStatusFilter('');
    setTrackingStatusFilter('');
    setHcrFilter('');
    setTripFilter('');
    setCustomerFilter('');
    setStartDate('');
    setEndDate('');
    setPaginationOpts({ numItems: 25, cursor: null });
  };

  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-3xl font-bold tracking-tight">Loads</h1>
          <p className="text-muted-foreground">Manage your freight loads and shipments</p>
        </div>
        <div className="flex gap-2">
          <Link href="/loads/new">
            <Button>
              <Plus className="mr-2 h-4 w-4" />
              Create Load
            </Button>
          </Link>
        </div>
      </div>

      {/* Filters */}
      <Card className="p-4">
        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-4">
          <div className="space-y-2">
            <label className="text-sm font-medium">Status</label>
            <Select value={statusFilter} onValueChange={setStatusFilter}>
              <SelectTrigger>
                <SelectValue placeholder="All statuses" />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="__all__">All statuses</SelectItem>
                <SelectItem value="Open">Open</SelectItem>
                <SelectItem value="Assigned">Assigned</SelectItem>
                <SelectItem value="Completed">Completed</SelectItem>
                <SelectItem value="Canceled">Canceled</SelectItem>
              </SelectContent>
            </Select>
          </div>

          <div className="space-y-2">
            <label className="text-sm font-medium">Tracking Status</label>
            <Select value={trackingStatusFilter} onValueChange={setTrackingStatusFilter}>
              <SelectTrigger>
                <SelectValue placeholder="All tracking" />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="__all__">All tracking</SelectItem>
                <SelectItem value="Pending">Pending</SelectItem>
                <SelectItem value="In Transit">In Transit</SelectItem>
                <SelectItem value="Completed">Completed</SelectItem>
                <SelectItem value="Delayed">Delayed</SelectItem>
                <SelectItem value="Canceled">Canceled</SelectItem>
              </SelectContent>
            </Select>
          </div>

          <div className="space-y-2">
            <label className="text-sm font-medium">HCR</label>
            <div className="relative">
              <Search className="absolute left-2.5 top-2.5 h-4 w-4 text-muted-foreground" />
              <Input
                placeholder="Search HCR..."
                value={hcrFilter}
                onChange={(e) => setHcrFilter(e.target.value)}
                className="pl-8"
              />
            </div>
          </div>

          <div className="space-y-2">
            <label className="text-sm font-medium">Trip</label>
            <div className="relative">
              <Search className="absolute left-2.5 top-2.5 h-4 w-4 text-muted-foreground" />
              <Input
                placeholder="Search Trip..."
                value={tripFilter}
                onChange={(e) => setTripFilter(e.target.value)}
                className="pl-8"
              />
            </div>
          </div>
        </div>

        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-4 mt-4">
          <div className="space-y-2">
            <label className="text-sm font-medium">Customer</label>
            <Select value={customerFilter} onValueChange={setCustomerFilter}>
              <SelectTrigger>
                <SelectValue placeholder="All customers" />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="__all__">All customers</SelectItem>
                {customers?.map((customer) => (
                  <SelectItem key={customer._id} value={customer._id}>
                    {customer.name}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>

          <div className="space-y-2">
            <label className="text-sm font-medium">Start Date</label>
            <Input
              type="date"
              value={startDate}
              onChange={(e) => setStartDate(e.target.value)}
            />
          </div>

          <div className="space-y-2">
            <label className="text-sm font-medium">End Date</label>
            <Input
              type="date"
              value={endDate}
              onChange={(e) => setEndDate(e.target.value)}
            />
          </div>

          <div className="space-y-2">
            <label className="text-sm font-medium invisible">Actions</label>
            <Button variant="outline" onClick={handleClearFilters} className="w-full">
              Clear Filters
            </Button>
          </div>
        </div>
      </Card>

      {/* Table */}
      <Card>
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Order #</TableHead>
              <TableHead>Customer</TableHead>
              <TableHead>Origin</TableHead>
              <TableHead>Destination</TableHead>
              <TableHead>Status</TableHead>
              <TableHead>Tracking</TableHead>
              <TableHead>Stops</TableHead>
              <TableHead>Created</TableHead>
              <TableHead className="text-right">Actions</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {!loadsData ? (
              <TableRow>
                <TableCell colSpan={9} className="text-center py-8 text-muted-foreground">
                  Loading loads...
                </TableCell>
              </TableRow>
            ) : loadsData.page.length === 0 ? (
              <TableRow>
                <TableCell colSpan={9} className="text-center py-8">
                  <div className="flex flex-col items-center gap-2">
                    <p className="text-muted-foreground">No loads found</p>
                    <Link href="/loads/new">
                      <Button variant="outline" size="sm">
                        <Plus className="mr-2 h-4 w-4" />
                        Create your first load
                      </Button>
                    </Link>
                  </div>
                </TableCell>
              </TableRow>
            ) : (
              loadsData.page.map((load) => (
                <TableRow key={load._id}>
                  <TableCell className="font-medium">{load.orderNumber}</TableCell>
                  <TableCell>{load.customerName || 'N/A'}</TableCell>
                  <TableCell>
                    {load.origin ? (
                      <div className="text-sm">
                        <div className="font-medium">{load.origin.city}</div>
                        <div className="text-muted-foreground">{load.origin.state}</div>
                      </div>
                    ) : (
                      'N/A'
                    )}
                  </TableCell>
                  <TableCell>
                    {load.destination ? (
                      <div className="text-sm">
                        <div className="font-medium">{load.destination.city}</div>
                        <div className="text-muted-foreground">{load.destination.state}</div>
                      </div>
                    ) : (
                      'N/A'
                    )}
                  </TableCell>
                  <TableCell>
                    <span
                      className={`inline-flex items-center rounded-full px-2.5 py-0.5 text-xs font-medium ${
                        load.status === 'Open'
                          ? 'bg-blue-100 text-blue-800'
                          : load.status === 'Assigned'
                            ? 'bg-purple-100 text-purple-800'
                            : load.status === 'Completed'
                              ? 'bg-green-100 text-green-800'
                              : 'bg-gray-100 text-gray-800'
                      }`}
                    >
                      {load.status}
                    </span>
                  </TableCell>
                  <TableCell>
                    <span
                      className={`inline-flex items-center rounded-full px-2.5 py-0.5 text-xs font-medium ${
                        load.trackingStatus === 'In Transit'
                          ? 'bg-yellow-100 text-yellow-800'
                          : load.trackingStatus === 'Completed'
                            ? 'bg-green-100 text-green-800'
                            : load.trackingStatus === 'Delayed'
                              ? 'bg-red-100 text-red-800'
                              : 'bg-gray-100 text-gray-800'
                      }`}
                    >
                      {load.trackingStatus}
                    </span>
                  </TableCell>
                  <TableCell>{load.stopsCount}</TableCell>
                  <TableCell className="text-sm text-muted-foreground">
                    {new Date(load.createdAt).toLocaleDateString()}
                  </TableCell>
                  <TableCell className="text-right">
                    <Link href={`/loads/${load._id}`}>
                      <Button variant="ghost" size="sm">
                        View
                      </Button>
                    </Link>
                  </TableCell>
                </TableRow>
              ))
            )}
          </TableBody>
        </Table>

        {/* Pagination */}
        {loadsData && loadsData.page.length > 0 && (
          <div className="flex items-center justify-between border-t px-4 py-3">
            <div className="text-sm text-muted-foreground">
              Showing {loadsData.page.length} loads
            </div>
            <div className="flex items-center gap-2">
              <Button
                variant="outline"
                size="sm"
                onClick={handlePrevPage}
                disabled={!paginationOpts.cursor}
              >
                <ChevronLeft className="h-4 w-4 mr-1" />
                Previous
              </Button>
              <Button
                variant="outline"
                size="sm"
                onClick={handleNextPage}
                disabled={!loadsData.continueCursor}
              >
                Next
                <ChevronRight className="h-4 w-4 ml-1" />
              </Button>
            </div>
          </div>
        )}
      </Card>
    </div>
  );
}
