'use client';

import { useState } from 'react';
import { useMutation } from 'convex/react';
import { api } from '@/convex/_generated/api';
import { Id } from '@/convex/_generated/dataModel';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Switch } from '@/components/ui/switch';
import { Checkbox } from '@/components/ui/checkbox';
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
} from '@/components/ui/dialog';
import { toast } from 'sonner';
import { Plus, Trash2, GripVertical } from 'lucide-react';

interface LaneEntryFormProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  sessionId: Id<'laneAnalysisSessions'>;
  organizationId: string;
}

const DAYS_OF_WEEK = [
  { label: 'Sun', value: 0 },
  { label: 'Mon', value: 1 },
  { label: 'Tue', value: 2 },
  { label: 'Wed', value: 3 },
  { label: 'Thu', value: 4 },
  { label: 'Fri', value: 5 },
  { label: 'Sat', value: 6 },
];

interface IntermediateStop {
  address: string;
  city: string;
  state: string;
  zip: string;
  stopType: 'Pickup' | 'Delivery';
  type: 'APPT' | 'FCFS' | 'Live';
  arrivalTime: string;
  arrivalEndTime: string;
}

const EMPTY_STOP: IntermediateStop = {
  address: '', city: '', state: '', zip: '',
  stopType: 'Delivery', type: 'APPT', arrivalTime: '', arrivalEndTime: '',
};

type ApptType = 'APPT' | 'FCFS' | 'Live';

