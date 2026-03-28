'use client';

import { Card, CardContent } from '@/components/ui/card';
import { Users, Truck, Link2, ArrowDownRight, AlertTriangle } from 'lucide-react';
import { Badge } from '@/components/ui/badge';

interface DriverCountDisplayProps {
  minDrivers: number;
  realisticDrivers: number;
  trucks: number;
  /** Shift building stats from the engine */
  chainingInfo?: {
    chainedLanes: number;
    soloLanes: number;
    driverSavings: number;
    avgLegsPerShift: number;
    maxLegsInAnyShift: number;
    totalShiftPatterns: number;
    weeklyHosExtraDrivers?: number;
    avgDutyPerShift?: number;
    dutyBands?: Array<{
      label: string;
      shiftCount: number;
      avgDuty: number;
      daysUntilCap: number | null;
      needsRelief: boolean;
      reliefDrivers: number;
    }>;
  };
  /** Unpaired driver count for comparison */
  unpairedMinDrivers?: number;
}

export function DriverCountDisplay({
  minDrivers,
  realisticDrivers,
  trucks,
  chainingInfo,
  unpairedMinDrivers,
}: DriverCountDisplayProps) {
  return (
    <Card>
      <CardContent className="pt-6">
        <div className="flex items-center gap-2">
          <Users className="h-4 w-4 text-muted-foreground" />
          <span className="text-sm text-muted-foreground">Fleet Required</span>
        </div>
        <div className="mt-1 flex items-baseline gap-3">
          <div>
            <span className="text-2xl font-bold">{realisticDrivers}</span>
            <span className="text-sm text-muted-foreground ml-1">drivers</span>
          </div>
          <div className="flex items-center gap-1">
            <Truck className="h-3.5 w-3.5 text-muted-foreground" />
            <span className="text-lg font-semibold">{trucks}</span>
            <span className="text-sm text-muted-foreground">trucks</span>
          </div>
        </div>
        <div className="text-xs text-muted-foreground mt-1">
          Min: {minDrivers} drivers (without relief)
        </div>

        {/* Multi-Leg Shift Summary */}
        {chainingInfo && chainingInfo.driverSavings > 0 && (
          <div className="mt-3 pt-3 border-t space-y-1.5">
            <div className="flex items-center gap-1.5 text-xs font-medium">
              <Link2 className="h-3.5 w-3.5 text-emerald-600" />
              Multi-Leg Shift Optimization
            </div>
            <div className="flex flex-wrap gap-1.5">
              <Badge variant="secondary" className="text-xs">
                {chainingInfo.chainedLanes} chained lane(s)
              </Badge>
              <Badge variant="secondary" className="text-xs">
                avg {chainingInfo.avgLegsPerShift} legs/shift
              </Badge>
              <Badge variant="secondary" className="text-xs">
                max {chainingInfo.maxLegsInAnyShift} legs
              </Badge>
              {chainingInfo.soloLanes > 0 && (
                <Badge variant="outline" className="text-xs">
                  {chainingInfo.soloLanes} solo lane(s)
                </Badge>
              )}
            </div>
            {unpairedMinDrivers != null && (
              <div className="flex items-center gap-1 text-xs text-emerald-600">
                <ArrowDownRight className="h-3 w-3" />
                Saves {chainingInfo.driverSavings} driver(s) vs no chaining ({unpairedMinDrivers} → {minDrivers})
              </div>
            )}
            <div className="text-[10px] text-muted-foreground">
              {chainingInfo.totalShiftPatterns} unique shift pattern(s) found
            </div>
            {/* Per-band weekly HOS analysis */}
            {chainingInfo.dutyBands && chainingInfo.dutyBands.length > 0 && (
              <div className="mt-1.5 space-y-1">
                <div className="text-[10px] text-muted-foreground font-medium">
                  70h/8-Day Weekly Cap by Shift Duty Band:
                </div>
                <div className="grid gap-0.5">
                  {chainingInfo.dutyBands.map((band) => (
                    <div key={band.label} className="flex items-center gap-2 text-[10px]">
                      <span className="w-10 text-muted-foreground font-mono">{band.label}</span>
                      <span className="w-16 text-muted-foreground">{band.shiftCount} shift(s)</span>
                      <span className="w-16 text-muted-foreground">avg {band.avgDuty}h</span>
                      {band.daysUntilCap != null ? (
                        <span className="w-20 text-muted-foreground">cap @ {band.daysUntilCap}d</span>
                      ) : (
                        <span className="w-20" />
                      )}
                      {band.needsRelief ? (
                        <span className="text-amber-600 font-medium">
                          +{band.reliefDrivers} relief
                        </span>
                      ) : (
                        <span className="text-emerald-600">OK</span>
                      )}
                    </div>
                  ))}
                </div>
                {(chainingInfo.weeklyHosExtraDrivers ?? 0) > 0 && (
                  <div className="flex items-center gap-1 text-xs text-amber-600 pt-0.5">
                    <AlertTriangle className="h-3 w-3" />
                    Total: +{chainingInfo.weeklyHosExtraDrivers} relief driver(s) for weekly HOS
                  </div>
                )}
                {(chainingInfo.weeklyHosExtraDrivers ?? 0) === 0 && (
                  <div className="text-[10px] text-emerald-600 pt-0.5">
                    All shifts complete the on-cycle within 70h — no relief needed
                  </div>
                )}
              </div>
            )}
          </div>
        )}
      </CardContent>
    </Card>
  );
}
