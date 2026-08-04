'use client';

import { RouteError } from '@/components/web/route-error';

export default function DashboardError(props: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  return <RouteError section="Dashboard" {...props} />;
}
