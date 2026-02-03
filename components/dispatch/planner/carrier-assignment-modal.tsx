'use client';

import { useState, useEffect } from 'react';
import { useMutation, useQuery } from 'convex/react';
import { api } from '@/convex/_generated/api';
import { Id } from '@/convex/_generated/dataModel';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
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
import { Badge } from '@/components/ui/badge';
import { Building2, CheckCircle2, Send, Loader2, DollarSign, Calculator, FileText } from 'lucide-react';
import { toast } from 'sonner';
import { cn } from '@/lib/utils';

// Type for carrier partnership from getActiveForDispatch query
export interface CarrierPartnership {
  _id: Id<'carrierPartnerships'>;
  carrierOrgId?: string;
  carrierName: string;
  mcNumber: string;
  contactFirstName?: string;
  contactLastName?: string;
  contactPhone?: string;
  contactEmail?: string;
  city?: string;
  state?: string;
  hasDefaultRate: boolean;
  defaultRate?: number;
  defaultRateType?: 'FLAT' | 'PER_MILE' | 'PERCENTAGE';
  defaultCurrency?: 'USD' | 'CAD' | 'MXN';
  isOwnerOperator?: boolean;
  ownerDriverFirstName?: string;
  ownerDriverLastName?: string;
  ownerDriverPhone?: string;
}

interface LoadInfo {
  _id: Id<'loadInformation'>;
  orderNumber?: string;
  effectiveMiles?: number;
  customerName?: string;
}

interface CarrierAssignmentModalProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  carrier: CarrierPartnership | null;
  load: LoadInfo | null;
  organizationId: string;
  userId: string;
  onSuccess?: () => void;
}

type RateType = 'FLAT' | 'PER_MILE' | 'PERCENTAGE';
type Currency = 'USD' | 'CAD' | 'MXN';

