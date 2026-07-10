'use client';

/**
 * Driver Detail — Documents tab (full-page).
 *
 * Layout per design Otoqa Web.html § DvDocsFullPage:
 *   • 4-stat summary strip — On file · Valid · Expiring · Expired
 *   • Active documents card — FilterBar (Category + Status) + Upload
 *     action; mini-table with editable Expires cell, computed Status chip
 *   • Archived & replaced card — empty until backend lands
 *
 * Today the driver record only carries four expiration dates (license,
 * medical, badge, TWIC). The table is populated from those four fields;
 * editing the Expires cell mutates the corresponding driver field. Adding
 * arbitrary documents (Drug screening, I-9, Hazmat, Background, etc.) +
 * an archive of replaced documents + actual file uploads need a
 * `driverDocuments` table + file storage. The Upload button and the
 * Archived & replaced card are wired in the UI now and will be connected
 * to that backend once it lands.
 */

import * as React from 'react';
import { useMutation } from 'convex/react';
import { toast } from 'sonner';

import { api } from '@/convex/_generated/api';
import type { Id } from '@/convex/_generated/dataModel';

import {
  Chip,
  type ChipStatus,
  DSCard,
  DSMiniTable,
  type DSMiniColumn,
  FilterBar,
  type FilterChipValue,
  type FilterProperty,
  WBtn,
} from '@/components/web';

// ─── Date helpers (mirror build-driver-details.tsx) ──────────────────────

type DocStatus = 'expired' | 'expiring' | 'warning' | 'valid' | 'na';

function parseDateString(dateStr?: string | null): { y: number; m: number; d: number } | null {
  if (!dateStr) return null;
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(dateStr);
  if (!m) return null;
  return { y: Number(m[1]), m: Number(m[2]), d: Number(m[3]) };
}
function todayDateStr(): string {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}
function diffCalendarDays(dateStr: string, todayStr: string): number {
  const a = parseDateString(dateStr);
  const b = parseDateString(todayStr);
  if (!a || !b) return Infinity;
  const da = Date.UTC(a.y, a.m - 1, a.d);
  const db = Date.UTC(b.y, b.m - 1, b.d);
  return Math.round((da - db) / 86400000);
}
function getDocStatus(dateStr: string | undefined, today = todayDateStr()): DocStatus {
  if (!dateStr) return 'na';
  const days = diffCalendarDays(dateStr, today);
  if (days < 0) return 'expired';
  if (days <= 30) return 'expiring';
  if (days <= 60) return 'warning';
  return 'valid';
}
const STATUS_TO_CHIP: Record<DocStatus, ChipStatus> = {
  expired: 'expired',
  expiring: 'expiring',
  warning: 'warning',
  valid: 'valid',
  na: 'na',
};

// ─── Row shape ───────────────────────────────────────────────────────────

type DocCategory = 'License' | 'Medical' | 'Identity';
type DocField = 'licenseExpiration' | 'medicalExpiration' | 'badgeExpiration' | 'twicExpiration';

interface DocRow {
  id: string;
  field: DocField;
  name: string;
  cat: DocCategory;
  exp: string; // YYYY-MM-DD ('' when not on file)
  st: DocStatus;
}

interface DriverDocFields {
  _id: Id<'drivers'>;
  licenseExpiration?: string;
  medicalExpiration?: string;
  badgeExpiration?: string;
  twicExpiration?: string;
}

function buildDocRows(driver: DriverDocFields): DocRow[] {
  return [
    { id: 'cdl',     field: 'licenseExpiration', name: 'CDL',                cat: 'License',  exp: driver.licenseExpiration ?? '', st: getDocStatus(driver.licenseExpiration) },
    { id: 'medical', field: 'medicalExpiration', name: 'Medical certificate',cat: 'Medical',  exp: driver.medicalExpiration ?? '', st: getDocStatus(driver.medicalExpiration) },
    { id: 'badge',   field: 'badgeExpiration',   name: 'Badge',              cat: 'Identity', exp: driver.badgeExpiration   ?? '', st: getDocStatus(driver.badgeExpiration) },
    { id: 'twic',    field: 'twicExpiration',    name: 'TWIC card',          cat: 'Identity', exp: driver.twicExpiration    ?? '', st: getDocStatus(driver.twicExpiration) },
  ];
}

// ─── Tab component ───────────────────────────────────────────────────────

interface DriverDocumentsTabProps {
  driver: DriverDocFields;
}

