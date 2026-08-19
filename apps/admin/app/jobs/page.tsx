'use client';

import { useMemo, useState } from 'react';
import { useQuery, useMutation } from 'convex/react';
import { api } from '@otoqa/convex-client';
import { ConsoleShell } from '@/components/ConsoleShell';
import { PanelBoundary } from '@/components/PanelBoundary';
import { ReasonAction } from '@/components/ReasonAction';
import { Badge, EmptyState, FilterChips, Kpi, PageHeader, Panel, toneFor } from '@/components/ui';
import { formatAgo, formatDuration, formatWhen } from '@/lib/format';

export default function JobsPage() {
  return (
    <ConsoleShell>
      <PageHeader
        title="Cron jobs"
        subtitle={
          <>
            Every scheduled job, with the state derived from its declared cadence — a job that stops
            firing shows <strong>stale</strong> rather than staying green on its last good tick.
          </>
        }
      />
      <PanelBoundary label="Jobs board">
        <JobsBoard />
      </PanelBoundary>
    </ConsoleShell>
  );
}

const STATE_HELP: Record<string, string> = {
  stale: 'Has not run within 3 expected cycles — check the schedule, not the code.',
  hung: 'Started and never reported: the run was killed mid-flight.',
  unknown: 'No declared cadence yet — staleness can’t be checked until it ticks once more.',
  retired: 'Retired by staff; no longer alerts.',
};

const FILTERS = ['all', 'ok', 'failing', 'stale', 'hung', 'unknown', 'retired'] as const;
type Filter = (typeof FILTERS)[number];

