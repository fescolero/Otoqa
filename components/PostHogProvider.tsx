'use client';

import { useEffect, Suspense } from 'react';
import { usePathname, useSearchParams } from 'next/navigation';
import posthog from 'posthog-js';

export function PostHogProvider({ children }: { children: React.ReactNode }) {
  return (
    <>
      <SuspendedPageTracker />
      {children}
    </>
  );
}

function PageTracker() {
  const pathname = usePathname();
  const searchParams = useSearchParams();

  useEffect(() => {
    if (!pathname) return;

    let url = window.origin + pathname;
    const params = searchParams?.toString();
    if (params) {
      url += '?' + params;
    }
    posthog.capture('$pageview', { $current_url: url });
  }, [pathname, searchParams]);

  return null;
}

function SuspendedPageTracker() {
  return (
    <Suspense fallback={null}>
      <PageTracker />
    </Suspense>
  );
}
