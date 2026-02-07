'use client';

import { useRef, type ChangeEvent } from 'react';
import { Button } from '@/components/ui/button';
import { Label } from '@/components/ui/label';
import { Badge } from '@/components/ui/badge';
import { Card } from '@/components/ui/card';
import { FileText, Upload, MapPin, Truck, User, Package } from 'lucide-react';
import { cn } from '@/lib/utils';

interface LoadStop {
  sequenceNumber: number;
  stopType: 'PICKUP' | 'DELIVERY';
  city?: string;
  state?: string;
  windowBeginTime?: string;
}

interface SelectedLoad {
  _id: string;
  internalId: string;
  orderNumber: string;
  customerName?: string;
  parsedHcr?: string;
  parsedTripNumber?: string;
  status: string;
  trackingStatus?: string;
  contractRate?: number;
  contractMiles?: number;
  effectiveMiles?: number;
  importedMiles?: number;
  stops: LoadStop[];
  assignedDriver?: {
    _id: string;
    name: string;
    phone?: string;
  } | null;
  assignedTruck?: {
    _id: string;
    unitId: string;
    bodyType?: string;
  } | null;
  assignedTrailer?: {
    _id: string;
    unitId: string;
    trailerType?: string;
  } | null;
  podStorageId?: string;
  podUrl?: string;
}

interface EvidencePanelProps {
  selectedLoad?: SelectedLoad | null;
  onUploadPOD?: (loadId: string) => void;
  extraDocs?: Array<{
    _id: string;
    url: string;
    fileName?: string;
    uploadedAt: number;
  }>;
  onUploadExtraDocs?: (files: FileList) => void;
  isUploadingExtraDocs?: boolean;
  isLocked?: boolean; // Hide upload buttons when PAID
}

