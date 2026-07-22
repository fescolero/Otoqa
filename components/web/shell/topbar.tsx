/**
 * Topbar — global header above all page content.
 *
 * Left:  breadcrumb derived from the route via NAV.
 * Right: density toggle (compact ↔ comfortable), theme toggle (light ↔
 *        dark), command-palette trigger (⌘K), and a help link.
 *
 * Slim (48px) and on the canvas color so it blends; no border-bottom in
 * light mode (the page content's own header carries the divider).
 */

'use client';

import * as React from 'react';
import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { cn } from '@/lib/utils';
import { WIcon } from '@/components/web';
import { deriveBreadcrumb } from './nav';
import { useUserPreferences } from './use-user-preferences';

interface TopbarProps {
  onCmdk?: () => void;
  helpHref?: string;
  className?: string;
}

export function Topbar({ onCmdk, helpHref, className }: TopbarProps) {
  const pathname = usePathname() ?? '/dashboard';
  const trail = React.useMemo(() => deriveBreadcrumb(pathname), [pathname]);
  const { theme, density, setTheme, setDensity } = useUserPreferences();

  return (
    <header
      className={cn(
        'h-12 px-4 flex items-center gap-2 shrink-0',
        'bg-background border-b border-[var(--border-hairline)]',
        className,
      )}
    >
      <Breadcrumb trail={trail} />
      <div className="flex-1" />
      <Toggle
        title={density === 'compact' ? 'Switch to comfortable density' : 'Switch to compact density'}
        onClick={() => setDensity(density === 'compact' ? 'comfortable' : 'compact')}
      >
        <WIcon name={density === 'compact' ? 'density' : 'density-comfortable'} size={14} />
      </Toggle>
      <Toggle
        title={theme === 'dark' ? 'Switch to light theme' : 'Switch to dark theme'}
        onClick={() => setTheme(theme === 'dark' ? 'light' : 'dark')}
      >
        <WIcon name={theme === 'dark' ? 'sun' : 'moon'} size={14} />
      </Toggle>
      {onCmdk && (
        <button
          type="button"
          onClick={onCmdk}
          className="focus-ring h-8 px-2.5 inline-flex items-center gap-1.5 rounded-md text-[var(--text-tertiary)] text-[12px] hover:bg-[var(--bg-row-hover)] hover:text-foreground"
        >
          <WIcon name="search" size={13} />
          <span className="hidden sm:inline">Search</span>
          <span className="text-[10.5px] font-medium">⌘K</span>
        </button>
      )}
      {helpHref && (
        <Link
          href={helpHref}
          title="Help"
          className="focus-ring h-8 w-8 inline-flex items-center justify-center rounded-md text-[var(--text-tertiary)] hover:bg-[var(--bg-row-hover)] hover:text-foreground"
        >
          <WIcon name="help" size={14} />
        </Link>
      )}
    </header>
  );
}

function Breadcrumb({ trail }: { trail: string[] }) {
  return (
    <nav aria-label="Breadcrumb" className="flex items-center text-[12.5px] min-w-0">
      {trail.map((seg, i) => {
        const last = i === trail.length - 1;
        return (
          <React.Fragment key={i}>
            <span
              className={cn(
                'truncate',
                last ? 'text-foreground font-medium' : 'text-[var(--text-secondary)]',
              )}
            >
              {seg}
            </span>
            {!last && (
              <WIcon name="breadcrumb-sep" size={11} className="mx-1.5 text-[var(--text-tertiary)] shrink-0" />
            )}
          </React.Fragment>
        );
      })}
    </nav>
  );
}

function Toggle({
  children,
  onClick,
  title,
}: {
  children: React.ReactNode;
  onClick: () => void;
  title: string;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      title={title}
      className="focus-ring h-8 w-8 inline-flex items-center justify-center rounded-md text-[var(--text-tertiary)] hover:bg-[var(--bg-row-hover)] hover:text-foreground"
    >
      {children}
    </button>
  );
}
