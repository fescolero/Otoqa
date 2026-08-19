'use client';

import { useState } from 'react';
import { useQuery } from 'convex/react';
import { api } from '@otoqa/convex-client';
import { ConsoleShell } from '@/components/ConsoleShell';
import { PanelBoundary } from '@/components/PanelBoundary';
import { EmptyState, PageHeader, Panel } from '@/components/ui';
import { formatAgo, formatWhen } from '@/lib/format';

/**
 * The staff audit trail, searchable.
 *
 * Retention is 7 years by policy, so "the newest 50" — all the Overview panel
 * could show — is not a way to answer "what did we do to this org in March" or
 * "everything this person touched". Filters are applied server-side against
 * by_target_org / by_actor where possible.
 *
 * The actor list doubles as the closest thing we have to an access review
 * until a dedicated access page exists: it shows who has actually used the
 * console and when they were last here.
 */
export default function AuditPage() {
  return (
    <ConsoleShell>
      <PageHeader
        title="Audit trail"
        subtitle={
          <>
            Every platform-staff write and sensitive read. Destructive actions cannot be recorded
            without a reason, so the &ldquo;why&rdquo; column is never empty for those.
          </>
        }
      />
      <PanelBoundary label="Audit trail">
        <AuditBoard />
      </PanelBoundary>
    </ConsoleShell>
  );
}

function AuditBoard() {
  const [actor, setActor] = useState('');
  const [org, setOrg] = useState('');
  const [search, setSearch] = useState('');

  const actors = useQuery(api.platform.access.auditActors, {});
  const rows = useQuery(api.platform.access.recentAuditLog, {
    limit: 200,
    ...(actor ? { actorEmail: actor } : {}),
    ...(org.trim() ? { targetOrgId: org.trim() } : {}),
    ...(search.trim() ? { search: search.trim() } : {}),
  });

  return (
    <>
      <Panel
        title="Who has used the console"
        count={actors?.length}
        flush
        footer="Actors seen in the log, not the allowlist itself — someone added to STAFF_EMAIL_ALLOWLIST who has never signed in will not appear here. Review both when offboarding."
      >
        {actors === undefined ? (
          <EmptyState>Loading…</EmptyState>
        ) : actors.length === 0 ? (
          <EmptyState>No staff activity recorded yet.</EmptyState>
        ) : (
          actors.map((a) => (
            <div className="audit-row" key={a.actorEmail}>
              <span className="action">{a.actorEmail}</span>
              <span className="muted">last seen {formatAgo(a.lastSeenAt)}</span>
              <span className="muted">{a.actions} action(s) in the recent window</span>
              <span className="row-actions">
                <button className="button button-sm" onClick={() => setActor(a.actorEmail)}>
                  Filter
                </button>
              </span>
            </div>
          ))
        )}
      </Panel>

      <Panel
        title="Trail"
        count={rows?.length}
        flush
        actions={
          <form className="inline-form" style={{ marginTop: 0 }} onSubmit={(e) => e.preventDefault()}>
            <select className="input input-sm" value={actor} onChange={(e) => setActor(e.target.value)}>
              <option value="">All actors</option>
              {(actors ?? []).map((a) => (
                <option key={a.actorEmail} value={a.actorEmail}>
                  {a.actorEmail}
                </option>
              ))}
            </select>
            <input
              className="input input-sm"
              placeholder="WorkOS org id"
              value={org}
              onChange={(e) => setOrg(e.target.value)}
            />
            <input
              className="input input-sm"
              style={{ minWidth: 220 }}
              placeholder="Search reason, action, target…"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
            />
            {actor || org || search ? (
              <button
                className="button button-sm button-quiet"
                type="button"
                onClick={() => {
                  setActor('');
                  setOrg('');
                  setSearch('');
                }}
              >
                Clear
              </button>
            ) : null}
          </form>
        }
        footer={
          rows && rows.length === 200
            ? 'Showing the first 200 matches — narrow the filters to see older entries.'
            : null
        }
      >
        {rows === undefined ? (
          <EmptyState>Loading…</EmptyState>
        ) : rows.length === 0 ? (
          <EmptyState hint="Filters apply server-side against by_actor and by_target_org.">
            No entries match those filters.
          </EmptyState>
        ) : (
          <div className="table-scroll">
            <table className="data-table table-sticky">
              <thead>
                <tr>
                  <th>When</th>
                  <th>Action</th>
                  <th>Actor</th>
                  <th>Org</th>
                  <th>Target</th>
                  <th>Reason</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((r) => (
                  <tr key={r._id}>
                    <td className="muted">{formatWhen(r.timestamp)}</td>
                    <td className="mono">{r.action}</td>
                    <td className="muted">{r.actorEmail}</td>
                    <td className="muted">{r.targetOrgId ?? '—'}</td>
                    <td className="muted">
                      {r.targetTable ? `${r.targetTable}${r.targetId ? `/${r.targetId}` : ''}` : '—'}
                    </td>
                    <td style={{ whiteSpace: 'normal' }}>{r.reason ?? '—'}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Panel>
    </>
  );
}
