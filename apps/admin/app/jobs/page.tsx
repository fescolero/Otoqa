'use client';

import { useState } from 'react';
import { useQuery, useMutation } from 'convex/react';
import { api } from '@otoqa/convex-client';
import { ConsoleShell } from '@/components/ConsoleShell';
import { PanelBoundary } from '@/components/PanelBoundary';
import { ReasonAction } from '@/components/ReasonAction';
import { formatAgo, formatDuration, formatWhen } from '@/lib/format';

export default function JobsPage() {
  return (
    <ConsoleShell>
      <h1>Cron jobs</h1>
      <p className="subtitle">
        Every scheduled job, with the state derived from its declared cadence — a job that stops
        firing shows <strong>stale</strong> rather than staying green on its last good tick.
      </p>
      <PanelBoundary label="Jobs board">
        <JobsBoard />
      </PanelBoundary>
    </ConsoleShell>
  );
}

const STATE_CHIP: Record<string, string> = {
  ok: 'chip chip-ok',
  failing: 'chip chip-danger',
  stale: 'chip chip-danger',
  hung: 'chip chip-danger',
  retired: 'chip',
  unknown: 'chip chip-warn',
};

const STATE_HELP: Record<string, string> = {
  stale: 'Has not run within 3 expected cycles — check the schedule, not the code.',
  hung: 'Started and never reported: the run was killed mid-flight.',
  unknown: 'No declared cadence yet — staleness can’t be checked until it ticks once more.',
  retired: 'Retired by staff; no longer alerts.',
};

function JobsBoard() {
  const jobs = useQuery(api.platform.jobs.listJobs, {});
  const failures = useQuery(api.platform.jobs.recentFailures, {});
  const retire = useMutation(api.platform.jobs.retireJob);
  const [openJob, setOpenJob] = useState<string | null>(null);

  const notRunning = (jobs ?? []).filter((j) => j.state === 'stale' || j.state === 'hung');

  return (
    <>
      {notRunning.length > 0 ? (
        <div className="panel panel-danger">
          <h2>Not running</h2>
          <p className="subtitle">
            These raise nothing on their own — no error is thrown when a job simply stops.
          </p>
          {notRunning.map((j) => (
            <div className="audit-row" key={j._id}>
              <span className={STATE_CHIP[j.state]}>{j.state}</span>
              <span className="action">{j.jobName}</span>
              <span className="muted">last started {formatAgo(j.lastStartedAt)}</span>
              {j.overdueMs != null ? (
                <span className="danger-text">{formatDuration(j.overdueMs)} overdue</span>
              ) : null}
              <ReasonAction
                label="Retire"
                danger
                onSubmit={async (reason) => {
                  await retire({ jobName: j.jobName, reason });
                }}
              />
            </div>
          ))}
        </div>
      ) : null}

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
                  <th>State</th>
                  <th>Last run</th>
                  <th>Every</th>
                  <th>Duration</th>
                  <th>Consecutive failures</th>
                  <th>Failures / runs</th>
                  <th></th>
                </tr>
              </thead>
              <tbody>
                {jobs.map((j) => (
                  <tr key={j._id}>
                    <td>{j.jobName}</td>
                    <td>
                      <span className={STATE_CHIP[j.state]} title={STATE_HELP[j.state] ?? ''}>
                        {j.state}
                      </span>
                    </td>
                    <td className="muted">{formatAgo(j.lastStartedAt)}</td>
                    <td className="muted">
                      {j.expectedIntervalMs != null ? formatDuration(j.expectedIntervalMs) : '—'}
                    </td>
                    <td>{formatDuration(j.lastDurationMs)}</td>
                    <td>{j.consecutiveFailures}</td>
                    <td className="muted">
                      {j.totalFailures} / {j.totalRuns}
                    </td>
                    <td>
                      <button
                        className="button button-sm"
                        onClick={() => setOpenJob(openJob === j.jobName ? null : j.jobName)}
                      >
                        {openJob === j.jobName ? 'Hide' : 'History'}
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>

      {openJob ? <JobTrend jobName={openJob} /> : null}
    </>
  );
}

/**
 * Duration percentiles + recent runs. A job degrading from 2s to 45s is
 * invisible on last-duration alone, and the degradation usually shows up
 * before the failure does.
 */
function JobTrend({ jobName }: { jobName: string }) {
  const trend = useQuery(api.platform.jobs.jobTrend, { jobName });
  if (trend === undefined) return <div className="empty">Loading history…</div>;

  return (
    <div className="panel">
      <h2>{jobName} — history</h2>
      {trend.sample === 0 ? (
        <div className="empty">
          No retained history. Sub-5-minute jobs only keep failures, by design.
        </div>
      ) : (
        <>
          <div className="kpi-row">
            <Kpi label="p50 duration" value={formatDuration(trend.p50Ms ?? 0)} />
            <Kpi label="p95 duration" value={formatDuration(trend.p95Ms ?? 0)} />
            <Kpi label="slowest" value={formatDuration(trend.maxMs ?? 0)} />
            <Kpi label={`failures / ${trend.sample} runs`} value={String(trend.failures)} />
          </div>
          {trend.recent.map((r) => (
            <div className="audit-row" key={r._id}>
              <span className="when">{formatWhen(r.startedAt)}</span>
              <span className={r.outcome === 'ok' ? 'chip chip-ok' : 'chip chip-danger'}>
                {r.outcome}
              </span>
              <span>{formatDuration(r.durationMs)}</span>
              {r.error ? <span className="danger-text">{r.error}</span> : null}
            </div>
          ))}
        </>
      )}
    </div>
  );
}

function Kpi({ label, value }: { label: string; value: string }) {
  return (
    <div className="kpi">
      <div className="kpi-value">{value}</div>
      <div className="kpi-label">{label}</div>
    </div>
  );
}
