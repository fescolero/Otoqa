'use client';

import { useState } from 'react';
import { useQuery, useMutation } from 'convex/react';
import { api } from '@/convex/_generated/api';
import { Id } from '@/convex/_generated/dataModel';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Switch } from '@/components/ui/switch';
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
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
  Plus,
  Pencil,
  Trash2,
  DollarSign,
  Clock,
  Percent,
  Star,
} from 'lucide-react';
import { RuleFormModal } from './RuleFormModal';

interface ProfileDetailModalProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  profileId: Id<'rateProfiles'>;
  organizationId: string;
  userId: string;
  onEdit: () => void;
}

const TRIGGER_LABELS: Record<string, string> = {
  MILE_LOADED: 'Per Loaded Mile',
  MILE_EMPTY: 'Per Empty Mile',
  TIME_DURATION: 'Per Hour',
  TIME_WAITING: 'Waiting Time',
  COUNT_STOPS: 'Per Stop',
  FLAT_LEG: 'Flat Rate per Leg',
  ATTR_HAZMAT: 'HazMat Load',
  ATTR_TARP: 'Tarp Required',
  PCT_OF_LOAD: '% of Load Revenue',
};

const CATEGORY_COLORS: Record<string, string> = {
  BASE: 'bg-blue-100 text-blue-800',
  ACCESSORIAL: 'bg-green-100 text-green-800',
  DEDUCTION: 'bg-red-100 text-red-800',
};

