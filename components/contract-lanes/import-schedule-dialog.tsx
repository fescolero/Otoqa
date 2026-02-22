'use client';

import { useState, useCallback } from 'react';
import { useAction, useMutation, useQuery } from 'convex/react';
import { api } from '@/convex/_generated/api';
import { Id } from '@/convex/_generated/dataModel';
import { Dialog, DialogContent } from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { toast } from 'sonner';
import { Upload, Settings2, Loader2, TableProperties, Import, ChevronLeft, ChevronRight } from 'lucide-react';
import { ScheduleConfigureStep } from './schedule-configure-step';
import { ScheduleReviewTable } from './schedule-review-table';
import { ScheduleChatPanel } from './schedule-chat-panel';
import { ScheduleDedupReview } from './schedule-dedup-review';
import type {
  ExtractionConfig,
  ExtractedLane,
  ChatMessage,
  DedupResult,
  WizardStep,
} from './schedule-import-types';
import * as pdfjsLib from 'pdfjs-dist';

pdfjsLib.GlobalWorkerOptions.workerSrc = `https://cdn.jsdelivr.net/npm/pdfjs-dist@${pdfjsLib.version}/build/pdf.worker.min.mjs`;

interface ImportScheduleDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  customerId: Id<'customers'>;
  workosOrgId: string;
  userId: string;
}

const STEP_ORDER: WizardStep[] = ['upload', 'configure', 'extracting', 'review', 'import'];

const STEP_LABELS: Record<WizardStep, string> = {
  upload: 'Upload',
  configure: 'Configure',
  extracting: 'Extracting',
  review: 'Review',
  import: 'Import',
};

const STEP_ICONS: Record<WizardStep, React.ReactNode> = {
  upload: <Upload className="h-4 w-4" />,
  configure: <Settings2 className="h-4 w-4" />,
  extracting: <Loader2 className="h-4 w-4" />,
  review: <TableProperties className="h-4 w-4" />,
  import: <Import className="h-4 w-4" />,
};

const PDF_DPI = 150;
const PAGES_PER_BATCH = 1;

