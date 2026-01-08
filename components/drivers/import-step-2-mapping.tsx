'use client';

import { useEffect, useState } from 'react';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Button } from '@/components/ui/button';
import { Link2, AlertCircle, Wand2, ChevronLeft, ChevronRight, CheckCircle2 } from 'lucide-react';
import { CSVRow, ColumnMapping } from './csv-import-wizard';

interface ImportStep2MappingProps {
  headers: string[];
  parsedData: CSVRow[];
  columnMappings: ColumnMapping[];
  onMappingsChange: (mappings: ColumnMapping[]) => void;
}

const DESTINATION_FIELDS = [
  { value: 'firstName', label: 'First Name', required: true },
  { value: 'middleName', label: 'Middle Name', required: false },
  { value: 'lastName', label: 'Last Name', required: true },
  { value: 'email', label: 'Email', required: true },
  { value: 'phone', label: 'Phone', required: true },
  { value: 'dateOfBirth', label: 'Date of Birth', required: false },
  { value: 'ssn', label: 'SSN', required: false },
  { value: 'licenseNumber', label: 'License Number', required: true },
  { value: 'licenseState', label: 'License State', required: true },
  { value: 'licenseExpiration', label: 'License Expiration', required: true },
  { value: 'licenseClass', label: 'License Class', required: true },
  { value: 'medicalExpiration', label: 'Medical Expiration', required: false },
  { value: 'badgeExpiration', label: 'Badge Expiration', required: false },
  { value: 'twicExpiration', label: 'TWIC Expiration', required: false },
  { value: 'hireDate', label: 'Hire Date', required: true },
  { value: 'employmentStatus', label: 'Employment Status', required: true },
  { value: 'employmentType', label: 'Employment Type', required: true },
  { value: 'terminationDate', label: 'Termination Date', required: false },
  { value: 'preEmploymentCheckDate', label: 'Pre-Employment Check Date', required: false },
  { value: 'address', label: 'Address', required: false },
  { value: 'address2', label: 'Address Line 2', required: false },
  { value: 'city', label: 'City', required: false },
  { value: 'state', label: 'State', required: false },
  { value: 'zipCode', label: 'ZIP Code', required: false },
  { value: 'emergencyContactName', label: 'Emergency Contact Name', required: false },
  { value: 'emergencyContactPhone', label: 'Emergency Contact Phone', required: false },
];

const autoMatchColumn = (sourceHeader: string): string | 'ignore' => {
  const normalized = sourceHeader.toLowerCase().replace(/[^a-z0-9]/g, '');

  const mappings: { [key: string]: string } = {
    firstname: 'firstName',
    fname: 'firstName',
    givenname: 'firstName',
    middlename: 'middleName',
    mname: 'middleName',
    lastname: 'lastName',
    lname: 'lastName',
    surname: 'lastName',
    familyname: 'lastName',
    email: 'email',
    emailaddress: 'email',
    emailaddr: 'email',
    phone: 'phone',
    phonenumber: 'phone',
    mobile: 'phone',
    cell: 'phone',
    telephone: 'phone',
    tel: 'phone',
    dateofbirth: 'dateOfBirth',
    dob: 'dateOfBirth',
    birthdate: 'dateOfBirth',
    ssn: 'ssn',
    socialsecurity: 'ssn',
    socialsecuritynumber: 'ssn',
    licensenumber: 'licenseNumber',
    dlnumber: 'licenseNumber',
    driverslicense: 'licenseNumber',
    licensestate: 'licenseState',
    dlstate: 'licenseState',
    licenseexpiration: 'licenseExpiration',
    licenseexp: 'licenseExpiration',
    dlexpiration: 'licenseExpiration',
    licenseclass: 'licenseClass',
    dlclass: 'licenseClass',
    class: 'licenseClass',
    medicalexpiration: 'medicalExpiration',
    medicalexp: 'medicalExpiration',
    medicalcardexpiration: 'medicalExpiration',
    badgeexpiration: 'badgeExpiration',
    badgeexp: 'badgeExpiration',
    twicexpiration: 'twicExpiration',
    twicexp: 'twicExpiration',
    hiredate: 'hireDate',
    datehired: 'hireDate',
    startdate: 'hireDate',
    employmentstatus: 'employmentStatus',
    status: 'employmentStatus',
    employmenttype: 'employmentType',
    emptype: 'employmentType',
    terminationdate: 'terminationDate',
    dateterm: 'terminationDate',
    preemploymentcheckdate: 'preEmploymentCheckDate',
    address: 'address',
    streetaddress: 'address',
    street: 'address',
    address2: 'address2',
    addressline2: 'address2',
    addressln2: 'address2',
    apt: 'address2',
    apartment: 'address2',
    suite: 'address2',
    unit: 'address2',
    city: 'city',
    state: 'state',
    zipcode: 'zipCode',
    zip: 'zipCode',
    postalcode: 'zipCode',
    emergencycontactname: 'emergencyContactName',
    emergencyname: 'emergencyContactName',
    emergencycontactphone: 'emergencyContactPhone',
    emergencyphone: 'emergencyContactPhone',
  };

  return mappings[normalized] || 'ignore';
};

