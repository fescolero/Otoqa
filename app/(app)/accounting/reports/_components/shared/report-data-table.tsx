'use client';

import { useState, useMemo } from 'react';
import {
  ColumnDef,
  SortingState,
  flexRender,
  getCoreRowModel,
  getFilteredRowModel,
  getPaginationRowModel,
  getSortedRowModel,
  useReactTable,
  type FilterFn,
  type Row,
} from '@tanstack/react-table';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { Button } from '@/components/ui/button';
import { Checkbox } from '@/components/ui/checkbox';
import { Loader2, ChevronLeft, ChevronRight, ListFilter } from 'lucide-react';
import { cn } from '@/lib/utils';
import type { TableDensity, QuickFilter } from './types';

// ============================================
// GLOBAL FILTER
// ============================================

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const globalFilterFn: FilterFn<any> = (row: Row<any>, _columnId: string, filterValue: string) => {
  const search = filterValue.toLowerCase();
  // Search across all string/number cell values
  return row.getAllCells().some((cell) => {
    const value = cell.getValue();
    if (value == null) return false;
    return String(value).toLowerCase().includes(search);
  });
};

// ============================================
// TYPES
// ============================================

type LoadMoreStatus = 'idle' | 'can-load' | 'loading' | 'exhausted';

interface ReportDataTableProps<TData> {
  columns: ColumnDef<TData, unknown>[];
  data: TData[];
  searchQuery?: string;
  quickFilters?: QuickFilter[];
  activeQuickFilter?: string;
  onQuickFilterChange?: (value: string) => void;
  isLoading?: boolean;
  emptyMessage?: string;
  pageSize?: number;
  /** Callback to load more server-side data (Convex pagination). */
  onLoadMore?: () => void;
  /** Status of the server-side pagination. */
  loadMoreStatus?: LoadMoreStatus;
  /** Total count from the server for display purposes. */
  serverTotal?: number;
}

// ============================================
// SELECT COLUMN HELPER
// ============================================

export function getSelectColumn<TData>(): ColumnDef<TData, unknown> {
  return {
    id: 'select',
    header: ({ table }) => (
      <Checkbox
        checked={table.getIsAllPageRowsSelected() || (table.getIsSomePageRowsSelected() && 'indeterminate')}
        onCheckedChange={(value) => table.toggleAllPageRowsSelected(!!value)}
        aria-label="Select all"
        className="translate-y-[2px]"
      />
    ),
    cell: ({ row }) => (
      <Checkbox
        checked={row.getIsSelected()}
        onCheckedChange={(value) => row.toggleSelected(!!value)}
        aria-label="Select row"
        className="translate-y-[2px]"
        onClick={(e) => e.stopPropagation()}
      />
    ),
    enableSorting: false,
    enableHiding: false,
    size: 40,
  };
}

// ============================================
// SORTABLE HEADER HELPER
// ============================================

