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
import { Checkbox } from '@/components/ui/checkbox';
import { Textarea } from '@/components/ui/textarea';
import { useMutation, useQuery } from 'convex/react';
import { api } from '@/convex/_generated/api';
import { useRouter } from 'next/navigation';
import { useState, useEffect, FormEvent } from 'react';
import { Loader2, ArrowLeft, Link2, AlertCircle } from 'lucide-react';
import { DatePicker } from '@/components/ui/date-picker';
import { PhoneInput } from '@/components/ui/phone-input';
import { AddressAutocomplete, AddressData } from '@/components/ui/address-autocomplete';
import { Id } from '@/convex/_generated/dataModel';
import { Badge } from '@/components/ui/badge';

export function CarrierEditContent({ carrierId }: { carrierId: string }) {
  const router = useRouter();
  const partnershipId = carrierId as Id<'carrierPartnerships'>;
  
  // Use partnership API
  const updatePartnership = useMutation(api.carrierPartnerships.update);
  const updateStatus = useMutation(api.carrierPartnerships.updateStatus);
  
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [addressData, setAddressData] = useState<AddressData | null>(null);
  const [addressLine, setAddressLine] = useState('');
  const [addressLine2, setAddressLine2] = useState('');
  const [city, setCity] = useState('');
  const [state, setState] = useState('');
  const [zip, setZip] = useState('');
  const [country, setCountry] = useState('');
  const [isOwnerOperator, setIsOwnerOperator] = useState(false);

  // Fetch partnership data
  const partnership = useQuery(api.carrierPartnerships.get, { partnershipId });

  // Initialize fields from partnership data
  useEffect(() => {
    if (partnership) {
      setAddressLine(partnership.addressLine || '');
      setAddressLine2(partnership.addressLine2 || '');
      setCity(partnership.city || '');
      setState(partnership.state || '');
      setZip(partnership.zip || '');
      setCountry(partnership.country || '');
      setIsOwnerOperator(partnership.isOwnerOperator || false);
    }
  }, [partnership]);

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

  if (!partnership) {
    return (
      <>
        <div className="flex items-center justify-center h-screen">
          <p className="text-muted-foreground">Loading carrier...</p>
        </div>
      </>
    );
  }

  // Check if this is a linked carrier (has an Otoqa account)
  const isLinkedCarrier = !!partnership.carrierOrgId;

  const handleSubmit = async (e: FormEvent<HTMLFormElement>) => {
    e.preventDefault();

    setIsSubmitting(true);

    try {
      const formData = new FormData(e.currentTarget);
      const newStatus = formData.get('status') as string;

      // Update partnership details
      await updatePartnership({
        partnershipId,
        // Carrier identification
        mcNumber: (formData.get('mcNumber') as string) || undefined,
        usdotNumber: (formData.get('usdotNumber') as string) || undefined,
        // Company Information
        carrierName: (formData.get('carrierName') as string) || undefined,
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
        insuranceCoverageVerified: formData.get('insuranceCoverageVerified') === 'true',
        // Broker preferences
        defaultPaymentTerms: (formData.get('defaultPaymentTerms') as string) || undefined,
        internalNotes: (formData.get('internalNotes') as string) || undefined,
        rating: formData.get('rating') ? parseInt(formData.get('rating') as string) : undefined,
        // Owner-operator fields
        isOwnerOperator,
        ownerDriverFirstName: isOwnerOperator ? (formData.get('ownerDriverFirstName') as string) || undefined : undefined,
        ownerDriverLastName: isOwnerOperator ? (formData.get('ownerDriverLastName') as string) || undefined : undefined,
        ownerDriverPhone: isOwnerOperator ? (formData.get('ownerDriverPhone') as string) || undefined : undefined,
        ownerDriverEmail: isOwnerOperator ? (formData.get('ownerDriverEmail') as string) || undefined : undefined,
        ownerDriverDOB: isOwnerOperator ? (formData.get('ownerDriverDOB') as string) || undefined : undefined,
        ownerDriverLicenseNumber: isOwnerOperator ? (formData.get('ownerDriverLicenseNumber') as string) || undefined : undefined,
        ownerDriverLicenseState: isOwnerOperator ? (formData.get('ownerDriverLicenseState') as string) || undefined : undefined,
        ownerDriverLicenseClass: isOwnerOperator ? (formData.get('ownerDriverLicenseClass') as string) || undefined : undefined,
        ownerDriverLicenseExpiration: isOwnerOperator ? (formData.get('ownerDriverLicenseExpiration') as string) || undefined : undefined,
      });

      // Update status if changed
      if (newStatus && newStatus !== partnership.status) {
        await updateStatus({
          partnershipId,
          status: newStatus as 'ACTIVE' | 'INVITED' | 'PENDING' | 'SUSPENDED' | 'TERMINATED',
        });
      }

      router.push(`/operations/carriers/${partnershipId}`);
    } catch (error) {
      console.error('Failed to update carrier partnership:', error);
      alert('Failed to update carrier. Please try again.');
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
              <BreadcrumbItem className="hidden md:block">
                <BreadcrumbLink href={`/operations/carriers/${partnershipId}`}>
                  {partnership.carrierName}
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

      <div className="flex flex-1 flex-col gap-6 p-6 pb-24">
        {/* Page Header */}
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-4">
            <Button
              variant="outline"
              size="icon"
              onClick={() => router.push(`/operations/carriers/${partnershipId}`)}
            >
              <ArrowLeft className="h-4 w-4" />
            </Button>
            <div>
              <div className="flex items-center gap-2">
                <h1 className="text-3xl font-bold tracking-tight">Edit Carrier</h1>
                {isLinkedCarrier && (
                  <Badge variant="outline" className="bg-blue-50 text-blue-700 border-blue-200">
                    <Link2 className="w-3 h-3 mr-1" />
                    Linked
                  </Badge>
                )}
              </div>
              <p className="text-muted-foreground">{partnership.carrierName}</p>
            </div>
          </div>
        </div>

        {/* Linked Carrier Warning */}
        {isLinkedCarrier && (
          <Card className="p-4 border-blue-200 bg-blue-50/50">
            <div className="flex items-start gap-3">
              <AlertCircle className="h-5 w-5 text-blue-600 mt-0.5" />
              <div>
                <p className="font-medium text-blue-900">Linked Carrier Account</p>
                <p className="text-sm text-blue-700">
                  This carrier has their own Otoqa account. Some fields are synced from their profile
                  and cannot be edited here. Contact the carrier directly for updates.
                </p>
              </div>
            </div>
          </Card>
        )}

        <form id="carrier-form" key={partnership._id} onSubmit={handleSubmit}>
          {/* Company Information */}
          <Card className="p-6 mb-6">
            <h2 className="text-xl font-semibold mb-4">Carrier Information</h2>
            <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
              <div className="space-y-2">
                <Label htmlFor="carrierName">
                  Carrier Name <span className="text-destructive">*</span>
                </Label>
                <Input
                  id="carrierName"
                  name="carrierName"
                  required
                  defaultValue={partnership.carrierName}
                  disabled={isLinkedCarrier}
                />
              </div>
              <div className="space-y-2">
                <Label htmlFor="carrierDba">DBA (Doing Business As)</Label>
                <Input
                  id="carrierDba"
                  name="carrierDba"
                  defaultValue={partnership.carrierDba || ''}
                  disabled={isLinkedCarrier}
                />
              </div>
              <div className="space-y-2">
                <Label htmlFor="status">
                  Status <span className="text-destructive">*</span>
                </Label>
                <Select name="status" required defaultValue={partnership.status}>
                  <SelectTrigger id="status" className="w-full">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="ACTIVE">Active</SelectItem>
                    <SelectItem value="INVITED">Invited</SelectItem>
                    <SelectItem value="PENDING">Pending</SelectItem>
                    <SelectItem value="SUSPENDED">Suspended</SelectItem>
                    <SelectItem value="TERMINATED">Terminated</SelectItem>
                  </SelectContent>
                </Select>
              </div>
              <div className="space-y-2">
                <Label htmlFor="mcNumber">MC Number</Label>
                <Input
                  id="mcNumber"
                  name="mcNumber"
                  defaultValue={partnership.mcNumber || ''}
                  disabled={isLinkedCarrier}
                />
              </div>
              <div className="space-y-2">
                <Label htmlFor="usdotNumber">USDOT Number</Label>
                <Input
                  id="usdotNumber"
                  name="usdotNumber"
                  defaultValue={partnership.usdotNumber || ''}
                  disabled={isLinkedCarrier}
                />
              </div>
            </div>
          </Card>

          {/* Contact Information */}
          <Card className="p-6 mb-6">
            <h2 className="text-xl font-semibold mb-4">Contact Information</h2>
            <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-4">
              <div className="space-y-2">
                <Label htmlFor="contactFirstName">First Name</Label>
                <Input
                  id="contactFirstName"
                  name="contactFirstName"
                  defaultValue={partnership.contactFirstName || ''}
                />
              </div>
              <div className="space-y-2">
                <Label htmlFor="contactLastName">Last Name</Label>
                <Input
                  id="contactLastName"
                  name="contactLastName"
                  defaultValue={partnership.contactLastName || ''}
                />
              </div>
              <div className="space-y-2">
                <Label htmlFor="contactEmail">Email</Label>
                <Input
                  id="contactEmail"
                  name="contactEmail"
                  type="email"
                  defaultValue={partnership.contactEmail || ''}
                />
              </div>
              <div className="space-y-2">
                <Label htmlFor="contactPhone">Phone Number</Label>
                <PhoneInput
                  id="contactPhone"
                  name="contactPhone"
                  defaultValue={partnership.contactPhone || ''}
                />
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
                  disabled={isLinkedCarrier}
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
                  disabled={isLinkedCarrier}
                />
              </div>
              <div className="space-y-2">
                <Label htmlFor="city">City</Label>
                <Input
                  id="city"
                  name="city"
                  value={city}
                  onChange={(e) => setCity(e.target.value)}
                  disabled={isLinkedCarrier}
                />
              </div>
              <div className="space-y-2">
                <Label htmlFor="state">State / Province</Label>
                <Input
                  id="state"
                  name="state"
                  placeholder="CA"
                  value={state}
                  onChange={(e) => setState(e.target.value)}
                  disabled={isLinkedCarrier}
                />
              </div>
              <div className="space-y-2">
                <Label htmlFor="zip">ZIP / Postal Code</Label>
                <Input
                  id="zip"
                  name="zip"
                  value={zip}
                  onChange={(e) => setZip(e.target.value)}
                  disabled={isLinkedCarrier}
                />
              </div>
              <div className="space-y-2">
                <Label htmlFor="country">Country</Label>
                <Input
                  id="country"
                  name="country"
                  value={country}
                  onChange={(e) => setCountry(e.target.value)}
                  disabled={isLinkedCarrier}
                />
              </div>
            </div>
          </Card>

          {/* Insurance */}
          <Card className="p-6 mb-6">
            <h2 className="text-xl font-semibold mb-4">Insurance</h2>
            <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
              <div className="space-y-2">
                <Label htmlFor="insuranceProvider">Insurance Provider</Label>
                <Input
                  id="insuranceProvider"
                  name="insuranceProvider"
                  defaultValue={partnership.insuranceProvider || ''}
                  disabled={isLinkedCarrier}
                />
              </div>
              <div className="space-y-2">
                <Label htmlFor="insuranceExpiration">Insurance Expiration</Label>
                <DatePicker
                  id="insuranceExpiration"
                  name="insuranceExpiration"
                  defaultValue={partnership.insuranceExpiration || undefined}
                  disabled={isLinkedCarrier}
                />
              </div>
              <div className="flex items-center space-x-2 pt-8">
                <Checkbox
                  id="insuranceCoverageVerified"
                  name="insuranceCoverageVerified"
                  value="true"
                  defaultChecked={partnership.insuranceCoverageVerified}
                />
                <Label htmlFor="insuranceCoverageVerified" className="font-normal cursor-pointer">
                  Coverage Verified
                </Label>
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
            <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
              <div className="space-y-2">
                <Label htmlFor="defaultPaymentTerms">Default Payment Terms</Label>
                <Select
                  name="defaultPaymentTerms"
                  defaultValue={partnership.defaultPaymentTerms || undefined}
                >
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
              <div className="space-y-2">
                <Label htmlFor="rating">Your Rating (1-5)</Label>
                <Select
                  name="rating"
                  defaultValue={partnership.rating?.toString() || undefined}
                >
                  <SelectTrigger id="rating" className="w-full">
                    <SelectValue placeholder="Rate this carrier" />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="1">1 - Poor</SelectItem>
                    <SelectItem value="2">2 - Below Average</SelectItem>
                    <SelectItem value="3">3 - Average</SelectItem>
                    <SelectItem value="4">4 - Good</SelectItem>
                    <SelectItem value="5">5 - Excellent</SelectItem>
                  </SelectContent>
                </Select>
              </div>
              <div className="space-y-2">
                <Label>Carrier Type</Label>
                <div className="flex items-center space-x-2 pt-2">
                  <Checkbox
                    id="isOwnerOperator"
                    name="isOwnerOperator"
                    value="true"
                    checked={isOwnerOperator}
                    onCheckedChange={(checked) => setIsOwnerOperator(checked === true)}
                  />
                  <Label htmlFor="isOwnerOperator" className="font-normal cursor-pointer">
                    Owner-Operator
                  </Label>
                </div>
                <p className="text-xs text-muted-foreground">
                  Single-driver carrier who owns and operates their own truck
                </p>
              </div>
              <div className="space-y-2 md:col-span-3">
                <Label htmlFor="internalNotes">Internal Notes</Label>
                <Textarea
                  id="internalNotes"
                  name="internalNotes"
                  placeholder="Add notes about this carrier..."
                  defaultValue={partnership.internalNotes || ''}
                  rows={3}
                />
              </div>
            </div>
          </Card>

          {/* Owner-Operator Driver Details */}
          {isOwnerOperator && (
            <Card className="p-6 mb-6 border-amber-200 bg-amber-50/50">
              <div className="flex items-center gap-2 mb-4">
                <h2 className="text-xl font-semibold text-amber-900">Owner-Operator Driver Details</h2>
              </div>
              <p className="text-sm text-amber-700 mb-4">
                Enter the driver information for this owner-operator. This helps with compliance tracking and load assignments.
              </p>
              <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-4">
                <div className="space-y-2">
                  <Label htmlFor="ownerDriverFirstName">First Name</Label>
                  <Input
                    id="ownerDriverFirstName"
                    name="ownerDriverFirstName"
                    defaultValue={partnership.ownerDriverFirstName || ''}
                    placeholder="John"
                  />
                </div>
                <div className="space-y-2">
                  <Label htmlFor="ownerDriverLastName">Last Name</Label>
                  <Input
                    id="ownerDriverLastName"
                    name="ownerDriverLastName"
                    defaultValue={partnership.ownerDriverLastName || ''}
                    placeholder="Smith"
                  />
                </div>
                <div className="space-y-2">
                  <Label htmlFor="ownerDriverPhone">Phone</Label>
                  <PhoneInput
                    id="ownerDriverPhone"
                    name="ownerDriverPhone"
                    defaultValue={partnership.ownerDriverPhone || ''}
                  />
                </div>
                <div className="space-y-2">
                  <Label htmlFor="ownerDriverEmail">Email</Label>
                  <Input
                    id="ownerDriverEmail"
                    name="ownerDriverEmail"
                    type="email"
                    defaultValue={partnership.ownerDriverEmail || ''}
                    placeholder="driver@example.com"
                  />
                </div>
                <div className="space-y-2">
                  <Label htmlFor="ownerDriverDOB">Date of Birth</Label>
                  <DatePicker
                    id="ownerDriverDOB"
                    name="ownerDriverDOB"
                    defaultValue={partnership.ownerDriverDOB || undefined}
                  />
                </div>
                <div className="space-y-2">
                  <Label htmlFor="ownerDriverLicenseNumber">License Number</Label>
                  <Input
                    id="ownerDriverLicenseNumber"
                    name="ownerDriverLicenseNumber"
                    defaultValue={partnership.ownerDriverLicenseNumber || ''}
                    placeholder="DL12345678"
                  />
                </div>
                <div className="space-y-2">
                  <Label htmlFor="ownerDriverLicenseState">License State</Label>
                  <Input
                    id="ownerDriverLicenseState"
                    name="ownerDriverLicenseState"
                    defaultValue={partnership.ownerDriverLicenseState || ''}
                    placeholder="CA"
                  />
                </div>
                <div className="space-y-2">
                  <Label htmlFor="ownerDriverLicenseClass">License Class</Label>
                  <Select
                    name="ownerDriverLicenseClass"
                    defaultValue={partnership.ownerDriverLicenseClass || undefined}
                  >
                    <SelectTrigger id="ownerDriverLicenseClass" className="w-full">
                      <SelectValue placeholder="Select class" />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="Class A">Class A</SelectItem>
                      <SelectItem value="Class B">Class B</SelectItem>
                      <SelectItem value="Class C">Class C</SelectItem>
                    </SelectContent>
                  </Select>
                </div>
                <div className="space-y-2">
                  <Label htmlFor="ownerDriverLicenseExpiration">License Expiration</Label>
                  <DatePicker
                    id="ownerDriverLicenseExpiration"
                    name="ownerDriverLicenseExpiration"
                    defaultValue={partnership.ownerDriverLicenseExpiration || undefined}
                  />
                </div>
              </div>
            </Card>
          )}

          {/* Submit Buttons */}
          <div className="flex justify-end gap-4">
            <Button
              type="button"
              variant="outline"
              onClick={() => router.push(`/operations/carriers/${partnershipId}`)}
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
