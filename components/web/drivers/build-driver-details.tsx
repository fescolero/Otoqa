/**
 * buildDriverDetails — turn a Driver record into DetailsSlideOver props.
 *
 * Sections: Overview · Documents · Activity · Comments. Each section is a
 * pure render that takes the driver row; the surrounding page wires the
 * mutations.
 *
 * Document expiration status uses the same date helpers as the existing
 * detail page (parseDateString / diffCalendarDays / getDateStatus) so the
 * "Needs Attention" badge in saved-views matches what a section row shows.
 */

'use client';

import * as React from 'react';
import {
  Avatar,
  Chip,
  DSActivity,
  DSCard,
  DSMiniTable,
  DSProps,
  DSStat,
  type ChipStatus,
  type DSMiniColumn,
  type DSPropItem,
  type DetailsSection,
} from '@/components/web';
import { CommentsThread } from '@/components/web/comments-thread';

export interface DriverRow {
  _id: string;
  firstName: string;
  middleName?: string;
  lastName: string;
  email: string;
  phone: string;
  licenseState?: string;
  licenseClass?: string;
  licenseNumber?: string;
  licenseExpiration?: string;
  medicalExpiration?: string;
  badgeExpiration?: string;
  twicExpiration?: string;
  hireDate?: string;
  employmentStatus?: string;
  employmentType?: string;
  city?: string;
  state?: string;
  emergencyContactName?: string;
  emergencyContactPhone?: string;
  emergencyContactRelationship?: string;
  isDeleted?: boolean;
}

// ─── Date status helpers ────────────────────────────────────────────────

export type DocStatus = 'expired' | 'expiring' | 'warning' | 'valid' | 'na';

function parseDateString(dateStr?: string | null): { y: number; m: number; d: number } | null {
  if (!dateStr) return null;
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(dateStr);
  if (!m) return null;
  return { y: Number(m[1]), m: Number(m[2]), d: Number(m[3]) };
}

