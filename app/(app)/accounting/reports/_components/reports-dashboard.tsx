'use client';

import { useState, useMemo } from 'react';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Input } from '@/components/ui/input';
import { Tabs, TabsContent, TabsListLine, TabsTriggerLine } from '@/components/ui/tabs';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
import { Calendar } from '@/components/ui/calendar';
import { CalendarIcon, Search } from 'lucide-react';
import { format } from 'date-fns';

import { ReceivablesTab } from './tabs/receivables-tab';
import { DiscrepanciesTab } from './tabs/discrepancies-tab';
import { RevenueTab } from './tabs/revenue-tab';
import { ProfitabilityTab } from './tabs/profitability-tab';
import { CostsTab } from './tabs/costs-tab';
import { DATE_PRESETS, getDateRange, type DatePreset } from './shared/types';

// ============================================
// TYPES
// ============================================

interface ReportsDashboardProps {
  organizationId: string;
  userId: string;
}

// ============================================
// MAIN COMPONENT
// ============================================

export function ReportsDashboard({ organizationId }: ReportsDashboardProps) {
  const [activeTab, setActiveTab] = useState('receivables');
  const [datePreset, setDatePreset] = useState<DatePreset>('this-month');
  const [customStart, setCustomStart] = useState<Date | undefined>();
  const [customEnd, setCustomEnd] = useState<Date | undefined>();
  const [searchQuery, setSearchQuery] = useState('');

  const dateRange = useMemo(
    () => getDateRange(datePreset, customStart, customEnd),
    [datePreset, customStart, customEnd],
  );

  const tabProps = { organizationId, dateRange, searchQuery };

  return (
    <div className="flex min-h-full flex-col gap-4 p-6">
      {/* Page header */}
      <div>
        <h1 className="text-3xl font-bold tracking-tight">Accounting Reports</h1>
      </div>

      {/* Tabs */}
      <Tabs value={activeTab} onValueChange={setActiveTab} className="flex min-h-0 flex-1 flex-col">
        <TabsListLine className="w-full">
          <TabsTriggerLine value="receivables">Receivables</TabsTriggerLine>
          <TabsTriggerLine value="discrepancies">Discrepancies</TabsTriggerLine>
          <TabsTriggerLine value="revenue">Revenue</TabsTriggerLine>
          <TabsTriggerLine value="profitability">Profitability</TabsTriggerLine>
          <TabsTriggerLine value="costs">Costs</TabsTriggerLine>
        </TabsListLine>

        {/* Date range filter + Search */}
        <div className="flex items-center gap-3 mt-4">
          <div className="flex items-center gap-2 flex-1 min-w-0">
            {DATE_PRESETS.map((preset) => (
              <Button
                key={preset.value}
                variant={datePreset === preset.value ? 'default' : 'outline'}
                size="sm"
                className="h-8 shrink-0"
                onClick={() => setDatePreset(preset.value)}
              >
                {preset.label}
              </Button>
            ))}
            {datePreset === 'custom' && (
              <div className="flex items-center gap-2 shrink-0">
                <Popover>
                  <PopoverTrigger asChild>
                    <Button variant="outline" size="sm" className="h-8 gap-2">
                      <CalendarIcon className="h-4 w-4" />
                      {customStart ? format(customStart, 'MMM d, yyyy') : 'Start'}
                    </Button>
                  </PopoverTrigger>
                  <PopoverContent className="w-auto p-0" align="start">
                    <Calendar mode="single" selected={customStart} onSelect={setCustomStart} />
                  </PopoverContent>
                </Popover>
                <span className="text-muted-foreground text-sm">to</span>
                <Popover>
                  <PopoverTrigger asChild>
                    <Button variant="outline" size="sm" className="h-8 gap-2">
                      <CalendarIcon className="h-4 w-4" />
                      {customEnd ? format(customEnd, 'MMM d, yyyy') : 'End'}
                    </Button>
                  </PopoverTrigger>
                  <PopoverContent className="w-auto p-0" align="start">
                    <Calendar mode="single" selected={customEnd} onSelect={setCustomEnd} />
                  </PopoverContent>
                </Popover>
              </div>
            )}
          </div>

          {/* Search bar */}
          <div className="relative w-64 shrink-0">
            <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
            <Input
              placeholder="Search loads, invoices..."
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              className="pl-9 h-8"
            />
          </div>
        </div>

        {/* Tab content */}
        <div className="mt-4 flex min-h-0 flex-1 flex-col">
          <TabsContent value="receivables" className="min-h-0">
            <ReceivablesTab {...tabProps} />
          </TabsContent>

          <TabsContent value="discrepancies" className="min-h-0">
            <DiscrepanciesTab {...tabProps} />
          </TabsContent>

          <TabsContent value="revenue" className="min-h-0">
            <RevenueTab {...tabProps} />
          </TabsContent>

          <TabsContent value="profitability" className="min-h-0">
            <ProfitabilityTab {...tabProps} />
          </TabsContent>

          <TabsContent value="costs" className="min-h-0">
            <CostsTab {...tabProps} />
          </TabsContent>
        </div>
      </Tabs>
    </div>
  );
}
