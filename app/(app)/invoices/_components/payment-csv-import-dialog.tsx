'use client';

import { useState, useMemo, useCallback } from 'react';
import { useMutation, useQuery } from 'convex/react';
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
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { RadioGroup, RadioGroupItem } from '@/components/ui/radio-group';
import { Label } from '@/components/ui/label';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import {
  Upload,
  FileSpreadsheet,
  AlertCircle,
  CheckCircle2,
  ArrowLeft,
  ArrowRight,
  AlertTriangle,
  TrendingDown,
  TrendingUp,
  Download,
  Search,
  X,
} from 'lucide-react';
import { Input } from '@/components/ui/input';
import { toast } from 'sonner';
import { cn } from '@/lib/utils';
import { Progress } from '@/components/ui/progress';

interface PaymentCsvImportDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  workosOrgId: string;
  userId: string;
}

type MatchType = 'invoiceNumber' | 'orderNumber';

interface ColumnMapping {
  matchKey: string | null;
  paidAmount: string | null;
  paymentDate: string | null;
  paymentReference: string | null;
  paymentMiles: string | null;
}

interface ParsedPayment {
  matchKey: string;
  paidAmount: number;
  paymentDate?: string;
  paymentMiles?: number;
  paymentReference?: string;
}

interface ValidationError {
  row: number;
  message: string;
}

interface NotFoundItem {
  matchKey: string;
  paidAmount: number;
  paymentDate?: string;
  paymentReference?: string;
}

interface ImportResults {
  success: number;
  failed: number;
  alreadyPaid: number;
  notFound: NotFoundItem[];
  noInvoice: NotFoundItem[];
  discrepancies: Array<{
    matchKey: string;
    invoicedAmount: number;
    paidAmount: number;
    difference: number;
  }>;
}

type Step = 'upload' | 'mapping' | 'review' | 'processing' | 'results';

// Prioritized auto-match rules. Earlier entries win when multiple columns match the same field.
// Each entry: [normalizedHeader, field, priority] -- lower priority number = preferred match.
const AUTO_MATCH_RULES: Array<{
  pattern: string;
  field: keyof ColumnMapping;
  priority: number;
}> = [
  // Match key: invoice number (high priority)
  { pattern: 'invoicenumber', field: 'matchKey', priority: 1 },
  { pattern: 'invoice_number', field: 'matchKey', priority: 1 },
  { pattern: 'invoiceno', field: 'matchKey', priority: 1 },
  { pattern: 'invoice_no', field: 'matchKey', priority: 1 },
  // Match key: order / load identifiers
  { pattern: 'ordernumber', field: 'matchKey', priority: 2 },
  { pattern: 'order_number', field: 'matchKey', priority: 2 },
  { pattern: 'loadid', field: 'matchKey', priority: 3 },
  { pattern: 'load_id', field: 'matchKey', priority: 3 },
  { pattern: 'svtripid', field: 'matchKey', priority: 4 },
  { pattern: 'sv_trip_id', field: 'matchKey', priority: 4 },
  { pattern: 'vouchernumber', field: 'matchKey', priority: 5 },
  { pattern: 'voucher_number', field: 'matchKey', priority: 5 },
  // Paid amount (prefer "paid amt" over generic "amount")
  { pattern: 'paidamount', field: 'paidAmount', priority: 1 },
  { pattern: 'paid_amount', field: 'paidAmount', priority: 1 },
  { pattern: 'paidamt', field: 'paidAmount', priority: 1 },
  { pattern: 'paid_amt', field: 'paidAmount', priority: 1 },
  { pattern: 'amountpaid', field: 'paidAmount', priority: 2 },
  { pattern: 'amount_paid', field: 'paidAmount', priority: 2 },
  { pattern: 'finalcharge', field: 'paidAmount', priority: 3 },
  { pattern: 'final_charge', field: 'paidAmount', priority: 3 },
  { pattern: 'billedamt', field: 'paidAmount', priority: 4 },
  { pattern: 'billed_amt', field: 'paidAmount', priority: 4 },
  { pattern: 'amount', field: 'paidAmount', priority: 5 },
  // Payment date
  { pattern: 'paymentdate', field: 'paymentDate', priority: 1 },
  { pattern: 'payment_date', field: 'paymentDate', priority: 1 },
  { pattern: 'paiddate', field: 'paymentDate', priority: 2 },
  { pattern: 'paid_date', field: 'paymentDate', priority: 2 },
  { pattern: 'inv_date', field: 'paymentDate', priority: 3 },
  { pattern: 'invoicedate', field: 'paymentDate', priority: 4 },
  { pattern: 'invoice_date', field: 'paymentDate', priority: 4 },
  // Payment reference
  { pattern: 'checknumber', field: 'paymentReference', priority: 1 },
  { pattern: 'check_number', field: 'paymentReference', priority: 1 },
  { pattern: 'checkno', field: 'paymentReference', priority: 1 },
  { pattern: 'check_no', field: 'paymentReference', priority: 1 },
  { pattern: 'paymentreference', field: 'paymentReference', priority: 2 },
  { pattern: 'payment_reference', field: 'paymentReference', priority: 2 },
  { pattern: 'wirenumber', field: 'paymentReference', priority: 3 },
  { pattern: 'wire_number', field: 'paymentReference', priority: 3 },
  { pattern: 'reference', field: 'paymentReference', priority: 4 },
  { pattern: 'ref', field: 'paymentReference', priority: 5 },
  // Payment miles
  { pattern: 'miles', field: 'paymentMiles', priority: 1 },
  { pattern: 'totalmiles', field: 'paymentMiles', priority: 1 },
  { pattern: 'total_miles', field: 'paymentMiles', priority: 1 },
  { pattern: 'paymentmiles', field: 'paymentMiles', priority: 1 },
  { pattern: 'payment_miles', field: 'paymentMiles', priority: 1 },
  { pattern: 'mileage', field: 'paymentMiles', priority: 2 },
  { pattern: 'distance', field: 'paymentMiles', priority: 3 },
];

