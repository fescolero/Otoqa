"use client";

import { FilterBarShell, FilterSearch, FilterSelect } from "@/components/filters/filter-bar";

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

const SAFETY_OPTIONS = [
  { value: "all", label: "All Ratings" },
  { value: "Satisfactory", label: "Satisfactory" },
  { value: "Conditional", label: "Conditional" },
  { value: "Unsatisfactory", label: "Unsatisfactory" },
  { value: "Not Rated", label: "Not Rated" },
];

const INSURANCE_OPTIONS = [
  { value: "all", label: "All Insurance" },
  { value: "valid", label: "Valid" },
  { value: "expiring", label: "Expiring Soon" },
  { value: "expired", label: "Expired" },
];

const STATE_OPTIONS = [
  { value: "all", label: "All States" },
  ...US_STATES.map((s) => ({ value: s, label: s })),
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
    <FilterBarShell>
      <FilterSearch
        value={searchQuery}
        onChange={onSearchChange}
        placeholder="Search carriers by company, DBA, MC#, DOT#, email..."
      />
      <FilterSelect
        value={safetyRating}
        onValueChange={onSafetyRatingChange}
        placeholder="Safety Rating"
        options={SAFETY_OPTIONS}
        triggerClassName="w-40"
      />
      <FilterSelect
        value={insuranceStatus}
        onValueChange={onInsuranceStatusChange}
        placeholder="Insurance"
        options={INSURANCE_OPTIONS}
        triggerClassName="w-40"
      />
      <FilterSelect
        value={state}
        onValueChange={onStateChange}
        placeholder="State"
        options={STATE_OPTIONS}
        triggerClassName="w-32"
      />
    </FilterBarShell>
  );
}
