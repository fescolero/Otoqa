'use client';

import { useState } from 'react';
import { useQuery, useMutation } from 'convex/react';
import { api } from '@otoqa/convex-client';
import { ConsoleShell } from '@/components/ConsoleShell';
import { PanelBoundary } from '@/components/PanelBoundary';
import { Badge, EmptyState, PageHeader, Panel, toneFor } from '@/components/ui';
import { formatAgo } from '@/lib/format';

type Status = 'open' | 'in_progress' | 'resolved' | 'closed';
const STATUSES: (Status | 'all')[] = ['all', 'open', 'in_progress', 'resolved', 'closed'];

export default function TicketsPage() {
  return (
    <ConsoleShell>
      <PageHeader
        title="Support tickets"
        subtitle="User reports (web + mobile), staff-filed issues, and automated escalations."
      />
      <PanelBoundary label="Tickets">
        <TicketsBoard />
      </PanelBoundary>
    </ConsoleShell>
  );
}

function TicketsBoard() {
  const [filter, setFilter] = useState<Status | 'all'>('all');
  const tickets = useQuery(
    api.platform.tickets.listTickets,
    filter === 'all' ? {} : { status: filter },
  );
  const update = useMutation(api.platform.tickets.updateTicket);
  const create = useMutation(api.platform.tickets.createTicket);
  const [newTitle, setNewTitle] = useState('');

  return (
    <>
      <Panel title="File a ticket" subtitle="filed as normal severity, assigned to nobody">
        <form
          className="inline-form"
          style={{ marginTop: 0 }}
          onSubmit={async (e) => {
            e.preventDefault();
            if (!newTitle.trim()) return;
            await create({ title: newTitle.trim(), severity: 'normal' });
            setNewTitle('');
          }}
        >
          <input
            className="input input-wide"
            placeholder="What happened?"
            value={newTitle}
            onChange={(e) => setNewTitle(e.target.value)}
          />
          <button className="button" type="submit">
            Create
          </button>
        </form>
      </Panel>

      <Panel
        title="Tickets"
        count={tickets?.length}
        flush
        footer={
          tickets && tickets.length >= 100
            ? 'Showing the most recent 100 — narrow with a status filter to see older ones.'
            : null
        }
      >
        <div className="chip-row" style={{ padding: '10px 12px 0', marginBottom: 0 }}>
          {STATUSES.map((s) => (
            <button
              key={s}
              type="button"
              className={`chip chip-button${filter === s ? ' chip-active' : ''}`}
              onClick={() => setFilter(s)}
            >
              {s.replace('_', ' ')}
            </button>
          ))}
        </div>
        {tickets === undefined ? (
          <EmptyState>Loading…</EmptyState>
        ) : tickets.length === 0 ? (
          <EmptyState
            hint={
              filter === 'all'
                ? 'Reports from the web and mobile apps land here automatically.'
                : undefined
            }
          >
            {filter === 'all' ? 'No tickets yet.' : `No ${filter.replace('_', ' ')} tickets.`}
          </EmptyState>
        ) : (
          tickets.map((t) => (
            <div className="ticket-row" key={t._id}>
              <div className="audit-row">
                <Badge tone={toneFor(t.severity)}>{t.severity}</Badge>
                <Badge tone={toneFor(t.status)}>{t.status.replace('_', ' ')}</Badge>
                <strong>{t.title}</strong>
                <span className="muted">{formatAgo(t.createdAt)}</span>
              </div>
              <div className="audit-row">
                <span className="muted">
                  {t.source} · {t.reporterEmail ?? t.reporterSubject ?? 'unknown reporter'}
                  {t.orgId ? ` · org ${t.orgId}` : ''}
                  {t.assignee ? ` · assigned to ${t.assignee}` : ''}
                </span>
                <span className="row-actions">
                  <select
                    className="input input-sm"
                    value={t.status}
                    onChange={(e) => update({ id: t._id, status: e.target.value as Status })}
                  >
                    {(['open', 'in_progress', 'resolved', 'closed'] as Status[]).map((s) => (
                      <option key={s} value={s}>
                        {s.replace('_', ' ')}
                      </option>
                    ))}
                  </select>
                  {!t.assignee ? (
                    <button
                      className="button button-sm"
                      onClick={() => update({ id: t._id, assignToMe: true })}
                    >
                      Assign to me
                    </button>
                  ) : null}
                </span>
              </div>
              {t.body ? <p className="ticket-body">{t.body}</p> : null}
              {t.resolutionNote ? (
                <p className="ticket-body muted">Resolution: {t.resolutionNote}</p>
              ) : null}
            </div>
          ))
        )}
      </Panel>
    </>
  );
}
