'use client';

import { Breadcrumb, BreadcrumbItem, BreadcrumbLink, BreadcrumbList, BreadcrumbPage, BreadcrumbSeparator } from '@/components/ui/breadcrumb';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Separator } from '@/components/ui/separator';
import { SidebarTrigger } from '@/components/ui/sidebar';
import { Badge } from '@/components/ui/badge';
import { useAuth } from '@workos-inc/authkit-nextjs/components';
import { useQuery } from 'convex/react';
import { api } from '@/convex/_generated/api';
import { useRouter } from 'next/navigation';
import { Edit, ArrowLeft, FileText } from 'lucide-react';
import { Id } from '@/convex/_generated/dataModel';

export function CustomerDetailContent({ customerId }: { customerId: string }) {
  const { user } = useAuth();
  const router = useRouter();
  const customerIdTyped = customerId as Id<'customers'>;
  
  const customer = useQuery(api.customers.get, { id: customerIdTyped });

  const getUserInitials = (name?: string, email?: string) => {
    if (name) {
      const names = name.split(' ');
      if (names.length >= 2) return `${names[0][0]}${names[1][0]}`.toUpperCase();
      return name.slice(0, 2).toUpperCase();
    }
    if (email) return email.slice(0, 2).toUpperCase();
    return 'U';
  };

  const userData = user
    ? {
        name: user.firstName && user.lastName ? `${user.firstName} ${user.lastName}` : user.email,
        email: user.email,
        avatar: user.profilePictureUrl || '',
        initials: getUserInitials(user.firstName && user.lastName ? `${user.firstName} ${user.lastName}` : undefined, user.email),
      }
    : { name: 'Guest', email: 'guest@example.com', avatar: '', initials: 'GU' };

  if (!customer) {
    return (
      <>
          <div className="flex items-center justify-center h-screen">
            <p className="text-muted-foreground">Loading customer...</p>
          </div>
        </>
    );
  }

  return (
    <>
        <header className="sticky top-0 z-40 flex h-16 shrink-0 items-center gap-2 border-b bg-background">
          <div className="flex items-center gap-2 px-4">
            <SidebarTrigger className="-ml-1" />
            <Separator orientation="vertical" className="mr-2 data-[orientation=vertical]:h-4" />
            <Breadcrumb>
              <BreadcrumbList>
                <BreadcrumbItem className="hidden md:block"><BreadcrumbLink href="/dashboard">Dashboard</BreadcrumbLink></BreadcrumbItem>
                <BreadcrumbSeparator className="hidden md:block" />
                <BreadcrumbItem className="hidden md:block"><BreadcrumbLink href="#">Company Operations</BreadcrumbLink></BreadcrumbItem>
                <BreadcrumbSeparator className="hidden md:block" />
                <BreadcrumbItem className="hidden md:block"><BreadcrumbLink href="/operations/customers">Customers</BreadcrumbLink></BreadcrumbItem>
                <BreadcrumbSeparator className="hidden md:block" />
                <BreadcrumbItem><BreadcrumbPage>{customer.name}</BreadcrumbPage></BreadcrumbItem>
              </BreadcrumbList>
            </Breadcrumb>
          </div>
        </header>

        <div className="flex flex-1 flex-col gap-6 p-6">
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-4">
              <Button variant="outline" size="icon" onClick={() => router.push('/operations/customers')}><ArrowLeft className="h-4 w-4" /></Button>
              <div>
                <h1 className="text-3xl font-bold tracking-tight">{customer.name}</h1>
                {customer.office && <p className="text-muted-foreground">Office: {customer.office}</p>}
              </div>
              <Badge variant="outline" className="ml-4">{customer.status}</Badge>
            </div>
            <div className="flex gap-2">
              <Button variant="outline" onClick={() => router.push(`/operations/customers/${customerIdTyped}/contract-lanes`)}><FileText className="mr-2 h-4 w-4" />Contract Lanes</Button>
              <Button onClick={() => router.push(`/operations/customers/${customerIdTyped}/edit`)}><Edit className="mr-2 h-4 w-4" />Edit</Button>
            </div>
          </div>

          <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
            <Card><CardHeader><CardTitle>Customer Information</CardTitle></CardHeader><CardContent className="space-y-2"><div><p className="text-sm text-muted-foreground">Company Type</p><p className="font-medium">{customer.companyType}</p></div><div><p className="text-sm text-muted-foreground">Status</p><p className="font-medium">{customer.status}</p></div></CardContent></Card>
            <Card><CardHeader><CardTitle>Address</CardTitle></CardHeader><CardContent className="space-y-2"><p className="font-medium">{customer.addressLine1}</p>{customer.addressLine2 && <p className="font-medium">{customer.addressLine2}</p>}<p className="font-medium">{customer.city}, {customer.state} {customer.zip}</p><p className="font-medium">{customer.country}</p></CardContent></Card>
            <Card><CardHeader><CardTitle>Primary Contact</CardTitle></CardHeader><CardContent className="space-y-2">{customer.primaryContactName ? <><div><p className="text-sm text-muted-foreground">Name</p><p className="font-medium">{customer.primaryContactName}</p></div>{customer.primaryContactTitle && <div><p className="text-sm text-muted-foreground">Title</p><p className="font-medium">{customer.primaryContactTitle}</p></div>}{customer.primaryContactEmail && <div><p className="text-sm text-muted-foreground">Email</p><p className="font-medium">{customer.primaryContactEmail}</p></div>}{customer.primaryContactPhone && <div><p className="text-sm text-muted-foreground">Phone</p><p className="font-medium">{customer.primaryContactPhone}</p></div>}</> : <p className="text-muted-foreground">No primary contact</p>}</CardContent></Card>
            {(customer.secondaryContactName || customer.secondaryContactEmail || customer.secondaryContactPhone) && <Card><CardHeader><CardTitle>Secondary Contact</CardTitle></CardHeader><CardContent className="space-y-2">{customer.secondaryContactName && <div><p className="text-sm text-muted-foreground">Name</p><p className="font-medium">{customer.secondaryContactName}</p></div>}{customer.secondaryContactEmail && <div><p className="text-sm text-muted-foreground">Email</p><p className="font-medium">{customer.secondaryContactEmail}</p></div>}{customer.secondaryContactPhone && <div><p className="text-sm text-muted-foreground">Phone</p><p className="font-medium">{customer.secondaryContactPhone}</p></div>}</CardContent></Card>}
            <Card><CardHeader><CardTitle>Operations</CardTitle></CardHeader><CardContent className="space-y-2">{customer.loadingType && <div><p className="text-sm text-muted-foreground">Loading Type</p><p className="font-medium">{customer.loadingType}</p></div>}{customer.locationScheduleType && <div><p className="text-sm text-muted-foreground">Schedule</p><p className="font-medium">{customer.locationScheduleType}</p></div>}{customer.instructions && <div><p className="text-sm text-muted-foreground">Instructions</p><p className="font-medium">{customer.instructions}</p></div>}</CardContent></Card>
            {customer.internalNotes && <Card><CardHeader><CardTitle>Internal Notes</CardTitle></CardHeader><CardContent><p className="font-medium">{customer.internalNotes}</p></CardContent></Card>}
          </div>
        </div>
      </>
  );
}
