'use client';

import { useMemo, useState } from 'react';
import { useAuthQuery } from '@/hooks/use-auth-query';
import { useQuery } from 'convex/react';
import { api } from '@/convex/_generated/api';
import { Id } from '@/convex/_generated/dataModel';
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Input } from '@/components/ui/input';
import { CalendarDays, Link2, ArrowRight, Clock, Truck, MapPin, Search, ChevronDown, ChevronRight } from 'lucide-react';

interface ScheduleViewTabProps {
  organizationId: string;
  activeSessionId: string | null;
}

const MONTH_NAMES = [
  'January', 'February', 'March', 'April', 'May', 'June',
  'July', 'August', 'September', 'October', 'November', 'December',
];



export function ScheduleViewTab({ organizationId, activeSessionId }: ScheduleViewTabProps) {
  const [weekStart, setWeekStart] = useState<string>(() => {
    // Default to current week's Monday
    const now = new Date();
    const day = now.getDay();
    const diff = day === 0 ? -6 : 1 - day; // Monday
    const monday = new Date(now);
    monday.setDate(now.getDate() + diff);
    return `${monday.getFullYear()}-${String(monday.getMonth() + 1).padStart(2, '0')}-${String(monday.getDate()).padStart(2, '0')}`;
  });
  const [laneSearch, setLaneSearch] = useState('');
  const [expandedLane, setExpandedLane] = useState<string | null>(null);

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

  // Parse shift building data from aggregate result
  const shiftData = useMemo(() => {
    if (!results) return null;
    const agg = results.find((r) => r.resultType === 'AGGREGATE');
    if (!agg?.hosAnalysis) return null;
    try {
      const parsed = JSON.parse(agg.hosAnalysis as string);
      return parsed.shiftBuilding as {
        chainedLanes: number;
        soloLanes: number;
        driverSavings: number;
        avgLegsPerShift: number;
        maxLegsInAnyShift: number;
        totalShiftPatterns: number;
        peakDayShifts: Array<{
          legs: string[];
          legCount: number;
          driveHours: number;
          dutyHours: number;
          miles: number;
          deadheadMiles: number;
          fuelCost: number;
          driverPay: number;
          tollCost: number;
          deadheadCost: number;
          totalCost: number;
          revenue: number;
          profit: number;
        }>;
      } | null;
    } catch { return null; }
  }, [results]);

  // Build schedule data client-side using the same logic as the backend
  const scheduleData = useMemo(() => {
    if (!entries || !session) return [];

    return entries.map((entry) => {
      // Expand schedule rule into dates
      const dates = expandSchedule(entry.scheduleRule, session.analysisYear, entry.contractPeriodStart, entry.contractPeriodEnd);
      return {
        entryId: entry._id,
        name: entry.name,
        dates: new Set(dates),
      };
    });
  }, [entries, session]);

  const year = session?.analysisYear ?? new Date().getFullYear();

  if (!activeSessionId) {
    return (
      <div className="flex flex-col items-center justify-center py-20 text-center">
        <CalendarDays className="h-12 w-12 text-muted-foreground mb-4" />
        <h3 className="text-lg font-medium">Select a session to view the schedule</h3>
      </div>
    );
  }

  const totalAnnualRuns = useMemo(() => {
    let total = 0;
    for (const lane of scheduleData) total += lane.dates.size;
    return total;
  }, [scheduleData]);

  return (
    <div className="space-y-6">
      {/* Summary Stats */}
      {scheduleData.length > 0 && (
        <div className="flex items-center gap-6 text-sm">
          <div>
            <span className="text-muted-foreground">Total Annual Runs: </span>
            <strong>{totalAnnualRuns.toLocaleString()}</strong>
          </div>
          <div>
            <span className="text-muted-foreground">Avg Runs/Week: </span>
            <strong>{(totalAnnualRuns / 52).toFixed(1)}</strong>
          </div>
          <div>
            <span className="text-muted-foreground">Lanes: </span>
            <strong>{scheduleData.length}</strong>
          </div>
        </div>
      )}

      {/* Searchable Lane Schedule Table */}
      {scheduleData.length > 0 && (
        <Card>
          <CardHeader className="pb-3">
            <div className="flex items-center justify-between">
              <CardTitle className="text-base">Lane Schedules ({scheduleData.length})</CardTitle>
              <div className="relative w-64">
                <Search className="absolute left-2.5 top-2 h-3.5 w-3.5 text-muted-foreground" />
                <Input
                  placeholder="Search lanes (e.g. 617)"
                  value={laneSearch}
                  onChange={(e) => setLaneSearch(e.target.value)}
                  className="h-8 pl-8 text-sm"
                />
              </div>
            </div>
          </CardHeader>
          <CardContent>
            <div className="max-h-[400px] overflow-y-auto space-y-0.5">
              {scheduleData
                .filter((lane) =>
                  !laneSearch || lane.name.toLowerCase().includes(laneSearch.toLowerCase()),
                )
                .map((lane) => {
                  const entry = entries?.find((e) => e._id === lane.entryId);
                  const isExpanded = expandedLane === lane.entryId;
                  const activeDays = entry?.scheduleRule.activeDays ?? [];
                  const dayLabels = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

                  // Monthly run distribution
                  const monthRuns = Array.from({ length: 12 }, () => 0);
                  for (const d of lane.dates) {
                    const m = parseInt(d.substring(5, 7)) - 1;
                    monthRuns[m]++;
                  }

                  return (
                    <div key={lane.entryId} className="border rounded-md">
                      <div
                        className="flex items-center gap-3 p-2.5 cursor-pointer hover:bg-muted/30"
                        onClick={() => setExpandedLane(isExpanded ? null : lane.entryId)}
                      >
                        {isExpanded
                          ? <ChevronDown className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
                          : <ChevronRight className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
                        }
                        <div className="flex-1 min-w-0">
                          <span className="text-sm font-medium">{lane.name}</span>
                          {entry && (
                            <span className="text-xs text-muted-foreground ml-2">
                              {entry.originCity}, {entry.originState}
                              {entry.originScheduledTime && <span className="font-mono"> {entry.originScheduledTime}</span>}
                              {' → '}
                              {entry.destinationCity}, {entry.destinationState}
                              {entry.destinationScheduledTime && <span className="font-mono"> {entry.destinationScheduledTime}</span>}
                            </span>
                          )}
                        </div>
                        <div className="flex items-center gap-3 shrink-0 text-xs">
                          <span className="text-muted-foreground">
                            {activeDays.map((d) => dayLabels[d]).join(', ')}
                          </span>
                          <Badge variant="outline" className="text-xs tabular-nums">
                            {lane.dates.size} runs/yr
                          </Badge>
                          {entry?.routeMiles && (
                            <span className="text-muted-foreground">
                              {entry.routeMiles} mi
                            </span>
                          )}
                        </div>
                      </div>

                      {/* Expanded: show monthly mini-calendar for this lane */}
                      {isExpanded && (
                        <div className="border-t px-3 py-2 bg-muted/10">
                          <div className="grid grid-cols-6 gap-2">
                            {MONTH_NAMES.map((monthName, mi) => (
                              <div key={mi}>
                                <div className="flex items-center justify-between mb-1">
                                  <span className="text-[10px] font-medium">{monthName.slice(0, 3)}</span>
                                  <span className="text-[10px] text-muted-foreground">{monthRuns[mi]}</span>
                                </div>
                                <SingleLaneMonthGrid
                                  year={year}
                                  month={mi}
                                  dates={lane.dates}
                                />
                              </div>
                            ))}
                          </div>
                          {entry && (
                            <div className="flex items-center gap-4 mt-2 pt-2 border-t text-xs text-muted-foreground">
                              {entry.originScheduledTime && (
                                <span>Pickup: {entry.originAppointmentType ?? 'APPT'} {entry.originScheduledTime}{entry.originScheduledEndTime && `–${entry.originScheduledEndTime}`}</span>
                              )}
                              {entry.destinationScheduledTime && (
                                <span>Delivery: {entry.destinationAppointmentType ?? 'APPT'} {entry.destinationScheduledTime}{entry.destinationScheduledEndTime && `–${entry.destinationScheduledEndTime}`}</span>
                              )}
                              {entry.contractPeriodStart && (
                                <span>Contract: {entry.contractPeriodStart} → {entry.contractPeriodEnd ?? '?'}</span>
                              )}
                              {entry.scheduleRule.excludeFederalHolidays && <span>Excl. holidays</span>}
                            </div>
                          )}
                        </div>
                      )}
                    </div>
                  );
                })}
              {scheduleData.filter((l) => !laneSearch || l.name.toLowerCase().includes(laneSearch.toLowerCase())).length === 0 && (
                <div className="text-center py-4 text-sm text-muted-foreground">
                  No lanes matching &ldquo;{laneSearch}&rdquo;
                </div>
              )}
            </div>
          </CardContent>
        </Card>
      )}

      {/* Driver Shift Chains — Weekly View */}
      {activeSessionId && (
        <WeeklyShiftView
          sessionId={activeSessionId as Id<'laneAnalysisSessions'>}
          entries={entries ?? []}
          weekStart={weekStart}
          onWeekChange={setWeekStart}
          year={year}
        />
      )}

    </div>
  );
}

