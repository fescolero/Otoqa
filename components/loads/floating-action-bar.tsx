'use client';

import { Button } from '@/components/ui/button';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { Download, FileText, Trash2, X, Edit } from 'lucide-react';
import { cn } from '@/lib/utils';

interface FloatingActionBarProps {
  selectedCount: number;
  onBulkDownload: () => void;
  onUpdateStatus: (status: 'Open' | 'Assigned' | 'Delivered' | 'Canceled') => void;
  onExport: () => void;
  onDelete: () => void;
  onClearSelection: () => void;
  className?: string;
}

export function FloatingActionBar({
  selectedCount,
  onBulkDownload,
  onUpdateStatus,
  onExport,
  onDelete,
  onClearSelection,
  className,
}: FloatingActionBarProps) {
  if (selectedCount === 0) return null;

  return (
    <div
      className={cn(
        'sticky top-0 z-20',
        'flex h-12 w-full items-center justify-between',
        'border-b bg-blue-50/30 px-4',
        'animate-in slide-in-from-top-2 duration-200',
        className
      )}
    >
      {/* Left side: Clear button and selection count */}
      <div className="flex items-center gap-3">
        <Button
          variant="ghost"
          size="sm"
          onClick={onClearSelection}
          className="h-8 w-8 p-0 hover:bg-slate-50 transition-colors"
        >
          <X className="h-4 w-4" strokeWidth={2} />
        </Button>
        <span className="text-sm font-semibold text-slate-900">
          {selectedCount} {selectedCount === 1 ? 'Load' : 'Loads'} Selected
        </span>
      </div>

      {/* Right side: Action buttons */}
      <div className="flex items-center gap-2">
        <Button
          size="sm"
          variant="ghost"
          onClick={onBulkDownload}
          className="h-8 text-slate-700 hover:bg-slate-50 hover:text-blue-600 transition-colors font-medium"
        >
          <Download className="w-4 h-4 mr-2" strokeWidth={2} />
          Download Manifests
        </Button>

        {/* Separator */}
        <div className="w-[1px] h-4 bg-slate-200 mx-2" />

        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button
              size="sm"
              variant="ghost"
              className="h-8 text-slate-700 hover:bg-slate-50 hover:text-blue-600 transition-colors font-medium"
            >
              <Edit className="w-4 h-4 mr-2" strokeWidth={2} />
              Update Status
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end" className="w-40">
            <DropdownMenuItem onClick={() => onUpdateStatus('Open')}>
              Mark as Open
            </DropdownMenuItem>
            <DropdownMenuItem onClick={() => onUpdateStatus('Assigned')}>
              Mark as Assigned
            </DropdownMenuItem>
            <DropdownMenuItem onClick={() => onUpdateStatus('Delivered')}>
              Mark as Delivered
            </DropdownMenuItem>
            <DropdownMenuItem onClick={() => onUpdateStatus('Canceled')}>
              Mark as Canceled
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>

        {/* Separator */}
        <div className="w-[1px] h-6 bg-slate-200 mx-2" />

        <Button
          size="sm"
          variant="ghost"
          onClick={onExport}
          className="h-8 text-slate-700 hover:bg-slate-50 hover:text-blue-600 transition-colors font-medium"
        >
          <FileText className="w-4 h-4 mr-2" strokeWidth={2} />
          Export
        </Button>

        {/* Separator */}
        <div className="w-[1px] h-6 bg-slate-200 mx-2" />

        <Button
          size="sm"
          variant="ghost"
          onClick={onDelete}
          className="h-8 text-slate-700 hover:bg-slate-50 hover:text-red-600 transition-colors font-medium"
        >
          <Trash2 className="w-4 h-4 mr-2" strokeWidth={2} />
          Delete
        </Button>
      </div>
    </div>
  );
}
