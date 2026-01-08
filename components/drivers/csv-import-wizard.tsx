'use client';

import { useState } from 'react';
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { Check, ChevronLeft, ChevronRight } from 'lucide-react';
import { ImportStep1Upload } from './import-step-1-upload';
import { ImportStep2Mapping } from './import-step-2-mapping';
import { ImportStep3Review } from './import-step-3-review';

export interface CSVRow {
  [key: string]: string;
}

export interface ColumnMapping {
  sourceColumn: string;
  destinationField: string | 'ignore';
  preview: string;
}

export interface ValidationError {
  rowIndex: number;
  field: string;
  value: string;
  error: string;
  suggestion?: string;
}

export interface DuplicateDriver {
  rowIndex: number;
  incomingData: CSVRow;
  existingDriver: any;
  matchedOn: string;
}

interface CSVImportWizardProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onImportComplete: () => void;
}

export function CSVImportWizard({ open, onOpenChange, onImportComplete }: CSVImportWizardProps) {
  const [currentStep, setCurrentStep] = useState(1);
  const [parsedData, setParsedData] = useState<CSVRow[]>([]);
  const [headers, setHeaders] = useState<string[]>([]);
  const [columnMappings, setColumnMappings] = useState<ColumnMapping[]>([]);
  const [validRows, setValidRows] = useState<CSVRow[]>([]);
  const [errors, setErrors] = useState<ValidationError[]>([]);
  const [duplicates, setDuplicates] = useState<DuplicateDriver[]>([]);

  const steps = [
    { number: 1, title: 'Upload File', description: 'Choose your CSV file' },
    { number: 2, title: 'Map Columns', description: 'Match your data fields' },
    { number: 3, title: 'Review & Repair', description: 'Fix any issues' },
  ];

  const handleReset = () => {
    setCurrentStep(1);
    setParsedData([]);
    setHeaders([]);
    setColumnMappings([]);
    setValidRows([]);
    setErrors([]);
    setDuplicates([]);
  };

  const handleClose = () => {
    handleReset();
    onOpenChange(false);
  };

  const canProceed = () => {
    if (currentStep === 1) return parsedData.length > 0;
    if (currentStep === 2) return columnMappings.some((m) => m.destinationField !== 'ignore');
    return true;
  };

  return (
    <Dialog open={open} onOpenChange={handleClose}>
      <DialogContent className="!w-[95vw] !max-w-[1400px] h-[95vh] flex flex-col p-0 gap-0 rounded-xl overflow-hidden">
        {/* Header with Progress */}
        <DialogHeader className="px-6 pt-4 pb-3 border-b flex-shrink-0 bg-background shadow-sm">
          <DialogTitle className="text-xl">Import Drivers</DialogTitle>
          
          {/* Step Progress Indicator */}
          <div className="flex items-center justify-between mt-4">
            {steps.map((step, index) => (
              <div key={step.number} className="flex items-center flex-1">
                {/* Step Circle */}
                <div className="flex flex-col items-center">
                  <div
                    className={`w-8 h-8 rounded-full flex items-center justify-center text-sm font-semibold transition-colors ${
                      currentStep > step.number
                        ? 'bg-green-600 text-white'
                        : currentStep === step.number
                        ? 'bg-primary text-primary-foreground'
                        : 'bg-gray-200 text-gray-500 dark:bg-gray-700 dark:text-gray-400'
                    }`}
                  >
                    {currentStep > step.number ? <Check className="h-4 w-4" /> : step.number}
                  </div>
                  <div className="mt-1.5 text-center">
                    <p className="text-xs font-medium">{step.title}</p>
                    <p className="text-[10px] text-muted-foreground">{step.description}</p>
                  </div>
                </div>

                {/* Connector Line */}
                {index < steps.length - 1 && (
                  <div
                    className={`flex-1 h-0.5 mx-3 transition-colors ${
                      currentStep > step.number ? 'bg-green-600' : 'bg-gray-200 dark:bg-gray-700'
                    }`}
                  />
                )}
              </div>
            ))}
          </div>
        </DialogHeader>

        {/* Step Content */}
        <div className="flex-1 overflow-y-auto px-6 py-6">
          {currentStep === 1 && (
            <ImportStep1Upload
              onFileProcessed={(data, headers) => {
                setParsedData(data);
                setHeaders(headers);
              }}
            />
          )}

          {currentStep === 2 && (
            <ImportStep2Mapping
              headers={headers}
              parsedData={parsedData}
              columnMappings={columnMappings}
              onMappingsChange={setColumnMappings}
            />
          )}

          {currentStep === 3 && (
            <ImportStep3Review
              parsedData={parsedData}
              columnMappings={columnMappings}
              validRows={validRows}
              errors={errors}
              duplicates={duplicates}
              onErrorsChange={setErrors}
              onDuplicatesChange={setDuplicates}
              onValidRowsChange={setValidRows}
              onImportComplete={() => {
                handleClose();
                onImportComplete();
              }}
            />
          )}
        </div>

        {/* Footer Navigation */}
        <div className="px-6 py-3 border-t bg-gray-50 dark:bg-gray-900 flex items-center justify-between flex-shrink-0 shadow-[0_-2px_8px_rgba(0,0,0,0.05)]">
          <Button variant="outline" onClick={handleClose}>
            Cancel
          </Button>

          <div className="flex items-center gap-2">
            {currentStep > 1 && (
              <Button variant="outline" onClick={() => setCurrentStep(currentStep - 1)}>
                <ChevronLeft className="mr-2 h-4 w-4" />
                Back
              </Button>
            )}

            {currentStep < 3 && (
              <Button onClick={() => setCurrentStep(currentStep + 1)} disabled={!canProceed()}>
                Continue
                <ChevronRight className="ml-2 h-4 w-4" />
              </Button>
            )}
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}
