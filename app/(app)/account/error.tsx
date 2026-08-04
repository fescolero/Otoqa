'use client';

import { RouteError } from '@/components/web/route-error';

export default function AccountError(props: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  return <RouteError section="Account" {...props} />;
}
