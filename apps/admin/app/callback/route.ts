import { handleAuth } from '@workos-inc/authkit-nextjs';

// No org-membership sync here (unlike the tenant app): staff accounts have
// no tenant org. Authorization happens Convex-side in requirePlatformStaff.
export const GET = handleAuth({ returnPathname: '/' });
