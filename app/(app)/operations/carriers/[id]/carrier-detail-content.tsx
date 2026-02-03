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
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Separator } from '@/components/ui/separator';
import { SidebarTrigger } from '@/components/ui/sidebar';
import { Badge } from '@/components/ui/badge';
import { useQuery } from 'convex/react';
import { api } from '@/convex/_generated/api';
import { useRouter } from 'next/navigation';
import { Edit, ArrowLeft, Link2, Building2, User, Truck, Phone, Mail, IdCard, Calendar, DollarSign } from 'lucide-react';
import { Id } from '@/convex/_generated/dataModel';
import { CarrierPaySettingsSection } from '@/components/carrier-pay';
import { useAuth } from '@workos-inc/authkit-nextjs/components';
import { useOrganizationId } from '@/contexts/organization-context';

export function CarrierDetailContent({ carrierId }: { carrierId: string }) {
  const router = useRouter();
  const { user } = useAuth();
  const organizationId = useOrganizationId();
  const partnershipId = carrierId as Id<'carrierPartnerships'>;

  // Fetch carrier partnership data using new API
  const partnership = useQuery(api.carrierPartnerships.get, { partnershipId });

  if (!partnership) {
    return (
      <>
        <div className="flex items-center justify-center h-screen">
          <p className="text-muted-foreground">Loading carrier...</p>
        </div>
      </>
    );
  }

  const formatDate = (dateString?: string) => {
    if (!dateString) return '-';
    const date = new Date(dateString);
    return date.toLocaleDateString('en-US', { month: 'long', day: 'numeric', year: 'numeric' });
  };

  const getStatusBadgeVariant = (status: string) => {
    switch (status) {
      case 'ACTIVE':
        return 'default';
      case 'INVITED':
        return 'secondary';
      case 'PENDING':
        return 'outline';
      case 'SUSPENDED':
        return 'destructive';
      case 'TERMINATED':
        return 'destructive';
      default:
        return 'secondary';
    }
  };

  // Check if this is a linked carrier (has an Otoqa account)
  const isLinkedCarrier = !!partnership.carrierOrgId;
  // Use partnership's isOwnerOperator if set, otherwise fall back to carrier org's value
  const isOwnerOperator = partnership.isOwnerOperator ?? partnership.carrierOrg?.isOwnerOperator;
  
  // Get driver info from linked carrier's driver record OR from partnership fields
  const ownerDriver = partnership.ownerDriver;
  const hasPartnershipDriverInfo = partnership.ownerDriverFirstName || partnership.ownerDriverLastName;
  
  // Merged driver data - prefer linked driver, fall back to partnership fields
  const driverInfo = ownerDriver ? {
    firstName: ownerDriver.firstName,
    lastName: ownerDriver.lastName,
    phone: ownerDriver.phone,
    email: ownerDriver.email,
    licenseClass: ownerDriver.licenseClass,
    licenseState: ownerDriver.licenseState,
    licenseExpiration: ownerDriver.licenseExpiration,
    employmentStatus: ownerDriver.employmentStatus,
    source: 'linked' as const,
  } : hasPartnershipDriverInfo ? {
    firstName: partnership.ownerDriverFirstName,
    lastName: partnership.ownerDriverLastName,
    phone: partnership.ownerDriverPhone,
    email: partnership.ownerDriverEmail,
    licenseClass: partnership.ownerDriverLicenseClass,
    licenseState: partnership.ownerDriverLicenseState,
    licenseExpiration: partnership.ownerDriverLicenseExpiration,
    employmentStatus: undefined,
    source: 'partnership' as const,
  } : null;

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
                <BreadcrumbLink href="/operations/carriers">Carriers</BreadcrumbLink>
              </BreadcrumbItem>
              <BreadcrumbSeparator className="hidden md:block" />
              <BreadcrumbItem>
                <BreadcrumbPage>{partnership.carrierName}</BreadcrumbPage>
              </BreadcrumbItem>
            </BreadcrumbList>
          </Breadcrumb>
        </div>
      </header>

      <div className="flex flex-1 flex-col gap-6 p-6">
        {/* Header */}
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-4">
            <Button variant="outline" size="icon" onClick={() => router.push('/operations/carriers')}>
              <ArrowLeft className="h-4 w-4" />
            </Button>
            <div>
              <div className="flex items-center gap-2">
                <h1 className="text-3xl font-bold tracking-tight">{partnership.carrierName}</h1>
                {isLinkedCarrier && (
                  <Badge variant="outline" className="bg-blue-50 text-blue-700 border-blue-200">
                    <Link2 className="w-3 h-3 mr-1" />
                    Linked
                  </Badge>
                )}
                {isOwnerOperator && (
                  <Badge variant="outline" className="bg-amber-50 text-amber-700 border-amber-200">
                    <User className="w-3 h-3 mr-1" />
                    Owner-Operator
                  </Badge>
                )}
              </div>
              {partnership.carrierDba && <p className="text-muted-foreground">DBA: {partnership.carrierDba}</p>}
            </div>
            <Badge variant={getStatusBadgeVariant(partnership.status)} className="ml-4">
              {partnership.status}
            </Badge>
          </div>
          <Button onClick={() => router.push(`/operations/carriers/${partnershipId}/edit`)}>
            <Edit className="mr-2 h-4 w-4" />
            Edit
          </Button>
        </div>

        {/* Linked Carrier Info */}
        {isLinkedCarrier && partnership.carrierOrg && (
          <Card className="border-blue-200 bg-blue-50/50">
            <CardHeader>
              <div className="flex items-center gap-2">
                <Building2 className="h-5 w-5 text-blue-600" />
                <CardTitle className="text-blue-900">Linked Carrier Account</CardTitle>
              </div>
            </CardHeader>
            <CardContent>
              <p className="text-sm text-blue-700">
                This carrier has an Otoqa account. Their profile information is synced automatically.
              </p>
              <div className="mt-2 grid grid-cols-2 gap-4">
                <div>
                  <p className="text-sm text-muted-foreground">Organization</p>
                  <p className="font-medium">{partnership.carrierOrg.name}</p>
                </div>
                <div>
                  <p className="text-sm text-muted-foreground">Organization Type</p>
                  <p className="font-medium">{partnership.carrierOrg.orgType}</p>
                </div>
              </div>
            </CardContent>
          </Card>
        )}

        {/* Owner-Operator Driver Info */}
        {isOwnerOperator && driverInfo && (
          <Card className="border-amber-200 bg-amber-50/50">
            <CardHeader>
              <div className="flex items-center justify-between">
                <div className="flex items-center gap-2">
                  <User className="h-5 w-5 text-amber-600" />
                  <CardTitle className="text-amber-900">Owner-Operator Driver</CardTitle>
                  {driverInfo.source === 'linked' && (
                    <Badge variant="outline" className="bg-blue-50 text-blue-700 border-blue-200 text-xs">
                      <Link2 className="w-3 h-3 mr-1" />
                      Synced
                    </Badge>
                  )}
                </div>
                {driverInfo.employmentStatus && (
                  <Badge variant={driverInfo.employmentStatus === 'Active' ? 'default' : 'secondary'}>
                    {driverInfo.employmentStatus}
                  </Badge>
                )}
              </div>
            </CardHeader>
            <CardContent>
              <p className="text-sm text-amber-700 mb-4">
                This carrier is an owner-operator. The owner drives their own truck and manages their business.
              </p>
              <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
                <div className="flex items-start gap-3">
                  <div className="p-2 rounded-lg bg-amber-100">
                    <User className="h-4 w-4 text-amber-700" />
                  </div>
                  <div>
                    <p className="text-sm text-muted-foreground">Driver Name</p>
                    <p className="font-medium">{driverInfo.firstName} {driverInfo.lastName}</p>
                  </div>
                </div>
                <div className="flex items-start gap-3">
                  <div className="p-2 rounded-lg bg-amber-100">
                    <Phone className="h-4 w-4 text-amber-700" />
                  </div>
                  <div>
                    <p className="text-sm text-muted-foreground">Phone</p>
                    <p className="font-medium">{driverInfo.phone || '-'}</p>
                  </div>
                </div>
                <div className="flex items-start gap-3">
                  <div className="p-2 rounded-lg bg-amber-100">
                    <Mail className="h-4 w-4 text-amber-700" />
                  </div>
                  <div>
                    <p className="text-sm text-muted-foreground">Email</p>
                    <p className="font-medium">{driverInfo.email || '-'}</p>
                  </div>
                </div>
                <div className="flex items-start gap-3">
                  <div className="p-2 rounded-lg bg-amber-100">
                    <IdCard className="h-4 w-4 text-amber-700" />
                  </div>
                  <div>
                    <p className="text-sm text-muted-foreground">License</p>
                    <p className="font-medium">{driverInfo.licenseClass || '-'} ({driverInfo.licenseState || '-'})</p>
                  </div>
                </div>
                <div className="flex items-start gap-3">
                  <div className="p-2 rounded-lg bg-amber-100">
                    <Calendar className="h-4 w-4 text-amber-700" />
                  </div>
                  <div>
                    <p className="text-sm text-muted-foreground">License Expiration</p>
                    <p className="font-medium">{formatDate(driverInfo.licenseExpiration)}</p>
                  </div>
                </div>
              </div>
            </CardContent>
          </Card>
        )}

        {/* Owner-Operator without driver info - prompt to add */}
        {isOwnerOperator && !driverInfo && (
          <Card className="border-amber-200 bg-amber-50/50">
            <CardHeader>
              <div className="flex items-center gap-2">
                <User className="h-5 w-5 text-amber-600" />
                <CardTitle className="text-amber-900">Owner-Operator Driver</CardTitle>
              </div>
            </CardHeader>
            <CardContent>
              <p className="text-sm text-amber-700 mb-4">
                This carrier is marked as an owner-operator but no driver information has been added yet.
              </p>
              <Button 
                variant="outline" 
                className="border-amber-300 text-amber-700 hover:bg-amber-100"
                onClick={() => router.push(`/operations/carriers/${partnershipId}/edit`)}
              >
                <Edit className="mr-2 h-4 w-4" />
                Add Driver Information
              </Button>
            </CardContent>
          </Card>
        )}

        <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
          {/* Operating Authority */}
          <Card>
            <CardHeader>
              <CardTitle>Operating Authority</CardTitle>
            </CardHeader>
            <CardContent className="space-y-2">
              <div>
                <p className="text-sm text-muted-foreground">MC Number</p>
                <p className="font-medium">{partnership.mcNumber || '-'}</p>
              </div>
              <div>
                <p className="text-sm text-muted-foreground">USDOT Number</p>
                <p className="font-medium">{partnership.usdotNumber || '-'}</p>
              </div>
            </CardContent>
          </Card>

          {/* Contact Information */}
          <Card>
            <CardHeader>
              <CardTitle>Contact Information</CardTitle>
            </CardHeader>
            <CardContent className="space-y-2">
              <div>
                <p className="text-sm text-muted-foreground">Contact Name</p>
                <p className="font-medium">
                  {partnership.contactFirstName || partnership.contactLastName 
                    ? `${partnership.contactFirstName || ''} ${partnership.contactLastName || ''}`.trim()
                    : '-'}
                </p>
              </div>
              <div>
                <p className="text-sm text-muted-foreground">Email</p>
                <p className="font-medium">{partnership.contactEmail || '-'}</p>
              </div>
              <div>
                <p className="text-sm text-muted-foreground">Phone</p>
                <p className="font-medium">{partnership.contactPhone || '-'}</p>
              </div>
            </CardContent>
          </Card>

          {/* Address */}
          <Card>
            <CardHeader>
              <CardTitle>Address</CardTitle>
            </CardHeader>
            <CardContent className="space-y-1">
              {partnership.addressLine ? (
                <>
                  <p className="font-medium">{partnership.addressLine}</p>
                  {partnership.addressLine2 && (
                    <p className="font-medium">{partnership.addressLine2}</p>
                  )}
                  <p className="font-medium">
                    {partnership.city && `${partnership.city}, `}
                    {partnership.state} {partnership.zip}
                  </p>
                  {partnership.country && partnership.country !== 'USA' && (
                    <p className="font-medium">{partnership.country}</p>
                  )}
                </>
              ) : (
                <p className="text-muted-foreground">No address on file</p>
              )}
            </CardContent>
          </Card>

          {/* Insurance */}
          <Card>
            <CardHeader>
              <CardTitle>Insurance</CardTitle>
            </CardHeader>
            <CardContent className="space-y-2">
              <div>
                <p className="text-sm text-muted-foreground">Provider</p>
                <p className="font-medium">{partnership.insuranceProvider || '-'}</p>
              </div>
              <div>
                <p className="text-sm text-muted-foreground">Expiration</p>
                <p className="font-medium">{formatDate(partnership.insuranceExpiration)}</p>
              </div>
              {partnership.insuranceCoverageVerified !== undefined && (
                <div>
                  <p className="text-sm text-muted-foreground">Coverage Verified</p>
                  <Badge variant={partnership.insuranceCoverageVerified ? 'default' : 'secondary'}>
                    {partnership.insuranceCoverageVerified ? 'Verified' : 'Not Verified'}
                  </Badge>
                </div>
              )}
            </CardContent>
          </Card>
        </div>

        {/* Carrier Pay Profiles Section */}
        {organizationId && user && (
          <Card>
            <CardHeader>
              <div className="flex items-center gap-2">
                <DollarSign className="h-5 w-5 text-primary" />
                <CardTitle>Carrier Compensation</CardTitle>
              </div>
            </CardHeader>
            <CardContent>
              <CarrierPaySettingsSection
                carrierPartnershipId={partnershipId}
                organizationId={organizationId}
                userId={user.id}
              />
            </CardContent>
          </Card>
        )}

        {/* Broker Preferences */}
        <Card className="border-primary/20 bg-primary/5">
          <CardHeader>
            <div className="flex items-center gap-2">
              <CardTitle>Your Preferences</CardTitle>
              <span className="text-xs bg-primary/10 text-primary px-2 py-1 rounded">
                Private to Your Org
              </span>
            </div>
          </CardHeader>
          <CardContent className="grid grid-cols-1 md:grid-cols-3 gap-4">
            <div>
              <p className="text-sm text-muted-foreground">Default Payment Terms</p>
              <p className="font-medium">{partnership.defaultPaymentTerms || 'Not Set'}</p>
            </div>
            {partnership.rating && (
              <div>
                <p className="text-sm text-muted-foreground">Your Rating</p>
                <p className="font-medium">{partnership.rating} / 5</p>
              </div>
            )}
            {partnership.preferredLanes && partnership.preferredLanes.length > 0 && (
              <div>
                <p className="text-sm text-muted-foreground">Preferred Lanes</p>
                <p className="font-medium">{partnership.preferredLanes.join(', ')}</p>
              </div>
            )}
            {partnership.internalNotes && (
              <div className="md:col-span-3">
                <p className="text-sm text-muted-foreground">Internal Notes</p>
                <p className="font-medium whitespace-pre-wrap">{partnership.internalNotes}</p>
              </div>
            )}
          </CardContent>
        </Card>
      </div>
    </>
  );
}
