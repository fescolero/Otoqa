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
import { Card } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Separator } from '@/components/ui/separator';
import { SidebarTrigger } from '@/components/ui/sidebar';
import { useAuth } from '@workos-inc/authkit-nextjs/components';
import { useQuery } from 'convex/react';
import { api } from '@/convex/_generated/api';
import { useRouter, useParams } from 'next/navigation';
import { ArrowLeft, Pencil } from 'lucide-react';
import { Id } from '@/convex/_generated/dataModel';

export default function ContractLaneDetailPage() {
  const { user } = useAuth();
  const router = useRouter();
  const params = useParams();
  const customerId = params.id as Id<'customers'>;
  const laneId = params.laneId as Id<'contractLanes'>;

  const customer = useQuery(api.customers.get, { id: customerId });
  const lane = useQuery(api.contractLanes.get, { id: laneId });

  const getUserInitials = (name?: string, email?: string) => {
    if (name) {
      const names = name.split(' ');
      if (names.length >= 2) {
        return `${names[0][0]}${names[1][0]}`.toUpperCase();
      }
      return name.slice(0, 2).toUpperCase();
    }
    if (email) {
      return email.slice(0, 2).toUpperCase();
    }
    return 'U';
  };

  const userData = user
    ? {
        name: user.firstName && user.lastName ? `${user.firstName} ${user.lastName}` : user.email,
        email: user.email,
        avatar: user.profilePictureUrl || '',
        initials: getUserInitials(
          user.firstName && user.lastName ? `${user.firstName} ${user.lastName}` : undefined,
          user.email,
        ),
      }
    : {
        name: 'Guest',
        email: 'guest@example.com',
        avatar: '',
        initials: 'GU',
      };

  if (!customer || !lane) {
    return (
      <>
          <div className="flex items-center justify-center h-screen">
            <p>Loading...</p>
          </div>
        </>
    );
  }

  const isActive = lane.isActive ?? true;

  return (
    <>
        <header className="sticky top-0 z-40 flex h-16 shrink-0 items-center gap-2 transition-[width,height] ease-linear group-has-data-[collapsible=icon]/sidebar-wrapper:h-12 border-b bg-background">
          <div className="flex items-center gap-2 px-4">
            <SidebarTrigger className="-ml-1" />
            <Separator orientation="vertical" className="mr-2 data-[orientation=vertical]:h-4" />
            <Breadcrumb>
              <BreadcrumbList>
                <BreadcrumbItem className="hidden md:block">
                  <BreadcrumbLink href="/dashboard">Dashboard</BreadcrumbLink>
                </BreadcrumbItem>
                <BreadcrumbSeparator className="hidden md:block" />
                <BreadcrumbItem className="hidden md:block">
                  <BreadcrumbLink href="#">Company Operations</BreadcrumbLink>
                </BreadcrumbItem>
                <BreadcrumbSeparator className="hidden md:block" />
                <BreadcrumbItem className="hidden md:block">
                  <BreadcrumbLink href="/operations/customers">Customers</BreadcrumbLink>
                </BreadcrumbItem>
                <BreadcrumbSeparator className="hidden md:block" />
                <BreadcrumbItem className="hidden md:block">
                  <BreadcrumbLink href={`/operations/customers/${customerId}`}>
                    {customer.name}
                  </BreadcrumbLink>
                </BreadcrumbItem>
                <BreadcrumbSeparator className="hidden md:block" />
                <BreadcrumbItem className="hidden md:block">
                  <BreadcrumbLink href={`/operations/customers/${customerId}/contract-lanes`}>
                    Contract Lanes
                  </BreadcrumbLink>
                </BreadcrumbItem>
                <BreadcrumbSeparator className="hidden md:block" />
                <BreadcrumbItem>
                  <BreadcrumbPage>{lane.contractName}</BreadcrumbPage>
                </BreadcrumbItem>
              </BreadcrumbList>
            </Breadcrumb>
          </div>
        </header>

        <div className="flex flex-1 flex-col gap-6 p-6 pb-24">
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-4">
              <Button
                variant="ghost"
                size="sm"
                onClick={() => router.push(`/operations/customers/${customerId}/contract-lanes`)}
              >
                <ArrowLeft className="h-4 w-4 mr-2" />
                Back
              </Button>
            </div>
            <Button
              onClick={() =>
                router.push(`/operations/customers/${customerId}/contract-lanes/${laneId}/edit`)
              }
            >
              <Pencil className="h-4 w-4 mr-2" />
              Edit
            </Button>
          </div>

          <div className="flex items-center gap-4">
            <div>
              <h1 className="text-3xl font-bold tracking-tight">{lane.contractName}</h1>
              <p className="text-muted-foreground">Contract lane for {customer.name}</p>
            </div>
            <Badge
              className={
                isActive
                  ? 'bg-green-100 text-green-800 dark:bg-green-900 dark:text-green-200'
                  : 'bg-gray-100 text-gray-800 dark:bg-gray-800 dark:text-gray-200'
              }
            >
              {isActive ? 'Active' : 'Inactive'}
            </Badge>
          </div>

          {/* Contract Information */}
          <Card className="p-6">
            <h2 className="text-xl font-semibold mb-4">Contract Information</h2>
            <dl className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
              <div>
                <dt className="text-sm font-medium text-muted-foreground">HCR</dt>
                <dd className="mt-1 text-sm">{lane.hcr || 'N/A'}</dd>
              </div>
              <div>
                <dt className="text-sm font-medium text-muted-foreground">Trip Number</dt>
                <dd className="mt-1 text-sm">{lane.tripNumber || 'N/A'}</dd>
              </div>
              <div>
                <dt className="text-sm font-medium text-muted-foreground">Priority</dt>
                <dd className="mt-1 text-sm">{lane.lanePriority || 'N/A'}</dd>
              </div>
              <div>
                <dt className="text-sm font-medium text-muted-foreground">Contract Start</dt>
                <dd className="mt-1 text-sm">{lane.contractPeriodStart}</dd>
              </div>
              <div>
                <dt className="text-sm font-medium text-muted-foreground">Contract End</dt>
                <dd className="mt-1 text-sm">{lane.contractPeriodEnd}</dd>
              </div>
              {lane.notes && (
                <div className="md:col-span-2 lg:col-span-3">
                  <dt className="text-sm font-medium text-muted-foreground">Notes</dt>
                  <dd className="mt-1 text-sm">{lane.notes}</dd>
                </div>
              )}
            </dl>
          </Card>

          {/* Stops */}
          <Card className="p-6">
            <h2 className="text-xl font-semibold mb-4">Stops</h2>
            <div className="space-y-4">
              {lane.stops.map((stop, index) => (
                <Card key={index} className="p-4">
                  <div className="flex items-center justify-between mb-2">
                    <h3 className="font-semibold">Stop {stop.stopOrder}</h3>
                    <div className="flex gap-2">
                      <Badge variant="outline">{stop.stopType}</Badge>
                      <Badge variant="outline">{stop.type}</Badge>
                    </div>
                  </div>
                  <dl className="grid grid-cols-2 md:grid-cols-4 gap-3 text-sm">
                    <div>
                      <dt className="text-muted-foreground">Address</dt>
                      <dd>{stop.address}</dd>
                    </div>
                    <div>
                      <dt className="text-muted-foreground">City</dt>
                      <dd>{stop.city}</dd>
                    </div>
                    <div>
                      <dt className="text-muted-foreground">State</dt>
                      <dd>{stop.state}</dd>
                    </div>
                    <div>
                      <dt className="text-muted-foreground">ZIP</dt>
                      <dd>{stop.zip}</dd>
                    </div>
                    <div>
                      <dt className="text-muted-foreground">Arrival Time</dt>
                      <dd>{stop.arrivalTime}</dd>
                    </div>
                  </dl>
                </Card>
              ))}
            </div>
            {lane.miles !== undefined && (
              <div className="mt-4 grid grid-cols-2 gap-4">
                <div>
                  <dt className="text-sm font-medium text-muted-foreground">Miles</dt>
                  <dd className="mt-1 text-sm">{lane.miles}</dd>
                </div>
                {lane.loadCommodity && (
                  <div>
                    <dt className="text-sm font-medium text-muted-foreground">Load Commodity</dt>
                    <dd className="mt-1 text-sm">{lane.loadCommodity}</dd>
                  </div>
                )}
              </div>
            )}
          </Card>

          {/* Equipment Requirements */}
          {(lane.equipmentClass || lane.equipmentSize) && (
            <Card className="p-6">
              <h2 className="text-xl font-semibold mb-4">Equipment Requirements</h2>
              <dl className="grid grid-cols-1 md:grid-cols-2 gap-4">
                {lane.equipmentClass && (
                  <div>
                    <dt className="text-sm font-medium text-muted-foreground">Equipment Class</dt>
                    <dd className="mt-1 text-sm">{lane.equipmentClass}</dd>
                  </div>
                )}
                {lane.equipmentSize && (
                  <div>
                    <dt className="text-sm font-medium text-muted-foreground">Equipment Size</dt>
                    <dd className="mt-1 text-sm">{lane.equipmentSize}</dd>
                  </div>
                )}
              </dl>
            </Card>
          )}

          {/* Rate Information */}
          <Card className="p-6">
            <h2 className="text-xl font-semibold mb-4">Rate Information</h2>
            <dl className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
              <div>
                <dt className="text-sm font-medium text-muted-foreground">Rate</dt>
                <dd className="mt-1 text-sm">
                  {lane.currency || 'USD'} {lane.rate.toFixed(2)}
                </dd>
              </div>
              <div>
                <dt className="text-sm font-medium text-muted-foreground">Rate Type</dt>
                <dd className="mt-1 text-sm">{lane.rateType}</dd>
              </div>
              {lane.minimumRate !== undefined && (
                <div>
                  <dt className="text-sm font-medium text-muted-foreground">Minimum Rate</dt>
                  <dd className="mt-1 text-sm">
                    {lane.currency || 'USD'} {lane.minimumRate.toFixed(2)}
                  </dd>
                </div>
              )}
              {lane.minimumQuantity !== undefined && (
                <div>
                  <dt className="text-sm font-medium text-muted-foreground">Minimum Quantity</dt>
                  <dd className="mt-1 text-sm">{lane.minimumQuantity}</dd>
                </div>
              )}
              {lane.subsidiary && (
                <div>
                  <dt className="text-sm font-medium text-muted-foreground">Subsidiary</dt>
                  <dd className="mt-1 text-sm">{lane.subsidiary}</dd>
                </div>
              )}
            </dl>
          </Card>
        </div>
      </>
  );
}
