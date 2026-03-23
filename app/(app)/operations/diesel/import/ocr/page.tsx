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
import { Input } from '@/components/ui/input';
import { Separator } from '@/components/ui/separator';
import { SidebarTrigger } from '@/components/ui/sidebar';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { useAuth } from '@workos-inc/authkit-nextjs/components';
import { useAction, useMutation } from 'convex/react';
import { api } from '@/convex/_generated/api';
import { Id } from '@/convex/_generated/dataModel';
import { useRouter } from 'next/navigation';
import { Fragment, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useOrganizationId } from '@/contexts/organization-context';
import { useAuthQuery } from '@/hooks/use-auth-query';
import Link from 'next/link';
import { AlertCircle, ArrowLeft, CheckCircle, Download, Loader2, Upload } from 'lucide-react';
import { toast } from 'sonner';
import * as pdfjsLib from 'pdfjs-dist';

pdfjsLib.GlobalWorkerOptions.workerSrc = `https://cdn.jsdelivr.net/npm/pdfjs-dist@${pdfjsLib.version}/build/pdf.worker.min.mjs`;

type Confidence = 'high' | 'medium' | 'low';

type ExtractedField<T = string | number | null> = {
  value: T;
  confidence: Confidence;
};

type OcrPageInput = {
  imageUrl: string;
  pageText?: string;
};

type PdfTextToken = {
  text: string;
  x: number;
  y: number;
};

type ExtractedFuelEntry = {
  entryDate: ExtractedField<string | null>;
  vendorName: ExtractedField<string | null>;
  gallons: ExtractedField<string | number | null>;
  pricePerGallon: ExtractedField<string | number | null>;
  fuelType?: ExtractedField<string | null>;
  totalCost?: ExtractedField<string | number | null>;
  odometerReading?: ExtractedField<string | number | null>;
  city?: ExtractedField<string | null>;
  state?: ExtractedField<string | null>;
  fuelCardNumber?: ExtractedField<string | null>;
  receiptNumber?: ExtractedField<string | null>;
  paymentMethod?: ExtractedField<string | null>;
  driverName?: ExtractedField<string | null>;
  carrierName?: ExtractedField<string | null>;
  truckUnit?: ExtractedField<string | null>;
  notes?: ExtractedField<string | null>;
};

type FuelPaymentMethod = 'FUEL_CARD' | 'CASH' | 'CHECK' | 'CREDIT_CARD' | 'EFS' | 'COMDATA';
type FuelCategory = 'FUEL' | 'DEF' | 'OTHER';

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

interface ReviewRow {
  extracted: ExtractedFuelEntry;
  errors: string[];
  warnings: string[];
  skip: boolean;
  resolvedDriverId?: Id<'drivers'>;
  resolvedCarrierId?: Id<'carrierPartnerships'>;
  resolvedTruckId?: Id<'trucks'>;
  resolvedVendorId?: Id<'fuelVendors'>;
  selectedDriverId?: Id<'drivers'>;
  selectedCarrierId?: Id<'carrierPartnerships'>;
  selectedTruckId?: Id<'trucks'>;
  selectedVendorId?: Id<'fuelVendors'>;
}

type Step = 'upload' | 'extracting' | 'review';

const PDF_DPI = 150;
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

function normalizeLooseString(value: string) {
  return value.toLowerCase().replace(/[^a-z0-9]/g, '');
}

function tryParseDate(value: string): number | null {
  if (!value) return null;

  const direct = new Date(value);
  if (!Number.isNaN(direct.getTime())) return direct.getTime();

  const parts = value.match(/^(\d{1,2})[/\-.](\d{1,2})[/\-.](\d{2,4})$/);
  if (!parts) return null;

  const month = Number(parts[1]);
  const day = Number(parts[2]);
  let year = Number(parts[3]);
  if (year < 100) year += 2000;

  const parsed = new Date(year, month - 1, day);
  return Number.isNaN(parsed.getTime()) ? null : parsed.getTime();
}

function fuzzyMatchName(
  fullName: string,
  drivers: Array<{ _id: Id<'drivers'>; firstName: string; lastName: string }>,
): Id<'drivers'> | undefined {
  const normalized = fullName.toLowerCase().trim();
  if (!normalized) return undefined;

  for (const driver of drivers) {
    const full = `${driver.firstName} ${driver.lastName}`.toLowerCase();
    if (full === normalized) return driver._id;
  }

  for (const driver of drivers) {
    const lastFirst = `${driver.lastName}, ${driver.firstName}`.toLowerCase();
    if (lastFirst === normalized) return driver._id;
  }

  for (const driver of drivers) {
    const full = `${driver.firstName} ${driver.lastName}`.toLowerCase();
    if (normalized.includes(driver.lastName.toLowerCase()) && normalized.includes(driver.firstName.toLowerCase())) {
      return driver._id;
    }
    if (full.includes(normalized) || normalized.includes(full)) {
      return driver._id;
    }
  }

  return undefined;
}

function formatConfidence(confidence: Confidence | undefined) {
  if (confidence === 'low') return 'Low confidence';
  if (confidence === 'medium') return 'Medium confidence';
  return null;
}

function getCellInputClass(hasError = false, hasWarning = false) {
  if (hasError) return 'h-8 min-w-[120px] border-destructive text-destructive';
  if (hasWarning) return 'h-8 min-w-[120px] border-yellow-500 text-yellow-700';
  return 'h-8 min-w-[120px]';
}

function formatPaymentMethodLabel(value: FuelPaymentMethod) {
  switch (value) {
    case 'FUEL_CARD':
      return 'Fuel Card';
    case 'CREDIT_CARD':
      return 'Credit Card';
    default:
      return value;
  }
}

