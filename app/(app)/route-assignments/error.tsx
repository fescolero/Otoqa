'use client';

import { RouteError } from '@/components/web/route-error';

export default function RouteAssignmentsError(props: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  return <RouteError section="Route Assignments" {...props} />;
}
