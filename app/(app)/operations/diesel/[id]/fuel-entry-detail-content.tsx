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
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogTrigger,
} from '@/components/ui/alert-dialog';
import { useAuth } from '@workos-inc/authkit-nextjs/components';
import { useMutation } from 'convex/react';
import { api } from '@/convex/_generated/api';
import { useRouter, useSearchParams } from 'next/navigation';
import { useAuthQuery } from '@/hooks/use-auth-query';
import { ArrowLeft, Edit, Trash2, Loader2 } from 'lucide-react';
import { format } from 'date-fns';
import { toast } from 'sonner';
import { Id } from '@/convex/_generated/dataModel';
import { useState } from 'react';
import Link from 'next/link';

function DetailRow({ label, value }: { label: string; value?: string | number | null }) {
  return (
    <div className="space-y-1">
      <p className="text-sm font-medium text-muted-foreground">{label}</p>
      <p className="text-sm">{value ?? '—'}</p>
    </div>
  );
}

export function FuelEntryDetailContent({ id }: { id: string }) {
  const { user } = useAuth();
  const router = useRouter();
  const searchParams = useSearchParams();
  const type = searchParams.get('type') === 'def' ? 'def' : 'fuel';
  const [isDeleting, setIsDeleting] = useState(false);

  const fuelEntry = useAuthQuery(
    api.fuelEntries.get,
    type === 'fuel' ? { entryId: id as Id<'fuelEntries'> } : 'skip'
  );
  const defEntry = useAuthQuery(
    api.defEntries.get,
    type === 'def' ? { entryId: id as Id<'defEntries'> } : 'skip'
  );

  const entry = type === 'def' ? defEntry : fuelEntry;

  const removeFuelEntry = useMutation(api.fuelEntries.remove);
  const removeDefEntry = useMutation(api.defEntries.remove);

  const typeLabel = type === 'def' ? 'DEF' : 'Fuel';

  const handleDelete = async () => {
    if (!user) return;
    setIsDeleting(true);
    try {
      if (type === 'def') {
        await removeDefEntry({ entryId: id as Id<'defEntries'>, deletedBy: user.id });
      } else {
        await removeFuelEntry({ entryId: id as Id<'fuelEntries'>, deletedBy: user.id });
      }
      toast.success(`${typeLabel} entry deleted successfully`);
      router.push('/operations/diesel');
    } catch (error) {
      console.error(`Failed to delete ${typeLabel} entry:`, error);
      toast.error(`Failed to delete ${typeLabel} entry. Please try again.`);
    } finally {
      setIsDeleting(false);
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
                <BreadcrumbPage>Entry Detail</BreadcrumbPage>
              </BreadcrumbItem>
            </BreadcrumbList>
          </Breadcrumb>
        </div>
      </header>

      <div className="flex flex-1 flex-col gap-6 p-6">
        <div className="flex items-center gap-2">
          <Button variant="ghost" size="sm" asChild>
            <Link href="/operations/diesel">
              <ArrowLeft className="mr-1 h-4 w-4" />
              Back
            </Link>
          </Button>
        </div>

        <div className="flex items-center justify-between">
          <div className="flex items-center gap-3">
            <h1 className="text-3xl font-bold tracking-tight">{typeLabel} Entry</h1>
            <Badge variant={type === 'def' ? 'secondary' : 'default'}>
              {typeLabel}
            </Badge>
          </div>
          <div className="flex items-center gap-2">
            <Button variant="outline" asChild>
              <Link href={`/operations/diesel/${id}/edit?type=${type}`}>
                <Edit className="mr-2 h-4 w-4" />
                Edit
              </Link>
            </Button>
            <AlertDialog>
              <AlertDialogTrigger asChild>
                <Button variant="destructive" disabled={isDeleting}>
                  {isDeleting ? (
                    <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                  ) : (
                    <Trash2 className="mr-2 h-4 w-4" />
                  )}
                  Delete
                </Button>
              </AlertDialogTrigger>
              <AlertDialogContent>
                <AlertDialogHeader>
                  <AlertDialogTitle>Delete {typeLabel} Entry</AlertDialogTitle>
                  <AlertDialogDescription>
                    Are you sure you want to delete this {typeLabel.toLowerCase()} entry? This action
                    cannot be undone.
                  </AlertDialogDescription>
                </AlertDialogHeader>
                <AlertDialogFooter>
                  <AlertDialogCancel>Cancel</AlertDialogCancel>
                  <AlertDialogAction onClick={handleDelete}>Delete</AlertDialogAction>
                </AlertDialogFooter>
              </AlertDialogContent>
            </AlertDialog>
          </div>
        </div>

        {/* Card 1: Purchase Information */}
        <Card className="p-6 shadow-sm">
          <h2 className="text-xl font-semibold mb-4">Purchase Information</h2>
          <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-5 gap-6">
            <DetailRow
              label="Date"
              value={entry.entryDate ? format(new Date(entry.entryDate), 'MMM d, yyyy') : undefined}
            />
            <DetailRow label="Vendor" value={entry.vendorName} />
            <DetailRow
              label="Gallons"
              value={entry.gallons?.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 3 })}
            />
            <DetailRow
              label="Price/Gal"
              value={entry.pricePerGallon != null ? `$${entry.pricePerGallon.toFixed(3)}` : undefined}
            />
            <DetailRow
              label="Total Cost"
              value={entry.totalCost != null ? `$${entry.totalCost.toFixed(2)}` : undefined}
            />
          </div>
        </Card>

        {/* Card 2: Assignment */}
        <Card className="p-6 shadow-sm">
          <h2 className="text-xl font-semibold mb-4">Assignment</h2>
          <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-6">
            <DetailRow label="Driver" value={entry.driverName} />
            <DetailRow label="Carrier" value={entry.carrierName} />
            <DetailRow label="Truck" value={entry.truckUnitId} />
            <DetailRow label="Load Reference" value={entry.loadReference ?? entry.loadId} />
          </div>
        </Card>

        {/* Card 3: Details */}
        <Card className="p-6 shadow-sm">
          <h2 className="text-xl font-semibold mb-4">Details</h2>
          <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-6">
            <DetailRow
              label="Odometer"
              value={entry.odometerReading?.toLocaleString()}
            />
            <DetailRow
              label="Location"
              value={
                entry.location
                  ? [entry.location.city, entry.location.state].filter(Boolean).join(', ')
                  : undefined
              }
            />
            <DetailRow label="Fuel Card #" value={entry.fuelCardNumber} />
            <DetailRow label="Receipt #" value={entry.receiptNumber} />
            <DetailRow label="Payment Method" value={entry.paymentMethod?.replace(/_/g, ' ')} />
          </div>
        </Card>

        {/* Card 4: Notes */}
        <Card className="p-6 shadow-sm">
          <h2 className="text-xl font-semibold mb-4">Notes</h2>
          <p className="text-sm whitespace-pre-wrap">{entry.notes || '—'}</p>
        </Card>

        {/* Card 5: Receipt */}
        <Card className="p-6 shadow-sm">
          <h2 className="text-xl font-semibold mb-4">Receipt</h2>
          {entry.receiptUrl ? (
            <img
              src={entry.receiptUrl}
              alt="Receipt"
              className="max-h-96 rounded-md border object-contain"
            />
          ) : (
            <p className="text-sm text-muted-foreground">No receipt uploaded</p>
          )}
        </Card>
      </div>
    </>
  );
}
