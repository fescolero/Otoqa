'use client';

import { useState, useMemo, useCallback } from 'react';
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
} from 'lucide-react';
import { toast } from 'sonner';
import { cn } from '@/lib/utils';

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
}

interface ParsedPayment {
  matchKey: string;
  paidAmount: number;
  paymentDate?: string;
  paymentReference?: string;
}

interface ValidationError {
  row: number;
  message: string;
}

interface ImportResults {
  success: number;
  failed: number;
  notFound: string[];
  discrepancies: Array<{
    matchKey: string;
    invoicedAmount: number;
    paidAmount: number;
    difference: number;
  }>;
}

type Step = 'upload' | 'mapping' | 'review' | 'results';

const AUTO_MATCH_MAP: Record<string, keyof ColumnMapping> = {
  invoicenumber: 'matchKey',
  invoice_number: 'matchKey',
  invoice: 'matchKey',
  ordernumber: 'matchKey',
  order_number: 'matchKey',
  order: 'matchKey',
  paidamount: 'paidAmount',
  paid_amount: 'paidAmount',
  amount: 'paidAmount',
  amountpaid: 'paidAmount',
  amount_paid: 'paidAmount',
  payment: 'paidAmount',
  paymentdate: 'paymentDate',
  payment_date: 'paymentDate',
  date: 'paymentDate',
  paiddate: 'paymentDate',
  paid_date: 'paymentDate',
  paymentreference: 'paymentReference',
  payment_reference: 'paymentReference',
  reference: 'paymentReference',
  ref: 'paymentReference',
  checknumber: 'paymentReference',
  check_number: 'paymentReference',
  wirenumber: 'paymentReference',
};

