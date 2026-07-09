/**
 * Sidebar — Otoqa Web app sidebar with three modes.
 *
 *   pinned (default) — always 248px wide, parents + sub-items visible
 *   hover            — collapsed 56px rail; mouse-in expands as a 248px
 *                      overlay (does not push content), mouse-out collapses
 *   rail             — fixed 56px icon column, sub-items live in a drill-in
 *                      panel that slides in on click
 *
 * Active state derives from `usePathname()` against the NAV constant, so a
 * single source of truth (nav.ts) drives sidebar + breadcrumb + cmdk.
 *
 * Replaces the shadcn `<Sidebar>` primitive — see PR description.
 */

'use client';

import * as React from 'react';
import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { cn } from '@/lib/utils';
import { WIcon } from '@/components/web';
import { NAV, findActive, type NavItem, type NavSection } from './nav';
import { useUserPreferences } from './use-user-preferences';

const RAIL_W = 56;
const EXPANDED_W = 248;

type ViewMode = 'rail' | 'expanded' | 'drilled';

interface SidebarProps {
  /** Header slot (org switcher). */
  header?: React.ReactNode;
  /** Footer slot (user menu). */
  footer?: React.ReactNode;
  /** Optional command-palette trigger; rendered as a top-of-list pill. */
  onCmdk?: () => void;
}

export function Sidebar({ header, footer, onCmdk }: SidebarProps) {
  const pathname = usePathname();
  const { sidebarMode, setSidebarMode } = useUserPreferences();
  const [hoverExpanded, setHoverExpanded] = React.useState(false);
  const [drillSectionId, setDrillSectionId] = React.useState<string | null>(null);

  const { section: activeSection, item: activeItem } = findActive(pathname ?? '');

  const view: ViewMode =
    sidebarMode === 'pinned'
      ? 'expanded'
      : sidebarMode === 'rail'
        ? drillSectionId
          ? 'drilled'
          : 'rail'
        : hoverExpanded
          ? 'expanded'
          : 'rail';

  const showOverlay = sidebarMode === 'hover' && view === 'expanded';
  const drillSection = drillSectionId ? NAV.find((n) => n.id === drillSectionId) : undefined;

  // In pinned mode the expanded panel takes a real slot in the layout. In
  // hover or rail mode the gutter stays at the rail width and the
  // expanded/drill panels float as overlays.
  const reservedWidth = sidebarMode === 'pinned' ? EXPANDED_W : RAIL_W;

  return (
    <div
      style={{ width: reservedWidth }}
      className="relative shrink-0 h-full"
      onMouseEnter={() => sidebarMode === 'hover' && setHoverExpanded(true)}
      onMouseLeave={() => {
        if (sidebarMode === 'hover') setHoverExpanded(false);
      }}
    >
      {/* Rail layer — always rendered so the gutter is reserved. */}
      <RailLayer
        header={header}
        footer={footer}
        onCmdk={onCmdk}
        activeSection={activeSection}
        onPickSection={(s) => {
          if (sidebarMode === 'rail' && s.items?.length) {
            setDrillSectionId(s.id);
          }
        }}
      />

      {/* Expanded panel: pinned (in-flow) or hover-overlay (absolute). */}
      {view === 'expanded' && (
        <ExpandedPanel
          header={header}
          footer={footer}
          onCmdk={onCmdk}
          activeSection={activeSection}
          activeItem={activeItem}
          overlay={showOverlay}
          sidebarMode={sidebarMode}
          onTogglePin={() =>
            setSidebarMode(sidebarMode === 'pinned' ? 'hover' : 'pinned')
          }
        />
      )}

      {/* Rail mode + drilled section panel. */}
      {view === 'drilled' && drillSection && (
        <DrillPanel
          section={drillSection}
          activeItemId={activeItem?.id}
          onBack={() => setDrillSectionId(null)}
          onClose={() => setDrillSectionId(null)}
        />
      )}
    </div>
  );
}

// ─── Rail layer (always visible, 56px wide) ─────────────────────────────