function JobsBoard() {
  const jobs = useQuery(api.platform.jobs.listJobs, {});
  const failures = useQuery(api.platform.jobs.recentFailures, {});
  const retire = useMutation(api.platform.jobs.retireJob);
  const [openJob, setOpenJob] = useState<string | null>(null);
  const [filter, setFilter] = useState<Filter>('all');
  const [search, setSearch] = useState('');

  const notRunning = (jobs ?? []).filter((j) => j.state === 'stale' || j.state === 'hung');

  // Counts on the chips, so a filter is worth clicking before it is clicked.
  const counts = useMemo(() => {
    if (!jobs) return undefined;
    // Seeded with zeroes: a chip with no count reads as "unknown", which is a
    // different claim from "none".
    const out = Object.fromEntries(FILTERS.map((f) => [f, 0])) as Record<Filter, number>;
    out.all = jobs.length;
    for (const j of jobs) out[j.state as Filter] = (out[j.state as Filter] ?? 0) + 1;
    return out;
  }, [jobs]);

  const rows = useMemo(() => {
    const q = search.trim().toLowerCase();
    return (jobs ?? []).filter(
      (j) =>
        (filter === 'all' || j.state === filter) && (!q || j.jobName.toLowerCase().includes(q)),
    );
  }, [jobs, filter, search]);

  return (
    <>
      {notRunning.length > 0 ? (
        <Panel
          title="Not running"
          count={notRunning.length}
          subtitle="no error is thrown when a job simply stops"
          tone="danger"
          flush
        >
          {notRunning.map((j) => (
            <div className="audit-row" key={j._id}>
              <Badge tone="danger">{j.state}</Badge>
              <span className="action">{j.jobName}</span>
              <span className="muted">last started {formatAgo(j.lastStartedAt)}</span>
              {j.overdueMs != null ? (
                <span className="danger-text">{formatDuration(j.overdueMs)} overdue</span>
              ) : null}
              <span className="row-actions">
                <ReasonAction
                  label="Retire"
                  danger
                  onSubmit={async (reason) => {
                    await retire({ jobName: j.jobName, reason });
                  }}
                />
              </span>
            </div>
          ))}
        </Panel>
      ) : null}

      {failures && failures.length > 0 ? (
        <Panel title="Recent failures" count={failures.length} tone="warn" flush>
          {failures.map((f) => (
            <div className="audit-row" key={f._id}>
              <span className="when">{formatWhen(f.startedAt)}</span>
              <span className="action">{f.jobName}</span>
              <span className="danger-text">{f.error}</span>
            </div>
          ))}
        </Panel>
      ) : null}

      <Panel
        title="All jobs"
        count={jobs?.length}
        flush
        actions={
          <input
            className="search"
            style={{ marginBottom: 0, maxWidth: 220 }}
            placeholder="Filter by job name…"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
          />
        }
        footer={
          rows.length !== (jobs?.length ?? 0)
            ? `Showing ${rows.length} of ${jobs?.length ?? 0} jobs.`
            : null
        }
      >
        <FilterChips options={FILTERS} value={filter} onChange={setFilter} counts={counts} />
        {jobs === undefined ? (
          <EmptyState>Loading…</EmptyState>
        ) : jobs.length === 0 ? (
          <EmptyState>
            No ticks recorded yet — the ledger fills in as jobs fire after this deploy.
          </EmptyState>
        ) : rows.length === 0 ? (
          <EmptyState>No jobs in that state.</EmptyState>
        ) : (
          <div className="table-scroll">
            <table className="data-table table-sticky">
              <thead>
                <tr>
                  <th>Job</th>
                  <th>State</th>
                  <th>Last run</th>
                  <th>Every</th>
                  <th className="num">Duration</th>
                  <th className="num">Consecutive failures</th>
                  <th className="num">Failures / runs</th>
                  <th></th>
                </tr>
              </thead>
              <tbody>
                {rows.map((j) => (
                  <tr key={j._id}>
                    <td className="mono">{j.jobName}</td>
                    <td>
                      <span title={STATE_HELP[j.state] ?? ''}>
                        <Badge tone={toneFor(j.state)}>{j.state}</Badge>
                      </span>
                    </td>
                    <td className="muted">{formatAgo(j.lastStartedAt)}</td>
                    <td className="muted">
                      {j.expectedIntervalMs != null ? formatDuration(j.expectedIntervalMs) : '—'}
                    </td>
                    <td className="num">{formatDuration(j.lastDurationMs)}</td>
                    <td className="num">{j.consecutiveFailures}</td>
                    <td className="num muted">
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
      </Panel>

      {openJob ? <JobTrend jobName={openJob} onClose={() => setOpenJob(null)} /> : null}
    </>
  );
}

/**
 * Duration percentiles + recent runs. A job degrading from 2s to 45s is
 * invisible on last-duration alone, and the degradation usually shows up
 * before the failure does.
 */
function JobTrend({ jobName, onClose }: { jobName: string; onClose: () => void }) {
  const trend = useQuery(api.platform.jobs.jobTrend, { jobName });

  return (
    <Panel
      title={jobName}
      subtitle="history"
      actions={
        <button className="button button-sm button-quiet" onClick={onClose}>
          Close
        </button>
      }
      flush
    >
      {trend === undefined ? (
        <EmptyState>Loading history…</EmptyState>
      ) : trend.sample === 0 ? (
        <EmptyState hint="Sub-5-minute jobs only keep failures, by design.">
          No retained history.
        </EmptyState>
      ) : (
        <>
          <div className="kpi-row" style={{ padding: 12, marginBottom: 0 }}>
            <Kpi label="p50 duration" value={formatDuration(trend.p50Ms ?? 0)} />
            <Kpi label="p95 duration" value={formatDuration(trend.p95Ms ?? 0)} />
            <Kpi label="slowest" value={formatDuration(trend.maxMs ?? 0)} />
            <Kpi
              label={`failures / ${trend.sample} runs`}
              value={String(trend.failures)}
              tone={trend.failures > 0 ? 'danger' : 'neutral'}
            />
          </div>
          {trend.recent.map((r) => (
            <div className="audit-row" key={r._id}>
              <span className="when">{formatWhen(r.startedAt)}</span>
              <Badge tone={r.outcome === 'ok' ? 'ok' : 'danger'}>{r.outcome}</Badge>
              <span>{formatDuration(r.durationMs)}</span>
              {r.error ? <span className="danger-text">{r.error}</span> : null}
            </div>
          ))}
        </>
      )}
    </Panel>
  );
}
