'use client';

import { Sheet, SheetContent, SheetHeader, SheetTitle } from '@/components/ui/sheet';
import { WBtn } from '@/components/web';
import type { DrillContent } from './types';

interface ReportDrillSheetProps {
  drill: DrillContent | null;
  onClose: () => void;
}

/**
 * Lightweight contextual drill panel for the Reports shell. Deliberately thin
 * (title + metrics + body + one footer action) — not the heavy record-detail
 * `DetailsSlideOver`. Rows across the views open this to inspect underlying data.
 */
export function ReportDrillSheet({ drill, onClose }: ReportDrillSheetProps) {
  return (
    <Sheet open={!!drill} onOpenChange={(o) => !o && onClose()}>
      <SheetContent side="right" className="flex w-full flex-col gap-0 p-0 sm:max-w-[440px]">
        {drill && (
          <>
            <SheetHeader className="space-y-0.5 border-b border-[var(--border-hairline)] px-4 py-3 text-left">
              <SheetTitle className="text-[15px] font-semibold">{drill.title}</SheetTitle>
              {drill.subtitle && <p className="m-0 text-[12px] text-[var(--text-tertiary)]">{drill.subtitle}</p>}
            </SheetHeader>

            {drill.metrics && drill.metrics.length > 0 && (
              <div
                className="grid gap-px border-b border-[var(--border-hairline)] bg-[var(--border-hairline)]"
                style={{ gridTemplateColumns: `repeat(${drill.metrics.length}, minmax(0, 1fr))` }}
              >
                {drill.metrics.map((m, i) => (
                  <div key={i} className="bg-[var(--bg-surface)] px-3 py-2.5">
                    <div className="tw-label text-[10px] uppercase tracking-wide text-[var(--text-tertiary)]">{m.label}</div>
                    <div className="num mt-0.5 text-[14px] font-semibold" style={m.tone ? { color: m.tone } : undefined}>
                      {m.value}
                    </div>
                  </div>
                ))}
              </div>
            )}

            <div className="min-h-0 flex-1 overflow-auto">{drill.body}</div>

            {drill.footAction && (
              <div className="flex items-center gap-2 border-t border-[var(--border-hairline)] px-4 py-3">
                {drill.footLabel && <span className="flex-1 text-[12px] text-[var(--text-tertiary)]">{drill.footLabel}</span>}
                <WBtn variant="primary" size="sm" leading={drill.footAction.icon} onClick={drill.footAction.onClick}>
                  {drill.footAction.label}
                </WBtn>
              </div>
            )}
          </>
        )}
      </SheetContent>
    </Sheet>
  );
}
