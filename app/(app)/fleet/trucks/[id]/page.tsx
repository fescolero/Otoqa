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
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Separator } from '@/components/ui/separator';
import { SidebarTrigger } from '@/components/ui/sidebar';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { Badge } from '@/components/ui/badge';
import { useAuth } from '@workos-inc/authkit-nextjs/components';
import { useQuery, useMutation } from 'convex/react';
import { api } from '@/convex/_generated/api';
import { useRouter } from 'next/navigation';
import { useState } from 'react';
import { 
  Edit, 
  Trash2, 
  Copy, 
  Check, 
  FileText, 
  AlertTriangle,
  CheckCircle2,
  Download
} from 'lucide-react';
import { Id } from '@/convex/_generated/dataModel';
import { format, differenceInDays, isPast } from 'date-fns';
import { use } from 'react';

export default function TruckDetailPage({ params }: { params: Promise<{ id: string }> }) {
  const { user } = useAuth();
  const router = useRouter();
  const { id } = use(params);
  const truck = useQuery(api.trucks.get, { id: id as Id<'trucks'> });
  const deactivateTruck = useMutation(api.trucks.deactivate);
  const [copiedVin, setCopiedVin] = useState(false);

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

  const getStatusColor = (status: string) => {
    const colors: Record<string, string> = {
      'Active': 'bg-green-100 text-green-800 dark:bg-green-900 dark:text-green-300',
      'Out of Service': 'bg-red-100 text-red-800 dark:bg-red-900 dark:text-red-300',
      'In Repair': 'bg-yellow-100 text-yellow-800 dark:bg-yellow-900 dark:text-yellow-300',
      'Maintenance': 'bg-blue-100 text-blue-800 dark:bg-blue-900 dark:text-blue-300',
      'Sold': 'bg-gray-100 text-gray-800 dark:bg-gray-900 dark:text-gray-300',
      'Lost': 'bg-gray-100 text-gray-800 dark:bg-gray-900 dark:text-gray-300',
    };
    return colors[status] || 'bg-gray-100 text-gray-800';
  };

  const getDaysAgo = (dateStr: string) => {
    const date = new Date(dateStr);
    const daysAgo = Math.abs(differenceInDays(new Date(), date));
    return daysAgo;
  };

  const getExpirationStatus = (dateStr: string | undefined) => {
    if (!dateStr) return { 
      text: 'Not set', 
      variant: 'default' as const, 
      icon: AlertTriangle,
      color: 'text-gray-600',
      expired: false
    };
    
    const date = new Date(dateStr);
    const daysUntil = differenceInDays(date, new Date());
    
    if (isPast(date)) {
      const daysAgo = getDaysAgo(dateStr);
      return { 
        text: `Expired ${format(date, 'MMM d, yyyy')} (${daysAgo} days ago)`, 
        variant: 'destructive' as const, 
        icon: AlertTriangle,
        color: 'text-red-600',
        expired: true
      };
    } else if (daysUntil <= 30) {
      return { 
        text: `Expires in ${daysUntil} days`, 
        variant: 'warning' as const, 
        icon: AlertTriangle,
        color: 'text-orange-600',
        expired: false
      };
    } else {
      return { 
        text: `Expires ${format(date, 'MMM d, yyyy')}`, 
        variant: 'default' as const, 
        icon: CheckCircle2,
        color: 'text-green-600',
        expired: false
      };
    }
  };

  const getComplianceStatus = () => {
    const regStatus = getExpirationStatus(truck?.registrationExpiration);
    const insStatus = getExpirationStatus(truck?.insuranceExpiration);
    
    if (regStatus.expired || insStatus.expired) {
      return { status: 'Non-Compliant', color: 'bg-red-100 text-red-800 dark:bg-red-900 dark:text-red-300' };
    } else if (regStatus.variant === 'warning' || insStatus.variant === 'warning') {
      return { status: 'Expiring Soon', color: 'bg-orange-100 text-orange-800 dark:bg-orange-900 dark:text-orange-300' };
    } else {
      return { status: 'Compliant', color: 'bg-green-100 text-green-800 dark:bg-green-900 dark:text-green-300' };
    }
  };

  const handleCopyVin = () => {
    if (truck?.vin) {
      navigator.clipboard.writeText(truck.vin);
      setCopiedVin(true);
      setTimeout(() => setCopiedVin(false), 2000);
    }
  };

  const handleEdit = () => {
    router.push(`/fleet/trucks/${id}/edit`);
  };

  const handleDeactivate = async () => {
    if (!user || !truck) return;

    const confirmed = confirm(`Are you sure you want to deactivate truck ${truck.unitId}?`);
    if (!confirmed) return;

    const userName = user.firstName && user.lastName ? `${user.firstName} ${user.lastName}` : user.email;

    try {
      await deactivateTruck({
        id: truck._id,
        userId: user.id,
        userName,
      });
      router.push('/fleet/trucks');
    } catch (error) {
      console.error('Failed to deactivate truck:', error);
      alert('Failed to deactivate truck. Please try again.');
    }
  };

  if (truck === undefined) {
    return (
      <>
          <div className="flex items-center justify-center h-screen">
            <p className="text-muted-foreground">Loading truck...</p>
          </div>
        </>
    );
  }

  if (truck === null) {
    return (
      <>
          <div className="flex items-center justify-center h-screen">
            <p className="text-muted-foreground">Truck not found</p>
          </div>
        </>
    );
  }

  const registrationStatus = getExpirationStatus(truck.registrationExpiration);
  const insuranceStatus = getExpirationStatus(truck.insuranceExpiration);
  const complianceStatus = getComplianceStatus();
  const hasComplianceIssues = registrationStatus.expired || insuranceStatus.expired || 
                              registrationStatus.variant === 'warning' || insuranceStatus.variant === 'warning';

  return (
    <>
        <header className="sticky top-0 z-40 flex h-16 shrink-0 items-center gap-2 transition-[width,height] ease-linear group-has-data-[collapsible=icon]/sidebar-wrapper:h-12 border-b bg-background">
          <div className="flex items-center gap-2 px-4 w-full">
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
                  <BreadcrumbLink href="/fleet/trucks">Trucks</BreadcrumbLink>
                </BreadcrumbItem>
                <BreadcrumbSeparator className="hidden md:block" />
                <BreadcrumbItem>
                  <BreadcrumbPage>{truck.unitId}</BreadcrumbPage>
                </BreadcrumbItem>
              </BreadcrumbList>
            </Breadcrumb>
          </div>
        </header>

        <div className="flex flex-1 flex-col gap-6 p-6">
          {/* Header */}
          <div className="flex items-center justify-between">
            <div className="flex-1">
              <div className="flex items-center gap-3 mb-2">
                <h1 className="text-3xl font-bold tracking-tight">{truck.unitId}</h1>
                <Badge className={complianceStatus.color}>{complianceStatus.status}</Badge>
              </div>
              <p className="text-muted-foreground text-lg">
                {truck.year} {truck.make} {truck.model}
              </p>
            </div>
            <div className="flex gap-2">
              <Button variant="outline">
                <Download className="mr-2 h-4 w-4" />
                Download Report
              </Button>
              <Button variant="outline" onClick={handleEdit}>
                <Edit className="mr-2 h-4 w-4" />
                Edit
              </Button>
              {!truck.isDeleted && (
                <Button variant="destructive" onClick={handleDeactivate}>
                  <Trash2 className="mr-2 h-4 w-4" />
                  Deactivate
                </Button>
              )}
            </div>
          </div>

          {/* Two Column Layout */}
          <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
            {/* Left Column - Operational & Compliance (66%) */}
            <div className="lg:col-span-2 space-y-6">
              {/* Vehicle Identification */}
              <Card>
                <CardHeader>
                  <CardTitle>Vehicle Identification</CardTitle>
                </CardHeader>
                <CardContent className="space-y-3">
                  <div>
                    <label className="text-sm font-medium text-muted-foreground">VIN</label>
                    <div className="flex items-center gap-2 mt-1">
                      <code className="text-base font-mono font-medium">{truck.vin}</code>
                      <Button
                        variant="ghost"
                        size="sm"
                        className="h-6 w-6 p-0"
                        onClick={handleCopyVin}
                      >
                        {copiedVin ? <Check className="h-3 w-3" /> : <Copy className="h-3 w-3" />}
                      </Button>
                    </div>
                  </div>
                  <div className="grid grid-cols-2 gap-4">
                    {truck.plate && (
                      <div>
                        <label className="text-sm font-medium text-muted-foreground">License Plate</label>
                        <p className="text-base font-medium mt-1">{truck.plate}</p>
                      </div>
                    )}
                    {truck.bodyType && (
                      <div>
                        <label className="text-sm font-medium text-muted-foreground">Body Type</label>
                        <p className="text-base font-medium mt-1">{truck.bodyType}</p>
                      </div>
                    )}
                  </div>
                  <div className="col-span-2">
                    <Button variant="outline" size="sm">
                      <FileText className="mr-2 h-4 w-4" />
                      View Registration
                    </Button>
                  </div>
                </CardContent>
              </Card>

              {/* Compliance & Insurance */}
              <Card>
                <CardHeader>
                  <div className="flex items-center justify-between">
                    <CardTitle>Compliance & Insurance</CardTitle>
                    {hasComplianceIssues && (
                      <AlertTriangle className="h-5 w-5 text-red-600" />
                    )}
                  </div>
                </CardHeader>
                <CardContent className="space-y-4">
                  <div className="space-y-3">
                    <div>
                      <label className="text-sm font-medium text-muted-foreground">Registration Expiration</label>
                      <p className={`text-base font-medium mt-1 ${registrationStatus.color}`}>
                        {registrationStatus.text}
                      </p>
                      <Button variant="outline" size="sm" className="mt-2">
                        View Policy
                      </Button>
                    </div>
                  </div>
                  
                  <Separator />
                  
                  <div className="space-y-3">
                    {truck.insuranceFirm && (
                      <div>
                        <label className="text-sm font-medium text-muted-foreground">Insurance Firm</label>
                        <p className="text-base font-medium mt-1">{truck.insuranceFirm}</p>
                      </div>
                    )}
                    {truck.insurancePolicyNumber && (
                      <div>
                        <label className="text-sm font-medium text-muted-foreground">Policy Number</label>
                        <p className="text-base font-medium mt-1">{truck.insurancePolicyNumber}</p>
                      </div>
                    )}
                    <div>
                      <label className="text-sm font-medium text-muted-foreground">Insurance Expiration</label>
                      <p className={`text-base font-medium mt-1 ${insuranceStatus.color}`}>
                        {insuranceStatus.text}
                      </p>
                      <Button variant="outline" size="sm" className="mt-2">
                        Upload Renewal
                      </Button>
                    </div>
                  </div>
                  
                  <Separator />
                  
                  <div className="grid grid-cols-2 gap-4">
                    <div>
                      <label className="text-sm font-medium text-muted-foreground">ARB Compliance</label>
                      <Badge variant={truck.arb ? 'default' : 'secondary'} className="mt-1">
                        {truck.arb ? 'Yes' : 'No'}
                      </Badge>
                    </div>
                    <div>
                      <label className="text-sm font-medium text-muted-foreground">IFTA</label>
                      <Badge variant={truck.ifta ? 'default' : 'secondary'} className="mt-1">
                        {truck.ifta ? 'Yes' : 'No'}
                      </Badge>
                    </div>
                  </div>
                  
                  {truck.insuranceComments && (
                    <div>
                      <label className="text-sm font-medium text-muted-foreground">Comments</label>
                      <p className="text-sm text-gray-600 dark:text-gray-400 mt-1">{truck.insuranceComments}</p>
                    </div>
                  )}
                </CardContent>
              </Card>
            </div>

            {/* Right Column - Technical & Asset Details (33%) */}
            <div className="space-y-6">
              {/* Technical Specifications */}
              <Card>
                <CardHeader>
                  <CardTitle>Technical Specifications</CardTitle>
                </CardHeader>
                <CardContent className="space-y-3">
                  {truck.gvwr && (
                    <div>
                      <label className="text-sm font-medium text-muted-foreground">GVWR</label>
                      <p className="text-base font-medium mt-1">{truck.gvwr.toLocaleString()} lbs</p>
                    </div>
                  )}
                  {truck.gcwr && (
                    <div>
                      <label className="text-sm font-medium text-muted-foreground">GCWR</label>
                      <p className="text-base font-medium mt-1">{truck.gcwr.toLocaleString()} lbs</p>
                    </div>
                  )}
                  {truck.fuelType && (
                    <div>
                      <label className="text-sm font-medium text-muted-foreground">Fuel Type</label>
                      <p className="text-base font-medium mt-1">{truck.fuelType}</p>
                    </div>
                  )}
                  {truck.engineManufacturer && (
                    <div>
                      <label className="text-sm font-medium text-muted-foreground">Engine Manufacturer</label>
                      <p className="text-base font-medium mt-1">{truck.engineManufacturer}</p>
                    </div>
                  )}
                  {truck.engineModel && (
                    <div>
                      <label className="text-sm font-medium text-muted-foreground">Engine Model</label>
                      <p className="text-base font-medium mt-1">{truck.engineModel}</p>
                    </div>
                  )}
                </CardContent>
              </Card>

              {/* Asset Details */}
              <Card>
                <CardHeader>
                  <CardTitle>Asset Details</CardTitle>
                </CardHeader>
                <CardContent className="space-y-3">
                  {truck.purchaseDate && (
                    <div>
                      <label className="text-sm font-medium text-muted-foreground">Purchase Date</label>
                      <p className="text-base font-medium mt-1">
                        {format(new Date(truck.purchaseDate), 'MMM d, yyyy')}
                      </p>
                    </div>
                  )}
                  {truck.purchasePrice && (
                    <div>
                      <label className="text-sm font-medium text-muted-foreground">Purchase Price</label>
                      <p className="text-base font-medium mt-1">
                        ${truck.purchasePrice.toLocaleString()}
                      </p>
                    </div>
                  )}
                  {truck.ownershipType && (
                    <div>
                      <label className="text-sm font-medium text-muted-foreground">Ownership Type</label>
                      <p className="text-base font-medium mt-1">{truck.ownershipType}</p>
                    </div>
                  )}
                  {truck.lienholder && (
                    <div>
                      <label className="text-sm font-medium text-muted-foreground">Lienholder</label>
                      <p className="text-base font-medium mt-1">{truck.lienholder}</p>
                    </div>
                  )}
                </CardContent>
              </Card>
            </div>
          </div>

          {/* Full Width History Section */}
          <Tabs defaultValue="audit" className="w-full">
            <TabsList>
              <TabsTrigger value="maintenance">Maintenance Logs</TabsTrigger>
              <TabsTrigger value="trips">Trip History</TabsTrigger>
              <TabsTrigger value="audit">Audit Log</TabsTrigger>
            </TabsList>

            <TabsContent value="maintenance" className="space-y-4">
              <Card>
                <CardHeader>
                  <CardTitle>Maintenance Logs</CardTitle>
                  <CardDescription>Service history and maintenance records</CardDescription>
                </CardHeader>
                <CardContent>
                  <p className="text-sm text-muted-foreground">Maintenance logging feature coming soon.</p>
                </CardContent>
              </Card>
            </TabsContent>

            <TabsContent value="trips" className="space-y-4">
              <Card>
                <CardHeader>
                  <CardTitle>Trip History</CardTitle>
                  <CardDescription>Historical trip logs and mileage records</CardDescription>
                </CardHeader>
                <CardContent>
                  <p className="text-sm text-muted-foreground">Trip history feature coming soon.</p>
                </CardContent>
              </Card>
            </TabsContent>

            <TabsContent value="audit" className="space-y-4">
              <Card>
                <CardHeader>
                  <CardTitle>Audit Log</CardTitle>
                  <CardDescription>Timeline of changes and updates</CardDescription>
                </CardHeader>
                <CardContent className="space-y-4">
                  <div className="space-y-3">
                    <div className="flex items-start gap-3">
                      <div className="rounded-full bg-blue-100 p-2 dark:bg-blue-900">
                        <CheckCircle2 className="h-4 w-4 text-blue-600 dark:text-blue-400" />
                      </div>
                      <div className="flex-1 space-y-1">
                        <p className="text-sm font-medium">Created</p>
                        <p className="text-sm text-muted-foreground">
                          {format(new Date(truck.createdAt), 'MMM d, yyyy h:mm a')}
                        </p>
                        <p className="text-xs text-muted-foreground">Created by {truck.createdBy}</p>
                      </div>
                    </div>

                    <div className="flex items-start gap-3">
                      <div className="rounded-full bg-green-100 p-2 dark:bg-green-900">
                        <Edit className="h-4 w-4 text-green-600 dark:text-green-400" />
                      </div>
                      <div className="flex-1 space-y-1">
                        <p className="text-sm font-medium">Last Updated</p>
                        <p className="text-sm text-muted-foreground">
                          {format(new Date(truck.updatedAt), 'MMM d, yyyy h:mm a')}
                        </p>
                      </div>
                    </div>

                    {truck.isDeleted && truck.deletedAt && (
                      <div className="flex items-start gap-3">
                        <div className="rounded-full bg-red-100 p-2 dark:bg-red-900">
                          <Trash2 className="h-4 w-4 text-red-600 dark:text-red-400" />
                        </div>
                        <div className="flex-1 space-y-1">
                          <p className="text-sm font-medium">Deactivated</p>
                          <p className="text-sm text-muted-foreground">
                            {format(new Date(truck.deletedAt), 'MMM d, yyyy h:mm a')}
                          </p>
                          {truck.deletedBy && (
                            <p className="text-xs text-muted-foreground">Deleted by {truck.deletedBy}</p>
                          )}
                        </div>
                      </div>
                    )}
                  </div>
                </CardContent>
              </Card>
            </TabsContent>
          </Tabs>
        </div>
      </>
  );
}
