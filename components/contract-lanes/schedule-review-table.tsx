'use client';

import { useState, useCallback } from 'react';
import { Input } from '@/components/ui/input';
import { Button } from '@/components/ui/button';
import { Checkbox } from '@/components/ui/checkbox';
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '@/components/ui/tooltip';
import { Trash2, CheckCircle2, AlertTriangle, XCircle, MapPin } from 'lucide-react';
import type { ExtractionConfig, ExtractedLane, Confidence } from './schedule-import-types';

interface ScheduleReviewTableProps {
  lanes: ExtractedLane[];
  config: ExtractionConfig;
  onLanesChange: (lanes: ExtractedLane[]) => void;
}

function confidenceClass(c: Confidence): string {
  switch (c) {
    case 'high':
      return 'bg-green-50 dark:bg-green-950/30';
    case 'medium':
      return 'bg-amber-50 dark:bg-amber-950/30';
    case 'low':
      return 'bg-red-50 dark:bg-red-950/30';
  }
}

function VerificationIcon({ status }: { status?: string }) {
  if (!status || status === 'pending') return <MapPin className="h-3.5 w-3.5 text-muted-foreground" />;
  if (status === 'verified') return <CheckCircle2 className="h-3.5 w-3.5 text-green-600" />;
  if (status === 'mismatch') return <AlertTriangle className="h-3.5 w-3.5 text-amber-600" />;
  return <XCircle className="h-3.5 w-3.5 text-red-600" />;
}

type ColumnDef = {
  key: string;
  label: string;
  width: string;
  getValue: (lane: ExtractedLane) => { value: unknown; confidence: Confidence } | undefined;
  format?: (val: unknown) => string;
};

function buildColumns(config: ExtractionConfig): ColumnDef[] {
  const cols: ColumnDef[] = [
    {
      key: 'hcr',
      label: 'HCR',
      width: 'w-24',
      getValue: (l) => l.hcr,
    },
    {
      key: 'tripNumber',
      label: 'Trip #',
      width: 'w-20',
      getValue: (l) => l.tripNumber,
    },
    {
      key: 'contractName',
      label: 'Contract Name',
      width: 'w-40',
      getValue: (l) => l.contractName,
    },
  ];

  if (config.extractDates) {
    cols.push(
      {
        key: 'contractPeriodStart',
        label: 'Start Date',
        width: 'w-28',
        getValue: (l) => l.contractPeriodStart,
      },
      {
        key: 'contractPeriodEnd',
        label: 'End Date',
        width: 'w-28',
        getValue: (l) => l.contractPeriodEnd,
      },
    );
  }

  if (config.includeFinancial) {
    cols.push(
      {
        key: 'rateType',
        label: 'Rate Type',
        width: 'w-24',
        getValue: (l) => l.rateType,
      },
      {
        key: 'rate',
        label: 'Rate',
        width: 'w-20',
        getValue: (l) => l.rate,
        format: (v) => (v != null ? `$${Number(v).toFixed(2)}` : ''),
      },
      {
        key: 'currency',
        label: 'Currency',
        width: 'w-20',
        getValue: (l) => l.currency,
      },
    );
  }

  if (config.includeFuelSurcharge) {
    cols.push(
      {
        key: 'fuelSurchargeType',
        label: 'FSC Type',
        width: 'w-24',
        getValue: (l) => l.fuelSurchargeType,
      },
      {
        key: 'fuelSurchargeValue',
        label: 'FSC Value',
        width: 'w-20',
        getValue: (l) => l.fuelSurchargeValue,
      },
    );
  }

  if (config.includeLogistics && config.stopDetailLevel !== 'none') {
    cols.push(
      {
        key: '_origin',
        label: 'Origin',
        width: 'w-32',
        getValue: (l) => {
          const first = l.stops?.[0];
          if (!first) return undefined;
          return {
            value: [first.city?.value, first.state?.value].filter(Boolean).join(', ') || null,
            confidence: first.city?.confidence || 'low',
          };
        },
      },
      {
        key: '_destination',
        label: 'Destination',
        width: 'w-32',
        getValue: (l) => {
          const last = l.stops && l.stops.length > 1 ? l.stops[l.stops.length - 1] : undefined;
          if (!last) return undefined;
          return {
            value: [last.city?.value, last.state?.value].filter(Boolean).join(', ') || null,
            confidence: last.city?.confidence || 'low',
          };
        },
      },
      {
        key: 'miles',
        label: 'Contract Mi',
        width: 'w-24',
        getValue: (l) => l.miles,
      },
      {
        key: '_calculatedMiles',
        label: 'Calc Mi',
        width: 'w-24',
        getValue: (l) =>
          l._calculatedMiles != null
            ? { value: l._calculatedMiles, confidence: 'high' as Confidence }
            : undefined,
      },
    );
  }

  if (config.includeEquipment) {
    cols.push(
      {
        key: 'equipmentClass',
        label: 'Equipment',
        width: 'w-28',
        getValue: (l) => l.equipmentClass,
      },
      {
        key: 'equipmentSize',
        label: 'Size',
        width: 'w-20',
        getValue: (l) => l.equipmentSize,
      },
    );
  }

  return cols;
}

