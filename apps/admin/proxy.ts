import { authkitMiddleware } from '@workos-inc/authkit-nextjs';

/**
 * Session gate for the platform console. Uses the STAFF WorkOS project —
 * this app's WORKOS_* env vars belong to a different WorkOS project than
 * the tenant app's (separate Vercel project, separate env set), so tenant
 * sessions do not exist here and staff sessions do not exist there.
 *
 * This is the outer layer only: real authorization is the fail-closed
 * issuer + allowlist check in convex/lib/auth.ts requirePlatformStaff,
 * enforced inside every convex/platform/* function.
 */
const redirectUri =
  process.env.WORKOS_REDIRECT_URI ?? process.env.NEXT_PUBLIC_WORKOS_REDIRECT_URI;

export default authkitMiddleware({
  redirectUri,
  middlewareAuth: {
    enabled: true,
    unauthenticatedPaths: ['/sign-in', '/callback', '/robots.txt'],
  },
});

export const config = {
  matcher: [
    '/((?!_next|[^?]*\\.(?:html?|css|js(?!on)|jpe?g|webp|png|gif|svg|ttf|woff2?|ico|csv|docx?|xlsx?|zip|webmanifest)).*)',
    '/(api|trpc)(.*)',
  ],
};
