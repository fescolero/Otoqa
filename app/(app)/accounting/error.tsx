'use client';

import { RouteError } from '@/components/web/route-error';

export default function AccountingError(props: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  return <RouteError section="Accounting" {...props} />;
}
