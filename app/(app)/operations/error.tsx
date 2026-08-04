'use client';

import { RouteError } from '@/components/web/route-error';

export default function OperationsError(props: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  return <RouteError section="Operations" {...props} />;
}