export function ProfileDetailModal({
  open,
  onOpenChange,
  profileId,
  organizationId,
  userId,
  onEdit,
}: ProfileDetailModalProps) {
  const [addRuleOpen, setAddRuleOpen] = useState(false);
  const [editingRuleId, setEditingRuleId] = useState<Id<'rateRules'> | null>(null);
  const [deletingRuleId, setDeletingRuleId] = useState<Id<'rateRules'> | null>(null);

  // Fetch profile with rules
  const profile = useQuery(api.rateProfiles.get, { profileId });
  const rules = useQuery(api.rateRules.listByProfile, { profileId });

  // Mutations
  const toggleRuleActive = useMutation(api.rateRules.toggleActive);
  const removeRule = useMutation(api.rateRules.remove);

  const handleToggleRule = async (ruleId: Id<'rateRules'>) => {
    try {
      // API toggles the current value, no need to pass isActive
      await toggleRuleActive({ ruleId, userId });
    } catch (error) {
      console.error('Failed to toggle rule:', error);
    }
  };

  const handleDeleteRule = async () => {
    if (!deletingRuleId) return;
    try {
      await removeRule({ ruleId: deletingRuleId, userId });
      setDeletingRuleId(null);
    } catch (error) {
      console.error('Failed to delete rule:', error);
    }
  };

  const getPayBasisIcon = (payBasis: string) => {
    switch (payBasis) {
      case 'MILEAGE':
        return <DollarSign className="h-5 w-5" />;
      case 'HOURLY':
        return <Clock className="h-5 w-5" />;
      case 'PERCENTAGE':
        return <Percent className="h-5 w-5" />;
      default:
        return <DollarSign className="h-5 w-5" />;
    }
  };

  const formatRate = (rule: { triggerEvent: string; rateAmount: number }) => {
    if (rule.triggerEvent === 'PCT_OF_LOAD') {
      return `${rule.rateAmount}%`;
    }
    return `$${rule.rateAmount.toFixed(2)}`;
  };

  if (!profile) {
    return null;
  }

  return (
    <>
      <Dialog open={open} onOpenChange={onOpenChange}>
        <DialogContent className="sm:max-w-[700px] max-h-[90vh] overflow-y-auto">
          <DialogHeader>
            <div className="flex items-start justify-between">
              <div className="flex items-center gap-3">
                <div className="p-2 bg-primary/10 rounded-lg">
                  {getPayBasisIcon(profile.payBasis)}
                </div>
                <div>
                  <DialogTitle className="flex items-center gap-2">
                    {profile.name}
                    {profile.isDefault && (
                      <Star className="h-4 w-4 text-yellow-500 fill-yellow-500" />
                    )}
                  </DialogTitle>
                  <p className="text-sm text-muted-foreground mt-1">
                    {profile.description || 'No description'}
                  </p>
                </div>
              </div>
              <Button variant="outline" size="sm" onClick={onEdit}>
                <Pencil className="h-4 w-4 mr-2" />
                Edit Profile
              </Button>
            </div>
          </DialogHeader>

          <div className="py-4">
            {/* Profile Status */}
            <div className="flex items-center gap-2 mb-6">
              <Badge variant={profile.isActive ? 'default' : 'secondary'}>
                {profile.isActive ? 'Active' : 'Inactive'}
              </Badge>
              <Badge variant="outline">
                {profile.payBasis === 'MILEAGE' && 'Per Mile'}
                {profile.payBasis === 'HOURLY' && 'Hourly'}
                {profile.payBasis === 'PERCENTAGE' && '% of Load'}
              </Badge>
              {profile.isDefault && (
                <Badge className="bg-yellow-100 text-yellow-800">Default</Badge>
              )}
            </div>

            {/* Rules Section */}
            <div className="space-y-4">
              <div className="flex items-center justify-between">
                <h3 className="text-lg font-semibold">Pay Rules</h3>
                <Button size="sm" onClick={() => setAddRuleOpen(true)}>
                  <Plus className="h-4 w-4 mr-2" />
                  Add Rule
                </Button>
              </div>

              {rules === undefined ? (
                <p className="text-muted-foreground text-center py-4">
                  Loading rules...
                </p>
              ) : rules.length === 0 ? (
                <div className="text-center py-8 border rounded-lg">
                  <p className="text-muted-foreground mb-4">
                    No rules configured yet
                  </p>
                  <Button size="sm" onClick={() => setAddRuleOpen(true)}>
                    <Plus className="h-4 w-4 mr-2" />
                    Add First Rule
                  </Button>
                </div>
              ) : (
                <div className="border rounded-lg overflow-hidden">
                  <Table>
                    <TableHeader>
                      <TableRow>
                        <TableHead>Name</TableHead>
                        <TableHead>Type</TableHead>
                        <TableHead>Category</TableHead>
                        <TableHead className="text-right">Rate</TableHead>
                        <TableHead className="text-center">Active</TableHead>
                        <TableHead className="w-[80px]"></TableHead>
                      </TableRow>
                    </TableHeader>
                    <TableBody>
                      {rules.map((rule) => (
                        <TableRow key={rule._id}>
                          <TableCell className="font-medium">
                            {rule.name}
                          </TableCell>
                          <TableCell className="text-sm text-muted-foreground">
                            {TRIGGER_LABELS[rule.triggerEvent] || rule.triggerEvent}
                          </TableCell>
                          <TableCell>
                            <Badge
                              className={CATEGORY_COLORS[rule.category] || 'bg-gray-100'}
                            >
                              {rule.category}
                            </Badge>
                          </TableCell>
                          <TableCell className="text-right font-mono">
                            {formatRate(rule)}
                            {rule.maxCap && (
                              <span className="text-xs text-muted-foreground ml-1">
                                (max ${rule.maxCap})
                              </span>
                            )}
                          </TableCell>
                          <TableCell className="text-center">
                            <Switch
                              checked={rule.isActive}
                              onCheckedChange={() => handleToggleRule(rule._id)}
                            />
                          </TableCell>
                          <TableCell>
                            <div className="flex items-center gap-1">
                              <Button
                                variant="ghost"
                                size="icon"
                                className="h-8 w-8"
                                onClick={() => setEditingRuleId(rule._id)}
                              >
                                <Pencil className="h-4 w-4" />
                              </Button>
                              <Button
                                variant="ghost"
                                size="icon"
                                className="h-8 w-8 text-red-600"
                                onClick={() => setDeletingRuleId(rule._id)}
                              >
                                <Trash2 className="h-4 w-4" />
                              </Button>
                            </div>
                          </TableCell>
                        </TableRow>
                      ))}
                    </TableBody>
                  </Table>
                </div>
              )}
            </div>
          </div>
        </DialogContent>
      </Dialog>

      {/* Add/Edit Rule Modal */}
      <RuleFormModal
        open={addRuleOpen || editingRuleId !== null}
        onOpenChange={(open) => {
          if (!open) {
            setAddRuleOpen(false);
            setEditingRuleId(null);
          }
        }}
        profileId={profileId}
        ruleId={editingRuleId ?? undefined}
        organizationId={organizationId}
        userId={userId}
      />

      {/* Delete Confirmation */}
      <AlertDialog
        open={deletingRuleId !== null}
        onOpenChange={(open) => {
          if (!open) setDeletingRuleId(null);
        }}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Delete Rule?</AlertDialogTitle>
            <AlertDialogDescription>
              Are you sure you want to delete this rule? This action cannot be
              undone.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction
              onClick={handleDeleteRule}
              className="bg-red-600 hover:bg-red-700"
            >
              Delete
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  );
}
