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
import { Switch } from '@/components/ui/switch';
import { useAuth } from '@workos-inc/authkit-nextjs/components';
import { useMutation, useQuery } from 'convex/react';
import { api } from '@/convex/_generated/api';
import { useRouter, useParams } from 'next/navigation';
import { useState, FormEvent } from 'react';
import { useOrganizationId } from '@/contexts/organization-context';
import { Loader2 } from 'lucide-react';
import { StopInput } from '@/components/contract-lanes/stop-input';
import { Id } from '@/convex/_generated/dataModel';

type Stop = {
  address: string;
  city: string;
  state: string;
  zip: string;
  stopOrder: number;
  stopType: 'Pickup' | 'Delivery';
  type: 'APPT' | 'FCFS' | 'Live';
  arrivalTime: string;
};

export default function CreateContractLanePage() {
  const { user } = useAuth();
  const router = useRouter();
  const params = useParams();
  const customerId = params.id as Id<'customers'>;
  const workosOrgId = useOrganizationId();
  
  const createContractLane = useMutation(api.contractLanes.create);
  const customer = useQuery(api.customers.get, { id: customerId });
  
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [stops, setStops] = useState<Stop[]>([
    {
      address: '',
      city: '',
      state: '',
      zip: '',
      stopOrder: 1,
      stopType: 'Pickup',
      type: 'APPT',
      arrivalTime: '',
    },
  ]);
  const [isActive, setIsActive] = useState(true);

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

      await createContractLane({
        contractName: formData.get('contractName') as string,
        contractPeriodStart: formData.get('contractPeriodStart') as string,
        contractPeriodEnd: formData.get('contractPeriodEnd') as string,
        hcr: (formData.get('hcr') as string) || undefined,
        tripNumber: (formData.get('tripNumber') as string) || undefined,
        lanePriority: (formData.get('lanePriority') as any) || undefined,
        notes: (formData.get('notes') as string) || undefined,
        customerCompanyId: customerId,
        stops: stops,
        miles: formData.get('miles') ? Number(formData.get('miles')) : undefined,
        loadCommodity: (formData.get('loadCommodity') as string) || undefined,
        equipmentClass: (formData.get('equipmentClass') as any) || undefined,
        equipmentSize: (formData.get('equipmentSize') as any) || undefined,
        rate: Number(formData.get('rate')),
        rateType: formData.get('rateType') as any,
        currency: (formData.get('currency') as string) || undefined,
        minimumRate: formData.get('minimumRate') ? Number(formData.get('minimumRate')) : undefined,
        minimumQuantity: formData.get('minimumQuantity')
          ? Number(formData.get('minimumQuantity'))
          : undefined,
        subsidiary: (formData.get('subsidiary') as string) || undefined,
        isActive: isActive,
        workosOrgId,
        createdBy: user.id,
      });

      router.push(`/operations/customers/${customerId}/contract-lanes`);
    } catch (error) {
      console.error('Failed to create contract lane:', error);
      alert('Failed to create contract lane. Please try again.');
    } finally {
      setIsSubmitting(false);
    }
  };

  if (!customer) {
    return (
      <>
          <div className="flex items-center justify-center h-screen">
            <p>Loading...</p>
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
                  <BreadcrumbLink href="#">Company Operations</BreadcrumbLink>
                </BreadcrumbItem>
                <BreadcrumbSeparator className="hidden md:block" />
                <BreadcrumbItem className="hidden md:block">
                  <BreadcrumbLink href="/operations/customers">Customers</BreadcrumbLink>
                </BreadcrumbItem>
                <BreadcrumbSeparator className="hidden md:block" />
                <BreadcrumbItem className="hidden md:block">
                  <BreadcrumbLink href={`/operations/customers/${customerId}`}>
                    {customer.name}
                  </BreadcrumbLink>
                </BreadcrumbItem>
                <BreadcrumbSeparator className="hidden md:block" />
                <BreadcrumbItem className="hidden md:block">
                  <BreadcrumbLink href={`/operations/customers/${customerId}/contract-lanes`}>
                    Contract Lanes
                  </BreadcrumbLink>
                </BreadcrumbItem>
                <BreadcrumbSeparator className="hidden md:block" />
                <BreadcrumbItem>
                  <BreadcrumbPage>Create</BreadcrumbPage>
                </BreadcrumbItem>
              </BreadcrumbList>
            </Breadcrumb>
          </div>
        </header>

        <div className="flex flex-1 flex-col gap-6 p-6 pb-24">
          <div>
            <h1 className="text-3xl font-bold tracking-tight">Create Contract Lane</h1>
            <p className="text-muted-foreground">Add a new contract lane for {customer.name}</p>
          </div>

          <form id="contract-lane-form" onSubmit={handleSubmit}>
            {/* Contract Information */}
            <Card className="p-6 mb-6">
              <h2 className="text-xl font-semibold mb-4">Contract Information</h2>
              <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
                <div className="space-y-2">
                  <Label htmlFor="contractName">
                    Contract Name <span className="text-destructive">*</span>
                  </Label>
                  <Input id="contractName" name="contractName" required />
                </div>
                <div className="space-y-2">
                  <Label htmlFor="hcr">HCR</Label>
                  <Input id="hcr" name="hcr" placeholder="e.g., 917DK" />
                </div>
                <div className="space-y-2">
                  <Label htmlFor="tripNumber">Trip Number</Label>
                  <Input id="tripNumber" name="tripNumber" />
                </div>
                <div className="space-y-2">
                  <Label htmlFor="lanePriority">Priority</Label>
                  <Select name="lanePriority">
                    <SelectTrigger id="lanePriority">
                      <SelectValue placeholder="Select priority" />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="Primary">Primary</SelectItem>
                      <SelectItem value="Secondary">Secondary</SelectItem>
                    </SelectContent>
                  </Select>
                </div>
                <div className="space-y-2">
                  <Label htmlFor="contractPeriodStart">
                    Contract Start <span className="text-destructive">*</span>
                  </Label>
                  <Input id="contractPeriodStart" name="contractPeriodStart" type="date" required />
                </div>
                <div className="space-y-2">
                  <Label htmlFor="contractPeriodEnd">
                    Contract End <span className="text-destructive">*</span>
                  </Label>
                  <Input id="contractPeriodEnd" name="contractPeriodEnd" type="date" required />
                </div>
                <div className="space-y-2 lg:col-span-3">
                  <Label htmlFor="notes">Notes</Label>
                  <Textarea id="notes" name="notes" rows={3} />
                </div>
                <div className="space-y-2 flex items-center gap-2">
                  <Switch id="isActive" checked={isActive} onCheckedChange={setIsActive} />
                  <Label htmlFor="isActive" className="cursor-pointer">
                    Active
                  </Label>
                </div>
              </div>
            </Card>

            {/* Lane Details (Stops) */}
            <Card className="p-6 mb-6">
              <h2 className="text-xl font-semibold mb-4">Lane Details</h2>
              <div className="space-y-4">
                <div>
                  <Label className="mb-2 block">
                    Stops <span className="text-destructive">*</span>
                  </Label>
                  <StopInput stops={stops} onChange={setStops} />
                </div>
                <div className="grid grid-cols-1 md:grid-cols-2 gap-4 mt-4">
                  <div className="space-y-2">
                    <Label htmlFor="miles">Miles</Label>
                    <Input id="miles" name="miles" type="number" step="0.1" />
                  </div>
                  <div className="space-y-2">
                    <Label htmlFor="loadCommodity">Load Commodity</Label>
                    <Input id="loadCommodity" name="loadCommodity" />
                  </div>
                </div>
              </div>
            </Card>

            {/* Equipment Requirements */}
            <Card className="p-6 mb-6">
              <h2 className="text-xl font-semibold mb-4">Equipment Requirements</h2>
              <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                <div className="space-y-2">
                  <Label htmlFor="equipmentClass">Equipment Class</Label>
                  <Select name="equipmentClass">
                    <SelectTrigger id="equipmentClass">
                      <SelectValue placeholder="Select class" />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="Bobtail">Bobtail</SelectItem>
                      <SelectItem value="Dry Van">Dry Van</SelectItem>
                      <SelectItem value="Refrigerated">Refrigerated</SelectItem>
                      <SelectItem value="Flatbed">Flatbed</SelectItem>
                      <SelectItem value="Tanker">Tanker</SelectItem>
                    </SelectContent>
                  </Select>
                </div>
                <div className="space-y-2">
                  <Label htmlFor="equipmentSize">Equipment Size</Label>
                  <Select name="equipmentSize">
                    <SelectTrigger id="equipmentSize">
                      <SelectValue placeholder="Select size" />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="53ft">53ft</SelectItem>
                      <SelectItem value="48ft">48ft</SelectItem>
                      <SelectItem value="45ft">45ft</SelectItem>
                    </SelectContent>
                  </Select>
                </div>
              </div>
            </Card>

            {/* Rate Information */}
            <Card className="p-6 mb-6">
              <h2 className="text-xl font-semibold mb-4">Rate Information</h2>
              <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
                <div className="space-y-2">
                  <Label htmlFor="rate">
                    Rate <span className="text-destructive">*</span>
                  </Label>
                  <Input id="rate" name="rate" type="number" step="0.01" required />
                </div>
                <div className="space-y-2">
                  <Label htmlFor="rateType">
                    Rate Type <span className="text-destructive">*</span>
                  </Label>
                  <Select name="rateType" required defaultValue="Flat Rate">
                    <SelectTrigger id="rateType">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="Per Mile">Per Mile</SelectItem>
                      <SelectItem value="Flat Rate">Flat Rate</SelectItem>
                      <SelectItem value="Per Stop">Per Stop</SelectItem>
                    </SelectContent>
                  </Select>
                </div>
                <div className="space-y-2">
                  <Label htmlFor="currency">Currency</Label>
                  <Select name="currency" defaultValue="USD">
                    <SelectTrigger id="currency">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="USD">USD</SelectItem>
                      <SelectItem value="CAD">CAD</SelectItem>
                      <SelectItem value="EUR">EUR</SelectItem>
                    </SelectContent>
                  </Select>
                </div>
                <div className="space-y-2">
                  <Label htmlFor="minimumRate">Minimum Rate</Label>
                  <Input id="minimumRate" name="minimumRate" type="number" step="0.01" />
                </div>
                <div className="space-y-2">
                  <Label htmlFor="minimumQuantity">Minimum Quantity</Label>
                  <Input id="minimumQuantity" name="minimumQuantity" type="number" />
                </div>
                <div className="space-y-2">
                  <Label htmlFor="subsidiary">Subsidiary</Label>
                  <Input id="subsidiary" name="subsidiary" />
                </div>
              </div>
            </Card>

            {/* Form Actions */}
            <div className="flex justify-end gap-4">
              <Button
                type="button"
                variant="outline"
                onClick={() => router.push(`/operations/customers/${customerId}/contract-lanes`)}
              >
                Cancel
              </Button>
              <Button type="submit" disabled={isSubmitting}>
                {isSubmitting && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
                Create Contract Lane
              </Button>
            </div>
          </form>
        </div>
      </>
  );
}
