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
import { Badge } from '@/components/ui/badge';
import { Separator } from '@/components/ui/separator';
import { SidebarTrigger } from '@/components/ui/sidebar';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import { useAuth } from '@workos-inc/authkit-nextjs/components';
import { useMutation } from 'convex/react';
import { api } from '@/convex/_generated/api';
import { useRouter } from 'next/navigation';
import { useOrganizationId } from '@/contexts/organization-context';
import { useAuthQuery } from '@/hooks/use-auth-query';
import { Plus, Power, PowerOff } from 'lucide-react';
import { toast } from 'sonner';

export default function FuelVendorsPage() {
  const { user } = useAuth();
  const router = useRouter();
  const workosOrgId = useOrganizationId();

  const vendors = useAuthQuery(
    api.fuelVendors.list,
    workosOrgId ? { organizationId: workosOrgId } : 'skip'
  );

  const toggleActive = useMutation(api.fuelVendors.toggleActive);

  const handleToggleActive = async (
    e: React.MouseEvent,
    vendorId: string,
    vendorName: string,
    currentlyActive: boolean
  ) => {
    e.stopPropagation();
    if (!user) return;

    try {
      await toggleActive({
        vendorId: vendorId as import('@/convex/_generated/dataModel').Id<'fuelVendors'>,
        updatedBy: user.id,
      });
      toast.success(
        `${vendorName} ${currentlyActive ? 'deactivated' : 'activated'} successfully`
      );
    } catch (error) {
      console.error('Failed to toggle vendor status:', error);
      toast.error('Failed to update vendor status');
    }
  };

  return (
    <>
      <header className="flex h-16 shrink-0 items-center gap-2 transition-[width,height] ease-linear group-has-data-[collapsible=icon]/sidebar-wrapper:h-12 border-b">
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
              <BreadcrumbItem>
                <BreadcrumbPage>Fuel Vendors</BreadcrumbPage>
              </BreadcrumbItem>
            </BreadcrumbList>
          </Breadcrumb>
        </div>
      </header>

      <div className="flex-1 overflow-hidden">
        <div className="h-full flex flex-col p-6">
          <div className="flex-shrink-0 flex items-center justify-between mb-4">
            <div>
              <h1 className="text-3xl font-bold tracking-tight">Fuel Vendors</h1>
              <p className="text-muted-foreground">
                Manage fuel vendors and discount programs
              </p>
            </div>
            <div className="flex items-center gap-2">
              <Button
                size="sm"
                onClick={() => router.push('/operations/diesel/vendors/create')}
              >
                <Plus className="mr-2 h-4 w-4" />
                Create Vendor
              </Button>
            </div>
          </div>

          <div className="flex-1 overflow-auto rounded-md border">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Name</TableHead>
                  <TableHead>Code</TableHead>
                  <TableHead>Account Number</TableHead>
                  <TableHead>Discount Program</TableHead>
                  <TableHead>Contact</TableHead>
                  <TableHead>Status</TableHead>
                  <TableHead className="w-[80px]" />
                </TableRow>
              </TableHeader>
              <TableBody>
                {!vendors ? (
                  <TableRow>
                    <TableCell colSpan={7} className="text-center py-8 text-muted-foreground">
                      Loading vendors...
                    </TableCell>
                  </TableRow>
                ) : vendors.length === 0 ? (
                  <TableRow>
                    <TableCell colSpan={7} className="text-center py-8 text-muted-foreground">
                      No fuel vendors yet. Create your first vendor to get started.
                    </TableCell>
                  </TableRow>
                ) : (
                  vendors.map((vendor) => (
                    <TableRow
                      key={vendor._id}
                      className="cursor-pointer"
                      onClick={() =>
                        router.push(`/operations/diesel/vendors/${vendor._id}/edit`)
                      }
                    >
                      <TableCell className="font-medium">{vendor.name}</TableCell>
                      <TableCell>{vendor.code || '—'}</TableCell>
                      <TableCell>{vendor.accountNumber || '—'}</TableCell>
                      <TableCell>{vendor.discountProgram || '—'}</TableCell>
                      <TableCell>
                        {vendor.contactName || vendor.contactEmail
                          ? `${vendor.contactName || ''}${vendor.contactName && vendor.contactEmail ? ' · ' : ''}${vendor.contactEmail || ''}`
                          : '—'}
                      </TableCell>
                      <TableCell>
                        <Badge variant={vendor.isActive ? 'default' : 'secondary'}>
                          {vendor.isActive ? 'Active' : 'Inactive'}
                        </Badge>
                      </TableCell>
                      <TableCell>
                        <Button
                          variant="ghost"
                          size="icon"
                          className="h-8 w-8"
                          title={vendor.isActive ? 'Deactivate' : 'Activate'}
                          onClick={(e) =>
                            handleToggleActive(
                              e,
                              vendor._id,
                              vendor.name,
                              vendor.isActive
                            )
                          }
                        >
                          {vendor.isActive ? (
                            <PowerOff className="h-4 w-4 text-muted-foreground" />
                          ) : (
                            <Power className="h-4 w-4 text-muted-foreground" />
                          )}
                        </Button>
                      </TableCell>
                    </TableRow>
                  ))
                )}
              </TableBody>
            </Table>
          </div>
        </div>
      </div>
    </>
  );
}
