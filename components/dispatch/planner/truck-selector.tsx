'use client';

import { useState } from 'react';
import { useQuery, useMutation } from 'convex/react';
import { api } from '@/convex/_generated/api';
import { Id } from '@/convex/_generated/dataModel';
import { toast } from 'sonner';
import { Check, ChevronsUpDown, Truck, Loader2 } from 'lucide-react';
import { cn } from '@/lib/utils';
import { Button } from '@/components/ui/button';
import {
  Command,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
} from '@/components/ui/command';
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from '@/components/ui/popover';

interface TruckSelectorProps {
  driverId: Id<'drivers'>;
  workosOrgId: string;
  userId: string;
  userName?: string;
  onTruckAssigned?: () => void;
}

export function TruckSelector({
  driverId,
  workosOrgId,
  userId,
  userName,
  onTruckAssigned,
}: TruckSelectorProps) {
  const [open, setOpen] = useState(false);
  const [isUpdating, setIsUpdating] = useState(false);

  const trucks = useQuery(api.trucks.getAvailableTrucks, { workosOrgId });
  const updateTruck = useMutation(api.drivers.updateCurrentTruck);

  const handleSelect = async (truckId: string) => {
    setIsUpdating(true);
    try {
      await updateTruck({
        driverId,
        truckId: truckId as Id<'trucks'>,
        workosOrgId,
        userId,
        userName,
      });
      toast.success('Truck assigned successfully');
      setOpen(false);
      onTruckAssigned?.();
    } catch (error) {
      console.error('Failed to assign truck:', error);
      toast.error('Failed to assign truck');
    } finally {
      setIsUpdating(false);
    }
  };

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <Button
          variant="outline"
          className="w-full justify-between border-dashed border-amber-400 bg-amber-50 text-amber-700 hover:bg-amber-100 hover:text-amber-800"
          disabled={isUpdating}
        >
          {isUpdating ? (
            <>
              <Loader2 className="mr-2 h-4 w-4 animate-spin" />
              Assigning...
            </>
          ) : (
            <>
              <span className="flex items-center">
                <Truck className="mr-2 h-4 w-4" />
                Select a truck...
              </span>
              <ChevronsUpDown className="ml-2 h-4 w-4 shrink-0 opacity-50" />
            </>
          )}
        </Button>
      </PopoverTrigger>
      <PopoverContent className="w-[280px] p-0" align="start">
        <Command>
          <CommandInput placeholder="Search by unit ID..." />
          <CommandList>
            <CommandEmpty>No trucks available.</CommandEmpty>
            <CommandGroup heading="Available Trucks">
              {trucks?.map((truck) => (
                <CommandItem
                  key={truck._id}
                  value={`${truck.unitId} ${truck.make || ''} ${truck.model || ''}`}
                  onSelect={() => handleSelect(truck._id)}
                  className="cursor-pointer"
                >
                  <Check className={cn('mr-2 h-4 w-4', 'opacity-0')} />
                  <div className="flex flex-col">
                    <span className="font-medium">Unit {truck.unitId}</span>
                    <span className="text-xs text-muted-foreground">
                      {truck.make} {truck.model}
                      {truck.bodyType && ` • ${truck.bodyType}`}
                    </span>
                  </div>
                </CommandItem>
              ))}
            </CommandGroup>
          </CommandList>
        </Command>
      </PopoverContent>
    </Popover>
  );
}