const FUEL_TYPE_NORMALIZATION_MAP: Record<string, FuelCategory> = {
  'DSL': 'FUEL',
  'DIESEL': 'FUEL',
  'ULSD': 'FUEL',
  'ULTRA LOW SULFUR DIESEL': 'FUEL',
  'LSD': 'FUEL',
  'DYED': 'FUEL',
  'DYED DIESEL': 'FUEL',
  'AGO': 'FUEL',
  'AUTOMOTIVE GAS OIL': 'FUEL',
  'B5': 'FUEL',
  'B10': 'FUEL',
  'B20': 'FUEL',
  'BIODIESEL': 'FUEL',
  'DEF': 'DEF',
  'DIESEL EXHAUST FLUID': 'DEF',
  'GSL': 'OTHER',
  'GAS': 'OTHER',
  'GASOLINE': 'OTHER',
  'REG': 'OTHER',
  'REGULAR': 'OTHER',
  'UNL': 'OTHER',
  'UNLEADED': 'OTHER',
  'PREM': 'OTHER',
  'PREMIUM': 'OTHER',
  'MID': 'OTHER',
  'MIDGRADE': 'OTHER',
};

function normalizeFuelType(value: string): FuelCategory | string {
  const normalized = value
    .trim()
    .toUpperCase()
    .replace(/[^A-Z0-9]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();

  return FUEL_TYPE_NORMALIZATION_MAP[normalized] ?? normalized;
}

function formatFuelCategoryLabel(value: FuelCategory) {
  if (value === 'FUEL') return 'Fuel';
  if (value === 'DEF') return 'DEF';
  return 'Other';
}

async function fileToDataUrl(file: File): Promise<string> {
  return await new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result as string);
    reader.onerror = () => reject(reader.error);
    reader.readAsDataURL(file);
  });
}

function buildStructuredPageText(items: unknown[]): string {
  const tokens: PdfTextToken[] = items
    .map((item) => {
      if (!item || typeof item !== 'object' || !('str' in item) || !('transform' in item)) return null;

      const maybe = item as { str?: unknown; transform?: unknown };
      if (typeof maybe.str !== 'string' || !Array.isArray(maybe.transform) || maybe.transform.length < 6) return null;

      const text = maybe.str.replace(/\s+/g, ' ').trim();
      if (!text) return null;

      return {
        text,
        x: Number(maybe.transform[4] ?? 0),
        y: Number(maybe.transform[5] ?? 0),
      } satisfies PdfTextToken;
    })
    .filter((token): token is PdfTextToken => token !== null)
    .sort((a, b) => b.y - a.y || a.x - b.x);

  if (tokens.length === 0) return '';

  const rows: Array<{ y: number; tokens: PdfTextToken[] }> = [];
  const rowTolerance = 2.5;

  for (const token of tokens) {
    const existingRow = rows.find((row) => Math.abs(row.y - token.y) <= rowTolerance);
    if (existingRow) {
      existingRow.tokens.push(token);
      existingRow.y = (existingRow.y + token.y) / 2;
    } else {
      rows.push({ y: token.y, tokens: [token] });
    }
  }

  rows.sort((a, b) => b.y - a.y);

  return rows
    .map((row) => {
      const ordered = row.tokens.sort((a, b) => a.x - b.x);
      let line = '';
      let lastX = ordered[0]?.x ?? 0;

      for (const token of ordered) {
        const gap = token.x - lastX;
        const spacer = gap > 120 ? ' | ' : gap > 48 ? '  ' : ' ';
        line += `${line ? spacer : ''}${token.text}`;
        lastX = token.x;
      }

      return line.trim();
    })
    .filter(Boolean)
    .join('\n');
}

async function renderPdfToImages(file: File): Promise<OcrPageInput[]> {
  const arrayBuffer = await file.arrayBuffer();
  const pdf = await pdfjsLib.getDocument({ data: new Uint8Array(arrayBuffer) }).promise;
  const pages: OcrPageInput[] = [];
  const scale = PDF_DPI / 72;

  for (let pageNumber = 1; pageNumber <= pdf.numPages; pageNumber++) {
    const page = await pdf.getPage(pageNumber);
    const textContent = await page.getTextContent();
    const pageText = buildStructuredPageText(textContent.items as unknown[]);
    const viewport = page.getViewport({ scale });
    const canvas = document.createElement('canvas');
    canvas.width = viewport.width;
    canvas.height = viewport.height;
    const ctx = canvas.getContext('2d');
    if (!ctx) continue;
    await page.render({ canvasContext: ctx, viewport, canvas } as Parameters<typeof page.render>[0]).promise;
    pages.push({ imageUrl: canvas.toDataURL('image/jpeg', 0.88), ...(pageText ? { pageText } : {}) });
  }

  return pages;
}