function RailLayer({
  header,
  footer,
  onCmdk,
  activeSection,
  onPickSection,
}: {
  header?: React.ReactNode;
  footer?: React.ReactNode;
  onCmdk?: () => void;
  activeSection?: NavSection;
  onPickSection: (s: NavSection) => void;
}) {
  return (
    <aside
      className="absolute inset-y-0 left-0 flex flex-col bg-[var(--bg-sidebar)] border-r border-[var(--border-hairline)]"
      style={{ width: RAIL_W }}
    >
      {header && (
        <div className="h-14 flex items-center justify-center border-b border-[var(--border-hairline)] px-2">
          {header}
        </div>
      )}
      {onCmdk && (
        <button
          type="button"
          onClick={onCmdk}
          title="Search & jump (⌘K)"
          className="focus-ring mx-2 mt-2 h-8 inline-flex items-center justify-center rounded-md text-[var(--text-tertiary)] hover:bg-[var(--bg-row-hover)] hover:text-foreground"
        >
          <WIcon name="search" size={15} />
        </button>
      )}
      <nav className="flex-1 overflow-y-auto py-2 flex flex-col items-center gap-0.5 scroll-thin">
        {NAV.map((sec) => {
          const active = activeSection?.id === sec.id;
          const inner = (
            <span
              className={cn(
                'h-9 w-9 inline-flex items-center justify-center rounded-md',
                active
                  ? 'bg-[var(--bg-sidebar-active)] text-[var(--accent)]'
                  : 'text-[var(--text-secondary)] hover:bg-[var(--bg-row-hover)] hover:text-foreground',
                'transition-colors duration-[var(--dur-fast)] ease-[var(--ease-out)]',
              )}
            >
              <WIcon name={sec.icon} size={18} />
            </span>
          );
          if (sec.items?.length) {
            return (
              <button
                key={sec.id}
                type="button"
                onClick={() => onPickSection(sec)}
                title={sec.label}
                className="focus-ring"
              >
                {inner}
              </button>
            );
          }
          return (
            <Link key={sec.id} href={sec.href ?? '#'} title={sec.label} className="focus-ring">
              {inner}
            </Link>
          );
        })}
      </nav>
      {footer && (
        <div className="h-14 flex items-center justify-center border-t border-[var(--border-hairline)] px-2">
          {footer}
        </div>
      )}
    </aside>
  );
}

// ─── Expanded panel (in-flow when pinned, overlay when hover) ───────────

function ExpandedPanel({
  header,
  footer,
  onCmdk,
  activeSection,
  activeItem,
  overlay,
  sidebarMode,
  onTogglePin,
}: {
  header?: React.ReactNode;
  footer?: React.ReactNode;
  onCmdk?: () => void;
  activeSection?: NavSection;
  activeItem?: NavItem;
  overlay: boolean;
  sidebarMode: 'hover' | 'pinned' | 'rail';
  onTogglePin: () => void;
}) {
  return (
    <aside
      style={{
        width: EXPANDED_W,
        position: overlay ? 'absolute' : 'absolute',
        inset: '0 auto 0 0',
        boxShadow: overlay ? 'var(--shadow-popover)' : undefined,
      }}
      className={cn(
        'flex flex-col bg-[var(--bg-sidebar)] border-r border-[var(--border-hairline)] z-30',
        overlay && 'slide-in-right',
      )}
    >
      {header && (
        <div className="h-14 flex items-center justify-between gap-2 border-b border-[var(--border-hairline)] px-3">
          <div className="min-w-0 flex-1">{header}</div>
          <button
            type="button"
            onClick={onTogglePin}
            title={sidebarMode === 'pinned' ? 'Collapse to hover' : 'Pin sidebar'}
            className="focus-ring h-7 w-7 inline-flex items-center justify-center rounded text-[var(--text-tertiary)] hover:bg-[var(--bg-row-hover)] hover:text-foreground"
          >
            <WIcon name={sidebarMode === 'pinned' ? 'pin' : 'pin-off'} size={13} />
          </button>
        </div>
      )}
      {onCmdk && (
        <button
          type="button"
          onClick={onCmdk}
          className="focus-ring mx-3 mt-3 h-8 px-2 inline-flex items-center gap-2 rounded-md text-[12.5px] text-[var(--text-secondary)] bg-[var(--bg-surface-2)] border border-[var(--border-hairline)] hover:bg-[var(--bg-row-hover)] hover:text-foreground"
        >
          <WIcon name="search" size={13} className="text-[var(--text-tertiary)]" />
          <span className="flex-1 text-left">Search…</span>
          <span className="text-[10.5px] font-medium text-[var(--text-tertiary)]">⌘K</span>
        </button>
      )}
      <nav className="flex-1 overflow-y-auto py-2 px-2 flex flex-col gap-0.5 scroll-thin">
        {NAV.map((sec) => (
          <SectionGroup
            key={sec.id}
            section={sec}
            isActiveSection={activeSection?.id === sec.id}
            activeItemId={activeItem?.id}
          />
        ))}
      </nav>
      {footer && (
        <div className="border-t border-[var(--border-hairline)] p-2">{footer}</div>
      )}
    </aside>
  );
}

