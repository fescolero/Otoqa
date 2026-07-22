'use client';

/**
 * New pay profile — guided create page.
 *
 * Reached from the "New profile" button on the Pay profiles list. Focused
 * form: pick a pay model, scope it to a payee type, name it, set the base
 * rate, and optionally seed common accessorials. Everything past that is
 * refined in the profile editor after creation.
 *
 * Visual reference: Otoqa Web design — settings-pay-create.jsx (rev aligned
 * with the pay engine: four per-leg models, absolute rates, payee scoping,
 * locked currency, single org default).
 *
 * Submits one atomic payProfiles.create call — the profile plus every seeded
 * rate line (components resolved server-side by catalog code) — then routes
 * to the editor.
 */

import * as React from 'react';
import { useRouter } from 'next/navigation';
import { useMutation, useQuery } from 'convex/react';
import { toast } from 'sonner';
import { api } from '@/convex/_generated/api';
import { useOrganizationId } from '@/contexts/organization-context';
import { SettingsHeader } from '@/components/web/settings-header';
import { WBtn, WIcon, DSCard, Kbd } from '@/components/web';
import type { IconName } from '@/components/web/icons';
import { ModelTag } from '@/components/web/pay-profiles/model-tag';
import { earningComponentOptions, type PayBasis } from '@/lib/payProfileDisplay';

// ============================================================================
// Model presets — the four per-leg trigger models the engine supports.
// Selecting one seeds the base rate + unit + default base-line name.
// ============================================================================

type ModelPreset = {
  payBasis: Exclude<PayBasis, 'HYBRID'>;
  label: string;
  icon: IconName;
  unit: string;
  prefix?: string;
  suffix?: string;
  base: string;
  baseName: string;
  blurb: string;
  componentCode: string;
  trigger: { source: string; transform?: 'HOURS_FROM_MINUTES' | 'PERCENT' };
};

const MODELS: ModelPreset[] = [
  {
    payBasis: 'MILEAGE', label: 'Per-mile', icon: 'route', unit: '/mi', prefix: '$',
    base: '0.600', baseName: 'Linehaul (loaded)',
    blurb: 'Pay per mile driven — the OTR standard.',
    componentCode: 'WAGE_MILEAGE', trigger: { source: 'leg.legLoadedMiles' },
  },
  {
    payBasis: 'HOURLY', label: 'Hourly', icon: 'gauge', unit: '/hr', prefix: '$',
    base: '32.00', baseName: 'Base hourly',
    blurb: 'Pay by the hour — local & yard work.',
    componentCode: 'WAGE_HOURLY',
    trigger: { source: 'leg.durationMinutes', transform: 'HOURS_FROM_MINUTES' },
  },
  {
    payBasis: 'PERCENTAGE', label: 'Percentage', icon: 'chart-bar', unit: '% of load', suffix: '%',
    base: '28', baseName: 'Driver share',
    blurb: '% of the load invoice total — owner-ops.',
    componentCode: 'WAGE_PERCENT',
    trigger: { source: 'load.invoiceTotalCents', transform: 'PERCENT' },
  },
  {
    payBasis: 'FLAT', label: 'Flat', icon: 'package', unit: '/load', prefix: '$',
    base: '120.00', baseName: 'Flat load rate',
    blurb: 'A set amount per load, any distance.',
    componentCode: 'WAGE_FLAT', trigger: { source: 'constant.1' },
  },
];

// ============================================================================
// Accessorial starters. `only` scopes a row to specific models; `soon` rows
// render disabled (no engine trigger yet). Empty miles gets an editable,
// pre-filled amount — the engine stores absolute rates only.
// ============================================================================

type AccessorialId = 'empty' | 'detention' | 'stop';

const ACCESSORIALS: Array<{
  id: AccessorialId | 'layover';
  label: string;
  detail?: string;
  only?: PayBasis[];
  kind?: 'empty';
  soon?: boolean;
}> = [
  { id: 'empty',     label: 'Empty miles', only: ['MILEAGE'], kind: 'empty' },
  { id: 'detention', label: 'Detention',   detail: '$45 / hr after 2h' },
  { id: 'stop',      label: 'Extra stop',  detail: '$35 after 1st stop' },
  { id: 'layover',   label: 'Layover',     detail: '$150 / 24h', soon: true },
];

const CURRENCIES = [
  { value: 'USD', label: 'USD — US Dollar ($)' },
  { value: 'CAD', label: 'CAD — Canadian Dollar ($)' },
  { value: 'MXN', label: 'MXN — Mexican Peso ($)' },
] as const;

// ── Custom lines — manually described rates stacked on top of the base
// (e.g. an H&W fringe per hour worked). Unit picks the engine trigger; the
// "counts as" component drives paycheck bucketing and tax treatment. ───────

type CustomUnit = 'hr' | 'hr_shift' | 'hr_offload' | 'mi' | 'mi_empty' | 'mi_total' | 'load';

