"use client";

import { useVirtualizer } from "@tanstack/react-virtual";
import { useRef } from "react";
import { Checkbox } from "@/components/ui/checkbox";
import { Badge } from "@/components/ui/badge";
import { Building2, Link2, User } from "lucide-react";
import { format } from "date-fns";

// Support both legacy carriers and partnership data
interface CarrierData {
  _id: string;
  // Legacy fields
  companyName?: string;
  dba?: string;
  primaryContactName?: string;
  email?: string;
  phoneNumber?: string;
  // Partnership fields
  carrierName?: string;
  carrierDba?: string;
  contactFirstName?: string;
  contactLastName?: string;
  contactEmail?: string;
  contactPhone?: string;
  carrierOrgId?: string; // If set, carrier is linked
  carrierOrg?: {
    _id: string;
    name: string;
    orgType?: string;
    isOwnerOperator?: boolean;
  } | null;
  isOwnerOperator?: boolean; // Broker's categorization
  // Shared fields
  mcNumber?: string;
  usdotNumber?: string;
  insuranceProvider?: string;
  insuranceExpiration?: string | number;
  safetyRating?: string;
  status: string;
}

interface VirtualizedCarriersTableProps {
  carriers: CarrierData[];
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

  const getInsuranceStatus = (expiration?: string | number) => {
    if (!expiration) return { label: "N/A", variant: "secondary" as const };
    
    // Handle both string (ISO date) and number (timestamp) formats
    const expirationDate = typeof expiration === 'string' 
      ? new Date(expiration).getTime() 
      : expiration;
    
    const now = Date.now();
    const daysUntilExpiration = Math.ceil((expirationDate - now) / (1000 * 60 * 60 * 24));
    
    if (daysUntilExpiration < 0) return { label: "Expired", variant: "destructive" as const };
    if (daysUntilExpiration <= 30) return { label: "Expiring", variant: "warning" as const };
    return { label: "Valid", variant: "success" as const };
  };

  const getStatusColor = (status: string) => {
    // Handle both legacy and partnership statuses
    switch (status.toUpperCase()) {
      case "ACTIVE":
      case "ACTIVE":
        return "success";
      case "VETTING":
      case "INVITED":
        return "default";
      case "SUSPENDED":
        return "destructive";
      case "INACTIVE":
      case "PENDING":
        return "secondary";
      case "TERMINATED":
        return "destructive";
      default:
        return "default";
    }
  };

  // Helper to get display name from either format
  const getDisplayName = (carrier: CarrierData) => {
    return carrier.carrierName || carrier.companyName || 'Unknown';
  };

  const getDba = (carrier: CarrierData) => {
    return carrier.carrierDba || carrier.dba;
  };

  const getContactName = (carrier: CarrierData) => {
    if (carrier.contactFirstName || carrier.contactLastName) {
      return `${carrier.contactFirstName || ''} ${carrier.contactLastName || ''}`.trim();
    }
    return carrier.primaryContactName;
  };

  const getContactEmail = (carrier: CarrierData) => {
    return carrier.contactEmail || carrier.email;
  };

  const getContactPhone = (carrier: CarrierData) => {
    return carrier.contactPhone || carrier.phoneNumber;
  };

  const formatExpirationDate = (expiration?: string | number) => {
    if (!expiration) return null;
    const date = typeof expiration === 'string' ? new Date(expiration) : new Date(expiration);
    return format(date, "MM/dd/yyyy");
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
            const isLinked = !!carrier.carrierOrgId;
            // Use partnership's isOwnerOperator if set, otherwise fall back to carrier org's value
            const isOwnerOperator = carrier.isOwnerOperator ?? carrier.carrierOrg?.isOwnerOperator;

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
                    {isOwnerOperator ? (
                      <User className="w-4 h-4 text-primary" />
                    ) : (
                      <Building2 className="w-4 h-4 text-primary" />
                    )}
                  </div>
                  <div className="min-w-0 flex-1">
                    <div className="font-medium text-sm truncate flex items-center gap-1.5">
                      {getDisplayName(carrier)}
                      {isLinked && (
                        <Link2 className="w-3 h-3 text-blue-500 flex-shrink-0" />
                      )}
                      {isOwnerOperator && (
                        <Badge variant="outline" className="text-[10px] px-1 py-0 h-4 bg-amber-50 text-amber-700 border-amber-200 flex-shrink-0">
                          Owner-Op
                        </Badge>
                      )}
                    </div>
                    {getDba(carrier) && (
                      <div className="text-xs text-muted-foreground truncate">
                        DBA: {getDba(carrier)}
                      </div>
                    )}
                  </div>
                </div>
                <div className="px-4 flex-[1.5] min-w-0">
                  {getContactName(carrier) && (
                    <div className="text-sm font-medium truncate">
                      {getContactName(carrier)}
                    </div>
                  )}
                  {getContactEmail(carrier) && (
                    <div className="text-xs text-muted-foreground truncate">
                      {getContactEmail(carrier)}
                    </div>
                  )}
                  {getContactPhone(carrier) && (
                    <div className="text-xs text-muted-foreground truncate">
                      {getContactPhone(carrier)}
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
                        {formatExpirationDate(carrier.insuranceExpiration)}
                      </span>
                    )}
                    <Badge variant={insuranceStatus.variant} className="text-xs">
                      {insuranceStatus.label}
                    </Badge>
                  </div>
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
