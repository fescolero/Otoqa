'use client';

/**
 * Root-level error boundary — catches crashes in the root layout itself,
 * where the segment error.tsx boundaries can't help. Replaces the entire
 * document, so it renders its own <html>/<body> and uses inline styles
 * (globals.css is gone along with the root layout).
 */

import { useEffect } from 'react';
import { POSTHOG_KEY, posthog } from '@/lib/posthog';

export default function GlobalError({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  useEffect(() => {
    if (!POSTHOG_KEY) return;
    posthog.captureException(error, {
      source: 'global_error_boundary',
      digest: error.digest,
    });
  }, [error]);

  return (
    <html lang="en">
      <body
        style={{
          margin: 0,
          fontFamily: 'system-ui, sans-serif',
          display: 'flex',
          minHeight: '100vh',
          alignItems: 'center',
          justifyContent: 'center',
        }}
      >
        <div style={{ textAlign: 'center', padding: 24, maxWidth: 480 }}>
          <h2 style={{ fontSize: 20, marginBottom: 8 }}>Something went wrong</h2>
          <p style={{ color: '#666', fontSize: 14, lineHeight: 1.5 }}>
            An unexpected error occurred. Try again, or reload the page if the
            problem persists.
          </p>
          {error.digest && (
            <p style={{ fontFamily: 'monospace', fontSize: 12, color: '#999' }}>
              Error digest: {error.digest}
            </p>
          )}
          <button
            onClick={reset}
            style={{
              marginTop: 12,
              padding: '8px 20px',
              fontSize: 14,
              borderRadius: 8,
              border: '1px solid #ccc',
              background: '#fff',
              cursor: 'pointer',
            }}
          >
            Try again
          </button>
        </div>
      </body>
    </html>
  );
}