export function ScheduleReviewTable({
  lanes,
  config,
  onLanesChange,
}: ScheduleReviewTableProps) {
  const [editingCell, setEditingCell] = useState<{
    row: number;
    col: string;
  } | null>(null);
  const [editValue, setEditValue] = useState('');

  const columns = buildColumns(config);

  const handleToggleRow = (idx: number) => {
    const updated = [...lanes];
    updated[idx] = { ...updated[idx], _selected: !(updated[idx]._selected ?? true) };
    onLanesChange(updated);
  };

  const handleToggleAll = () => {
    const allSelected = lanes.every((l) => l._selected !== false);
    onLanesChange(lanes.map((l) => ({ ...l, _selected: !allSelected })));
  };

  const handleDeleteRow = (idx: number) => {
    onLanesChange(lanes.filter((_, i) => i !== idx));
  };

  const handleAcceptAllSuggestions = () => {
    const updated = lanes.map((lane) => {
      if (!lane.stops) return lane;
      const newStops = lane.stops.map((stop) => {
        const v = stop._verification;
        if (v?.status === 'mismatch' && v.suggestedCorrection) {
          return {
            ...stop,
            address: { value: v.suggestedCorrection.address, confidence: 'high' as Confidence },
            city: { value: v.suggestedCorrection.city, confidence: 'high' as Confidence },
            state: { value: v.suggestedCorrection.state, confidence: 'high' as Confidence },
            zip: { value: v.suggestedCorrection.zip, confidence: 'high' as Confidence },
            _verification: { status: 'verified' as const, suggestedCorrection: null },
          };
        }
        return stop;
      });
      return { ...lane, stops: newStops };
    });
    onLanesChange(updated);
  };

  const startEdit = (row: number, col: string, currentValue: unknown) => {
    setEditingCell({ row, col });
    setEditValue(currentValue != null ? String(currentValue) : '');
  };

  const commitEdit = useCallback(() => {
    if (!editingCell) return;
    const { row, col } = editingCell;
    const updated = [...lanes];
    const lane = { ...updated[row] };

    if (col.startsWith('_')) {
      setEditingCell(null);
      return;
    }

    const field = lane[col as keyof ExtractedLane] as
      | { value: unknown; confidence: Confidence }
      | undefined;

    if (field && typeof field === 'object' && 'value' in field) {
      const isNum = typeof field.value === 'number' || col === 'rate' || col === 'miles' || col === 'fuelSurchargeValue';
      (lane as Record<string, unknown>)[col] = {
        value: isNum ? (editValue ? parseFloat(editValue) : null) : (editValue || null),
        confidence: 'high' as Confidence,
      };
    }

    updated[row] = lane;
    onLanesChange(updated);
    setEditingCell(null);
  }, [editingCell, editValue, lanes, onLanesChange]);

  const hasSuggestions = lanes.some(
    (l) => l.stops?.some((s) => s._verification?.status === 'mismatch'),
  );

  const selectedCount = lanes.filter((l) => l._selected !== false).length;

  return (
    <div className="flex flex-col h-full">
      {/* Toolbar */}
      <div className="flex items-center justify-between px-4 py-2 border-b bg-muted/30 shrink-0">
        <span className="text-sm text-muted-foreground">
          {selectedCount} of {lanes.length} lane(s) selected
        </span>
        <div className="flex gap-2">
          {hasSuggestions && (
            <Button size="sm" variant="outline" onClick={handleAcceptAllSuggestions}>
              <CheckCircle2 className="h-3.5 w-3.5 mr-1.5" />
              Accept All Google Suggestions
            </Button>
          )}
        </div>
      </div>

      {/* Table */}
      <div className="flex-1 overflow-auto">
        <table className="w-full text-sm">
          <thead className="sticky top-0 bg-background border-b z-10">
            <tr>
              <th className="p-2 w-10">
                <Checkbox
                  checked={lanes.length > 0 && lanes.every((l) => l._selected !== false)}
                  onCheckedChange={handleToggleAll}
                />
              </th>
              {config.includeLogistics && config.stopDetailLevel !== 'none' && (
                <th className="p-2 w-8 text-center">
                  <TooltipProvider>
                    <Tooltip>
                      <TooltipTrigger>
                        <MapPin className="h-3.5 w-3.5 text-muted-foreground" />
                      </TooltipTrigger>
                      <TooltipContent>Address Verification</TooltipContent>
                    </Tooltip>
                  </TooltipProvider>
                </th>
              )}
              {columns.map((col) => (
                <th
                  key={col.key}
                  className={`p-2 text-left font-medium text-muted-foreground ${col.width}`}
                >
                  {col.label}
                </th>
              ))}
              <th className="p-2 w-10" />
            </tr>
          </thead>
          <tbody>
            {lanes.map((lane, rowIdx) => {
              const isSelected = lane._selected !== false;
              const originStop = lane.stops?.[0];

              return (
                <tr
                  key={rowIdx}
                  className={`border-b hover:bg-muted/20 ${!isSelected ? 'opacity-50' : ''}`}
                >
                  <td className="p-2">
                    <Checkbox
                      checked={isSelected}
                      onCheckedChange={() => handleToggleRow(rowIdx)}
                    />
                  </td>
                  {config.includeLogistics && config.stopDetailLevel !== 'none' && (
                    <td className="p-2 text-center">
                      <TooltipProvider>
                        <Tooltip>
                          <TooltipTrigger>
                            <VerificationIcon status={originStop?._verification?.status} />
                          </TooltipTrigger>
                          <TooltipContent>
                            {originStop?._verification?.status === 'verified' && 'Address verified by Google'}
                            {originStop?._verification?.status === 'mismatch' && (
                              <div>
                                <p>Google suggests:</p>
                                <p className="font-mono text-xs">
                                  {originStop._verification.suggestedCorrection?.city},{' '}
                                  {originStop._verification.suggestedCorrection?.state}{' '}
                                  {originStop._verification.suggestedCorrection?.zip}
                                </p>
                              </div>
                            )}
                            {originStop?._verification?.status === 'not_found' && 'Address not found by Google'}
                            {(!originStop?._verification || originStop._verification.status === 'pending') && 'Not yet verified'}
                          </TooltipContent>
                        </Tooltip>
                      </TooltipProvider>
                    </td>
                  )}
                  {columns.map((col) => {
                    const field = col.getValue(lane);
                    const value = field?.value;
                    const confidence = field?.confidence || 'low';
                    const isEditing =
                      editingCell?.row === rowIdx && editingCell?.col === col.key;
                    const displayValue =
                      col.format && value != null ? col.format(value) : (value != null ? String(value) : '');

                    const milesDiscrepancy =
                      col.key === '_calculatedMiles' &&
                      lane.miles?.value != null &&
                      lane._calculatedMiles != null &&
                      Math.abs(
                        ((lane._calculatedMiles - (lane.miles.value as number)) /
                          (lane.miles.value as number)) *
                          100,
                      ) > 10;

                    return (
                      <td
                        key={col.key}
                        className={`p-0 ${col.width} ${
                          field ? confidenceClass(confidence) : ''
                        } ${milesDiscrepancy ? '!bg-amber-100 dark:!bg-amber-950/50' : ''}`}
                        onClick={() => {
                          if (!col.key.startsWith('_')) {
                            startEdit(rowIdx, col.key, value);
                          }
                        }}
                      >
                        {isEditing ? (
                          <Input
                            autoFocus
                            value={editValue}
                            onChange={(e) => setEditValue(e.target.value)}
                            onBlur={commitEdit}
                            onKeyDown={(e) => {
                              if (e.key === 'Enter') commitEdit();
                              if (e.key === 'Escape') setEditingCell(null);
                            }}
                            className="h-8 rounded-none border-0 border-primary ring-1 ring-primary text-sm"
                          />
                        ) : (
                          <div className="px-2 py-1.5 truncate cursor-text min-h-[32px]">
                            {displayValue || (
                              <span className="text-muted-foreground/50 italic">
                                empty
                              </span>
                            )}
                          </div>
                        )}
                      </td>
                    );
                  })}
                  <td className="p-1">
                    <Button
                      variant="ghost"
                      size="icon"
                      className="h-7 w-7"
                      onClick={() => handleDeleteRow(rowIdx)}
                    >
                      <Trash2 className="h-3.5 w-3.5 text-muted-foreground" />
                    </Button>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
        {lanes.length === 0 && (
          <div className="flex items-center justify-center h-40 text-muted-foreground">
            No lanes extracted
          </div>
        )}
      </div>
    </div>
  );
}
