'use client';

import {
  Breadcrumb,
  BreadcrumbItem,
  BreadcrumbLink,
  BreadcrumbList,
  BreadcrumbPage,
  BreadcrumbSeparator,
} from '@/components/ui/breadcrumb';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Separator } from '@/components/ui/separator';
import { SidebarTrigger } from '@/components/ui/sidebar';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { useAuth } from '@workos-inc/authkit-nextjs/components';
import { useMutation } from 'convex/react';
import { api } from '@/convex/_generated/api';
import { useRouter } from 'next/navigation';
import Link from 'next/link';
import { useState, useCallback, useRef } from 'react';
import { useOrganizationId } from '@/contexts/organization-context';
import { useAuthQuery } from '@/hooks/use-auth-query';
import { Upload, Download, CheckCircle, AlertCircle, Loader2, ArrowLeft, ArrowRight } from 'lucide-react';
import { toast } from 'sonner';
import { generateCSVTemplate } from '@/lib/csv-export';
import { Id } from '@/convex/_generated/dataModel';

type FuelField =
  | 'date'
  | 'driverName'
  | 'truckUnit'
  | 'vendorName'
  | 'gallons'
  | 'pricePerGallon'
  | 'total'
  | 'odometer'
  | 'city'
  | 'state'
  | 'fuelCardNumber'
  | 'receiptNumber'
  | 'paymentMethod'
  | 'notes';

interface FieldDef {
  key: FuelField;
  label: string;
  required: boolean;
}

type FuelPaymentMethod = 'FUEL_CARD' | 'CASH' | 'CHECK' | 'CREDIT_CARD' | 'EFS' | 'COMDATA';

const FUEL_FIELDS: Array<FieldDef> = [
  { key: 'date', label: 'Date', required: true },
  { key: 'driverName', label: 'Driver Name', required: false },
  { key: 'truckUnit', label: 'Truck Unit', required: false },
  { key: 'vendorName', label: 'Vendor Name', required: true },
  { key: 'gallons', label: 'Gallons', required: true },
  { key: 'pricePerGallon', label: 'Price Per Gallon', required: true },
  { key: 'total', label: 'Total', required: false },
  { key: 'odometer', label: 'Odometer', required: false },
  { key: 'city', label: 'City', required: false },
  { key: 'state', label: 'State', required: false },
  { key: 'fuelCardNumber', label: 'Fuel Card Number', required: false },
  { key: 'receiptNumber', label: 'Receipt Number', required: false },
  { key: 'paymentMethod', label: 'Payment Method', required: false },
  { key: 'notes', label: 'Notes', required: false },
];

const TEMPLATE_COLUMNS = FUEL_FIELDS.map((f) => f.label);

const AUTO_MAP: Record<string, FuelField> = {
  'date': 'date',
  'entry date': 'date',
  'transaction date': 'date',
  'trans date': 'date',
  'driver': 'driverName',
  'driver name': 'driverName',
  'driver_name': 'driverName',
  'truck': 'truckUnit',
  'truck unit': 'truckUnit',
  'unit id': 'truckUnit',
  'unit': 'truckUnit',
  'truck_unit': 'truckUnit',
  'vendor': 'vendorName',
  'vendor name': 'vendorName',
  'vendor_name': 'vendorName',
  'station': 'vendorName',
  'fuel station': 'vendorName',
  'merchant': 'vendorName',
  'gallons': 'gallons',
  'quantity': 'gallons',
  'gal': 'gallons',
  'price': 'pricePerGallon',
  'price per gallon': 'pricePerGallon',
  'price/gallon': 'pricePerGallon',
  'ppg': 'pricePerGallon',
  'unit price': 'pricePerGallon',
  'rate': 'pricePerGallon',
  'total': 'total',
  'amount': 'total',
  'total cost': 'total',
  'total amount': 'total',
  'odometer': 'odometer',
  'odometer reading': 'odometer',
  'mileage': 'odometer',
  'miles': 'odometer',
  'city': 'city',
  'state': 'state',
  'fuel card': 'fuelCardNumber',
  'fuel card number': 'fuelCardNumber',
  'card number': 'fuelCardNumber',
  'card #': 'fuelCardNumber',
  'receipt': 'receiptNumber',
  'receipt number': 'receiptNumber',
  'receipt #': 'receiptNumber',
  'receipt no': 'receiptNumber',
  'payment method': 'paymentMethod',
  'payment': 'paymentMethod',
  'payment type': 'paymentMethod',
  'notes': 'notes',
  'comments': 'notes',
  'memo': 'notes',
};

