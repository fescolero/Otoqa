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
import { Separator } from '@/components/ui/separator';
import { SidebarTrigger } from '@/components/ui/sidebar';
import { Textarea } from '@/components/ui/textarea';
import { useAuth } from '@workos-inc/authkit-nextjs/components';
import { useMutation } from 'convex/react';
import { api } from '@/convex/_generated/api';
import { useRouter } from 'next/navigation';
import { useState, FormEvent } from 'react';
import { useOrganizationId } from '@/contexts/organization-context';
import { Loader2 } from 'lucide-react';
import { PhoneInput } from '@/components/ui/phone-input';
import { toast } from 'sonner';

export default function CreateFuelVendorPage() {
  const { user } = useAuth();
  const router = useRouter();
  const workosOrgId = useOrganizationId();
  const createVendor = useMutation(api.fuelVendors.create);
  const [isSubmitting, setIsSubmitting] = useState(false);

  const [country, setCountry] = useState('USA');

  const handleSubmit = async (e: FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    if (!workosOrgId || !user) return;

    setIsSubmitting(true);

    try {
      const formData = new FormData(e.currentTarget);

      await createVendor({
        organizationId: workosOrgId,
        name: formData.get('name') as string,
        code: (formData.get('code') as string) || undefined,
        accountNumber: (formData.get('accountNumber') as string) || undefined,
        discountProgram: (formData.get('discountProgram') as string) || undefined,
        contactName: (formData.get('contactName') as string) || undefined,
        contactEmail: (formData.get('contactEmail') as string) || undefined,
        contactPhone: (formData.get('contactPhone') as string) || undefined,
        addressLine: (formData.get('addressLine') as string) || undefined,
        city: (formData.get('city') as string) || undefined,
        state: (formData.get('state') as string) || undefined,
        zip: (formData.get('zip') as string) || undefined,
        country: country || undefined,
        notes: (formData.get('notes') as string) || undefined,
        createdBy: user.id,
      });

      toast.success('Fuel vendor created successfully');
      router.push('/operations/diesel/vendors');
    } catch (error) {
      console.error('Failed to create fuel vendor:', error);
      toast.error('Failed to create fuel vendor. Please try again.');
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
                <BreadcrumbLink href="/dashboard">Dashboard</BreadcrumbLink>
              </BreadcrumbItem>
              <BreadcrumbSeparator className="hidden md:block" />
              <BreadcrumbItem className="hidden md:block">
                <BreadcrumbLink href="#">Company Operations</BreadcrumbLink>
              </BreadcrumbItem>
              <BreadcrumbSeparator className="hidden md:block" />
              <BreadcrumbItem className="hidden md:block">
                <BreadcrumbLink href="/operations/diesel/vendors">Fuel Vendors</BreadcrumbLink>
              </BreadcrumbItem>
              <BreadcrumbSeparator className="hidden md:block" />
              <BreadcrumbItem>
                <BreadcrumbPage>New Vendor</BreadcrumbPage>
              </BreadcrumbItem>
            </BreadcrumbList>
          </Breadcrumb>
        </div>
      </header>

      <div className="flex flex-1 flex-col gap-6 p-6 pb-24">
        <div className="flex items-center justify-between">
          <div>
            <h1 className="text-3xl font-bold tracking-tight">New Fuel Vendor</h1>
            <p className="text-muted-foreground">
              Add a new fuel vendor to your organization
            </p>
          </div>
        </div>

        <form id="vendor-form" onSubmit={handleSubmit}>
          <Card className="p-6 mb-6">
            <h2 className="text-xl font-semibold mb-4">Vendor Information</h2>
            <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
              <div className="space-y-2">
                <Label htmlFor="name">
                  Name <span className="text-destructive">*</span>
                </Label>
                <Input
                  id="name"
                  name="name"
                  required
                  placeholder="e.g. Pilot Flying J"
                />
              </div>
              <div className="space-y-2">
                <Label htmlFor="code">Code</Label>
                <Input id="code" name="code" placeholder="e.g. PFJ" />
              </div>
              <div className="space-y-2">
                <Label htmlFor="accountNumber">Account Number</Label>
                <Input
                  id="accountNumber"
                  name="accountNumber"
                  placeholder="e.g. 12345678"
                />
              </div>
              <div className="space-y-2">
                <Label htmlFor="discountProgram">Discount Program</Label>
                <Input
                  id="discountProgram"
                  name="discountProgram"
                  placeholder="e.g. Fleet Advantage"
                />
              </div>
            </div>
          </Card>

          <Card className="p-6 mb-6">
            <h2 className="text-xl font-semibold mb-4">Contact Information</h2>
            <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
              <div className="space-y-2">
                <Label htmlFor="contactName">Contact Name</Label>
                <Input
                  id="contactName"
                  name="contactName"
                  placeholder="John Doe"
                />
              </div>
              <div className="space-y-2">
                <Label htmlFor="contactEmail">Contact Email</Label>
                <Input
                  id="contactEmail"
                  name="contactEmail"
                  type="email"
                  placeholder="contact@vendor.com"
                />
              </div>
              <div className="space-y-2">
                <Label htmlFor="contactPhone">Contact Phone</Label>
                <PhoneInput id="contactPhone" name="contactPhone" />
              </div>
            </div>
          </Card>

          <Card className="p-6 mb-6">
            <h2 className="text-xl font-semibold mb-4">Address</h2>
            <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
              <div className="space-y-2 md:col-span-2">
                <Label htmlFor="addressLine">Address Line</Label>
                <Input
                  id="addressLine"
                  name="addressLine"
                  placeholder="123 Main St"
                />
              </div>
              <div className="space-y-2">
                <Label htmlFor="city">City</Label>
                <Input id="city" name="city" placeholder="Houston" />
              </div>
              <div className="space-y-2">
                <Label htmlFor="state">State</Label>
                <Input id="state" name="state" placeholder="TX" />
              </div>
              <div className="space-y-2">
                <Label htmlFor="zip">ZIP</Label>
                <Input id="zip" name="zip" placeholder="77001" />
              </div>
              <div className="space-y-2">
                <Label htmlFor="country">Country</Label>
                <Input
                  id="country"
                  name="country"
                  value={country}
                  onChange={(e) => setCountry(e.target.value)}
                />
              </div>
            </div>
          </Card>

          <Card className="p-6 mb-6">
            <h2 className="text-xl font-semibold mb-4">Notes</h2>
            <div className="space-y-2">
              <Label htmlFor="notes">Notes</Label>
              <Textarea
                id="notes"
                name="notes"
                placeholder="Any additional notes about this vendor..."
                rows={4}
              />
            </div>
          </Card>

          <div className="flex justify-end gap-4">
            <Button
              type="button"
              variant="outline"
              onClick={() => router.push('/operations/diesel/vendors')}
              disabled={isSubmitting}
            >
              Cancel
            </Button>
            <Button type="submit" disabled={isSubmitting}>
              {isSubmitting && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
              Create Vendor
            </Button>
          </div>
        </form>
      </div>
    </>
  );
}
