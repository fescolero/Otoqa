"use client";

import { useVirtualizer } from "@tanstack/react-virtual";
import { useRef } from "react";
import { Checkbox } from "@/components/ui/checkbox";
import { Badge } from "@/components/ui/badge";
import { Building2 } from "lucide-react";
import { format } from "date-fns";

interface Carrier {
  _id: string;
  companyName: string;
  dba?: string;
  primaryContactName?: string;
  email?: string;
  phoneNumber?: string;
  mcNumber?: string;
  usdotNumber?: string;
  insuranceProvider?: string;
  insuranceExpiration?: number;
  safetyRating?: string;
  status: string;
}

interface VirtualizedCarriersTableProps {
  carriers: Carrier[];
  selectedCarriers: Set<string>;
  onSelectCarrier: (id: string) => void;
  onSelectAll: () => void;
  onCarrierClick: (id: string) => void;
}

export function VirtualizedCarriersTable({
  carriers,
  selectedCarriers,
  onSelectCarrier,
  onSelectAll,
  onCarrierClick,
}: VirtualizedCarriersTableProps) {
  const parentRef = useRef<HTMLDivElement>(null);

  const rowVirtualizer = useVirtualizer({
    count: carriers.length,
    getScrollElement: () => parentRef.current,
    estimateSize: () => 56,
    overscan: 5,
  });

  const getInsuranceStatus = (expiration?: number) => {
    if (!expiration) return { label: "N/A", variant: "secondary" as const };
    const now = Date.now();
    const daysUntilExpiration = Math.ceil((expiration - now) / (1000 * 60 * 60 * 24));
    
    if (daysUntilExpiration < 0) return { label: "Expired", variant: "destructive" as const };
    if (daysUntilExpiration <= 30) return { label: "Expiring", variant: "warning" as const };
    return { label: "Valid", variant: "success" as const };
  };

  const getStatusColor = (status: string) => {
    switch (status) {
      case "Active":
        return "success";
      case "Vetting":
        return "default";
      case "Suspended":
        return "destructive";
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
              checked={selectedCarriers.size === carriers.length && carriers.length > 0}
              onCheckedChange={onSelectAll}
            />
          </div>
          <div className="px-4 flex-[1.5] font-medium text-muted-foreground text-xs uppercase">Carrier</div>
          <div className="px-4 flex-[1.5] font-medium text-muted-foreground text-xs uppercase">Contact</div>
          <div className="px-4 flex-1 font-medium text-muted-foreground text-xs uppercase">MC# / DOT#</div>
          <div className="px-4 flex-[1.5] font-medium text-muted-foreground text-xs uppercase">Insurance</div>
          <div className="px-4 flex-1 font-medium text-muted-foreground text-xs uppercase">Safety Rating</div>
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
            const carrier = carriers[virtualRow.index];
            const insuranceStatus = getInsuranceStatus(carrier.insuranceExpiration);

            return (
              <div
                key={carrier._id}
                style={{
                  position: "absolute",
                  top: 0,
                  left: 0,
                  width: "100%",
                  height: `${virtualRow.size}px`,
                  transform: `translateY(${virtualRow.start}px)`,
                }}
                className="flex items-center w-full border-b hover:bg-slate-50/50 cursor-pointer"
                onClick={() => onCarrierClick(carrier._id)}
              >
                <div
                  className="px-2 w-12 flex items-center"
                  onClick={(e) => e.stopPropagation()}
                >
                  <Checkbox
                    checked={selectedCarriers.has(carrier._id)}
                    onCheckedChange={() => onSelectCarrier(carrier._id)}
                  />
                </div>
                <div className="px-4 flex-[1.5] flex items-center gap-2 min-w-0">
                  <div className="flex-shrink-0 w-8 h-8 rounded-lg bg-primary/10 flex items-center justify-center">
                    <Building2 className="w-4 h-4 text-primary" />
                  </div>
                  <div className="min-w-0 flex-1">
                    <div className="font-medium text-sm truncate">
                      {carrier.companyName}
                    </div>
                    {carrier.dba && (
                      <div className="text-xs text-muted-foreground truncate">
                        DBA: {carrier.dba}
                      </div>
                    )}
                  </div>
                </div>
                <div className="px-4 flex-[1.5] min-w-0">
                  {carrier.primaryContactName && (
                    <div className="text-sm font-medium truncate">
                      {carrier.primaryContactName}
                    </div>
                  )}
                  {carrier.email && (
                    <div className="text-xs text-muted-foreground truncate">
                      {carrier.email}
                    </div>
                  )}
                  {carrier.phoneNumber && (
                    <div className="text-xs text-muted-foreground truncate">
                      {carrier.phoneNumber}
                    </div>
                  )}
                </div>
                <div className="px-4 flex-1 text-sm min-w-0">
                  {carrier.mcNumber && (
                    <div className="truncate">MC# {carrier.mcNumber}</div>
                  )}
                  {carrier.usdotNumber && (
                    <div className="text-xs text-muted-foreground truncate">
                      DOT# {carrier.usdotNumber}
                    </div>
                  )}
                </div>
                <div className="px-4 flex-[1.5] min-w-0">
                  {carrier.insuranceProvider && (
                    <div className="text-sm truncate">
                      {carrier.insuranceProvider}
                    </div>
                  )}
                  <div className="flex items-center gap-2 mt-0.5">
                    {carrier.insuranceExpiration && (
                      <span className="text-xs text-muted-foreground">
                        {format(carrier.insuranceExpiration, "MM/dd/yyyy")}
                      </span>
                    )}
                    <Badge variant={insuranceStatus.variant} className="text-xs">
                      {insuranceStatus.label}
                    </Badge>
                  </div>
                </div>
                <div className="px-4 flex-1 text-sm">
                  {carrier.safetyRating || "Not Rated"}
                </div>
                <div className="px-4 flex-1">
                  <Badge variant={getStatusColor(carrier.status)}>
                    {carrier.status}
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
