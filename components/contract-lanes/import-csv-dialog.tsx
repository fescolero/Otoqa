'use client';

import { useState } from 'react';
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
import { Id } from '@/convex/_generated/dataModel';

interface ImportCsvDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  customerId: Id<'customers'>;
  workosOrgId: string;
  userId: string;
}

interface ParsedLane {
  hcr: string;
  tripNumber: string;
  contractName?: string;
  rateType: 'Flat Rate' | 'Per Mile' | 'Per Stop';
  rate: number;
  contractPeriodStart?: string;
  contractPeriodEnd?: string;
}

export function ImportCsvDialog({
  open,
  onOpenChange,
  customerId,
  workosOrgId,
  userId,
}: ImportCsvDialogProps) {
  const [file, setFile] = useState<File | null>(null);
  const [isProcessing, setIsProcessing] = useState(false);
  const [preview, setPreview] = useState<ParsedLane[]>([]);
  const [errors, setErrors] = useState<string[]>([]);

  const bulkImportLanes = useMutation(api.contractLanes.bulkImport);

  const handleFileChange = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const selectedFile = e.target.files?.[0];
    if (!selectedFile) return;

    if (!selectedFile.name.endsWith('.csv')) {
      toast.error('Please upload a CSV file');
      return;
    }

    setFile(selectedFile);
    setErrors([]);

    // Parse CSV for preview
    try {
      const text = await selectedFile.text();
      const { lanes, errors: parseErrors } = parseCsv(text);
      setPreview(lanes);
      setErrors(parseErrors);
    } catch (error) {
      toast.error('Failed to parse CSV file');
      console.error(error);
    }
  };

  const parseCsv = (text: string): { lanes: ParsedLane[]; errors: string[] } => {
    const lines = text.split('\n').filter((line) => line.trim());
    if (lines.length < 2) {
      return { lanes: [], errors: ['CSV file is empty or has no data rows'] };
    }

    const header = lines[0].toLowerCase().split(',').map((h) => h.trim());
    const lanes: ParsedLane[] = [];
    const errors: string[] = [];

    // Validate required columns
    const requiredColumns = ['hcr', 'tripnumber', 'ratetype', 'rate'];
    const missingColumns = requiredColumns.filter((col) => !header.includes(col));
    if (missingColumns.length > 0) {
      errors.push(`Missing required columns: ${missingColumns.join(', ')}`);
      return { lanes, errors };
    }

    // Parse data rows
    for (let i = 1; i < lines.length; i++) {
      const values = lines[i].split(',').map((v) => v.trim());
      if (values.length !== header.length) {
        errors.push(`Row ${i + 1}: Column count mismatch`);
        continue;
      }

      const row: Record<string, string> = {};
      header.forEach((col, idx) => {
        row[col] = values[idx];
      });

      // Validate and parse
      if (!row.hcr || !row.tripnumber || !row.ratetype || !row.rate) {
        errors.push(`Row ${i + 1}: Missing required fields`);
        continue;
      }

      const rateType = row.ratetype as 'Flat Rate' | 'Per Mile' | 'Per Stop';
      if (!['Flat Rate', 'Per Mile', 'Per Stop'].includes(rateType)) {
        errors.push(`Row ${i + 1}: Invalid rate type '${row.ratetype}'`);
        continue;
      }

      const rate = parseFloat(row.rate);
      if (isNaN(rate) || rate < 0) {
        errors.push(`Row ${i + 1}: Invalid rate value`);
        continue;
      }

      lanes.push({
        hcr: row.hcr,
        tripNumber: row.tripnumber,
        contractName: row.contractname || `Lane: ${row.hcr}/${row.tripnumber}`,
        rateType,
        rate,
        contractPeriodStart: row.contractperiodstart || undefined,
        contractPeriodEnd: row.contractperiodend || undefined,
      });
    }

    return { lanes, errors };
  };

  const handleImport = async () => {
    if (preview.length === 0) {
      toast.error('No valid lanes to import');
      return;
    }

    setIsProcessing(true);
    try {
      const result = await bulkImportLanes({
        customerId,
        workosOrgId,
        userId,
        lanes: preview,
      });

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
      setPreview([]);
      setErrors([]);
    } catch (error: any) {
      toast.error(error.message || 'Failed to import contract lanes');
    } finally {
      setIsProcessing(false);
    }
  };

  const downloadTemplate = () => {
    const template = `hcr,tripNumber,contractName,rateType,rate,contractPeriodStart,contractPeriodEnd
925L0,210,Lane: Customer A - 210,Per Mile,2.30,2023-01-01,2024-12-31
925L0,246,Lane: Customer A - 246,Flat Rate,1500.00,2023-01-01,2024-12-31`;

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
            Upload a CSV file to bulk import contract lanes. The next FourKites sync will automatically
            match quarantined and SPOT loads against the new lanes. Download the template to see the required
            format.
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
