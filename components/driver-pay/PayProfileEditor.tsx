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
import { Badge } from '@/components/ui/badge';
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetFooter,
  SheetHeader,
  SheetTitle,
} from '@/components/ui/sheet';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '@/components/ui/alert-dialog';
import {
  DollarSign,
  Clock,
  Percent,
  Plus,
  Pencil,
  Trash2,
  X,
  Check,
  User,
  Truck,
  Banknote,
} from 'lucide-react';

interface PayProfileEditorProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  profileId?: Id<'rateProfiles'>;
  organizationId: string;
  userId: string;
  /** Pre-select profile type for new profiles */
  defaultProfileType?: 'DRIVER' | 'CARRIER';
  onSaved?: () => void;
}

type PayBasis = 'MILEAGE' | 'HOURLY' | 'PERCENTAGE' | 'FLAT';
type ProfileType = 'DRIVER' | 'CARRIER';

type TriggerEvent =
  | 'MILE_LOADED'
  | 'MILE_EMPTY'
  | 'TIME_DURATION'
  | 'TIME_WAITING'
  | 'COUNT_STOPS'
  | 'FLAT_LOAD'
  | 'FLAT_LEG'
  | 'ATTR_HAZMAT'
  | 'ATTR_TARP'
  | 'PCT_OF_LOAD';

type RuleCategory = 'BASE' | 'ACCESSORIAL' | 'DEDUCTION';

interface RuleFormData {
  _id?: string;
  name: string;
  category: RuleCategory;
  triggerEvent: TriggerEvent;
  rateAmount: string;
  minThreshold?: string;
  maxCap?: string;
  isActive: boolean;
  isNew?: boolean;
  isEditing?: boolean;
}

// Map pay basis to default base trigger
const PAY_BASIS_TRIGGERS: Record<PayBasis, TriggerEvent> = {
  MILEAGE: 'MILE_LOADED',
  HOURLY: 'TIME_DURATION',
  PERCENTAGE: 'PCT_OF_LOAD',
  FLAT: 'FLAT_LOAD',
};

// Friendly names for trigger events
const TRIGGER_LABELS: Record<TriggerEvent, string> = {
  MILE_LOADED: 'Loaded Miles',
  MILE_EMPTY: 'Empty Miles',
  TIME_DURATION: 'Hours Worked',
  TIME_WAITING: 'Waiting/Detention Time',
  COUNT_STOPS: 'Number of Stops',
  FLAT_LOAD: 'Flat Rate per Load',
  FLAT_LEG: 'Flat Rate per Leg',
  ATTR_HAZMAT: 'Hazmat Load',
  ATTR_TARP: 'Tarp Required',
  PCT_OF_LOAD: 'Percentage of Load Revenue',
};

// Unit labels based on trigger
const TRIGGER_UNITS: Record<TriggerEvent, string> = {
  MILE_LOADED: 'per mile',
  MILE_EMPTY: 'per mile',
  TIME_DURATION: 'per hour',
  TIME_WAITING: 'per hour',
  COUNT_STOPS: 'per stop',
  FLAT_LOAD: 'per load',
  FLAT_LEG: 'per leg',
  ATTR_HAZMAT: 'flat bonus',
  ATTR_TARP: 'flat bonus',
  PCT_OF_LOAD: '% of revenue',
};

// Valid triggers for BASE rules per pay basis
const BASE_TRIGGERS_BY_BASIS: Record<PayBasis, TriggerEvent[]> = {
  MILEAGE: ['MILE_LOADED', 'MILE_EMPTY'],
  HOURLY: ['TIME_DURATION'],
  PERCENTAGE: ['PCT_OF_LOAD'],
  FLAT: ['FLAT_LOAD'],
};

// Available triggers for accessorial rules per pay basis
const TRIGGERS_BY_BASIS: Record<PayBasis, TriggerEvent[]> = {
  MILEAGE: ['MILE_LOADED', 'MILE_EMPTY', 'COUNT_STOPS', 'FLAT_LEG', 'ATTR_HAZMAT', 'ATTR_TARP', 'TIME_WAITING'],
  HOURLY: ['TIME_DURATION', 'TIME_WAITING', 'COUNT_STOPS', 'FLAT_LEG', 'ATTR_HAZMAT', 'ATTR_TARP'],
  PERCENTAGE: ['PCT_OF_LOAD', 'COUNT_STOPS', 'FLAT_LEG', 'ATTR_HAZMAT', 'ATTR_TARP', 'TIME_WAITING'],
  FLAT: ['FLAT_LOAD', 'COUNT_STOPS', 'FLAT_LEG', 'ATTR_HAZMAT', 'ATTR_TARP', 'TIME_WAITING'],
};

