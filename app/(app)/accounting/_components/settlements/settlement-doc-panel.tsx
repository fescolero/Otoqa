'use client';

/**
 * SettlementDocPanel — the rendered settlement-statement preview overlay for
 * the Driver / Carrier Settlements screens (approved / paid rows).
 *
 * Full-screen dark chrome above everything: 52px toolbar ("Statement preview"
 * title, ‹ n / total › pager, Print, PDF, accent "Record payment" when
 * approved, close) over a scrollable 720px statement card. Esc closes,
 * ArrowLeft/ArrowRight page through the current view, clicking the backdrop
 * closes (clicks on the card don't).
 *
 * Line items come from {driver,carrier}Settlements.getSettlementDetails and
 * are classified into Earnings / Reimbursements / Deductions with the same
 * `classifyPayable` the backend uses, so the document always agrees with the
 * table. While details load, the totals card falls back to the row's
 * pre-computed totals and the line area shows a skeleton.
 *
 * Print / PDF mirror invoice-preview-sheet.tsx: render a @react-pdf/renderer
 * document to a blob, then open it in a new tab (Print) or download it (PDF).
 */

import * as React from 'react';
import { toast } from 'sonner';

import { api } from '@/convex/_generated/api';
import type { Id } from '@/convex/_generated/dataModel';
import { classifyPayable } from '@/convex/lib/settlementShared';
import { useAuthQuery } from '@/hooks/use-auth-query';
import { WBtn, WIcon, type IconName } from '@/components/web';

import {
  PLAN_META,
  SETTLE_PRESETS,
  SettleChip,
  chipKeyForRow,
  fmtPeriod,
  fmtUSD,
  type SettlementParty,
  type SettlementRow,
} from './settlement-meta';

// ── local formatters ─────────────────────────────────────────────────────────
// The design hardcoded ", 2026" suffixes — render real dates with year instead.

export const fmtDateYear = (t: number | null | undefined): string =>
  t == null
    ? '—'
    : new Date(t).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });

export function fmtPeriodYear(start: number, end: number): string {
  const s = new Date(start);
  const e = new Date(end);
  if (s.getFullYear() === e.getFullYear()) return `${fmtPeriod(start, end)}, ${e.getFullYear()}`;
  return `${fmtDateYear(start)} – ${fmtDateYear(end)}`;
}

function formatPhone(phone: string | undefined | null): string {
  if (!phone) return '';
  const digits = phone.replace(/\D/g, '');
  if (digits.length !== 10) return phone;
  return `(${digits.slice(0, 3)}) ${digits.slice(3, 6)}-${digits.slice(6)}`;
}

// ── statement data shapes ────────────────────────────────────────────────────

/** Narrow view of a payable line — both detail queries return this shape. */
export interface StatementPayable {
  description: string;
  quantity: number;
  rate: number;
  totalAmount: number;
  sourceType: 'SYSTEM' | 'MANUAL';
  category?: 'EARNING' | 'REIMBURSEMENT' | 'DEDUCTION';
  isRebillable?: boolean;
  loadOrderNumber?: string;
  loadInternalId?: string;
}

export interface StatementSections {
  earn: StatementPayable[];
  reimb: StatementPayable[];
  deduct: StatementPayable[];
  earnTotal: number;
  reimbTotal: number;
  deductTotal: number;
  net: number;
}

export interface CompanyBlock {
  name: string;
  addressLines: string[];
  email: string;
  phone: string;
  logoUrl: string | null;
}

/** Loose shape of `settings.getOrgSettings` — only the fields the PDF uses. */
type OrgSettingsForPdf =
  | {
      name?: string | null;
      billingEmail?: string | null;
      billingPhone?: string | null;
      logoUrl?: string | null;
      billingAddress?: {
        addressLine1: string;
        addressLine2?: string | null;
        city: string;
        state: string;
        zip: string;
        country: string;
      } | null;
    }
  | null
  | undefined;

/**
 * Build the company header block from org settings — shared by the on-screen
 * panel and the bulk-download renderer so both PDFs are identical.
 */
