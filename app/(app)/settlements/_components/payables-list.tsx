'use client';

import { useMemo, useState, useRef, useEffect } from 'react';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Input } from '@/components/ui/input';
import { Switch } from '@/components/ui/switch';
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from '@/components/ui/tooltip';
import { AlertTriangle, Paperclip, Pause, Pencil, Trash2, Check, X } from 'lucide-react';
import { Id } from '@/convex/_generated/dataModel';
import { cn } from '@/lib/utils';

interface Payable {
  _id: Id<'loadPayables'>;
  loadId?: Id<'loadInformation'>;
  loadInternalId?: string;
  loadOrderNumber?: string;
  description: string;
  quantity: number;
  rate: number;
  totalAmount: number;
  sourceType: 'SYSTEM' | 'MANUAL';
  isLocked: boolean;
  warningMessage?: string;
  receiptStorageId?: Id<'_storage'>;
  isRebillable?: boolean;
  createdAt: number;
}

interface AuditFlags {
  missingPodLoadIds: Set<string>;
  varianceLoadIds: Set<string>;
  missingReceiptPayableIds?: Set<string>;
}

interface PayablesListProps {
  payables: Payable[];
  onHoldLoad: (loadId: string) => void;
  onViewLoad: (loadId: string) => void;
  onReleaseLoad?: (loadId: string) => void;
  onEditPayable?: (payableId: Id<'loadPayables'>, data: { description: string; quantity: number; rate: number; isRebillable: boolean }) => Promise<void>;
  onDeletePayable?: (payableId: Id<'loadPayables'>) => void;
  isHeldSection?: boolean;
  isDraft?: boolean;
  isLocked?: boolean; // When true (Approved/Paid), hide all interactive elements
  selectedLoadId?: string | null;
  auditFlags?: AuditFlags;
}