function todayDateStr(): string {
  const d = new Date();
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const dd = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${dd}`;
}

function diffCalendarDays(dateStr: string, todayStr: string): number {
  const a = parseDateString(dateStr);
  const b = parseDateString(todayStr);
  if (!a || !b) return Infinity;
  const da = Date.UTC(a.y, a.m - 1, a.d);
  const db = Date.UTC(b.y, b.m - 1, b.d);
  return Math.round((da - db) / 86400000);
}

export function getDocStatus(dateStr: string | undefined, today = todayDateStr()): DocStatus {
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

function fmtDate(dateStr?: string): string {
  const p = parseDateString(dateStr);
  if (!p) return '—';
  const d = new Date(Date.UTC(p.y, p.m - 1, p.d));
  return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric', timeZone: 'UTC' });
}

function fmtPhone(p?: string): string {
  if (!p) return '—';
  const digits = p.replace(/\D/g, '');
  if (digits.length === 10) return `(${digits.slice(0, 3)}) ${digits.slice(3, 6)}-${digits.slice(6)}`;
  return p;
}

export function countAttention(driver: DriverRow): number {
  let n = 0;
  for (const f of [driver.licenseExpiration, driver.medicalExpiration, driver.badgeExpiration, driver.twicExpiration]) {
    const s = getDocStatus(f);
    if (s === 'expired' || s === 'expiring') n++;
  }
  return n;
}

// ─── Section renderers ──────────────────────────────────────────────────

function OverviewSection({ driver }: { driver: DriverRow }) {
  const fullName = [driver.firstName, driver.middleName, driver.lastName].filter(Boolean).join(' ');
  const identity: Array<DSPropItem | null> = [
    { label: 'Name',  value: fullName },
    { label: 'Phone', value: fmtPhone(driver.phone) },
    { label: 'Email', value: driver.email || '—' },
    driver.city || driver.state ? { label: 'Based in', value: [driver.city, driver.state].filter(Boolean).join(', ') } : null,
  ];
  const license: Array<DSPropItem | null> = [
    driver.licenseClass ? { label: 'Class', value: driver.licenseClass } : null,
    driver.licenseState ? { label: 'State', value: driver.licenseState } : null,
    driver.licenseNumber ? { label: 'Number', value: <span className="num">{driver.licenseNumber}</span> } : null,
  ];
  const employment: Array<DSPropItem | null> = [
    driver.employmentStatus ? { label: 'Status',     value: driver.employmentStatus } : null,
    driver.employmentType   ? { label: 'Type',       value: driver.employmentType   } : null,
    driver.hireDate         ? { label: 'Hired',      value: fmtDate(driver.hireDate) } : null,
  ];
  const emergency: Array<DSPropItem | null> = driver.emergencyContactName
    ? [
        { label: 'Name',         value: driver.emergencyContactName },
        driver.emergencyContactRelationship ? { label: 'Relationship', value: driver.emergencyContactRelationship } : null,
        driver.emergencyContactPhone ? { label: 'Phone', value: fmtPhone(driver.emergencyContactPhone) } : null,
      ]
    : [];

  return (
    <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
      <DSCard title="Identity"><DSProps items={identity} /></DSCard>
      <DSCard title="Employment"><DSProps items={employment} /></DSCard>
      {license.filter(Boolean).length > 0 && (
        <DSCard title="License"><DSProps items={license} /></DSCard>
      )}
      {emergency.length > 0 && (
        <DSCard title="Emergency contact"><DSProps items={emergency} /></DSCard>
      )}
    </div>
  );
}

function DocumentsSection({ driver }: { driver: DriverRow }) {
  type DocRow = { id: string; name: string; expires: string; status: DocStatus };
  const rows: DocRow[] = [
    { id: 'cdl',     name: 'CDL',           expires: driver.licenseExpiration ?? '', status: getDocStatus(driver.licenseExpiration) },
    { id: 'medical', name: 'Medical card',  expires: driver.medicalExpiration ?? '', status: getDocStatus(driver.medicalExpiration) },
    { id: 'badge',   name: 'Badge',         expires: driver.badgeExpiration   ?? '', status: getDocStatus(driver.badgeExpiration) },
    { id: 'twic',    name: 'TWIC',          expires: driver.twicExpiration    ?? '', status: getDocStatus(driver.twicExpiration) },
  ];
  const cols: DSMiniColumn<DocRow>[] = [
    { key: 'name',    label: 'Document', width: '1.4fr' },
    { key: 'expires', label: 'Expires',  width: '1fr', render: (r) => fmtDate(r.expires) },
    { key: 'status',  label: 'Status',   width: '110px', render: (r) => <Chip status={STATUS_TO_CHIP[r.status]} /> },
  ];
  return <DSMiniTable columns={cols} rows={rows} />;
}

function ActivitySection({ driver }: { driver: DriverRow }) {
  // Activity stream is wired in a follow-up — for now, derive a couple
  // events from what we already know about the record.
  const items = [
    driver.hireDate
      ? { id: 'hired', icon: 'badge-check' as const, text: 'Hired', when: fmtDate(driver.hireDate) }
      : null,
    driver.licenseExpiration
      ? {
          id: 'cdl-exp',
          icon: 'id-card' as const,
          text: `CDL expires`,
          when: fmtDate(driver.licenseExpiration),
        }
      : null,
  ].filter(Boolean) as Parameters<typeof DSActivity>[0]['items'];
  return <DSActivity items={items} emptyText="No activity yet." />;
}

function StatsBlock({ driver }: { driver: DriverRow }) {
  const docsAttention = countAttention(driver);
  return (
    <div className="grid grid-cols-3 gap-0 rounded-xl border border-[var(--border-hairline)] bg-card overflow-hidden">
      <div className="p-3"><DSStat label="Docs to action" value={docsAttention} /></div>
      <div className="p-3 border-l border-[var(--border-hairline)]"><DSStat label="Status" value={driver.employmentStatus ?? '—'} /></div>
      <div className="p-3 border-l border-[var(--border-hairline)]"><DSStat label="State" value={driver.licenseState ?? '—'} /></div>
    </div>
  );
}

// ─── Public builder ─────────────────────────────────────────────────────

interface BuildOptions {
  /** When true, include the Comments section (slide-over only — full page
   *  shows comments in the right rail instead). */
  withComments?: boolean;
}

export function buildDriverDetails(driver: DriverRow, opts: BuildOptions = {}) {
  const fullName = [driver.firstName, driver.middleName, driver.lastName].filter(Boolean).join(' ');
  const attention = countAttention(driver);
  const status = (driver.employmentStatus ?? 'Inactive').toLowerCase();
  const statusChip: ChipStatus =
    status === 'active' ? 'active'
      : status === 'on leave' ? 'pending'
      : driver.isDeleted ? 'cancelled'
      : 'inactive';

  const header = (
    <div className="flex items-center gap-3 min-w-0">
      <Avatar name={fullName} size={36} />
      <div className="min-w-0 flex-1">
        <h2 className="m-0 text-[16px] font-semibold text-foreground truncate">{fullName}</h2>
        <p className="m-0 text-[12px] text-[var(--text-tertiary)] truncate">
          {driver.licenseClass ? `Class ${driver.licenseClass}` : 'No class'} · {driver.licenseState ?? '—'}
        </p>
      </div>
      <Chip status={statusChip} />
    </div>
  );

  const sections: DetailsSection[] = [
    {
      id: 'overview',
      label: 'Overview',
      icon: 'id-card',
      content: (
        <div className="flex flex-col gap-3">
          <StatsBlock driver={driver} />
          <OverviewSection driver={driver} />
        </div>
      ),
    },
    {
      id: 'documents',
      label: 'Documents',
      icon: 'file-text',
      count: 4,
      attention: attention || undefined,
      content: <DocumentsSection driver={driver} />,
    },
    {
      id: 'activity',
      label: 'Activity',
      icon: 'pulse',
      content: <ActivitySection driver={driver} />,
    },
  ];

  if (opts.withComments) {
    sections.push({
      id: 'comments',
      label: 'Comments',
      icon: 'inbox',
      content: <CommentsThread entityType="driver" entityId={driver._id} />,
    });
  }

  return { header, sections };
}
