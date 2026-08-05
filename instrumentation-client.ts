import posthog from 'posthog-js';

if (process.env.NEXT_PUBLIC_POSTHOG_KEY) {
  posthog.init(process.env.NEXT_PUBLIC_POSTHOG_KEY, {
    api_host: '/ingest',
    ui_host: 'https://us.posthog.com',
    person_profiles: 'identified_only',
    capture_pageleave: true,
    // D17: uncaught errors + unhandled rejections become $exception events
    // (PostHog error tracking), not just console noise.
    capture_exceptions: true,
    defaults: '2026-01-30',
  });
}
