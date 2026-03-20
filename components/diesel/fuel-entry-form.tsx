'use client';

import { useState, useCallback, useMemo } from 'react';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Textarea } from '@/components/ui/textarea';
import { DatePicker } from '@/components/ui/date-picker';
import { Loader2, Upload, X } from 'lucide-react';

export interface FuelEntryFormData {
  entryDate: number;
  driverId?: string;
  carrierId?: string;
  truckId?: string;
  vendorId: string;
  gallons: number;
  pricePerGallon: number;
  odometerReading?: number;
  location?: { city: string; state: string };
  fuelCardNumber?: string;
  receiptNumber?: string;
  loadId?: string;
  paymentMethod?: string;
  notes?: string;
  receiptStorageId?: string;
}

interface FuelEntryFormProps {
  entryType: 'fuel' | 'def';
  initialData?: {
    entryDate?: number;
    driverId?: string;
    carrierId?: string;
    truckId?: string;
    vendorId?: string;
    gallons?: number;
    pricePerGallon?: number;
    odometerReading?: number;
    location?: { city: string; state: string };
    fuelCardNumber?: string;
    receiptNumber?: string;
    loadId?: string;
    paymentMethod?: string;
    notes?: string;
    receiptStorageId?: string;
    receiptUrl?: string;
  };
  drivers: Array<{ _id: string; firstName: string; lastName: string }>;
  carriers: Array<{ _id: string; carrierName: string; trackFuelConsumption?: boolean }>;
  trucks: Array<{
    _id: string;
    unitId: string;
    make?: string;
    model?: string;
  }>;
  vendors: Array<{ _id: string; name: string }>;
  onSubmit: (data: FuelEntryFormData, options?: { continueAdding?: boolean }) => Promise<void>;
  onCancel: () => void;
  isSubmitting: boolean;
  generateUploadUrl: () => Promise<string>;
}

const PAYMENT_METHODS = [
  { value: 'FUEL_CARD', label: 'Fuel Card' },
  { value: 'CASH', label: 'Cash' },
  { value: 'CHECK', label: 'Check' },
  { value: 'CREDIT_CARD', label: 'Credit Card' },
  { value: 'EFS', label: 'EFS' },
  { value: 'COMDATA', label: 'Comdata' },
];

