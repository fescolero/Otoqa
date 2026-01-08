'use client';

import { useState } from 'react';
import { useQuery, useMutation } from 'convex/react';
import { api } from '@/convex/_generated/api';
import { Id } from '@/convex/_generated/dataModel';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Plus } from 'lucide-react';
import { toast } from 'sonner';

interface QuickAddMenuProps {
  settlementId: Id<'driverSettlements'>;
  driverId: Id<'drivers'>;
  organizationId: string;
  userId: string;
  onSuccess?: () => void;
}

export function QuickAddMenu({ settlementId, driverId, organizationId, userId, onSuccess }: QuickAddMenuProps) {
  const [customAmount, setCustomAmount] = useState('');
  const [customDescription, setCustomDescription] = useState('');

  // Fetch templates
  const templates = useQuery(api.manualTemplates.listTemplates, {
    workosOrgId: organizationId,
    profileType: 'DRIVER',
  });

  // Fetch common types as fallback
  const commonTypes = useQuery(api.manualTemplates.getCommonAdjustmentTypes, {});

  // Add adjustment mutation
  const addAdjustment = useMutation(api.driverSettlements.addManualAdjustment);

  const handleAddTemplate = async (description: string, amount: number) => {
    try {
      await addAdjustment({
        settlementId,
        driverId,
        description,
        amount,
        workosOrgId: organizationId,
        userId,
      });
      toast.success(`Added ${description}`);
      onSuccess?.();
    } catch (error) {
      toast.error('Failed to add adjustment');
      console.error(error);
    }
  };

  const handleAddCustom = async () => {
    if (!customDescription || !customAmount) {
      toast.error('Please enter description and amount');
      return;
    }

    const amount = parseFloat(customAmount);
    if (isNaN(amount)) {
      toast.error('Invalid amount');
      return;
    }

    try {
      await addAdjustment({
        settlementId,
        driverId,
        description: customDescription,
        amount,
        workosOrgId: organizationId,
        userId,
      });
      toast.success('Added custom adjustment');
      setCustomDescription('');
      setCustomAmount('');
      onSuccess?.();
    } catch (error) {
      toast.error('Failed to add adjustment');
      console.error(error);
    }
  };

  const displayTemplates = templates && templates.length > 0 ? templates : commonTypes || [];

  return (
    <div className="space-y-2">
      {/* Header + Template Chips in one row */}
      <div className="flex items-center gap-2 flex-wrap">
        <span className="text-[10px] font-semibold uppercase tracking-wide text-slate-500 shrink-0">
          Quick Add:
        </span>
        {displayTemplates.slice(0, 5).map((template, index) => (
          <Button
            key={'_id' in template ? template._id : index}
            variant="outline"
            size="sm"
            className="h-6 px-2 text-[10px] hover:bg-blue-50 hover:border-blue-300 transition-colors font-medium"
            onClick={() => {
              if ('defaultAmount' in template && template.defaultAmount) {
                handleAddTemplate(template.label || template.type, template.defaultAmount);
              } else if ('rateAmount' in template) {
                handleAddTemplate(template.name, template.rateAmount);
              }
            }}
          >
            <Plus className="w-2.5 h-2.5 mr-1" />
            {'description' in template ? template.description : template.label}
          </Button>
        ))}
      </div>

      {/* Compact Custom Addition Row */}
      <div className="flex gap-2 items-center">
        <Input
          placeholder="Description"
          value={customDescription}
          onChange={(e) => setCustomDescription(e.target.value)}
          className="h-7 text-xs flex-1"
        />
        <div className="relative w-24">
          <span className="absolute left-2 top-1/2 -translate-y-1/2 text-xs text-slate-400">$</span>
          <Input
            type="number"
            placeholder="0.00"
            step="0.01"
            value={customAmount}
            onChange={(e) => setCustomAmount(e.target.value)}
            className="h-7 text-xs pl-5"
          />
        </div>
        <Button 
          size="sm" 
          className="h-7 px-3 text-xs"
          onClick={handleAddCustom}
          disabled={!customDescription || !customAmount}
        >
          Add
        </Button>
      </div>
    </div>
  );
}
