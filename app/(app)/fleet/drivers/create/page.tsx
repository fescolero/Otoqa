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
import { useAuth } from '@workos-inc/authkit-nextjs/components';
import { useMutation } from 'convex/react';
import { api } from '@/convex/_generated/api';
import { useRouter } from 'next/navigation';
import { useState, useEffect, FormEvent } from 'react';
import { Loader2 } from 'lucide-react';
import { DatePicker } from '@/components/ui/date-picker';
import { PhoneInput } from '@/components/ui/phone-input';
import { SSNInput } from '@/components/ui/ssn-input';
import { DateInput } from '@/components/ui/date-input';
import { AddressAutocomplete, AddressData } from '@/components/ui/address-autocomplete';
import { useOrganizationId } from '@/contexts/organization-context';

export default function CreateDriverPage() {
  const { user } = useAuth();
  const router = useRouter();
  const organizationId = useOrganizationId();
  const createDriver = useMutation(api.drivers.create);
  const [isSubmitting, setIsSubmitting] = useState(false);
  
  // Address state
  const [addressData, setAddressData] = useState<AddressData | null>(null);
  const [address, setAddress] = useState('');
  const [city, setCity] = useState('');
  const [state, setState] = useState('');
  const [zipCode, setZipCode] = useState('');
  const [country, setCountry] = useState('');

  // Auto-fill fields when address is selected from autocomplete
  useEffect(() => {
    if (addressData) {
      setAddress(addressData.address);
      setCity(addressData.city);
      setState(addressData.state);
      setZipCode(addressData.postalCode);
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

  const handleSubmit = async (e: FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    if (!organizationId || !user) return;

    setIsSubmitting(true);

    try {
      const formData = new FormData(e.currentTarget);

      await createDriver({
        // Personal Information
        firstName: formData.get('firstName') as string,
        middleName: (formData.get('middleName') as string) || undefined,
        lastName: formData.get('lastName') as string,
        email: formData.get('email') as string,
        phone: formData.get('phone') as string,
        dateOfBirth: (formData.get('dateOfBirth') as string) || undefined,
        ssn: (formData.get('ssn') as string) || undefined,
        // License Information
        licenseNumber: formData.get('licenseNumber') as string,
        licenseState: formData.get('licenseState') as string,
        licenseExpiration: formData.get('licenseExpiration') as string,
        licenseClass: formData.get('licenseClass') as string,
        // Medical
        medicalExpiration: (formData.get('medicalExpiration') as string) || undefined,
        // Security Access
        badgeExpiration: (formData.get('badgeExpiration') as string) || undefined,
        twicExpiration: (formData.get('twicExpiration') as string) || undefined,
        // Employment
        hireDate: formData.get('hireDate') as string,
        employmentStatus: formData.get('employmentStatus') as string,
        employmentType: formData.get('employmentType') as string,
        terminationDate: (formData.get('terminationDate') as string) || undefined,
        preEmploymentCheckDate: (formData.get('preEmploymentCheckDate') as string) || undefined,
        // Address
        address: (formData.get('address') as string) || undefined,
        address2: (formData.get('address2') as string) || undefined,
        city: (formData.get('city') as string) || undefined,
        state: (formData.get('state') as string) || undefined,
        zipCode: (formData.get('zipCode') as string) || undefined,
        country: (formData.get('country') as string) || undefined,
        // Emergency Contact
        emergencyContactName: (formData.get('emergencyContactName') as string) || undefined,
        emergencyContactRelationship: (formData.get('emergencyContactRelationship') as string) || undefined,
        emergencyContactPhone: (formData.get('emergencyContactPhone') as string) || undefined,
        // WorkOS Integration
        organizationId,
        createdBy: user.id,
      });

      router.push('/fleet/drivers');
    } catch (error) {
      console.error('Failed to create driver:', error);
      alert('Failed to create driver. Please try again.');
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
                  <BreadcrumbLink href="#">Fleet Management</BreadcrumbLink>
                </BreadcrumbItem>
                <BreadcrumbSeparator className="hidden md:block" />
                <BreadcrumbItem className="hidden md:block">
                  <BreadcrumbLink href="/fleet/drivers">Drivers</BreadcrumbLink>
                </BreadcrumbItem>
                <BreadcrumbSeparator className="hidden md:block" />
                <BreadcrumbItem>
                  <BreadcrumbPage>Create Driver</BreadcrumbPage>
                </BreadcrumbItem>
              </BreadcrumbList>
            </Breadcrumb>
          </div>
        </header>

        <div className="flex flex-1 flex-col gap-6 p-6 pb-24">
          {/* Page Header */}
          <div className="flex items-center justify-between">
            <div>
              <h1 className="text-3xl font-bold tracking-tight">Create New Driver</h1>
              <p className="text-muted-foreground">Add a new driver to your fleet</p>
            </div>
          </div>

          <form id="driver-form" onSubmit={handleSubmit}>
            {/* Personal Information */}
            <Card className="p-6 mb-6">
              <h2 className="text-xl font-semibold mb-4">Personal Information</h2>
              <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
                <div className="space-y-2">
                  <Label htmlFor="firstName">
                    First Name <span className="text-destructive">*</span>
                  </Label>
                  <Input id="firstName" name="firstName" required />
                </div>
                <div className="space-y-2">
                  <Label htmlFor="middleName">Middle Name</Label>
                  <Input id="middleName" name="middleName" />
                </div>
                <div className="space-y-2">
                  <Label htmlFor="lastName">
                    Last Name <span className="text-destructive">*</span>
                  </Label>
                  <Input id="lastName" name="lastName" required />
                </div>
                <div className="space-y-2">
                  <Label htmlFor="email">
                    Email <span className="text-destructive">*</span>
                  </Label>
                  <Input id="email" name="email" type="email" required />
                </div>
                <div className="space-y-2">
                  <Label htmlFor="phone">
                    Phone <span className="text-destructive">*</span>
                  </Label>
                  <PhoneInput id="phone" name="phone" required />
                </div>
                <div className="space-y-2">
                  <Label htmlFor="dateOfBirth">Date of Birth</Label>
                  <DateInput id="dateOfBirth" name="dateOfBirth" />
                </div>
                <div className="space-y-2">
                  <Label htmlFor="ssn">SSN</Label>
                  <SSNInput id="ssn" name="ssn" />
                </div>
              </div>
            </Card>

            {/* License Information */}
            <Card className="p-6 mb-6">
              <h2 className="text-xl font-semibold mb-4">License Information</h2>
              <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-4">
                <div className="space-y-2">
                  <Label htmlFor="licenseNumber">
                    License Number <span className="text-destructive">*</span>
                  </Label>
                  <Input id="licenseNumber" name="licenseNumber" required />
                </div>
                <div className="space-y-2">
                  <Label htmlFor="licenseState">
                    License State <span className="text-destructive">*</span>
                  </Label>
                  <Select name="licenseState" required>
                    <SelectTrigger id="licenseState" className="w-full">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="AL">Alabama</SelectItem>
                      <SelectItem value="AK">Alaska</SelectItem>
                      <SelectItem value="AZ">Arizona</SelectItem>
                      <SelectItem value="AR">Arkansas</SelectItem>
                      <SelectItem value="CA">California</SelectItem>
                      <SelectItem value="CO">Colorado</SelectItem>
                      <SelectItem value="CT">Connecticut</SelectItem>
                      <SelectItem value="DE">Delaware</SelectItem>
                      <SelectItem value="FL">Florida</SelectItem>
                      <SelectItem value="GA">Georgia</SelectItem>
                      <SelectItem value="HI">Hawaii</SelectItem>
                      <SelectItem value="ID">Idaho</SelectItem>
                      <SelectItem value="IL">Illinois</SelectItem>
                      <SelectItem value="IN">Indiana</SelectItem>
                      <SelectItem value="IA">Iowa</SelectItem>
                      <SelectItem value="KS">Kansas</SelectItem>
                      <SelectItem value="KY">Kentucky</SelectItem>
                      <SelectItem value="LA">Louisiana</SelectItem>
                      <SelectItem value="ME">Maine</SelectItem>
                      <SelectItem value="MD">Maryland</SelectItem>
                      <SelectItem value="MA">Massachusetts</SelectItem>
                      <SelectItem value="MI">Michigan</SelectItem>
                      <SelectItem value="MN">Minnesota</SelectItem>
                      <SelectItem value="MS">Mississippi</SelectItem>
                      <SelectItem value="MO">Missouri</SelectItem>
                      <SelectItem value="MT">Montana</SelectItem>
                      <SelectItem value="NE">Nebraska</SelectItem>
                      <SelectItem value="NV">Nevada</SelectItem>
                      <SelectItem value="NH">New Hampshire</SelectItem>
                      <SelectItem value="NJ">New Jersey</SelectItem>
                      <SelectItem value="NM">New Mexico</SelectItem>
                      <SelectItem value="NY">New York</SelectItem>
                      <SelectItem value="NC">North Carolina</SelectItem>
                      <SelectItem value="ND">North Dakota</SelectItem>
                      <SelectItem value="OH">Ohio</SelectItem>
                      <SelectItem value="OK">Oklahoma</SelectItem>
                      <SelectItem value="OR">Oregon</SelectItem>
                      <SelectItem value="PA">Pennsylvania</SelectItem>
                      <SelectItem value="RI">Rhode Island</SelectItem>
                      <SelectItem value="SC">South Carolina</SelectItem>
                      <SelectItem value="SD">South Dakota</SelectItem>
                      <SelectItem value="TN">Tennessee</SelectItem>
                      <SelectItem value="TX">Texas</SelectItem>
                      <SelectItem value="UT">Utah</SelectItem>
                      <SelectItem value="VT">Vermont</SelectItem>
                      <SelectItem value="VA">Virginia</SelectItem>
                      <SelectItem value="WA">Washington</SelectItem>
                      <SelectItem value="WV">West Virginia</SelectItem>
                      <SelectItem value="WI">Wisconsin</SelectItem>
                      <SelectItem value="WY">Wyoming</SelectItem>
                    </SelectContent>
                  </Select>
                </div>
                <div className="space-y-2">
                  <Label htmlFor="licenseExpiration">
                    License Expiration <span className="text-destructive">*</span>
                  </Label>
                  <DatePicker
                    id="licenseExpiration"
                    name="licenseExpiration"
                   
                    required
                  />
                </div>
                <div className="space-y-2">
                  <Label htmlFor="licenseClass">
                    License Class <span className="text-destructive">*</span>
                  </Label>
                  <Select name="licenseClass" required>
                    <SelectTrigger id="licenseClass" className="w-full">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="Class A">Class A</SelectItem>
                      <SelectItem value="Class B">Class B</SelectItem>
                      <SelectItem value="Class C">Class C</SelectItem>
                    </SelectContent>
                  </Select>
                </div>
              </div>
            </Card>

            {/* Medical & Security */}
            <Card className="p-6 mb-6">
              <h2 className="text-xl font-semibold mb-4">Medical & Security Access</h2>
              <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
                <div className="space-y-2">
                  <Label htmlFor="medicalExpiration">Medical Card Expiration</Label>
                  <DatePicker id="medicalExpiration" name="medicalExpiration" />
                </div>
                <div className="space-y-2">
                  <Label htmlFor="badgeExpiration">Badge Expiration</Label>
                  <DatePicker id="badgeExpiration" name="badgeExpiration" />
                </div>
                <div className="space-y-2">
                  <Label htmlFor="twicExpiration">TWIC Expiration</Label>
                  <DatePicker id="twicExpiration" name="twicExpiration" />
                </div>
              </div>
            </Card>

            {/* Employment Information */}
            <Card className="p-6 mb-6">
              <h2 className="text-xl font-semibold mb-4">Employment Information</h2>
              <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
                <div className="space-y-2">
                  <Label htmlFor="hireDate">
                    Hire Date <span className="text-destructive">*</span>
                  </Label>
                  <DatePicker id="hireDate" name="hireDate" required />
                </div>
                <div className="space-y-2">
                  <Label htmlFor="employmentStatus">
                    Employment Status <span className="text-destructive">*</span>
                  </Label>
                  <Select name="employmentStatus" required>
                    <SelectTrigger id="employmentStatus" className="w-full">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="Active">Active</SelectItem>
                      <SelectItem value="Inactive">Inactive</SelectItem>
                      <SelectItem value="On Leave">On Leave</SelectItem>
                    </SelectContent>
                  </Select>
                </div>
                <div className="space-y-2">
                  <Label htmlFor="employmentType">
                    Employment Type <span className="text-destructive">*</span>
                  </Label>
                  <Select name="employmentType" required>
                    <SelectTrigger id="employmentType" className="w-full">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="Full-time">Full-time</SelectItem>
                      <SelectItem value="Part-time">Part-time</SelectItem>
                      <SelectItem value="Contract">Contract</SelectItem>
                    </SelectContent>
                  </Select>
                </div>
                <div className="space-y-2">
                  <Label htmlFor="preEmploymentCheckDate">Pre-Employment Check Date</Label>
                  <DatePicker
                    id="preEmploymentCheckDate"
                    name="preEmploymentCheckDate"
                   
                  />
                </div>
                <div className="space-y-2">
                  <Label htmlFor="terminationDate">Termination Date</Label>
                  <DatePicker id="terminationDate" name="terminationDate" />
                </div>
              </div>
            </Card>

            {/* Address */}
            <Card className="p-6 mb-6">
              <h2 className="text-xl font-semibold mb-4">Address</h2>
              <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                <div className="space-y-2 md:col-span-2">
                  <Label htmlFor="address">Street Address</Label>
                  <AddressAutocomplete
                    value={address}
                    onChange={(value) => setAddress(value)}
                    onSelect={(data) => setAddressData(data)}
                    placeholder="Start typing address..."
                  />
                  <input type="hidden" name="address" value={address} />
                  <p className="text-xs text-muted-foreground">Type to search or enter manually</p>
                </div>
                <div className="space-y-2 md:col-span-2">
                  <Label htmlFor="address2">Address Line 2 (Apt, Suite, etc.)</Label>
                  <Input id="address2" name="address2" placeholder="Optional" />
                </div>
                <div className="space-y-2">
                  <Label htmlFor="city">City</Label>
                  <Input id="city" name="city" value={city} onChange={(e) => setCity(e.target.value)} />
                </div>
                <div className="space-y-2">
                  <Label htmlFor="state">State</Label>
                  <Input id="state" name="state" value={state} onChange={(e) => setState(e.target.value)} />
                </div>
                <div className="space-y-2">
                  <Label htmlFor="zipCode">ZIP Code</Label>
                  <Input id="zipCode" name="zipCode" value={zipCode} onChange={(e) => setZipCode(e.target.value)} />
                </div>
                <div className="space-y-2">
                  <Label htmlFor="country">Country</Label>
                  <Input id="country" name="country" value={country} onChange={(e) => setCountry(e.target.value)} />
                </div>
              </div>
            </Card>

            {/* Emergency Contact */}
            <Card className="p-6 mb-6">
              <h2 className="text-xl font-semibold mb-4">Emergency Contact</h2>
              <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
                <div className="space-y-2">
                  <Label htmlFor="emergencyContactName">Contact Name</Label>
                  <Input id="emergencyContactName" name="emergencyContactName" />
                </div>
                <div className="space-y-2">
                  <Label htmlFor="emergencyContactRelationship">Relationship</Label>
                  <Select name="emergencyContactRelationship">
                    <SelectTrigger id="emergencyContactRelationship" className="w-full">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="Spouse">Spouse</SelectItem>
                      <SelectItem value="Parent">Parent</SelectItem>
                      <SelectItem value="Sibling">Sibling</SelectItem>
                      <SelectItem value="Child">Child</SelectItem>
                      <SelectItem value="Partner">Partner</SelectItem>
                      <SelectItem value="Friend">Friend</SelectItem>
                      <SelectItem value="Other">Other</SelectItem>
                    </SelectContent>
                  </Select>
                </div>
                <div className="space-y-2">
                  <Label htmlFor="emergencyContactPhone">Contact Phone</Label>
                  <PhoneInput id="emergencyContactPhone" name="emergencyContactPhone" />
                </div>
              </div>
            </Card>

          </form>
        </div>

        {/* Sticky Action Bar - in the layout */}
        <div className="sticky bottom-0 left-0 right-0 z-50 border-t bg-background/95 backdrop-blur supports-[backdrop-filter]:bg-background/60 mt-auto">
          <div className="flex h-16 items-center justify-end gap-4 px-6">
              <Button
                type="button"
                variant="outline"
                onClick={() => router.push('/fleet/drivers')}
                disabled={isSubmitting}
              >
                Cancel
              </Button>
              <Button
                type="submit"
                form="driver-form"
                disabled={isSubmitting || !organizationId}
              >
                {isSubmitting && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
                Create Driver
            </Button>
          </div>
        </div>
      </>
  );
}
