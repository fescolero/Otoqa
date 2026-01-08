'use client';

import { Checkbox } from '@/components/ui/checkbox';

interface TruckListHeaderProps {
  isAllSelected: boolean;
  isSomeSelected: boolean;
  onSelectAll: (checked: boolean) => void;
}

export function TruckListHeader({ isAllSelected, isSomeSelected, onSelectAll }: TruckListHeaderProps) {
  return (
    <div className="group relative flex items-center gap-2 sm:gap-3 px-2 sm:px-4 py-3 border-b bg-muted/50">
      {/* Checkbox Column - Fixed */}
      <div className="flex items-center w-6 sm:w-8 flex-shrink-0">
        <Checkbox
          checked={isAllSelected}
          onCheckedChange={onSelectAll}
          aria-label="Select all trucks"
          className={`h-4 w-4 ${isSomeSelected && !isAllSelected ? 'data-[state=checked]:bg-blue-600' : ''}`}
        />
      </div>

      {/* Unit ID Column - Fixed */}
      <div className="w-16 sm:w-20 md:w-24 flex-shrink-0">
        <p className="text-xs font-medium text-muted-foreground uppercase tracking-wide">Unit ID</p>
      </div>

      {/* Status Column - Fixed */}
      <div className="w-20 sm:w-24 md:w-28 flex-shrink-0">
        <p className="text-xs font-medium text-muted-foreground uppercase tracking-wide">Status</p>
      </div>

      {/* Vehicle Column - Flexible (grows) */}
      <div className="flex-1 min-w-[120px] sm:min-w-[150px] md:min-w-[200px]">
        <p className="text-xs font-medium text-muted-foreground uppercase tracking-wide">Vehicle</p>
      </div>

      {/* Plate/VIN Column - Hidden on small screens */}
      <div className="hidden xl:flex w-40 2xl:w-44 flex-shrink-0">
        <p className="text-xs font-medium text-muted-foreground uppercase tracking-wide">Plate / VIN</p>
      </div>

      {/* Compliance Column - Responsive width */}
      <div className="w-28 sm:w-32 md:w-40 lg:w-48 flex-shrink-0">
        <p className="text-xs font-medium text-muted-foreground uppercase tracking-wide">Compliance</p>
      </div>

      {/* GVWR Column - Hidden on smaller screens */}
      <div className="hidden lg:flex w-20 xl:w-24 flex-shrink-0">
        <p className="text-xs font-medium text-muted-foreground uppercase tracking-wide">GVWR</p>
      </div>

      {/* Actions Column - Fixed */}
      <div className="w-8 sm:w-10 flex-shrink-0">
        <p className="text-xs font-medium text-muted-foreground uppercase tracking-wide text-right">Actions</p>
      </div>
    </div>
  );
}
