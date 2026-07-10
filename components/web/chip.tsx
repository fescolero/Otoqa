/**
 * Chip — soft-tint status badge with a leading dot.
 *
 * Status presets cover the common entity states (active/inactive/pending/
 * warning/danger/open/assigned/delivered/cancelled/draft/valid/expiring/
 * expired/na). Pass `label` to override the preset's default label, or
 * `dotOnly` to render just the dot + tone with no text shift.
 */

import * as React from 'react';
import { cn } from '@/lib/utils';

export type ChipStatus =
  | 'active'
  | 'inactive'
  | 'pending'
  | 'warning'
  | 'danger'
  | 'open'
  | 'assigned'
  | 'delivered'
  | 'cancelled'
  | 'draft'
  | 'valid'
  | 'expiring'
  | 'expired'
  | 'na';

interface Preset {
  bg: string;
  fg: string;
  dot: string;
  label: string;
}

export const STATUS_PRESETS: Record<ChipStatus, Preset> = {
  active:    { bg: 'rgba(16,185,129,0.10)',  fg: '#0F8C5F', dot: '#10B981', label: 'Active' },
  inactive:  { bg: 'rgba(107,115,133,0.10)', fg: '#5A6172', dot: '#9BA3B4', label: 'Inactive' },
  pending:   { bg: 'rgba(245,158,11,0.12)',  fg: '#A66800', dot: '#F59E0B', label: 'Pending' },
  warning:   { bg: 'rgba(245,158,11,0.12)',  fg: '#A66800', dot: '#F59E0B', label: 'Attention' },
  danger:    { bg: 'rgba(239,68,68,0.10)',   fg: '#B43030', dot: '#EF4444', label: 'Issue' },
  open:      { bg: 'rgba(245,158,11,0.12)',  fg: '#A66800', dot: '#F59E0B', label: 'Open' },
  assigned:  { bg: 'rgba(46,92,255,0.10)',   fg: '#1A47E6', dot: '#2E5CFF', label: 'Assigned' },
  delivered: { bg: 'rgba(16,185,129,0.10)',  fg: '#0F8C5F', dot: '#10B981', label: 'Delivered' },
  cancelled: { bg: 'rgba(107,115,133,0.10)', fg: '#5A6172', dot: '#9BA3B4', label: 'Cancelled' },
  draft:     { bg: 'rgba(107,115,133,0.10)', fg: '#5A6172', dot: '#9BA3B4', label: 'Draft' },
  valid:     { bg: 'rgba(16,185,129,0.10)',  fg: '#0F8C5F', dot: '#10B981', label: 'Valid' },
  expiring:  { bg: 'rgba(245,158,11,0.12)',  fg: '#A66800', dot: '#F59E0B', label: 'Expiring' },
  expired:   { bg: 'rgba(239,68,68,0.10)',   fg: '#B43030', dot: '#EF4444', label: 'Expired' },
  na:        { bg: 'rgba(107,115,133,0.06)', fg: '#9BA3B4', dot: 'transparent', label: 'N/A' },
};

interface ChipProps {
  status: ChipStatus;
  label?: React.ReactNode;
  dotOnly?: boolean;
  className?: string;
}

export function Chip({ status, label, dotOnly, className }: ChipProps) {
  const p = STATUS_PRESETS[status] ?? STATUS_PRESETS.inactive;
  return (
    <span
      className={cn(
        'inline-flex items-center gap-1.5 rounded-full whitespace-nowrap',
        'text-[11.5px] font-semibold leading-[18px] tracking-[0.01em]',
        dotOnly ? 'px-2 py-[2px]' : 'pl-2 pr-2.5 py-[2px]',
        className,
      )}
      style={{ background: p.bg, color: p.fg }}
    >
      <span
        className="h-1.5 w-1.5 rounded-full"
        style={{
          background: p.dot,
          boxShadow: p.dot !== 'transparent' ? `0 0 0 2px ${p.bg}` : 'none',
        }}
      />
      {label ?? p.label}
    </span>
  );
}
