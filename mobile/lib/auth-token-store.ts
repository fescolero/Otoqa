import { storage } from './storage';

const AUTH_TOKEN_KEY = 'location_auth_token';

/**
 * Store the current Clerk JWT so background tasks can authenticate
 * with Convex without the React tree being mounted.
 * This is a fallback -- prefer getFreshToken() which uses the Clerk singleton.
 */
export async function storeAuthToken(token: string): Promise<void> {
  await storage.set(AUTH_TOKEN_KEY, token);
}

export async function getStoredAuthToken(): Promise<string | null> {
  return await storage.getString(AUTH_TOKEN_KEY);
}

export async function clearAuthToken(): Promise<void> {
  await storage.delete(AUTH_TOKEN_KEY);
}

/**
 * Get a fresh Clerk JWT using the Clerk singleton (works outside React).
 * Falls back to the stored token if the singleton isn't available.
 * Clerk sessions persist in SecureStore so this works even when backgrounded.
 */
export async function getFreshToken(): Promise<string | null> {
  try {
    const { getClerkInstance } = require('@clerk/clerk-expo');
    const clerk = getClerkInstance();
    const session = clerk?.session;
    if (session) {
      const token = await session.getToken({ template: 'convex' });
      if (token) {
        await storeAuthToken(token);
        return token;
      }
    }
  } catch (err) {
    console.warn('[AuthTokenStore] Clerk singleton getToken failed:', err instanceof Error ? err.message : err);
  }

  // Fallback to stored token (may be expired but worth trying)
  return await getStoredAuthToken();
}
