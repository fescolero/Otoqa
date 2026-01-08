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
import { useAuth } from '@workos-inc/authkit-nextjs/components';
import { useQuery } from 'convex/react';
import { api } from '@/convex/_generated/api';
import { useRouter } from 'next/navigation';
import { Edit, ArrowLeft } from 'lucide-react';
import { Id } from '@/convex/_generated/dataModel';

export function CarrierDetailContent({ carrierId }: { carrierId: string }) {
  const { user } = useAuth();
  const router = useRouter();
  const carrierIdTyped = carrierId as Id<'carriers'>;

  // Fetch carrier with sensitive data
  const carrier = useQuery(api.carriers.get, { id: carrierIdTyped, includeSensitive: true });

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

  if (!carrier) {
    return (
      <>
          <div className="flex items-center justify-center h-screen">
            <p className="text-muted-foreground">Loading carrier...</p>
          </div>
        </>
    );
  }

  const formatDate = (dateString: string) => {
    const date = new Date(dateString);
    return date.toLocaleDateString('en-US', { month: 'long', day: 'numeric', year: 'numeric' });
  };

  const formatCurrency = (amount?: number) => {
    if (!amount) return '-';
    return new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD' }).format(amount);
  };

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
                  <BreadcrumbPage>{carrier.companyName}</BreadcrumbPage>
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
                <h1 className="text-3xl font-bold tracking-tight">{carrier.companyName}</h1>
                {carrier.dba && <p className="text-muted-foreground">DBA: {carrier.dba}</p>}
              </div>
              <Badge variant="outline" className="ml-4">
                {carrier.status}
              </Badge>
            </div>
            <Button onClick={() => router.push(`/operations/carriers/${carrierIdTyped}/edit`)}>
              <Edit className="mr-2 h-4 w-4" />
              Edit
            </Button>
          </div>

          <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
            {/* Contact Information */}
            <Card>
              <CardHeader>
                <CardTitle>Contact Information</CardTitle>
              </CardHeader>
              <CardContent className="space-y-2">
                <div>
                  <p className="text-sm text-muted-foreground">Contact Name</p>
                  <p className="font-medium">
                    {carrier.firstName} {carrier.lastName}
                  </p>
                </div>
                <div>
                  <p className="text-sm text-muted-foreground">Email</p>
                  <p className="font-medium">{carrier.email}</p>
                </div>
                <div>
                  <p className="text-sm text-muted-foreground">Phone</p>
                  <p className="font-medium">{carrier.phoneNumber}</p>
                </div>
              </CardContent>
            </Card>

            {/* Address */}
            <Card>
              <CardHeader>
                <CardTitle>Address</CardTitle>
              </CardHeader>
              <CardContent className="space-y-2">
                <p className="font-medium">{carrier.addressLine}</p>
                {carrier.addressLine2 && <p className="font-medium">{carrier.addressLine2}</p>}
                <p className="font-medium">
                  {carrier.city && `${carrier.city}, `}
                  {carrier.state} {carrier.zip}
                </p>
              </CardContent>
            </Card>

            {/* Operating Authority */}
            <Card>
              <CardHeader>
                <CardTitle>Operating Authority</CardTitle>
              </CardHeader>
              <CardContent className="space-y-2">
                <div>
                  <p className="text-sm text-muted-foreground">MC Number</p>
                  <p className="font-medium">{carrier.mcNumber}</p>
                </div>
                <div>
                  <p className="text-sm text-muted-foreground">USDOT Number</p>
                  <p className="font-medium">{carrier.usdotNumber || '-'}</p>
                </div>
                <div>
                  <p className="text-sm text-muted-foreground">Safety Rating</p>
                  <p className="font-medium">{carrier.safetyRating || 'Not Rated'}</p>
                </div>
                <div className="flex gap-4 pt-2">
                  {carrier.dotRegistration && (
                    <Badge variant="outline" className="bg-green-50">
                      DOT Registered
                    </Badge>
                  )}
                  {carrier.operatingAuthorityActive && (
                    <Badge variant="outline" className="bg-green-50">
                      Authority Active
                    </Badge>
                  )}
                </div>
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
                  <p className="font-medium">{carrier.insuranceProvider}</p>
                </div>
                <div>
                  <p className="text-sm text-muted-foreground">Expiration</p>
                  <p className="font-medium">{formatDate(carrier.insuranceExpiration)}</p>
                </div>
                <div>
                  <p className="text-sm text-muted-foreground">Coverage Status</p>
                  <Badge variant={carrier.insuranceCoverage ? 'default' : 'destructive'}>
                    {carrier.insuranceCoverage ? 'Active' : 'Inactive'}
                  </Badge>
                </div>
              </CardContent>
            </Card>

            {/* Financial Information */}
            <Card className="md:col-span-2 border-orange-200 bg-orange-50/50">
              <CardHeader>
                <div className="flex items-center gap-2">
                  <CardTitle>Financial Information</CardTitle>
                  <span className="text-xs bg-orange-100 text-orange-700 px-2 py-1 rounded">
                    Sensitive Data
                  </span>
                </div>
              </CardHeader>
              <CardContent className="grid grid-cols-1 md:grid-cols-3 gap-4">
                <div>
                  <p className="text-sm text-muted-foreground">EIN</p>
                  <p className="font-medium">{(carrier as any).ein || '-'}</p>
                </div>
                <div>
                  <p className="text-sm text-muted-foreground">Cargo Insurance Amount</p>
                  <p className="font-medium">{formatCurrency((carrier as any).insuranceCargoAmount)}</p>
                </div>
                <div>
                  <p className="text-sm text-muted-foreground">Liability Insurance Amount</p>
                  <p className="font-medium">
                    {formatCurrency((carrier as any).insuranceLiabilityAmount)}
                  </p>
                </div>
                <div>
                  <p className="text-sm text-muted-foreground">Payment Terms</p>
                  <p className="font-medium">{(carrier as any).paymentTerms || '-'}</p>
                </div>
                <div>
                  <p className="text-sm text-muted-foreground">Currency</p>
                  <p className="font-medium">{carrier.currency || 'USD'}</p>
                </div>
                <div>
                  <p className="text-sm text-muted-foreground">Factoring Status</p>
                  <Badge variant={(carrier as any).factoringStatus ? 'default' : 'secondary'}>
                    {(carrier as any).factoringStatus ? 'Active' : 'Inactive'}
                  </Badge>
                </div>
                {(carrier as any).remitToAddress && (
                  <div className="md:col-span-3">
                    <p className="text-sm text-muted-foreground">Remit To Address</p>
                    <p className="font-medium">{(carrier as any).remitToAddress}</p>
                  </div>
                )}
              </CardContent>
            </Card>
          </div>
        </div>
      </>
  );
}
