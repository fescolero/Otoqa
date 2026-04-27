/**
 * Centralized scheduler call-site helpers for `internal.clerkSync.*` actions.
 *
 * Why this file exists:
 *   - Every place that creates/updates/deletes a Clerk user previously inlined
 *     `ctx.scheduler.runAfter(0, internal.clerkSync.X, { ... })`. There are
 *     ~20 such sites across drivers/carrierMobile/carrierPartnerships/maintenance.
 *   - Inlining the function-reference path means a typo (e.g.
 *     `internal.clerkSync.deleteClekUser`) or a drifted arg shape can land
 *     silently — Convex resolves the path at runtime.
 *   - These helpers centralize the contract: callers cannot mistype the path
 *     and the arg shape is enforced by the function signature.
 *
 * Notes:
 *   - Helpers wrap the scheduler call only; they do NOT change the actual
 *     internalAction handlers in `convex/clerkSync.ts`. Those exports
 *     (`internal.clerkSync.createClerkUserForDriver`, etc.) remain stable.
 *   - The `ctx` type is intentionally narrow: only `scheduler` is required,
 *     so helpers work from both `MutationCtx` and `ActionCtx` call sites.
 *   - Scheduled actions are fire-and-forget (at-most-once, no auto-retry per
 *     Convex semantics). Helpers preserve the existing await/non-await
 *     behavior at each call site by returning the scheduler's promise.
 */

import type { Id } from './_generated/dataModel';
import type { MutationCtx, ActionCtx } from './_generated/server';
import { internal } from './_generated/api';

/**
 * Any Convex ctx that exposes the scheduler. Both `MutationCtx` and
 * `ActionCtx` carry a compatible `scheduler.runAfter` signature.
 */
type SchedulerCtx = Pick<MutationCtx, 'scheduler'> | Pick<ActionCtx, 'scheduler'>;

// -----------------------------------------------------------------------------
// Driver-side helpers
// -----------------------------------------------------------------------------

export type CreateClerkUserForDriverArgs = {
  phone: string;
  firstName: string;
  lastName: string;
};

/**
 * Fire-and-forget: create a Clerk user for a newly-created driver so they
 * can sign in to the mobile app via phone number.
 */
export function scheduleCreateClerkUserForDriver(
  ctx: SchedulerCtx,
  args: CreateClerkUserForDriverArgs
): Promise<unknown> {
  return ctx.scheduler.runAfter(
    0,
    internal.clerkSync.createClerkUserForDriver,
    args
  );
}

export type UpdateClerkUserPhoneArgs = {
  oldPhone: string;
  newPhone: string;
  firstName: string;
  lastName: string;
  targetClerkUserId?: string;
  organizationId?: Id<'organizations'>;
};

/**
 * Fire-and-forget: update the phone number on an existing Clerk user when a
 * driver's phone changes.
 */
export function scheduleUpdateClerkUserPhone(
  ctx: SchedulerCtx,
  args: UpdateClerkUserPhoneArgs
): Promise<unknown> {
  return ctx.scheduler.runAfter(
    0,
    internal.clerkSync.updateClerkUserPhone,
    args
  );
}

export type DeleteClerkUserArgs = {
  phone: string;
};

/**
 * Fire-and-forget: delete a Clerk user identified by phone number (used when
 * the actual Clerk user ID is not known by the caller).
 */
export function scheduleDeleteClerkUser(
  ctx: SchedulerCtx,
  args: DeleteClerkUserArgs
): Promise<unknown> {
  return ctx.scheduler.runAfter(0, internal.clerkSync.deleteClerkUser, args);
}

export type DeleteClerkUserByIdArgs = {
  clerkUserId: string;
  reason?: string;
};

/**
 * Fire-and-forget: delete a Clerk user by their Clerk user ID (preferred when
 * the ID is known — avoids an extra search-by-phone round-trip).
 */
export function scheduleDeleteClerkUserById(
  ctx: SchedulerCtx,
  args: DeleteClerkUserByIdArgs
): Promise<unknown> {
  return ctx.scheduler.runAfter(
    0,
    internal.clerkSync.deleteClerkUserById,
    args
  );
}

// -----------------------------------------------------------------------------
// Carrier-owner helpers
// -----------------------------------------------------------------------------

export type SyncCarrierOwnerToClerkArgs = {
  organizationId: Id<'organizations'>;
  phone: string;
  firstName?: string;
  lastName?: string;
  email?: string;
};

/**
 * Fire-and-forget: ensure a Clerk user exists for the owner of a carrier
 * organization and that the matching `userIdentityLinks` row carries the
 * real Clerk user ID.
 */
export function scheduleSyncCarrierOwnerToClerk(
  ctx: SchedulerCtx,
  args: SyncCarrierOwnerToClerkArgs
): Promise<unknown> {
  return ctx.scheduler.runAfter(
    0,
    internal.clerkSync.syncSingleCarrierOwnerToClerk,
    args
  );
}
