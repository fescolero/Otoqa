'use client';

import { RouteError } from '@/components/web/route-error';

export default function DispatchError(props: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  return <RouteError section="Dispatch" {...props} />;
}