const UNIT_META: Record<CustomUnit, {
  /** Picker label — spells out WHICH miles so an "Empty miles" line can't
   *  silently bind to hours or loaded miles. */
  label: string;
  suffix: string;
  defaultCode: string;
  trigger: { source: string; transform?: 'HOURS_FROM_MINUTES' };
}> = {
  hr:       { label: '/hr on load', suffix: '/hr',  defaultCode: 'WAGE_HOURLY',  trigger: { source: 'leg.durationMinutes', transform: 'HOURS_FROM_MINUTES' } },
  hr_shift: { label: '/hr shift',  suffix: '/hr',   defaultCode: 'WAGE_HOURLY',  trigger: { source: 'session.activeMinutes', transform: 'HOURS_FROM_MINUTES' } },
  hr_offload: { label: '/hr off-load', suffix: '/hr', defaultCode: 'WAGE_HOURLY',  trigger: { source: 'session.bookendMinutes', transform: 'HOURS_FROM_MINUTES' } },
  mi:       { label: '/mi loaded', suffix: '/mi',   defaultCode: 'WAGE_MILEAGE', trigger: { source: 'leg.legLoadedMiles' } },
  mi_empty: { label: '/mi empty',  suffix: '/mi',   defaultCode: 'WAGE_MILEAGE', trigger: { source: 'leg.legEmptyMiles' } },
  mi_total: { label: '/mi total',  suffix: '/mi',   defaultCode: 'WAGE_MILEAGE', trigger: { source: 'leg.totalMiles' } },
  load:     { label: '/load',      suffix: '/load', defaultCode: 'WAGE_FLAT',    trigger: { source: 'constant.1' } },
};

type CustomLine = { key: number; name: string; code: string; unit: CustomUnit; rate: string };

type Currency = (typeof CURRENCIES)[number]['value'];
type PayeeType = 'DRIVER' | 'CARRIER';

// Dollars → micro-cents (1/1000 cent); percent → micro-pct-points
// (100% = 100,000,000). Mirrors AddLineItemModal's parseRateInput.
function toMicroUnits(input: string, percent: boolean): bigint | null {
  const cleaned = input.replace(/[^0-9.]/g, '').trim();
  if (cleaned === '' || cleaned === '.') return null;
  const n = Number(cleaned);
  if (!Number.isFinite(n) || n < 0) return null;
  return BigInt(Math.round(n * (percent ? 1_000_000 : 100_000)));
}

const fmt3 = (n: number) => (Math.round(n * 1000) / 1000).toString();

// ============================================================================
// Page
// ============================================================================

