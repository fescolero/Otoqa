/**
 * PayeeProfilesCard — driver/carrier Compensation card.
 *
 * Mirrors the new design in `details-driver.jsx` (DvPay):
 *   - Header action: "Manage pay profiles" → opens ManageAssignmentsModal
 *   - DEFAULT PROFILE block rendered through DSProps:
 *       · Pay model row (profile name + model chip)
 *       · Rate breakdown row (flex-wrap chips: name + rate + unit + note)
 *       · Currency / state / contract-tag rows if set on the profile
 *   - CONDITIONAL OVERRIDES (n) section: one OverrideAssignmentCard per
 *     non-default assignment, each with its own rate-breakdown chips.
 *   - PAYOUT ACCOUNT divider section — placeholder rows for direct deposit
 *     and YTD gross until the payeeBankAccounts UI ships.
 *
 * Pay profile templates themselves are managed at Settings → Pay profiles.
 * This card is purely about *which* templates apply to *this* payee.
 */

'use client';

import * as React from 'react';
import { useQuery } from 'convex/react';
import { api } from '@/convex/_generated/api';
import {
  DSCard,
  DSProps,
  type DSPropItem,
  WBtn,
  WIcon,
} from '@/components/web';
import { ModelTag } from '@/components/web/pay-profiles/model-tag';
import { ManageAssignmentsModal } from '@/components/web/pay-profiles/manage-assignments-modal';
import {
  formatRateMicroCents,
  triggerToDesignType,
  RATE_TYPE_BINDINGS,
  type PayBasis,
} from '@/lib/payProfileDisplay';

export interface PayeeProfilesCardProps {
  payeeType: 'DRIVER' | 'CARRIER';
  payeeId: string;
}

// ============================================================================
// Shared types — mirror the enriched shape returned by listForPayee
// ============================================================================

type RuleForChip = {
  name: string;
  trigger: { source: string; transform?: string; filter?: string };
  rateAmountMicroCents?: bigint;
  minThreshold?: number;
};

type Assignment = {
  _id: string;
  profileId: string;
  profileName: string;
  profilePayBasis: string;
  profileCurrency?: string;
  profileState?: string;
  profileContractTag?: string;
  isDefault?: boolean;
  selectionStrategy: string;
  matchState?: string;
  matchContractTag?: string;
  thresholdValue?: number;
  rules: RuleForChip[];
};

// ============================================================================
// Component
// ============================================================================

export function PayeeProfilesCard({ payeeType, payeeId }: PayeeProfilesCardProps) {
  const assignments = useQuery(api.payeeProfileAssignments.listForPayee, {
    payeeType,
    payeeId,
  });
  const [sheetOpen, setSheetOpen] = React.useState(false);

  const list = (assignments ?? []) as Assignment[];
  const defaultAssign = list.find(a => a.isDefault) ?? list[0] ?? null;
  const overrides = list.filter(a => a !== defaultAssign);
  const payeeLabel = payeeType === 'CARRIER' ? 'carrier' : 'driver';

  return (
    <>
      <DSCard
        title="Compensation"
        action={
          <WBtn size="sm" leading="edit" onClick={() => setSheetOpen(true)}>
            Manage pay profiles
          </WBtn>
        }
        bodyClassName="flex flex-col gap-3.5"
      >
        {assignments === undefined ? (
          <p className="m-0 text-[12.5px]" style={{ color: 'var(--text-tertiary)' }}>
            Loading…
          </p>
        ) : list.length === 0 ? (
          <EmptyState payeeLabel={payeeLabel} onAdd={() => setSheetOpen(true)} />
        ) : (
          <>
            {/* Default profile — rendered as a labeled DSProps block */}
            <div>
              <SubHeader>Default profile</SubHeader>
              {defaultAssign ? (
                <DSProps items={buildDefaultRows(defaultAssign)} />
              ) : (
                <p
                  className="text-[12.5px] italic"
                  style={{ color: 'var(--text-tertiary)' }}
                >
                  No default profile.
                </p>
              )}
            </div>

            {overrides.length > 0 && (
              <div>
                <SubHeader>{`Conditional overrides (${overrides.length})`}</SubHeader>
                <div className="flex flex-col gap-2 mt-1.5">
                  {overrides.map(a => (
                    <OverrideAssignmentCard key={a._id} assignment={a} />
                  ))}
                </div>
              </div>
            )}
          </>
        )}

        {/* Payout account — stub until payeeBankAccounts UI ships */}
        <div
          style={{
            height: 1,
            background: 'var(--border-hairline)',
            margin: '4px 0 2px',
          }}
        />
        <div>
          <SubHeader>Payout account</SubHeader>
          <DSProps
            items={[
              {
                label: 'Direct dep.',
                value: (
                  <span style={{ color: 'var(--text-tertiary)', fontStyle: 'italic' }}>
                    Not set
                  </span>
                ),
              },
              {
                label: 'YTD gross',
                value: (
                  <span style={{ color: 'var(--text-tertiary)', fontStyle: 'italic' }}>
                    —
                  </span>
                ),
              },
            ]}
          />
        </div>
      </DSCard>

      {sheetOpen && (
        <ManageAssignmentsModal
          payeeType={payeeType}
          payeeId={payeeId}
          onClose={() => setSheetOpen(false)}
        />
      )}
    </>
  );
}

