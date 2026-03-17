'use client';

import { useRef, useEffect, useLayoutEffect, useState, useCallback } from 'react';
import { Id } from '@/convex/_generated/dataModel';

const ROW_HEIGHT = 48;
const OVERSCAN = 15;
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
import { Download, Printer, TrendingDown, TrendingUp } from 'lucide-react';
import { InvoiceStatusBadge } from './invoice-status-badge';
import { cn } from '@/lib/utils';
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from '@/components/ui/tooltip';

interface Invoice {
  _id: Id<'loadInvoices'>;
  invoiceNumber?: string;
  totalAmount: number;
  paidAmount?: number;
  paymentDifference?: number;
  status?: string;
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
  onLoadMore?: () => void;
  canLoadMore?: boolean;
  isLoadingMore?: boolean;
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
  onLoadMore,
  canLoadMore = false,
  isLoadingMore = false,
}: VirtualizedInvoiceTableProps) {
  const parentRef = useRef<HTMLDivElement>(null);
  const loadMoreSentinelRef = useRef<HTMLDivElement>(null);
  const headerChecked = isAllSelected ? true : isSomeSelected ? 'indeterminate' : false;

  // Custom scroll-based virtualization (avoids @tanstack/react-virtual's flushSync)
  const [scrollState, setScrollState] = useState({ scrollTop: 0, height: 400 });
  const rafRef = useRef<number | undefined>(undefined);
  const onScroll = useCallback(() => {
    const el = parentRef.current;
    if (!el) return;
    if (rafRef.current) cancelAnimationFrame(rafRef.current);
    rafRef.current = requestAnimationFrame(() => {
      rafRef.current = undefined;
      const scrollTop = el.scrollTop;
      const height = el.clientHeight;
      setScrollState({ scrollTop, height });

      // Scroll-based load: when near bottom (500px from end), load more
      if (canLoadMore && !isLoadingMore && onLoadMore) {
        const totalH = invoices.length * ROW_HEIGHT;
        if (totalH > 0 && scrollTop + height >= totalH - 500) {
          queueMicrotask(() => onLoadMore());
        }
      }
    });
  }, [canLoadMore, isLoadingMore, onLoadMore, invoices.length]);

  useLayoutEffect(() => {
    const el = parentRef.current;
    if (!el) return;
    onScroll();
    const ro = new ResizeObserver(onScroll);
    ro.observe(el);
    el.addEventListener('scroll', onScroll, { passive: true });
    return () => {
      ro.disconnect();
      el.removeEventListener('scroll', onScroll);
    };
  }, [onScroll]);

  const count = invoices.length;
  const totalHeight = count * ROW_HEIGHT;
  const startIndex = Math.max(0, Math.floor(scrollState.scrollTop / ROW_HEIGHT) - OVERSCAN);
  const visibleCount = Math.max(50, Math.ceil(scrollState.height / ROW_HEIGHT) + OVERSCAN * 2);
  const endIndex = Math.min(count, startIndex + visibleCount);
  const visibleItems = Array.from({ length: Math.max(0, endIndex - startIndex) }, (_, i) => startIndex + i);

  // Infinite scroll: IntersectionObserver when sentinel comes into view (500px before bottom)
  useEffect(() => {
    if (!canLoadMore || isLoadingMore || !onLoadMore || !loadMoreSentinelRef.current || !parentRef.current) return;
    const sentinel = loadMoreSentinelRef.current;
    const observer = new IntersectionObserver(
      (entries) => {
        if (!entries[0]?.isIntersecting) return;
        queueMicrotask(() => onLoadMore());
      },
      { root: parentRef.current, rootMargin: '0px 0px 500px 0px', threshold: 0 }
    );
    observer.observe(sentinel);
    return () => observer.disconnect();
  }, [canLoadMore, isLoadingMore, onLoadMore]);

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
      <div className="flex-1 min-h-[300px] overflow-auto" ref={parentRef}>
        <div className="relative" style={{ height: `${totalHeight}px` }}>
          {visibleItems.map((index) => {
            const invoice = invoices[index];
            if (!invoice) return null;

            return (
              <div
                key={invoice._id}
                data-index={index}
                className={cn(
                  'absolute top-0 left-0 w-full cursor-pointer bg-background hover:bg-slate-50/80 transition-colors group border-b flex items-center',
                  focusedRowIndex === index && 'ring-2 ring-primary'
                )}
                style={{
                  height: ROW_HEIGHT,
                  transform: `translateY(${index * ROW_HEIGHT}px)`,
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
                  <span>{formatCurrency(invoice.totalAmount)}</span>
                  {invoice.status === 'PAID' &&
                    invoice.paymentDifference !== undefined &&
                    Math.abs(invoice.paymentDifference) > 0.005 && (
                      <TooltipProvider delayDuration={200}>
                        <Tooltip>
                          <TooltipTrigger asChild>
                            <span
                              className={cn(
                                'ml-1.5 inline-flex items-center gap-0.5 text-xs font-medium rounded px-1 py-0.5',
                                invoice.paymentDifference > 0
                                  ? 'text-amber-700 bg-amber-50 dark:text-amber-300 dark:bg-amber-950/40'
                                  : 'text-red-700 bg-red-50 dark:text-red-300 dark:bg-red-950/40'
                              )}
                            >
                              {invoice.paymentDifference > 0 ? (
                                <TrendingUp className="h-3 w-3" />
                              ) : (
                                <TrendingDown className="h-3 w-3" />
                              )}
                              {formatCurrency(Math.abs(invoice.paymentDifference))}
                            </span>
                          </TooltipTrigger>
                          <TooltipContent side="top">
                            <p>
                              Paid {formatCurrency(invoice.paidAmount ?? 0)} vs invoiced{' '}
                              {formatCurrency(invoice.totalAmount)}
                            </p>
                            <p className="text-xs text-muted-foreground">
                              {invoice.paymentDifference > 0 ? 'Overpaid' : 'Underpaid'} by{' '}
                              {formatCurrency(Math.abs(invoice.paymentDifference))}
                            </p>
                          </TooltipContent>
                        </Tooltip>
                      </TooltipProvider>
                    )}
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
          {isLoadingMore && (
            <div className="flex items-center justify-center py-4 text-sm text-muted-foreground">
              <div className="animate-spin rounded-full h-4 w-4 border-b-2 border-primary mr-2" />
              Loading more...
            </div>
          )}
        </div>
        {canLoadMore && <div ref={loadMoreSentinelRef} className="h-1 min-h-1 shrink-0" aria-hidden="true" />}
      </div>

      {/* Footer status bar */}
      <div className="flex-shrink-0 border-t px-4 py-2 flex items-center justify-between text-xs text-muted-foreground bg-slate-50/50">
        <span>
          Showing {invoices.length} invoice{invoices.length !== 1 ? 's' : ''}
          {canLoadMore && ' — scroll for more'}
        </span>
        {canLoadMore && !isLoadingMore && (
          <button
            onClick={onLoadMore}
            className="text-primary hover:underline font-medium"
          >
            Load more
          </button>
        )}
        {isLoadingMore && (
          <span className="flex items-center gap-1">
            <div className="animate-spin rounded-full h-3 w-3 border-b-2 border-primary" />
            Loading...
          </span>
        )}
      </div>
    </div>
  );
}
