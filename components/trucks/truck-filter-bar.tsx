'use client';

import * as React from 'react';
import { Input } from '@/components/ui/input';
import { Search } from 'lucide-react';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';

interface TruckFilterBarProps {
  onSearchChange: (value: string) => void;
  onRegistrationStatusChange: (value: string) => void;
  onInsuranceStatusChange: (value: string) => void;
  onYearRangeChange: (min?: number, max?: number) => void;
}

export function TruckFilterBar({
  onSearchChange,
  onRegistrationStatusChange,
  onInsuranceStatusChange,
  onYearRangeChange,
}: TruckFilterBarProps) {
  const [search, setSearch] = React.useState('');
  const [registrationStatus, setRegistrationStatus] = React.useState('all');
  const [insuranceStatus, setInsuranceStatus] = React.useState('all');
  const [yearRange, setYearRange] = React.useState('all');

  const handleSearchChange = (value: string) => {
    setSearch(value);
    onSearchChange(value);
  };

  const handleRegistrationStatusChange = (value: string) => {
    setRegistrationStatus(value);
    onRegistrationStatusChange(value === 'all' ? '' : value);
  };

  const handleInsuranceStatusChange = (value: string) => {
    setInsuranceStatus(value);
    onInsuranceStatusChange(value === 'all' ? '' : value);
  };

  const handleYearRangeChange = (value: string) => {
    setYearRange(value);
    
    const currentYear = new Date().getFullYear();
    
    if (value === 'all') {
      onYearRangeChange(undefined, undefined);
    } else if (value === '0-5') {
      onYearRangeChange(currentYear - 5, currentYear);
    } else if (value === '6-10') {
      onYearRangeChange(currentYear - 10, currentYear - 6);
    } else if (value === '11-15') {
      onYearRangeChange(currentYear - 15, currentYear - 11);
    } else if (value === '16+') {
      onYearRangeChange(undefined, currentYear - 16);
    }
  };

  return (
    <div className="bg-slate-50/50 border-y border-slate-200/60 px-4 py-6">
      <div className="flex items-center gap-3 flex-wrap">
        {/* Search */}
        <div className="relative w-full max-w-md">
          <Search className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" strokeWidth={2} />
          <Input
            placeholder="Search unit ID, VIN, plate..."
            value={search}
            onChange={(e) => handleSearchChange(e.target.value)}
            className="pl-9 h-9 bg-white"
          />
        </div>

        {/* Registration Status */}
        <Select value={registrationStatus} onValueChange={handleRegistrationStatusChange}>
          <SelectTrigger className="w-40 h-9">
            <SelectValue placeholder="Registration" />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="all">All Registration</SelectItem>
            <SelectItem value="valid">Valid</SelectItem>
            <SelectItem value="expiring">Expiring Soon</SelectItem>
            <SelectItem value="expired">Expired</SelectItem>
          </SelectContent>
        </Select>

        {/* Insurance Status */}
        <Select value={insuranceStatus} onValueChange={handleInsuranceStatusChange}>
          <SelectTrigger className="w-36 h-9">
            <SelectValue placeholder="Insurance" />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="all">All Insurance</SelectItem>
            <SelectItem value="valid">Valid</SelectItem>
            <SelectItem value="expiring">Expiring Soon</SelectItem>
            <SelectItem value="expired">Expired</SelectItem>
          </SelectContent>
        </Select>

        {/* Year Range */}
        <Select value={yearRange} onValueChange={handleYearRangeChange}>
          <SelectTrigger className="w-32 h-9">
            <SelectValue placeholder="Year" />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="all">All Years</SelectItem>
            <SelectItem value="0-5">0-5 years</SelectItem>
            <SelectItem value="6-10">6-10 years</SelectItem>
            <SelectItem value="11-15">11-15 years</SelectItem>
            <SelectItem value="16+">16+ years</SelectItem>
          </SelectContent>
        </Select>
      </div>
    </div>
  );
}