export function EvidencePanel({
  selectedLoad,
  onUploadPOD,
  extraDocs = [],
  onUploadExtraDocs,
  isUploadingExtraDocs = false,
  isLocked = false,
}: EvidencePanelProps) {
  const extraDocsInputRef = useRef<HTMLInputElement>(null);

  const handleExtraDocsClick = () => {
    extraDocsInputRef.current?.click();
  };

  const handleExtraDocsChange = (event: ChangeEvent<HTMLInputElement>) => {
    const files = event.target.files;
    if (files && files.length > 0) {
      onUploadExtraDocs?.(files);
    }
    event.target.value = '';
  };
  const formatTime = (isoString: string) => {
    try {
      return new Date(isoString).toLocaleString('en-US', {
        month: 'short',
        day: 'numeric',
        hour: 'numeric',
        minute: '2-digit',
      });
    } catch {
      return isoString;
    }
  };

  if (!selectedLoad) {
    return (
      <div className="flex flex-col items-center justify-center h-full min-h-[200px] p-6">
        <FileText className="w-8 h-8 mb-2 text-slate-300" />
        <p className="text-[11px] text-slate-400 font-medium">Select a load</p>
        <p className="text-[10px] text-slate-300 mt-0.5">View POD & mileage</p>
      </div>
    );
  }

  const formatCurrency = (amount: number) => {
    return new Intl.NumberFormat('en-US', {
      style: 'currency',
      currency: 'USD',
      minimumFractionDigits: 2,
    }).format(amount);
  };

  return (
    <div className="flex flex-col h-full overflow-auto">
      {/* Header - Tightened */}
      <div className="p-3 border-b shrink-0 bg-slate-50/50">
        <div className="flex items-start justify-between mb-1.5">
          <div>
            <h3 className="text-[11px] font-bold font-mono text-slate-800">{selectedLoad.internalId}</h3>
            <p className="text-[10px] text-muted-foreground">{selectedLoad.orderNumber}</p>
          </div>
          <Badge variant="outline" className="text-[9px] h-5">
            {selectedLoad.status}
          </Badge>
        </div>
        
        {/* Customer & Revenue */}
        {selectedLoad.customerName && (
          <div className="mt-2 pt-2 border-t">
            <div className="flex items-center gap-1.5 text-[10px] text-muted-foreground mb-0.5">
              <Package className="w-2.5 h-2.5" />
              <span className="font-medium">Customer</span>
            </div>
            <p className="text-[11px] font-medium">{selectedLoad.customerName}</p>
            {(selectedLoad.parsedHcr || selectedLoad.parsedTripNumber) && (
              <div className="mt-1 flex items-center gap-2 text-[10px] text-muted-foreground">
                {selectedLoad.parsedHcr && (
                  <div className="flex items-center gap-0.5">
                    <span className="font-medium">HCR:</span>
                    <span className="font-mono">{selectedLoad.parsedHcr}</span>
                  </div>
                )}
                {selectedLoad.parsedTripNumber && (
                  <div className="flex items-center gap-0.5">
                    <span className="font-medium">Trip:</span>
                    <span className="font-mono">{selectedLoad.parsedTripNumber}</span>
                  </div>
                )}
              </div>
            )}
          </div>
        )}
        
        {selectedLoad.contractRate && (
          <div className="mt-1.5 flex items-center justify-between text-[11px]">
            <span className="text-muted-foreground">Revenue:</span>
            <span className="font-semibold text-green-700 tabular-nums">
              {formatCurrency(selectedLoad.contractRate)}
            </span>
          </div>
        )}
      </div>

      {/* Driver & Equipment - Tightened */}
      {(selectedLoad.assignedDriver || selectedLoad.assignedTruck || selectedLoad.assignedTrailer) && (
        <div className="p-3 border-b shrink-0 space-y-2">
          {selectedLoad.assignedDriver && (
            <div>
              <div className="flex items-center gap-1.5 text-[10px] text-muted-foreground mb-0.5">
                <User className="w-2.5 h-2.5" />
                <span className="font-medium">Driver</span>
              </div>
              <p className="text-[11px] font-medium">{selectedLoad.assignedDriver.name}</p>
              {selectedLoad.assignedDriver.phone && (
                <p className="text-[10px] text-muted-foreground">{selectedLoad.assignedDriver.phone}</p>
              )}
            </div>
          )}
          
          {(selectedLoad.assignedTruck || selectedLoad.assignedTrailer) && (
            <div>
              <div className="flex items-center gap-1.5 text-[10px] text-muted-foreground mb-0.5">
                <Truck className="w-2.5 h-2.5" />
                <span className="font-medium">Equipment</span>
              </div>
              <div className="space-y-0.5">
                {selectedLoad.assignedTruck && (
                  <div className="flex items-center justify-between text-[11px]">
                    <span className="text-muted-foreground">Truck:</span>
                    <span className="font-mono font-medium">{selectedLoad.assignedTruck.unitId}</span>
                  </div>
                )}
                {selectedLoad.assignedTrailer && (
                  <div className="flex items-center justify-between text-[11px]">
                    <span className="text-muted-foreground">Trailer:</span>
                    <span className="font-mono font-medium">{selectedLoad.assignedTrailer.unitId}</span>
                  </div>
                )}
              </div>
            </div>
          )}
        </div>
      )}

      {/* Stops Timeline - Tightened */}
      <div className="p-3 border-b shrink-0">
        <Label className="text-[10px] font-semibold uppercase tracking-wide text-slate-500">
          Stops ({selectedLoad.stops.length})
        </Label>
        <div className="mt-2 space-y-2">
          {selectedLoad.stops.map((stop, index) => (
            <div key={index} className="flex items-start gap-2">
              <div className={cn(
                "w-5 h-5 rounded-full flex items-center justify-center text-[10px] font-semibold shrink-0",
                stop.stopType === 'PICKUP' 
                  ? "bg-blue-100 text-blue-700" 
                  : "bg-green-100 text-green-700"
              )}>
                {index + 1}
              </div>
              <div className="flex-1 min-w-0">
                <div className="flex items-center gap-1">
                  <MapPin className="w-2.5 h-2.5 text-muted-foreground shrink-0" />
                  <p className="text-[11px] font-medium truncate">
                    {[stop.city, stop.state].filter(Boolean).join(', ') || 'Location unavailable'}
                  </p>
                  <Badge variant="outline" className="text-[8px] px-1 py-0 h-3.5 ml-1">
                    {stop.stopType}
                  </Badge>
                </div>
                <p className="text-[9px] text-muted-foreground mt-0.5">
                  {stop.windowBeginTime ? formatTime(stop.windowBeginTime) : 'Time TBD'}
                </p>
              </div>
            </div>
          ))}
        </div>
      </div>

      {/* POD Section - Tightened */}
      <div className="p-3 border-b shrink-0">
        <Label className="text-[10px] font-semibold uppercase tracking-wide text-slate-500">
          Proof of Delivery
        </Label>
        {selectedLoad.podStorageId && selectedLoad.podUrl ? (
          <Card className="mt-2 overflow-hidden border">
            <img 
              src={selectedLoad.podUrl} 
              alt="POD" 
              className="w-full h-auto"
            />
          </Card>
        ) : isLocked ? (
          <div className="mt-2 p-3 bg-slate-50 rounded border border-dashed border-slate-200">
            <p className="text-[10px] text-slate-400 text-center">No POD on file</p>
          </div>
        ) : (
          <div className="mt-2">
            <Button
              variant="outline"
              size="sm"
              className="w-full h-7 text-[11px] text-blue-600 border-blue-300 hover:bg-blue-50 hover:text-blue-700 font-medium"
              onClick={() => onUploadPOD?.(selectedLoad._id)}
            >
              <Upload className="w-3.5 h-3.5 mr-1.5 text-blue-600" />
              Upload POD
            </Button>
          </div>
        )}
      </div>

      {/* Extra Documentation */}
      <div className="p-3 border-b shrink-0">
        <Label className="text-[10px] font-semibold uppercase tracking-wide text-slate-500">
          Extra Documentation
        </Label>

        {extraDocs.length > 0 ? (
          <div className="mt-2 grid grid-cols-2 gap-2">
            {extraDocs.map((doc) => (
              <a
                key={doc._id}
                href={doc.url}
                target="_blank"
                rel="noreferrer"
                className="block overflow-hidden rounded border bg-white"
                title={doc.fileName || 'Extra documentation'}
              >
                <img
                  src={doc.url}
                  alt={doc.fileName || 'Extra documentation'}
                  className="w-full h-24 object-cover"
                />
              </a>
            ))}
          </div>
        ) : (
          <div className="mt-2 p-3 bg-slate-50 rounded border border-dashed border-slate-200">
            <p className="text-[10px] text-slate-400 text-center">No extra documentation</p>
          </div>
        )}

        {!isLocked && onUploadExtraDocs && (
          <div className="mt-2">
            <input
              ref={extraDocsInputRef}
              type="file"
              accept="image/*"
              multiple
              className="hidden"
              onChange={handleExtraDocsChange}
            />
            <Button
              variant="outline"
              size="sm"
              className="w-full h-7 text-[11px] text-blue-600 border-blue-300 hover:bg-blue-50 hover:text-blue-700 font-medium"
              onClick={handleExtraDocsClick}
              disabled={isUploadingExtraDocs}
            >
              <Upload className="w-3.5 h-3.5 mr-1.5 text-blue-600" />
              {isUploadingExtraDocs ? 'Uploading...' : 'Upload Extra Documentation'}
            </Button>
          </div>
        )}
      </div>

      {/* Mileage Comparison - Tightened */}
      {(selectedLoad.contractMiles || selectedLoad.effectiveMiles || selectedLoad.importedMiles) && (
        <div className="p-3 shrink-0">
          <Label className="text-[10px] font-semibold uppercase tracking-wide text-slate-500">
            Mileage
          </Label>
          <div className="mt-2 space-y-1.5">
            {selectedLoad.contractMiles && (
              <div className="flex justify-between text-[11px]">
                <span className="text-muted-foreground">Contract:</span>
                <span className="font-mono font-medium tabular-nums">{selectedLoad.contractMiles.toFixed(1)} mi</span>
              </div>
            )}
            {selectedLoad.effectiveMiles && (
              <div className="flex justify-between text-[11px]">
                <span className="text-muted-foreground">Effective:</span>
                <span className={cn(
                  "font-mono font-medium tabular-nums",
                  selectedLoad.importedMiles && Math.abs(selectedLoad.effectiveMiles - selectedLoad.importedMiles) / selectedLoad.effectiveMiles > 0.05
                    ? "text-red-600 font-bold bg-red-50 px-1 rounded"
                    : ""
                )}>
                  {selectedLoad.effectiveMiles.toFixed(1)} mi
                </span>
              </div>
            )}
            {selectedLoad.importedMiles && (
              <div className="flex justify-between text-[11px]">
                <span className="text-muted-foreground">Imported:</span>
                <span className={cn(
                  "font-mono font-medium tabular-nums",
                  selectedLoad.effectiveMiles && Math.abs(selectedLoad.effectiveMiles - selectedLoad.importedMiles) / selectedLoad.effectiveMiles > 0.05
                    ? "text-red-600 font-bold bg-red-50 px-1 rounded"
                    : ""
                )}>
                  {selectedLoad.importedMiles.toFixed(1)} mi
                </span>
              </div>
            )}
            {selectedLoad.effectiveMiles && selectedLoad.importedMiles && (
              (() => {
                const variance = ((selectedLoad.effectiveMiles - selectedLoad.importedMiles) / selectedLoad.effectiveMiles) * 100;
                const hasVariance = Math.abs(variance) > 5;
                return hasVariance ? (
                  <div className={cn(
                    "flex justify-between text-[11px] pt-1.5 mt-1 border-t font-semibold",
                    Math.abs(variance) > 10 ? "text-red-600" : "text-amber-600"
                  )}>
                    <span>Variance:</span>
                    <span className="tabular-nums">{variance > 0 ? '+' : ''}{variance.toFixed(1)}%</span>
                  </div>
                ) : null;
              })()
            )}
            {selectedLoad.contractRate && selectedLoad.effectiveMiles && (
              <div className="flex justify-between text-[11px] pt-1.5 mt-1 border-t">
                <span className="text-muted-foreground">Rate/Mile:</span>
                <span className="font-mono font-medium text-green-700 tabular-nums">
                  {formatCurrency(selectedLoad.contractRate / selectedLoad.effectiveMiles)}
                </span>
              </div>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