const PAYMENT_METHOD_MAP: Record<string, FuelPaymentMethod> = {
  'fuel_card': 'FUEL_CARD',
  'fuel card': 'FUEL_CARD',
  'fuelcard': 'FUEL_CARD',
  'cash': 'CASH',
  'check': 'CHECK',
  'credit card': 'CREDIT_CARD',
  'credit_card': 'CREDIT_CARD',
  'cc': 'CREDIT_CARD',
  'efs': 'EFS',
  'comdata': 'COMDATA',
};

const VALID_PAYMENT_METHODS = ['FUEL_CARD', 'CASH', 'CHECK', 'CREDIT_CARD', 'EFS', 'COMDATA'];

interface ParsedRow {
  raw: Array<string>;
  mapped: Record<string, string>;
  errors: Array<string>;
  warnings: Array<string>;
  skip: boolean;
  resolvedDriverId?: Id<'drivers'>;
  resolvedTruckId?: Id<'trucks'>;
  resolvedVendorId?: Id<'fuelVendors'>;
}

interface BulkFuelEntryInput {
  entryDate: number;
  driverId?: Id<'drivers'>;
  carrierId?: Id<'carrierPartnerships'>;
  truckId?: Id<'trucks'>;
  vendorId: Id<'fuelVendors'>;
  gallons: number;
  pricePerGallon: number;
  odometerReading?: number;
  location?: { city: string; state: string };
  fuelCardNumber?: string;
  receiptNumber?: string;
  loadId?: Id<'loadInformation'>;
  paymentMethod?: FuelPaymentMethod;
  notes?: string;
}

function parseCSV(text: string): { headers: Array<string>; rows: Array<Array<string>> } {
  const lines: Array<string> = [];
  let current = '';
  let inQuotes = false;

  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (ch === '"') {
      if (inQuotes && i + 1 < text.length && text[i + 1] === '"') {
        current += '"';
        i++;
      } else {
        inQuotes = !inQuotes;
      }
    } else if ((ch === '\n' || ch === '\r') && !inQuotes) {
      if (ch === '\r' && i + 1 < text.length && text[i + 1] === '\n') {
        i++;
      }
      lines.push(current);
      current = '';
    } else {
      current += ch;
    }
  }
  if (current.length > 0) {
    lines.push(current);
  }

  const parseLine = (line: string): Array<string> => {
    const fields: Array<string> = [];
    let field = '';
    let quoted = false;

    for (let i = 0; i < line.length; i++) {
      const ch = line[i];
      if (ch === '"') {
        if (quoted && i + 1 < line.length && line[i + 1] === '"') {
          field += '"';
          i++;
        } else {
          quoted = !quoted;
        }
      } else if (ch === ',' && !quoted) {
        fields.push(field.trim());
        field = '';
      } else {
        field += ch;
      }
    }
    fields.push(field.trim());
    return fields;
  };

  const nonEmpty = lines.filter((l) => l.trim().length > 0);
  if (nonEmpty.length === 0) return { headers: [], rows: [] };

  const headers = parseLine(nonEmpty[0]);
  const rows = nonEmpty.slice(1).map(parseLine);

  return { headers, rows };
}

function tryParseDate(value: string): number | null {
  if (!value) return null;
  const d = new Date(value);
  if (!isNaN(d.getTime())) return d.getTime();

  const parts = value.match(/^(\d{1,2})[/\-.](\d{1,2})[/\-.](\d{2,4})$/);
  if (parts) {
    const month = parseInt(parts[1], 10);
    const day = parseInt(parts[2], 10);
    let year = parseInt(parts[3], 10);
    if (year < 100) year += 2000;
    const parsed = new Date(year, month - 1, day);
    if (!isNaN(parsed.getTime())) return parsed.getTime();
  }

  return null;
}

function fuzzyMatchName(
  fullName: string,
  drivers: Array<{ _id: Id<'drivers'>; firstName: string; lastName: string }>,
): Id<'drivers'> | undefined {
  const normalized = fullName.toLowerCase().trim();
  if (!normalized) return undefined;

  for (const d of drivers) {
    const full = `${d.firstName} ${d.lastName}`.toLowerCase();
    if (full === normalized) return d._id;
  }
  for (const d of drivers) {
    const full = `${d.lastName}, ${d.firstName}`.toLowerCase();
    if (full === normalized) return d._id;
    const lastFirst = `${d.lastName} ${d.firstName}`.toLowerCase();
    if (lastFirst === normalized) return d._id;
  }
  for (const d of drivers) {
    const full = `${d.firstName} ${d.lastName}`.toLowerCase();
    if (normalized.includes(d.lastName.toLowerCase()) && normalized.includes(d.firstName.toLowerCase())) {
      return d._id;
    }
    if (full.includes(normalized) || normalized.includes(full)) {
      return d._id;
    }
  }
  return undefined;
}

