'use client';

import { useMemo, useState } from 'react';
import { useMutation } from 'convex/react';
import { api } from '@/convex/_generated/api';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Upload, FileSpreadsheet, AlertCircle, CheckCircle2 } from 'lucide-react';
import { toast } from 'sonner';
import { chunkArray } from '@/lib/chunked-bulk';
import { useAuthQuery } from '@/hooks/use-auth-query';
import { Id } from '@/convex/_generated/dataModel';

interface ImportCsvDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  customerId: Id<'customers'>;
  workosOrgId: string;
  userId: string;
}

interface ParsedStop {
  address: string;
  city: string;
  state: string;
  zip: string;
  stopOrder: number;
  stopType: 'Pickup' | 'Delivery';
  type: 'APPT' | 'FCFS' | 'Live';
  arrivalTime: string;
  facilityId?: Id<'facilities'>;
  nassCode?: string;
}

interface ParsedLane {
  hcr: string;
  tripNumber: string;
  contractName?: string;
  rateType: 'Flat Rate' | 'Per Mile' | 'Per Stop';
  rate: number;
  contractPeriodStart?: string;
  contractPeriodEnd?: string;
  lanePriority?: 'Primary' | 'Secondary';
  notes?: string;
  stops?: ParsedStop[];
  miles?: number;
  loadCommodity?: string;
  equipmentClass?: 'Bobtail' | 'Dry Van' | 'Refrigerated' | 'Flatbed' | 'Tanker';
  equipmentSize?: '53ft' | '48ft' | '45ft';
  currency?: 'USD' | 'CAD' | 'MXN';
  minimumRate?: number;
  minimumQuantity?: number;
  scheduleRule?: {
    activeDays: number[];
    excludeFederalHolidays: boolean;
    customExclusions: string[];
  };
  subsidiary?: string;
  isActive?: boolean;
}

interface FacilityRow {
  _id: Id<'facilities'>;
  name: string;
  addressLine1?: string;
  city: string;
  state: string;
  postalCode?: string;
  externalCode?: string;
}

/* ────────────────────────────────────────────────────────────────────
 *  CSV primitives
 * ──────────────────────────────────────────────────────────────── */

/** Quote-aware CSV line splitter — addresses and notes contain commas. */
function splitCsvLine(line: string): string[] {
  const out: string[] = [];
  let cur = '';
  let inQuotes = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (inQuotes) {
      if (ch === '"') {
        if (line[i + 1] === '"') {
          cur += '"';
          i++;
        } else {
          inQuotes = false;
        }
      } else {
        cur += ch;
      }
    } else if (ch === '"') {
      inQuotes = true;
    } else if (ch === ',') {
      out.push(cur.trim());
      cur = '';
    } else {
      cur += ch;
    }
  }
  out.push(cur.trim());
  return out;
}

const DAY_INDEX: Record<string, number> = {
  sun: 0, sunday: 0,
  mon: 1, monday: 1,
  tue: 2, tues: 2, tuesday: 2,
  wed: 3, wednesday: 3,
  thu: 4, thur: 4, thurs: 4, thursday: 4,
  fri: 5, friday: 5,
  sat: 6, saturday: 6,
};

/** "Mon;Tue;Wed", "mon tue", "1;2;3" → sorted unique day indices. */
function parseDays(raw: string): number[] | null {
  const parts = raw.split(/[;|\s/]+/).map((p) => p.trim().toLowerCase()).filter(Boolean);
  if (parts.length === 0) return null;
  const days = new Set<number>();
  for (const p of parts) {
    if (/^[0-6]$/.test(p)) {
      days.add(Number(p));
    } else if (DAY_INDEX[p] !== undefined) {
      days.add(DAY_INDEX[p]);
    } else {
      return null;
    }
  }
  return [...days].sort((a, b) => a - b);
}

function parseBool(raw: string): boolean | null {
  const s = raw.trim().toLowerCase();
  if (['true', 'yes', 'y', '1'].includes(s)) return true;
  if (['false', 'no', 'n', '0'].includes(s)) return false;
  return null;
}

function normalizeRateType(raw: string): ParsedLane['rateType'] | null {
  const s = raw.trim().toLowerCase();
  if (s === 'per mile' || s === 'per-mile' || s === 'mile') return 'Per Mile';
  if (s === 'flat rate' || s === 'flat' || s === 'flat-rate') return 'Flat Rate';
  if (s === 'per stop' || s === 'per-stop' || s === 'stop') return 'Per Stop';
  return null;
}

