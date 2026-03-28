'use client';

import { useMemo, useState } from 'react';
import { useAuthQuery } from '@/hooks/use-auth-query';
import { api } from '@/convex/_generated/api';
import { Id } from '@/convex/_generated/dataModel';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { DollarSign, ChevronDown, ChevronRight, Clock, Users, AlertTriangle } from 'lucide-react';

interface CostBreakdownTabProps {
  organizationId: string;
  activeSessionId: string | null;
}

export function CostBreakdownTab({ organizationId, activeSessionId }: CostBreakdownTabProps) {
  const session = useAuthQuery(
    api.laneAnalyzer.getSession,
    activeSessionId ? { id: activeSessionId as Id<'laneAnalysisSessions'> } : 'skip',
  );

  const entries = useAuthQuery(
    api.laneAnalyzer.listEntries,
    activeSessionId ? { sessionId: activeSessionId as Id<'laneAnalysisSessions'> } : 'skip',
  );

  const results = useAuthQuery(
    api.laneAnalyzer.getResults,
    activeSessionId ? { sessionId: activeSessionId as Id<'laneAnalysisSessions'> } : 'skip',
  );

  const perLaneResults = results?.filter((r) => r.resultType === 'PER_LANE') ?? [];
  const aggregateResult = results?.find((r) => r.resultType === 'AGGREGATE');

  const tableData = useMemo(() => {
    if (!entries || !perLaneResults.length) return [];

    return entries.map((entry) => {
      const result = perLaneResults.find((r) => r.entryId === entry._id);
      return {
        id: entry._id,
        name: entry.name,
        origin: `${entry.originCity}, ${entry.originState}`,
        destination: `${entry.destinationCity}, ${entry.destinationState}`,
        miles: entry.routeMiles ?? 0,
        annualRuns: result?.annualRunCount ?? 0,
        fuelPerRun: result?.fuelCostPerRun ?? 0,
        tollPerRun: result?.tollCostPerRun ?? 0,
        driverPayPerRun: result?.driverPayPerRun ?? 0,
        totalPerRun: result?.totalCostPerRun ?? 0,
        revenuePerRun: result?.revenuePerRun ?? 0,
        marginPerRun: result?.marginPerRun ?? 0,
        marginPercent: result?.marginPercent ?? 0,
        costPerYear: result?.costPerYear ?? 0,
        revenuePerYear: result?.revenuePerYear ?? 0,
        requiresTeam: result?.requiresTeamDrivers ?? false,
        hosAnalysis: result?.hosAnalysis ? (() => { try { return JSON.parse(result.hosAnalysis!); } catch { return null; } })() : null,
        durationHours: entry.routeDurationHours ?? 0,
        equipmentClass: entry.equipmentClass ?? 'Dry Van',
        isCityRoute: entry.isCityRoute,
        activeDays: entry.scheduleRule.activeDays,
      };
    });
  }, [entries, perLaneResults]);

  const [expandedRow, setExpandedRow] = useState<string | null>(null);

  if (!activeSessionId) {
    return (
      <div className="flex flex-col items-center justify-center py-20 text-center">
        <DollarSign className="h-12 w-12 text-muted-foreground mb-4" />
        <h3 className="text-lg font-medium">Select a session to view cost breakdown</h3>
      </div>
    );
  }

  if (!results?.length) {
    return (
      <div className="flex flex-col items-center justify-center py-20 text-center">
        <DollarSign className="h-12 w-12 text-muted-foreground mb-4" />
        <h3 className="text-lg font-medium">No analysis results yet</h3>
        <p className="text-muted-foreground mt-1">Run the analysis from the Bid Calculator tab first.</p>
      </div>
    );
  }

  return (
    <div className="space-y-6">
      {/* Per-Lane Cost Table */}
      <Card>
        <CardHeader>
          <CardTitle>Per-Lane Cost Breakdown</CardTitle>
        </CardHeader>
        <CardContent>
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b text-left">
                  <th className="pb-2 pr-4 font-medium">Lane</th>
                  <th className="pb-2 pr-4 font-medium text-right">Miles</th>
                  <th className="pb-2 pr-4 font-medium text-right">Runs/yr</th>
                  <th className="pb-2 pr-4 font-medium text-right">Fuel</th>
                  <th className="pb-2 pr-4 font-medium text-right">Tolls</th>
                  <th className="pb-2 pr-4 font-medium text-right">Driver Pay</th>
                  <th className="pb-2 pr-4 font-medium text-right">Cost/Run</th>
                  <th className="pb-2 pr-4 font-medium text-right">Revenue/Run</th>
                  <th className="pb-2 pr-4 font-medium text-right">Margin</th>
                  <th className="pb-2 pr-4 font-medium text-right">Annual Cost</th>
                </tr>
              </thead>
                {tableData.map((row) => (
                  <tbody key={row.id}>
                    <tr
                      className="border-b cursor-pointer hover:bg-accent/50"
                      onClick={() => setExpandedRow(expandedRow === row.id ? null : row.id)}
                    >
                      <td className="py-2 pr-4">
                        <div className="flex items-center gap-1">
                          {expandedRow === row.id ? (
                            <ChevronDown className="h-3 w-3 shrink-0" />
                          ) : (
                            <ChevronRight className="h-3 w-3 shrink-0" />
                          )}
                          <div>
                            <div className="font-medium">{row.name}</div>
                            <div className="text-xs text-muted-foreground">
                              {row.origin} → {row.destination}
                            </div>
                          </div>
                        </div>
                      </td>
                      <td className="py-2 pr-4 text-right tabular-nums">{row.miles.toLocaleString()}</td>
                      <td className="py-2 pr-4 text-right tabular-nums">{row.annualRuns}</td>
                      <td className="py-2 pr-4 text-right tabular-nums">${row.fuelPerRun.toFixed(0)}</td>
                      <td className="py-2 pr-4 text-right tabular-nums">${row.tollPerRun.toFixed(0)}</td>
                      <td className="py-2 pr-4 text-right tabular-nums">${row.driverPayPerRun.toFixed(0)}</td>
                      <td className="py-2 pr-4 text-right tabular-nums font-medium">${row.totalPerRun.toFixed(0)}</td>
                      <td className="py-2 pr-4 text-right tabular-nums">${row.revenuePerRun.toFixed(0)}</td>
                      <td className="py-2 pr-4 text-right">
                        <Badge
                          variant={row.marginPercent > 15 ? 'default' : row.marginPercent > 5 ? 'secondary' : 'destructive'}
                          className="tabular-nums"
                        >
                          {row.marginPercent.toFixed(1)}%
                        </Badge>
                        {row.requiresTeam && (
                          <Badge variant="outline" className="ml-1 text-xs">Team</Badge>
                        )}
                      </td>
                      <td className="py-2 pr-4 text-right tabular-nums font-medium">
                        ${row.costPerYear.toLocaleString('en-US', { maximumFractionDigits: 0 })}
                      </td>
                    </tr>
                    {/* HOS Detail Row */}
                    {expandedRow === row.id && (
                      <tr className="border-b bg-muted/30">
                        <td colSpan={10} className="py-3 px-6">
                          <div className="grid grid-cols-4 gap-4 text-sm">
                            <div>
                              <div className="flex items-center gap-1 text-muted-foreground mb-1">
                                <Clock className="h-3 w-3" /> HOS Analysis
                              </div>
                              {row.hosAnalysis ? (
                                <div className="space-y-1">
                                  <div>Drive time: <strong>{row.hosAnalysis.driveTimePerRun?.toFixed(1)}h</strong></div>
                                  <div>Dwell time: <strong>{(row.hosAnalysis.dwellTimeTotal ?? 0).toFixed(1)}h</strong> <span className="text-muted-foreground text-[10px]">(loading/unloading at stops)</span></div>
                                  <div>Pre/post trip: <strong>{(row.hosAnalysis.prePostTripTime ?? 1.0).toFixed(1)}h</strong></div>
                                  <div>
                                    Duty time: <strong>{row.hosAnalysis.dutyTimePerRun?.toFixed(1)}h</strong>
                                    <span className="text-muted-foreground ml-1 text-[10px]">
                                      ({row.hosAnalysis.driveTimePerRun?.toFixed(1)} + {(row.hosAnalysis.dwellTimeTotal ?? 0).toFixed(1)} + {(row.hosAnalysis.prePostTripTime ?? 1.0).toFixed(1)} + {((row.hosAnalysis.breaksNeeded ?? 0) * 0.5).toFixed(1)} breaks)
                                    </span>
                                  </div>
                                  <div>Cycle time: <strong>{row.hosAnalysis.cycleTimeHours?.toFixed(1)}h</strong> <span className="text-muted-foreground text-[10px]">(duty + 10h off-duty)</span></div>
                                  <div>Max runs/shift: <strong>{row.hosAnalysis.maxDailyRuns}</strong></div>
                                  <div>Breaks needed: <strong>{row.hosAnalysis.breaksNeeded}</strong></div>
                                  {row.hosAnalysis.borderlineTeam && (
                                    <div className="flex items-center gap-1 text-amber-600">
                                      <AlertTriangle className="h-3 w-3" /> Borderline — near solo limit
                                    </div>
                                  )}
                                </div>
                              ) : (
                                <div className="text-muted-foreground">Run analysis to see HOS details</div>
                              )}
                            </div>
                            <div>
                              <div className="flex items-center gap-1 text-muted-foreground mb-1">
                                <Users className="h-3 w-3" /> Driver Requirement
                              </div>
                              <div className="space-y-1">
                                <div>Type: <strong>{row.requiresTeam ? 'Team (2 drivers)' : 'Solo'}</strong></div>
                                <div>Max runs/day: <strong>{row.hosAnalysis?.maxDailyRuns ?? '?'}</strong></div>
                              </div>
                            </div>
                            <div>
                              <div className="text-muted-foreground mb-1">Route Info</div>
                              <div className="space-y-1">
                                <div>Equipment: <strong>{row.equipmentClass}</strong></div>
                                <div>Duration: <strong>{row.durationHours.toFixed(1)}h</strong></div>
                                <div>MPG: <strong>{row.isCityRoute ? `City (${session?.defaultMpgCity ?? 10})` : `Highway (${session?.defaultMpgHighway ?? 6})`}</strong></div>
                              </div>
                            </div>
                            <div>
                              <div className="text-muted-foreground mb-1">Cost Breakdown / Run</div>
                              <div className="space-y-1">
                                <div>
                                  Fuel: <strong>${row.fuelPerRun.toFixed(2)}</strong>
                                  <span className="text-[10px] text-muted-foreground ml-1">
                                    ({row.miles} mi ÷ {row.isCityRoute ? (session?.defaultMpgCity ?? 10) : (session?.defaultMpgHighway ?? 6)} mpg × ${(session?.defaultFuelPricePerGallon ?? 4.0).toFixed(2)}/gal)
                                  </span>
                                </div>
                                <div>Tolls: <strong>${row.tollPerRun.toFixed(2)}</strong></div>
                                <div>
                                  Driver: <strong>${row.driverPayPerRun.toFixed(2)}</strong>
                                  <span className="text-[10px] text-muted-foreground ml-1">
                                    (${session?.defaultDriverPayRate ?? 0}{session?.defaultDriverPayType === 'PER_MILE' ? '/mi' : session?.defaultDriverPayType === 'PER_HOUR' ? '/hr' : '/run'}
                                    {session?.defaultDriverPayType === 'PER_MILE' && ` × ${row.miles} mi`}
                                    {session?.defaultDriverPayType === 'PER_HOUR' && ` × ${row.hosAnalysis?.dutyTimePerRun?.toFixed(1) ?? '?'}h`})
                                  </span>
                                </div>
                                <div className="border-t pt-1 font-medium">Total: ${row.totalPerRun.toFixed(2)}</div>
                                <div>Revenue: ${row.revenuePerRun.toFixed(2)}</div>
                                <div className={row.marginPerRun > 0 ? 'text-green-600' : 'text-red-600'}>
                                  Profit: ${row.marginPerRun.toFixed(2)}/run
                                </div>
                              </div>
                            </div>
                          </div>
                        </td>
                      </tr>
                    )}
                  </tbody>
                ))}

              {/* Totals row */}
              {aggregateResult && (
                <tfoot>
                  <tr className="border-t-2 font-bold">
                    <td className="py-2 pr-4">Total</td>
                    <td className="py-2 pr-4 text-right tabular-nums">
                      {tableData.reduce((sum, r) => sum + r.miles, 0).toLocaleString()}
                    </td>
                    <td className="py-2 pr-4 text-right tabular-nums">{aggregateResult.annualRunCount}</td>
                    <td colSpan={4} />
                    <td className="py-2 pr-4 text-right tabular-nums">
                      ${(aggregateResult.revenuePerYear ?? 0).toLocaleString('en-US', { maximumFractionDigits: 0 })}
                    </td>
                    <td className="py-2 pr-4 text-right">
                      <Badge
                        variant={(aggregateResult.marginPercent ?? 0) > 15 ? 'default' : 'secondary'}
                      >
                        {(aggregateResult.marginPercent ?? 0).toFixed(1)}%
                      </Badge>
                    </td>
                    <td className="py-2 pr-4 text-right tabular-nums">
                      ${(aggregateResult.costPerYear ?? 0).toLocaleString('en-US', { maximumFractionDigits: 0 })}
                    </td>
                  </tr>
                </tfoot>
              )}
            </table>
          </div>
        </CardContent>
      </Card>
    </div>
  );
}
