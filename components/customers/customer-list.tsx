"use client";

import * as React from "react";
import { useQuery } from "convex/react";
import { useRouter } from "next/navigation";
import { api } from "@/convex/_generated/api";
import { Card } from "@/components/ui/card";
import { Tabs, TabsList, TabsTrigger, TabsContent } from "@/components/ui/tabs";
import { Badge } from "@/components/ui/badge";
import { Users, CheckCircle, Star, MinusCircle, Trash } from "lucide-react";
import { CustomerFilterBar } from "./customer-filter-bar";
import { VirtualizedCustomersTable } from "./virtualized-customers-table";

interface CustomerListProps {
  workosOrgId: string;
}

export function CustomerList({ workosOrgId }: CustomerListProps) {
  const router = useRouter();
  const [activeTab, setActiveTab] = React.useState("all");
  const [searchQuery, setSearchQuery] = React.useState("");
  const [companyType, setCompanyType] = React.useState("all");
  const [state, setState] = React.useState("all");
  const [loadingType, setLoadingType] = React.useState("all");
  const [selectedCustomers, setSelectedCustomers] = React.useState<Set<string>>(new Set());

  // Fetch counts
  const counts = useQuery(api.customers.countCustomersByStatus);

  // Fetch filtered customers
  const customers = useQuery(api.customers.list, {
    workosOrgId,
    status: activeTab === "all" ? undefined : activeTab === "deleted" ? undefined : activeTab.charAt(0).toUpperCase() + activeTab.slice(1),
    searchQuery: searchQuery || undefined,
    companyType: companyType === "all" ? undefined : (companyType as any),
    state: state === "all" ? undefined : state,
    loadingType: loadingType === "all" ? undefined : (loadingType as any),
    includeDeleted: activeTab === "deleted",
  });

  // Selection handlers
  const handleSelectCustomer = (id: string) => {
    setSelectedCustomers((prev) => {
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
    if (selectedCustomers.size === customers?.length) {
      setSelectedCustomers(new Set());
    } else {
      setSelectedCustomers(new Set(customers?.map((c) => c._id) || []));
    }
  };

  const handleCustomerClick = (id: string) => {
    router.push(`/operations/customers/${id}`);
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
                <Users className="w-4 h-4 mr-2" />
                All Customers
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
                value="prospect"
                className="data-[state=active]:border-b-2 data-[state=active]:border-primary data-[state=active]:!bg-transparent data-[state=active]:!shadow-none data-[state=active]:border-l-0 data-[state=active]:border-r-0 data-[state=active]:border-t-0 rounded-none px-4 py-3 !bg-transparent !shadow-none border-0"
              >
                <Star className="w-4 h-4 mr-2" />
                Prospect
                {counts?.prospect !== undefined && (
                  <Badge variant="secondary" className="ml-2">
                    {counts.prospect}
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
            <CustomerFilterBar
              searchQuery={searchQuery}
              onSearchChange={setSearchQuery}
              companyType={companyType}
              onCompanyTypeChange={setCompanyType}
              state={state}
              onStateChange={setState}
              loadingType={loadingType}
              onLoadingTypeChange={setLoadingType}
            />

            <div className="flex-1 p-4 overflow-hidden min-h-0 flex flex-col">
              <div className="border rounded-lg flex-1 min-h-0 overflow-hidden flex flex-col">
                {customers === undefined ? (
                  <div className="flex items-center justify-center h-full">
                    <div className="text-sm text-muted-foreground">Loading...</div>
                  </div>
                ) : customers.length === 0 ? (
                  <div className="flex items-center justify-center h-full">
                    <div className="text-center">
                      <p className="text-sm text-muted-foreground">No customers found</p>
                    </div>
                  </div>
                ) : (
                  <VirtualizedCustomersTable
                    customers={customers}
                    selectedCustomers={selectedCustomers}
                    onSelectCustomer={handleSelectCustomer}
                    onSelectAll={handleSelectAll}
                    onCustomerClick={handleCustomerClick}
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