// Inline Edit Row Component
function InlineEditRow({
  payable,
  onSave,
  onCancel,
  formatCurrency,
}: {
  payable: Payable;
  onSave: (data: { description: string; quantity: number; rate: number; isRebillable: boolean }) => void;
  onCancel: () => void;
  formatCurrency: (amount: number) => string;
}) {
  const [description, setDescription] = useState(payable.description);
  const [quantity, setQuantity] = useState(payable.quantity.toString());
  const [rate, setRate] = useState(payable.rate.toString());
  const [isRebillable, setIsRebillable] = useState(payable.isRebillable || false);
  const descriptionRef = useRef<HTMLInputElement>(null);

  // Focus description input on mount
  useEffect(() => {
    descriptionRef.current?.focus();
    descriptionRef.current?.select();
  }, []);

  // Calculate total in real-time
  const calculatedTotal = (parseFloat(quantity) || 0) * (parseFloat(rate) || 0);

  // Handle keyboard shortcuts
  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      handleSave();
    } else if (e.key === 'Escape') {
      e.preventDefault();
      onCancel();
    }
  };

  const handleSave = () => {
    const qty = parseFloat(quantity);
    const rateVal = parseFloat(rate);
    
    if (!description.trim() || isNaN(qty) || isNaN(rateVal) || qty <= 0 || rateVal <= 0) {
      return; // Basic validation
    }
    
    onSave({
      description: description.trim(),
      quantity: qty,
      rate: rateVal,
      isRebillable,
    });
  };

  return (
    <div
      className="grid grid-cols-[64px_1fr_80px_90px_100px_56px] min-h-[52px] items-start bg-blue-50/60 border-l-2 border-l-blue-500 transition-all"
      onKeyDown={handleKeyDown}
    >
      {/* Type Badge */}
      <div className="px-3 py-2">
        <Badge className="text-[8px] font-medium h-[14px] px-1.5 bg-indigo-100 text-indigo-700 border-0">
          MANUAL
        </Badge>
      </div>
      
      {/* Description Input + Rebillable Toggle */}
      <div className="px-3 py-1.5 flex flex-col gap-1">
        <Input
          ref={descriptionRef}
          value={description}
          onChange={(e) => setDescription(e.target.value)}
          className="h-6 text-[11px] border-0 border-b border-blue-300 rounded-none bg-transparent px-0 focus-visible:ring-0 focus-visible:border-blue-500"
          placeholder="Description"
        />
        <div className="flex items-center gap-1.5">
          <Switch
            checked={isRebillable}
            onCheckedChange={setIsRebillable}
            className="h-3 w-6 data-[state=checked]:bg-blue-500"
          />
          <span className="text-[9px] text-slate-500">Rebillable</span>
        </div>
      </div>
      
      {/* Quantity Input - Right Aligned */}
      <div className="px-3 py-1.5">
        <Input
          type="number"
          step="0.01"
          value={quantity}
          onChange={(e) => setQuantity(e.target.value)}
          className="h-6 text-[11px] text-right tabular-nums font-mono border-0 border-b border-blue-300 rounded-none bg-transparent px-0 focus-visible:ring-0 focus-visible:border-blue-500"
        />
      </div>
      
      {/* Rate Input - Right Aligned */}
      <div className="px-3 py-1.5">
        <Input
          type="number"
          step="0.01"
          value={rate}
          onChange={(e) => setRate(e.target.value)}
          className="h-6 text-[11px] text-right tabular-nums font-mono border-0 border-b border-blue-300 rounded-none bg-transparent px-0 focus-visible:ring-0 focus-visible:border-blue-500"
        />
      </div>
      
      {/* Auto-calculated Total */}
      <div className="px-3 py-2 text-right">
        <span className="text-[11px] font-semibold text-slate-800 tabular-nums font-mono">
          {formatCurrency(calculatedTotal)}
        </span>
      </div>
      
      {/* Save/Cancel Actions */}
      <div className="px-2 py-2 flex items-center justify-end gap-0.5">
        <Tooltip>
          <TooltipTrigger asChild>
            <button
              onClick={handleSave}
              className="h-5 w-5 p-0.5 bg-green-100 hover:bg-green-200 text-green-600 rounded flex items-center justify-center transition-colors"
              title="Save (Enter)"
            >
              <Check className="w-3 h-3" />
            </button>
          </TooltipTrigger>
          <TooltipContent side="top" className="text-xs">Save (Enter)</TooltipContent>
        </Tooltip>
        
        <Tooltip>
          <TooltipTrigger asChild>
            <button
              onClick={onCancel}
              className="h-5 w-5 p-0.5 hover:bg-slate-200 text-slate-400 hover:text-slate-600 rounded flex items-center justify-center transition-colors"
              title="Cancel (Esc)"
            >
              <X className="w-3 h-3" />
            </button>
          </TooltipTrigger>
          <TooltipContent side="top" className="text-xs">Cancel (Esc)</TooltipContent>
        </Tooltip>
      </div>
    </div>
  );
}