export function PayProfileEditor({
  open,
  onOpenChange,
  profileId,
  organizationId,
  userId,
  defaultProfileType = 'DRIVER',
  onSaved,
}: PayProfileEditorProps) {
  // Profile state
  const [name, setName] = useState('');
  const [description, setDescription] = useState('');
  const [profileType, setProfileType] = useState<ProfileType>(defaultProfileType);
  const [payBasis, setPayBasis] = useState<PayBasis>('MILEAGE');
  const [isDefault, setIsDefault] = useState(false);
  const [isActive, setIsActive] = useState(true);

  // Rules state - managed locally, synced on save
  const [rules, setRules] = useState<RuleFormData[]>([]);
  const [deletingRuleId, setDeletingRuleId] = useState<string | null>(null);

  // UI state
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [hasChanges, setHasChanges] = useState(false);
  const [showDefaultConfirm, setShowDefaultConfirm] = useState(false);

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
  const deleteRule = useMutation(api.rateRules.remove);

  // Initialize form when profile loads
  useEffect(() => {
    if (existingProfile) {
      setName(existingProfile.name);
      setDescription(existingProfile.description ?? '');
      setProfileType(existingProfile.profileType as ProfileType);
      setPayBasis(existingProfile.payBasis as PayBasis);
      setIsDefault(existingProfile.isDefault ?? false);
      setIsActive(existingProfile.isActive);

      // Load existing rules
      const loadedRules: RuleFormData[] = (existingProfile.allRules ?? []).map((r) => ({
        _id: r._id,
        name: r.name,
        category: r.category as RuleCategory,
        triggerEvent: r.triggerEvent as TriggerEvent,
        rateAmount: r.rateAmount.toString(),
        minThreshold: r.minThreshold?.toString(),
        maxCap: r.maxCap?.toString(),
        isActive: r.isActive,
        isEditing: false,
      }));
      setRules(loadedRules);
      setHasChanges(false);
    } else if (!profileId && open) {
      // New profile - reset form
      setName('');
      setDescription('');
      setProfileType(defaultProfileType);
      setPayBasis('MILEAGE');
      setIsDefault(false);
      setIsActive(true);
      // Add default base rule for new profiles
      setRules([
        {
          name: 'Base Loaded Miles',
          category: 'BASE',
          triggerEvent: 'MILE_LOADED',
          rateAmount: '',
          isActive: true,
          isNew: true,
          isEditing: true,
        },
      ]);
      setHasChanges(false);
    }
  }, [existingProfile, profileId, open]);

  // Handle pay basis change - update base rule trigger
  const handlePayBasisChange = (newBasis: PayBasis) => {
    setPayBasis(newBasis);
    setHasChanges(true);

    // Update the BASE rule's trigger to match new basis
    const newTrigger = PAY_BASIS_TRIGGERS[newBasis];
    setRules((prev) =>
      prev.map((rule) => {
        if (rule.category === 'BASE') {
          const newName = TRIGGER_LABELS[newTrigger].replace('s Worked', '').replace('s', '');
          return {
            ...rule,
            triggerEvent: newTrigger,
            name: `Base ${newName}`,
          };
        }
        return rule;
      })
    );
  };

  // Start editing a rule inline
  const handleEditRule = (index: number) => {
    setRules((prev) =>
      prev.map((r, i) => ({
        ...r,
        isEditing: i === index,
      }))
    );
  };

  // Cancel editing
  const handleCancelEdit = (index: number) => {
    setRules((prev) =>
      prev.map((r, i) => {
        if (i !== index) return r;
        if (r.isNew) {
          // Remove new unsaved rule
          return null as unknown as RuleFormData;
        }
        return { ...r, isEditing: false };
      }).filter(Boolean)
    );
  };

  // Save rule edit (local only)
  const handleSaveRuleEdit = (index: number) => {
    setRules((prev) =>
      prev.map((r, i) => (i === index ? { ...r, isEditing: false, isNew: false } : r))
    );
    setHasChanges(true);
  };

  // Update rule field
  const updateRuleField = (index: number, field: keyof RuleFormData, value: string | boolean) => {
    setRules((prev) =>
      prev.map((r, i) => (i === index ? { ...r, [field]: value } : r))
    );
    setHasChanges(true);
  };

  // Add new accessorial rule
  const handleAddRule = () => {
    const availableTriggers = TRIGGERS_BY_BASIS[payBasis].filter(
      (t) => !rules.some((r) => r.triggerEvent === t && r.category === 'BASE')
    );
    const defaultTrigger = availableTriggers.find((t) => t === 'COUNT_STOPS') ?? availableTriggers[0];

    setRules((prev) => [
      ...prev,
      {
        name: '',
        category: 'ACCESSORIAL',
        triggerEvent: defaultTrigger,
        rateAmount: '',
        isActive: true,
        isNew: true,
        isEditing: true,
      },
    ]);
  };

  // Delete rule
  const handleDeleteRule = async () => {
    if (!deletingRuleId) return;

    const ruleIndex = rules.findIndex((r) => r._id === deletingRuleId);
    if (ruleIndex === -1) {
      setDeletingRuleId(null);
      return;
    }

    const rule = rules[ruleIndex];

    // If it's an existing rule in DB, delete it
    if (rule._id && !rule.isNew) {
      try {
        await deleteRule({
          ruleId: rule._id as Id<'rateRules'>,
          userId,
        });
      } catch (error) {
        console.error('Failed to delete rule:', error);
        setDeletingRuleId(null);
        return;
      }
    }

    // Remove from local state
    setRules((prev) => prev.filter((r) => r._id !== deletingRuleId));
    setDeletingRuleId(null);
    setHasChanges(true);
  };

  // Save everything
  const handleSave = async () => {
    // Validation
    if (!name.trim()) {
      alert('Please enter a profile name');
      return;
    }

    const baseRule = rules.find((r) => r.category === 'BASE');
    if (!baseRule || !baseRule.rateAmount || parseFloat(baseRule.rateAmount) <= 0) {
      alert('Please enter a valid base rate');
      return;
    }

    // Check all rules have required fields
    for (const rule of rules) {
      if (!rule.name.trim()) {
        alert('All rules must have a name');
        return;
      }
      if (!rule.rateAmount || parseFloat(rule.rateAmount) <= 0) {
        alert(`Please enter a valid rate for "${rule.name}"`);
        return;
      }
    }

    setIsSubmitting(true);

    try {
      let targetProfileId = profileId;

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
      } else {
        // Create new profile
        targetProfileId = await createProfile({
          workosOrgId: organizationId,
          name: name.trim(),
          description: description.trim() || undefined,
          profileType,
          payBasis,
          isDefault,
          createdBy: userId,
        });
      }

      // Sync rules
      for (const rule of rules) {
        if (rule._id && !rule.isNew) {
          // Update existing rule
          await updateRule({
            ruleId: rule._id as Id<'rateRules'>,
            name: rule.name,
            category: rule.category,
            triggerEvent: rule.triggerEvent,
            rateAmount: parseFloat(rule.rateAmount),
            minThreshold: rule.minThreshold ? parseFloat(rule.minThreshold) : undefined,
            maxCap: rule.maxCap ? parseFloat(rule.maxCap) : undefined,
            isActive: rule.isActive,
            userId,
          });
        } else {
          // Create new rule
          await createRule({
            profileId: targetProfileId!,
            name: rule.name,
            category: rule.category,
            triggerEvent: rule.triggerEvent,
            rateAmount: parseFloat(rule.rateAmount),
            minThreshold: rule.minThreshold ? parseFloat(rule.minThreshold) : undefined,
            maxCap: rule.maxCap ? parseFloat(rule.maxCap) : undefined,
            userId,
          });
        }
      }

      setHasChanges(false);
      onSaved?.();
      onOpenChange(false);
    } catch (error) {
      console.error('Failed to save profile:', error);
      alert('Failed to save profile');
    } finally {
      setIsSubmitting(false);
    }
  };

  // Get rules by category
  const baseRules = rules.filter((r) => r.category === 'BASE');
  const accessorialRules = rules.filter((r) => r.category === 'ACCESSORIAL' || r.category === 'DEDUCTION');

  const isEditing = !!profileId;

  return (
    <>
      <Sheet open={open} onOpenChange={onOpenChange}>
        <SheetContent className="w-full sm:max-w-[540px] overflow-y-auto">
          <SheetHeader className="pb-4 border-b">
            <div className="flex items-center justify-between">
              <SheetTitle>
                {isEditing ? 'Edit Pay Profile' : 'Create Pay Profile'}
              </SheetTitle>
              {isEditing && (
                <div className="flex items-center gap-2">
                  <span className="text-sm text-muted-foreground">Active</span>
                  <Switch checked={isActive} onCheckedChange={(checked) => { setIsActive(checked); setHasChanges(true); }} />
                </div>
              )}
            </div>
            <SheetDescription>
              Configure how {profileType === 'DRIVER' ? 'drivers' : 'carriers'} with this profile are compensated.
            </SheetDescription>
          </SheetHeader>

          <div className="py-6 space-y-8">
            {/* Section A: Profile Settings */}
            <section className="space-y-4">
              <h3 className="text-sm font-semibold text-muted-foreground uppercase tracking-wide">
                General Info
              </h3>

              <div className="space-y-4">
                {/* Profile Type - only shown for new profiles */}
                {!isEditing && (
                  <div className="space-y-2">
                    <Label>Profile Type</Label>
                    <div className="grid grid-cols-2 gap-2">
                      <Button
                        type="button"
                        variant={profileType === 'DRIVER' ? 'default' : 'outline'}
                        className="justify-start"
                        onClick={() => { setProfileType('DRIVER'); setHasChanges(true); }}
                      >
                        <User className="h-4 w-4 mr-2" />
                        Driver
                      </Button>
                      <Button
                        type="button"
                        variant={profileType === 'CARRIER' ? 'default' : 'outline'}
                        className="justify-start"
                        onClick={() => { setProfileType('CARRIER'); setHasChanges(true); }}
                      >
                        <Truck className="h-4 w-4 mr-2" />
                        Carrier
                      </Button>
                    </div>
                    <p className="text-xs text-muted-foreground">
                      {profileType === 'DRIVER' 
                        ? 'For company drivers (W2 employees)'
                        : 'For owner operators and external carriers (1099)'}
                    </p>
                  </div>
                )}

                {/* Show profile type badge when editing */}
                {isEditing && (
                  <div className="flex items-center gap-2 p-2 bg-muted rounded-lg">
                    {profileType === 'DRIVER' ? (
                      <><User className="h-4 w-4" /><span className="text-sm font-medium">Driver Profile</span></>
                    ) : (
                      <><Truck className="h-4 w-4" /><span className="text-sm font-medium">Carrier Profile</span></>
                    )}
                  </div>
                )}

                <div className="space-y-2">
                  <Label htmlFor="name">Profile Name</Label>
                  <Input
                    id="name"
                    value={name}
                    onChange={(e) => { setName(e.target.value); setHasChanges(true); }}
                    placeholder="e.g., Standard OTR, City Hourly"
                  />
                </div>

                <div className="space-y-2">
                  <Label>Pay Basis</Label>
                  <Select value={payBasis} onValueChange={(v) => handlePayBasisChange(v as PayBasis)}>
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
                      <SelectItem value="FLAT">
                        <div className="flex items-center gap-2">
                          <Banknote className="h-4 w-4" />
                          <span>Flat Rate per Load</span>
                        </div>
                      </SelectItem>
                    </SelectContent>
                  </Select>
                </div>

                <div className="space-y-2">
                  <Label htmlFor="description">Description (optional)</Label>
                  <Textarea
                    id="description"
                    value={description}
                    onChange={(e) => { setDescription(e.target.value); setHasChanges(true); }}
                    placeholder="When should this profile be used?"
                    rows={2}
                  />
                </div>

                <div className="flex items-center justify-between py-2">
                  <div>
                    <Label>Organization Default</Label>
                    <p className="text-xs text-muted-foreground">
                      Use as default for {profileType === 'DRIVER' ? 'drivers' : 'carriers'} without an assigned profile
                    </p>
                  </div>
                  <Switch
                    checked={isDefault}
                    onCheckedChange={(checked) => {
                      if (checked) {
                        // Show confirmation when enabling org default
                        setShowDefaultConfirm(true);
                      } else {
                        setIsDefault(false);
                        setHasChanges(true);
                      }
                    }}
                  />
                </div>
              </div>
            </section>

            {/* Section B: Compensation Rules */}
            <section className="space-y-4">
              <h3 className="text-sm font-semibold text-muted-foreground uppercase tracking-wide">
                Compensation Rules
              </h3>

              {/* Base Pay */}
              <div className="space-y-3">
                <h4 className="text-sm font-medium flex items-center gap-2">
                  <div className="h-2 w-2 rounded-full bg-primary" />
                  Base Pay
                </h4>

                {baseRules.map((rule, idx) => {
                  const ruleIndex = rules.findIndex((r) => r === rule);
                  return (
                    <RuleCard
                      key={rule._id ?? `base-${idx}`}
                      rule={rule}
                      payBasis={payBasis}
                      isBase
                      onEdit={() => handleEditRule(ruleIndex)}
                      onSave={() => handleSaveRuleEdit(ruleIndex)}
                      onCancel={() => handleCancelEdit(ruleIndex)}
                      onChange={(field, value) => updateRuleField(ruleIndex, field, value)}
                    />
                  );
                })}
              </div>

              {/* Accessorials & Bonuses */}
              <div className="space-y-3 pt-4">
                <h4 className="text-sm font-medium flex items-center gap-2">
                  <div className="h-2 w-2 rounded-full bg-green-500" />
                  Accessorials &amp; Bonuses
                </h4>

                {accessorialRules.length === 0 ? (
                  <p className="text-sm text-muted-foreground py-2">
                    No additional pay rules configured.
                  </p>
                ) : (
                  accessorialRules.map((rule, idx) => {
                    const ruleIndex = rules.findIndex((r) => r === rule);
                    return (
                      <RuleCard
                        key={rule._id ?? `acc-${idx}`}
                        rule={rule}
                        payBasis={payBasis}
                        onEdit={() => handleEditRule(ruleIndex)}
                        onSave={() => handleSaveRuleEdit(ruleIndex)}
                        onCancel={() => handleCancelEdit(ruleIndex)}
                        onChange={(field, value) => updateRuleField(ruleIndex, field, value)}
                        onDelete={() => setDeletingRuleId(rule._id ?? `new-${idx}`)}
                      />
                    );
                  })
                )}

                <Button
                  variant="outline"
                  size="sm"
                  className="w-full"
                  onClick={handleAddRule}
                >
                  <Plus className="h-4 w-4 mr-2" />
                  Add Rule
                </Button>
              </div>
            </section>
          </div>

          <SheetFooter className="border-t pt-4">
            <div className="flex gap-3 w-full">
              <Button
                variant="outline"
                className="flex-1"
                onClick={() => onOpenChange(false)}
              >
                Cancel
              </Button>
              <Button
                className="flex-1"
                onClick={handleSave}
                disabled={isSubmitting || (!hasChanges && isEditing)}
              >
                {isSubmitting ? 'Saving...' : isEditing ? 'Save Changes' : 'Create Profile'}
              </Button>
            </div>
          </SheetFooter>
        </SheetContent>
      </Sheet>

      {/* Delete Rule Confirmation */}
      <AlertDialog open={deletingRuleId !== null} onOpenChange={(open) => !open && setDeletingRuleId(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Delete Rule?</AlertDialogTitle>
            <AlertDialogDescription>
              This rule will be permanently removed from this profile.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction onClick={handleDeleteRule} className="bg-red-600 hover:bg-red-700">
              Delete
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      {/* Organization Default Confirmation */}
      <AlertDialog open={showDefaultConfirm} onOpenChange={setShowDefaultConfirm}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Set as Organization Default?</AlertDialogTitle>
            <AlertDialogDescription>
              This will make &quot;{name || 'this profile'}&quot; the default pay profile for all{' '}
              {profileType === 'DRIVER' ? 'drivers' : 'carriers'} in your organization who don&apos;t have a
              specific profile assigned.
              {existingProfile?.isDefault === false && (
                <span className="block mt-2 font-medium text-foreground">
                  Any existing organization default for {profileType === 'DRIVER' ? 'drivers' : 'carriers'} will be replaced.
                </span>
              )}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction
              onClick={() => {
                setIsDefault(true);
                setHasChanges(true);
                setShowDefaultConfirm(false);
              }}
            >
              Set as Default
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  );
}

// Rule Card Component - handles both view and edit states
interface RuleCardProps {
  rule: RuleFormData;
  payBasis: PayBasis;
  isBase?: boolean;
  onEdit: () => void;
  onSave: () => void;
  onCancel: () => void;
  onChange: (field: keyof RuleFormData, value: string | boolean) => void;
  onDelete?: () => void;
}

function RuleCard({
  rule,
  payBasis,
  isBase,
  onEdit,
  onSave,
  onCancel,
  onChange,
  onDelete,
}: RuleCardProps) {
  const availableTriggers = isBase
    ? BASE_TRIGGERS_BY_BASIS[payBasis]
    : TRIGGERS_BY_BASIS[payBasis];

  if (rule.isEditing) {
    // Edit Mode - Inline Form
    return (
      <div className="border rounded-lg p-4 space-y-3 bg-muted/30">
        <div className="grid grid-cols-2 gap-3">
          <div className="space-y-1">
            <Label className="text-xs">Rule Name</Label>
            <Input
              value={rule.name}
              onChange={(e) => onChange('name', e.target.value)}
              placeholder="e.g., Detention Pay"
              className="h-9"
            />
          </div>
          <div className="space-y-1">
            <Label className="text-xs">Trigger</Label>
            <Select
              value={rule.triggerEvent}
              onValueChange={(v) => onChange('triggerEvent', v)}
            >
              <SelectTrigger className="h-9">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {availableTriggers.map((trigger) => (
                  <SelectItem key={trigger} value={trigger}>
                    {TRIGGER_LABELS[trigger]}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
        </div>

        <div className="grid grid-cols-3 gap-3">
          <div className="space-y-1">
            <Label className="text-xs">
              Rate {rule.triggerEvent === 'PCT_OF_LOAD' ? '(%)' : '($)'}
            </Label>
            <div className="relative">
              <span className="absolute left-3 top-1/2 -translate-y-1/2 text-muted-foreground text-sm">
                {rule.triggerEvent === 'PCT_OF_LOAD' ? '%' : '$'}
              </span>
              <Input
                type="number"
                step="0.01"
                min="0"
                value={rule.rateAmount}
                onChange={(e) => onChange('rateAmount', e.target.value)}
                className="h-9 pl-7"
                placeholder="0.00"
              />
            </div>
          </div>
          <div className="space-y-1">
            <Label className="text-xs">Min Threshold</Label>
            <Input
              type="number"
              step="0.01"
              min="0"
              value={rule.minThreshold ?? ''}
              onChange={(e) => onChange('minThreshold', e.target.value)}
              className="h-9"
              placeholder="Optional"
            />
          </div>
          <div className="space-y-1">
            <Label className="text-xs">Max Cap ($)</Label>
            <Input
              type="number"
              step="0.01"
              min="0"
              value={rule.maxCap ?? ''}
              onChange={(e) => onChange('maxCap', e.target.value)}
              className="h-9"
              placeholder="Optional"
            />
          </div>
        </div>

        <div className="flex items-center justify-between pt-2">
          <div className="flex items-center gap-2">
            <Switch
              checked={rule.isActive}
              onCheckedChange={(checked) => onChange('isActive', checked)}
              id={`active-${rule._id}`}
            />
            <Label htmlFor={`active-${rule._id}`} className="text-xs">
              Active
            </Label>
          </div>
          <div className="flex gap-2">
            <Button variant="ghost" size="sm" onClick={onCancel}>
              <X className="h-4 w-4 mr-1" />
              Cancel
            </Button>
            <Button size="sm" onClick={onSave}>
              <Check className="h-4 w-4 mr-1" />
              Done
            </Button>
          </div>
        </div>
      </div>
    );
  }

  // View Mode
  return (
    <div className={`border rounded-lg p-3 ${!rule.isActive ? 'opacity-50' : ''} ${isBase ? 'bg-primary/5 border-primary/20' : ''}`}>
      <div className="flex items-center justify-between">
        <div className="flex-1">
          <div className="flex items-center gap-2">
            <span className="font-medium">{rule.name}</span>
            {!rule.isActive && (
              <Badge variant="secondary" className="text-xs">
                Inactive
              </Badge>
            )}
          </div>
          <p className="text-sm text-muted-foreground">
            {rule.triggerEvent === 'PCT_OF_LOAD'
              ? `${rule.rateAmount}% ${TRIGGER_UNITS[rule.triggerEvent]}`
              : `$${parseFloat(rule.rateAmount || '0').toFixed(2)} ${TRIGGER_UNITS[rule.triggerEvent]}`}
            {rule.minThreshold && ` (after ${rule.minThreshold})`}
            {rule.maxCap && ` (max $${rule.maxCap})`}
          </p>
        </div>
        <div className="flex items-center gap-1">
          <Button variant="ghost" size="icon" className="h-8 w-8" onClick={onEdit}>
            <Pencil className="h-4 w-4" />
          </Button>
          {!isBase && onDelete && (
            <Button variant="ghost" size="icon" className="h-8 w-8 text-red-600" onClick={onDelete}>
              <Trash2 className="h-4 w-4" />
            </Button>
          )}
        </div>
      </div>
    </div>
  );
}