function normalizeHeader(header: string): string {
  return header.toLowerCase().replace(/[\s\-]/g, '');
}

function autoDetectMappings(headers: string[]): {
  mapping: ColumnMapping;
  matchType: MatchType;
} {
  const candidates: Record<
    keyof ColumnMapping,
    { header: string; priority: number } | null
  > = {
    matchKey: null,
    paidAmount: null,
    paymentDate: null,
    paymentReference: null,
    paymentMiles: null,
  };

  const ORDER_PATTERNS = new Set([
    'ordernumber', 'order_number',
    'loadid', 'load_id',
    'svtripid', 'sv_trip_id',
    'vouchernumber', 'voucher_number',
  ]);
  const INVOICE_PATTERNS = new Set([
    'invoicenumber', 'invoice_number',
    'invoiceno', 'invoice_no',
  ]);

  let detectedMatchType: MatchType = 'invoiceNumber';

  for (const header of headers) {
    const normalized = normalizeHeader(header);

    for (const rule of AUTO_MATCH_RULES) {
      if (rule.pattern !== normalized) continue;

      const current = candidates[rule.field];
      if (!current || rule.priority < current.priority) {
        candidates[rule.field] = { header, priority: rule.priority };

        if (rule.field === 'matchKey') {
          if (ORDER_PATTERNS.has(normalized)) {
            detectedMatchType = 'orderNumber';
          } else if (INVOICE_PATTERNS.has(normalized)) {
            detectedMatchType = 'invoiceNumber';
          }
        }
      }
      break;
    }
  }

  return {
    mapping: {
      matchKey: candidates.matchKey?.header ?? null,
      paidAmount: candidates.paidAmount?.header ?? null,
      paymentDate: candidates.paymentDate?.header ?? null,
      paymentReference: candidates.paymentReference?.header ?? null,
      paymentMiles: candidates.paymentMiles?.header ?? null,
    },
    matchType: detectedMatchType,
  };
}

// Flat lookup for the "is this column recognized?" highlight in step 1
const AUTO_MATCH_PATTERNS = new Set(AUTO_MATCH_RULES.map((r) => r.pattern));

const DELIMITERS = [',', '\t', '|', ';'] as const;

function detectDelimiter(headerLine: string): string {
  let best = ',';
  let bestCount = 0;

  for (const d of DELIMITERS) {
    const count = headerLine.split(d).length;
    if (count > bestCount) {
      bestCount = count;
      best = d;
    }
  }

  return best;
}

function cleanValue(val: string): string {
  return val
    .replace(/\u0000/g, '')      // null bytes (UTF-16 artifacts)
    .replace(/^\uFEFF/, '')       // BOM
    .replace(/[\u200B-\u200D\uFEFF\u00A0]/g, '') // zero-width chars, NBSP
    .replace(/\r/g, '')           // stray carriage returns
    .trim();
}

function parseCSVLine(line: string, delimiter: string): string[] {
  const fields: string[] = [];
  let current = '';
  let inQuotes = false;

  for (let i = 0; i < line.length; i++) {
    const char = line[i];

    if (inQuotes) {
      if (char === '"') {
        if (i + 1 < line.length && line[i + 1] === '"') {
          current += '"';
          i++;
        } else {
          inQuotes = false;
        }
      } else {
        current += char;
      }
    } else {
      if (char === '"') {
        inQuotes = true;
      } else if (char === delimiter) {
        fields.push(cleanValue(current));
        current = '';
      } else {
        current += char;
      }
    }
  }

  fields.push(cleanValue(current));
  return fields;
}

function formatCurrency(amount: number): string {
  return new Intl.NumberFormat('en-US', {
    style: 'currency',
    currency: 'USD',
  }).format(amount);
}

function exportNotFoundCsv(items: NotFoundItem[], filename: string) {
  const header = 'Match Key,Paid Amount,Payment Date,Payment Reference';
  const rows = items.map(
    (item) =>
      `"${item.matchKey}",${item.paidAmount},"${item.paymentDate ?? ''}","${item.paymentReference ?? ''}"`
  );
  const csv = [header, ...rows].join('\n');
  const blob = new Blob([csv], { type: 'text/csv;charset=utf-8;' });
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = `${filename}-${new Date().toISOString().slice(0, 10)}.csv`;
  link.click();
  URL.revokeObjectURL(url);
}

