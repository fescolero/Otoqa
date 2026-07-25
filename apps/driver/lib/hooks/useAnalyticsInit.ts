/**
 * useAnalyticsInit — identifies the current user in PostHog exactly once
 * per app session, after roles + role selection have settled.
 *
 * Inputs come from the layout's bootstrap state so this hook stays a
 * pure orchestrator — no Convex queries, no Clerk hooks. The caller is
 * responsible for waiting until userId / userRoles / hasSelectedRole
 * are all truthy.
 */
import { useEffect, useRef } from 'react';
import type { UserResource } from '@clerk/types';
import { identifyUser } from '../analytics';

interface AnalyticsRoles {
  isDriver: boolean;
  isCarrierOwner: boolean;
  carrierOrgId: string | null | undefined;
}

export function useAnalyticsInit(params: {
  userId: string | null | undefined;
  user: UserResource | null | undefined;
  userRoles: AnalyticsRoles | null | undefined;
  hasSelectedRole: boolean;
  clerkOrgId: string | undefined;
}) {
  const { userId, user, userRoles, hasSelectedRole, clerkOrgId } = params;
  const hasIdentifiedRef = useRef(false);

  useEffect(() => {
    if (hasIdentifiedRef.current || !userId || !userRoles || !hasSelectedRole) return;
    hasIdentifiedRef.current = true;

    const role = userRoles.isDriver && userRoles.isCarrierOwner
      ? 'both'
      : userRoles.isDriver ? 'driver' : 'owner';

    identifyUser({
      id: userId,
      phone: user?.primaryPhoneNumber?.phoneNumber,
      name: user?.fullName ?? undefined,
      organizationId: userRoles.carrierOrgId ?? clerkOrgId ?? undefined,
      role,
    });
  }, [userId, userRoles, hasSelectedRole, user, clerkOrgId]);
}
