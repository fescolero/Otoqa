'use client';

import { useQuery } from 'convex/react';
import { api } from '@otoqa/convex-client';
import { ConsoleShell } from '@/components/ConsoleShell';
import { formatAgo, formatDuration, formatWhen } from '@/lib/format';

export default function JobsPage() {
  return (
    <ConsoleShell>
      <h1>Cron jobs</h1>
      <p className="subtitle">
        All scheduled jobs, recorded every tick by the run ledger. Sub-5-minute jobs keep
        history only for failures.
      </p>
      <JobsBoard />
    </ConsoleShell>
  );
}

function JobsBoard() {
  const jobs = useQuery(api.platform.jobs.listJobs, {});
  const failures = useQuery(api.platform.jobs.recentFailures, {});

  return (
    <>
      {failures && failures.length > 0 ? (
        <div className="panel panel-attention">
          <h2>Recent failures</h2>
          {failures.map((f) => (
            <div className="audit-row" key={f._id}>
              <span className="when">{formatWhen(f.startedAt)}</span>
              <span className="action">{f.jobName}</span>
              <span className="danger-text">{f.error}</span>
            </div>
          ))}
        </div>
      ) : null}

      <div className="panel">
        <h2>All jobs {jobs ? `(${jobs.length})` : ''}</h2>
        {jobs === undefined ? (
          <div className="empty">Loading…</div>
        ) : jobs.length === 0 ? (
          <div className="empty">
            No ticks recorded yet — the ledger fills in as jobs fire after this deploy.
          </div>
        ) : (
          <div className="table-scroll">
            <table className="data-table">
              <thead>
                <tr>
                  <th>Job</th>
                  <th>Status</th>
                  <th>Last run</th>
                  <th>Duration</th>
                  <th>Consecutive failures</th>
                  <th>Failures / runs</th>
                </tr>
              </thead>
              <tbody>
                {jobs.map((j) => (
                  <tr key={j._id}>
                    <td>{j.jobName}</td>
                    <td>
                      <span
                        className={
                          j.lastOutcome === 'ok'
                            ? j.consecutiveFailures === 0
                              ? 'chip chip-ok'
                              : 'chip chip-warn'
                            : j.consecutiveFailures >= 3
                              ? 'chip chip-danger'
                              : 'chip chip-warn'
                        }
                      >
                        {j.lastOutcome}
                      </span>
                    </td>
                    <td className="muted">{formatAgo(j.lastStartedAt)}</td>
                    <td>{formatDuration(j.lastDurationMs)}</td>
                    <td>{j.consecutiveFailures}</td>
                    <td className="muted">
                      {j.totalFailures} / {j.totalRuns}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </>
  );
}