function formatCurrency(amount: number): string {
  return new Intl.NumberFormat('en-US', {
    style: 'currency',
    currency: 'USD',
  }).format(amount);
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
  });
  const [isProcessing, setIsProcessing] = useState(false);
  const [importResults, setImportResults] = useState<ImportResults | null>(null);

  const confirmPaymentBatch = useMutation(api.invoices.confirmPaymentBatch);

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
    });
    setIsProcessing(false);
    setImportResults(null);
  }, []);

  const handleClose = useCallback(
    (open: boolean) => {
      if (!open) resetState();
      onOpenChange(open);
    },
    [onOpenChange, resetState]
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
        const text = await selectedFile.text();
        const lines = text.split('\n').filter((line) => line.trim());
        if (lines.length < 2) {
          toast.error('CSV file is empty or has no data rows');
          return;
        }

        const headers = lines[0].split(',').map((h) => h.trim());
        const rows: Record<string, string>[] = [];

        for (let i = 1; i < lines.length; i++) {
          const values = lines[i].split(',').map((v) => v.trim());
          if (values.length !== headers.length) continue;

          const row: Record<string, string> = {};
          headers.forEach((col, idx) => {
            row[col] = values[idx];
          });
          rows.push(row);
        }

        setFile(selectedFile);
        setCsvHeaders(headers);
        setCsvData(rows);

        // Auto-detect column mappings
        const autoMapping: ColumnMapping = {
          matchKey: null,
          paidAmount: null,
          paymentDate: null,
          paymentReference: null,
        };

        const ORDER_KEYWORDS = ['ordernumber', 'order_number', 'order'];
        const INVOICE_KEYWORDS = ['invoicenumber', 'invoice_number', 'invoice'];
        let detectedMatchType: MatchType | null = null;

        for (const header of headers) {
          const normalized = header.toLowerCase().replace(/[\s\-]/g, '');
          const field = AUTO_MATCH_MAP[normalized];
          if (field && !autoMapping[field]) {
            autoMapping[field] = header;
          }
          if (field === 'matchKey') {
            if (ORDER_KEYWORDS.includes(normalized)) {
              detectedMatchType = 'orderNumber';
            } else if (INVOICE_KEYWORDS.includes(normalized)) {
              detectedMatchType = 'invoiceNumber';
            }
          }
        }

        if (detectedMatchType) {
          setMatchType(detectedMatchType);
        }

        setColumnMapping(autoMapping);
      } catch {
        toast.error('Failed to parse CSV file');
      }
    },
    []
  );

  const { parsedPayments, validationErrors } = useMemo(() => {
    const payments: ParsedPayment[] = [];
    const errors: ValidationError[] = [];

    if (!columnMapping.matchKey || !columnMapping.paidAmount) {
      return { parsedPayments: payments, validationErrors: errors };
    }

    csvData.forEach((row, idx) => {
      const rowNum = idx + 2; // 1-indexed + header row
      const matchKey = row[columnMapping.matchKey!]?.trim();
      const amountStr = row[columnMapping.paidAmount!]?.trim();

      if (!matchKey) {
        errors.push({ row: rowNum, message: 'Missing match key' });
        return;
      }

      const paidAmount = parseFloat(amountStr?.replace(/[$,]/g, '') ?? '');
      if (isNaN(paidAmount) || paidAmount < 0) {
        errors.push({
          row: rowNum,
          message: `Invalid amount "${amountStr}" for ${matchKey}`,
        });
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

      payments.push(payment);
    });

    return { parsedPayments: payments, validationErrors: errors };
  }, [csvData, columnMapping]);

  const canProceedToMapping = file && csvHeaders.length > 0 && csvData.length > 0;
  const canProceedToReview =
    columnMapping.matchKey && columnMapping.paidAmount && parsedPayments.length > 0;

  const handleImport = useCallback(async () => {
    if (parsedPayments.length === 0) return;

    setIsProcessing(true);
    try {
      const result = await confirmPaymentBatch({
        workosOrgId,
        updatedBy: userId,
        matchType,
        payments: parsedPayments,
      });

      setImportResults(result);
      setStep('results');

      if (result.success > 0) {
        toast.success(
          `${result.success} payment${result.success === 1 ? '' : 's'} confirmed`
        );
      }
      if (result.notFound.length > 0) {
        toast.warning(`${result.notFound.length} invoice(s) not found`);
      }
    } catch (error) {
      toast.error('Failed to process payments');
      console.error(error);
    } finally {
      setIsProcessing(false);
    }
  }, [parsedPayments, confirmPaymentBatch, workosOrgId, userId, matchType]);

  return (
    <Dialog open={open} onOpenChange={handleClose}>
      <DialogContent className="max-w-3xl max-h-[85vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle>Import Payment Confirmations</DialogTitle>
          <DialogDescription>
            {step === 'upload' &&
              'Upload any CSV file with payment data. We\'ll auto-detect the columns in the next step.'}
            {step === 'mapping' && 'Verify the column mapping and adjust if needed.'}
            {step === 'review' && 'Review parsed payments before importing.'}
            {step === 'results' && 'Import complete. Review the results below.'}
          </DialogDescription>
        </DialogHeader>

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
                  Detected columns
                </p>
                <div className="flex flex-wrap gap-1.5">
                  {csvHeaders.map((h) => (
                    <span
                      key={h}
                      className="inline-block px-2 py-0.5 text-xs font-mono bg-background border rounded"
                    >
                      {h}
                    </span>
                  ))}
                </div>
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

              {validationErrors.length > 0 && (
                <div className="flex-1 p-3 bg-red-50 border border-red-200 rounded-lg dark:bg-red-950/30 dark:border-red-900">
                  <div className="flex items-start gap-2">
                    <AlertCircle className="h-4 w-4 text-red-600 mt-0.5" />
                    <div>
                      <p className="text-sm font-medium text-red-900 dark:text-red-200">
                        {validationErrors.length} row{validationErrors.length === 1 ? '' : 's'}{' '}
                        skipped
                      </p>
                      <ul className="text-xs text-red-700 dark:text-red-400 mt-1 list-disc list-inside max-h-20 overflow-y-auto">
                        {validationErrors.slice(0, 5).map((err, idx) => (
                          <li key={idx}>
                            Row {err.row}: {err.message}
                          </li>
                        ))}
                        {validationErrors.length > 5 && (
                          <li>... and {validationErrors.length - 5} more</li>
                        )}
                      </ul>
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

        {/* Step 4: Results */}
        {step === 'results' && importResults && (
          <div className="space-y-4">
            {/* Summary cards */}
            <div className="grid grid-cols-3 gap-3">
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
                  With Discrepancy
                </p>
              </div>
              <div className="p-3 rounded-lg bg-red-50 border border-red-200 dark:bg-red-950/30 dark:border-red-900">
                <p className="text-2xl font-bold text-red-700 dark:text-red-300">
                  {importResults.notFound.length}
                </p>
                <p className="text-xs text-red-600 dark:text-red-400">Not Found</p>
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

            {/* Not found list */}
            {importResults.notFound.length > 0 && (
              <div className="space-y-2">
                <div className="flex items-center gap-2">
                  <AlertCircle className="h-4 w-4 text-red-600" />
                  <p className="text-sm font-medium">Invoices Not Found</p>
                </div>
                <div className="p-3 bg-red-50 border border-red-200 rounded-lg dark:bg-red-950/30 dark:border-red-900 max-h-32 overflow-y-auto">
                  <div className="flex flex-wrap gap-2">
                    {importResults.notFound.map((key, idx) => (
                      <span
                        key={idx}
                        className="inline-block px-2 py-0.5 text-xs font-mono bg-red-100 text-red-800 rounded dark:bg-red-900 dark:text-red-200"
                      >
                        {key}
                      </span>
                    ))}
                  </div>
                </div>
              </div>
            )}
          </div>
        )}

        <DialogFooter className="flex items-center justify-between sm:justify-between">
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
      </DialogContent>
    </Dialog>
  );
}