// ============================================================================
// Subcomponents
// ============================================================================

function SubHeader({ children }: { children: React.ReactNode }) {
  return (
    <div
      className="mb-1"
      style={{
        fontSize: 10.5,
        fontWeight: 600,
        letterSpacing: 0.04,
        textTransform: 'uppercase',
        color: 'var(--text-tertiary)',
      }}
    >
      {children}
    </div>
  );
}

function EmptyState({
  payeeLabel,
  onAdd,
}: {
  payeeLabel: string;
  onAdd: () => void;
}) {
  return (
    <div className="flex flex-col items-center gap-2 py-4 text-center">
      <div
        className="inline-flex items-center justify-center w-10 h-10 rounded-md"
        style={{
          background: 'var(--bg-surface-2)',
          border: '1px solid var(--border-hairline)',
          color: 'var(--text-tertiary)',
        }}
      >
        <WIcon name="doc-dollar" size={16} />
      </div>
      <div className="text-[12.5px]" style={{ color: 'var(--text-secondary)' }}>
        No pay profile assigned for this {payeeLabel}
      </div>
      <WBtn size="sm" accent leading="plus" onClick={onAdd}>
        Manage pay profiles
      </WBtn>
    </div>
  );
}

/**
 * OverrideAssignmentCard — non-default assignment with its condition pill
 * + the same rate-chip treatment as the default profile.
 */
function OverrideAssignmentCard({ assignment }: { assignment: Assignment }) {
  const conditionLabel = describeCondition(assignment);

  return (
    <div
      style={{
        border: '1px solid var(--border-hairline)',
        borderRadius: 8,
        background: 'var(--bg-surface-2)',
        overflow: 'hidden',
      }}
    >
      {/* Header — condition pill + profile name + model tag */}
      <div
        className="flex items-center gap-2 flex-wrap"
        style={{
          padding: '8px 10px',
          borderBottom: '1px solid var(--border-hairline)',
          background: 'var(--bg-surface)',
        }}
      >
        <span
          className="inline-flex items-center gap-1"
          style={{
            fontSize: 10.5,
            padding: '2px 8px',
            borderRadius: 9,
            background: 'rgba(245,158,11,0.10)',
            color: '#A66800',
            fontWeight: 600,
            letterSpacing: 0.04,
            textTransform: 'uppercase',
            whiteSpace: 'nowrap',
          }}
        >
          <WIcon name="filter" size={10} />
          When · {conditionLabel ?? 'Custom'}
        </span>
        <span
          style={{
            fontSize: 12.5,
            fontWeight: 600,
            color: 'var(--text-primary)',
          }}
        >
          {assignment.profileName}
        </span>
        <ModelTag payBasis={assignment.profilePayBasis as PayBasis} />
      </div>

      {/* Rate breakdown chips */}
      {assignment.rules.length > 0 && (
        <div
          className="flex flex-wrap gap-1.5"
          style={{ padding: '8px 10px' }}
        >
          {assignment.rules.map(r => (
            <RateChip key={r.name + r.trigger.source} rule={r} surface="alt" />
          ))}
        </div>
      )}
    </div>
  );
}

/**
 * RateChip — one rule rendered as a "name + rate + unit + optional note"
 * pill. Used in both the default-profile rate-breakdown row and inside
 * OverrideAssignmentCard.
 *
 * `surface` controls the chip background: 'primary' for the default
 * profile (lighter to sit on the card body) and 'alt' for chips inside
 * the override card (which already has a tinted background).
 */