export function FuelEntryForm({
  entryType,
  initialData,
  drivers,
  carriers,
  trucks,
  vendors,
  onSubmit,
  onCancel,
  isSubmitting,
  generateUploadUrl,
}: FuelEntryFormProps) {
  const isEditing = !!initialData;
  const typeLabel = entryType === 'fuel' ? 'Fuel' : 'DEF';
  const title = isEditing ? `Edit ${typeLabel} Entry` : `New ${typeLabel} Entry`;

  const [entryDate, setEntryDate] = useState<Date | undefined>(
    initialData?.entryDate ? new Date(initialData.entryDate) : new Date(),
  );
  const [vendorId, setVendorId] = useState(initialData?.vendorId ?? '');
  const [gallons, setGallons] = useState(initialData?.gallons?.toString() ?? '');
  const [pricePerGallon, setPricePerGallon] = useState(initialData?.pricePerGallon?.toString() ?? '');
  const [driverId, setDriverId] = useState(initialData?.driverId ?? '');
  const [carrierId, setCarrierId] = useState(initialData?.carrierId ?? '');
  const [truckId, setTruckId] = useState(initialData?.truckId ?? '');
  const [loadId, setLoadId] = useState(initialData?.loadId ?? '');
  const [odometerReading, setOdometerReading] = useState(initialData?.odometerReading?.toString() ?? '');
  const [city, setCity] = useState(initialData?.location?.city ?? '');
  const [state, setState] = useState(initialData?.location?.state ?? '');
  const [fuelCardNumber, setFuelCardNumber] = useState(initialData?.fuelCardNumber ?? '');
  const [receiptNumber, setReceiptNumber] = useState(initialData?.receiptNumber ?? '');
  const [paymentMethod, setPaymentMethod] = useState(initialData?.paymentMethod ?? '');
  const [notes, setNotes] = useState(initialData?.notes ?? '');

  const [receiptStorageId, setReceiptStorageId] = useState(initialData?.receiptStorageId ?? '');
  const [receiptPreviewUrl, setReceiptPreviewUrl] = useState(initialData?.receiptUrl ?? '');
  const [isUploading, setIsUploading] = useState(false);
  const [isDragOver, setIsDragOver] = useState(false);

  const resetForm = useCallback(() => {
    setEntryDate(new Date());
    setVendorId('');
    setGallons('');
    setPricePerGallon('');
    setDriverId('');
    setCarrierId('');
    setTruckId('');
    setLoadId('');
    setOdometerReading('');
    setCity('');
    setState('');
    setFuelCardNumber('');
    setReceiptNumber('');
    setPaymentMethod('');
    setNotes('');
    setReceiptStorageId('');
    setReceiptPreviewUrl('');
    setIsDragOver(false);
  }, []);

  const totalCost = useMemo(() => {
    const g = parseFloat(gallons);
    const p = parseFloat(pricePerGallon);
    if (!isNaN(g) && !isNaN(p)) {
      return (g * p).toFixed(2);
    }
    return '0.00';
  }, [gallons, pricePerGallon]);

  const handleFileUpload = useCallback(
    async (file: File) => {
      if (!file.type.startsWith('image/')) return;
      setIsUploading(true);
      try {
        const uploadUrl = await generateUploadUrl();
        const result = await fetch(uploadUrl, {
          method: 'POST',
          headers: { 'Content-Type': file.type },
          body: file,
        });
        const { storageId } = await result.json();
        setReceiptStorageId(storageId);
        setReceiptPreviewUrl(URL.createObjectURL(file));
      } catch (err) {
        console.error('Receipt upload failed:', err);
      } finally {
        setIsUploading(false);
      }
    },
    [generateUploadUrl],
  );

  const handleDrop = useCallback(
    (e: React.DragEvent) => {
      e.preventDefault();
      setIsDragOver(false);
      const file = e.dataTransfer.files[0];
      if (file) handleFileUpload(file);
    },
    [handleFileUpload],
  );

  const handleRemoveReceipt = () => {
    setReceiptStorageId('');
    setReceiptPreviewUrl('');
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();

    const g = parseFloat(gallons);
    const p = parseFloat(pricePerGallon);
    if (!vendorId || isNaN(g) || isNaN(p)) return;

    const data: FuelEntryFormData = {
      entryDate: entryDate ? entryDate.getTime() : Date.now(),
      vendorId,
      gallons: g,
      pricePerGallon: p,
      ...(driverId && { driverId }),
      ...(carrierId && { carrierId }),
      ...(truckId && { truckId }),
      ...(loadId && { loadId }),
      ...(odometerReading && { odometerReading: parseFloat(odometerReading) }),
      ...((city || state) && {
        location: { city, state },
      }),
      ...(fuelCardNumber && { fuelCardNumber }),
      ...(receiptNumber && { receiptNumber }),
      ...(paymentMethod && { paymentMethod }),
      ...(notes && { notes }),
      ...(receiptStorageId && { receiptStorageId }),
    };

    const nativeEvent = e.nativeEvent as SubmitEvent;
    const submitter = nativeEvent.submitter as HTMLButtonElement | null;
    const continueAdding = submitter?.value === 'continue';

    await onSubmit(data, { continueAdding });

    if (continueAdding && !isEditing) {
      resetForm();
    }
  };

  return (
    <>
      <form id="fuel-entry-form" onSubmit={handleSubmit} className="space-y-6 pb-24">
        <div>
          <h1 className="text-3xl font-bold tracking-tight">{title}</h1>
          <p className="text-muted-foreground">
            {isEditing
              ? `Update the ${typeLabel.toLowerCase()} entry details below.`
              : `Enter the ${typeLabel.toLowerCase()} purchase details below.`}
          </p>
        </div>

        {/* Card 1: Purchase Information */}
        <Card className="p-6 shadow-sm">
          <h2 className="text-xl font-semibold mb-4">Purchase Information</h2>
          <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
            <div className="space-y-2">
              <Label htmlFor="entryDate" className="text-destructive">
                Entry Date
              </Label>
              <DatePicker id="entryDate" name="entryDate" value={entryDate} onChange={setEntryDate} required />
            </div>

            <div className="space-y-2">
              <Label htmlFor="vendor" className={vendorId ? 'text-foreground' : 'text-destructive'}>
                Vendor
              </Label>
              <Select value={vendorId} onValueChange={setVendorId}>
                <SelectTrigger className="w-full">
                  <SelectValue placeholder="Select a vendor..." />
                </SelectTrigger>
                <SelectContent>
                  {vendors.map((v) => (
                    <SelectItem key={v._id} value={v._id}>
                      {v.name}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>

            <div className="group/field space-y-2">
              <Label htmlFor="gallons" className="text-destructive group-has-[:valid]/field:text-foreground">
                Gallons
              </Label>
              <Input
                id="gallons"
                type="number"
                step="0.001"
                min="0"
                value={gallons}
                onChange={(e) => setGallons(e.target.value)}
                placeholder="0.000"
                required
              />
            </div>

            <div className="group/field space-y-2">
              <Label htmlFor="pricePerGallon" className="text-destructive group-has-[:valid]/field:text-foreground">
                Price Per Gallon
              </Label>
              <div className="relative">
                <span className="absolute left-3 top-1/2 -translate-y-1/2 text-muted-foreground text-sm">$</span>
                <Input
                  id="pricePerGallon"
                  type="number"
                  step="0.001"
                  min="0"
                  className="pl-7"
                  value={pricePerGallon}
                  onChange={(e) => setPricePerGallon(e.target.value)}
                  placeholder="0.000"
                  required
                />
              </div>
            </div>

            <div className="space-y-2">
              <Label>Total Cost</Label>
              <div className="flex h-9 items-center rounded-md border bg-muted/50 px-3 text-sm font-medium">
                ${totalCost}
              </div>
            </div>
          </div>
        </Card>

        {/* Card 2: Assignment */}
        <Card className="p-6 shadow-sm">
          <h2 className="text-xl font-semibold mb-4">Assignment</h2>
          <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-4">
            <div className="space-y-2">
              <Label htmlFor="driver">Driver</Label>
              <Select value={driverId} onValueChange={setDriverId}>
                <SelectTrigger className="w-full">
                  <SelectValue placeholder="Select a driver..." />
                </SelectTrigger>
                <SelectContent>
                  {drivers.map((d) => (
                    <SelectItem key={d._id} value={d._id}>
                      {d.firstName} {d.lastName}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>

            <div className="space-y-2">
              <Label htmlFor="carrier">Carrier</Label>
              <Select value={carrierId} onValueChange={setCarrierId}>
                <SelectTrigger className="w-full">
                  <SelectValue placeholder="Select a carrier..." />
                </SelectTrigger>
                <SelectContent>
                  {[...carriers]
                    .sort((a, b) => {
                      if (a.trackFuelConsumption && !b.trackFuelConsumption) return -1;
                      if (!a.trackFuelConsumption && b.trackFuelConsumption) return 1;
                      return a.carrierName.localeCompare(b.carrierName);
                    })
                    .map((c) => (
                      <SelectItem key={c._id} value={c._id}>
                        {c.carrierName}
                        {c.trackFuelConsumption ? ' ✓' : ''}
                      </SelectItem>
                    ))}
                </SelectContent>
              </Select>
              {carriers.length === 0 && (
                <p className="text-xs text-muted-foreground">
                  No carriers available. Add carriers in Operations &gt; Carriers.
                </p>
              )}
            </div>

            <div className="space-y-2">
              <Label htmlFor="truck">Truck</Label>
              <Select value={truckId} onValueChange={setTruckId}>
                <SelectTrigger className="w-full">
                  <SelectValue placeholder="Select a truck..." />
                </SelectTrigger>
                <SelectContent>
                  {trucks.map((t) => (
                    <SelectItem key={t._id} value={t._id}>
                      {t.unitId}
                      {t.make || t.model ? ` — ${[t.make, t.model].filter(Boolean).join(' ')}` : ''}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>

            <div className="space-y-2">
              <Label htmlFor="loadId">Load Reference</Label>
              <Input
                id="loadId"
                value={loadId}
                onChange={(e) => setLoadId(e.target.value)}
                placeholder="e.g., LOAD-001"
              />
            </div>
          </div>
        </Card>

        {/* Card 3: Details */}
        <Card className="p-6 shadow-sm">
          <h2 className="text-xl font-semibold mb-4">Details</h2>
          <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
            <div className="space-y-2">
              <Label htmlFor="odometerReading">Odometer Reading</Label>
              <Input
                id="odometerReading"
                type="number"
                min="0"
                value={odometerReading}
                onChange={(e) => setOdometerReading(e.target.value)}
                placeholder="0"
              />
            </div>

            <div className="space-y-2">
              <Label htmlFor="city">Location City</Label>
              <Input id="city" value={city} onChange={(e) => setCity(e.target.value)} placeholder="City" />
            </div>

            <div className="space-y-2">
              <Label htmlFor="state">Location State</Label>
              <Input id="state" value={state} onChange={(e) => setState(e.target.value)} placeholder="State" />
            </div>

            <div className="space-y-2">
              <Label htmlFor="fuelCardNumber">Fuel Card Number</Label>
              <Input
                id="fuelCardNumber"
                value={fuelCardNumber}
                onChange={(e) => setFuelCardNumber(e.target.value)}
                placeholder="Card number"
              />
            </div>

            <div className="space-y-2">
              <Label htmlFor="receiptNumber">Receipt Number</Label>
              <Input
                id="receiptNumber"
                value={receiptNumber}
                onChange={(e) => setReceiptNumber(e.target.value)}
                placeholder="Receipt #"
              />
            </div>

            <div className="space-y-2">
              <Label htmlFor="paymentMethod">Payment Method</Label>
              <Select value={paymentMethod} onValueChange={setPaymentMethod}>
                <SelectTrigger className="w-full">
                  <SelectValue placeholder="Select method..." />
                </SelectTrigger>
                <SelectContent>
                  {PAYMENT_METHODS.map((pm) => (
                    <SelectItem key={pm.value} value={pm.value}>
                      {pm.label}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
          </div>
        </Card>

        {/* Card 4: Notes & Receipt */}
        <Card className="p-6 shadow-sm">
          <h2 className="text-xl font-semibold mb-4">Notes &amp; Receipt</h2>
          <div className="space-y-4">
            <div className="space-y-2">
              <Label htmlFor="notes">Notes</Label>
              <Textarea
                id="notes"
                value={notes}
                onChange={(e) => setNotes(e.target.value)}
                placeholder="Any additional notes..."
                rows={3}
              />
            </div>

            <div className="space-y-2">
              <Label>Receipt Image</Label>
              {receiptPreviewUrl ? (
                <div className="relative inline-block">
                  <img
                    src={receiptPreviewUrl}
                    alt="Receipt preview"
                    className="max-h-48 rounded-md border object-contain"
                  />
                  <Button
                    type="button"
                    variant="destructive"
                    size="icon"
                    className="absolute -top-2 -right-2 h-6 w-6"
                    onClick={handleRemoveReceipt}
                  >
                    <X className="h-3 w-3" />
                  </Button>
                </div>
              ) : (
                <div
                  onDragOver={(e) => {
                    e.preventDefault();
                    setIsDragOver(true);
                  }}
                  onDragLeave={() => setIsDragOver(false)}
                  onDrop={handleDrop}
                  className={`flex flex-col items-center justify-center rounded-md border-2 border-dashed p-8 transition-colors ${
                    isDragOver
                      ? 'border-primary bg-primary/5'
                      : 'border-muted-foreground/25 hover:border-muted-foreground/50'
                  }`}
                >
                  {isUploading ? (
                    <Loader2 className="h-8 w-8 animate-spin text-muted-foreground" />
                  ) : (
                    <>
                      <Upload className="h-8 w-8 text-muted-foreground mb-2" />
                      <p className="text-sm text-muted-foreground mb-1">Drag &amp; drop a receipt image here, or</p>
                      <label className="cursor-pointer">
                        <span className="text-sm font-medium text-primary hover:underline">browse files</span>
                        <input
                          type="file"
                          accept="image/*"
                          className="hidden"
                          onChange={(e) => {
                            const file = e.target.files?.[0];
                            if (file) handleFileUpload(file);
                          }}
                        />
                      </label>
                    </>
                  )}
                </div>
              )}
            </div>
          </div>
        </Card>
      </form>

      <div className="sticky bottom-0 left-0 right-0 z-50 border-t bg-background/95 backdrop-blur supports-[backdrop-filter]:bg-background/60 mt-auto">
        <div className="flex h-16 items-center justify-end gap-4 px-6">
          <Button type="button" variant="outline" onClick={onCancel} disabled={isSubmitting}>
            Cancel
          </Button>
          <Button type="submit" form="fuel-entry-form" disabled={isSubmitting || !vendorId}>
            {isSubmitting ? (
              <>
                <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                {isEditing ? 'Saving...' : 'Creating...'}
              </>
            ) : isEditing ? (
              `Save ${typeLabel} Entry`
            ) : (
              `Create ${typeLabel} Entry`
            )}
          </Button>
          {!isEditing && (
            <Button
              type="submit"
              form="fuel-entry-form"
              name="submissionMode"
              value="continue"
              variant="secondary"
              disabled={isSubmitting || !vendorId}
            >
              {isSubmitting ? (
                <>
                  <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                  Saving...
                </>
              ) : (
                'Save & Continue'
              )}
            </Button>
          )}
        </div>
      </div>
    </>
  );
}
