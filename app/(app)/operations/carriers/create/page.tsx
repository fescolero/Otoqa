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
import { useMutation } from 'convex/react';
import { api } from '@/convex/_generated/api';
import { useRouter } from 'next/navigation';
import { useState, useEffect, FormEvent } from 'react';
import { useOrganizationId } from '@/contexts/organization-context';
import { Loader2, Info } from 'lucide-react';
import { DatePicker } from '@/components/ui/date-picker';
import { PhoneInput } from '@/components/ui/phone-input';
import { AddressAutocomplete, AddressData } from '@/components/ui/address-autocomplete';

export default function CreateCarrierPage() {
  const { user } = useAuth();
  const router = useRouter();
  const workosOrgId = useOrganizationId();
  // Use new carrierPartnerships API
  const createPartnership = useMutation(api.carrierPartnerships.create);
  const [isSubmitting, setIsSubmitting] = useState(false);
  
  // Address state
  const [addressData, setAddressData] = useState<AddressData | null>(null);
  const [addressLine, setAddressLine] = useState('');
  const [addressLine2, setAddressLine2] = useState('');
  const [city, setCity] = useState('');
  const [state, setState] = useState('');
  const [zip, setZip] = useState('');
  const [country, setCountry] = useState('USA');

  // Auto-fill fields when address is selected from autocomplete
  useEffect(() => {
    if (addressData) {
      setAddressLine(addressData.address);
      setCity(addressData.city);
      setState(addressData.state);
      setZip(addressData.postalCode);
      setCountry(addressData.country);
    }
  }, [addressData]);

  const handleSubmit = async (e: FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    if (!workosOrgId || !user) return;

    setIsSubmitting(true);

    try {
      const formData = new FormData(e.currentTarget);

      // Create carrier partnership using new API
      await createPartnership({
        // Broker organization
        brokerOrgId: workosOrgId,
        // Carrier identification (required)
        mcNumber: formData.get('mcNumber') as string,
        carrierName: formData.get('carrierName') as string,
        // Optional carrier info
        usdotNumber: (formData.get('usdotNumber') as string) || undefined,
        carrierDba: (formData.get('carrierDba') as string) || undefined,
        // Contact Information
        contactFirstName: (formData.get('contactFirstName') as string) || undefined,
        contactLastName: (formData.get('contactLastName') as string) || undefined,
        contactEmail: (formData.get('contactEmail') as string) || undefined,
        contactPhone: (formData.get('contactPhone') as string) || undefined,
        // Address
        addressLine: addressLine || undefined,
        addressLine2: addressLine2 || undefined,
        city: city || undefined,
        state: state || undefined,
        zip: zip || undefined,
        country: country || undefined,
        // Insurance
        insuranceProvider: (formData.get('insuranceProvider') as string) || undefined,
        insuranceExpiration: (formData.get('insuranceExpiration') as string) || undefined,
        // Broker preferences
        defaultPaymentTerms: (formData.get('defaultPaymentTerms') as string) || undefined,
        internalNotes: (formData.get('internalNotes') as string) || undefined,
        // Metadata
        createdBy: user.id,
      });

      router.push('/operations/carriers');
    } catch (error) {
      console.error('Failed to create carrier partnership:', error);
      alert('Failed to create carrier. Please try again.');
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
                <BreadcrumbLink href="/operations/carriers">Carriers</BreadcrumbLink>
              </BreadcrumbItem>
              <BreadcrumbSeparator className="hidden md:block" />
              <BreadcrumbItem>
                <BreadcrumbPage>Add Carrier Partner</BreadcrumbPage>
              </BreadcrumbItem>
            </BreadcrumbList>
          </Breadcrumb>
        </div>
      </header>

      <div className="flex flex-1 flex-col gap-6 p-6 pb-24">
        {/* Page Header */}
        <div className="flex items-center justify-between">
          <div>
            <h1 className="text-3xl font-bold tracking-tight">Add Carrier Partner</h1>
            <p className="text-muted-foreground">Add a carrier to your network for load assignments</p>
          </div>
        </div>

        {/* Info Banner */}
        <Card className="p-4 border-blue-200 bg-blue-50/50">
          <div className="flex items-start gap-3">
            <Info className="h-5 w-5 text-blue-600 mt-0.5" />
            <div>
              <p className="font-medium text-blue-900">Carrier Marketplace</p>
              <p className="text-sm text-blue-700">
                If this carrier has an Otoqa account, they&apos;ll receive a partnership request and can accept to link accounts.
                Otherwise, you can use them as a reference-only carrier for load assignments.
              </p>
            </div>
          </div>
        </Card>

        <form id="carrier-form" onSubmit={handleSubmit}>
          {/* Company & Authority Information */}
          <Card className="p-6 mb-6">
            <h2 className="text-xl font-semibold mb-4">Carrier Information</h2>
            <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
              <div className="space-y-2">
                <Label htmlFor="carrierName">
                  Carrier Name <span className="text-destructive">*</span>
                </Label>
                <Input id="carrierName" name="carrierName" required placeholder="ABC Trucking LLC" />
              </div>
              <div className="space-y-2">
                <Label htmlFor="carrierDba">DBA (Doing Business As)</Label>
                <Input id="carrierDba" name="carrierDba" placeholder="Optional" />
              </div>
              <div className="space-y-2">
                <Label htmlFor="mcNumber">
                  MC Number <span className="text-destructive">*</span>
                </Label>
                <Input id="mcNumber" name="mcNumber" required placeholder="MC-123456" />
              </div>
              <div className="space-y-2">
                <Label htmlFor="usdotNumber">USDOT Number</Label>
                <Input id="usdotNumber" name="usdotNumber" placeholder="1234567" />
              </div>
            </div>
          </Card>

          {/* Contact Information */}
          <Card className="p-6 mb-6">
            <h2 className="text-xl font-semibold mb-4">Contact Information</h2>
            <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-4">
              <div className="space-y-2">
                <Label htmlFor="contactFirstName">First Name</Label>
                <Input id="contactFirstName" name="contactFirstName" placeholder="John" />
              </div>
              <div className="space-y-2">
                <Label htmlFor="contactLastName">Last Name</Label>
                <Input id="contactLastName" name="contactLastName" placeholder="Doe" />
              </div>
              <div className="space-y-2">
                <Label htmlFor="contactEmail">Email</Label>
                <Input id="contactEmail" name="contactEmail" type="email" placeholder="contact@carrier.com" />
              </div>
              <div className="space-y-2">
                <Label htmlFor="contactPhone">Phone Number</Label>
                <PhoneInput id="contactPhone" name="contactPhone" />
              </div>
            </div>
          </Card>

          {/* Address */}
          <Card className="p-6 mb-6">
            <h2 className="text-xl font-semibold mb-4">Address</h2>
            <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
              <div className="space-y-2 md:col-span-2">
                <Label htmlFor="addressLine">Street Address</Label>
                <AddressAutocomplete
                  value={addressLine}
                  onChange={(value) => setAddressLine(value)}
                  onSelect={(data) => setAddressData(data)}
                  placeholder="Start typing address..."
                />
                <p className="text-xs text-muted-foreground">Type to search or enter manually</p>
              </div>
              <div className="space-y-2 md:col-span-2">
                <Label htmlFor="addressLine2">Address Line 2</Label>
                <Input
                  id="addressLine2"
                  name="addressLine2"
                  value={addressLine2}
                  onChange={(e) => setAddressLine2(e.target.value)}
                  placeholder="Suite, Unit, Building, Floor, etc."
                />
              </div>
              <div className="space-y-2">
                <Label htmlFor="city">City</Label>
                <Input id="city" name="city" value={city} onChange={(e) => setCity(e.target.value)} />
              </div>
              <div className="space-y-2">
                <Label htmlFor="state">State / Province</Label>
                <Input id="state" name="state" placeholder="CA" value={state} onChange={(e) => setState(e.target.value)} />
              </div>
              <div className="space-y-2">
                <Label htmlFor="zip">ZIP / Postal Code</Label>
                <Input id="zip" name="zip" value={zip} onChange={(e) => setZip(e.target.value)} />
              </div>
              <div className="space-y-2">
                <Label htmlFor="country">Country</Label>
                <Input id="country" name="country" value={country} onChange={(e) => setCountry(e.target.value)} />
              </div>
            </div>
          </Card>

          {/* Insurance */}
          <Card className="p-6 mb-6">
            <h2 className="text-xl font-semibold mb-4">Insurance</h2>
            <p className="text-sm text-muted-foreground mb-4">
              Basic insurance info for your records. Linked carriers will have their verified insurance details synced automatically.
            </p>
            <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
              <div className="space-y-2">
                <Label htmlFor="insuranceProvider">Insurance Provider</Label>
                <Input id="insuranceProvider" name="insuranceProvider" placeholder="State Farm, Progressive, etc." />
              </div>
              <div className="space-y-2">
                <Label htmlFor="insuranceExpiration">Insurance Expiration</Label>
                <DatePicker id="insuranceExpiration" name="insuranceExpiration" />
              </div>
            </div>
          </Card>

          {/* Broker Preferences */}
          <Card className="p-6 mb-6 border-primary/20 bg-primary/5">
            <div className="flex items-center gap-2 mb-4">
              <h2 className="text-xl font-semibold">Your Preferences</h2>
              <span className="text-xs bg-primary/10 text-primary px-2 py-1 rounded">
                Private to Your Org
              </span>
            </div>
            <p className="text-sm text-muted-foreground mb-4">
              These settings are only visible to your organization and won&apos;t be shared with the carrier.
            </p>
            <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
              <div className="space-y-2">
                <Label htmlFor="defaultPaymentTerms">Default Payment Terms</Label>
                <Select name="defaultPaymentTerms">
                  <SelectTrigger id="defaultPaymentTerms" className="w-full">
                    <SelectValue placeholder="Select terms" />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="Net15">Net 15</SelectItem>
                    <SelectItem value="Net30">Net 30</SelectItem>
                    <SelectItem value="Net45">Net 45</SelectItem>
                    <SelectItem value="QuickPay">Quick Pay</SelectItem>
                  </SelectContent>
                </Select>
              </div>
              <div className="space-y-2 md:col-span-2">
                <Label htmlFor="internalNotes">Internal Notes</Label>
                <Textarea
                  id="internalNotes"
                  name="internalNotes"
                  placeholder="Add any notes about this carrier..."
                  rows={3}
                />
              </div>
            </div>
          </Card>

          {/* Submit Buttons */}
          <div className="flex justify-end gap-4">
            <Button
              type="button"
              variant="outline"
              onClick={() => router.push('/operations/carriers')}
              disabled={isSubmitting}
            >
              Cancel
            </Button>
            <Button type="submit" disabled={isSubmitting}>
              {isSubmitting && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
              Add Carrier Partner
            </Button>
          </div>
        </form>
      </div>
    </>
  );
}