export default function OcrFuelImportPage() {
  const { user } = useAuth();
  const router = useRouter();
  const organizationId = useOrganizationId();
  const fileInputRef = useRef<HTMLInputElement>(null);

  const extractFuelEntries = useAction(api.fuelReceiptImport.extractFuelEntriesFromReceipts);
  const bulkCreate = useMutation(api.fuelEntries.bulkCreate);

  const drivers = useAuthQuery(api.drivers.list, organizationId ? { organizationId } : 'skip');
  const trucks = useAuthQuery(api.trucks.list, organizationId ? { organizationId } : 'skip');
  const vendors = useAuthQuery(api.fuelVendors.list, organizationId ? { organizationId, activeOnly: true } : 'skip');
  const carriersRaw = useAuthQuery(
    api.carrierPartnerships.listForBroker,
    organizationId ? { brokerOrgId: organizationId } : 'skip',
  );

  const [step, setStep] = useState<Step>('upload');
  const [dragOver, setDragOver] = useState(false);
  const [selectedFiles, setSelectedFiles] = useState<File[]>([]);
  const [ocrPages, setOcrPages] = useState<OcrPageInput[]>([]);
  const [extractedEntries, setExtractedEntries] = useState<ExtractedFuelEntry[]>([]);
  const [reviewRows, setReviewRows] = useState<ReviewRow[]>([]);
  const [isProcessing, setIsProcessing] = useState(false);
  const [importResult, setImportResult] = useState<{ imported: number; skipped: number } | null>(null);

  const carriers = useMemo(
    () =>
      (carriersRaw ?? []).map((carrier) => ({
        _id: carrier._id,
        carrierName: carrier.carrierName,
        trackFuelConsumption: carrier.trackFuelConsumption ?? false,
      })),
    [carriersRaw],
  );

  const buildReviewRows = useCallback(
    (entries: ExtractedFuelEntry[], previousRows?: ReviewRow[]): ReviewRow[] => {
      const driverList = (drivers ?? []).filter((driver) => !driver.isDeleted);
      const truckList = (trucks ?? []).filter((truck) => !truck.isDeleted);
      const vendorList = vendors ?? [];
      const carrierList = carriers;

      return entries.map((entry, index) => {
        const errors: string[] = [];
        const warnings: string[] = [];
        const previous = previousRows?.[index];

        const dateValue = entry.entryDate.value?.toString().trim() || '';
        if (!dateValue) {
          errors.push('Date is required');
        } else if (tryParseDate(dateValue) === null) {
          errors.push(`Invalid date: "${dateValue}"`);
        }

        const vendorName = entry.vendorName.value?.toString().trim() || '';
        let resolvedVendorId: Id<'fuelVendors'> | undefined;
        if (!vendorName) {
          errors.push('Vendor name is required');
        } else {
          const exact = vendorList.find((vendor) => vendor.name.toLowerCase() === vendorName.toLowerCase());
          const loose = vendorList.find((vendor) => {
            const existing = normalizeLooseString(vendor.name);
            const incoming = normalizeLooseString(vendorName);
            return existing === incoming || existing.includes(incoming) || incoming.includes(existing);
          });
          resolvedVendorId = exact?._id ?? loose?._id;
          if (!resolvedVendorId) {
            warnings.push(`Vendor "${vendorName}" not found`);
          }
        }

        if (entry.vendorName.confidence !== 'high') {
          const label = formatConfidence(entry.vendorName.confidence);
          if (label) warnings.push(`${label} vendor match`);
        }

        const selectedVendorId = previous?.selectedVendorId ?? resolvedVendorId;
        if (!selectedVendorId) {
          errors.push('Vendor selection is required');
        }

        const gallons = entry.gallons.value;
        if (gallons === null || gallons === undefined) {
          errors.push('Gallons is required');
        } else if (Number(gallons) <= 0) {
          errors.push(`Invalid gallons: "${gallons}"`);
        }

        if (entry.gallons.confidence !== 'high') {
          const label = formatConfidence(entry.gallons.confidence);
          if (label) warnings.push(`${label} gallons value`);
        }

        const pricePerGallon = entry.pricePerGallon.value;
        if (pricePerGallon === null || pricePerGallon === undefined) {
          errors.push('Price per gallon is required');
        } else if (Number(pricePerGallon) <= 0) {
          errors.push(`Invalid price: "${pricePerGallon}"`);
        }

        if (entry.pricePerGallon.confidence !== 'high') {
          const label = formatConfidence(entry.pricePerGallon.confidence);
          if (label) warnings.push(`${label} price per gallon`);
        }

        const fuelType = entry.fuelType?.value?.toString().trim() || '';
        const normalizedFuelType = fuelType ? normalizeFuelType(fuelType) : '';
        if (normalizedFuelType === 'DEF') {
          errors.push('Fuel type is DEF; use the DEF workflow instead');
        }
        if (normalizedFuelType === 'OTHER') {
          warnings.push('Fuel type normalized to OTHER; verify this is a fuel entry');
        }
        if (!fuelType) {
          warnings.push('Fuel type missing');
        }

        let resolvedDriverId: Id<'drivers'> | undefined;
        const driverName = entry.driverName?.value?.toString().trim() || '';
        if (driverName) {
          resolvedDriverId = fuzzyMatchName(driverName, driverList);
        }

        let resolvedCarrierId: Id<'carrierPartnerships'> | undefined;
        const carrierName = entry.carrierName?.value?.toString().trim() || '';
        if (carrierName) {
          const exact = carrierList.find((carrier) => carrier.carrierName.toLowerCase() === carrierName.toLowerCase());
          const loose = carrierList.find((carrier) => {
            const existing = normalizeLooseString(carrier.carrierName);
            const incoming = normalizeLooseString(carrierName);
            return existing === incoming || existing.includes(incoming) || incoming.includes(existing);
          });
          resolvedCarrierId = exact?._id ?? loose?._id;
        }

        const selectedDriverId = previous?.selectedDriverId ?? resolvedDriverId;
        const selectedCarrierId = previous?.selectedCarrierId ?? resolvedCarrierId;

        if (driverName && !selectedDriverId) {
          warnings.push(`Driver "${driverName}" not matched`);
        }
        if (carrierName && !selectedCarrierId) {
          warnings.push(`Carrier "${carrierName}" not matched`);
        }

        let resolvedTruckId: Id<'trucks'> | undefined;
        const truckUnit = entry.truckUnit?.value?.toString().trim() || '';
        if (truckUnit) {
          const normalizedTruck = normalizeLooseString(truckUnit);
          const match = truckList.find((truck) => normalizeLooseString(truck.unitId) === normalizedTruck);
          if (match) {
            resolvedTruckId = match._id;
          }
        }

        const selectedTruckId = previous?.selectedTruckId ?? resolvedTruckId;
        if (truckUnit && !selectedTruckId) {
          warnings.push(`Truck "${truckUnit}" not found`);
        }

        if (entry.odometerReading?.value !== null && entry.odometerReading?.value !== undefined) {
          if (Number(entry.odometerReading.value) < 0) {
            warnings.push(`Invalid odometer: "${entry.odometerReading.value}"`);
          }
        }

        const paymentMethodValue = entry.paymentMethod?.value?.toString().trim() || '';
        if (paymentMethodValue && !VALID_PAYMENT_METHODS.includes(paymentMethodValue.toUpperCase())) {
          warnings.push(`Unknown payment method: "${paymentMethodValue}"`);
        }

        if (
          entry.totalCost?.value !== null &&
          entry.totalCost?.value !== undefined &&
          gallons !== null &&
          gallons !== undefined &&
          pricePerGallon !== null &&
          pricePerGallon !== undefined
        ) {
          const computed = Math.round(Number(gallons) * Number(pricePerGallon) * 100) / 100;
          if (Math.abs(Number(entry.totalCost.value) - computed) > 0.11) {
            warnings.push('Total does not match gallons x price/gal');
          }
        }

        return {
          extracted: entry,
          errors,
          warnings,
          skip: false,
          resolvedDriverId,
          resolvedCarrierId,
          resolvedTruckId,
          resolvedVendorId,
          selectedDriverId,
          selectedCarrierId,
          selectedTruckId,
          selectedVendorId,
        };
      });
    },
    [carriers, drivers, trucks, vendors],
  );

  const syncReviewRows = useCallback(
    (entries: ExtractedFuelEntry[], previousRows?: ReviewRow[]) => {
      const nextRows = buildReviewRows(entries, previousRows);
      return nextRows.map((row, index) => ({
        ...row,
        skip: previousRows?.[index]?.skip ?? false,
      }));
    },
    [buildReviewRows],
  );

  useEffect(() => {
    if (extractedEntries.length === 0) {
      setReviewRows([]);
      return;
    }

    setReviewRows((current) => syncReviewRows(extractedEntries, current));
  }, [extractedEntries, syncReviewRows]);

  const updateField = useCallback(
    (rowIndex: number, field: keyof ExtractedFuelEntry, value: string | number | null) => {
      const nextValue =
        field === 'fuelType' && typeof value === 'string' && value.trim() ? normalizeFuelType(value) : value;

      setExtractedEntries((current) =>
        current.map((entry, index) => {
          if (index !== rowIndex) return entry;

          return {
            ...entry,
            [field]: {
              value: nextValue,
              confidence: 'high',
            },
          } as ExtractedFuelEntry;
        }),
      );
    },
    [],
  );

  const updateRowSelection = useCallback(
    (
      rowIndex: number,
      field: 'selectedVendorId' | 'selectedTruckId' | 'selectedDriverId' | 'selectedCarrierId',
      value?: string,
    ) => {
      setReviewRows((current) => {
        const next = current.map((row, index) => {
          if (index !== rowIndex) return row;

          if (field === 'selectedDriverId') {
            return {
              ...row,
              selectedDriverId: value as Id<'drivers'> | undefined,
              selectedCarrierId: undefined,
            };
          }

          if (field === 'selectedCarrierId') {
            return {
              ...row,
              selectedCarrierId: value as Id<'carrierPartnerships'> | undefined,
              selectedDriverId: undefined,
            };
          }

          return {
            ...row,
            [field]: value,
          } as ReviewRow;
        });

        return syncReviewRows(extractedEntries, next);
      });
    },
    [extractedEntries, syncReviewRows],
  );

  const handleFiles = useCallback(async (files: File[]) => {
    if (files.length === 0) return;

    setIsProcessing(true);

    try {
      const supportedFiles = files.filter(
        (file) =>
          file.type.startsWith('image/') || file.type === 'application/pdf' || file.name.toLowerCase().endsWith('.pdf'),
      );
      if (supportedFiles.length === 0) {
        toast.error('Upload images or PDF receipts/statements');
        return;
      }

      const imageSets = await Promise.all(
        supportedFiles.map(async (file) => {
          if (file.type === 'application/pdf' || file.name.toLowerCase().endsWith('.pdf')) {
            return await renderPdfToImages(file);
          }
          return [{ imageUrl: await fileToDataUrl(file) }];
        }),
      );

      setSelectedFiles(supportedFiles);
      setOcrPages(imageSets.flat());
      setExtractedEntries([]);
      setReviewRows([]);
      setImportResult(null);
      setStep('upload');
      toast.success(`Loaded ${supportedFiles.length} file(s), ${imageSets.flat().length} page(s)`);
    } catch (error) {
      console.error('Failed to prepare files for OCR import:', error);
      toast.error('Could not read one or more files');
    } finally {
      setIsProcessing(false);
    }
  }, []);

  const handleInputChange = useCallback(
    async (e: React.ChangeEvent<HTMLInputElement>) => {
      const files = Array.from(e.target.files ?? []);
      await handleFiles(files);
    },
    [handleFiles],
  );

  const handleDrop = useCallback(
    async (e: React.DragEvent<HTMLDivElement>) => {
      e.preventDefault();
      setDragOver(false);
      await handleFiles(Array.from(e.dataTransfer.files ?? []));
    },
    [handleFiles],
  );

  const handleExtract = useCallback(async () => {
    if (ocrPages.length === 0) {
      toast.error('Upload at least one image or PDF first');
      return;
    }

    setStep('extracting');
    setIsProcessing(true);

    try {
      const result = await extractFuelEntries({
        pages: ocrPages,
        vendorNames: (vendors ?? []).map((vendor) => vendor.name),
      });

      if (result.error && result.entries.length === 0) {
        toast.error(result.error);
        setStep('upload');
        return;
      }

      if (result.error) {
        toast.warning(result.error);
      }

      const typedEntries = result.entries as ExtractedFuelEntry[];
      setExtractedEntries(typedEntries);
      setReviewRows(syncReviewRows(typedEntries));
      setStep('review');
      toast.success(`Extracted ${typedEntries.length} transaction(s)`);
    } catch (error) {
      console.error('OCR extraction failed:', error);
      toast.error('OCR extraction failed');
      setStep('upload');
    } finally {
      setIsProcessing(false);
    }
  }, [extractFuelEntries, ocrPages, syncReviewRows, vendors]);

  const toggleSkip = (index: number) => {
    setReviewRows((current) =>
      current.map((row, rowIndex) => (rowIndex === index ? { ...row, skip: !row.skip } : row)),
    );
  };

  const handleImport = useCallback(async () => {
    if (!organizationId || !user) return;

    const validRows = reviewRows.filter((row) => !row.skip && row.errors.length === 0 && row.selectedVendorId);
    if (validRows.length === 0) {
      toast.error('No valid transactions to import');
      return;
    }

    setIsProcessing(true);

    try {
      const BATCH_SIZE = 50;
      let imported = 0;
      const skipped = reviewRows.length - validRows.length;

      for (let start = 0; start < validRows.length; start += BATCH_SIZE) {
        const batch = validRows.slice(start, start + BATCH_SIZE);
        await bulkCreate({
          organizationId,
          createdBy: user.id,
          entries: batch.map((row): BulkFuelEntryInput => {
            const paymentRaw = row.extracted.paymentMethod?.value?.toString().trim() || '';
            const paymentMethod = paymentRaw
              ? ((PAYMENT_METHOD_MAP[paymentRaw.toLowerCase()] ||
                  (VALID_PAYMENT_METHODS.includes(paymentRaw.toUpperCase()) ? paymentRaw.toUpperCase() : undefined)) as
                  | FuelPaymentMethod
                  | undefined)
              : undefined;

            const city = row.extracted.city?.value?.toString().trim() || '';
            const state = row.extracted.state?.value?.toString().trim() || '';

            return {
              entryDate: tryParseDate(row.extracted.entryDate.value?.toString() || '') || Date.now(),
              vendorId: row.selectedVendorId!,
              gallons: Number(row.extracted.gallons.value),
              pricePerGallon: Number(row.extracted.pricePerGallon.value),
              ...(row.selectedDriverId ? { driverId: row.selectedDriverId } : {}),
              ...(row.selectedCarrierId ? { carrierId: row.selectedCarrierId } : {}),
              ...(row.selectedTruckId ? { truckId: row.selectedTruckId } : {}),
              ...(row.extracted.odometerReading?.value !== null && row.extracted.odometerReading?.value !== undefined
                ? { odometerReading: Number(row.extracted.odometerReading.value) }
                : {}),
              ...(city && state ? { location: { city, state } } : {}),
              ...(row.extracted.fuelCardNumber?.value
                ? { fuelCardNumber: row.extracted.fuelCardNumber.value.toString() }
                : {}),
              ...(row.extracted.receiptNumber?.value
                ? { receiptNumber: row.extracted.receiptNumber.value.toString() }
                : {}),
              ...(paymentMethod ? { paymentMethod } : {}),
              ...(row.extracted.notes?.value ? { notes: row.extracted.notes.value.toString() } : {}),
            };
          }),
        });
        imported += batch.length;
      }

      setImportResult({ imported, skipped });
      toast.success(`Imported ${imported} fuel entr${imported === 1 ? 'y' : 'ies'}`);
    } catch (error) {
      console.error('OCR fuel import failed:', error);
      toast.error('Import failed. Some entries may have been created.');
    } finally {
      setIsProcessing(false);
    }
  }, [bulkCreate, organizationId, reviewRows, user]);

  const validCount = useMemo(
    () => reviewRows.filter((row) => !row.skip && row.errors.length === 0 && row.selectedVendorId).length,
    [reviewRows],
  );
  const errorCount = useMemo(
    () => reviewRows.filter((row) => !row.skip && (row.errors.length > 0 || !row.selectedVendorId)).length,
    [reviewRows],
  );
  const skipCount = useMemo(() => reviewRows.filter((row) => row.skip).length, [reviewRows]);

  return (
    <>
      <header className="sticky top-0 z-40 flex h-16 shrink-0 items-center gap-2 border-b bg-background transition-[width,height] ease-linear group-has-data-[collapsible=icon]/sidebar-wrapper:h-12">
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
                <BreadcrumbPage>OCR Import</BreadcrumbPage>
              </BreadcrumbItem>
            </BreadcrumbList>
          </Breadcrumb>
        </div>
      </header>

      <div className="min-w-0 flex flex-1 flex-col gap-6 p-6">
        <div className="flex flex-col gap-4 sm:flex-row sm:items-start sm:justify-between">
          <div>
            <h1 className="text-3xl font-bold tracking-tight">Import Fuel Entries with OCR</h1>
            <p className="text-muted-foreground">
              Extract diesel purchases from receipts and vendor statements. The OCR prompt is based on the `fuelEntries`
              schema, not a fixed vendor template.
            </p>
          </div>
          <div className="flex flex-wrap gap-2">
            <Button variant="outline" asChild>
              <Link href="/operations/diesel/import">
                <Download className="mr-2 h-4 w-4" />
                CSV Import
              </Link>
            </Button>
            <Button variant="outline" asChild>
              <Link href="/operations/diesel">
                <ArrowLeft className="mr-2 h-4 w-4" />
                Back to Diesel
              </Link>
            </Button>
          </div>
        </div>

        <div className="flex items-center justify-center gap-2">
          {[
            { key: 'upload', label: 'Upload' },
            { key: 'extracting', label: 'Extract' },
            { key: 'review', label: 'Review & Import' },
          ].map((item, index) => {
            const isActive = step === item.key;
            const isComplete =
              (item.key === 'upload' && step !== 'upload') || (item.key === 'extracting' && step === 'review');

            return (
              <div key={item.key} className="flex items-center gap-2">
                <div
                  className={`flex items-center gap-2 rounded-full px-4 py-2 text-sm font-medium ${isActive ? 'bg-primary text-primary-foreground' : isComplete ? 'bg-primary/20 text-primary' : 'bg-muted text-muted-foreground'}`}
                >
                  {isComplete ? (
                    <CheckCircle className="h-4 w-4" />
                  ) : (
                    <span className="flex h-5 w-5 items-center justify-center rounded-full border text-xs">
                      {index + 1}
                    </span>
                  )}
                  <span className="hidden sm:inline">{item.label}</span>
                </div>
                {index < 2 && <div className={`h-px w-8 ${isComplete ? 'bg-primary' : 'bg-muted'}`} />}
              </div>
            );
          })}
        </div>

        {step === 'upload' && (
          <div className="mx-auto w-full max-w-3xl space-y-6">
            <Card
              className={`flex cursor-pointer flex-col items-center justify-center gap-4 border-2 border-dashed p-12 transition-colors ${dragOver ? 'border-primary bg-primary/5' : ocrPages.length > 0 ? 'border-green-500 bg-green-500/5' : 'border-muted-foreground/25 hover:border-muted-foreground/50'}`}
              onClick={() => fileInputRef.current?.click()}
              onDragOver={(e) => {
                e.preventDefault();
                setDragOver(true);
              }}
              onDragLeave={() => setDragOver(false)}
              onDrop={handleDrop}
            >
              <input
                ref={fileInputRef}
                type="file"
                accept="image/*,.pdf,application/pdf"
                multiple
                className="hidden"
                onChange={handleInputChange}
              />
              {ocrPages.length > 0 ? (
                <>
                  <CheckCircle className="h-10 w-10 text-green-500" />
                  <div className="text-center">
                    <p className="font-medium text-green-700 dark:text-green-400">Files loaded successfully</p>
                    <p className="text-sm text-muted-foreground">
                      {selectedFiles.length} file(s), {ocrPages.length} page(s)
                    </p>
                  </div>
                </>
              ) : (
                <>
                  <Upload className="h-10 w-10 text-muted-foreground" />
                  <div className="text-center">
                    <p className="font-medium">Drag receipts or statements here</p>
                    <p className="text-sm text-muted-foreground">Upload images or PDFs from any fuel vendor</p>
                  </div>
                </>
              )}
            </Card>

            {selectedFiles.length > 0 && (
              <Card className="p-4">
                <div className="flex flex-wrap gap-2">
                  {selectedFiles.map((file) => (
                    <Badge key={`${file.name}-${file.lastModified}`} variant="secondary">
                      {file.name}
                    </Badge>
                  ))}
                </div>
              </Card>
            )}

            <Card className="p-5">
              <div className="space-y-2 text-sm text-muted-foreground">
                <p>
                  The OCR flow looks for the fields required by `fuelEntries`: date, vendor, gallons, price per gallon,
                  plus any optional driver, truck, card, receipt, payment, odometer, and location details it can find.
                </p>
                <p>
                  Because vendor layouts vary, missing or fuzzy values stay editable in review instead of being guessed.
                </p>
              </div>
            </Card>

            <div className="flex justify-end">
              <Button onClick={handleExtract} disabled={ocrPages.length === 0 || isProcessing || !vendors}>
                {isProcessing ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : <Upload className="mr-2 h-4 w-4" />}
                Extract Transactions
              </Button>
            </div>
          </div>
        )}

        {step === 'extracting' && (
          <Card className="mx-auto flex w-full max-w-lg flex-col items-center gap-4 p-10 text-center">
            <Loader2 className="h-10 w-10 animate-spin text-primary" />
            <div>
              <h2 className="text-xl font-semibold">Reading receipt data</h2>
              <p className="text-sm text-muted-foreground">
                We are scanning each page for diesel purchase transactions and matching them to the fuel entry schema.
              </p>
            </div>
          </Card>
        )}

        {step === 'review' && (
          <div className="space-y-6">
            {importResult ? (
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
            ) : (
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
                  {skipCount > 0 && <Badge variant="secondary">{skipCount} skipped</Badge>}
                  <Badge variant="outline">{extractedEntries.length} extracted</Badge>
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
                          <TableHead>Assigned To</TableHead>
                          <TableHead>Truck</TableHead>
                          <TableHead>Gallons</TableHead>
                          <TableHead>Price/Gal</TableHead>
                          <TableHead>Total</TableHead>
                          <TableHead className="w-20">Action</TableHead>
                        </TableRow>
                      </TableHeader>
                      <TableBody>
                        {reviewRows.map((row, index) => {
                          const gallons = row.extracted.gallons.value;
                          const pricePerGallon = row.extracted.pricePerGallon.value;
                          const total =
                            row.extracted.totalCost?.value !== null && row.extracted.totalCost?.value !== undefined
                              ? Number(row.extracted.totalCost.value).toFixed(2)
                              : gallons !== null &&
                                  gallons !== undefined &&
                                  pricePerGallon !== null &&
                                  pricePerGallon !== undefined
                                ? (Number(gallons) * Number(pricePerGallon)).toFixed(2)
                                : '0.00';

                          return (
                            <Fragment key={index}>
                              <TableRow key={`main-${index}`} className={row.skip ? 'opacity-40' : ''}>
                                <TableCell className="text-xs text-muted-foreground align-top">{index + 1}</TableCell>
                                <TableCell className="align-top">
                                  {row.skip ? (
                                    <Badge variant="secondary" className="text-xs">
                                      Skipped
                                    </Badge>
                                  ) : row.errors.length > 0 || !row.selectedVendorId ? (
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
                                <TableCell className="align-top">
                                  <Input
                                    value={row.extracted.entryDate.value ?? ''}
                                    onChange={(event) => updateField(index, 'entryDate', event.target.value || null)}
                                    className={getCellInputClass(
                                      row.errors.some((message) => message.includes('Date')),
                                    )}
                                    placeholder="MM/DD/YYYY"
                                  />
                                </TableCell>
                                <TableCell className="align-top">
                                  <div className="w-[180px] space-y-1">
                                    <Select
                                      value={row.selectedVendorId ?? '__none__'}
                                      onValueChange={(value) =>
                                        updateRowSelection(
                                          index,
                                          'selectedVendorId',
                                          value === '__none__' ? undefined : value,
                                        )
                                      }
                                    >
                                      <SelectTrigger className={getCellInputClass(!row.selectedVendorId)}>
                                        <SelectValue placeholder="Select vendor" />
                                      </SelectTrigger>
                                      <SelectContent>
                                        <SelectItem value="__none__">Unassigned</SelectItem>
                                        {(vendors ?? []).map((vendor) => (
                                          <SelectItem key={vendor._id} value={vendor._id}>
                                            {vendor.name}
                                          </SelectItem>
                                        ))}
                                      </SelectContent>
                                    </Select>
                                    {row.extracted.vendorName.value && (
                                      <p className="truncate text-xs text-muted-foreground">
                                        OCR: {row.extracted.vendorName.value}
                                      </p>
                                    )}
                                  </div>
                                </TableCell>
                                <TableCell className="align-top">
                                  <div className="w-[220px] space-y-1">
                                    <Select
                                      value={row.selectedDriverId ?? '__none__'}
                                      onValueChange={(value) =>
                                        updateRowSelection(
                                          index,
                                          'selectedDriverId',
                                          value === '__none__' ? undefined : value,
                                        )
                                      }
                                    >
                                      <SelectTrigger
                                        className={getCellInputClass(
                                          false,
                                          !!row.extracted.driverName?.value && !row.selectedDriverId,
                                        )}
                                      >
                                        <SelectValue placeholder="Driver" />
                                      </SelectTrigger>
                                      <SelectContent>
                                        <SelectItem value="__none__">No driver</SelectItem>
                                        {(drivers ?? [])
                                          .filter((driver) => !driver.isDeleted)
                                          .map((driver) => (
                                            <SelectItem key={driver._id} value={driver._id}>
                                              {driver.firstName} {driver.lastName}
                                            </SelectItem>
                                          ))}
                                      </SelectContent>
                                    </Select>
                                    <Select
                                      value={row.selectedCarrierId ?? '__none__'}
                                      onValueChange={(value) =>
                                        updateRowSelection(
                                          index,
                                          'selectedCarrierId',
                                          value === '__none__' ? undefined : value,
                                        )
                                      }
                                    >
                                      <SelectTrigger
                                        className={getCellInputClass(
                                          false,
                                          !!row.extracted.carrierName?.value && !row.selectedCarrierId,
                                        )}
                                      >
                                        <SelectValue placeholder="Carrier" />
                                      </SelectTrigger>
                                      <SelectContent>
                                        <SelectItem value="__none__">No carrier</SelectItem>
                                        {carriers.map((carrier) => (
                                          <SelectItem key={carrier._id} value={carrier._id}>
                                            {carrier.carrierName}
                                          </SelectItem>
                                        ))}
                                      </SelectContent>
                                    </Select>
                                    {(row.extracted.driverName?.value || row.extracted.carrierName?.value) && (
                                      <p className="truncate text-xs text-muted-foreground">
                                        OCR: {row.extracted.driverName?.value || row.extracted.carrierName?.value}
                                      </p>
                                    )}
                                  </div>
                                </TableCell>
                                <TableCell className="align-top">
                                  <div className="w-[140px] space-y-1">
                                    <Select
                                      value={row.selectedTruckId ?? '__none__'}
                                      onValueChange={(value) =>
                                        updateRowSelection(
                                          index,
                                          'selectedTruckId',
                                          value === '__none__' ? undefined : value,
                                        )
                                      }
                                    >
                                      <SelectTrigger
                                        className={getCellInputClass(
                                          false,
                                          !!row.extracted.truckUnit?.value && !row.selectedTruckId,
                                        )}
                                      >
                                        <SelectValue placeholder="Truck" />
                                      </SelectTrigger>
                                      <SelectContent>
                                        <SelectItem value="__none__">Unassigned</SelectItem>
                                        {(trucks ?? [])
                                          .filter((truck) => !truck.isDeleted)
                                          .map((truck) => (
                                            <SelectItem key={truck._id} value={truck._id}>
                                              {truck.unitId}
                                            </SelectItem>
                                          ))}
                                      </SelectContent>
                                    </Select>
                                    {row.extracted.truckUnit?.value && (
                                      <p className="truncate text-xs text-muted-foreground">
                                        OCR: {row.extracted.truckUnit.value}
                                      </p>
                                    )}
                                  </div>
                                </TableCell>
                                <TableCell className="align-top">
                                  <Input
                                    type="number"
                                    step="0.001"
                                    min="0"
                                    value={row.extracted.gallons.value ?? ''}
                                    onChange={(event) => updateField(index, 'gallons', event.target.value || null)}
                                    className={getCellInputClass(
                                      row.errors.some((message) => message.includes('Gallons')),
                                    )}
                                    placeholder="0.000"
                                  />
                                </TableCell>
                                <TableCell className="align-top">
                                  <Input
                                    type="number"
                                    step="0.001"
                                    min="0"
                                    value={row.extracted.pricePerGallon.value ?? ''}
                                    onChange={(event) =>
                                      updateField(index, 'pricePerGallon', event.target.value || null)
                                    }
                                    className={getCellInputClass(
                                      row.errors.some((message) => message.includes('price')),
                                    )}
                                    placeholder="0.000"
                                  />
                                </TableCell>
                                <TableCell className="align-top">
                                  <Input
                                    type="number"
                                    step="0.01"
                                    min="0"
                                    value={row.extracted.totalCost?.value ?? total}
                                    onChange={(event) => updateField(index, 'totalCost', event.target.value || null)}
                                    className={getCellInputClass(
                                      false,
                                      row.warnings.some((message) => message.includes('Total')),
                                    )}
                                    placeholder="0.00"
                                  />
                                </TableCell>
                                <TableCell className="align-top">
                                  <Button
                                    variant="ghost"
                                    size="sm"
                                    className="text-xs"
                                    onClick={() => toggleSkip(index)}
                                  >
                                    {row.skip ? 'Include' : 'Skip'}
                                  </Button>
                                </TableCell>
                              </TableRow>
                              <TableRow key={`details-${index}`} className={row.skip ? 'opacity-40' : ''}>
                                <TableCell colSpan={10} className="bg-muted/20 py-4">
                                  <div className="grid gap-4 lg:grid-cols-[1.3fr_1fr_1fr_1fr_1fr]">
                                    <div className="space-y-3">
                                      <div className="grid gap-3 sm:grid-cols-2">
                                        <div className="space-y-1">
                                          <p className="text-xs font-medium text-muted-foreground">City</p>
                                          <Input
                                            value={row.extracted.city?.value ?? ''}
                                            onChange={(event) => updateField(index, 'city', event.target.value || null)}
                                            className="h-8"
                                            placeholder="City"
                                          />
                                        </div>
                                        <div className="space-y-1">
                                          <p className="text-xs font-medium text-muted-foreground">State</p>
                                          <Input
                                            value={row.extracted.state?.value ?? ''}
                                            onChange={(event) =>
                                              updateField(index, 'state', event.target.value || null)
                                            }
                                            className="h-8"
                                            placeholder="ST"
                                          />
                                        </div>
                                      </div>
                                      <div className="grid gap-3 sm:grid-cols-2">
                                        <div className="space-y-1">
                                          <p className="text-xs font-medium text-muted-foreground">Receipt Number</p>
                                          <Input
                                            value={row.extracted.receiptNumber?.value ?? ''}
                                            onChange={(event) =>
                                              updateField(index, 'receiptNumber', event.target.value || null)
                                            }
                                            className="h-8"
                                            placeholder="Receipt #"
                                          />
                                        </div>
                                        <div className="space-y-1">
                                          <p className="text-xs font-medium text-muted-foreground">Fuel Card</p>
                                          <Input
                                            value={row.extracted.fuelCardNumber?.value ?? ''}
                                            onChange={(event) =>
                                              updateField(index, 'fuelCardNumber', event.target.value || null)
                                            }
                                            className="h-8"
                                            placeholder="Card number"
                                          />
                                        </div>
                                      </div>
                                    </div>
                                    <div className="space-y-3">
                                      <div className="space-y-1">
                                        <p className="text-xs font-medium text-muted-foreground">Entry Type</p>
                                        <Select
                                          value={
                                            row.extracted.fuelType?.value
                                              ? normalizeFuelType(row.extracted.fuelType.value.toString())
                                              : '__none__'
                                          }
                                          onValueChange={(value) =>
                                            updateField(index, 'fuelType', value === '__none__' ? null : value)
                                          }
                                        >
                                          <SelectTrigger
                                            className={getCellInputClass(
                                              row.errors.some((message) => message.includes('Fuel type')),
                                              row.warnings.some((message) => message.includes('Fuel type missing')),
                                            )}
                                          >
                                            <SelectValue placeholder="Select type" />
                                          </SelectTrigger>
                                          <SelectContent>
                                            <SelectItem value="__none__">Unassigned</SelectItem>
                                            {(['FUEL', 'DEF', 'OTHER'] as FuelCategory[]).map((type) => (
                                              <SelectItem key={type} value={type}>
                                                {formatFuelCategoryLabel(type)}
                                              </SelectItem>
                                            ))}
                                          </SelectContent>
                                        </Select>
                                        {row.extracted.fuelType?.value && (
                                          <p className="text-xs text-muted-foreground">
                                            Normalized: {normalizeFuelType(row.extracted.fuelType.value.toString())}
                                          </p>
                                        )}
                                      </div>
                                      <div className="space-y-1">
                                        <p className="text-xs font-medium text-muted-foreground">Payment Method</p>
                                        <Select
                                          value={row.extracted.paymentMethod?.value ?? '__none__'}
                                          onValueChange={(value) =>
                                            updateField(index, 'paymentMethod', value === '__none__' ? null : value)
                                          }
                                        >
                                          <SelectTrigger className="h-8">
                                            <SelectValue placeholder="Payment" />
                                          </SelectTrigger>
                                          <SelectContent>
                                            <SelectItem value="__none__">None</SelectItem>
                                            {VALID_PAYMENT_METHODS.map((method) => (
                                              <SelectItem key={method} value={method}>
                                                {formatPaymentMethodLabel(method as FuelPaymentMethod)}
                                              </SelectItem>
                                            ))}
                                          </SelectContent>
                                        </Select>
                                      </div>
                                    </div>
                                    <div className="space-y-1">
                                      <p className="text-xs font-medium text-muted-foreground">Odometer</p>
                                      <Input
                                        type="number"
                                        min="0"
                                        value={row.extracted.odometerReading?.value ?? ''}
                                        onChange={(event) =>
                                          updateField(index, 'odometerReading', event.target.value || null)
                                        }
                                        className="h-8"
                                        placeholder="0"
                                      />
                                    </div>
                                    <div className="space-y-1 lg:col-span-2">
                                      <p className="text-xs font-medium text-muted-foreground">Notes</p>
                                      <Input
                                        value={row.extracted.notes?.value ?? ''}
                                        onChange={(event) => updateField(index, 'notes', event.target.value || null)}
                                        className="h-8"
                                        placeholder="Optional notes"
                                      />
                                    </div>
                                    <div className="space-y-1 lg:col-span-5">
                                      <p className="text-xs font-medium text-muted-foreground">Issues</p>
                                      {row.errors.length === 0 && row.warnings.length === 0 ? (
                                        <p className="text-xs text-muted-foreground">No issues detected.</p>
                                      ) : (
                                        <div className="flex flex-wrap gap-2">
                                          {row.errors.map((message, messageIndex) => (
                                            <Badge
                                              key={`error-${messageIndex}`}
                                              variant="destructive"
                                              className="text-xs"
                                            >
                                              {message}
                                            </Badge>
                                          ))}
                                          {row.warnings.map((message, messageIndex) => (
                                            <Badge
                                              key={`warning-${messageIndex}`}
                                              variant="outline"
                                              className="border-yellow-500 text-yellow-700 text-xs"
                                            >
                                              {message}
                                            </Badge>
                                          ))}
                                        </div>
                                      )}
                                    </div>
                                  </div>
                                </TableCell>
                              </TableRow>
                            </Fragment>
                          );
                        })}
                      </TableBody>
                    </Table>
                  </div>
                </Card>

                <div className="flex justify-between">
                  <Button variant="outline" onClick={() => setStep('upload')}>
                    <ArrowLeft className="mr-2 h-4 w-4" />
                    Back
                  </Button>
                  <Button onClick={handleImport} disabled={isProcessing || validCount === 0}>
                    {isProcessing ? (
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
