import { storage } from './storage';

const AUTH_TOKEN_KEY = 'location_auth_token';

/**
 * Store the current Clerk JWT so background tasks can authenticate
 * with Convex without the React tree being mounted.
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
