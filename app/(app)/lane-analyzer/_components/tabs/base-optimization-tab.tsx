'use client';

import { useState, useMemo } from 'react';
import { useAction } from 'convex/react';
import { useAuthQuery } from '@/hooks/use-auth-query';
import { api } from '@/convex/_generated/api';
import { Id } from '@/convex/_generated/dataModel';
import { Button } from '@/components/ui/button';
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { toast } from 'sonner';
import {
  MapPin,
  Plus,
  Loader2,
  ArrowRight,
  Warehouse,
  ParkingCircle,
  TrendingDown,
  AlertTriangle,
  Users,
} from 'lucide-react';
import { BaseForm } from '../shared/base-form';

interface BaseOptimizationTabProps {
  organizationId: string;
  userId: string;
  activeSessionId: string | null;
}

export function BaseOptimizationTab({
  organizationId,
  userId,
  activeSessionId,
}: BaseOptimizationTabProps) {
  const [showAddBase, setShowAddBase] = useState(false);
  const [isOptimizing, setIsOptimizing] = useState(false);

  const bases = useAuthQuery(
    api.laneAnalyzer.listBases,
    activeSessionId
      ? { workosOrgId: organizationId, sessionId: activeSessionId as Id<'laneAnalysisSessions'> }
      : { workosOrgId: organizationId },
  );

  const entries = useAuthQuery(
    api.laneAnalyzer.listEntries,
    activeSessionId
      ? { sessionId: activeSessionId as Id<'laneAnalysisSessions'> }
      : 'skip',
  );

  const optimizationResults = useAuthQuery(
    api.laneAnalyzerOptimization.getOptimizationResults,
    activeSessionId
      ? { sessionId: activeSessionId as Id<'laneAnalysisSessions'> }
      : 'skip',
  );

  // Parse base optimization result
  const baseOptResult = useMemo(() => {
    if (!optimizationResults) return null;
    const baseResult = optimizationResults.find(
      (r) => r.suggestionType === 'CHANGE_BASE',
    );
    if (!baseResult?.suggestionDetails) return null;
    try {
      return JSON.parse(baseResult.suggestionDetails);
    } catch {
      return null;
    }
  }, [optimizationResults]);

  // Parse lane pairing suggestions
  const lanePairSuggestions = useMemo(() => {
    if (!optimizationResults) return [];
    return optimizationResults
      .filter((r) => r.suggestionType === 'COMBINE_LANES')
      .map((r) => {
        try {
          return JSON.parse(r.suggestionDetails!);
        } catch {
          return null;
        }
      })
      .filter(Boolean);
  }, [optimizationResults]);

  const handleRunOptimization = async () => {
    // Optimization runs as part of the analysis pipeline
    // For now, show a message to run the full analysis
    toast.info('Run the full analysis from the Bid Calculator tab to generate optimization suggestions');
  };

  if (!activeSessionId) {
    return (
      <div className="flex flex-col items-center justify-center py-20 text-center">
        <MapPin className="h-12 w-12 text-muted-foreground mb-4" />
        <h3 className="text-lg font-medium">Select a session to optimize bases</h3>
      </div>
    );
  }

  const baseTypeIcon = (type: string) => {
    switch (type) {
      case 'YARD': return <Warehouse className="h-4 w-4" />;
      case 'PARKING': return <ParkingCircle className="h-4 w-4" />;
      default: return <MapPin className="h-4 w-4" />;
    }
  };

  return (
    <div className="space-y-6">
      {/* Base Locations */}
      <Card>
        <CardHeader className="flex flex-row items-center justify-between">
          <div>
            <CardTitle>Base Locations ({bases?.length ?? 0})</CardTitle>
            <CardDescription>Yards, relay points, and parking locations</CardDescription>
          </div>
          <Button variant="outline" size="sm" onClick={() => setShowAddBase(true)}>
            <Plus className="h-4 w-4 mr-1" /> Add Base
          </Button>
        </CardHeader>
        <CardContent>
          {!bases?.length ? (
            <div className="text-center py-8 text-muted-foreground">
              No base locations added. Add at least one yard or parking location to analyze deadhead.
            </div>
          ) : (
            <div className="grid grid-cols-2 gap-3">
              {bases.map((base) => (
                <div key={base._id} className="flex items-center gap-3 border rounded-lg p-3">
                  {baseTypeIcon(base.baseType)}
                  <div className="flex-1">
                    <div className="font-medium text-sm">{base.name}</div>
                    <div className="text-xs text-muted-foreground">
                      {base.city}, {base.state}
                      {base.capacity && ` • ${base.capacity} trucks`}
                      {base.monthlyParkingCost && ` • $${base.monthlyParkingCost}/mo`}
                    </div>
                  </div>
                  <Badge variant="outline" className="text-xs">{base.baseType}</Badge>
                </div>
              ))}
            </div>
          )}
        </CardContent>
      </Card>

      {/* Optimization Results: Base Assignments */}
      {baseOptResult && (
        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2">
              <TrendingDown className="h-5 w-5 text-green-600" />
              Base Assignment Optimization
            </CardTitle>
            <CardDescription>
              Optimal base assignments to minimize deadhead costs
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-4">
            {/* Summary */}
            <div className="grid grid-cols-3 gap-4 rounded-lg bg-muted/30 p-4">
              <div>
                <div className="text-sm text-muted-foreground">Current Annual Deadhead Cost</div>
                <div className="text-xl font-bold">
                  ${(baseOptResult.summary.totalCurrentDeadheadCostPerRun * 260).toLocaleString('en-US', { maximumFractionDigits: 0 })}
                </div>
              </div>
              <div>
                <div className="text-sm text-muted-foreground">Optimized Annual Deadhead Cost</div>
                <div className="text-xl font-bold text-green-600">
                  ${(baseOptResult.summary.totalOptimalDeadheadCostPerRun * 260).toLocaleString('en-US', { maximumFractionDigits: 0 })}
                </div>
              </div>
              <div>
                <div className="text-sm text-muted-foreground">Potential Annual Savings</div>
                <div className="text-xl font-bold text-green-600">
                  ${baseOptResult.summary.totalAnnualSavings.toLocaleString('en-US', { maximumFractionDigits: 0 })}
                </div>
              </div>
            </div>

            {/* Capacity Warnings */}
            {baseOptResult.capacityWarnings?.length > 0 && (
              <div className="space-y-2">
                {baseOptResult.capacityWarnings.map((w: { baseId: string; baseName: string; assigned: number; capacity: number }, i: number) => (
                  <div key={i} className="flex items-center gap-2 text-sm text-amber-600 bg-amber-50 dark:bg-amber-950/20 rounded-md px-3 py-2">
                    <AlertTriangle className="h-4 w-4 shrink-0" />
                    <span>
                      <strong>{w.baseName}</strong> has {w.assigned} lanes assigned but capacity for {w.capacity} trucks
                    </span>
                  </div>
                ))}
              </div>
            )}

            {/* Per-Lane Assignments */}
            <div className="space-y-2">
              {baseOptResult.assignments?.map((a: {
                entryId: string; laneName: string;
                currentBaseName: string | null; optimalBaseName: string;
                currentDeadheadMiles: number; optimalDeadheadMiles: number;
                savingsPerRun: number; annualSavings: number;
                hosFeasible: boolean; recommendParking: boolean;
                returnToBaseCost: number; parkingCostPerNight: number;
              }) => (
                <div key={a.entryId} className="flex items-center justify-between border rounded-lg p-3">
                  <div className="flex-1">
                    <div className="font-medium text-sm">{a.laneName}</div>
                    <div className="text-xs text-muted-foreground flex items-center gap-1">
                      {a.currentBaseName && (
                        <>
                          <span>{a.currentBaseName} ({Math.round(a.currentDeadheadMiles)} mi)</span>
                          <ArrowRight className="h-3 w-3" />
                        </>
                      )}
                      <span className="font-medium">{a.optimalBaseName} ({Math.round(a.optimalDeadheadMiles)} mi)</span>
                    </div>
                  </div>
                  <div className="flex items-center gap-2">
                    {a.recommendParking && (
                      <Badge variant="secondary" className="text-xs">
                        <ParkingCircle className="h-3 w-3 mr-1" />
                        Park (${a.parkingCostPerNight}/night vs ${Math.round(a.returnToBaseCost)} return)
                      </Badge>
                    )}
                    {!a.hosFeasible && (
                      <Badge variant="destructive" className="text-xs">
                        <Users className="h-3 w-3 mr-1" /> Team needed (HOS)
                      </Badge>
                    )}
                    {a.savingsPerRun > 0 ? (
                      <Badge variant="default" className="text-xs tabular-nums">
                        Save ${Math.round(a.annualSavings)}/yr
                      </Badge>
                    ) : (
                      <Badge variant="outline" className="text-xs">Optimal</Badge>
                    )}
                  </div>
                </div>
              ))}
            </div>
          </CardContent>
        </Card>
      )}

      {/* Lane Pairing Suggestions */}
      {lanePairSuggestions.length > 0 && (
        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2">
              <ArrowRight className="h-5 w-5 text-blue-600" />
              Lane Pairing Opportunities
            </CardTitle>
            <CardDescription>
              Lanes where one driver can chain both — savings account for deadhead transit cost
            </CardDescription>
          </CardHeader>
          <CardContent>
            <div className="space-y-3">
              {lanePairSuggestions.map((s: {
                laneAId: string; laneAName: string;
                laneBId: string; laneBName: string;
                proximityMiles: number; transitTimeHours: number;
                deadheadSavingsPerRun: number; annualCostSavings: number;
                hosFeasible: boolean; overlappingRunDays: number;
                transitFuelCost?: number; transitDriverCost?: number;
                totalTransitCost?: number;
                separateDriverCostPerRun?: number; combinedDriverCostPerRun?: number;
              }, i: number) => (
                <div key={i} className="border rounded-lg p-3 space-y-2">
                  <div className="flex items-center justify-between">
                    <div className="text-sm">
                      <strong>{s.laneAName}</strong>
                      <span className="text-muted-foreground mx-2">→ {s.proximityMiles} mi →</span>
                      <strong>{s.laneBName}</strong>
                    </div>
                    <div className="flex items-center gap-2">
                      {!s.hosFeasible && (
                        <Badge variant="destructive" className="text-xs">Exceeds HOS</Badge>
                      )}
                      <Badge variant="default" className="text-xs tabular-nums">
                        Save ${Math.round(s.annualCostSavings).toLocaleString()}/yr
                      </Badge>
                    </div>
                  </div>
                  <div className="grid grid-cols-3 gap-4 text-xs text-muted-foreground bg-muted/30 rounded-md p-2">
                    <div>
                      <div className="font-medium text-foreground mb-0.5">Transit Deadhead</div>
                      <div>{s.proximityMiles} mi • {s.transitTimeHours}h</div>
                      {s.transitFuelCost != null && (
                        <div>Fuel: ${s.transitFuelCost.toFixed(2)} • Driver: ${(s.transitDriverCost ?? 0).toFixed(2)}</div>
                      )}
                      {s.totalTransitCost != null && (
                        <div className="font-medium">Total: ${s.totalTransitCost.toFixed(2)}/run</div>
                      )}
                    </div>
                    <div>
                      <div className="font-medium text-foreground mb-0.5">Separate (2 drivers)</div>
                      <div>${(s.separateDriverCostPerRun ?? 0).toFixed(2)}/day</div>
                      <div>{s.overlappingRunDays} shared days/yr</div>
                    </div>
                    <div>
                      <div className="font-medium text-foreground mb-0.5">Combined (1 driver)</div>
                      <div>${(s.combinedDriverCostPerRun ?? 0).toFixed(2)}/day</div>
                      <div className="font-medium text-emerald-600">Save ${s.deadheadSavingsPerRun.toFixed(2)}/day</div>
                    </div>
                  </div>
                </div>
              ))}
            </div>
          </CardContent>
        </Card>
      )}

      {/* No optimization results yet */}
      {!baseOptResult && lanePairSuggestions.length === 0 && bases && bases.length > 0 && (
        <div className="text-center py-8 text-muted-foreground">
          Run the full analysis from the Bid Calculator tab to see optimization suggestions.
        </div>
      )}

      <BaseForm
        open={showAddBase}
        onOpenChange={setShowAddBase}
        sessionId={activeSessionId as Id<'laneAnalysisSessions'>}
        organizationId={organizationId}
        userId={userId}
      />
    </div>
  );
}
