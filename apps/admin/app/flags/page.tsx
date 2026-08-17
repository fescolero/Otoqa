'use client';

import { useQuery, useMutation } from 'convex/react';
import { api } from '@otoqa/convex-client';
import { ConsoleShell } from '@/components/ConsoleShell';
import { PanelBoundary } from '@/components/PanelBoundary';
import { ReasonAction } from '@/components/ReasonAction';
import { EmptyState, PageHeader, Panel } from '@/components/ui';
import { formatAgo } from '@/lib/format';

export default function FlagsPage() {
  return (
    <ConsoleShell>
      <PageHeader
        title="Global feature flags"
        subtitle={
          <>
            Scope <code>*</code> — applies to every organization unless an org override exists.
            Writes require a recent sign-in and a reason; per-org overrides live on each
            organization&apos;s page.
          </>
        }
      />
      <PanelBoundary label="Global flags">
        <GlobalFlags />
      </PanelBoundary>
    </ConsoleShell>
  );
}

function GlobalFlags() {
  const flags = useQuery(api.platform.support.listGlobalFlags, {});
  const setFlag = useMutation(api.platform.support.setGlobalFlag);

  return (
    <Panel
      title="Flags at scope *"
      count={flags?.length}
      flush
      actions={
        <ReasonAction
          label="Set a global flag"
          danger
          onSubmit={async (reason, form) => {
            const data = new FormData(form);
            const key = String(data.get('key') ?? '').trim();
            const value = String(data.get('value') ?? '');
            if (!key) throw new Error('Key is required');
            await setFlag({ key, value, reason });
          }}
        >
          <input className="input input-sm" name="key" placeholder="flag key" />
          <input className="input input-sm" name="value" placeholder="value (string)" />
        </ReasonAction>
      }
    >
      {flags === undefined ? (
        <EmptyState>Loading…</EmptyState>
      ) : flags.length === 0 ? (
        <EmptyState hint="Without a global flag, every org falls through to the code default.">
          No global flags set.
        </EmptyState>
      ) : (
        flags.map((f) => (
          <div className="audit-row" key={f._id}>
            <span className="action">{f.key}</span>
            <span className="mono">{f.value}</span>
            <span className="muted">{formatAgo(f.updatedAt)}</span>
            <span className="row-actions">
              <ReasonAction
                label="Remove"
                danger
                onSubmit={async (reason) => {
                  await setFlag({ key: f.key, value: null, reason });
                }}
              />
            </span>
          </div>
        ))
      )}
    </Panel>
  );
}