export function ImportStep2Mapping({
  headers,
  parsedData,
  columnMappings,
  onMappingsChange,
}: ImportStep2MappingProps) {
  const [previewRowIndex, setPreviewRowIndex] = useState(0);
  const [fullNameSplitMode, setFullNameSplitMode] = useState<{ [key: string]: 'split' | 'keep' }>({});

  // Auto-generate mappings on mount
  useEffect(() => {
    if (columnMappings.length === 0 && headers.length > 0 && parsedData.length > 0) {
      const initialMappings: ColumnMapping[] = headers.map((header) => ({
        sourceColumn: header,
        destinationField: autoMatchColumn(header),
        preview: parsedData[previewRowIndex]?.[header] || '',
      }));
      onMappingsChange(initialMappings);
    }
  }, [headers, parsedData, columnMappings.length, onMappingsChange]);

  const handleMappingChange = (sourceColumn: string, destinationField: string) => {
    const updatedMappings = columnMappings.map((mapping) =>
      mapping.sourceColumn === sourceColumn ? { ...mapping, destinationField } : mapping,
    );
    onMappingsChange(updatedMappings);
  };

  const handleQuickMap = (sourceColumn: string, destinationField: string) => {
    handleMappingChange(sourceColumn, destinationField);
  };

  const cyclePreviewRow = (direction: 'prev' | 'next') => {
    const newIndex = direction === 'next' 
      ? Math.min(previewRowIndex + 1, parsedData.length - 1)
      : Math.max(previewRowIndex - 1, 0);
    setPreviewRowIndex(newIndex);
    
    // Update preview data for all mappings
    const updatedMappings = columnMappings.map((mapping) => ({
      ...mapping,
      preview: parsedData[newIndex]?.[mapping.sourceColumn] || '',
    }));
    onMappingsChange(updatedMappings);
  };

  // Detect full name issues
  const detectFullNameIssue = (sourceColumn: string, destinationField: string): boolean => {
    const sourceLower = sourceColumn.toLowerCase();
    return (
      (sourceLower.includes('full') && sourceLower.includes('name')) &&
      (destinationField === 'firstName' || destinationField === 'lastName')
    );
  };

  const requiredFields = DESTINATION_FIELDS.filter((f) => f.required);
  const mappedRequiredFields = columnMappings.filter(
    (m) => m.destinationField !== 'ignore' && DESTINATION_FIELDS.find((f) => f.value === m.destinationField)?.required,
  );
  const missingRequired = requiredFields.filter(
    (rf) => !mappedRequiredFields.some((mf) => mf.destinationField === rf.value),
  );

  const mappedCount = columnMappings.filter((m) => m.destinationField !== 'ignore').length;
  const unmappedSources = columnMappings.filter((m) => m.destinationField === 'ignore');

  // Find potential matches for missing required fields
  const potentialMatches = missingRequired.map((rf) => {
    const similar = unmappedSources.filter((um) => {
      const sourceLower = um.sourceColumn.toLowerCase();
      const fieldLower = rf.label.toLowerCase();
      return sourceLower.includes(fieldLower) || fieldLower.includes(sourceLower);
    });
    return { field: rf, suggestions: similar };
  }).filter((pm) => pm.suggestions.length > 0);

  return (
    <div className="flex flex-col h-full">
      {/* Header */}
      <div className="flex-shrink-0 mb-4">
        <h2 className="text-xl font-semibold mb-2">Map Your Columns</h2>
        <p className="text-muted-foreground">
          Match the columns from your file to the corresponding fields in our system. We've automatically suggested
          mappings for you.
        </p>
      </div>

      {/* Mapping Status Bar */}
      <div className="flex-shrink-0 bg-gray-50 dark:bg-gray-900 border border-gray-200 dark:border-gray-700 rounded-lg p-3 mb-4">
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-6">
            <div className="flex items-center gap-2">
              <CheckCircle2 className="h-5 w-5 text-green-600" />
              <span className="text-sm font-medium">{mappedCount} Columns Mapped</span>
            </div>
            {missingRequired.length > 0 && (
              <div className="flex items-center gap-2">
                <AlertCircle className="h-5 w-5 text-red-600" />
                <span className="text-sm font-medium text-red-600">{missingRequired.length} Required Fields Missing</span>
              </div>
            )}
          </div>
        </div>
      </div>

      {/* Quick Fix Section for Missing Required Fields */}
      {potentialMatches.length > 0 && (
        <div className="flex-shrink-0 bg-blue-50 dark:bg-blue-950/20 border border-blue-200 dark:border-blue-800 rounded-lg p-3 mb-4">
          <p className="text-sm font-medium text-blue-900 dark:text-blue-100 mb-3">
            💡 Quick Fix Available
          </p>
          <div className="space-y-2">
            {potentialMatches.map((pm) => (
              <div key={pm.field.value} className="flex items-center gap-2 flex-wrap">
                <span className="text-sm text-blue-800 dark:text-blue-200">
                  Map <strong>{pm.field.label}</strong> from:
                </span>
                {pm.suggestions.map((suggestion) => (
                  <Button
                    key={suggestion.sourceColumn}
                    size="sm"
                    variant="outline"
                    className="h-7 text-xs"
                    onClick={() => handleQuickMap(suggestion.sourceColumn, pm.field.value)}
                  >
                    {suggestion.sourceColumn}
                  </Button>
                ))}
              </div>
            ))}
          </div>
        </div>
      )}

      {/* Mapping Table - Scrollable Area */}
      <div className="flex-1 border border-gray-200 dark:border-gray-700 rounded-lg overflow-hidden flex flex-col min-h-0">
        <div className="flex-1 overflow-y-auto scroll-smooth">
          <table className="w-full table-fixed">
            <colgroup>
              <col className="w-[30%]" />
              <col className="w-[30%]" />
              <col className="w-[40%]" />
            </colgroup>
            <thead className="bg-gray-50 dark:bg-gray-900 sticky top-0 z-10 shadow-sm">
            <tr>
              <th className="px-4 py-3 text-left text-sm font-medium text-gray-700 dark:text-gray-300">
                Source Column (Your File)
              </th>
              <th className="px-4 py-3 text-left text-sm font-medium text-gray-700 dark:text-gray-300">
                <div className="flex items-center justify-between">
                  <span className="text-blue-600 dark:text-blue-400">Preview (Row {previewRowIndex + 1})</span>
                  <div className="flex items-center gap-1">
                    <Button
                      size="sm"
                      variant="ghost"
                      className="h-6 w-6 p-0"
                      onClick={() => cyclePreviewRow('prev')}
                      disabled={previewRowIndex === 0}
                    >
                      <ChevronLeft className="h-4 w-4" />
                    </Button>
                    <Button
                      size="sm"
                      variant="ghost"
                      className="h-6 w-6 p-0"
                      onClick={() => cyclePreviewRow('next')}
                      disabled={previewRowIndex === parsedData.length - 1}
                    >
                      <ChevronRight className="h-4 w-4" />
                    </Button>
                  </div>
                </div>
              </th>
              <th className="px-4 py-3 text-left text-sm font-medium text-gray-700 dark:text-gray-300">
                Destination Field (System)
              </th>
            </tr>
          </thead>
          <tbody className="divide-y divide-gray-200 dark:divide-gray-700">
            {columnMappings.map((mapping, index) => {
              const isAutoMatched = mapping.destinationField !== 'ignore';
              const destinationField = DESTINATION_FIELDS.find((f) => f.value === mapping.destinationField);
              const isIgnored = mapping.destinationField === 'ignore';
              const isMissingRequired = missingRequired.some((mr) => mr.value === mapping.destinationField);
              const hasFullNameIssue = detectFullNameIssue(mapping.sourceColumn, mapping.destinationField);

              return (
                <tr 
                  key={index} 
                  className={`${
                    isIgnored 
                      ? 'bg-gray-50/50 dark:bg-gray-900/30 opacity-60' 
                      : 'bg-white dark:bg-gray-950 hover:bg-gray-50 dark:hover:bg-gray-900'
                  }`}
                >
                  {/* Source Column */}
                  <td className="px-4 py-3">
                    <div className="flex items-center gap-2">
                      <span className={`font-medium truncate ${isIgnored ? 'text-gray-400' : ''}`} title={mapping.sourceColumn}>
                        {mapping.sourceColumn}
                      </span>
                      {isAutoMatched && !isIgnored && (
                        <Link2 className="h-4 w-4 text-green-600" title="Auto-matched" />
                      )}
                    </div>
                  </td>

                  {/* Preview Data */}
                  <td className="px-4 py-3">
                    <span className="text-sm text-blue-600/70 dark:text-blue-400/70 italic truncate block" title={mapping.preview}>
                      {mapping.preview || '(empty)'}
                    </span>
                  </td>

                  {/* Destination Mapping */}
                  <td className="px-4 py-3">
                    <div className="space-y-2">
                      <Select
                        value={mapping.destinationField}
                        onValueChange={(value) => handleMappingChange(mapping.sourceColumn, value)}
                      >
                        <SelectTrigger 
                          className={`w-full ${
                            isMissingRequired && isIgnored
                              ? 'border-red-500 dark:border-red-500' 
                              : ''
                          }`}
                        >
                          <SelectValue placeholder="Map to field..." />
                        </SelectTrigger>
                        <SelectContent>
                          <SelectItem value="ignore">
                            <span className="text-gray-500">
                              Ignore Column
                            </span>
                          </SelectItem>
                          {DESTINATION_FIELDS.map((field) => (
                            <SelectItem key={field.value} value={field.value}>
                              <span className="flex items-center gap-2">
                                {field.label}
                                {field.required && <span className="text-red-500 text-xs">*</span>}
                              </span>
                            </SelectItem>
                          ))}
                        </SelectContent>
                      </Select>
                      
                      {/* Full Name Split Warning */}
                      {hasFullNameIssue && (
                        <div className="bg-orange-50 dark:bg-orange-950/20 border border-orange-200 dark:border-orange-800 rounded p-2 text-xs">
                          <div className="flex items-start gap-2">
                            <Wand2 className="h-4 w-4 text-orange-600 mt-0.5 flex-shrink-0" />
                            <div className="flex-1">
                              <p className="text-orange-900 dark:text-orange-100 font-medium mb-1">
                                You're mapping a Full Name to a single field
                              </p>
                              <p className="text-orange-800 dark:text-orange-200 mb-2">
                                Consider splitting into First and Last Name during import?
                              </p>
                              <div className="flex items-center gap-3 text-orange-800 dark:text-orange-200">
                                <label className="flex items-center gap-1.5 cursor-pointer">
                                  <input
                                    type="radio"
                                    name={`split-${mapping.sourceColumn}`}
                                    checked={fullNameSplitMode[mapping.sourceColumn] === 'split'}
                                    onChange={() => setFullNameSplitMode({ ...fullNameSplitMode, [mapping.sourceColumn]: 'split' })}
                                    className="w-3 h-3"
                                  />
                                  <span>Split into First/Last</span>
                                </label>
                                <label className="flex items-center gap-1.5 cursor-pointer">
                                  <input
                                    type="radio"
                                    name={`split-${mapping.sourceColumn}`}
                                    checked={fullNameSplitMode[mapping.sourceColumn] === 'keep'}
                                    onChange={() => setFullNameSplitMode({ ...fullNameSplitMode, [mapping.sourceColumn]: 'split' })}
                                    className="w-3 h-3"
                                  />
                                  <span>Keep as is</span>
                                </label>
                              </div>
                            </div>
                          </div>
                        </div>
                      )}
                      
                      {/* Required Field Warning */}
                      {isMissingRequired && isIgnored && (
                        <p className="text-xs text-red-600 flex items-center gap-1">
                          <AlertCircle className="h-3 w-3" />
                          Required field
                        </p>
                      )}
                    </div>
                  </td>
                </tr>
              );
            })}
            </tbody>
          </table>
        </div>
      </div>

      {/* Compact Tips Bar - Fixed at Bottom */}
      <div className="flex-shrink-0 mt-4 bg-blue-50 dark:bg-blue-950/20 border border-blue-200 dark:border-blue-800 rounded-lg px-4 py-2.5">
        <p className="text-xs text-blue-800 dark:text-blue-200 flex items-center gap-4 flex-wrap">
          <span className="font-medium text-blue-900 dark:text-blue-100 flex items-center gap-1.5">
            💡 Tips:
          </span>
          <span className="flex items-center gap-1.5">
            <span className="text-red-500 font-semibold">*</span> Required
          </span>
          <span className="flex items-center gap-1.5">
            <Link2 className="h-3 w-3 text-green-600" /> Auto-matched
          </span>
          <span className="flex items-center gap-1.5">
            <span className="inline-block w-3 h-3 bg-gray-200 dark:bg-gray-700 rounded opacity-60"></span> Ignored
          </span>
          <span className="flex items-center gap-1.5">
            <span className="inline-block w-3 h-3 border-2 border-red-500 rounded"></span> Unmapped required
          </span>
          <span className="flex items-center gap-1.5">
            <ChevronLeft className="h-3 w-3" /><ChevronRight className="h-3 w-3" /> Cycle preview rows
          </span>
        </p>
      </div>
    </div>
  );
}
