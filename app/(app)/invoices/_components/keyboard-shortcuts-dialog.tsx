'use client';

import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { useEffect, useState } from 'react';

const shortcuts = [
  {
    category: 'Navigation',
    items: [
      { keys: ['j', '↓'], description: 'Move to next invoice' },
      { keys: ['k', '↑'], description: 'Move to previous invoice' },
      { keys: ['Enter'], description: 'Open invoice preview' },
      { keys: ['Esc'], description: 'Close preview / Clear selection' },
    ],
  },
  {
    category: 'Selection',
    items: [
      { keys: ['Space'], description: 'Select/deselect invoice' },
      { keys: ['Click checkbox'], description: 'Select individual invoice' },
      { keys: ['Header checkbox'], description: 'Select all invoices' },
    ],
  },
  {
    category: 'Preview Navigation',
    items: [
      { keys: ['←'], description: 'Previous invoice in preview' },
      { keys: ['→'], description: 'Next invoice in preview' },
    ],
  },
  {
    category: 'Other',
    items: [
      { keys: ['?'], description: 'Show keyboard shortcuts' },
    ],
  },
];

function KeyboardKey({ children }: { children: string }) {
  return (
    <kbd className="px-2 py-1 text-xs font-semibold text-gray-800 bg-gray-100 border border-gray-200 rounded-md shadow-sm">
      {children}
    </kbd>
  );
}

export function KeyboardShortcutsDialog() {
  const [isOpen, setIsOpen] = useState(false);

  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      // Don't trigger in input fields
      if (
        e.target instanceof HTMLInputElement ||
        e.target instanceof HTMLTextAreaElement ||
        e.target instanceof HTMLSelectElement
      ) {
        return;
      }

      // Open with '?' key
      if (e.key === '?' || (e.shiftKey && e.key === '/')) {
        e.preventDefault();
        setIsOpen(true);
      }
    };

    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, []);

  return (
    <Dialog open={isOpen} onOpenChange={setIsOpen}>
      <DialogContent className="max-w-2xl max-h-[80vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle className="text-xl font-semibold">Keyboard Shortcuts</DialogTitle>
          <DialogDescription>
            Use these shortcuts to navigate and manage invoices faster
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-6 mt-4">
          {shortcuts.map((section) => (
            <div key={section.category}>
              <h3 className="text-sm font-semibold text-gray-900 mb-3">
                {section.category}
              </h3>
              <div className="space-y-2">
                {section.items.map((item, index) => (
                  <div
                    key={index}
                    className="flex items-center justify-between py-2 border-b last:border-0"
                  >
                    <span className="text-sm text-gray-600">{item.description}</span>
                    <div className="flex items-center gap-2">
                      {item.keys.map((key, keyIndex) => (
                        <div key={keyIndex} className="flex items-center gap-1">
                          {keyIndex > 0 && (
                            <span className="text-xs text-gray-400">or</span>
                          )}
                          <KeyboardKey>{key}</KeyboardKey>
                        </div>
                      ))}
                    </div>
                  </div>
                ))}
              </div>
            </div>
          ))}
        </div>

        <div className="mt-6 pt-4 border-t">
          <p className="text-xs text-gray-500 text-center">
            Press <KeyboardKey>Esc</KeyboardKey> to close this dialog
          </p>
        </div>
      </DialogContent>
    </Dialog>
  );
}
