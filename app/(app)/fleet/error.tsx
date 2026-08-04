'use client';

import { RouteError } from '@/components/web/route-error';

export default function FleetError(props: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  return <RouteError section="Fleet" {...props} />;
}
