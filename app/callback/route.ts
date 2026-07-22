import { handleAuth } from '@workos-inc/authkit-nextjs';
import { syncOrgMembersToConvex } from '@/lib/sync-org-members';

export const GET = handleAuth({
  returnPathname: '/dashboard',
  // Keep the Convex org member directory current so server-side queries
  // can resolve WorkOS user IDs to names. Never block login on it.
  onSuccess: async ({ accessToken, organizationId }) => {
    if (!organizationId) return;
    try {
      await syncOrgMembersToConvex({ organizationId, accessToken });
    } catch (error) {
      console.error('Failed to sync org members to Convex:', error);
    }
  },
});
