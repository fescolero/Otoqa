'use client';

import {
  Breadcrumb,
  BreadcrumbItem,
  BreadcrumbLink,
  BreadcrumbList,
  BreadcrumbPage,
  BreadcrumbSeparator,
} from '@/components/ui/breadcrumb';
import { Separator } from '@/components/ui/separator';
import { SidebarTrigger } from '@/components/ui/sidebar';
import { useAuth } from '@workos-inc/authkit-nextjs/components';
import { useMutation } from 'convex/react';
import { api } from '@/convex/_generated/api';
import { useRouter } from 'next/navigation';
import { useState } from 'react';
import { useOrganizationId } from '@/contexts/organization-context';
import { useAuthQuery } from '@/hooks/use-auth-query';
import { FuelEntryForm, FuelEntryFormData } from '@/components/diesel/fuel-entry-form';
import { toast } from 'sonner';
import { Id } from '@/convex/_generated/dataModel';

export default function CreateDefEntryPage() {
  const { user } = useAuth();
  const router = useRouter();
  const organizationId = useOrganizationId();
  const createDefEntry = useMutation(api.defEntries.create);
  const generateUploadUrl = useMutation(api.defEntries.generateUploadUrl);
  const [isSubmitting, setIsSubmitting] = useState(false);

  const drivers = useAuthQuery(api.drivers.list, organizationId ? { organizationId } : 'skip');
  const trucks = useAuthQuery(api.trucks.list, organizationId ? { organizationId } : 'skip');
  const vendors = useAuthQuery(api.fuelVendors.list, organizationId ? { organizationId, activeOnly: true } : 'skip');
  const carriersRaw = useAuthQuery(
    api.carrierPartnerships.listForBroker,
    organizationId ? { brokerOrgId: organizationId } : 'skip',
  );

  const carriers = (carriersRaw ?? []).map((c) => ({
    _id: c._id,
    carrierName: c.carrierName,
    trackFuelConsumption: c.trackFuelConsumption ?? false,
  }));

  const handleSubmit = async (data: FuelEntryFormData, options?: { continueAdding?: boolean }) => {
    if (!organizationId || !user) return;

    setIsSubmitting(true);
    try {
      await createDefEntry({
        organizationId,
        entryDate: data.entryDate,
        vendorId: data.vendorId as Id<'fuelVendors'>,
        gallons: data.gallons,
        pricePerGallon: data.pricePerGallon,
        ...(data.driverId && { driverId: data.driverId as Id<'drivers'> }),
        ...(data.carrierId && { carrierId: data.carrierId as Id<'carrierPartnerships'> }),
        ...(data.truckId && { truckId: data.truckId as Id<'trucks'> }),
        ...(data.odometerReading && { odometerReading: data.odometerReading }),
        ...(data.location && { location: data.location }),
        ...(data.fuelCardNumber && { fuelCardNumber: data.fuelCardNumber }),
        ...(data.receiptNumber && { receiptNumber: data.receiptNumber }),
        ...(data.loadId && { loadId: data.loadId as Id<'loadInformation'> }),
        ...(data.paymentMethod && {
          paymentMethod: data.paymentMethod as 'FUEL_CARD' | 'CASH' | 'CHECK' | 'CREDIT_CARD' | 'EFS' | 'COMDATA',
        }),
        ...(data.notes && { notes: data.notes }),
        ...(data.receiptStorageId && { receiptStorageId: data.receiptStorageId as Id<'_storage'> }),
        createdBy: user.id,
      });

      toast.success(
        options?.continueAdding ? 'DEF entry created. Ready for the next one.' : 'DEF entry created successfully',
      );

      if (!options?.continueAdding) {
        router.push('/operations/diesel');
      }
    } catch (error) {
      console.error('Failed to create DEF entry:', error);
      toast.error('Failed to create DEF entry. Please try again.');
    } finally {
      setIsSubmitting(false);
    }
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
                <BreadcrumbLink href="/dashboard">Home</BreadcrumbLink>
              </BreadcrumbItem>
              <BreadcrumbSeparator className="hidden md:block" />
              <BreadcrumbItem className="hidden md:block">
                <BreadcrumbLink href="#">Company Operations</BreadcrumbLink>
              </BreadcrumbItem>
              <BreadcrumbSeparator className="hidden md:block" />
              <BreadcrumbItem className="hidden md:block">
                <BreadcrumbLink href="/operations/diesel">Diesel</BreadcrumbLink>
              </BreadcrumbItem>
              <BreadcrumbSeparator className="hidden md:block" />
              <BreadcrumbItem>
                <BreadcrumbPage>New DEF Entry</BreadcrumbPage>
              </BreadcrumbItem>
            </BreadcrumbList>
          </Breadcrumb>
        </div>
      </header>

      <div className="flex flex-1 flex-col gap-6 p-6">
        <FuelEntryForm
          entryType="def"
          drivers={drivers ?? []}
          carriers={carriers}
          trucks={trucks ?? []}
          vendors={vendors ?? []}
          onSubmit={handleSubmit}
          onCancel={() => router.push('/operations/diesel')}
          isSubmitting={isSubmitting}
          generateUploadUrl={generateUploadUrl}
        />
      </div>
    </>
  );
}
