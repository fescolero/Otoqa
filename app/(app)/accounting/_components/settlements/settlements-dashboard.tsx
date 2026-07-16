'use client';

/**
 * SettlementsDashboard — Accounting → Driver / Carrier Settlements, on the
 * Otoqa Web chassis. One chassis, two parties: the `party` prop swaps the
 * Convex module (driverSettlements / carrierSettlements) and the blocker
 * vocabulary; everything else is shared.
 *
 * PageHeader (pay-run stat-chips) → SavedViews tabs → TableToolbar +
 * FilterBar → shared Table → BulkBar → InfiniteFooter, mirroring the
 * invoices migration. Lifecycle views are *buckets* computed server-side
 * over the raw statuses (see convex/lib/settlementShared.ts):
 *   Needs attention → period closed + hard blockers (triage queue)
 *   Open → period still accruing          Ready to approve → closed + clean
 *   Approved → awaiting the pay run       Paid / Void → history (paginated)
 *
 * Detail work happens in SettlementPanel; finalized statements render in
 * SettlementDocPanel.
 */

import { useEffect, useMemo, useState, startTransition } from 'react';
import { useMutation, usePaginatedQuery, useConvex } from 'convex/react';
import { useAuthQuery } from '@/hooks/use-auth-query';
import { api } from '@/convex/_generated/api';
import { toast } from 'sonner';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import {
  Avatar,
  BulkAction,
  BulkBar,
  type ColumnDef,
  FilterBar,
  type FilterChipValue,
  type FilterProperty,
  InfiniteFooter,
  PageHeader,
  type PageHeaderStat,
  SavedViews,
  type SavedView,
  Table,
  type TableColumn,
  TableToolbar,
  WBtn,
  WIcon,
} from '@/components/web';
import { useUserPreferences } from '@/components/web/shell/use-user-preferences';
import { useDebounce } from '@/hooks/use-debounce';
import {
  PLAN_META,
  SettleChip,
  SettleIssueCell,
  type SettlementParty,
  type SettlementRow,
  blockersFor,
  chipKeyForRow,
  fmtPeriod,
  fmtShortDate,
  fmtUSD,
  fmtUSDCompact,
  payRunKey,
} from './settlement-meta';
import { SettlementPanel } from './settlement-panel';
import { useSettlementsLedger } from './use-settlements-ledger';
import {
  SettlementDocPanel,
  buildSettlementCompany,
  buildSettlementSections,
  type StatementPayable,
} from './settlement-doc-panel';
import { GenerateStatementsModal } from './generate-statements-modal';
import { bulkDownloadPdfs } from '@/lib/bulk-pdf';
import { runChunkedEach } from '@/lib/chunked-bulk';

interface SettlementsDashboardProps {
  party: SettlementParty;
  organizationId: string;
  userId: string;
}

type ViewId = 'attention' | 'open' | 'ready' | 'approved' | 'paid' | 'void' | 'disputed';

const ACTIVE_VIEWS: ReadonlySet<string> = new Set(['attention', 'open', 'ready']);

const SETTLED_STATUS: Record<string, 'APPROVED' | 'PAID' | 'VOID' | 'DISPUTED'> = {
  approved: 'APPROVED',
  paid: 'PAID',
  void: 'VOID',
  disputed: 'DISPUTED',
};

// ── per-cell renderers ──────────────────────────────────────────────────
function PayeeCell({ r }: { r: SettlementRow }) {
  return (
    <span className="inline-flex items-center gap-2 min-w-0">
      <Avatar name={r.payeeName} size={22} />
      <span className="block text-[13px] text-foreground truncate">{r.payeeName}</span>
    </span>
  );
}

function PlanCell({ r }: { r: SettlementRow }) {
  if (!r.planBasis) return <span className="text-[12.5px] text-[var(--text-tertiary)]">—</span>;
  const meta = PLAN_META[r.planBasis];
  return (
    <span className="inline-flex items-center gap-1.5 min-w-0">
      <WIcon name={meta.icon} size={13} color="var(--text-tertiary)" />
      <span className="text-[12.5px] font-medium text-foreground whitespace-nowrap">{meta.label}</span>
      {r.planDetail && (
        <span className="num text-[11.5px] text-[var(--text-tertiary)] truncate">{r.planDetail}</span>
      )}
    </span>
  );
}

// ── sorting (active views only — settled views keep server order) ────────
type SortDir = 'asc' | 'desc';
const COMPARATORS: Record<string, (a: SettlementRow, b: SettlementRow) => number> = {
  id: (a, b) => a.statementNumber.localeCompare(b.statementNumber),
  payee: (a, b) => a.payeeName.localeCompare(b.payeeName),
  plan: (a, b) => (a.planBasis ?? '').localeCompare(b.planBasis ?? ''),
  cadence: (a, b) => (a.cadence ?? '').localeCompare(b.cadence ?? ''),
  period: (a, b) => a.periodStart - b.periodStart,
  age: (a, b) => a.ageDays - b.ageDays,
  payDate: (a, b) => (a.payDate ?? 0) - (b.payDate ?? 0),
  units: (a, b) => a.loadCount - b.loadCount,
  earnTotal: (a, b) => a.earnTotal - b.earnTotal,
  deductTotal: (a, b) => a.deductTotal - b.deductTotal,
  net: (a, b) => a.net - b.net,
};

