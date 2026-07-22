'use client';

import { useCallback, useMemo, useState } from 'react';
import { PageHeader, SavedViews, FilterBar, WBtn } from '@/components/web';
import type { FilterChipValue } from '@/components/web';

import { ReportRangeSelect } from './shell/report-range-select';
import { ReportDrillSheet } from './shell/report-drill-sheet';
import { useReportFilterProperties } from './shell/use-report-filter-properties';
import { OverviewView } from './views/overview-view';
import { AgingView } from './views/aging-view';
import { DiscrepanciesView } from './views/discrepancies-view';
import { ProfitabilityView } from './views/profitability-view';
import { PlView } from './views/pl-view';
import {
  REPORT_VIEWS,
  resolveRange,
  type CustomRange,
  type DrillContent,
  type RangePresetId,
  type ReportViewId,
  type ResolvedRange,
} from './shell/types';

interface ReportsDashboardProps {
  organizationId: string;
  userId: string;
}

/**
 * Shared context handed to each view: the resolved period, active entity
 * filters, and the callbacks to open a drill / switch views. Views are added
 * per phase (see REDESIGN_PLAN.md); Phase 0 renders placeholders.
 */
export interface ReportViewContext {
  organizationId: string;
  range: ResolvedRange;
  filters: FilterChipValue[];
  onDrill: (content: DrillContent) => void;
  onView: (view: ReportViewId) => void;
  /** Active view registers its CSV export here so the header button can call it. */
  registerExport: (fn: (() => void) | null) => void;
}

export function ReportsDashboard({ organizationId }: ReportsDashboardProps) {
  const [view, setView] = useState<ReportViewId>('overview');
  const [preset, setPreset] = useState<RangePresetId>('this-quarter');
  const [custom, setCustom] = useState<CustomRange>({});
  const [filters, setFilters] = useState<FilterChipValue[]>([]);
  const [drill, setDrill] = useState<DrillContent | null>(null);
  const [exportFn, setExportFn] = useState<(() => void) | null>(null);

  const range = useMemo(() => resolveRange(preset, custom), [preset, custom]);
  const properties = useReportFilterProperties();
  const registerExport = useCallback((fn: (() => void) | null) => setExportFn(() => fn), []);

  const ctx: ReportViewContext = {
    organizationId,
    range,
    filters,
    onDrill: setDrill,
    onView: setView,
    registerExport,
  };

  return (
    <div className="relative flex min-h-0 flex-1 flex-col">
      <PageHeader
        title="Accounting Reports"
        actions={
          <WBtn variant="ghost" size="sm" leading="export" disabled={!exportFn} onClick={() => exportFn?.()}>
            Export CSV
          </WBtn>
        }
      />

      <SavedViews views={REPORT_VIEWS} activeId={view} onChange={(id) => setView(id as ReportViewId)} />

      {/* Control strip — period + entity filters */}
      <div className="flex flex-wrap items-center gap-2.5 border-b border-[var(--border-hairline)] bg-[var(--bg-surface)] px-6 py-2.5">
        <ReportRangeSelect
          preset={preset}
          custom={custom}
          label={range.label}
          sub={range.sub}
          onPickPreset={(p) => {
            setPreset(p);
            setCustom({});
          }}
          onApplyCustom={(from, to) => {
            setPreset('custom');
            setCustom({ from, to });
          }}
        />
        <span className="mx-0.5 h-[22px] w-px bg-[var(--border-hairline-strong)]" />
        <FilterBar properties={properties} value={filters} onChange={setFilters} slot="all" />
        <div className="flex-1" />
        {filters.length > 0 && (
          <WBtn variant="ghost" size="sm" onClick={() => setFilters([])}>
            Clear filters
          </WBtn>
        )}
      </div>

      {/* Content */}
      <div className="min-h-0 flex-1 overflow-auto bg-[var(--bg-canvas)]">
        <div className="mx-auto max-w-[1360px] px-6 pb-10 pt-4">
          {view === 'overview' && <OverviewView ctx={ctx} />}
          {view === 'aging' && <AgingView ctx={ctx} />}
          {view === 'disc' && <DiscrepanciesView ctx={ctx} />}
          {view === 'profit' && <ProfitabilityView ctx={ctx} />}
          {view === 'pl' && <PlView ctx={ctx} />}
        </div>
      </div>

      <ReportDrillSheet drill={drill} onClose={() => setDrill(null)} />
    </div>
  );
}
