'use client';

import { Card } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { ScrollArea } from '@/components/ui/scroll-area';
import { Download } from 'lucide-react';
import { format } from 'date-fns';
import type { DateRange } from './types';

interface ReportIntelligenceSidebarProps {
  subtitle: string;
  dateRange: DateRange;
  onExport?: () => void;
  children: React.ReactNode;
}

export function ReportIntelligenceSidebar({ subtitle, dateRange, onExport, children }: ReportIntelligenceSidebarProps) {
  const dateLabel = `${format(new Date(dateRange.start), 'MMM d')} - ${format(new Date(dateRange.end), 'MMM d, yyyy')}`;

  return (
    <Card className="sticky top-0 flex h-full min-h-0 flex-col overflow-hidden">
      <ScrollArea className="flex-1 min-h-0">
        <div className="p-4 space-y-5">
          {/* Header */}
          <div>
            <h3 className="text-base font-semibold">Accounting Intelligence</h3>
            <p className="text-xs text-muted-foreground mt-0.5 leading-relaxed">{subtitle}</p>
          </div>

          {/* Controls */}
          <div className="flex items-center justify-between gap-2">
            <span className="text-xs font-medium text-muted-foreground border rounded-full px-2.5 py-1 shrink-0 truncate max-w-[200px]">
              {dateLabel}
            </span>
            {onExport && (
              <Button variant="outline" size="sm" onClick={onExport} className="h-7 text-xs gap-1.5 shrink-0">
                <Download className="h-3.5 w-3.5" />
                Export
              </Button>
            )}
          </div>

          {/* Tab-specific content */}
          {children}
        </div>
      </ScrollArea>
    </Card>
  );
}
