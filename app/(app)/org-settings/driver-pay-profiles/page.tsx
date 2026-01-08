'use client';

import { useState } from 'react';
import { useQuery, useMutation } from 'convex/react';
import { api } from '@/convex/_generated/api';
import { Id } from '@/convex/_generated/dataModel';
import {
  Breadcrumb,
  BreadcrumbItem,
  BreadcrumbLink,
  BreadcrumbList,
  BreadcrumbPage,
  BreadcrumbSeparator,
} from '@/components/ui/breadcrumb';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Separator } from '@/components/ui/separator';
import { SidebarTrigger } from '@/components/ui/sidebar';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import { useAuth } from '@workos-inc/authkit-nextjs/components';
import { useOrganizationId } from '@/contexts/organization-context';
import {
  Plus,
  DollarSign,
  Clock,
  Percent,
  MoreHorizontal,
  Pencil,
  Archive,
  RotateCcw,
  Star,
  User,
  Truck,
  Banknote,
} from 'lucide-react';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { PayProfileEditor } from '@/components/driver-pay/PayProfileEditor';

export default function DriverPayProfilesPage() {
  const { user } = useAuth();
  const organizationId = useOrganizationId();

  const [editorOpen, setEditorOpen] = useState(false);
  const [editingProfileId, setEditingProfileId] = useState<Id<'rateProfiles'> | undefined>(undefined);
  const [showInactive, setShowInactive] = useState(false);

  // Fetch profiles
  const profiles = useQuery(
    api.rateProfiles.list,
    organizationId ? { workosOrgId: organizationId, includeInactive: showInactive } : 'skip'
  );

  // Mutations
  const deactivateProfile = useMutation(api.rateProfiles.deactivate);
  const reactivateProfile = useMutation(api.rateProfiles.reactivate);

  const handleDeactivate = async (profileId: Id<'rateProfiles'>) => {
    if (!user) return;
    try {
      await deactivateProfile({ profileId, userId: user.id });
    } catch (error) {
      console.error('Failed to deactivate profile:', error);
    }
  };

  const handleReactivate = async (profileId: Id<'rateProfiles'>) => {
    if (!user) return;
    try {
      await reactivateProfile({ profileId, userId: user.id });
    } catch (error) {
      console.error('Failed to reactivate profile:', error);
    }
  };

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

  return (
    <>
      <header className="flex h-16 shrink-0 items-center gap-2 transition-[width,height] ease-linear group-has-data-[collapsible=icon]/sidebar-wrapper:h-12 border-b">
        <div className="flex items-center gap-2 px-4">
          <SidebarTrigger className="-ml-1" />
          <Separator orientation="vertical" className="mr-2 data-[orientation=vertical]:h-4" />
          <Breadcrumb>
            <BreadcrumbList>
              <BreadcrumbItem className="hidden md:block">
                <BreadcrumbLink href="/dashboard">Dashboard</BreadcrumbLink>
              </BreadcrumbItem>
              <BreadcrumbSeparator className="hidden md:block" />
              <BreadcrumbItem className="hidden md:block">
                <BreadcrumbLink href="/org-settings">Organization Settings</BreadcrumbLink>
              </BreadcrumbItem>
              <BreadcrumbSeparator className="hidden md:block" />
              <BreadcrumbItem>
                <BreadcrumbPage>Pay Profiles</BreadcrumbPage>
              </BreadcrumbItem>
            </BreadcrumbList>
          </Breadcrumb>
        </div>
      </header>

      <div className="flex flex-1 flex-col gap-6 p-6">
        {/* Page Header */}
        <div className="flex items-center justify-between">
          <div>
            <h1 className="text-3xl font-bold tracking-tight">Pay Profiles</h1>
            <p className="text-muted-foreground">
              Configure pay structures and rules for driver and carrier compensation
            </p>
          </div>
          <div className="flex items-center gap-3">
            <Button
              variant="outline"
              onClick={() => setShowInactive(!showInactive)}
            >
              {showInactive ? 'Hide Inactive' : 'Show Inactive'}
            </Button>
            <Button onClick={() => { setEditingProfileId(undefined); setEditorOpen(true); }}>
              <Plus className="h-4 w-4 mr-2" />
              New Profile
            </Button>
          </div>
        </div>

        {/* Profiles Table */}
        {profiles === undefined ? (
          <div className="flex items-center justify-center py-12">
            <p className="text-muted-foreground">Loading profiles...</p>
          </div>
        ) : profiles.length === 0 ? (
          <Card className="p-12">
            <div className="text-center">
              <DollarSign className="h-12 w-12 mx-auto text-muted-foreground mb-4" />
              <h3 className="text-lg font-semibold mb-2">No pay profiles yet</h3>
              <p className="text-muted-foreground mb-6">
                Create your first pay profile to start configuring driver and carrier compensation.
              </p>
              <Button onClick={() => { setEditingProfileId(undefined); setEditorOpen(true); }}>
                <Plus className="h-4 w-4 mr-2" />
                Create Profile
              </Button>
            </div>
          </Card>
        ) : (
          <Card>
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead className="w-[300px]">Profile Name</TableHead>
                  <TableHead>Type</TableHead>
                  <TableHead>Pay Basis</TableHead>
                  <TableHead>Status</TableHead>
                  <TableHead className="text-right">Actions</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {profiles.map((profile) => (
                  <TableRow
                    key={profile._id}
                    className={`cursor-pointer ${!profile.isActive ? 'opacity-60' : ''}`}
                    onClick={() => { setEditingProfileId(profile._id); setEditorOpen(true); }}
                  >
                    <TableCell>
                      <div className="flex items-center gap-3">
                        <div className="p-2 bg-primary/10 rounded-lg">
                          {getPayBasisIcon(profile.payBasis)}
                        </div>
                        <div>
                          <div className="font-medium flex items-center gap-2">
                            {profile.name}
                            {profile.isDefault && (
                              <Badge variant="default" className="bg-yellow-500 text-xs">
                                Org Default
                              </Badge>
                            )}
                          </div>
                          {profile.description && (
                            <p className="text-sm text-muted-foreground line-clamp-1">
                              {profile.description}
                            </p>
                          )}
                        </div>
                      </div>
                    </TableCell>
                    <TableCell>
                      <div className="flex items-center gap-1.5">
                        {profile.profileType === 'DRIVER' ? (
                          <><User className="h-4 w-4 text-muted-foreground" /><span>Driver</span></>
                        ) : (
                          <><Truck className="h-4 w-4 text-muted-foreground" /><span>Carrier</span></>
                        )}
                      </div>
                    </TableCell>
                    <TableCell>{getPayBasisLabel(profile.payBasis)}</TableCell>
                    <TableCell>
                      <Badge variant={profile.isActive ? 'outline' : 'secondary'}>
                        {profile.isActive ? 'Active' : 'Inactive'}
                      </Badge>
                    </TableCell>
                    <TableCell className="text-right">
                      <DropdownMenu>
                        <DropdownMenuTrigger asChild onClick={(e) => e.stopPropagation()}>
                          <Button variant="ghost" size="icon" className="h-8 w-8">
                            <MoreHorizontal className="h-4 w-4" />
                          </Button>
                        </DropdownMenuTrigger>
                        <DropdownMenuContent align="end">
                          <DropdownMenuItem
                            onClick={(e) => {
                              e.stopPropagation();
                              setEditingProfileId(profile._id);
                              setEditorOpen(true);
                            }}
                          >
                            <Pencil className="h-4 w-4 mr-2" />
                            Edit Profile
                          </DropdownMenuItem>
                          {profile.isActive ? (
                            <DropdownMenuItem
                              onClick={(e) => {
                                e.stopPropagation();
                                handleDeactivate(profile._id);
                              }}
                              className="text-orange-600"
                            >
                              <Archive className="h-4 w-4 mr-2" />
                              Deactivate
                            </DropdownMenuItem>
                          ) : (
                            <DropdownMenuItem
                              onClick={(e) => {
                                e.stopPropagation();
                                handleReactivate(profile._id);
                              }}
                              className="text-green-600"
                            >
                              <RotateCcw className="h-4 w-4 mr-2" />
                              Reactivate
                            </DropdownMenuItem>
                          )}
                        </DropdownMenuContent>
                      </DropdownMenu>
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </Card>
        )}
      </div>

      {/* Unified Profile Editor (Slide-Over) */}
      {organizationId && user && (
        <PayProfileEditor
          open={editorOpen}
          onOpenChange={(open) => {
            setEditorOpen(open);
            if (!open) setEditingProfileId(undefined);
          }}
          profileId={editingProfileId}
          organizationId={organizationId}
          userId={user.id}
        />
      )}
    </>
  );
}