export function buildSettlementCompany(orgSettings: OrgSettingsForPdf): CompanyBlock {
  const addr = orgSettings?.billingAddress;
  const addressLines = addr
    ? [
        addr.addressLine1,
        ...(addr.addressLine2 ? [addr.addressLine2] : []),
        `${addr.city}, ${addr.state} ${addr.zip}`,
        addr.country,
      ]
    : [];
  return {
    name: orgSettings?.name ?? '',
    addressLines,
    email: orgSettings?.billingEmail ?? '',
    phone: formatPhone(orgSettings?.billingPhone),
    logoUrl: orgSettings?.logoUrl ?? null,
  };
}

/**
 * Classify payable lines into earnings / reimbursements / deductions with
 * totals derived from the same lists, so the totals card always agrees with the
 * section contents. Shared by the panel and the bulk-download renderer.
 */
export function buildSettlementSections(payables: StatementPayable[]): StatementSections {
  const earn: StatementPayable[] = [];
  const reimb: StatementPayable[] = [];
  const deduct: StatementPayable[] = [];
  for (const p of payables) {
    const cat = classifyPayable(p);
    if (cat === 'DEDUCTION') deduct.push(p);
    else if (cat === 'REIMBURSEMENT') reimb.push(p);
    else earn.push(p);
  }
  const earnTotal = earn.reduce((s, p) => s + p.totalAmount, 0);
  const reimbTotal = reimb.reduce((s, p) => s + p.totalAmount, 0);
  const deductTotal = deduct.reduce((s, p) => s + Math.abs(p.totalAmount), 0);
  return { earn, reimb, deduct, earnTotal, reimbTotal, deductTotal, net: earnTotal + reimbTotal - deductTotal };
}

/**
 * "Basis" cell for an earning line — `1,204 mi @ $0.62/mi`, `9.5 h @ $28/hr`,
 * `28% of $4,600`, or `Flat` for single-quantity lines.
 */
export function basisLabel(p: StatementPayable, basis: SettlementRow['planBasis']): string {
  if (p.quantity > 1) {
    if (basis === 'pct' && p.rate <= 1) {
      return `${Math.round(p.rate * 100)}% of ${fmtUSD(p.quantity, false)}`;
    }
    const qty =
      basis === 'hourly'
        ? p.quantity.toFixed(1)
        : Math.round(p.quantity).toLocaleString('en-US');
    const unit = basis === 'mile' ? ' mi' : basis === 'hourly' ? ' h' : '';
    const rate =
      basis === 'mile'
        ? `$${p.rate.toFixed(2)}/mi`
        : basis === 'hourly'
          ? `$${p.rate}/hr`
          : fmtUSD(p.rate);
    return `${qty}${unit} @ ${rate}`;
  }
  return p.sourceType === 'MANUAL' || basis === 'flat' ? 'Flat' : '—';
}

/** Earning row display: order number (mono) with description sub when a load backs the line. */
export function lineDisplay(p: StatementPayable): { label: string; sub: string | null; mono: boolean } {
  const loadRef = p.loadOrderNumber ?? p.loadInternalId ?? null;
  if (loadRef) return { label: loadRef, sub: p.description, mono: true };
  return { label: p.description, sub: null, mono: false };
}

// ── PDF document (mirrors the on-screen statement; Print/PDF both render it) ─


// ── chrome bits ──────────────────────────────────────────────────────────────

function ToolBtn({
  icon,
  label,
  onClick,
  disabled,
  title,
}: {
  icon: IconName;
  label: string;
  onClick?: () => void;
  disabled?: boolean;
  title?: string;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      title={title}
      className="focus-ring inline-flex items-center font-medium disabled:opacity-50 disabled:cursor-not-allowed"
      style={{
        height: 32,
        padding: '0 12px',
        borderRadius: 8,
        cursor: disabled ? 'default' : 'pointer',
        fontFamily: 'inherit',
        gap: 7,
        fontSize: 12.5,
        background: 'rgba(255,255,255,0.08)',
        border: '1px solid rgba(255,255,255,0.14)',
        color: '#FFFFFF',
        transition: 'background var(--dur-fast) var(--ease-out)',
      }}
      onMouseEnter={(e) => {
        if (!disabled) e.currentTarget.style.background = 'rgba(255,255,255,0.14)';
      }}
      onMouseLeave={(e) => {
        e.currentTarget.style.background = 'rgba(255,255,255,0.08)';
      }}
    >
      <WIcon name={icon} size={14} />
      {label}
    </button>
  );
}