export function DriverDocumentsTab({ driver }: DriverDocumentsTabProps) {
  const updateDriver = useMutation(api.drivers.update);
  const allRows = React.useMemo(() => buildDocRows(driver), [driver]);

  const [filters, setFilters] = React.useState<FilterChipValue[]>([]);
  const filtered = React.useMemo(() => {
    return allRows.filter((r) => {
      for (const f of filters) {
        if (!f.values || f.values.length === 0) continue;
        if (f.propId === 'cat' && !f.values.includes(r.cat)) return false;
        if (f.propId === 'st'  && !f.values.includes(r.st))  return false;
      }
      return true;
    });
  }, [allRows, filters]);

  const counts = {
    total:    allRows.length,
    valid:    allRows.filter((r) => r.st === 'valid' || r.st === 'warning').length,
    expiring: allRows.filter((r) => r.st === 'expiring').length,
    expired:  allRows.filter((r) => r.st === 'expired').length,
  };

  const filterProps: FilterProperty[] = [
    {
      id: 'cat', label: 'Category', icon: 'file-text', kind: 'enum', operator: 'is any of',
      options: [
        { value: 'License',  label: 'License' },
        { value: 'Medical',  label: 'Medical' },
        { value: 'Identity', label: 'Identity' },
      ],
    },
    {
      id: 'st', label: 'Status', icon: 'shield', kind: 'enum', operator: 'is any of',
      options: [
        { value: 'valid',    label: 'Valid' },
        { value: 'expiring', label: 'Expiring' },
        { value: 'expired',  label: 'Expired' },
      ],
    },
  ];

  const cols: DSMiniColumn<DocRow>[] = [
    { key: 'name', label: 'Document', width: '1.4fr' },
    { key: 'cat',  label: 'Category', width: '110px' },
    {
      key: 'exp', label: 'Expires', width: '160px',
      render: (r) => (
        <span className="num">{r.exp ? formatDate(r.exp) : '—'}</span>
      ),
      editor: { type: 'date', placeholder: 'Set expiration…' },
      getValue: (r) => r.exp,
    },
    {
      key: 'st', label: 'Status', width: '110px',
      render: (r) => <Chip status={STATUS_TO_CHIP[r.st]} />,
      readOnly: true,
    },
  ];

  // Archived & replaced reuses the active columns plus a Note column for
  // "Replaced …" / "Renewed …" entries. Rendered empty until the
  // documentation archive backend lands.
  const archivedCols: DSMiniColumn<DocRow & { note?: string }>[] = [
    { key: 'name', label: 'Document', width: '1.4fr' },
    { key: 'cat',  label: 'Category', width: '110px' },
    {
      key: 'exp', label: 'Expired', width: '160px',
      render: (r) => <span className="num">{r.exp ? formatDate(r.exp) : '—'}</span>,
      readOnly: true,
    },
    {
      key: 'st', label: 'Status', width: '110px',
      render: () => <Chip status="expired" />,
      readOnly: true,
    },
    {
      key: 'note', label: 'Note', width: '180px',
      render: (r) => <span className="text-[var(--text-tertiary)]">{r.note ?? '—'}</span>,
      readOnly: true,
    },
  ];

  const onCommit = async (row: DocRow, key: string, next: string | string[]) => {
    if (key !== 'exp') return;
    const value = Array.isArray(next) ? next[0] : next;
    try {
      await updateDriver({ id: driver._id, [row.field]: value || undefined });
      toast.success(`${row.name} expiration updated`);
    } catch (e) {
      console.error(e);
      toast.error('Failed to update expiration');
    }
  };

  return (
    <div className="flex flex-col gap-3.5">
      {/* 4-stat summary strip */}
      <div className="grid grid-cols-2 sm:grid-cols-4 rounded-xl border border-[var(--border-hairline)] bg-card overflow-hidden">
        <DocStat label="On file"  value={counts.total} />
        <DocStat label="Valid"    value={counts.valid}    tone="ok"   divided />
        <DocStat label="Expiring" value={counts.expiring} tone="warn" divided />
        <DocStat label="Expired"  value={counts.expired}  tone="crit" divided />
      </div>

      {/* Active documents */}
      <DSCard
        title={`Active documents (${filtered.length})`}
        bodyClassName="p-0"
        action={
          <div className="flex items-center gap-2">
            <FilterBar properties={filterProps} value={filters} onChange={setFilters} slot="trigger" />
            <WBtn
              size="sm"
              variant="primary"
              leading="plus"
              onClick={() => toast.message('Document upload is on the way.')}
            >
              Upload
            </WBtn>
          </div>
        }
      >
        {filters.length > 0 && (
          <div className="flex items-center gap-2 flex-wrap px-3.5 py-2 border-b border-[var(--border-hairline)] bg-[var(--bg-surface-2)]">
            <FilterBar properties={filterProps} value={filters} onChange={setFilters} slot="chips" />
            <div className="flex-1" />
            <FilterBar properties={filterProps} value={filters} onChange={setFilters} slot="trigger" />
          </div>
        )}
        <DSMiniTable
          columns={cols}
          rows={filtered}
          total={filtered.length}
          editable
          onCellCommit={onCommit}
          className="rounded-t-none border-0 border-t"
        />
      </DSCard>

      {/* Archived & replaced — backend pending. Card chrome + empty state
          render now so the section is in place when the data backend
          arrives. */}
      <DSCard
        title="Archived & replaced"
        bodyClassName="p-0"
        action={
          <WBtn
            size="sm"
            variant="ghost"
            leading="export"
            onClick={() => toast.message('Export will be available with the document archive.')}
          >
            Export
          </WBtn>
        }
      >
        <DSMiniTable
          columns={archivedCols}
          rows={[]}
          className="rounded-t-none border-0 border-t"
        />
        <div className="px-4 py-6 text-center text-[12px] text-[var(--text-tertiary)]">
          No archived documents. Replaced and superseded documents will appear here once the
          archive backend lands.
        </div>
      </DSCard>
    </div>
  );
}

// ─── Bits ────────────────────────────────────────────────────────────────

function DocStat({
  label,
  value,
  tone,
  divided,
}: {
  label: string;
  value: number;
  tone?: 'ok' | 'warn' | 'crit';
  divided?: boolean;
}) {
  const color =
    tone === 'ok' ? '#0F8C5F' :
    tone === 'warn' ? '#B45309' :
    tone === 'crit' ? '#B43030' :
    'var(--text-primary)';
  return (
    <div
      className="px-4 py-3.5"
      style={{ borderLeft: divided ? '1px solid var(--border-hairline)' : 'none' }}
    >
      <div className="text-[11px] uppercase tracking-[0.04em] text-[var(--text-tertiary)] mb-1">
        {label}
      </div>
      <div className="num text-[22px] leading-[26px] font-medium" style={{ color }}>
        {value}
      </div>
    </div>
  );
}

function formatDate(ymd: string): string {
  const p = parseDateString(ymd);
  if (!p) return ymd;
  const d = new Date(Date.UTC(p.y, p.m - 1, p.d));
  return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric', timeZone: 'UTC' });
}