export function PaymentCsvImportDialog({
  open,
  onOpenChange,
  workosOrgId,
  userId,
}: PaymentCsvImportDialogProps) {
  const [step, setStep] = useState<Step>('upload');
  const [file, setFile] = useState<File | null>(null);
  const [matchType, setMatchType] = useState<MatchType>('invoiceNumber');
  const [csvHeaders, setCsvHeaders] = useState<string[]>([]);
  const [csvData, setCsvData] = useState<Record<string, string>[]>([]);
  const [columnMapping, setColumnMapping] = useState<ColumnMapping>({
    matchKey: null,
    paidAmount: null,
    paymentDate: null,
    paymentReference: null,
    paymentMiles: null,
  });
  const [isProcessing, setIsProcessing] = useState(false);
  const [progress, setProgress] = useState({ processed: 0, total: 0 });
  const [importResults, setImportResults] = useState<ImportResults | null>(null);

  const confirmPaymentChunk = useMutation(api.invoices.confirmPaymentChunk);
  const [debugKey, setDebugKey] = useState<string | null>(null);
  const debugResult = useQuery(
    api.invoices.debugLoadLookup,
    debugKey ? { workosOrgId, searchValue: debugKey } : "skip"
  );
  const [detailModal, setDetailModal] = useState<{
    type: 'notFound' | 'noInvoice' | 'discrepancies';
    title: string;
  } | null>(null);

  const resetState = useCallback(() => {
    setStep('upload');
    setFile(null);
    setMatchType('invoiceNumber');
    setCsvHeaders([]);
    setCsvData([]);
    setColumnMapping({
      matchKey: null,
      paidAmount: null,
      paymentDate: null,
      paymentReference: null,
      paymentMiles: null,
    });
    setIsProcessing(false);
    setProgress({ processed: 0, total: 0 });
    setImportResults(null);
    setDebugKey(null);
    setDetailModal(null);
  }, []);

  const handleClose = useCallback(
    (open: boolean) => {
      if (isProcessing) return;
      if (!open) resetState();
      onOpenChange(open);
    },
    [onOpenChange, resetState, isProcessing]
  );

  const handleFileChange = useCallback(
    async (e: React.ChangeEvent<HTMLInputElement>) => {
      const selectedFile = e.target.files?.[0];
      if (!selectedFile) return;

      if (!selectedFile.name.endsWith('.csv')) {
        toast.error('Please upload a CSV file');
        return;
      }

      try {
        const rawText = await selectedFile.text();
        // Strip null bytes (UTF-16 files read as UTF-8 leave \u0000 between chars) and BOM
        const text = rawText.replace(/\u0000/g, '').replace(/^\uFEFF/, '');
        const lines = text
          .split(/\r?\n/)
          .filter((line) => line.trim());
        if (lines.length < 2) {
          toast.error('CSV file is empty or has no data rows');
          return;
        }

        const delimiter = detectDelimiter(lines[0]);
        const headers = parseCSVLine(lines[0], delimiter);
        const rows: Record<string, string>[] = [];

        for (let i = 1; i < lines.length; i++) {
          const values = parseCSVLine(lines[i], delimiter);
          if (values.length === 0) continue;

          const row: Record<string, string> = {};
          headers.forEach((col, idx) => {
            row[col] = idx < values.length ? values[idx] : '';
          });
          rows.push(row);
        }

        setFile(selectedFile);
        setCsvHeaders(headers);
        setCsvData(rows);

        const { mapping, matchType: detectedType } = autoDetectMappings(headers);
        setMatchType(detectedType);
        setColumnMapping(mapping);
      } catch {
        toast.error('Failed to parse CSV file');
      }
    },
    []
  );

  const { parsedPayments, validationErrors, zeroAmountCount } = useMemo(() => {
    const payments: ParsedPayment[] = [];
    const errors: ValidationError[] = [];
    let zeroes = 0;

    if (!columnMapping.matchKey || !columnMapping.paidAmount) {
      return { parsedPayments: payments, validationErrors: errors, zeroAmountCount: 0 };
    }

    csvData.forEach((row, idx) => {
      const rowNum = idx + 2; // 1-indexed + header row
      const matchKey = row[columnMapping.matchKey!]?.trim();
      const amountStr = row[columnMapping.paidAmount!]?.trim();

      if (!matchKey) {
        errors.push({ row: rowNum, message: 'Missing match key' });
        return;
      }

      const cleaned = (amountStr ?? '').replace(/[^0-9.\-]/g, '');
      const paidAmount = parseFloat(cleaned);
      if (!cleaned || isNaN(paidAmount) || paidAmount < 0) {
        errors.push({
          row: rowNum,
          message: `Invalid amount "${amountStr}" for ${matchKey}`,
        });
        return;
      }

      if (paidAmount === 0) {
        zeroes++;
        return;
      }

      const payment: ParsedPayment = { matchKey, paidAmount };

      if (columnMapping.paymentDate) {
        const dateVal = row[columnMapping.paymentDate]?.trim();
        if (dateVal) payment.paymentDate = dateVal;
      }

      if (columnMapping.paymentReference) {
        const refVal = row[columnMapping.paymentReference]?.trim();
        if (refVal) payment.paymentReference = refVal;
      }

      if (columnMapping.paymentMiles) {
        const milesStr = row[columnMapping.paymentMiles]?.trim();
        if (milesStr) {
          const milesVal = parseFloat(milesStr.replace(/[^0-9.\-]/g, ''));
          if (!isNaN(milesVal) && milesVal > 0) payment.paymentMiles = milesVal;
        }
      }

      payments.push(payment);
    });

    return { parsedPayments: payments, validationErrors: errors, zeroAmountCount: zeroes };
  }, [csvData, columnMapping]);

  const canProceedToMapping = file && csvHeaders.length > 0 && csvData.length > 0;
  const canProceedToReview = !!columnMapping.matchKey && !!columnMapping.paidAmount;

  const CHUNK_SIZE = 25;

  const handleImport = useCallback(async () => {
    if (parsedPayments.length === 0) return;

    setIsProcessing(true);
    setStep('processing');
    setProgress({ processed: 0, total: parsedPayments.length });

    const totals: ImportResults = {
      success: 0,
      failed: 0,
      alreadyPaid: 0,
      notFound: [],
      noInvoice: [],
      discrepancies: [],
    };

    try {
      for (let i = 0; i < parsedPayments.length; i += CHUNK_SIZE) {
        const chunk = parsedPayments.slice(i, i + CHUNK_SIZE);
        const chunkLookup = new Map(chunk.map((p) => [p.matchKey.trim(), p]));

        const result = await confirmPaymentChunk({
          workosOrgId,
          matchType,
          payments: chunk,
        });

        totals.success += result.success;
        totals.failed += result.failed;
        totals.alreadyPaid += result.alreadyPaid ?? 0;
        for (const key of result.notFound) {
          const orig = chunkLookup.get(key);
          totals.notFound.push({
            matchKey: key,
            paidAmount: orig?.paidAmount ?? 0,
            paymentDate: orig?.paymentDate,
            paymentReference: orig?.paymentReference,
          });
        }
        for (const key of (result.noInvoice ?? [])) {
          const orig = chunkLookup.get(key);
          totals.noInvoice.push({
            matchKey: key,
            paidAmount: orig?.paidAmount ?? 0,
            paymentDate: orig?.paymentDate,
            paymentReference: orig?.paymentReference,
          });
        }
        totals.discrepancies.push(...result.discrepancies);

        setProgress({ processed: Math.min(i + CHUNK_SIZE, parsedPayments.length), total: parsedPayments.length });
      }

      setImportResults(totals);
      setStep('results');

      if (totals.success > 0) {
        toast.success(
          `${totals.success} payment${totals.success === 1 ? '' : 's'} confirmed`
        );
      }
      if (totals.alreadyPaid > 0) {
        toast.info(`${totals.alreadyPaid} invoice(s) already paid — skipped`);
      }
      if (totals.notFound.length > 0) {
        toast.warning(`${totals.notFound.length} load(s) not found in system`);
      }
      if (totals.noInvoice.length > 0) {
        toast.warning(`${totals.noInvoice.length} load(s) found but have no invoice`);
      }
    } catch (error) {
      toast.error('Failed to process payments');
      console.error(error);
      if (totals.success > 0) {
        setImportResults(totals);
        setStep('results');
      }
    } finally {
      setIsProcessing(false);
    }
  }, [parsedPayments, confirmPaymentChunk, workosOrgId, matchType]);

  return (
    <>
    <Dialog open={open} onOpenChange={handleClose}>
      <DialogContent className="max-w-3xl max-h-[85vh] flex flex-col overflow-hidden">
        <DialogHeader>
          <DialogTitle>Import Payment Confirmations</DialogTitle>
          <DialogDescription>
            {step === 'upload' &&
              'Upload any CSV file with payment data. We\'ll auto-detect the columns in the next step.'}
            {step === 'mapping' && 'Verify the column mapping and adjust if needed.'}
            {step === 'review' && 'Review parsed payments before importing.'}
            {step === 'processing' && 'Processing payments...'}
            {step === 'results' && 'Import complete. Review the results below.'}
          </DialogDescription>
        </DialogHeader>

        <div className="flex-1 overflow-y-auto min-h-0">
        {/* Step 1: Upload */}
        {step === 'upload' && (
          <div className="space-y-5">
            <div className="border-2 border-dashed rounded-lg p-8">
              <div className="flex flex-col items-center gap-2 text-center">
                <Upload className="h-8 w-8 text-muted-foreground" />
                <div>
                  <label htmlFor="payment-csv-file" className="cursor-pointer">
                    <span className="text-sm font-medium text-blue-600 hover:text-blue-500">
                      Choose a CSV file
                    </span>
                    <input
                      id="payment-csv-file"
                      type="file"
                      accept=".csv"
                      className="hidden"
                      onChange={handleFileChange}
                    />
                  </label>
                  <p className="text-xs text-muted-foreground mt-1">
                    Upload any CSV with payment data — we&apos;ll auto-detect the columns
                  </p>
                </div>
                {file && (
                  <div className="text-sm text-foreground font-medium mt-2">
                    <FileSpreadsheet className="inline h-4 w-4 mr-1" />
                    {file.name} ({csvData.length} rows)
                  </div>
                )}
              </div>
            </div>

            {file && csvHeaders.length > 0 && (
              <div className="p-3 bg-muted/50 border rounded-lg">
                <p className="text-xs font-medium text-muted-foreground mb-1.5">
                  {csvHeaders.length} columns detected
                </p>
                <div className="flex flex-wrap gap-1.5">
                  {csvHeaders.map((h) => {
                    const isMapped = AUTO_MATCH_PATTERNS.has(normalizeHeader(h));
                    return (
                      <span
                        key={h}
                        className={cn(
                          'inline-block px-2 py-0.5 text-xs font-mono rounded',
                          isMapped
                            ? 'bg-blue-50 border border-blue-200 text-blue-800 dark:bg-blue-950/40 dark:border-blue-900 dark:text-blue-300'
                            : 'bg-background border'
                        )}
                      >
                        {h}
                      </span>
                    );
                  })}
                </div>
                {Object.values(columnMapping).some(Boolean) && (
                  <p className="text-xs text-muted-foreground mt-2">
                    <span className="inline-block w-2 h-2 rounded-sm bg-blue-200 dark:bg-blue-800 mr-1 align-middle" />
                    Highlighted columns were auto-matched to payment fields
                  </p>
                )}
              </div>
            )}
          </div>
        )}

        {/* Step 2: Column Mapping */}
        {step === 'mapping' && (
          <div className="space-y-5">
            {/* Auto-detected banner */}
            {columnMapping.matchKey && columnMapping.paidAmount && (
              <div className="p-3 bg-green-50 border border-green-200 rounded-lg dark:bg-green-950/30 dark:border-green-900">
                <div className="flex items-start gap-2">
                  <CheckCircle2 className="h-4 w-4 text-green-600 mt-0.5" />
                  <p className="text-sm text-green-800 dark:text-green-200">
                    Columns auto-detected. Verify the mapping below or adjust as needed.
                  </p>
                </div>
              </div>
            )}

            {/* Match type */}
            <div className="space-y-2">
              <Label className="text-sm font-medium">Match invoices by</Label>
              <RadioGroup
                value={matchType}
                onValueChange={(v) => setMatchType(v as MatchType)}
                className="flex gap-6"
              >
                <div className="flex items-center space-x-2">
                  <RadioGroupItem value="invoiceNumber" id="match-invoice" />
                  <Label htmlFor="match-invoice" className="font-normal cursor-pointer">
                    Invoice Number
                  </Label>
                </div>
                <div className="flex items-center space-x-2">
                  <RadioGroupItem value="orderNumber" id="match-order" />
                  <Label htmlFor="match-order" className="font-normal cursor-pointer">
                    Order Number
                  </Label>
                </div>
              </RadioGroup>
            </div>

            {/* Column selectors */}
            <div className="grid grid-cols-2 gap-4">
              <div className="space-y-2">
                <Label className="text-sm font-medium">
                  {matchType === 'invoiceNumber' ? 'Invoice Number' : 'Order Number'}{' '}
                  column <span className="text-red-500">*</span>
                </Label>
                <Select
                  value={columnMapping.matchKey ?? ''}
                  onValueChange={(v) =>
                    setColumnMapping((prev) => ({ ...prev, matchKey: v || null }))
                  }
                >
                  <SelectTrigger>
                    <SelectValue placeholder="Select column..." />
                  </SelectTrigger>
                  <SelectContent>
                    {csvHeaders.map((h) => (
                      <SelectItem key={h} value={h}>
                        {h}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>

              <div className="space-y-2">
                <Label className="text-sm font-medium">
                  Paid Amount column <span className="text-red-500">*</span>
                </Label>
                <Select
                  value={columnMapping.paidAmount ?? ''}
                  onValueChange={(v) =>
                    setColumnMapping((prev) => ({ ...prev, paidAmount: v || null }))
                  }
                >
                  <SelectTrigger>
                    <SelectValue placeholder="Select column..." />
                  </SelectTrigger>
                  <SelectContent>
                    {csvHeaders.map((h) => (
                      <SelectItem key={h} value={h}>
                        {h}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>

              <div className="space-y-2">
                <Label className="text-sm font-medium text-muted-foreground">
                  Payment Date column
                </Label>
                <Select
                  value={columnMapping.paymentDate ?? '__none__'}
                  onValueChange={(v) =>
                    setColumnMapping((prev) => ({
                      ...prev,
                      paymentDate: v === '__none__' ? null : v,
                    }))
                  }
                >
                  <SelectTrigger>
                    <SelectValue placeholder="None" />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="__none__">None</SelectItem>
                    {csvHeaders.map((h) => (
                      <SelectItem key={h} value={h}>
                        {h}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>

              <div className="space-y-2">
                <Label className="text-sm font-medium text-muted-foreground">
                  Payment Reference column
                </Label>
                <Select
                  value={columnMapping.paymentReference ?? '__none__'}
                  onValueChange={(v) =>
                    setColumnMapping((prev) => ({
                      ...prev,
                      paymentReference: v === '__none__' ? null : v,
                    }))
                  }
                >
                  <SelectTrigger>
                    <SelectValue placeholder="None" />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="__none__">None</SelectItem>
                    {csvHeaders.map((h) => (
                      <SelectItem key={h} value={h}>
                        {h}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>

              <div className="space-y-2">
                <Label className="text-sm font-medium text-muted-foreground">
                  Miles column <span className="text-xs">(optional)</span>
                </Label>
                <Select
                  value={columnMapping.paymentMiles ?? '__none__'}
                  onValueChange={(v) =>
                    setColumnMapping((prev) => ({
                      ...prev,
                      paymentMiles: v === '__none__' ? null : v,
                    }))
                  }
                >
                  <SelectTrigger>
                    <SelectValue placeholder="None" />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="__none__">None</SelectItem>
                    {csvHeaders.map((h) => (
                      <SelectItem key={h} value={h}>
                        {h}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
            </div>

            {/* Live preview */}
            {csvData.length > 0 && columnMapping.matchKey && columnMapping.paidAmount && (
              <div className="rounded-md border overflow-hidden">
                <p className="text-xs text-muted-foreground px-3 py-2 bg-muted/50">
                  Preview (first 5 rows)
                </p>
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead>
                        {matchType === 'invoiceNumber'
                          ? 'Invoice #'
                          : 'Order #'}
                      </TableHead>
                      <TableHead className="text-right">Paid Amount</TableHead>
                      {columnMapping.paymentDate && <TableHead>Date</TableHead>}
                      {columnMapping.paymentReference && (
                        <TableHead>Reference</TableHead>
                      )}
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {csvData.slice(0, 5).map((row, idx) => (
                      <TableRow key={idx}>
                        <TableCell className="font-mono text-sm">
                          {row[columnMapping.matchKey!] || '—'}
                        </TableCell>
                        <TableCell className="text-right font-mono text-sm">
                          {row[columnMapping.paidAmount!] || '—'}
                        </TableCell>
                        {columnMapping.paymentDate && (
                          <TableCell className="text-sm">
                            {row[columnMapping.paymentDate] || '—'}
                          </TableCell>
                        )}
                        {columnMapping.paymentReference && (
                          <TableCell className="text-sm">
                            {row[columnMapping.paymentReference] || '—'}
                          </TableCell>
                        )}
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              </div>
            )}
          </div>
        )}

        {/* Step 3: Review & Confirm */}
        {step === 'review' && (
          <div className="space-y-4">
            {parsedPayments.length === 0 && validationErrors.length === 0 && (
              <div className="p-4 bg-amber-50 border border-amber-200 rounded-lg dark:bg-amber-950/30 dark:border-amber-900">
                <div className="flex items-start gap-2">
                  <AlertTriangle className="h-4 w-4 text-amber-600 mt-0.5" />
                  <div>
                    <p className="text-sm font-medium text-amber-900 dark:text-amber-200">
                      No payments could be parsed
                    </p>
                    <p className="text-xs text-amber-700 dark:text-amber-400 mt-0.5">
                      Go back and verify the column mapping matches your CSV data.
                    </p>
                  </div>
                </div>
              </div>
            )}

            <div className="flex gap-3">
              {parsedPayments.length > 0 && (
                <div className="flex-1 p-3 bg-green-50 border border-green-200 rounded-lg dark:bg-green-950/30 dark:border-green-900">
                  <div className="flex items-start gap-2">
                    <CheckCircle2 className="h-4 w-4 text-green-600 mt-0.5" />
                    <div>
                      <p className="text-sm font-medium text-green-900 dark:text-green-200">
                        {parsedPayments.length} payment{parsedPayments.length === 1 ? '' : 's'}{' '}
                        ready to process
                      </p>
                      <p className="text-xs text-green-700 dark:text-green-400 mt-0.5">
                        Total:{' '}
                        {formatCurrency(
                          parsedPayments.reduce((sum, p) => sum + p.paidAmount, 0)
                        )}
                      </p>
                    </div>
                  </div>
                </div>
              )}

              {(validationErrors.length > 0 || zeroAmountCount > 0) && (
                <div className="flex-1 p-3 bg-muted/50 border rounded-lg">
                  <div className="flex items-start gap-2">
                    <AlertCircle className="h-4 w-4 text-muted-foreground mt-0.5" />
                    <div className="space-y-1">
                      {zeroAmountCount > 0 && (
                        <p className="text-sm text-muted-foreground">
                          {zeroAmountCount.toLocaleString()} row{zeroAmountCount === 1 ? '' : 's'}{' '}
                          skipped ($0.00 paid)
                        </p>
                      )}
                      {validationErrors.length > 0 && (
                        <>
                          <p className="text-sm text-muted-foreground">
                            {validationErrors.length} row{validationErrors.length === 1 ? '' : 's'}{' '}
                            skipped (invalid data)
                          </p>
                          <ul className="text-xs text-muted-foreground mt-1 list-disc list-inside max-h-20 overflow-y-auto">
                            {validationErrors.slice(0, 5).map((err, idx) => (
                              <li key={idx}>
                                Row {err.row}: {err.message}
                              </li>
                            ))}
                            {validationErrors.length > 5 && (
                              <li>... and {validationErrors.length - 5} more</li>
                            )}
                          </ul>
                        </>
                      )}
                    </div>
                  </div>
                </div>
              )}
            </div>

            <div className="rounded-md border overflow-hidden max-h-64 overflow-y-auto">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>
                      {matchType === 'invoiceNumber' ? 'Invoice #' : 'Order #'}
                    </TableHead>
                    <TableHead className="text-right">Paid Amount</TableHead>
                    {parsedPayments.some((p) => p.paymentDate) && (
                      <TableHead>Date</TableHead>
                    )}
                    {parsedPayments.some((p) => p.paymentReference) && (
                      <TableHead>Reference</TableHead>
                    )}
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {parsedPayments.map((payment, idx) => (
                    <TableRow key={idx}>
                      <TableCell className="font-mono text-sm">
                        {payment.matchKey}
                      </TableCell>
                      <TableCell className="text-right font-mono text-sm">
                        {formatCurrency(payment.paidAmount)}
                      </TableCell>
                      {parsedPayments.some((p) => p.paymentDate) && (
                        <TableCell className="text-sm">
                          {payment.paymentDate || '—'}
                        </TableCell>
                      )}
                      {parsedPayments.some((p) => p.paymentReference) && (
                        <TableCell className="text-sm">
                          {payment.paymentReference || '—'}
                        </TableCell>
                      )}
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </div>
          </div>
        )}

        {/* Step 4: Processing */}
        {step === 'processing' && (
          <div className="space-y-6 py-8">
            <div className="text-center space-y-2">
              <p className="text-sm font-medium">
                Processing {progress.processed.toLocaleString()} of{' '}
                {progress.total.toLocaleString()} payments...
              </p>
              <Progress
                value={progress.total > 0 ? (progress.processed / progress.total) * 100 : 0}
                className="h-2"
              />
              <p className="text-xs text-muted-foreground">
                {Math.round(
                  progress.total > 0 ? (progress.processed / progress.total) * 100 : 0
                )}
                % complete
              </p>
            </div>
          </div>
        )}

        {/* Step 5: Results */}
        {step === 'results' && importResults && (
          <div className="space-y-4">
            {/* Summary cards */}
            <div className="grid grid-cols-2 sm:grid-cols-3 gap-3">
              <div className="p-3 rounded-lg bg-green-50 border border-green-200 dark:bg-green-950/30 dark:border-green-900">
                <p className="text-2xl font-bold text-green-700 dark:text-green-300">
                  {importResults.success}
                </p>
                <p className="text-xs text-green-600 dark:text-green-400">Confirmed</p>
              </div>
              <div className="p-3 rounded-lg bg-amber-50 border border-amber-200 dark:bg-amber-950/30 dark:border-amber-900">
                <p className="text-2xl font-bold text-amber-700 dark:text-amber-300">
                  {importResults.discrepancies.length}
                </p>
                <p className="text-xs text-amber-600 dark:text-amber-400">
                  Discrepancy
                </p>
              </div>
              {importResults.alreadyPaid > 0 && (
                <div className="p-3 rounded-lg bg-blue-50 border border-blue-200 dark:bg-blue-950/30 dark:border-blue-900">
                  <p className="text-2xl font-bold text-blue-700 dark:text-blue-300">
                    {importResults.alreadyPaid}
                  </p>
                  <p className="text-xs text-blue-600 dark:text-blue-400">Already Paid</p>
                </div>
              )}
              <div className="p-3 rounded-lg bg-red-50 border border-red-200 dark:bg-red-950/30 dark:border-red-900">
                <p className="text-2xl font-bold text-red-700 dark:text-red-300">
                  {importResults.notFound.length}
                </p>
                <p className="text-xs text-red-600 dark:text-red-400">Load Not Found</p>
              </div>
              <div className="p-3 rounded-lg bg-orange-50 border border-orange-200 dark:bg-orange-950/30 dark:border-orange-900">
                <p className="text-2xl font-bold text-orange-700 dark:text-orange-300">
                  {importResults.noInvoice.length}
                </p>
                <p className="text-xs text-orange-600 dark:text-orange-400">No Invoice</p>
              </div>
            </div>

            {/* Discrepancies table */}
            {importResults.discrepancies.length > 0 && (
              <div className="space-y-2">
                <div className="flex items-center gap-2">
                  <AlertTriangle className="h-4 w-4 text-amber-600" />
                  <p className="text-sm font-medium">Payment Discrepancies</p>
                </div>
                <div className="rounded-md border overflow-hidden max-h-48 overflow-y-auto">
                  <Table>
                    <TableHeader>
                      <TableRow>
                        <TableHead>
                          {matchType === 'invoiceNumber' ? 'Invoice #' : 'Order #'}
                        </TableHead>
                        <TableHead className="text-right">Invoiced</TableHead>
                        <TableHead className="text-right">Paid</TableHead>
                        <TableHead className="text-right">Difference</TableHead>
                      </TableRow>
                    </TableHeader>
                    <TableBody>
                      {importResults.discrepancies.map((d, idx) => (
                        <TableRow key={idx}>
                          <TableCell className="font-mono text-sm">
                            {d.matchKey}
                          </TableCell>
                          <TableCell className="text-right font-mono text-sm">
                            {formatCurrency(d.invoicedAmount)}
                          </TableCell>
                          <TableCell className="text-right font-mono text-sm">
                            {formatCurrency(d.paidAmount)}
                          </TableCell>
                          <TableCell className="text-right">
                            <span
                              className={cn(
                                'inline-flex items-center gap-1 font-mono text-sm font-medium',
                                d.difference > 0
                                  ? 'text-amber-600'
                                  : 'text-red-600'
                              )}
                            >
                              {d.difference > 0 ? (
                                <TrendingUp className="h-3 w-3" />
                              ) : (
                                <TrendingDown className="h-3 w-3" />
                              )}
                              {formatCurrency(d.difference)}
                            </span>
                          </TableCell>
                        </TableRow>
                      ))}
                    </TableBody>
                  </Table>
                </div>
              </div>
            )}

            {/* Compact rows for not-found / no-invoice — click to open detail modal */}
            {importResults.notFound.length > 0 && (
              <button
                type="button"
                onClick={() => setDetailModal({ type: 'notFound', title: `Loads Not Found (${importResults.notFound.length})` })}
                className="w-full flex items-center justify-between p-3 rounded-lg border border-red-200 bg-red-50 hover:bg-red-100 dark:bg-red-950/30 dark:border-red-900 dark:hover:bg-red-950/50 transition-colors text-left"
              >
                <div className="flex items-center gap-2">
                  <AlertCircle className="h-4 w-4 text-red-600 flex-shrink-0" />
                  <div>
                    <p className="text-sm font-medium text-red-800 dark:text-red-200">
                      {importResults.notFound.length} Loads Not Found
                    </p>
                    <p className="text-xs text-red-600 dark:text-red-400">
                      No matching load in the system — click to review
                    </p>
                  </div>
                </div>
                <ArrowRight className="h-4 w-4 text-red-400" />
              </button>
            )}

            {importResults.noInvoice.length > 0 && (
              <button
                type="button"
                onClick={() => setDetailModal({ type: 'noInvoice', title: `Load Found, No Invoice (${importResults.noInvoice.length})` })}
                className="w-full flex items-center justify-between p-3 rounded-lg border border-orange-200 bg-orange-50 hover:bg-orange-100 dark:bg-orange-950/30 dark:border-orange-900 dark:hover:bg-orange-950/50 transition-colors text-left"
              >
                <div className="flex items-center gap-2">
                  <AlertCircle className="h-4 w-4 text-orange-600 flex-shrink-0" />
                  <div>
                    <p className="text-sm font-medium text-orange-800 dark:text-orange-200">
                      {importResults.noInvoice.length} Loads — No Invoice
                    </p>
                    <p className="text-xs text-orange-600 dark:text-orange-400">
                      Load exists but has no invoice record — click to review
                    </p>
                  </div>
                </div>
                <ArrowRight className="h-4 w-4 text-orange-400" />
              </button>
            )}
          </div>
        )}
        </div>

        {step !== 'processing' && (
        <DialogFooter className="flex-shrink-0 flex items-center justify-between sm:justify-between border-t pt-4">
          <div>
            {step === 'mapping' && (
              <Button variant="ghost" size="sm" onClick={() => setStep('upload')}>
                <ArrowLeft className="mr-2 h-4 w-4" />
                Back
              </Button>
            )}
            {step === 'review' && (
              <Button variant="ghost" size="sm" onClick={() => setStep('mapping')}>
                <ArrowLeft className="mr-2 h-4 w-4" />
                Back
              </Button>
            )}
          </div>

          <div className="flex gap-2">
            {step === 'results' ? (
              <Button onClick={() => handleClose(false)}>Done</Button>
            ) : (
              <>
                <Button
                  variant="outline"
                  onClick={() => handleClose(false)}
                  disabled={isProcessing}
                >
                  Cancel
                </Button>

                {step === 'upload' && (
                  <Button
                    onClick={() => setStep('mapping')}
                    disabled={!canProceedToMapping}
                  >
                    Next
                    <ArrowRight className="ml-2 h-4 w-4" />
                  </Button>
                )}

                {step === 'mapping' && (
                  <Button
                    onClick={() => setStep('review')}
                    disabled={!canProceedToReview}
                  >
                    Review
                    <ArrowRight className="ml-2 h-4 w-4" />
                  </Button>
                )}

                {step === 'review' && (
                  <Button
                    onClick={handleImport}
                    disabled={parsedPayments.length === 0 || isProcessing}
                  >
                    {isProcessing
                      ? 'Processing...'
                      : `Confirm ${parsedPayments.length} Payment${parsedPayments.length === 1 ? '' : 's'}`}
                  </Button>
                )}
              </>
            )}
          </div>
        </DialogFooter>
        )}
      </DialogContent>
    </Dialog>

    {/* Detail modal — full-width table for not-found / no-invoice items */}
    <NotFoundDetailModal
      open={!!detailModal}
      onClose={() => setDetailModal(null)}
      title={detailModal?.title ?? ''}
      items={
        detailModal?.type === 'notFound'
          ? importResults?.notFound ?? []
          : detailModal?.type === 'noInvoice'
            ? importResults?.noInvoice ?? []
            : []
      }
      matchLabel={matchType === 'invoiceNumber' ? 'Invoice #' : 'Order #'}
      exportFilename={
        detailModal?.type === 'notFound' ? 'loads-not-found' : 'loads-no-invoice'
      }
    />
    </>
  );
}

/* ─────────────────────────────────────────────────────────────────────────────
 * Full-screen detail modal for reviewing not-found / no-invoice items
 * ───────────────────────────────────────────────────────────────────────────── */

function NotFoundDetailModal({
  open,
  onClose,
  title,
  items,
  matchLabel,
  exportFilename,
}: {
  open: boolean;
  onClose: () => void;
  title: string;
  items: NotFoundItem[];
  matchLabel: string;
  exportFilename: string;
}) {
  const [search, setSearch] = useState('');

  const filtered = useMemo(() => {
    if (!search.trim()) return items;
    const q = search.toLowerCase().trim();
    return items.filter(
      (item) =>
        item.matchKey.toLowerCase().includes(q) ||
        item.paymentReference?.toLowerCase().includes(q) ||
        item.paymentDate?.toLowerCase().includes(q) ||
        String(item.paidAmount).includes(q)
    );
  }, [items, search]);

  const totalAmount = useMemo(
    () => filtered.reduce((sum, item) => sum + item.paidAmount, 0),
    [filtered]
  );

  return (
    <Dialog open={open} onOpenChange={(v) => !v && onClose()}>
      <DialogContent className="w-[calc(100vw-3rem)] max-w-[calc(100vw-3rem)] h-[calc(100vh-3rem)] flex flex-col p-0 gap-0">
        <DialogHeader className="flex-shrink-0 px-6 pt-6 pb-4 border-b">
          <div className="flex items-center justify-between">
            <div>
              <DialogTitle className="text-lg">{title}</DialogTitle>
              <DialogDescription className="mt-1">
                {filtered.length === items.length
                  ? `${items.length} items — Total: ${formatCurrency(totalAmount)}`
                  : `Showing ${filtered.length} of ${items.length} items — Filtered Total: ${formatCurrency(totalAmount)}`}
              </DialogDescription>
            </div>
            <div className="flex items-center gap-2">
              <Button
                variant="outline"
                size="sm"
                onClick={() => exportNotFoundCsv(filtered, exportFilename)}
              >
                <Download className="mr-1.5 h-3.5 w-3.5" />
                Export CSV
              </Button>
            </div>
          </div>
          <div className="relative mt-3">
            <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
            <Input
              placeholder="Search by order #, reference, amount..."
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              className="pl-9 pr-9"
            />
            {search && (
              <button
                type="button"
                onClick={() => setSearch('')}
                className="absolute right-3 top-1/2 -translate-y-1/2 text-muted-foreground hover:text-foreground"
              >
                <X className="h-4 w-4" />
              </button>
            )}
          </div>
        </DialogHeader>

        <div className="flex-1 overflow-auto">
          <Table>
            <TableHeader className="sticky top-0 bg-background z-10">
              <TableRow>
                <TableHead className="w-16 pl-6">#</TableHead>
                <TableHead>{matchLabel}</TableHead>
                <TableHead className="text-right">Paid Amount</TableHead>
                <TableHead>Payment Date</TableHead>
                <TableHead className="pr-6">Reference</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {filtered.length === 0 ? (
                <TableRow>
                  <TableCell colSpan={5} className="text-center py-12 text-muted-foreground">
                    {search ? 'No items match your search' : 'No items'}
                  </TableCell>
                </TableRow>
              ) : (
                filtered.map((item, idx) => (
                  <TableRow key={idx} className="hover:bg-muted/50">
                    <TableCell className="text-xs text-muted-foreground pl-6 tabular-nums">
                      {idx + 1}
                    </TableCell>
                    <TableCell className="font-mono text-sm font-medium">
                      {item.matchKey}
                    </TableCell>
                    <TableCell className="text-right font-mono text-sm tabular-nums">
                      {formatCurrency(item.paidAmount)}
                    </TableCell>
                    <TableCell className="text-sm text-muted-foreground">
                      {item.paymentDate || '—'}
                    </TableCell>
                    <TableCell className="text-sm text-muted-foreground pr-6">
                      {item.paymentReference || '—'}
                    </TableCell>
                  </TableRow>
                ))
              )}
            </TableBody>
          </Table>
        </div>

        <div className="flex-shrink-0 border-t px-6 py-4 flex justify-end">
          <Button onClick={onClose}>Close</Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}
