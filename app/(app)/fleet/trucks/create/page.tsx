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
import { useMutation, useAction } from 'convex/react';
import { api } from '@/convex/_generated/api';
import { useRouter } from 'next/navigation';
import { useState, FormEvent } from 'react';
import { Loader2, Sparkles } from 'lucide-react';
import { DatePicker } from '@/components/ui/date-picker';
import { NumberInput } from '@/components/ui/number-input';
import { useOrganizationId } from '@/contexts/organization-context';

export default function CreateTruckPage() {
  const { user } = useAuth();
  const router = useRouter();
  const organizationId = useOrganizationId();
  const createTruck = useMutation(api.trucks.create);
  const decodeVin = useAction(api.vinDecoder.decodeVIN);
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [isDecoding, setIsDecoding] = useState(false);
  const [vinInput, setVinInput] = useState('');
  const [status, setStatus] = useState<string>('');

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

  const handleDecodeVin = async () => {
    if (!vinInput || vinInput.length !== 17) {
      alert('Please enter a valid 17-character VIN');
      return;
    }

    setIsDecoding(true);
    try {
      const decodedData = await decodeVin({ vin: vinInput });

      // Populate form fields with decoded data
      // Auto-fill VIN field and set status to Active
      (document.getElementById('vin') as HTMLInputElement).value = vinInput;
      setStatus('Active');
      
      if (decodedData.year) {
        (document.getElementById('year') as HTMLInputElement).value = String(decodedData.year);
      }
      if (decodedData.make) {
        (document.getElementById('make') as HTMLInputElement).value = decodedData.make;
      }
      if (decodedData.model) {
        (document.getElementById('model') as HTMLInputElement).value = decodedData.model;
      }
      if (decodedData.engineManufacturer) {
        (document.getElementById('engineManufacturer') as HTMLInputElement).value = decodedData.engineManufacturer;
      }
      if (decodedData.engineModel) {
        (document.getElementById('engineModel') as HTMLInputElement).value = decodedData.engineModel;
      }
      if (decodedData.fuelType) {
        // Try to set the fuel type select value
        const fuelTypeSelect = document.querySelector('[name="fuelType"]') as any;
        if (fuelTypeSelect) {
          // Trigger the select to open and set value
          const event = new Event('change', { bubbles: true });
          fuelTypeSelect.value = decodedData.fuelType;
          fuelTypeSelect.dispatchEvent(event);
        }
      }

      alert('VIN decoded successfully! Form fields have been populated.');
    } catch (error) {
      console.error('Failed to decode VIN:', error);
      alert('Failed to decode VIN. Please check the VIN and try again.');
    } finally {
      setIsDecoding(false);
    }
  };

  const handleSubmit = async (e: FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    if (!organizationId || !user) return;

    setIsSubmitting(true);

    try {
      const formData = new FormData(e.currentTarget);

      const yearStr = formData.get('year') as string;
      const gvwrStr = formData.get('gvwr') as string;
      const gcwrStr = formData.get('gcwr') as string;
      const purchasePriceStr = formData.get('purchasePrice') as string;
      const engineModelYearStr = formData.get('engineModelYear') as string;

      await createTruck({
        // Identity
        unitId: formData.get('unitId') as string,
        vin: formData.get('vin') as string,
        plate: (formData.get('plate') as string) || undefined,
        make: (formData.get('make') as string) || undefined,
        model: (formData.get('model') as string) || undefined,
        year: yearStr ? parseInt(yearStr, 10) : undefined,
        status: formData.get('status') as string,
        // Specifications
        bodyType: (formData.get('bodyType') as string) || undefined,
        fuelType: (formData.get('fuelType') as string) || undefined,
        gvwr: gvwrStr ? parseFloat(gvwrStr) : undefined,
        gcwr: gcwrStr ? parseFloat(gcwrStr) : undefined,
        // Registration & Compliance
        registrationExpiration: (formData.get('registrationExpiration') as string) || undefined,
        arb: formData.get('arb') === 'true',
        ifta: formData.get('ifta') === 'true',
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
        // Engine Information
        engineModel: (formData.get('engineModel') as string) || undefined,
        engineFamilyName: (formData.get('engineFamilyName') as string) || undefined,
        engineModelYear: engineModelYearStr ? parseInt(engineModelYearStr, 10) : undefined,
        engineSerialNumber: (formData.get('engineSerialNumber') as string) || undefined,
        engineManufacturer: (formData.get('engineManufacturer') as string) || undefined,
        // WorkOS Integration
        organizationId,
        createdBy: user.id,
      });

      router.push('/fleet/trucks');
    } catch (error) {
      console.error('Failed to create truck:', error);
      alert('Failed to create truck. Please try again.');
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
                  <BreadcrumbLink href="/fleet/trucks">Trucks</BreadcrumbLink>
                </BreadcrumbItem>
                <BreadcrumbSeparator className="hidden md:block" />
                <BreadcrumbItem>
                  <BreadcrumbPage>Create Truck</BreadcrumbPage>
                </BreadcrumbItem>
              </BreadcrumbList>
            </Breadcrumb>
          </div>
        </header>

        <div className="flex flex-1 flex-col gap-6 p-4 md:p-6 pb-24">
          {/* Page Header */}
          <div className="flex items-center justify-between">
            <div>
              <h1 className="text-3xl font-bold tracking-tight">Create New Truck</h1>
              <p className="text-muted-foreground">Add a new truck to your fleet</p>
            </div>
          </div>

          <form id="truck-form" onSubmit={handleSubmit}>
            {/* VIN Decoder */}
            <Card className="p-6 mb-6 bg-gradient-to-br from-blue-50 to-indigo-50 dark:from-blue-950/20 dark:to-indigo-950/20 border-blue-200 dark:border-blue-800">
              <div className="flex items-start gap-4">
                <div className="flex-1 space-y-2">
                  <Label htmlFor="vin-decoder" className="text-base font-semibold flex items-center gap-2">
                    <Sparkles className="h-4 w-4 text-blue-600" />
                    VIN Decoder
                  </Label>
                  <p className="text-sm text-muted-foreground mb-3">
                    Enter a 17-character VIN to automatically populate vehicle information
                  </p>
                  <div className="flex gap-3">
                    <Input
                      id="vin-decoder"
                      value={vinInput}
                      onChange={(e) => setVinInput(e.target.value.toUpperCase())}
                      placeholder="Enter VIN (17 characters)"
                      maxLength={17}
                      className="font-mono bg-background"
                    />
                    <Button type="button" onClick={handleDecodeVin} disabled={isDecoding || vinInput.length !== 17}>
                      {isDecoding ? (
                        <>
                          <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                          Decoding...
                        </>
                      ) : (
                        'Decode VIN'
                      )}
                    </Button>
                  </div>
                </div>
              </div>
            </Card>

            {/* Identity */}
            <Card className="p-6 mb-6">
              <h2 className="text-xl font-semibold mb-4">Vehicle Identity</h2>
              <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
                <div className="space-y-2">
                  <Label htmlFor="unitId">
                    Unit ID <span className="text-destructive">*</span>
                  </Label>
                  <Input id="unitId" name="unitId" required />
                </div>
                <div className="space-y-2">
                  <Label htmlFor="vin">
                    VIN <span className="text-destructive">*</span>
                  </Label>
                  <Input id="vin" name="vin" maxLength={17} className="font-mono" required />
                </div>
                <div className="space-y-2">
                  <Label htmlFor="status">
                    Status <span className="text-destructive">*</span>
                  </Label>
                  <Select name="status" value={status} onValueChange={setStatus} required>
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
                  <Input id="plate" name="plate" />
                </div>
                <div className="space-y-2">
                  <Label htmlFor="year">Year</Label>
                  <Input id="year" name="year" type="number" placeholder="2024" />
                </div>
                <div className="space-y-2">
                  <Label htmlFor="make">Make</Label>
                  <Input id="make" name="make" placeholder="Freightliner" />
                </div>
                <div className="space-y-2">
                  <Label htmlFor="model">Model</Label>
                  <Input id="model" name="model" placeholder="Cascadia" />
                </div>
              </div>
            </Card>

            {/* Specifications */}
            <Card className="p-6 mb-6">
              <h2 className="text-xl font-semibold mb-4">Specifications</h2>
              <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-4">
                <div className="space-y-2">
                  <Label htmlFor="bodyType">Body Type</Label>
                  <Select name="bodyType">
                    <SelectTrigger id="bodyType" className="w-full">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="Semi">Semi</SelectItem>
                      <SelectItem value="Bobtail">Bobtail</SelectItem>
                    </SelectContent>
                  </Select>
                </div>
                <div className="space-y-2">
                  <Label htmlFor="fuelType">Fuel Type</Label>
                  <Select name="fuelType">
                    <SelectTrigger id="fuelType" className="w-full">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="Diesel">Diesel</SelectItem>
                      <SelectItem value="Gas">Gas</SelectItem>
                      <SelectItem value="Electric">Electric</SelectItem>
                      <SelectItem value="CNG">CNG</SelectItem>
                      <SelectItem value="Hybrid">Hybrid</SelectItem>
                    </SelectContent>
                  </Select>
                </div>
                <div className="space-y-2">
                  <Label htmlFor="gvwr">GVWR</Label>
                  <NumberInput id="gvwr" name="gvwr" placeholder="80,000" />
                </div>
                <div className="space-y-2">
                  <Label htmlFor="gcwr">GCWR</Label>
                  <NumberInput id="gcwr" name="gcwr" placeholder="80,000" />
                </div>
              </div>
            </Card>

            {/* Registration & Compliance */}
            <Card className="p-6 mb-6">
              <h2 className="text-xl font-semibold mb-4">Registration & Compliance</h2>
              <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
                <div className="space-y-2">
                  <Label htmlFor="registrationExpiration">Registration Expiration</Label>
                  <DatePicker id="registrationExpiration" name="registrationExpiration" />
                </div>
                <div className="space-y-2">
                  <Label htmlFor="arb">ARB Compliance</Label>
                  <Select name="arb">
                    <SelectTrigger id="arb" className="w-full">
                      <SelectValue placeholder="Select..." />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="true">Yes</SelectItem>
                      <SelectItem value="false">No</SelectItem>
                    </SelectContent>
                  </Select>
                </div>
                <div className="space-y-2">
                  <Label htmlFor="ifta">IFTA</Label>
                  <Select name="ifta">
                    <SelectTrigger id="ifta" className="w-full">
                      <SelectValue placeholder="Select..." />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="true">Yes</SelectItem>
                      <SelectItem value="false">No</SelectItem>
                    </SelectContent>
                  </Select>
                </div>
                <div className="space-y-2 md:col-span-2 lg:col-span-3">
                  <Label htmlFor="comments">Comments</Label>
                  <Textarea id="comments" name="comments" rows={3} />
                </div>
              </div>
            </Card>

            {/* Insurance */}
            <Card className="p-6 mb-6">
              <h2 className="text-xl font-semibold mb-4">Insurance</h2>
              <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
                <div className="space-y-2">
                  <Label htmlFor="insuranceFirm">Insurance Firm</Label>
                  <Input id="insuranceFirm" name="insuranceFirm" />
                </div>
                <div className="space-y-2">
                  <Label htmlFor="insurancePolicyNumber">Policy Number</Label>
                  <Input id="insurancePolicyNumber" name="insurancePolicyNumber" />
                </div>
                <div className="space-y-2">
                  <Label htmlFor="insuranceExpiration">Insurance Expiration</Label>
                  <DatePicker id="insuranceExpiration" name="insuranceExpiration" />
                </div>
                <div className="space-y-2 md:col-span-2 lg:col-span-3">
                  <Label htmlFor="insuranceComments">Insurance Comments</Label>
                  <Textarea id="insuranceComments" name="insuranceComments" rows={3} />
                </div>
              </div>
            </Card>

            {/* Financial */}
            <Card className="p-6 mb-6">
              <h2 className="text-xl font-semibold mb-4">Financial Information</h2>
              <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-4">
                <div className="space-y-2">
                  <Label htmlFor="purchaseDate">Purchase Date</Label>
                  <DatePicker id="purchaseDate" name="purchaseDate" />
                </div>
                <div className="space-y-2">
                  <Label htmlFor="purchasePrice">Purchase Price</Label>
                  <NumberInput id="purchasePrice" name="purchasePrice" placeholder="150,000" />
                </div>
                <div className="space-y-2">
                  <Label htmlFor="ownershipType">Ownership Type</Label>
                  <Select name="ownershipType">
                    <SelectTrigger id="ownershipType" className="w-full">
                      <SelectValue />
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
                  <Input id="lienholder" name="lienholder" />
                </div>
              </div>
            </Card>

            {/* Engine Information */}
            <Card className="p-6 mb-6">
              <h2 className="text-xl font-semibold mb-4">Engine Information</h2>
              <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
                <div className="space-y-2">
                  <Label htmlFor="engineManufacturer">Manufacturer</Label>
                  <Input id="engineManufacturer" name="engineManufacturer" placeholder="Detroit Diesel" />
                </div>
                <div className="space-y-2">
                  <Label htmlFor="engineModel">Model</Label>
                  <Input id="engineModel" name="engineModel" placeholder="DD15" />
                </div>
                <div className="space-y-2">
                  <Label htmlFor="engineFamilyName">Family Name</Label>
                  <Input id="engineFamilyName" name="engineFamilyName" />
                </div>
                <div className="space-y-2">
                  <Label htmlFor="engineModelYear">Model Year</Label>
                  <Input id="engineModelYear" name="engineModelYear" type="number" placeholder="2024" />
                </div>
                <div className="space-y-2">
                  <Label htmlFor="engineSerialNumber">Serial Number</Label>
                  <Input id="engineSerialNumber" name="engineSerialNumber" />
                </div>
              </div>
            </Card>
          </form>
        </div>

        {/* Sticky Footer */}
        <footer className="sticky bottom-0 z-50 flex items-center justify-between gap-4 border-t bg-background px-6 py-4">
          <Button type="button" variant="outline" onClick={() => router.push('/fleet/trucks')} disabled={isSubmitting}>
            Cancel
          </Button>
          <Button type="submit" form="truck-form" disabled={isSubmitting}>
            {isSubmitting ? (
              <>
                <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                Creating...
              </>
            ) : (
              'Create Truck'
            )}
          </Button>
        </footer>
      </>
  );
}
