'use client';

import * as React from 'react';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import { Doc } from '@/convex/_generated/dataModel';
import { Pencil, Eye, Trash2, ShieldCheck, Copy, Check } from 'lucide-react';
import { useRouter } from 'next/navigation';
import { format, parseISO } from 'date-fns';

type ContractLane = Doc<'contractLanes'>;

interface ContractLaneListItemProps {
  lane: ContractLane;
  customerId: string;
  isSelected: boolean;
  onSelectionChange: (id: string, selected: boolean) => void;
  onDelete?: (id: string) => void;
}

function formatDate(dateStr: string): string {
  try {
    return format(parseISO(dateStr), 'MMM dd, yyyy');
  } catch {
    return dateStr;
  }
}

export function ContractLaneListItem({
  lane,
  customerId,
  isSelected,
  onSelectionChange,
  onDelete,
}: ContractLaneListItemProps) {
  const router = useRouter();
  const [copied, setCopied] = React.useState(false);

  const isActive = lane.isActive ?? true;
  const hasImportMatch = !!lane.lastImportMatchAt;
  const matchDate = lane.lastImportMatchAt
    ? format(new Date(lane.lastImportMatchAt), 'MMM dd, yyyy h:mm a')
    : null;

  const handleCopyMatchDate = (e: React.MouseEvent) => {
    e.stopPropagation();
    if (!matchDate) return;
    navigator.clipboard.writeText(matchDate).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    });
  };

  return (
    <div
      className={`group relative flex items-center gap-4 py-2.5 px-4 border-b last:border-b-0 hover:bg-accent/50 transition-colors cursor-pointer min-w-[1000px] ${
        isSelected ? 'bg-blue-50 dark:bg-blue-950/20' : ''
      }`}
      onClick={() => router.push(`/operations/customers/${customerId}/contract-lanes/${lane._id}`)}
    >
      {/* Checkbox */}
      <div className="flex items-center w-10 flex-shrink-0">
        <input
          type="checkbox"
          checked={isSelected}
          onChange={(e) => {
            e.stopPropagation();
            onSelectionChange(lane._id, e.target.checked);
          }}
          onClick={(e) => e.stopPropagation()}
          className="h-4 w-4 rounded border-gray-300 text-blue-600 focus:ring-blue-500 cursor-pointer hover:border-gray-400 transition-colors"
        />
      </div>

      {/* HCR + Verified Badge */}
      <div className="flex-1 min-w-[150px]">
        <div className="flex items-center gap-1.5">
          <p className="font-semibold text-base truncate">{lane.hcr || 'N/A'}</p>
          {hasImportMatch && (
            <Tooltip>
              <TooltipTrigger asChild>
                <button
                  type="button"
                  onClick={handleCopyMatchDate}
                  className="inline-flex items-center text-emerald-600 dark:text-emerald-400 hover:text-emerald-700 dark:hover:text-emerald-300 transition-colors"
                >
                  <ShieldCheck className="h-4 w-4" />
                </button>
              </TooltipTrigger>
              <TooltipContent side="top" className="flex items-center gap-2">
                <span>Verified &mdash; {matchDate}</span>
                {copied ? (
                  <Check className="h-3 w-3 text-emerald-400" />
                ) : (
                  <Copy className="h-3 w-3 opacity-60" />
                )}
              </TooltipContent>
            </Tooltip>
          )}
        </div>
        <p className="text-sm text-muted-foreground truncate">{lane.contractName}</p>
      </div>

      {/* Trip Number (with wildcard tooltip) */}
      <div className="w-[150px] flex-shrink-0">
        {lane.tripNumber === '*' ? (
          <Tooltip>
            <TooltipTrigger asChild>
              <span className="inline-flex items-center text-sm font-medium bg-muted px-2 py-0.5 rounded">
                *
              </span>
            </TooltipTrigger>
            <TooltipContent side="top">
              Wildcard &mdash; matches any trip number for this HCR
            </TooltipContent>
          </Tooltip>
        ) : (
          <p className="text-sm font-medium">{lane.tripNumber || 'N/A'}</p>
        )}
      </div>

      {/* Rate Period */}
      <div className="w-[220px] flex-shrink-0">
        <p className="text-sm">
          {formatDate(lane.contractPeriodStart)} &ndash; {formatDate(lane.contractPeriodEnd)}
        </p>
      </div>

      {/* Status */}
      <div className="w-[120px] flex-shrink-0">
        <Badge
          className={
            isActive
              ? 'bg-emerald-100 text-emerald-800 dark:bg-emerald-900/50 dark:text-emerald-300'
              : 'bg-gray-100 text-gray-800 dark:bg-gray-800 dark:text-gray-200'
          }
        >
          {isActive ? 'Active' : 'Inactive'}
        </Badge>
      </div>

      {/* Actions */}
      <div className="flex items-center gap-1 w-[180px] flex-shrink-0 justify-end">
        <Button
          variant="ghost"
          size="sm"
          onClick={(e) => {
            e.stopPropagation();
            router.push(`/operations/customers/${customerId}/contract-lanes/${lane._id}`);
          }}
          className="h-8 opacity-0 group-hover:opacity-100 transition-opacity"
        >
          <Eye className="h-4 w-4" />
        </Button>
        <Button
          variant="ghost"
          size="sm"
          onClick={(e) => {
            e.stopPropagation();
            router.push(`/operations/customers/${customerId}/contract-lanes/${lane._id}/edit`);
          }}
          className="h-8 opacity-0 group-hover:opacity-100 transition-opacity"
        >
          <Pencil className="h-4 w-4" />
        </Button>
        {onDelete && (
          <Button
            variant="ghost"
            size="sm"
            onClick={(e) => {
              e.stopPropagation();
              if (confirm('Are you sure you want to delete this contract lane?')) {
                onDelete(lane._id);
              }
            }}
            className="h-8 opacity-0 group-hover:opacity-100 transition-opacity text-destructive hover:text-destructive"
          >
            <Trash2 className="h-4 w-4" />
          </Button>
        )}
      </div>
    </div>
  );
}
