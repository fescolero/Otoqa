/**
 * logout.ts — centralized sign-out sequencing.
 *
 * Introduced in Phase 1c so future sign-out touch-points (there are 4
 * today — role switch, more tab, driver-tabs _layout handoff, owner
 * profile) don't each need to remember every piece of local state
 * that must be torn down before Clerk tears down the session.
 *
 * Order matters:
 *   1. Clear the push-token cache so the NEXT driver on this device
 *      gets a fresh registration on first tracking-start (not
 *      re-using a token that the server-side `clearPushToken` may
 *      have wiped from a session we'll never revive).
 *   2. Reset the MMKV ping queue. Any unsynced pings from the prior
 *      session are abandoned at sign-out — we can't attribute them
 *      to the new session, and the server-side 48h purge would
 *      eventually handle them anyway.
 *   3. Call the caller-supplied Clerk `signOut()`. Passed in rather
 *      than imported so this module stays decoupled from Clerk's
 *      React-context auth (useClerk / useAuth) — the caller already
 *      has the handle.
 *
 * Errors in steps 1 + 2 are logged but not rethrown: we never want
 * to block sign-out on a storage glitch.
 */

import { clearCachedPushToken } from './push-token';
import { resetLocationQueue } from './location-queue';
import { log } from './log';

const lg = log('Logout');

export async function performSignOut(
  signOut: () => Promise<unknown> | void,
  reason: string = 'user_initiated',
): Promise<void> {
  lg.debug(`performSignOut reason=${reason}`);

  try {
    await clearCachedPushToken(reason);
  } catch (err) {
    lg.warn(
      `clearCachedPushToken failed (continuing): ${err instanceof Error ? err.message : err}`,
    );
  }

  try {
    resetLocationQueue();
  } catch (err) {
    lg.warn(
      `resetLocationQueue failed (continuing): ${err instanceof Error ? err.message : err}`,
    );
  }

  await signOut();
}
