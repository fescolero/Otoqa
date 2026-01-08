'use client';

import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Doc } from '@/convex/_generated/dataModel';
import { Pencil, Eye, Trash2 } from 'lucide-react';
import { useRouter } from 'next/navigation';

type ContractLane = Doc<'contractLanes'>;

interface ContractLaneListItemProps {
  lane: ContractLane;
  customerId: string;
  isSelected: boolean;
  onSelectionChange: (id: string, selected: boolean) => void;
  onDelete?: (id: string) => void;
}

export function ContractLaneListItem({
  lane,
  customerId,
  isSelected,
  onSelectionChange,
  onDelete,
}: ContractLaneListItemProps) {
  const router = useRouter();

  const formatDateRange = (start: string, end: string) => {
    return `${start} - ${end}`;
  };

  const isActive = lane.isActive ?? true;

  return (
    <div
      className={`group relative flex items-center gap-4 p-4 border rounded-lg hover:bg-accent/50 transition-colors cursor-pointer min-w-[1000px] ${
        isSelected ? 'bg-blue-50 dark:bg-blue-950/20 border-blue-300 dark:border-blue-800' : ''
      }`}
      onClick={() => router.push(`/operations/customers/${customerId}/contract-lanes/${lane._id}`)}
    >
      {/* Checkbox Column */}
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

      {/* Column 1: HCR */}
      <div className="flex-1 min-w-[150px]">
        <p className="font-semibold text-base truncate">{lane.hcr || 'N/A'}</p>
        <p className="text-sm text-muted-foreground truncate">{lane.contractName}</p>
      </div>

      {/* Column 2: Trip Number */}
      <div className="w-[150px] flex-shrink-0">
        <p className="text-sm font-medium">{lane.tripNumber || 'N/A'}</p>
      </div>

      {/* Column 3: Rate Period */}
      <div className="w-[220px] flex-shrink-0">
        <p className="text-sm">{formatDateRange(lane.contractPeriodStart, lane.contractPeriodEnd)}</p>
      </div>

      {/* Column 4: Status */}
      <div className="w-[120px] flex-shrink-0">
        <Badge
          className={
            isActive
              ? 'bg-green-100 text-green-800 dark:bg-green-900 dark:text-green-200'
              : 'bg-gray-100 text-gray-800 dark:bg-gray-800 dark:text-gray-200'
          }
        >
          {isActive ? 'Active' : 'Inactive'}
        </Badge>
      </div>

      {/* Column 5: Actions */}
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
