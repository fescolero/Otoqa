'use client';

import { useEffect } from 'react';
import { Id } from '@/convex/_generated/dataModel';

interface Invoice {
  _id: Id<'loadInvoices'>;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  [key: string]: any;
}

interface UseKeyboardNavigationProps {
  invoices: Invoice[];
  selectedIds: Set<Id<'loadInvoices'>>;
  setSelectedIds: (ids: Set<Id<'loadInvoices'>>) => void;
  focusedRowIndex: number | null;
  setFocusedRowIndex: (index: number | null) => void;
  onOpenPreview: (invoiceId: Id<'loadInvoices'>) => void;
  isSheetOpen: boolean;
}

export function useKeyboardNavigation({
  invoices,
  selectedIds,
  setSelectedIds,
  focusedRowIndex,
  setFocusedRowIndex,
  onOpenPreview,
  isSheetOpen,
}: UseKeyboardNavigationProps) {
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      // Don't handle shortcuts when typing in input fields
      if (
        e.target instanceof HTMLInputElement ||
        e.target instanceof HTMLTextAreaElement ||
        e.target instanceof HTMLSelectElement
      ) {
        return;
      }

      // Don't handle j/k/space when sheet is open (allow arrow keys only)
      const currentIndex = focusedRowIndex ?? -1;

      switch (e.key.toLowerCase()) {
        case 'j':
        case 'arrowdown':
          e.preventDefault();
          if (invoices.length > 0) {
            const nextIndex = Math.min(currentIndex + 1, invoices.length - 1);
            setFocusedRowIndex(nextIndex >= 0 ? nextIndex : 0);
          }
          break;

        case 'k':
        case 'arrowup':
          e.preventDefault();
          if (invoices.length > 0 && currentIndex > 0) {
            setFocusedRowIndex(currentIndex - 1);
          }
          break;

        case ' ':
          // Space to select/deselect
          if (!isSheetOpen && currentIndex >= 0 && invoices[currentIndex]) {
            e.preventDefault();
            const invoiceId = invoices[currentIndex]._id;
            const newSelectedIds = new Set(selectedIds);
            
            if (newSelectedIds.has(invoiceId)) {
              newSelectedIds.delete(invoiceId);
            } else {
              newSelectedIds.add(invoiceId);
            }
            
            setSelectedIds(newSelectedIds);
          }
          break;

        case 'enter':
          // Enter to open preview
          if (currentIndex >= 0 && invoices[currentIndex]) {
            e.preventDefault();
            onOpenPreview(invoices[currentIndex]._id);
          }
          break;

        case 'escape':
          // Escape to clear selection or close sheet
          e.preventDefault();
          if (selectedIds.size > 0) {
            setSelectedIds(new Set());
          }
          if (isSheetOpen) {
            onOpenPreview(null as any); // Close sheet by passing null
          }
          setFocusedRowIndex(null);
          break;

        default:
          break;
      }
    };

    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [
    invoices,
    selectedIds,
    setSelectedIds,
    focusedRowIndex,
    setFocusedRowIndex,
    onOpenPreview,
    isSheetOpen,
  ]);
}
