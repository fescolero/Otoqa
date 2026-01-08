'use client';

import { useState, useEffect } from 'react';
import { useQuery, useMutation } from 'convex/react';
import { api } from '@/convex/_generated/api';
import { Id } from '@/convex/_generated/dataModel';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';
import { Switch } from '@/components/ui/switch';
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
import { DollarSign, Clock, Percent } from 'lucide-react';

interface ProfileFormModalProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  profileId?: Id<'rateProfiles'>;
  organizationId: string;
  userId: string;
}

type PayBasis = 'MILEAGE' | 'HOURLY' | 'PERCENTAGE';

export function ProfileFormModal({
  open,
  onOpenChange,
  profileId,
  organizationId,
  userId,
}: ProfileFormModalProps) {
  const [name, setName] = useState('');
  const [description, setDescription] = useState('');
  const [payBasis, setPayBasis] = useState<PayBasis>('MILEAGE');
  const [baseRate, setBaseRate] = useState('');
  const [isDefault, setIsDefault] = useState(false);
  const [isSubmitting, setIsSubmitting] = useState(false);

  // Fetch existing profile if editing
  const existingProfile = useQuery(
    api.rateProfiles.get,
    profileId ? { profileId } : 'skip'
  );

  // Mutations
  const createProfile = useMutation(api.rateProfiles.create);
  const updateProfile = useMutation(api.rateProfiles.update);
  const createRule = useMutation(api.rateRules.create);
  const updateRule = useMutation(api.rateRules.update);

  // Find the BASE rule for this profile
  const baseRule = existingProfile?.allRules?.find(
    (r) => r.category === 'BASE' && r.isActive
  );

  // Populate form when editing
  useEffect(() => {
    if (existingProfile) {
      setName(existingProfile.name);
      setDescription(existingProfile.description ?? '');
      setPayBasis(existingProfile.payBasis as PayBasis);
      setIsDefault(existingProfile.isDefault ?? false);
      // Set base rate from existing BASE rule
      if (baseRule) {
        setBaseRate(baseRule.rateAmount.toString());
      } else {
        setBaseRate('');
      }
    } else if (!profileId) {
      // Reset form for new profile
      setName('');
      setDescription('');
      setPayBasis('MILEAGE');
      setBaseRate('');
      setIsDefault(false);
    }
  }, [existingProfile, profileId, baseRule]);

  // Get the trigger event based on pay basis
  const getTriggerEvent = (basis: PayBasis) => {
    switch (basis) {
      case 'MILEAGE':
        return 'MILE_LOADED';
      case 'HOURLY':
        return 'TIME_DURATION';
      case 'PERCENTAGE':
        return 'PCT_OF_LOAD';
    }
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();

    if (!name.trim()) {
      alert('Please enter a profile name');
      return;
    }

    if (!baseRate || parseFloat(baseRate) <= 0) {
      alert('Please enter a valid base rate');
      return;
    }

    setIsSubmitting(true);

    try {
      if (profileId) {
        // Update existing profile
        await updateProfile({
          profileId,
          name: name.trim(),
          description: description.trim() || undefined,
          payBasis,
          isDefault,
          userId,
        });

        // Update or create BASE rule
        if (baseRule) {
          await updateRule({
            ruleId: baseRule._id,
            rateAmount: parseFloat(baseRate),
            triggerEvent: getTriggerEvent(payBasis) as 'MILE_LOADED' | 'TIME_DURATION' | 'PCT_OF_LOAD',
            userId,
          });
        } else {
          // Create BASE rule if it doesn't exist
          await createRule({
            profileId,
            name: 'Base Pay Rate',
            category: 'BASE',
            triggerEvent: getTriggerEvent(payBasis) as 'MILE_LOADED' | 'TIME_DURATION' | 'PCT_OF_LOAD',
            rateAmount: parseFloat(baseRate),
            userId,
          });
        }
      } else {
        // Create new profile
        const newProfileId = await createProfile({
          workosOrgId: organizationId,
          name: name.trim(),
          description: description.trim() || undefined,
          payBasis,
          isDefault,
          createdBy: userId,
        });

        // Create BASE rule for new profile
        await createRule({
          profileId: newProfileId,
          name: 'Base Pay Rate',
          category: 'BASE',
          triggerEvent: getTriggerEvent(payBasis) as 'MILE_LOADED' | 'TIME_DURATION' | 'PCT_OF_LOAD',
          rateAmount: parseFloat(baseRate),
          userId,
        });
      }
      onOpenChange(false);
    } catch (error) {
      console.error('Failed to save profile:', error);
      alert('Failed to save profile');
    } finally {
      setIsSubmitting(false);
    }
  };

  const isEditing = !!profileId;

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-[500px]">
        <DialogHeader>
          <DialogTitle>
            {isEditing ? 'Edit Pay Profile' : 'Create Pay Profile'}
          </DialogTitle>
          <DialogDescription>
            {isEditing
              ? 'Update the pay profile settings. Rules can be managed from the profile detail view.'
              : 'Create a new pay profile to define how drivers are compensated.'}
          </DialogDescription>
        </DialogHeader>

        <form onSubmit={handleSubmit} className="space-y-6 py-4">
          {/* Profile Name */}
          <div className="space-y-2">
            <Label htmlFor="name">Profile Name</Label>
            <Input
              id="name"
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="e.g., Standard OTR, City Hourly"
            />
          </div>

          {/* Pay Basis */}
          <div className="space-y-2">
            <Label>Pay Basis</Label>
            <Select value={payBasis} onValueChange={(v) => setPayBasis(v as PayBasis)}>
              <SelectTrigger>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="MILEAGE">
                  <div className="flex items-center gap-2">
                    <DollarSign className="h-4 w-4" />
                    <span>Mileage (Per Mile)</span>
                  </div>
                </SelectItem>
                <SelectItem value="HOURLY">
                  <div className="flex items-center gap-2">
                    <Clock className="h-4 w-4" />
                    <span>Hourly</span>
                  </div>
                </SelectItem>
                <SelectItem value="PERCENTAGE">
                  <div className="flex items-center gap-2">
                    <Percent className="h-4 w-4" />
                    <span>Percentage of Load</span>
                  </div>
                </SelectItem>
              </SelectContent>
            </Select>
          </div>

          {/* Base Rate */}
          <div className="space-y-2">
            <Label htmlFor="baseRate">
              Base Rate
              {payBasis === 'MILEAGE' && ' ($ per mile)'}
              {payBasis === 'HOURLY' && ' ($ per hour)'}
              {payBasis === 'PERCENTAGE' && ' (% of load)'}
            </Label>
            <div className="relative">
              <span className="absolute left-3 top-1/2 -translate-y-1/2 text-muted-foreground">
                {payBasis === 'PERCENTAGE' ? '%' : '$'}
              </span>
              <Input
                id="baseRate"
                type="number"
                step="0.01"
                min="0"
                value={baseRate}
                onChange={(e) => setBaseRate(e.target.value)}
                placeholder={payBasis === 'MILEAGE' ? '0.55' : payBasis === 'HOURLY' ? '25.00' : '25'}
                className="pl-7"
              />
            </div>
            <p className="text-xs text-muted-foreground">
              {payBasis === 'MILEAGE' && 'Driver earns this rate for each loaded mile'}
              {payBasis === 'HOURLY' && 'Driver earns this rate per hour on the load'}
              {payBasis === 'PERCENTAGE' && 'Driver earns this percentage of the load revenue'}
            </p>
          </div>

          {/* Description */}
          <div className="space-y-2">
            <Label htmlFor="description">Description (optional)</Label>
            <Textarea
              id="description"
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              placeholder="Describe when this profile should be used..."
              rows={3}
            />
          </div>

          {/* Default Toggle */}
          <div className="flex items-center justify-between">
            <div>
              <Label htmlFor="isDefault">Set as Default</Label>
              <p className="text-sm text-muted-foreground">
                Use this profile when no other profile is assigned
              </p>
            </div>
            <Switch
              id="isDefault"
              checked={isDefault}
              onCheckedChange={setIsDefault}
            />
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
              {isSubmitting ? 'Saving...' : isEditing ? 'Save Changes' : 'Create Profile'}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
