import { ConvexError } from 'convex/values';

/**
 * The user-facing message a Convex function deliberately threw, if it
 * threw one.
 *
 * `throw new ConvexError('…')` arrives on the client as a ConvexError
 * whose `data` is that string — a message the handler wrote for a
 * person to read ("This record changed since you opened it…").
 * Anything else, a bug or a dropped connection, carries nothing meant
 * for a user, so this returns null and the caller falls back to its
 * own copy rather than leaking internals into a toast.
 */
export function convexErrorMessage(err: unknown): string | null {
  if (err instanceof ConvexError && typeof err.data === 'string') {
    return err.data;
  }
  return null;
}