export function SettlementsDashboard({ party, organizationId, userId }: SettlementsDashboardProps) {
  const isCarrier = party === 'carrier';
  const noun = isCarrier ? 'carrier' : 'driver';
  const { density } = useUserPreferences();

  const [view, setView] = useState<ViewId>('attention');
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
  const [search, setSearch] = useState('');
  const [chipFilters, setChipFilters] = useState<FilterChipValue[]>([]);
  const [grouped, setGrouped] = useState(true);
  const [sortKey, setSortKey] = useState<string>('age');
  const [sortDir, setSortDir] = useState<SortDir>('desc');

  // Overlays
  const [openRow, setOpenRow] = useState<SettlementRow | null>(null);
  const [docIndex, setDocIndex] = useState<number | null>(null);
  const [payRows, setPayRows] = useState<SettlementRow[] | null>(null);
  const [reopenRow, setReopenRow] = useState<SettlementRow | null>(null);
  const [generateOpen, setGenerateOpen] = useState(false);
  const [carrierRunOpen, setCarrierRunOpen] = useState(false);

  const debouncedSearch = useDebounce(search, 300);
  const isActiveView = ACTIVE_VIEWS.has(view);
  const settledStatus = isActiveView ? null : SETTLED_STATUS[view];

  // Ledger adapter — the settlements_read_ledger flag picks legacy vs new. Read
  // refs are swapped inline below (identical args); writes go through the hook.
  const ledger = useSettlementsLedger({ party: isCarrier ? 'carrier' : 'driver', organizationId, userId });
  const useNew = ledger.useNew;
  const R = useNew ? api.payEngine.settlementReads : null;

  // The read ledger flipped at runtime (settlements_read_ledger changed):
  // every held row snapshot carries ids from the OTHER ledger's tables, so a
  // stale overlay would feed e.g. a driverSettlements id into the new
  // adapter's v.id('settlements') validator and crash the details query.
  // Close overlays and clear selection; fresh rows arrive from the new refs.
  useEffect(() => {
    setOpenRow(null);
    setDocIndex(null);
    setPayRows(null);
    setReopenRow(null);
    setSelectedIds(new Set());
  }, [useNew]);

  // ── data (both party modules wired; the inactive one is skipped) ──
  const driverStats = useAuthQuery(
    R ? R.getViewStats : api.driverSettlements.getViewStats,
    !isCarrier ? { workosOrgId: organizationId } : 'skip',
  );
  const carrierStats = useAuthQuery(
    R ? R.carrierGetViewStats : api.carrierSettlements.getViewStats,
    isCarrier ? { workosOrgId: organizationId } : 'skip',
  );
  const stats = isCarrier ? carrierStats : driverStats;

  const activeArgs = isActiveView
    ? {
        workosOrgId: organizationId,
        view: view as 'attention' | 'open' | 'ready',
        search: debouncedSearch || undefined,
      }
    : null;
  const driverActive = useAuthQuery(
    R ? R.listActive : api.driverSettlements.listActive,
    !isCarrier && activeArgs ? activeArgs : 'skip',
  );
  const carrierActive = useAuthQuery(
    R ? R.carrierListActive : api.carrierSettlements.listActive,
    isCarrier && activeArgs ? activeArgs : 'skip',
  );
  const activeData = isCarrier ? carrierActive : driverActive;

  const driverSettled = usePaginatedQuery(
    R ? R.listSettled : api.driverSettlements.listSettled,
    !isCarrier && settledStatus && settledStatus !== 'DISPUTED'
      ? {
          workosOrgId: organizationId,
          status: settledStatus as 'APPROVED' | 'PAID' | 'VOID',
          search: debouncedSearch || undefined,
        }
      : 'skip',
    { initialNumItems: 100 },
  );
  const carrierSettled = usePaginatedQuery(
    R ? R.carrierListSettled : api.carrierSettlements.listSettled,
    isCarrier && settledStatus
      ? {
          workosOrgId: organizationId,
          status: settledStatus,
          search: debouncedSearch || undefined,
        }
      : 'skip',
    { initialNumItems: 100 },
  );
  const settled = isCarrier ? carrierSettled : driverSettled;

  // ── mutations ──
  const convex = useConvex();
  const generateForAllCarriers = useMutation(api.carrierSettlements.generateForAllCarriers);

  const updateStatus = (
    id: string,
    newStatus: 'PENDING' | 'APPROVED' | 'PAID' | 'VOID',
    extra?: { paidMethod?: string; paidReference?: string; voidReason?: string },
  ) => ledger.updateStatus(id, newStatus, extra);

  // ── rows for the current view ──
  const chipMap = useMemo(
    () => new Map(chipFilters.map((c) => [c.propId, c.values])),
    [chipFilters],
  );

  const rows = useMemo<SettlementRow[]>(() => {
    const base: SettlementRow[] = isActiveView
      ? ((activeData?.rows ?? []) as unknown as SettlementRow[])
      : ((settled.results ?? []) as unknown as SettlementRow[]);

    let filtered = base;
    const blockerVals = chipMap.get('blocker');
    if (blockerVals?.length) {
      filtered = filtered.filter((r) => r.blockers.some((b) => blockerVals.includes(b.key)));
    }
    const planVals = chipMap.get('plan');
    if (planVals?.length) {
      filtered = filtered.filter((r) => r.planBasis && planVals.includes(r.planBasis));
    }
    const cadenceVals = chipMap.get('cadence');
    if (cadenceVals?.length) {
      filtered = filtered.filter((r) => r.cadence && cadenceVals.includes(r.cadence));
    }
    const payeeVals = chipMap.get('payee');
    if (payeeVals?.length) {
      filtered = filtered.filter((r) => payeeVals.includes(r.payeeName));
    }

    if (isActiveView) {
      const cmp = COMPARATORS[sortKey];
      if (cmp) {
        filtered = [...filtered].sort((a, b) => (sortDir === 'asc' ? cmp(a, b) : cmp(b, a)));
      }
    }
    return filtered;
  }, [isActiveView, activeData, settled.results, chipMap, sortKey, sortDir]);

  // ── columns ──
  const attentionCols: TableColumn<SettlementRow>[] = useMemo(
    () => [
      { key: 'payee', label: isCarrier ? 'Carrier' : 'Driver', width: '1.5fr', render: (r) => <PayeeCell r={r} /> },
      { key: 'plan', label: 'Pay basis', width: '1.3fr', render: (r) => <PlanCell r={r} /> },
      {
        key: 'period', label: 'Period', width: '130px', tnum: true,
        render: (r) => <span className="num text-[12.5px] text-[var(--text-secondary)] whitespace-nowrap">{fmtPeriod(r.periodStart, r.periodEnd)}</span>,
      },
      {
        key: 'age', label: 'Ended', width: '84px', align: 'right', tnum: true,
        render: (r) => (
          <span className={`num text-[12.5px] whitespace-nowrap ${r.ageDays >= 7 ? 'text-[#A66800] font-semibold' : 'text-[var(--text-secondary)]'}`}>
            {r.ageDays}d ago
          </span>
        ),
      },
      { key: 'blockers', label: 'Blockers', width: '1.4fr', sortable: false, render: (r) => <SettleIssueCell blockers={r.blockers} party={party} /> },
      {
        key: 'net', label: 'Est. net', width: '110px', align: 'right', tnum: true,
        render: (r) => (
          <span className={`num text-[12.5px] ${r.net < 0 ? 'font-semibold text-[#B43030]' : 'text-foreground'}`}>{fmtUSD(r.net, false)}</span>
        ),
      },
      {
        key: 'resolve', label: '', width: '96px', sortable: false, align: 'right',
        render: (r) => (
          <span onClick={(e) => e.stopPropagation()}>
            <WBtn size="xs" variant="secondary" onClick={() => setOpenRow(r)}>Resolve</WBtn>
          </span>
        ),
      },
    ],
    [isCarrier, party],
  );

  const settleCols: TableColumn<SettlementRow>[] = useMemo(
    () => [
      {
        key: 'id', label: 'Statement #', width: '136px',
        render: (r) => <span className="num text-[12.5px] font-medium text-[var(--accent)] whitespace-nowrap">{r.statementNumber}</span>,
      },
      { key: 'payee', label: isCarrier ? 'Carrier' : 'Driver', width: '1.5fr', render: (r) => <PayeeCell r={r} /> },
      { key: 'plan', label: 'Pay basis', width: '1.4fr', render: (r) => <PlanCell r={r} /> },
      {
        key: 'cadence', label: 'Schedule', width: '96px',
        render: (r) => <span className="text-[12.5px] text-[var(--text-secondary)] whitespace-nowrap">{r.cadence ?? '—'}</span>,
      },
      {
        key: 'period', label: 'Period', width: '134px', tnum: true,
        render: (r) => <span className="num text-[12.5px] text-[var(--text-secondary)] whitespace-nowrap">{fmtPeriod(r.periodStart, r.periodEnd)}</span>,
      },
      {
        key: 'payDate', label: view === 'paid' ? 'Paid' : 'Pay date', width: '88px', tnum: true,
        render: (r) => (
          <span className="num text-[12.5px] text-[var(--text-secondary)] whitespace-nowrap">
            {view === 'paid' ? fmtShortDate(r.paidAt) : fmtShortDate(r.payDate)}
          </span>
        ),
      },
      {
        key: 'units', label: 'Work', width: '92px', align: 'right', tnum: true,
        render: (r) => <span className="num text-[12.5px] text-[var(--text-secondary)] whitespace-nowrap">{r.units}</span>,
      },
      {
        key: 'earnTotal', label: 'Earnings', width: '100px', align: 'right', tnum: true,
        render: (r) => <span className="num text-[12.5px] text-[var(--text-secondary)]">{fmtUSD(r.earnTotal, false)}</span>,
      },
      {
        key: 'deductTotal', label: 'Deductions', width: '104px', align: 'right', tnum: true,
        render: (r) => (
          <span className={`num text-[12.5px] ${r.deductTotal > 0 ? 'text-[#A66800]' : 'text-[var(--text-tertiary)]'}`}>
            {r.deductTotal > 0 ? '−' + fmtUSD(r.deductTotal, false) : '—'}
          </span>
        ),
      },
      {
        key: 'net', label: 'Net pay', width: '104px', align: 'right', tnum: true,
        render: (r) => (
          <span className={`num text-[13px] font-semibold ${r.net < 0 ? 'text-[#B43030]' : 'text-foreground'}`}>{fmtUSD(r.net, false)}</span>
        ),
      },
      { key: 'status', label: 'Status', width: '108px', sortable: false, render: (r) => <SettleChip chip={chipKeyForRow(r)} /> },
    ],
    [isCarrier, view],
  );

  const cols = view === 'attention' ? attentionCols : settleCols;
  const [visibleCols, setVisibleCols] = useState<Set<string> | null>(null);
  const columnDefs: ColumnDef[] = cols
    .filter((c) => typeof c.label === 'string' && c.label)
    .map((c) => ({ key: c.key, label: c.label as string }));
  const shownCols = cols.filter((c) => !c.label || !visibleCols || visibleCols.has(c.key));

  // ── filters per view ──
  const filterProps: FilterProperty[] = useMemo(() => {
    const payeeOptions = [...new Set(rows.map((r) => r.payeeName))]
      .sort()
      .map((p) => ({ value: p, label: p }));
    if (view === 'attention') {
      return [
        {
          id: 'blocker', label: 'Blocker', icon: 'warn-tri', kind: 'enum', operator: 'is',
          options: Object.entries(blockersFor(party)).map(([k, m]) => ({ value: k, label: m.label })),
        },
        { id: 'payee', label: isCarrier ? 'Carrier' : 'Driver', icon: 'users', kind: 'enum', operator: 'is', options: payeeOptions },
      ];
    }
    return [
      {
        id: 'plan', label: 'Pay basis', icon: 'doc-dollar', kind: 'enum', operator: 'is',
        options: Object.entries(PLAN_META).map(([k, m]) => ({ value: k, label: m.label })),
      },
      {
        id: 'cadence', label: 'Schedule', icon: 'refresh', kind: 'enum', operator: 'is',
        options: [...new Set(rows.map((r) => r.cadence).filter(Boolean) as string[])].map((c) => ({ value: c, label: c })),
      },
      { id: 'payee', label: isCarrier ? 'Carrier' : 'Driver', icon: 'users', kind: 'enum', operator: 'is', options: payeeOptions },
    ];
  }, [view, rows, party, isCarrier]);

  // ── view chrome ──
  const counts = stats?.counts;
  const headerStats: PageHeaderStat[] = [
    { value: fmtUSDCompact(stats?.dueThisRun ?? 0), label: 'due this run' },
    { value: fmtUSDCompact(stats?.openAccruing ?? 0), label: 'open accruing' },
    { value: <span style={{ color: '#A66800' }}>{counts?.attention ?? 0}</span>, label: 'blocked' },
    { value: fmtUSDCompact(stats?.paidMtd ?? 0), label: 'paid MTD' },
  ];

  const views: SavedView[] = useMemo(() => {
    const base: SavedView[] = [
      { id: 'attention', label: 'Needs attention', count: counts?.attention ?? 0, tone: 'warn' },
      { id: 'open', label: 'Open', count: counts?.open ?? 0, tone: 'neutral' },
      { id: 'ready', label: 'Ready to approve', count: counts?.ready ?? 0, tone: 'accent' },
      { id: 'approved', label: 'Approved', count: counts?.approved ?? 0, tone: 'neutral' },
      { id: 'paid', label: 'Paid', count: counts?.paid ?? 0, tone: 'neutral' },
      { id: 'void', label: 'Void', count: counts?.void ?? 0, tone: 'neutral' },
    ];
    if (isCarrier && (counts as { disputed?: number } | undefined)?.disputed) {
      base.push({ id: 'disputed', label: 'Disputed', count: (counts as { disputed?: number }).disputed, tone: 'warn' });
    }
    return base;
  }, [counts, isCarrier]);

  const onChangeView = (next: string) => {
    setView(next as ViewId);
    setSelectedIds(new Set());
    setDocIndex(null);
    setVisibleCols(null);
    setChipFilters([]);
    setSortKey(next === 'attention' ? 'age' : 'payDate');
    setSortDir('desc');
  };

  const onSort = (key: string) => {
    if (sortKey === key) setSortDir(sortDir === 'asc' ? 'desc' : 'asc');
    else {
      setSortKey(key);
      setSortDir('asc');
    }
  };

  // ── selection ──
  const onSelectRow = (id: string | number) => {
    setSelectedIds((prev) => {
      const next = new Set(prev);
      if (next.has(id as string)) next.delete(id as string);
      else next.add(id as string);
      return next;
    });
  };
  const onSelectAll = () => {
    setSelectedIds((prev) => (prev.size === rows.length ? new Set() : new Set(rows.map((r) => r._id))));
  };

  // ── lifecycle actions ──
  const approveMany = async (ids: string[]) => {
    try {
      // Each approval locks every payable in its settlement — bound the
      // concurrency so a large selection doesn't fire hundreds at once.
      const result = await runChunkedEach(ids, (id) => updateStatus(id, 'APPROVED'));
      if (result.failed > 0) {
        toast.warning(`Approved ${result.success} settlement${result.success !== 1 ? 's' : ''}. ${result.failed} failed.`);
      } else {
        toast.success(`Approved ${result.success} settlement${result.success !== 1 ? 's' : ''}`);
      }
      setSelectedIds(new Set());
    } catch (err) {
      toast.error('Failed to approve settlements');
      console.error(err);
    }
  };

  const voidMany = async (ids: string[]) => {
    if (!confirm(`Void ${ids.length} settlement${ids.length > 1 ? 's' : ''}? Line items return to the unassigned pool when the statement is deleted.`)) return;
    try {
      const result = await runChunkedEach(ids, (id) => updateStatus(id, 'VOID'));
      if (result.failed > 0) {
        toast.warning(`Voided ${result.success} settlement${result.success !== 1 ? 's' : ''}. ${result.failed} failed.`);
      } else {
        toast.success(`Voided ${result.success} settlement${result.success !== 1 ? 's' : ''}`);
      }
      setSelectedIds(new Set());
    } catch (err) {
      toast.error('Failed to void settlements');
      console.error(err);
    }
  };

  // Bulk PDF download — render each selected statement to a PDF and deliver
  // them as a single zip (a one-statement selection downloads as a bare PDF).
  // Statement details are fetched imperatively per row; the panel itself uses
  // one reactive query at a time, so there is no hook to reuse here.
  const handleBulkDownload = async (targets: SettlementRow[]) => {
    if (targets.length === 0) return;
    const toastId = toast.loading(`Preparing ${targets.length} statement${targets.length > 1 ? 's' : ''}…`);
    try {
      const orgSettings = await convex.query(api.settings.getOrgSettings, { workosOrgId: organizationId });
      const company = buildSettlementCompany(orgSettings);
      const generatedOn = new Date().toLocaleDateString('en-US', {
        month: 'short',
        day: 'numeric',
        year: 'numeric',
      });
      const result = await bulkDownloadPdfs<SettlementRow>({
        items: targets,
        zipName: `${noun}-settlements`,
        concurrency: 3,
        onProgress: (done, total) =>
          toast.loading(`Rendering ${done}/${total} statement${total > 1 ? 's' : ''}…`, { id: toastId }),
        render: async (r) => {
          const detailsRef = useNew
            ? isCarrier ? api.payEngine.settlementReads.carrierGetSettlementDetails : api.payEngine.settlementReads.getSettlementDetails
            : isCarrier ? api.carrierSettlements.getSettlementDetails : api.driverSettlements.getSettlementDetails;
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          const details = await convex.query(detailsRef, { settlementId: r._id as any });
          const sections = buildSettlementSections((details?.payables ?? []) as StatementPayable[]);
          const { pdf } = await import('@react-pdf/renderer');
          const { SettlementPDF } = await import('./settlement-pdf-template');
          const blob = await pdf(
            <SettlementPDF row={r} party={party} sections={sections} company={company} generatedOn={generatedOn} />,
          ).toBlob();
          return { blob, name: `settlement-${r.statementNumber}` };
        },
      });
      if (result.failed.length === 0) {
        toast.success(`Downloaded ${result.ok} statement${result.ok > 1 ? 's' : ''}`, { id: toastId });
      } else if (result.ok > 0) {
        toast.warning(`Downloaded ${result.ok}; ${result.failed.length} failed to render`, { id: toastId });
      } else {
        toast.error('Failed to generate PDFs', { id: toastId });
      }
      setSelectedIds(new Set());
    } catch (err) {
      toast.error('Failed to download statements', { id: toastId });
      console.error(err);
    }
  };

  const recordPayment = async (targets: SettlementRow[], method: string, reference: string) => {
    try {
      const result = await runChunkedEach(targets, (r) =>
        updateStatus(r._id, 'PAID', { paidMethod: method, paidReference: reference || undefined }),
      );
      if (result.failed > 0) {
        toast.warning(`Recorded payment on ${result.success} settlement${result.success !== 1 ? 's' : ''}. ${result.failed} failed.`);
      } else {
        toast.success(
          targets.length === 1
            ? `${targets[0].statementNumber} marked paid`
            : `Recorded payment on ${result.success} settlements`,
        );
      }
      setSelectedIds(new Set());
      setPayRows(null);
      setOpenRow(null);
      setDocIndex(null);
    } catch (err) {
      toast.error('Failed to record payment');
      console.error(err);
    }
  };

  // Undo a recorded payment: PAID → APPROVED, clearing the payment stamps. For a
  // mis-recorded payment; the statement returns to the Approved queue to re-pay.
  const reversePayment = async (targets: SettlementRow[]) => {
    if (targets.length === 0) return;
    const label = targets.length === 1 ? targets[0].statementNumber : `${targets.length} settlements`;
    if (!confirm(`Undo the recorded payment on ${label}? It returns to Approved so you can re-record it.`)) return;
    try {
      const result = await runChunkedEach(targets, (r) => ledger.reversePayment(r._id));
      if (result.failed > 0) {
        toast.warning(`Reversed ${result.success} payment${result.success !== 1 ? 's' : ''}. ${result.failed} failed.`);
      } else {
        toast.success(
          targets.length === 1
            ? `Payment on ${targets[0].statementNumber} reversed — back in Approved`
            : `Reversed payment on ${result.success} settlements`,
        );
      }
      setSelectedIds(new Set());
      setOpenRow(null);
      setDocIndex(null);
    } catch (err) {
      toast.error('Failed to reverse payment');
      console.error(err);
    }
  };

  const reopen = async (target: SettlementRow, reason: string) => {
    try {
      await ledger.reopen(target._id, reason);
      toast.success(`${target.statementNumber} reopened — back in Ready to edit`);
      setReopenRow(null);
      setSelectedIds(new Set());
      setOpenRow(null);
      setDocIndex(null);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Failed to reopen settlement');
      console.error(err);
    }
  };

  // ── group by pay run (ready view) ──
  const useGroups = view === 'ready' && grouped;
  const groupToggle =
    view === 'ready' ? (
      <WBtn
        size="sm"
        variant={grouped ? 'primary' : 'secondary'}
        leading="list-tree"
        onClick={() => setGrouped((g) => !g)}
        title="Group settlements by pay run"
      >
        Group by pay run
      </WBtn>
    ) : undefined;

  const groupSummary = (key: string, groupRows: SettlementRow[]) => {
    const total = groupRows.reduce((s, r) => s + r.net, 0);
    return (
      <span className="inline-flex items-center gap-3.5">
        <span className="text-[12px] text-[var(--text-tertiary)]">
          <span className="num font-semibold text-[var(--text-secondary)]">{groupRows.length}</span> {noun}
          {groupRows.length > 1 ? 's' : ''}
        </span>
        <span className="text-[12px] text-[var(--text-tertiary)]">
          Net <span className="num font-semibold text-[var(--text-secondary)]">{fmtUSD(total, false)}</span>
        </span>
        <span onClick={(e) => e.stopPropagation()}>
          <WBtn size="xs" variant="secondary" leading="badge-check" onClick={() => approveMany(groupRows.map((r) => r._id))}>
            Approve run
          </WBtn>
        </span>
      </span>
    );
  };

  // ── bulk actions per view ──
  // Download is offered in every view (you settle records from paid/void too);
  // lifecycle actions are view-specific.
  const selectedRows = rows.filter((r) => selectedIds.has(r._id));
  const bulkActions = (
    <>
      <BulkAction icon="download" label="Download" onClick={() => handleBulkDownload(selectedRows)} />
      {view === 'ready' ? (
        <>
          <BulkAction icon="badge-check" label="Approve" onClick={() => approveMany(Array.from(selectedIds))} />
          <BulkAction icon="close" label="Void" danger onClick={() => voidMany(Array.from(selectedIds))} />
        </>
      ) : view === 'approved' ? (
        <>
          <BulkAction icon="doc-dollar" label="Record payment" onClick={() => setPayRows(selectedRows)} />
          <BulkAction icon="close" label="Void" danger onClick={() => voidMany(Array.from(selectedIds))} />
        </>
      ) : view === 'open' || view === 'attention' ? (
        <BulkAction icon="close" label="Void" danger onClick={() => voidMany(Array.from(selectedIds))} />
      ) : view === 'paid' ? (
        <BulkAction icon="refresh" label="Undo payment" onClick={() => reversePayment(selectedRows)} />
      ) : null}
    </>
  );

  // ── attention banner data ──
  const attentionRows = view === 'attention' ? rows : [];
  const oldest = attentionRows.reduce<SettlementRow | null>(
    (m, r) => (m == null || r.ageDays > m.ageDays ? r : m),
    null,
  );

  const isLoading = isActiveView ? activeData === undefined : settled.status === 'LoadingFirstPage';
  const infiniteTotal = isActiveView
    ? rows.length
    : settled.status === 'CanLoadMore' || settled.status === 'LoadingMore'
      ? Math.max(rows.length, (settledStatus && counts?.[view as keyof typeof counts]) || rows.length)
      : rows.length;

  const title = isCarrier ? 'Carrier Settlements' : 'Driver Settlements';

  return (
    <div className="h-full flex flex-col min-h-0 relative">
      <PageHeader
        title={title}
        stats={headerStats}
        actions={
          <WBtn size="sm" variant="primary" leading="refresh" onClick={() => (isCarrier ? setCarrierRunOpen(true) : setGenerateOpen(true))}>
            New pay run
          </WBtn>
        }
      />
      <SavedViews views={views} activeId={view} onChange={onChangeView} />

      {/* Triage banner — only on the attention view, only when there's work */}
      {view === 'attention' && attentionRows.length > 0 && (
        <div className="flex items-center gap-3 px-6 py-[11px] border-b border-[var(--border-hairline)]" style={{ background: 'rgba(245,158,11,0.06)' }}>
          <span className="inline-flex items-center justify-center rounded-[7px] shrink-0" style={{ width: 26, height: 26, background: 'rgba(245,158,11,0.14)', color: '#A66800' }}>
            <WIcon name="alert" size={15} />
          </span>
          <div className="flex-1 text-[12.5px] text-[var(--text-secondary)]">
            <strong className="text-foreground">
              {attentionRows.length} settlement{attentionRows.length > 1 ? 's' : ''}
            </strong>{' '}
            closed the period but can&apos;t be approved — clear the blockers to release{' '}
            <span className="num font-semibold text-foreground">{fmtUSD(stats?.blockedNet ?? 0, false)}</span> in {noun} pay.
          </div>
          {oldest && (
            <WBtn size="sm" variant="secondary" leading="badge-check" onClick={() => setOpenRow(oldest)}>
              Resolve oldest
            </WBtn>
          )}
        </div>
      )}

      {view === 'attention' && !isLoading && attentionRows.length === 0 && chipFilters.length === 0 && !search ? (
        <EmptyAttention noun={noun} onGoReady={() => onChangeView('ready')} />
      ) : (
        <>
          <TableToolbar
            searchPlaceholder={isCarrier ? 'Search statement #, carrier…' : 'Search statement #, driver…'}
            searchValue={search}
            onSearchChange={setSearch}
            columns={columnDefs}
            visibleColumns={visibleCols ?? new Set(columnDefs.map((c) => c.key))}
            onVisibleColumnsChange={setVisibleCols}
            rightContent={groupToggle}
            filterTrigger={
              chipFilters.length === 0 ? (
                <FilterBar properties={filterProps} value={chipFilters} onChange={setChipFilters} slot="trigger" />
              ) : null
            }
          >
            {chipFilters.length > 0 && (
              <>
                <FilterBar properties={filterProps} value={chipFilters} onChange={setChipFilters} slot="chips" />
                <FilterBar properties={filterProps} value={chipFilters} onChange={setChipFilters} slot="trigger" />
              </>
            )}
          </TableToolbar>

          <div className="flex-1 min-h-0 flex flex-col relative bg-card">
            <Table<SettlementRow>
              columns={shownCols}
              rows={rows}
              density={density}
              selected={Array.from(selectedIds)}
              onSelect={onSelectRow}
              onSelectAll={onSelectAll}
              sortKey={isActiveView ? sortKey : undefined}
              sortDir={isActiveView ? sortDir : undefined}
              onSort={isActiveView ? onSort : undefined}
              activeRowId={openRow?._id ?? null}
              getRowId={(r) => r._id}
              groupBy={useGroups ? payRunKey : undefined}
              groupLabel={useGroups ? (k) => `Pay run · ${k}` : undefined}
              groupSummary={useGroups ? groupSummary : undefined}
              onRowClick={(r) => {
                if (r.bucket === 'paid' || r.bucket === 'void') setDocIndex(rows.indexOf(r));
                else setOpenRow(r);
              }}
              onEndReached={
                !isActiveView && settled.status === 'CanLoadMore'
                  ? () => startTransition(() => settled.loadMore(100))
                  : undefined
              }
            />
            {isLoading && rows.length === 0 && (
              <div className="absolute inset-0 flex items-center justify-center text-[12.5px] text-[var(--text-tertiary)]">
                Loading settlements…
              </div>
            )}
            {!isLoading && rows.length === 0 && (
              <div className="absolute inset-0 flex items-center justify-center text-[12.5px] text-[var(--text-tertiary)]">
                No {view === 'attention' ? 'blocked' : view} settlements
                {search || chipFilters.length > 0 ? ' matching your filters' : ''}
              </div>
            )}
            <InfiniteFooter
              loaded={rows.length}
              total={infiniteTotal}
              loading={!isActiveView && settled.status === 'LoadingMore'}
            />
            <BulkBar count={selectedIds.size} onClear={() => setSelectedIds(new Set())} actions={bulkActions} />
          </div>
        </>
      )}

      {/* Working slide-over. Feed the LIVE row from the reactive list (matched
          by id) so in-modal actions — verify a blocker, edit a line, add an
          adjustment — reflect immediately instead of showing the stale
          snapshot captured when the row was first opened. */}
      {openRow && (
        <SettlementPanel
          party={party}
          row={rows.find((r) => r._id === openRow._id) ?? openRow}
          organizationId={organizationId}
          userId={userId}
          onClose={() => setOpenRow(null)}
          onOpenDoc={(r) => {
            setOpenRow(null);
            setDocIndex(Math.max(rows.indexOf(r), 0));
          }}
          onRecordPayment={(r) => setPayRows([r])}
          onReopen={(r) => {
            setOpenRow(null);
            setReopenRow(r);
          }}
          onChanged={() => setSelectedIds(new Set())}
        />
      )}

      {/* Statement document preview */}
      {docIndex != null && rows[docIndex] && (
        <SettlementDocPanel
          party={party}
          list={rows}
          index={docIndex}
          organizationId={organizationId}
          onNavigate={setDocIndex}
          onClose={() => setDocIndex(null)}
          // Close the preview (z-60) before opening the payment dialog so the
          // dialog — and its Select dropdown — render at the default modal
          // layer (z-50) instead of being trapped behind the preview. One
          // modal at a time; recordPayment closes the preview on success too.
          onRecordPayment={(r) => {
            setDocIndex(null);
            setPayRows([r]);
          }}
          onReversePayment={(r) => reversePayment([r])}
          onReopen={(r) => {
            setDocIndex(null);
            setReopenRow(r);
          }}
        />
      )}

      {/* Record payment */}
      <RecordPaymentDialog
        rows={payRows}
        onClose={() => setPayRows(null)}
        onSubmit={(method, reference) => payRows && recordPayment(payRows, method, reference)}
      />

      {/* Reopen to edit */}
      <ReopenDialog
        key={reopenRow?._id ?? 'reopen'}
        row={reopenRow}
        onClose={() => setReopenRow(null)}
        onSubmit={(reason) => reopenRow && reopen(reopenRow, reason)}
      />

      {/* New pay run */}
      {!isCarrier && (
        <GenerateStatementsModal
          open={generateOpen}
          onOpenChange={setGenerateOpen}
          organizationId={organizationId}
          userId={userId}
        />
      )}
      {isCarrier && (
        <CarrierRunDialog
          open={carrierRunOpen}
          onClose={() => setCarrierRunOpen(false)}
          onSubmit={async (periodStart, periodEnd) => {
            try {
              // Fans out one transaction per carrier; statements stream into
              // the list reactively. Carriers with nothing to settle are
              // skipped silently.
              const result = await generateForAllCarriers({
                workosOrgId: organizationId,
                periodStart,
                periodEnd,
                userId,
              });
              setCarrierRunOpen(false);
              if (result.scheduled > 0) {
                toast.success(`Generating statements for ${result.scheduled} active carrier${result.scheduled > 1 ? 's' : ''}`, {
                  description: 'They appear in the list as each one completes. Carriers with no unassigned pay in the period are skipped.',
                });
              } else {
                toast.info('No active carrier partnerships found');
              }
            } catch (err) {
              toast.error('Failed to generate carrier statements');
              console.error(err);
            }
          }}
        />
      )}
    </div>
  );
}

