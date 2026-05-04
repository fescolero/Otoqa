/**
 * DetailsSlideOver — record-detail panel that slides in from the right.
 *
 * One primitive, four layout modes:
 *   - tabs    — horizontal tab strip; one section visible at a time
 *   - sidebar — left nav (icons + labels) + scrollable content area
 *   - scroll  — single tall scroll with anchored section headers
 *   - 3-col   — left nav + center content + right rail always-on
 *
 * The right rail is appended below the section content in `tabs` and
 * `scroll` modes; hidden in `sidebar`; and always-visible in `3-col`.
 *
 * Built on Radix Dialog so we get focus trap + escape-to-close + overlay
 * for free. The dialog is non-modal in 3-col so the underlying list still
 * accepts row clicks.
 */

import * as React from 'react';
import * as DialogPrimitive from '@radix-ui/react-dialog';
import { cn } from '@/lib/utils';
import { WIcon, type IconName } from './icons';

export type DetailsLayout = 'tabs' | 'sidebar' | 'scroll' | '3-col';

export interface DetailsSection {
  id: string;
  label: React.ReactNode;
  icon?: IconName;
  /** Total count for this section's data (e.g. trips.length). */
  count?: number;
  /** Number of items needing attention (renders an amber dot/badge on tabs). */
  attention?: number;
  content: React.ReactNode;
}

interface DetailsSlideOverProps {
  open: boolean;
  onClose: () => void;
  layout?: DetailsLayout;
  /** Header rendered above the section nav (record title, status, actions). */
  header: React.ReactNode;
  sections: DetailsSection[];
  /** Optional persistent right rail (Now / activity / comments preview). */
  rightRail?: React.ReactNode;
  /** Optional "Open full page" handler — surfaces a button in the header. */
  onOpenFull?: () => void;
  /** Width in px when not 3-col; default 480. */
  width?: number;
  /** Force open without focus trap (for 3-col always-open mode). */
  modal?: boolean;
  className?: string;
}

export function DetailsSlideOver({
  open,
  onClose,
  layout = 'tabs',
  header,
  sections,
  rightRail,
  onOpenFull,
  width = 480,
  modal,
  className,
}: DetailsSlideOverProps) {
  const isThreeCol = layout === '3-col';
  const effectiveModal = modal ?? !isThreeCol;
  const [activeId, setActiveId] = React.useState<string>(sections[0]?.id ?? '');

  React.useEffect(() => {
    if (!sections.find((s) => s.id === activeId) && sections[0]) setActiveId(sections[0].id);
  }, [sections, activeId]);

  const active = sections.find((s) => s.id === activeId) ?? sections[0];

  return (
    <DialogPrimitive.Root open={open} onOpenChange={(o) => !o && onClose()} modal={effectiveModal}>
      <DialogPrimitive.Portal>
        {effectiveModal && (
          <DialogPrimitive.Overlay
            className="fixed inset-0 z-40 bg-[var(--bg-overlay)] data-[state=open]:animate-in data-[state=open]:fade-in data-[state=closed]:animate-out data-[state=closed]:fade-out"
          />
        )}
        <DialogPrimitive.Content
          aria-describedby={undefined}
          onPointerDownOutside={(e) => isThreeCol && e.preventDefault()}
          onInteractOutside={(e) => isThreeCol && e.preventDefault()}
          className={cn(
            'fixed top-0 right-0 bottom-0 z-50 flex flex-col bg-card border-l border-[var(--border-hairline)] shadow-[var(--shadow-popover)]',
            'data-[state=open]:slide-in-right data-[state=closed]:animate-out data-[state=closed]:fade-out',
            className,
          )}
          style={{ width: isThreeCol ? Math.max(width + 320, 720) : width }}
        >
          <DialogPrimitive.Title className="sr-only">Record details</DialogPrimitive.Title>
          {/* Header */}
          <div className="shrink-0 px-5 py-4 flex items-start justify-between gap-3 border-b border-[var(--border-hairline)]">
            <div className="min-w-0 flex-1">{header}</div>
            <div className="flex items-center gap-1 shrink-0">
              {onOpenFull && (
                <button
                  type="button"
                  onClick={onOpenFull}
                  title="Open full page"
                  className="focus-ring h-8 w-8 inline-flex items-center justify-center rounded-md text-[var(--text-tertiary)] hover:bg-[var(--bg-row-hover)] hover:text-foreground"
                >
                  <WIcon name="arrow-up-right" size={14} />
                </button>
              )}
              <button
                type="button"
                onClick={onClose}
                title="Close"
                className="focus-ring h-8 w-8 inline-flex items-center justify-center rounded-md text-[var(--text-tertiary)] hover:bg-[var(--bg-row-hover)] hover:text-foreground"
              >
                <WIcon name="close" size={14} />
              </button>
            </div>
          </div>

          {/* Body */}
          {layout === 'tabs' && (
            <BodyTabs sections={sections} activeId={activeId} onChange={setActiveId} active={active} rightRail={rightRail} />
          )}
          {layout === 'sidebar' && (
            <BodySidebar sections={sections} activeId={activeId} onChange={setActiveId} active={active} />
          )}
          {layout === 'scroll' && <BodyScroll sections={sections} rightRail={rightRail} />}
          {layout === '3-col' && (
            <BodyThreeCol sections={sections} activeId={activeId} onChange={setActiveId} active={active} rightRail={rightRail} />
          )}
        </DialogPrimitive.Content>
      </DialogPrimitive.Portal>
    </DialogPrimitive.Root>
  );
}

