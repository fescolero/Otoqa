'use client';

/**
 * Client-side view of the caller's RBAC claims — same policy as the server
 * (convex/lib/permissions.ts), fed from the AuthKit session. UI gating
 * only: every mutation is independently enforced server-side.
 */

import { useAuth } from '@workos-inc/authkit-nextjs/components';
import { isPermitted, permissionSlug } from '@/convex/lib/permissions';

export type PermCheckLevel = 'view' | 'edit' | 'manage';

export function usePermissions() {
  const { role, roles, permissions, loading } = useAuth();
  const claims = { role, roles, permissions };
  const can = (area: string, level: PermCheckLevel) =>
    isPermitted(claims, permissionSlug(area, level));
  return {
    /** True while the session is still resolving — render optimistically. */
    loading,
    role,
    can,
    /** True once real permission claims are present (RBAC active). */
    enforced: permissions != null && !(role === 'admin' || roles?.includes('admin')),
  };
}
