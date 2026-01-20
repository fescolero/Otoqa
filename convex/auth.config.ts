import { AuthConfig } from 'convex/server';

const clientId = process.env.WORKOS_CLIENT_ID;

// Clerk configuration for mobile driver app
// Get these values from your Clerk Dashboard > API Keys
const clerkIssuer = process.env.CLERK_ISSUER_URL; // e.g., "https://your-app.clerk.accounts.dev"

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
  ],
} satisfies AuthConfig;
