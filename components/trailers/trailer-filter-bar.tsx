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

interface TrailerFilterBarProps {
  onSearchChange: (value: string) => void;
  onRegistrationStatusChange: (value: string) => void;
  onInsuranceStatusChange: (value: string) => void;
  onSizeChange: (value: string) => void;
  onBodyTypeChange: (value: string) => void;
}

export function TrailerFilterBar({
  onSearchChange,
  onRegistrationStatusChange,
  onInsuranceStatusChange,
  onSizeChange,
  onBodyTypeChange,
}: TrailerFilterBarProps) {
  const [search, setSearch] = React.useState('');
  const [registrationStatus, setRegistrationStatus] = React.useState('all');
  const [insuranceStatus, setInsuranceStatus] = React.useState('all');
  const [size, setSize] = React.useState('all');
  const [bodyType, setBodyType] = React.useState('all');

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

  const handleSizeChange = (value: string) => {
    setSize(value);
    onSizeChange(value === 'all' ? '' : value);
  };

  const handleBodyTypeChange = (value: string) => {
    setBodyType(value);
    onBodyTypeChange(value === 'all' ? '' : value);
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

        {/* Size Filter */}
        <Select value={size} onValueChange={handleSizeChange}>
          <SelectTrigger className="w-32 h-9">
            <SelectValue placeholder="Size" />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="all">All Sizes</SelectItem>
            <SelectItem value="28'">28'</SelectItem>
            <SelectItem value="48'">48'</SelectItem>
            <SelectItem value="53'">53'</SelectItem>
          </SelectContent>
        </Select>

        {/* Body Type Filter */}
        <Select value={bodyType} onValueChange={handleBodyTypeChange}>
          <SelectTrigger className="w-36 h-9">
            <SelectValue placeholder="Body Type" />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="all">All Types</SelectItem>
            <SelectItem value="Dry Van">Dry Van</SelectItem>
            <SelectItem value="Refrigerated">Refrigerated</SelectItem>
            <SelectItem value="Flatbed">Flatbed</SelectItem>
          </SelectContent>
        </Select>

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
      </div>
    </div>
  );
}
