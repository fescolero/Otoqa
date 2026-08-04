'use client';

/**
 * RouteError — shared segment-level error state, rendered by each section's
 * error.tsx boundary. Because it mounts inside the (app) layout, the shell
 * (sidebar/topbar) stays alive and only the failed section is replaced.
 * Next.js passes `reset` to re-render the segment.
 */

import { useEffect } from 'react';
import { WIcon } from '@/components/web/icons';
import { Button } from '@/components/ui/button';
import { POSTHOG_KEY, posthog } from '@/lib/posthog';

interface RouteErrorProps {
  section: string;
  error: Error & { digest?: string };
  reset: () => void;
}

export function RouteError({ section, error, reset }: RouteErrorProps) {
  useEffect(() => {
    // Segment boundaries swallow the error before capture_exceptions can
    // see it, so report it explicitly (D17).
    if (!POSTHOG_KEY) return;
    posthog.captureException(error, {
      source: 'route_error_boundary',
      section,
      digest: error.digest,
    });
  }, [error, section]);

  return (
    <div className="flex h-[60vh] flex-col items-center justify-center gap-4 px-6">
      <span
        className="flex h-12 w-12 items-center justify-center rounded-xl"
        style={{ background: 'var(--bg-muted)', color: 'var(--danger-500)' }}
      >
        <WIcon name="circle-alert" size={22} />
      </span>
      <h2 className="tw-h2">Something went wrong in {section}</h2>
      <p className="tw-body max-w-md text-center" style={{ color: 'var(--text-secondary)' }}>
        The rest of the app is still available. Try again, or reload the page if the problem
        persists.
      </p>
      {error.digest && (
        <p className="tw-mono tw-meta rounded px-2 py-1" style={{ background: 'var(--bg-muted)' }}>
          Error digest: {error.digest}
        </p>
      )}
      <Button onClick={reset} variant="outline">
        Try again
      </Button>
    </div>
  );
}