export function SortableHeader({
  column,
  children,
  className,
}: {
  column: { toggleSorting: (desc?: boolean) => void; getIsSorted: () => false | 'asc' | 'desc' };
  children: React.ReactNode;
  className?: string;
}) {
  const sorted = column.getIsSorted();
  return (
    <Button
      variant="ghost"
      size="sm"
      className={cn('-ml-3 h-8 data-[state=open]:bg-accent', className)}
      onClick={() => column.toggleSorting(sorted === 'asc')}
    >
      {children}
      {sorted === 'asc' && <span className="ml-1 text-xs">&#9650;</span>}
      {sorted === 'desc' && <span className="ml-1 text-xs">&#9660;</span>}
      {!sorted && <span className="ml-1 text-xs text-muted-foreground/50">&#9650;&#9660;</span>}
    </Button>
  );
}

// ============================================
// MAIN TABLE COMPONENT
// ============================================

export function ReportDataTable<TData>({
  columns,
  data,
  searchQuery = '',
  quickFilters,
  activeQuickFilter = 'all',
  onQuickFilterChange,
  isLoading = false,
  emptyMessage = 'No data found for the selected date range.',
  pageSize = 20,
  onLoadMore,
  loadMoreStatus = 'idle',
  serverTotal,
}: ReportDataTableProps<TData>) {
  const [sorting, setSorting] = useState<SortingState>([]);
  const [rowSelection, setRowSelection] = useState({});
  const [density, setDensity] = useState<TableDensity>('compact');

  const table = useReactTable({
    data,
    columns,
    state: {
      sorting,
      globalFilter: searchQuery,
      rowSelection,
    },
    onSortingChange: setSorting,
    onRowSelectionChange: setRowSelection,
    globalFilterFn,
    getCoreRowModel: getCoreRowModel(),
    getSortedRowModel: getSortedRowModel(),
    getFilteredRowModel: getFilteredRowModel(),
    getPaginationRowModel: getPaginationRowModel(),
    initialState: {
      pagination: { pageSize },
    },
  });

  const totalRows = table.getFilteredRowModel().rows.length;
  const currentPage = table.getState().pagination.pageIndex;
  const totalPages = table.getPageCount();
  const startRow = currentPage * pageSize + 1;
  const endRow = Math.min((currentPage + 1) * pageSize, totalRows);
  const isOnLastPage = totalPages <= 1 || currentPage === totalPages - 1;

  // Generate page numbers for pagination
  const pageNumbers = useMemo(() => {
    const pages: (number | 'ellipsis')[] = [];
    if (totalPages <= 7) {
      for (let i = 0; i < totalPages; i++) pages.push(i);
    } else {
      pages.push(0);
      if (currentPage > 2) pages.push('ellipsis');
      const start = Math.max(1, currentPage - 1);
      const end = Math.min(totalPages - 2, currentPage + 1);
      for (let i = start; i <= end; i++) pages.push(i);
      if (currentPage < totalPages - 3) pages.push('ellipsis');
      pages.push(totalPages - 1);
    }
    return pages;
  }, [totalPages, currentPage]);

  // ============================================
  // LOADING STATE
  // ============================================

  if (isLoading) {
    return (
      <div className="flex flex-col items-center justify-center py-20">
        <Loader2 className="h-8 w-8 animate-spin text-muted-foreground" />
        <p className="mt-2 text-sm text-muted-foreground">Loading report data...</p>
      </div>
    );
  }

  // ============================================
  // RENDER
  // ============================================

  return (
    <div className="flex h-full min-h-0 flex-col space-y-0 overflow-hidden">
      {/* Toolbar */}
      <div className="flex items-center justify-between border rounded-t-md border-b-0 px-3 py-2 bg-muted/30 gap-2">
        {/* Left: quick filters */}
        <div className="flex items-center gap-1.5 min-w-0">
          {quickFilters && quickFilters.length > 0 && (
            <>
              <ListFilter className="h-3.5 w-3.5 text-muted-foreground shrink-0" />
              <span className="text-xs text-muted-foreground shrink-0">Quick filters</span>
              <div className="w-px h-4 bg-border mx-0.5 shrink-0" />
              {quickFilters.map((filter) => (
                <Button
                  key={filter.value}
                  variant={activeQuickFilter === filter.value ? 'default' : 'ghost'}
                  size="sm"
                  className="h-6 text-xs px-2 shrink-0"
                  onClick={() => onQuickFilterChange?.(filter.value)}
                >
                  {filter.label}
                </Button>
              ))}
            </>
          )}
        </div>

        {/* Right: density toggle + result count */}
        <div className="flex items-center gap-2 shrink-0">
          {/* Density toggle */}
          <div className="flex items-center rounded-md border bg-background">
            <Button
              variant="ghost"
              size="sm"
              className={cn(
                'h-6 rounded-r-none text-xs px-2.5 border-r',
                density === 'compact' &&
                  'bg-primary text-primary-foreground hover:bg-primary/90 hover:text-primary-foreground',
              )}
              onClick={() => setDensity('compact')}
            >
              Compact
            </Button>
            <Button
              variant="ghost"
              size="sm"
              className={cn(
                'h-6 rounded-l-none text-xs px-2.5',
                density === 'normal' &&
                  'bg-primary text-primary-foreground hover:bg-primary/90 hover:text-primary-foreground',
              )}
              onClick={() => setDensity('normal')}
            >
              Normal
            </Button>
          </div>

          <span className="text-xs text-muted-foreground whitespace-nowrap">{totalRows} results</span>
        </div>
      </div>

      {/* Table */}
      <div className="min-h-0 flex-1 rounded-b-md border overflow-auto">
        <Table>
          <TableHeader>
            {table.getHeaderGroups().map((headerGroup) => (
              <TableRow key={headerGroup.id}>
                {headerGroup.headers.map((header) => (
                  <TableHead
                    key={header.id}
                    className={cn(density === 'compact' ? 'h-8 px-2' : 'h-10 px-3')}
                    style={header.column.getSize() !== 150 ? { width: header.column.getSize() } : undefined}
                  >
                    {header.isPlaceholder ? null : flexRender(header.column.columnDef.header, header.getContext())}
                  </TableHead>
                ))}
              </TableRow>
            ))}
          </TableHeader>
          <TableBody>
            {table.getRowModel().rows?.length ? (
              table.getRowModel().rows.map((row) => (
                <TableRow key={row.id} data-state={row.getIsSelected() && 'selected'}>
                  {row.getVisibleCells().map((cell) => (
                    <TableCell key={cell.id} className={cn(density === 'compact' ? 'py-1.5 px-2' : 'py-3 px-3')}>
                      {flexRender(cell.column.columnDef.cell, cell.getContext())}
                    </TableCell>
                  ))}
                </TableRow>
              ))
            ) : (
              <TableRow>
                <TableCell colSpan={columns.length} className="h-48 text-center align-middle">
                  <p className="text-sm text-muted-foreground">{emptyMessage}</p>
                </TableCell>
              </TableRow>
            )}
          </TableBody>
        </Table>
      </div>

      {/* Pagination */}
      {totalRows > 0 && (
        <div className="flex items-center justify-between pt-3">
          <p className="text-xs text-muted-foreground">
            Showing {startRow}-{endRow} of {totalRows}
            {serverTotal && serverTotal > totalRows ? ` (${serverTotal} total)` : ''}
          </p>
          <div className="flex items-center gap-1.5">
            {totalPages > 1 && (
              <>
                <Button
                  variant="ghost"
                  size="sm"
                  className="h-7 w-7 p-0"
                  onClick={() => table.previousPage()}
                  disabled={!table.getCanPreviousPage()}
                >
                  <ChevronLeft className="h-3.5 w-3.5" />
                  <span className="sr-only">Previous</span>
                </Button>
                {pageNumbers.map((page, i) =>
                  page === 'ellipsis' ? (
                    <span key={`ellipsis-${i}`} className="px-0.5 text-muted-foreground text-xs">
                      ...
                    </span>
                  ) : (
                    <Button
                      key={page}
                      variant={page === currentPage ? 'default' : 'ghost'}
                      size="sm"
                      className="h-7 w-7 p-0 text-xs"
                      onClick={() => table.setPageIndex(page)}
                    >
                      {page + 1}
                    </Button>
                  ),
                )}
                <Button
                  variant="ghost"
                  size="sm"
                  className="h-7 w-7 p-0"
                  onClick={() => table.nextPage()}
                  disabled={!table.getCanNextPage()}
                >
                  <ChevronRight className="h-3.5 w-3.5" />
                  <span className="sr-only">Next</span>
                </Button>
              </>
            )}
            {/* Load More — right of nav controls, only on last page */}
            {isOnLastPage && loadMoreStatus === 'can-load' && onLoadMore && (
              <Button variant="outline" size="sm" className="h-7 text-xs px-3 ml-1" onClick={onLoadMore}>
                Load More
              </Button>
            )}
            {isOnLastPage && loadMoreStatus === 'loading' && (
              <Loader2 className="h-3.5 w-3.5 animate-spin text-muted-foreground ml-1" />
            )}
          </div>
        </div>
      )}
    </div>
  );
}
