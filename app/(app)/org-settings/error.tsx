'use client';

import { RouteError } from '@/components/web/route-error';

export default function OrgSettingsError(props: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  return <RouteError section="Organization Settings" {...props} />;
}
