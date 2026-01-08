'use client';

import { useState, useEffect } from 'react';
import { useQuery, useMutation } from 'convex/react';
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

interface RuleFormModalProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  profileId: Id<'rateProfiles'>;
  ruleId?: Id<'rateRules'>;
  organizationId: string;
  userId: string;
}

type TriggerEvent =
  | 'MILE_LOADED'
  | 'MILE_EMPTY'
  | 'TIME_DURATION'
  | 'TIME_WAITING'
  | 'COUNT_STOPS'
  | 'FLAT_LEG'
  | 'ATTR_HAZMAT'
  | 'ATTR_TARP'
  | 'PCT_OF_LOAD';

type Category = 'BASE' | 'ACCESSORIAL' | 'DEDUCTION';

const TRIGGER_OPTIONS: { value: TriggerEvent; label: string; description: string }[] = [
  { value: 'MILE_LOADED', label: 'Loaded Miles', description: 'Pay per loaded mile' },
  { value: 'MILE_EMPTY', label: 'Empty Miles', description: 'Pay per empty/deadhead mile' },
  { value: 'TIME_DURATION', label: 'Hourly', description: 'Pay per hour worked' },
  { value: 'TIME_WAITING', label: 'Waiting Time', description: 'Pay for wait time at stops' },
  { value: 'COUNT_STOPS', label: 'Per Stop', description: 'Pay per stop on the load' },
  { value: 'FLAT_LEG', label: 'Flat Rate', description: 'Flat rate per leg' },
  { value: 'ATTR_HAZMAT', label: 'HazMat', description: 'Bonus for hazmat loads' },
  { value: 'ATTR_TARP', label: 'Tarp Required', description: 'Bonus when tarp is required' },
  { value: 'PCT_OF_LOAD', label: '% of Revenue', description: 'Percentage of load revenue' },
];

const CATEGORY_OPTIONS: { value: Category; label: string; description: string }[] = [
  { value: 'BASE', label: 'Base Pay', description: 'Primary compensation' },
  { value: 'ACCESSORIAL', label: 'Accessorial', description: 'Additional charges/bonuses' },
  { value: 'DEDUCTION', label: 'Deduction', description: 'Deductions from pay' },
];

