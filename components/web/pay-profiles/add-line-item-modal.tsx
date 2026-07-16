/**
 * AddLineItemModal — two-step rate-line creation flow.
 *
 *   Step 1: pick a rate type (9 options, 2 marked "coming soon").
 *   Step 2: name + counts-as component + rate amount + distance (if
 *           mileage-based).
 *
 * Each rate type has a default chargeComponent (e.g. Hourly → WAGE_HOURLY),
 * but the "Counts as" picker lets a line be classified differently — an
 * hourly H&W fringe line uses HEALTH_WELFARE so it buckets as non-taxable
 * fringe on settlements and certified payroll instead of taxable base wage.
 * On submit, calls payRules.addRule with the chosen component.
 *
 * Visual reference: settings-screen.jsx > AddLineItemModal.
 */

'use client';

import * as React from 'react';
import { useMutation, useQuery } from 'convex/react';
import { api } from '@/convex/_generated/api';
import type { Id } from '@/convex/_generated/dataModel';
import { WBtn, WIcon, Kbd } from '@/components/web';
import {
  RATE_TYPE_BINDINGS,
  RATE_TYPE_COLOR,
  RATE_TYPE_TO_COMPONENT_CODE,
  earningComponentOptions,
  type EarningComponent,
  type DesignRateType,
} from '@/lib/payProfileDisplay';

const RATE_TYPES: DesignRateType[] = [
  'Per Total Mile',
  'Per Loaded Mile',
  'Per Empty Mile',
  'Per Extra Stop',
  'Per Extra Order Stop',
  'Percentage from Load',
  'Flat',
  'Hourly',
  'Weekly',
];

const TYPE_DESCRIPTIONS: Record<DesignRateType, string> = {
  'Per Total Mile':       'Pays for every mile driven, loaded or empty.',
  'Per Loaded Mile':      'Pays only when carrying freight. Most common OTR rate.',
  'Per Empty Mile':       'Pays for deadhead / empty repositioning miles.',
  'Per Extra Stop':       'Flat fee for each stop beyond the first.',
  'Per Extra Order Stop': 'Flat fee per additional order on the same stop.',
  'Percentage from Load': 'A % cut of the linehaul revenue.',
  'Flat':                 'A fixed payment per trip, regardless of distance.',
  'Hourly':               'Paid by the hour — used for detention, layover, local routes.',
  'Weekly':               'Flat weekly stipend or guarantee.',
};

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

export interface AddLineItemModalProps {
  profileId: Id<'payProfiles'>;
  workosOrgId: string;
  onClose: () => void;
}

