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

interface CarrierFilterBarProps {
  searchQuery: string;
  onSearchChange: (value: string) => void;
  safetyRating: string;
  onSafetyRatingChange: (value: string) => void;
  insuranceStatus: string;
  onInsuranceStatusChange: (value: string) => void;
  state: string;
  onStateChange: (value: string) => void;
}

const US_STATES = [
  "AL", "AK", "AZ", "AR", "CA", "CO", "CT", "DE", "FL", "GA",
  "HI", "ID", "IL", "IN", "IA", "KS", "KY", "LA", "ME", "MD",
  "MA", "MI", "MN", "MS", "MO", "MT", "NE", "NV", "NH", "NJ",
  "NM", "NY", "NC", "ND", "OH", "OK", "OR", "PA", "RI", "SC",
  "SD", "TN", "TX", "UT", "VT", "VA", "WA", "WV", "WI", "WY"
];

export function CarrierFilterBar({
  searchQuery,
  onSearchChange,
  safetyRating,
  onSafetyRatingChange,
  insuranceStatus,
  onInsuranceStatusChange,
  state,
  onStateChange,
}: CarrierFilterBarProps) {
  return (
    <div className="bg-slate-50/50 border-y border-slate-200/60 px-4 py-6">
      <div className="flex items-center gap-3 flex-wrap">
        <div className="relative w-full max-w-md">
          <Search className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" strokeWidth={2} />
          <Input
            placeholder="Search carriers by company, DBA, MC#, DOT#, email..."
            value={searchQuery}
            onChange={(e) => onSearchChange(e.target.value)}
            className="pl-9 h-9 bg-white"
          />
        </div>

        <Select value={safetyRating} onValueChange={onSafetyRatingChange}>
          <SelectTrigger className="w-40 h-9 bg-white">
            <SelectValue placeholder="Safety Rating" />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="all">All Ratings</SelectItem>
            <SelectItem value="Satisfactory">Satisfactory</SelectItem>
            <SelectItem value="Conditional">Conditional</SelectItem>
            <SelectItem value="Unsatisfactory">Unsatisfactory</SelectItem>
            <SelectItem value="Not Rated">Not Rated</SelectItem>
          </SelectContent>
        </Select>

        <Select value={insuranceStatus} onValueChange={onInsuranceStatusChange}>
          <SelectTrigger className="w-40 h-9 bg-white">
            <SelectValue placeholder="Insurance" />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="all">All Insurance</SelectItem>
            <SelectItem value="valid">Valid</SelectItem>
            <SelectItem value="expiring">Expiring Soon</SelectItem>
            <SelectItem value="expired">Expired</SelectItem>
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
      </div>
    </div>
  );
}
