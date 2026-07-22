/**
 * RatesTable — spreadsheet-style table of payRules inside a profile editor.
 *
 * Built on top of <DSMiniTable editable> so every cell gets click-to-edit
 * via <EditableField>, with a single onCellCommit dispatcher that maps
 * each change to a payRules.updateRule mutation.
 *
 * Columns mirror the design (settings-screen.jsx > RatesTable):
 *   Type · Name · Rate · Distance · row actions
 *
 * Distance is encoded as a compact string operator+value (`'>50'`, `'<100'`,
 * `'any'`) for the select editor; on commit we translate back to
 *   - minThreshold (number)
 *   - trigger.filter (string expression like "leg.legLoadedMiles < 100")
 */

'use client';

import * as React from 'react';
import { useMutation, useQuery } from 'convex/react';
import { api } from '@/convex/_generated/api';
import type { Doc, Id } from '@/convex/_generated/dataModel';
import { DSMiniTable, type DSMiniColumn, type DSRowAction } from '@/components/web';
import {
  RATE_TYPE_BINDINGS,
  RATE_TYPE_COLOR,
  triggerToDesignType,
  formatRateMicroCents,
  deriveDistanceLabel,
  earningComponentOptions,
  EARNING_BUCKETS,
  type DesignRateType,
} from '@/lib/payProfileDisplay';

// Design rate types the picker offers — 9 total. Two are "coming soon" until
// backend trigger sources catch up (Per Extra Order Stop, Weekly).
const RATE_TYPE_OPTIONS: Array<{ value: DesignRateType; label: string }> = [
  { value: 'Per Total Mile',       label: 'Per Total Mile' },
  { value: 'Per Loaded Mile',      label: 'Per Loaded Mile' },
  { value: 'Per Empty Mile',       label: 'Per Empty Mile' },
  { value: 'Per Extra Stop',       label: 'Per Extra Stop' },
  { value: 'Per Extra Order Stop', label: 'Per Extra Order Stop (soon)' },
  { value: 'Percentage from Load', label: 'Percentage from Load' },
  { value: 'Flat',                 label: 'Flat' },
  { value: 'Hourly',               label: 'Hourly' },
  { value: 'Hourly (per shift)',   label: 'Hourly (per shift)' },
  { value: 'Hourly (off-load)',    label: 'Hourly (off-load)' },
  { value: 'Weekly',               label: 'Weekly (soon)' },
];

// Distance operator + value, encoded as a single string so it fits a <select>.
// Mirrors settings-screen.jsx DISTANCE_OPTIONS.
const DISTANCE_OPTIONS = [
  { value: 'any',  label: 'Any distance' },
  { value: '>0',   label: 'After 0 mi' },
  { value: '>50',  label: 'After 50 mi' },
  { value: '>100', label: 'After 100 mi' },
  { value: '>250', label: 'After 250 mi' },
  { value: '>500', label: 'After 500 mi' },
  { value: '<100', label: 'Under 100 mi' },
  { value: '<250', label: 'Under 250 mi' },
];

// Row shape DSMiniTable consumes. Keeps a stable string id.
type RateRow = {
  id: string;
  rule: Doc<'payRules'>;
  designType: DesignRateType;
  // Display-only formatted strings — DSMiniTable uses `render` for display
  // and `getValue` for the editor's raw value.
  typeLabel: string;
  name: string;
  rateDisplay: string;
  rateEditorValue: string;          // raw number for the inline editor
  distanceKey: string;              // '>50' | '<100' | 'any'
  unit: string;
  supportsDistance: boolean;
};

function toRow(rule: Doc<'payRules'>): RateRow {
  const designType = triggerToDesignType(rule.trigger.source, rule.trigger.transform);
  const binding = RATE_TYPE_BINDINGS[designType];
  const dist = deriveDistanceLabel(rule.minThreshold, rule.trigger.filter);
  const distanceKey =
    dist.op === 'any' || dist.value === null
      ? 'any'
      : `${dist.op === 'gt' ? '>' : '<'}${dist.value}`;

  // Editor value for rate: plain decimal string. For PERCENT path, store as
  // a percent number (e.g. "75" for 75%); otherwise as dollars (e.g. "0.62").
  let rateEditorValue = '';
  if (rule.rateAmountMicroCents !== undefined) {
    const raw = Number(rule.rateAmountMicroCents);
    if (designType === 'Percentage from Load') {
      rateEditorValue = String(raw / 1_000_000);
    } else {
      // microcents → dollars
      rateEditorValue = (raw / 100_000).toString();
    }
  }

  return {
    id: rule._id,
    rule,
    designType,
    typeLabel: designType,
    name: rule.name,
    rateDisplay: formatRateMicroCents(rule.rateAmountMicroCents, designType),
    rateEditorValue,
    distanceKey,
    unit: binding.unit,
    supportsDistance: binding.supportsDistance,
  };
}