// ── Record payment dialog (single or bulk) ──────────────────────────────
function RecordPaymentDialog({
  rows,
  onClose,
  onSubmit,
}: {
  rows: SettlementRow[] | null;
  onClose: () => void;
  onSubmit: (method: string, reference: string) => void;
}) {
  const [method, setMethod] = useState('ACH');
  const [reference, setReference] = useState('');
  const total = (rows ?? []).reduce((s, r) => s + r.net, 0);
  return (
    <Dialog open={rows != null} onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>Record payment</DialogTitle>
          <DialogDescription>
            {rows?.length === 1
              ? `${rows[0].statementNumber} · ${rows[0].payeeName} · ${fmtUSD(rows[0].net)}`
              : `${rows?.length ?? 0} settlements · ${fmtUSD(total)} total`}
          </DialogDescription>
        </DialogHeader>
        <div className="grid gap-4 py-2">
          <div className="grid gap-2">
            <Label>Method</Label>
            {/* Segmented control instead of a Select: only three options, and a
                portal-based dropdown inside this modal hit a Radix dismissable-
                layer conflict (the open click's pointer-up landed on the dialog
                overlay and instantly closed the menu). Buttons sidestep that
                entirely and are one click instead of two. */}
            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3, 1fr)', gap: 6 }}>
              {(['ACH', 'Check', 'Wire'] as const).map((m) => {
                const active = method === m;
                return (
                  <button
                    key={m}
                    type="button"
                    onClick={() => setMethod(m)}
                    aria-pressed={active}
                    className="focus-ring"
                    style={{
                      height: 36,
                      borderRadius: 8,
                      fontSize: 13,
                      fontWeight: 500,
                      cursor: 'pointer',
                      border: `1px solid ${active ? 'var(--accent)' : 'var(--border)'}`,
                      background: active ? 'color-mix(in srgb, var(--accent) 12%, transparent)' : 'transparent',
                      color: active ? 'var(--accent)' : 'var(--text-secondary)',
                      transition: 'all var(--dur-fast)',
                    }}
                  >
                    {m}
                  </button>
                );
              })}
            </div>
          </div>
          <div className="grid gap-2">
            <Label>Reference</Label>
            <Input
              value={reference}
              onChange={(e) => setReference(e.target.value)}
              placeholder="Check #, transaction ID…"
            />
          </div>
        </div>
        <DialogFooter>
          <WBtn variant="secondary" onClick={onClose}>Cancel</WBtn>
          <WBtn variant="primary" leading="badge-check" onClick={() => onSubmit(method, reference)}>
            Mark paid
          </WBtn>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

// ── Reopen dialog (single settlement — reason required for the audit trail) ──
function ReopenDialog({
  row,
  onClose,
  onSubmit,
}: {
  row: SettlementRow | null;
  onClose: () => void;
  onSubmit: (reason: string) => void;
}) {
  const [reason, setReason] = useState('');
  const trimmed = reason.trim();
  return (
    <Dialog open={row != null} onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>Reopen settlement</DialogTitle>
          <DialogDescription>
            {row
              ? `${row.statementNumber} · ${row.payeeName} · ${fmtUSD(row.net)}`
              : ''}
          </DialogDescription>
        </DialogHeader>
        <div className="grid gap-3 py-2">
          <p className="text-[12.5px] text-[var(--text-secondary)]">
            This unlocks the statement back to <strong>Ready</strong> so you can correct it, then re-approve.
            Auto-generated lines return to the rules engine; your manual edits and adjustments are kept.
          </p>
          <div className="grid gap-2">
            <Label>Reason</Label>
            <Input
              autoFocus
              value={reason}
              onChange={(e) => setReason(e.target.value)}
              placeholder="e.g. wrong mileage rate"
              onKeyDown={(e) => {
                if (e.key === 'Enter' && trimmed) onSubmit(trimmed);
              }}
            />
          </div>
        </div>
        <DialogFooter>
          <WBtn variant="secondary" onClick={onClose}>Cancel</WBtn>
          <WBtn variant="primary" leading="edit-pen" disabled={!trimmed} onClick={() => onSubmit(trimmed)}>
            Reopen
          </WBtn>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

// ── New carrier pay run (period picker) ─────────────────────────────────
function CarrierRunDialog({
  open,
  onClose,
  onSubmit,
}: {
  open: boolean;
  onClose: () => void;
  onSubmit: (periodStart: number, periodEnd: number) => Promise<void>;
}) {
  const toInput = (t: number) => new Date(t).toISOString().slice(0, 10);
  const weekAgo = Date.now() - 7 * 86_400_000;
  const [start, setStart] = useState(toInput(weekAgo));
  const [end, setEnd] = useState(toInput(Date.now()));
  const [busy, setBusy] = useState(false);
  return (
    <Dialog open={open} onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>New carrier pay run</DialogTitle>
          <DialogDescription>
            Generates a statement for every active carrier with unassigned pay items in the period.
          </DialogDescription>
        </DialogHeader>
        <div className="grid grid-cols-2 gap-4 py-2">
          <div className="grid gap-2">
            <Label>Period start</Label>
            <Input type="date" value={start} onChange={(e) => setStart(e.target.value)} />
          </div>
          <div className="grid gap-2">
            <Label>Period end</Label>
            <Input type="date" value={end} onChange={(e) => setEnd(e.target.value)} />
          </div>
        </div>
        <DialogFooter>
          <WBtn variant="secondary" onClick={onClose}>Cancel</WBtn>
          <WBtn
            variant="primary"
            leading="refresh"
            disabled={busy}
            onClick={async () => {
              setBusy(true);
              try {
                await onSubmit(
                  new Date(`${start}T00:00:00`).getTime(),
                  new Date(`${end}T23:59:59.999`).getTime(),
                );
              } finally {
                setBusy(false);
              }
            }}
          >
            {busy ? 'Generating…' : 'Generate statements'}
          </WBtn>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

// ── Empty state for the attention queue ─────────────────────────────────
function EmptyAttention({ noun, onGoReady }: { noun: string; onGoReady: () => void }) {
  return (
    <div className="flex-1 flex items-center justify-center bg-card">
      <div className="text-center max-w-sm px-6">
        <span className="inline-flex items-center justify-center rounded-2xl bg-[rgba(16,185,129,0.10)] text-[#0F8C5F] mb-3.5" style={{ height: 52, width: 52 }}>
          <WIcon name="badge-check" size={26} />
        </span>
        <div className="text-[16px] font-semibold text-foreground">All caught up</div>
        <div className="text-[13px] text-[var(--text-tertiary)] mt-1.5 leading-[19px]">
          Every closed period is clean. New exceptions land here automatically when a {noun}&apos;s settlement can&apos;t be approved.
        </div>
        <div className="mt-4 flex justify-center">
          <WBtn size="sm" variant="primary" leading="arrow-right" onClick={onGoReady}>
            Go to ready to approve
          </WBtn>
        </div>
      </div>
    </div>
  );
}
