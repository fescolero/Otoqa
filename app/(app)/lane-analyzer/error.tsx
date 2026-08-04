'use client';

import { RouteError } from '@/components/web/route-error';

export default function LaneAnalyzerError(props: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  return <RouteError section="Lane Analyzer" {...props} />;
}
