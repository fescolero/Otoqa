'use client';

import * as React from 'react';
import { FilterBarShell, FilterSearch, FilterSelect } from '@/components/filters/filter-bar';

interface TruckFilterBarProps {
  onSearchChange: (value: string) => void;
  onRegistrationStatusChange: (value: string) => void;
  onInsuranceStatusChange: (value: string) => void;
  onYearRangeChange: (min?: number, max?: number) => void;
}

const EXPIRATION_OPTIONS = [
  { value: 'valid', label: 'Valid' },
  { value: 'expiring', label: 'Expiring Soon' },
  { value: 'expired', label: 'Expired' },
];

const REGISTRATION_OPTIONS = [{ value: 'all', label: 'All Registration' }, ...EXPIRATION_OPTIONS];
const INSURANCE_OPTIONS = [{ value: 'all', label: 'All Insurance' }, ...EXPIRATION_OPTIONS];

const YEAR_OPTIONS = [
  { value: 'all', label: 'All Years' },
  { value: '0-5', label: '0-5 years' },
  { value: '6-10', label: '6-10 years' },
  { value: '11-15', label: '11-15 years' },
  { value: '16+', label: '16+ years' },
];

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
    if (value === '0-5') return onYearRangeChange(currentYear - 5, currentYear);
    if (value === '6-10') return onYearRangeChange(currentYear - 10, currentYear - 6);
    if (value === '11-15') return onYearRangeChange(currentYear - 15, currentYear - 11);
    if (value === '16+') return onYearRangeChange(undefined, currentYear - 16);
    onYearRangeChange(undefined, undefined);
  };

  return (
    <FilterBarShell>
      <FilterSearch
        value={search}
        onChange={(v) => {
          setSearch(v);
          onSearchChange(v);
        }}
        placeholder="Search unit ID, VIN, plate..."
      />
      <FilterSelect
        value={registrationStatus}
        onValueChange={handleRegistrationStatusChange}
        placeholder="Registration"
        options={REGISTRATION_OPTIONS}
        triggerClassName="w-40"
      />
      <FilterSelect
        value={insuranceStatus}
        onValueChange={handleInsuranceStatusChange}
        placeholder="Insurance"
        options={INSURANCE_OPTIONS}
        triggerClassName="w-36"
      />
      <FilterSelect
        value={yearRange}
        onValueChange={handleYearRangeChange}
        placeholder="Year"
        options={YEAR_OPTIONS}
        triggerClassName="w-32"
      />
    </FilterBarShell>
  );
}
