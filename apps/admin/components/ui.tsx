/**
 * Console UI primitives.
 *
 * These are the design system's components (otoqa-console-design) expressed as
 * class names against app/globals.css rather than inline styles, so the whole
 * console re-skins from one stylesheet and a panel costs no runtime work.
 *
 * They are deliberately thin. Anything that needs state (ReasonAction,
 * PanelBoundary) lives in its own client component; everything here is
 * presentational and safe to render on the server.
 */

import type { ReactNode } from 'react';

export type Tone = 'neutral' | 'ok' | 'warn' | 'danger' | 'info';

/* ------------------------------------------------------------------ Panel */

/**
 * The console's section container: an 8px shell holding a white content plate.
 * `tone` tints the border and the header band — never a coloured left edge.
 *
 * Use `flush` for tables and feed rows, which carry their own cell padding.
 * `maxHeight` bounds the plate and scrolls inside it, which is the last resort
 * for a long list: prefer truncation or a page of its own.
 */
export function Panel({
  title,
  subtitle,
  count,
  tone = 'neutral',
  actions,
  flush = false,
  maxHeight,
  footer,
  className = '',
  children,
}: {
  title?: ReactNode;
  subtitle?: ReactNode;
  count?: number | null;
  tone?: Tone;
  actions?: ReactNode;
  flush?: boolean;
  maxHeight?: number;
  footer?: ReactNode;
  className?: string;
  children: ReactNode;
}) {
  const toneClass =
    tone === 'danger'
      ? ' panel-danger'
      : tone === 'warn'
        ? ' panel-attention'
        : tone === 'ok'
          ? ' panel-ok'
          : '';
  return (
    <section className={`panel${toneClass}${className ? ` ${className}` : ''}`}>
      {title !== undefined ? (
        <header className="panel-head">
          <h2>
            {title}
            {count != null ? <span className="panel-count"> ({count})</span> : null}
          </h2>
          {subtitle ? <span className="panel-subtitle">{subtitle}</span> : null}
          {actions ? <span className="panel-actions">{actions}</span> : null}
        </header>
      ) : null}
      <div className={`panel-body${flush ? ' panel-body-flush' : ''}`}>
        {maxHeight ? (
          <div className="panel-scroll" style={{ maxHeight }}>
            {children}
          </div>
        ) : (
          children
        )}
        {footer ? <div className="panel-foot">{footer}</div> : null}
      </div>
    </section>
  );
}

/* ------------------------------------------------------------- PageHeader */

export function PageHeader({
  title,
  subtitle,
  badge,
  actions,
  back,
}: {
  title: ReactNode;
  subtitle?: ReactNode;
  badge?: ReactNode;
  actions?: ReactNode;
  back?: ReactNode;
}) {
  return (
    <header className="page-head">
      <div className="page-head-main">
        {back ? <div className="back-link">{back}</div> : null}
        <h1>
          {title}
          {badge}
        </h1>
        {subtitle ? <p className="subtitle">{subtitle}</p> : null}
      </div>
      {actions ? <div className="page-head-actions">{actions}</div> : null}
    </header>
  );
}

/* -------------------------------------------------------------------- Kpi */

/**
 * One headline figure. `meter` (0–1) draws the segmented bar under it — use it
 * only where a ratio is meaningful; a bare count gets no meter.
 */
export function Kpi({
  label,
  value,
  hint,
  tone = 'neutral',
  meter,
}: {
  label: ReactNode;
  value: string;
  hint?: ReactNode;
  tone?: Tone;
  meter?: number;
}) {
  const segs = 44;
  const filled = meter == null ? 0 : Math.round(Math.max(0, Math.min(1, meter)) * segs);
  return (
    <div className={tone === 'danger' ? 'kpi kpi-danger' : 'kpi'}>
      <div className="kpi-label">{label}</div>
      <div className="kpi-value">{value}</div>
      {meter != null ? (
        <div aria-hidden="true" className={`kpi-meter kpi-meter-${tone}`}>
          {Array.from({ length: segs }, (_, i) => (
            <span key={i} className={i < filled ? 'on' : undefined} />
          ))}
        </div>
      ) : null}
      {hint ? <div className="kpi-hint">{hint}</div> : null}
    </div>
  );
}

/* ------------------------------------------------------------------ Badge */

const STATE_TONES: Record<string, Tone> = {
  ok: 'ok',
  healthy: 'ok',
  resolved: 'ok',
  closed: 'ok',
  paid: 'ok',
  active: 'ok',
  done: 'ok',
  empty: 'ok',
  warn: 'warn',
  unknown: 'warn',
  open: 'warn',
  pending: 'warn',
  in_progress: 'warn',
  partial: 'warn',
  partially_paid: 'warn',
  draft: 'warn',
  acknowledged: 'warn',
  snoozed: 'warn',
  failing: 'danger',
  stale: 'danger',
  hung: 'danger',
  critical: 'danger',
  error: 'danger',
  high: 'danger',
  urgent: 'danger',
  all_failed: 'danger',
  overdue: 'danger',
  dead: 'danger',
  deleted: 'danger',
};

/** The console's job/severity/status vocabulary mapped onto a tone. */
export function toneFor(value: string | null | undefined): Tone {
  return STATE_TONES[String(value ?? '').toLowerCase()] ?? 'neutral';
}

/**
 * A status chip. Machine words keep their underscores and lowercase — a
 * `written_off` invoice says `written_off`, because that is what the ledger
 * and the audit trail say.
 */
export function Badge({
  tone = 'neutral',
  outline = false,
  mono = false,
  children,
}: {
  tone?: Tone;
  outline?: boolean;
  mono?: boolean;
  children: ReactNode;
}) {
  const classes = ['chip'];
  if (outline) classes.push('chip-outline');
  else if (tone !== 'neutral') classes.push(`chip-${tone}`);
  if (mono) classes.push('chip-mono');
  return <span className={classes.join(' ')}>{children}</span>;
}

/* ------------------------------------------------------------- EmptyState */

/** Empty copy says WHY it is empty. "No data" tells an operator nothing. */
export function EmptyState({ children, hint }: { children: ReactNode; hint?: ReactNode }) {
  return (
    <div className="empty">
      {children}
      {hint ? <p className="empty-hint">{hint}</p> : null}
    </div>
  );
}

/* ------------------------------------------------------------- DetailGrid */

export function DetailGrid({
  items,
}: {
  items: { label: string; value: ReactNode; mono?: boolean }[];
}) {
  return (
    <dl className="detail-grid">
      {items.map((it) => (
        <div key={it.label} style={{ display: 'contents' }}>
          <dt>{it.label}</dt>
          <dd className={it.mono ? 'mono' : undefined}>{it.value ?? '—'}</dd>
        </div>
      ))}
    </dl>
  );
}

/* ------------------------------------------------------------ FilterChips */

/**
 * State filter chips with counts, for a table that owns its page. The counts
 * are the point: "issued 4" tells you whether a filter is worth clicking
 * before you click it.
 */
export function FilterChips<T extends string>({
  options,
  value,
  onChange,
  counts,
}: {
  options: readonly T[];
  value: T;
  onChange: (next: T) => void;
  counts?: Partial<Record<T, number>>;
}) {
  return (
    <div className="chip-row">
      {options.map((option) => (
        <button
          key={option}
          type="button"
          className={`chip chip-button${value === option ? ' chip-active' : ''}`}
          onClick={() => onChange(option)}
        >
          {option.replace(/_/g, ' ')}
          {counts?.[option] != null ? ` ${counts[option]}` : ''}
        </button>
      ))}
    </div>
  );
}
