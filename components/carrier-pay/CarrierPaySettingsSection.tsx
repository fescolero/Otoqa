'use client';

import { useState } from 'react';
import { useQuery, useMutation } from 'convex/react';
import { api } from '@/convex/_generated/api';
import { Id } from '@/convex/_generated/dataModel';
import { Button } from '@/components/ui/button';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
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
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { Label } from '@/components/ui/label';
import {
  Plus,
  DollarSign,
  Clock,
  Percent,
  Trash2,
  ExternalLink,
  Eye,
  Star,
  MoreHorizontal,
  Banknote,
} from 'lucide-react';
import Link from 'next/link';
import { PayProfileEditor } from '@/components/driver-pay/PayProfileEditor';

interface CarrierPaySettingsSectionProps {
  carrierPartnershipId: Id<'carrierPartnerships'>;
  organizationId: string;
  userId: string;
}

export function CarrierPaySettingsSection({
  carrierPartnershipId,
  organizationId,
  userId,
}: CarrierPaySettingsSectionProps) {
  const [addModalOpen, setAddModalOpen] = useState(false);
  const [deletingAssignment, setDeletingAssignment] = useState<string | null>(null);
  const [viewingProfileId, setViewingProfileId] = useState<string | null>(null);

  // Form state
  const [selectedProfileId, setSelectedProfileId] = useState<string>('');
  const [isSubmitting, setIsSubmitting] = useState(false);

  // Fetch carrier's profile assignments
  const assignments = useQuery(api.carrierProfileAssignments.getForCarrierPartnership, { 
    carrierPartnershipId 
  });

  // Fetch available profiles (CARRIER type only)
  const profiles = useQuery(
    api.rateProfiles.list,
    organizationId ? { workosOrgId: organizationId, profileType: 'CARRIER' } : 'skip'
  );

  // Mutations
  const assignProfile = useMutation(api.carrierProfileAssignments.assign);
  const removeAssignment = useMutation(api.carrierProfileAssignments.remove);
  const setDefaultAssignment = useMutation(api.carrierProfileAssignments.setDefault);

  const getPayBasisIcon = (payBasis: string) => {
    switch (payBasis) {
      case 'MILEAGE':
        return <DollarSign className="h-4 w-4" />;
      case 'HOURLY':
        return <Clock className="h-4 w-4" />;
      case 'PERCENTAGE':
        return <Percent className="h-4 w-4" />;
      case 'FLAT':
        return <Banknote className="h-4 w-4" />;
      default:
        return <DollarSign className="h-4 w-4" />;
    }
  };

  const getPayBasisLabel = (payBasis: string) => {
    switch (payBasis) {
      case 'MILEAGE':
        return 'Per Mile';
      case 'HOURLY':
        return 'Hourly';
      case 'PERCENTAGE':
        return '% of Load';
      case 'FLAT':
        return 'Flat Rate';
      default:
        return payBasis;
    }
  };

  const resetForm = () => {
    setSelectedProfileId('');
  };

  const handleOpenAddModal = () => {
    resetForm();
    setAddModalOpen(true);
  };

  const handleSubmit = async () => {
    if (!selectedProfileId) {
      alert('Please select a profile');
      return;
    }

    setIsSubmitting(true);

    try {
      await assignProfile({
        carrierPartnershipId,
        profileId: selectedProfileId as Id<'rateProfiles'>,
        selectionStrategy: 'ALWAYS_ACTIVE',
        userId,
        workosOrgId: organizationId,
      });
      setAddModalOpen(false);
      resetForm();
    } catch (error) {
      console.error('Failed to save assignment:', error);
      alert('Failed to save assignment');
    } finally {
      setIsSubmitting(false);
    }
  };

  const handleDelete = async () => {
    if (!deletingAssignment) return;

    try {
      await removeAssignment({
        assignmentId: deletingAssignment as Id<'carrierProfileAssignments'>,
      });
      setDeletingAssignment(null);
    } catch (error) {
      console.error('Failed to remove assignment:', error);
    }
  };

  // Get profiles not yet assigned to this carrier
  const availableProfiles = profiles?.filter(
    (p) => p.isActive && !assignments?.some((a) => a.profileId === p._id)
  );

  // Check if any profile is explicitly starred
  const hasExplicitDefault = assignments?.some((a) => a.isDefault);

  // Determine if a profile is the "active" one for pay calculation
  const isActiveProfile = (assignment: { isDefault?: boolean }) => {
    return assignment.isDefault === true;
  };

  return (
    <>
      {/* Section Header - matches settlement ledger style */}
      <div className="flex items-center justify-between mb-3">
        <div>
          <h2 className="text-sm font-semibold">Pay Profiles</h2>
          <p className="text-xs text-muted-foreground">
            Compensation profiles assigned to this carrier
          </p>
        </div>
        <div className="flex items-center gap-2">
          <Link href="/org-settings/driver-pay-profiles">
            <Button variant="ghost" size="sm" className="h-8 text-xs text-muted-foreground hover:text-foreground">
              <ExternalLink className="h-3.5 w-3.5 mr-1.5" />
              Manage Profiles
            </Button>
          </Link>
          <Button onClick={handleOpenAddModal} size="sm" className="h-8">
            <Plus className="h-3.5 w-3.5 mr-1.5" />
            Add Profile
          </Button>
        </div>
      </div>

      {/* Profiles List - Settlement Ledger Style */}
      {assignments === undefined ? (
        <div className="p-6 text-center">
          <p className="text-muted-foreground text-sm">Loading...</p>
        </div>
      ) : assignments.length === 0 ? (
        <div className="py-8 text-center border rounded-lg bg-muted/20">
          <DollarSign className="h-8 w-8 mx-auto text-muted-foreground mb-2" />
          <p className="text-sm text-muted-foreground mb-3">No pay profiles assigned</p>
          <Button size="sm" className="h-8" onClick={handleOpenAddModal}>
            <Plus className="h-3.5 w-3.5 mr-1.5" />
            Add Profile
          </Button>
        </div>
      ) : (
        <div className="border rounded-lg overflow-hidden">
          {/* Table Header - Pro ledger style */}
          <div className="grid grid-cols-[28px_1fr_90px_110px_40px] gap-2 px-3 py-1.5 bg-slate-50 dark:bg-slate-900 border-b">
            <div></div>
            <div className="text-[10px] font-semibold text-slate-500 uppercase tracking-wide">Profile</div>
            <div className="text-[10px] font-semibold text-slate-500 uppercase tracking-wide">Pay Basis</div>
            <div className="text-[10px] font-semibold text-slate-500 uppercase tracking-wide text-right">Base Rate</div>
            <div></div>
          </div>
          
          {/* Table Body - high-density ledger rows */}
          <div className="divide-y divide-slate-100 dark:divide-slate-800">
            {assignments.map((assignment) => {
              const isActive = isActiveProfile(assignment);
              return (
                <div 
                  key={assignment._id} 
                  className={`grid grid-cols-[28px_1fr_90px_110px_40px] gap-2 px-3 py-2 items-center group transition-colors ${
                    isActive 
                      ? 'bg-blue-50/40 dark:bg-blue-950/30 border-l-[3px] border-l-blue-500' 
                      : 'hover:bg-slate-50/50 dark:hover:bg-slate-900/50 border-l-[3px] border-l-transparent'
                  }`}
                >
                  {/* Star Toggle - vertically centered */}
                  <div className="flex items-center justify-center">
                    <button
                      onClick={async () => {
                        try {
                          if (!assignment.isDefault) {
                            await setDefaultAssignment({
                              assignmentId: assignment._id as Id<'carrierProfileAssignments'>,
                            });
                          }
                        } catch (error) {
                          console.error('Failed to toggle default:', error);
                        }
                      }}
                      className={`flex items-center justify-center ${isActive 
                        ? "text-blue-500 hover:text-blue-600 transition-colors" 
                        : "text-slate-300 dark:text-slate-600 hover:text-blue-500 transition-colors"
                      }`}
                      title={isActive ? "Active Profile" : "Set as Active"}
                    >
                      <Star className={`h-3.5 w-3.5 ${isActive ? 'fill-blue-500' : ''}`} />
                    </button>
                  </div>

                  {/* Profile Name + Badges */}
                  <div className="flex items-center gap-2 min-w-0">
                    <div className={`p-1 rounded ${isActive ? 'bg-blue-100 dark:bg-blue-900' : 'bg-slate-100 dark:bg-slate-800'}`}>
                      {getPayBasisIcon(assignment.profilePayBasis ?? 'MILEAGE')}
                    </div>
                    <span className="font-medium text-sm truncate">{assignment.profileName}</span>
                    {isActive && (
                      <span className="px-1.5 py-0.5 text-[10px] font-medium bg-blue-100 dark:bg-blue-900 text-blue-600 dark:text-blue-400 rounded">
                        Active
                      </span>
                    )}
                  </div>

                  {/* Pay Basis */}
                  <div className="text-xs text-muted-foreground">
                    {getPayBasisLabel(assignment.profilePayBasis ?? 'MILEAGE')}
                  </div>

                  {/* Base Rate - right aligned, tabular-nums, monospace */}
                  <div className="text-right font-mono">
                    {assignment.baseRate !== undefined ? (
                      <span className="font-medium text-sm tabular-nums" style={{ fontVariantNumeric: 'tabular-nums' }}>
                        {assignment.profilePayBasis === 'PERCENTAGE'
                          ? `${assignment.baseRate.toFixed(1)}%`
                          : `$${assignment.baseRate.toFixed(2)}`}
                        <span className="text-muted-foreground text-[10px] ml-0.5">
                          {assignment.profilePayBasis === 'MILEAGE' && '/mi'}
                          {assignment.profilePayBasis === 'HOURLY' && '/hr'}
                        </span>
                      </span>
                    ) : (
                      <span className="text-muted-foreground text-sm">—</span>
                    )}
                  </div>

                  {/* Actions - muted ellipsis, vertically centered, hover reveal */}
                  <div className="flex items-center justify-end">
                    <DropdownMenu>
                      <DropdownMenuTrigger asChild>
                        <Button 
                          variant="ghost" 
                          size="icon" 
                          className="h-6 w-6 opacity-0 group-hover:opacity-100 transition-opacity flex items-center justify-center"
                        >
                          <MoreHorizontal className="h-3.5 w-3.5 text-slate-400" />
                        </Button>
                      </DropdownMenuTrigger>
                      <DropdownMenuContent align="end">
                        <DropdownMenuItem onClick={() => setViewingProfileId(assignment.profileId)}>
                          <Eye className="h-4 w-4 mr-2" />
                          View Profile
                        </DropdownMenuItem>
                        {!assignment.isDefault && (
                          <DropdownMenuItem
                            onClick={async () => {
                              try {
                                await setDefaultAssignment({
                                  assignmentId: assignment._id as Id<'carrierProfileAssignments'>,
                                });
                              } catch (error) {
                                console.error('Failed to set default:', error);
                              }
                            }}
                          >
                            <Star className="h-4 w-4 mr-2" />
                            Set as Active
                          </DropdownMenuItem>
                        )}
                        <DropdownMenuItem
                          onClick={() => setDeletingAssignment(assignment._id)}
                          className="text-red-600"
                        >
                          <Trash2 className="h-4 w-4 mr-2" />
                          Remove
                        </DropdownMenuItem>
                      </DropdownMenuContent>
                    </DropdownMenu>
                  </div>
                </div>
              );
            })}
          </div>
        </div>
      )}

      {/* Add Profile Modal */}
      <Dialog
        open={addModalOpen}
        onOpenChange={(open) => {
          if (!open) {
            setAddModalOpen(false);
            resetForm();
          }
        }}
      >
        <DialogContent className="sm:max-w-[425px]">
          <DialogHeader>
            <DialogTitle>Add Pay Profile</DialogTitle>
            <DialogDescription>
              Assign a pay profile to this carrier for automatic pay calculation.
            </DialogDescription>
          </DialogHeader>

          <div className="space-y-4 py-4">
            <div className="space-y-2">
              <Label>Pay Profile</Label>
              <Select
                value={selectedProfileId}
                onValueChange={setSelectedProfileId}
              >
                <SelectTrigger>
                  <SelectValue placeholder="Select a profile..." />
                </SelectTrigger>
                <SelectContent>
                  {availableProfiles?.length === 0 ? (
                    <div className="p-2 text-sm text-muted-foreground text-center">
                      {profiles?.filter(p => p.isActive).length === 0 
                        ? 'No carrier profiles created yet'
                        : 'All profiles are already assigned'}
                    </div>
                  ) : (
                    availableProfiles?.map((profile) => (
                      <SelectItem key={profile._id} value={profile._id}>
                        <div className="flex items-center gap-2">
                          {getPayBasisIcon(profile.payBasis)}
                          <span>{profile.name}</span>
                        </div>
                      </SelectItem>
                    ))
                  )}
                </SelectContent>
              </Select>
            </div>

            <div className="pt-2">
              <Link
                href="/org-settings/driver-pay-profiles"
                className="text-sm text-primary hover:underline flex items-center gap-1"
              >
                <Plus className="h-3 w-3" />
                Create New Profile
              </Link>
            </div>
          </div>

          <DialogFooter>
            <Button
              variant="outline"
              onClick={() => {
                setAddModalOpen(false);
                resetForm();
              }}
            >
              Cancel
            </Button>
            <Button onClick={handleSubmit} disabled={isSubmitting || !selectedProfileId}>
              {isSubmitting ? 'Adding...' : 'Add Profile'}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Delete Confirmation */}
      <AlertDialog
        open={deletingAssignment !== null}
        onOpenChange={(open) => {
          if (!open) setDeletingAssignment(null);
        }}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Remove Profile Assignment?</AlertDialogTitle>
            <AlertDialogDescription>
              This will remove the pay profile from this carrier. They will no
              longer be compensated according to this profile's rules.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction
              onClick={handleDelete}
              className="bg-red-600 hover:bg-red-700"
            >
              Remove
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      {/* Profile Editor (Slide-Over) */}
      {viewingProfileId && (
        <PayProfileEditor
          open={viewingProfileId !== null}
          onOpenChange={(open) => {
            if (!open) setViewingProfileId(null);
          }}
          profileId={viewingProfileId as Id<'rateProfiles'>}
          organizationId={organizationId}
          userId={userId}
        />
      )}
    </>
  );
}
