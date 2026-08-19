'use client';

// eslint-disable-next-line no-restricted-imports -- pre-existing raw Convex query; migrate to useAuthQuery/useAuthPaginatedQuery
import { useMutation, useQuery } from 'convex/react';
import { api } from '@/convex/_generated/api';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';

const KIND_LABEL: Record<string, string> = {
  TRACKING_LOST: 'Tracking lost',
  MISSED_APPOINTMENT: 'Appointment missed',
  POD_MISSING: 'POD missing',
  LOAD_CANCELED: 'Load canceled',
  OFFER_DECLINED: 'Offer declined',
};

/** Live alerts feed — same query, same tiers as the mobile app (D19). */
export function DispatchAlertsClient() {
  const alerts = useQuery(api.dispatchAlerts.listAlerts, {});
  const dismiss = useMutation(api.dispatchAlerts.dismissAlert);

  if (alerts === undefined) {
    return <div className="p-8 text-sm text-muted-foreground">Loading alerts…</div>;
  }

  const tiers = [
    { title: 'Costing money now', rows: alerts.filter((a) => a.severity === 'high'), accent: 'text-destructive' },
    { title: 'Needs a look', rows: alerts.filter((a) => a.severity === 'med'), accent: 'text-muted-foreground' },
  ].filter((t) => t.rows.length > 0);

  return (
    <div className="mx-auto max-w-3xl space-y-6 p-6">
      <div>
        <h1 className="text-2xl font-bold">Alerts</h1>
        <p className="text-sm text-muted-foreground">
          Live operational exceptions — the same feed the Dispatch app shows.
        </p>
      </div>
      {tiers.length === 0 ? (
        <div className="rounded-lg border p-8 text-center">
          <div className="font-semibold">Nothing slipping</div>
          <div className="mt-1 text-sm text-muted-foreground">Every load is tracked and on schedule.</div>
        </div>
      ) : (
        tiers.map((tier) => (
          <section key={tier.title} className="space-y-2">
            <h2 className={`text-xs font-bold uppercase tracking-wide ${tier.accent}`}>{tier.title}</h2>
            {tier.rows.map((a) => (
              <div
                key={a._id}
                className={`rounded-lg border p-4 ${a.severity === 'high' ? 'border-destructive' : ''}`}
              >
                <div className="flex items-center justify-between gap-3">
                  <div className="flex items-center gap-2 font-semibold">
                    {KIND_LABEL[a.kind] ?? a.kind}
                    {a.loadInternalId && <Badge variant="outline">#{a.loadInternalId}</Badge>}
                  </div>
                  <div className="flex items-center gap-2">
                    {a.driver?.phone && (
                      <Button asChild variant="outline" size="sm">
                        <a href={`tel:${a.driver.phone}`}>Call {a.driver.firstName}</a>
                      </Button>
                    )}
                    <Button variant="ghost" size="sm" onClick={() => void dismiss({ alertId: a._id })}>
                      Dismiss
                    </Button>
                  </div>
                </div>
                <p className="mt-1 text-sm text-muted-foreground">{a.detail}</p>
              </div>
            ))}
          </section>
        ))
      )}
    </div>
  );
}