// ─── Layout: tabs ───────────────────────────────────────────────────────

function BodyTabs({
  sections,
  activeId,
  onChange,
  active,
  rightRail,
}: {
  sections: DetailsSection[];
  activeId: string;
  onChange: (id: string) => void;
  active?: DetailsSection;
  rightRail?: React.ReactNode;
}) {
  return (
    <>
      <SectionTabs sections={sections} activeId={activeId} onChange={onChange} />
      <div className="scroll-thin flex-1 overflow-auto">
        <div className="p-5 flex flex-col gap-4">{active?.content}</div>
        {rightRail && (
          <div className="px-5 pb-5 flex flex-col gap-4 border-t border-[var(--border-hairline)] pt-4">{rightRail}</div>
        )}
      </div>
    </>
  );
}

// ─── Layout: sidebar ────────────────────────────────────────────────────

function BodySidebar({
  sections,
  activeId,
  onChange,
  active,
}: {
  sections: DetailsSection[];
  activeId: string;
  onChange: (id: string) => void;
  active?: DetailsSection;
}) {
  return (
    <div className="flex-1 flex min-h-0">
      <nav className="w-44 shrink-0 border-r border-[var(--border-hairline)] py-2 overflow-auto scroll-thin">
        {sections.map((s) => {
          const a = s.id === activeId;
          return (
            <button
              key={s.id}
              type="button"
              onClick={() => onChange(s.id)}
              className={cn(
                'focus-ring w-full px-3 h-8 inline-flex items-center gap-2 text-left text-[12.5px]',
                a
                  ? 'bg-[var(--bg-sidebar-active)] text-[var(--accent)] font-medium'
                  : 'text-[var(--text-secondary)] hover:bg-[var(--bg-row-hover)] hover:text-foreground',
              )}
            >
              {s.icon && <WIcon name={s.icon} size={13} />}
              <span className="flex-1 truncate">{s.label}</span>
              {s.attention != null && s.attention > 0 && (
                <span className="num text-[10.5px] font-semibold text-[#A66800]">{s.attention}</span>
              )}
              {s.count != null && (
                <span className="num text-[11px] text-[var(--text-tertiary)]">{s.count}</span>
              )}
            </button>
          );
        })}
      </nav>
      <div className="scroll-thin flex-1 overflow-auto p-5 flex flex-col gap-4">{active?.content}</div>
    </div>
  );
}

// ─── Layout: scroll ─────────────────────────────────────────────────────

