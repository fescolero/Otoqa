'use client';

import { useState, useCallback } from 'react';
import { Button } from '@/components/ui/button';
import { Upload, FileText, Download, CheckCircle2, AlertCircle, Loader2 } from 'lucide-react';
import { CSVRow } from './csv-import-wizard';

interface ImportStep1UploadProps {
  onFileProcessed: (data: CSVRow[], headers: string[]) => void;
}

export function ImportStep1Upload({ onFileProcessed }: ImportStep1UploadProps) {
  const [isDragging, setIsDragging] = useState(false);
  const [isProcessing, setIsProcessing] = useState(false);
  const [uploadedFile, setUploadedFile] = useState<File | null>(null);
  const [error, setError] = useState<string | null>(null);

  const generateTemplate = () => {
    const headers = [
      'First Name',
      'Middle Name',
      'Last Name',
      'Email',
      'Phone',
      'Date of Birth',
      'SSN',
      'License Number',
      'License State',
      'License Expiration',
      'License Class',
      'Medical Expiration',
      'Badge Expiration',
      'TWIC Expiration',
      'Hire Date',
      'Employment Status',
      'Employment Type',
      'Termination Date',
      'Pre-Employment Check Date',
      'Address',
      'Address Line 2',
      'City',
      'State',
      'ZIP Code',
      'Emergency Contact Name',
      'Emergency Contact Phone',
    ];

    const exampleRow = [
      'Carlos',
      'A',
      'Gonzalez',
      'carlos@example.com',
      '909-213-6870',
      '06/21/2000',
      '***-**-5678',
      'D5211514',
      'CA',
      '12/30/2025',
      'Class C',
      '12/30/2025',
      '12/30/2025',
      '12/30/2025',
      '11/16/2020',
      'Active',
      'Full-time',
      '',
      '10/31/2020',
      '1311 W Maitland St',
      'Apt 201',
      'Ontario',
      'CA',
      '91762',
      'Maria Gonzalez',
      '909-555-0123',
    ];

    const csv = [headers.join(','), exampleRow.join(',')].join('\n');
    const blob = new Blob([csv], { type: 'text/csv' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = 'driver-import-template.csv';
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
  };

  const parseCSV = (text: string): { headers: string[]; data: CSVRow[] } => {
    const lines = text.split('\n').filter((line) => line.trim());
    if (lines.length === 0) throw new Error('File is empty');

    const headers = lines[0].split(',').map((h) => h.trim().replace(/^"|"$/g, ''));
    const data: CSVRow[] = [];

    for (let i = 1; i < lines.length; i++) {
      const values = lines[i].split(',').map((v) => v.trim().replace(/^"|"$/g, ''));
      const row: CSVRow = {};
      headers.forEach((header, index) => {
        row[header] = values[index] || '';
      });
      data.push(row);
    }

    return { headers, data };
  };

  const processFile = useCallback(
    async (file: File) => {
      setIsProcessing(true);
      setError(null);

      try {
        if (!file.name.endsWith('.csv')) {
          throw new Error('Please upload a CSV file');
        }

        const text = await file.text();
        const { headers, data } = parseCSV(text);

        if (data.length === 0) {
          throw new Error('No data rows found in file');
        }

        setUploadedFile(file);
        onFileProcessed(data, headers);
      } catch (err) {
        setError(err instanceof Error ? err.message : 'Failed to process file');
        setUploadedFile(null);
      } finally {
        setIsProcessing(false);
      }
    },
    [onFileProcessed],
  );

  const handleDrop = useCallback(
    (e: React.DragEvent) => {
      e.preventDefault();
      setIsDragging(false);

      const file = e.dataTransfer.files[0];
      if (file) {
        processFile(file);
      }
    },
    [processFile],
  );

  const handleFileInput = useCallback(
    (e: React.ChangeEvent<HTMLInputElement>) => {
      const file = e.target.files?.[0];
      if (file) {
        processFile(file);
      }
    },
    [processFile],
  );

  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="text-center">
        <h2 className="text-xl font-semibold mb-2">Upload Your Driver Data</h2>
        <p className="text-muted-foreground">
          Import multiple drivers at once using a CSV file. Download our template to get started.
        </p>
      </div>

      {/* Template Download Button */}
      <div className="flex justify-center">
        <Button variant="outline" onClick={generateTemplate} className="gap-2">
          <Download className="h-4 w-4" />
          Download CSV Template
        </Button>
      </div>

      {/* Upload Area */}
      {!uploadedFile ? (
        <div
          onDragOver={(e) => {
            e.preventDefault();
            setIsDragging(true);
          }}
          onDragLeave={() => setIsDragging(false)}
          onDrop={handleDrop}
          className={`relative border-2 border-dashed rounded-lg p-12 text-center transition-colors ${
            isDragging
              ? 'border-primary bg-primary/5'
              : error
              ? 'border-red-300 bg-red-50 dark:bg-red-950/20'
              : 'border-gray-300 dark:border-gray-700 hover:border-gray-400'
          }`}
        >
          {isProcessing ? (
            <div className="flex flex-col items-center gap-4">
              <Loader2 className="h-12 w-12 text-primary animate-spin" />
              <p className="text-lg font-medium">Processing your file...</p>
            </div>
          ) : error ? (
            <div className="flex flex-col items-center gap-4">
              <div className="h-16 w-16 rounded-full bg-red-100 dark:bg-red-900 flex items-center justify-center">
                <AlertCircle className="h-8 w-8 text-red-600 dark:text-red-400" />
              </div>
              <div>
                <p className="text-lg font-medium text-red-600 dark:text-red-400 mb-2">Upload Failed</p>
                <p className="text-sm text-muted-foreground">{error}</p>
              </div>
              <Button
                variant="outline"
                onClick={() => {
                  setError(null);
                  const input = document.createElement('input');
                  input.type = 'file';
                  input.accept = '.csv';
                  input.onchange = (e) => handleFileInput(e as any);
                  input.click();
                }}
              >
                Try Again
              </Button>
            </div>
          ) : (
            <>
              <div className="flex flex-col items-center gap-4">
                <div className="h-16 w-16 rounded-full bg-primary/10 flex items-center justify-center">
                  <Upload className="h-8 w-8 text-primary" />
                </div>
                <div>
                  <p className="text-lg font-medium mb-2">Drag and drop your CSV file here</p>
                  <p className="text-sm text-muted-foreground mb-4">or click to browse</p>
                </div>
                <Button
                  onClick={() => {
                    const input = document.createElement('input');
                    input.type = 'file';
                    input.accept = '.csv';
                    input.onchange = (e) => handleFileInput(e as any);
                    input.click();
                  }}
                >
                  <FileText className="mr-2 h-4 w-4" />
                  Choose File
                </Button>
              </div>
            </>
          )}
        </div>
      ) : (
        <div className="border rounded-lg p-8 bg-green-50 dark:bg-green-950/20 border-green-200 dark:border-green-800">
          <div className="flex items-center gap-4">
            <div className="h-12 w-12 rounded-full bg-green-100 dark:bg-green-900 flex items-center justify-center flex-shrink-0">
              <CheckCircle2 className="h-6 w-6 text-green-600 dark:text-green-400" />
            </div>
            <div className="flex-1">
              <p className="font-semibold text-green-900 dark:text-green-100 mb-1">File Uploaded Successfully</p>
              <p className="text-sm text-green-700 dark:text-green-300">{uploadedFile.name}</p>
              <p className="text-xs text-green-600 dark:text-green-400 mt-1">
                Ready to proceed to column mapping
              </p>
            </div>
            <Button
              variant="outline"
              size="sm"
              onClick={() => {
                setUploadedFile(null);
                onFileProcessed([], []);
              }}
            >
              Choose Different File
            </Button>
          </div>
        </div>
      )}

      {/* Help Text */}
      <div className="bg-blue-50 dark:bg-blue-950/20 border border-blue-200 dark:border-blue-800 rounded-lg p-4">
        <p className="text-sm text-blue-900 dark:text-blue-100 font-medium mb-2">💡 Tips for best results:</p>
        <ul className="text-sm text-blue-800 dark:text-blue-200 space-y-1 ml-4 list-disc">
          <li>Use our template to ensure proper formatting</li>
          <li>Include column headers in the first row</li>
          <li>Date format: MM/DD/YYYY (e.g., 12/30/2025)</li>
          <li>Phone format: XXX-XXX-XXXX (e.g., 909-213-6870)</li>
          <li>Employment Status: Active, Inactive, or On Leave</li>
        </ul>
      </div>
    </div>
  );
}
