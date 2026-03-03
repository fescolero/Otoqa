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
import { Id } from '@/convex/_generated/dataModel';
import { useRouter } from 'next/navigation';
import { useState, useEffect, FormEvent } from 'react';
import { Loader2 } from 'lucide-react';
import { PhoneInput } from '@/components/ui/phone-input';
import { useAuthQuery } from '@/hooks/use-auth-query';
import { toast } from 'sonner';

export function VendorEditContent({ vendorId }: { vendorId: string }) {
  const { user } = useAuth();
  const router = useRouter();
  const typedVendorId = vendorId as Id<'fuelVendors'>;

  const vendor = useAuthQuery(api.fuelVendors.get, { vendorId: typedVendorId });
  const updateVendor = useMutation(api.fuelVendors.update);

  const [isSubmitting, setIsSubmitting] = useState(false);

  const [name, setName] = useState('');
  const [code, setCode] = useState('');
  const [accountNumber, setAccountNumber] = useState('');
  const [discountProgram, setDiscountProgram] = useState('');
  const [contactName, setContactName] = useState('');
  const [contactEmail, setContactEmail] = useState('');
  const [contactPhone, setContactPhone] = useState('');
  const [addressLine, setAddressLine] = useState('');
  const [city, setCity] = useState('');
  const [state, setState] = useState('');
  const [zip, setZip] = useState('');
  const [country, setCountry] = useState('');
  const [notes, setNotes] = useState('');

  useEffect(() => {
    if (vendor) {
      setName(vendor.name || '');
      setCode(vendor.code || '');
      setAccountNumber(vendor.accountNumber || '');
      setDiscountProgram(vendor.discountProgram || '');
      setContactName(vendor.contactName || '');
      setContactEmail(vendor.contactEmail || '');
      setContactPhone(vendor.contactPhone || '');
      setAddressLine(vendor.addressLine || '');
      setCity(vendor.city || '');
      setState(vendor.state || '');
      setZip(vendor.zip || '');
      setCountry(vendor.country || '');
      setNotes(vendor.notes || '');
    }
  }, [vendor]);

  if (!vendor) {
    return (
      <div className="flex items-center justify-center h-screen">
        <p className="text-muted-foreground">Loading vendor...</p>
      </div>
    );
  }

  const handleSubmit = async (e: FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    if (!user) return;

    setIsSubmitting(true);

    const formData = new FormData(e.currentTarget);
    const phoneValue = (formData.get('contactPhone') as string) || '';

    try {
      await updateVendor({
        vendorId: typedVendorId,
        name: name || undefined,
        code: code || undefined,
        accountNumber: accountNumber || undefined,
        discountProgram: discountProgram || undefined,
        contactName: contactName || undefined,
        contactEmail: contactEmail || undefined,
        contactPhone: phoneValue || undefined,
        addressLine: addressLine || undefined,
        city: city || undefined,
        state: state || undefined,
        zip: zip || undefined,
        country: country || undefined,
        notes: notes || undefined,
        updatedBy: user.id,
      });

      toast.success('Fuel vendor updated successfully');
      router.push('/operations/diesel/vendors');
    } catch (error) {
      console.error('Failed to update fuel vendor:', error);
      toast.error('Failed to update fuel vendor. Please try again.');
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
                <BreadcrumbPage>Edit {vendor.name}</BreadcrumbPage>
              </BreadcrumbItem>
            </BreadcrumbList>
          </Breadcrumb>
        </div>
      </header>

      <div className="flex flex-1 flex-col gap-6 p-6 pb-24">
        <div className="flex items-center justify-between">
          <div>
            <h1 className="text-3xl font-bold tracking-tight">Edit Fuel Vendor</h1>
            <p className="text-muted-foreground">{vendor.name}</p>
          </div>
        </div>

        <form id="vendor-form" key={vendor._id} onSubmit={handleSubmit}>
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
                  value={name}
                  onChange={(e) => setName(e.target.value)}
                />
              </div>
              <div className="space-y-2">
                <Label htmlFor="code">Code</Label>
                <Input
                  id="code"
                  name="code"
                  value={code}
                  onChange={(e) => setCode(e.target.value)}
                />
              </div>
              <div className="space-y-2">
                <Label htmlFor="accountNumber">Account Number</Label>
                <Input
                  id="accountNumber"
                  name="accountNumber"
                  value={accountNumber}
                  onChange={(e) => setAccountNumber(e.target.value)}
                />
              </div>
              <div className="space-y-2">
                <Label htmlFor="discountProgram">Discount Program</Label>
                <Input
                  id="discountProgram"
                  name="discountProgram"
                  value={discountProgram}
                  onChange={(e) => setDiscountProgram(e.target.value)}
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
                  value={contactName}
                  onChange={(e) => setContactName(e.target.value)}
                />
              </div>
              <div className="space-y-2">
                <Label htmlFor="contactEmail">Contact Email</Label>
                <Input
                  id="contactEmail"
                  name="contactEmail"
                  type="email"
                  value={contactEmail}
                  onChange={(e) => setContactEmail(e.target.value)}
                />
              </div>
              <div className="space-y-2">
                <Label htmlFor="contactPhone">Contact Phone</Label>
                <PhoneInput
                  id="contactPhone"
                  name="contactPhone"
                  defaultValue={contactPhone}
                />
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
                  value={addressLine}
                  onChange={(e) => setAddressLine(e.target.value)}
                />
              </div>
              <div className="space-y-2">
                <Label htmlFor="city">City</Label>
                <Input
                  id="city"
                  name="city"
                  value={city}
                  onChange={(e) => setCity(e.target.value)}
                />
              </div>
              <div className="space-y-2">
                <Label htmlFor="state">State</Label>
                <Input
                  id="state"
                  name="state"
                  value={state}
                  onChange={(e) => setState(e.target.value)}
                />
              </div>
              <div className="space-y-2">
                <Label htmlFor="zip">ZIP</Label>
                <Input
                  id="zip"
                  name="zip"
                  value={zip}
                  onChange={(e) => setZip(e.target.value)}
                />
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
                value={notes}
                onChange={(e) => setNotes(e.target.value)}
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
              Save Changes
            </Button>
          </div>
        </form>
      </div>
    </>
  );
}