export function AddLineItemModal({ profileId, workosOrgId, onClose }: AddLineItemModalProps) {
  const [step, setStep] = React.useState<'type' | 'details'>('type');
  const [type, setType] = React.useState<DesignRateType | null>(null);
  const [name, setName] = React.useState('');
  const [rate, setRate] = React.useState('');
  const [dist, setDist] = React.useState('any');
  const [submitting, setSubmitting] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);

  const addRule = useMutation(api.payRules.addRule);
  // The org's component catalog backs the "Counts as" picker. Each rate type
  // has a default code; the user can override it (e.g. Hourly line classified
  // as HEALTH_WELFARE fringe instead of WAGE_HOURLY taxable wage).
  const components = useQuery(api.chargeComponents.listForOrg, { workosOrgId });
  const [componentCode, setComponentCode] = React.useState<string | null>(null);
  const targetComponentCode = componentCode ?? (type ? RATE_TYPE_TO_COMPONENT_CODE[type] : null);
  const component = React.useMemo(
    () => components?.find(c => c.code === targetComponentCode) ?? null,
    [components, targetComponentCode],
  );
  const componentsLoading = components === undefined;

  const binding = type ? RATE_TYPE_BINDINGS[type] : null;
  const comingSoon = binding?.comingSoon ?? false;

  // ⌘↵ / Esc keyboard shortcuts
  React.useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.preventDefault();
        onClose();
      } else if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
        e.preventDefault();
        if (step === 'type' && type && !comingSoon) setStep('details');
        else if (step === 'details' && rate.trim() && !comingSoon) handleSubmit();
      }
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  });

  const pickType = (t: DesignRateType) => {
    setType(t);
    setName(t);
    setComponentCode(null); // reset "Counts as" to the type's default
    setError(null);
    if (!RATE_TYPE_BINDINGS[t].comingSoon) setStep('details');
  };

  const handleSubmit = async () => {
    if (!type || !binding) return;
    if (comingSoon) {
      setError(`"${type}" is not yet supported by the calc engine.`);
      return;
    }
    if (!component) {
      setError('Could not resolve a chargeComponent for this type.');
      return;
    }
    const microCents = parseRateInput(rate, type);
    if (microCents === null) {
      setError('Enter a valid rate amount.');
      return;
    }

    setSubmitting(true);
    setError(null);
    try {
      const { minThreshold, filter } = encodeDistance(dist, binding.source);
      await addRule({
        profileId,
        name: name.trim() || type,
        componentId: component._id as Id<'chargeComponents'>,
        trigger: {
          source: binding.source,
          transform: binding.transform,
          filter,
        },
        rateAmountMicroCents: microCents,
        minThreshold,
      });
      onClose();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to add rate line.');
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <div
      onMouseDown={onClose}
      className="fixed inset-0 z-[90] flex items-center justify-center p-6"
      style={{ background: 'rgba(15,22,36,0.32)' }}
    >
      <div
        onMouseDown={e => e.stopPropagation()}
        className="flex flex-col overflow-hidden"
        style={{
          width: 620,
          maxWidth: '100%',
          maxHeight: '88vh',
          background: 'var(--bg-surface)',
          border: '1px solid var(--border-hairline-strong)',
          borderRadius: 10,
          boxShadow: 'var(--shadow-popover)',
        }}
      >
        {/* Header */}
        <div
          className="flex items-start justify-between px-4 py-3.5 border-b"
          style={{ borderColor: 'var(--border-hairline)' }}
        >
          <div>
            <div className="tw-label text-[10.5px] mb-1">
              {step === 'type' ? 'Step 1 of 2' : 'Step 2 of 2'} · Rates & accessorials
            </div>
            <div className="text-[15px] font-semibold">
              {step === 'type' ? 'Add a rate line' : `New ${type}`}
            </div>
            <div className="text-[12px] mt-1 max-w-[480px]" style={{ color: 'var(--text-tertiary)' }}>
              {step === 'type'
                ? 'Pick a rate type. The amount and scope are filled in next.'
                : type && TYPE_DESCRIPTIONS[type]}
            </div>
          </div>
          <button
            onClick={onClose}
            className="focus-ring inline-flex items-center justify-center w-7 h-7 rounded border-0 bg-transparent cursor-pointer"
            style={{ color: 'var(--text-tertiary)' }}
            aria-label="Close"
          >
            <WIcon name="close" size={13} />
          </button>
        </div>

        {/* Body */}
        <div className="flex-1 overflow-auto p-4">
          {step === 'type' && (
            <TypePicker onPick={pickType} />
          )}

          {step === 'details' && type && binding && (
            <DetailsForm
              type={type}
              binding={binding}
              comingSoon={comingSoon}
              components={components}
              componentCode={targetComponentCode}
              onChangeComponent={setComponentCode}
              name={name}
              rate={rate}
              dist={dist}
              onChangeName={setName}
              onChangeRate={setRate}
              onChangeDist={setDist}
              onBackToType={() => setStep('type')}
            />
          )}

          {error && (
            <div
              className="mt-3 px-3 py-2 rounded text-[12px]"
              style={{ background: 'rgba(180,48,48,0.08)', color: '#B43030' }}
            >
              {error}
            </div>
          )}
        </div>

        {/* Footer */}
        <div
          className="flex items-center justify-between px-4 py-3 border-t gap-3"
          style={{
            borderColor: 'var(--border-hairline)',
            background: 'var(--bg-surface-2)',
          }}
        >
          <span className="text-[11.5px]" style={{ color: 'var(--text-tertiary)' }}>
            {step === 'type'
              ? 'Pick a type to continue.'
              : <>Press <Kbd>⌘</Kbd> <Kbd>↵</Kbd> to add</>}
          </span>
          <div className="flex gap-2">
            {step === 'details' && (
              <WBtn size="sm" onClick={() => setStep('type')}>Back</WBtn>
            )}
            <WBtn size="sm" onClick={onClose}>Cancel</WBtn>
            <WBtn
              size="sm"
              accent
              leading="plus"
              disabled={
                step === 'type' ||
                !rate.trim() ||
                comingSoon ||
                submitting ||
                componentsLoading ||
                !component
              }
              onClick={step === 'type' ? undefined : handleSubmit}
            >
              {submitting ? 'Adding…' : 'Add line item'}
            </WBtn>
          </div>
        </div>
      </div>
    </div>
  );
}

