/**
 * SettingsHeader — page-within-page header used on every settings screen.
 *
 * Distinct from the list-page <PageHeader> (which lives at the very top of
 * the app shell). SettingsHeader lives inside the settings body, sits on a
 * surface fill, and supports:
 *   - breadcrumb row (back-link + chevrons)
 *   - small uppercase eyebrow
 *   - title (string OR ReactNode for inline chips)
 *   - subtitle paragraph
 *   - right-aligned action buttons
 *
 * Visual reference: Otoqa Web design — settings-screen.jsx > SettingsHeader.
 */

import * as React from 'react';
import { cn } from '@/lib/utils';

interface SettingsHeaderProps {
  breadcrumb?: React.ReactNode;
  eyebrow?: React.ReactNode;
  title: React.ReactNode;
  subtitle?: React.ReactNode;
  actions?: React.ReactNode;
  className?: string;
}

export function SettingsHeader({
  breadcrumb,
  eyebrow,
  title,
  subtitle,
  actions,
  className,
}: SettingsHeaderProps) {
  return (
    <div
      className={cn(
        'shrink-0 bg-card border-b border-[var(--border-hairline)] px-7 pt-5 pb-4',
        className,
      )}
    >
      {breadcrumb && (
        <div className="flex items-center gap-1.5 text-[12px] text-[var(--text-tertiary)] mb-1.5">
          {breadcrumb}
        </div>
      )}
      <div className="flex items-start justify-between gap-4">
        <div className="min-w-0">
          {eyebrow && (
            <div className="tw-label text-[10.5px] mb-1">
              {eyebrow}
            </div>
          )}
          <h1 className="m-0 text-[20px] font-semibold tracking-[-0.01em] leading-[1.15] text-foreground">
            {title}
          </h1>
          {subtitle && (
            <div className="text-[13px] text-[var(--text-tertiary)] mt-1.5 max-w-[720px] leading-[18px]">
              {subtitle}
            </div>
          )}
        </div>
        {actions && <div className="flex items-center gap-2 shrink-0">{actions}</div>}
      </div>
    </div>
  );
}