export function RuleFormModal({
  open,
  onOpenChange,
  profileId,
  ruleId,
  organizationId,
  userId,
}: RuleFormModalProps) {
  const [name, setName] = useState('');
  const [triggerEvent, setTriggerEvent] = useState<TriggerEvent>('MILE_LOADED');
  const [category, setCategory] = useState<Category>('BASE');
  const [rateAmount, setRateAmount] = useState('');
  const [minThreshold, setMinThreshold] = useState('');
  const [maxCap, setMaxCap] = useState('');
  const [isSubmitting, setIsSubmitting] = useState(false);

  // Fetch existing rule if editing
  const existingRule = useQuery(
    api.rateRules.get,
    ruleId ? { ruleId } : 'skip'
  );

  // Mutations
  const createRule = useMutation(api.rateRules.create);
  const updateRule = useMutation(api.rateRules.update);

  // Populate form when editing
  useEffect(() => {
    if (existingRule) {
      setName(existingRule.name);
      setTriggerEvent(existingRule.triggerEvent as TriggerEvent);
      setCategory(existingRule.category as Category);
      setRateAmount(existingRule.rateAmount.toString());
      setMinThreshold(existingRule.minThreshold?.toString() ?? '');
      setMaxCap(existingRule.maxCap?.toString() ?? '');
    } else if (!ruleId) {
      // Reset form for new rule
      setName('');
      setTriggerEvent('MILE_LOADED');
      setCategory('BASE');
      setRateAmount('');
      setMinThreshold('');
      setMaxCap('');
    }
  }, [existingRule, ruleId]);

  // Auto-generate name based on trigger
  useEffect(() => {
    if (!ruleId && !name) {
      const trigger = TRIGGER_OPTIONS.find((t) => t.value === triggerEvent);
      if (trigger) {
        setName(trigger.label);
      }
    }
  }, [triggerEvent, ruleId, name]);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();

    if (!name.trim()) {
      alert('Please enter a rule name');
      return;
    }

    const rate = parseFloat(rateAmount);
    if (isNaN(rate) || rate < 0) {
      alert('Please enter a valid rate amount');
      return;
    }

    const min = minThreshold ? parseFloat(minThreshold) : undefined;
    const max = maxCap ? parseFloat(maxCap) : undefined;

    setIsSubmitting(true);

    try {
      if (ruleId) {
        // Update existing
        await updateRule({
          ruleId,
          name: name.trim(),
          category,
          triggerEvent,
          rateAmount: rate,
          minThreshold: min,
          maxCap: max,
          userId,
        });
      } else {
        // Create new (API gets workosOrgId from profile and defaults isActive=true)
        await createRule({
          profileId,
          name: name.trim(),
          category,
          triggerEvent,
          rateAmount: rate,
          minThreshold: min,
          maxCap: max,
          userId,
        });
      }
      onOpenChange(false);
    } catch (error) {
      console.error('Failed to save rule:', error);
      alert('Failed to save rule');
    } finally {
      setIsSubmitting(false);
    }
  };

  const isEditing = !!ruleId;
  const isPercentage = triggerEvent === 'PCT_OF_LOAD';

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-[500px]">
        <DialogHeader>
          <DialogTitle>{isEditing ? 'Edit Rule' : 'Add Rule'}</DialogTitle>
          <DialogDescription>
            {isEditing
              ? 'Update the rule configuration.'
              : 'Add a new pay rule to this profile.'}
          </DialogDescription>
        </DialogHeader>

        <form onSubmit={handleSubmit} className="space-y-4 py-4">
          {/* Rule Name */}
          <div className="space-y-2">
            <Label htmlFor="name">Rule Name</Label>
            <Input
              id="name"
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="e.g., Base Loaded Mile, Detention Pay"
            />
          </div>

          {/* Trigger Event */}
          <div className="space-y-2">
            <Label>Trigger Type</Label>
            <Select
              value={triggerEvent}
              onValueChange={(v) => setTriggerEvent(v as TriggerEvent)}
            >
              <SelectTrigger>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {TRIGGER_OPTIONS.map((option) => (
                  <SelectItem key={option.value} value={option.value}>
                    <div>
                      <span className="font-medium">{option.label}</span>
                      <span className="text-muted-foreground ml-2 text-xs">
                        {option.description}
                      </span>
                    </div>
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>

          {/* Category */}
          <div className="space-y-2">
            <Label>Category</Label>
            <Select
              value={category}
              onValueChange={(v) => setCategory(v as Category)}
            >
              <SelectTrigger>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {CATEGORY_OPTIONS.map((option) => (
                  <SelectItem key={option.value} value={option.value}>
                    <div>
                      <span className="font-medium">{option.label}</span>
                      <span className="text-muted-foreground ml-2 text-xs">
                        {option.description}
                      </span>
                    </div>
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>

          {/* Rate Amount */}
          <div className="space-y-2">
            <Label htmlFor="rateAmount">
              Rate {isPercentage ? '(%)' : '($)'}
            </Label>
            <Input
              id="rateAmount"
              type="number"
              step={isPercentage ? '0.1' : '0.01'}
              min="0"
              value={rateAmount}
              onChange={(e) => setRateAmount(e.target.value)}
              placeholder={isPercentage ? 'e.g., 25' : 'e.g., 0.55'}
            />
            <p className="text-xs text-muted-foreground">
              {isPercentage
                ? 'Percentage of load revenue'
                : `Amount per ${triggerEvent.includes('MILE') ? 'mile' : triggerEvent.includes('TIME') ? 'hour' : 'unit'}`}
            </p>
          </div>

          {/* Optional: Min Threshold */}
          <div className="grid grid-cols-2 gap-4">
            <div className="space-y-2">
              <Label htmlFor="minThreshold">Min Threshold (optional)</Label>
              <Input
                id="minThreshold"
                type="number"
                step="0.01"
                min="0"
                value={minThreshold}
                onChange={(e) => setMinThreshold(e.target.value)}
                placeholder="e.g., 100"
              />
              <p className="text-xs text-muted-foreground">
                Only apply if quantity exceeds this
              </p>
            </div>

            {/* Optional: Max Cap */}
            <div className="space-y-2">
              <Label htmlFor="maxCap">Max Cap (optional)</Label>
              <Input
                id="maxCap"
                type="number"
                step="0.01"
                min="0"
                value={maxCap}
                onChange={(e) => setMaxCap(e.target.value)}
                placeholder="e.g., 500"
              />
              <p className="text-xs text-muted-foreground">
                Maximum amount for this rule
              </p>
            </div>
          </div>

          <DialogFooter>
            <Button
              type="button"
              variant="outline"
              onClick={() => onOpenChange(false)}
            >
              Cancel
            </Button>
            <Button type="submit" disabled={isSubmitting}>
              {isSubmitting ? 'Saving...' : isEditing ? 'Save Changes' : 'Add Rule'}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