// ============================================================================
// Subcomponents
// ============================================================================

function TypePicker({ onPick }: { onPick: (t: DesignRateType) => void }) {
  return (
    <div className="grid gap-2" style={{ gridTemplateColumns: '1fr 1fr' }}>
      {RATE_TYPES.map(t => {
        const binding = RATE_TYPE_BINDINGS[t];
        return (
          <button
            key={t}
            onClick={() => onPick(t)}
            disabled={binding.comingSoon}
            className="focus-ring text-left flex flex-col gap-1 px-3 py-2.5 rounded-lg border bg-card cursor-pointer disabled:cursor-not-allowed"
            style={{
              borderColor: 'var(--border-hairline)',
              opacity: binding.comingSoon ? 0.5 : 1,
            }}
            onMouseEnter={e => {
              if (binding.comingSoon) return;
              e.currentTarget.style.background = 'var(--bg-row-hover)';
              e.currentTarget.style.borderColor = 'var(--border-hairline-strong)';
            }}
            onMouseLeave={e => {
              e.currentTarget.style.background = 'var(--bg-surface)';
              e.currentTarget.style.borderColor = 'var(--border-hairline)';
            }}
          >
            <div className="flex items-center justify-between gap-2">
              <span
                className="text-[13px] font-semibold"
                style={{ color: RATE_TYPE_COLOR[t] }}
              >
                {t}
              </span>
              <span className="num text-[11px]" style={{ color: 'var(--text-tertiary)' }}>
                {binding.unit}
              </span>
            </div>
            <span className="text-[11.5px] leading-[16px]" style={{ color: 'var(--text-tertiary)' }}>
              {binding.comingSoon ? `Coming soon — ${TYPE_DESCRIPTIONS[t]}` : TYPE_DESCRIPTIONS[t]}
            </span>
          </button>
        );
      })}
    </div>
  );
}

function DetailsForm({
  type,
  binding,
  comingSoon,
  components,
  componentCode,
  onChangeComponent,
  name,
  rate,
  dist,
  onChangeName,
  onChangeRate,
  onChangeDist,
  onBackToType,
}: {
  type: DesignRateType;
  binding: typeof RATE_TYPE_BINDINGS[DesignRateType];
  comingSoon: boolean;
  components: EarningComponent[] | undefined;
  componentCode: string | null;
  onChangeComponent: (code: string) => void;
  name: string;
  rate: string;
  dist: string;
  onChangeName: (v: string) => void;
  onChangeRate: (v: string) => void;
  onChangeDist: (v: string) => void;
  onBackToType: () => void;
}) {
  const prefix = binding.unit.includes('$') || !binding.unit.includes('%') ? '$' : '';
  const suffix = binding.unit.includes('%') ? '%' : '';

  const componentOptions = React.useMemo(
    () => earningComponentOptions(components, 'code'),
    [components],
  );

  return (
    <div className="flex flex-col gap-4">
      {comingSoon && (
        <div
          className="px-3 py-2 rounded text-[12px]"
          style={{ background: 'rgba(245,158,11,0.10)', color: '#A66800' }}
        >
          <strong>Coming soon.</strong> This rate type isn&apos;t wired into the
          calc engine yet. Choose another type to continue.
        </div>
      )}

      <FormRow label="Type" hint="The pay model for this line.">
        <button
          onClick={onBackToType}
          className="focus-ring inline-flex items-center gap-2 h-8 px-3 rounded-md cursor-pointer"
          style={{
            background: 'var(--bg-surface)',
            border: '1px solid var(--border-hairline-strong)',
            color: RATE_TYPE_COLOR[type],
            fontSize: 13,
            fontWeight: 600,
          }}
        >
          {type}
          <WIcon name="chevron-down" size={11} />
        </button>
      </FormRow>

      <FormRow label="Name" hint="Shows on driver settlements and the rates table.">
        <ModalInput value={name} onChange={onChangeName} placeholder={`e.g. ${type}`} />
      </FormRow>

      <FormRow
        label="Counts as"
        hint="Drives paycheck bucketing and tax treatment — e.g. an hourly H&W line classified as Health & Welfare pays as non-taxable fringe on top of base wage."
      >
        {componentOptions.length > 0 ? (
          <ModalSelect
            value={componentCode ?? ''}
            onChange={onChangeComponent}
            options={componentOptions}
          />
        ) : (
          <div className="text-[11.5px] italic" style={{ color: 'var(--text-tertiary)' }}>
            Loading component catalog…
          </div>
        )}
      </FormRow>

      <div className="grid gap-3" style={{ gridTemplateColumns: '1fr 140px' }}>
        <FormRow label="Rate" hint="The amount paid per unit.">
          <ModalInput
            value={rate}
            onChange={onChangeRate}
            placeholder="0.00"
            prefix={prefix}
            suffix={suffix}
            mono
          />
        </FormRow>
        <FormRow label="Unit" hint="Set by the rate type.">
          <div
            className="inline-flex items-center h-8 px-3 rounded-md text-[13px] font-medium"
            style={{
              background: 'var(--bg-surface-2)',
              border: '1px solid var(--border-hairline)',
              color: 'var(--text-secondary)',
            }}
          >
            {binding.unit}
          </div>
        </FormRow>
      </div>

      {binding.supportsDistance && (
        <FormRow label="Distance" hint="Only apply when leg distance matches.">
          <ModalSelect value={dist} onChange={onChangeDist} options={DISTANCE_OPTIONS} />
        </FormRow>
      )}

    </div>
  );
}