function PagerBtn({
  dir,
  disabled,
  onClick,
}: {
  dir: -1 | 1;
  disabled: boolean;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      disabled={disabled}
      onClick={onClick}
      title={dir < 0 ? 'Previous statement (←)' : 'Next statement (→)'}
      className="focus-ring inline-flex items-center justify-center"
      style={{
        width: 28,
        height: 28,
        borderRadius: 7,
        cursor: disabled ? 'default' : 'pointer',
        background: 'transparent',
        border: 0,
        color: disabled ? 'rgba(255,255,255,0.25)' : 'rgba(255,255,255,0.75)',
      }}
    >
      <WIcon name={dir < 0 ? 'chevron-left' : 'chevron-right'} size={14} />
    </button>
  );
}

// ── document bits ────────────────────────────────────────────────────────────

function StDocRow({
  label,
  value,
  strong,
  negative,
}: {
  label: string;
  value: string;
  strong?: boolean;
  negative?: boolean;
}) {
  return (
    <div className="flex items-center justify-between gap-4">
      <span
        style={{
          fontSize: strong ? 14 : 12.5,
          fontWeight: strong ? 700 : 400,
          color: strong ? 'var(--text-primary)' : 'var(--text-secondary)',
        }}
      >
        {label}
      </span>
      <span
        className="num"
        style={{
          fontSize: strong ? 16 : 12.5,
          fontWeight: strong ? 700 : 500,
          color: negative ? '#B43030' : 'var(--text-primary)',
        }}
      >
        {value}
      </span>
    </div>
  );
}

const COL_GRID: React.CSSProperties = {
  display: 'grid',
  gridTemplateColumns: '1fr 160px 100px',
  gap: 12,
};

function ColHead({ children, right }: { children: React.ReactNode; right?: boolean }) {
  return (
    <span
      className="uppercase"
      style={{
        fontSize: 10.5,
        fontWeight: 600,
        letterSpacing: 0.5,
        color: 'var(--text-tertiary)',
        textAlign: right ? 'right' : 'left',
      }}
    >
      {children}
    </span>
  );
}

function FieldLabel({ children }: { children: React.ReactNode }) {
  return (
    <div
      className="uppercase"
      style={{
        fontSize: 10.5,
        fontWeight: 600,
        letterSpacing: 0.5,
        color: 'var(--text-tertiary)',
        marginBottom: 6,
      }}
    >
      {children}
    </div>
  );
}

/** Shimmer placeholder row while settlement details load. */
function SkeletonRow() {
  return (
    <div style={{ ...COL_GRID, padding: '12px 0', borderBottom: '1px solid var(--border-hairline)' }}>
      <div className="animate-pulse rounded" style={{ height: 12, width: '55%', background: 'var(--bg-surface-2)' }} />
      <div className="animate-pulse rounded justify-self-end" style={{ height: 12, width: 90, background: 'var(--bg-surface-2)' }} />
      <div className="animate-pulse rounded justify-self-end" style={{ height: 12, width: 64, background: 'var(--bg-surface-2)' }} />
    </div>
  );
}

// ── SettlementDocPanel ───────────────────────────────────────────────────────

export interface SettlementDocPanelProps {
  party: SettlementParty;
  list: SettlementRow[];
  index: number;
  organizationId: string;
  onNavigate: (index: number) => void;
  onClose: () => void;
  /** Only shown when row.status === 'APPROVED'. */
  onRecordPayment: (row: SettlementRow) => void;
  /** Only shown when row.status === 'PAID' — reverses the payment to Approved. */
  onReversePayment?: (row: SettlementRow) => void;
  /** Only shown when row.status === 'APPROVED' — reopens to Draft for edits. */
  onReopen?: (row: SettlementRow) => void;
}

