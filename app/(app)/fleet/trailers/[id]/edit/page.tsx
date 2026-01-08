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
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Separator } from '@/components/ui/separator';
import { SidebarTrigger } from '@/components/ui/sidebar';
import { Textarea } from '@/components/ui/textarea';
import { useAuth } from '@workos-inc/authkit-nextjs/components';
import { useMutation, useQuery } from 'convex/react';
import { api } from '@/convex/_generated/api';
import { useRouter } from 'next/navigation';
import { useState, FormEvent } from 'react';
import { Loader2 } from 'lucide-react';
import { DatePicker } from '@/components/ui/date-picker';
import { NumberInput } from '@/components/ui/number-input';
import { Id } from '@/convex/_generated/dataModel';
import { use } from 'react';

export default function EditTrailerPage({ params }: { params: Promise<{ id: string }> }) {
  const { user } = useAuth();
  const router = useRouter();
  const { id } = use(params);
  const updateTrailer = useMutation(api.trailers.update);
  const trailer = useQuery(api.trailers.get, { id: id as Id<'trailers'> });
  const [isSubmitting, setIsSubmitting] = useState(false);

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

  const handleSubmit = async (e: FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    if (!user || !trailer) return;

    setIsSubmitting(true);

    try {
      const formData = new FormData(e.currentTarget);

      const yearStr = formData.get('year') as string;
      const gvwrStr = formData.get('gvwr') as string;
      const purchasePriceStr = formData.get('purchasePrice') as string;
      const userName = user.firstName && user.lastName ? `${user.firstName} ${user.lastName}` : user.email;

      await updateTrailer({
        id: trailer._id,
        // Identity
        unitId: formData.get('unitId') as string,
        vin: formData.get('vin') as string,
        plate: (formData.get('plate') as string) || undefined,
        make: (formData.get('make') as string) || undefined,
        model: (formData.get('model') as string) || undefined,
        year: yearStr ? parseInt(yearStr, 10) : undefined,
        status: formData.get('status') as string,
        // Specifications
        size: (formData.get('size') as string) || undefined,
        bodyType: (formData.get('bodyType') as string) || undefined,
        gvwr: gvwrStr ? parseFloat(gvwrStr) : undefined,
        // Registration & Compliance
        registrationExpiration: (formData.get('registrationExpiration') as string) || undefined,
        comments: (formData.get('comments') as string) || undefined,
        // Insurance
        insuranceFirm: (formData.get('insuranceFirm') as string) || undefined,
        insurancePolicyNumber: (formData.get('insurancePolicyNumber') as string) || undefined,
        insuranceExpiration: (formData.get('insuranceExpiration') as string) || undefined,
        insuranceComments: (formData.get('insuranceComments') as string) || undefined,
        // Financial
        purchaseDate: (formData.get('purchaseDate') as string) || undefined,
        purchasePrice: purchasePriceStr ? parseFloat(purchasePriceStr) : undefined,
        ownershipType: (formData.get('ownershipType') as string) || undefined,
        lienholder: (formData.get('lienholder') as string) || undefined,
        // Audit
        userId: user.id,
        userName,
        organizationId: trailer.organizationId,
      });

      router.push('/fleet/trailers');
    } catch (error) {
      console.error('Failed to update trailer:', error);
      alert('Failed to update trailer. Please try again.');
    } finally {
      setIsSubmitting(false);
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
                  <BreadcrumbPage>Edit Trailer</BreadcrumbPage>
                </BreadcrumbItem>
              </BreadcrumbList>
            </Breadcrumb>
          </div>
        </header>

        <div className="flex flex-1 flex-col gap-6 p-4 md:p-6 pb-24">
          {/* Page Header */}
          <div className="flex items-center justify-between">
            <div>
              <h1 className="text-3xl font-bold tracking-tight">Edit Trailer</h1>
              <p className="text-muted-foreground">Update trailer information</p>
            </div>
          </div>

          <form key={trailer._id} id="trailer-form" onSubmit={handleSubmit}>
            {/* Identity */}
            <Card className="p-6 mb-6">
              <h2 className="text-xl font-semibold mb-4">Trailer Identity</h2>
              <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
                <div className="space-y-2">
                  <Label htmlFor="unitId">
                    Unit ID <span className="text-destructive">*</span>
                  </Label>
                  <Input id="unitId" name="unitId" defaultValue={trailer.unitId} required />
                </div>
                <div className="space-y-2">
                  <Label htmlFor="vin">
                    VIN <span className="text-destructive">*</span>
                  </Label>
                  <Input id="vin" name="vin" maxLength={17} className="font-mono" defaultValue={trailer.vin} required />
                </div>
                <div className="space-y-2">
                  <Label htmlFor="status">
                    Status <span className="text-destructive">*</span>
                  </Label>
                  <Select name="status" defaultValue={trailer.status} required>
                    <SelectTrigger id="status" className="w-full">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="Active">Active</SelectItem>
                      <SelectItem value="Out of Service">Out of Service</SelectItem>
                      <SelectItem value="In Repair">In Repair</SelectItem>
                      <SelectItem value="Maintenance">Maintenance</SelectItem>
                      <SelectItem value="Sold">Sold</SelectItem>
                      <SelectItem value="Lost">Lost</SelectItem>
                    </SelectContent>
                  </Select>
                </div>
                <div className="space-y-2">
                  <Label htmlFor="plate">License Plate</Label>
                  <Input id="plate" name="plate" defaultValue={trailer.plate} />
                </div>
                <div className="space-y-2">
                  <Label htmlFor="year">Year</Label>
                  <Input id="year" name="year" type="number" placeholder="2024" defaultValue={trailer.year} />
                </div>
                <div className="space-y-2">
                  <Label htmlFor="make">Make</Label>
                  <Input id="make" name="make" placeholder="Utility" defaultValue={trailer.make} />
                </div>
                <div className="space-y-2">
                  <Label htmlFor="model">Model</Label>
                  <Input id="model" name="model" placeholder="3000R" defaultValue={trailer.model} />
                </div>
              </div>
            </Card>

            {/* Specifications */}
            <Card className="p-6 mb-6">
              <h2 className="text-xl font-semibold mb-4">Specifications</h2>
              <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
                <div className="space-y-2">
                  <Label htmlFor="size">Size</Label>
                  <Select name="size" defaultValue={trailer.size}>
                    <SelectTrigger id="size" className="w-full">
                      <SelectValue placeholder="Select size..." />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="53ft">53ft</SelectItem>
                      <SelectItem value="48ft">48ft</SelectItem>
                      <SelectItem value="40ft">40ft</SelectItem>
                      <SelectItem value="28ft">28ft</SelectItem>
                      <SelectItem value="20ft">20ft</SelectItem>
                    </SelectContent>
                  </Select>
                </div>
                <div className="space-y-2">
                  <Label htmlFor="bodyType">Body Type</Label>
                  <Select name="bodyType" defaultValue={trailer.bodyType}>
                    <SelectTrigger id="bodyType" className="w-full">
                      <SelectValue placeholder="Select type..." />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="Dry Van">Dry Van</SelectItem>
                      <SelectItem value="Refrigerated">Refrigerated</SelectItem>
                      <SelectItem value="Flatbed">Flatbed</SelectItem>
                      <SelectItem value="Tanker">Tanker</SelectItem>
                      <SelectItem value="Lowboy">Lowboy</SelectItem>
                      <SelectItem value="Step Deck">Step Deck</SelectItem>
                    </SelectContent>
                  </Select>
                </div>
                <div className="space-y-2">
                  <Label htmlFor="gvwr">GVWR</Label>
                  <NumberInput id="gvwr" name="gvwr" placeholder="80,000" defaultValue={trailer.gvwr} />
                </div>
              </div>
            </Card>

            {/* Registration & Compliance */}
            <Card className="p-6 mb-6">
              <h2 className="text-xl font-semibold mb-4">Registration & Compliance</h2>
              <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                <div className="space-y-2">
                  <Label htmlFor="registrationExpiration">Registration Expiration</Label>
                  <DatePicker id="registrationExpiration" name="registrationExpiration" defaultValue={trailer.registrationExpiration} />
                </div>
                <div className="space-y-2 md:col-span-2">
                  <Label htmlFor="comments">Comments</Label>
                  <Textarea id="comments" name="comments" rows={3} defaultValue={trailer.comments} />
                </div>
              </div>
            </Card>

            {/* Insurance */}
            <Card className="p-6 mb-6">
              <h2 className="text-xl font-semibold mb-4">Insurance</h2>
              <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
                <div className="space-y-2">
                  <Label htmlFor="insuranceFirm">Insurance Firm</Label>
                  <Input id="insuranceFirm" name="insuranceFirm" defaultValue={trailer.insuranceFirm} />
                </div>
                <div className="space-y-2">
                  <Label htmlFor="insurancePolicyNumber">Policy Number</Label>
                  <Input id="insurancePolicyNumber" name="insurancePolicyNumber" defaultValue={trailer.insurancePolicyNumber} />
                </div>
                <div className="space-y-2">
                  <Label htmlFor="insuranceExpiration">Insurance Expiration</Label>
                  <DatePicker id="insuranceExpiration" name="insuranceExpiration" defaultValue={trailer.insuranceExpiration} />
                </div>
                <div className="space-y-2 md:col-span-2 lg:col-span-3">
                  <Label htmlFor="insuranceComments">Insurance Comments</Label>
                  <Textarea id="insuranceComments" name="insuranceComments" rows={3} defaultValue={trailer.insuranceComments} />
                </div>
              </div>
            </Card>

            {/* Financial */}
            <Card className="p-6 mb-6">
              <h2 className="text-xl font-semibold mb-4">Financial Information</h2>
              <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-4">
                <div className="space-y-2">
                  <Label htmlFor="purchaseDate">Purchase Date</Label>
                  <DatePicker id="purchaseDate" name="purchaseDate" defaultValue={trailer.purchaseDate} />
                </div>
                <div className="space-y-2">
                  <Label htmlFor="purchasePrice">Purchase Price</Label>
                  <NumberInput id="purchasePrice" name="purchasePrice" placeholder="150,000" defaultValue={trailer.purchasePrice} />
                </div>
                <div className="space-y-2">
                  <Label htmlFor="ownershipType">Ownership Type</Label>
                  <Select name="ownershipType" defaultValue={trailer.ownershipType}>
                    <SelectTrigger id="ownershipType" className="w-full">
                      <SelectValue placeholder="Select type..." />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="Owned">Owned</SelectItem>
                      <SelectItem value="Leased">Leased</SelectItem>
                      <SelectItem value="Financed">Financed</SelectItem>
                      <SelectItem value="Renting">Renting</SelectItem>
                    </SelectContent>
                  </Select>
                </div>
                <div className="space-y-2">
                  <Label htmlFor="lienholder">Lienholder</Label>
                  <Input id="lienholder" name="lienholder" defaultValue={trailer.lienholder} />
                </div>
              </div>
            </Card>
          </form>
        </div>

        {/* Sticky Footer */}
        <footer className="sticky bottom-0 z-50 flex items-center justify-between gap-4 border-t bg-background px-6 py-4">
          <Button type="button" variant="outline" onClick={() => router.push('/fleet/trailers')} disabled={isSubmitting}>
            Cancel
          </Button>
          <Button type="submit" form="trailer-form" disabled={isSubmitting}>
            {isSubmitting ? (
              <>
                <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                Saving...
              </>
            ) : (
              'Save Changes'
            )}
          </Button>
        </footer>
      </>
  );
}
