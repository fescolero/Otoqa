'use client';

import { RouteError } from '@/components/web/route-error';

export default function InvoicesError(props: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  return <RouteError section="Invoices" {...props} />;
}
