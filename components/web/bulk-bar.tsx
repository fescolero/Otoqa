/**
 * BulkBar — bottom-pinned dark pill that animates up on multi-select.
 *
 * Render as a sibling to the table; positions itself absolutely relative to
 * the nearest positioned parent. Action buttons are typed via `<BulkAction>`
 * to inherit the dark-shell styling.
 */

import * as React from 'react';
import { cn } from '@/lib/utils';
import { WIcon, type IconName } from './icons';

interface BulkBarProps {
  count: number;
  onClear: () => void;
  actions?: React.ReactNode;
  className?: string;
}

export function BulkBar({ count, onClear, actions, className }: BulkBarProps) {
  if (count <= 0) return null;
  return (
    <div
      role="region"
      aria-label={`${count} selected`}
      className={cn(
        'absolute bottom-4 left-1/2 -translate-x-1/2 z-10',
        'slide-up',
        className,
      )}
    >
      <div
        className="h-11 rounded-xl flex items-center text-[13px] text-white pl-4 pr-1"
        style={{
          background: '#1F232D',
          boxShadow: '0 12px 32px -8px rgba(15,22,36,0.40), 0 2px 6px -2px rgba(15,22,36,0.20)',
        }}
      >
        <span className="num font-semibold">{count}</span>
        <span className="ml-1.5 opacity-70">selected</span>
        <span className="mx-3 h-[18px] w-px" style={{ background: 'rgba(255,255,255,0.12)' }} />
        {actions}
        <span className="mx-1.5 h-[18px] w-px" style={{ background: 'rgba(255,255,255,0.12)' }} />
        <button
          type="button"
          onClick={onClear}
          className={cn(
            'focus-ring h-9 px-3 rounded-lg text-white opacity-70 text-[12.5px] cursor-pointer',
            'transition-colors duration-[var(--dur-fast)] ease-[var(--ease-out)] hover:opacity-100',
          )}
          style={{ background: 'transparent' }}
          onMouseEnter={(e) => (e.currentTarget.style.background = 'rgba(255,255,255,0.08)')}
          onMouseLeave={(e) => (e.currentTarget.style.background = 'transparent')}
        >
          Clear
        </button>
      </div>
    </div>
  );
}

interface BulkActionProps {
  icon?: IconName;
  label: React.ReactNode;
  onClick?: () => void;
  danger?: boolean;
}

export function BulkAction({ icon, label, onClick, danger }: BulkActionProps) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={cn(
        'focus-ring h-9 px-3 rounded-lg inline-flex items-center gap-1.5',
        'text-[12.5px] font-medium cursor-pointer bg-transparent',
        'transition-colors duration-[var(--dur-fast)] ease-[var(--ease-out)]',
        danger ? 'text-[#FCA5A5]' : 'text-white',
      )}
      onMouseEnter={(e) => (e.currentTarget.style.background = 'rgba(255,255,255,0.08)')}
      onMouseLeave={(e) => (e.currentTarget.style.background = 'transparent')}
    >
      {icon && <WIcon name={icon} size={14} />}
      {label}
    </button>
  );
}
