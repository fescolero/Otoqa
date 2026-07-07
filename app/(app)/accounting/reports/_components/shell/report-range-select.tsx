'use client';

import { useState } from 'react';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
import { WIcon } from '@/components/web';
import { cn } from '@/lib/utils';
import { RANGE_PRESETS, type CustomRange, type RangePresetId } from './types';

interface ReportRangeSelectProps {
  preset: RangePresetId;
  custom: CustomRange;
  label: string;
  sub: string;
  onPickPreset: (id: RangePresetId) => void;
  onApplyCustom: (from: string, to: string) => void;
}

/**
 * Period selector for the Reports shell — preset list + a custom range panel.
 * Mirrors the design mock's AcRangeSelect using the app's Popover primitive.
 */
export function ReportRangeSelect({ preset, custom, label, sub, onPickPreset, onApplyCustom }: ReportRangeSelectProps) {
  const [open, setOpen] = useState(false);
  const [mode, setMode] = useState<'presets' | 'custom'>(preset === 'custom' ? 'custom' : 'presets');
  const [from, setFrom] = useState(custom.from ?? '');
  const [to, setTo] = useState(custom.to ?? '');
  const isCustom = preset === 'custom';

  return (
    <Popover
      open={open}
      onOpenChange={(o) => {
        setOpen(o);
        if (o) setMode(isCustom ? 'custom' : 'presets');
      }}
    >
      <PopoverTrigger asChild>
        <button
          type="button"
          className="focus-ring inline-flex h-[30px] items-center gap-2 rounded-lg border border-[var(--border-hairline-strong)] bg-[var(--bg-surface)] pl-2.5 pr-2 text-[12.5px] font-medium text-foreground"
        >
          <WIcon name="calendar" size={13} className="text-[var(--text-tertiary)]" />
          <span>{label}</span>
          <span className="num font-normal text-[var(--text-tertiary)]">· {sub}</span>
          <WIcon name="chevron-down" size={11} className="text-[var(--text-tertiary)]" />
        </button>
      </PopoverTrigger>
      <PopoverContent align="start" className="w-[260px] p-1">
        {mode === 'presets' ? (
          <>
            {RANGE_PRESETS.map((r) => {
              const on = !isCustom && r.id === preset;
              return (
                <button
                  key={r.id}
                  type="button"
                  onClick={() => {
                    onPickPreset(r.id);
                    setOpen(false);
                  }}
                  className={cn(
                    'focus-ring flex w-full items-center gap-2.5 rounded-md px-2.5 py-2 text-left hover:bg-[var(--bg-row-hover)]',
                    on && 'bg-[var(--bg-sidebar-active)]',
                  )}
                >
                  <span className={cn('flex-1 text-[12.5px] font-medium', on ? 'text-[var(--accent)]' : 'text-foreground')}>
                    {r.label}
                  </span>
                  {on && <WIcon name="check" size={13} className="text-[var(--accent)]" />}
                </button>
              );
            })}
            <div className="my-1 h-px bg-[var(--border-hairline)]" />
            <button
              type="button"
              onClick={() => setMode('custom')}
              className={cn(
                'focus-ring flex w-full items-center gap-2.5 rounded-md px-2.5 py-2 text-left hover:bg-[var(--bg-row-hover)]',
                isCustom && 'bg-[var(--bg-sidebar-active)]',
              )}
            >
              <WIcon name="calendar" size={13} className={isCustom ? 'text-[var(--accent)]' : 'text-[var(--text-tertiary)]'} />
              <span className={cn('flex-1 text-[12.5px] font-medium', isCustom ? 'text-[var(--accent)]' : 'text-foreground')}>
                Custom range…
              </span>
              <WIcon name="chevron-right" size={12} className="text-[var(--text-tertiary)]" />
            </button>
          </>
        ) : (
          <div className="p-1.5">
            <button
              type="button"
              onClick={() => setMode('presets')}
              className="focus-ring mb-2 inline-flex items-center gap-1.5 rounded px-1.5 py-1 text-[11.5px] font-medium text-[var(--text-secondary)]"
            >
              <WIcon name="chevron-left" size={12} /> Presets
            </button>
            <label className="mb-1 block text-[11px] text-[var(--text-tertiary)]">From</label>
            <input
              type="date"
              value={from}
              onChange={(e) => setFrom(e.target.value)}
              className="h-[30px] w-full rounded-md border border-[var(--border-hairline-strong)] bg-[var(--bg-surface-2)] px-2 text-[12.5px] text-foreground"
            />
            <label className="mb-1 mt-2 block text-[11px] text-[var(--text-tertiary)]">To</label>
            <input
              type="date"
              value={to}
              onChange={(e) => setTo(e.target.value)}
              className="h-[30px] w-full rounded-md border border-[var(--border-hairline-strong)] bg-[var(--bg-surface-2)] px-2 text-[12.5px] text-foreground"
            />
            <button
              type="button"
              disabled={!from || !to}
              onClick={() => {
                if (!from || !to) return;
                onApplyCustom(from, to);
                setOpen(false);
              }}
              className="focus-ring mt-2.5 h-[30px] w-full rounded-md bg-[var(--accent)] text-[12.5px] font-medium text-white disabled:opacity-50"
            >
              Apply range
            </button>
          </div>
        )}
      </PopoverContent>
    </Popover>
  );
}
