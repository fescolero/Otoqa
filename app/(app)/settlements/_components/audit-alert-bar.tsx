'use client';

import { useState } from 'react';
import { FileText, AlertTriangle, Paperclip, CheckCircle2 } from 'lucide-react';
import { cn } from '@/lib/utils';
import { Id } from '@/convex/_generated/dataModel';

interface AuditFlags {
  missingPods: Array<{
    loadId: Id<'loadInformation'>;
    loadInternalId: string;
    orderNumber: string;
  }>;
  mileageVariances: Array<{
    loadId: Id<'loadInformation'>;
    loadInternalId: string;
    payableQuantity: number;
    loadEffectiveMiles: number;
    variance: number;
    percentVariance: number;
    level: 'INFO' | 'WARNING';
  }>;
  missingReceipts: Array<{
    payableId: Id<'loadPayables'>;
    description: string;
    amount: number;
  }>;
}

interface AuditAlertBarProps {
  auditFlags?: AuditFlags;
  onFilterChange?: (filter: 'all' | 'pods' | 'variances' | 'receipts') => void;
}

export function AuditAlertBar({ auditFlags, onFilterChange }: AuditAlertBarProps) {
  const [activeFilter, setActiveFilter] = useState<'all' | 'pods' | 'variances' | 'receipts'>('all');

  if (!auditFlags) {
    return null;
  }

  const alerts = [
    {
      key: 'pods' as const,
      icon: <FileText className="w-4 h-4" />,
      count: auditFlags.missingPods.length,
      label: 'Missing PODs',
      color: 'text-red-600 bg-red-50 border-red-200',
    },
    {
      key: 'variances' as const,
      icon: <AlertTriangle className="w-4 h-4" />,
      count: auditFlags.mileageVariances.length,
      label: 'Mileage Variances',
      color: 'text-amber-600 bg-amber-50 border-amber-200',
    },
    {
      key: 'receipts' as const,
      icon: <Paperclip className="w-4 h-4" />,
      count: auditFlags.missingReceipts.length,
      label: 'Missing Receipts',
      color: 'text-orange-600 bg-orange-50 border-orange-200',
    },
  ];

  const totalIssues = alerts.reduce((sum, alert) => sum + alert.count, 0);

  if (totalIssues === 0) {
    return (
      <div className="px-4 py-2 bg-green-50/50 border-b border-green-100 flex items-center gap-2">
        <CheckCircle2 className="w-3.5 h-3.5 text-green-600" />
        <span className="text-[11px] font-medium text-green-700">All clear — ready for approval</span>
      </div>
    );
  }

  return (
    <div className="px-4 py-2 bg-slate-50/50 border-b border-slate-100 flex items-center gap-1.5">
      <span className="text-[10px] font-semibold uppercase tracking-wide text-slate-400 mr-2">Filters:</span>
      
      {/* "All" button */}
      <button
        className={cn(
          'h-6 px-2 text-[10px] font-medium rounded transition-all',
          activeFilter === 'all' 
            ? 'bg-slate-200 text-slate-700' 
            : 'text-slate-500 hover:bg-slate-100 hover:text-slate-600'
        )}
        onClick={() => {
          setActiveFilter('all');
          onFilterChange?.('all');
        }}
      >
        All
      </button>
      
      <div className="w-px h-4 bg-slate-200 mx-1" />
      
      {alerts.map((alert) =>
        alert.count > 0 ? (
          <button
            key={alert.key}
            className={cn(
              'h-6 px-2 text-[10px] font-medium rounded flex items-center gap-1.5 transition-all',
              activeFilter === alert.key 
                ? `${alert.color}` 
                : 'text-slate-500 hover:bg-slate-100 hover:text-slate-600'
            )}
            onClick={() => {
              const newFilter = activeFilter === alert.key ? 'all' : alert.key;
              setActiveFilter(newFilter);
              onFilterChange?.(newFilter);
            }}
          >
            <div className={cn("w-3.5 h-3.5", activeFilter === alert.key ? "opacity-100" : "opacity-50")}>
              {alert.icon}
            </div>
            <span className="tabular-nums font-semibold">{alert.count}</span>
            <span className="font-normal">{alert.label}</span>
          </button>
        ) : null
      )}
    </div>
  );
}

