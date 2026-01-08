'use client';

import { Button } from '@/components/ui/button';
import { Mail, Edit, FileDown, UserX, X } from 'lucide-react';

interface FloatingActionBarProps {
  selectedCount: number;
  totalCount?: number;
  isAllSelected?: boolean;
  onClearSelection: () => void;
  onSelectAll?: () => void;
  onMessage?: () => void;
  onBulkEdit?: () => void;
  onExport?: () => void;
  onDeactivate?: () => void;
}

export function FloatingActionBar({
  selectedCount,
  totalCount,
  isAllSelected,
  onClearSelection,
  onSelectAll,
  onMessage,
  onBulkEdit,
  onExport,
  onDeactivate,
}: FloatingActionBarProps) {
  if (selectedCount === 0) return null;

  return (
    <div className="fixed bottom-6 left-1/2 -translate-x-1/2 z-50 animate-in slide-in-from-bottom-4 duration-300">
      {/* Select All Hint - Shows above the action bar */}
      {!isAllSelected && totalCount && selectedCount < totalCount && onSelectAll && (
        <div className="mb-2 text-center">
          <button
            onClick={onSelectAll}
            className="text-xs text-gray-600 dark:text-gray-400 hover:text-gray-900 dark:hover:text-gray-200 underline"
          >
            All {selectedCount} carriers on this page are selected. Select all {totalCount} carriers?
          </button>
        </div>
      )}

      <div className="bg-gray-900 dark:bg-gray-800 text-white rounded-full shadow-2xl border border-gray-700 px-6 py-3 flex items-center gap-4">
        {/* Selection Counter */}
        <div className="flex items-center gap-2">
          <span className="font-semibold text-sm">
            {selectedCount} {selectedCount === 1 ? 'Carrier' : 'Carriers'} Selected
          </span>
        </div>

        {/* Divider */}
        <div className="h-6 w-px bg-gray-600" />

        {/* Actions */}
        <div className="flex items-center gap-2">
          {onMessage && (
            <Button
              variant="ghost"
              size="sm"
              onClick={onMessage}
              className="text-white hover:bg-gray-700 hover:text-white h-8"
            >
              <Mail className="h-4 w-4 mr-1.5" />
              Message
            </Button>
          )}

          {onBulkEdit && (
            <Button
              variant="ghost"
              size="sm"
              onClick={onBulkEdit}
              className="text-white hover:bg-gray-700 hover:text-white h-8"
            >
              <Edit className="h-4 w-4 mr-1.5" />
              Edit
            </Button>
          )}

          {onExport && (
            <Button
              variant="ghost"
              size="sm"
              onClick={onExport}
              className="text-white hover:bg-gray-700 hover:text-white h-8"
            >
              <FileDown className="h-4 w-4 mr-1.5" />
              Export
            </Button>
          )}

          {onDeactivate && (
            <Button
              variant="ghost"
              size="sm"
              onClick={onDeactivate}
              className="text-white hover:bg-red-600 hover:text-white h-8"
            >
              <UserX className="h-4 w-4 mr-1.5" />
              Deactivate
            </Button>
          )}
        </div>

        {/* Divider */}
        <div className="h-6 w-px bg-gray-600" />

        {/* Close Button */}
        <Button
          variant="ghost"
          size="sm"
          onClick={onClearSelection}
          className="text-white hover:bg-gray-700 hover:text-white h-8 w-8 p-0"
        >
          <X className="h-4 w-4" />
        </Button>
      </div>
    </div>
  );
}