// ---- Weekly Shift View ----

function WeeklyShiftView({
  sessionId,
  entries,
  weekStart,
  onWeekChange,
  year,
}: {
  sessionId: Id<'laneAnalysisSessions'>;
  entries: Array<{
    _id: string;
    name: string;
    originCity: string;
    originState: string;
    destinationCity: string;
    destinationState: string;
    routeMiles?: number;
    routeDurationHours?: number;
    originScheduledTime?: string;
    destinationScheduledTime?: string;
  }>;
  weekStart: string;
  onWeekChange: (date: string) => void;
  year: number;
}) {
  const weekData = useQuery(
    api.laneAnalyzer.getShiftsForWeek,
    { sessionId, weekStartDate: weekStart },
  );

  const navigateWeek = (direction: number) => {
    const d = new Date(weekStart + 'T00:00:00');
    d.setDate(d.getDate() + direction * 7);
    const str = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
    onWeekChange(str);
  };

  // Week end date for display
  const weekEndDate = useMemo(() => {
    const d = new Date(weekStart + 'T00:00:00');
    d.setDate(d.getDate() + 6);
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
  }, [weekStart]);

  // Week summary stats
  const weekStats = useMemo(() => {
    if (!weekData?.days) return null;
    const totalShifts = weekData.days.reduce((s, d) => s + d.shifts.length, 0);
    const totalLanes = weekData.days.reduce((s, d) => s + d.lanesRunning, 0);
    const maxShiftsDay = weekData.days.reduce((max, d) => d.shifts.length > max.shifts.length ? d : max, weekData.days[0]);
    return { totalShifts, totalLanes, peakDay: maxShiftsDay };
  }, [weekData]);

  // Expanded day state
  const [expandedDay, setExpandedDay] = useState<string | null>(null);

  return (
    <Card>
      <CardHeader className="pb-3">
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-2">
            <Link2 className="h-4 w-4 text-emerald-600" />
            <CardTitle className="text-base">Weekly Shift Chains</CardTitle>
          </div>
          <div className="flex items-center gap-2">
            <button onClick={() => navigateWeek(-1)} className="px-2 py-1 rounded border text-xs hover:bg-muted">← Prev</button>
            <Input
              type="date"
              value={weekStart}
              min={`${year}-01-01`}
              max={`${year}-12-31`}
              onChange={(e) => e.target.value && onWeekChange(e.target.value)}
              className="h-8 w-40 text-xs"
            />
            <button onClick={() => navigateWeek(1)} className="px-2 py-1 rounded border text-xs hover:bg-muted">Next →</button>
          </div>
        </div>
        <CardDescription>
          Week of {weekStart} → {weekEndDate}
          {weekStats && (
            <> • {weekStats.totalShifts} total shifts, {weekStats.totalLanes} lane-runs</>
          )}
        </CardDescription>
      </CardHeader>
      <CardContent>
        {!weekData && (
          <p className="text-sm text-muted-foreground text-center py-8">Loading week...</p>
        )}

        {weekData && (
          <div className="space-y-1">
            {/* Day rows */}
            {weekData.days.map((day) => {
              const isExpanded = expandedDay === day.date;
              const isOff = day.lanesRunning === 0;

              return (
                <div key={day.date} className={`rounded-md border ${isOff ? 'opacity-40' : ''}`}>
                  {/* Day header */}
                  <div
                    className={`flex items-center gap-3 p-3 cursor-pointer hover:bg-muted/30 ${isExpanded ? 'border-b' : ''}`}
                    onClick={() => !isOff && setExpandedDay(isExpanded ? null : day.date)}
                  >
                    {!isOff && (isExpanded
                      ? <ChevronDown className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
                      : <ChevronRight className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
                    )}
                    {isOff && <div className="w-3.5" />}

                    <div className="w-12 font-medium text-sm">{day.dayName}</div>
                    <div className="text-xs text-muted-foreground w-24">{day.date}</div>

                    {!isOff ? (
                      <div className="flex items-center gap-4 flex-1">
                        <Badge variant="secondary" className="text-xs">
                          {day.shifts.length} driver{day.shifts.length !== 1 ? 's' : ''}
                        </Badge>
                        <span className="text-xs text-muted-foreground">
                          {day.lanesRunning} lane(s)
                        </span>

                        {/* Mini shift summary: show leg counts */}
                        <div className="flex items-center gap-1 flex-1">
                          {day.shifts.map((shift, si) => (
                            <div
                              key={si}
                              className={`h-5 rounded text-[9px] font-mono px-1.5 flex items-center gap-0.5 ${
                                shift.dutyHours > 12 ? 'bg-amber-100 dark:bg-amber-950 text-amber-700 dark:text-amber-400 border border-amber-300 dark:border-amber-800'
                                : shift.legCount > 1 ? 'bg-emerald-100 dark:bg-emerald-950 text-emerald-700 dark:text-emerald-400 border border-emerald-300 dark:border-emerald-800'
                                : 'bg-muted border text-muted-foreground'
                              }`}
                              title={`Driver ${si + 1}: ${shift.legCount} legs, ${shift.driveHours}h drive, ${shift.dutyHours}h duty, ${shift.miles} mi`}
                            >
                              {shift.legCount}L {shift.dutyHours}h
                            </div>
                          ))}
                        </div>

                        <span className="text-xs text-muted-foreground shrink-0">
                          {day.shifts.reduce((s, sh) => s + sh.miles, 0)} mi total
                        </span>
                      </div>
                    ) : (
                      <span className="text-xs text-muted-foreground">No lanes scheduled</span>
                    )}
                  </div>

                  {/* Expanded: show full shift details */}
                  {isExpanded && (
                    <div className="p-3 space-y-2 bg-muted/10">
                      {day.shifts.map((shift, shiftIdx) => (
                        <div key={shiftIdx} className="rounded border bg-background p-2.5">
                          <div className="flex items-center justify-between mb-1.5">
                            <div className="flex items-center gap-2">
                              <Badge variant="secondary" className="text-[10px] font-mono">
                                Driver {shiftIdx + 1}
                              </Badge>
                              <span className="text-[10px] text-muted-foreground">
                                {shift.legCount} leg{shift.legCount !== 1 ? 's' : ''}
                              </span>
                            </div>
                            <div className="flex items-center gap-2 text-[10px] text-muted-foreground">
                              <span>{shift.driveHours}h drive / {shift.dutyHours}h duty</span>
                              <span>{shift.miles} mi</span>
                              {shift.deadheadMiles > 0 && (
                                <span className="text-amber-600">+{shift.deadheadMiles} mi DH</span>
                              )}
                            </div>
                          </div>

                          {/* Leg chain */}
                          <div className="flex items-center gap-1 flex-wrap">
                            {shift.legs.map((legName: string, legIdx: number) => {
                              const entry = entries?.find((e) => e.name === legName);
                              const prevEntry = legIdx > 0 ? entries?.find((e) => e.name === shift.legs[legIdx - 1]) : null;

                              // Get per-gap deadhead data if available
                              const gap = legIdx > 0 && 'legGaps' in shift
                                ? (shift as { legGaps?: Array<{ miles: number; driveHours: number; waitHours: number; prevEndTime?: string | null; nextStartTime?: string | null; earliestArrival?: string | null }> }).legGaps?.[legIdx - 1]
                                : null;

                              const hasDH = gap ? (gap.miles > 0 || gap.waitHours > 0) : (prevEntry && entry &&
                                (prevEntry.destinationCity.toLowerCase() !== entry.originCity.toLowerCase() ||
                                 prevEntry.destinationState.toLowerCase() !== entry.originState.toLowerCase()));

                              return (
                                <div key={legIdx} className="flex items-center gap-1">
                                  {legIdx > 0 && (
                                    <div className="flex flex-col items-center shrink-0 mx-0.5">
                                      {hasDH || (gap && gap.waitHours > 0) ? (
                                        <div className="flex flex-col items-center rounded bg-amber-50 dark:bg-amber-950/30 border border-amber-200 dark:border-amber-800 px-1.5 py-0.5 min-w-[60px]">
                                          <ArrowRight className="h-2.5 w-2.5 text-amber-600" />
                                          {gap ? (
                                            <>
                                              {gap.miles > 0 && (
                                                <span className="text-[7px] text-amber-600 font-medium leading-tight whitespace-nowrap">
                                                  {gap.miles} mi • {gap.driveHours}h drive
                                                </span>
                                              )}
                                              {gap.waitHours > 0 && (
                                                <span className="text-[7px] text-amber-700 dark:text-amber-400 leading-tight whitespace-nowrap">
                                                  {gap.waitHours}h wait
                                                </span>
                                              )}
                                            </>
                                          ) : (
                                            prevEntry && entry && (
                                              <span className="text-[7px] text-amber-600 font-medium leading-tight whitespace-nowrap">
                                                {prevEntry.destinationCity}→{entry.originCity}
                                              </span>
                                            )
                                          )}
                                        </div>
                                      ) : (
                                        <ArrowRight className="h-2.5 w-2.5 text-emerald-500" />
                                      )}
                                    </div>
                                  )}
                                  <div className="rounded border px-2 py-1 text-[10px]">
                                    <span className="font-medium">{legName}</span>
                                    {entry && (
                                      <span className="text-muted-foreground ml-1">
                                        {entry.originCity}
                                        {entry.originScheduledTime && <span className="font-mono"> {entry.originScheduledTime}</span>}
                                        {' → '}
                                        {entry.destinationCity}
                                        {entry.destinationScheduledTime && <span className="font-mono"> {entry.destinationScheduledTime}</span>}
                                        {entry.routeMiles && <span className="ml-1">{entry.routeMiles}mi</span>}
                                        {entry.routeDurationHours && <span className="ml-0.5">{entry.routeDurationHours.toFixed(1)}h</span>}
                                      </span>
                                    )}
                                  </div>
                                </div>
                              );
                            })}
                          </div>

                          {/* HOS mini bar */}
                          <div className="flex gap-2 mt-1.5">
                            <div className="flex-1">
                              <div className="w-full bg-muted rounded-full h-1">
                                <div className={`h-1 rounded-full ${shift.driveHours / 11 > 0.85 ? 'bg-amber-500' : 'bg-emerald-500'}`} style={{ width: `${Math.min((shift.driveHours / 11) * 100, 100)}%` }} />
                              </div>
                            </div>
                            <div className="flex-1">
                              <div className="w-full bg-muted rounded-full h-1">
                                <div className={`h-1 rounded-full ${shift.dutyHours / 14 > 0.85 ? 'bg-amber-500' : 'bg-blue-500'}`} style={{ width: `${Math.min((shift.dutyHours / 14) * 100, 100)}%` }} />
                              </div>
                            </div>
                          </div>
                        </div>
                      ))}
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        )}
      </CardContent>
    </Card>
  );
}

// Client-side schedule expansion (mirrors backend logic)
function expandSchedule(
  scheduleRule: { activeDays: number[]; excludeFederalHolidays: boolean; customExclusions: string[] },
  year: number,
  contractPeriodStart?: string,
  contractPeriodEnd?: string,
): string[] {
  if (scheduleRule.activeDays.length === 0) return [];

  const activeDaysSet = new Set(scheduleRule.activeDays);
  const customExclusionsSet = new Set(scheduleRule.customExclusions);

  // Simple federal holiday check (client-side approximation)
  const holidays = scheduleRule.excludeFederalHolidays ? getFederalHolidaysSimple(year) : new Set<string>();

  const dates: string[] = [];
  const startDate = contractPeriodStart ? new Date(contractPeriodStart + 'T00:00:00') : new Date(year, 0, 1);
  const endDate = contractPeriodEnd ? new Date(contractPeriodEnd + 'T00:00:00') : new Date(year, 11, 31);
  const yearStart = new Date(year, 0, 1);
  const yearEnd = new Date(year, 11, 31);
  const effectiveStart = startDate > yearStart ? startDate : yearStart;
  const effectiveEnd = endDate < yearEnd ? endDate : yearEnd;

  const current = new Date(effectiveStart);
  while (current <= effectiveEnd) {
    const dayOfWeek = current.getDay();
    const dateStr = formatDate(current);
    if (activeDaysSet.has(dayOfWeek) && !holidays.has(dateStr) && !customExclusionsSet.has(dateStr)) {
      dates.push(dateStr);
    }
    current.setDate(current.getDate() + 1);
  }

  return dates;
}

function formatDate(date: Date): string {
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, '0');
  const d = String(date.getDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
}

function getFederalHolidaysSimple(year: number): Set<string> {
  // Simplified list — same holidays as holidays.ts
  const holidays: string[] = [];

  // Fixed-date holidays (observed shift)
  const addObserved = (y: number, m: number, d: number) => {
    const date = new Date(y, m, d);
    const dow = date.getDay();
    if (dow === 6) date.setDate(d - 1); // Saturday → Friday
    if (dow === 0) date.setDate(d + 1); // Sunday → Monday
    holidays.push(formatDate(date));
  };

  addObserved(year, 0, 1);   // New Year's
  addObserved(year, 5, 19);  // Juneteenth
  addObserved(year, 6, 4);   // Independence Day
  addObserved(year, 10, 11); // Veterans Day
  addObserved(year, 11, 25); // Christmas

  // Nth-day-of-month holidays
  const nthDay = (m: number, dow: number, n: number) => {
    const first = new Date(year, m, 1);
    let daysToAdd = dow - first.getDay();
    if (daysToAdd < 0) daysToAdd += 7;
    daysToAdd += (n - 1) * 7;
    holidays.push(formatDate(new Date(year, m, 1 + daysToAdd)));
  };

  nthDay(0, 1, 3);  // MLK Day (3rd Monday Jan)
  nthDay(1, 1, 3);  // Presidents Day (3rd Monday Feb)
  nthDay(8, 1, 1);  // Labor Day (1st Monday Sep)
  nthDay(9, 1, 2);  // Columbus Day (2nd Monday Oct)
  nthDay(10, 4, 4); // Thanksgiving (4th Thursday Nov)

  // Memorial Day (last Monday May)
  const lastDay = new Date(year, 5, 0);
  let daysBack = lastDay.getDay() - 1;
  if (daysBack < 0) daysBack += 7;
  holidays.push(formatDate(new Date(year, 5, -daysBack)));

  return new Set(holidays);
}

/** Mini month grid for a single lane — highlights dates this lane runs */
function SingleLaneMonthGrid({ year, month, dates }: { year: number; month: number; dates: Set<string> }) {
  const firstDay = new Date(year, month, 1).getDay();
  const daysInMonth = new Date(year, month + 1, 0).getDate();

  const cells: Array<{ day: number | null; active: boolean }> = [];
  for (let i = 0; i < firstDay; i++) cells.push({ day: null, active: false });
  for (let d = 1; d <= daysInMonth; d++) {
    const dateStr = `${year}-${String(month + 1).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
    cells.push({ day: d, active: dates.has(dateStr) });
  }

  return (
    <div className="grid grid-cols-7 gap-px">
      {cells.map((cell, i) => (
        <div
          key={i}
          className={`text-center text-[8px] leading-4 rounded-sm ${
            cell.day === null
              ? ''
              : cell.active
                ? 'bg-primary text-primary-foreground font-medium'
                : 'text-muted-foreground/40'
          }`}
        >
          {cell.day ?? ''}
        </div>
      ))}
    </div>
  );
}