export function CarrierAssignmentModal({
  open,
  onOpenChange,
  carrier,
  load,
  organizationId,
  userId,
  onSuccess,
}: CarrierAssignmentModalProps) {
  // Form state
  const [payMethod, setPayMethod] = useState<'profile' | 'negotiated'>('profile');
  const [rateType, setRateType] = useState<RateType>('FLAT');
  const [rate, setRate] = useState<string>('');
  const [currency, setCurrency] = useState<Currency>('USD');
  const [fuelSurcharge, setFuelSurcharge] = useState<string>('');
  const [accessorials, setAccessorials] = useState<string>('');
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [submitAction, setSubmitAction] = useState<'assign' | 'offer' | null>(null);

  // Mutations
  const directAssign = useMutation(api.loadCarrierAssignments.directAssign);
  const offerLoad = useMutation(api.loadCarrierAssignments.offerLoad);

  // Query carrier's pay profile (for auto-pay calculation display)
  const carrierPayProfile = useQuery(
    api.carrierProfileAssignments.getForCarrierPartnership,
    carrier ? { carrierPartnershipId: carrier._id } : 'skip'
  );
  const hasPayProfile = carrierPayProfile && carrierPayProfile.length > 0;
  const defaultPayProfile = carrierPayProfile?.find(p => p.isDefault) || carrierPayProfile?.[0];

  // Auto-fill from carrier defaults when carrier changes
  useEffect(() => {
    if (carrier) {
      if (carrier.hasDefaultRate && carrier.defaultRate !== undefined) {
        setRate(carrier.defaultRate.toString());
        setRateType(carrier.defaultRateType || 'FLAT');
        setCurrency(carrier.defaultCurrency || 'USD');
      } else {
        // Reset to empty if no default rate
        setRate('');
        setRateType('FLAT');
        setCurrency('USD');
      }
      setFuelSurcharge('');
      setAccessorials('');
    }
  }, [carrier]);

  // Set default pay method based on whether carrier has a pay profile
  useEffect(() => {
    if (hasPayProfile) {
      setPayMethod('profile');
    } else {
      setPayMethod('negotiated');
    }
  }, [hasPayProfile]);

  const resetForm = () => {
    setPayMethod(hasPayProfile ? 'profile' : 'negotiated');
    setRate('');
    setRateType('FLAT');
    setCurrency('USD');
    setFuelSurcharge('');
    setAccessorials('');
    setSubmitAction(null);
  };

  const handleClose = () => {
    resetForm();
    onOpenChange(false);
  };

  // Calculate totals
  const rateAmount = parseFloat(rate) || 0;
  const fuelAmount = parseFloat(fuelSurcharge) || 0;
  const accessorialsAmount = parseFloat(accessorials) || 0;

  // For per-mile, multiply by load miles
  const baseAmount =
    rateType === 'PER_MILE' && load?.effectiveMiles
      ? rateAmount * load.effectiveMiles
      : rateAmount;

  const totalAmount = baseAmount + fuelAmount + accessorialsAmount;

  const handleDirectAssign = async () => {
    if (!carrier || !load) return;

    // Only require rate if using negotiated rate method
    if (payMethod === 'negotiated' && (!rate || parseFloat(rate) <= 0)) {
      toast.error('Please enter a valid rate');
      return;
    }

    setIsSubmitting(true);
    setSubmitAction('assign');

    try {
      const result = await directAssign({
        loadId: load._id,
        brokerOrgId: organizationId,
        partnershipId: carrier._id,
        // Only pass rate if using negotiated method
        carrierRate: payMethod === 'negotiated' ? parseFloat(rate) : undefined,
        carrierRateType: payMethod === 'negotiated' ? rateType : undefined,
        currency: payMethod === 'negotiated' ? currency : undefined,
        carrierFuelSurcharge: payMethod === 'negotiated' && fuelAmount ? fuelAmount : undefined,
        carrierAccessorials: payMethod === 'negotiated' && accessorialsAmount ? accessorialsAmount : undefined,
        usePayProfile: payMethod === 'profile',
        createdBy: userId,
      });

      toast.success(`Assigned to ${result.carrierName}`);
      handleClose();
      onSuccess?.();
    } catch (error) {
      console.error('Direct assign failed:', error);
      toast.error(error instanceof Error ? error.message : 'Failed to assign carrier');
    } finally {
      setIsSubmitting(false);
      setSubmitAction(null);
    }
  };

  const handleSendOffer = async () => {
    if (!carrier || !load) return;

    // Only require rate if using negotiated rate method
    if (payMethod === 'negotiated' && (!rate || parseFloat(rate) <= 0)) {
      toast.error('Please enter a valid rate');
      return;
    }

    // Check if carrier has an account (required for offer flow)
    if (!carrier.carrierOrgId) {
      toast.error('Cannot send offer - carrier does not have an Otoqa account. Use Direct Assign instead.');
      return;
    }

    setIsSubmitting(true);
    setSubmitAction('offer');

    try {
      await offerLoad({
        loadId: load._id,
        brokerOrgId: organizationId,
        partnershipId: carrier._id,
        carrierRate: payMethod === 'negotiated' ? parseFloat(rate) : undefined,
        carrierRateType: payMethod === 'negotiated' ? rateType : undefined,
        currency: payMethod === 'negotiated' ? currency : undefined,
        carrierFuelSurcharge: payMethod === 'negotiated' && fuelAmount ? fuelAmount : undefined,
        carrierAccessorials: payMethod === 'negotiated' && accessorialsAmount ? accessorialsAmount : undefined,
        usePayProfile: payMethod === 'profile',
        createdBy: userId,
      });

      toast.success(`Offer sent to ${carrier.carrierName}`);
      handleClose();
      onSuccess?.();
    } catch (error) {
      console.error('Send offer failed:', error);
      toast.error(error instanceof Error ? error.message : 'Failed to send offer');
    } finally {
      setIsSubmitting(false);
      setSubmitAction(null);
    }
  };

  if (!carrier || !load) return null;

  const canSendOffer = !!carrier.carrierOrgId;

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-[500px]">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <Building2 className="h-5 w-5" />
            Assign Carrier to Load
          </DialogTitle>
          <DialogDescription>
            Assign <strong>{carrier.carrierName}</strong> to Load #{load.orderNumber}
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-4 py-4">
          {/* Carrier & Load Info - Compact Row */}
          <div className="flex gap-3">
            <div className="flex-1 p-3 bg-muted rounded-lg">
              <div className="font-medium text-sm">{carrier.carrierName}</div>
              <div className="text-xs text-muted-foreground">
                MC# {carrier.mcNumber}
                {carrier.city && carrier.state && ` • ${carrier.city}, ${carrier.state}`}
              </div>
              {carrier.contactFirstName && (
                <div className="text-xs text-muted-foreground mt-0.5">
                  {carrier.contactFirstName} {carrier.contactLastName}
                  {carrier.contactPhone && ` • ${carrier.contactPhone}`}
                </div>
              )}
            </div>
            <div className="flex-1 p-3 bg-blue-50 dark:bg-blue-950 rounded-lg">
              <div className="font-medium text-sm">Load #{load.orderNumber}</div>
              <div className="text-xs text-muted-foreground">
                {load.customerName || 'No customer'}
              </div>
              {load.effectiveMiles && (
                <div className="text-xs text-muted-foreground mt-0.5">
                  {load.effectiveMiles.toLocaleString()} miles
                </div>
              )}
            </div>
          </div>

          {/* Pay Method Selection */}
          <div className="space-y-3">
            <Label className="text-sm font-medium">How should carrier pay be calculated?</Label>
            
            <div className="grid grid-cols-2 gap-3">
              {/* Pay Profile Option */}
              <button
                type="button"
                onClick={() => hasPayProfile && setPayMethod('profile')}
                disabled={!hasPayProfile}
                className={cn(
                  'relative p-3 rounded-lg border-2 text-left transition-all',
                  payMethod === 'profile' && hasPayProfile
                    ? 'border-blue-500 bg-blue-50 dark:bg-blue-950/50'
                    : hasPayProfile
                      ? 'border-muted hover:border-blue-300 hover:bg-blue-50/50'
                      : 'border-muted bg-muted/30 opacity-60 cursor-not-allowed'
                )}
              >
                {payMethod === 'profile' && hasPayProfile && (
                  <div className="absolute top-2 right-2">
                    <CheckCircle2 className="h-4 w-4 text-blue-600" />
                  </div>
                )}
                <div className="flex items-center gap-2 mb-1">
                  <Calculator className="h-4 w-4 text-blue-600" />
                  <span className="font-medium text-sm">Auto-Calculate</span>
                </div>
                {hasPayProfile && defaultPayProfile ? (
                  <>
                    <div className="text-xs text-muted-foreground mb-1">
                      {defaultPayProfile.profileName}
                    </div>
                    {defaultPayProfile.baseRate !== undefined && (
                      <div className="text-sm font-semibold text-blue-600">
                        ${defaultPayProfile.baseRate.toFixed(2)}
                        <span className="text-xs font-normal">
                          {defaultPayProfile.profilePayBasis === 'MILEAGE' && '/mi'}
                          {defaultPayProfile.profilePayBasis === 'HOURLY' && '/hr'}
                          {defaultPayProfile.profilePayBasis === 'PERCENTAGE' && '%'}
                          {defaultPayProfile.profilePayBasis === 'FLAT' && ' flat'}
                        </span>
                      </div>
                    )}
                    {defaultPayProfile.profilePayBasis === 'MILEAGE' && load.effectiveMiles && defaultPayProfile.baseRate && (
                      <div className="text-[10px] text-muted-foreground mt-0.5">
                        ≈ ${(defaultPayProfile.baseRate * load.effectiveMiles).toFixed(2)} est.
                      </div>
                    )}
                  </>
                ) : (
                  <div className="text-xs text-muted-foreground">
                    No pay profile configured
                  </div>
                )}
              </button>

              {/* Negotiated Rate Option */}
              <button
                type="button"
                onClick={() => setPayMethod('negotiated')}
                className={cn(
                  'relative p-3 rounded-lg border-2 text-left transition-all',
                  payMethod === 'negotiated'
                    ? 'border-green-500 bg-green-50 dark:bg-green-950/50'
                    : 'border-muted hover:border-green-300 hover:bg-green-50/50'
                )}
              >
                {payMethod === 'negotiated' && (
                  <div className="absolute top-2 right-2">
                    <CheckCircle2 className="h-4 w-4 text-green-600" />
                  </div>
                )}
                <div className="flex items-center gap-2 mb-1">
                  <FileText className="h-4 w-4 text-green-600" />
                  <span className="font-medium text-sm">Negotiated Rate</span>
                </div>
                <div className="text-xs text-muted-foreground mb-1">
                  Enter custom rate for this load
                </div>
                {carrier.hasDefaultRate && carrier.defaultRate !== undefined && (
                  <div className="text-sm font-semibold text-green-600">
                    ${carrier.defaultRate.toFixed(2)}
                    <span className="text-xs font-normal">
                      {carrier.defaultRateType === 'PER_MILE' && '/mi'}
                      {carrier.defaultRateType === 'FLAT' && ' flat'}
                      {carrier.defaultRateType === 'PERCENTAGE' && '%'}
                    </span>
                    <Badge variant="outline" className="ml-1 text-[9px] py-0 bg-green-100 text-green-700 border-green-200">
                      Contract
                    </Badge>
                  </div>
                )}
              </button>
            </div>
          </div>

          {/* Negotiated Rate Entry - Only shown when selected */}
          {payMethod === 'negotiated' && (
            <div className="space-y-3 p-3 bg-muted/50 rounded-lg border">
              <div className="grid grid-cols-3 gap-3">
                <div className="space-y-1.5">
                  <Label className="text-xs text-muted-foreground">Type</Label>
                  <Select value={rateType} onValueChange={(v) => setRateType(v as RateType)}>
                    <SelectTrigger className="h-9">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="FLAT">Flat</SelectItem>
                      <SelectItem value="PER_MILE">Per Mile</SelectItem>
                      <SelectItem value="PERCENTAGE">%</SelectItem>
                    </SelectContent>
                  </Select>
                </div>

                <div className="space-y-1.5">
                  <Label className="text-xs text-muted-foreground">
                    {rateType === 'FLAT' ? 'Amount' : rateType === 'PER_MILE' ? 'Per Mile' : '%'}
                  </Label>
                  <div className="relative">
                    <span className="absolute left-2.5 top-1/2 -translate-y-1/2 text-muted-foreground text-sm">
                      {rateType === 'PERCENTAGE' ? '' : '$'}
                    </span>
                    <Input
                      type="number"
                      step="0.01"
                      min="0"
                      value={rate}
                      onChange={(e) => setRate(e.target.value)}
                      placeholder="0.00"
                      className={`h-9 ${rateType === 'PERCENTAGE' ? '' : 'pl-6'}`}
                    />
                    {rateType === 'PERCENTAGE' && (
                      <span className="absolute right-2.5 top-1/2 -translate-y-1/2 text-muted-foreground text-sm">
                        %
                      </span>
                    )}
                  </div>
                </div>

                <div className="space-y-1.5">
                  <Label className="text-xs text-muted-foreground">Currency</Label>
                  <Select value={currency} onValueChange={(v) => setCurrency(v as Currency)}>
                    <SelectTrigger className="h-9">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="USD">USD</SelectItem>
                      <SelectItem value="CAD">CAD</SelectItem>
                      <SelectItem value="MXN">MXN</SelectItem>
                    </SelectContent>
                  </Select>
                </div>
              </div>

              {rateType === 'PER_MILE' && load.effectiveMiles && rate && (
                <p className="text-xs text-muted-foreground">
                  {load.effectiveMiles.toLocaleString()} mi × ${rate}/mi = $
                  {baseAmount.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}
                </p>
              )}

              <div className="grid grid-cols-2 gap-3">
                <div className="space-y-1.5">
                  <Label className="text-xs text-muted-foreground">Fuel Surcharge</Label>
                  <div className="relative">
                    <span className="absolute left-2.5 top-1/2 -translate-y-1/2 text-muted-foreground text-sm">$</span>
                    <Input
                      type="number"
                      step="0.01"
                      min="0"
                      value={fuelSurcharge}
                      onChange={(e) => setFuelSurcharge(e.target.value)}
                      placeholder="0.00"
                      className="h-9 pl-6"
                    />
                  </div>
                </div>

                <div className="space-y-1.5">
                  <Label className="text-xs text-muted-foreground">Accessorials</Label>
                  <div className="relative">
                    <span className="absolute left-2.5 top-1/2 -translate-y-1/2 text-muted-foreground text-sm">$</span>
                    <Input
                      type="number"
                      step="0.01"
                      min="0"
                      value={accessorials}
                      onChange={(e) => setAccessorials(e.target.value)}
                      placeholder="0.00"
                      className="h-9 pl-6"
                    />
                  </div>
                </div>
              </div>

              {/* Total for negotiated rate */}
              <div className="pt-2 border-t flex justify-between items-center">
                <span className="text-sm text-muted-foreground">Total</span>
                <span className="text-lg font-bold text-green-600">
                  ${totalAmount.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}
                </span>
              </div>
            </div>
          )}

          {/* Summary for pay profile selection */}
          {payMethod === 'profile' && hasPayProfile && (
            <div className="p-3 bg-blue-50 dark:bg-blue-950/50 rounded-lg border border-blue-200">
              <div className="flex items-center gap-2 text-sm text-blue-700 dark:text-blue-300">
                <Calculator className="h-4 w-4" />
                <span>
                  Pay will be auto-calculated using <strong>{defaultPayProfile?.profileName}</strong> rules
                </span>
              </div>
            </div>
          )}
        </div>

        <DialogFooter className="flex-col sm:flex-row gap-2">
          <Button type="button" variant="outline" onClick={handleClose} disabled={isSubmitting}>
            Cancel
          </Button>

          <div className="flex gap-2">
            {/* Send Offer - only if carrier has account */}
            {canSendOffer && (
              <Button
                type="button"
                variant="outline"
                onClick={handleSendOffer}
                disabled={isSubmitting || (payMethod === 'negotiated' && !rate)}
                title="Send offer for carrier to accept"
              >
                {isSubmitting && submitAction === 'offer' && (
                  <Loader2 className="h-4 w-4 mr-2 animate-spin" />
                )}
                <Send className="h-4 w-4 mr-2" />
                Send Offer
              </Button>
            )}

            {/* Direct Assign */}
            <Button
              type="button"
              onClick={handleDirectAssign}
              disabled={isSubmitting || (payMethod === 'negotiated' && !rate)}
              title={payMethod === 'profile' ? 'Assign using pay profile' : 'Assign at negotiated rate'}
            >
              {isSubmitting && submitAction === 'assign' && (
                <Loader2 className="h-4 w-4 mr-2 animate-spin" />
              )}
              <CheckCircle2 className="h-4 w-4 mr-2" />
              Assign
            </Button>
          </div>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
