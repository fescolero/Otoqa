'use client';

/**
 * Period rules — profile-level rules that fire at settlement aggregation,
 * not per-shift/leg: today, weekly hour caps (MAXIMUM_CAP_WEEKLY).
 *
 * A weekly cap says "pay this component on at most N hours per 7-day window
 * of the pay period". The pay engine keeps every shift line intact and emits
 * a visible offset line on the statement for the hours over the cap, so the
 * math stays auditable. Classic use: Health & Welfare fringe owed on the
 * first 40 hours each week.
 *
 * Writes replace the profile's whole postCalcRules array (payProfiles.update);
 * rules of other kinds are carried through untouched.
 */

import * as React from 'react';
import { toast } from 'sonner';
// eslint-disable-next-line no-restricted-imports -- pre-existing raw Convex query; migrate to useAuthQuery/useAuthPaginatedQuery
import { useMutation, useQuery } from 'convex/react';
import { api } from '@/convex/_generated/api';
import type { Doc, Id } from '@/convex/_generated/dataModel';
import { DSCard, WBtn, WIcon } from '@/components/web';
import { earningComponentOptions } from '@/lib/payProfileDisplay';

type PostCalcRule = NonNullable<Doc<'payProfiles'>['postCalcRules']>[number];

export function PeriodRulesCard({
  profile,
  workosOrgId,
}: {
  profile: Doc<'payProfiles'>;
  workosOrgId: string | null;
}) {
  const components = useQuery(
    api.chargeComponents.listForOrg,
    workosOrgId ? { workosOrgId } : 'skip',
  );
  const updateProfile = useMutation(api.payProfiles.update);

  const rules = React.useMemo(() => profile.postCalcRules ?? [], [profile.postCalcRules]);
  const weeklyCaps = rules.filter((r) => r.kind === 'MAXIMUM_CAP_WEEKLY');

  const [adding, setAdding] = React.useState(false);
  const [componentId, setComponentId] = React.useState('');
  const [hours, setHours] = React.useState('40');
  const [busy, setBusy] = React.useState(false);

  const options = earningComponentOptions(components, '_id');
  const nameOf = (id: string) =>
    components?.find((c) => c._id === id)?.displayName ?? 'Component';

  const commit = async (next: PostCalcRule[]) => {
    setBusy(true);
    try {
      await updateProfile({ profileId: profile._id, patch: { postCalcRules: next } });
    } catch (err) {
      toast.error('Failed to save period rules');
      console.error(err);
    } finally {
      setBusy(false);
    }
  };

  const addCap = async () => {
    const n = parseFloat(hours);
    if (!componentId) { toast.error('Pick a component to cap'); return; }
    if (!Number.isFinite(n) || n <= 0) { toast.error('Cap hours must be a positive number'); return; }
    if (weeklyCaps.some((r) => (r.componentId as string) === componentId)) {
      toast.error(`${nameOf(componentId)} already has a weekly cap`);
      return;
    }
    const maxSort = rules.reduce((m, r) => Math.max(m, r.sortOrder), 0);
    await commit([
      ...rules,
      {
        name: `${nameOf(componentId)} weekly cap`,
        kind: 'MAXIMUM_CAP_WEEKLY',
        componentId: componentId as Id<'chargeComponents'>,
        thresholdQty: n,
        sortOrder: maxSort + 1,
      },
    ]);
    setAdding(false);
    setComponentId('');
    setHours('40');
  };

  const removeRule = async (rule: PostCalcRule) => {
    await commit(rules.filter((r) => r !== rule));
  };

  return (
    <DSCard
      title={
        <span className="inline-flex items-center gap-2">
          <span>Period rules</span>
          <span className="text-[11px] font-normal" style={{ color: 'var(--text-tertiary)' }}>
            · applied per pay period, on top of the rate lines
          </span>
        </span>
      }
      bodyClassName="p-0"
    >
      {rules.length === 0 && !adding && (
        <div className="px-3.5 py-4 text-[12px]" style={{ color: 'var(--text-tertiary)' }}>
          No period rules yet. A weekly cap pays a rate layer on at most N hours per week —
          e.g. Health &amp; Welfare on the first 40 h — and puts a visible offset line on the
          statement for anything over.
        </div>
      )}

      {rules.map((rule, i) => (
        <div
          key={`${rule.kind}:${rule.name}:${i}`}
          className="flex items-center gap-2.5 px-3.5 py-2.5"
          style={{ borderTop: i === 0 ? 'none' : '1px solid var(--border-hairline)' }}
        >
          <span
            className="inline-flex items-center justify-center w-6 h-6 rounded shrink-0"
            style={{
              background: 'var(--bg-surface-2)',
              border: '1px solid var(--border-hairline)',
              color: 'var(--text-secondary)',
            }}
          >
            <WIcon name={rule.kind === 'MAXIMUM_CAP_WEEKLY' ? 'clock' : 'gauge'} size={13} />
          </span>
          <div className="min-w-0 flex-1">
            <div className="text-[12.5px] font-medium truncate" style={{ color: 'var(--text-primary)' }}>
              {rule.name}
            </div>
            <div className="text-[11px]" style={{ color: 'var(--text-tertiary)' }}>
              {rule.kind === 'MAXIMUM_CAP_WEEKLY' ? (
                <>
                  Pays {nameOf(rule.componentId as string)} on at most{' '}
                  <span className="num" style={{ color: 'var(--text-secondary)', fontWeight: 500 }}>
                    {rule.thresholdQty ?? '—'} h
                  </span>{' '}
                  per week — hours over show as an offset line on the statement.
                </>
              ) : (
                rule.kind.replaceAll('_', ' ').toLowerCase()
              )}
            </div>
          </div>
          <button
            type="button"
            title="Remove rule"
            disabled={busy}
            onClick={() => removeRule(rule)}
            className="focus-ring shrink-0 inline-flex items-center justify-center rounded cursor-pointer border-0 bg-transparent text-[var(--text-tertiary)] hover:text-[#B43030] disabled:opacity-50"
            style={{ width: 22, height: 22 }}
          >
            <WIcon name="close" size={13} />
          </button>
        </div>
      ))}

      <div
        className="px-3.5 py-2.5"
        style={{ borderTop: rules.length > 0 || adding ? '1px solid var(--border-hairline)' : 'none' }}
      >
        {!adding ? (
          <WBtn size="xs" leading="plus" onClick={() => setAdding(true)}>
            Add weekly cap
          </WBtn>
        ) : (
          <div className="flex items-center gap-2 flex-wrap">
            <span className="text-[12px]" style={{ color: 'var(--text-secondary)' }}>Cap</span>
            <select
              value={componentId}
              onChange={(e) => setComponentId(e.target.value)}
              className="focus-ring rounded-lg cursor-pointer"
              style={{
                height: 28, padding: '0 8px', fontSize: 12, color: 'var(--text-primary)',
                background: 'var(--bg-surface)', border: '1px solid var(--border-hairline-strong)',
                maxWidth: 240,
              }}
            >
              <option value="">Pick a component…</option>
              {options.map((o) => (
                <option key={o.value} value={o.value}>{o.label}</option>
              ))}
            </select>
            <span className="text-[12px]" style={{ color: 'var(--text-secondary)' }}>at</span>
            <input
              type="number" min="1" step="0.5" value={hours}
              onChange={(e) => setHours(e.target.value)}
              className="focus-ring num rounded-lg"
              style={{
                width: 64, height: 28, padding: '0 8px', fontSize: 12, textAlign: 'right',
                color: 'var(--text-primary)', background: 'var(--bg-surface)',
                border: '1px solid var(--border-hairline-strong)',
              }}
            />
            <span className="text-[12px]" style={{ color: 'var(--text-secondary)' }}>h / week</span>
            <div className="flex items-center gap-1.5 ml-auto">
              <WBtn size="xs" variant="ghost" disabled={busy} onClick={() => setAdding(false)}>
                Cancel
              </WBtn>
              <WBtn size="xs" accent disabled={busy} onClick={addCap}>
                Add cap
              </WBtn>
            </div>
          </div>
        )}
      </div>
    </DSCard>
  );
}