export function ImportScheduleDialog({
  open,
  onOpenChange,
  customerId,
  workosOrgId,
  userId,
}: ImportScheduleDialogProps) {
  const [step, setStep] = useState<WizardStep>('upload');
  const [pdfFile, setPdfFile] = useState<File | null>(null);
  const [pageImages, setPageImages] = useState<string[]>([]);
  const [config, setConfig] = useState<ExtractionConfig | null>(null);
  const [lanes, setLanes] = useState<ExtractedLane[]>([]);
  const [chatMessages, setChatMessages] = useState<ChatMessage[]>([]);
  const [dedupResults, setDedupResults] = useState<DedupResult[]>([]);
  const [extractionProgress, setExtractionProgress] = useState('');
  const [isProcessing, setIsProcessing] = useState(false);

  const extractLanes = useAction(api.scheduleImport.extractLanesFromSchedule);
  const verifyStops = useAction(api.scheduleImport.verifyAndEnrichStops);
  const checkExisting = useQuery(api.contractLanes.checkExistingLanes, 
    step === 'import' ? {
      workosOrgId,
      pairs: lanes
        .filter((l) => l.hcr?.value && l.tripNumber?.value)
        .map((l) => ({
          hcr: l.hcr.value as string,
          tripNumber: l.tripNumber.value as string,
        })),
    } : 'skip'
  );
  const bulkUpsert = useMutation(api.contractLanes.bulkUpsert);

  const renderPdfToImages = useCallback(async (file: File): Promise<string[]> => {
    const arrayBuffer = await file.arrayBuffer();
    const pdf = await pdfjsLib.getDocument({ data: new Uint8Array(arrayBuffer) }).promise;
    const images: string[] = [];
    const scale = PDF_DPI / 72;

    for (let i = 1; i <= pdf.numPages; i++) {
      const page = await pdf.getPage(i);
      const viewport = page.getViewport({ scale });
      const canvas = document.createElement('canvas');
      canvas.width = viewport.width;
      canvas.height = viewport.height;
      const ctx = canvas.getContext('2d')!;
      // pdfjs-dist v5 requires canvas as a top-level render param
      await page.render({ canvasContext: ctx, viewport, canvas } as Parameters<typeof page.render>[0]).promise;
      images.push(canvas.toDataURL('image/jpeg', 0.85));
    }

    return images;
  }, []);

  const handleFileUpload = useCallback(
    async (e: React.ChangeEvent<HTMLInputElement>) => {
      const file = e.target.files?.[0];
      if (!file || !file.name.toLowerCase().endsWith('.pdf')) {
        toast.error('Please select a PDF file');
        return;
      }
      setPdfFile(file);
      try {
        const images = await renderPdfToImages(file);
        setPageImages(images);
        toast.success(`Loaded ${images.length} page(s)`);
      } catch (err) {
        console.error('PDF rendering failed:', err);
        toast.error('Failed to read PDF file. Check console for details.');
      }
    },
    [renderPdfToImages],
  );

  const handleDrop = useCallback(
    async (e: React.DragEvent) => {
      e.preventDefault();
      const file = e.dataTransfer.files[0];
      if (!file || !file.name.toLowerCase().endsWith('.pdf')) {
        toast.error('Please drop a PDF file');
        return;
      }
      setPdfFile(file);
      try {
        const images = await renderPdfToImages(file);
        setPageImages(images);
        toast.success(`Loaded ${images.length} page(s)`);
      } catch (err) {
        console.error('PDF rendering failed:', err);
        toast.error('Failed to read PDF file. Check console for details.');
      }
    },
    [renderPdfToImages],
  );

  const handleExtract = useCallback(async () => {
    if (!config || pageImages.length === 0) return;

    setStep('extracting');
    setIsProcessing(true);
    const allLanes: ExtractedLane[] = [];

    try {
      for (let i = 0; i < pageImages.length; i += PAGES_PER_BATCH) {
        const batch = pageImages.slice(i, i + PAGES_PER_BATCH);
        const endPage = Math.min(i + PAGES_PER_BATCH, pageImages.length);
        setExtractionProgress(
          `Processing pages ${i + 1}-${endPage} of ${pageImages.length}...`,
        );

        const result = await extractLanes({
          imageUrls: batch,
          config,
        });

        if (result.error) {
          toast.error(`Extraction error: ${result.error}`);
          if (result.lanes.length === 0 && allLanes.length === 0) {
            setStep('configure');
            setIsProcessing(false);
            return;
          }
        }

        for (const lane of result.lanes) {
          const laneTyped = lane as ExtractedLane;
          const isDuplicate = allLanes.some(
            (existing) =>
              existing.hcr?.value === laneTyped.hcr?.value &&
              existing.tripNumber?.value === laneTyped.tripNumber?.value,
          );
          if (!isDuplicate) {
            allLanes.push({ ...laneTyped, _selected: true });
          }
        }
      }

      setLanes(allLanes);
      setStep('review');

      if (
        config.includeLogistics &&
        config.stopDetailLevel !== 'none' &&
        allLanes.some((l) => l.stops && l.stops.length > 0)
      ) {
        setExtractionProgress('Verifying addresses with Google Maps...');
        try {
          const verified = await verifyStops({ lanes: allLanes });
          setLanes(verified.lanes as ExtractedLane[]);
          if (verified.error) {
            toast.warning(`Address verification: ${verified.error}`);
          }
        } catch {
          toast.warning('Address verification failed -- you can continue without it');
        }
      }

      toast.success(`Extracted ${allLanes.length} lane(s)`);
    } catch (err) {
      toast.error('Extraction failed. Please try again.');
      console.error(err);
      setStep('configure');
    } finally {
      setIsProcessing(false);
      setExtractionProgress('');
    }
  }, [config, pageImages, extractLanes, verifyStops]);

  const handleProceedToImport = useCallback(() => {
    if (!checkExisting) {
      setStep('import');
      return;
    }

    const results: DedupResult[] = lanes
      .filter((l) => l._selected !== false)
      .map((lane) => {
        const key = `${lane.hcr?.value || ''}:${lane.tripNumber?.value || ''}`;
        const existing = checkExisting[key];

        if (!existing) {
          return { lane, category: 'new' as const, selected: true };
        }

        if (existing.isDeleted) {
          return {
            lane,
            category: 'restore' as const,
            existingId: existing._id,
            existingData: existing as unknown as Record<string, unknown>,
            isDeleted: true,
            selected: true,
          };
        }

        const hasChanges =
          (lane.rate?.value !== undefined && lane.rate.value !== existing.rate) ||
          (lane.rateType?.value !== undefined && lane.rateType.value !== existing.rateType) ||
          (lane.contractPeriodStart?.value !== undefined &&
            lane.contractPeriodStart.value !== existing.contractPeriodStart) ||
          (lane.contractPeriodEnd?.value !== undefined &&
            lane.contractPeriodEnd.value !== existing.contractPeriodEnd) ||
          (lane.miles?.value !== undefined && lane.miles.value !== existing.miles);

        if (hasChanges) {
          return {
            lane,
            category: 'update' as const,
            existingId: existing._id,
            existingData: existing as unknown as Record<string, unknown>,
            selected: true,
          };
        }

        return {
          lane,
          category: 'unchanged' as const,
          existingId: existing._id,
          existingData: existing as unknown as Record<string, unknown>,
          selected: false,
        };
      });

    setDedupResults(results);
    setStep('import');
  }, [lanes, checkExisting]);

  const handleImport = useCallback(async () => {
    setIsProcessing(true);
    try {
      const toCreate = dedupResults
        .filter((r) => r.selected && r.category === 'new')
        .map((r) => r.lane);

      const toUpdate = dedupResults
        .filter((r) => r.selected && (r.category === 'update' || r.category === 'restore'))
        .filter((r) => r.existingId);

      const toRestore = dedupResults
        .filter((r) => r.selected && r.category === 'restore' && r.existingId)
        .map((r) => r.existingId as Id<'contractLanes'>);

      const newLanes = toCreate.map((lane) => ({
        contractName: (lane.contractName?.value as string) || `Lane: ${lane.hcr?.value || 'Unknown'}/${lane.tripNumber?.value || 'Unknown'}`,
        contractPeriodStart: (lane.contractPeriodStart?.value as string) || '',
        contractPeriodEnd: (lane.contractPeriodEnd?.value as string) || '',
        hcr: (lane.hcr?.value as string) || undefined,
        tripNumber: (lane.tripNumber?.value as string) || undefined,
        stops: (lane.stops || []).map((s, idx) => ({
          address: (s.address?.value as string) || '',
          city: (s.city?.value as string) || '',
          state: (s.state?.value as string) || '',
          zip: (s.zip?.value as string) || '',
          stopOrder: idx + 1,
          stopType: ((s.stopType?.value as 'Pickup' | 'Delivery') || 'Pickup'),
          type: 'APPT' as const,
          arrivalTime: '',
        })),
        miles: (lane.miles?.value as number) || undefined,
        calculatedMiles: lane._calculatedMiles || undefined,
        rate: (lane.rate?.value as number) || 0,
        rateType: ((lane.rateType?.value as 'Per Mile' | 'Flat Rate' | 'Per Stop') || 'Flat Rate'),
        currency: ((lane.currency?.value as 'USD' | 'CAD' | 'MXN') || undefined),
        minimumRate: (lane.minimumRate?.value as number) || undefined,
        minimumQuantity: (lane.minimumQuantity?.value as number) || undefined,
        equipmentClass: (lane.equipmentClass?.value as 'Bobtail' | 'Dry Van' | 'Refrigerated' | 'Flatbed' | 'Tanker') || undefined,
        equipmentSize: (lane.equipmentSize?.value as '53ft' | '48ft' | '45ft') || undefined,
        stopOffRate: (lane.stopOffRate?.value as number) || undefined,
        includedStops: (lane.includedStops?.value as number) || undefined,
        fuelSurchargeType: (lane.fuelSurchargeType?.value as 'PERCENTAGE' | 'FLAT' | 'DOE_INDEX') || undefined,
        fuelSurchargeValue: (lane.fuelSurchargeValue?.value as number) || undefined,
        subsidiary: (lane.subsidiary?.value as string) || undefined,
      }));

      const updateLanes = toUpdate.map((r) => ({
        existingId: r.existingId as Id<'contractLanes'>,
        contractPeriodStart: (r.lane.contractPeriodStart?.value as string) || undefined,
        contractPeriodEnd: (r.lane.contractPeriodEnd?.value as string) || undefined,
        rate: (r.lane.rate?.value as number) || undefined,
        rateType: ((r.lane.rateType?.value as 'Per Mile' | 'Flat Rate' | 'Per Stop') || undefined),
        miles: (r.lane.miles?.value as number) || undefined,
        calculatedMiles: r.lane._calculatedMiles || undefined,
      }));

      const result = await bulkUpsert({
        customerId,
        workosOrgId,
        userId,
        newLanes,
        updateLanes,
        restoreLaneIds: toRestore,
      });

      const parts = [];
      if (result.created > 0) parts.push(`${result.created} created`);
      if (result.updated > 0) parts.push(`${result.updated} updated`);
      if (result.restored > 0) parts.push(`${result.restored} restored`);
      toast.success(`Import complete: ${parts.join(', ')}`);

      onOpenChange(false);
      resetState();
    } catch (err) {
      console.error('Import failed:', err);
      toast.error('Import failed. Please try again.');
    } finally {
      setIsProcessing(false);
    }
  }, [dedupResults, bulkUpsert, customerId, workosOrgId, userId, onOpenChange]);

  const resetState = () => {
    setStep('upload');
    setPdfFile(null);
    setPageImages([]);
    setConfig(null);
    setLanes([]);
    setChatMessages([]);
    setDedupResults([]);
    setExtractionProgress('');
    setIsProcessing(false);
  };

  const currentStepIndex = STEP_ORDER.indexOf(step);

  return (
    <Dialog
      open={open}
      onOpenChange={(val) => {
        if (!val) resetState();
        onOpenChange(val);
      }}
    >
      <DialogContent className="max-w-[95vw] w-[1400px] max-h-[90vh] h-[85vh] flex flex-col p-0 gap-0">
        {/* Step indicator */}
        <div className="flex items-center justify-center border-b px-4 py-3 shrink-0 overflow-x-auto">
          {STEP_ORDER.map((s, i) => {
            const isActive = s === step;
            const isComplete = i < currentStepIndex;
            return (
              <div key={s} className="flex items-center shrink-0">
                {i > 0 && (
                  <div
                    className={`h-px w-6 mx-1.5 ${isComplete ? 'bg-primary' : 'bg-border'}`}
                  />
                )}
                <div
                  className={`flex items-center gap-1.5 text-xs px-2 py-1 rounded whitespace-nowrap ${
                    isActive
                      ? 'bg-primary/10 text-primary font-medium'
                      : isComplete
                        ? 'text-primary'
                        : 'text-muted-foreground'
                  }`}
                >
                  {STEP_ICONS[s]}
                  <span>{STEP_LABELS[s]}</span>
                </div>
              </div>
            );
          })}
        </div>

        {/* Step content */}
        <div className="flex-1 min-h-0 overflow-hidden">
          {step === 'upload' && (
            <div className="flex flex-col items-center justify-center h-full p-8">
              <div
                className="border-2 border-dashed rounded-xl p-12 w-full max-w-lg text-center cursor-pointer hover:border-primary/50 transition-colors"
                onDrop={handleDrop}
                onDragOver={(e) => e.preventDefault()}
              >
                <Upload className="h-12 w-12 text-muted-foreground mx-auto mb-4" />
                <h3 className="text-lg font-semibold mb-2">
                  Upload Schedule PDF
                </h3>
                <p className="text-sm text-muted-foreground mb-4">
                  Drag and drop a PDF file, or click to browse
                </p>
                <label>
                  <Button variant="outline" asChild>
                    <span>Choose File</span>
                  </Button>
                  <input
                    type="file"
                    accept=".pdf"
                    className="hidden"
                    onChange={handleFileUpload}
                  />
                </label>
                {pdfFile && (
                  <div className="mt-4 text-sm font-medium">
                    {pdfFile.name} ({pageImages.length} page
                    {pageImages.length !== 1 ? 's' : ''})
                  </div>
                )}
              </div>
            </div>
          )}

          {step === 'configure' && config !== null && (
            <div className="h-full overflow-y-auto p-6">
              <ScheduleConfigureStep config={config} onChange={setConfig} />
            </div>
          )}

          {step === 'configure' && config === null && (
            <div className="h-full overflow-y-auto p-6">
              <ScheduleConfigureStep
                config={{
                  includeLogistics: true,
                  includeFinancial: true,
                  extractDates: true,
                  stopDetailLevel: 'full',
                  includeEquipment: false,
                  includeFuelSurcharge: false,
                }}
                onChange={setConfig}
              />
            </div>
          )}

          {step === 'extracting' && (
            <div className="flex flex-col items-center justify-center h-full gap-4">
              <Loader2 className="h-12 w-12 animate-spin text-primary" />
              <p className="text-lg font-medium">Extracting lane data...</p>
              {extractionProgress && (
                <p className="text-sm text-muted-foreground">
                  {extractionProgress}
                </p>
              )}
            </div>
          )}

          {step === 'review' && (
            <div className="flex h-full min-h-0">
              <div className="flex-1 min-w-0 overflow-auto border-r">
                <ScheduleReviewTable
                  lanes={lanes}
                  config={config!}
                  onLanesChange={setLanes}
                />
              </div>
              <div className="w-[360px] shrink-0">
                <ScheduleChatPanel
                  lanes={lanes}
                  config={config!}
                  messages={chatMessages}
                  onMessagesChange={setChatMessages}
                  onLanesChange={setLanes}
                />
              </div>
            </div>
          )}

          {step === 'import' && (
            <div className="h-full overflow-y-auto p-6">
              <ScheduleDedupReview
                results={dedupResults}
                onResultsChange={setDedupResults}
              />
            </div>
          )}
        </div>

        {/* Footer navigation */}
        <div className="flex items-center justify-between border-t px-6 py-3 shrink-0">
          <Button
            variant="outline"
            onClick={() => {
              if (step === 'upload') {
                onOpenChange(false);
                resetState();
              } else if (step === 'review') {
                setStep('configure');
              } else if (step === 'import') {
                setStep('review');
              } else if (step === 'configure') {
                setStep('upload');
              }
            }}
            disabled={step === 'extracting'}
          >
            <ChevronLeft className="h-4 w-4 mr-1" />
            {step === 'upload' ? 'Cancel' : 'Back'}
          </Button>

          <div className="flex gap-2">
            {step === 'upload' && (
              <Button
                onClick={() => {
                  if (!config) {
                    setConfig({
                      includeLogistics: true,
                      includeFinancial: true,
                      extractDates: true,
                      stopDetailLevel: 'full',
                      includeEquipment: false,
                      includeFuelSurcharge: false,
                    });
                  }
                  setStep('configure');
                }}
                disabled={pageImages.length === 0}
              >
                Next
                <ChevronRight className="h-4 w-4 ml-1" />
              </Button>
            )}

            {step === 'configure' && (
              <Button onClick={handleExtract} disabled={!config}>
                Extract Lanes
                <ChevronRight className="h-4 w-4 ml-1" />
              </Button>
            )}

            {step === 'review' && (
              <Button
                onClick={handleProceedToImport}
                disabled={lanes.filter((l) => l._selected !== false).length === 0}
              >
                Continue to Import
                <ChevronRight className="h-4 w-4 ml-1" />
              </Button>
            )}

            {step === 'import' && (
              <Button
                onClick={handleImport}
                disabled={
                  isProcessing ||
                  dedupResults.filter((r) => r.selected).length === 0
                }
              >
                {isProcessing ? (
                  <>
                    <Loader2 className="h-4 w-4 mr-2 animate-spin" />
                    Importing...
                  </>
                ) : (
                  <>
                    Import{' '}
                    {dedupResults.filter((r) => r.selected).length} Lane(s)
                  </>
                )}
              </Button>
            )}
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}
