'use client';

import { useQuery, useMutation } from 'convex/react';
import { api } from '@otoqa/convex-client';
import { ConsoleShell } from '@/components/ConsoleShell';
import { ReasonAction } from '@/components/ReasonAction';
import { formatAgo } from '@/lib/format';

export default function FlagsPage() {
  return (
    <ConsoleShell>
      <h1>Global feature flags</h1>
      <p className="subtitle">
        Scope <code>*</code> — applies to every organization unless an org override exists.
        Writes require a recent sign-in and a reason; per-org overrides live on each
        organization&apos;s page.
      </p>
      <GlobalFlags />
    </ConsoleShell>
  );
}

function GlobalFlags() {
  const flags = useQuery(api.platform.support.listGlobalFlags, {});
  const setFlag = useMutation(api.platform.support.setGlobalFlag);

  return (
    <div className="panel">
      {flags === undefined ? (
        <div className="empty">Loading…</div>
      ) : flags.length === 0 ? (
        <div className="empty">No global flags set.</div>
      ) : (
        flags.map((f) => (
          <div className="audit-row" key={f._id}>
            <span className="action">{f.key}</span>
            <span>{f.value}</span>
            <span className="muted">{formatAgo(f.updatedAt)}</span>
            <ReasonAction
              label="Remove"
              danger
              onSubmit={async (reason) => {
                await setFlag({ key: f.key, value: null, reason });
              }}
            />
          </div>
        ))
      )}
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
        <input className="input" name="key" placeholder="flag key" />
        <input className="input" name="value" placeholder="value (string)" />
      </ReasonAction>
    </div>
  );
}
