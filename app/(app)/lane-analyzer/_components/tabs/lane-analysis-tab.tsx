'use client';

import { useState, useMemo } from 'react';
import { useAuthQuery } from '@/hooks/use-auth-query';
import { api } from '@/convex/_generated/api';
import { Id } from '@/convex/_generated/dataModel';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import {
  BarChart3,
  TrendingUp,
  TrendingDown,
  AlertTriangle,
  Search,
  ChevronDown,
  ChevronRight,
} from 'lucide-react';
import { startOfMonth, subMonths, format } from 'date-fns';

interface LaneAnalysisTabProps {
  organizationId: string;
}

const FLAG_LABELS: Record<string, { label: string; variant: 'default' | 'secondary' | 'destructive' | 'outline' }> = {
  UNDERPERFORMING: { label: 'Underperforming', variant: 'destructive' },
  PROFITABLE: { label: 'Profitable', variant: 'default' },
  HIGH_DEADHEAD: { label: 'High Deadhead', variant: 'secondary' },
  RATE_MISMATCH: { label: 'Rate Mismatch', variant: 'outline' },
  LOW_SAMPLE_SIZE: { label: 'Low Data', variant: 'outline' },
  NO_DATA: { label: 'No Data', variant: 'outline' },
};

export function LaneAnalysisTab({ organizationId }: LaneAnalysisTabProps) {
  const [selectedCustomerId, setSelectedCustomerId] = useState<string>('');
  const handleCustomerChange = (id: string) => {
    setSelectedCustomerId(id);
    setLanePage(0);
  };
  const [searchQuery, setSearchQuery] = useState('');
  const [expandedLane, setExpandedLane] = useState<string | null>(null);
  const [dateRange] = useState(() => {
    const end = new Date();
    const start = subMonths(startOfMonth(end), 6);
    return {
      start: format(start, 'yyyy-MM-dd'),
      end: format(end, 'yyyy-MM-dd'),
    };
  });

  // Get customers
  const customers = useAuthQuery(api.customers.list, {
    workosOrgId: organizationId,
  });

  // Get contract lanes for selected customer
  const contractLanes = useAuthQuery(
    api.contractLanes.listByCustomer,
    selectedCustomerId
      ? { customerCompanyId: selectedCustomerId as Id<'customers'> }
      : 'skip',
  );

  // Get lane IDs for performance analysis (paginate in batches of 10)
  const [lanePage, setLanePage] = useState(0);
  const PAGE_SIZE = 10;

  const allLaneIds = useMemo(() => {
    if (!contractLanes) return [];
    return contractLanes.map((l) => l._id);
  }, [contractLanes]);

  const pagedLaneIds = useMemo(() => {
    return allLaneIds.slice(lanePage * PAGE_SIZE, (lanePage + 1) * PAGE_SIZE);
  }, [allLaneIds, lanePage]);

  const totalPages = Math.ceil(allLaneIds.length / PAGE_SIZE);

  // Run performance analysis for current page of lanes
  const performanceData = useAuthQuery(
    api.laneAnalyzerOptimization.analyzeLanePerformance,
    pagedLaneIds.length > 0
      ? {
          workosOrgId: organizationId,
          contractLaneIds: pagedLaneIds as Id<'contractLanes'>[],
          dateRangeStart: dateRange.start,
          dateRangeEnd: dateRange.end,
        }
      : 'skip',
  );

  // Filter by search
  const filteredData = useMemo(() => {
    if (!performanceData) return [];
    if (!searchQuery) return performanceData;
    const q = searchQuery.toLowerCase();
    return performanceData.filter(
      (d) =>
        d.laneName.toLowerCase().includes(q) ||
        d.hcr.toLowerCase().includes(q) ||
        d.tripNumber.toLowerCase().includes(q),
    );
  }, [performanceData, searchQuery]);

  // Summary stats
  const summary = useMemo(() => {
    if (!performanceData || performanceData.length === 0) return null;
    const withData = performanceData.filter((d) => d.totalRuns > 0);
    return {
      totalLanes: performanceData.length,
      lanesWithData: withData.length,
      totalRevenue: withData.reduce((s, d) => s + d.metrics.totalRevenue, 0),
      totalCost: withData.reduce((s, d) => s + d.metrics.totalCost, 0),
      totalProfit: withData.reduce((s, d) => s + d.metrics.totalProfit, 0),
      totalRuns: withData.reduce((s, d) => s + d.totalRuns, 0),
      avgMargin: (() => {
        const rev = withData.reduce((s, d) => s + d.metrics.totalRevenue, 0);
        const cost = withData.reduce((s, d) => s + d.metrics.totalCost, 0);
        return rev > 0 ? ((rev - cost) / rev) * 100 : 0;
      })(),
      underperforming: withData.filter((d) => d.flags.includes('UNDERPERFORMING')).length,
      profitable: withData.filter((d) => d.flags.includes('PROFITABLE')).length,
      rateMismatch: withData.filter((d) => d.flags.includes('RATE_MISMATCH')).length,
    };
  }, [performanceData]);

  return (
    <div className="space-y-6">
      {/* Controls */}
      <div className="flex items-center gap-3">
        <div>
          <Label className="text-xs text-muted-foreground">Customer</Label>
          <Select value={selectedCustomerId} onValueChange={handleCustomerChange}>
            <SelectTrigger className="w-[250px]">
              <SelectValue placeholder="Select customer..." />
            </SelectTrigger>
            <SelectContent>
              {customers?.map((c) => (
                <SelectItem key={c._id} value={c._id}>
                  {c.name}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>

        <div>
          <Label className="text-xs text-muted-foreground">Date Range</Label>
          <div className="text-sm font-medium">
            {dateRange.start} → {dateRange.end}
          </div>
        </div>

        {selectedCustomerId && (
          <div className="flex-1">
            <Label className="text-xs text-muted-foreground">Search</Label>
            <div className="relative">
              <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
              <Input
                placeholder="Search by name, HCR, trip..."
                value={searchQuery}
                onChange={(e) => setSearchQuery(e.target.value)}
                className="pl-9 h-9"
              />
            </div>
          </div>
        )}
      </div>

      {/* No customer selected */}
      {!selectedCustomerId && (
        <div className="flex flex-col items-center justify-center py-20 text-center">
          <BarChart3 className="h-12 w-12 text-muted-foreground mb-4" />
          <h3 className="text-lg font-medium">Select a customer to analyze lanes</h3>
          <p className="text-muted-foreground mt-1">
            Compare actual performance vs contract rates for existing lanes
          </p>
        </div>
      )}

      {/* Summary Cards */}
      {summary && (
        <div className="grid grid-cols-5 gap-3">
          <Card>
            <CardContent className="pt-4 pb-3">
              <div className="text-xs text-muted-foreground">Total Revenue</div>
              <div className="text-lg font-bold">${summary.totalRevenue.toLocaleString('en-US', { maximumFractionDigits: 0 })}</div>
              <div className="text-xs text-muted-foreground">{summary.totalRuns} runs</div>
            </CardContent>
          </Card>
          <Card>
            <CardContent className="pt-4 pb-3">
              <div className="text-xs text-muted-foreground">Total Cost</div>
              <div className="text-lg font-bold">${summary.totalCost.toLocaleString('en-US', { maximumFractionDigits: 0 })}</div>
            </CardContent>
          </Card>
          <Card>
            <CardContent className="pt-4 pb-3">
              <div className="text-xs text-muted-foreground">Total Profit</div>
              <div className={`text-lg font-bold ${summary.totalProfit > 0 ? 'text-green-600' : 'text-red-600'}`}>
                ${summary.totalProfit.toLocaleString('en-US', { maximumFractionDigits: 0 })}
              </div>
            </CardContent>
          </Card>
          <Card>
            <CardContent className="pt-4 pb-3">
              <div className="text-xs text-muted-foreground">Avg Margin</div>
              <div className={`text-lg font-bold ${summary.avgMargin > 15 ? 'text-green-600' : summary.avgMargin > 5 ? 'text-yellow-600' : 'text-red-600'}`}>
                {summary.avgMargin.toFixed(1)}%
              </div>
            </CardContent>
          </Card>
          <Card>
            <CardContent className="pt-4 pb-3">
              <div className="text-xs text-muted-foreground">Flags</div>
              <div className="flex gap-1 mt-1 flex-wrap">
                {summary.underperforming > 0 && (
                  <Badge variant="destructive" className="text-xs">{summary.underperforming} low margin</Badge>
                )}
                {summary.rateMismatch > 0 && (
                  <Badge variant="outline" className="text-xs">{summary.rateMismatch} rate mismatch</Badge>
                )}
                {summary.profitable > 0 && (
                  <Badge variant="default" className="text-xs">{summary.profitable} strong</Badge>
                )}
              </div>
            </CardContent>
          </Card>
        </div>
      )}

      {/* Lane Performance Table */}
      {filteredData.length > 0 && (
        <Card>
          <CardHeader>
            <div className="flex items-center justify-between">
              <CardTitle>Lane Performance ({filteredData.length} of {allLaneIds.length})</CardTitle>
              {totalPages > 1 && (
                <div className="flex items-center gap-2 text-sm">
                  <Button
                    variant="outline"
                    size="sm"
                    disabled={lanePage === 0}
                    onClick={() => setLanePage((p) => Math.max(0, p - 1))}
                  >
                    Prev
                  </Button>
                  <span className="text-muted-foreground">
                    Page {lanePage + 1} of {totalPages}
                  </span>
                  <Button
                    variant="outline"
                    size="sm"
                    disabled={lanePage >= totalPages - 1}
                    onClick={() => setLanePage((p) => Math.min(totalPages - 1, p + 1))}
                  >
                    Next
                  </Button>
                </div>
              )}
            </div>
            <CardDescription>
              Historical actual costs vs contract rates for {dateRange.start} to {dateRange.end}
            </CardDescription>
          </CardHeader>
          <CardContent>
            <div className="space-y-1">
              {filteredData.map((lane) => (
                <div key={lane.contractLaneId} className="border rounded-lg">
                  {/* Summary Row */}
                  <div
                    className="flex items-center justify-between p-3 cursor-pointer hover:bg-accent/50"
                    onClick={() => setExpandedLane(expandedLane === lane.contractLaneId ? null : lane.contractLaneId)}
                  >
                    <div className="flex items-center gap-2 flex-1">
                      {expandedLane === lane.contractLaneId ? (
                        <ChevronDown className="h-4 w-4 shrink-0" />
                      ) : (
                        <ChevronRight className="h-4 w-4 shrink-0" />
                      )}
                      <div>
                        <div className="font-medium text-sm">
                          {lane.laneName}
                          {lane.hcr && (
                            <span className="text-muted-foreground ml-2 font-normal">
                              HCR: {lane.hcr}{lane.tripNumber && `/${lane.tripNumber}`}
                            </span>
                          )}
                        </div>
                        <div className="text-xs text-muted-foreground">
                          {lane.totalRuns} runs • {lane.metrics.totalMiles.toLocaleString()} mi
                        </div>
                      </div>
                    </div>

                    <div className="flex items-center gap-3">
                      {/* Revenue/Run */}
                      <div className="text-right">
                        <div className="text-xs text-muted-foreground">Rev/Run</div>
                        <div className="text-sm tabular-nums">${lane.metrics.avgRevenuePerRun.toFixed(0)}</div>
                      </div>
                      {/* Cost/Run */}
                      <div className="text-right">
                        <div className="text-xs text-muted-foreground">Cost/Run</div>
                        <div className="text-sm tabular-nums">${lane.metrics.avgCostPerRun.toFixed(0)}</div>
                      </div>
                      {/* Margin */}
                      <Badge
                        variant={
                          lane.metrics.avgMarginPercent > 15 ? 'default' :
                          lane.metrics.avgMarginPercent > 5 ? 'secondary' : 'destructive'
                        }
                        className="tabular-nums min-w-[60px] justify-center"
                      >
                        {lane.metrics.avgMarginPercent > 0 ? (
                          <TrendingUp className="h-3 w-3 mr-1" />
                        ) : (
                          <TrendingDown className="h-3 w-3 mr-1" />
                        )}
                        {lane.metrics.avgMarginPercent.toFixed(1)}%
                      </Badge>
                      {/* Flags */}
                      {lane.flags.map((flag) => {
                        const config = FLAG_LABELS[flag];
                        if (!config || flag === 'PROFITABLE') return null;
                        return (
                          <Badge key={flag} variant={config.variant} className="text-xs">
                            {flag === 'UNDERPERFORMING' && <AlertTriangle className="h-3 w-3 mr-1" />}
                            {config.label}
                          </Badge>
                        );
                      })}
                    </div>
                  </div>

                  {/* Expanded Detail */}
                  {expandedLane === lane.contractLaneId && (
                    <div className="border-t px-4 py-3 bg-muted/20 space-y-4">
                      <div className="grid grid-cols-4 gap-4 text-sm">
                        {/* Financial Summary */}
                        <div>
                          <div className="text-muted-foreground mb-1 font-medium">Financial Summary</div>
                          <div className="space-y-1">
                            <div>Total Revenue: <strong>${lane.metrics.totalRevenue.toLocaleString('en-US', { maximumFractionDigits: 0 })}</strong></div>
                            <div>Total Cost: <strong>${lane.metrics.totalCost.toLocaleString('en-US', { maximumFractionDigits: 0 })}</strong></div>
                            <div className={lane.metrics.totalProfit > 0 ? 'text-green-600' : 'text-red-600'}>
                              Total Profit: <strong>${lane.metrics.totalProfit.toLocaleString('en-US', { maximumFractionDigits: 0 })}</strong>
                            </div>
                          </div>
                        </div>

                        {/* Per-Mile Metrics */}
                        <div>
                          <div className="text-muted-foreground mb-1 font-medium">Per-Mile</div>
                          <div className="space-y-1">
                            <div>Revenue/mi: <strong>${lane.metrics.avgRevenuePerMile.toFixed(2)}</strong></div>
                            <div>Cost/mi: <strong>${lane.metrics.avgCostPerMile.toFixed(2)}</strong></div>
                          </div>
                        </div>

                        {/* Rate Comparison */}
                        <div>
                          <div className="text-muted-foreground mb-1 font-medium">Rate Comparison</div>
                          <div className="space-y-1">
                            <div>Expected Rev/Run: <strong>${lane.comparison.expectedRevenuePerRun.toFixed(0)}</strong></div>
                            <div>Actual Rev/Run: <strong>${lane.metrics.avgRevenuePerRun.toFixed(0)}</strong></div>
                            <div className={Math.abs(lane.comparison.revenueVariance) > 15 ? 'text-amber-600' : ''}>
                              Variance: <strong>{lane.comparison.revenueVariance > 0 ? '+' : ''}{lane.comparison.revenueVariance.toFixed(1)}%</strong>
                            </div>
                          </div>
                        </div>

                        {/* Monthly Trend */}
                        <div>
                          <div className="text-muted-foreground mb-1 font-medium">Monthly Trend</div>
                          <div className="space-y-1">
                            {lane.trend.slice(-4).map((t) => (
                              <div key={t.month} className="flex items-center justify-between text-xs">
                                <span>{t.month}</span>
                                <span className="tabular-nums">{t.runs} runs</span>
                                <Badge
                                  variant={t.margin > 15 ? 'default' : t.margin > 5 ? 'secondary' : 'destructive'}
                                  className="text-xs tabular-nums"
                                >
                                  {t.margin.toFixed(0)}%
                                </Badge>
                              </div>
                            ))}
                          </div>
                        </div>
                      </div>
                    </div>
                  )}
                </div>
              ))}
            </div>
          </CardContent>
        </Card>
      )}

      {/* Loading / Empty states */}
      {selectedCustomerId && !performanceData && (
        <div className="text-center py-12 text-muted-foreground">Loading lane performance data...</div>
      )}
      {selectedCustomerId && performanceData && filteredData.length === 0 && (
        <div className="text-center py-12 text-muted-foreground">
          No contract lanes found for this customer{searchQuery && ' matching your search'}.
        </div>
      )}
    </div>
  );
}
