'use client';

import { useState } from 'react';
import { useQuery, useMutation } from 'convex/react';
import { api } from '@otoqa/convex-client';
import { ConsoleShell } from '@/components/ConsoleShell';
import { formatAgo } from '@/lib/format';

type Status = 'open' | 'in_progress' | 'resolved' | 'closed';
const STATUSES: (Status | 'all')[] = ['all', 'open', 'in_progress', 'resolved', 'closed'];

export default function TicketsPage() {
  return (
    <ConsoleShell>
      <h1>Support tickets</h1>
      <p className="subtitle">
        User reports (web + mobile), staff-filed issues, and automated escalations.
      </p>
      <TicketsBoard />
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
      <div className="panel">
        <form
          className="inline-form"
          onSubmit={async (e) => {
            e.preventDefault();
            if (!newTitle.trim()) return;
            await create({ title: newTitle.trim(), severity: 'normal' });
            setNewTitle('');
          }}
        >
          <input
            className="input input-wide"
            placeholder="File a ticket…"
            value={newTitle}
            onChange={(e) => setNewTitle(e.target.value)}
          />
          <button className="button button-sm" type="submit">
            Create
          </button>
        </form>
      </div>

      <div className="chip-row">
        {STATUSES.map((s) => (
          <button
            key={s}
            className={`chip chip-button${filter === s ? ' chip-ok' : ''}`}
            onClick={() => setFilter(s)}
          >
            {s.replace('_', ' ')}
          </button>
        ))}
      </div>

      <div className="panel">
        {tickets === undefined ? (
          <div className="empty">Loading…</div>
        ) : tickets.length === 0 ? (
          <div className="empty">No tickets.</div>
        ) : (
          tickets.map((t) => (
            <div className="ticket-row" key={t._id}>
              <div className="audit-row">
                <span
                  className={`chip ${
                    t.severity === 'urgent' || t.severity === 'high' ? 'chip-danger' : ''
                  }`}
                >
                  {t.severity}
                </span>
                <span className="chip">{t.status.replace('_', ' ')}</span>
                <strong>{t.title}</strong>
                <span className="muted">{formatAgo(t.createdAt)}</span>
              </div>
              <div className="audit-row">
                <span className="muted">
                  {t.source} · {t.reporterEmail ?? t.reporterSubject ?? 'unknown reporter'}
                  {t.orgId ? ` · org ${t.orgId}` : ''}
                  {t.assignee ? ` · assigned to ${t.assignee}` : ''}
                </span>
                <select
                  className="input"
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
              </div>
              {t.body ? <p className="ticket-body">{t.body}</p> : null}
              {t.resolutionNote ? (
                <p className="ticket-body muted">Resolution: {t.resolutionNote}</p>
              ) : null}
            </div>
          ))
        )}
      </div>
    </>
  );
}
