'use client';

import { useRef } from 'react';
import { useVirtualizer } from '@tanstack/react-virtual';
import { Id } from '@/convex/_generated/dataModel';
import { Button } from '@/components/ui/button';
import { Checkbox } from '@/components/ui/checkbox';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import { Download, Printer } from 'lucide-react';
import { InvoiceStatusBadge } from './invoice-status-badge';
import { cn } from '@/lib/utils';

interface Invoice {
  _id: Id<'loadInvoices'>;
  invoiceNumber?: string;
  totalAmount: number;
  createdAt: number;
  customer?: {
    name: string;
  };
  load?: {
    orderNumber: string;
    loadType?: 'CONTRACT' | 'SPOT' | 'UNMAPPED';
  };
}

interface VirtualizedInvoiceTableProps {
  invoices: Invoice[];
  selectedIds: Set<Id<'loadInvoices'>>;
  focusedRowIndex: number | null;
  isAllSelected: boolean;
  isSomeSelected: boolean;
  onSelectAll: (checked: boolean) => void;
  onSelectRow: (id: Id<'loadInvoices'>, checked: boolean) => void;
  onRowClick: (id: Id<'loadInvoices'>) => void;
  onDownload?: (id: Id<'loadInvoices'>) => void;
  onPrint?: (id: Id<'loadInvoices'>) => void;
  formatDate: (timestamp: number) => string;
  formatCurrency: (amount: number) => string;
  emptyMessage?: string;
}

export function VirtualizedInvoiceTable({
  invoices,
  selectedIds,
  focusedRowIndex,
  isAllSelected,
  isSomeSelected,
  onSelectAll,
  onSelectRow,
  onRowClick,
  onDownload,
  onPrint,
  formatDate,
  formatCurrency,
  emptyMessage = 'No invoices found',
}: VirtualizedInvoiceTableProps) {
  const parentRef = useRef<HTMLDivElement>(null);
  const headerChecked = isAllSelected ? true : isSomeSelected ? 'indeterminate' : false;

  const rowVirtualizer = useVirtualizer({
    count: invoices.length,
    getScrollElement: () => parentRef.current,
    estimateSize: () => 48, // Row height
    overscan: 10, // Number of items to render outside viewport
  });

  if (invoices.length === 0) {
    return (
      <Table>
        <TableHeader>
          <TableRow className="h-10">
            <TableHead className="w-12">
              <Checkbox
                checked={headerChecked}
                onCheckedChange={(checked) => onSelectAll(checked === true)}
                aria-label="Select all"
              />
            </TableHead>
            <TableHead>Load #</TableHead>
            <TableHead>Customer</TableHead>
            <TableHead>Type</TableHead>
            <TableHead>Amount</TableHead>
            <TableHead>Created</TableHead>
            <TableHead className="w-24"></TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          <TableRow>
            <TableCell colSpan={7} className="text-center py-8 text-muted-foreground">
              {emptyMessage}
            </TableCell>
          </TableRow>
        </TableBody>
      </Table>
    );
  }

  return (
    <div className="flex flex-col flex-1 min-h-0">
      {/* Fixed Header */}
      <div className="flex-shrink-0 border-b bg-background">
        <div className="flex items-center h-10 w-full">
          <div className="px-2 w-12 flex items-center">
            <Checkbox
              checked={headerChecked}
              onCheckedChange={(checked) => onSelectAll(checked === true)}
              aria-label="Select all"
            />
          </div>
          <div className="px-4 flex-1 font-medium text-muted-foreground text-sm">Load #</div>
          <div className="px-4 flex-1 font-medium text-muted-foreground text-sm">Customer</div>
          <div className="px-4 flex-1 font-medium text-muted-foreground text-sm">Type</div>
          <div className="px-4 flex-1 font-medium text-muted-foreground text-sm">Amount</div>
          <div className="px-4 flex-1 font-medium text-muted-foreground text-sm">Created</div>
          <div className="px-4 w-24"></div>
        </div>
      </div>
      
      {/* Scrollable Body */}
      <div className="flex-1 overflow-auto" ref={parentRef}>
        <div className="relative" style={{ height: `${rowVirtualizer.getTotalSize()}px` }}>
          {rowVirtualizer.getVirtualItems().map((virtualRow) => {
            const invoice = invoices[virtualRow.index];
            const index = virtualRow.index;

            return (
              <div
                key={invoice._id}
                data-index={virtualRow.index}
                className={cn(
                  'absolute top-0 left-0 w-full h-[48px] cursor-pointer hover:bg-slate-50/80 transition-colors group border-b flex items-center',
                  focusedRowIndex === index && 'ring-2 ring-primary'
                )}
                style={{
                  transform: `translateY(${virtualRow.start}px)`,
                }}
                onClick={(e) => {
                  if (!(e.target as HTMLElement).closest('input[type="checkbox"]')) {
                    onRowClick(invoice._id);
                  }
                }}
              >
                <div className="px-2 w-12 flex items-center" onClick={(e) => e.stopPropagation()}>
                  <Checkbox
                    checked={selectedIds.has(invoice._id)}
                    onCheckedChange={(checked) => onSelectRow(invoice._id, checked as boolean)}
                    aria-label={`Select invoice ${invoice.load?.orderNumber}`}
                  />
                </div>
                <div className="px-4 flex-1 font-mono text-sm">
                  {invoice.load?.orderNumber || 'N/A'}
                </div>
                <div className="px-4 flex-1 text-sm">{invoice.customer?.name || 'Unknown'}</div>
                <div className="px-4 flex-1">
                  {invoice.load?.loadType && (
                    <InvoiceStatusBadge
                      type={invoice.load.loadType as 'CONTRACT' | 'SPOT' | 'UNMAPPED'}
                      value={invoice.load.loadType}
                    />
                  )}
                </div>
                <div className="px-4 flex-1 font-semibold text-sm">
                  {formatCurrency(invoice.totalAmount)}
                </div>
                <div className="px-4 flex-1 text-sm text-muted-foreground">
                  {formatDate(invoice.createdAt)}
                </div>
                <div className="px-4 w-24">
                  <div className="opacity-0 group-hover:opacity-100 transition-opacity flex items-center gap-1">
                      <Button
                        size="sm"
                        variant="ghost"
                        className="h-7 w-7 p-0 hover:bg-slate-50 transition-colors"
                        onClick={(e) => {
                          e.stopPropagation();
                          onDownload?.(invoice._id);
                        }}
                      >
                        <Download className="h-3.5 w-3.5" strokeWidth={2} />
                      </Button>
                      <Button
                        size="sm"
                        variant="ghost"
                        className="h-7 w-7 p-0 hover:bg-slate-50 transition-colors"
                        onClick={(e) => {
                          e.stopPropagation();
                          onPrint?.(invoice._id);
                        }}
                      >
                        <Printer className="h-3.5 w-3.5" strokeWidth={2} />
                      </Button>
                  </div>
                </div>
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );
}
