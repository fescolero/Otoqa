'use client';

import { useState } from 'react';
import { Tabs, TabsContent, TabsListLine, TabsTriggerLine } from '@/components/ui/tabs';
import { BidCalculatorTab } from './tabs/bid-calculator-tab';
import { ScheduleViewTab } from './tabs/schedule-view-tab';
import { CostBreakdownTab } from './tabs/cost-breakdown-tab';
import { BaseOptimizationTab } from './tabs/base-optimization-tab';
import { LaneAnalysisTab } from './tabs/lane-analysis-tab';

interface LaneAnalyzerDashboardProps {
  organizationId: string;
  userId: string;
}

export function LaneAnalyzerDashboard({ organizationId, userId }: LaneAnalyzerDashboardProps) {
  const [activeTab, setActiveTab] = useState('bid-calculator');
  const [activeSessionId, setActiveSessionId] = useState<string | null>(null);

  return (
    <div className="flex h-full min-h-0 w-full flex-col gap-4 p-6 overflow-hidden">
      <div>
        <h1 className="text-3xl font-bold tracking-tight">Lane Analyzer</h1>
        <p className="text-muted-foreground mt-1">
          Bid on new contract lanes and optimize existing routes
        </p>
      </div>

      <Tabs
        value={activeTab}
        onValueChange={setActiveTab}
        className="flex min-h-0 w-full flex-1 flex-col"
      >
        <TabsListLine className="w-full">
          <TabsTriggerLine value="bid-calculator">Bid Calculator</TabsTriggerLine>
          <TabsTriggerLine value="schedule">Schedule</TabsTriggerLine>
          <TabsTriggerLine value="cost-breakdown">Cost Breakdown</TabsTriggerLine>
          <TabsTriggerLine value="base-optimization">
            Base Optimization
          </TabsTriggerLine>
          <TabsTriggerLine value="lane-analysis">
            Lane Analysis
          </TabsTriggerLine>
        </TabsListLine>

        <div className="mt-4 flex min-h-0 w-full flex-1 flex-col overflow-auto">
          <TabsContent value="bid-calculator" className="min-h-0 w-full flex-1">
            <BidCalculatorTab
              organizationId={organizationId}
              userId={userId}
              activeSessionId={activeSessionId}
              onSessionChange={setActiveSessionId}
            />
          </TabsContent>

          <TabsContent value="schedule" className="min-h-0 w-full flex-1">
            <ScheduleViewTab
              organizationId={organizationId}
              activeSessionId={activeSessionId}
            />
          </TabsContent>

          <TabsContent value="cost-breakdown" className="min-h-0 w-full flex-1">
            <CostBreakdownTab
              organizationId={organizationId}
              activeSessionId={activeSessionId}
            />
          </TabsContent>

          <TabsContent value="base-optimization" className="min-h-0 w-full flex-1">
            <BaseOptimizationTab
              organizationId={organizationId}
              userId={userId}
              activeSessionId={activeSessionId}
            />
          </TabsContent>

          <TabsContent value="lane-analysis" className="min-h-0 w-full flex-1">
            <LaneAnalysisTab organizationId={organizationId} />
          </TabsContent>
        </div>
      </Tabs>
    </div>
  );
}
