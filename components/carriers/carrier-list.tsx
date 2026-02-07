"use client";

import * as React from "react";
import { useQuery, useMutation } from "convex/react";
import { useRouter } from "next/navigation";
import { api } from "@/convex/_generated/api";
import { Card } from "@/components/ui/card";
import { Tabs, TabsList, TabsTrigger, TabsContent } from "@/components/ui/tabs";
import { Badge } from "@/components/ui/badge";
import { Building2, CheckCircle, Search, AlertCircle, Ban, MinusCircle, Trash, Link2, Users } from "lucide-react";
import { CarrierFilterBar } from "./carrier-filter-bar";
import { VirtualizedCarriersTable } from "./virtualized-carriers-table";
import { FloatingActionBar } from "./floating-action-bar";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { toast } from "sonner";
import { Id } from "@/convex/_generated/dataModel";

interface CarrierListProps {
  workosOrgId: string;
  /**
   * Use the new partnership model (carrierPartnerships table)
   * When true, uses listPartnerships query instead of legacy carriers.list
   * Default: false for backward compatibility
   */
  usePartnerships?: boolean;
}

export function CarrierList({ workosOrgId, usePartnerships = false }: CarrierListProps) {
  const router = useRouter();
  const [activeTab, setActiveTab] = React.useState("all");
  const [searchQuery, setSearchQuery] = React.useState("");
  const [safetyRating, setSafetyRating] = React.useState("all");
  const [insuranceStatus, setInsuranceStatus] = React.useState("all");
  const [state, setState] = React.useState("all");
  const [selectedCarriers, setSelectedCarriers] = React.useState<Set<string>>(new Set());
  const [showDeactivateDialog, setShowDeactivateDialog] = React.useState(false);
  const [isDeactivating, setIsDeactivating] = React.useState(false);
  const [showReactivateDialog, setShowReactivateDialog] = React.useState(false);
  const [isReactivating, setIsReactivating] = React.useState(false);
  const [showPermanentDeleteDialog, setShowPermanentDeleteDialog] = React.useState(false);
  const [isPermanentlyDeleting, setIsPermanentlyDeleting] = React.useState(false);

  // Mutations for deactivation/reactivation/deletion
  const bulkTerminatePartnerships = useMutation(api.carrierPartnerships.bulkTerminate);
  const bulkReactivatePartnerships = useMutation(api.carrierPartnerships.bulkReactivate);
  const permanentlyDeletePartnerships = useMutation(api.carrierPartnerships.permanentlyDelete);

  // Fetch counts - use partnership counts
  const partnershipCounts = useQuery(
    api.carrierPartnerships.countPartnershipsByStatus,
    usePartnerships ? { brokerOrgId: workosOrgId } : "skip"
  );
  const counts = partnershipCounts;
  const totalCount = usePartnerships ? counts?.total : (counts as any)?.all;
  const insuranceExpiringCount = usePartnerships ? undefined : (counts as any)?.insuranceExpiring;

  // Fetch carrier partnerships
  const partnerships = useQuery(
    api.carrierPartnerships.listForBroker,
    usePartnerships
      ? {
          brokerOrgId: workosOrgId,
          status: activeTab === "all" ? undefined : activeTab.toUpperCase() as "ACTIVE" | "PENDING" | "INVITED" | "SUSPENDED" | "TERMINATED",
        }
      : "skip"
  );

  const carriers = partnerships;

  // Selection handlers
  const handleSelectCarrier = (id: string) => {
    setSelectedCarriers((prev) => {
      const newSet = new Set(prev);
      if (newSet.has(id)) {
        newSet.delete(id);
      } else {
        newSet.add(id);
      }
      return newSet;
    });
  };

  const handleSelectAll = () => {
    if (selectedCarriers.size === carriers?.length) {
      setSelectedCarriers(new Set());
    } else {
      setSelectedCarriers(new Set(carriers?.map((c) => c._id) || []));
    }
  };

  const handleCarrierClick = (id: string) => {
    router.push(`/operations/carriers/${id}`);
  };

  // Bulk action handlers
  const handleBulkMessage = () => {
    console.log('Message carriers:', Array.from(selectedCarriers));
    // TODO: Implement bulk message functionality
  };

  const handleUpdateStatus = (status: 'Active' | 'Inactive' | 'Vetting' | 'Suspended') => {
    console.log('Update carrier status to:', status, 'for carriers:', Array.from(selectedCarriers));
    // TODO: Implement bulk status update functionality
  };

  const handleBulkExport = () => {
    const selectedData = carriers?.filter((carrier) => selectedCarriers.has(carrier._id));
    console.log('Export carriers:', selectedData);
    // TODO: Implement bulk export functionality
  };

  const handleBulkDeactivate = () => {
    if (selectedCarriers.size === 0) return;
    setShowDeactivateDialog(true);
  };

  const confirmDeactivate = async () => {
    setIsDeactivating(true);
    const carrierIds = Array.from(selectedCarriers);
    
    try {
      if (usePartnerships) {
        // Use bulk terminate for partnerships
        const result = await bulkTerminatePartnerships({
          partnershipIds: carrierIds as Id<"carrierPartnerships">[],
          userId: "system", // In real app, get from auth context
          userName: "System",
        });
        
        if (result.failed > 0) {
          toast.error(`Terminated ${result.succeeded} partnerships, ${result.failed} failed`);
        } else {
          const assignmentMsg = result.totalReleasedAssignments > 0 
            ? `. Released ${result.totalReleasedAssignments} load assignment${result.totalReleasedAssignments !== 1 ? "s" : ""}` 
            : "";
          const loadsMsg = result.totalLoadsReopened > 0 
            ? `, ${result.totalLoadsReopened} load${result.totalLoadsReopened !== 1 ? "s" : ""} reopened` 
            : "";
          toast.success(`Successfully terminated ${result.succeeded} partnership${result.succeeded !== 1 ? "s" : ""}${assignmentMsg}${loadsMsg}`);
        }
      } else {
        toast.error("Legacy carriers are not supported in this view.");
        return;
      }
      
      // Clear selection after deactivation
      setSelectedCarriers(new Set());
    } catch (error) {
      console.error("Deactivation error:", error);
      toast.error("Failed to deactivate carriers. Please try again.");
    } finally {
      setIsDeactivating(false);
      setShowDeactivateDialog(false);
    }
  };

  const handleBulkReactivate = () => {
    if (selectedCarriers.size === 0) return;
    setShowReactivateDialog(true);
  };

  const confirmReactivate = async () => {
    setIsReactivating(true);
    const carrierIds = Array.from(selectedCarriers);
    
    try {
      if (usePartnerships) {
        // Use bulk reactivate for partnerships
        const result = await bulkReactivatePartnerships({
          partnershipIds: carrierIds as Id<"carrierPartnerships">[],
          userId: "system", // In real app, get from auth context
          userName: "System",
        });
        
        if (result.failed > 0) {
          toast.error(`Reactivated ${result.succeeded} partnerships, ${result.failed} failed`);
        } else {
          const details = [];
          if (result.carrierOrgsCreated > 0) {
            details.push(`created ${result.carrierOrgsCreated} org${result.carrierOrgsCreated !== 1 ? "s" : ""}`);
          }
          if (result.carrierOrgsRestored > 0) {
            details.push(`restored ${result.carrierOrgsRestored} org${result.carrierOrgsRestored !== 1 ? "s" : ""}`);
          }
          if (result.clerkSyncsScheduled > 0) {
            details.push(`${result.clerkSyncsScheduled} mobile login${result.clerkSyncsScheduled !== 1 ? "s" : ""} created`);
          }
          const detailsMsg = details.length > 0 ? ` (${details.join(", ")})` : "";
          toast.success(`Successfully reactivated ${result.succeeded} partnership${result.succeeded !== 1 ? "s" : ""}${detailsMsg}`);
        }
      } else {
        toast.error("Legacy carriers are not supported in this view.");
        return;
      }
      
      // Clear selection after reactivation
      setSelectedCarriers(new Set());
    } catch (error) {
      console.error("Reactivation error:", error);
      toast.error("Failed to reactivate carriers. Please try again.");
    } finally {
      setIsReactivating(false);
      setShowReactivateDialog(false);
    }
  };

  // Check if we're viewing terminated/deleted items
  const isTerminatedView = usePartnerships ? activeTab === "terminated" : activeTab === "deleted";

  const handlePermanentDelete = () => {
    if (selectedCarriers.size === 0) return;
    setShowPermanentDeleteDialog(true);
  };

  const confirmPermanentDelete = async () => {
    setIsPermanentlyDeleting(true);
    const carrierIds = Array.from(selectedCarriers);
    
    try {
      if (usePartnerships) {
        const result = await permanentlyDeletePartnerships({
          partnershipIds: carrierIds as Id<"carrierPartnerships">[],
          userId: "system",
          userName: "System",
        });
        
        if (result.failed > 0) {
          toast.error(`Deleted ${result.succeeded} carriers, ${result.failed} failed`);
        } else {
          const details = [];
          if (result.totalDeletedDrivers > 0) {
            details.push(`${result.totalDeletedDrivers} driver${result.totalDeletedDrivers !== 1 ? "s" : ""}`);
          }
          if (result.totalDeletedAssignments > 0) {
            details.push(`${result.totalDeletedAssignments} assignment${result.totalDeletedAssignments !== 1 ? "s" : ""}`);
          }
          const detailsMsg = details.length > 0 ? ` (including ${details.join(", ")})` : "";
          toast.success(`Permanently deleted ${result.succeeded} carrier${result.succeeded !== 1 ? "s" : ""}${detailsMsg}`);
        }
      } else {
        // Legacy carriers don't support permanent delete yet
        toast.error("Permanent deletion not supported for legacy carriers");
      }
      
      setSelectedCarriers(new Set());
    } catch (error) {
      console.error("Permanent deletion error:", error);
      toast.error("Failed to permanently delete carriers. Please try again.");
    } finally {
      setIsPermanentlyDeleting(false);
      setShowPermanentDeleteDialog(false);
    }
  };

  // Tab style for consistency
  const tabClassName =
    "data-[state=active]:border-b-2 data-[state=active]:border-primary data-[state=active]:!bg-transparent data-[state=active]:!shadow-none data-[state=active]:border-l-0 data-[state=active]:border-r-0 data-[state=active]:border-t-0 rounded-none px-4 py-3 !bg-transparent !shadow-none border-0";

  return (
    <div className="flex-1 flex flex-col gap-4 min-h-0">
      <Card className="flex-1 flex flex-col p-0 gap-0 overflow-hidden min-h-0">
        <Tabs value={activeTab} onValueChange={setActiveTab} className="w-full flex-1 flex flex-col gap-0 min-h-0">
          <div className="flex-shrink-0 px-4">
            <TabsList className="h-auto p-0 bg-transparent border-0">
              <TabsTrigger value="all" className={tabClassName}>
                <Building2 className="w-4 h-4 mr-2" />
                {usePartnerships ? "All Partners" : "All Carriers"}
                {totalCount !== undefined && (
                  <Badge variant="secondary" className="ml-2">
                    {totalCount}
                  </Badge>
                )}
              </TabsTrigger>
              <TabsTrigger value="active" className={tabClassName}>
                <CheckCircle className="w-4 h-4 mr-2" />
                Active
                {counts?.active !== undefined && (
                  <Badge variant="secondary" className="ml-2">
                    {counts.active}
                  </Badge>
                )}
              </TabsTrigger>
              {usePartnerships ? (
                <>
                  <TabsTrigger value="invited" className={tabClassName}>
                    <Users className="w-4 h-4 mr-2" />
                    Invited
                    {(counts as any)?.invited !== undefined && (counts as any).invited > 0 && (
                      <Badge variant="secondary" className="ml-2">
                        {(counts as any).invited}
                      </Badge>
                    )}
                  </TabsTrigger>
                  <TabsTrigger value="pending" className={tabClassName}>
                    <Link2 className="w-4 h-4 mr-2" />
                    Pending
                    {(counts as any)?.pending !== undefined && (counts as any).pending > 0 && (
                      <Badge variant="warning" className="ml-2">
                        {(counts as any).pending}
                      </Badge>
                    )}
                  </TabsTrigger>
                </>
              ) : (
                <TabsTrigger value="vetting" className={tabClassName}>
                  <Search className="w-4 h-4 mr-2" />
                  Vetting
                  {(counts as any)?.vetting !== undefined && (
                    <Badge variant="secondary" className="ml-2">
                      {(counts as any).vetting}
                    </Badge>
                  )}
                </TabsTrigger>
              )}
              <TabsTrigger value="expiring" className={tabClassName}>
                <AlertCircle className="w-4 h-4 mr-2" />
                Insurance Expiring
                {insuranceExpiringCount !== undefined && insuranceExpiringCount > 0 && (
                  <Badge variant="warning" className="ml-2">
                    {insuranceExpiringCount}
                  </Badge>
                )}
              </TabsTrigger>
              <TabsTrigger value="suspended" className={tabClassName}>
                <Ban className="w-4 h-4 mr-2" />
                Suspended
                {counts?.suspended !== undefined && (
                  <Badge variant="secondary" className="ml-2">
                    {counts.suspended}
                  </Badge>
                )}
              </TabsTrigger>
              {!usePartnerships && (
                <>
                  <TabsTrigger value="inactive" className={tabClassName}>
                    <MinusCircle className="w-4 h-4 mr-2" />
                    Inactive
                    {(counts as any)?.inactive !== undefined && (
                      <Badge variant="secondary" className="ml-2">
                        {(counts as any).inactive}
                      </Badge>
                    )}
                  </TabsTrigger>
                  <TabsTrigger value="deleted" className={tabClassName}>
                    <Trash className="w-4 h-4 mr-2" />
                    Deleted
                    {(counts as any)?.deleted !== undefined && (
                      <Badge variant="secondary" className="ml-2">
                        {(counts as any).deleted}
                      </Badge>
                    )}
                  </TabsTrigger>
                </>
              )}
              {usePartnerships && (
                <TabsTrigger value="terminated" className={tabClassName}>
                  <Trash className="w-4 h-4 mr-2" />
                  Terminated
                  {(counts as any)?.terminated !== undefined && (
                    <Badge variant="secondary" className="ml-2">
                      {(counts as any).terminated}
                    </Badge>
                  )}
                </TabsTrigger>
              )}
            </TabsList>
          </div>

          <div className="flex-1 flex flex-col overflow-hidden min-h-0">
            <CarrierFilterBar
              searchQuery={searchQuery}
              onSearchChange={setSearchQuery}
              safetyRating={safetyRating}
              onSafetyRatingChange={setSafetyRating}
              insuranceStatus={insuranceStatus}
              onInsuranceStatusChange={setInsuranceStatus}
              state={state}
              onStateChange={setState}
            />

            <div className="flex-1 p-4 overflow-hidden min-h-0 flex flex-col">
              <div className="border rounded-lg flex-1 min-h-0 overflow-hidden flex flex-col">
                {/* Floating Action Bar */}
                <FloatingActionBar
                  selectedCount={selectedCarriers.size}
                  onClearSelection={() => setSelectedCarriers(new Set())}
                  onMessage={handleBulkMessage}
                  onUpdateStatus={handleUpdateStatus}
                  onExport={handleBulkExport}
                  onDeactivate={handleBulkDeactivate}
                  onReactivate={handleBulkReactivate}
                  onPermanentDelete={handlePermanentDelete}
                  isTerminatedView={isTerminatedView}
                />

                {carriers === undefined ? (
                  <div className="flex items-center justify-center h-full">
                    <div className="text-sm text-muted-foreground">Loading...</div>
                  </div>
                ) : carriers.length === 0 ? (
                  <div className="flex items-center justify-center h-full">
                    <div className="text-center">
                      <p className="text-sm text-muted-foreground">No carriers found</p>
                    </div>
                  </div>
                ) : (
                  <VirtualizedCarriersTable
                    carriers={carriers}
                    selectedCarriers={selectedCarriers}
                    onSelectCarrier={handleSelectCarrier}
                    onSelectAll={handleSelectAll}
                    onCarrierClick={handleCarrierClick}
                  />
                )}
              </div>
            </div>
          </div>
        </Tabs>
      </Card>

      {/* Deactivate Confirmation Dialog */}
      <AlertDialog open={showDeactivateDialog} onOpenChange={setShowDeactivateDialog}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>
              {usePartnerships ? "Terminate Partnerships?" : "Deactivate Carriers?"}
            </AlertDialogTitle>
            <AlertDialogDescription>
              {usePartnerships ? (
                <>
                  You are about to terminate <strong>{selectedCarriers.size}</strong>{" "}
                  carrier partnership{selectedCarriers.size !== 1 ? "s" : ""}. 
                  Terminated partnerships will no longer appear in your active carrier list 
                  and cannot receive load offers.
                  <br /><br />
                  This action can be reversed by reactivating the partnership later.
                </>
              ) : (
                <>
                  You are about to deactivate <strong>{selectedCarriers.size}</strong>{" "}
                  carrier{selectedCarriers.size !== 1 ? "s" : ""}. 
                  Deactivated carriers will be moved to the &quot;Deleted&quot; tab 
                  and will no longer appear in searches.
                  <br /><br />
                  This action can be reversed by restoring the carrier later.
                </>
              )}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={isDeactivating}>Cancel</AlertDialogCancel>
            <AlertDialogAction
              onClick={confirmDeactivate}
              disabled={isDeactivating}
              className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
            >
              {isDeactivating ? "Processing..." : usePartnerships ? "Terminate" : "Deactivate"}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      {/* Reactivate Confirmation Dialog */}
      <AlertDialog open={showReactivateDialog} onOpenChange={setShowReactivateDialog}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>
              {usePartnerships ? "Reactivate Partnerships?" : "Restore Carriers?"}
            </AlertDialogTitle>
            <AlertDialogDescription>
              {usePartnerships ? (
                <>
                  You are about to reactivate <strong>{selectedCarriers.size}</strong>{" "}
                  carrier partnership{selectedCarriers.size !== 1 ? "s" : ""}. 
                  <br /><br />
                  Reactivated partnerships will appear in your active carrier list 
                  and can receive load offers again. The carrier will regain access 
                  to their mobile app for managing loads from your company.
                </>
              ) : (
                <>
                  You are about to restore <strong>{selectedCarriers.size}</strong>{" "}
                  carrier{selectedCarriers.size !== 1 ? "s" : ""}. 
                  <br /><br />
                  Restored carriers will be moved back to the active list 
                  and will appear in searches again.
                </>
              )}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={isReactivating}>Cancel</AlertDialogCancel>
            <AlertDialogAction
              onClick={confirmReactivate}
              disabled={isReactivating}
              className="bg-green-600 text-white hover:bg-green-700"
            >
              {isReactivating ? "Processing..." : usePartnerships ? "Reactivate" : "Restore"}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      {/* Permanent Delete Confirmation Dialog */}
      <AlertDialog open={showPermanentDeleteDialog} onOpenChange={setShowPermanentDeleteDialog}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle className="text-destructive">
              ⚠️ Permanently Delete Carrier{selectedCarriers.size !== 1 ? "s" : ""}?
            </AlertDialogTitle>
            <AlertDialogDescription asChild>
              <div className="space-y-3">
                <p>
                  You are about to <strong className="text-destructive">permanently delete</strong>{" "}
                  <strong>{selectedCarriers.size}</strong> carrier{selectedCarriers.size !== 1 ? "s" : ""}.
                </p>
                <p className="font-medium">This action will:</p>
                <ul className="list-disc list-inside space-y-1 text-sm">
                  <li>Delete the carrier organization record</li>
                  <li>Delete all drivers associated with this carrier</li>
                  <li>Delete completed/canceled load assignments</li>
                  <li>Delete the carrier&apos;s mobile app login (phone number freed)</li>
                  <li>Remove all rate profiles and contracts</li>
                </ul>
                <p className="text-destructive font-semibold mt-4">
                  This action cannot be undone. All data will be permanently lost.
                </p>
              </div>
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={isPermanentlyDeleting}>Cancel</AlertDialogCancel>
            <AlertDialogAction
              onClick={confirmPermanentDelete}
              disabled={isPermanentlyDeleting}
              className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
            >
              {isPermanentlyDeleting ? "Deleting..." : "Delete Permanently"}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}
