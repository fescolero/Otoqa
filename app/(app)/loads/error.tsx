'use client';

import { RouteError } from '@/components/web/route-error';

export default function LoadsError(props: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  return <RouteError section="Loads" {...props} />;
}
