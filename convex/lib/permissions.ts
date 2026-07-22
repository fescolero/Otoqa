/**
 * The RBAC permission policy — shared by Convex functions, the Next.js
 * team API routes, and the client UI (all three import this file), so
 * "can this caller do X" has exactly one definition.
 *
 * Permission slugs are `area:level` (see lib/team-rbac.ts for the catalog)
 * and levels are stored cumulatively, so a single `includes` answers any
 * check.
 *
 * Policy, in order:
 *   1. Admin bypass — any caller whose role slug is `admin` passes every
 *      check. Safety net so a workspace can never lock its admins out by
 *      editing role permissions.
 *   2. Legacy grandfathering — a token with NO permissions claim at all
 *      predates RBAC (WorkOS only issues the claim once roles carry
 *      permissions). Those sessions keep full access; enforcement tightens
 *      automatically as tokens refresh with real claims.
 *   3. Strict check — the permissions claim must contain the slug.
 *
 * Note on freshness: role changes reach the claims on the next access-token
 * refresh (minutes), not instantly.
 */

export interface PermissionClaims {
  role?: string | null;
  roles?: string[] | null;
  permissions?: string[] | null;
}

export const ADMIN_ROLE_SLUG = 'admin';

export function isPermitted(claims: PermissionClaims, slug: string): boolean {
  const roleSlugs = [claims.role, ...(claims.roles ?? [])].filter(
    (r): r is string => typeof r === 'string' && r.length > 0,
  );
  if (roleSlugs.includes(ADMIN_ROLE_SLUG)) return true;
  if (claims.permissions == null) return true; // legacy token — RBAC not active yet
  return claims.permissions.includes(slug);
}

/** `area:level` slug builder, mirroring lib/team-rbac.ts. */
export function permissionSlug(area: string, level: 'view' | 'edit' | 'manage'): string {
  return `${area}:${level}`;
}
