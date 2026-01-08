'use client';

interface DriverListHeaderProps {
  isAllSelected: boolean;
  isSomeSelected: boolean;
  onSelectAll: (checked: boolean) => void;
}

export function DriverListHeader({ isAllSelected, isSomeSelected, onSelectAll }: DriverListHeaderProps) {
  return (
    <div className="flex items-center gap-4 px-4 py-2 text-xs font-medium text-muted-foreground uppercase tracking-wider">
      {/* Checkbox Column - 40px to match card checkbox */}
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
          title="Select all drivers"
        />
      </div>

      {/* Column 1: Driver Name (Flex) - Aligned with avatar + name structure */}
      <div className="flex items-center gap-3 flex-1 min-w-0">
        {/* Spacer for avatar alignment (48px avatar + gap) */}
        <div className="w-12"></div>
        <div>Driver</div>
      </div>

      {/* Column 2: Contact (220px - matches card) */}
      <div className="hidden md:block w-[220px] flex-shrink-0">Contact</div>

      {/* Column 3: License (180px - matches card) */}
      <div className="hidden lg:block w-[180px] flex-shrink-0">License</div>

      {/* Column 4: Medical (150px - matches card) */}
      <div className="hidden xl:block w-[150px] flex-shrink-0">Medical</div>

      {/* Column 5: Actions (180px - matches card) */}
      <div className="w-[180px] flex-shrink-0 text-right">Actions</div>
    </div>
  );
}
