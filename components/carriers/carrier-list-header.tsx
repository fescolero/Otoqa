'use client';

interface CarrierListHeaderProps {
  isAllSelected: boolean;
  isSomeSelected: boolean;
  onSelectAll: (checked: boolean) => void;
}

export function CarrierListHeader({ isAllSelected, isSomeSelected, onSelectAll }: CarrierListHeaderProps) {
  return (
    <div className="flex items-center gap-4 px-4 py-2 text-xs font-medium text-muted-foreground uppercase tracking-wider">
      {/* Checkbox Column */}
      <div className="flex items-center w-10 flex-shrink-0">
        <input
          type="checkbox"
          checked={isAllSelected}
          ref={(input) => {
            if (input) {
              input.indeterminate = isSomeSelected && !isAllSelected;
            }
          }}
          onChange={(e) => onSelectAll(e.target.checked)}
          className="h-4 w-4 rounded border-gray-300 text-blue-600 focus:ring-blue-500 cursor-pointer"
          title="Select all carriers"
        />
      </div>

      {/* Column 1: Company Name (Flex) */}
      <div className="flex items-center gap-3 flex-1 min-w-0">
        <div className="w-12"></div>
        <div>Company</div>
      </div>

      {/* Column 2: MC# / DOT# (180px) */}
      <div className="hidden md:block w-[180px] flex-shrink-0">Authority</div>

      {/* Column 3: Safety Rating (150px) */}
      <div className="hidden lg:block w-[150px] flex-shrink-0">Safety Rating</div>

      {/* Column 4: Insurance (180px) */}
      <div className="hidden xl:block w-[180px] flex-shrink-0">Insurance</div>

      {/* Column 5: Actions (180px) */}
      <div className="w-[180px] flex-shrink-0 text-right">Actions</div>
    </div>
  );
}
