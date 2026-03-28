'use client';

import { useState, useCallback, useRef } from 'react';
import { useAction, useMutation } from 'convex/react';
import { useSearchParams, useRouter } from 'next/navigation';
import { api } from '@/convex/_generated/api';
import { useAuthQuery } from '@/hooks/use-auth-query';
import { Id } from '@/convex/_generated/dataModel';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Switch } from '@/components/ui/switch';
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
import { toast } from 'sonner';
import {
  Upload,
  FileText,
  FileSpreadsheet,
  Loader2,
  Check,
  AlertCircle,
  ChevronDown,
  ChevronRight,
  X,
  Download,
} from 'lucide-react';

type Step = 'upload' | 'extracting' | 'csvMapping' | 'review';
type UploadMode = 'ocr' | 'csv';

interface CsvMapping {
  rawHeaders: string[];
  mappedHeaders: string[]; // canonical key per column
  sampleRows: string[][]; // first 3 data rows for preview
  allRows: string[][]; // all data rows
  unmapped: string[]; // headers that didn't match
}

interface OcrPage {
  imageUrl: string;
  pageText?: string;
}

interface ExtractedField<T = string> {
  value: T | null;
  confidence: 'high' | 'medium' | 'low';
}

interface ExtractedStop {
  city: string;
  state: string;
  zip: string;
  address: string;
  stopType: 'Pickup' | 'Delivery';
  apptType: 'APPT' | 'FCFS' | 'Live';
  timeStart: string;
  timeEnd: string;
}

interface ExtractedLane {
  laneName: ExtractedField;
  originCity: ExtractedField;
  originState: ExtractedField;
  originZip: ExtractedField;
  originAddress: ExtractedField;
  originApptType: ExtractedField;
  originTimeStart: ExtractedField;
  originTimeEnd: ExtractedField;
  intermediateStops: ExtractedStop[];
  destinationCity: ExtractedField;
  destinationState: ExtractedField;
  destinationZip: ExtractedField;
  destinationAddress: ExtractedField;
  destApptType: ExtractedField;
  destTimeStart: ExtractedField;
  destTimeEnd: ExtractedField;
  miles: ExtractedField<number>;
  rateType: ExtractedField;
  rate: ExtractedField<number>;
  frequency: ExtractedField;
  activeDays: ExtractedField<number[]>;
  excludeHolidays: ExtractedField<boolean>;
  equipmentType: ExtractedField;
  equipmentSize: ExtractedField;
  contractStart: ExtractedField;
  contractEnd: ExtractedField;
  hcr: ExtractedField;
  tripNumber: ExtractedField;
  isRoundTrip: ExtractedField<boolean>;
  notes: ExtractedField;
}

interface ReviewRow {
  lane: ExtractedLane;
  skip: boolean;
  expanded: boolean;
  errors: string[];
  warnings: string[];
  // Editable overrides
  overrides: {
    laneName?: string;
    originCity?: string;
    originState?: string;
    destinationCity?: string;
    destinationState?: string;
    miles?: number;
    rate?: number;
    rateType?: string;
    activeDays?: number[];
    equipmentType?: string;
    isCityRoute?: boolean;
  };
}

interface OcrLaneImportClientProps {
  organizationId: string;
  userId: string;
}

const DAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

const CSV_FIELD_OPTIONS = [
  { value: 'laneName', label: 'Lane Name' },
  { value: 'originAddress', label: 'Origin Address' },
  { value: 'originCity', label: 'Origin City' },
  { value: 'originState', label: 'Origin State' },
  { value: 'originZip', label: 'Origin Zip' },
  { value: 'originApptType', label: 'Origin Appt Type' },
  { value: 'originTimeStart', label: 'Origin Time Start' },
  { value: 'originTimeEnd', label: 'Origin Time End' },
  { value: 'destCity', label: 'Dest City' },
  { value: 'destState', label: 'Dest State' },
  { value: 'destZip', label: 'Dest Zip' },
  { value: 'destAddress', label: 'Dest Address' },
  { value: 'destApptType', label: 'Dest Appt Type' },
  { value: 'destTimeStart', label: 'Dest Time Start' },
  { value: 'destTimeEnd', label: 'Dest Time End' },
  ...Array.from({ length: 5 }, (_, i) => {
    const n = i + 1;
    return [
      { value: `stop${n}Address`, label: `Stop ${n} Address` },
      { value: `stop${n}City`, label: `Stop ${n} City` },
      { value: `stop${n}State`, label: `Stop ${n} State` },
      { value: `stop${n}Zip`, label: `Stop ${n} Zip` },
      { value: `stop${n}Type`, label: `Stop ${n} Type (PU/Del)` },
      { value: `stop${n}ApptType`, label: `Stop ${n} Appt Type` },
      { value: `stop${n}TimeStart`, label: `Stop ${n} Time Start` },
      { value: `stop${n}TimeEnd`, label: `Stop ${n} Time End` },
    ];
  }).flat(),
  { value: 'miles', label: 'Miles' },
  { value: 'rate', label: 'Rate ($)' },
  { value: 'rateType', label: 'Rate Type' },
  { value: 'activeDays', label: 'Active Days' },
  { value: 'excludeHolidays', label: 'Exclude Federal Holidays' },
  { value: 'equipment', label: 'Equipment Type' },
  { value: 'contractStart', label: 'Contract Start' },
  { value: 'contractEnd', label: 'Contract End' },
  { value: 'roundTrip', label: 'Round Trip' },
  { value: 'hcr', label: 'HCR / Route ID' },
  { value: 'tripNumber', label: 'Trip Number' },
  { value: 'notes', label: 'Notes' },
];

