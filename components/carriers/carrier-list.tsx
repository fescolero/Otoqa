"use client";

import * as React from "react";
import { useQuery } from "convex/react";
import { useRouter } from "next/navigation";
import { api } from "@/convex/_generated/api";
import { Card } from "@/components/ui/card";
import { Tabs, TabsList, TabsTrigger, TabsContent } from "@/components/ui/tabs";
import { Badge } from "@/components/ui/badge";
import { Building2, CheckCircle, Search, AlertCircle, Ban, MinusCircle, Trash } from "lucide-react";
import { CarrierFilterBar } from "./carrier-filter-bar";
import { VirtualizedCarriersTable } from "./virtualized-carriers-table";

interface CarrierListProps {
  workosOrgId: string;
}

export function CarrierList({ workosOrgId }: CarrierListProps) {
  const router = useRouter();
  const [activeTab, setActiveTab] = React.useState("all");
  const [searchQuery, setSearchQuery] = React.useState("");
  const [safetyRating, setSafetyRating] = React.useState("all");
  const [insuranceStatus, setInsuranceStatus] = React.useState("all");
  const [state, setState] = React.useState("all");
  const [selectedCarriers, setSelectedCarriers] = React.useState<Set<string>>(new Set());

  // Fetch counts
  const counts = useQuery(api.carriers.countCarriersByStatus, { workosOrgId });

  // Fetch filtered carriers
  const carriers = useQuery(api.carriers.list, {
    workosOrgId,
    status: activeTab === "all" ? undefined : activeTab === "expiring" ? undefined : activeTab === "deleted" ? undefined : activeTab.charAt(0).toUpperCase() + activeTab.slice(1),
    search: searchQuery || undefined,
    safetyRating: safetyRating === "all" ? undefined : safetyRating,
    insuranceStatus: insuranceStatus === "all" ? undefined : insuranceStatus,
    state: state === "all" ? undefined : state,
    includeDeleted: activeTab === "deleted",
  });

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

  return (
    <div className="flex-1 flex flex-col gap-4 min-h-0">
      <Card className="flex-1 flex flex-col p-0 gap-0 overflow-hidden min-h-0">
        <Tabs value={activeTab} onValueChange={setActiveTab} className="w-full flex-1 flex flex-col gap-0 min-h-0">
          <div className="flex-shrink-0 px-4">
            <TabsList className="h-auto p-0 bg-transparent border-0">
              <TabsTrigger
                value="all"
                className="data-[state=active]:border-b-2 data-[state=active]:border-primary data-[state=active]:!bg-transparent data-[state=active]:!shadow-none data-[state=active]:border-l-0 data-[state=active]:border-r-0 data-[state=active]:border-t-0 rounded-none px-4 py-3 !bg-transparent !shadow-none border-0"
              >
                <Building2 className="w-4 h-4 mr-2" />
                All Carriers
                {counts?.all !== undefined && (
                  <Badge variant="secondary" className="ml-2">
                    {counts.all}
                  </Badge>
                )}
              </TabsTrigger>
              <TabsTrigger
                value="active"
                className="data-[state=active]:border-b-2 data-[state=active]:border-primary data-[state=active]:!bg-transparent data-[state=active]:!shadow-none data-[state=active]:border-l-0 data-[state=active]:border-r-0 data-[state=active]:border-t-0 rounded-none px-4 py-3 !bg-transparent !shadow-none border-0"
              >
                <CheckCircle className="w-4 h-4 mr-2" />
                Active
                {counts?.active !== undefined && (
                  <Badge variant="secondary" className="ml-2">
                    {counts.active}
                  </Badge>
                )}
              </TabsTrigger>
              <TabsTrigger
                value="vetting"
                className="data-[state=active]:border-b-2 data-[state=active]:border-primary data-[state=active]:!bg-transparent data-[state=active]:!shadow-none data-[state=active]:border-l-0 data-[state=active]:border-r-0 data-[state=active]:border-t-0 rounded-none px-4 py-3 !bg-transparent !shadow-none border-0"
              >
                <Search className="w-4 h-4 mr-2" />
                Vetting
                {counts?.vetting !== undefined && (
                  <Badge variant="secondary" className="ml-2">
                    {counts.vetting}
                  </Badge>
                )}
              </TabsTrigger>
              <TabsTrigger
                value="expiring"
                className="data-[state=active]:border-b-2 data-[state=active]:border-primary data-[state=active]:!bg-transparent data-[state=active]:!shadow-none data-[state=active]:border-l-0 data-[state=active]:border-r-0 data-[state=active]:border-t-0 rounded-none px-4 py-3 !bg-transparent !shadow-none border-0"
              >
                <AlertCircle className="w-4 h-4 mr-2" />
                Insurance Expiring
                {counts?.insuranceExpiring !== undefined && counts.insuranceExpiring > 0 && (
                  <Badge variant="warning" className="ml-2">
                    {counts.insuranceExpiring}
                  </Badge>
                )}
              </TabsTrigger>
              <TabsTrigger
                value="suspended"
                className="data-[state=active]:border-b-2 data-[state=active]:border-primary data-[state=active]:!bg-transparent data-[state=active]:!shadow-none data-[state=active]:border-l-0 data-[state=active]:border-r-0 data-[state=active]:border-t-0 rounded-none px-4 py-3 !bg-transparent !shadow-none border-0"
              >
                <Ban className="w-4 h-4 mr-2" />
                Suspended
                {counts?.suspended !== undefined && (
                  <Badge variant="secondary" className="ml-2">
                    {counts.suspended}
                  </Badge>
                )}
              </TabsTrigger>
              <TabsTrigger
                value="inactive"
                className="data-[state=active]:border-b-2 data-[state=active]:border-primary data-[state=active]:!bg-transparent data-[state=active]:!shadow-none data-[state=active]:border-l-0 data-[state=active]:border-r-0 data-[state=active]:border-t-0 rounded-none px-4 py-3 !bg-transparent !shadow-none border-0"
              >
                <MinusCircle className="w-4 h-4 mr-2" />
                Inactive
                {counts?.inactive !== undefined && (
                  <Badge variant="secondary" className="ml-2">
                    {counts.inactive}
                  </Badge>
                )}
              </TabsTrigger>
              <TabsTrigger
                value="deleted"
                className="data-[state=active]:border-b-2 data-[state=active]:border-primary data-[state=active]:!bg-transparent data-[state=active]:!shadow-none data-[state=active]:border-l-0 data-[state=active]:border-r-0 data-[state=active]:border-t-0 rounded-none px-4 py-3 !bg-transparent !shadow-none border-0"
              >
                <Trash className="w-4 h-4 mr-2" />
                Deleted
                {counts?.deleted !== undefined && (
                  <Badge variant="secondary" className="ml-2">
                    {counts.deleted}
                  </Badge>
                )}
              </TabsTrigger>
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
    </div>
  );
}