function RateChip({
  rule,
  surface,
}: {
  rule: RuleForChip;
  surface: 'primary' | 'alt';
}) {
  const designType = triggerToDesignType(rule.trigger.source, rule.trigger.transform);
  const binding = RATE_TYPE_BINDINGS[designType];
  const rate = formatRateMicroCents(rule.rateAmountMicroCents, designType);
  const note = describeRuleNote(rule);

  return (
    <span
      className="inline-flex items-baseline gap-1.5"
      style={{
        padding: '4px 8px',
        borderRadius: 6,
        background: surface === 'primary' ? 'var(--bg-surface-2)' : 'var(--bg-surface)',
        border: '1px solid var(--border-hairline)',
        maxWidth: '100%',
      }}
    >
      <span
        style={{
          fontSize: 12,
          fontWeight: 500,
          color: 'var(--text-secondary)',
          whiteSpace: 'nowrap',
        }}
      >
        {rule.name}
      </span>
      <span className="inline-flex items-baseline" style={{ gap: 2 }}>
        <span
          className="num"
          style={{
            fontSize: 12.5,
            fontWeight: 600,
            color: 'var(--text-primary)',
          }}
        >
          {rate}
        </span>
        {binding.unit && (
          <span
            style={{
              fontSize: 11,
              color: 'var(--text-tertiary)',
            }}
          >
            {binding.unit}
          </span>
        )}
      </span>
      {note && (
        <span
          style={{
            fontSize: 10.5,
            color: 'var(--text-tertiary)',
            fontStyle: 'italic',
            whiteSpace: 'nowrap',
          }}
        >
          · {note}
        </span>
      )}
    </span>
  );
}

// ============================================================================
// Row builders + helpers
// ============================================================================

/** Build the DSProps rows for the default profile block. */
function buildDefaultRows(a: Assignment): DSPropItem[] {
  const rows: DSPropItem[] = [];

  rows.push({
    label: 'Pay model',
    value: (
      <span className="inline-flex items-center gap-1.5">
        <span style={{ fontWeight: 500 }}>{a.profileName}</span>
        <ModelTag payBasis={a.profilePayBasis as PayBasis} />
      </span>
    ),
  });

  if (a.rules.length > 0) {
    rows.push({
      // Label kept short so every row's label column lines up at the same
      // width regardless of how many rate lines a profile carries.
      label: 'Rate breakdown',
      value: (
        <div
          className="flex flex-wrap items-center gap-1.5"
          style={{ width: '100%', minWidth: 0 }}
        >
          {a.rules.map(r => (
            <RateChip
              key={r.name + r.trigger.source}
              rule={r}
              surface="primary"
            />
          ))}
        </div>
      ),
    });
  }

  // Jurisdiction / currency facets pulled from the profile if set
  if (a.profileCurrency && a.profileCurrency !== 'USD') {
    rows.push({ label: 'Currency', value: a.profileCurrency });
  }
  if (a.profileState) {
    rows.push({ label: 'State', value: a.profileState });
  }
  if (a.profileContractTag) {
    rows.push({ label: 'Contract', value: a.profileContractTag });
  }

  return rows;
}

/**
 * describeCondition — human label for the override's selection strategy.
 *
 * Maps our backend's actual selectionStrategy values to short readable
 * conditions. Falls back to the strategy name if no nicer phrasing applies.
 */
function describeCondition(a: Assignment): string | null {
  switch (a.selectionStrategy) {
    case 'JURISDICTION': {
      const parts = [a.matchContractTag, a.matchState].filter(Boolean);
      return parts.length > 0 ? parts.join(' · ') : 'Jurisdiction match';
    }
    case 'DISTANCE_THRESHOLD':
      return a.thresholdValue != null
        ? `After ${a.thresholdValue} mi`
        : 'Distance threshold';
    case 'MANUAL_ONLY':
      return 'Manual select';
    case 'ALWAYS_ACTIVE':
      return 'Always active';
    default:
      return a.selectionStrategy;
  }
}

/**
 * describeRuleNote — derive a short qualifier note from the rule's
 * trigger filter / minThreshold (e.g. "after 50 mi", "after 1st").
 *
 * Returns undefined when no useful note can be derived; the chip will
 * just show name + rate + unit.
 */
function describeRuleNote(rule: RuleForChip): string | undefined {
  if (rule.minThreshold !== undefined && rule.minThreshold > 0) {
    // Mileage triggers → "after N mi"; stop triggers → "after Nth"
    if (rule.trigger.source.includes('Miles') || rule.trigger.source === 'leg.totalMiles') {
      return `after ${rule.minThreshold} mi`;
    }
    if (rule.trigger.source === 'stops.count') {
      const n = rule.minThreshold;
      return `after ${ordinal(n)}`;
    }
    return `after ${rule.minThreshold}`;
  }
  return undefined;
}

function ordinal(n: number): string {
  const s = ['th', 'st', 'nd', 'rd'];
  const v = n % 100;
  return n + (s[(v - 20) % 10] || s[v] || s[0]);
}