export default function NewPayProfilePage() {
  const router = useRouter();
  const workosOrgId = useOrganizationId();
  const createProfile = useMutation(api.payProfiles.create);

  const [model, setModel] = React.useState<ModelPreset>(MODELS[0]);
  const [name, setName] = React.useState('');
  const [desc, setDesc] = React.useState('');
  const [payeeType, setPayeeType] = React.useState<PayeeType>('DRIVER');
  const [currency, setCurrency] = React.useState<Currency>('USD');
  const [orgDefault, setOrgDefault] = React.useState(false);
  const [baseName, setBaseName] = React.useState(MODELS[0].baseName);
  const [base, setBase] = React.useState(MODELS[0].base);
  const [acc, setAcc] = React.useState<Record<AccessorialId, boolean>>({
    empty: true, detention: true, stop: false,
  });
  const [emptyAmt, setEmptyAmt] = React.useState(fmt3(0.6 * 0.85));
  const [customLines, setCustomLines] = React.useState<CustomLine[]>([]);
  const customKeyRef = React.useRef(0);
  const [submitting, setSubmitting] = React.useState(false);

  // Component catalog for the custom lines' "Counts as" picker.
  const components = useQuery(
    api.chargeComponents.listForOrg,
    workosOrgId ? { workosOrgId } : 'skip',
  );
  const componentOptions = React.useMemo(
    () => earningComponentOptions(components, 'code'),
    [components],
  );

  const addCustomLine = () => setCustomLines(lines => [
    ...lines,
    { key: ++customKeyRef.current, name: '', code: 'HEALTH_WELFARE', unit: 'hr', rate: '' },
  ]);
  const patchCustomLine = (key: number, patch: Partial<CustomLine>) =>
    setCustomLines(lines => lines.map(l => (l.key === key ? { ...l, ...patch } : l)));
  const removeCustomLine = (key: number) =>
    setCustomLines(lines => lines.filter(l => l.key !== key));

  const pickModel = (m: ModelPreset) => {
    setModel(m);
    setBase(m.base);
    setBaseName(m.baseName);
    if (m.payBasis === 'MILEAGE') setEmptyAmt(fmt3((parseFloat(m.base) || 0) * 0.85));
  };

  // Empty-miles pre-fills at 85% of the base when toggled on — a one-time
  // calculation that does not track later base-rate edits.
  const toggleAcc = (id: AccessorialId) => setAcc(a => {
    const next = { ...a, [id]: !a[id] };
    if (id === 'empty' && next.empty) setEmptyAmt(fmt3((parseFloat(base) || 0) * 0.85));
    return next;
  });

  const rateStr = model.prefix
    ? `${model.prefix}${base || '0'} ${model.unit}`
    : `${base || '0'}${model.suffix ?? ''} ${model.unit}`;

  const visibleAcc = ACCESSORIALS.filter(a => !a.only || a.only.includes(model.payBasis));
  const accDetail = (a: (typeof ACCESSORIALS)[number]) =>
    a.kind === 'empty' ? `$${emptyAmt} /mi` : a.detail!;
  const chosenAcc = visibleAcc.filter(a => !a.soon && acc[a.id as AccessorialId]);

  const payeeWord = payeeType === 'DRIVER' ? 'drivers' : 'carriers';
  const baseMicro = toMicroUnits(base, model.payBasis === 'PERCENTAGE');
  // Custom lines: fully blank rows are ignored; partially filled rows block
  // create so nothing is silently dropped.
  const validCustomLines = customLines.filter(
    l => l.name.trim() !== '' && toMicroUnits(l.rate, false) !== null,
  );
  const customLinesOk = customLines.every(
    l => (l.name.trim() === '' && l.rate.trim() === '')
      || (l.name.trim() !== '' && toMicroUnits(l.rate, false) !== null),
  );
  const canCreate = !!workosOrgId && name.trim().length > 0 && baseMicro !== null
    && customLinesOk && !submitting;

  const submit = React.useCallback(async () => {
    if (!canCreate || !workosOrgId || baseMicro === null) return;
    setSubmitting(true);
    try {
      const initialRules: Array<{
        name: string;
        componentCode: string;
        trigger: { source: string; transform?: 'HOURS_FROM_MINUTES' | 'PERCENT'; filter?: string };
        rateAmountMicroCents: bigint;
        minThreshold?: number;
      }> = [{
        name: baseName.trim() || model.baseName,
        componentCode: model.componentCode,
        trigger: model.trigger,
        rateAmountMicroCents: baseMicro,
      }];

      if (model.payBasis === 'MILEAGE' && acc.empty) {
        const emptyMicro = toMicroUnits(emptyAmt, false);
        if (emptyMicro !== null && emptyMicro > BigInt(0)) {
          initialRules.push({
            name: 'Empty miles',
            componentCode: 'WAGE_MILEAGE',
            trigger: { source: 'leg.legEmptyMiles' },
            rateAmountMicroCents: emptyMicro,
          });
        }
      }
      if (acc.detention) {
        initialRules.push({
          name: 'Detention',
          componentCode: 'DETENTION_PAY',
          trigger: { source: 'stops.dwellMinutesSum', transform: 'HOURS_FROM_MINUTES' },
          rateAmountMicroCents: BigInt(4_500_000), // $45/hr
          minThreshold: 2,                  // hours — skip below 2h dwell
        });
      }
      if (acc.stop) {
        initialRules.push({
          name: 'Extra stop',
          componentCode: 'STOP_PAY',
          trigger: { source: 'stops.count' },
          rateAmountMicroCents: BigInt(3_500_000), // $35/stop
          minThreshold: 2,                  // fires from the 2nd stop on
        });
      }
      for (const l of validCustomLines) {
        initialRules.push({
          name: l.name.trim(),
          componentCode: l.code,
          trigger: UNIT_META[l.unit].trigger,
          rateAmountMicroCents: toMicroUnits(l.rate, false)!,
        });
      }

      const profileId = await createProfile({
        workosOrgId,
        name: name.trim(),
        description: desc.trim() || undefined,
        payeeType,
        payBasis: model.payBasis,
        currency,
        isDefault: orgDefault || undefined,
        initialRules,
      });
      toast.success(`Pay profile "${name.trim()}" created`);
      router.push(`/org-settings/pay-profiles/${profileId}`);
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Failed to create pay profile');
      setSubmitting(false);
    }
  }, [canCreate, workosOrgId, baseMicro, baseName, model, acc, emptyAmt, validCustomLines, name, desc, payeeType, currency, orgDefault, createProfile, router]);

  const cancel = React.useCallback(() => router.push('/org-settings/pay-profiles'), [router]);

  React.useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') { e.preventDefault(); cancel(); }
      if (e.key === 'Enter' && (e.metaKey || e.ctrlKey) && canCreate) { e.preventDefault(); void submit(); }
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [canCreate, submit, cancel]);

  return (
    <div className="flex-1 flex flex-col min-h-0 overflow-auto bg-[var(--bg-canvas)]">
      <SettingsHeader
        breadcrumb={
          <>
            <button
              onClick={cancel}
              className="focus-ring inline-flex items-center gap-1 p-0 border-0 bg-transparent cursor-pointer text-[12px]"
              style={{ color: 'var(--text-tertiary)', fontFamily: 'inherit' }}
            >
              <WIcon name="chevron-left" size={12} /> Pay profiles
            </button>
            <WIcon name="breadcrumb-sep" size={10} />
            <span style={{ color: 'var(--text-secondary)' }}>New profile</span>
          </>
        }
        eyebrow="Payroll & money"
        title="New pay profile"
        subtitle="Define a compensation template. Set the model, payee, and base rate, and any starter accessorials — then fine-tune rates and adjustments in the editor once it's created."
        actions={
          <>
            <WBtn size="sm" variant="ghost" onClick={cancel}>Cancel</WBtn>
            <WBtn size="sm" accent leading="check" disabled={!canCreate} onClick={() => void submit()}>
              {submitting ? 'Creating…' : 'Create profile'}
            </WBtn>
          </>
        }
      />

      <div
        className="flex-1 grid gap-6 p-6 items-start min-w-0"
        style={{ gridTemplateColumns: 'minmax(0, 1fr) 340px' }}
      >
        {/* Form column */}
        <div className="flex flex-col gap-4 min-w-0">
          <DSCard title={
            <SectionTitle sub="How drivers or carriers on this profile are paid. Sets the base rate's units and defaults — you can add other rate types later.">
              Pay model
            </SectionTitle>
          }>
            <div className="grid gap-2.5" style={{ gridTemplateColumns: 'repeat(auto-fit, minmax(180px, 1fr))' }}>
              {MODELS.map(m => (
                <ModelTile key={m.payBasis} model={m} active={model.payBasis === m.payBasis} onPick={() => pickModel(m)} />
              ))}
            </div>
          </DSCard>

          <DSCard title={
            <SectionTitle sub="Who the profile pays, its currency, and how it's named.">
              Profile identity
            </SectionTitle>
          }>
            <div className="grid gap-x-5 gap-y-3.5" style={{ gridTemplateColumns: '1fr 1fr' }}>
              <Field label="Name" full hint="Shows across the profile list, driver records, and settlements.">
                <Input value={name} onChange={setName} autoFocus placeholder="e.g. OTR Standard" />
              </Field>
              <Field label="Applies to" hint="The payee type this profile can be assigned to.">
                <Segmented
                  value={payeeType}
                  onChange={v => setPayeeType(v as PayeeType)}
                  options={[
                    { value: 'DRIVER', label: 'Driver', icon: 'users' },
                    { value: 'CARRIER', label: 'Carrier', icon: 'handshake' },
                  ]}
                />
              </Field>
              <Field label="Currency" hint="Locked after creation — all rates are stored in it.">
                <Select
                  value={currency}
                  onChange={v => setCurrency(v as Currency)}
                  options={CURRENCIES.map(c => ({ value: c.value, label: c.label }))}
                />
              </Field>
              <Field label="Model" hint="Locked to your selection above.">
                <div
                  className="inline-flex items-center gap-2 h-[34px] px-[11px] rounded-[7px] text-[13px] font-medium"
                  style={{
                    border: '1px solid var(--border-hairline)',
                    background: 'var(--bg-surface-2)',
                    color: 'var(--text-secondary)',
                  }}
                >
                  <WIcon name={model.icon} size={14} color="var(--text-tertiary)" /> {model.label}
                </div>
              </Field>
              <div style={{ gridColumn: '1 / -1' }}>
                <Switch
                  value={orgDefault}
                  onChange={setOrgDefault}
                  label="Set as org default"
                  hint="Pre-selected when assigning a new payee. Only one profile can be the default."
                />
              </div>
              <Field label="Description" full hint="What kind of runs it covers and any notable terms.">
                <Textarea value={desc} onChange={setDesc} placeholder="What kind of runs this covers and any notable terms…" />
              </Field>
            </div>
          </DSCard>

          <DSCard title={
            <SectionTitle sub="The primary line every settlement starts from. Everything else stacks on top.">
              Base rate
            </SectionTitle>
          }>
            <div className="grid gap-x-5 gap-y-3.5" style={{ gridTemplateColumns: '1fr 200px' }}>
              <Field label="Line name" hint="Shows in the rate table and on settlements.">
                <Input value={baseName} onChange={setBaseName} placeholder="e.g. Linehaul (loaded)" />
              </Field>
              <Field label="Rate" hint="Up to 3 decimal places.">
                <Input
                  value={base}
                  onChange={setBase}
                  mono
                  prefix={model.prefix}
                  suffix={model.suffix ?? model.unit.replace('/', '/ ')}
                  placeholder="0.000"
                />
              </Field>
            </div>
          </DSCard>

          <DSCard
            bodyClassName="p-0"
            title={
              <SectionTitle sub="Optional starters — toggle the ones that apply, or add your own lines (e.g. an H&W fringe on top of the base rate). Amounts are absolute; fine-tune in the editor.">
                Accessorials &amp; extra lines
              </SectionTitle>
            }
          >
            <div>
              {visibleAcc.map((a, i) => {
                if (a.soon) {
                  return (
                    <div
                      key={a.id}
                      className="flex items-center gap-3 px-3.5 py-2.5 opacity-60"
                      style={{ borderTop: i === 0 ? 'none' : '1px solid var(--border-hairline)' }}
                    >
                      <Check on={false} />
                      <span className="flex-1 min-w-0 text-[12.5px] font-medium" style={{ color: 'var(--text-secondary)' }}>
                        {a.label}
                      </span>
                      <span
                        className="text-[10px] font-bold uppercase px-[7px] py-[2px] rounded-[9px]"
                        style={{
                          letterSpacing: 0.03,
                          color: 'var(--text-tertiary)',
                          background: 'var(--bg-surface-2)',
                          border: '1px solid var(--border-hairline)',
                        }}
                      >
                        Soon
                      </span>
                    </div>
                  );
                }
                if (a.kind === 'empty') {
                  const on = acc.empty;
                  return (
                    <div key={a.id} style={{ borderTop: i === 0 ? 'none' : '1px solid var(--border-hairline)' }}>
                      <div className="flex items-center gap-3 px-3.5 py-2.5">
                        <button
                          onClick={() => toggleAcc('empty')}
                          className="focus-ring inline-flex items-center gap-3 flex-1 min-w-0 bg-transparent border-0 cursor-pointer text-left p-0"
                          style={{ fontFamily: 'inherit' }}
                        >
                          <Check on={on} />
                          <span className="text-[12.5px] font-medium" style={{ color: 'var(--text-primary)' }}>{a.label}</span>
                        </button>
                        {on ? (
                          <div className="w-[130px] shrink-0">
                            <Input value={emptyAmt} onChange={setEmptyAmt} mono prefix="$" suffix="/mi" placeholder="0.000" />
                          </div>
                        ) : (
                          <span className="num text-[12px]" style={{ color: 'var(--text-tertiary)' }}>≈ 85% of base</span>
                        )}
                      </div>
                      {on && (
                        <div className="pb-2.5 pr-3.5 text-[11px] leading-[15px]" style={{ paddingLeft: 44, color: 'var(--text-tertiary)' }}>
                          Pre-filled at 85% of the base rate — a one-time calculation that won&apos;t change if you edit the base later.
                        </div>
                      )}
                    </div>
                  );
                }
                return (
                  <button
                    key={a.id}
                    onClick={() => toggleAcc(a.id as AccessorialId)}
                    className="focus-ring w-full flex items-center gap-3 px-3.5 py-2.5 bg-transparent border-0 cursor-pointer text-left hover:bg-[var(--bg-row-hover)]"
                    style={{
                      fontFamily: 'inherit',
                      borderTop: i === 0 ? 'none' : '1px solid var(--border-hairline)',
                    }}
                  >
                    <Check on={acc[a.id as AccessorialId]} />
                    <span className="flex-1 min-w-0 text-[12.5px] font-medium" style={{ color: 'var(--text-primary)' }}>
                      {a.label}
                    </span>
                    <span className="num text-[12px]" style={{ color: 'var(--text-tertiary)' }}>{a.detail}</span>
                  </button>
                );
              })}

              {customLines.map(l => (
                <div key={l.key} style={{ borderTop: '1px solid var(--border-hairline)' }}>
                  <div className="flex items-center gap-2 px-3.5 py-2.5">
                    <div className="flex-1 min-w-0">
                      <Input value={l.name} onChange={v => patchCustomLine(l.key, { name: v })} placeholder="e.g. H&W" />
                    </div>
                    <div className="w-[120px] shrink-0">
                      <Input value={l.rate} onChange={v => patchCustomLine(l.key, { rate: v })} mono prefix="$" placeholder="0.000" />
                    </div>
                    <div className="w-[118px] shrink-0">
                      <Select
                        value={l.unit}
                        onChange={v => patchCustomLine(l.key, {
                          unit: v as CustomUnit,
                          // keep the wage default in sync unless the user
                          // classified the line as something specific already
                          code: Object.values(UNIT_META).some(m => m.defaultCode === l.code)
                            ? UNIT_META[v as CustomUnit].defaultCode
                            : l.code,
                        })}
                        options={(Object.keys(UNIT_META) as CustomUnit[]).map(u => ({ value: u, label: UNIT_META[u].label }))}
                      />
                    </div>
                    <button
                      onClick={() => removeCustomLine(l.key)}
                      className="focus-ring inline-flex items-center justify-center w-7 h-7 rounded border-0 bg-transparent cursor-pointer shrink-0"
                      style={{ color: 'var(--text-tertiary)' }}
                      aria-label="Remove line"
                      title="Remove line"
                    >
                      <WIcon name="close" size={13} />
                    </button>
                  </div>
                  <div className="flex items-center gap-2 pb-2.5 pr-3.5" style={{ paddingLeft: 14 }}>
                    <span className="text-[11px] whitespace-nowrap" style={{ color: 'var(--text-tertiary)' }}>Counts as</span>
                    <div className="flex-1 min-w-0">
                      <Select
                        value={l.code}
                        onChange={v => patchCustomLine(l.key, { code: v })}
                        options={componentOptions.length > 0
                          ? componentOptions
                          : [{ value: l.code, label: 'Loading component catalog…' }]}
                      />
                    </div>
                  </div>
                </div>
              ))}

              <button
                onClick={addCustomLine}
                className="focus-ring w-full flex items-center gap-2 px-3.5 py-2.5 bg-transparent border-0 cursor-pointer text-left hover:bg-[var(--bg-row-hover)]"
                style={{ fontFamily: 'inherit', borderTop: '1px solid var(--border-hairline)', color: 'var(--accent)' }}
              >
                <WIcon name="plus" size={13} />
                <span className="text-[12.5px] font-medium">Add custom line</span>
                <span className="text-[11.5px] ml-auto" style={{ color: 'var(--text-tertiary)' }}>
                  fringe, bonus, or another rate on top of base
                </span>
              </button>
            </div>
          </DSCard>
        </div>

        {/* Preview rail */}
        <div className="flex flex-col gap-4 sticky top-0">
          <DSCard title={<SectionTitle sub="How it appears in the Pay profiles list.">Preview</SectionTitle>}>
            <div className="rounded-[9px] overflow-hidden" style={{ border: '1px solid var(--border-hairline)', background: 'var(--bg-surface)' }}>
              <div className="flex items-center gap-2.5 px-3.5 py-3">
                <div
                  className="inline-flex items-center justify-center w-[30px] h-[30px] rounded-[7px] shrink-0"
                  style={{
                    background: 'var(--bg-surface-2)',
                    border: '1px solid var(--border-hairline)',
                    color: 'var(--text-secondary)',
                  }}
                >
                  <WIcon name="doc-dollar" size={15} />
                </div>
                <div className="min-w-0 flex-1">
                  <div
                    className="text-[13px] font-semibold truncate"
                    style={{ color: name.trim() ? 'var(--text-primary)' : 'var(--text-tertiary)' }}
                  >
                    {name.trim() || 'Untitled profile'}
                  </div>
                  <div className="text-[11px] mt-px" style={{ color: 'var(--text-tertiary)' }}>
                    Applies to {payeeWord} · {currency}
                  </div>
                </div>
                <span
                  className="text-[10px] font-bold uppercase px-[7px] py-[2px] rounded-[9px]"
                  style={{ letterSpacing: 0.03, color: 'var(--accent)', background: 'rgba(46,92,255,0.10)' }}
                >
                  New
                </span>
              </div>
              <div
                className="flex items-center gap-2 flex-wrap px-3.5 py-2.5"
                style={{ borderTop: '1px solid var(--border-hairline)', background: 'var(--bg-surface-2)' }}
              >
                <ModelTag payBasis={model.payBasis} />
                <span className="num text-[12.5px] font-semibold">{rateStr}</span>
                {orgDefault && (
                  <span
                    className="text-[10px] font-bold uppercase px-[7px] py-[2px] rounded-[9px]"
                    style={{ letterSpacing: 0.03, color: '#0F8C5F', background: 'rgba(16,185,129,0.12)' }}
                  >
                    Default
                  </span>
                )}
              </div>
              <div className="px-3.5 pt-1 pb-2">
                <div className="flex items-center justify-between py-[7px]">
                  <span className="text-[12px]" style={{ color: 'var(--text-secondary)' }}>{baseName || 'Base rate'}</span>
                  <span className="num text-[12px] font-semibold">{rateStr}</span>
                </div>
                {chosenAcc.map(a => (
                  <div
                    key={a.id}
                    className="flex items-center justify-between py-[7px]"
                    style={{ borderTop: '1px solid var(--border-hairline)' }}
                  >
                    <span className="text-[12px]" style={{ color: 'var(--text-secondary)' }}>{a.label}</span>
                    <span className="num text-[12px]" style={{ color: 'var(--text-tertiary)' }}>{accDetail(a)}</span>
                  </div>
                ))}
                {validCustomLines.map(l => (
                  <div
                    key={l.key}
                    className="flex items-center justify-between py-[7px]"
                    style={{ borderTop: '1px solid var(--border-hairline)' }}
                  >
                    <span className="text-[12px] truncate" style={{ color: 'var(--text-secondary)' }}>{l.name.trim()}</span>
                    <span className="num text-[12px] shrink-0" style={{ color: 'var(--text-tertiary)' }}>
                      ${l.rate.trim()} {UNIT_META[l.unit].label}
                    </span>
                  </div>
                ))}
              </div>
              <div
                className="px-3.5 py-2 text-[11.5px]"
                style={{
                  borderTop: '1px solid var(--border-hairline)',
                  background: 'var(--bg-surface-2)',
                  color: 'var(--text-tertiary)',
                }}
              >
                In use · <span className="num font-semibold" style={{ color: 'var(--text-secondary)' }}>0</span> {payeeWord}
              </div>
            </div>
          </DSCard>

          <DSCard title={<SectionTitle>Setup checklist</SectionTitle>}>
            <div>
              <ChecklistRow done label="Choose a pay model" />
              <ChecklistRow done label="Choose who it applies to" />
              <ChecklistRow done={name.trim().length > 0} label="Name the profile" />
              <ChecklistRow done={baseMicro !== null} label="Set the base rate" />
              <ChecklistRow
                done={chosenAcc.length + validCustomLines.length > 0}
                label={`Extra lines (optional) · ${chosenAcc.length + validCustomLines.length} added`}
                last
              />
            </div>
            <div
              className="mt-3 flex items-start gap-2 px-3 py-2.5 rounded-lg"
              style={{ background: 'var(--bg-surface-2)', border: '1px solid var(--border-hairline)' }}
            >
              <WIcon name="help" size={13} color="var(--text-tertiary)" style={{ marginTop: 1, flexShrink: 0 }} />
              <span className="text-[11.5px] leading-4" style={{ color: 'var(--text-tertiary)' }}>
                Creating starts with zero {payeeWord} assigned. Assign it on {payeeType === 'DRIVER' ? 'driver' : 'carrier'} records, or bulk-apply from the profile once saved.
              </span>
            </div>
          </DSCard>

          <div className="flex items-center justify-end gap-2">
            <span className="text-[11px] mr-auto" style={{ color: 'var(--text-tertiary)' }}>
              <Kbd>⌘</Kbd> <Kbd>↵</Kbd> to create
            </span>
            <WBtn size="sm" variant="ghost" onClick={cancel}>Cancel</WBtn>
            <WBtn size="sm" accent leading="check" disabled={!canCreate} onClick={() => void submit()}>
              {submitting ? 'Creating…' : 'Create profile'}
            </WBtn>
          </div>
        </div>
      </div>
    </div>
  );
}