// Parse the rate string the user typed back into a MicroCents bigint.
// PERCENT rules: input "75" → 75 percent → 75 × 1_000_000 micro-pct-points.
// Other rules:   input "0.555" → 0.555 dollars → 55_500 microcents.
function parseRateInput(input: string, designType: DesignRateType): bigint | null {
  const cleaned = input.replace(/[^0-9.-]/g, '').trim();
  if (cleaned === '' || cleaned === '-' || cleaned === '.') return null;
  const n = Number(cleaned);
  if (!Number.isFinite(n)) return null;
  if (designType === 'Percentage from Load') {
    return BigInt(Math.round(n * 1_000_000));
  }
  return BigInt(Math.round(n * 100_000));
}

// Parse a distance key ('>50' / '<100' / 'any') into the rule patch fields.
function parseDistanceKey(
  key: string,
  rule: Doc<'payRules'>,
): { minThreshold?: number; trigger: Doc<'payRules'>['trigger'] } {
  const baseTrigger = { ...rule.trigger };
  // Strip any prior "leg.*Miles < N" filter — we own that slot.
  const cleanedFilter = baseTrigger.filter?.replace(/\s*leg\.[a-zA-Z]+\s*<\s*\d+(?:\.\d+)?/, '').trim();
  if (key === 'any') {
    return {
      minThreshold: undefined,
      trigger: { ...baseTrigger, filter: cleanedFilter || undefined },
    };
  }
  const op = key[0];
  const v = Number(key.slice(1));
  if (!Number.isFinite(v)) {
    return { minThreshold: undefined, trigger: baseTrigger };
  }
  if (op === '>') {
    return {
      minThreshold: v,
      trigger: { ...baseTrigger, filter: cleanedFilter || undefined },
    };
  }
  // "<N" → translate to a filter against the rule's distance-producing source.
  const filter = `${baseTrigger.source} < ${v}`;
  return {
    minThreshold: undefined,
    trigger: { ...baseTrigger, filter },
  };
}

export interface RatesTableProps {
  rules: Doc<'payRules'>[];
  workosOrgId: string | null;
  onAddLineItem: () => void;
}

