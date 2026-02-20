'use client';

import { Checkbox } from '@/components/ui/checkbox';
import { Badge } from '@/components/ui/badge';
import { Card } from '@/components/ui/card';
import { PlusCircle, RefreshCw, RotateCcw, MinusCircle } from 'lucide-react';
import type { DedupResult, DedupCategory } from './schedule-import-types';

interface ScheduleDedupReviewProps {
  results: DedupResult[];
  onResultsChange: (results: DedupResult[]) => void;
}

const CATEGORY_META: Record<
  DedupCategory,
  { label: string; color: string; icon: React.ReactNode; description: string }
> = {
  new: {
    label: 'New',
    color: 'bg-green-100 text-green-800 dark:bg-green-900/40 dark:text-green-300',
    icon: <PlusCircle className="h-4 w-4" />,
    description: 'Will be created as a new contract lane.',
  },
  update: {
    label: 'Update',
    color: 'bg-blue-100 text-blue-800 dark:bg-blue-900/40 dark:text-blue-300',
    icon: <RefreshCw className="h-4 w-4" />,
    description: 'Existing lane found with different values. Will update.',
  },
  restore: {
    label: 'Restore',
    color: 'bg-amber-100 text-amber-800 dark:bg-amber-900/40 dark:text-amber-300',
    icon: <RotateCcw className="h-4 w-4" />,
    description: 'A previously deleted lane matches. Will restore and update.',
  },
  unchanged: {
    label: 'Unchanged',
    color: 'bg-gray-100 text-gray-600 dark:bg-gray-800/40 dark:text-gray-400',
    icon: <MinusCircle className="h-4 w-4" />,
    description: 'Identical to existing lane. Will be skipped.',
  },
};

function DiffField({
  label,
  oldVal,
  newVal,
}: {
  label: string;
  oldVal: unknown;
  newVal: unknown;
}) {
  if (oldVal === newVal || newVal === undefined || newVal === null) return null;
  return (
    <div className="flex items-baseline gap-2 text-xs">
      <span className="text-muted-foreground w-24 shrink-0">{label}:</span>
      <span className="line-through text-red-500/70">{String(oldVal ?? '—')}</span>
      <span className="text-green-600 font-medium">{String(newVal)}</span>
    </div>
  );
}

export function ScheduleDedupReview({
  results,
  onResultsChange,
}: ScheduleDedupReviewProps) {
  const toggleResult = (idx: number) => {
    const updated = [...results];
    updated[idx] = { ...updated[idx], selected: !updated[idx].selected };
    onResultsChange(updated);
  };

  const categories: DedupCategory[] = ['new', 'update', 'restore', 'unchanged'];

  const counts = categories.reduce(
    (acc, cat) => {
      acc[cat] = results.filter((r) => r.category === cat).length;
      return acc;
    },
    {} as Record<DedupCategory, number>,
  );

  const selectedCount = results.filter((r) => r.selected).length;

  return (
    <div className="max-w-3xl mx-auto space-y-6">
      <div>
        <h2 className="text-xl font-semibold mb-1">Review Import</h2>
        <p className="text-sm text-muted-foreground">
          {selectedCount} of {results.length} lane(s) selected for import.
        </p>
      </div>

      {/* Summary badges */}
      <div className="flex gap-3 flex-wrap">
        {categories.map((cat) =>
          counts[cat] > 0 ? (
            <Badge key={cat} variant="outline" className={`${CATEGORY_META[cat].color} gap-1.5`}>
              {CATEGORY_META[cat].icon}
              {counts[cat]} {CATEGORY_META[cat].label}
            </Badge>
          ) : null,
        )}
      </div>

      {/* Grouped results */}
      {categories.map((cat) => {
        const catResults = results
          .map((r, originalIdx) => ({ ...r, originalIdx }))
          .filter((r) => r.category === cat);

        if (catResults.length === 0) return null;
        const meta = CATEGORY_META[cat];

        return (
          <div key={cat}>
            <h3 className="text-sm font-semibold mb-2 flex items-center gap-2">
              <span className={meta.color + ' px-2 py-0.5 rounded-md flex items-center gap-1'}>
                {meta.icon}
                {meta.label} ({catResults.length})
              </span>
              <span className="text-muted-foreground font-normal text-xs">
                {meta.description}
              </span>
            </h3>

            <div className="space-y-2">
              {catResults.map((r) => {
                const lane = r.lane;
                const hcr = lane.hcr?.value || '—';
                const trip = lane.tripNumber?.value || '—';
                const name = lane.contractName?.value || '';
                const rate = lane.rate?.value;
                const rateType = lane.rateType?.value;

                return (
                  <Card
                    key={r.originalIdx}
                    className={`p-3 flex items-start gap-3 ${
                      !r.selected ? 'opacity-50' : ''
                    }`}
                  >
                    <Checkbox
                      checked={r.selected}
                      onCheckedChange={() => toggleResult(r.originalIdx)}
                      className="mt-0.5"
                    />
                    <div className="flex-1 min-w-0">
                      <div className="flex items-baseline gap-2">
                        <span className="font-mono text-sm font-medium">
                          {hcr}/{trip}
                        </span>
                        {name && (
                          <span className="text-xs text-muted-foreground truncate">
                            {name}
                          </span>
                        )}
                      </div>

                      {rate != null && (
                        <div className="text-xs text-muted-foreground mt-0.5">
                          {rateType} — ${Number(rate).toFixed(2)}
                        </div>
                      )}

                      {/* Diff for updates */}
                      {(r.category === 'update' || r.category === 'restore') &&
                        r.existingData && (
                          <div className="mt-2 space-y-0.5 border-t pt-2">
                            <DiffField
                              label="Rate"
                              oldVal={r.existingData.rate}
                              newVal={lane.rate?.value}
                            />
                            <DiffField
                              label="Rate Type"
                              oldVal={r.existingData.rateType}
                              newVal={lane.rateType?.value}
                            />
                            <DiffField
                              label="Start Date"
                              oldVal={r.existingData.contractPeriodStart}
                              newVal={lane.contractPeriodStart?.value}
                            />
                            <DiffField
                              label="End Date"
                              oldVal={r.existingData.contractPeriodEnd}
                              newVal={lane.contractPeriodEnd?.value}
                            />
                            <DiffField
                              label="Contract Mi"
                              oldVal={r.existingData.miles}
                              newVal={lane.miles?.value}
                            />
                          </div>
                        )}
                    </div>
                  </Card>
                );
              })}
            </div>
          </div>
        );
      })}

      {results.length === 0 && (
        <div className="text-center text-muted-foreground py-12">
          No lanes to review. Go back and select lanes to import.
        </div>
      )}
    </div>
  );
}
