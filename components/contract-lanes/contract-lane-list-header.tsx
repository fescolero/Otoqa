import { Checkbox } from '@/components/ui/checkbox';

interface ContractLaneListHeaderProps {
  showCheckbox?: boolean;
  allSelected?: boolean;
  onSelectAll?: () => void;
}

export function ContractLaneListHeader({ 
  showCheckbox = false, 
  allSelected = false, 
  onSelectAll 
}: ContractLaneListHeaderProps) {
  return (
    <div className="flex items-center gap-4 p-4 border rounded-lg bg-muted/50 font-medium text-sm min-w-[1000px]">
      {/* Checkbox Column */}
      <div className="w-10 flex-shrink-0">
        {showCheckbox && onSelectAll && (
          <Checkbox checked={allSelected} onCheckedChange={onSelectAll} />
        )}
      </div>

      {/* Column 1: HCR */}
      <div className="flex-1 min-w-[150px]">HCR</div>

      {/* Column 2: Trip Number */}
      <div className="w-[150px] flex-shrink-0">Trip Number</div>

      {/* Column 3: Rate Period */}
      <div className="w-[220px] flex-shrink-0">Rate Period</div>

      {/* Column 4: Status */}
      <div className="w-[120px] flex-shrink-0">Status</div>

      {/* Column 5: Actions */}
      <div className="w-[180px] flex-shrink-0 text-right">Actions</div>
    </div>
  );
}
