'use client';

import { Checkbox } from '@/components/ui/checkbox';

interface TrailerListHeaderProps {
  isAllSelected: boolean;
  isSomeSelected: boolean;
  onSelectAll: (checked: boolean) => void;
}

export function TrailerListHeader({ isAllSelected, isSomeSelected, onSelectAll }: TrailerListHeaderProps) {
  return (
    <div className="group relative flex items-center gap-1.5 sm:gap-2 md:gap-3 px-2 sm:px-4 py-3 pr-3 sm:pr-5 border-b bg-muted/50">
      {/* Checkbox Column - Fixed */}
      <div className="flex items-center w-6 sm:w-8 flex-shrink-0">
        <Checkbox
          checked={isAllSelected}
          onCheckedChange={onSelectAll}
          aria-label="Select all trailers"
          className={`h-4 w-4 ${isSomeSelected && !isAllSelected ? 'data-[state=checked]:bg-blue-600' : ''}`}
        />
      </div>

      {/* Unit ID Column - Flexible */}
      <div className="w-14 sm:w-16 md:w-20 flex-shrink-0">
        <p className="text-xs font-medium text-muted-foreground uppercase tracking-wide">Unit ID</p>
      </div>

      {/* Status Column - Flexible */}
      <div className="w-16 sm:w-20 md:w-24 flex-shrink-0">
        <p className="text-xs font-medium text-muted-foreground uppercase tracking-wide">Status</p>
      </div>

      {/* Vehicle Column - Flexible (grows) */}
      <div className="flex-1 min-w-0">
        <p className="text-xs font-medium text-muted-foreground uppercase tracking-wide">Trailer</p>
      </div>

      {/* Plate/VIN Column - Hidden on small screens */}
      <div className="hidden xl:flex w-32 2xl:w-36 flex-shrink-0">
        <p className="text-xs font-medium text-muted-foreground uppercase tracking-wide">Plate / VIN</p>
      </div>

      {/* Compliance Column - Flexible */}
      <div className="w-20 sm:w-24 md:w-28 lg:w-32 flex-shrink-0">
        <p className="text-xs font-medium text-muted-foreground uppercase tracking-wide">Compliance</p>
      </div>

      {/* GVWR Column - Hidden on smaller screens */}
      <div className="hidden lg:flex w-16 xl:w-20 flex-shrink-0">
        <p className="text-xs font-medium text-muted-foreground uppercase tracking-wide">GVWR</p>
      </div>

      {/* Actions Column - Fixed */}
      <div className="w-8 sm:w-10 flex-shrink-0">
        <p className="text-xs font-medium text-muted-foreground uppercase tracking-wide text-right pr-2">Actions</p>
      </div>
    </div>
  );
}
