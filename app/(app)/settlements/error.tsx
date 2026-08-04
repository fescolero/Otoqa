'use client';

import { RouteError } from '@/components/web/route-error';

export default function SettlementsError(props: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  return <RouteError section="Settlements" {...props} />;
}