// ============================================================================
// Local form primitives (mirrors the design's PC* components)
// ============================================================================

function SectionTitle({ children, sub }: { children: React.ReactNode; sub?: string }) {
  return (
    <span className="inline-flex flex-col gap-px py-1">
      <span>{children}</span>
      {sub && (
        <span className="text-[11px] font-normal leading-[15px]" style={{ color: 'var(--text-tertiary)' }}>
          {sub}
        </span>
      )}
    </span>
  );
}

function Field({
  label, hint, full, children,
}: {
  label: string; hint?: React.ReactNode; full?: boolean; children: React.ReactNode;
}) {
  return (
    <label className="flex flex-col gap-[5px] min-w-0" style={{ gridColumn: full ? '1 / -1' : undefined }}>
      <span className="text-[12px] font-medium whitespace-nowrap" style={{ color: 'var(--text-secondary)' }}>{label}</span>
      {children}
      {hint && <span className="text-[11px] leading-[15px]" style={{ color: 'var(--text-tertiary)' }}>{hint}</span>}
    </label>
  );
}

function Input({
  value, onChange, prefix, suffix, mono, placeholder, autoFocus,
}: {
  value: string;
  onChange: (v: string) => void;
  prefix?: string;
  suffix?: string;
  mono?: boolean;
  placeholder?: string;
  autoFocus?: boolean;
}) {
  return (
    <div
      className="flex items-stretch w-full h-[34px] rounded-[7px] overflow-hidden"
      style={{ border: '1px solid var(--border-hairline-strong)', background: 'var(--bg-surface)' }}
    >
      {prefix && (
        <span
          className="inline-flex items-center px-2.5 text-[12.5px] font-medium"
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
        autoFocus={autoFocus}
        onChange={e => onChange(e.target.value)}
        placeholder={placeholder}
        className={mono ? 'num' : ''}
        style={{
          flex: 1, minWidth: 0, padding: '0 11px', border: 0, outline: 0,
          background: 'transparent', fontFamily: 'inherit',
          fontVariantNumeric: mono ? 'tabular-nums' : undefined,
          fontSize: 13, color: 'var(--text-primary)',
        }}
      />
      {suffix && (
        <span
          className="inline-flex items-center px-2.5 text-[12.5px] font-medium"
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

function Textarea({
  value, onChange, placeholder,
}: {
  value: string; onChange: (v: string) => void; placeholder?: string;
}) {
  return (
    <textarea
      value={value}
      onChange={e => onChange(e.target.value)}
      placeholder={placeholder}
      rows={3}
      className="rounded-[7px] text-[12.5px]"
      style={{
        resize: 'vertical', minHeight: 62, padding: '9px 11px',
        border: '1px solid var(--border-hairline-strong)',
        background: 'var(--bg-surface)', outline: 0,
        fontFamily: 'inherit', lineHeight: '18px',
        color: 'var(--text-primary)',
      }}
    />
  );
}

function Select({
  value, onChange, options,
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
        className="appearance-none w-full h-[34px] rounded-[7px] cursor-pointer text-[13px]"
        style={{
          padding: '0 30px 0 11px',
          border: '1px solid var(--border-hairline-strong)',
          background: 'var(--bg-surface)', fontFamily: 'inherit',
          color: 'var(--text-primary)',
        }}
      >
        {options.map(o => <option key={o.value} value={o.value}>{o.label}</option>)}
      </select>
      <span
        className="absolute pointer-events-none"
        style={{ right: 11, top: '50%', transform: 'translateY(-50%)', color: 'var(--text-tertiary)' }}
      >
        <WIcon name="chevron-down" size={12} />
      </span>
    </div>
  );
}

function Segmented({
  value, onChange, options,
}: {
  value: string;
  onChange: (v: string) => void;
  options: Array<{ value: string; label: string; icon: IconName }>;
}) {
  return (
    <div
      className="inline-flex items-stretch h-[34px] w-full rounded-[7px] overflow-hidden"
      style={{ border: '1px solid var(--border-hairline-strong)', background: 'var(--bg-surface)' }}
    >
      {options.map((o, i) => {
        const active = o.value === value;
        return (
          <button
            key={o.value}
            onClick={() => onChange(o.value)}
            className="focus-ring flex-1 inline-flex items-center justify-center gap-[7px] cursor-pointer text-[12.5px]"
            style={{
              border: 0,
              borderLeft: i === 0 ? 'none' : '1px solid var(--border-hairline-strong)',
              background: active ? 'var(--bg-surface-2)' : 'transparent',
              color: active ? 'var(--text-primary)' : 'var(--text-tertiary)',
              fontWeight: active ? 600 : 500,
              fontFamily: 'inherit',
            }}
          >
            <WIcon name={o.icon} size={13} color={active ? 'var(--accent)' : 'var(--text-tertiary)'} />
            {o.label}
          </button>
        );
      })}
    </div>
  );
}

function Switch({
  value, onChange, label, hint,
}: {
  value: boolean; onChange: (v: boolean) => void; label: string; hint?: string;
}) {
  return (
    <div
      onClick={() => onChange(!value)}
      role="switch"
      aria-checked={value}
      tabIndex={0}
      onKeyDown={e => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); onChange(!value); } }}
      className="focus-ring flex items-center gap-3 cursor-pointer px-[13px] py-[11px] rounded-lg"
      style={{ border: '1px solid var(--border-hairline)', background: 'var(--bg-surface-2)' }}
    >
      <span
        className="relative shrink-0 rounded-full"
        style={{
          width: 32, height: 19,
          background: value ? 'var(--accent)' : 'var(--border-hairline-strong)',
          transition: 'background var(--dur-fast) var(--ease-out)',
        }}
      >
        <span
          className="absolute rounded-full bg-white"
          style={{
            top: 2, left: value ? 15 : 2, width: 15, height: 15,
            boxShadow: '0 1px 2px rgba(0,0,0,0.2)',
            transition: 'left var(--dur-fast) var(--ease-out)',
          }}
        />
      </span>
      <span className="min-w-0">
        <span className="block text-[12.5px] font-semibold" style={{ color: 'var(--text-primary)' }}>{label}</span>
        {hint && <span className="block text-[11px] leading-[15px] mt-px" style={{ color: 'var(--text-tertiary)' }}>{hint}</span>}
      </span>
    </div>
  );
}

function ModelTile({
  model, active, onPick,
}: {
  model: ModelPreset; active: boolean; onPick: () => void;
}) {
  return (
    <button
      onClick={onPick}
      className="focus-ring text-left cursor-pointer flex flex-col gap-2 p-3 rounded-[9px]"
      style={{
        fontFamily: 'inherit',
        background: active ? 'rgba(46,92,255,0.06)' : 'var(--bg-surface)',
        border: `1px solid ${active ? 'var(--accent)' : 'var(--border-hairline)'}`,
        boxShadow: active ? '0 0 0 3px rgba(46,92,255,0.12)' : 'none',
        transition: 'border-color var(--dur-fast) var(--ease-out), box-shadow var(--dur-fast) var(--ease-out), background var(--dur-fast) var(--ease-out)',
      }}
      onMouseEnter={e => { if (!active) e.currentTarget.style.borderColor = 'var(--border-hairline-strong)'; }}
      onMouseLeave={e => { if (!active) e.currentTarget.style.borderColor = 'var(--border-hairline)'; }}
    >
      <div className="flex items-center justify-between w-full">
        <span
          className="inline-flex items-center justify-center w-[30px] h-[30px] rounded-lg shrink-0"
          style={{
            background: active ? 'var(--accent)' : 'var(--bg-surface-2)',
            color: active ? '#fff' : 'var(--text-secondary)',
            border: active ? 'none' : '1px solid var(--border-hairline)',
          }}
        >
          <WIcon name={model.icon} size={15} />
        </span>
        {active && <WIcon name="check" size={15} color="var(--accent)" />}
      </div>
      <div>
        <div className="text-[13px] font-semibold" style={{ color: 'var(--text-primary)' }}>{model.label}</div>
        <div className="text-[11px] leading-[15px] mt-0.5" style={{ color: 'var(--text-tertiary)' }}>{model.blurb}</div>
      </div>
    </button>
  );
}

function Check({ on }: { on: boolean }) {
  return (
    <span
      className="inline-flex items-center justify-center w-[18px] h-[18px] rounded-[5px] shrink-0"
      style={{
        background: on ? 'var(--accent)' : 'var(--bg-surface)',
        border: `1px solid ${on ? 'var(--accent)' : 'var(--border-hairline-strong)'}`,
        transition: 'background var(--dur-fast) var(--ease-out), border-color var(--dur-fast) var(--ease-out)',
      }}
    >
      {on && <WIcon name="check" size={12} color="#fff" />}
    </span>
  );
}

function ChecklistRow({ done, label, last }: { done: boolean; label: string; last?: boolean }) {
  return (
    <div
      className="flex items-center gap-2.5 py-[9px]"
      style={{ borderBottom: last ? 'none' : '1px solid var(--border-hairline)' }}
    >
      <span
        className="inline-flex items-center justify-center w-[18px] h-[18px] rounded-full shrink-0"
        style={{
          background: done ? 'rgba(16,185,129,0.12)' : 'var(--bg-surface-2)',
          border: done ? 'none' : '1px solid var(--border-hairline-strong)',
        }}
      >
        {done
          ? <WIcon name="check" size={11} color="#0F8C5F" />
          : <span className="w-[5px] h-[5px] rounded-full" style={{ background: 'var(--text-tertiary)' }} />}
      </span>
      <span
        className="text-[12.5px]"
        style={{ color: done ? 'var(--text-secondary)' : 'var(--text-tertiary)', fontWeight: done ? 500 : 400 }}
      >
        {label}
      </span>
    </div>
  );
}
