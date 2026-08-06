import { signOut } from '@workos-inc/authkit-nextjs';

export async function GET() {
  // Clears the AuthKit session cookie and redirects to the post-logout URL.
  await signOut();
}
