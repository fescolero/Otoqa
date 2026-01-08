"use client";

import { Search } from "lucide-react";
import { Input } from "@/components/ui/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";

interface CustomerFilterBarProps {
  searchQuery: string;
  onSearchChange: (value: string) => void;
  companyType: string;
  onCompanyTypeChange: (value: string) => void;
  state: string;
  onStateChange: (value: string) => void;
  loadingType: string;
  onLoadingTypeChange: (value: string) => void;
}

const US_STATES = [
  "AL", "AK", "AZ", "AR", "CA", "CO", "CT", "DE", "FL", "GA",
  "HI", "ID", "IL", "IN", "IA", "KS", "KY", "LA", "ME", "MD",
  "MA", "MI", "MN", "MS", "MO", "MT", "NE", "NV", "NH", "NJ",
  "NM", "NY", "NC", "ND", "OH", "OK", "OR", "PA", "RI", "SC",
  "SD", "TN", "TX", "UT", "VT", "VA", "WA", "WV", "WI", "WY"
];

export function CustomerFilterBar({
  searchQuery,
  onSearchChange,
  companyType,
  onCompanyTypeChange,
  state,
  onStateChange,
  loadingType,
  onLoadingTypeChange,
}: CustomerFilterBarProps) {
  return (
    <div className="bg-slate-50/50 border-y border-slate-200/60 px-4 py-6">
      <div className="flex items-center gap-3 flex-wrap">
        <div className="relative w-full max-w-md">
          <Search className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" strokeWidth={2} />
          <Input
            placeholder="Search customers by name, city, contact..."
            value={searchQuery}
            onChange={(e) => onSearchChange(e.target.value)}
            className="pl-9 h-9 bg-white"
          />
        </div>

        <Select value={companyType} onValueChange={onCompanyTypeChange}>
          <SelectTrigger className="w-40 h-9 bg-white">
            <SelectValue placeholder="Company Type" />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="all">All Types</SelectItem>
            <SelectItem value="Shipper">Shipper</SelectItem>
            <SelectItem value="Broker">Broker</SelectItem>
            <SelectItem value="Manufacturer">Manufacturer</SelectItem>
            <SelectItem value="Distributor">Distributor</SelectItem>
          </SelectContent>
        </Select>

        <Select value={state} onValueChange={onStateChange}>
          <SelectTrigger className="w-32 h-9 bg-white">
            <SelectValue placeholder="State" />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="all">All States</SelectItem>
            {US_STATES.map((state) => (
              <SelectItem key={state} value={state}>
                {state}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>

        <Select value={loadingType} onValueChange={onLoadingTypeChange}>
          <SelectTrigger className="w-36 h-9 bg-white">
            <SelectValue placeholder="Loading Type" />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="all">All Types</SelectItem>
            <SelectItem value="Live Load">Live Load</SelectItem>
            <SelectItem value="Drop & Hook">Drop & Hook</SelectItem>
            <SelectItem value="Appointment">Appointment</SelectItem>
          </SelectContent>
        </Select>
      </div>
    </div>
  );
}
