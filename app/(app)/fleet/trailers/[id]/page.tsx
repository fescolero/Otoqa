'use client';

import {
  Breadcrumb,
  BreadcrumbItem,
  BreadcrumbLink,
  BreadcrumbList,
  BreadcrumbPage,
  BreadcrumbSeparator,
} from '@/components/ui/breadcrumb';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Separator } from '@/components/ui/separator';
import { SidebarTrigger } from '@/components/ui/sidebar';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { useAuth } from '@workos-inc/authkit-nextjs/components';
import { useQuery, useMutation } from 'convex/react';
import { api } from '@/convex/_generated/api';
import { useRouter } from 'next/navigation';
import { AlertCircle, Download, Pencil, Truck, Trash2 } from 'lucide-react';
import { Id } from '@/convex/_generated/dataModel';
import { use } from 'react';

export default function TrailerDetailsPage({ params }: { params: Promise<{ id: string }> }) {
  const { user } = useAuth();
  const router = useRouter();
  const { id } = use(params);
  const trailer = useQuery(api.trailers.get, { id: id as Id<'trailers'> });
  const deactivateTrailer = useMutation(api.trailers.deactivate);

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

  const getDaysAgo = (date: string | undefined): number => {
    if (!date) return -1;
    const now = new Date();
    const targetDate = new Date(date);
    const diffMs = now.getTime() - targetDate.getTime();
    return Math.floor(diffMs / (1000 * 60 * 60 * 24));
  };

  const getExpirationStatus = (expiration: string | undefined) => {
    if (!expiration) return { text: 'Not Set', variant: 'secondary' as const, days: null };

    const expirationDate = new Date(expiration);
    const now = new Date();
    const daysUntilExpiration = Math.ceil((expirationDate.getTime() - now.getTime()) / (1000 * 60 * 60 * 24));

    if (daysUntilExpiration < 0) {
      return { text: 'Expired', variant: 'destructive' as const, days: Math.abs(daysUntilExpiration) };
    } else if (daysUntilExpiration <= 30) {
      return { text: 'Expiring Soon', variant: 'warning' as const, days: daysUntilExpiration };
    } else {
      return { text: 'Valid', variant: 'success' as const, days: daysUntilExpiration };
    }
  };

  const getComplianceStatus = (
    registrationExpiration: string | undefined,
    insuranceExpiration: string | undefined,
  ) => {
    const regStatus = getExpirationStatus(registrationExpiration);
    const insStatus = getExpirationStatus(insuranceExpiration);

    if (regStatus.variant === 'destructive' || insStatus.variant === 'destructive') {
      return { text: 'Non-Compliant', variant: 'destructive' as const };
    }
    if (regStatus.variant === 'warning' || insStatus.variant === 'warning') {
      return { text: 'Expiring Soon', variant: 'warning' as const };
    }
    return { text: 'Compliant', variant: 'success' as const };
  };

  const handleDeactivate = async () => {
    if (!user || !trailer) return;

    const confirmed = confirm(`Are you sure you want to deactivate trailer ${trailer.unitId}?`);
    if (!confirmed) return;

    const userName = user.firstName && user.lastName ? `${user.firstName} ${user.lastName}` : user.email;

    try {
      await deactivateTrailer({
        id: trailer._id,
        userId: user.id,
        userName,
      });
      router.push('/fleet/trailers');
    } catch (error) {
      console.error('Failed to deactivate trailer:', error);
      alert('Failed to deactivate trailer. Please try again.');
    }
  };

  if (trailer === undefined) {
    return (
      <>
          <div className="flex items-center justify-center h-screen">
            <p className="text-muted-foreground">Loading trailer...</p>
          </div>
        </>
    );
  }

  if (trailer === null) {
    return (
      <>
          <div className="flex items-center justify-center h-screen">
            <p className="text-muted-foreground">Trailer not found</p>
          </div>
        </>
    );
  }

  const registrationStatus = getExpirationStatus(trailer.registrationExpiration);
  const insuranceStatus = getExpirationStatus(trailer.insuranceExpiration);
  const complianceStatus = getComplianceStatus(trailer.registrationExpiration, trailer.insuranceExpiration);

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
                  <BreadcrumbLink href="#">Fleet Management</BreadcrumbLink>
                </BreadcrumbItem>
                <BreadcrumbSeparator className="hidden md:block" />
                <BreadcrumbItem className="hidden md:block">
                  <BreadcrumbLink href="/fleet/trailers">Trailers</BreadcrumbLink>
                </BreadcrumbItem>
                <BreadcrumbSeparator className="hidden md:block" />
                <BreadcrumbItem>
                  <BreadcrumbPage>{trailer.unitId}</BreadcrumbPage>
                </BreadcrumbItem>
              </BreadcrumbList>
            </Breadcrumb>
          </div>
        </header>

        <div className="flex flex-1 flex-col gap-6 p-4 md:p-6">
          {/* Header */}
          <div className="flex items-start justify-between">
            <div className="space-y-1">
              <div className="flex items-center gap-3">
                <div className="flex h-12 w-12 items-center justify-center rounded-lg border bg-muted/50">
                  <Truck className="h-6 w-6" />
                </div>
                <div>
                  <div className="flex items-center gap-3">
                    <h1 className="text-3xl font-bold tracking-tight">{trailer.unitId}</h1>
                    <Badge
                      className={
                        complianceStatus.variant === 'success'
                          ? 'bg-green-100 text-green-800 dark:bg-green-900 dark:text-green-300'
                          : 'bg-red-100 text-red-800 dark:bg-red-900 dark:text-red-300'
                      }
                    >
                      {complianceStatus.text}
                    </Badge>
                  </div>
                  <p className="text-gray-600 dark:text-gray-400">
                    {trailer.year} {trailer.make} {trailer.model}
                  </p>
                </div>
              </div>
            </div>
            <div className="flex items-center gap-2">
              <Button variant="outline" size="sm">
                <Download className="mr-2 h-4 w-4" />
                Export
              </Button>
              <Button variant="outline" size="sm" onClick={() => router.push(`/fleet/trailers/${id}/edit`)}>
                <Pencil className="mr-2 h-4 w-4" />
                Edit
              </Button>
              {!trailer.isDeleted && (
                <Button variant="destructive" size="sm" onClick={handleDeactivate}>
                  <Trash2 className="mr-2 h-4 w-4" />
                  Deactivate
                </Button>
              )}
            </div>
          </div>

          {/* 2-Column Grid */}
          <div className="grid gap-6 lg:grid-cols-3">
            {/* Left Column (66%) */}
            <div className="space-y-6 lg:col-span-2">
              {/* Vehicle Identification */}
              <Card>
                <CardHeader>
                  <CardTitle>Vehicle Identification</CardTitle>
                  <CardDescription>Basic trailer information and identifiers</CardDescription>
                </CardHeader>
                <CardContent>
                  <dl className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                    <div>
                      <dt className="text-sm font-medium text-muted-foreground">Unit ID</dt>
                      <dd className="mt-1 text-sm font-semibold">{trailer.unitId}</dd>
                    </div>
                    <div>
                      <dt className="text-sm font-medium text-muted-foreground">VIN</dt>
                      <dd className="mt-1 text-sm font-mono font-semibold">{trailer.vin}</dd>
                    </div>
                    <div>
                      <dt className="text-sm font-medium text-muted-foreground">License Plate</dt>
                      <dd className="mt-1 text-sm font-semibold">{trailer.plate || 'N/A'}</dd>
                    </div>
                    <div>
                      <dt className="text-sm font-medium text-muted-foreground">Status</dt>
                      <dd className="mt-1">
                        <Badge
                          variant={
                            trailer.status === 'Active'
                              ? 'success'
                              : trailer.status === 'Out of Service'
                                ? 'destructive'
                                : 'secondary'
                          }
                        >
                          {trailer.status}
                        </Badge>
                      </dd>
                    </div>
                    <div>
                      <dt className="text-sm font-medium text-muted-foreground">Year</dt>
                      <dd className="mt-1 text-sm">{trailer.year || 'N/A'}</dd>
                    </div>
                    <div>
                      <dt className="text-sm font-medium text-muted-foreground">Make</dt>
                      <dd className="mt-1 text-sm">{trailer.make || 'N/A'}</dd>
                    </div>
                    <div>
                      <dt className="text-sm font-medium text-muted-foreground">Model</dt>
                      <dd className="mt-1 text-sm">{trailer.model || 'N/A'}</dd>
                    </div>
                  </dl>
                </CardContent>
              </Card>

              {/* Compliance & Insurance */}
              <Card>
                <CardHeader>
                  <CardTitle>Compliance & Insurance</CardTitle>
                  <CardDescription>Registration and insurance status</CardDescription>
                </CardHeader>
                <CardContent className="space-y-6">
                  {/* Registration */}
                  <div className="space-y-3">
                    <div className="flex items-center justify-between">
                      <h4 className="text-sm font-semibold">Registration</h4>
                    </div>
                    <dl className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                      <div>
                        <dt className="text-sm font-medium text-muted-foreground">Expiration Date</dt>
                        <dd
                          className={
                            `mt-1 text-sm font-semibold ${
                              registrationStatus.variant === 'success'
                                ? 'text-green-600 dark:text-green-400'
                                : registrationStatus.variant === 'warning'
                                  ? 'text-yellow-600 dark:text-yellow-400'
                                  : registrationStatus.variant === 'destructive'
                                    ? 'text-red-600 dark:text-red-400'
                                    : ''
                            }`
                          }
                        >
                          {trailer.registrationExpiration
                            ? new Date(trailer.registrationExpiration).toLocaleDateString()
                            : 'Not Set'}
                        </dd>
                      </div>
                      {registrationStatus.days !== null && (
                        <div>
                          <dt className="text-sm font-medium text-muted-foreground">
                            {registrationStatus.variant === 'destructive' ? 'Days Expired' : 'Days Until Expiration'}
                          </dt>
                          <dd className="mt-1 text-sm">{registrationStatus.days}</dd>
                        </div>
                      )}
                    </dl>
                    {trailer.comments && (
                      <div>
                        <dt className="text-sm font-medium text-muted-foreground">Comments</dt>
                        <dd className="mt-1 text-sm">{trailer.comments}</dd>
                      </div>
                    )}
                  </div>

                  <Separator />

                  {/* Insurance */}
                  <div className="space-y-3">
                    <div className="flex items-center justify-between">
                      <h4 className="text-sm font-semibold">Insurance</h4>
                    </div>
                    <dl className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                      <div>
                        <dt className="text-sm font-medium text-muted-foreground">Insurance Firm</dt>
                        <dd className="mt-1 text-sm">{trailer.insuranceFirm || 'N/A'}</dd>
                      </div>
                      <div>
                        <dt className="text-sm font-medium text-muted-foreground">Policy Number</dt>
                        <dd className="mt-1 text-sm font-mono">{trailer.insurancePolicyNumber || 'N/A'}</dd>
                      </div>
                      <div>
                        <dt className="text-sm font-medium text-muted-foreground">Expiration Date</dt>
                        <dd
                          className={
                            `mt-1 text-sm font-semibold ${
                              insuranceStatus.variant === 'success'
                                ? 'text-green-600 dark:text-green-400'
                                : insuranceStatus.variant === 'warning'
                                  ? 'text-yellow-600 dark:text-yellow-400'
                                  : insuranceStatus.variant === 'destructive'
                                    ? 'text-red-600 dark:text-red-400'
                                    : ''
                            }`
                          }
                        >
                          {trailer.insuranceExpiration
                            ? new Date(trailer.insuranceExpiration).toLocaleDateString()
                            : 'Not Set'}
                        </dd>
                      </div>
                      {insuranceStatus.days !== null && (
                        <div>
                          <dt className="text-sm font-medium text-muted-foreground">
                            {insuranceStatus.variant === 'destructive' ? 'Days Expired' : 'Days Until Expiration'}
                          </dt>
                          <dd className="mt-1 text-sm">{insuranceStatus.days}</dd>
                        </div>
                      )}
                    </dl>
                    {trailer.insuranceComments && (
                      <div className="col-span-2">
                        <dt className="text-sm font-medium text-muted-foreground">Insurance Comments</dt>
                        <dd className="mt-1 text-sm">{trailer.insuranceComments}</dd>
                      </div>
                    )}
                  </div>
                </CardContent>
              </Card>
            </div>

            {/* Right Column (33%) */}
            <div className="space-y-6 lg:col-span-1">
              {/* Technical Specifications */}
              <Card>
                <CardHeader>
                  <CardTitle>Specifications</CardTitle>
                  <CardDescription>Technical details</CardDescription>
                </CardHeader>
                <CardContent>
                  <dl className="space-y-4">
                    <div>
                      <dt className="text-sm font-medium text-muted-foreground">Size</dt>
                      <dd className="mt-1 text-sm font-semibold">{trailer.size || 'N/A'}</dd>
                    </div>
                    <div>
                      <dt className="text-sm font-medium text-muted-foreground">Body Type</dt>
                      <dd className="mt-1 text-sm">{trailer.bodyType || 'N/A'}</dd>
                    </div>
                    <div>
                      <dt className="text-sm font-medium text-muted-foreground">GVWR</dt>
                      <dd className="mt-1 text-sm">{trailer.gvwr ? `${trailer.gvwr.toLocaleString()} lbs` : 'N/A'}</dd>
                    </div>
                  </dl>
                </CardContent>
              </Card>

              {/* Asset Details */}
              <Card>
                <CardHeader>
                  <CardTitle>Asset Details</CardTitle>
                  <CardDescription>Financial and ownership information</CardDescription>
                </CardHeader>
                <CardContent>
                  <dl className="space-y-4">
                    <div>
                      <dt className="text-sm font-medium text-muted-foreground">Purchase Date</dt>
                      <dd className="mt-1 text-sm">
                        {trailer.purchaseDate ? new Date(trailer.purchaseDate).toLocaleDateString() : 'N/A'}
                      </dd>
                    </div>
                    <div>
                      <dt className="text-sm font-medium text-muted-foreground">Purchase Price</dt>
                      <dd className="mt-1 text-sm">
                        {trailer.purchasePrice ? `$${trailer.purchasePrice.toLocaleString()}` : 'N/A'}
                      </dd>
                    </div>
                    <div>
                      <dt className="text-sm font-medium text-muted-foreground">Ownership Type</dt>
                      <dd className="mt-1 text-sm">{trailer.ownershipType || 'N/A'}</dd>
                    </div>
                    <div>
                      <dt className="text-sm font-medium text-muted-foreground">Lienholder</dt>
                      <dd className="mt-1 text-sm">{trailer.lienholder || 'N/A'}</dd>
                    </div>
                    <Separator />
                    <div>
                      <dt className="text-sm font-medium text-muted-foreground">Created</dt>
                      <dd className="mt-1 text-sm">
                        {new Date(trailer._creationTime).toLocaleDateString()} by {trailer.createdBy}
                      </dd>
                    </div>
                    <div>
                      <dt className="text-sm font-medium text-muted-foreground">Last Updated</dt>
                      <dd className="mt-1 text-sm">
                        {trailer.updatedAt ? new Date(trailer.updatedAt).toLocaleDateString() : 'Never'}
                      </dd>
                    </div>
                  </dl>
                </CardContent>
              </Card>
            </div>
          </div>

          {/* Full Width History Section */}
          <Card>
            <CardHeader>
              <CardTitle>History</CardTitle>
              <CardDescription>Maintenance logs, trip history, and audit trail</CardDescription>
            </CardHeader>
            <CardContent>
              <Tabs defaultValue="maintenance" className="w-full">
                <TabsList className="grid w-full grid-cols-3">
                  <TabsTrigger value="maintenance">Maintenance Logs</TabsTrigger>
                  <TabsTrigger value="trips">Trip History</TabsTrigger>
                  <TabsTrigger value="audit">Audit Log</TabsTrigger>
                </TabsList>
                <TabsContent value="maintenance" className="space-y-4">
                  <div className="flex items-center justify-center py-12 text-muted-foreground">
                    <div className="text-center space-y-2">
                      <AlertCircle className="mx-auto h-8 w-8" />
                      <p>No maintenance logs available</p>
                    </div>
                  </div>
                </TabsContent>
                <TabsContent value="trips" className="space-y-4">
                  <div className="flex items-center justify-center py-12 text-muted-foreground">
                    <div className="text-center space-y-2">
                      <AlertCircle className="mx-auto h-8 w-8" />
                      <p>No trip history available</p>
                    </div>
                  </div>
                </TabsContent>
                <TabsContent value="audit" className="space-y-4">
                  <div className="flex items-center justify-center py-12 text-muted-foreground">
                    <div className="text-center space-y-2">
                      <AlertCircle className="mx-auto h-8 w-8" />
                      <p>No audit logs available</p>
                    </div>
                  </div>
                </TabsContent>
              </Tabs>
            </CardContent>
          </Card>
        </div>
      </>
  );
}
