'use client';

import { Unauthenticated } from 'convex/react';
import { useAuth } from '@workos-inc/authkit-nextjs/components';
import { useRouter } from 'next/navigation';
import { useEffect } from 'react';

export default function Home() {
  const { user } = useAuth();
  const router = useRouter();

  useEffect(() => {
    if (user) {
      router.push('/dashboard');
    }
  }, [user, router]);

  return (
    <main className="flex min-h-screen items-center justify-center p-8">
      <Unauthenticated>
        <SignInForm />
      </Unauthenticated>
    </main>
  );
}

function SignInForm() {
  return (
    <div className="flex flex-col gap-8 w-96 mx-auto text-center">
      <h1 className="text-4xl font-bold">Welcome</h1>
      <p className="text-muted-foreground">Sign in to access your dashboard</p>
      <div className="flex flex-col gap-3">
        <a href="/sign-in">
          <button className="w-full bg-foreground text-background px-6 py-3 rounded-md hover:opacity-90 transition-opacity">
            Sign in
          </button>
        </a>
        <a href="/sign-up">
          <button className="w-full bg-muted text-foreground px-6 py-3 rounded-md hover:bg-muted/80 transition-colors">
            Sign up
          </button>
        </a>
      </div>
    </div>
  );
}
