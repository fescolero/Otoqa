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
import { useRouter, useSearchParams } from 'next/navigation';
import { useState } from 'react';
import { useOrganizationId } from '@/contexts/organization-context';
import { useAuthQuery } from '@/hooks/use-auth-query';
import { FuelEntryForm, FuelEntryFormData } from '@/components/diesel/fuel-entry-form';
import { toast } from 'sonner';
import { Id } from '@/convex/_generated/dataModel';
import { Loader2 } from 'lucide-react';
import { Button } from '@/components/ui/button';

export function FuelEntryEditContent({ id }: { id: string }) {
  const { user } = useAuth();
  const router = useRouter();
  const searchParams = useSearchParams();
  const type = searchParams.get('type') === 'def' ? 'def' : 'fuel';
  const organizationId = useOrganizationId();
  const [isSubmitting, setIsSubmitting] = useState(false);

  const fuelEntry = useAuthQuery(
    api.fuelEntries.get,
    type === 'fuel' ? { entryId: id as Id<'fuelEntries'> } : 'skip'
  );
  const defEntry = useAuthQuery(
    api.defEntries.get,
    type === 'def' ? { entryId: id as Id<'defEntries'> } : 'skip'
  );

  const entry = type === 'def' ? defEntry : fuelEntry;

  const drivers = useAuthQuery(api.drivers.list, organizationId ? { organizationId } : 'skip');
  const trucks = useAuthQuery(api.trucks.list, organizationId ? { organizationId } : 'skip');
  const vendors = useAuthQuery(api.fuelVendors.list, organizationId ? { organizationId, activeOnly: true } : 'skip');
  const carriersRaw = useAuthQuery(api.carrierPartnerships.listForBroker, organizationId ? { brokerOrgId: organizationId } : 'skip');

  const carriers = (carriersRaw ?? []).map((c) => ({
    _id: c._id,
    carrierName: c.carrierName,
    trackFuelConsumption: c.trackFuelConsumption ?? false,
  }));

  const updateFuelEntry = useMutation(api.fuelEntries.update);
  const updateDefEntry = useMutation(api.defEntries.update);
  const generateUploadUrl = useMutation(
    type === 'def' ? api.defEntries.generateUploadUrl : api.fuelEntries.generateUploadUrl
  );

  const typeLabel = type === 'def' ? 'DEF' : 'Fuel';

  const handleSubmit = async (data: FuelEntryFormData) => {
    if (!user) return;

    setIsSubmitting(true);
    try {
      const baseArgs = {
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
        ...(data.paymentMethod && { paymentMethod: data.paymentMethod as 'FUEL_CARD' | 'CASH' | 'CHECK' | 'CREDIT_CARD' | 'EFS' | 'COMDATA' }),
        ...(data.notes && { notes: data.notes }),
        ...(data.receiptStorageId && { receiptStorageId: data.receiptStorageId as Id<'_storage'> }),
        updatedBy: user.id,
      };

      if (type === 'def') {
        await updateDefEntry({
          entryId: id as Id<'defEntries'>,
          ...baseArgs,
        });
      } else {
        await updateFuelEntry({
          entryId: id as Id<'fuelEntries'>,
          ...baseArgs,
        });
      }

      toast.success(`${typeLabel} entry updated successfully`);
      router.push(`/operations/diesel/${id}?type=${type}`);
    } catch (error) {
      console.error(`Failed to update ${typeLabel} entry:`, error);
      toast.error(`Failed to update ${typeLabel} entry. Please try again.`);
    } finally {
      setIsSubmitting(false);
    }
  };

  if (entry === undefined) {
    return (
      <div className="flex items-center justify-center h-screen">
        <Loader2 className="h-8 w-8 animate-spin text-muted-foreground" />
      </div>
    );
  }

  if (entry === null) {
    return (
      <div className="flex items-center justify-center h-screen">
        <div className="text-center">
          <p className="text-muted-foreground mb-4">{typeLabel} entry not found</p>
          <Button onClick={() => router.push('/operations/diesel')}>Back to Diesel</Button>
        </div>
      </div>
    );
  }

  const initialData = {
    entryDate: entry.entryDate,
    driverId: entry.driverId ?? undefined,
    carrierId: entry.carrierId ?? undefined,
    truckId: entry.truckId ?? undefined,
    vendorId: entry.vendorId,
    gallons: entry.gallons,
    pricePerGallon: entry.pricePerGallon,
    odometerReading: entry.odometerReading ?? undefined,
    location: entry.location ?? undefined,
    fuelCardNumber: entry.fuelCardNumber ?? undefined,
    receiptNumber: entry.receiptNumber ?? undefined,
    loadId: entry.loadId ?? undefined,
    paymentMethod: entry.paymentMethod ?? undefined,
    notes: entry.notes ?? undefined,
    receiptStorageId: entry.receiptStorageId ?? undefined,
    receiptUrl: entry.receiptUrl ?? undefined,
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
              <BreadcrumbItem className="hidden md:block">
                <BreadcrumbLink href={`/operations/diesel/${id}?type=${type}`}>
                  Entry Detail
                </BreadcrumbLink>
              </BreadcrumbItem>
              <BreadcrumbSeparator className="hidden md:block" />
              <BreadcrumbItem>
                <BreadcrumbPage>Edit</BreadcrumbPage>
              </BreadcrumbItem>
            </BreadcrumbList>
          </Breadcrumb>
        </div>
      </header>

      <div className="flex flex-1 flex-col gap-6 p-6">
        <FuelEntryForm
          entryType={type}
          initialData={initialData}
          drivers={drivers ?? []}
          carriers={carriers}
          trucks={trucks ?? []}
          vendors={vendors ?? []}
          onSubmit={handleSubmit}
          onCancel={() => router.push(`/operations/diesel/${id}?type=${type}`)}
          isSubmitting={isSubmitting}
          generateUploadUrl={generateUploadUrl}
        />
      </div>
    </>
  );
}