function BodyScroll({ sections, rightRail }: { sections: DetailsSection[]; rightRail?: React.ReactNode }) {
  return (
    <div className="scroll-thin flex-1 overflow-auto p-5 flex flex-col gap-6">
      {sections.map((s) => (
        <section key={s.id} id={`section-${s.id}`} className="flex flex-col gap-3">
          <header className="flex items-center gap-2 text-[var(--text-tertiary)]">
            {s.icon && <WIcon name={s.icon} size={13} />}
            <span className="tw-label">{s.label}</span>
            {s.count != null && (
              <span className="num text-[11px] text-[var(--text-tertiary)]">{s.count}</span>
            )}
          </header>
          {s.content}
        </section>
      ))}
      {rightRail && (
        <div className="border-t border-[var(--border-hairline)] pt-4 flex flex-col gap-4">{rightRail}</div>
      )}
    </div>
  );
}

// ─── Layout: 3-col ──────────────────────────────────────────────────────

function BodyThreeCol({
  sections,
  activeId,
  onChange,
  active,
  rightRail,
}: {
  sections: DetailsSection[];
  activeId: string;
  onChange: (id: string) => void;
  active?: DetailsSection;
  rightRail?: React.ReactNode;
}) {
  return (
    <div className="flex-1 flex min-h-0">
      <nav className="w-40 shrink-0 border-r border-[var(--border-hairline)] py-2 overflow-auto scroll-thin">
        {sections.map((s) => {
          const a = s.id === activeId;
          return (
            <button
              key={s.id}
              type="button"
              onClick={() => onChange(s.id)}
              className={cn(
                'focus-ring w-full px-3 h-8 inline-flex items-center gap-2 text-left text-[12.5px]',
                a
                  ? 'bg-[var(--bg-sidebar-active)] text-[var(--accent)] font-medium'
                  : 'text-[var(--text-secondary)] hover:bg-[var(--bg-row-hover)] hover:text-foreground',
              )}
            >
              {s.icon && <WIcon name={s.icon} size={13} />}
              <span className="flex-1 truncate">{s.label}</span>
            </button>
          );
        })}
      </nav>
      <div className="scroll-thin flex-1 overflow-auto p-5 flex flex-col gap-4 min-w-0">{active?.content}</div>
      {rightRail && (
        <aside className="w-72 shrink-0 border-l border-[var(--border-hairline)] p-4 overflow-auto scroll-thin">
          {rightRail}
        </aside>
      )}
    </div>
  );
}

// ─── Section tabs (used by `tabs` layout) ───────────────────────────────

function SectionTabs({
  sections,
  activeId,
  onChange,
}: {
  sections: DetailsSection[];
  activeId: string;
  onChange: (id: string) => void;
}) {
  return (
    <div className="shrink-0 px-2 flex items-end h-10 border-b border-[var(--border-hairline)] overflow-x-auto scroll-thin">
      {sections.map((s) => {
        const a = s.id === activeId;
        return (
          <button
            key={s.id}
            type="button"
            onClick={() => onChange(s.id)}
            className={cn(
              'focus-ring relative h-10 px-3 inline-flex items-center gap-1.5 text-[12.5px] cursor-pointer',
              'transition-colors duration-[var(--dur-fast)] ease-[var(--ease-out)]',
              a ? 'text-foreground font-medium' : 'text-[var(--text-secondary)] hover:text-foreground',
            )}
          >
            {s.icon && <WIcon name={s.icon} size={12} />}
            <span>{s.label}</span>
            {s.count != null && (
              <span className="num text-[10.5px] text-[var(--text-tertiary)]">{s.count}</span>
            )}
            {s.attention != null && s.attention > 0 && (
              <span
                title="Items need attention"
                className="num inline-flex items-center justify-center min-w-[16px] h-4 px-1 rounded-full text-[10px] font-semibold"
                style={{ background: 'rgba(245,158,11,0.18)', color: '#A66800' }}
              >
                {s.attention}
              </span>
            )}
            <span
              aria-hidden
              className="absolute -bottom-px left-2 right-2 h-0.5 rounded-sm"
              style={{ background: a ? 'var(--accent)' : 'transparent' }}
            />
          </button>
        );
      })}
    </div>
  );
}