function SectionGroup({
  section,
  isActiveSection,
  activeItemId,
}: {
  section: NavSection;
  isActiveSection: boolean;
  activeItemId?: string;
}) {
  // Auto-expand the active section. Otherwise default closed (parents
  // collapsed) — Linear-style. Single source of state per group.
  const [open, setOpen] = React.useState(isActiveSection);
  React.useEffect(() => {
    if (isActiveSection) setOpen(true);
  }, [isActiveSection]);

  if (!section.items?.length) {
    return (
      <Link
        href={section.href ?? '#'}
        className={cn(
          'focus-ring flex items-center gap-2 h-8 px-2 rounded-md text-[12.5px]',
          isActiveSection
            ? 'bg-[var(--bg-sidebar-active)] text-[var(--accent)] font-medium'
            : 'text-[var(--text-secondary)] hover:bg-[var(--bg-row-hover)] hover:text-foreground',
          'transition-colors duration-[var(--dur-fast)] ease-[var(--ease-out)]',
        )}
      >
        <WIcon name={section.icon} size={15} />
        <span className="flex-1 truncate">{section.label}</span>
      </Link>
    );
  }

  return (
    <div>
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        className={cn(
          'focus-ring w-full flex items-center gap-2 h-8 px-2 rounded-md text-[12.5px]',
          isActiveSection
            ? 'text-foreground font-medium'
            : 'text-[var(--text-secondary)] hover:bg-[var(--bg-row-hover)] hover:text-foreground',
        )}
      >
        <WIcon name={section.icon} size={15} />
        <span className="flex-1 text-left truncate">{section.label}</span>
        <WIcon
          name="chevron-down"
          size={11}
          style={{ transform: open ? 'rotate(0deg)' : 'rotate(-90deg)', transition: 'transform var(--dur-fast) var(--ease-out)' }}
          className="text-[var(--text-tertiary)]"
        />
      </button>
      {open && (
        <ul className="ml-7 mt-0.5 mb-1 flex flex-col gap-0.5 list-none p-0">
          {section.items.map((item) => {
            const a = activeItemId === item.id;
            return (
              <li key={item.id}>
                <Link
                  href={item.href}
                  className={cn(
                    'focus-ring flex items-center h-7 px-2 rounded text-[12.5px]',
                    a
                      ? 'bg-[var(--bg-sidebar-active)] text-[var(--accent)] font-medium'
                      : 'text-[var(--text-secondary)] hover:bg-[var(--bg-row-hover)] hover:text-foreground',
                  )}
                >
                  {item.label}
                </Link>
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}

// ─── Drill panel (rail mode only) ───────────────────────────────────────

function DrillPanel({
  section,
  activeItemId,
  onBack,
  onClose,
}: {
  section: NavSection;
  activeItemId?: string;
  onBack: () => void;
  onClose: () => void;
}) {
  return (
    <aside
      style={{ width: EXPANDED_W, left: RAIL_W, boxShadow: 'var(--shadow-popover)' }}
      className="absolute inset-y-0 z-30 bg-[var(--bg-sidebar)] border-r border-[var(--border-hairline)] flex flex-col slide-in-right"
    >
      <div className="h-14 flex items-center gap-2 border-b border-[var(--border-hairline)] px-3">
        <button
          type="button"
          onClick={onBack}
          className="focus-ring h-7 w-7 inline-flex items-center justify-center rounded text-[var(--text-tertiary)] hover:bg-[var(--bg-row-hover)] hover:text-foreground"
          title="Back"
        >
          <WIcon name="chevron-left" size={14} />
        </button>
        <span className="text-[13px] font-medium text-foreground flex items-center gap-2">
          <WIcon name={section.icon} size={14} />
          {section.label}
        </span>
        <div className="flex-1" />
        <button
          type="button"
          onClick={onClose}
          className="focus-ring h-7 w-7 inline-flex items-center justify-center rounded text-[var(--text-tertiary)] hover:bg-[var(--bg-row-hover)] hover:text-foreground"
          title="Close"
        >
          <WIcon name="close" size={13} />
        </button>
      </div>
      <ul className="flex-1 overflow-y-auto py-2 px-2 flex flex-col gap-0.5 list-none m-0 scroll-thin">
        {section.items?.map((item) => {
          const a = activeItemId === item.id;
          return (
            <li key={item.id}>
              <Link
                href={item.href}
                onClick={onClose}
                className={cn(
                  'focus-ring flex items-center h-8 px-2 rounded text-[12.5px]',
                  a
                    ? 'bg-[var(--bg-sidebar-active)] text-[var(--accent)] font-medium'
                    : 'text-[var(--text-secondary)] hover:bg-[var(--bg-row-hover)] hover:text-foreground',
                )}
              >
                {item.label}
              </Link>
            </li>
          );
        })}
      </ul>
    </aside>
  );
}
