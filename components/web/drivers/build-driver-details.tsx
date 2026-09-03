/**
 * buildDriverDetails — turn a Driver record into DetailsSlideOver props.
 *
 * Sections: Overview · Documents · Activity · Comments. Each section is a
 * pure render that takes the driver row; the surrounding page wires the
 * mutations.
 *
 * Document status comes from the shared module (convex/_helpers/
 * documentStatus.ts) — the same rule the Documents tab, the driver page
 * attention band, and the Convex list counts use — so the "Needs Attention"
 * badge in saved-views matches what a section row shows.
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
import {
  countDriverAttention,
  dateExpiryStatus,
  localTodayDateStr,
} from '@/convex/_helpers/documentStatus';
import { useDriverDocuments } from '@/components/web/documents/use-entity-documents';
import { chipForStatus, formatYmd } from '@/components/web/documents/entity-documents-model';

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
  /** Time-independent missing-documents summary written by the backend.
   *  Undefined on rows from before the summary existed. */
  missingDocTypeKeys?: string[];
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
// Thin adapters over the shared status module (documentStatus.ts). `na`
// stays as the label for "no date" in the list's per-row CDL / Medical
// chips; attention counting goes through countDriverAttention so a
// Missing type counts once and a stale mirror on a Missing type never
// double counts.

export type DocStatus = 'expired' | 'expiring' | 'warning' | 'valid' | 'na';

export function getDocStatus(dateStr: string | undefined, today: string = localTodayDateStr()): DocStatus {
  const s = dateExpiryStatus(dateStr, today);
  return s === 'missing' ? 'na' : s;
}

function fmtDate(dateStr?: string): string {
  return formatYmd(dateStr);
}

function fmtPhone(p?: string): string {
  if (!p) return '—';
  const digits = p.replace(/\D/g, '');
  if (digits.length === 10) return `(${digits.slice(0, 3)}) ${digits.slice(3, 6)}-${digits.slice(6)}`;
  return p;
}

/** List-row attention: missing document types + expired/expiring
 *  mirrored dates, without reading documents (spec §2 "Denormalized
 *  summary"). */
export function countAttention(driver: DriverRow, today: string = localTodayDateStr()): number {
  return countDriverAttention(driver, today);
}

// ─── Section renderers ──────────────────────────────────────────────────

function OverviewSection({ driver, compact }: { driver: DriverRow; compact?: boolean }) {
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

  // Compact (slide-over) — single column so each card spans the full panel
  // width, keeping names / emails / phones from truncating in a narrow
  // viewport. Full-page (default) keeps the 2-col grid on md+.
  const gridClass = compact ? 'grid grid-cols-1 gap-3' : 'grid grid-cols-1 md:grid-cols-2 gap-3';

  return (
    <div className={gridClass}>
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
  // Live from entityDocuments — the same rows the Documents tab renders.
  const docs = useDriverDocuments(driver._id);
  type Row = (typeof docs.rows)[number];
  const cols: DSMiniColumn<Row>[] = [
    { key: 'name',    label: 'Document', width: '1.4fr', render: (r) => r.type.name },
    {
      key: 'expires', label: 'Expires',  width: '1fr',
      render: (r) =>
        r.type.expires
          ? fmtDate(r.doc?.expirationDate)
          : r.doc?.issueDate ? `Issued ${fmtDate(r.doc.issueDate)}` : '—',
    },
    {
      key: 'status',  label: 'Status',   width: '110px',
      render: (r) => {
        const c = chipForStatus(r.status);
        return <Chip status={c.status} label={c.label} />;
      },
    },
  ];
  return <DSMiniTable columns={cols} rows={docs.rows} />;
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
  /** When true, lay sections out for a narrow container (slide-over).
   *  Stacks Overview cards vertically so labels and values get the full
   *  panel width. Default false (full-page 2-col grid). */
  compact?: boolean;
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
          <OverviewSection driver={driver} compact={opts.compact} />
        </div>
      ),
    },
    {
      id: 'documents',
      label: 'Documents',
      icon: 'file-text',
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
