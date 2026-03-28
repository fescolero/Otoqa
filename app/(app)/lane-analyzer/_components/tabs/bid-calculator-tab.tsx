'use client';

import { useState } from 'react';
import { useAction, useMutation } from 'convex/react';
import { api } from '@/convex/_generated/api';
import { useAuthQuery } from '@/hooks/use-auth-query';
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
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from '@/components/ui/dialog';
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { toast } from 'sonner';
import { Plus, Play, Truck, Users, DollarSign, MapPin, Loader2, Upload, FileSpreadsheet, ChevronDown, Settings2, Pencil, Check, X } from 'lucide-react';
import { Switch } from '@/components/ui/switch';
import { Id } from '@/convex/_generated/dataModel';
import { LaneEntryForm } from '../shared/lane-entry-form';
import { ImportContractLanesDialog } from '../shared/import-contract-lanes-dialog';
import { DriverCountDisplay } from '../shared/driver-count-display';
import { CostSummaryCard } from '../shared/cost-summary-card';

interface BidCalculatorTabProps {
  organizationId: string;
  userId: string;
  activeSessionId: string | null;
  onSessionChange: (id: string | null) => void;
}

export function BidCalculatorTab({
  organizationId,
  userId,
  activeSessionId,
  onSessionChange,
}: BidCalculatorTabProps) {
  const [showCreateSession, setShowCreateSession] = useState(false);
  const [showAddLane, setShowAddLane] = useState(false);
  const [showImportContractLanes, setShowImportContractLanes] = useState(false);
  const [isRunning, setIsRunning] = useState(false);

  // Session form state
  const [sessionName, setSessionName] = useState('');
  const [analysisYear, setAnalysisYear] = useState(new Date().getFullYear());
  const [driverPayType, setDriverPayType] = useState<'PER_MILE' | 'PER_HOUR' | 'FLAT_PER_RUN'>('PER_MILE');
  const [driverPayRate, setDriverPayRate] = useState('0.65');
  const [schedulePattern, setSchedulePattern] = useState<'5on2off' | '6on1off' | '7on' | 'custom'>('5on2off');
  const [mpgHighway, setMpgHighway] = useState('6');
  const [mpgCity, setMpgCity] = useState('10');

  // Queries
  const sessions = useAuthQuery(api.laneAnalyzer.listSessions, {
    workosOrgId: organizationId,
  });

  const session = useAuthQuery(
    api.laneAnalyzer.getSession,
    activeSessionId
      ? { id: activeSessionId as Id<'laneAnalysisSessions'> }
      : 'skip',
  );

  const entries = useAuthQuery(
    api.laneAnalyzer.listEntries,
    activeSessionId
      ? { sessionId: activeSessionId as Id<'laneAnalysisSessions'> }
      : 'skip',
  );

  const results = useAuthQuery(
    api.laneAnalyzer.getResults,
    activeSessionId
      ? { sessionId: activeSessionId as Id<'laneAnalysisSessions'> }
      : 'skip',
  );

  // Config bar editing
  const [editingConfig, setEditingConfig] = useState(false);

  // Mutations & Actions
  const createSession = useMutation(api.laneAnalyzer.createSession);
  const updateSession = useMutation(api.laneAnalyzer.updateSession);
  const deleteEntry = useMutation(api.laneAnalyzer.deleteEntry);
  const runAnalysis = useAction(api.laneAnalyzerActions.runAnalysisWithExternalData);
  const geocodeRoute = useAction(api.laneAnalyzerActions.geocodeAndCalculateRoute);

  const aggregateResult = results?.find((r) => r.resultType === 'AGGREGATE');
  const perLaneResults = results?.filter((r) => r.resultType === 'PER_LANE') ?? [];

  const handleCreateSession = async () => {
    try {
      const id = await createSession({
        workosOrgId: organizationId,
        name: sessionName,
        analysisType: 'BID',
        defaultDriverPayType: driverPayType,
        defaultDriverPayRate: parseFloat(driverPayRate),
        driverSchedulePattern: schedulePattern,
        defaultMpgHighway: parseFloat(mpgHighway),
        defaultMpgCity: parseFloat(mpgCity),
        analysisYear,
        createdBy: userId,
      });
      onSessionChange(id);
      setShowCreateSession(false);
      setSessionName('');
      toast.success('Session created');
    } catch (error) {
      toast.error('Failed to create session');
    }
  };

  const handleGeocodeAll = async () => {
    if (!entries?.length) return;
    const needsGeocode = entries.filter(
      (e) => !e.originLat || !e.originLng || !e.destinationLat || !e.destinationLng || !e.routeMiles,
    );
    if (needsGeocode.length === 0) return 0;

    let geocoded = 0;
    for (const entry of needsGeocode) {
      try {
        await geocodeRoute({ entryId: entry._id });
        geocoded++;
      } catch (error) {
        console.error(`Failed to geocode ${entry.name}:`, error);
      }
    }
    return geocoded;
  };

  const handleRunAnalysis = async () => {
    if (!activeSessionId) return;
    setIsRunning(true);
    try {
      // Step 1: Geocode any entries that don't have coordinates/miles yet
      const needsGeocode = entries?.filter(
        (e) => !e.originLat || !e.originLng || !e.destinationLat || !e.destinationLng || !e.routeMiles,
      );
      if (needsGeocode && needsGeocode.length > 0) {
        toast.info(`Geocoding ${needsGeocode.length} lane(s)...`);
        const geocoded = await handleGeocodeAll();
        if (geocoded) toast.success(`Geocoded ${geocoded} lane(s)`);
      }

      // Step 2: Run full analysis (fetches fuel prices, tolls, then calculates)
      toast.info('Running analysis...');
      await runAnalysis({
        sessionId: activeSessionId as Id<'laneAnalysisSessions'>,
      });

      toast.success('Analysis complete');
    } catch (error) {
      console.error('Analysis error:', error);
      toast.error('Analysis failed: ' + String(error));
    } finally {
      setIsRunning(false);
    }
  };

  return (
    <div className="space-y-6">
      {/* Session Selector + Create */}
      <div className="flex items-center gap-3">
        <div className="flex-1">
          <Select
            value={activeSessionId ?? ''}
            onValueChange={(v) => onSessionChange(v || null)}
          >
            <SelectTrigger className="w-[300px]">
              <SelectValue placeholder="Select a session..." />
            </SelectTrigger>
            <SelectContent>
              {sessions?.map((s) => (
                <SelectItem key={s._id} value={s._id}>
                  {s.name} ({s.analysisYear})
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>

        <Dialog open={showCreateSession} onOpenChange={setShowCreateSession}>
          <DialogTrigger asChild>
            <Button variant="outline" size="sm">
              <Plus className="h-4 w-4 mr-1" /> New Session
            </Button>
          </DialogTrigger>
          <DialogContent className="max-w-lg">
            <DialogHeader>
              <DialogTitle>Create Analysis Session</DialogTitle>
              <DialogDescription>Set up a new bid or optimization scenario.</DialogDescription>
            </DialogHeader>

            <div className="grid gap-4 py-4">
              <div className="grid gap-2">
                <Label htmlFor="session-name">Session Name</Label>
                <Input
                  id="session-name"
                  placeholder="e.g. Q1 2027 Amazon Bid"
                  value={sessionName}
                  onChange={(e) => setSessionName(e.target.value)}
                />
              </div>

              <div className="grid grid-cols-2 gap-4">
                <div className="grid gap-2">
                  <Label>Analysis Year</Label>
                  <Input
                    type="number"
                    value={analysisYear}
                    onChange={(e) => setAnalysisYear(parseInt(e.target.value))}
                  />
                </div>
                <div className="grid gap-2">
                  <Label>Driver Schedule</Label>
                  <Select value={schedulePattern} onValueChange={(v: typeof schedulePattern) => setSchedulePattern(v)}>
                    <SelectTrigger>
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="5on2off">5 on / 2 off</SelectItem>
                      <SelectItem value="6on1off">6 on / 1 off</SelectItem>
                      <SelectItem value="7on">7 on (no off)</SelectItem>
                      <SelectItem value="custom">Custom</SelectItem>
                    </SelectContent>
                  </Select>
                </div>
              </div>

              <div className="grid grid-cols-3 gap-4">
                <div className="grid gap-2">
                  <Label>Driver Pay Type</Label>
                  <Select value={driverPayType} onValueChange={(v: typeof driverPayType) => setDriverPayType(v)}>
                    <SelectTrigger>
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="PER_MILE">Per Mile</SelectItem>
                      <SelectItem value="PER_HOUR">Per Hour</SelectItem>
                      <SelectItem value="FLAT_PER_RUN">Flat / Run</SelectItem>
                    </SelectContent>
                  </Select>
                </div>
                <div className="grid gap-2">
                  <Label>Pay Rate ($)</Label>
                  <Input
                    type="number"
                    step="0.01"
                    value={driverPayRate}
                    onChange={(e) => setDriverPayRate(e.target.value)}
                  />
                </div>
                <div className="grid gap-2">
                  <Label>MPG (Hwy / City)</Label>
                  <div className="flex gap-1">
                    <Input
                      type="number"
                      step="0.5"
                      value={mpgHighway}
                      onChange={(e) => setMpgHighway(e.target.value)}
                      className="w-16"
                    />
                    <span className="self-center text-muted-foreground">/</span>
                    <Input
                      type="number"
                      step="0.5"
                      value={mpgCity}
                      onChange={(e) => setMpgCity(e.target.value)}
                      className="w-16"
                    />
                  </div>
                </div>
              </div>
            </div>

            <DialogFooter>
              <Button variant="outline" onClick={() => setShowCreateSession(false)}>
                Cancel
              </Button>
              <Button onClick={handleCreateSession} disabled={!sessionName}>
                Create Session
              </Button>
            </DialogFooter>
          </DialogContent>
        </Dialog>

        {activeSessionId && (
          <>
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <Button variant="outline" size="sm">
                  <Plus className="h-4 w-4 mr-1" /> Add Lanes <ChevronDown className="h-3 w-3 ml-1" />
                </Button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end">
                <DropdownMenuItem onClick={() => setShowAddLane(true)}>
                  <MapPin className="h-4 w-4 mr-2" /> Manual Entry
                </DropdownMenuItem>
                <DropdownMenuItem onClick={() => setShowImportContractLanes(true)}>
                  <FileSpreadsheet className="h-4 w-4 mr-2" /> Import from Contract Lanes
                </DropdownMenuItem>
                <DropdownMenuItem
                  onClick={() => {
                    // Navigate to OCR import page (to be built as a sub-route)
                    window.location.href = `/lane-analyzer/import-ocr?sessionId=${activeSessionId}`;
                  }}
                >
                  <Upload className="h-4 w-4 mr-2" /> OCR Import (Bid Package)
                </DropdownMenuItem>
              </DropdownMenuContent>
            </DropdownMenu>
            <Button
              size="sm"
              onClick={handleRunAnalysis}
              disabled={isRunning || !entries?.length}
            >
              {isRunning ? (
                <Loader2 className="h-4 w-4 mr-1 animate-spin" />
              ) : (
                <Play className="h-4 w-4 mr-1" />
              )}
              Run Analysis
            </Button>
          </>
        )}
      </div>

      {/* No Session Selected */}
      {!activeSessionId && (
        <div className="flex flex-col items-center justify-center py-20 text-center">
          <Truck className="h-12 w-12 text-muted-foreground mb-4" />
          <h3 className="text-lg font-medium">No session selected</h3>
          <p className="text-muted-foreground mt-1">
            Create a new session or select an existing one to start analyzing lanes.
          </p>
        </div>
      )}

      {/* Session Content */}
      {activeSessionId && (
        <>
          {/* Session Config Bar */}
          {session && !editingConfig && (
            <div className="flex items-center gap-4 rounded-lg border bg-muted/30 px-4 py-2 text-sm">
              <span className="text-muted-foreground">
                Year: <strong>{session.analysisYear}</strong>
              </span>
              <span className="text-muted-foreground">
                Driver Pay: <strong>
                  ${session.defaultDriverPayRate}/{session.defaultDriverPayType === 'PER_MILE' ? 'mi' : session.defaultDriverPayType === 'PER_HOUR' ? 'hr' : 'run'}
                </strong>
              </span>
              <span className="text-muted-foreground">
                MPG: <strong>{session.defaultMpgHighway} hwy / {session.defaultMpgCity} city</strong>
              </span>
              <span className="text-muted-foreground">
                Schedule: <strong>{session.driverSchedulePattern}</strong>
              </span>
              {session.defaultFuelPricePerGallon && (
                <span className="text-muted-foreground">
                  Fuel: <strong>${session.defaultFuelPricePerGallon.toFixed(2)}/gal</strong>
                </span>
              )}
              <span className="text-muted-foreground">
                Pre/Post: <strong>{session.prePostTripMinutes ?? 60}min</strong>
              </span>
              <span className="text-muted-foreground">
                Dwell: <strong>{session.dwellTimeApptMinutes ?? 30}min</strong>
              </span>
              <span className="text-muted-foreground">
                Legs: <strong>{session.maxChainingLegs ?? 8}</strong>
              </span>
              <span className="text-muted-foreground">
                DH: <strong>{session.maxDeadheadMiles ?? 75}mi</strong>
              </span>
              <span className="text-muted-foreground">
                Wait: <strong>{session.maxWaitHours ?? 3.0}h</strong>
              </span>
              <span className="text-muted-foreground">
                70h: <strong>{session.weeklyHosMode === 'uniform' ? 'Uniform' : 'Flexible'}</strong>
              </span>
              <Button variant="ghost" size="sm" className="ml-auto h-7 gap-1 text-xs" onClick={() => setEditingConfig(true)}>
                <Pencil className="h-3 w-3" /> Edit
              </Button>
            </div>
          )}

          {/* Editable Session Config */}
          {session && editingConfig && (
            <SessionConfigEditor
              session={session}
              onSave={async (updates) => {
                await updateSession({ id: session._id, ...updates });
                setEditingConfig(false);
                toast.success('Session settings updated');
              }}
              onCancel={() => setEditingConfig(false)}
            />
          )}

          {/* Aggregate Summary Cards */}
          {aggregateResult && (
            <div className="grid grid-cols-4 gap-4">
              <CostSummaryCard
                title="Annual Cost"
                value={aggregateResult.costPerYear ?? 0}
                icon={DollarSign}
                format="currency"
              />
              <CostSummaryCard
                title="Annual Revenue"
                value={aggregateResult.revenuePerYear ?? 0}
                icon={DollarSign}
                format="currency"
              />
              <CostSummaryCard
                title="Margin"
                value={aggregateResult.marginPercent ?? 0}
                icon={DollarSign}
                format="percent"
              />
              <DriverCountDisplay
                minDrivers={aggregateResult.minDriverCount ?? 0}
                realisticDrivers={aggregateResult.realisticDriverCount ?? 0}
                trucks={aggregateResult.minTruckCount ?? 0}
                {...(() => {
                  try {
                    const parsed = aggregateResult.hosAnalysis ? JSON.parse(aggregateResult.hosAnalysis as string) : null;
                    if (parsed?.shiftBuilding) {
                      return {
                        chainingInfo: {
                          chainedLanes: parsed.shiftBuilding.chainedLanes ?? 0,
                          soloLanes: parsed.shiftBuilding.soloLanes ?? 0,
                          driverSavings: parsed.shiftBuilding.driverSavings ?? 0,
                          avgLegsPerShift: parsed.shiftBuilding.avgLegsPerShift ?? 0,
                          maxLegsInAnyShift: parsed.shiftBuilding.maxLegsInAnyShift ?? 0,
                          totalShiftPatterns: parsed.shiftBuilding.totalShiftPatterns ?? 0,
                          weeklyHosExtraDrivers: parsed.shiftBuilding.weeklyHosExtraDrivers ?? 0,
                          avgDutyPerShift: parsed.shiftBuilding.avgDutyPerShift ?? 0,
                          dutyBands: parsed.shiftBuilding.dutyBands ?? [],
                        },
                        unpairedMinDrivers: parsed.unpairedDriverCounts?.minDriverCount,
                      };
                    }
                  } catch {}
                  return {};
                })()}
              />
            </div>
          )}

          {/* Lane Entries Table */}
          <Card>
            <CardHeader>
              <CardTitle>Lanes ({entries?.length ?? 0})</CardTitle>
              <CardDescription>
                Routes in this analysis session
              </CardDescription>
            </CardHeader>
            <CardContent>
              {entries?.length === 0 ? (
                <div className="text-center py-8 text-muted-foreground">
                  No lanes added yet. Click &quot;Add Lane&quot; to get started.
                </div>
              ) : (
                <div className="space-y-2">
                  {entries?.map((entry) => {
                    const laneResult = perLaneResults.find((r) => r.entryId === entry._id);
                    const needsGeocode = !entry.originLat || !entry.routeMiles;
                    return (
                      <div
                        key={entry._id}
                        className="flex items-center justify-between border rounded-lg p-3"
                      >
                        <div className="flex-1">
                          <div className="font-medium">{entry.name}</div>
                          <div className="text-sm text-muted-foreground">
                            {entry.originCity}, {entry.originState} → {entry.destinationCity},{' '}
                            {entry.destinationState}
                            {entry.routeMiles
                              ? ` • ${entry.routeMiles} mi`
                              : ''}
                            {entry.routeDurationHours
                              ? ` • ${entry.routeDurationHours.toFixed(1)} hrs`
                              : ''}
                            {needsGeocode && (
                              <span className="text-amber-600 ml-1">(needs route calc)</span>
                            )}
                          </div>
                        </div>

                        <div className="flex items-center gap-2">
                          {entry.scheduleRule.activeDays.length > 0 && (
                            <Badge variant="outline" className="text-xs">
                              {entry.scheduleRule.activeDays.length}d/wk
                            </Badge>
                          )}
                          {entry.equipmentClass && (
                            <Badge variant="outline" className="text-xs">
                              {entry.equipmentClass}
                            </Badge>
                          )}
                          {entry.isCityRoute && (
                            <Badge variant="secondary" className="text-xs">
                              City
                            </Badge>
                          )}
                          {laneResult ? (
                            <>
                              <span className="text-sm tabular-nums">
                                ${laneResult.totalCostPerRun?.toFixed(0)}/run
                              </span>
                              {laneResult.requiresTeamDrivers && (
                                <Badge variant="destructive" className="text-xs">
                                  Team
                                </Badge>
                              )}
                              <Badge
                                variant={
                                  (laneResult.marginPercent ?? 0) > 15
                                    ? 'default'
                                    : (laneResult.marginPercent ?? 0) > 5
                                      ? 'secondary'
                                      : 'destructive'
                                }
                                className="text-xs tabular-nums"
                              >
                                {laneResult.marginPercent?.toFixed(1)}%
                              </Badge>
                            </>
                          ) : needsGeocode ? (
                            <Button
                              variant="outline"
                              size="sm"
                              className="text-xs"
                              onClick={async () => {
                                try {
                                  toast.info(`Calculating route for ${entry.name}...`);
                                  await geocodeRoute({ entryId: entry._id });
                                  toast.success('Route calculated');
                                } catch (error) {
                                  toast.error('Failed to calculate route');
                                }
                              }}
                            >
                              <MapPin className="h-3 w-3 mr-1" /> Calc Route
                            </Button>
                          ) : null}
                          <Button
                            variant="ghost"
                            size="sm"
                            className="text-destructive"
                            onClick={() => deleteEntry({ id: entry._id })}
                          >
                            Remove
                          </Button>
                        </div>
                      </div>
                    );
                  })}
                </div>
              )}
            </CardContent>
          </Card>
        </>
      )}

      {/* Add Lane Dialog */}
      {activeSessionId && (
        <>
          <LaneEntryForm
            open={showAddLane}
            onOpenChange={setShowAddLane}
            sessionId={activeSessionId as Id<'laneAnalysisSessions'>}
            organizationId={organizationId}
          />
          <ImportContractLanesDialog
            open={showImportContractLanes}
            onOpenChange={setShowImportContractLanes}
            sessionId={activeSessionId as Id<'laneAnalysisSessions'>}
            organizationId={organizationId}
          />
        </>
      )}
    </div>
  );
}

// ---- Session Config Editor ----

interface SessionConfigEditorProps {
  session: {
    _id: Id<'laneAnalysisSessions'>;
    analysisYear: number;
    defaultDriverPayType: 'PER_MILE' | 'PER_HOUR' | 'FLAT_PER_RUN';
    defaultDriverPayRate: number;
    defaultMpgHighway: number;
    defaultMpgCity: number;
    driverSchedulePattern: string;
    customScheduleOnDays?: number;
    customScheduleOffDays?: number;
    defaultFuelPricePerGallon?: number;
    prePostTripMinutes?: number;
    dwellTimeApptMinutes?: number;
    dwellTimeLiveMinutes?: number;
    dwellTimeFcfsMinutes?: number;
    useApptWindowsForDwell?: boolean;
    maxChainingLegs?: number;
    maxDeadheadMiles?: number;
    maxWaitHours?: number;
    weeklyHosMode?: 'uniform' | 'flexible';
    allowSameLaneRepeat?: boolean;
  };
  onSave: (updates: Record<string, unknown>) => Promise<void>;
  onCancel: () => void;
}

function SessionConfigEditor({ session, onSave, onCancel }: SessionConfigEditorProps) {
  const [year, setYear] = useState(session.analysisYear);
  const [payType, setPayType] = useState(session.defaultDriverPayType);
  const [payRate, setPayRate] = useState(String(session.defaultDriverPayRate));
  const [mpgHwy, setMpgHwy] = useState(String(session.defaultMpgHighway));
  const [mpgCity, setMpgCity] = useState(String(session.defaultMpgCity));
  const [schedule, setSchedule] = useState(session.driverSchedulePattern);
  const [customOn, setCustomOn] = useState(String(session.customScheduleOnDays ?? 5));
  const [customOff, setCustomOff] = useState(String(session.customScheduleOffDays ?? 2));
  const [fuelOverride, setFuelOverride] = useState(session.defaultFuelPricePerGallon ? String(session.defaultFuelPricePerGallon) : '');
  const [prePostTrip, setPrePostTrip] = useState(String(session.prePostTripMinutes ?? 60));
  const [dwellAppt, setDwellAppt] = useState(String(session.dwellTimeApptMinutes ?? 30));
  const [dwellLive, setDwellLive] = useState(String(session.dwellTimeLiveMinutes ?? 60));
  const [dwellFcfs, setDwellFcfs] = useState(String(session.dwellTimeFcfsMinutes ?? 90));
  const [useApptWindows, setUseApptWindows] = useState(session.useApptWindowsForDwell ?? false);
  const [maxLegs, setMaxLegs] = useState(String(session.maxChainingLegs ?? 8));
  const [maxDeadhead, setMaxDeadhead] = useState(String(session.maxDeadheadMiles ?? 75));
  const [maxWait, setMaxWait] = useState(String(session.maxWaitHours ?? 3.0));
  const [weeklyMode, setWeeklyMode] = useState<'uniform' | 'flexible'>(session.weeklyHosMode ?? 'flexible');
  const [saving, setSaving] = useState(false);

  const handleSave = async () => {
    setSaving(true);
    try {
      await onSave({
        analysisYear: year,
        defaultDriverPayType: payType,
        defaultDriverPayRate: parseFloat(payRate) || 0,
        defaultMpgHighway: parseFloat(mpgHwy) || 6,
        defaultMpgCity: parseFloat(mpgCity) || 10,
        driverSchedulePattern: schedule,
        customScheduleOnDays: schedule === 'custom' ? parseInt(customOn) || 5 : undefined,
        customScheduleOffDays: schedule === 'custom' ? parseInt(customOff) || 2 : undefined,
        defaultFuelPricePerGallon: fuelOverride ? parseFloat(fuelOverride) : undefined,
        prePostTripMinutes: parseInt(prePostTrip) || 60,
        dwellTimeApptMinutes: parseInt(dwellAppt) || 30,
        dwellTimeLiveMinutes: parseInt(dwellLive) || 60,
        dwellTimeFcfsMinutes: parseInt(dwellFcfs) || 90,
        useApptWindowsForDwell: useApptWindows,
        maxChainingLegs: parseInt(maxLegs) || 8,
        maxDeadheadMiles: parseInt(maxDeadhead) || 75,
        maxWaitHours: parseFloat(maxWait) || 3.0,
        weeklyHosMode: weeklyMode,
      });
    } finally {
      setSaving(false);
    }
  };

  return (
    <Card>
      <CardHeader className="pb-3">
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-2">
            <Settings2 className="h-4 w-4" />
            <CardTitle className="text-base">Session Settings</CardTitle>
          </div>
          <div className="flex gap-2">
            <Button variant="ghost" size="sm" onClick={onCancel} className="h-7">
              <X className="h-3.5 w-3.5 mr-1" /> Cancel
            </Button>
            <Button size="sm" onClick={handleSave} disabled={saving} className="h-7">
              {saving ? <Loader2 className="h-3.5 w-3.5 mr-1 animate-spin" /> : <Check className="h-3.5 w-3.5 mr-1" />}
              Save
            </Button>
          </div>
        </div>
      </CardHeader>
      <CardContent className="space-y-4">
        {/* Row 1: Core settings */}
        <div>
          <Label className="text-xs font-semibold text-muted-foreground uppercase tracking-wider">Core Settings</Label>
          <div className="grid grid-cols-6 gap-3 mt-2">
            <div>
              <Label className="text-xs">Year</Label>
              <Input type="number" value={year} onChange={(e) => setYear(parseInt(e.target.value) || 2026)} className="h-8 text-sm" />
            </div>
            <div>
              <Label className="text-xs">Pay Type</Label>
              <Select value={payType} onValueChange={(v) => setPayType(v as typeof payType)}>
                <SelectTrigger className="h-8 text-xs"><SelectValue /></SelectTrigger>
                <SelectContent>
                  <SelectItem value="PER_MILE">Per Mile</SelectItem>
                  <SelectItem value="PER_HOUR">Per Hour</SelectItem>
                  <SelectItem value="FLAT_PER_RUN">Flat/Run</SelectItem>
                </SelectContent>
              </Select>
            </div>
            <div>
              <Label className="text-xs">Pay Rate ($)</Label>
              <Input type="number" step="0.01" value={payRate} onChange={(e) => setPayRate(e.target.value)} className="h-8 text-sm" />
            </div>
            <div>
              <Label className="text-xs">MPG Hwy</Label>
              <Input type="number" step="0.1" value={mpgHwy} onChange={(e) => setMpgHwy(e.target.value)} className="h-8 text-sm" />
            </div>
            <div>
              <Label className="text-xs">MPG City</Label>
              <Input type="number" step="0.1" value={mpgCity} onChange={(e) => setMpgCity(e.target.value)} className="h-8 text-sm" />
            </div>
            <div>
              <Label className="text-xs">Schedule</Label>
              <Select value={schedule} onValueChange={(v) => setSchedule(v)}>
                <SelectTrigger className="h-8 text-xs"><SelectValue /></SelectTrigger>
                <SelectContent>
                  <SelectItem value="5on2off">5 on / 2 off</SelectItem>
                  <SelectItem value="6on1off">6 on / 1 off</SelectItem>
                  <SelectItem value="7on">7 on (no off)</SelectItem>
                  <SelectItem value="custom">Custom</SelectItem>
                </SelectContent>
              </Select>
            </div>
          </div>
          {schedule === 'custom' && (
            <div className="flex items-center gap-2 mt-2">
              <Input type="number" value={customOn} onChange={(e) => setCustomOn(e.target.value)} className="h-8 w-16 text-sm" />
              <span className="text-xs text-muted-foreground">on /</span>
              <Input type="number" value={customOff} onChange={(e) => setCustomOff(e.target.value)} className="h-8 w-16 text-sm" />
              <span className="text-xs text-muted-foreground">off</span>
            </div>
          )}
          {fuelOverride !== '' && (
            <div className="flex items-center gap-2 mt-2">
              <Label className="text-xs">Fuel Override ($/gal)</Label>
              <Input type="number" step="0.01" value={fuelOverride} onChange={(e) => setFuelOverride(e.target.value)} className="h-8 w-24 text-sm" />
              <Button variant="ghost" size="sm" className="h-7 text-xs" onClick={() => setFuelOverride('')}>Clear</Button>
            </div>
          )}
        </div>

        {/* Row 2: Operational / HOS settings */}
        <div>
          <Label className="text-xs font-semibold text-muted-foreground uppercase tracking-wider">Operational / HOS Settings</Label>
          <div className="grid grid-cols-6 gap-3 mt-2">
            <div>
              <Label className="text-xs">Pre/Post Trip (min)</Label>
              <Input type="number" value={prePostTrip} onChange={(e) => setPrePostTrip(e.target.value)} className="h-8 text-sm" />
            </div>
            <div>
              <Label className="text-xs">APPT Dwell (min)</Label>
              <Input type="number" value={dwellAppt} onChange={(e) => setDwellAppt(e.target.value)} className="h-8 text-sm" />
            </div>
            <div>
              <Label className="text-xs">Live Dwell (min)</Label>
              <Input type="number" value={dwellLive} onChange={(e) => setDwellLive(e.target.value)} className="h-8 text-sm" />
            </div>
            <div>
              <Label className="text-xs">FCFS Dwell (min)</Label>
              <Input type="number" value={dwellFcfs} onChange={(e) => setDwellFcfs(e.target.value)} className="h-8 text-sm" />
            </div>
            <div>
              <Label className="text-xs">Max Legs/Shift</Label>
              <Input type="number" min={1} max={12} value={maxLegs} onChange={(e) => setMaxLegs(e.target.value)} className="h-8 text-sm" />
            </div>
            <div>
              <Label className="text-xs">Max Deadhead (mi)</Label>
              <Input type="number" value={maxDeadhead} onChange={(e) => setMaxDeadhead(e.target.value)} className="h-8 text-sm" />
            </div>
            <div>
              <Label className="text-xs">Max Wait (hrs)</Label>
              <Input type="number" step="0.5" min={0.5} max={6} value={maxWait} onChange={(e) => setMaxWait(e.target.value)} className="h-8 text-sm" />
            </div>
          </div>
          <div className="flex items-center gap-6 mt-3">
            <div className="flex items-center gap-2">
              <div className="flex rounded border p-0.5 w-fit">
                <button
                  type="button"
                  onClick={() => setWeeklyMode('flexible')}
                  className={`px-2.5 py-1 rounded text-xs font-medium transition-colors ${
                    weeklyMode === 'flexible' ? 'bg-primary text-primary-foreground' : 'text-muted-foreground'
                  }`}
                >
                  Flexible 70h
                </button>
                <button
                  type="button"
                  onClick={() => setWeeklyMode('uniform')}
                  className={`px-2.5 py-1 rounded text-xs font-medium transition-colors ${
                    weeklyMode === 'uniform' ? 'bg-primary text-primary-foreground' : 'text-muted-foreground'
                  }`}
                >
                  Uniform 70h
                </button>
              </div>
              <span className="text-[10px] text-muted-foreground">
                {weeklyMode === 'flexible'
                  ? 'Allow up to 14h/day, manage 70h across the week'
                  : `Cap each shift at ${(70 / 6).toFixed(1)}h to distribute evenly`}
              </span>
            </div>
            <div className="flex items-center gap-2">
              <Switch checked={useApptWindows} onCheckedChange={setUseApptWindows} id="useApptWindows" />
              <Label htmlFor="useApptWindows" className="text-xs">Use APPT windows for dwell</Label>
            </div>
          </div>
        </div>
      </CardContent>
    </Card>
  );
}