function FormRow({
  label,
  hint,
  children,
}: {
  label: string;
  hint?: string;
  children: React.ReactNode;
}) {
  return (
    <label className="flex flex-col gap-1">
      <span className="text-[12px] font-medium" style={{ color: 'var(--text-secondary)' }}>{label}</span>
      {children}
      {hint && <span className="text-[11px]" style={{ color: 'var(--text-tertiary)' }}>{hint}</span>}
    </label>
  );
}

function ModalInput({
  value,
  onChange,
  prefix,
  suffix,
  mono,
  placeholder,
}: {
  value: string;
  onChange: (v: string) => void;
  prefix?: string;
  suffix?: string;
  mono?: boolean;
  placeholder?: string;
}) {
  return (
    <div
      className="inline-flex items-stretch h-8 rounded-md overflow-hidden"
      style={{ border: '1px solid var(--border-hairline-strong)', background: 'var(--bg-surface)' }}
    >
      {prefix && (
        <span
          className="inline-flex items-center px-2.5 text-[12px] font-medium"
          style={{
            background: 'var(--bg-surface-2)',
            borderRight: '1px solid var(--border-hairline)',
            color: 'var(--text-tertiary)',
          }}
        >
          {prefix}
        </span>
      )}
      <input
        value={value}
        onChange={e => onChange(e.target.value)}
        placeholder={placeholder}
        className={mono ? 'num' : ''}
        style={{
          flex: 1,
          padding: '0 10px',
          border: 0,
          outline: 0,
          background: 'transparent',
          fontSize: 13,
          color: 'var(--text-primary)',
        }}
      />
      {suffix && (
        <span
          className="inline-flex items-center px-2.5 text-[12px] font-medium"
          style={{
            background: 'var(--bg-surface-2)',
            borderLeft: '1px solid var(--border-hairline)',
            color: 'var(--text-tertiary)',
          }}
        >
          {suffix}
        </span>
      )}
    </div>
  );
}

function ModalSelect({
  value,
  onChange,
  options,
}: {
  value: string;
  onChange: (v: string) => void;
  options: Array<{ value: string; label: string }>;
}) {
  return (
    <div className="relative">
      <select
        value={value}
        onChange={e => onChange(e.target.value)}
        className="appearance-none w-full h-8 pl-2.5 pr-7 rounded-md cursor-pointer text-[13px]"
        style={{
          background: 'var(--bg-surface)',
          border: '1px solid var(--border-hairline-strong)',
          color: 'var(--text-primary)',
        }}
      >
        {options.map(o => (
          <option key={o.value} value={o.value}>{o.label}</option>
        ))}
      </select>
      <span
        className="absolute pointer-events-none"
        style={{ right: 10, top: '50%', transform: 'translateY(-50%)', color: 'var(--text-tertiary)' }}
      >
        <WIcon name="chevron-down" size={11} />
      </span>
    </div>
  );
}

// ============================================================================
// Helpers — shared with RatesTable
// ============================================================================

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

function encodeDistance(
  dist: string,
  source: string,
): { minThreshold: number | undefined; filter: string | undefined } {
  if (dist === 'any') return { minThreshold: undefined, filter: undefined };
  const op = dist[0];
  const v = Number(dist.slice(1));
  if (!Number.isFinite(v)) return { minThreshold: undefined, filter: undefined };
  if (op === '>') return { minThreshold: v, filter: undefined };
  return { minThreshold: undefined, filter: `${source} < ${v}` };
}
