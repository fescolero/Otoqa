/**
 * Shared shapes for Settings → Team & roles. Produced by the /api/team/*
 * routes (server-side WorkOS SDK calls) and consumed by the settings page.
 */

export interface TeamMemberDTO {
  membershipId: string;
  userId: string;
  name: string;
  email: string;
  roleSlug: string;
  status: 'active' | 'inactive';
  twoFactorEnabled: boolean;
  /** ISO timestamp of the last sign-in, per WorkOS. Audit-log activity
   *  (fresher) is layered on client-side from Convex. */
  lastSignInAt: string | null;
  createdAt: string;
  profilePictureUrl: string | null;
}

export interface PendingInviteDTO {
  invitationId: string;
  email: string;
  createdAt: string;
  expiresAt: string;
  inviterName: string | null;
  /** Shareable accept URL (Copy invite link). */
  acceptUrl: string;
}

export interface TeamRoleDTO {
  slug: string;
  name: string;
  description: string | null;
  type: 'environment' | 'organization';
  permissions: string[];
}

export interface TeamPayload {
  members: TeamMemberDTO[];
  invitations: PendingInviteDTO[];
  roles: TeamRoleDTO[];
}