export default function ImportFuelEntriesPage() {
  const { user } = useAuth();
  const router = useRouter();
  const organizationId = useOrganizationId();
  const bulkCreate = useMutation(api.fuelEntries.bulkCreate);

  const drivers = useAuthQuery(api.drivers.list, organizationId ? { organizationId } : 'skip');
  const trucks = useAuthQuery(api.trucks.list, organizationId ? { organizationId } : 'skip');
  const vendors = useAuthQuery(api.fuelVendors.list, organizationId ? { organizationId, activeOnly: true } : 'skip');

  const [currentStep, setCurrentStep] = useState(1);
  const [csvHeaders, setCsvHeaders] = useState<Array<string>>([]);
  const [csvRows, setCsvRows] = useState<Array<Array<string>>>([]);
  const [columnMap, setColumnMap] = useState<Record<number, FuelField | 'skip'>>({});
  const [parsedRows, setParsedRows] = useState<Array<ParsedRow>>([]);
  const [importing, setImporting] = useState(false);
  const [importResult, setImportResult] = useState<{ imported: number; skipped: number } | null>(null);
  const [dragOver, setDragOver] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);

  const handleFile = useCallback((file: File) => {
    const reader = new FileReader();
    reader.onload = (e) => {
      const text = e.target?.result as string;
      const { headers, rows } = parseCSV(text);
      if (headers.length === 0) {
        toast.error('Could not parse CSV file. Please check the format.');
        return;
      }
      setCsvHeaders(headers);
      setCsvRows(rows);

      const autoMap: Record<number, FuelField | 'skip'> = {};
      headers.forEach((h, i) => {
        const key = h.toLowerCase().trim();
        if (AUTO_MAP[key]) {
          autoMap[i] = AUTO_MAP[key];
        }
      });
      setColumnMap(autoMap);
    };
    reader.readAsText(file);
  }, []);

  const handleDrop = useCallback(
    (e: React.DragEvent) => {
      e.preventDefault();
      setDragOver(false);
      const file = e.dataTransfer.files[0];
      if (file && (file.name.endsWith('.csv') || file.type === 'text/csv')) {
        handleFile(file);
      } else {
        toast.error('Please upload a CSV file.');
      }
    },
    [handleFile],
  );

  const handleFileSelect = useCallback(
    (e: React.ChangeEvent<HTMLInputElement>) => {
      const file = e.target.files?.[0];
      if (file) handleFile(file);
    },
    [handleFile],
  );

  const handleDownloadTemplate = () => {
    generateCSVTemplate(TEMPLATE_COLUMNS, 'fuel-entries');
  };

  const requiredFields = FUEL_FIELDS.filter((f) => f.required).map((f) => f.key);
  const mappedFields = new Set(Object.values(columnMap).filter((v) => v !== 'skip'));
  const missingRequired = requiredFields.filter((f) => !mappedFields.has(f));

  const buildParsedRows = useCallback(() => {
    const driverList = (drivers ?? []).filter((d) => !d.isDeleted);
    const truckList = (trucks ?? []).filter((t) => !t.isDeleted);
    const vendorList = vendors ?? [];

    const reverseMap: Record<FuelField, number> = {} as Record<FuelField, number>;
    for (const [colIdx, field] of Object.entries(columnMap)) {
      if (field !== 'skip') {
        reverseMap[field] = parseInt(colIdx, 10);
      }
    }

    const getValue = (row: Array<string>, field: FuelField): string => {
      const idx = reverseMap[field];
      if (idx === undefined) return '';
      return (row[idx] ?? '').trim();
    };

    const result: Array<ParsedRow> = csvRows.map((row) => {
      const errors: Array<string> = [];
      const warnings: Array<string> = [];
      const mapped: Record<string, string> = {};

      for (const field of FUEL_FIELDS) {
        mapped[field.key] = getValue(row, field.key);
      }

      const dateStr = mapped.date;
      const parsedDate = tryParseDate(dateStr);
      if (!dateStr) {
        errors.push('Date is required');
      } else if (parsedDate === null) {
        errors.push(`Invalid date: "${dateStr}"`);
      }

      const gallonsStr = mapped.gallons;
      const gallons = parseFloat(gallonsStr);
      if (!gallonsStr) {
        errors.push('Gallons is required');
      } else if (isNaN(gallons) || gallons <= 0) {
        errors.push(`Invalid gallons: "${gallonsStr}"`);
      }

      const ppgStr = mapped.pricePerGallon;
      const ppg = parseFloat(ppgStr.replace(/^\$/, ''));
      if (!ppgStr) {
        errors.push('Price per gallon is required');
      } else if (isNaN(ppg) || ppg <= 0) {
        errors.push(`Invalid price: "${ppgStr}"`);
      }

      const vendorName = mapped.vendorName;
      let resolvedVendorId: Id<'fuelVendors'> | undefined;
      if (!vendorName) {
        errors.push('Vendor name is required');
      } else {
        const match = vendorList.find((v) => v.name.toLowerCase() === vendorName.toLowerCase());
        if (match) {
          resolvedVendorId = match._id;
        } else {
          warnings.push(`Vendor "${vendorName}" not found`);
        }
      }

      let resolvedDriverId: Id<'drivers'> | undefined;
      const driverName = mapped.driverName;
      if (driverName) {
        resolvedDriverId = fuzzyMatchName(driverName, driverList);
        if (!resolvedDriverId) {
          warnings.push(`Driver "${driverName}" not matched`);
        }
      }

      let resolvedTruckId: Id<'trucks'> | undefined;
      const truckUnit = mapped.truckUnit;
      if (truckUnit) {
        const match = truckList.find((t) => t.unitId.toLowerCase() === truckUnit.toLowerCase());
        if (match) {
          resolvedTruckId = match._id;
        } else {
          warnings.push(`Truck "${truckUnit}" not found`);
        }
      }

      const odometerStr = mapped.odometer;
      if (odometerStr) {
        const odo = parseFloat(odometerStr);
        if (isNaN(odo) || odo < 0) {
          warnings.push(`Invalid odometer: "${odometerStr}"`);
        }
      }

      const pmStr = mapped.paymentMethod;
      if (pmStr) {
        const normalized = PAYMENT_METHOD_MAP[pmStr.toLowerCase()];
        if (!normalized && !VALID_PAYMENT_METHODS.includes(pmStr.toUpperCase())) {
          warnings.push(`Unknown payment method: "${pmStr}"`);
        }
      }

      return {
        raw: row,
        mapped,
        errors,
        warnings,
        skip: false,
        resolvedDriverId,
        resolvedTruckId,
        resolvedVendorId,
      };
    });

    setParsedRows(result);
  }, [csvRows, columnMap, drivers, trucks, vendors]);

  const handleGoToReview = () => {
    buildParsedRows();
    setCurrentStep(3);
  };

  const toggleSkip = (index: number) => {
    setParsedRows((prev) => prev.map((r, i) => (i === index ? { ...r, skip: !r.skip } : r)));
  };

  const handleImport = async () => {
    if (!organizationId || !user) return;

    const validRows = parsedRows.filter((r) => !r.skip && r.errors.length === 0 && r.resolvedVendorId);

    if (validRows.length === 0) {
      toast.error('No valid rows to import.');
      return;
    }

    setImporting(true);
    let imported = 0;
    const skipped = parsedRows.length - validRows.length;

    try {
      const BATCH_SIZE = 50;
      for (let i = 0; i < validRows.length; i += BATCH_SIZE) {
        const batch = validRows.slice(i, i + BATCH_SIZE);
        const entries: BulkFuelEntryInput[] = batch.map((row) => {
          const dateVal = tryParseDate(row.mapped.date)!;
          const gallons = parseFloat(row.mapped.gallons);
          const ppg = parseFloat(row.mapped.pricePerGallon.replace(/^\$/, ''));
          const odometerStr = row.mapped.odometer;
          const odometer = odometerStr ? parseFloat(odometerStr) : undefined;
          const city = row.mapped.city;
          const state = row.mapped.state;
          const pmStr = row.mapped.paymentMethod;
          let paymentMethod: FuelPaymentMethod | undefined;
          if (pmStr) {
            paymentMethod = (PAYMENT_METHOD_MAP[pmStr.toLowerCase()] ||
              (VALID_PAYMENT_METHODS.includes(pmStr.toUpperCase()) ? pmStr.toUpperCase() : undefined)) as
              | FuelPaymentMethod
              | undefined;
          }

          const entry: BulkFuelEntryInput = {
            entryDate: dateVal,
            vendorId: row.resolvedVendorId!,
            gallons,
            pricePerGallon: ppg,
          };

          if (row.resolvedDriverId) entry.driverId = row.resolvedDriverId;
          if (row.resolvedTruckId) entry.truckId = row.resolvedTruckId;
          if (odometer !== undefined && !isNaN(odometer) && odometer >= 0) {
            entry.odometerReading = odometer;
          }
          if (city && state) {
            entry.location = { city, state };
          }
          if (row.mapped.fuelCardNumber) entry.fuelCardNumber = row.mapped.fuelCardNumber;
          if (row.mapped.receiptNumber) entry.receiptNumber = row.mapped.receiptNumber;
          if (paymentMethod) entry.paymentMethod = paymentMethod;
          if (row.mapped.notes) entry.notes = row.mapped.notes;

          return entry;
        });

        await bulkCreate({
          organizationId,
          entries,
          createdBy: user.id,
        });

        imported += batch.length;
      }

      setImportResult({ imported, skipped });
      toast.success(`Successfully imported ${imported} fuel entries.`);
    } catch (error) {
      console.error('Bulk import failed:', error);
      toast.error('Import failed. Some entries may have been created.');
      setImportResult({ imported, skipped: skipped + (validRows.length - imported) });
    } finally {
      setImporting(false);
    }
  };

  const steps = [
    { num: 1, label: 'Upload' },
    { num: 2, label: 'Map Columns' },
    { num: 3, label: 'Review & Import' },
  ];

  const validCount = parsedRows.filter((r) => !r.skip && r.errors.length === 0 && r.resolvedVendorId).length;
  const errorCount = parsedRows.filter((r) => !r.skip && (r.errors.length > 0 || !r.resolvedVendorId)).length;
  const skipCount = parsedRows.filter((r) => r.skip).length;

  return (
    <>
      <header className="sticky top-0 z-40 flex h-16 shrink-0 items-center gap-2 transition-[width,height] ease-linear group-has-data-[collapsible=icon]/sidebar-wrapper:h-12 border-b bg-background">
        <div className="flex items-center gap-2 px-4">
          <SidebarTrigger className="-ml-1" />
          <Separator orientation="vertical" className="mr-2 data-[orientation=vertical]:h-4" />
          <Breadcrumb>
            <BreadcrumbList>
              <BreadcrumbItem className="hidden md:block">
                <BreadcrumbLink href="/dashboard">Home</BreadcrumbLink>
              </BreadcrumbItem>
              <BreadcrumbSeparator className="hidden md:block" />
              <BreadcrumbItem className="hidden md:block">
                <BreadcrumbLink href="#">Company Operations</BreadcrumbLink>
              </BreadcrumbItem>
              <BreadcrumbSeparator className="hidden md:block" />
              <BreadcrumbItem className="hidden md:block">
                <BreadcrumbLink href="/operations/diesel">Diesel</BreadcrumbLink>
              </BreadcrumbItem>
              <BreadcrumbSeparator className="hidden md:block" />
              <BreadcrumbItem>
                <BreadcrumbPage>Import Fuel Entries</BreadcrumbPage>
              </BreadcrumbItem>
            </BreadcrumbList>
          </Breadcrumb>
        </div>
      </header>

      <div className="flex flex-1 flex-col gap-6 p-6">
        <div className="flex justify-end">
          <Button variant="outline" asChild>
            <Link href="/operations/diesel/import/ocr">
              <Upload className="mr-2 h-4 w-4" />
              Use OCR Import Instead
            </Link>
          </Button>
        </div>

        {/* Step Indicator */}
        <div className="flex items-center justify-center gap-2">
          {steps.map((step, i) => (
            <div key={step.num} className="flex items-center gap-2">
              <div
                className={`flex items-center gap-2 rounded-full px-4 py-2 text-sm font-medium transition-colors ${
                  currentStep === step.num
                    ? 'bg-primary text-primary-foreground'
                    : currentStep > step.num
                      ? 'bg-primary/20 text-primary'
                      : 'bg-muted text-muted-foreground'
                }`}
              >
                {currentStep > step.num ? (
                  <CheckCircle className="h-4 w-4" />
                ) : (
                  <span className="flex h-5 w-5 items-center justify-center rounded-full border text-xs">
                    {step.num}
                  </span>
                )}
                <span className="hidden sm:inline">{step.label}</span>
              </div>
              {i < steps.length - 1 && (
                <div className={`h-px w-8 ${currentStep > step.num ? 'bg-primary' : 'bg-muted'}`} />
              )}
            </div>
          ))}
        </div>

        {/* Step 1: Upload */}
        {currentStep === 1 && (
          <div className="mx-auto w-full max-w-2xl space-y-6">
            <div className="text-center">
              <h2 className="text-2xl font-semibold">Upload CSV File</h2>
              <p className="mt-1 text-sm text-muted-foreground">
                Upload a fuel card statement or CSV export to bulk import fuel entries.
              </p>
            </div>

            <Card
              className={`relative flex flex-col items-center justify-center gap-4 border-2 border-dashed p-12 transition-colors cursor-pointer ${
                dragOver
                  ? 'border-primary bg-primary/5'
                  : csvHeaders.length > 0
                    ? 'border-green-500 bg-green-500/5'
                    : 'border-muted-foreground/25 hover:border-muted-foreground/50'
              }`}
              onDragOver={(e) => {
                e.preventDefault();
                setDragOver(true);
              }}
              onDragLeave={() => setDragOver(false)}
              onDrop={handleDrop}
              onClick={() => fileInputRef.current?.click()}
            >
              <input
                ref={fileInputRef}
                type="file"
                accept=".csv,text/csv"
                className="hidden"
                onChange={handleFileSelect}
              />
              {csvHeaders.length > 0 ? (
                <>
                  <CheckCircle className="h-10 w-10 text-green-500" />
                  <div className="text-center">
                    <p className="font-medium text-green-700 dark:text-green-400">File loaded successfully</p>
                    <p className="text-sm text-muted-foreground">
                      {csvHeaders.length} columns, {csvRows.length} data rows
                    </p>
                  </div>
                </>
              ) : (
                <>
                  <Upload className="h-10 w-10 text-muted-foreground" />
                  <div className="text-center">
                    <p className="font-medium">Drag & drop your CSV file here</p>
                    <p className="text-sm text-muted-foreground">or click to browse</p>
                  </div>
                </>
              )}
            </Card>

            <div className="flex justify-center">
              <Button variant="outline" onClick={handleDownloadTemplate}>
                <Download className="mr-2 h-4 w-4" />
                Download Template
              </Button>
            </div>

            {csvHeaders.length > 0 && csvRows.length > 0 && (
              <Card className="overflow-hidden">
                <div className="border-b px-4 py-3">
                  <h3 className="text-sm font-medium">Preview (first 5 rows)</h3>
                </div>
                <div className="overflow-x-auto">
                  <Table>
                    <TableHeader>
                      <TableRow>
                        {csvHeaders.map((h, i) => (
                          <TableHead key={i} className="whitespace-nowrap text-xs">
                            {h}
                          </TableHead>
                        ))}
                      </TableRow>
                    </TableHeader>
                    <TableBody>
                      {csvRows.slice(0, 5).map((row, ri) => (
                        <TableRow key={ri}>
                          {csvHeaders.map((_, ci) => (
                            <TableCell key={ci} className="whitespace-nowrap text-xs">
                              {row[ci] ?? ''}
                            </TableCell>
                          ))}
                        </TableRow>
                      ))}
                    </TableBody>
                  </Table>
                </div>
              </Card>
            )}

            <div className="flex justify-end">
              <Button onClick={() => setCurrentStep(2)} disabled={csvHeaders.length === 0 || csvRows.length === 0}>
                Next
                <ArrowRight className="ml-2 h-4 w-4" />
              </Button>
            </div>
          </div>
        )}

        {/* Step 2: Map Columns */}
        {currentStep === 2 && (
          <div className="mx-auto w-full max-w-3xl space-y-6">
            <div className="text-center">
              <h2 className="text-2xl font-semibold">Map Columns</h2>
              <p className="mt-1 text-sm text-muted-foreground">
                Match each CSV column to a fuel entry field. Required fields are marked with *.
              </p>
            </div>

            {missingRequired.length > 0 && (
              <div className="flex items-start gap-2 rounded-lg border border-destructive/50 bg-destructive/10 p-3">
                <AlertCircle className="mt-0.5 h-4 w-4 text-destructive shrink-0" />
                <p className="text-sm text-destructive">
                  Missing required mappings:{' '}
                  {missingRequired.map((f) => FUEL_FIELDS.find((ff) => ff.key === f)?.label).join(', ')}
                </p>
              </div>
            )}

            <Card className="divide-y">
              {csvHeaders.map((header, colIdx) => (
                <div key={colIdx} className="flex items-center justify-between gap-4 px-4 py-3">
                  <div className="min-w-0 flex-1">
                    <p className="truncate font-medium text-sm">{header}</p>
                    <p className="truncate text-xs text-muted-foreground">
                      e.g. &quot;{csvRows[0]?.[colIdx] ?? ''}&quot;
                    </p>
                  </div>
                  <div className="w-56 shrink-0">
                    <Select
                      value={columnMap[colIdx] ?? 'unmapped'}
                      onValueChange={(val) => {
                        setColumnMap((prev) => ({
                          ...prev,
                          [colIdx]: val === 'unmapped' ? undefined! : (val as FuelField | 'skip'),
                        }));
                        if (val === 'unmapped') {
                          setColumnMap((prev) => {
                            const next = { ...prev };
                            delete next[colIdx];
                            return next;
                          });
                        }
                      }}
                    >
                      <SelectTrigger>
                        <SelectValue placeholder="Select field..." />
                      </SelectTrigger>
                      <SelectContent>
                        <SelectItem value="unmapped">-- Do not import --</SelectItem>
                        <SelectItem value="skip">Skip this column</SelectItem>
                        {FUEL_FIELDS.map((field) => {
                          const alreadyMapped = Object.entries(columnMap).some(
                            ([idx, val]) => val === field.key && parseInt(idx) !== colIdx,
                          );
                          return (
                            <SelectItem key={field.key} value={field.key} disabled={alreadyMapped}>
                              {field.label}
                              {field.required ? ' *' : ''}
                              {alreadyMapped ? ' (already mapped)' : ''}
                            </SelectItem>
                          );
                        })}
                      </SelectContent>
                    </Select>
                  </div>
                </div>
              ))}
            </Card>

            <div className="flex justify-between">
              <Button variant="outline" onClick={() => setCurrentStep(1)}>
                <ArrowLeft className="mr-2 h-4 w-4" />
                Back
              </Button>
              <Button onClick={handleGoToReview} disabled={missingRequired.length > 0}>
                Next
                <ArrowRight className="ml-2 h-4 w-4" />
              </Button>
            </div>
          </div>
        )}

        {/* Step 3: Review & Import */}
        {currentStep === 3 && (
          <div className="space-y-6">
            <div className="text-center">
              <h2 className="text-2xl font-semibold">Review & Import</h2>
              <p className="mt-1 text-sm text-muted-foreground">
                Review parsed data before importing. Fix or skip rows with issues.
              </p>
            </div>

            {importResult && (
              <Card className="mx-auto max-w-md p-6 text-center">
                <CheckCircle className="mx-auto h-12 w-12 text-green-500" />
                <h3 className="mt-3 text-lg font-semibold">Import Complete</h3>
                <div className="mt-2 flex justify-center gap-4">
                  <div>
                    <p className="text-2xl font-bold text-green-600">{importResult.imported}</p>
                    <p className="text-xs text-muted-foreground">Imported</p>
                  </div>
                  <div>
                    <p className="text-2xl font-bold text-muted-foreground">{importResult.skipped}</p>
                    <p className="text-xs text-muted-foreground">Skipped</p>
                  </div>
                </div>
                <Button className="mt-4" onClick={() => router.push('/operations/diesel')}>
                  Go to Fuel Entries
                </Button>
              </Card>
            )}

            {!importResult && (
              <>
                <div className="flex flex-wrap items-center justify-center gap-3">
                  <Badge variant="default" className="gap-1">
                    <CheckCircle className="h-3 w-3" />
                    {validCount} valid
                  </Badge>
                  {errorCount > 0 && (
                    <Badge variant="destructive" className="gap-1">
                      <AlertCircle className="h-3 w-3" />
                      {errorCount} with errors
                    </Badge>
                  )}
                  {skipCount > 0 && (
                    <Badge variant="secondary" className="gap-1">
                      {skipCount} skipped
                    </Badge>
                  )}
                </div>

                <Card className="overflow-hidden">
                  <div className="overflow-x-auto">
                    <Table>
                      <TableHeader>
                        <TableRow>
                          <TableHead className="w-10">#</TableHead>
                          <TableHead>Status</TableHead>
                          <TableHead>Date</TableHead>
                          <TableHead>Vendor</TableHead>
                          <TableHead>Driver</TableHead>
                          <TableHead>Truck</TableHead>
                          <TableHead className="text-right">Gallons</TableHead>
                          <TableHead className="text-right">Price/Gal</TableHead>
                          <TableHead className="text-right">Total</TableHead>
                          <TableHead>Issues</TableHead>
                          <TableHead className="w-20">Action</TableHead>
                        </TableRow>
                      </TableHeader>
                      <TableBody>
                        {parsedRows.map((row, idx) => {
                          const gallons = parseFloat(row.mapped.gallons);
                          const ppg = parseFloat(row.mapped.pricePerGallon?.replace(/^\$/, '') ?? '');
                          const total =
                            !isNaN(gallons) && !isNaN(ppg) ? (gallons * ppg).toFixed(2) : row.mapped.total || '—';

                          return (
                            <TableRow key={idx} className={row.skip ? 'opacity-40' : ''}>
                              <TableCell className="text-xs text-muted-foreground">{idx + 1}</TableCell>
                              <TableCell>
                                {row.skip ? (
                                  <Badge variant="secondary" className="text-xs">
                                    Skipped
                                  </Badge>
                                ) : row.errors.length > 0 || !row.resolvedVendorId ? (
                                  <Badge variant="destructive" className="text-xs">
                                    Error
                                  </Badge>
                                ) : row.warnings.length > 0 ? (
                                  <Badge variant="outline" className="border-yellow-500 text-yellow-600 text-xs">
                                    Warning
                                  </Badge>
                                ) : (
                                  <Badge variant="default" className="text-xs">
                                    Valid
                                  </Badge>
                                )}
                              </TableCell>
                              <TableCell className="whitespace-nowrap text-sm">{row.mapped.date || '—'}</TableCell>
                              <TableCell className="text-sm">
                                <span
                                  className={!row.resolvedVendorId && row.mapped.vendorName ? 'text-destructive' : ''}
                                >
                                  {row.mapped.vendorName || '—'}
                                </span>
                              </TableCell>
                              <TableCell className="text-sm">
                                <span
                                  className={row.mapped.driverName && !row.resolvedDriverId ? 'text-yellow-600' : ''}
                                >
                                  {row.mapped.driverName || '—'}
                                </span>
                              </TableCell>
                              <TableCell className="text-sm">
                                <span className={row.mapped.truckUnit && !row.resolvedTruckId ? 'text-yellow-600' : ''}>
                                  {row.mapped.truckUnit || '—'}
                                </span>
                              </TableCell>
                              <TableCell className="text-right text-sm">{row.mapped.gallons || '—'}</TableCell>
                              <TableCell className="text-right text-sm">{row.mapped.pricePerGallon || '—'}</TableCell>
                              <TableCell className="text-right text-sm">${total}</TableCell>
                              <TableCell className="max-w-[200px]">
                                {(row.errors.length > 0 || row.warnings.length > 0) && (
                                  <div className="space-y-0.5">
                                    {row.errors.map((e, i) => (
                                      <p key={`e-${i}`} className="text-xs text-destructive truncate">
                                        {e}
                                      </p>
                                    ))}
                                    {row.warnings.map((w, i) => (
                                      <p key={`w-${i}`} className="text-xs text-yellow-600 truncate">
                                        {w}
                                      </p>
                                    ))}
                                  </div>
                                )}
                              </TableCell>
                              <TableCell>
                                <Button variant="ghost" size="sm" className="text-xs" onClick={() => toggleSkip(idx)}>
                                  {row.skip ? 'Include' : 'Skip'}
                                </Button>
                              </TableCell>
                            </TableRow>
                          );
                        })}
                      </TableBody>
                    </Table>
                  </div>
                </Card>

                <div className="flex justify-between">
                  <Button variant="outline" onClick={() => setCurrentStep(2)}>
                    <ArrowLeft className="mr-2 h-4 w-4" />
                    Back
                  </Button>
                  <Button onClick={handleImport} disabled={importing || validCount === 0}>
                    {importing ? (
                      <>
                        <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                        Importing...
                      </>
                    ) : (
                      <>
                        <Upload className="mr-2 h-4 w-4" />
                        Import {validCount} Entries
                      </>
                    )}
                  </Button>
                </div>
              </>
            )}
          </div>
        )}
      </div>
    </>
  );
}