export function OcrLaneImportClient({ organizationId, userId }: OcrLaneImportClientProps) {
  const router = useRouter();
  const searchParams = useSearchParams();
  const sessionId = searchParams.get('sessionId');

  const [step, setStep] = useState<Step>('upload');
  const [uploadMode, setUploadMode] = useState<UploadMode>('csv');
  const [csvMapping, setCsvMapping] = useState<CsvMapping | null>(null);
  const [extractionProgress, setExtractionProgress] = useState({ current: 0, total: 0, status: '' });
  const [files, setFiles] = useState<File[]>([]);
  const [ocrPages, setOcrPages] = useState<OcrPage[]>([]);
  const [reviewRows, setReviewRows] = useState<ReviewRow[]>([]);
  const [isImporting, setIsImporting] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const csvInputRef = useRef<HTMLInputElement>(null);

  const extractLanes = useAction(api.laneScheduleImport.extractLanesFromDocument);
  const createEntry = useMutation(api.laneAnalyzer.createEntry);

  // Sessions for target selector
  const sessions = useAuthQuery(api.laneAnalyzer.listSessions, {
    workosOrgId: organizationId,
  });
  const [targetSessionId, setTargetSessionId] = useState(sessionId ?? '');

  // ---- STEP 1: UPLOAD ----

  const handleFileChange = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const selected = Array.from(e.target.files ?? []);
    if (selected.length === 0) return;
    setFiles(selected);

    const pages: OcrPage[] = [];
    setExtractionProgress({ current: 0, total: selected.length, status: 'Processing files...' });
    for (let i = 0; i < selected.length; i++) {
      const file = selected[i];
      setExtractionProgress({
        current: i + 1,
        total: selected.length,
        status: `Processing ${file.name}...`,
      });
      if (file.type === 'application/pdf') {
        const pdfPages = await renderPdfToImages(file);
        pages.push(...pdfPages);
      } else {
        const dataUrl = await fileToDataUrl(file);
        pages.push({ imageUrl: dataUrl });
      }
    }
    setExtractionProgress({ current: 0, total: 0, status: '' });
    setOcrPages(pages);
  };

  // ---- CSV IMPORT ----

  const handleCsvFile = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    setFiles([file]);

    const text = await file.text();
    const { headers: rawHeaders, rows: rawRows } = parseCsvRaw(text);

    if (rawRows.length === 0) {
      toast.error('No data rows found in CSV');
      return;
    }

    // Map each header to a canonical key
    const mappedHeaders = rawHeaders.map((h) => {
      const norm = normalizeHeader(h);
      return HEADER_MAP[norm] ?? '';
    });

    const unmapped = rawHeaders.filter((_, i) => !mappedHeaders[i]);

    setCsvMapping({
      rawHeaders,
      mappedHeaders,
      sampleRows: rawRows.slice(0, 3),
      allRows: rawRows,
      unmapped,
    });
    setStep('csvMapping');
  };

  /** User confirms mapping and proceeds to review */
  const handleConfirmCsvMapping = () => {
    if (!csvMapping) return;

    const { mappedHeaders, allRows } = csvMapping;

    // Build keyed row objects from raw rows + confirmed mapping
    const keyedRows: Record<string, string>[] = allRows.map((values) => {
      const row: Record<string, string> = {};
      mappedHeaders.forEach((key, idx) => {
        if (key && values[idx] !== undefined) {
          row[key] = values[idx].trim();
        }
      });
      return row;
    }).filter((row) => Object.values(row).some((v) => v));

    // Map to ReviewRow format
    const mapped: ReviewRow[] = keyedRows.map((row) => {
      const lane = csvRowToExtractedLane(row);
      const errors: string[] = [];
      const warnings: string[] = [];

      if (!lane.originCity.value) errors.push('Missing origin city');
      if (!lane.originState.value) errors.push('Missing origin state');
      if (!lane.destinationCity.value) errors.push('Missing destination city');
      if (!lane.destinationState.value) errors.push('Missing destination state');
      if (!lane.activeDays.value || lane.activeDays.value.length === 0) {
        warnings.push('No schedule days found – defaulting to Mon–Fri');
      }
      if (!lane.rate.value) warnings.push('No rate found');

      return { lane, skip: false, expanded: false, errors, warnings, overrides: {} };
    });

    setReviewRows(mapped);
    setStep('review');
    toast.success(`Parsed ${mapped.length} lane(s) from CSV`);
  };

  /** Let user re-map a column header */
  const updateCsvMapping = (colIndex: number, newKey: string) => {
    if (!csvMapping) return;
    const updated = [...csvMapping.mappedHeaders];
    updated[colIndex] = newKey;
    const unmapped = csvMapping.rawHeaders.filter((_, i) => !updated[i]);
    setCsvMapping({ ...csvMapping, mappedHeaders: updated, unmapped });
  };

  const handleDownloadTemplate = () => {
    const headers = [
      'Lane Name',
      'Origin Address', 'Origin City', 'Origin State', 'Origin Zip',
      'Origin Appt Type', 'Origin Time Start', 'Origin Time End',
      'Stop 1 Address', 'Stop 1 City', 'Stop 1 State', 'Stop 1 Zip', 'Stop 1 Type',
      'Stop 1 Appt Type', 'Stop 1 Time Start', 'Stop 1 Time End',
      'Stop 2 Address', 'Stop 2 City', 'Stop 2 State', 'Stop 2 Zip', 'Stop 2 Type',
      'Stop 2 Appt Type', 'Stop 2 Time Start', 'Stop 2 Time End',
      'Stop 3 Address', 'Stop 3 City', 'Stop 3 State', 'Stop 3 Zip', 'Stop 3 Type',
      'Stop 3 Appt Type', 'Stop 3 Time Start', 'Stop 3 Time End',
      'Destination Address', 'Destination City', 'Destination State', 'Destination Zip',
      'Dest Appt Type', 'Dest Time Start', 'Dest Time End',
      'Miles', 'Rate', 'Rate Type',
      'Active Days', 'Exclude Federal Holidays', 'Equipment Type',
      'Contract Start', 'Contract End',
      'Round Trip', 'HCR', 'Trip Number', 'Notes',
    ];
    const exampleRow = [
      'Chicago to Houston Multi-Stop',
      '123 Main St', 'Chicago', 'IL', '60601',
      'APPT', '06:00', '07:00',
      '500 Market St', 'Indianapolis', 'IN', '46201', 'Delivery',
      'APPT', '12:00', '14:00',
      '200 Broadway', 'Nashville', 'TN', '37201', 'Delivery',
      'FCFS', '08:00', '16:00',
      '', '', '', '', '',
      '', '', '',
      '789 Elm St', 'Houston', 'TX', '77001',
      'APPT', '18:00', '20:00',
      '1050', '3200', 'Flat Rate',
      'Mon,Tue,Wed,Thu,Fri', 'Yes', 'Dry Van',
      '2026-01-01', '2026-12-31',
      'No', '', '', '',
    ];
    const csv = headers.join(',') + '\n' + exampleRow.join(',');
    const blob = new Blob([csv], { type: 'text/csv' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = 'lane-import-template.csv';
    a.click();
    URL.revokeObjectURL(url);
  };

  const handleExtract = async () => {
    if (ocrPages.length === 0) return;
    setStep('extracting');

    const totalPages = ocrPages.length;
    const chunkSize = 4;
    const totalChunks = Math.ceil(totalPages / chunkSize);
    const allEntries: ExtractedLane[] = [];

    try {
      // Process pages in chunks for progress tracking
      for (let i = 0; i < totalPages; i += chunkSize) {
        const chunkIndex = Math.floor(i / chunkSize) + 1;
        const chunk = ocrPages.slice(i, i + chunkSize);

        setExtractionProgress({
          current: chunkIndex,
          total: totalChunks,
          status: `Analyzing pages ${i + 1}–${Math.min(i + chunkSize, totalPages)} of ${totalPages}...`,
        });

        const result = await extractLanes({ pages: chunk });

        if (result.error) {
          toast.error(`Extraction error on chunk ${chunkIndex}: ${result.error}`);
          // Continue with other chunks instead of failing entirely
          continue;
        }

        allEntries.push(...(result.entries as ExtractedLane[]));
      }

      setExtractionProgress({ current: totalChunks, total: totalChunks, status: 'Processing results...' });

      if (allEntries.length === 0) {
        toast.error('No lanes found in the document. Try a different file.');
        setStep('upload');
        return;
      }

      // Deduplicate
      const seen = new Set<string>();
      const dedupedEntries = allEntries.filter((lane) => {
        const key = [
          lane.originCity.value, lane.originState.value,
          lane.destinationCity.value, lane.destinationState.value,
          lane.frequency.value,
        ].join('|');
        if (seen.has(key)) return false;
        seen.add(key);
        return true;
      });

      // Build review rows with validation — ensure intermediateStops exists (OCR may not return it)
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const rows: ReviewRow[] = dedupedEntries.map((rawLane: any) => {
        const lane: ExtractedLane = { intermediateStops: [], ...rawLane };
        const errors: string[] = [];
        const warnings: string[] = [];

        if (!lane.originCity.value) errors.push('Missing origin city');
        if (!lane.originState.value) errors.push('Missing origin state');
        if (!lane.destinationCity.value) errors.push('Missing destination city');
        if (!lane.destinationState.value) errors.push('Missing destination state');
        if (!lane.activeDays.value || lane.activeDays.value.length === 0) {
          warnings.push('No schedule days detected — defaulting to Mon-Fri');
        }

        // Confidence warnings
        for (const [key, field] of Object.entries(lane)) {
          const f = field as ExtractedField;
          if (f.value !== null && f.confidence === 'low') {
            warnings.push(`Low confidence: ${key}`);
          }
        }

        return {
          lane,
          skip: errors.length > 0,
          expanded: false,
          errors,
          warnings,
          overrides: {},
        };
      });

      setReviewRows(rows);
      setStep('review');
      toast.success(`Found ${rows.length} lane(s)`);
    } catch (error) {
      toast.error('Extraction failed: ' + String(error));
      setStep('upload');
    }
  };

  // ---- STEP 3: REVIEW & IMPORT ----

  const toggleExpand = (index: number) => {
    setReviewRows((prev) =>
      prev.map((r, i) => (i === index ? { ...r, expanded: !r.expanded } : r)),
    );
  };

  const toggleSkip = (index: number) => {
    setReviewRows((prev) =>
      prev.map((r, i) => (i === index ? { ...r, skip: !r.skip } : r)),
    );
  };

  const updateOverride = (index: number, field: string, value: unknown) => {
    setReviewRows((prev) =>
      prev.map((r, i) =>
        i === index ? { ...r, overrides: { ...r.overrides, [field]: value } } : r,
      ),
    );
  };

  const handleImport = async () => {
    if (!targetSessionId) {
      toast.error('Select a target session first');
      return;
    }

    const validRows = reviewRows.filter((r) => !r.skip && r.errors.length === 0);
    if (validRows.length === 0) {
      toast.error('No valid lanes to import');
      return;
    }

    setIsImporting(true);
    let imported = 0;

    try {
      for (const row of validRows) {
        const lane = row.lane;
        const o = row.overrides;

        const originCity = o.originCity ?? lane.originCity.value ?? '';
        const originState = o.originState ?? lane.originState.value ?? '';
        const destCity = o.destinationCity ?? lane.destinationCity.value ?? '';
        const destState = o.destinationState ?? lane.destinationState.value ?? '';
        const activeDays = o.activeDays ?? lane.activeDays.value ?? [1, 2, 3, 4, 5];

        // Build lane name including stops
        const stops = lane.intermediateStops ?? [];
        const stopCities = stops.filter((s) => s.city).map((s) => s.city);
        const defaultName = stopCities.length > 0
          ? `${originCity}, ${originState} → ${stopCities.join(' → ')} → ${destCity}, ${destState}`
          : `${originCity}, ${originState} → ${destCity}, ${destState}`;

        await createEntry({
          sessionId: targetSessionId as Id<'laneAnalysisSessions'>,
          workosOrgId: organizationId,
          name: o.laneName ?? lane.laneName.value ?? defaultName,
          originAddress: lane.originAddress.value ?? `${originCity}, ${originState}`,
          originCity,
          originState,
          originZip: lane.originZip.value ?? '',
          originStopType: 'Pickup' as const,
          originAppointmentType: (lane.originApptType?.value ?? 'APPT') as 'APPT' | 'FCFS' | 'Live',
          originScheduledTime: lane.originTimeStart?.value ?? undefined,
          originScheduledEndTime: lane.originTimeEnd?.value ?? undefined,
          destinationAddress: lane.destinationAddress.value ?? `${destCity}, ${destState}`,
          destinationCity: destCity,
          destinationState: destState,
          destinationZip: lane.destinationZip.value ?? '',
          destinationStopType: 'Delivery' as const,
          destinationAppointmentType: (lane.destApptType?.value ?? 'APPT') as 'APPT' | 'FCFS' | 'Live',
          destinationScheduledTime: lane.destTimeStart?.value ?? undefined,
          destinationScheduledEndTime: lane.destTimeEnd?.value ?? undefined,
          intermediateStops: stops.length > 0
            ? stops.map((s, i) => ({
                address: s.address || `${s.city}, ${s.state}`,
                city: s.city,
                state: s.state,
                zip: s.zip,
                stopOrder: i + 1,
                stopType: s.stopType,
                type: (s.apptType ?? 'APPT') as 'APPT' | 'FCFS' | 'Live',
                arrivalTime: s.timeStart || undefined,
                arrivalEndTime: s.timeEnd || undefined,
              }))
            : undefined,
          routeMiles: o.miles ?? lane.miles.value ?? undefined,
          isRoundTrip: lane.isRoundTrip.value ?? false,
          isCityRoute: o.isCityRoute ?? false,
          includedStops: stops.length > 0 ? stops.length + 2 : undefined,
          scheduleRule: {
            activeDays,
            excludeFederalHolidays: lane.excludeHolidays.value ?? true,
            customExclusions: [],
          },
          contractPeriodStart: lane.contractStart.value ?? undefined,
          contractPeriodEnd: lane.contractEnd.value ?? undefined,
          rateType: (o.rateType ?? lane.rateType.value ?? 'Flat Rate') as 'Flat Rate' | 'Per Mile' | 'Per Stop',
          ratePerRun: (o.rateType ?? lane.rateType.value) === 'Flat Rate' ? (o.rate ?? lane.rate.value ?? undefined) : undefined,
          ratePerMile: (o.rateType ?? lane.rateType.value) === 'Per Mile' ? (o.rate ?? lane.rate.value ?? undefined) : undefined,
          equipmentClass: (o.equipmentType ?? lane.equipmentType.value ?? undefined) as 'Dry Van' | 'Refrigerated' | 'Flatbed' | 'Tanker' | 'Bobtail' | undefined,
        });
        imported++;
      }

      toast.success(`Imported ${imported} lane(s)`);
      router.push('/lane-analyzer');
    } catch (error) {
      toast.error(`Import failed after ${imported} lanes: ${String(error)}`);
    } finally {
      setIsImporting(false);
    }
  };

  // ---- RENDER ----

  return (
    <div className="flex h-full min-h-0 w-full flex-col gap-4 p-6 overflow-auto">
      <div>
        <h1 className="text-3xl font-bold tracking-tight">OCR Lane Import</h1>
        <p className="text-muted-foreground mt-1">
          Upload a bid package or route schedule to extract lanes automatically
        </p>
      </div>

      {/* Target Session Selector */}
      <div className="flex items-center gap-3">
        <Label className="shrink-0">Import to session:</Label>
        <Select value={targetSessionId} onValueChange={setTargetSessionId}>
          <SelectTrigger className="w-[300px]">
            <SelectValue placeholder="Select session..." />
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

      {/* STEP 1: Upload */}
      {step === 'upload' && (
        <Card>
          <CardHeader>
            <CardTitle>Import Lanes</CardTitle>
            <CardDescription>
              Upload a CSV spreadsheet or use OCR to extract lanes from a PDF/image
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-4">
            {/* Mode Toggle */}
            <div className="flex rounded-lg border p-1 w-fit">
              <button
                type="button"
                onClick={() => { setUploadMode('csv'); setFiles([]); setOcrPages([]); }}
                className={`flex items-center gap-2 px-4 py-2 rounded-md text-sm font-medium transition-colors ${
                  uploadMode === 'csv'
                    ? 'bg-primary text-primary-foreground'
                    : 'text-muted-foreground hover:text-foreground'
                }`}
              >
                <FileSpreadsheet className="h-4 w-4" />
                CSV Import
              </button>
              <button
                type="button"
                onClick={() => { setUploadMode('ocr'); setFiles([]); setOcrPages([]); }}
                className={`flex items-center gap-2 px-4 py-2 rounded-md text-sm font-medium transition-colors ${
                  uploadMode === 'ocr'
                    ? 'bg-primary text-primary-foreground'
                    : 'text-muted-foreground hover:text-foreground'
                }`}
              >
                <FileText className="h-4 w-4" />
                PDF / Image (OCR)
              </button>
            </div>

            {/* CSV Upload */}
            {uploadMode === 'csv' && (
              <div className="space-y-4">
                <div
                  className="border-2 border-dashed rounded-lg p-12 text-center cursor-pointer hover:bg-accent/50 transition-colors"
                  onClick={() => csvInputRef.current?.click()}
                  onDragOver={(e) => e.preventDefault()}
                  onDrop={(e) => {
                    e.preventDefault();
                    const dropped = e.dataTransfer.files[0];
                    if (dropped && (dropped.name.endsWith('.csv') || dropped.name.endsWith('.tsv'))) {
                      const dt = new DataTransfer();
                      dt.items.add(dropped);
                      const input = csvInputRef.current;
                      if (input) {
                        input.files = dt.files;
                        input.dispatchEvent(new Event('change', { bubbles: true }));
                      }
                    } else {
                      toast.error('Please drop a .csv or .tsv file');
                    }
                  }}
                >
                  <FileSpreadsheet className="h-10 w-10 mx-auto text-muted-foreground mb-4" />
                  <p className="font-medium">Drop a CSV file here or click to browse</p>
                  <p className="text-sm text-muted-foreground mt-1">
                    Supports .csv and .tsv files
                  </p>
                  <input
                    ref={csvInputRef}
                    type="file"
                    accept=".csv,.tsv"
                    className="hidden"
                    onChange={handleCsvFile}
                  />
                </div>

                <div className="flex items-center gap-3 text-sm">
                  <Button variant="outline" size="sm" onClick={handleDownloadTemplate}>
                    <Download className="h-3.5 w-3.5 mr-1.5" />
                    Download CSV Template
                  </Button>
                  <span className="text-muted-foreground">
                    Use the template for the expected column format
                  </span>
                </div>

                {/* Column mapping hint */}
                <div className="rounded-md border bg-muted/50 p-3">
                  <p className="text-xs font-medium mb-1.5">Accepted column headers:</p>
                  <p className="text-xs text-muted-foreground leading-relaxed">
                    Lane Name, Origin Address / City / State / Zip / Appt Type / Time Start / Time End,
                    Stop 1–10 Address / City / State / Zip / Type / Appt Type / Time Start / Time End,
                    Dest Address / City / State / Zip / Appt Type / Time Start / Time End,
                    Miles, Rate, Rate Type, Active Days, Equipment,
                    Contract Start, Contract End, Round Trip, HCR, Trip #, Notes
                  </p>
                </div>
              </div>
            )}

            {/* OCR Upload */}
            {uploadMode === 'ocr' && (
              <>
                <div
                  className="border-2 border-dashed rounded-lg p-12 text-center cursor-pointer hover:bg-accent/50 transition-colors"
                  onClick={() => fileInputRef.current?.click()}
                  onDragOver={(e) => e.preventDefault()}
                  onDrop={(e) => {
                    e.preventDefault();
                    const dropped = Array.from(e.dataTransfer.files);
                    if (dropped.length > 0) {
                      setFiles(dropped);
                      const input = fileInputRef.current;
                      if (input) {
                        const dt = new DataTransfer();
                        dropped.forEach((f) => dt.items.add(f));
                        input.files = dt.files;
                        input.dispatchEvent(new Event('change', { bubbles: true }));
                      }
                    }
                  }}
                >
                  <Upload className="h-10 w-10 mx-auto text-muted-foreground mb-4" />
                  <p className="font-medium">Drop files here or click to browse</p>
                  <p className="text-sm text-muted-foreground mt-1">
                    Supports PDF, JPG, PNG
                  </p>
                  <input
                    ref={fileInputRef}
                    type="file"
                    accept=".pdf,.jpg,.jpeg,.png,.webp"
                    multiple
                    className="hidden"
                    onChange={handleFileChange}
                  />
                </div>

                {files.length > 0 && (
                  <div className="space-y-2">
                    {files.map((f, i) => (
                      <div key={i} className="flex items-center gap-2 text-sm">
                        <FileText className="h-4 w-4 text-muted-foreground" />
                        <span>{f.name}</span>
                        <span className="text-muted-foreground">
                          ({(f.size / 1024).toFixed(0)} KB)
                        </span>
                      </div>
                    ))}
                    <p className="text-sm text-muted-foreground">
                      {ocrPages.length} page(s) ready for extraction
                    </p>
                    <Button
                      onClick={handleExtract}
                      disabled={ocrPages.length === 0 || !targetSessionId}
                    >
                      Extract Lanes
                    </Button>
                  </div>
                )}
              </>
            )}
          </CardContent>
        </Card>
      )}

      {/* STEP 2: Extracting */}
      {step === 'extracting' && (
        <Card>
          <CardContent className="py-16 text-center space-y-4">
            <Loader2 className="h-10 w-10 mx-auto animate-spin text-primary" />
            <p className="font-medium">Extracting lanes from document...</p>
            <p className="text-sm text-muted-foreground">
              {extractionProgress.status || 'Preparing pages...'}
            </p>
            {extractionProgress.total > 0 && (
              <div className="max-w-md mx-auto space-y-2">
                <div className="w-full bg-muted rounded-full h-2.5">
                  <div
                    className="bg-primary h-2.5 rounded-full transition-all duration-500"
                    style={{
                      width: `${Math.round((extractionProgress.current / extractionProgress.total) * 100)}%`,
                    }}
                  />
                </div>
                <p className="text-xs text-muted-foreground">
                  Step {extractionProgress.current} of {extractionProgress.total}
                </p>
              </div>
            )}
          </CardContent>
        </Card>
      )}

      {/* STEP 2b: CSV Column Mapping */}
      {step === 'csvMapping' && csvMapping && (
        <div className="space-y-4">
          <Card>
            <CardHeader>
              <CardTitle>Confirm Column Mapping</CardTitle>
              <CardDescription>
                Verify each CSV column is mapped to the correct field. Fix any mismatches before importing.
                {csvMapping.unmapped.length > 0 && (
                  <span className="text-amber-600 ml-1">
                    {csvMapping.unmapped.length} column(s) not mapped.
                  </span>
                )}
              </CardDescription>
            </CardHeader>
            <CardContent>
              <div className="overflow-x-auto">
                <table className="w-full text-xs border-collapse">
                  <thead>
                    <tr className="border-b bg-muted/50">
                      <th className="text-left p-2 font-medium text-muted-foreground whitespace-nowrap">CSV Header</th>
                      <th className="text-left p-2 font-medium text-muted-foreground whitespace-nowrap">Mapped To</th>
                      {csvMapping.sampleRows.map((_, i) => (
                        <th key={i} className="text-left p-2 font-medium text-muted-foreground whitespace-nowrap">
                          Row {i + 1}
                        </th>
                      ))}
                    </tr>
                  </thead>
                  <tbody>
                    {csvMapping.rawHeaders.map((header, colIdx) => {
                      const mapped = csvMapping.mappedHeaders[colIdx];
                      const isMapped = !!mapped;
                      return (
                        <tr key={colIdx} className={`border-b ${!isMapped ? 'bg-amber-50 dark:bg-amber-950/20' : ''}`}>
                          <td className="p-2 font-mono whitespace-nowrap">{header}</td>
                          <td className="p-2">
                            <Select
                              value={mapped || '_unmapped'}
                              onValueChange={(v) => updateCsvMapping(colIdx, v === '_unmapped' ? '' : v)}
                            >
                              <SelectTrigger className={`h-7 w-44 text-xs ${!isMapped ? 'border-amber-400' : ''}`}>
                                <SelectValue />
                              </SelectTrigger>
                              <SelectContent className="max-h-60">
                                <SelectItem value="_unmapped">
                                  <span className="text-muted-foreground">— Skip —</span>
                                </SelectItem>
                                {CSV_FIELD_OPTIONS.map((opt) => (
                                  <SelectItem key={opt.value} value={opt.value}>
                                    {opt.label}
                                  </SelectItem>
                                ))}
                              </SelectContent>
                            </Select>
                          </td>
                          {csvMapping.sampleRows.map((row, rowIdx) => (
                            <td key={rowIdx} className="p-2 text-muted-foreground max-w-[200px] truncate whitespace-nowrap">
                              {row[colIdx] ?? ''}
                            </td>
                          ))}
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            </CardContent>
          </Card>

          <div className="flex items-center justify-between">
            <Button variant="outline" onClick={() => { setStep('upload'); setCsvMapping(null); }}>
              Start Over
            </Button>
            <div className="flex items-center gap-3">
              <span className="text-sm text-muted-foreground">
                {csvMapping.allRows.length} row(s) found
              </span>
              <Button onClick={handleConfirmCsvMapping} disabled={!targetSessionId}>
                <Check className="h-4 w-4 mr-1.5" />
                Confirm & Continue
              </Button>
            </div>
          </div>
        </div>
      )}

      {/* STEP 3: Review */}
      {step === 'review' && (
        <div className="space-y-4">
          <div className="flex items-center justify-between">
            <div>
              <span className="font-medium">{reviewRows.length} lanes extracted</span>
              <span className="text-muted-foreground ml-2">
                ({reviewRows.filter((r) => !r.skip).length} to import,{' '}
                {reviewRows.filter((r) => r.skip).length} skipped)
              </span>
            </div>
            <div className="flex gap-2">
              <Button variant="outline" onClick={() => { setStep('upload'); setReviewRows([]); }}>
                Start Over
              </Button>
              <Button
                onClick={handleImport}
                disabled={isImporting || !targetSessionId || reviewRows.filter((r) => !r.skip).length === 0}
              >
                {isImporting && <Loader2 className="h-4 w-4 mr-1 animate-spin" />}
                Import {reviewRows.filter((r) => !r.skip).length} Lane(s)
              </Button>
            </div>
          </div>

          {reviewRows.map((row, index) => (
            <Card key={index} className={row.skip ? 'opacity-50' : ''}>
              <div
                className="flex items-center gap-3 p-4 cursor-pointer"
                onClick={() => toggleExpand(index)}
              >
                {row.expanded ? (
                  <ChevronDown className="h-4 w-4 shrink-0" />
                ) : (
                  <ChevronRight className="h-4 w-4 shrink-0" />
                )}

                <div className="flex-1 min-w-0">
                  <div className="font-medium truncate">
                    {row.overrides.laneName ?? row.lane.laneName.value ?? 'Unnamed Lane'}
                  </div>
                  <div className="text-sm text-muted-foreground">
                    {row.overrides.originCity ?? row.lane.originCity.value},{' '}
                    {row.overrides.originState ?? row.lane.originState.value}
                    {(row.lane.intermediateStops ?? []).length > 0 && (
                      <>
                        {' → '}
                        {row.lane.intermediateStops.map((s) => `${s.city}, ${s.state}`).join(' → ')}
                      </>
                    )}
                    {' → '}
                    {row.overrides.destinationCity ?? row.lane.destinationCity.value},{' '}
                    {row.overrides.destinationState ?? row.lane.destinationState.value}
                    {(row.overrides.miles ?? row.lane.miles.value) &&
                      ` • ${row.overrides.miles ?? row.lane.miles.value} mi`}
                    {(row.lane.intermediateStops ?? []).length > 0 && (
                      <Badge variant="outline" className="ml-2 text-xs">
                        {row.lane.intermediateStops.length + 2} stops
                      </Badge>
                    )}
                  </div>
                  {/* Schedule times summary */}
                  <div className="text-xs text-muted-foreground mt-0.5 flex flex-wrap items-center gap-x-3 gap-y-0.5">
                    {row.lane.originApptType?.value && (
                      <span>
                        <span className="font-medium">PU:</span>{' '}
                        {row.lane.originApptType.value}
                        {row.lane.originTimeStart?.value && (
                          <> {row.lane.originTimeStart.value}{row.lane.originTimeEnd?.value && `–${row.lane.originTimeEnd.value}`}</>
                        )}
                      </span>
                    )}
                    {(row.lane.intermediateStops ?? []).map((s, si) => (
                      (s.apptType || s.timeStart) ? (
                        <span key={si}>
                          <span className="font-medium">Stop {si + 1}:</span>{' '}
                          {s.apptType}{s.timeStart && <> {s.timeStart}{s.timeEnd && `–${s.timeEnd}`}</>}
                        </span>
                      ) : null
                    ))}
                    {row.lane.destApptType?.value && (
                      <span>
                        <span className="font-medium">DEL:</span>{' '}
                        {row.lane.destApptType.value}
                        {row.lane.destTimeStart?.value && (
                          <> {row.lane.destTimeStart.value}{row.lane.destTimeEnd?.value && `–${row.lane.destTimeEnd.value}`}</>
                        )}
                      </span>
                    )}
                  </div>
                </div>

                <div className="flex items-center gap-2 shrink-0">
                  {row.lane.frequency.value && (
                    <Badge variant="outline" className="text-xs">
                      {row.lane.frequency.value}
                    </Badge>
                  )}
                  {row.lane.rate.value && (
                    <span className="text-sm tabular-nums">
                      ${row.lane.rate.value}
                      {row.lane.rateType.value === 'Per Mile' ? '/mi' : ''}
                    </span>
                  )}
                  {row.errors.length > 0 && (
                    <Badge variant="destructive" className="text-xs">
                      {row.errors.length} error(s)
                    </Badge>
                  )}
                  {row.warnings.length > 0 && (
                    <Badge variant="secondary" className="text-xs">
                      {row.warnings.length} warning(s)
                    </Badge>
                  )}
                  <Button
                    variant="ghost"
                    size="sm"
                    onClick={(e) => { e.stopPropagation(); toggleSkip(index); }}
                  >
                    {row.skip ? 'Include' : 'Skip'}
                  </Button>
                </div>
              </div>

              {/* Expanded Edit Panel */}
              {row.expanded && (
                <div className="border-t px-4 pb-4 pt-3 space-y-3">
                  {row.errors.length > 0 && (
                    <div className="text-sm text-red-600 space-y-1">
                      {row.errors.map((e, i) => (
                        <div key={i} className="flex items-center gap-1">
                          <AlertCircle className="h-3 w-3" /> {e}
                        </div>
                      ))}
                    </div>
                  )}
                  {row.warnings.length > 0 && (
                    <div className="text-sm text-amber-600 space-y-1">
                      {row.warnings.map((w, i) => (
                        <div key={i} className="flex items-center gap-1">
                          <AlertCircle className="h-3 w-3" /> {w}
                        </div>
                      ))}
                    </div>
                  )}

                  {/* Lane Name + Miles */}
                  <div className="grid grid-cols-4 gap-3">
                    <div className="col-span-3">
                      <Label className="text-xs">Lane Name</Label>
                      <Input
                        value={row.overrides.laneName ?? row.lane.laneName.value ?? ''}
                        onChange={(e) => updateOverride(index, 'laneName', e.target.value)}
                        className="h-8 text-sm"
                      />
                    </div>
                    <div>
                      <Label className="text-xs">Miles</Label>
                      <Input
                        type="number"
                        value={row.overrides.miles ?? row.lane.miles.value ?? ''}
                        onChange={(e) => updateOverride(index, 'miles', parseFloat(e.target.value) || undefined)}
                        className="h-8 text-sm"
                        placeholder="Auto"
                      />
                    </div>
                  </div>

                  {/* Origin */}
                  <div>
                    <Label className="text-xs font-semibold">Origin</Label>
                    <div className="grid grid-cols-4 gap-2 mt-1">
                      <Input
                        placeholder="Address"
                        value={row.lane.originAddress.value ?? ''}
                        className="col-span-2 h-8 text-sm"
                        readOnly
                      />
                      <Input
                        placeholder="City *"
                        value={row.overrides.originCity ?? row.lane.originCity.value ?? ''}
                        onChange={(e) => updateOverride(index, 'originCity', e.target.value)}
                        className="h-8 text-sm"
                      />
                      <div className="flex gap-2">
                        <Input
                          placeholder="ST *"
                          value={row.overrides.originState ?? row.lane.originState.value ?? ''}
                          onChange={(e) => updateOverride(index, 'originState', e.target.value)}
                          className="h-8 text-sm w-16"
                        />
                        <Input
                          placeholder="Zip"
                          value={row.lane.originZip.value ?? ''}
                          className="h-8 text-sm"
                          readOnly
                        />
                      </div>
                    </div>
                  </div>

                  {/* Intermediate Stops */}
                  {(row.lane.intermediateStops ?? []).length > 0 && (
                    <div className="space-y-2">
                      <Label className="text-xs font-semibold">
                        Intermediate Stops ({row.lane.intermediateStops.length})
                      </Label>
                      {row.lane.intermediateStops.map((stop, sIdx) => (
                        <div key={sIdx} className="rounded border bg-muted/30 p-2">
                          <div className="flex items-center gap-2 mb-1.5">
                            <span className="text-xs text-muted-foreground font-medium">Stop {sIdx + 1}</span>
                            <Badge variant="outline" className="text-xs h-5">
                              {stop.stopType}
                            </Badge>
                          </div>
                          <div className="grid grid-cols-4 gap-2">
                            <Input
                              placeholder="Address"
                              value={stop.address}
                              onChange={(e) => {
                                const updated = [...row.lane.intermediateStops];
                                updated[sIdx] = { ...updated[sIdx], address: e.target.value };
                                setReviewRows((prev) => prev.map((r, i) =>
                                  i === index ? { ...r, lane: { ...r.lane, intermediateStops: updated } } : r
                                ));
                              }}
                              className="col-span-2 h-7 text-xs"
                            />
                            <Input
                              placeholder="City"
                              value={stop.city}
                              onChange={(e) => {
                                const updated = [...row.lane.intermediateStops];
                                updated[sIdx] = { ...updated[sIdx], city: e.target.value };
                                setReviewRows((prev) => prev.map((r, i) =>
                                  i === index ? { ...r, lane: { ...r.lane, intermediateStops: updated } } : r
                                ));
                              }}
                              className="h-7 text-xs"
                            />
                            <div className="flex gap-2">
                              <Input
                                placeholder="ST"
                                value={stop.state}
                                onChange={(e) => {
                                  const updated = [...row.lane.intermediateStops];
                                  updated[sIdx] = { ...updated[sIdx], state: e.target.value };
                                  setReviewRows((prev) => prev.map((r, i) =>
                                    i === index ? { ...r, lane: { ...r.lane, intermediateStops: updated } } : r
                                  ));
                                }}
                                className="h-7 text-xs w-14"
                              />
                              <Input
                                placeholder="Zip"
                                value={stop.zip}
                                onChange={(e) => {
                                  const updated = [...row.lane.intermediateStops];
                                  updated[sIdx] = { ...updated[sIdx], zip: e.target.value };
                                  setReviewRows((prev) => prev.map((r, i) =>
                                    i === index ? { ...r, lane: { ...r.lane, intermediateStops: updated } } : r
                                  ));
                                }}
                                className="h-7 text-xs"
                              />
                            </div>
                          </div>
                        </div>
                      ))}
                    </div>
                  )}

                  {/* Destination */}
                  <div>
                    <Label className="text-xs font-semibold">Destination</Label>
                    <div className="grid grid-cols-4 gap-2 mt-1">
                      <Input
                        placeholder="Address"
                        value={row.lane.destinationAddress.value ?? ''}
                        className="col-span-2 h-8 text-sm"
                        readOnly
                      />
                      <Input
                        placeholder="City *"
                        value={row.overrides.destinationCity ?? row.lane.destinationCity.value ?? ''}
                        onChange={(e) => updateOverride(index, 'destinationCity', e.target.value)}
                        className="h-8 text-sm"
                      />
                      <div className="flex gap-2">
                        <Input
                          placeholder="ST *"
                          value={row.overrides.destinationState ?? row.lane.destinationState.value ?? ''}
                          onChange={(e) => updateOverride(index, 'destinationState', e.target.value)}
                          className="h-8 text-sm w-16"
                        />
                        <Input
                          placeholder="Zip"
                          value={row.lane.destinationZip.value ?? ''}
                          className="h-8 text-sm"
                          readOnly
                        />
                      </div>
                    </div>
                  </div>

                  {/* Rate */}
                  <div className="grid grid-cols-4 gap-3">
                    <div>
                      <Label className="text-xs">Rate ($)</Label>
                      <Input
                        type="number"
                        step="0.01"
                        value={row.overrides.rate ?? row.lane.rate.value ?? ''}
                        onChange={(e) => updateOverride(index, 'rate', parseFloat(e.target.value) || undefined)}
                        className="h-8 text-sm"
                      />
                    </div>
                    <div>
                      <Label className="text-xs">Rate Type</Label>
                      <Select
                        value={row.overrides.rateType ?? row.lane.rateType.value ?? 'Flat Rate'}
                        onValueChange={(v) => updateOverride(index, 'rateType', v)}
                      >
                        <SelectTrigger className="h-8 text-sm">
                          <SelectValue />
                        </SelectTrigger>
                        <SelectContent>
                          <SelectItem value="Flat Rate">Flat Rate</SelectItem>
                          <SelectItem value="Per Mile">Per Mile</SelectItem>
                          <SelectItem value="Per Stop">Per Stop</SelectItem>
                        </SelectContent>
                      </Select>
                    </div>
                  </div>

                  <div className="grid grid-cols-4 gap-3">
                    <div>
                      <Label className="text-xs">Equipment</Label>
                      <Select
                        value={row.overrides.equipmentType ?? row.lane.equipmentType.value ?? 'Dry Van'}
                        onValueChange={(v) => updateOverride(index, 'equipmentType', v)}
                      >
                        <SelectTrigger className="h-8 text-sm">
                          <SelectValue />
                        </SelectTrigger>
                        <SelectContent>
                          <SelectItem value="Dry Van">Dry Van</SelectItem>
                          <SelectItem value="Refrigerated">Refrigerated</SelectItem>
                          <SelectItem value="Flatbed">Flatbed</SelectItem>
                          <SelectItem value="Tanker">Tanker</SelectItem>
                          <SelectItem value="Bobtail">Bobtail</SelectItem>
                        </SelectContent>
                      </Select>
                    </div>
                    <div className="col-span-2">
                      <Label className="text-xs">Schedule (active days)</Label>
                      <div className="flex gap-1 mt-1">
                        {DAYS.map((d, dayIdx) => {
                          const activeDays = row.overrides.activeDays ?? row.lane.activeDays.value ?? [1, 2, 3, 4, 5];
                          const isActive = activeDays.includes(dayIdx);
                          return (
                            <button
                              key={dayIdx}
                              type="button"
                              onClick={() => {
                                const current = [...activeDays];
                                const updated = isActive
                                  ? current.filter((x) => x !== dayIdx)
                                  : [...current, dayIdx].sort();
                                updateOverride(index, 'activeDays', updated);
                              }}
                              className={`h-7 w-8 rounded text-xs font-medium border transition-colors ${
                                isActive
                                  ? 'bg-primary text-primary-foreground border-primary'
                                  : 'bg-background text-muted-foreground border-input hover:bg-accent'
                              }`}
                            >
                              {d}
                            </button>
                          );
                        })}
                      </div>
                    </div>
                    <div className="flex items-end gap-2 pb-1">
                      <Switch
                        checked={row.overrides.isCityRoute ?? false}
                        onCheckedChange={(v) => updateOverride(index, 'isCityRoute', v)}
                        id={`city-${index}`}
                      />
                      <Label htmlFor={`city-${index}`} className="text-xs">City Route</Label>
                    </div>
                  </div>

                  {/* Extra info from OCR */}
                  {(row.lane.hcr.value || row.lane.tripNumber.value || row.lane.contractStart.value || row.lane.notes.value) && (
                    <div className="text-xs text-muted-foreground space-y-1 pt-2 border-t">
                      {row.lane.hcr.value && <div>HCR: {row.lane.hcr.value}{row.lane.tripNumber.value && ` / Trip: ${row.lane.tripNumber.value}`}</div>}
                      {row.lane.contractStart.value && <div>Contract: {row.lane.contractStart.value} → {row.lane.contractEnd.value ?? '?'}</div>}
                      {row.lane.notes.value && <div>Notes: {row.lane.notes.value}</div>}
                    </div>
                  )}
                </div>
              )}
            </Card>
          ))}
        </div>
      )}
    </div>
  );
}

// ---- HELPERS ----

function fileToDataUrl(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result as string);
    reader.onerror = reject;
    reader.readAsDataURL(file);
  });
}

async function renderPdfToImages(file: File): Promise<OcrPage[]> {
  // Dynamic import of pdfjs-dist
  const pdfjsLib = await import('pdfjs-dist');
  pdfjsLib.GlobalWorkerOptions.workerSrc = `https://cdn.jsdelivr.net/npm/pdfjs-dist@${pdfjsLib.version}/build/pdf.worker.min.mjs`;

  const arrayBuffer = await file.arrayBuffer();
  const pdf = await pdfjsLib.getDocument({ data: arrayBuffer }).promise;
  const pages: OcrPage[] = [];

  for (let i = 1; i <= pdf.numPages; i++) {
    const page = await pdf.getPage(i);

    // Extract text content
    const textContent = await page.getTextContent();
    const textItems = textContent.items as Array<{ str: string }>;
    const pageText = textItems.map((item) => item.str).join(' ');

    // Render to canvas at 150 DPI
    const scale = 150 / 72;
    const viewport = page.getViewport({ scale });
    const canvas = document.createElement('canvas');
    canvas.width = viewport.width;
    canvas.height = viewport.height;
    const ctx = canvas.getContext('2d')!;
    await page.render({ canvasContext: ctx, viewport } as Parameters<typeof page.render>[0]).promise;

    const imageUrl = canvas.toDataURL('image/jpeg', 0.85);
    pages.push({ imageUrl, pageText: pageText || undefined });
  }

  return pages;
}

// ---- CSV PARSING ----

/** Normalize a header string to a canonical key for flexible column matching */
function normalizeHeader(h: string): string {
  return h.toLowerCase().replace(/[^a-z0-9]/g, '');
}

const HEADER_MAP: Record<string, string> = {
  lanename: 'laneName', name: 'laneName', lane: 'laneName',
  origincity: 'originCity', origcity: 'originCity', fromcity: 'originCity',
  originstate: 'originState', origstate: 'originState', fromstate: 'originState',
  originzip: 'originZip', origzip: 'originZip', fromzip: 'originZip',
  originaddress: 'originAddress', origaddress: 'originAddress', fromaddress: 'originAddress',
  originappttype: 'originApptType', originappointmenttype: 'originApptType',
  origintimestart: 'originTimeStart', originscheduledtime: 'originTimeStart',
  origintimeend: 'originTimeEnd', originscheduledendtime: 'originTimeEnd',
  // Intermediate stops (up to 10)
  ...Object.fromEntries(
    Array.from({ length: 10 }, (_, i) => {
      const n = i + 1;
      return [
        [`stop${n}city`, `stop${n}City`],
        [`stop${n}state`, `stop${n}State`],
        [`stop${n}zip`, `stop${n}Zip`],
        [`stop${n}address`, `stop${n}Address`],
        [`stop${n}type`, `stop${n}Type`],
        [`stop${n}appttype`, `stop${n}ApptType`],
        [`stop${n}appointmenttype`, `stop${n}ApptType`],
        [`stop${n}timestart`, `stop${n}TimeStart`],
        [`stop${n}timeend`, `stop${n}TimeEnd`],
      ];
    }).flat(),
  ),
  destinationcity: 'destCity', destcity: 'destCity', tocity: 'destCity',
  destinationstate: 'destState', deststate: 'destState', tostate: 'destState',
  destinationzip: 'destZip', destzip: 'destZip', tozip: 'destZip',
  destinationaddress: 'destAddress', destaddress: 'destAddress', toaddress: 'destAddress',
  destappttype: 'destApptType', destinationappttype: 'destApptType',
  desttimestart: 'destTimeStart', destinationtimestart: 'destTimeStart',
  desttimeend: 'destTimeEnd', destinationtimeend: 'destTimeEnd',
  miles: 'miles', distance: 'miles', routemiles: 'miles',
  rate: 'rate', price: 'rate', linehaul: 'rate',
  ratetype: 'rateType', pricetype: 'rateType',
  activedays: 'activeDays', schedule: 'activeDays', days: 'activeDays',
  excludefederalholidays: 'excludeHolidays', excludeholidays: 'excludeHolidays', holidays: 'excludeHolidays', federalholidays: 'excludeHolidays', noholidays: 'excludeHolidays',
  equipmenttype: 'equipment', equipment: 'equipment', trailer: 'equipment', trailertype: 'equipment',
  contractstart: 'contractStart', startdate: 'contractStart',
  contractend: 'contractEnd', enddate: 'contractEnd',
  roundtrip: 'roundTrip',
  hcr: 'hcr', routeid: 'hcr',
  tripnumber: 'tripNumber', trip: 'tripNumber', tripno: 'tripNumber',
  notes: 'notes', comments: 'notes',
};

/** Parse CSV text into raw headers + raw row arrays (no mapping) */
function parseCsvRaw(text: string): { headers: string[]; rows: string[][] } {
  const lines = text.split(/\r?\n/).filter((l) => l.trim());
  if (lines.length < 2) return { headers: [], rows: [] };

  const headers = parseCsvLine(lines[0]).map((h) => h.trim());
  const rows: string[][] = [];
  for (let i = 1; i < lines.length; i++) {
    const values = parseCsvLine(lines[i]);
    if (values.every((v) => !v.trim())) continue;
    rows.push(values);
  }
  return { headers, rows };
}

/** Parse CSV text into an array of keyed row objects (legacy, used by OCR path) */
function parseCsv(text: string): Record<string, string>[] {
  const { headers: rawHeaders, rows: rawRows } = parseCsvRaw(text);
  const headers = rawHeaders.map((h) => {
    const norm = normalizeHeader(h);
    return HEADER_MAP[norm] ?? norm;
  });

  const rows: Record<string, string>[] = [];
  for (const values of rawRows) {
    const row: Record<string, string> = {};
    headers.forEach((key, idx) => {
      if (key && values[idx] !== undefined) {
        row[key] = values[idx].trim();
      }
    });
    rows.push(row);
  }
  return rows;
}

/** Parse a single CSV line respecting quoted fields */
function parseCsvLine(line: string): string[] {
  const result: string[] = [];
  let current = '';
  let inQuotes = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (inQuotes) {
      if (ch === '"' && line[i + 1] === '"') {
        current += '"';
        i++;
      } else if (ch === '"') {
        inQuotes = false;
      } else {
        current += ch;
      }
    } else {
      if (ch === '"') {
        inQuotes = true;
      } else if (ch === ',' || ch === '\t') {
        result.push(current);
        current = '';
      } else {
        current += ch;
      }
    }
  }
  result.push(current);
  return result;
}

/** Parse yes/no/true/false string to boolean, with a default */
function parseYesNo(s: string | undefined, defaultValue: boolean): boolean {
  if (!s) return defaultValue;
  const lower = s.trim().toLowerCase();
  if (['yes', 'true', '1', 'y'].includes(lower)) return true;
  if (['no', 'false', '0', 'n'].includes(lower)) return false;
  return defaultValue;
}

const DAY_NAMES: Record<string, number> = {
  sun: 0, sunday: 0, su: 0,
  mon: 1, monday: 1, mo: 1, m: 1,
  tue: 2, tuesday: 2, tu: 2,
  wed: 3, wednesday: 3, we: 3, w: 3,
  thu: 4, thursday: 4, th: 4,
  fri: 5, friday: 5, fr: 5, f: 5,
  sat: 6, saturday: 6, sa: 6,
};

/** Parse an "Active Days" string like "Mon,Tue,Wed,Thu,Fri" or "1,2,3,4,5" into number[] */
/** Resolve a single day token (name or number) to a day index, or -1 if unknown */
function resolveDayToken(token: string): number {
  const t = token.trim().toLowerCase();
  if (DAY_NAMES[t] !== undefined) return DAY_NAMES[t];
  const n = parseInt(t, 10);
  if (!isNaN(n) && n >= 0 && n <= 6) return n;
  return -1;
}

/** Expand a day range like "Mon-Sat" to [1,2,3,4,5,6] */
function expandDayRange(start: number, end: number): number[] {
  const days: number[] = [];
  if (start <= end) {
    for (let i = start; i <= end; i++) days.push(i);
  } else {
    // Wrap around: e.g. Fri-Mon → [5,6,0,1]
    for (let i = start; i <= 6; i++) days.push(i);
    for (let i = 0; i <= end; i++) days.push(i);
  }
  return days;
}

function parseActiveDays(s: string): number[] | null {
  if (!s) return null;

  // Check for common shorthands
  const lower = s.toLowerCase().trim();
  if (lower === 'daily' || lower === 'everyday' || lower === '7 days') return [0, 1, 2, 3, 4, 5, 6];
  if (lower === 'weekdays') return [1, 2, 3, 4, 5];
  if (lower === 'weekends') return [0, 6];

  // Split on comma/semicolon/pipe/slash but NOT hyphen (hyphens are for ranges)
  const parts = s.split(/[,;|\/]+/).map((p) => p.trim().toLowerCase()).filter(Boolean);
  const days: number[] = [];

  for (const part of parts) {
    // Check if it's a range (e.g. "Mon-Sat", "Mon–Fri", "1-5")
    const rangeMatch = part.match(/^([a-z]+|\d)\s*[-–]\s*([a-z]+|\d)$/);
    if (rangeMatch) {
      const start = resolveDayToken(rangeMatch[1]);
      const end = resolveDayToken(rangeMatch[2]);
      if (start >= 0 && end >= 0) {
        days.push(...expandDayRange(start, end));
        continue;
      }
    }

    // Single day token
    const d = resolveDayToken(part);
    if (d >= 0) {
      days.push(d);
    }
  }

  return days.length > 0 ? [...new Set(days)].sort() : null;
}

/** Convert a parsed CSV row object to the ExtractedLane structure */
function csvRowToExtractedLane(row: Record<string, string>): ExtractedLane {
  const high = <T = string>(value: T | null): ExtractedField<T> => ({ value, confidence: 'high' as const });
  const str = (key: string): string | null => row[key] || null;
  const num = (key: string): number | null => {
    const v = row[key];
    if (!v) return null;
    const n = parseFloat(v.replace(/[$,]/g, ''));
    return isNaN(n) ? null : n;
  };

  const activeDays = parseActiveDays(row['activeDays'] ?? '');
  const roundTrip = row['roundTrip']?.toLowerCase();
  const isRoundTrip = roundTrip === 'yes' || roundTrip === 'true' || roundTrip === '1';

  // Parse intermediate stops
  const stops: ExtractedStop[] = [];
  for (let i = 1; i <= 10; i++) {
    const city = row[`stop${i}City`];
    const state = row[`stop${i}State`];
    if (city || state) {
      const typeVal = (row[`stop${i}Type`] ?? '').toLowerCase();
      const apptVal = (row[`stop${i}ApptType`] ?? 'APPT').toUpperCase();
      stops.push({
        city: city ?? '',
        state: state ?? '',
        zip: row[`stop${i}Zip`] ?? '',
        address: row[`stop${i}Address`] ?? '',
        stopType: typeVal === 'pickup' ? 'Pickup' : 'Delivery',
        apptType: apptVal === 'FCFS' ? 'FCFS' : apptVal === 'LIVE' ? 'Live' : 'APPT',
        timeStart: row[`stop${i}TimeStart`] ?? '',
        timeEnd: row[`stop${i}TimeEnd`] ?? '',
      });
    }
  }

  return {
    laneName: high(str('laneName')),
    originCity: high(str('originCity')),
    originState: high(str('originState')),
    originZip: high(str('originZip')),
    originAddress: high(str('originAddress')),
    originApptType: high(str('originApptType') ?? 'APPT'),
    originTimeStart: high(str('originTimeStart')),
    originTimeEnd: high(str('originTimeEnd')),
    intermediateStops: stops,
    destinationCity: high(str('destCity')),
    destinationState: high(str('destState')),
    destinationZip: high(str('destZip')),
    destinationAddress: high(str('destAddress')),
    destApptType: high(str('destApptType') ?? 'APPT'),
    destTimeStart: high(str('destTimeStart')),
    destTimeEnd: high(str('destTimeEnd')),
    miles: high(num('miles')),
    rate: high(num('rate')),
    rateType: high(str('rateType')),
    frequency: high(str('activeDays')),
    activeDays: high(activeDays),
    excludeHolidays: high(parseYesNo(row['excludeHolidays'], true)),
    equipmentType: high(str('equipment')),
    equipmentSize: high<string>(null),
    contractStart: high(str('contractStart')),
    contractEnd: high(str('contractEnd')),
    hcr: high(str('hcr')),
    tripNumber: high(str('tripNumber')),
    isRoundTrip: high(isRoundTrip),
    notes: high(str('notes')),
  };
}