export function LaneEntryForm({ open, onOpenChange, sessionId, organizationId }: LaneEntryFormProps) {
  const createEntry = useMutation(api.laneAnalyzer.createEntry);

  const [name, setName] = useState('');
  const [originAddress, setOriginAddress] = useState('');
  const [originCity, setOriginCity] = useState('');
  const [originState, setOriginState] = useState('');
  const [originZip, setOriginZip] = useState('');
  const [originApptType, setOriginApptType] = useState<ApptType>('APPT');
  const [originScheduledTime, setOriginScheduledTime] = useState('');
  const [originScheduledEndTime, setOriginScheduledEndTime] = useState('');
  const [intermediateStops, setIntermediateStops] = useState<IntermediateStop[]>([]);
  const [destAddress, setDestAddress] = useState('');
  const [destCity, setDestCity] = useState('');
  const [destState, setDestState] = useState('');
  const [destZip, setDestZip] = useState('');
  const [destApptType, setDestApptType] = useState<ApptType>('APPT');
  const [destScheduledTime, setDestScheduledTime] = useState('');
  const [destScheduledEndTime, setDestScheduledEndTime] = useState('');
  const [routeMiles, setRouteMiles] = useState('');
  const [routeDuration, setRouteDuration] = useState('');
  const [isRoundTrip, setIsRoundTrip] = useState(false);
  const [isCityRoute, setIsCityRoute] = useState(false);
  const [activeDays, setActiveDays] = useState<number[]>([1, 2, 3, 4, 5]);
  const [excludeHolidays, setExcludeHolidays] = useState(true);
  const [rateType, setRateType] = useState<'Per Mile' | 'Flat Rate' | 'Per Stop'>('Flat Rate');
  const [rateValue, setRateValue] = useState('');
  const [equipmentClass, setEquipmentClass] = useState('Dry Van');

  const toggleDay = (day: number) => {
    setActiveDays((prev) =>
      prev.includes(day) ? prev.filter((d) => d !== day) : [...prev, day].sort(),
    );
  };

  const addStop = () => setIntermediateStops((prev) => [...prev, { ...EMPTY_STOP }]);
  const removeStop = (idx: number) => setIntermediateStops((prev) => prev.filter((_, i) => i !== idx));
  const updateStop = (idx: number, field: keyof IntermediateStop, value: string) => {
    setIntermediateStops((prev) => prev.map((s, i) => (i === idx ? { ...s, [field]: value } : s)));
  };
  const moveStop = (idx: number, direction: 'up' | 'down') => {
    setIntermediateStops((prev) => {
      const next = [...prev];
      const swapIdx = direction === 'up' ? idx - 1 : idx + 1;
      if (swapIdx < 0 || swapIdx >= next.length) return prev;
      [next[idx], next[swapIdx]] = [next[swapIdx], next[idx]];
      return next;
    });
  };

  const resetForm = () => {
    setName('');
    setOriginAddress('');
    setOriginCity('');
    setOriginState('');
    setOriginZip('');
    setOriginApptType('APPT');
    setOriginScheduledTime('');
    setOriginScheduledEndTime('');
    setIntermediateStops([]);
    setDestAddress('');
    setDestCity('');
    setDestState('');
    setDestZip('');
    setDestApptType('APPT');
    setDestScheduledTime('');
    setDestScheduledEndTime('');
    setRouteMiles('');
    setRouteDuration('');
    setIsRoundTrip(false);
    setIsCityRoute(false);
    setActiveDays([1, 2, 3, 4, 5]);
    setExcludeHolidays(true);
    setRateType('Flat Rate');
    setRateValue('');
    setEquipmentClass('Dry Van');
  };

  const handleSubmit = async () => {
    if (!name || !originCity || !originState || !destCity || !destState) {
      toast.error('Please fill in required fields');
      return;
    }

    try {
      // Build lane name with stops
      const stopCities = intermediateStops.filter((s) => s.city).map((s) => s.city);
      const defaultName = stopCities.length > 0
        ? `${originCity}, ${originState} → ${stopCities.join(' → ')} → ${destCity}, ${destState}`
        : `${originCity}, ${originState} → ${destCity}, ${destState}`;

      await createEntry({
        sessionId,
        workosOrgId: organizationId,
        name: name || defaultName,
        originAddress: originAddress || `${originCity}, ${originState}`,
        originCity,
        originState,
        originZip,
        originStopType: 'Pickup' as const,
        originAppointmentType: originApptType,
        originScheduledTime: originScheduledTime || undefined,
        originScheduledEndTime: originScheduledEndTime || undefined,
        destinationAddress: destAddress || `${destCity}, ${destState}`,
        destinationCity: destCity,
        destinationState: destState,
        destinationZip: destZip,
        destinationStopType: 'Delivery' as const,
        destinationAppointmentType: destApptType,
        destinationScheduledTime: destScheduledTime || undefined,
        destinationScheduledEndTime: destScheduledEndTime || undefined,
        intermediateStops: intermediateStops.length > 0
          ? intermediateStops.map((s, i) => ({
              address: s.address || `${s.city}, ${s.state}`,
              city: s.city,
              state: s.state,
              zip: s.zip,
              stopOrder: i + 1,
              stopType: s.stopType,
              type: s.type,
              arrivalTime: s.arrivalTime || undefined,
              arrivalEndTime: s.arrivalEndTime || undefined,
            }))
          : undefined,
        routeMiles: routeMiles ? parseFloat(routeMiles) : undefined,
        routeDurationHours: routeDuration ? parseFloat(routeDuration) : undefined,
        isRoundTrip,
        isCityRoute,
        scheduleRule: {
          activeDays,
          excludeFederalHolidays: excludeHolidays,
          customExclusions: [],
        },
        rateType,
        ratePerRun: rateType === 'Flat Rate' ? parseFloat(rateValue) || undefined : undefined,
        ratePerMile: rateType === 'Per Mile' ? parseFloat(rateValue) || undefined : undefined,
        equipmentClass: equipmentClass as 'Dry Van' | 'Refrigerated' | 'Flatbed' | 'Tanker' | 'Bobtail',
        includedStops: intermediateStops.length > 0 ? intermediateStops.length + 2 : undefined,
      });

      toast.success('Lane added');
      resetForm();
      onOpenChange(false);
    } catch (error) {
      toast.error('Failed to add lane');
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-2xl max-h-[85vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle>Add Lane</DialogTitle>
          <DialogDescription>Define a new contracted lane for analysis.</DialogDescription>
        </DialogHeader>

        <div className="grid gap-4 py-4">
          {/* Lane Name */}
          <div className="grid gap-2">
            <Label>Lane Name</Label>
            <Input
              placeholder="e.g. Detroit → Chicago Daily"
              value={name}
              onChange={(e) => setName(e.target.value)}
            />
          </div>

          {/* Origin */}
          <div className="space-y-2">
            <Label className="text-sm font-semibold">Origin (Pickup)</Label>
            <div className="grid grid-cols-4 gap-2">
              <Input placeholder="Address" value={originAddress} onChange={(e) => setOriginAddress(e.target.value)} className="col-span-2" />
              <Input placeholder="City *" value={originCity} onChange={(e) => setOriginCity(e.target.value)} />
              <div className="flex gap-2">
                <Input placeholder="ST *" value={originState} onChange={(e) => setOriginState(e.target.value)} className="w-16" />
                <Input placeholder="Zip" value={originZip} onChange={(e) => setOriginZip(e.target.value)} />
              </div>
            </div>
            <div className="flex items-center gap-2">
              <Select value={originApptType} onValueChange={(v) => setOriginApptType(v as ApptType)}>
                <SelectTrigger className="h-8 w-24 text-xs">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="APPT">APPT</SelectItem>
                  <SelectItem value="FCFS">FCFS</SelectItem>
                  <SelectItem value="Live">Live</SelectItem>
                </SelectContent>
              </Select>
              {originApptType === 'APPT' && (
                <>
                  <Input
                    type="time"
                    value={originScheduledTime}
                    onChange={(e) => setOriginScheduledTime(e.target.value)}
                    className="h-8 w-32 text-xs"
                  />
                  <span className="text-xs text-muted-foreground">to</span>
                  <Input
                    type="time"
                    value={originScheduledEndTime}
                    onChange={(e) => setOriginScheduledEndTime(e.target.value)}
                    className="h-8 w-32 text-xs"
                  />
                </>
              )}
              {originApptType === 'FCFS' && (
                <>
                  <Input
                    type="time"
                    value={originScheduledTime}
                    onChange={(e) => setOriginScheduledTime(e.target.value)}
                    className="h-8 w-32 text-xs"
                    placeholder="Opens"
                  />
                  <span className="text-xs text-muted-foreground">to</span>
                  <Input
                    type="time"
                    value={originScheduledEndTime}
                    onChange={(e) => setOriginScheduledEndTime(e.target.value)}
                    className="h-8 w-32 text-xs"
                    placeholder="Closes"
                  />
                </>
              )}
            </div>
          </div>

          {/* Intermediate Stops */}
          {intermediateStops.length > 0 && (
            <div className="space-y-3">
              <Label className="text-sm font-semibold">
                Stops ({intermediateStops.length})
              </Label>
              {intermediateStops.map((stop, idx) => (
                <div key={idx} className="rounded-md border bg-muted/30 p-3 space-y-2">
                  <div className="flex items-center justify-between">
                    <div className="flex items-center gap-2">
                      <span className="text-xs font-medium text-muted-foreground">
                        Stop {idx + 1}
                      </span>
                      <Select
                        value={stop.stopType}
                        onValueChange={(v) => updateStop(idx, 'stopType', v)}
                      >
                        <SelectTrigger className="h-7 w-24 text-xs">
                          <SelectValue />
                        </SelectTrigger>
                        <SelectContent>
                          <SelectItem value="Pickup">Pickup</SelectItem>
                          <SelectItem value="Delivery">Delivery</SelectItem>
                        </SelectContent>
                      </Select>
                      <Select
                        value={stop.type}
                        onValueChange={(v) => updateStop(idx, 'type', v)}
                      >
                        <SelectTrigger className="h-7 w-20 text-xs">
                          <SelectValue />
                        </SelectTrigger>
                        <SelectContent>
                          <SelectItem value="APPT">APPT</SelectItem>
                          <SelectItem value="FCFS">FCFS</SelectItem>
                          <SelectItem value="Live">Live</SelectItem>
                        </SelectContent>
                      </Select>
                      {stop.type !== 'Live' && (
                        <>
                          <Input
                            type="time"
                            value={stop.arrivalTime}
                            onChange={(e) => updateStop(idx, 'arrivalTime', e.target.value)}
                            className="h-7 w-28 text-xs"
                          />
                          <span className="text-xs text-muted-foreground">to</span>
                          <Input
                            type="time"
                            value={stop.arrivalEndTime}
                            onChange={(e) => updateStop(idx, 'arrivalEndTime', e.target.value)}
                            className="h-7 w-28 text-xs"
                          />
                        </>
                      )}
                    </div>
                    <div className="flex items-center gap-1">
                      {idx > 0 && (
                        <Button variant="ghost" size="icon" className="h-6 w-6" onClick={() => moveStop(idx, 'up')}>
                          <GripVertical className="h-3 w-3 rotate-180" />
                        </Button>
                      )}
                      {idx < intermediateStops.length - 1 && (
                        <Button variant="ghost" size="icon" className="h-6 w-6" onClick={() => moveStop(idx, 'down')}>
                          <GripVertical className="h-3 w-3" />
                        </Button>
                      )}
                      <Button variant="ghost" size="icon" className="h-6 w-6 text-destructive" onClick={() => removeStop(idx)}>
                        <Trash2 className="h-3 w-3" />
                      </Button>
                    </div>
                  </div>
                  <div className="grid grid-cols-4 gap-2">
                    <Input placeholder="Address" value={stop.address} onChange={(e) => updateStop(idx, 'address', e.target.value)} className="col-span-2 h-8 text-sm" />
                    <Input placeholder="City *" value={stop.city} onChange={(e) => updateStop(idx, 'city', e.target.value)} className="h-8 text-sm" />
                    <div className="flex gap-2">
                      <Input placeholder="ST *" value={stop.state} onChange={(e) => updateStop(idx, 'state', e.target.value)} className="w-16 h-8 text-sm" />
                      <Input placeholder="Zip" value={stop.zip} onChange={(e) => updateStop(idx, 'zip', e.target.value)} className="h-8 text-sm" />
                    </div>
                  </div>
                </div>
              ))}
            </div>
          )}

          {/* Add Stop Button */}
          <Button
            type="button"
            variant="outline"
            size="sm"
            onClick={addStop}
            className="w-fit"
          >
            <Plus className="h-3.5 w-3.5 mr-1.5" />
            Add Stop
          </Button>

          {/* Destination */}
          <div className="space-y-2">
            <Label className="text-sm font-semibold">
              Destination (Final Delivery)
            </Label>
            <div className="grid grid-cols-4 gap-2">
              <Input placeholder="Address" value={destAddress} onChange={(e) => setDestAddress(e.target.value)} className="col-span-2" />
              <Input placeholder="City *" value={destCity} onChange={(e) => setDestCity(e.target.value)} />
              <div className="flex gap-2">
                <Input placeholder="ST *" value={destState} onChange={(e) => setDestState(e.target.value)} className="w-16" />
                <Input placeholder="Zip" value={destZip} onChange={(e) => setDestZip(e.target.value)} />
              </div>
            </div>
            <div className="flex items-center gap-2">
              <Select value={destApptType} onValueChange={(v) => setDestApptType(v as ApptType)}>
                <SelectTrigger className="h-8 w-24 text-xs">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="APPT">APPT</SelectItem>
                  <SelectItem value="FCFS">FCFS</SelectItem>
                  <SelectItem value="Live">Live</SelectItem>
                </SelectContent>
              </Select>
              {destApptType !== 'Live' && (
                <>
                  <Input
                    type="time"
                    value={destScheduledTime}
                    onChange={(e) => setDestScheduledTime(e.target.value)}
                    className="h-8 w-32 text-xs"
                  />
                  <span className="text-xs text-muted-foreground">to</span>
                  <Input
                    type="time"
                    value={destScheduledEndTime}
                    onChange={(e) => setDestScheduledEndTime(e.target.value)}
                    className="h-8 w-32 text-xs"
                  />
                </>
              )}
            </div>
          </div>

          {/* Route Metrics */}
          <div className="grid grid-cols-4 gap-4">
            <div className="grid gap-2">
              <Label>Miles</Label>
              <Input type="number" placeholder="Auto" value={routeMiles} onChange={(e) => setRouteMiles(e.target.value)} />
            </div>
            <div className="grid gap-2">
              <Label>Duration (hrs)</Label>
              <Input type="number" step="0.5" placeholder="Auto" value={routeDuration} onChange={(e) => setRouteDuration(e.target.value)} />
            </div>
            <div className="grid gap-2">
              <Label>Equipment</Label>
              <Select value={equipmentClass} onValueChange={setEquipmentClass}>
                <SelectTrigger><SelectValue /></SelectTrigger>
                <SelectContent>
                  <SelectItem value="Dry Van">Dry Van</SelectItem>
                  <SelectItem value="Refrigerated">Refrigerated</SelectItem>
                  <SelectItem value="Flatbed">Flatbed</SelectItem>
                  <SelectItem value="Tanker">Tanker</SelectItem>
                  <SelectItem value="Bobtail">Bobtail</SelectItem>
                </SelectContent>
              </Select>
            </div>
            <div className="space-y-3 pt-6">
              <div className="flex items-center gap-2">
                <Switch checked={isRoundTrip} onCheckedChange={setIsRoundTrip} id="round-trip" />
                <Label htmlFor="round-trip" className="text-sm">Round Trip</Label>
              </div>
              <div className="flex items-center gap-2">
                <Switch checked={isCityRoute} onCheckedChange={setIsCityRoute} id="city-route" />
                <Label htmlFor="city-route" className="text-sm">City Route</Label>
              </div>
            </div>
          </div>

          {/* Schedule */}
          <div className="space-y-2">
            <Label className="text-sm font-semibold">Schedule</Label>
            <div className="flex items-center gap-2">
              {DAYS_OF_WEEK.map((day) => (
                <button
                  key={day.value}
                  type="button"
                  onClick={() => toggleDay(day.value)}
                  className={`h-8 w-10 rounded text-xs font-medium border transition-colors ${
                    activeDays.includes(day.value)
                      ? 'bg-primary text-primary-foreground border-primary'
                      : 'bg-background text-muted-foreground border-input hover:bg-accent'
                  }`}
                >
                  {day.label}
                </button>
              ))}
              <div className="ml-4 flex items-center gap-2">
                <Checkbox
                  checked={excludeHolidays}
                  onCheckedChange={(c) => setExcludeHolidays(c === true)}
                  id="exclude-holidays"
                />
                <Label htmlFor="exclude-holidays" className="text-sm">
                  Exclude federal holidays
                </Label>
              </div>
            </div>
          </div>

          {/* Rate */}
          <div className="grid grid-cols-3 gap-4">
            <div className="grid gap-2">
              <Label>Rate Type</Label>
              <Select value={rateType} onValueChange={(v) => setRateType(v as typeof rateType)}>
                <SelectTrigger><SelectValue /></SelectTrigger>
                <SelectContent>
                  <SelectItem value="Flat Rate">Flat Rate</SelectItem>
                  <SelectItem value="Per Mile">Per Mile</SelectItem>
                  <SelectItem value="Per Stop">Per Stop</SelectItem>
                </SelectContent>
              </Select>
            </div>
            <div className="grid gap-2">
              <Label>
                Rate ($)
                {rateType === 'Per Mile' && ' / mi'}
                {rateType === 'Per Stop' && ' / stop'}
              </Label>
              <Input
                type="number"
                step="0.01"
                placeholder="0.00"
                value={rateValue}
                onChange={(e) => setRateValue(e.target.value)}
              />
            </div>
          </div>
        </div>

        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button onClick={handleSubmit}>Add Lane</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
