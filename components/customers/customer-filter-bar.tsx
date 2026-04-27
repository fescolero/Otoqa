"use client";

import { FilterBarShell, FilterSearch, FilterSelect } from "@/components/filters/filter-bar";

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

const COMPANY_TYPE_OPTIONS = [
  { value: "all", label: "All Types" },
  { value: "Shipper", label: "Shipper" },
  { value: "Broker", label: "Broker" },
  { value: "Manufacturer", label: "Manufacturer" },
  { value: "Distributor", label: "Distributor" },
];

const LOADING_TYPE_OPTIONS = [
  { value: "all", label: "All Types" },
  { value: "Live Load", label: "Live Load" },
  { value: "Drop & Hook", label: "Drop & Hook" },
  { value: "Appointment", label: "Appointment" },
];

const STATE_OPTIONS = [
  { value: "all", label: "All States" },
  ...US_STATES.map((s) => ({ value: s, label: s })),
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
    <FilterBarShell>
      <FilterSearch
        value={searchQuery}
        onChange={onSearchChange}
        placeholder="Search customers by name, city, contact..."
      />
      <FilterSelect
        value={companyType}
        onValueChange={onCompanyTypeChange}
        placeholder="Company Type"
        options={COMPANY_TYPE_OPTIONS}
        triggerClassName="w-40"
      />
      <FilterSelect
        value={state}
        onValueChange={onStateChange}
        placeholder="State"
        options={STATE_OPTIONS}
        triggerClassName="w-32"
      />
      <FilterSelect
        value={loadingType}
        onValueChange={onLoadingTypeChange}
        placeholder="Loading Type"
        options={LOADING_TYPE_OPTIONS}
        triggerClassName="w-36"
      />
    </FilterBarShell>
  );
}
