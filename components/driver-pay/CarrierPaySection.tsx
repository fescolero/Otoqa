'use client';

import { useQuery } from 'convex/react';
import { api } from '@/convex/_generated/api';
import { Id } from '@/convex/_generated/dataModel';
import { Card } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import {
  DollarSign,
  Building2,
  FileText,
  Clock,
  CheckCircle2,
  Banknote,
} from 'lucide-react';

interface CarrierPaySectionProps {
  loadId: Id<'loadInformation'>;
  organizationId: string;
}

export function CarrierPaySection({
  loadId,
  organizationId,
}: CarrierPaySectionProps) {
  // Fetch carrier assignment for this load
  const assignments = useQuery(api.loadCarrierAssignments.listByLoad, { loadId });
  
  // Fetch load data to get miles for rate calculation display
  const loadData = useQuery(api.loads.getLoad, { loadId });

  // Loading state
  if (assignments === undefined || loadData === undefined) {
    return (
      <Card className="p-6">
        <div className="flex items-center justify-center py-8">
          <p className="text-muted-foreground">Loading carrier pay...</p>
        </div>
      </Card>
    );
  }
  
  // Get effective miles from load
  const effectiveMiles = loadData?.effectiveMiles ?? loadData?.importedMiles ?? loadData?.contractMiles ?? 0;

  // Find the active/awarded assignment
  const activeAssignment = assignments.find(
    (a) => a.status === 'AWARDED' || a.status === 'IN_PROGRESS' || a.status === 'COMPLETED'
  );

  if (!activeAssignment) {
    return (
      <Card className="p-6">
        <div className="flex items-center gap-2 mb-4">
          <DollarSign className="h-5 w-5 text-muted-foreground" />
          <h2 className="text-xl font-semibold">Carrier Pay</h2>
        </div>
        <div className="text-center py-8 text-muted-foreground">
          <Building2 className="h-12 w-12 mx-auto mb-3 opacity-50" />
          <p>No carrier assignment found</p>
        </div>
      </Card>
    );
  }

  // Format currency
  const formatCurrency = (amount: number | undefined, currency: string = 'USD') => {
    if (amount === undefined) return '—';
    return new Intl.NumberFormat('en-US', {
      style: 'currency',
      currency,
    }).format(amount);
  };

  // Format date
  const formatDate = (timestamp: number | undefined) => {
    if (!timestamp) return '—';
    return new Date(timestamp).toLocaleDateString('en-US', {
      month: 'short',
      day: 'numeric',
      year: 'numeric',
    });
  };

  // Get payment status styling
  const getPaymentStatusStyle = (status: string | undefined) => {
    switch (status) {
      case 'PENDING':
        return 'bg-yellow-50 text-yellow-700 border-yellow-200';
      case 'INVOICED':
        return 'bg-blue-50 text-blue-700 border-blue-200';
      case 'PAID':
        return 'bg-green-50 text-green-700 border-green-200';
      case 'DISPUTED':
        return 'bg-red-50 text-red-700 border-red-200';
      default:
        return 'bg-slate-50 text-slate-700 border-slate-200';
    }
  };

  // Get assignment status styling
  const getAssignmentStatusStyle = (status: string) => {
    switch (status) {
      case 'AWARDED':
        return 'bg-blue-50 text-blue-700 border-blue-200';
      case 'IN_PROGRESS':
        return 'bg-purple-50 text-purple-700 border-purple-200';
      case 'COMPLETED':
        return 'bg-green-50 text-green-700 border-green-200';
      default:
        return 'bg-slate-50 text-slate-700 border-slate-200';
    }
  };

  return (
    <Card className="p-6">
      <div className="space-y-6">
        {/* Header with Total */}
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-2">
            <DollarSign className="h-5 w-5 text-muted-foreground" />
            <h2 className="text-xl font-semibold">Carrier Pay</h2>
          </div>
          <div className="flex items-center gap-4">
            <Badge variant="outline" className={getAssignmentStatusStyle(activeAssignment.status)}>
              {activeAssignment.status.replace('_', ' ')}
            </Badge>
            <div className="text-right">
              <p className="text-sm text-muted-foreground">Total Pay</p>
              <p className="text-2xl font-bold text-green-600">
                {formatCurrency(activeAssignment.carrierTotalAmount, activeAssignment.currency)}
              </p>
            </div>
          </div>
        </div>

        {/* Carrier Info */}
        <div className="bg-slate-50 rounded-lg p-4">
          <div className="flex items-start gap-3">
            <div className="flex h-10 w-10 items-center justify-center rounded-full bg-blue-100">
              <Building2 className="h-5 w-5 text-blue-600" />
            </div>
            <div className="flex-1">
              <h3 className="font-semibold text-slate-900">
                {activeAssignment.carrierName}
              </h3>
              {activeAssignment.carrierMcNumber && (
                <p className="text-sm text-slate-500">
                  MC# {activeAssignment.carrierMcNumber}
                </p>
              )}
            </div>
          </div>

        </div>

        {/* Rate Breakdown */}
        <div className="border rounded-lg overflow-hidden">
          <div className="bg-slate-50 px-4 py-2 border-b">
            <h4 className="text-sm font-semibold text-slate-700">Rate Breakdown</h4>
          </div>
          <div className="divide-y">
            {/* Base Rate - Different display for PER_MILE vs FLAT */}
            {activeAssignment.carrierRateType === 'PER_MILE' ? (
              <div className="flex justify-between items-center px-4 py-3">
                <div className="flex items-center gap-2">
                  <FileText className="h-4 w-4 text-slate-400" />
                  <span className="text-sm text-slate-700">
                    {formatCurrency(activeAssignment.carrierRate, activeAssignment.currency)}/mi × {effectiveMiles.toLocaleString()} mi
                  </span>
                </div>
                <span className="font-medium">
                  {formatCurrency((activeAssignment.carrierRate ?? 0) * effectiveMiles, activeAssignment.currency)}
                </span>
              </div>
            ) : (
              <div className="flex justify-between items-center px-4 py-3">
                <div className="flex items-center gap-2">
                  <FileText className="h-4 w-4 text-slate-400" />
                  <span className="text-sm text-slate-700">
                    Base Rate (Flat)
                  </span>
                </div>
                <span className="font-medium">
                  {formatCurrency(activeAssignment.carrierRate, activeAssignment.currency)}
                </span>
              </div>
            )}

            {/* Fuel Surcharge */}
            {activeAssignment.carrierFuelSurcharge && activeAssignment.carrierFuelSurcharge > 0 && (
              <div className="flex justify-between items-center px-4 py-3">
                <div className="flex items-center gap-2">
                  <Banknote className="h-4 w-4 text-slate-400" />
                  <span className="text-sm text-slate-700">Fuel Surcharge</span>
                </div>
                <span className="font-medium">
                  {formatCurrency(activeAssignment.carrierFuelSurcharge, activeAssignment.currency)}
                </span>
              </div>
            )}

            {/* Accessorials */}
            {activeAssignment.carrierAccessorials && activeAssignment.carrierAccessorials > 0 && (
              <div className="flex justify-between items-center px-4 py-3">
                <div className="flex items-center gap-2">
                  <Banknote className="h-4 w-4 text-slate-400" />
                  <span className="text-sm text-slate-700">Accessorials</span>
                </div>
                <span className="font-medium">
                  {formatCurrency(activeAssignment.carrierAccessorials, activeAssignment.currency)}
                </span>
              </div>
            )}

            {/* Total */}
            <div className="flex justify-between items-center px-4 py-3 bg-green-50">
              <span className="font-semibold text-slate-900">Total</span>
              <span className="font-bold text-lg text-green-600">
                {formatCurrency(activeAssignment.carrierTotalAmount, activeAssignment.currency)}
              </span>
            </div>
          </div>
        </div>

        {/* Payment Status */}
        <div className="flex items-center justify-between p-4 border rounded-lg">
          <div className="flex items-center gap-3">
            {activeAssignment.paymentStatus === 'PAID' ? (
              <CheckCircle2 className="h-5 w-5 text-green-500" />
            ) : (
              <Clock className="h-5 w-5 text-slate-400" />
            )}
            <div>
              <p className="text-sm font-medium text-slate-700">Payment Status</p>
              <p className="text-xs text-slate-500">
                {activeAssignment.paymentStatus === 'PAID' && activeAssignment.paymentDate
                  ? `Paid on ${formatDate(activeAssignment.paymentDate)}`
                  : activeAssignment.paymentStatus === 'INVOICED'
                  ? 'Invoice sent'
                  : 'Awaiting invoice'}
              </p>
            </div>
          </div>
          <Badge variant="outline" className={getPaymentStatusStyle(activeAssignment.paymentStatus)}>
            {activeAssignment.paymentStatus || 'PENDING'}
          </Badge>
        </div>

        {/* Timeline */}
        <div className="text-xs text-slate-500 space-y-1">
          {activeAssignment.offeredAt && (
            <p>Offered: {formatDate(activeAssignment.offeredAt)}</p>
          )}
          {activeAssignment.awardedAt && (
            <p>Awarded: {formatDate(activeAssignment.awardedAt)}</p>
          )}
          {activeAssignment.completedAt && (
            <p>Completed: {formatDate(activeAssignment.completedAt)}</p>
          )}
        </div>
      </div>
    </Card>
  );
}
