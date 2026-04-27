'use client';

import * as React from 'react';
import { FilterBarShell, FilterSearch, FilterSelect } from '@/components/filters/filter-bar';

interface TrailerFilterBarProps {
  onSearchChange: (value: string) => void;
  onRegistrationStatusChange: (value: string) => void;
  onInsuranceStatusChange: (value: string) => void;
  onSizeChange: (value: string) => void;
  onBodyTypeChange: (value: string) => void;
}

const SIZE_OPTIONS = [
  { value: 'all', label: 'All Sizes' },
  { value: "28'", label: "28'" },
  { value: "48'", label: "48'" },
  { value: "53'", label: "53'" },
];

const BODY_TYPE_OPTIONS = [
  { value: 'all', label: 'All Types' },
  { value: 'Dry Van', label: 'Dry Van' },
  { value: 'Refrigerated', label: 'Refrigerated' },
  { value: 'Flatbed', label: 'Flatbed' },
];

const EXPIRATION_OPTIONS = [
  { value: 'valid', label: 'Valid' },
  { value: 'expiring', label: 'Expiring Soon' },
  { value: 'expired', label: 'Expired' },
];

const REGISTRATION_OPTIONS = [{ value: 'all', label: 'All Registration' }, ...EXPIRATION_OPTIONS];
const INSURANCE_OPTIONS = [{ value: 'all', label: 'All Insurance' }, ...EXPIRATION_OPTIONS];

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

  // Each handler keeps local select state in sync and emits 'all' as ''.
  const makeSelectHandler = (
    setLocal: (v: string) => void,
    emit: (v: string) => void
  ) => (value: string) => {
    setLocal(value);
    emit(value === 'all' ? '' : value);
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
        value={size}
        onValueChange={makeSelectHandler(setSize, onSizeChange)}
        placeholder="Size"
        options={SIZE_OPTIONS}
        triggerClassName="w-32"
      />
      <FilterSelect
        value={bodyType}
        onValueChange={makeSelectHandler(setBodyType, onBodyTypeChange)}
        placeholder="Body Type"
        options={BODY_TYPE_OPTIONS}
        triggerClassName="w-36"
      />
      <FilterSelect
        value={registrationStatus}
        onValueChange={makeSelectHandler(setRegistrationStatus, onRegistrationStatusChange)}
        placeholder="Registration"
        options={REGISTRATION_OPTIONS}
        triggerClassName="w-40"
      />
      <FilterSelect
        value={insuranceStatus}
        onValueChange={makeSelectHandler(setInsuranceStatus, onInsuranceStatusChange)}
        placeholder="Insurance"
        options={INSURANCE_OPTIONS}
        triggerClassName="w-36"
      />
    </FilterBarShell>
  );
}
