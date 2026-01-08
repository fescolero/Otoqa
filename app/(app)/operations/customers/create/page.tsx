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
import { Loader2 } from 'lucide-react';
import { PhoneInput } from '@/components/ui/phone-input';
import { AddressAutocomplete, AddressData } from '@/components/ui/address-autocomplete';

export default function CreateCustomerPage() {
  const { user } = useAuth();
  const router = useRouter();
  const workosOrgId = useOrganizationId();
  const createCustomer = useMutation(api.customers.create);
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [addressData, setAddressData] = useState<AddressData | null>(null);
  const [addressLine1, setAddressLine1] = useState('');
  const [city, setCity] = useState('');
  const [state, setState] = useState('');
  const [zip, setZip] = useState('');
  const [country, setCountry] = useState('');

  // Auto-fill fields when address is selected from autocomplete
  useEffect(() => {
    if (addressData) {
      setAddressLine1(addressData.address);
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

  const handleSubmit = async (e: FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    if (!workosOrgId || !user) return;

    setIsSubmitting(true);

    try {
      const formData = new FormData(e.currentTarget);

      await createCustomer({
        name: formData.get('name') as string,
        companyType: formData.get('companyType') as any,
        status: formData.get('status') as any,
        office: (formData.get('office') as string) || undefined,
        addressLine1: formData.get('addressLine1') as string,
        addressLine2: (formData.get('addressLine2') as string) || undefined,
        city: formData.get('city') as string,
        state: formData.get('state') as string,
        zip: formData.get('zip') as string,
        country: formData.get('country') as string,
        primaryContactName: (formData.get('primaryContactName') as string) || undefined,
        primaryContactTitle: (formData.get('primaryContactTitle') as string) || undefined,
        primaryContactEmail: (formData.get('primaryContactEmail') as string) || undefined,
        primaryContactPhone: (formData.get('primaryContactPhone') as string) || undefined,
        secondaryContactName: (formData.get('secondaryContactName') as string) || undefined,
        secondaryContactEmail: (formData.get('secondaryContactEmail') as string) || undefined,
        secondaryContactPhone: (formData.get('secondaryContactPhone') as string) || undefined,
        loadingType: (formData.get('loadingType') as any) || undefined,
        locationScheduleType: (formData.get('locationScheduleType') as any) || undefined,
        instructions: (formData.get('instructions') as string) || undefined,
        internalNotes: (formData.get('internalNotes') as string) || undefined,
        workosOrgId,
        createdBy: user.id,
      });

      router.push('/operations/customers');
    } catch (error) {
      console.error('Failed to create customer:', error);
      alert('Failed to create customer. Please try again.');
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
                  <BreadcrumbLink href="/operations/customers">Customers</BreadcrumbLink>
                </BreadcrumbItem>
                <BreadcrumbSeparator className="hidden md:block" />
                <BreadcrumbItem>
                  <BreadcrumbPage>Create Customer</BreadcrumbPage>
                </BreadcrumbItem>
              </BreadcrumbList>
            </Breadcrumb>
          </div>
        </header>

        <div className="flex flex-1 flex-col gap-6 p-6 pb-24">
          <div>
            <h1 className="text-3xl font-bold tracking-tight">Create New Customer</h1>
            <p className="text-muted-foreground">Add a new customer to your network</p>
          </div>

          <form id="customer-form" onSubmit={handleSubmit}>
            {/* Customer Information */}
            <Card className="p-6 mb-6">
              <h2 className="text-xl font-semibold mb-4">Customer Information</h2>
              <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
                <div className="space-y-2">
                  <Label htmlFor="name">
                    Customer Name <span className="text-destructive">*</span>
                  </Label>
                  <Input id="name" name="name" required />
                </div>
                <div className="space-y-2">
                  <Label htmlFor="companyType">
                    Company Type <span className="text-destructive">*</span>
                  </Label>
                  <Select name="companyType" required defaultValue="Shipper">
                    <SelectTrigger id="companyType" className="w-full">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="Shipper">Shipper</SelectItem>
                      <SelectItem value="Broker">Broker</SelectItem>
                      <SelectItem value="Manufacturer">Manufacturer</SelectItem>
                      <SelectItem value="Distributor">Distributor</SelectItem>
                    </SelectContent>
                  </Select>
                </div>
                <div className="space-y-2">
                  <Label htmlFor="status">
                    Status <span className="text-destructive">*</span>
                  </Label>
                  <Select name="status" required defaultValue="Prospect">
                    <SelectTrigger id="status" className="w-full">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="Active">Active</SelectItem>
                      <SelectItem value="Inactive">Inactive</SelectItem>
                      <SelectItem value="Prospect">Prospect</SelectItem>
                    </SelectContent>
                  </Select>
                </div>
                <div className="space-y-2">
                  <Label htmlFor="office">Office/Location ID</Label>
                  <Input id="office" name="office" />
                </div>
              </div>
            </Card>

            {/* Address */}
            <Card className="p-6 mb-6">
              <h2 className="text-xl font-semibold mb-4">Address</h2>
              <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                <div className="space-y-2 md:col-span-2">
                  <Label htmlFor="addressLine1">
                    Address Line 1 <span className="text-destructive">*</span>
                  </Label>
                  <AddressAutocomplete
                    value={addressLine1}
                    onChange={(value) => setAddressLine1(value)}
                    onSelect={(data) => setAddressData(data)}
                    placeholder="Start typing address..."
                  />
                  <input type="hidden" name="addressLine1" value={addressLine1} required />
                  <p className="text-xs text-muted-foreground">Type to search or enter manually</p>
                </div>
                <div className="space-y-2 md:col-span-2">
                  <Label htmlFor="addressLine2">Address Line 2 (Apt, Suite, etc.)</Label>
                  <Input id="addressLine2" name="addressLine2" placeholder="Optional" />
                </div>
                <div className="space-y-2">
                  <Label htmlFor="city">
                    City <span className="text-destructive">*</span>
                  </Label>
                  <Input
                    id="city"
                    name="city"
                    required
                    value={city}
                    onChange={(e) => setCity(e.target.value)}
                  />
                </div>
                <div className="space-y-2">
                  <Label htmlFor="state">
                    State/Province <span className="text-destructive">*</span>
                  </Label>
                  <Input
                    id="state"
                    name="state"
                    required
                    value={state}
                    onChange={(e) => setState(e.target.value)}
                  />
                </div>
                <div className="space-y-2">
                  <Label htmlFor="zip">
                    ZIP/Postal Code <span className="text-destructive">*</span>
                  </Label>
                  <Input
                    id="zip"
                    name="zip"
                    required
                    value={zip}
                    onChange={(e) => setZip(e.target.value)}
                  />
                </div>
                <div className="space-y-2">
                  <Label htmlFor="country">
                    Country <span className="text-destructive">*</span>
                  </Label>
                  <Input
                    id="country"
                    name="country"
                    required
                    value={country}
                    onChange={(e) => setCountry(e.target.value)}
                  />
                </div>
              </div>
            </Card>

            {/* Primary Contact */}
            <Card className="p-6 mb-6">
              <h2 className="text-xl font-semibold mb-4">Primary Contact</h2>
              <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
                <div className="space-y-2">
                  <Label htmlFor="primaryContactName">Contact Name</Label>
                  <Input id="primaryContactName" name="primaryContactName" />
                </div>
                <div className="space-y-2">
                  <Label htmlFor="primaryContactTitle">Title</Label>
                  <Input id="primaryContactTitle" name="primaryContactTitle" />
                </div>
                <div className="space-y-2">
                  <Label htmlFor="primaryContactEmail">Email</Label>
                  <Input id="primaryContactEmail" name="primaryContactEmail" type="email" />
                </div>
                <div className="space-y-2">
                  <Label htmlFor="primaryContactPhone">Phone</Label>
                  <PhoneInput id="primaryContactPhone" name="primaryContactPhone" />
                </div>
              </div>
            </Card>

            {/* Secondary Contact */}
            <Card className="p-6 mb-6">
              <h2 className="text-xl font-semibold mb-4">Secondary Contact</h2>
              <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
                <div className="space-y-2">
                  <Label htmlFor="secondaryContactName">Contact Name</Label>
                  <Input id="secondaryContactName" name="secondaryContactName" />
                </div>
                <div className="space-y-2">
                  <Label htmlFor="secondaryContactEmail">Email</Label>
                  <Input id="secondaryContactEmail" name="secondaryContactEmail" type="email" />
                </div>
                <div className="space-y-2">
                  <Label htmlFor="secondaryContactPhone">Phone</Label>
                  <PhoneInput id="secondaryContactPhone" name="secondaryContactPhone" />
                </div>
              </div>
            </Card>

            {/* Operations */}
            <Card className="p-6 mb-6">
              <h2 className="text-xl font-semibold mb-4">Operations</h2>
              <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                <div className="space-y-2">
                  <Label htmlFor="loadingType">Loading Type</Label>
                  <Select name="loadingType">
                    <SelectTrigger id="loadingType" className="w-full">
                      <SelectValue placeholder="Select type" />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="Live Load">Live Load</SelectItem>
                      <SelectItem value="Drop & Hook">Drop & Hook</SelectItem>
                      <SelectItem value="Appointment">Appointment</SelectItem>
                    </SelectContent>
                  </Select>
                </div>
                <div className="space-y-2">
                  <Label htmlFor="locationScheduleType">Schedule Type</Label>
                  <Select name="locationScheduleType">
                    <SelectTrigger id="locationScheduleType" className="w-full">
                      <SelectValue placeholder="Select schedule" />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="24/7">24/7</SelectItem>
                      <SelectItem value="Business Hours">Business Hours</SelectItem>
                      <SelectItem value="Appointment Only">Appointment Only</SelectItem>
                      <SelectItem value="Specific Hours">Specific Hours</SelectItem>
                    </SelectContent>
                  </Select>
                </div>
                <div className="space-y-2 md:col-span-2">
                  <Label htmlFor="instructions">Special Instructions</Label>
                  <Textarea id="instructions" name="instructions" rows={3} />
                </div>
              </div>
            </Card>

            {/* Internal Notes */}
            <Card className="p-6 mb-6">
              <h2 className="text-xl font-semibold mb-4">Internal Notes</h2>
              <div className="space-y-2">
                <Label htmlFor="internalNotes">Notes</Label>
                <Textarea id="internalNotes" name="internalNotes" rows={4} />
              </div>
            </Card>

            {/* Submit Buttons */}
            <div className="flex justify-end gap-4">
              <Button
                type="button"
                variant="outline"
                onClick={() => router.push('/operations/customers')}
                disabled={isSubmitting}
              >
                Cancel
              </Button>
              <Button type="submit" disabled={isSubmitting}>
                {isSubmitting && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
                Create Customer
              </Button>
            </div>
          </form>
        </div>
      </>
  );
}
