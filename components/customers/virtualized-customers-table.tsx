"use client";

import { useVirtualizer } from "@tanstack/react-virtual";
import { useRef } from "react";
import { Checkbox } from "@/components/ui/checkbox";
import { Badge } from "@/components/ui/badge";
import { Users } from "lucide-react";

interface Customer {
  _id: string;
  name: string;
  city?: string;
  state?: string;
  companyType: string;
  primaryContactName?: string;
  primaryContactEmail?: string;
  primaryContactPhone?: string;
  loadingType?: string;
  status: string;
}

interface VirtualizedCustomersTableProps {
  customers: Customer[];
  selectedCustomers: Set<string>;
  onSelectCustomer: (id: string) => void;
  onSelectAll: () => void;
  onCustomerClick: (id: string) => void;
}

export function VirtualizedCustomersTable({
  customers,
  selectedCustomers,
  onSelectCustomer,
  onSelectAll,
  onCustomerClick,
}: VirtualizedCustomersTableProps) {
  const parentRef = useRef<HTMLDivElement>(null);

  const rowVirtualizer = useVirtualizer({
    count: customers.length,
    getScrollElement: () => parentRef.current,
    estimateSize: () => 56,
    overscan: 5,
  });

  const getStatusColor = (status: string) => {
    switch (status) {
      case "Active":
        return "success";
      case "Prospect":
        return "default";
      case "Inactive":
        return "secondary";
      default:
        return "default";
    }
  };

  return (
    <div className="flex flex-col h-full min-h-0">
      {/* Header */}
      <div className="flex-shrink-0 border-b bg-slate-50">
        <div className="flex items-center h-10 w-full">
          <div className="px-2 w-12 flex items-center">
            <Checkbox
              checked={selectedCustomers.size === customers.length && customers.length > 0}
              onCheckedChange={onSelectAll}
            />
          </div>
          <div className="px-4 flex-[1.5] font-medium text-muted-foreground text-xs uppercase">Customer</div>
          <div className="px-4 flex-1 font-medium text-muted-foreground text-xs uppercase">Location</div>
          <div className="px-4 flex-1 font-medium text-muted-foreground text-xs uppercase">Company Type</div>
          <div className="px-4 flex-[1.5] font-medium text-muted-foreground text-xs uppercase">Contact</div>
          <div className="px-4 flex-1 font-medium text-muted-foreground text-xs uppercase">Loading Type</div>
          <div className="px-4 flex-1 font-medium text-muted-foreground text-xs uppercase">Status</div>
        </div>
      </div>

      {/* Body */}
      <div ref={parentRef} className="flex-1 overflow-auto">
        <div
          style={{
            height: `${rowVirtualizer.getTotalSize()}px`,
            width: "100%",
            position: "relative",
          }}
        >
          {rowVirtualizer.getVirtualItems().map((virtualRow) => {
            const customer = customers[virtualRow.index];

            return (
              <div
                key={customer._id}
                style={{
                  position: "absolute",
                  top: 0,
                  left: 0,
                  width: "100%",
                  height: `${virtualRow.size}px`,
                  transform: `translateY(${virtualRow.start}px)`,
                }}
                className="flex items-center w-full border-b hover:bg-slate-50/50 cursor-pointer"
                onClick={() => onCustomerClick(customer._id)}
              >
                <div
                  className="px-2 w-12 flex items-center"
                  onClick={(e) => e.stopPropagation()}
                >
                  <Checkbox
                    checked={selectedCustomers.has(customer._id)}
                    onCheckedChange={() => onSelectCustomer(customer._id)}
                  />
                </div>
                <div className="px-4 flex-[1.5] flex items-center gap-2 min-w-0">
                  <div className="flex-shrink-0 w-8 h-8 rounded-lg bg-primary/10 flex items-center justify-center">
                    <Users className="w-4 h-4 text-primary" />
                  </div>
                  <div className="min-w-0 flex-1">
                    <div className="font-medium text-sm truncate">
                      {customer.name}
                    </div>
                  </div>
                </div>
                <div className="px-4 flex-1 text-sm min-w-0">
                  {customer.city && customer.state && (
                    <div className="truncate">
                      {customer.city}, {customer.state}
                    </div>
                  )}
                </div>
                <div className="px-4 flex-1 text-sm">
                  {customer.companyType}
                </div>
                <div className="px-4 flex-[1.5] min-w-0">
                  {customer.primaryContactName && (
                    <div className="text-sm font-medium truncate">
                      {customer.primaryContactName}
                    </div>
                  )}
                  {customer.primaryContactEmail && (
                    <div className="text-xs text-muted-foreground truncate">
                      {customer.primaryContactEmail}
                    </div>
                  )}
                  {customer.primaryContactPhone && (
                    <div className="text-xs text-muted-foreground truncate">
                      {customer.primaryContactPhone}
                    </div>
                  )}
                </div>
                <div className="px-4 flex-1 text-sm">
                  {customer.loadingType || "N/A"}
                </div>
                <div className="px-4 flex-1">
                  <Badge variant={getStatusColor(customer.status)}>
                    {customer.status}
                  </Badge>
                </div>
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );
}
