import { AuthConfig } from 'convex/server';

const clientId = process.env.WORKOS_CLIENT_ID;

// Clerk configuration for mobile driver app
// Get these values from your Clerk Dashboard > API Keys
const clerkIssuer = process.env.CLERK_ISSUER_URL; // e.g., "https://your-app.clerk.accounts.dev"

// Platform-staff issuer for the provider console (apps/admin).
// A SEPARATE identity provider from the tenant WorkOS project — for a staff
// WorkOS project these are:
//   STAFF_ISSUER   = https://api.workos.com/user_management/<staff_client_id>
//   STAFF_JWKS_URL = https://api.workos.com/sso/jwks/<staff_client_id>
// requirePlatformStaff (convex/lib/auth.ts) authorizes by comparing the
// token issuer against STAFF_ISSUER, so the two env vars must describe the
// same provider. Absent env vars = console disabled on this deployment.
const staffIssuer = process.env.STAFF_ISSUER;
const staffJwks = process.env.STAFF_JWKS_URL;

export default {
  providers: [
    // WorkOS providers for web app (existing)
    {
      type: 'customJwt',
      issuer: 'https://api.workos.com/',
      algorithm: 'RS256',
      jwks: `https://api.workos.com/sso/jwks/${clientId}`,
      applicationID: clientId,
    },
    {
      type: 'customJwt',
      issuer: `https://api.workos.com/user_management/${clientId}`,
      algorithm: 'RS256',
      jwks: `https://api.workos.com/sso/jwks/${clientId}`,
    },
    // Clerk provider for mobile driver app (phone OTP)
    ...(clerkIssuer
      ? [
          {
            domain: clerkIssuer,
            applicationID: 'convex',
          },
        ]
      : []),
    // Platform-staff provider for the provider console (apps/admin)
    ...(staffIssuer && staffJwks
      ? [
          {
            type: 'customJwt' as const,
            issuer: staffIssuer,
            algorithm: 'RS256' as const,
            jwks: staffJwks,
          },
        ]
      : []),
  ],
} satisfies AuthConfig;
