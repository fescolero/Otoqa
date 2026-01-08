'use client';

interface CustomerListHeaderProps {
  isAllSelected: boolean;
  isSomeSelected: boolean;
  onSelectAll: (checked: boolean) => void;
}

export function CustomerListHeader({ isAllSelected, isSomeSelected, onSelectAll }: CustomerListHeaderProps) {
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
          title="Select all customers"
        />
      </div>

      {/* Column 1: Customer Name (Flex) */}
      <div className="flex items-center gap-3 flex-1 min-w-0">
        <div className="w-12"></div>
        <div>Customer</div>
      </div>

      {/* Column 2: Company Type (150px) */}
      <div className="hidden md:block w-[150px] flex-shrink-0">Type</div>

      {/* Column 3: City, State (200px) */}
      <div className="hidden lg:block w-[200px] flex-shrink-0">Location</div>

      {/* Column 4: Primary Contact (220px) */}
      <div className="hidden xl:block w-[220px] flex-shrink-0">Primary Contact</div>

      {/* Column 5: Actions (180px) */}
      <div className="w-[180px] flex-shrink-0 text-right">Actions</div>
    </div>
  );
}