export function RatesTable({ rules, workosOrgId, onAddLineItem }: RatesTableProps) {
  const updateRule = useMutation(api.payRules.updateRule);
  const removeRule = useMutation(api.payRules.removeRule);

  // Component catalog backs the "Counts as" column — the classification that
  // drives paycheck bucketing / tax treatment (base wage vs fringe vs bonus).
  const components = useQuery(
    api.chargeComponents.listForOrg,
    workosOrgId ? { workosOrgId } : 'skip',
  );
  const componentOptions = React.useMemo(
    () => earningComponentOptions(components, '_id'),
    [components],
  );
  const componentsById = React.useMemo(() => {
    const m = new Map<string, Doc<'chargeComponents'>>();
    for (const c of components ?? []) m.set(c._id, c);
    return m;
  }, [components]);

  const rows = React.useMemo(() => rules.map(toRow), [rules]);

  const cols: DSMiniColumn<RateRow>[] = [
    {
      key: 'type',
      label: 'Type',
      width: '210px',
      render: r => (
        <span
          style={{
            display: 'inline-flex',
            alignItems: 'center',
            padding: '0 8px',
            height: 20,
            borderRadius: 9,
            background: `${RATE_TYPE_COLOR[r.designType]}1A`,
            color: RATE_TYPE_COLOR[r.designType],
            fontSize: 11.5,
            fontWeight: 600,
            whiteSpace: 'nowrap',
          }}
        >
          {r.typeLabel}
        </span>
      ),
      editor: { type: 'select', options: RATE_TYPE_OPTIONS },
      getValue: r => r.designType,
    },
    {
      key: 'name',
      label: 'Name',
      width: 'minmax(140px, 1.4fr)',
      render: r => <span className="text-[13px] font-medium truncate">{r.name}</span>,
      editor: { type: 'text' },
      getValue: r => r.name,
    },
    {
      key: 'component',
      label: 'Counts as',
      width: '180px',
      render: r => {
        const c = componentsById.get(r.rule.componentId);
        if (!c) {
          return <span className="text-[12px] italic" style={{ color: 'var(--text-tertiary)' }}>…</span>;
        }
        return (
          <span className="inline-flex items-baseline gap-1.5 min-w-0">
            <span className="text-[12.5px] truncate" style={{ color: 'var(--text-secondary)' }}>{c.displayName}</span>
            <span className="text-[10.5px] shrink-0" style={{ color: 'var(--text-tertiary)' }}>
              {EARNING_BUCKETS[c.bucket] ?? c.bucket}
            </span>
          </span>
        );
      },
      editor: { type: 'select', options: componentOptions },
      getValue: r => r.rule.componentId,
    },
    {
      key: 'rate',
      label: 'Rate',
      width: '160px',
      align: 'right',
      tnum: true,
      render: r => (
        <span className="inline-flex items-baseline gap-1">
          <span className="num text-[13px] font-semibold">{r.rateDisplay}</span>
          <span className="text-[11.5px]" style={{ color: 'var(--text-tertiary)' }}>{r.unit}</span>
        </span>
      ),
      editor: { type: 'text', placeholder: '0.00' },
      getValue: r => r.rateEditorValue,
    },
    {
      key: 'distance',
      label: 'Distance',
      width: '170px',
      render: r => {
        if (!r.supportsDistance) {
          return <span className="text-[12px] italic" style={{ color: 'var(--text-tertiary)' }}>—</span>;
        }
        const opt = DISTANCE_OPTIONS.find(o => o.value === r.distanceKey);
        return <span className="num text-[12.5px]" style={{ color: 'var(--text-secondary)' }}>{opt?.label ?? 'Any distance'}</span>;
      },
      editor: { type: 'select', options: DISTANCE_OPTIONS },
      getValue: r => r.distanceKey,
    },
  ];

  const handleCellCommit = async (
    row: RateRow,
    key: string,
    next: string | string[],
  ) => {
    const value = Array.isArray(next) ? next.join(',') : next;
    const ruleId = row.id as Id<'payRules'>;

    switch (key) {
      case 'name':
        if (value !== row.name) await updateRule({ ruleId, patch: { name: value } });
        return;

      case 'component': {
        if (!value || value === row.rule.componentId) return;
        await updateRule({ ruleId, patch: { componentId: value as Id<'chargeComponents'> } });
        return;
      }

      case 'rate': {
        const microCents = parseRateInput(value, row.designType);
        if (microCents === null) return;
        if (microCents === BigInt(Number(row.rule.rateAmountMicroCents ?? 0))) return;
        await updateRule({ ruleId, patch: { rateAmountMicroCents: microCents } });
        return;
      }

      case 'distance': {
        const { minThreshold, trigger } = parseDistanceKey(value, row.rule);
        await updateRule({ ruleId, patch: { minThreshold, trigger } });
        return;
      }

      case 'type': {
        const newType = value as DesignRateType;
        if (newType === row.designType) return;
        const binding = RATE_TYPE_BINDINGS[newType];
        if (binding.comingSoon) {
          window.alert(`"${newType}" is not yet supported by the calc engine. Coming soon.`);
          return;
        }
        // Reset distance constraints — they're type-specific.
        await updateRule({
          ruleId,
          patch: {
            trigger: {
              source: binding.source,
              transform: binding.transform,
              filter: undefined,
            },
            minThreshold: undefined,
          },
        });
        return;
      }
    }
  };

  const rowActions = (row: RateRow): DSRowAction[] => [
    {
      icon: 'trash',
      label: 'Remove',
      danger: true,
      onClick: async () => {
        await removeRule({ ruleId: row.id as Id<'payRules'> });
      },
    },
  ];

  return (
    <DSMiniTable
      columns={cols}
      rows={rows}
      total={rows.length}
      editable
      onCellCommit={handleCellCommit}
      rowActions={rowActions}
      uploadRow={
        <button
          onClick={onAddLineItem}
          className="focus-ring w-full h-9 flex items-center justify-center gap-1.5 text-[12.5px] font-medium border-0 cursor-pointer"
          style={{
            background: 'var(--bg-surface-2)',
            color: 'var(--accent)',
            borderBottom: '1px solid var(--border-hairline)',
          }}
        >
          <span style={{ fontSize: 14 }}>+</span>
          Add line item
        </button>
      }
    />
  );
}