export function PayablesList({ 
  payables, 
  onHoldLoad, 
  onViewLoad, 
  onReleaseLoad, 
  onEditPayable,
  onDeletePayable,
  isHeldSection = false,
  isDraft = false,
  isLocked = false,
  selectedLoadId = null,
  auditFlags,
}: PayablesListProps) {
  const [editingPayableId, setEditingPayableId] = useState<Id<'loadPayables'> | null>(null);

  // Group payables by loadId
  const groupedPayables = useMemo(() => {
    const groups = new Map<string, Payable[]>();
    
    payables.forEach((payable) => {
      const key = payable.loadId || 'standalone';
      if (!groups.has(key)) groups.set(key, []);
      groups.get(key)!.push(payable);
    });
    
    return Array.from(groups.entries());
  }, [payables]);

  const formatCurrency = (amount: number) => {
    return new Intl.NumberFormat('en-US', {
      style: 'currency',
      currency: 'USD',
      minimumFractionDigits: 2,
    }).format(amount);
  };

  // Check if a manual item needs a receipt
  const needsReceipt = (description: string) => {
    const receiptTypes = ['lumper', 'tarp', 'detention', 'layover', 'toll', 'scale'];
    return receiptTypes.some(type => description.toLowerCase().includes(type));
  };

  // Handle inline save
  const handleInlineSave = async (payableId: Id<'loadPayables'>, data: { description: string; quantity: number; rate: number; isRebillable: boolean }) => {
    if (onEditPayable) {
      await onEditPayable(payableId, data);
    }
    setEditingPayableId(null);
  };

  if (payables.length === 0) {
    return (
      <div className="flex items-center justify-center h-32">
        <p className="text-xs text-slate-400">No payables in this settlement</p>
      </div>
    );
  }

  return (
    <TooltipProvider>
      {/* Single Continuous Ledger Table */}
      <div className="bg-white">
        {/* Global Table Headers - Fixed widths, right-aligned numerical columns */}
        <div className="grid grid-cols-[64px_1fr_80px_90px_100px_56px] border-b bg-slate-100/80 sticky top-0 z-10">
          <div className="px-3 py-2">
            <span className="text-[10px] font-semibold tracking-wider text-slate-500 uppercase">Type</span>
          </div>
          <div className="pl-4 pr-3 py-2">
            <span className="text-[10px] font-semibold tracking-wider text-slate-500 uppercase">Description</span>
          </div>
          <div className="px-3 py-2">
            <span className="text-[10px] font-semibold tracking-wider text-slate-500 uppercase block text-right tabular-nums">Qty</span>
          </div>
          <div className="px-3 py-2">
            <span className="text-[10px] font-semibold tracking-wider text-slate-500 uppercase block text-right tabular-nums">Rate</span>
          </div>
          <div className="px-3 py-2">
            <span className="text-[10px] font-semibold tracking-wider text-slate-500 uppercase block text-right tabular-nums">Total</span>
          </div>
          <div className="px-2 py-2"></div>
        </div>

        {/* Load Groups */}
        {groupedPayables.map(([loadId, items], groupIndex) => {
          const isStandalone = loadId === 'standalone';
          const firstItem = items[0];
          
          // Check audit flags for this load
          const hasMissingPod = !isStandalone && auditFlags?.missingPodLoadIds.has(loadId);
          const hasVariance = !isStandalone && auditFlags?.varianceLoadIds.has(loadId);
          
          // Selected state
          const isSelected = selectedLoadId !== null && selectedLoadId === loadId;

          return (
            <div 
              key={loadId} 
              className={cn(
                "group/load transition-all",
                // Standalone section gets distinct styling
                isStandalone && "mt-5 border-t-2 border-indigo-100",
                isSelected && !isStandalone && "bg-blue-50/50 border-l-[3px] border-l-blue-500",
                !isSelected && !isStandalone && isHeldSection && "bg-amber-50/10 border-l-[3px] border-l-transparent",
                !isSelected && !isStandalone && !isHeldSection && "hover:bg-slate-50/50 border-l-[3px] border-l-transparent"
              )}
            >
              {/* Load/Standalone Group Header Row - Fixed column widths */}
              <div className={cn(
                "grid grid-cols-[64px_1fr_80px_90px_100px_56px] h-8 items-center transition-colors",
                isStandalone && "bg-indigo-50/50 cursor-default",
                !isStandalone && "cursor-pointer",
                !isStandalone && isSelected && "bg-blue-100/70",
                !isStandalone && !isSelected && isHeldSection && "bg-amber-50/50",
                !isStandalone && !isSelected && !isHeldSection && "bg-slate-50",
                !isStandalone && !isSelected && "group-hover/load:bg-slate-100/80"
              )}
              onClick={() => !isStandalone && onViewLoad(loadId)}
              >
                {/* TYPE column - Audit indicators */}
                <div className="px-3 flex items-center justify-center">
                  {!isStandalone && (hasMissingPod || hasVariance) && (
                    <>
                      {hasMissingPod ? (
                        <Tooltip>
                          <TooltipTrigger asChild>
                            <div className="w-2.5 h-2.5 rounded-full bg-red-500 shrink-0 shadow-sm" />
                          </TooltipTrigger>
                          <TooltipContent side="top" className="text-xs">Missing POD</TooltipContent>
                        </Tooltip>
                      ) : hasVariance ? (
                        <Tooltip>
                          <TooltipTrigger asChild>
                            <AlertTriangle className="w-3.5 h-3.5 text-amber-500 shrink-0" />
                          </TooltipTrigger>
                          <TooltipContent side="top" className="text-xs">Mileage Variance</TooltipContent>
                        </Tooltip>
                      ) : null}
                    </>
                  )}
                </div>
                
                {/* DESCRIPTION column - Load ID or Standalone label */}
                <div className="pl-4 pr-3 flex items-center gap-2">
                  {!isStandalone ? (
                    <>
                      <span className="font-mono text-[11px] font-bold text-slate-800">
                        {firstItem.loadInternalId}
                      </span>
                      <span className="text-[10px] text-slate-500">
                        #{firstItem.loadOrderNumber}
                      </span>
                    </>
                  ) : (
                    <span className="text-[11px] font-semibold text-indigo-700">
                      Standalone Adjustments
                    </span>
                  )}
                </div>
                
                {/* QTY column - empty for header */}
                <div className="px-3"></div>
                
                {/* RATE column - empty for header */}
                <div className="px-3"></div>
                
                {/* TOTAL column - empty for header */}
                <div className="px-3"></div>
                
                {/* ACTIONS column - Hold button (hidden when locked) */}
                <div className="px-2 flex items-center justify-end gap-1">
                  {!isStandalone && !isLocked && (
                    <>
                      {isHeldSection ? (
                        <Button
                          variant="ghost"
                          size="sm"
                          onClick={(e) => { e.stopPropagation(); onReleaseLoad?.(loadId); }}
                          className="h-5 px-1.5 bg-amber-100 text-amber-700 hover:bg-amber-200 text-[9px] font-semibold border-0 rounded"
                        >
                          HELD
                        </Button>
                      ) : (
                        <Tooltip>
                          <TooltipTrigger asChild>
                            <Button 
                              variant="ghost" 
                              size="sm"
                              onClick={(e) => { e.stopPropagation(); onHoldLoad(loadId); }}
                              className="h-5 w-5 p-0 text-slate-300 hover:bg-amber-100 hover:text-amber-600 transition-colors opacity-0 group-hover/load:opacity-100"
                            >
                              <Pause className="w-3 h-3" />
                            </Button>
                          </TooltipTrigger>
                          <TooltipContent side="top" className="text-xs">Hold for next period</TooltipContent>
                        </Tooltip>
                      )}
                    </>
                  )}
                  {/* Show green checkmark when locked (Approved/Paid) */}
                  {!isStandalone && isLocked && !isHeldSection && (
                    <Tooltip>
                      <TooltipTrigger asChild>
                        <div className="w-4 h-4 rounded-full bg-green-100 flex items-center justify-center">
                          <Check className="w-2.5 h-2.5 text-green-600" />
                        </div>
                      </TooltipTrigger>
                      <TooltipContent side="left" className="text-xs">Paid</TooltipContent>
                    </Tooltip>
                  )}
                </div>
              </div>

              {/* Payable Line Items - All flush left, only indent accessorials within loads */}
              {items.map((payable, index) => {
                const isEditing = editingPayableId === payable._id;
                const isMissingReceipt = payable.sourceType === 'MANUAL' && 
                  needsReceipt(payable.description) && 
                  !payable.receiptStorageId;
                
                // Only indent non-first items within LOAD groups (not standalone)
                const shouldIndent = !isStandalone && index > 0;

                // INLINE EDIT MODE (only if not locked)
                if (isEditing && !isLocked) {
                  return (
                    <InlineEditRow
                      key={payable._id}
                      payable={payable}
                      onSave={(data) => handleInlineSave(payable._id, data)}
                      onCancel={() => setEditingPayableId(null)}
                      formatCurrency={formatCurrency}
                    />
                  );
                }

                // DISPLAY MODE - Flush left for all, with subtle indent only for load accessorials
                return (
                  <div
                    key={payable._id}
                    className={cn(
                      "grid grid-cols-[64px_1fr_80px_90px_100px_56px] h-7 items-center transition-colors group/row",
                      "hover:bg-blue-50/40",
                      // Only indent accessorials within loads (not standalone items)
                      shouldIndent && "ml-3 border-l border-l-slate-200"
                    )}
                  >
                    {/* TYPE column */}
                    <div className={cn("px-3", shouldIndent && "pl-5")}>
                      {payable.sourceType === 'MANUAL' ? (
                        <Badge className="text-[8px] font-medium h-[14px] px-1.5 bg-indigo-50 text-indigo-600 border-0">
                          MANUAL
                        </Badge>
                      ) : (
                        <Badge className="text-[8px] font-medium h-[14px] px-1.5 bg-slate-100 text-slate-500 border-0">
                          SYSTEM
                        </Badge>
                      )}
                    </div>
                    
                    {/* DESCRIPTION column */}
                    <div className="pl-4 pr-3 flex items-center gap-1.5 min-w-0">
                      {isMissingReceipt && (
                        <Tooltip>
                          <TooltipTrigger asChild>
                            <Paperclip className="w-3 h-3 text-amber-500 shrink-0" />
                          </TooltipTrigger>
                          <TooltipContent side="top" className="text-xs">Missing receipt</TooltipContent>
                        </Tooltip>
                      )}
                      <span className="text-[11px] text-slate-700 truncate">{payable.description}</span>
                      {payable.isRebillable && (
                        <Badge className="text-[7px] px-1 py-0 h-3 bg-blue-50 text-blue-600 border-0 shrink-0">
                          REBILL
                        </Badge>
                      )}
                    </div>
                    
                    {/* QTY column - Right aligned with tabular-nums */}
                    <div className="px-3 text-right">
                      <span className="text-[11px] text-slate-600 tabular-nums font-mono">
                        {payable.quantity.toFixed(2)}
                      </span>
                    </div>
                    
                    {/* RATE column - Right aligned with tabular-nums */}
                    <div className="px-3 text-right">
                      <span className="text-[11px] text-slate-600 tabular-nums font-mono">
                        {formatCurrency(payable.rate)}
                      </span>
                    </div>
                    
                    {/* TOTAL column - Right aligned with tabular-nums */}
                    <div className="px-3 text-right">
                      <span className="text-[11px] font-semibold text-slate-800 tabular-nums font-mono">
                        {formatCurrency(payable.totalAmount)}
                      </span>
                    </div>
                    
                    {/* ACTIONS column */}
                    <div className="px-2 flex items-center justify-end gap-0.5">
                      {payable.receiptStorageId && (
                        <Tooltip>
                          <TooltipTrigger>
                            <Paperclip className="w-3 h-3 text-green-500" />
                          </TooltipTrigger>
                          <TooltipContent side="top" className="text-xs">Receipt attached</TooltipContent>
                        </Tooltip>
                      )}
                      
                      {/* Edit/Delete for MANUAL items in DRAFT only (not locked) */}
                      {payable.sourceType === 'MANUAL' && isDraft && !isLocked && (
                        <>
                          <button
                            onClick={(e) => {
                              e.stopPropagation();
                              setEditingPayableId(payable._id);
                            }}
                            className="h-5 w-5 p-0.5 hover:bg-blue-100 text-slate-400 hover:text-blue-600 rounded opacity-0 group-hover/row:opacity-100 transition-opacity flex items-center justify-center"
                            title="Edit"
                          >
                            <Pencil className="w-3 h-3" />
                          </button>
                          
                          <button
                            onClick={(e) => {
                              e.stopPropagation();
                              onDeletePayable?.(payable._id);
                            }}
                            className="h-5 w-5 p-0.5 hover:bg-red-100 text-slate-400 hover:text-red-600 rounded opacity-0 group-hover/row:opacity-100 transition-opacity flex items-center justify-center"
                            title="Delete"
                          >
                            <Trash2 className="w-3 h-3" />
                          </button>
                        </>
                      )}
                    </div>
                  </div>
                );
              })}
            </div>
          );
        })}
      </div>
    </TooltipProvider>
  );
}
