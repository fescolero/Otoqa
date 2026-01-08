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
import { useAuth } from '@workos-inc/authkit-nextjs/components';
import { useMutation, useQuery } from 'convex/react';
import { api } from '@/convex/_generated/api';
import { useRouter } from 'next/navigation';
import { useState, useEffect, FormEvent, useRef } from 'react';
import { Loader2, ArrowLeft } from 'lucide-react';
import { DatePicker } from '@/components/ui/date-picker';
import { PhoneInput } from '@/components/ui/phone-input';
import { AddressAutocomplete, AddressData } from '@/components/ui/address-autocomplete';
import { Id } from '@/convex/_generated/dataModel';

export function CarrierEditContent({ carrierId }: { carrierId: string }) {
  const { user } = useAuth();
  const router = useRouter();
  const carrierIdTyped = carrierId as Id<'carriers'>;
  const updateCarrier = useMutation(api.carriers.update);
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [addressData, setAddressData] = useState<AddressData | null>(null);
  const [addressLine, setAddressLine] = useState('');
  const [city, setCity] = useState('');
  const [state, setState] = useState('');
  const [zip, setZip] = useState('');
  const [country, setCountry] = useState('');

  // Fetch carrier with sensitive data - must be before useEffects that depend on it
  const carrier = useQuery(api.carriers.get, { id: carrierIdTyped, includeSensitive: true });

  // Initialize address fields from carrier data
  useEffect(() => {
    if (carrier) {
      setAddressLine(carrier.addressLine);
      setCity(carrier.city || '');
      setState(carrier.state || '');
      setZip(carrier.zip || '');
      setCountry(carrier.country || '');
    }
  }, [carrier]);

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

  if (!carrier) {
    return (
      <>
          <div className="flex items-center justify-center h-screen">
            <p className="text-muted-foreground">Loading carrier...</p>
          </div>
        </>
    );
  }

  const handleSubmit = async (e: FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    if (!user) return;

    setIsSubmitting(true);

    try {
      const formData = new FormData(e.currentTarget);

      await updateCarrier({
        id: carrierIdTyped,
        // Company Information
        companyName: formData.get('companyName') as string,
        dba: (formData.get('dba') as string) || undefined,
        // Contact Information
        firstName: formData.get('firstName') as string,
        lastName: formData.get('lastName') as string,
        email: formData.get('email') as string,
        phoneNumber: formData.get('phoneNumber') as string,
        // Address
        addressLine: formData.get('addressLine') as string,
        addressLine2: (formData.get('addressLine2') as string) || undefined,
        city: (formData.get('city') as string) || undefined,
        state: (formData.get('state') as string) || undefined,
        zip: (formData.get('zip') as string) || undefined,
        country: (formData.get('country') as string) || undefined,
        // Operating Authority
        mcNumber: formData.get('mcNumber') as string,
        usdotNumber: (formData.get('usdotNumber') as string) || undefined,
        dotRegistration: formData.get('dotRegistration') === 'true',
        operatingAuthorityActive: formData.get('operatingAuthorityActive') === 'true',
        safetyRating: (formData.get('safetyRating') as string) || undefined,
        // Insurance
        insuranceProvider: formData.get('insuranceProvider') as string,
        insuranceCoverage: formData.get('insuranceCoverage') === 'true',
        insuranceExpiration: formData.get('insuranceExpiration') as string,
        // Sensitive Financial Information
        ein: (formData.get('ein') as string) || undefined,
        insuranceCargoAmount: formData.get('insuranceCargoAmount')
          ? parseFloat(formData.get('insuranceCargoAmount') as string)
          : undefined,
        insuranceLiabilityAmount: formData.get('insuranceLiabilityAmount')
          ? parseFloat(formData.get('insuranceLiabilityAmount') as string)
          : undefined,
        paymentTerms: (formData.get('paymentTerms') as string) || undefined,
        factoringStatus: formData.get('factoringStatus') === 'true',
        remitToAddress: (formData.get('remitToAddress') as string) || undefined,
        // Status & Metadata
        status: formData.get('status') as string,
        currency: (formData.get('currency') as string) || undefined,
      });

      router.push(`/operations/carriers/${carrierIdTyped}`);
    } catch (error) {
      console.error('Failed to update carrier:', error);
      alert('Failed to update carrier. Please try again.');
    } finally {
      setIsSubmitting(false);
    }
  };

  // Type assertion for sensitive data
  const sensitiveData = carrier as any;

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
                  <BreadcrumbLink href={`/operations/carriers/${carrierIdTyped}`}>
                    {carrier.companyName}
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
                onClick={() => router.push(`/operations/carriers/${carrierIdTyped}`)}
              >
                <ArrowLeft className="h-4 w-4" />
              </Button>
              <div>
                <h1 className="text-3xl font-bold tracking-tight">Edit Carrier</h1>
                <p className="text-muted-foreground">{carrier.companyName}</p>
              </div>
            </div>
          </div>

          <form id="carrier-form" key={carrier._id} onSubmit={handleSubmit}>
            {/* Company Information */}
            <Card className="p-6 mb-6">
              <h2 className="text-xl font-semibold mb-4">Company Information</h2>
              <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
                <div className="space-y-2">
                  <Label htmlFor="companyName">
                    Company Name <span className="text-destructive">*</span>
                  </Label>
                  <Input id="companyName" name="companyName" required defaultValue={carrier.companyName} />
                </div>
                <div className="space-y-2">
                  <Label htmlFor="dba">DBA (Doing Business As)</Label>
                  <Input id="dba" name="dba" defaultValue={carrier.dba || ''} />
                </div>
                <div className="space-y-2">
                  <Label htmlFor="status">
                    Status <span className="text-destructive">*</span>
                  </Label>
                  <Select name="status" required defaultValue={carrier.status}>
                    <SelectTrigger id="status" className="w-full">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="Active">Active</SelectItem>
                      <SelectItem value="Inactive">Inactive</SelectItem>
                      <SelectItem value="Vetting">Vetting</SelectItem>
                      <SelectItem value="Suspended">Suspended</SelectItem>
                    </SelectContent>
                  </Select>
                </div>
              </div>
            </Card>

            {/* Contact Information */}
            <Card className="p-6 mb-6">
              <h2 className="text-xl font-semibold mb-4">Contact Information</h2>
              <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
                <div className="space-y-2">
                  <Label htmlFor="firstName">
                    First Name <span className="text-destructive">*</span>
                  </Label>
                  <Input id="firstName" name="firstName" required defaultValue={carrier.firstName} />
                </div>
                <div className="space-y-2">
                  <Label htmlFor="lastName">
                    Last Name <span className="text-destructive">*</span>
                  </Label>
                  <Input id="lastName" name="lastName" required defaultValue={carrier.lastName} />
                </div>
                <div className="space-y-2">
                  <Label htmlFor="email">
                    Email <span className="text-destructive">*</span>
                  </Label>
                  <Input id="email" name="email" type="email" required defaultValue={carrier.email} />
                </div>
                <div className="space-y-2">
                  <Label htmlFor="phoneNumber">
                    Phone Number <span className="text-destructive">*</span>
                  </Label>
                  <PhoneInput
                    id="phoneNumber"
                    name="phoneNumber"
                    required
                    defaultValue={carrier.phoneNumber}
                  />
                </div>
              </div>
            </Card>

            {/* Address */}
            <Card className="p-6 mb-6">
              <h2 className="text-xl font-semibold mb-4">Address</h2>
              <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                <div className="space-y-2 md:col-span-2">
                  <Label htmlFor="addressLine">
                    Address Line 1 <span className="text-destructive">*</span>
                  </Label>
                  <AddressAutocomplete
                    value={addressLine}
                    onChange={(value) => setAddressLine(value)}
                    onSelect={(data) => setAddressData(data)}
                    placeholder="Start typing address..."
                  />
                  <input type="hidden" name="addressLine" value={addressLine} required />
                  <p className="text-xs text-muted-foreground">Type to search or enter manually</p>
                </div>
                <div className="space-y-2 md:col-span-2">
                  <Label htmlFor="addressLine2">Address Line 2</Label>
                  <Input id="addressLine2" name="addressLine2" defaultValue={carrier.addressLine2 || ''} />
                </div>
                <div className="space-y-2">
                  <Label htmlFor="city">City</Label>
                  <Input id="city" name="city" value={city} onChange={(e) => setCity(e.target.value)} />
                </div>
                <div className="space-y-2">
                  <Label htmlFor="state">State</Label>
                  <Input id="state" name="state" placeholder="CA" maxLength={2} value={state} onChange={(e) => setState(e.target.value)} />
                </div>
                <div className="space-y-2">
                  <Label htmlFor="zip">ZIP Code</Label>
                  <Input id="zip" name="zip" value={zip} onChange={(e) => setZip(e.target.value)} />
                </div>
                <div className="space-y-2">
                  <Label htmlFor="country">Country</Label>
                  <Input id="country" name="country" value={country} onChange={(e) => setCountry(e.target.value)} />
                </div>
              </div>
            </Card>

            {/* Operating Authority */}
            <Card className="p-6 mb-6">
              <h2 className="text-xl font-semibold mb-4">Operating Authority</h2>
              <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
                <div className="space-y-2">
                  <Label htmlFor="mcNumber">
                    MC Number <span className="text-destructive">*</span>
                  </Label>
                  <Input id="mcNumber" name="mcNumber" required defaultValue={carrier.mcNumber} />
                </div>
                <div className="space-y-2">
                  <Label htmlFor="usdotNumber">USDOT Number</Label>
                  <Input id="usdotNumber" name="usdotNumber" defaultValue={carrier.usdotNumber || ''} />
                </div>
                <div className="space-y-2">
                  <Label htmlFor="safetyRating">Safety Rating</Label>
                  <Select name="safetyRating" defaultValue={carrier.safetyRating || undefined}>
                    <SelectTrigger id="safetyRating" className="w-full">
                      <SelectValue placeholder="Select rating" />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="Satisfactory">Satisfactory</SelectItem>
                      <SelectItem value="Conditional">Conditional</SelectItem>
                      <SelectItem value="Unsatisfactory">Unsatisfactory</SelectItem>
                      <SelectItem value="Not Rated">Not Rated</SelectItem>
                    </SelectContent>
                  </Select>
                </div>
                <div className="flex items-center space-x-2 pt-8">
                  <Checkbox
                    id="dotRegistration"
                    name="dotRegistration"
                    value="true"
                    defaultChecked={carrier.dotRegistration}
                  />
                  <Label htmlFor="dotRegistration" className="font-normal cursor-pointer">
                    DOT Registration
                  </Label>
                </div>
                <div className="flex items-center space-x-2 pt-8">
                  <Checkbox
                    id="operatingAuthorityActive"
                    name="operatingAuthorityActive"
                    value="true"
                    defaultChecked={carrier.operatingAuthorityActive}
                  />
                  <Label htmlFor="operatingAuthorityActive" className="font-normal cursor-pointer">
                    Operating Authority Active
                  </Label>
                </div>
              </div>
            </Card>

            {/* Insurance */}
            <Card className="p-6 mb-6">
              <h2 className="text-xl font-semibold mb-4">Insurance Information</h2>
              <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
                <div className="space-y-2">
                  <Label htmlFor="insuranceProvider">
                    Insurance Provider <span className="text-destructive">*</span>
                  </Label>
                  <Input
                    id="insuranceProvider"
                    name="insuranceProvider"
                    required
                    defaultValue={carrier.insuranceProvider}
                  />
                </div>
                <div className="space-y-2">
                  <Label htmlFor="insuranceExpiration">
                    Insurance Expiration <span className="text-destructive">*</span>
                  </Label>
                  <DatePicker
                    id="insuranceExpiration"
                    name="insuranceExpiration"
                    required
                    defaultValue={carrier.insuranceExpiration}
                  />
                </div>
                <div className="flex items-center space-x-2 pt-8">
                  <Checkbox
                    id="insuranceCoverage"
                    name="insuranceCoverage"
                    value="true"
                    defaultChecked={carrier.insuranceCoverage}
                  />
                  <Label htmlFor="insuranceCoverage" className="font-normal cursor-pointer">
                    Insurance Coverage Active
                  </Label>
                </div>
              </div>
            </Card>

            {/* Financial Information (Sensitive) */}
            <Card className="p-6 mb-6 border-orange-200 bg-orange-50/50">
              <div className="flex items-center gap-2 mb-4">
                <h2 className="text-xl font-semibold">Financial Information</h2>
                <span className="text-xs bg-orange-100 text-orange-700 px-2 py-1 rounded">
                  Sensitive Data
                </span>
              </div>
              <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
                <div className="space-y-2">
                  <Label htmlFor="ein">EIN (Tax ID)</Label>
                  <Input
                    id="ein"
                    name="ein"
                    placeholder="XX-XXXXXXX"
                    defaultValue={sensitiveData.ein || ''}
                  />
                </div>
                <div className="space-y-2">
                  <Label htmlFor="insuranceCargoAmount">Insurance Cargo Amount ($)</Label>
                  <Input
                    id="insuranceCargoAmount"
                    name="insuranceCargoAmount"
                    type="number"
                    step="0.01"
                    placeholder="100000.00"
                    defaultValue={sensitiveData.insuranceCargoAmount || ''}
                  />
                </div>
                <div className="space-y-2">
                  <Label htmlFor="insuranceLiabilityAmount">Insurance Liability Amount ($)</Label>
                  <Input
                    id="insuranceLiabilityAmount"
                    name="insuranceLiabilityAmount"
                    type="number"
                    step="0.01"
                    placeholder="1000000.00"
                    defaultValue={sensitiveData.insuranceLiabilityAmount || ''}
                  />
                </div>
                <div className="space-y-2">
                  <Label htmlFor="paymentTerms">Payment Terms</Label>
                  <Select name="paymentTerms" defaultValue={sensitiveData.paymentTerms || undefined}>
                    <SelectTrigger id="paymentTerms" className="w-full">
                      <SelectValue placeholder="Select terms" />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="Net15">Net 15</SelectItem>
                      <SelectItem value="Net30">Net 30</SelectItem>
                      <SelectItem value="QuickPay">Quick Pay</SelectItem>
                    </SelectContent>
                  </Select>
                </div>
                <div className="space-y-2">
                  <Label htmlFor="currency">Currency</Label>
                  <Select name="currency" defaultValue={carrier.currency || 'USD'}>
                    <SelectTrigger id="currency" className="w-full">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="USD">USD</SelectItem>
                      <SelectItem value="CAD">CAD</SelectItem>
                    </SelectContent>
                  </Select>
                </div>
                <div className="flex items-center space-x-2 pt-8">
                  <Checkbox
                    id="factoringStatus"
                    name="factoringStatus"
                    value="true"
                    defaultChecked={sensitiveData.factoringStatus}
                  />
                  <Label htmlFor="factoringStatus" className="font-normal cursor-pointer">
                    Factoring Active
                  </Label>
                </div>
                <div className="space-y-2 md:col-span-2">
                  <Label htmlFor="remitToAddress">Remit To Address</Label>
                  <Input
                    id="remitToAddress"
                    name="remitToAddress"
                    placeholder="Payment routing address"
                    defaultValue={sensitiveData.remitToAddress || ''}
                  />
                </div>
              </div>
            </Card>

            {/* Submit Buttons */}
            <div className="flex justify-end gap-4">
              <Button
                type="button"
                variant="outline"
                onClick={() => router.push(`/operations/carriers/${carrierIdTyped}`)}
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
