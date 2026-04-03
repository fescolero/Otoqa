'use client';

import { useEffect, useReducer, useRef, useState } from 'react';
import { Virtualizer, elementScroll, observeElementOffset, observeElementRect } from '@tanstack/virtual-core';
import { Checkbox } from '@/components/ui/checkbox';
import { Badge } from '@/components/ui/badge';
import { format } from 'date-fns';

interface FuelEntry {
  _id: string;
  entryDate: number;
  vendorName: string;
  driverName?: string;
  carrierName?: string;
  truckUnitId?: string;
  gallons: number;
  pricePerGallon: number;
  totalCost: number;
  type: 'fuel' | 'def';
  paymentMethod?: string;
  location?: { city: string; state: string };
}

interface FuelEntriesTableProps {
  entries: FuelEntry[];
  onRowClick: (id: string, type: 'fuel' | 'def') => void;
  selectedIds: Set<string>;
  onSelectRow: (id: string) => void;
  onSelectAll: () => void;
  isAllSelected: boolean;
}

function formatCurrency(value: number): string {
  return `$${value.toFixed(2)}`;
}

export function FuelEntriesTable({
  entries,
  onRowClick,
  selectedIds,
  onSelectRow,
  onSelectAll,
  isAllSelected,
}: FuelEntriesTableProps) {
  const parentRef = useRef<HTMLDivElement>(null);
  const rerender = useReducer(() => ({}), {})[1];

  const options = {
    count: entries.length,
    getScrollElement: () => parentRef.current,
    estimateSize: () => 52,
    overscan: 10,
    observeElementRect,
    observeElementOffset,
    scrollToFn: elementScroll,
    onChange: () => {
      rerender();
    },
  };

  const [rowVirtualizer] = useState(() => new Virtualizer(options));
  rowVirtualizer.setOptions(options);

  useEffect(() => {
    return rowVirtualizer._didMount();
  }, [rowVirtualizer]);

  useEffect(() => {
    return rowVirtualizer._willUpdate();
  });

  return (
    <div className="flex flex-col h-full min-h-0">
      {/* Header */}
      <div className="flex-shrink-0 border-b bg-slate-50">
        <div className="flex items-center h-10 w-full">
          <div className="px-2 w-12 flex items-center">
            <Checkbox checked={isAllSelected && entries.length > 0} onCheckedChange={onSelectAll} />
          </div>
          <div className="px-3 w-28 font-medium text-muted-foreground text-xs uppercase">Date</div>
          <div className="px-3 flex-1 font-medium text-muted-foreground text-xs uppercase">Driver / Carrier</div>
          <div className="px-3 w-24 font-medium text-muted-foreground text-xs uppercase">Truck</div>
          <div className="px-3 flex-1 font-medium text-muted-foreground text-xs uppercase">Vendor</div>
          <div className="px-3 w-36 font-medium text-muted-foreground text-xs uppercase">Location</div>
          <div className="px-3 w-24 font-medium text-muted-foreground text-xs uppercase text-right">Gallons</div>
          <div className="px-3 w-24 font-medium text-muted-foreground text-xs uppercase text-right">Price/Gal</div>
          <div className="px-3 w-28 font-medium text-muted-foreground text-xs uppercase text-right">Total</div>
          <div className="px-3 w-20 font-medium text-muted-foreground text-xs uppercase text-center">Type</div>
          <div className="px-3 w-32 font-medium text-muted-foreground text-xs uppercase">Payment</div>
        </div>
      </div>

      {/* Body */}
      <div ref={parentRef} className="flex-1 overflow-auto">
        {entries.length === 0 ? (
          <div className="flex items-center justify-center h-40 text-sm text-muted-foreground">
            No fuel entries found
          </div>
        ) : (
          <div
            style={{
              height: `${rowVirtualizer.getTotalSize()}px`,
              width: '100%',
              position: 'relative',
            }}
          >
            {rowVirtualizer.getVirtualItems().map((virtualRow) => {
              const entry = entries[virtualRow.index];
              const isSelected = selectedIds.has(entry._id);

              return (
                <div
                  key={entry._id}
                  style={{
                    position: 'absolute',
                    top: 0,
                    left: 0,
                    width: '100%',
                    height: `${virtualRow.size}px`,
                    transform: `translateY(${virtualRow.start}px)`,
                  }}
                  className={`flex items-center w-full border-b hover:bg-slate-50/50 cursor-pointer ${
                    isSelected ? 'bg-primary/5' : ''
                  }`}
                  onClick={() => onRowClick(entry._id, entry.type)}
                >
                  <div className="px-2 w-12 flex items-center" onClick={(e) => e.stopPropagation()}>
                    <Checkbox checked={isSelected} onCheckedChange={() => onSelectRow(entry._id)} />
                  </div>
                  <div className="px-3 w-28 text-sm">{format(new Date(entry.entryDate), 'MMM d, yyyy')}</div>
                  <div className="px-3 flex-1 min-w-0">
                    {entry.driverName && <div className="text-sm font-medium truncate">{entry.driverName}</div>}
                    {entry.carrierName && (
                      <div className="text-xs text-muted-foreground truncate">{entry.carrierName}</div>
                    )}
                    {!entry.driverName && !entry.carrierName && (
                      <span className="text-xs text-muted-foreground">—</span>
                    )}
                  </div>
                  <div className="px-3 w-24 text-sm truncate">{entry.truckUnitId || '—'}</div>
                  <div className="px-3 flex-1 text-sm truncate min-w-0">{entry.vendorName}</div>
                  <div className="px-3 w-36 text-sm truncate min-w-0">
                    {entry.location ? `${entry.location.city}, ${entry.location.state}` : '—'}
                  </div>
                  <div className="px-3 w-24 text-sm text-right tabular-nums">{entry.gallons.toFixed(2)}</div>
                  <div className="px-3 w-24 text-sm text-right tabular-nums">
                    {formatCurrency(entry.pricePerGallon)}
                  </div>
                  <div className="px-3 w-28 text-sm font-medium text-right tabular-nums">
                    {formatCurrency(entry.totalCost)}
                  </div>
                  <div className="px-3 w-20 flex justify-center">
                    <Badge variant={entry.type === 'def' ? 'secondary' : 'default'}>
                      {entry.type === 'def' ? 'DEF' : 'Fuel'}
                    </Badge>
                  </div>
                  <div className="px-3 w-32 text-sm truncate">{entry.paymentMethod || '—'}</div>
                </div>
              );
            })}
          </div>
        )}
      </div>
    </div>
  );
}