export function SettlementDocPanel({
  party,
  list,
  index,
  organizationId,
  onNavigate,
  onClose,
  onRecordPayment,
  onReversePayment,
  onReopen,
}: SettlementDocPanelProps) {
  const row: SettlementRow | undefined = list[index];
  const count = list.length;

  // "Generated on" date for the statement — captured once per mount so render
  // stays pure (react-hooks/purity flags Date.now() in render).
  const [generatedOn] = React.useState(() => fmtDateYear(Date.now()));

  // Esc closes; arrows page through the current view.
  React.useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
      else if (e.key === 'ArrowLeft' && index > 0) onNavigate(index - 1);
      else if (e.key === 'ArrowRight' && index < count - 1) onNavigate(index + 1);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose, onNavigate, index, count]);

  // Line items — one detail query per party; the other stays skipped.
  const driverDetails = useAuthQuery(
    api.driverSettlements.getSettlementDetails,
    party === 'driver' && row ? { settlementId: row._id as Id<'driverSettlements'> } : 'skip',
  );
  const carrierDetails = useAuthQuery(
    api.carrierSettlements.getSettlementDetails,
    party === 'carrier' && row ? { settlementId: row._id as Id<'carrierSettlements'> } : 'skip',
  );
  const payables: StatementPayable[] | undefined =
    party === 'driver' ? driverDetails?.payables : carrierDetails?.payables;

  // Company block — same source as the invoice preview (org settings).
  const orgSettings = useAuthQuery(api.settings.getOrgSettings, { workosOrgId: organizationId });
  const company = React.useMemo<CompanyBlock>(() => buildSettlementCompany(orgSettings), [orgSettings]);

  // Classify lines into statement sections; totals derive from the same lists
  // so the totals card always agrees with the section contents.
  const sections = React.useMemo<StatementSections | null>(
    () => (payables ? buildSettlementSections(payables) : null),
    [payables],
  );

  // Print / PDF — same approach as invoice-preview-sheet: render the
  // @react-pdf document to a blob, then open (print) or download (PDF).
  const handlePrint = React.useCallback(async () => {
    if (!row || !sections) {
      toast.error('Statement data not ready');
      return;
    }
    try {
      toast.loading('Generating PDF for printing...');
      const { pdf } = await import('@react-pdf/renderer');
      const { SettlementPDF } = await import('./settlement-pdf-template');
      const blob = await pdf(
        <SettlementPDF
          row={row}
          party={party}
          sections={sections}
          company={company}
          generatedOn={fmtDateYear(Date.now())}
        />,
      ).toBlob();
      const url = URL.createObjectURL(blob);
      window.open(url, '_blank');
      toast.dismiss();
      toast.success('PDF opened in new tab');
      setTimeout(() => URL.revokeObjectURL(url), 1000);
    } catch (error) {
      toast.dismiss();
      toast.error('Failed to generate PDF');
      console.error('Settlement PDF generation error:', error);
    }
  }, [row, party, sections, company]);

  const handleDownloadPDF = React.useCallback(async () => {
    if (!row || !sections) {
      toast.error('Statement data not ready');
      return;
    }
    try {
      toast.loading('Generating PDF...');
      const { pdf } = await import('@react-pdf/renderer');
      const { SettlementPDF } = await import('./settlement-pdf-template');
      const blob = await pdf(
        <SettlementPDF
          row={row}
          party={party}
          sections={sections}
          company={company}
          generatedOn={fmtDateYear(Date.now())}
        />,
      ).toBlob();
      const url = URL.createObjectURL(blob);
      const link = document.createElement('a');
      link.href = url;
      link.download = `settlement-${row.statementNumber}.pdf`;
      document.body.appendChild(link);
      link.click();
      document.body.removeChild(link);
      URL.revokeObjectURL(url);
      toast.dismiss();
      toast.success('PDF downloaded successfully');
    } catch (error) {
      toast.dismiss();
      toast.error('Failed to generate PDF');
      console.error('Settlement PDF generation error:', error);
    }
  }, [row, party, sections, company]);

  if (!row) return null;

  const isPaid = row.paidAt != null;
  const planMeta = row.planBasis ? PLAN_META[row.planBasis] : null;
  const docReady = sections != null;
  // While details load, fall back to the row's pre-computed totals.
  const totals = sections ?? {
    earnTotal: row.earnTotal,
    reimbTotal: row.reimbTotal,
    deductTotal: row.deductTotal,
    net: row.net,
  };
  const hasAdjustments = sections != null && (sections.reimb.length > 0 || sections.deduct.length > 0);
  const logoLetter = (company.name || 'O').charAt(0).toUpperCase();

  return (
    <div
      className="fixed inset-0 z-[60] flex flex-col animate-in fade-in duration-150"
      style={{ background: 'rgba(15,22,36,0.78)' }}
    >
      {/* preview chrome */}
      <div className="flex shrink-0 items-center gap-2.5 px-4" style={{ height: 52 }}>
        <span style={{ fontSize: 13.5, fontWeight: 600, color: '#FFFFFF' }}>Statement preview</span>
        <div className="ml-2 flex items-center" style={{ gap: 2 }}>
          <PagerBtn dir={-1} disabled={index === 0} onClick={() => onNavigate(index - 1)} />
          <span
            className="num text-center"
            style={{ fontSize: 12.5, color: 'rgba(255,255,255,0.65)', minWidth: 48 }}
          >
            {index + 1} / {count}
          </span>
          <PagerBtn dir={1} disabled={index === count - 1} onClick={() => onNavigate(index + 1)} />
        </div>
        <div className="flex-1" />
        <ToolBtn
          icon="export"
          label="Print"
          onClick={handlePrint}
          disabled={!docReady}
          title={docReady ? 'Print statement' : 'Loading statement lines…'}
        />
        <ToolBtn
          icon="import"
          label="PDF"
          onClick={handleDownloadPDF}
          disabled={!docReady}
          title={docReady ? 'Download PDF' : 'Loading statement lines…'}
        />
        {row.status === 'APPROVED' && onReopen && (
          <WBtn variant="secondary" leading="edit-pen" style={{ height: 32 }} onClick={() => onReopen(row)}>
            Reopen
          </WBtn>
        )}
        {row.status === 'APPROVED' && (
          <WBtn accent leading="doc-dollar" style={{ height: 32 }} onClick={() => onRecordPayment(row)}>
            Record payment
          </WBtn>
        )}
        {row.status === 'PAID' && onReversePayment && (
          <WBtn variant="secondary" leading="refresh" style={{ height: 32 }} onClick={() => onReversePayment(row)}>
            Undo payment
          </WBtn>
        )}
        <button
          type="button"
          onClick={onClose}
          className="focus-ring inline-flex items-center justify-center"
          title="Close (Esc)"
          style={{
            width: 32,
            height: 32,
            borderRadius: 8,
            marginLeft: 4,
            cursor: 'pointer',
            background: 'transparent',
            border: 0,
            color: 'rgba(255,255,255,0.75)',
          }}
        >
          <WIcon name="close" size={16} />
        </button>
      </div>

      {/* document — clicking the backdrop closes; clicks on the card don't */}
      <div
        className="scroll-thin flex-1 overflow-auto"
        style={{ padding: '8px 24px 32px' }}
        onClick={onClose}
      >
        <div
          onClick={(e) => e.stopPropagation()}
          className="relative mx-auto overflow-hidden"
          style={{
            maxWidth: 720,
            background: 'var(--bg-surface)',
            borderRadius: 12,
            boxShadow: '0 24px 64px -16px rgba(0,0,0,0.45)',
            padding: '40px 44px 32px',
          }}
        >
          {/* doc header */}
          <div className="flex items-start justify-between gap-6">
            <div>
              {company.logoUrl ? (
                // eslint-disable-next-line @next/next/no-img-element
                <img
                  src={company.logoUrl}
                  alt={company.name}
                  style={{ width: 44, height: 44, borderRadius: 10, objectFit: 'contain', marginBottom: 14 }}
                />
              ) : (
                <div
                  className="flex items-center justify-center"
                  style={{
                    width: 44,
                    height: 44,
                    borderRadius: 10,
                    background: 'var(--accent)',
                    color: '#FFF',
                    fontSize: 21,
                    fontWeight: 700,
                    marginBottom: 14,
                  }}
                >
                  {logoLetter}
                </div>
              )}
              <div style={{ fontSize: 17, fontWeight: 700, color: 'var(--text-primary)', letterSpacing: -0.01 }}>
                {company.name || '—'}
              </div>
              <div style={{ fontSize: 12, color: 'var(--text-tertiary)', lineHeight: '18px', marginTop: 4 }}>
                {company.addressLines.map((l) => (
                  <div key={l}>{l}</div>
                ))}
                {company.email && <div style={{ marginTop: 6 }}>{company.email}</div>}
                {company.phone && <div>{company.phone}</div>}
              </div>
            </div>
            <div className="text-right">
              <div style={{ fontSize: 30, fontWeight: 700, letterSpacing: 0.12, color: 'var(--text-primary)' }}>
                SETTLEMENT
              </div>
              <div style={{ fontSize: 12, color: 'var(--text-tertiary)', marginTop: 2 }}>
                {party === 'carrier' ? 'Carrier statement' : 'Driver statement'}
              </div>
              <div className="flex justify-end" style={{ marginTop: 8 }}>
                <SettleChip chip={chipKeyForRow(row)} />
              </div>
            </div>
          </div>

          {/* meta strip */}
          <div
            className="grid grid-cols-3 gap-4"
            style={{ marginTop: 28, paddingTop: 18, borderTop: '1px solid var(--border-hairline)' }}
          >
            {(
              [
                ['Statement no.', row.statementNumber],
                ['Pay period', fmtPeriodYear(row.periodStart, row.periodEnd)],
                ['Pay date', fmtDateYear(row.payDate)],
              ] as const
            ).map(([l, v]) => (
              <div key={l}>
                <div
                  className="uppercase"
                  style={{ fontSize: 10.5, fontWeight: 600, letterSpacing: 0.5, color: 'var(--text-tertiary)' }}
                >
                  {l}
                </div>
                <div className="num" style={{ fontSize: 13, fontWeight: 600, color: 'var(--text-primary)', marginTop: 3 }}>
                  {v}
                </div>
              </div>
            ))}
          </div>

          {/* from / pay to */}
          <div className="grid grid-cols-2 gap-6" style={{ marginTop: 22 }}>
            <div>
              <FieldLabel>From</FieldLabel>
              <div style={{ fontSize: 13.5, fontWeight: 600, color: 'var(--text-primary)' }}>
                {company.name || '—'}
              </div>
              <div style={{ fontSize: 12, color: 'var(--text-tertiary)', lineHeight: '18px', marginTop: 3 }}>
                {company.addressLines.map((l) => (
                  <div key={l}>{l}</div>
                ))}
              </div>
            </div>
            <div>
              <FieldLabel>Pay to</FieldLabel>
              <div style={{ fontSize: 13.5, fontWeight: 600, color: 'var(--text-primary)' }}>{row.payeeName}</div>
              <div style={{ fontSize: 12, color: 'var(--text-tertiary)', lineHeight: '18px', marginTop: 3 }}>
                {row.payeeSub && <div>{row.payeeSub}</div>}
                {planMeta && (
                  <div>
                    {planMeta.label}
                    {row.planDetail ? ` — ${row.planDetail}` : ''}
                  </div>
                )}
                {row.cadence && <div>Paid {row.cadence.toLowerCase()}</div>}
              </div>
            </div>
          </div>

          {/* earnings table */}
          <div style={{ marginTop: 28 }}>
            <div style={{ ...COL_GRID, padding: '0 0 8px', borderBottom: '1px solid var(--border-hairline-strong)' }}>
              <ColHead>Earnings</ColHead>
              <ColHead right>Basis</ColHead>
              <ColHead right>Amount</ColHead>
            </div>

            {!sections && (
              <>
                <SkeletonRow />
                <SkeletonRow />
                <SkeletonRow />
              </>
            )}

            {sections && sections.earn.length === 0 && (
              <div
                style={{
                  padding: '12px 0',
                  fontSize: 12,
                  color: 'var(--text-tertiary)',
                  borderBottom: '1px solid var(--border-hairline)',
                }}
              >
                No earning lines on this statement.
              </div>
            )}

            {sections?.earn.map((p, i) => {
              const d = lineDisplay(p);
              return (
                <div
                  key={`e${i}`}
                  style={{ ...COL_GRID, padding: '10px 0', borderBottom: '1px solid var(--border-hairline)' }}
                >
                  <div className="min-w-0">
                    <div
                      className={d.mono ? 'num tw-mono' : undefined}
                      style={{ fontSize: 12.5, fontWeight: 500, color: 'var(--text-primary)' }}
                    >
                      {d.label}
                    </div>
                    {d.sub && (
                      <div className="truncate" style={{ fontSize: 11.5, color: 'var(--text-tertiary)', marginTop: 2 }}>
                        {d.sub}
                      </div>
                    )}
                  </div>
                  <span className="num text-right" style={{ fontSize: 12, color: 'var(--text-secondary)' }}>
                    {basisLabel(p, row.planBasis)}
                  </span>
                  <span className="num text-right" style={{ fontSize: 12.5, fontWeight: 500, color: 'var(--text-primary)' }}>
                    {fmtUSD(p.totalAmount)}
                  </span>
                </div>
              );
            })}

            {hasAdjustments && (
              <div
                style={{ ...COL_GRID, padding: '14px 0 8px', borderBottom: '1px solid var(--border-hairline-strong)' }}
              >
                <ColHead>Adjustments</ColHead>
                <span />
                <span />
              </div>
            )}
            {sections?.reimb.map((p, i) => (
              <div
                key={`r${i}`}
                style={{ ...COL_GRID, padding: '10px 0', borderBottom: '1px solid var(--border-hairline)' }}
              >
                <div style={{ fontSize: 12.5, fontWeight: 500, color: 'var(--text-primary)' }}>{p.description}</div>
                <span className="text-right" style={{ fontSize: 12, color: 'var(--text-secondary)' }}>
                  Reimbursement
                </span>
                <span className="num text-right" style={{ fontSize: 12.5, fontWeight: 500, color: 'var(--text-primary)' }}>
                  {fmtUSD(p.totalAmount)}
                </span>
              </div>
            ))}
            {sections?.deduct.map((p, i) => (
              <div
                key={`d${i}`}
                style={{ ...COL_GRID, padding: '10px 0', borderBottom: '1px solid var(--border-hairline)' }}
              >
                <div style={{ fontSize: 12.5, fontWeight: 500, color: 'var(--text-primary)' }}>{p.description}</div>
                <span className="text-right" style={{ fontSize: 12, color: 'var(--text-secondary)' }}>
                  Deduction
                </span>
                <span className="num text-right" style={{ fontSize: 12.5, fontWeight: 500, color: '#B43030' }}>
                  −{fmtUSD(Math.abs(p.totalAmount))}
                </span>
              </div>
            ))}
          </div>

          {/* totals */}
          <div className="flex justify-end" style={{ marginTop: 20 }}>
            <div
              className="flex flex-col"
              style={{
                width: 300,
                background: 'var(--bg-surface-2)',
                border: '1px solid var(--border-hairline)',
                borderRadius: 10,
                padding: '14px 16px',
                gap: 9,
              }}
            >
              <StDocRow label="Earnings" value={fmtUSD(totals.earnTotal)} />
              {totals.reimbTotal > 0 && <StDocRow label="Reimbursements" value={fmtUSD(totals.reimbTotal)} />}
              {totals.deductTotal > 0 && (
                <StDocRow label="Deductions" value={`−${fmtUSD(totals.deductTotal)}`} negative />
              )}
              <div style={{ height: 1, background: 'var(--border-hairline)' }} />
              <StDocRow label="Net pay" value={fmtUSD(totals.net)} strong />
              {isPaid && (
                <div className="flex items-center" style={{ gap: 7, fontSize: 12, color: '#0F8C5F', marginTop: 2 }}>
                  <WIcon name="badge-check" size={13} color="#10B981" />
                  Paid via {row.paidMethod ?? '—'} on {fmtDateYear(row.paidAt)}
                </div>
              )}
            </div>
          </div>

          {/* footer */}
          <div
            className="grid grid-cols-2 gap-6"
            style={{ marginTop: 28, paddingTop: 18, borderTop: '1px dashed var(--border-hairline-strong)' }}
          >
            <div>
              <FieldLabel>Payment method</FieldLabel>
              <div style={{ fontSize: 12, color: 'var(--text-secondary)', lineHeight: '19px' }}>
                {isPaid ? (
                  <>
                    <div>
                      Paid on {fmtDateYear(row.paidAt)} via {row.paidMethod ?? '—'}
                    </div>
                    {row.paidReference && (
                      <div>
                        Reference: <span className="num">{row.paidReference}</span>
                      </div>
                    )}
                  </>
                ) : (
                  <div>Scheduled for {fmtDateYear(row.payDate)}</div>
                )}
              </div>
            </div>
            <div>
              <FieldLabel>Notes</FieldLabel>
              <div style={{ fontSize: 12, color: 'var(--text-secondary)', lineHeight: '19px' }}>
                {row.notes ??
                  `Questions about this statement? Contact ${company.email || 'your administrator'} within 30 days of the pay date.`}
              </div>
            </div>
          </div>

          <div className="text-center" style={{ fontSize: 11, color: 'var(--text-tertiary)', marginTop: 26 }}>
            {company.name ? `${company.name} · ` : ''}Generated on {generatedOn}
          </div>
        </div>
      </div>
    </div>
  );
}