function normalizeEquipmentClass(raw: string): ParsedLane['equipmentClass'] | null {
  const s = raw.trim().toLowerCase();
  if (s === 'bobtail') return 'Bobtail';
  if (s === 'dry van' || s === 'dryvan' || s === 'van') return 'Dry Van';
  if (s === 'refrigerated' || s === 'reefer') return 'Refrigerated';
  if (s === 'flatbed') return 'Flatbed';
  if (s === 'tanker') return 'Tanker';
  return null;
}

function normalizeEquipmentSize(raw: string): ParsedLane['equipmentSize'] | null {
  const s = raw.trim().toLowerCase().replace(/['′ft]+$/, '');
  if (s === '53') return '53ft';
  if (s === '48') return '48ft';
  if (s === '45') return '45ft';
  return null;
}

function normalizeAppt(raw: string): ParsedStop['type'] | null {
  const s = raw.trim().toLowerCase();
  if (s === 'appt' || s === 'appointment') return 'APPT';
  if (s === 'fcfs' || s.startsWith('first come') || s.startsWith('first-come')) return 'FCFS';
  if (s === 'live') return 'Live';
  return null;
}

/* ────────────────────────────────────────────────────────────────────
 *  Parser
 * ──────────────────────────────────────────────────────────────── */

function parseCsv(
  text: string,
  facilities: FacilityRow[],
): { lanes: ParsedLane[]; errors: string[] } {
  const lines = text.split('\n').filter((line) => line.trim());
  if (lines.length < 2) {
    return { lanes: [], errors: ['CSV file is empty or has no data rows'] };
  }

  const header = splitCsvLine(lines[0]).map((h) => h.toLowerCase().replace(/\s+/g, ''));
  const lanes: ParsedLane[] = [];
  const errors: string[] = [];

  const requiredColumns = ['hcr', 'tripnumber', 'ratetype', 'rate'];
  const missingColumns = requiredColumns.filter((col) => !header.includes(col));
  if (missingColumns.length > 0) {
    errors.push(`Missing required columns: ${missingColumns.join(', ')}`);
    return { lanes, errors };
  }

  // How many stopN_ groups does the header carry?
  let maxStops = 0;
  for (const h of header) {
    const m = /^stop(\d+)_/.exec(h);
    if (m) maxStops = Math.max(maxStops, Number(m[1]));
  }

  // Facility lookup by name OR code (case-insensitive). Codes take
  // priority on collision — they're the more precise identifier.
  const facilityByKey = new Map<string, FacilityRow>();
  for (const f of facilities) {
    facilityByKey.set(f.name.trim().toLowerCase(), f);
  }
  for (const f of facilities) {
    if (f.externalCode) facilityByKey.set(f.externalCode.trim().toLowerCase(), f);
  }

  for (let i = 1; i < lines.length; i++) {
    const values = splitCsvLine(lines[i]);
    if (values.length !== header.length) {
      errors.push(`Row ${i + 1}: Column count mismatch (${values.length} values, ${header.length} columns)`);
      continue;
    }

    const row: Record<string, string> = {};
    header.forEach((col, idx) => {
      row[col] = values[idx];
    });

    if (!row.hcr || !row.tripnumber || !row.ratetype || !row.rate) {
      errors.push(`Row ${i + 1}: Missing required fields (hcr, tripNumber, rateType, rate)`);
      continue;
    }

    const rateType = normalizeRateType(row.ratetype);
    if (!rateType) {
      errors.push(`Row ${i + 1}: Invalid rate type '${row.ratetype}' (Per Mile / Flat Rate / Per Stop)`);
      continue;
    }

    const rate = parseFloat(row.rate);
    if (isNaN(rate) || rate < 0) {
      errors.push(`Row ${i + 1}: Invalid rate value`);
      continue;
    }

    const lane: ParsedLane = {
      hcr: row.hcr,
      tripNumber: row.tripnumber,
      contractName: row.contractname || `Lane: ${row.hcr}/${row.tripnumber}`,
      rateType,
      rate,
      contractPeriodStart: row.contractperiodstart || undefined,
      contractPeriodEnd: row.contractperiodend || undefined,
      notes: row.notes || undefined,
      loadCommodity: row.loadcommodity || undefined,
      subsidiary: row.subsidiary || undefined,
    };

    let rowFailed = false;
    const fail = (msg: string) => {
      errors.push(`Row ${i + 1}: ${msg}`);
      rowFailed = true;
    };

    if (row.priority) {
      const p = row.priority.trim().toLowerCase();
      if (p === 'primary') lane.lanePriority = 'Primary';
      else if (p === 'secondary') lane.lanePriority = 'Secondary';
      else fail(`Invalid priority '${row.priority}' (Primary / Secondary)`);
    }

    if (row.miles) {
      const miles = parseFloat(row.miles);
      if (isNaN(miles) || miles < 0) fail('Invalid miles value');
      else lane.miles = miles;
    }

    if (row.equipmentclass) {
      const ec = normalizeEquipmentClass(row.equipmentclass);
      if (!ec) fail(`Invalid equipment class '${row.equipmentclass}' (Bobtail / Dry Van / Refrigerated / Flatbed / Tanker)`);
      else lane.equipmentClass = ec;
    }

    if (row.equipmentsize) {
      const es = normalizeEquipmentSize(row.equipmentsize);
      if (!es) fail(`Invalid equipment size '${row.equipmentsize}' (53ft / 48ft / 45ft)`);
      else lane.equipmentSize = es;
    }

    if (row.currency) {
      const c = row.currency.trim().toUpperCase();
      if (c === 'USD' || c === 'CAD' || c === 'MXN') lane.currency = c;
      else fail(`Invalid currency '${row.currency}' (USD / CAD / MXN)`);
    }

    if (row.minimumrate) {
      const mr = parseFloat(row.minimumrate);
      if (isNaN(mr) || mr < 0) fail('Invalid minimumRate value');
      else lane.minimumRate = mr;
    }

    if (row.minimumquantity) {
      const mq = parseFloat(row.minimumquantity);
      if (isNaN(mq) || mq < 0) fail('Invalid minimumQuantity value');
      else lane.minimumQuantity = mq;
    }

    if (row.active) {
      const b = parseBool(row.active);
      if (b === null) fail(`Invalid active value '${row.active}' (yes / no)`);
      else lane.isActive = b;
    }

    if (row.operatingdays) {
      const days = parseDays(row.operatingdays);
      if (!days) {
        fail(`Invalid operatingDays '${row.operatingdays}' (e.g. "Mon;Tue;Wed;Thu;Fri")`);
      } else {
        let excludeHolidays = true;
        if (row.excludeholidays) {
          const b = parseBool(row.excludeholidays);
          if (b === null) fail(`Invalid excludeHolidays value '${row.excludeholidays}' (yes / no)`);
          else excludeHolidays = b;
        }
        lane.scheduleRule = {
          activeDays: days,
          excludeFederalHolidays: excludeHolidays,
          customExclusions: [],
        };
      }
    }

    // ── Stops — numbered stopN_* column groups. A group counts when any
    // of facility/address/city is filled. `stopN_facility` may be a
    // facility name or code; a match binds the facility and fills any
    // address fields the CSV leaves blank.
    const stops: ParsedStop[] = [];
    for (let n = 1; n <= maxStops; n++) {
      const g = (suffix: string) => row[`stop${n}_${suffix}`] ?? '';
      const facilityRef = g('facility');
      if (!facilityRef && !g('address') && !g('city')) continue;

      const facility = facilityRef
        ? facilityByKey.get(facilityRef.trim().toLowerCase())
        : undefined;
      if (facilityRef && !facility) {
        fail(`Stop ${n}: no facility matches '${facilityRef}' (by name or code)`);
        continue;
      }

      const stop: ParsedStop = {
        address: g('address') || facility?.addressLine1 || '',
        city: g('city') || facility?.city || '',
        state: g('state') || facility?.state || '',
        zip: g('zip') || facility?.postalCode || '',
        stopOrder: stops.length + 1,
        stopType: stops.length === 0 ? 'Pickup' : 'Delivery',
        type: 'APPT',
        arrivalTime: g('time') || '',
        facilityId: facility?._id,
        nassCode: facility?.externalCode || undefined,
      };

      const st = g('type').trim().toLowerCase();
      if (st === 'pickup') stop.stopType = 'Pickup';
      else if (st === 'delivery') stop.stopType = 'Delivery';
      else if (st) fail(`Stop ${n}: invalid type '${g('type')}' (Pickup / Delivery)`);

      if (g('appt')) {
        const appt = normalizeAppt(g('appt'));
        if (!appt) fail(`Stop ${n}: invalid appointment '${g('appt')}' (Appointment / FCFS / Live)`);
        else stop.type = appt;
      }

      if (!stop.address || !stop.city || !stop.state) {
        fail(`Stop ${n}: needs an address, city, and state (directly or via a matched facility)`);
      }

      stops.push(stop);
    }
    if (stops.length > 0) lane.stops = stops;

    if (rowFailed) continue;
    lanes.push(lane);
  }

  return { lanes, errors };
}

/* ────────────────────────────────────────────────────────────────────
 *  Dialog
 * ──────────────────────────────────────────────────────────────── */

export function ImportCsvDialog({
  open,
  onOpenChange,
  customerId,
  workosOrgId,
  userId,
}: ImportCsvDialogProps) {
  const [file, setFile] = useState<File | null>(null);
  const [csvText, setCsvText] = useState<string | null>(null);
  const [isProcessing, setIsProcessing] = useState(false);

  const bulkImportLanes = useMutation(api.contractLanes.bulkImport);

  // Customer facility registry — lets stopN_facility columns reference a
  // facility by name or code instead of spelling out the address.
  const facilitiesQ = useAuthQuery(
    api.facilities.listByCustomer,
    open ? { customerId } : 'skip',
  );

  // Re-parse when either the file text or the facility registry lands, so
  // a facility reference resolves even if the query finished after upload.
  const { lanes: preview, errors } = useMemo(
    () =>
      csvText
        ? parseCsv(csvText, (facilitiesQ ?? []) as FacilityRow[])
        : { lanes: [], errors: [] },
    [csvText, facilitiesQ],
  );

  const handleFileChange = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const selectedFile = e.target.files?.[0];
    if (!selectedFile) return;

    if (!selectedFile.name.endsWith('.csv')) {
      toast.error('Please upload a CSV file');
      return;
    }

    setFile(selectedFile);
    try {
      setCsvText(await selectedFile.text());
    } catch (error) {
      toast.error('Failed to read CSV file');
      console.error(error);
    }
  };

  const handleImport = async () => {
    if (preview.length === 0) {
      toast.error('No valid lanes to import');
      return;
    }

    setIsProcessing(true);
    try {
      // Each lane does a dedup index-scan + insert + facet writes, so a large
      // CSV in one mutation would exceed Convex's ~1s budget. Chunk sequentially
      // — dedup still works because committed chunks are visible to later ones.
      const result = { imported: 0, skipped: 0 };
      for (const chunk of chunkArray(preview, 30)) {
        const r = await bulkImportLanes({ customerId, workosOrgId, userId, lanes: chunk });
        result.imported += r.imported;
        result.skipped += r.skipped;
      }

      toast.success(`Successfully imported ${result.imported} contract lane(s)`);
      if (result.skipped > 0) {
        toast.info(`Skipped ${result.skipped} duplicate lane(s)`);
      }
      if (result.imported > 0) {
        toast.info('New lanes imported. Existing SPOT loads will match on the next scheduled sync.', {
          duration: 7000,
        });
      }

      onOpenChange(false);
      setFile(null);
      setCsvText(null);
    } catch (error) {
      toast.error(error instanceof Error ? error.message : 'Failed to import contract lanes');
    } finally {
      setIsProcessing(false);
    }
  };

  const downloadTemplate = () => {
    const header = [
      'hcr', 'tripNumber', 'contractName', 'rateType', 'rate',
      'contractPeriodStart', 'contractPeriodEnd', 'priority', 'active',
      'miles', 'loadCommodity', 'equipmentClass', 'equipmentSize',
      'currency', 'minimumRate', 'minimumQuantity', 'subsidiary',
      'operatingDays', 'excludeHolidays', 'notes',
      'stop1_facility', 'stop1_address', 'stop1_city', 'stop1_state', 'stop1_zip', 'stop1_type', 'stop1_appt', 'stop1_time',
      'stop2_facility', 'stop2_address', 'stop2_city', 'stop2_state', 'stop2_zip', 'stop2_type', 'stop2_appt', 'stop2_time',
    ].join(',');
    const rows = [
      // Stop addresses spelled out directly.
      '925L0,210,Lane: Customer A - 210,Per Mile,2.30,2026-01-01,2026-12-31,Primary,yes,177.1,US Mail,Dry Van,53ft,USD,,,,"Mon;Tue;Wed;Thu;Fri",yes,,,"3000 Power Inn Rd",Sacramento,CA,95826,Pickup,Appointment,07:45,,"4600 E University Dr",Phoenix,AZ,85034,Delivery,FCFS,14:30',
      // Stops referenced by facility name or code — address fields stay
      // blank and fill from the facility registry.
      '925L0,246,Lane: Customer A - 246,Flat Rate,1500.00,2026-01-01,2026-12-31,Secondary,yes,,,,,USD,,,,"Mon;Wed;Fri",yes,,Sacramento DC,,,,,Pickup,Appointment,06:00,PHX01,,,,,Delivery,Live,15:00',
    ];
    const template = [header, ...rows].join('\n');

    const blob = new Blob([template], { type: 'text/csv' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = 'contract_lanes_template.csv';
    a.click();
    URL.revokeObjectURL(url);
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-2xl max-h-[80vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle>Import Contract Lanes from CSV</DialogTitle>
          <DialogDescription>
            Upload a CSV file to bulk import contract lanes. Only hcr, tripNumber,
            rateType, and rate are required — every other lane field (term, priority,
            equipment, schedule, minimums, stops…) imports when its column is present.
            Stops can spell out addresses or reference a facility by name or code
            (stop1_facility) to pull the address from the registry. The next FourKites
            sync will automatically match quarantined and SPOT loads against the new lanes.
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-4">
          {/* Template Download */}
          <div className="flex items-center gap-2">
            <Button variant="outline" size="sm" onClick={downloadTemplate}>
              <FileSpreadsheet className="mr-2 h-4 w-4" />
              Download Template
            </Button>
          </div>

          {/* File Upload */}
          <div className="border-2 border-dashed rounded-lg p-6">
            <div className="flex flex-col items-center gap-2 text-center">
              <Upload className="h-8 w-8 text-muted-foreground" />
              <div>
                <label htmlFor="csv-file" className="cursor-pointer">
                  <span className="text-sm font-medium text-blue-600 hover:text-blue-500">
                    Choose a CSV file
                  </span>
                  <input
                    id="csv-file"
                    type="file"
                    accept=".csv"
                    className="hidden"
                    onChange={handleFileChange}
                  />
                </label>
                <p className="text-xs text-muted-foreground mt-1">or drag and drop</p>
              </div>
              {file && (
                <div className="text-sm text-foreground font-medium mt-2">
                  <FileSpreadsheet className="inline h-4 w-4 mr-1" />
                  {file.name}
                </div>
              )}
            </div>
          </div>

          {/* Errors */}
          {errors.length > 0 && (
            <div className="p-3 bg-red-50 border border-red-200 rounded-lg">
              <div className="flex items-start gap-2">
                <AlertCircle className="h-4 w-4 text-red-600 mt-0.5" />
                <div className="flex-1">
                  <p className="text-sm font-medium text-red-900">Found {errors.length} error(s):</p>
                  <ul className="text-xs text-red-700 mt-1 list-disc list-inside">
                    {errors.slice(0, 5).map((error, idx) => (
                      <li key={idx}>{error}</li>
                    ))}
                    {errors.length > 5 && <li>... and {errors.length - 5} more</li>}
                  </ul>
                </div>
              </div>
            </div>
          )}

          {/* Preview */}
          {preview.length > 0 && (
            <div className="p-3 bg-green-50 border border-green-200 rounded-lg">
              <div className="flex items-start gap-2">
                <CheckCircle2 className="h-4 w-4 text-green-600 mt-0.5" />
                <div className="flex-1">
                  <p className="text-sm font-medium text-green-900">
                    Ready to import {preview.length} contract lane(s)
                  </p>
                  <div className="text-xs text-green-700 mt-2 max-h-32 overflow-y-auto">
                    {preview.slice(0, 5).map((lane, idx) => (
                      <div key={idx} className="font-mono">
                        {lane.hcr}/{lane.tripNumber} - {lane.rateType} ${lane.rate}
                        {lane.stops ? ` · ${lane.stops.length} stop(s)` : ''}
                        {lane.scheduleRule ? ` · ${lane.scheduleRule.activeDays.length}d/wk` : ''}
                      </div>
                    ))}
                    {preview.length > 5 && <div className="mt-1">... and {preview.length - 5} more</div>}
                  </div>
                </div>
              </div>
            </div>
          )}
        </div>

        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)} disabled={isProcessing}>
            Cancel
          </Button>
          <Button onClick={handleImport} disabled={preview.length === 0 || isProcessing}>
            {isProcessing ? 'Importing...' : `Import ${preview.length} Lane(s)`}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
