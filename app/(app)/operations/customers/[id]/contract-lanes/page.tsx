'use client';

import { Button } from '@/components/ui/button';
import { useAuth } from '@workos-inc/authkit-nextjs/components';
import { useQuery, useMutation } from 'convex/react';
import { api } from '@/convex/_generated/api';
import { useRouter, useParams } from 'next/navigation';
import { useOrganizationId } from '@/contexts/organization-context';
import { ArrowLeft } from 'lucide-react';
import { ContractLaneList } from '@/components/contract-lanes/contract-lane-list';
import { Id } from '@/convex/_generated/dataModel';

export default function ContractLanesPage() {
  const { user } = useAuth();
  const router = useRouter();
  const params = useParams();
  const customerId = params.id as Id<'customers'>;
  const workosOrgId = useOrganizationId();

  const customer = useQuery(api.customers.get, { id: customerId });
  const contractLanes = useQuery(
    api.contractLanes.listByCustomer,
    customerId ? { customerCompanyId: customerId, includeDeleted: false } : 'skip',
  );
  const deactivateLane = useMutation(api.contractLanes.deactivate);

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

  const handleDelete = async (laneId: string) => {
    if (!user) return;
    try {
      await deactivateLane({
        id: laneId as Id<'contractLanes'>,
        userId: user.id,
      });
    } catch (error) {
      console.error('Failed to delete contract lane:', error);
      alert('Failed to delete contract lane. Please try again.');
    }
  };

  if (!customer) {
    return (
      <>
          <div className="flex items-center justify-center h-screen">
            <p>Loading customer...</p>
          </div>
        </>
    );
  }

  return (
    <>
        <div className="flex flex-1 flex-col gap-6 p-6 pb-4 min-h-0 overflow-hidden">
          <div className="flex items-center gap-4">
            <Button
              variant="ghost"
              size="sm"
              onClick={() => router.push(`/operations/customers/${customerId}`)}
            >
              <ArrowLeft className="h-4 w-4 mr-2" />
              Back to Customer
            </Button>
          </div>

          <div>
            <h1 className="text-3xl font-bold tracking-tight">Contract Lanes</h1>
            <p className="text-muted-foreground">Manage contract lanes for {customer.name}</p>
          </div>

          {contractLanes && workosOrgId && user ? (
            <ContractLaneList
              data={contractLanes}
              customerId={customerId}
              workosOrgId={workosOrgId}
              userId={user.id}
              onCreateClick={() =>
                router.push(`/operations/customers/${customerId}/contract-lanes/create`)
              }
              onDelete={handleDelete}
            />
          ) : (
            <div className="flex items-center justify-center h-64">
              <p className="text-muted-foreground">Loading contract lanes...</p>
            </div>
          )}
        </div>
      </>
  );
}
