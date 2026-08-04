'use client';

import { RouteError } from '@/components/web/route-error';

export default function SettingsError(props: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  return <RouteError section="Settings" {...props} />;
}
